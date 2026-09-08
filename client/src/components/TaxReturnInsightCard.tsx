import { useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  queryClient,
  apiRequest,
  dashboardKeys,
  consentKeys,
  consentTemplateKeys,
  applicationResourceKeys,
  taskKeys,
} from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@/hooks/use-upload";
import { friendlyApiError } from "@/lib/errorMessage";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@shared/uploads";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/formatters";
import { Briefcase, Building2, CheckCircle2, FileUp, Landmark, Loader2, ReceiptText } from "lucide-react";

/**
 * Tax Return Insight — the incubator's "upload last year's return" card.
 *
 * Consumer-direct by design: the user uploads their OWN return (IRC §7216
 * preparer rules never attach), gated by the tax_document_use consent.
 *
 * Compliance copy rules (Reg N / Reg Z — do not soften):
 * - NEVER a dollar purchasing-power figure or loan amount.
 * - NEVER "qualify", "prequalified", "preapproved", or "approved".
 * - The educational-estimate disclaimer stays visible in every state.
 */

interface TaxInsightRecord {
  taxYear: number;
  documentId: string | null;
  wagesW2: string | null;
  grossIncome: string | null;
  adjustedGrossIncome: string | null;
  scheduleCNetProfit: string | null;
  scheduleENetRental: string | null;
  rentalPropertyCount: number | null;
  selfEmployed: boolean;
  dscrCandidate: boolean;
  confidence: string;
}

interface ConsentTemplateRecord {
  id: string;
  consentType: string;
  version: string;
  title: string;
  fullText: string;
}

interface ConsentRecord {
  consentType: string;
  consentGiven: boolean;
  isRevoked: boolean;
}

type Step = "idle" | "consent" | "working";

const DISCLAIMER =
  "Educational estimate only — not a prequalification, preapproval, loan offer, or commitment to lend. Figures used in a loan decision are separately verified during a loan application.";

