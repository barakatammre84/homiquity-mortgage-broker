/**
 * Document review panel (roadmap A6) — the left pane of the staff document
 * workbench on BorrowerFile's Documents tab.
 *
 * Groups the file's uploads by review state, surfaces the stored extraction
 * summary (field names + confidence — the notes writers persist names only),
 * lets staff run a fresh extraction to see values with deterministic
 * stated-vs-extracted triage badges, and carries the ONLY UI path to
 * verify/reject a document.
 *
 * MR-2: extraction stages a document at most to "verifying"; the Verify button
 * here calls POST /api/documents/:id/verify — the sole route to "verified"
 * (role-gated server-side; DOCUMENT_REVIEW_ROLES mirrors that gate for the UI).
 * The comparison badges are display-only triage and feed nothing.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, loanApplicationKeys } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Document, LoanApplication } from "@shared/schema";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icons, iconSize } from "@/lib/icons";
import { formatDate } from "@/lib/formatters";
import { DocumentStatusBadge } from "@/components/DocumentStatusBadge";
import {
  parseExtractionNotes,
  documentReviewGroup,
  compareExtractedToStated,
  isExtractableDocumentType,
  type DocumentReviewGroup,
  type ComparisonRow,
} from "@/lib/documentReview";
import { ExtractedFieldReview } from "@/components/staff/ExtractedFieldReview";
import { DocumentPacketReview } from "@/components/staff/DocumentPacketReview";
import { isTaxReturnDocumentType } from "@shared/documentTypes";

const GROUP_ORDER: DocumentReviewGroup[] = ["needs_review", "other", "verified", "rejected"];
const GROUP_LABELS: Record<DocumentReviewGroup, string> = {
  needs_review: "Needs review",
  other: "Uploaded",
  verified: "Verified",
  rejected: "Rejected",
};

const CONFIDENCE_CHIP: Record<string, string> = {
  high: "bg-success-subtle text-success-subtle-foreground",
  medium: "bg-warning-subtle text-warning-subtle-foreground",
  low: "bg-status-danger/10 text-status-danger",
};

const VERDICT_META: Record<ComparisonRow["verdict"], { label: string; chip: string }> = {
  consistent: { label: "Matches stated", chip: "bg-success-subtle text-success-subtle-foreground" },
  variance: { label: "Differs from stated", chip: "bg-warning-subtle text-warning-subtle-foreground" },
  insufficient_data: { label: "Not comparable", chip: "text-muted-foreground border" },
};

/** The /extract response: extraction values at the top level plus the
 * summary fields — held in component state only, never persisted client-side. */
type ExtractionRun = Record<string, unknown> & {
  confidence?: "high" | "medium" | "low";
  warnings?: string[];
  extractedFields?: string[];
  classificationBlocked?: boolean;
};

interface DocumentReviewPanelProps {
  applicationId: string;
  documents: Document[];
  application: LoanApplication;
  canReview: boolean;
  taxDocumentUseAuthorized?: boolean;
  selectedDocumentId: string | null;
  onSelectDocument: (id: string) => void;
  onOpenSourcePage?: (pageNumber: number, boundingBox?: unknown, fieldLabel?: string) => void;
}

