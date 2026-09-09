import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface PacketPage {
  pageId: string;
  pageNumber: number;
  imageUrl: string;
  documentType: string;
  machineDocumentType: string;
  confidence: number;
  humanReviewed: boolean;
}

interface PacketReview {
  documentId: string;
  pageCount: number;
  mixedPacket: boolean;
  pages: PacketPage[];
  segments: Array<{
    documentType: string;
    pageStart: number;
    pageEnd: number;
    confidence: number;
  }>;
}

const REVIEW_TYPES = [
  "paystub",
  "w2",
  "1099_misc",
  "1099_nec",
  "tax_return_1040",
  "schedule_1",
  "schedule_c",
  "schedule_d",
  "schedule_e",
  "schedule_k1",
  "business_tax_return_1120",
  "business_tax_return_1120s",
  "business_tax_return_1065",
  "form_8825",
  "form_4562",
  "profit_loss_statement",
  "bank_statement_checking",
  "bank_statement_savings",
  "business_bank_statement",
  "mortgage_statement",
  "lease_agreement",
  "purchase_contract",
  "unknown",
] as const;

const label = (value: string) =>
  value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

export function DocumentPacketReview({
  documentId,
  canReview,
}: {
  documentId: string;
  canReview: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selectedTypes, setSelectedTypes] = useState<Record<number, string>>({});
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const packetQuery = useQuery<PacketReview>({
    queryKey: ["/api/documents", documentId, "pages"],
    retry: false,
  });
  const packet = packetQuery.data;

  useEffect(() => {
    if (!packet) return;
    setSelectedTypes(Object.fromEntries(packet.pages.map((page) => [page.pageNumber, page.documentType])));
  }, [packet]);

  const changedPages = useMemo(() => packet?.pages.filter(
    (page) => selectedTypes[page.pageNumber] && selectedTypes[page.pageNumber] !== page.documentType,
  ) ?? [], [packet, selectedTypes]);

  const correctionMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest(
        "PATCH",
        `/api/documents/${documentId}/pages/classification`,
        {
          corrections: changedPages.map((page) => ({
            pageNumber: page.pageNumber,
            documentType: selectedTypes[page.pageNumber],
          })),
        },
      );
      return response.json() as Promise<PacketReview>;
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(["/api/documents", documentId, "pages"], updated);
      queryClient.invalidateQueries({ queryKey: ["/api/documents", documentId, "pages"] });
      queryClient.invalidateQueries({ queryKey: ["/api/documents", documentId, "extracted-fields"] });
      toast({
        title: "Page boundaries saved",
        description: "The corrected logical documents were re-read and remain linked to the original upload.",
      });
    },
    onError: (error: Error) => toast({
      title: "Could not save page boundaries",
      description: error.message,
      variant: "destructive",
    }),
  });

  // Older documents and document types outside the page pipeline have no
  // normalized manifest. Their ordinary source preview remains available.
  if (!packet || packetQuery.isError) return null;

  return (
    <div className="rounded-md border bg-background" data-testid={`packet-review-${documentId}`}>
      <button
        type="button"
        className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>
          <span className="block text-xs font-semibold">Normalized page review</span>
          <span className="block text-xs text-muted-foreground">
            {packet.pageCount} {packet.pageCount === 1 ? "page" : "pages"} · {packet.segments.length} logical {packet.segments.length === 1 ? "document" : "documents"}
          </span>
        </span>
        <Badge variant="secondary" className="no-default-hover-elevate shrink-0">
          {open ? "Hide pages" : "Review pages"}
        </Badge>
      </button>

      {open && (
        <div className="space-y-3 border-t p-3">
          <p className="text-xs text-muted-foreground">
            Confirm each page type before relying on a packet split. Corrections preserve the original file and create a new logical boundary record.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {packet.pages.map((page) => (
              <div key={page.pageId} className="overflow-hidden rounded-md border bg-muted/20">
                <img
                  src={page.imageUrl}
                  alt={`Normalized preview of page ${page.pageNumber}`}
                  className="aspect-[8.5/11] w-full bg-background object-contain"
                  loading="lazy"
                />
                <div className="space-y-2 p-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold">Page {page.pageNumber}</span>
                    <span className="text-muted-foreground">
                      {page.humanReviewed ? "Human confirmed" : `${Math.round(page.confidence * 100)}% model confidence`}
                    </span>
                  </div>
                  <Select
                    value={selectedTypes[page.pageNumber] ?? page.documentType}
                    onValueChange={(value) => setSelectedTypes((prior) => ({
                      ...prior,
                      [page.pageNumber]: value,
                    }))}
                    disabled={!canReview || correctionMutation.isPending}
                  >
                    <SelectTrigger aria-label={`Document type for page ${page.pageNumber}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REVIEW_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>{label(type)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ))}
          </div>
          {canReview && (
            <div className="flex justify-end">
              <Button
                size="sm"
                className="touch-target"
                disabled={changedPages.length === 0 || correctionMutation.isPending}
                onClick={() => correctionMutation.mutate()}
              >
                {correctionMutation.isPending ? "Saving…" : `Save ${changedPages.length || ""} ${changedPages.length === 1 ? "correction" : "corrections"}`.trim()}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
