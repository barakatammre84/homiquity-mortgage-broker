// Presentational row for a single document-checklist item (static catalog or
// personalized checklist) — extracted from the borrower Documents page so
// that page can stay focused on data-fetching/state and this stays pure UI.
import { formatDate } from "@/lib/formatters";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DocumentStatusBadge } from "@/components/DocumentStatusBadge";
import { DocumentDropzone, UploadProgressCard } from "@/components/DocumentDropzone";
import {
  Download,
  Upload,
  CheckCircle2,
  Circle,
  AlertCircle,
  FileCheck,
  Clock,
  Shield,
} from "lucide-react";

// One row model feeding one row component, whichever path produced it — the
// static catalog and the personalized checklist must never render differently.
export interface DocRow {
  /** Readable key used in data-testids (document type). */
  key: string;
  /** Identifies THIS row's in-flight upload (unique per row). */
  uploadKey: string;
  /** documentType POSTed on upload. */
  uploadType: string;
  name: string;
  description?: string;
  /** Which year's document is being asked for ("2023") — from the requesting task. */
  year?: string;
  /** Staff-authored borrower-facing instructions (tasks.documentInstructions). */
  instructions?: string;
  required: boolean;
  status: "needed" | "uploaded" | "verifying" | "verified" | "rejected";
  fileName?: string;
  uploadedAt?: string | Date | null;
  documentId?: string;
  rejectionReason?: string | null;
  focused?: boolean;
}

export function DocumentItemRow({
  row,
  uploading,
  uploadingFile,
  progress,
  anyUploadBusy,
  onFile,
  onBrowse,
  onCancel,
}: {
  row: DocRow;
  uploading: boolean;
  uploadingFile: { fileName: string; fileSize: number } | null;
  progress: number;
  anyUploadBusy: boolean;
  onFile: (file: File) => void;
  onBrowse: () => void;
  onCancel: () => void;
}) {
  const hasUpload = row.status !== "needed";
  const isRejected = row.status === "rejected";
  const isVerified = row.status === "verified";
  const isUnderReview = row.status === "uploaded" || row.status === "verifying";
  // Pending items and bounced items invite a (re-)upload right in the row;
  // accepted/in-review items stay calm.
  const showDropzone = !uploading && (!hasUpload || isRejected);

  return (
    <div
      className={`p-4 rounded-lg transition-colors ${
        isRejected
          ? "bg-destructive/5"
          : isVerified
          ? "bg-success-subtle/50"
          : isUnderReview
          ? "bg-info-subtle/50"
          : row.required
          ? "bg-warning-subtle/50"
          : "bg-muted/30"
      } ${row.focused ? "ring-2 ring-primary" : ""}`}
      data-testid={`row-doctype-${row.key}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 flex-1">
          {isRejected ? (
            <AlertCircle className="h-5 w-5 text-destructive shrink-0" />
          ) : isVerified ? (
            <CheckCircle2 className="h-5 w-5 text-success-subtle-foreground shrink-0" />
          ) : isUnderReview ? (
            <Clock className="h-5 w-5 text-info-subtle-foreground shrink-0" />
          ) : row.required ? (
            <AlertCircle className="h-5 w-5 text-warning-subtle-foreground shrink-0" />
          ) : (
            <Circle className="h-5 w-5 text-muted-foreground shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{row.name}</span>
              {row.year && (
                <span
                  className="text-xs text-muted-foreground"
                  data-testid={`text-doc-year-${row.key}`}
                >
                  · {row.year}
                </span>
              )}
              {row.required && !hasUpload && (
                <Badge variant="outline" className="text-xs border-border text-warning-subtle-foreground">
                  Required
                </Badge>
              )}
              {row.required && isVerified && (
                <Badge variant="outline" className="text-xs border-border text-success-subtle-foreground">
                  Complete
                </Badge>
              )}
              {row.required && isUnderReview && (
                <Badge variant="outline" className="text-xs border-border text-info-subtle-foreground">
                  Submitted
                </Badge>
              )}
            </div>
            {row.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{row.description}</p>
            )}
            {row.instructions && (
              <p
                className="text-xs text-foreground/80 mt-1"
                data-testid={`text-doc-instructions-${row.key}`}
              >
                {row.instructions}
              </p>
            )}
            {hasUpload && (
              <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                {row.fileName && (
                  <span className="flex items-center gap-1">
                    <FileCheck className="h-3 w-3" />
                    {row.fileName}
                  </span>
                )}
                {row.uploadedAt && (
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatDate(row.uploadedAt)}
                  </span>
                )}
                <span className="flex items-center gap-1">
                  <Shield className="h-3 w-3" />
                  <DocumentStatusBadge status={row.status} data-testid={`badge-doc-status-${row.key}`} />
                </span>
              </div>
            )}
            {isRejected && row.rejectionReason && (
              <p
                className="mt-2 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
                data-testid={`text-reject-reason-${row.key}`}
              >
                {row.rejectionReason} — please upload a new copy.
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 ml-4">
          {hasUpload && row.documentId && (
            <Button
              size="sm"
              variant="ghost"
              className="touch-target gap-1.5"
              data-testid={`button-download-${row.key}`}
              onClick={() => window.open(`/api/documents/${row.documentId}/download`, "_blank")}
            >
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline">View</span>
            </Button>
          )}
          {hasUpload && !isRejected && (
            <Button
              size="sm"
              variant="outline"
              className="touch-target gap-1.5"
              data-testid={`button-upload-${row.key}`}
              disabled={anyUploadBusy}
              onClick={onBrowse}
            >
              <Upload className="h-4 w-4" />
              <span className="hidden sm:inline">Replace</span>
            </Button>
          )}
        </div>
      </div>
      {uploading && uploadingFile && (
        <div className="mt-3">
          <UploadProgressCard
            fileName={uploadingFile.fileName}
            fileSize={uploadingFile.fileSize}
            progress={progress}
            onCancel={onCancel}
            data-testid={`upload-progress-${row.key}`}
          />
        </div>
      )}
      {showDropzone && (
        <div className="mt-3">
          <DocumentDropzone
            compact
            disabled={anyUploadBusy}
            onFileAccepted={onFile}
            idleLabel={
              isRejected
                ? "Upload a new copy — drag & drop, or browse"
                : `Drag & drop your ${row.name.toLowerCase()}, or browse`
            }
            data-testid={`dropzone-${row.key}`}
          />
        </div>
      )}
    </div>
  );
}
