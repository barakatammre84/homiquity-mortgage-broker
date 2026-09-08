import { useQuery } from "@tanstack/react-query";
import { taskEngineKeys } from "@/lib/queryClient";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, Clock, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { AllCaughtUpArt } from "@/components/illustrations";
import { selectOutstanding } from "@/lib/outstandingWork";

interface BorrowerTask {
  id: string;
  applicationId: string;
  title: string;
  description?: string;
  taskType: string;
  taskTypeCode?: string;
  ownerRole?: string;
  slaClass?: string;
  status: string;
  /**
   * "rejected" means a verification came back and the borrower must redo
   * something. It rides the borrower whitelist (shared/borrowerTaskView.ts)
   * and is part of what makes a task outstanding — see outstandingWork.ts.
   */
  verificationStatus?: string | null;
  createdAt?: string;
  slaStatus: "green" | "amber" | "red";
  timeRemaining: number | null;
  percentageElapsed: number | null;
  /** Staff transparency rows only — the mapping's borrower-facing line. */
  borrowerDisplayText?: string;
}

const FRIENDLY_TASK_NAMES: Record<string, string> = {
  DOC_PAYSTUB_REQUEST: "Upload April Pay Stub",
  DOC_BANK_STATEMENT_REQUEST: "Upload Bank Statements",
  DOC_TAX_RETURN_REQUEST: "Upload Tax Returns",
  DOC_PURCHASE_CONTRACT: "Upload Purchase Contract",
  DOC_GIFT_LETTER: "Upload Gift Letter",
  DOC_W2_REQUEST: "Upload W-2 Forms",
  INTAKE_CONSENT_CREDIT: "Authorize Credit Check",
  INTAKE_INITIAL_DISCLOSURES: "Review Loan Disclosures",
  CRD_CREDIT_PULL: "Authorize Credit Check",
  CRD_INQUIRY_LOE: "Explain Credit Inquiries",
  INC_EMP_GAP: "Verify Employment History",
  AST_LARGE_DEPOSIT: "Explain Large Deposit",
  CMP_ADVERSE_ACTION: "Review Important Notice",
};

function formatDueDate(minutes: number | null): string {
  if (minutes === null) return "";
  if (minutes <= 0) return "Due today";
  
  if (minutes < 60) return "Due in 1 hour";
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    return `Due in ${hours} hour${hours > 1 ? "s" : ""}`;
  }
  const days = Math.floor(minutes / 1440);
  return `Due in ${days} day${days > 1 ? "s" : ""}`;
}

interface BorrowerRequestsProps {
  applicationId?: string;
  "data-testid"?: string;
  /** Return null when there are no pending tasks (default false → show the
   *  "all caught up" state, so a dashboard grid cell never renders blank). */
  hideWhenEmpty?: boolean;
}

