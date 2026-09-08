import { useQuery } from "@tanstack/react-query";
import { dashboardKeys } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PageShell } from "@/components/PageShell";
import { QueryBoundary } from "@/components/ui/query-boundary";
import { useAuth } from "@/hooks/useAuth";
import { formatCurrency } from "@/lib/formatters";
import type { LoanApplication } from "@shared/schema";
import type { BorrowerGraphData } from "@/pages/borrower/borrowerDashboard/model";
import { useActiveApplication } from "@/hooks/useActiveApplication";
import { DATA_PROVENANCE } from "@shared/dataProvenance";
import { EmptyState } from "@/components/patterns/EmptyState";
import { ProvenanceBadge } from "@/components/patterns/ProvenanceBadge";
import { SummarySection } from "@/components/patterns/SummarySection";
import { DualUnitTable } from "@/components/patterns/DualUnitTable";
import {
  Home,
  ChevronRight,
  MessageCircle,
  User,
  PiggyBank,
  Briefcase,
  MapPin,
  UserPlus,
} from "lucide-react";

interface DashboardData {
  applications: LoanApplication[];
}

// The borrower's "what you told us" summary, on the pattern components
// (knowledge-base/handbook/design/DESIGN_SYSTEM.md §13): the financial section is a SummarySection with
// its required source + why-we-ask; income and debts render dual-unit (annual
// AND monthly, monthly derived); the previous hand-rolled "Initial"/"Soft
// check" chips became the shared ProvenanceBadge vocabulary; and the
// client-computed loan amount now declares itself Calculated instead of
// rendering unlabeled.

