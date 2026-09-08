import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, applicationResourceKeys, coachContextKeys, dashboardKeys, taskKeys, loanApplicationKeys } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@/hooks/use-upload";
import { friendlyApiError } from "@/lib/errorMessage";
import { ACCEPTED_UPLOAD_EXTENSIONS, validateUploadFile } from "@shared/uploads";
import { Button } from "@/components/ui/button";
import { CheckCircle2, FileUp, RefreshCw } from "lucide-react";

/**
 * Inline document upload launcher — lets the borrower attach a specific
 * checklist document right where it's rendered (the coach chat / checklist
 * panel) so they never leave the conversation. This is the "each document has
 * an upload link in the chat" affordance: one button per required document.
 *
 * Reuses the existing two-step flow: useUpload (presigned PUT to object storage)
 * → POST /api/documents/upload to register it against the borrower's loan file.
 * The document's docType is passed straight through as documentType so staff see
 * exactly which checklist item it satisfies. Server auto-attaches to the
 * borrower's most recent application when applicationId is omitted.
 */
export function DocumentUploadButton({
  docType,
  label = "Upload",
  size = "sm",
  variant = "outline",
  className,
  testId,
  applicationId,
  onDone,
}: {
  docType: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "outline" | "default" | "secondary" | "ghost";
  className?: string;
  testId?: string;
  applicationId?: string | null;
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { uploadFile, progress } = useUpload();
  const inputRef = useRef<HTMLInputElement>(null);
  const [done, setDone] = useState(false);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const stored = await uploadFile(file);
      if (!stored) throw new Error("The file could not be uploaded to secure storage. Please try again.");
      const res = await apiRequest("POST", "/api/documents/upload", {
        objectPath: stored.objectPath,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        documentType: docType.slice(0, 50),
        ...(applicationId ? { applicationId } : {}),
      });
      return res.json();
    },
    onSuccess: () => {
      setDone(true);
      // Invalidate the checklist ROOT, not a scoped key: `applicationId` is
      // optional here (the server auto-attaches to the borrower's most recent
      // application when it's omitted), so this uploader often has no id to
      // scope with. The root prefix reaches every mounted checklist either way.
      //
      // This used to fire `["/api/documents"]`, which no client query has ever
      // read — the borrower Documents page moved to the checklist endpoint and
      // the invalidation was never migrated. The result was that a document
      // uploaded from the Homi panel (the only place this button mounts)
      // refreshed nothing, while the same upload through UploadDocumentDialog
      // refreshed correctly.
      queryClient.invalidateQueries({ queryKey: applicationResourceKeys.all() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.root() });
      queryClient.invalidateQueries({ queryKey: taskKeys.all() });
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.actionItemsRoot() });
      queryClient.invalidateQueries({ queryKey: ["/api/shell/badges"] });
      queryClient.invalidateQueries({ queryKey: ["/api/coach/insights"] });
      // The assistant's own checklist. NOT covered by the insights key above:
      // partialMatchKey is element-wise, so ["/api/coach/insights"] never
      // matches ["/api/coach/context"] — a shared "/api/coach" prefix matches
      // nothing. Without this the upload lands, the condition flips, and the
      // panel the borrower uploaded FROM still reads "Needed" — the same
      // silent-success shape this whole change exists to remove.
      queryClient.invalidateQueries({ queryKey: coachContextKeys.root() });
      toast({ title: "Document received", description: "Thanks — that's added to your file. I'll take it from here." });
      onDone?.();
    },
    onError: (err: Error) => {
      toast({
        title: "Couldn't add that document",
        description: friendlyApiError(err, "Nothing was lost — please try again."),
        variant: "destructive",
      });
    },
  });

  const handlePicked = (file: File | null) => {
    if (!file) return;
    const check = validateUploadFile(file);
    if (!check.ok) {
      toast({
        title: check.reason === "size" ? "File too large" : "Unsupported file type",
        description: check.message,
        variant: "destructive",
      });
      return;
    }
    upload.mutate(file);
  };

  const busy = upload.isPending;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_UPLOAD_EXTENSIONS}
        className="hidden"
        onChange={(e) => {
          handlePicked(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
        data-testid={testId ? `input-${testId}` : undefined}
      />
      <Button
        size={size}
        variant={done ? "secondary" : variant}
        className={className}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        data-testid={testId}
      >
        {busy ? (
          <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
        ) : done ? (
          <CheckCircle2 className="mr-1.5 h-3.5 w-3.5 text-success-subtle-foreground" />
        ) : (
          <FileUp className="mr-1.5 h-3.5 w-3.5" />
        )}
        {busy
          ? progress > 0
            ? `Uploading… ${Math.round(progress)}%`
            : "Uploading…"
          : done
            ? "Uploaded — add another"
            : label}
      </Button>
    </>
  );
}
