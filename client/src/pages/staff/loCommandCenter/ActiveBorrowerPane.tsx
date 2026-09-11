import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertCircle, ArrowLeft, BriefcaseBusiness, ClipboardList, ExternalLink, FileText, MessageSquare, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { getLoanAppStatusMeta } from "@shared/loanApplicationStatus";
import { formatCurrency, formatDate } from "@/lib/formatters";
import { DocRequestDraftDialog } from "./DocRequestDraftDialog";
import { SIGNAL_META, prettyPathId, type CockpitData, type PipelineSummary, type StaffSignal } from "./types";

// -----------------------------------------------------------------------------
// Center pane — active borrower
// -----------------------------------------------------------------------------
export function loanOfficerNextAction(data: CockpitData): string {
  const submitted = data.conditions.items.filter((condition) => condition.status === "submitted").length;
  if (data.messages.unreadFromBorrower > 0) {
    return `Reply to ${data.messages.unreadFromBorrower} unread borrower message${data.messages.unreadFromBorrower === 1 ? "" : "s"}.`;
  }
  if (submitted > 0) {
    return `Review ${submitted} submitted condition${submitted === 1 ? "" : "s"}.`;
  }
  if (!data.income) {
    return "Complete the income review before discussing qualification or lender fit.";
  }
  if (data.conditions.open > 0) {
    return `Send a focused request for the ${data.conditions.open} open item${data.conditions.open === 1 ? "" : "s"}.`;
  }
  if (data.documents.uploadedCount > data.documents.verifiedCount) {
    const awaiting = data.documents.uploadedCount - data.documents.verifiedCount;
    return `Review ${awaiting} uploaded document${awaiting === 1 ? "" : "s"}.`;
  }
  return "Confirm submission readiness and resolve any remaining validation findings.";
}

