import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, loanApplicationKeys } from "@/lib/queryClient";
import { downloadResponseAsFile } from "@/lib/downloadFile";
import { PREQUAL_ELIGIBLE_STATUSES } from "@shared/letters";

// Pre-qual and pre-approval letters are the same interaction — check whether a
// letter exists, generate it if not, download it once it does — differing only
// in endpoints, copy, and which loan statuses they apply to. They were two
// near-identical 65-line components; this is the shared shape, with the
// per-letter differences declared in LETTER_KINDS below.
type LetterKind = {
  /** Which loan statuses this letter is offered for. */
  isEligible: (status: string, financialsVerified: boolean) => boolean;
  statusQueryKey: (applicationId: string) => readonly unknown[];
  generatePath: (applicationId: string) => string;
  pdfPath: (applicationId: string) => string;
  downloadFileName: string;
  generatedToastTitle: string;
  generatedToastDescription: (letterNumber: string) => string;
  errorToastDescription: string;
  generateLabel: string;
  downloadLabel: string;
  generateVariant?: "outline";
  generateTestId: string;
  downloadTestId: string;
};

const LETTER_KINDS = {
  prequal: {
    // Offered while the file is pre-qual eligible, but a pre-approved file gets
    // the stronger pre-approval letter instead.
    isEligible: (status, financialsVerified) =>
      (PREQUAL_ELIGIBLE_STATUSES as readonly string[]).includes(status) &&
      (status !== "pre_approved" || !financialsVerified),
    statusQueryKey: (id) => loanApplicationKeys.prequalStatus(id),
    generatePath: (id) => `/api/loan-applications/${id}/generate-prequal`,
    pdfPath: (id) => `/api/loan-applications/${id}/prequal-pdf`,
    downloadFileName: "pre-qualification-letter.pdf",
    generatedToastTitle: "Letter Generated",
    generatedToastDescription: (n) => `Pre-qualification letter #${n} is ready.`,
    errorToastDescription: "Failed to generate pre-qualification letter.",
    generateLabel: "Get Pre-Qualification Letter",
    downloadLabel: "Download Pre-Qualification Letter",
    generateVariant: "outline",
    generateTestId: "button-generate-prequal",
    downloadTestId: "button-download-prequal",
  },
  preapproval: {
    isEligible: (status, financialsVerified) => status === "pre_approved" && financialsVerified,
    statusQueryKey: (id) => loanApplicationKeys.letterStatus(id),
    generatePath: (id) => `/api/loan-applications/${id}/generate-letter`,
    pdfPath: (id) => `/api/loan-applications/${id}/letter-pdf`,
    downloadFileName: "pre-approval-letter.pdf",
    generatedToastTitle: "Letter Generated",
    generatedToastDescription: (n) => `Pre-approval letter #${n} is ready.`,
    errorToastDescription: "Failed to generate letter. Please try again.",
    generateLabel: "Generate Pre-Approval Letter",
    downloadLabel: "Download Pre-Approval Letter",
    generateTestId: "button-generate-letter",
    downloadTestId: "button-download-letter",
  },
} satisfies Record<string, LetterKind>;

export function isLoanLetterEligible(
  kind: keyof typeof LETTER_KINDS,
  status: string,
  financialsVerified: boolean,
): boolean {
  return LETTER_KINDS[kind].isEligible(status, financialsVerified);
}

export function LoanLetterButton({
  applicationId,
  status,
  kind,
  financialsVerified,
}: {
  applicationId: string;
  status: string;
  kind: keyof typeof LETTER_KINDS;
  financialsVerified: boolean;
}) {
  const queryClient = useQueryClient();
  const spec: LetterKind = LETTER_KINDS[kind];
  const { toast } = useToast();

  const statusQuery = useQuery<{ hasLetter: boolean; letterNumber?: string }>({
    queryKey: spec.statusQueryKey(applicationId),
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", spec.generatePath(applicationId));
      return res.json();
    },
    onSuccess: (data: { letterNumber: string }) => {
      toast({
        title: spec.generatedToastTitle,
        description: spec.generatedToastDescription(data.letterNumber),
      });
      queryClient.invalidateQueries({ queryKey: spec.statusQueryKey(applicationId) });
    },
    onError: () => {
      toast({ title: "Error", description: spec.errorToastDescription, variant: "destructive" });
    },
  });

  const handleDownload = async () => {
    try {
      const res = await apiRequest("GET", spec.pdfPath(applicationId));
      await downloadResponseAsFile(res, spec.downloadFileName);
    } catch {
      toast({ title: "Error", description: "Failed to download letter.", variant: "destructive" });
    }
  };

  if (!isLoanLetterEligible(kind, status, financialsVerified)) return null;

  const hasLetter = statusQuery.data?.hasLetter;

  return (
    <>
      {!hasLetter && (
        <Button
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
          variant={spec.generateVariant}
          className="gap-2"
          data-testid={spec.generateTestId}
        >
          {generateMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FileText className="h-4 w-4" />
          )}
          {generateMutation.isPending ? "Generating..." : spec.generateLabel}
        </Button>
      )}
      {hasLetter && (
        <Button onClick={handleDownload} variant="outline" className="gap-2" data-testid={spec.downloadTestId}>
          <Download className="h-4 w-4" />
          {spec.downloadLabel}
        </Button>
      )}
    </>
  );
}
