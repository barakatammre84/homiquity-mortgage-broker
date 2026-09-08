import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, dashboardKeys, applicationResourceKeys, taskKeys, loanApplicationKeys } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@/hooks/use-upload";
import { friendlyApiError } from "@/lib/errorMessage";
import { DocumentDropzone } from "@/components/DocumentDropzone";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle2, FileText, FileUp, Paperclip, Upload, X } from "lucide-react";

/**
 * Smart inline document upload for the messaging surface.
 *
 * Principles (low friction, zero data loss):
 * - Shows exactly what the loan still needs (document-checklist endpoint) and
 * lets the borrower quick-pick an outstanding item in one tap.
 * - Never blocks an upload: anything not on the list goes up as a classified
 * "other" document, stamped onto the loan file server-side.
 * - Duplicates warn gently (server hint) — they are never rejected silently.
 */

/** Canonical upload types — aligned with the server checklist vocabulary. */
export const UPLOADABLE_DOCUMENT_TYPES = [
  { value: "w2", label: "W-2 Forms", category: "Income" },
  { value: "pay_stub", label: "Recent Pay Stubs", category: "Income" },
  { value: "tax_return", label: "Tax Returns", category: "Income" },
  { value: "bank_statement", label: "Bank Statements", category: "Assets" },
  { value: "id", label: "Government-Issued ID", category: "Identity" },
  { value: "purchase_contract", label: "Purchase Contract", category: "Property" },
  { value: "homeowners_insurance", label: "Homeowners Insurance", category: "Property" },
  { value: "lease_agreement", label: "Lease Agreement", category: "Income" },
  { value: "other", label: "Other Document", category: "Other" },
];

/** Older request vocabularies → this dialog's UPLOADABLE_DOCUMENT_TYPES values. */
const TYPE_ALIASES: Record<string, string> = {
  paystub: "pay_stub",
  tax_return_1040: "tax_return",
  bank_statement_checking: "bank_statement",
  bank_statement_savings: "bank_statement",
  drivers_license: "id",
  government_id: "id",
  homeowners_insurance_binder: "homeowners_insurance",
};

/**
 * Resolves a requested document type to a value the type <Select> can actually
 * show. Unknown/custom request types are preserved and added to the selector
 * dynamically so the upload still fulfills the exact request.
 *
 * NOT interchangeable with `canonicalDocumentType` in @shared/documentTypes:
 * that one canonicalizes to the *pipeline-engine* vocabulary for condition
 * matching (drivers_license → government_id), this one targets the *upload
 * select* vocabulary (drivers_license → id). Same input, different output —
 * keep the names distinct so neither gets imported for the other's job.
 */
export function toUploadableDocumentType(type: string | undefined | null): string {
  if (!type) return "other";
  return TYPE_ALIASES[type] ?? type;
}

interface ChecklistItem {
  id: string;
  documentType: string;
  label: string;
  status: "needed" | "uploaded" | "verifying" | "verified" | "rejected";
  instructions?: string;
  documentId?: string;
  rejectionReason?: string | null;
}

interface ChecklistResponse {
  documents: ChecklistItem[];
  stats: { total: number; verified: number; uploaded: number; needed: number; rejected: number };
}

function useDocumentChecklist(applicationId: string | null | undefined, enabled = true) {
  return useQuery<ChecklistResponse>({
    queryKey: applicationResourceKeys.documentChecklist(applicationId),
    enabled: !!applicationId && enabled,
    staleTime: 15_000,
  });
}

// Borrower-actionable outstanding items only. "Other" remains a free-form
// upload choice, not a useful one-tap request label.
function outstandingItems(checklist: ChecklistResponse | undefined): ChecklistItem[] {
  return (checklist?.documents ?? []).filter(
    (d) => (d.status === "needed" || d.status === "rejected") && d.documentType !== "other",
  );
}

