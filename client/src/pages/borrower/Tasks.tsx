import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, taskKeys, dashboardKeys, applicationResourceKeys, loanApplicationKeys } from "@/lib/queryClient";
import { friendlyApiError } from "@/lib/errorMessage";
import { titleCaseFromSnake } from "@/lib/formatters";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskProgress } from "@/components/patterns/TaskProgress";
import { isPendingTask, isRejectedTask } from "@/lib/outstandingWork";
import { EmptyState } from "@/components/patterns/EmptyState";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@/hooks/use-upload";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "wouter";
import type { Task, LoanApplication, TaskPriority } from "@shared/schema";
import { useActiveApplication } from "@/hooks/useActiveApplication";
import { useBorrowerActionItems } from "@/hooks/useBorrowerActionItems";
import {
  CheckCircle2,
  Clock,
  FileText,
  Upload,
  AlertCircle,
  Calendar,
  File,
  X,
  CheckSquare,
} from "lucide-react";
import { format } from "date-fns";
import { PageShell } from "@/components/PageShell";
import { QueryErrorState } from "@/components/ui/query-boundary";

interface DashboardData {
  applications: LoanApplication[];
}

// Badge over both task axes: lifecycle (tasks.status, canonical uppercase) and
// the verification verdict (verificationStatus) — a rejection outranks the
// lifecycle label because it is the thing the borrower must act on.
function getTaskStatusBadge(task: Pick<Task, "status" | "verificationStatus">) {
  if (task.verificationStatus === "rejected" && task.status !== "COMPLETED") {
    return <Badge variant="destructive">Needs Attention</Badge>;
  }
  const config: Record<Task["status"], { variant: "default" | "secondary" | "destructive" | "outline"; label: string }> = {
    OPEN: { variant: "secondary", label: "Pending" },
    IN_PROGRESS:
      task.verificationStatus === "pending"
        ? { variant: "default", label: "Submitted" }
        : { variant: "outline", label: "In Progress" },
    BLOCKED: { variant: "secondary", label: "Blocked" },
    COMPLETED: { variant: "default", label: "Completed" },
    EXPIRED: { variant: "secondary", label: "Expired" },
  };
  const c = config[task.status] || { variant: "secondary" as const, label: task.status };
  return <Badge variant={c.variant}>{c.label}</Badge>;
}

function getPriorityBadge(priority: TaskPriority) {
  const config: Record<TaskPriority, { className: string; label: string }> = {
    low: { className: "bg-muted text-muted-foreground", label: "Low" },
    normal: { className: "bg-primary/10 text-primary", label: "Normal" },
    high: { className: "bg-status-warning/10 text-status-warning", label: "High" },
    urgent: { className: "bg-status-danger/10 text-status-danger", label: "Urgent" },
  };
  const p = config[priority] ?? config.normal; // runtime guard: pre-0034 legacy rows
  return <Badge className={`no-default-hover-elevate no-default-active-elevate ${p.className}`}>{p.label}</Badge>;
}

function getDocumentCategoryLabel(category: string) {
  const labels: Record<string, string> = {
    tax_return: "Tax Return",
    pay_stub: "Pay Stub",
    bank_statement: "Bank Statement",
    bank_statement_business: "Business Bank Statement",
    w2: "W-2 Form",
    id: "Government ID",
    government_id: "Government ID",
    homeowners_insurance: "Homeowners Insurance",
    purchase_contract: "Purchase Contract",
    gift_letter: "Gift Letter",
    profit_loss: "Profit & Loss Statement",
    business_license: "Business License",
    reserves_proof: "Proof of Reserves",
    third_party_payment_history: "12-Month Third-Party Payment History",
    social_security_award: "Social Security Award Letter",
    pension_statement: "Pension Statement",
    letter_of_explanation: "Letter of Explanation",
    other: "Other Document",
  };
  // Fallback: humanize unknown snake_case types instead of showing raw keys.
  return labels[category] || titleCaseFromSnake(category);
}