export function ActiveBorrowerPane({
  applicationId,
  file,
  signals = [],
  onBack,
}: {
  applicationId: string;
  file?: PipelineSummary;
  signals?: StaffSignal[];
  onBack: () => void;
}) {
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
  const reportedIncome = data.reportedIncome;
  const statusMeta = getLoanAppStatusMeta(app.status);
  const financialsVerified = app.currentDecisionGrade;
  const isPreliminaryReview = app.status === "pre_approved" && !financialsVerified;
  const topSignal = signals[0];
  const nextAction = loanOfficerNextAction(data);

  return (
    <div className="space-y-4 p-4 md:p-6" data-testid="cockpit-active-borrower">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
        <div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0">
          <Button asChild variant="outline" size="sm" className="touch-target" data-testid="cockpit-open-full-file">
            <Link href={`/borrower-file/${app.id}`}>
              <ExternalLink className="mr-1 h-4 w-4" aria-hidden="true" />
              Full file
            </Link>
          </Button>
        </div>
      </div>

      <section
        className="overflow-hidden rounded-lg border border-primary/25 bg-primary/5"
        aria-labelledby="file-plan-heading"
        data-testid="cockpit-file-plan"
      >
        <div className="grid gap-4 p-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <p id="file-plan-heading" className="text-xs font-semibold text-primary">
              Next loan-officer action
            </p>
            <p className="mt-1 font-semibold" data-testid="cockpit-next-action">{nextAction}</p>
            <div className="mt-3" data-testid="cockpit-next-action-control">
              {messages.unreadFromBorrower > 0 ? (
                <Button asChild size="sm" className="touch-target">
                  <Link href={`/messages/${app.borrowerUserId}`}>Reply to borrower</Link>
                </Button>
              ) : conditions.items.some((condition) => condition.status === "submitted") ? (
                <Button asChild size="sm" className="touch-target">
                  <Link href={`/borrower-file/${app.id}?tab=conditions`}>Review submitted items</Link>
                </Button>
              ) : !income ? (
                <Button asChild size="sm" className="touch-target">
                  <Link href={`/borrower-file/${app.id}?tab=financial-review`}>Open income review</Link>
                </Button>
              ) : conditions.open > 0 ? (
                <DocRequestDraftDialog applicationId={app.id} />
              ) : documents.uploadedCount > documents.verifiedCount ? (
                <Button asChild size="sm" className="touch-target">
                  <Link href={`/borrower-file/${app.id}?tab=file-review`}>Review documents</Link>
                </Button>
              ) : (
                <Button asChild size="sm" variant="outline" className="touch-target">
                  <Link href={`/borrower-file/${app.id}`}>Confirm file readiness</Link>
                </Button>
              )}
            </div>
            {topSignal ? (
              <div className="mt-3 border-t border-primary/15 pt-3" data-testid="cockpit-top-signal">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={SIGNAL_META[topSignal.priority].badge}>
                    {SIGNAL_META[topSignal.priority].label}
                  </Badge>
                  <span className="text-sm font-medium capitalize">{topSignal.title}</span>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{topSignal.detail}</p>
              </div>
            ) : file?.fileHealth.reasons.length ? (
              <p className="mt-2 text-sm text-muted-foreground">{file.fileHealth.reasons.join(" · ")}</p>
            ) : null}
          </div>
          <dl className="grid grid-cols-2 gap-3 border-t border-primary/15 pt-3 text-sm sm:grid-cols-1 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
            <div>
              <dt className="text-xs text-muted-foreground">Income status</dt>
              <dd className="mt-0.5 font-medium">{financialsVerified ? "Verified" : income ? "Self-reported" : "Not calculated"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Evidence status</dt>
              <dd className="mt-0.5 font-medium">
                {documents.verifiedCount}/{documents.uploadedCount} verified · {conditions.open} open
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* Reported income story — the intake facts the calculation below must
          eventually reconcile, shown separately from qualifying income. */}
      <Card data-testid="cockpit-reported-income">
        <CardContent className="p-4">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
            <BriefcaseBusiness className="h-4 w-4 text-primary" aria-hidden="true" />
            Reported income story
          </h3>
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-muted-foreground">Household total</span>
              <span className="font-semibold tabular-nums">
                {reportedIncome.householdAnnualTotal == null
                  ? "Not provided"
                  : `${formatCurrency(reportedIncome.householdAnnualTotal)}/yr`}
                <Badge variant="outline" className="ml-2">Self-reported</Badge>
              </span>
            </div>
            {reportedIncome.unitemizedAnnualAmount !== null && reportedIncome.unitemizedAnnualAmount > 0 && (
              <div className="flex items-center justify-between gap-2">
                <span className="capitalize text-muted-foreground">
                  {reportedIncome.employmentType?.replace(/_/g, " ") || "Main source"} / household income not itemized
                </span>
                <span className="tabular-nums">{formatCurrency(reportedIncome.unitemizedAnnualAmount)}/yr</span>
              </div>
            )}
            {reportedIncome.sources.map((source, index) => (
              <div key={`${source.type}-${source.name ?? index}`} className="flex items-start justify-between gap-3">
                <span className="min-w-0 text-muted-foreground">
                  <span className="capitalize">{source.type === "self_employed" ? "Business / 1099" : source.type.replace(/_/g, " ")}</span>
                  {source.name ? ` · ${source.name}` : ""}
                  {source.rentalPropertyCount > 0 ? ` · ${source.rentalPropertyCount} properties` : ""}
                  {source.yearsInRole ? ` · ${source.yearsInRole} years` : ""}
                  {source.ownershipPercent ? ` · ${source.ownershipPercent}% ownership` : ""}
                </span>
                <span className="shrink-0 tabular-nums">
                  {source.annualAmount == null ? "Not itemized" : `${formatCurrency(source.annualAmount)}/yr`}
                </span>
              </div>
            ))}
            {reportedIncome.breakdownExceedsHouseholdTotal && (
              <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                The itemized source amounts exceed the reported household total. Resolve this conflict before relying on the file.
              </p>
            )}
            {reportedIncome.rental && (
              <div className="rounded-md bg-muted/50 p-2 text-xs leading-relaxed" data-testid="cockpit-reported-rental">
                <span className="font-medium">Rental screen:</span>{" "}
                {formatCurrency(reportedIncome.rental.grossMonthlyRent)}/mo gross × 75% ={" "}
                {formatCurrency(reportedIncome.rental.planningMonthlyRent)}/mo, less{" "}
                {formatCurrency(reportedIncome.rental.monthlyPropertyPayments)}/mo reported property payments ={" "}
                {reportedIncome.rental.preliminaryMonthlyOffset >= 0 ? "+" : "−"}
                {formatCurrency(Math.abs(reportedIncome.rental.preliminaryMonthlyOffset))}/mo preliminary offset.
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Intake amounts only. Use reviewed wage records, tax returns, P&amp;L, leases or Schedule E, and liabilities for the qualifying calculation.
            </p>
          </div>
        </CardContent>
      </Card>

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
                  {income.incomeBasis === "urla_line_items" ? "URLA line items" : "household-total fallback"}
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
                        {income.incomeBasis === "application_summary" && p.pathId === "agency_wage"
                          ? "Household Total Fallback"
                          : prettyPathId(p.pathId)}
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
                  {income.incomeBasis === "application_summary"
                    ? "This preliminary fallback uses the reported household total because reviewed wage and business line items are not available yet. It does not establish W-2 or qualifying income."
                    : "Preliminary calculation only. Verify income, assets, credit, and property evidence before using it for qualification or a lender package."}
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