export function DocumentReviewPanel({
  applicationId,
  documents,
  application,
  canReview,
  taxDocumentUseAuthorized = true,
  selectedDocumentId,
  onSelectDocument,
  onOpenSourcePage,
}: DocumentReviewPanelProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [rejectTarget, setRejectTarget] = useState<Document | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [extractionRuns, setExtractionRuns] = useState<Record<string, ExtractionRun>>({});

  const invalidateFile = () =>
    queryClient.invalidateQueries({ queryKey: loanApplicationKeys.detail(applicationId) });

  const verifyMutation = useMutation({
    mutationFn: async (input: { id: string; status: "verified" | "rejected"; reason?: string }) => {
      const res = await apiRequest("POST", `/api/documents/${input.id}/verify`, {
        status: input.status,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return res.json();
    },
    onSuccess: (_data, input) => {
      invalidateFile();
      // A rejection reverts no-longer-satisfied conditions server-side, so the
      // pipeline view must refresh too.
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.pipeline(applicationId) });
      setRejectTarget(null);
      setRejectReason("");
      toast(
        input.status === "verified"
          ? { title: "Document verified", description: "The borrower sees it as accepted." }
          : { title: "Sent back to the borrower", description: "They'll see your reason on their Documents page." },
      );
    },
    onError: (error: Error) =>
      toast({ title: "Review failed", description: error.message, variant: "destructive" }),
  });

  const extractMutation = useMutation({
    mutationFn: async (doc: Document) => {
      const res = await apiRequest("POST", `/api/documents/${doc.id}/extract`, {});
      return { docId: doc.id, run: (await res.json()) as ExtractionRun };
    },
    onSuccess: ({ docId, run }) => {
      setExtractionRuns((prev) => ({ ...prev, [docId]: run }));
      queryClient.invalidateQueries({ queryKey: ["/api/documents", docId, "extracted-fields"] });
      // Extraction can restage the document (uploaded ↔ verifying) and rewrite
      // its notes — refresh the file so groups and summaries stay truthful.
      invalidateFile();
      toast({ title: "Extraction complete", description: "Values below are from this run." });
    },
    onError: (error: Error) =>
      toast({ title: "Extraction failed", description: error.message, variant: "destructive" }),
  });

  const grouped = new Map<DocumentReviewGroup, Document[]>();
  for (const group of GROUP_ORDER) grouped.set(group, []);
  for (const doc of documents) grouped.get(documentReviewGroup(doc))!.push(doc);

  const renderDocDetail = (doc: Document) => {
    const parsed = parseExtractionNotes(doc.notes);
    const run = extractionRuns[doc.id];
    const compareRows = run && !run.classificationBlocked
      ? compareExtractedToStated(doc.documentType, run, application)
      : [];
    const isPending = doc.status !== "verified" && doc.status !== "rejected";
    const taxAuthorizationBlocked = isTaxReturnDocumentType(doc.documentType)
      && !taxDocumentUseAuthorized;

    return (
      <div className="space-y-3 border-t px-3 py-3" data-testid={`doc-review-detail-${doc.id}`}>
        {doc.status === "rejected" && doc.rejectionReason && (
          <p
            className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
            data-testid={`text-reject-reason-${doc.id}`}
          >
            Reason sent to borrower: {doc.rejectionReason}
            {doc.reviewedAt ? ` (${formatDate(doc.reviewedAt)})` : ""}
          </p>
        )}
        {parsed ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {parsed.confidence && (
                <Badge
                  variant="secondary"
                  className={`no-default-hover-elevate ${CONFIDENCE_CHIP[parsed.confidence]}`}
                  data-testid={`badge-confidence-${doc.id}`}
                >
                  {parsed.confidence} confidence
                </Badge>
              )}
              {/* Only while pending — on a verified/rejected doc the stale
                  gate flag reads as "still waiting" and contradicts the badge. */}
              {parsed.humanReviewRequired === true && isPending && (
                <Badge variant="secondary" className="no-default-hover-elevate bg-warning-subtle text-warning-subtle-foreground">
                  Review required
                </Badge>
              )}
              {parsed.extractedAt && (
                <span className="text-xs text-muted-foreground">
                  Extracted {formatDate(parsed.extractedAt)}
                </span>
              )}
            </div>
            {parsed.documentClassification && (
              <div
                className="rounded-md border border-border bg-surface px-2.5 py-2 text-xs"
                data-testid={`document-classification-${doc.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">Page classification</span>
                  <Badge
                    variant="secondary"
                    className={`no-default-hover-elevate ${parsed.documentClassification.compatible ? CONFIDENCE_CHIP.high : CONFIDENCE_CHIP.low}`}
                  >
                    {parsed.documentClassification.compatible ? "Matches upload type" : "Needs correction"}
                  </Badge>
                  {parsed.documentClassification.mixedPacket && (
                    <Badge variant="secondary" className="no-default-hover-elevate bg-warning-subtle text-warning-subtle-foreground">
                      Mixed packet
                    </Badge>
                  )}
                </div>
                {parsed.documentClassification.segments.length > 0 && (
                  <p className="mt-1 text-muted-foreground">
                    {parsed.documentClassification.segments.map((segment) => {
                      const pages = segment.pageStart === segment.pageEnd
                        ? `page ${segment.pageStart}`
                        : `pages ${segment.pageStart}–${segment.pageEnd}`;
                      return `${segment.documentType.replace(/_/g, " ")} (${pages}, ${Math.round(segment.confidence * 100)}%)`;
                    }).join(" · ")}
                  </p>
                )}
              </div>
            )}
            {parsed.documentClassification && (
              <DocumentPacketReview documentId={doc.id} canReview={canReview && isPending} />
            )}
            {parsed.extractedFields.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Fields read: {parsed.extractedFields.join(", ")}
              </p>
            )}
            {parsed.warnings.length > 0 && (
              <ul className="space-y-1 text-xs text-warning-subtle-foreground" data-testid={`doc-warnings-${doc.id}`}>
                {parsed.warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-1">
                    <Icons.warning className={`${iconSize.dense} mt-0.5 shrink-0`} aria-hidden="true" />
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No extraction has run for this document yet.</p>
        )}

        {canReview && isExtractableDocumentType(doc.documentType) && !isTaxReturnDocumentType(doc.documentType) && (
          <div className="flex flex-wrap items-end gap-2">
            <Button
              size="sm" className="touch-target"
              variant="outline"
              disabled={extractMutation.isPending}
              onClick={() => extractMutation.mutate(doc)}
              data-testid={`button-extract-doc-${doc.id}`}
            >
              <Icons.rerun className={`${iconSize.inline} mr-2 ${extractMutation.isPending ? "animate-spin" : ""}`} />
              {extractMutation.isPending ? "Extracting…" : run || parsed ? "Re-run extraction" : "Run extraction"}
            </Button>
          </div>
        )}

        {canReview && isTaxReturnDocumentType(doc.documentType) && (
          <p className={`rounded-md px-2.5 py-2 text-xs ${taxAuthorizationBlocked ? "bg-warning-subtle text-warning-subtle-foreground" : "bg-muted text-muted-foreground"}`}>
            {taxAuthorizationBlocked
              ? "Borrower tax-document authorization is inactive. Preview, analysis, and final review remain locked until the borrower renews it."
              : "Tax analysis runs only while the borrower’s authorization is active. Review the authorized results below."}
          </p>
        )}

        {run && compareRows.length > 0 && (
          <div className="space-y-2" data-testid={`doc-compare-${doc.id}`}>
            {compareRows.map((row, idx) => (
              <div key={idx} className="rounded-md border p-2 text-xs" data-testid={`compare-row-${idx}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{row.label}</span>
                  <Badge variant="secondary" className={`no-default-hover-elevate shrink-0 ${VERDICT_META[row.verdict].chip}`}>
                    {VERDICT_META[row.verdict].label}
                  </Badge>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-2 text-muted-foreground">
                  <span>Stated: {row.statedValue ?? "—"}</span>
                  <span>Extracted: {row.extractedValue ?? "—"}</span>
                </div>
                {row.note && <p className="mt-1 text-muted-foreground">{row.note}</p>}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              This comparison is a triage aid. Confirm the stored values against their source before verifying the document.
            </p>
          </div>
        )}

        {(parsed || run) && (
          <ExtractedFieldReview
            documentId={doc.id}
            canReview={canReview && isPending}
            onOpenSourcePage={onOpenSourcePage}
          />
        )}

        {canReview && isPending && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm" className="touch-target"
              disabled={verifyMutation.isPending || taxAuthorizationBlocked}
              onClick={() => verifyMutation.mutate({ id: doc.id, status: "verified" })}
              data-testid={`button-verify-doc-${doc.id}`}
            >
              <Icons.done className={`${iconSize.inline} mr-2`} />
              Verify
            </Button>
            <Button
              size="sm" className="touch-target"
              variant="outline"
              disabled={verifyMutation.isPending || taxAuthorizationBlocked}
              onClick={() => {
                setRejectTarget(doc);
                setRejectReason("");
              }}
              data-testid={`button-reject-doc-${doc.id}`}
            >
              <Icons.reject className={`${iconSize.inline} mr-2`} />
              Reject
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <Card data-testid="document-review-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icons.documentVerified className={iconSize.emphasis} aria-hidden="true" />
          Document review
        </CardTitle>
        <CardDescription>
          Extraction stages a document for review; verifying it is always a human decision.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground" data-testid="text-no-documents">
            No documents uploaded yet.
          </p>
        ) : (
          <ScrollArea className="h-[560px] pr-3">
            <div className="space-y-4">
              {GROUP_ORDER.map((group) => {
                const docs = grouped.get(group)!;
                if (docs.length === 0) return null;
                return (
                  <div key={group} className="space-y-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium">{GROUP_LABELS[group]}</h3>
                      <Badge variant="secondary" data-testid={`badge-group-count-${group}`}>
                        {docs.length}
                      </Badge>
                    </div>
                    {docs.map((doc) => {
                      const selected = doc.id === selectedDocumentId;
                      return (
                        <div
                          key={doc.id}
                          className={`rounded-lg border ${selected ? "ring-2 ring-ring" : ""}`}
                          data-testid={`doc-review-item-${doc.id}`}
                        >
                          <button
                            type="button"
                            className="flex w-full items-center justify-between gap-2 rounded-lg p-3 text-left hover-elevate"
                            onClick={() => onSelectDocument(doc.id)}
                            aria-pressed={selected}
                            aria-label={`Preview ${doc.fileName}`}
                            data-testid={`button-select-doc-${doc.id}`}
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <Icons.document
                                className={`${iconSize.emphasis} shrink-0 text-muted-foreground`}
                                aria-hidden="true"
                              />
                              <div className="min-w-0">
                                <p className="truncate font-medium">{doc.fileName}</p>
                                <p className="text-xs text-muted-foreground">
                                  {doc.documentType} • {formatDate(doc.createdAt)}
                                </p>
                              </div>
                            </div>
                            <DocumentStatusBadge
                              status={doc.status}
                              audience="staff"
                              className="shrink-0"
                              data-testid={`badge-doc-status-${doc.id}`}
                            />
                          </button>
                          {selected && renderDocDetail(doc)}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>

      <Dialog
        open={!!rejectTarget}
        onOpenChange={(open) => {
          if (!open) {
            setRejectTarget(null);
            setRejectReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject document</DialogTitle>
            <DialogDescription>
              {rejectTarget?.fileName} — the borrower will see this reason on their Documents page
              and be asked to upload a new copy.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="reject-reason">Reason (shown to the borrower)</Label>
            <Textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. Pages 3–4 of the statement are missing — please upload all pages."
              data-testid="input-reject-reason"
            />
            <p className="text-xs text-muted-foreground">
              Written for the borrower: say what to re-upload and why, in plain language.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRejectTarget(null);
                setRejectReason("");
              }}
              data-testid="button-cancel-reject"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={verifyMutation.isPending || rejectReason.trim().length < 12}
              onClick={() =>
                rejectTarget &&
                verifyMutation.mutate({ id: rejectTarget.id, status: "rejected", reason: rejectReason.trim() })
              }
              data-testid="button-confirm-reject"
            >
              {verifyMutation.isPending ? "Sending…" : "Reject & notify borrower"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