function getDocumentTaskLabel(
  task: Pick<Task, "documentCategory" | "title" | "description">,
) {
  if (
    task.documentCategory === "tax_return" &&
    /schedule e/i.test(`${task.title} ${task.description ?? ""}`)
  ) {
    return "Rental Tax Return & Schedule E";
  }

  return task.documentCategory
    ? getDocumentCategoryLabel(task.documentCategory)
    : task.title;
}

export default function Tasks() {
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const { uploadFile } = useUpload();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const { data: dashboardData, isLoading: dashboardLoading } = useQuery<DashboardData>({
    queryKey: dashboardKeys.root(),
    enabled: !authLoading,
  });

  // Resolved up here (not at the point of use) because Rules of Hooks bars a
  // hook call after the loading/error early returns below.
  const applications = dashboardData?.applications || [];
  const { activeApplication } = useActiveApplication(applications);
  const { data: actionItemsData } = useBorrowerActionItems(activeApplication?.id);

  const {
    data: tasks,
    isLoading: tasksLoading,
    isError: tasksIsError,
    error: tasksError,
    refetch: refetchTasks,
  } = useQuery<Task[]>({
    queryKey: taskKeys.all(),
    enabled: !authLoading && !!user,
  });

  const updateTaskMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Task> }) => {
      const response = await apiRequest("PATCH", `/api/tasks/${id}`, data);
      return await response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: taskKeys.all() });
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.actionItemsRoot() });
      toast({ title: "Task updated", description: "Your task has been updated." });
    },
    onError: (error: Error) => {
      toast({
        title: "Update Failed",
        description: error.message || "Failed to update task",
        variant: "destructive",
      });
    },
  });

  const handleFileUpload = async () => {
    if (!selectedTask || !selectedFile) return;

    setIsUploading(true);
    try {
      // Presigned flow: the file goes browser → object storage directly, then
      // the JSON call registers it as a document (the multipart leg is gone).
      const stored = await uploadFile(selectedFile);
      if (!stored) {
        throw new Error("The file could not be uploaded to secure storage. Please try again.");
      }

      const uploadResponse = await apiRequest("POST", "/api/documents/upload", {
        objectPath: stored.objectPath,
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
        mimeType: selectedFile.type,
        documentType: selectedTask.documentCategory || "other",
        applicationId: selectedTask.applicationId,
      });

      await uploadResponse.json();

      // Registration advances and links the matching borrower task on the
      // server, regardless of which upload surface initiated it. A second
      // client request here used to make To-Do behave differently from
      // Documents and Homi.

      queryClient.invalidateQueries({ queryKey: taskKeys.all() });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.root() });
      queryClient.invalidateQueries({ queryKey: ["/api/shell/badges"] });
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.actionItems(selectedTask.applicationId) });
      // Was ["/api/documents"] — a key no client query reads. The upload also
      // satisfies a checklist item, so refresh the checklist root.
      queryClient.invalidateQueries({ queryKey: applicationResourceKeys.all() });

      toast({
        title: "Document Uploaded",
        description: "Your document has been submitted for review.",
      });

      setUploadDialogOpen(false);
      setSelectedFile(null);
      setSelectedTask(null);
    } catch (error) {
      toast({
        title: "Upload Failed",
        description: friendlyApiError(error, "There was an error uploading your document."),
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  if (authLoading || dashboardLoading || tasksLoading) {
    return (
      <div className="p-8">
        <Skeleton className="mb-8 h-8 w-48" />
        <div className="space-y-6">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  // A server failure on the tasks query used to fall through to the "No Tasks
  // Yet" empty state — misleading. Show an honest error + retry instead (ux-01).
  if (tasksIsError) {
    return (
      <PageShell width="wide" title="My Tasks" subtitle="Complete these tasks to move forward with your loan application">
        <QueryErrorState
          error={tasksError}
          onRetry={() => refetchTasks()}
          title="We couldn't load your tasks"
          data-testid="tasks-error"
        />
      </PageShell>
    );
  }

  // Scope to the ACTIVE application — tasks from old/denied applications are
  // noise, not next steps (the "56 pending tasks" defect). EXPIRED tasks are
  // dead, not to-dos, so they don't count against progress either.
  const myTasks = (tasks || []).filter(
    (t) =>
      (!activeApplication || t.applicationId === activeApplication.id) &&
      t.status !== "EXPIRED",
  );
  // Buckets over the canonical vocabulary (the old lowercase groups matched
  // zero engine-written tasks, leaving every OPEN task invisible on this page).
  // A "rejected" verdict on a non-completed task outranks its lifecycle bucket.
  // The buckets come from the shared definition (lib/outstandingWork.ts), so
  // this page and the dashboard card can no longer disagree about whether the
  // borrower has anything to do.
  const rejectedTasks = myTasks.filter(isRejectedTask);
  const pendingTasks = myTasks.filter(isPendingTask);
  const submittedTasks = myTasks.filter(
    (t) => t.status === "IN_PROGRESS" && t.verificationStatus !== "rejected",
  );
  const completedTasks = myTasks.filter((t) => t.status === "COMPLETED");

  // Milestone grouping: document requests collapse into ONE checklist card
  // instead of a wall of near-identical task rows.
  const pendingDocTasks = pendingTasks.filter((t) => t.taskType === "document_request");
  const pendingOtherTasks = pendingTasks.filter((t) => t.taskType !== "document_request");

  // Fed to <TaskProgress>, which SNAPSHOTS the total on first render. Both
  // figures derive from `myTasks` — the one scoped list this page filters
  // everything else from — so no two counts on the screen can disagree
  // (DESIGN_SYSTEM §13, Agreement). The denominator must not move while the
  // borrower is looking at it: an LO assigning a task mid-session used to
  // drop the percentage, making their progress run backwards.
  const totalTasks = myTasks.length;
  const completedCount = completedTasks.length;
  const additionalActions = (actionItemsData?.items ?? []).filter(
    (item) => !myTasks.some((task) => task.id === item.id),
  );

  const openUploadDialog = (task: Task) => {
    setSelectedTask(task);
    setUploadDialogOpen(true);
  };

  return (
    <>
      <PageShell width="wide" title="My Tasks" subtitle="Complete these tasks to move forward with your loan application">
            {myTasks.length === 0 && additionalActions.length === 0 ? (
              // Scoped to what this page knows — the ACTIVE application's tasks,
              // never a global "you're all caught up" (DESIGN_SYSTEM §13).
              <EmptyState
                scope="tasks on this application"
                icon={CheckCircle2}
                description={
                  activeApplication
                    ? "Your loan officer will assign tasks as your application progresses — we'll tell you the moment one arrives."
                    : "Start a loan application to receive your first tasks."
                }
                action={
                  !activeApplication ? (
                    <Button asChild data-testid="button-start-application">
                      <Link href="/apply">Start Application</Link>
                    </Button>
                  ) : undefined
                }
                data-testid="tasks-empty"
              />
            ) : (
              <>
                <div className="mb-4 flex items-center justify-between gap-3" data-testid="tasks-open-action-count">
                  <h2 className="text-lg font-semibold">Your next steps</h2>
                  <Badge variant="secondary">{actionItemsData?.stats.total ?? pendingTasks.length} remaining</Badge>
                </div>
                {myTasks.length > 0 && (
                  <Card className="mb-8">
                    <CardContent className="p-6">
                      <TaskProgress
                        label="Tasks completed on this application"
                        completed={completedCount}
                        total={totalTasks}
                        data-testid="tasks-progress"
                      />
                    </CardContent>
                  </Card>
                )}

                {additionalActions.length > 0 && (
                  <div className="mb-8" data-testid="section-additional-actions">
                    <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
                      <CheckSquare className="h-5 w-5 text-muted-foreground" />
                      Other required steps ({additionalActions.length})
                    </h2>
                    <div className="space-y-3">
                      {additionalActions.map((item) => (
                        <Card key={item.id}>
                          <CardContent className="flex items-center justify-between gap-4 p-4">
                            <div>
                              <p className="font-medium">{item.title}</p>
                              {item.description && (
                                <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                              )}
                            </div>
                            <Button asChild size="sm" className="touch-target shrink-0">
                              <Link href={item.actionUrl} data-testid={`task-action-${item.id}`}>
                                {item.actionLabel}
                              </Link>
                            </Button>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}

                {rejectedTasks.length > 0 && (
                  <div className="mb-8">
                    <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold text-destructive">
                      <AlertCircle className="h-5 w-5" />
                      Needs Your Attention ({rejectedTasks.length})
                    </h2>
                    <div className="space-y-4">
                      {rejectedTasks.map((task) => (
                        <Card key={task.id} className="border-destructive">
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 flex-wrap mb-2">
                                  <h4 className="font-medium">{task.title}</h4>
                                  {getTaskStatusBadge(task)}
                                  {task.priority && getPriorityBadge(task.priority)}
                                </div>
                                {task.description && (
                                  <p className="text-sm text-muted-foreground mb-2">{task.description}</p>
                                )}
                                {/* Never tasks.verificationNotes here — staff
                                    review free text is embargoed from borrower
                                    payloads (borrowerTaskView); the staff→
                                    borrower channel is documentInstructions. */}
                                <p className="text-sm text-destructive bg-destructive/10 p-2 rounded">
                                  {task.documentInstructions || "We couldn't verify this document — please upload a new copy."}
                                </p>
                              </div>
                              <Button
                                size="sm" className="touch-target"
                                onClick={() => openUploadDialog(task)}
                                data-testid={`button-reupload-${task.id}`}
                              >
                                <Upload className="mr-2 h-4 w-4" />
                                Re-upload
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}

                {pendingDocTasks.length > 0 && (
                  <div className="mb-8">
                    <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
                      <FileText className="h-5 w-5 text-muted-foreground" />
                      Document Checklist ({pendingDocTasks.length})
                    </h2>
                    <Card data-testid="card-document-milestone">
                      <CardContent className="p-4 sm:p-5">
                        <p className="mb-4 text-sm text-muted-foreground">
                          One milestone, {pendingDocTasks.length} item{pendingDocTasks.length === 1 ? "" : "s"} —
                          upload what you have and each one checks itself off.
                        </p>
                        <div className="divide-y">
                          {pendingDocTasks.map((task) => (
                            <div
                              key={task.id}
                              className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                              data-testid={`checklist-item-${task.id}`}
                            >
                              <div className="flex min-w-0 items-center gap-3">
                                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                                  <FileText className="h-4 w-4 text-muted-foreground" />
                                </div>
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-medium">
                                    {getDocumentTaskLabel(task)}
                                    {task.documentYear && (
                                      <span className="text-muted-foreground"> · {task.documentYear}</span>
                                    )}
                                  </p>
                                  {task.documentInstructions && (
                                    <p className="truncate text-xs text-muted-foreground">
                                      {task.documentInstructions}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <Button
                                size="sm" className="touch-target"
                                variant="outline"
                                onClick={() => openUploadDialog(task)}
                                data-testid={`button-upload-${task.id}`}
                              >
                                <Upload className="mr-2 h-4 w-4" />
                                Upload
                              </Button>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                )}

                {pendingOtherTasks.length > 0 && (
                  <div className="mb-8">
                    <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
                      <Clock className="h-5 w-5 text-muted-foreground" />
                      To Do ({pendingOtherTasks.length})
                    </h2>
                    <div className="space-y-4">
                      {pendingOtherTasks.map((task) => (
                        <Card key={task.id} className="hover-elevate" data-testid={`card-task-${task.id}`}>
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 flex-wrap mb-2">
                                  <h4 className="font-medium">{task.title}</h4>
                                  {getTaskStatusBadge(task)}
                                  {task.priority && getPriorityBadge(task.priority)}
                                </div>
                                {task.description && (
                                  <p className="text-sm text-muted-foreground mb-2">{task.description}</p>
                                )}
                                {task.documentCategory && (
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <FileText className="h-4 w-4" />
                                    {getDocumentTaskLabel(task)}
                                    {task.documentYear && ` (${task.documentYear})`}
                                  </div>
                                )}
                                {task.dueDate && (
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                                    <Calendar className="h-4 w-4" />
                                    Due: {format(new Date(task.dueDate), "MMM d, yyyy")}
                                  </div>
                                )}
                                {task.documentInstructions && (
                                  <p className="text-xs text-muted-foreground mt-2 italic">
                                    {task.documentInstructions}
                                  </p>
                                )}
                              </div>
                              {task.taskType === "document_request" && (
                                <Button
                                  size="sm" className="touch-target"
                                  onClick={() => openUploadDialog(task)}
                                  data-testid={`button-upload-${task.id}`}
                                >
                                  <Upload className="mr-2 h-4 w-4" />
                                  Upload
                                </Button>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}

                {submittedTasks.length > 0 && (
                  <div className="mb-8">
                    <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
                      <File className="h-5 w-5 text-primary" />
                      Under Review ({submittedTasks.length})
                    </h2>
                    <div className="space-y-4">
                      {submittedTasks.map((task) => (
                        <Card key={task.id}>
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 flex-wrap mb-2">
                                  <h4 className="font-medium">{task.title}</h4>
                                  {getTaskStatusBadge(task)}
                                </div>
                                {task.documentCategory && (
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <FileText className="h-4 w-4" />
                                    {getDocumentTaskLabel(task)}
                                    {task.documentYear && ` (${task.documentYear})`}
                                  </div>
                                )}
                              </div>
                              <div className="text-sm text-muted-foreground">
                                Awaiting review
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}

                {completedTasks.length > 0 && (
                  <div>
                    <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
                      <CheckCircle2 className="h-5 w-5 text-status-success" />
                      Completed ({completedTasks.length})
                    </h2>
                    <div className="space-y-4">
                      {completedTasks.map((task) => (
                        <Card key={task.id} className="opacity-75">
                          <CardContent className="p-4">
                            <div className="flex items-center gap-4">
                              <CheckCircle2 className="h-5 w-5 text-status-success flex-shrink-0" />
                              <div className="flex-1">
                                <h4 className="font-medium">{task.title}</h4>
                                {task.documentCategory && (
                                  <p className="text-sm text-muted-foreground">
                                    {getDocumentTaskLabel(task)}
                                  </p>
                                )}
                              </div>
                              {getTaskStatusBadge(task)}
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
      </PageShell>

      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
            <DialogDescription>
              {selectedTask?.title}
              {selectedTask?.documentCategory && (
                <span className="block mt-1">
                  Required: {getDocumentTaskLabel(selectedTask)}
                  {selectedTask.documentYear && ` for ${selectedTask.documentYear}`}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {selectedTask?.documentInstructions && (
              <div className="rounded-lg bg-muted p-3 text-sm">
                <strong>Instructions:</strong> {selectedTask.documentInstructions}
              </div>
            )}
            <div>
              <Label htmlFor="file">Select File</Label>
              <Input
                id="file"
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                className="mt-2"
                data-testid="input-file-upload"
              />
              {selectedFile && (
                <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
                  <File className="h-4 w-4" />
                  {selectedFile.name}
                  <Button
                    variant="ghost"
                    size="icon" aria-label="Close"
                    className="h-6 w-6"
                    onClick={() => setSelectedFile(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleFileUpload}
              disabled={!selectedFile || isUploading}
              data-testid="button-confirm-upload"
            >
              {isUploading ? "Uploading..." : "Upload Document"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