export function TaxReturnInsightCard() {
  const { toast } = useToast();
  const { uploadFile } = useUpload();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const { data: insightData, isLoading } = useQuery<{ insights: TaxInsightRecord[] }>({
    queryKey: ["/api/tax-insights/me"],
  });
  const { data: consents } = useQuery<ConsentRecord[]>({
    queryKey: consentKeys.me(),
  });
  // ONE identity for this endpoint. This used to key on a bare
  // `"tax_document_use"` segment plus a hand-written queryFn, while
  // ConsentGateCard read the same `GET /api/consent-templates?type=` through the
  // params-object form — so identical server data occupied two cache entries,
  // was fetched twice, and no single invalidation could reach both.
  const { data: templates } = useQuery<ConsentTemplateRecord[]>({
    queryKey: consentTemplateKeys.byType("tax_document_use"),
  });

  const insight = insightData?.insights?.[0];
  const template = Array.isArray(templates)
    ? templates.find((t) => t.consentType === "tax_document_use")
    : undefined;
  const hasConsent = Array.isArray(consents)
    ? consents.some((c) => c.consentType === "tax_document_use" && c.consentGiven && !c.isRevoked)
    : false;

  const process = useMutation({
    mutationFn: async (file: File) => {
      setStep("working");
      const stored = await uploadFile(file);
      if (!stored) throw new Error("The file could not be uploaded to secure storage. Please try again.");

      const registerRes = await apiRequest("POST", "/api/documents/upload", {
        objectPath: stored.objectPath,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        documentType: "tax_return",
      });
      const document = await registerRes.json();

      const processRes = await apiRequest("POST", "/api/tax-insights/process", {
        documentId: document.id,
      });
      return processRes.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tax-insights/me"] });
      // Was ["/api/documents"] — a key no client query reads. The tax return is
      // registered as a document, so the checklist root is what needs refreshing.
      queryClient.invalidateQueries({ queryKey: applicationResourceKeys.all() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.root() });
      queryClient.invalidateQueries({ queryKey: taskKeys.all() });
      queryClient.invalidateQueries({ queryKey: ["/api/shell/badges"] });
      setPendingFile(null);
      setStep("idle");
      toast({
        title: "Tax return read",
        description: "Your readiness snapshot has been updated with income signals from your return.",
      });
    },
    onError: (error: Error) => {
      // Server-side consent gate is the source of truth — if it says consent
      // is missing, fall back to the consent step instead of erroring out.
      if (error.message.includes("CONSENT_REQUIRED")) {
        setStep("consent");
        return;
      }
      setStep("idle");
      toast({
        title: "We couldn't process that",
        description: friendlyApiError(error, "Nothing was lost — please try again."),
        variant: "destructive",
      });
    },
  });

  const recordConsent = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/consents", {
        consentType: "tax_document_use",
        consentGiven: true,
        consentMethod: "click",
        templateId: template?.id,
        templateVersion: template?.version,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: consentKeys.me() });
      if (pendingFile) process.mutate(pendingFile);
    },
    onError: (error: Error) => {
      setStep("idle");
      toast({
        title: "Couldn't record your authorization",
        description: friendlyApiError(error, "Please try again."),
        variant: "destructive",
      });
    },
  });

  // The consent template promises "You can revoke this authorization at any
  // time" — this is that promise. The server revokes the consent AND purges
  // the derived insights, so the card falls back to the upload CTA.
  const revoke = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/consents/tax_document_use/revoke");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: consentKeys.me() });
      queryClient.invalidateQueries({ queryKey: ["/api/tax-insights/me"] });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.root() });
      setConfirmingRevoke(false);
      toast({
        title: "Authorization revoked",
        description:
          "Your tax return insights were removed and won't be used. Your uploaded document stays in your secure documents.",
      });
    },
    onError: (error: Error) => {
      setConfirmingRevoke(false);
      toast({
        title: "Couldn't revoke the authorization",
        description: friendlyApiError(error, "Please try again."),
        variant: "destructive",
      });
    },
  });

  const handleFilePicked = (picked: File | null) => {
    if (!picked) return;
    if (picked.size > MAX_UPLOAD_BYTES) {
      toast({
        title: "File too large",
        description: `The limit is ${MAX_UPLOAD_LABEL}. Try compressing the file.`,
        variant: "destructive",
      });
      return;
    }
    setPendingFile(picked);
    if (hasConsent) {
      process.mutate(picked);
    } else {
      setConsentChecked(false);
      setStep("consent");
    }
  };

  const money = (v: string | null) => {
    const n = v ? parseFloat(v) : NaN;
    return Number.isFinite(n) ? formatCurrency(n) : null;
  };

  const busy = step === "working" || process.isPending || recordConsent.isPending;
  const lowConfidence = insight && insight.confidence === "low";

  return (
    <Card data-testid="card-tax-insight">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <ReceiptText className="h-4 w-4 text-primary" />
          Tax Return Insight
          {insight && !lowConfidence && (
            <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate text-[10px]">
              {insight.taxYear}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          className="hidden"
          onChange={(e) => handleFilePicked(e.target.files?.[0] ?? null)}
          data-testid="input-tax-return-file"
        />

        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : step === "consent" ? (
          <div className="space-y-3" data-testid="tax-consent-step">
            <p className="text-sm font-medium">{template?.title ?? "Tax Document Use Authorization"}</p>
            <div className="max-h-40 overflow-y-auto rounded-md border p-3 text-xs whitespace-pre-wrap text-muted-foreground">
              {template?.fullText ?? "Loading authorization text…"}
            </div>
            <label className="flex items-start gap-2 text-xs cursor-pointer">
              <Checkbox
                checked={consentChecked}
                onCheckedChange={(v) => setConsentChecked(v === true)}
                data-testid="checkbox-tax-consent"
              />
              <span>I have read and agree to the authorization above.</span>
            </label>
            <div className="flex gap-2">
              <Button
                size="sm" className="touch-target"
                disabled={!consentChecked || !template || busy}
                onClick={() => recordConsent.mutate()}
                data-testid="button-tax-consent-agree"
              >
                {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                Agree & continue
              </Button>
              <Button
                size="sm" className="touch-target"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setPendingFile(null);
                  setStep("idle");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : busy ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Reading your return securely — this usually takes a few seconds.
          </div>
        ) : insight && !lowConfidence ? (
          <div className="space-y-2" data-testid="tax-insight-result">
            <p className="text-sm">
              Income signals from your {insight.taxYear} return strengthen your readiness profile.
            </p>
            <div className="space-y-1.5">
              {money(insight.wagesW2) && (
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-status-success shrink-0" />
                  <Landmark className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  W-2 wages found: {money(insight.wagesW2)}
                </div>
              )}
              {insight.selfEmployed && (
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-status-success shrink-0" />
                  <Briefcase className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  Self-employment income found
                  {money(insight.scheduleCNetProfit) ? `: ${money(insight.scheduleCNetProfit)}` : ""}
                </div>
              )}
              {insight.dscrCandidate && (
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-status-success shrink-0" />
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  Rental property income found — programs designed for property investors may be
                  worth discussing with your loan team.
                </div>
              )}
              {money(insight.adjustedGrossIncome) && (
                <p className="text-xs text-muted-foreground">
                  Adjusted gross income on file: {money(insight.adjustedGrossIncome)}
                </p>
              )}
            </div>
            <Button
              size="sm" className="touch-target"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              data-testid="button-tax-reupload"
            >
              <FileUp className="mr-1 h-3.5 w-3.5" />
              Update with a newer return
            </Button>
          </div>
        ) : lowConfidence ? (
          <div className="space-y-2" data-testid="tax-insight-low-confidence">
            <p className="text-sm text-muted-foreground">
              We couldn't read your return clearly. A sharper scan or the original PDF usually fixes
              this.
            </p>
            <Button size="sm" className="touch-target" variant="outline" onClick={() => fileInputRef.current?.click()}>
              <FileUp className="mr-1 h-3.5 w-3.5" />
              Try a clearer copy
            </Button>
          </div>
        ) : (
          <div className="space-y-2" data-testid="tax-insight-cta">
            <p className="text-sm text-muted-foreground">
              Add last year's tax return and we'll turn it into a readiness snapshot — income
              signals, self-employment history, and rental property income, read securely in
              seconds.
            </p>
            <Button size="sm" className="touch-target" onClick={() => fileInputRef.current?.click()} data-testid="button-tax-upload">
              <FileUp className="mr-1 h-3.5 w-3.5" />
              Add last year's tax return
            </Button>
          </div>
        )}

        {hasConsent && step !== "consent" && !busy && (
          confirmingRevoke ? (
            <div className="space-y-2 rounded-md border p-2" data-testid="tax-revoke-confirm">
              <p className="text-xs text-muted-foreground">
                Revoking removes your tax return insights and stops our staff from using them. You
                can re-authorize later by uploading a return again.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm" className="touch-target"
                  variant="destructive"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate()}
                  data-testid="button-tax-revoke-confirm"
                >
                  {revoke.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                  Revoke authorization
                </Button>
                <Button
                  size="sm" className="touch-target"
                  variant="ghost"
                  disabled={revoke.isPending}
                  onClick={() => setConfirmingRevoke(false)}
                >
                  Keep it
                </Button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setConfirmingRevoke(true)}
              data-testid="button-tax-revoke"
            >
              Revoke tax document authorization
            </button>
          )
        )}

        <p className="text-[11px] leading-snug text-muted-foreground border-t pt-2" data-testid="text-tax-disclaimer">
          {DISCLAIMER}
        </p>
      </CardContent>
    </Card>
  );
}
