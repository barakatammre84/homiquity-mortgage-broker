import { useEffect } from "react";
import { Link } from "wouter";
import { ArrowRight, CheckCircle2, ListChecks } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBorrowerActionItems } from "@/hooks/useBorrowerActionItems";

// The post-submit page's first job is telling the borrower what to do next.
// This renders the server-computed action items (tasks + unsigned consents +
// outstanding conditions from GET /api/applications/:id/action-items — an
// endpoint that previously had zero client callers) as the page's lead
// section. The server owns the list and its priorities; this renders.

const MAX_VISIBLE_ITEMS = 5;

function priorityDotClass(priority: string): string {
  if (priority === "urgent") return "bg-destructive";
  if (priority === "high") return "bg-warning";
  return "bg-muted-foreground/40";
}

export interface ActionItemsSectionProps {
  applicationId: string;
  /** True while the intake decision/scenarios are still being computed —
   * tasks are generated in the same pass, so refetch once it settles. */
  stillAnalyzing: boolean;
}

export function ActionItemsSection({ applicationId, stillAnalyzing }: ActionItemsSectionProps) {
  const { data, isLoading, refetch } = useBorrowerActionItems(applicationId);

  useEffect(() => {
    if (!stillAnalyzing) {
      refetch();
    }
  }, [stillAnalyzing, refetch]);

  useEffect(() => {
    if (!stillAnalyzing) return;
    const timer = window.setInterval(() => void refetch(), 5000);
    return () => window.clearInterval(timer);
  }, [stillAnalyzing, refetch]);

  if (isLoading) {
    return (
      <Card className="mb-8 p-6" data-testid="section-action-items">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="mt-4 h-12 w-full" />
        <Skeleton className="mt-2 h-12 w-full" />
      </Card>
    );
  }

  const items = data?.items ?? [];
  const visible = items.slice(0, MAX_VISIBLE_ITEMS);
  const overflow = items.length - visible.length;

  return (
    <Card className="mb-8 p-6" data-testid="section-action-items">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-primary/10 p-1.5">
            <ListChecks className="h-4 w-4 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">What to do next</h2>
          {items.length > 0 && (
            <Badge variant="secondary" data-testid="text-action-items-count">
              {items.length}
            </Badge>
          )}
        </div>
        <Button asChild variant="ghost" size="sm" className="touch-target" data-testid="button-action-items-dashboard">
          <Link href="/dashboard">
            Go to Dashboard
            <ArrowRight className="ml-1.5 h-4 w-4" />
          </Link>
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="mt-4 flex items-start gap-3" data-testid="text-action-items-empty">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success-subtle-foreground" />
          <p className="text-sm text-muted-foreground">
            {stillAnalyzing
              ? "We're putting together your personalized document list — it will appear here in a moment."
              : "Nothing needed from you right now. Your loan team will message you if anything comes up."}
          </p>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            Completing these moves your application forward — documents are what turn your estimates
            into verified terms.
          </p>
          <ul className="mt-4 divide-y">
            {visible.map((item, index) => (
              <li
                key={item.id}
                className="flex items-center gap-3 py-3"
                data-testid={`action-item-${item.id}`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${priorityDotClass(item.priority)}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  {item.description && (
                    <p className="truncate text-xs text-muted-foreground">{item.description}</p>
                  )}
                </div>
                <Button asChild
                    size="sm" className="touch-target"
                    variant={index === 0 ? "default" : "outline"}
                    data-testid={`button-action-item-${item.id}`}
                  >
                  <Link href={item.actionUrl}>
                    {item.actionLabel}
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
          {overflow > 0 && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="text-action-items-overflow">
              +{overflow} more on your{" "}
              <Link href="/dashboard" className="text-primary hover:underline">
                dashboard
              </Link>
              .
            </p>
          )}
        </>
      )}
    </Card>
  );
}