export default function ApplicationSummary() {
  const { user, isLoading: authLoading } = useAuth();

  // A disabled query (while auth resolves) reports `isPending`, so QueryBoundary
  // covers the auth-loading, fetching, error, and empty branches in one place.
  const query = useQuery<DashboardData>({
    queryKey: dashboardKeys.root(),
    enabled: !authLoading,
  });

  const graphQuery = useQuery<BorrowerGraphData>({
    queryKey: ["/api/borrower-graph"],
    enabled: !authLoading,
    staleTime: 60_000,
  });

  // Resolved here rather than inside the QueryBoundary render-prop below: that
  // callback is not a component, so it cannot call hooks.
  const { activeApplication } = useActiveApplication(query.data?.applications ?? []);

  const applicantName = user?.firstName && user?.lastName
    ? `${user.firstName} ${user.lastName}`
    : user?.email?.split("@")[0] || "Applicant";

  const loadingSkeleton = (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-24" />
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
    </div>
  );

  return (
    <PageShell
      width="narrow"
      title="Application summary"
      subtitle="See your application details here"
      titleTestId="text-page-title"
      contentClassName="space-y-6"
    >
        <QueryBoundary query={query} loading={loadingSkeleton} data-testid="application-summary">
          {() => {
            if (!activeApplication) {
              return (
                <EmptyState
                  scope="active application"
                  icon={Home}
                  description="Start your pre-approval to see your application summary."
                  action={
                    <Button className="gap-2" data-testid="button-start-application">
                      Start Pre-Approval
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  }
                />
              );
            }

            const annualIncome = graphQuery.data?.bestAnnualIncome ?? (
              activeApplication.annualIncome ? parseFloat(activeApplication.annualIncome) : null
            );
            const monthlyDebts = activeApplication.monthlyDebts
              ? parseFloat(activeApplication.monthlyDebts)
              : null;
            const loanAmount =
              parseFloat(activeApplication.purchasePrice || "0") -
              parseFloat(activeApplication.downPayment || "0");
            const propertyLocation =
              activeApplication.propertyCity && activeApplication.propertyState
                ? `${activeApplication.propertyCity}, ${activeApplication.propertyState}`
                : activeApplication.propertyState || "Not specified";
            const verificationExamples = activeApplication.employmentType === "self_employed"
              ? "tax returns, profit-and-loss statements, and business bank statements"
              : activeApplication.employmentType === "retired"
                ? "benefit letters, retirement statements, and bank statements"
                : "pay stubs, W-2s, and bank statements";

            return (
              <>
            <p className="text-sm text-muted-foreground">
              This is what you told us about your finances and property on your application — we're here to help if you need to make any changes.
            </p>

            <Card className="bg-muted/30">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-start gap-3 flex-wrap">
                    <MessageCircle className="h-5 w-5 text-primary mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium text-sm">Questions about your application?</p>
                      <p className="text-sm text-muted-foreground">
                        We're happy to help guide you through it or make edits to financial info.
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" className="touch-target shrink-0" data-testid="button-contact">
                    Contact info
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider flex-wrap">
                <User className="h-3.5 w-3.5" />
                Applicant
              </div>
              <p className="text-base font-medium" data-testid="text-applicant-name">
                {applicantName}
              </p>
            </div>

            <SummarySection
              title="Financial information"
              source={{ provenance: DATA_PROVENANCE.SELF_REPORTED }}
              whyWeAsk={`These figures set your buying power and your debt-to-income ratio — how much of what you earn already goes to debts. Next we verify them with ${verificationExamples}.`}
              data-testid="summary-financial"
            >
              <DualUnitTable
                caption="Income and debts — yearly and monthly, the two ways your loan team reads them"
                groups={[
                  {
                    label: "Income",
                    rows: [
                      {
                        label: "Annual income (before taxes)",
                        annual: annualIncome,
                        testId: "text-income",
                      },
                    ],
                  },
                  {
                    label: "Debts",
                    note: "From your soft credit check — the kind that never affects your credit score.",
                    rows: [
                      {
                        label: "Monthly debts",
                        annual: monthlyDebts === null ? null : monthlyDebts * 12,
                        testId: "text-debts",
                      },
                    ],
                  },
                ]}
              />

              <div className="mt-4 flex items-center justify-between gap-4 flex-wrap border-t border-border pt-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 shrink-0">
                    <PiggyBank className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Assets for your down payment</p>
                    <p className="font-semibold" data-testid="text-assets">
                      {formatCurrency(activeApplication.downPayment || "0")}
                    </p>
                  </div>
                </div>
              </div>
            </SummarySection>

            <div className="border-t pt-6">
              <div className="flex items-center gap-2 text-xs text-muted-foreground uppercase tracking-wider mb-4 flex-wrap">
                Loan summary
              </div>

              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted shrink-0">
                      <UserPlus className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Real estate agent</p>
                      <p className="font-medium text-muted-foreground" data-testid="text-agent">
                        Not added
                      </p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="touch-target text-primary shrink-0" data-testid="button-add-agent">
                    Add
                  </Button>
                </div>

                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 shrink-0">
                      <Briefcase className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">Loan</p>
                      <p className="font-semibold" data-testid="text-loan-amount">
                        {formatCurrency(loanAmount.toString())}
                      </p>
                    </div>
                  </div>
                  {/* Purchase price minus down payment, computed here — say so. */}
                  <ProvenanceBadge
                    provenance={DATA_PROVENANCE.SYSTEM_CALCULATED}
                    data-testid="provenance-loan-amount"
                  />
                </div>

                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 shrink-0">
                    <MapPin className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Property info</p>
                    <p className="font-semibold" data-testid="text-property-location">
                      {propertyLocation}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <Card className="bg-primary/5 border-primary/20">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <p className="font-medium text-sm">Ready to make an offer?</p>
                    <p className="text-sm text-muted-foreground">
                      Let us know if you plan on making an offer soon. We're here to help you make your offer as strong as possible.
                    </p>
                  </div>
                  <Button size="sm" className="touch-target shrink-0 gap-1" data-testid="button-make-offer">
                    Get started
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
              </>
            );
          }}
        </QueryBoundary>
    </PageShell>
  );
}