export function UploadDocumentDialog({
  applicationId,
  defaultDocumentType,
  requestMessageId,
  replacesDocumentId,
  confirmToRecipientId,
  trigger,
  onUploaded,
}: {
  /** Loan file this upload belongs to; the server derives it when absent. */
  applicationId?: string | null;
  /** Pre-selected type (e.g. from a document-request card). */
  defaultDocumentType?: string;
  /** When the upload fulfills a chat document request, its message id. */
  requestMessageId?: string;
  /** Exact rejected version this response supersedes. */
  replacesDocumentId?: string;
  /** When set, posts an upload confirmation into this chat thread. */
  confirmToRecipientId?: string;
  trigger: React.ReactNode;
  onUploaded?: () => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<string>(toUploadableDocumentType(defaultDocumentType));
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<"idle" | "uploading" | "registering">("idle");
  const { toast } = useToast();
  const { uploadFile, progress } = useUpload();

  const { data: checklist } = useDocumentChecklist(applicationId, open);
  const neededItems = outstandingItems(checklist);
  const uploadTypeOptions = [...UPLOADABLE_DOCUMENT_TYPES];
  const optionValues = new Set(uploadTypeOptions.map((option) => option.value));
  for (const item of neededItems) {
    const value = toUploadableDocumentType(item.documentType);
    if (!optionValues.has(value)) {
      uploadTypeOptions.push({ value, label: item.label, category: "Requested" });
      optionValues.add(value);
    }
  }
  const defaultValue = toUploadableDocumentType(defaultDocumentType);
  if (defaultDocumentType && !optionValues.has(defaultValue)) {
    uploadTypeOptions.push({
      value: defaultValue,
      label: defaultDocumentType.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase()),
      category: "Requested",
    });
  }
  const selectedChecklistItem = neededItems.find(
    (item) => toUploadableDocumentType(item.documentType) === selectedType,
  );
  const effectiveReplacementId =
    replacesDocumentId ??
    (selectedChecklistItem?.status === "rejected"
      ? selectedChecklistItem.documentId
      : undefined);

  const busy = phase !== "idle";
  const typeLabel =
    uploadTypeOptions.find((t) => t.value === selectedType)?.label ??
    "Document";

  const reset = () => {
    setFile(null);
    setDescription("");
    setSelectedType(toUploadableDocumentType(defaultDocumentType));
    setPhase("idle");
  };

  const submit = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose a file first");

      setPhase("uploading");
      const stored = await uploadFile(file);
      if (!stored) throw new Error("The file could not be uploaded to secure storage. Please try again.");

      setPhase("registering");
      const res = await apiRequest("POST", "/api/documents/upload", {
        objectPath: stored.objectPath,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        documentType: selectedType,
        applicationId: applicationId || undefined,
        description: description || undefined,
        replacesDocumentId: effectiveReplacementId,
        requestMessageId,
      });
      const document = await res.json();

      // Confirm in the thread so the team sees it instantly (and gets the
      // standard message notification).
      let confirmationFailed = false;
      if (confirmToRecipientId) {
        try {
          await apiRequest("POST", "/api/messages", {
            recipientId: confirmToRecipientId,
            message: `📎 Uploaded: ${file.name} (${typeLabel})`,
            applicationId: applicationId || undefined,
          });
        } catch {
          // Registration already succeeded and the request card is already
          // submitted. Do not tell the borrower the upload failed or invite a
          // duplicate retry just because the optional chat receipt failed.
          confirmationFailed = true;
        }
      }

      return { ...document, confirmationFailed };
    },
    onSuccess: (document) => {
      queryClient.invalidateQueries({ queryKey: applicationResourceKeys.documentChecklist(applicationId) });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.root() });
      queryClient.invalidateQueries({ queryKey: taskKeys.all() });
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.actionItemsRoot() });
      queryClient.invalidateQueries({ queryKey: ["/api/shell/badges"] });
      if (confirmToRecipientId || requestMessageId) {
        queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
        queryClient.invalidateQueries({ queryKey: ["/api/messages/conversations"] });
      }
      const confirmationCopy = document?.confirmationFailed
        ? " Your document is filed; the separate chat receipt could not be sent."
        : "";
      if (document?.similarDocument) {
        toast({
          title: "Heads up: possible duplicate",
          description: `This looks similar to ${document.similarDocument.fileName} you uploaded earlier. We kept both — your team can remove one if needed.${confirmationCopy}`,
        });
      } else {
        toast({ title: "Document uploaded", description: `${typeLabel} is with your loan team.${confirmationCopy}` });
      }
      reset();
      setOpen(false);
      onUploaded?.();
    },
    onError: (error: Error) => {
      setPhase("idle");
      toast({
        title: "Upload didn't go through",
        description: friendlyApiError(
          error,
          "Nothing was lost — the file is still on your device. Please try again.",
        ),
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return; // don't close mid-upload
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload a document</DialogTitle>
          <DialogDescription>
            Pick something your team asked for, or upload any other document — nothing gets lost.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {neededItems.length > 0 && (
            <div className="space-y-2">
              <Label>Still needed for your loan</Label>
              <div className="flex flex-wrap gap-2" data-testid="needed-doc-chips">
                {neededItems.map((item) => (
                  <Button
                    key={item.id}
                    type="button"
                    size="sm" className="touch-target"
                    variant={selectedType === toUploadableDocumentType(item.documentType) ? "default" : "outline"}
                    onClick={() => setSelectedType(toUploadableDocumentType(item.documentType))}
                    data-testid={`chip-needed-${item.documentType}`}
                  >
                    <FileText className="mr-1.5 h-3.5 w-3.5" />
                    {item.label}
                    {item.status === "rejected" && (
                      <Badge variant="destructive" className="ml-1.5 text-[10px]">Re-upload</Badge>
                    )}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="upload-doc-type">Document type</Label>
            <Select value={selectedType} onValueChange={setSelectedType} disabled={busy}>
              <SelectTrigger id="upload-doc-type" data-testid="select-upload-doc-type">
                <SelectValue placeholder="What is this document?" />
              </SelectTrigger>
              <SelectContent>
                {uploadTypeOptions.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    <div className="flex items-center gap-2">
                      <span>{t.label}</span>
                      <Badge variant="secondary" className="text-xs">{t.category}</Badge>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>File</Label>
            {file ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm">{file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                </div>
                {!busy && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon" aria-label="Remove file"
                    onClick={() => setFile(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ) : (
              // Validates type + the shared size cap itself (the old copy
              // promised 25MB while the server enforced 10MB).
              <DocumentDropzone
                compact
                onFileAccepted={setFile}
                data-testid="dropzone-upload-dialog"
              />
            )}
          </div>

          {selectedType === "other" && (
            <div className="space-y-2">
              <Label htmlFor="upload-doc-description">What is it? (helps your team file it fast)</Label>
              <Textarea
                id="upload-doc-description"
                placeholder='e.g. "Gift letter from my parents" or "2024 bonus statement"'
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={busy}
                data-testid="input-upload-description"
              />
            </div>
          )}

          {busy && (
            <div className="space-y-1.5" data-testid="upload-progress">
              {/* Real byte-level progress from the XHR PUT; registration is a
                  quick JSON call shown as the near-done tail. */}
              <Progress value={phase === "uploading" ? Math.max(progress, 3) : 95} />
              <p className="text-xs text-muted-foreground">
                {phase === "uploading"
                  ? `Uploading to secure storage… ${Math.round(progress)}%`
                  : "Filing it on your loan…"}
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => submit.mutate()}
            disabled={!file || busy}
            data-testid="button-submit-upload"
          >
            <FileUp className="mr-2 h-4 w-4" />
            Upload {typeLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Persistent "what's still needed" strip for the chat thread. Renders only
 * when the loan actually needs something — progress, not nagging.
 */
export function DocumentNeedsSummary({
  applicationId,
  recipientId,
}: {
  applicationId: string | null | undefined;
  recipientId: string;
}) {
  const { data: checklist } = useDocumentChecklist(applicationId);
  const needed = outstandingItems(checklist).length;
  if (!applicationId || needed === 0) return null;

  return (
    <div
      className="mx-auto mb-2 flex w-full max-w-3xl items-center justify-between gap-3 rounded-lg border border-border bg-warning-subtle px-3 py-2"
      data-testid="document-needs-summary"
    >
      <div className="flex items-center gap-2 text-sm">
        <FileText className="h-4 w-4 shrink-0 text-warning-subtle-foreground" />
        <span className="text-warning-subtle-foreground">
          Your loan still needs <strong>{needed} document{needed === 1 ? "" : "s"}</strong>
        </span>
      </div>
      <UploadDocumentDialog
        applicationId={applicationId}
        confirmToRecipientId={recipientId}
        trigger={
          <Button size="sm" variant="outline" className="touch-target shrink-0" data-testid="button-needs-upload">
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Upload
          </Button>
        }
      />
    </div>
  );
}

/** Small inline confirmation for fulfilled requests (used by chat cards). */
export function UploadedConfirmation({ fileName }: { fileName?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-success-subtle-foreground">
      <CheckCircle2 className="h-3.5 w-3.5" />
      <span>{fileName ? `${fileName} submitted` : "Submitted"}</span>
    </div>
  );
}