export function BorrowerRequests({ applicationId, "data-testid": testId, hideWhenEmpty = false }: BorrowerRequestsProps) {
  const { data: tasks, isLoading } = useQuery<BorrowerTask[]>({
    queryKey: taskEngineKeys.borrowerTasks(applicationId),
    enabled: !!applicationId,
  });

  // One definition of outstanding, shared with /tasks (outstandingWork.ts).
  // This used to select `status === "OPEN"` alone, so a BLOCKED task — and,
  // worse, a task whose document came back REJECTED — was invisible here while
  // /tasks listed it under "Needs Your Attention". The borrower was told
  // "You're all caught up" at the exact moment something was wrong.
  const pendingTasks = selectOutstanding(tasks);
  // Visible staff tasks (task type flagged visibleToBorrower — the server's
  // borrowerTaskView already reduced them to their borrowerDisplayText).
  // Shown read-only for transparency; never an action affordance.
  const inProgressTasks =
    tasks?.filter(
      t =>
        t.ownerRole &&
        t.ownerRole !== "BORROWER" &&
        (t.status === "OPEN" || t.status === "IN_PROGRESS"),
    ) || [];
  // Several internal tasks can intentionally share the same borrower-facing
  // status line (for example, one review task per document). Repeating that
  // sentence dozens of times makes the dashboard look broken and adds no new
  // borrower information, so this surface shows each distinct update once.
  const distinctInProgressTasks = Array.from(
    new Map(
      inProgressTasks.map((task) => [task.borrowerDisplayText || task.title, task] as const),
    ).values(),
  );
  const visibleInProgressTasks = distinctInProgressTasks.slice(0, 3);

  if (isLoading) {
    return (
      <Card className="shadow-card" data-testid={testId || "card-what-we-need"}>
        <CardContent className="p-6">
          <div className="flex items-center justify-center h-16">
            <div className="animate-pulse text-muted-foreground">Loading…</div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (pendingTasks.length === 0 && inProgressTasks.length === 0) {
    if (hideWhenEmpty) return null;
    // A blank grid cell reads as broken, so an empty state still renders — but
    // it may only speak for what this card knows: the tasks on THIS loan.
    // "You're all caught up" was an unqualified, account-wide claim made by a
    // component scoped to one application (DESIGN_SYSTEM §13).
    return (
      <Card className="shadow-card" data-testid={testId || "card-what-we-need"}>
        <CardContent className="flex flex-col items-center px-6 py-8 text-center">
          <AllCaughtUpArt className="mb-3 h-20 w-20" />
          <p className="font-medium text-foreground" data-testid="text-tasks-caught-up">
            Nothing to do on this loan
          </p>
          <p className="mt-1 max-w-xs text-sm text-muted-foreground">
            We'll let you know the moment something comes up.
          </p>
        </CardContent>
      </Card>
    );
  }

  const displayTasks = pendingTasks.slice(0, 3);

  return (
    <Card className="shadow-card" data-testid={testId || "card-what-we-need"}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Tasks</p>
              <Badge variant="secondary" className="text-xs">{pendingTasks.length}</Badge>
            </div>
            <div className="mt-1 h-0.5 w-8 rounded-full bg-primary/60" />
          </div>
          <Button asChild variant="outline" size="sm" className="touch-target" data-testid="button-complete-items">
            <Link href="/tasks">
              Complete items
              <ArrowRight className="ml-1 h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-1 space-y-3">
        {displayTasks.map((task) => {
          const friendlyName = FRIENDLY_TASK_NAMES[task.taskTypeCode || ""] || task.title;
          const dueText = formatDueDate(task.timeRemaining);
          const isUrgent = task.slaStatus === "red" || task.slaStatus === "amber";
          
          return (
            <div 
              key={task.id}
              className="flex flex-col items-stretch gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              data-testid={`row-request-${task.id}`}
            >
              <div className="flex items-center gap-3 min-w-0 flex-wrap">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 ${
                  isUrgent ? "border-border text-warning-subtle-foreground" : "border-primary/50 text-primary"
                }`}>
                  {isUrgent ? (
                    <Clock className="h-4 w-4 text-warning-subtle-foreground" />
                  ) : (
                    <Upload className="h-4 w-4 text-primary" />
                  )}
                </div>
                <div className="min-w-0">
                  {/* Wraps on a phone (the row stacks, so the title owns the line);
                      keeps truncating from sm: up, where the CTA sits beside it. A
                      truncated request title tells the borrower nothing. */}
                  <p className="text-sm font-medium sm:truncate" data-testid={`text-request-title-${task.id}`}>
                    {friendlyName}
                  </p>
                  {dueText && (
                    <p className={`text-xs ${
                      isUrgent ? "text-warning-subtle-foreground" : "text-muted-foreground"
                    }`} data-testid={`text-request-due-${task.id}`}>
                      {dueText}
                    </p>
                  )}
                </div>
              </div>
              <Button asChild size="sm" variant="outline" className="touch-target w-full shrink-0 sm:w-auto" data-testid={`button-upload-${task.id}`}>
                <Link href="/documents">
                  Upload
                  <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Link>
              </Button>
            </div>
          );
        })}
        
        {pendingTasks.length > 3 && (
          <Button asChild variant="ghost" size="sm" className="touch-target w-full text-muted-foreground" data-testid="button-view-all-requests">
            <Link href="/documents">
              View all {pendingTasks.length} requests
              <ArrowRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        )}

        {pendingTasks.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-nothing-needed">
            Nothing needed from you right now.
          </p>
        )}

        {inProgressTasks.length > 0 && (
          <div className="pt-1" data-testid="section-in-progress">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              In progress on our side
            </p>
            <div className="space-y-2">
              {visibleInProgressTasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-center gap-3 rounded-md bg-muted/30 px-3 py-2"
                  data-testid={`row-transparency-${task.id}`}
                >
                  <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {task.borrowerDisplayText || task.title}
                  </p>
                </div>
              ))}
              {distinctInProgressTasks.length > visibleInProgressTasks.length && (
                <p className="px-3 text-xs text-muted-foreground" data-testid="text-in-progress-overflow">
                  {distinctInProgressTasks.length - visibleInProgressTasks.length} more updates are in progress.
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default BorrowerRequests;
