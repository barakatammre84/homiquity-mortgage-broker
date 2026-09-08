import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, dashboardKeys, taskKeys, loanApplicationKeys } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@/hooks/use-upload";
import { useLocation, useRoute } from "wouter";
import { isStaffRole } from "@shared/roles";
import type { Task, Document, TaskDocument, TaskPriority } from "@shared/schema";
import {
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  FileText,
  Upload,
  Calendar,
  X,
  Loader2,
} from "lucide-react";
import { format } from "date-fns";
import { PageShell } from "@/components/PageShell";

interface TaskWithDocs extends Task {
  documents: (TaskDocument & { document: Document })[];
}

// Badge over both task axes: lifecycle (tasks.status, canonical uppercase) and
// the verification verdict (verificationStatus) — a rejection outranks the
// lifecycle label because it is the thing the borrower must act on.
function getStatusBadge(task: Pick<Task, "status" | "verificationStatus">) {
  if (task.verificationStatus === "rejected" && task.status !== "COMPLETED") {
    return <Badge variant="destructive">Rejected</Badge>;
  }
  const statusConfig: Record<Task["status"], { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
    OPEN: { variant: "secondary", label: "Pending" },
    IN_PROGRESS:
      task.verificationStatus === "pending"
        ? { variant: "outline", label: "Submitted - Awaiting Review" }
        : { variant: "default", label: "In Progress" },
    BLOCKED: { variant: "secondary", label: "Blocked" },
    COMPLETED: { variant: "default", label: "Completed" },
    EXPIRED: { variant: "secondary", label: "Expired" },
  };
  const config = statusConfig[task.status] || { variant: "secondary" as const, label: task.status };
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

function getPriorityBadge(priority: TaskPriority) {
  const config: Record<TaskPriority, { className: string; label: string }> = {
    low: { className: "bg-muted text-muted-foreground", label: "Low Priority" },
    normal: { className: "bg-info-subtle text-info", label: "Normal Priority" },
    high: { className: "bg-warning-subtle text-warning-subtle-foreground", label: "High Priority" },
    urgent: { className: "bg-destructive-subtle text-destructive", label: "Urgent" },
  };
  const p = config[priority] ?? config.normal; // runtime guard: pre-0034 legacy rows
  return <Badge className={p.className}>{p.label}</Badge>;
}

export default function TaskDetail() {
  const queryClient = useQueryClient();
  const [, params] = useRoute("/task/:id");
  const taskId = params?.id;
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const { uploadFile } = useUpload();
  const [, navigate] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [verificationNotes, setVerificationNotes] = useState("");

  const { data: task, isLoading } = useQuery<TaskWithDocs>({
    queryKey: taskKeys.detail(taskId!),
    enabled: !authLoading && !!taskId,
  });

  const uploadDocumentMutation = useMutation({
    mutationFn: async (file: File) => {
      // Presigned flow: the file goes browser → object storage directly, then
      // the JSON call registers it as a document (the multipart leg is gone).
      const stored = await uploadFile(file);
      if (!stored) {
        throw new Error("The file could not be uploaded to secure storage. Please try again.");
      }

      const response = await apiRequest("POST", "/api/documents/upload", {
        objectPath: stored.objectPath,
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        documentType: task?.documentCategory || "other",
        applicationId: task?.applicationId || undefined,
      });

      // Upload registration now links the matching task centrally, so task
      // detail, Documents, To-Do, and Homi all have the same outcome.
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.detail(taskId!) });
      queryClient.invalidateQueries({ queryKey: taskKeys.all() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.root() });
      if (task?.applicationId) {
        queryClient.invalidateQueries({ queryKey: loanApplicationKeys.actionItems(task.applicationId) });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/shell/badges"] });
      toast({
        title: "Document Uploaded",
        description: "Your document has been uploaded and is pending review.",
      });
      setIsUploading(false);
    },
    onError: (error: Error) => {
      toast({
        title: "Upload Failed",
        description: error.message || "Failed to upload document",
        variant: "destructive",
      });
      setIsUploading(false);
    },
  });

  const verifyDocumentMutation = useMutation({
    mutationFn: async ({ docId, isVerified }: { docId: string; isVerified: boolean }) => {
      const response = await apiRequest("PATCH", `/api/tasks/${taskId}/documents/${docId}/verify`, {
        isVerified,
        verificationNotes,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.detail(taskId!) });
      queryClient.invalidateQueries({ queryKey: taskKeys.all() });
      toast({
        title: "Document Updated",
        description: "The document verification status has been updated.",
      });
      setVerificationNotes("");
    },
    // Silent before, and this is the worst place for it: the server rejects
    // this for a staff member who is not on the deal team (403), and a verdict
    // that never landed looked identical to one that did — on the action that
    // completes or reopens the task. The notes are deliberately NOT cleared, so
    // the reviewer does not have to retype them.
    onError: (error: Error) => {
      toast({
        title: "Verification not saved",
        description: error.message || "The document's status is unchanged. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setIsUploading(true);
      uploadDocumentMutation.mutate(file);
    }
  };

  if (authLoading || isLoading) {
    return (
      <PageShell width="wide">
        <Skeleton className="mb-8 h-8 w-48" />
        <Skeleton className="h-64" />
      </PageShell>
    );
  }

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-8 text-center">
            <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h2 className="text-xl font-semibold mb-2">Task Not Found</h2>
            <p className="text-muted-foreground mb-4">
              The task you're looking for doesn't exist or you don't have access.
            </p>
            <Button onClick={() => navigate("/tasks")}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to Tasks
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isStaff = isStaffRole(user?.role || "");
  const isAssignedUser = task.assignedToUserId === user?.id;
  // Upload while the ball is in the borrower's court (OPEN covers both the
  // initial request and a reopened-after-rejection task); verify once a
  // document is submitted and the verdict is still pending.
  const canUpload = isAssignedUser && task.status === "OPEN";
  const canVerify = isStaff && task.status === "IN_PROGRESS" && task.verificationStatus === "pending";

  return (
    <PageShell
      width="wide"
      title={task.title}
      titleTestId="text-task-title"
      headerLead={
        <Button
          variant="ghost"
          onClick={() => navigate(isStaff ? "/staff-dashboard" : "/tasks")}
          className="-ml-2"
          data-testid="button-back"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
      }
      headerMeta={
        <div className="flex flex-wrap items-center gap-2">
          {getStatusBadge(task)}
          {getPriorityBadge(task.priority || "normal")}
          {task.dueDate && (
            <span className="text-sm text-muted-foreground flex items-center gap-1">
              <Calendar className="h-4 w-4" />
              Due: {format(new Date(task.dueDate), "MMMM d, yyyy")}
            </span>
          )}
        </div>
      }
    >
            <div className="grid gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2 space-y-6">
                {task.documentInstructions && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Instructions</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-muted-foreground" data-testid="text-instructions">
                        {task.documentInstructions}
                      </p>
                    </CardContent>
                  </Card>
                )}

                {task.description && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Description</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-muted-foreground">{task.description}</p>
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Uploaded Documents</CardTitle>
                    <CardDescription>
                      {task.documents?.length || 0} document(s) uploaded for this task
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {(!task.documents || task.documents.length === 0) ? (
                      <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-lg">
                        <FileText className="mx-auto h-12 w-12 mb-4" />
                        <p>No documents uploaded yet</p>
                        {canUpload && (
                          <p className="text-sm mt-2">
                            Click the upload button to add your document
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {task.documents.map((taskDoc) => (
                          <div
                            key={taskDoc.id}
                            className={`flex items-center justify-between rounded-lg border p-4 ${
                              taskDoc.isVerified
                                ? "bg-success-subtle border-border"
                                : ""
                            }`}
                            data-testid={`document-${taskDoc.id}`}
                          >
                            <div className="flex items-center gap-4">
                              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                                <FileText className="h-5 w-5" />
                              </div>
                              <div>
                                <p className="font-medium">{taskDoc.document.fileName}</p>
                                <p className="text-sm text-muted-foreground">
                                  {format(new Date(taskDoc.createdAt!), "MMM d, yyyy 'at' h:mm a")}
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {taskDoc.isVerified ? (
                                <Badge variant="success">
                                  <CheckCircle2 className="mr-1 h-3 w-3" />
                                  Verified
                                </Badge>
                              ) : (
                                <Badge variant="secondary">Pending Review</Badge>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {canUpload && (
                      <div className="mt-6">
                        <input
                          type="file"
                          ref={fileInputRef}
                          onChange={handleFileSelect}
                          className="hidden"
                          accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                          data-testid="input-file-upload"
                        />
                        <Button
                          onClick={() => fileInputRef.current?.click()}
                          disabled={isUploading}
                          className="w-full"
                          data-testid="button-upload-document"
                        >
                          {isUploading ? (
                            <>
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                              Uploading...
                            </>
                          ) : (
                            <>
                              <Upload className="mr-2 h-4 w-4" />
                              Upload Document
                            </>
                          )}
                        </Button>
                        <p className="text-sm text-muted-foreground text-center mt-2">
                          Supported formats: PDF, JPG, PNG, DOC, DOCX
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {canVerify && task.documents && task.documents.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Verify Documents</CardTitle>
                      <CardDescription>
                        Review the uploaded documents and verify or reject them
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="space-y-2">
                        <Label htmlFor="notes">Verification Notes (Optional)</Label>
                        <Textarea
                          id="notes"
                          placeholder="Add any notes about the verification..."
                          value={verificationNotes}
                          onChange={(e) => setVerificationNotes(e.target.value)}
                          data-testid="input-verification-notes"
                        />
                        <p className="text-sm text-muted-foreground">
                          Saved against whichever document you approve or reject next, then cleared.
                        </p>
                      </div>
                      {/*
                        One control pair PER DOCUMENT. Both buttons used to act on
                        documents[documents.length - 1], so on a multi-upload task
                        ("2 years of tax returns", "last 3 pay stubs") every earlier
                        document was unreachable — a reviewer who believed they had
                        approved "the tax returns" had approved exactly one file,
                        and the rest stayed unverified forever. The API has always
                        taken a docId; only this UI collapsed the choice (#484).
                      */}
                      <div className="space-y-3">
                        {task.documents.map((taskDoc) => (
                          <div
                            key={taskDoc.id}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                            data-testid={`verify-row-${taskDoc.id}`}
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-medium" title={taskDoc.document.fileName}>
                                {taskDoc.document.fileName}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {taskDoc.isVerified ? "Verified" : "Not yet verified"}
                              </p>
                            </div>
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                size="sm" className="touch-target"
                                onClick={() => verifyDocumentMutation.mutate({ docId: taskDoc.id, isVerified: false })}
                                disabled={verifyDocumentMutation.isPending}
                                data-testid={`button-reject-document-${taskDoc.id}`}
                                aria-label={`Reject ${taskDoc.document.fileName}`}
                              >
                                <X className="mr-2 h-4 w-4" />
                                Reject
                              </Button>
                              <Button
                                size="sm" className="touch-target"
                                onClick={() => verifyDocumentMutation.mutate({ docId: taskDoc.id, isVerified: true })}
                                disabled={verifyDocumentMutation.isPending}
                                data-testid={`button-approve-document-${taskDoc.id}`}
                                aria-label={`Approve and verify ${taskDoc.document.fileName}`}
                              >
                                <CheckCircle2 className="mr-2 h-4 w-4" />
                                Approve & Verify
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>

              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Task Details</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <p className="text-sm text-muted-foreground">Task Type</p>
                      <p className="font-medium capitalize">{task.taskType.replace(/_/g, " ")}</p>
                    </div>
                    {task.documentCategory && (
                      <div>
                        <p className="text-sm text-muted-foreground">Document Type</p>
                        <p className="font-medium capitalize">{task.documentCategory.replace(/_/g, " ")}</p>
                      </div>
                    )}
                    {task.documentYear && (
                      <div>
                        <p className="text-sm text-muted-foreground">Year</p>
                        <p className="font-medium">{task.documentYear}</p>
                      </div>
                    )}
                    <div>
                      <p className="text-sm text-muted-foreground">Created</p>
                      <p className="font-medium">
                        {format(new Date(task.createdAt!), "MMMM d, yyyy")}
                      </p>
                    </div>
                    {task.verifiedAt && (
                      <div>
                        <p className="text-sm text-muted-foreground">Verified</p>
                        <p className="font-medium">
                          {format(new Date(task.verifiedAt), "MMMM d, yyyy")}
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Server strips verificationNotes for client roles
                    (borrowerTaskView); the isStaff guard states the intent. */}
                {isStaff && task.verificationNotes && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Verification Notes</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-muted-foreground" data-testid="text-verification-notes">
                        {task.verificationNotes}
                      </p>
                    </CardContent>
                  </Card>
                )}

                {task.verificationStatus === "rejected" && task.status !== "COMPLETED" && (
                  <Card className="border-border bg-destructive-subtle">
                    <CardContent className="p-6">
                      <div className="flex items-start gap-3">
                        <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
                        <div>
                          <p className="font-medium text-destructive">
                            Document Rejected
                          </p>
                          <p className="text-sm text-destructive mt-1">
                            Please upload a new copy of this document.
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {task.status === "COMPLETED" && (
                  <Card className="border-border bg-success-subtle">
                    <CardContent className="p-6">
                      <div className="flex items-start gap-3">
                        <CheckCircle2 className="h-5 w-5 text-success-subtle-foreground mt-0.5" />
                        <div>
                          <p className="font-medium text-success-subtle-foreground">
                            Task Complete
                          </p>
                          <p className="text-sm text-success-subtle-foreground mt-1">
                            Your document has been verified and accepted.
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
            </div>
    </PageShell>
  );
}
