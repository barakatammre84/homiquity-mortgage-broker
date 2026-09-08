import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertCircle, ArrowLeft, ClipboardList, ExternalLink, FileText, MessageSquare, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getLoanAppStatusMeta } from "@shared/loanApplicationStatus";
import { formatCurrency, formatDate } from "@/lib/formatters";
import { isDecisionGrade } from "@shared/dataProvenance";
import { DocRequestDraftDialog } from "./DocRequestDraftDialog";
import { prettyPathId, type CockpitData } from "./types";

// -----------------------------------------------------------------------------
// Center pane — active borrower
// -----------------------------------------------------------------------------
export function ActiveBorrowerPane({ applicationId, onBack }: { applicationId: string; onBack: () => void }) {
  const { data, isLoading, isError } = useQuery<CockpitData>({
    queryKey: ["/api/staff/applications", applicationId, "cockpit"],
  });

  if (isLoading) {
    return (
      <div className="space-y-4 p-4" data-testid="cockpit-loading">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="text-center">
          <AlertCircle className="mx-auto mb-3 h-10 w-10 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium">Couldn't load this file</p>
          <p className="mt-1 text-sm text-muted-foreground">You may not have access, or it's no longer active.</p>
        </div>
      </div>
    );
  }

  const { application: app, income, conditions, documents, messages } = data;
  const statusMeta = getLoanAppStatusMeta(app.status);
  const financialsVerified = isDecisionGrade(app.financialDataProvenance as Parameters<typeof isDecisionGrade>[0]);
  const isPreliminaryReview = app.status === "pre_approved" && !financialsVerified;

  return (
    <div className="space-y-4 p-4 md:p-6" data-testid="cockpit-active-borrower">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="touch-target lg:hidden"
              onClick={onBack}
              aria-label="Back to pipeline"
              data-testid="cockpit-back"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <h2 className="truncate text-xl font-bold" data-testid="cockpit-borrower-name">
              {app.borrowerName}
            </h2>
            {app.isVeteran && <Badge variant="info">Veteran</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <Badge variant={isPreliminaryReview ? "info" : statusMeta.badgeVariant}>
              {isPreliminaryReview ? "Initial review" : statusMeta.label}
            </Badge>
            {app.loanPurpose && <span className="capitalize">{app.loanPurpose.replace(/_/g, " ")}</span>}
            {app.purchasePrice && <span>{formatCurrency(app.purchasePrice)}</span>}
            {app.propertyState && <span>{app.propertyState}</span>}
            {app.closingDate && <span>Close {formatDate(app.closingDate)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <DocRequestDraftDialog applicationId={app.id} />
          <Button asChild variant="outline" size="sm" className="touch-target" data-testid="cockpit-open-full-file">
            <Link href={`/borrower-file/${app.id}`}>
              <ExternalLink className="mr-1 h-4 w-4" aria-hidden="true" />
              Full file
            </Link>
          </Button>
        </div>
      </div>

      {/* Income */}
      <Card data-testid="cockpit-income">
        <CardContent className="p-4">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <TrendingUp className="h-4 w-4 text-primary" aria-hidden="true" />
            {financialsVerified ? "Qualifying income" : "Income calculation"}
          </h3>
          {income ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-2xl font-semibold tabular-nums">
                  {formatCurrency(income.primaryMonthlyQualifyingIncome)}/mo
                </span>
                <span className="text-xs text-muted-foreground">
                  {income.incomeBasis === "urla_line_items" ? "URLA line items" : "application summary"}
                  {!financialsVerified && " · self-reported"}
                </span>
                {income.requiresManualReview && <Badge variant="warning">Manual review</Badge>}
              </div>
              {/* Each row is what the path CONTRIBUTED to the figure above, so
                  the list reconciles to it. A rental portfolio's losses sit on
                  the obligation side and are labelled as such rather than
                  netted into an income number that then fails to add up. */}
              <ul className="space-y-1 text-sm">
                {income.paths
                  .filter((p) => p.status === "applicable")
                  .map((p) => (
                    <li key={p.pathId} className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">
                        {prettyPathId(p.pathId)}
                        {p.role === "alternative" && <span className="ml-1 text-xs">(alt)</span>}
                        {p.kind === "dti_income" && (p.appliedMonthlyObligation ?? 0) > 0 && (
                          <span className="ml-1 text-xs">
                            (+{formatCurrency(p.appliedMonthlyObligation ?? 0)}/mo to debts)
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums">
                        {p.kind === "coverage_ratio"
                          ? p.coverageRatio != null
                            ? `DSCR ${p.coverageRatio.toFixed(2)}`
                            : "—"
                          : formatCurrency(
                              p.appliedMonthlyIncome ?? p.monthlyQualifyingIncome ?? 0,
                            ) + "/mo"}
                      </span>
                    </li>
                  ))}
              </ul>
              {!financialsVerified && (
                <p className="rounded-md bg-warning-subtle p-2 text-xs text-warning-subtle-foreground" data-testid="cockpit-income-unverified">
                  Preliminary calculation only. Verify income, assets, credit, and property evidence before using it for qualification or a lender package.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No income evaluation yet. Run the instant decision (or update income) to populate qualifying paths.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Conditions */}
        <Card data-testid="cockpit-conditions">
          <CardContent className="p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <ClipboardList className="h-4 w-4 text-primary" aria-hidden="true" />
              Open conditions ({conditions.open}/{conditions.total})
            </h3>
            {conditions.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open conditions.</p>
            ) : (
              <ul className="space-y-1.5">
                {conditions.items.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-sm" data-testid={`condition-${c.id}`}>
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate">{c.title}</span>
                      {c.status === "submitted" && <Badge variant="info" className="mt-0.5">Ready for review</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Documents */}
        <Card data-testid="cockpit-documents">
          <CardContent className="p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <FileText className="h-4 w-4 text-primary" aria-hidden="true" />
              Documents ({documents.verifiedCount}/{documents.uploadedCount} verified)
            </h3>
            {documents.byType.length === 0 ? (
              <p className="text-sm text-muted-foreground">No documents uploaded yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {documents.byType.slice(0, 6).map((d) => (
                  <li key={d.type} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate capitalize text-muted-foreground">{d.type.replace(/_/g, " ")}</span>
                    <Badge
                      variant={d.status === "verified" ? "success" : d.status === "rejected" ? "destructive" : "secondary"}
                    >
                      {d.status}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Messages */}
      <Card data-testid="cockpit-messages">
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <MessageSquare className="h-4 w-4 text-primary" aria-hidden="true" />
              Recent messages
              {messages.unreadFromBorrower > 0 && (
                <Badge variant="destructive">{messages.unreadFromBorrower} unread</Badge>
              )}
            </h3>
            <Button asChild variant="ghost" size="sm" className="touch-target" data-testid="cockpit-open-messages">
              <Link href="/messages">Open thread</Link>
            </Button>
          </div>
          {messages.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages with this borrower yet.</p>
          ) : (
            <ul className="space-y-2">
              {messages.recent.map((m) => (
                <li key={m.id} className="text-sm">
                  <span className={`font-medium ${m.fromBorrower ? "text-foreground" : "text-muted-foreground"}`}>
                    {m.fromBorrower ? app.borrowerName.split(" ")[0] : "You"}:
                  </span>{" "}
                  <span className="text-muted-foreground">{m.snippet}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
