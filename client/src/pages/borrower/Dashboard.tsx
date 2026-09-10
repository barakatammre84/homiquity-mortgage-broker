import { useEffect, useState } from "react";
import { useActiveApplication } from "@/hooks/useActiveApplication";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { useAutopilotStatus } from "@/hooks/useAutopilotStatus";
import { AutopilotBanner } from "@/components/AutopilotBanner";
import { useAuth } from "@/hooks/useAuth";
import { usePageView } from "@/hooks/useActivityTracker";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, dashboardKeys, coachConversationKeys, loanApplicationKeys, taskEngineKeys } from "@/lib/queryClient";
import { deriveJourneyStepDetails } from "@shared/borrowerJourney";
import { formatCurrency } from "@/lib/formatters";
import { hasPendingPreApprovalSubmit } from "@/lib/pendingAttribution";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BorrowerRequests } from "@/components/BorrowerRequests";
import { TermTooltip } from "@/components/TermTooltip";
import { ApplicationSwitcher } from "@/components/ApplicationSwitcher";
import { JourneyTracker } from "@/components/JourneyTracker";
import { PartnerSharingCard } from "@/components/PartnerSharingCard";
import { PreApprovedCard } from "@/components/dashboard/PreApprovedCard";
import { ContactCard } from "@/components/dashboard/ContactCard";
import { LoanTeamCard } from "@/components/dashboard/LoanTeamCard";
import { RenterHome } from "@/pages/borrower/RenterHome";
import { isStaffRole } from "@shared/roles";
import PredictionInsights from "@/components/borrower/PredictionInsights";
import type { LoanApplication, DealActivity, LoanAppStatus } from "@shared/schema";
import {
  CheckCircle2,
  Clock,
  FileText,
  ArrowRight,
  TrendingUp,
  Home,
  Percent,
  DollarSign,
  Calendar,
  User,
  Bot,
  Sparkles,
  Users,
  Download,
  Loader2,
  AlertTriangle,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  MessageCircle,
  Shield,
  Target,
  Briefcase,
  PiggyBank,
  Rocket,
  Zap,
} from "lucide-react";

import { hasBrowsedProperties } from "@/lib/pendingAttribution";
import {
  NEXT_ACTION_ICONS,
  getPreUwFlags,
  getExpirationInfo,
  getReadinessPercent,
  getPersonalizedGreeting,
  showIncubatorHome,
  type DashboardData,
  type NextActionData,
  type BorrowerGraphData,
} from "./borrowerDashboard/model";
import { FinancialSnapshot } from "./borrowerDashboard/FinancialSnapshot";
import { CollapsibleActivity } from "./borrowerDashboard/CollapsibleActivity";
import { LoanDetails } from "./borrowerDashboard/LoanDetails";
import { PreQualLetterCard } from "./borrowerDashboard/PreQualLetterCard";

export default function Dashboard() {
  const { user, isLoading: authLoading } = useAuth();
  usePageView("/dashboard");
  const [, navigate] = useLocation();

  const isStaff = isStaffRole(user?.role || "");

  useEffect(() => {
    if (!authLoading && isStaff) {
      navigate("/staff-dashboard");
    }
  }, [authLoading, isStaff, navigate]);

  // Catch-all for OAuth sign-in: the password login/signup handlers already route
  // a deferred pre-approval submit back to /apply, but an OAuth callback lands the
  // user here on /dashboard. If a completed funnel is waiting to submit, bounce to
  // /apply so the replay effect finishes it instead of stranding them on the
  // incubator with their answers unsent.
  useEffect(() => {
    if (!authLoading && !isStaff && hasPendingPreApprovalSubmit()) {
      navigate("/apply");
    }
  }, [authLoading, isStaff, navigate]);

  const { data, isLoading, isFetching } = useQuery<DashboardData>({
    queryKey: dashboardKeys.root(),
    enabled: !authLoading && !isStaff,
  });

  const { data: coachConversations } = useQuery<{ id: number }[]>({
    queryKey: coachConversationKeys.all(),
    enabled: !authLoading && !isStaff,
  });

  // activitySummary and nextAction now ride on /api/dashboard — two fewer
  // request waterfalls on mount. (The old /api/homeownership-goal query fed a
  // goal-string switch that never matched — the endpoint returns an object —
  // so it's dropped, not moved.)
  const activitySummary = data?.activitySummary;

  const { data: borrowerGraph, isError: graphError } = useQuery<BorrowerGraphData>({
    queryKey: ["/api/borrower-graph"],
    enabled: !authLoading && !isStaff,
    retry: 1,
    staleTime: 60000,
  });

  const [browsedProperties, setBrowsedProperties] = useState(false);
  useEffect(() => {
    try {
      setBrowsedProperties(hasBrowsedProperties());
    } catch {}
  }, []);

  // Rules of Hooks: both of these must run before the early returns below, so
  // the selection is resolved once here (tolerant of not-yet-loaded data) and
  // reused after the guards; the Autopilot hook re-subscribes when the id changes.
  const { activeApplication, selectApplication } = useActiveApplication(data?.applications ?? []);
  const autopilot = useAutopilotStatus(activeApplication?.id);

  // Journey detail lines: milestone dates + doc/condition counters from the
  // pipeline payload, plus the closing-prep transparency task. Both queries
  // share cache entries with their existing consumers (LoanPipeline,
  // BorrowerRequests) — segmented keys, no new endpoints.
  const { data: pipelineData } = useQuery<{
    progress?: { documentsComplete: number; documentsTotal: number; conditionsCleared: number; conditionsTotal: number };
    milestones?: Record<string, string | null> | null;
  }>({
    queryKey: loanApplicationKeys.pipeline(activeApplication?.id ?? ""),
    enabled: !!activeApplication?.id,
  });
  const { data: journeyTasks } = useQuery<
    Array<{ taskTypeCode?: string; ownerRole?: string; status: string }>
  >({
    queryKey: taskEngineKeys.borrowerTasks(activeApplication?.id),
    enabled: !!activeApplication?.id,
  });
  const journeyDetails = deriveJourneyStepDetails({
    milestones: pipelineData?.milestones ?? null,
    documents: pipelineData?.progress
      ? { complete: pipelineData.progress.documentsComplete, total: pipelineData.progress.documentsTotal }
      : null,
    conditions: pipelineData?.progress
      ? { cleared: pipelineData.progress.conditionsCleared, total: pipelineData.progress.conditionsTotal }
      : null,
    closingPrepInProgress: (journeyTasks ?? []).some(
      (t) =>
        t.taskTypeCode === "CMP_CLOSING_DISC" &&
        t.ownerRole !== "BORROWER" &&
        (t.status === "OPEN" || t.status === "IN_PROGRESS"),
    ),
  });

  const waitingForSubmittedApplication =
    user?.role === "active_buyer" && isFetching && (data?.applications?.length ?? 0) === 0;

  if (authLoading || isLoading || waitingForSubmittedApplication || isStaff) {
    return (
      // Geometry matches the real page (max-w-6xl + the canonical gutter) so the
      // layout does not jump when data lands. It used to be `p-8 max-w-xl`, a
      // width DESIGN_SYSTEM.md §4 retires, ~3x narrower than the page it stood in
      // for — the content visibly snapped wider on every load.
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-8 sm:py-10 space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-3 w-40 mt-4" />
        <Skeleton className="h-40 w-full mt-6" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const applications = data?.applications || [];
  const activities = data?.activities || [];
  const unreadMessages = data?.unreadMessages || 0;
  const pendingTasksByApplication = data?.pendingTasksByApplication || {};

  // Post-close borrowers graduate to the Homeowner module (equity tracking,
  // refi alerts). This is the only in-app path to /homeowner-dashboard.
  // ("funded" is the canonical post-close status — the old check for "closed"
  // matched a value no backend path ever wrote, so this link never appeared.)
  const hasClosedLoan = applications.some((app) => app.status === "funded");

  const approvalVerified = !!activeApplication
    && borrowerGraph?.activeApplicationId === activeApplication.id
    && borrowerGraph.financialVerification.decisionGrade;
  const isPreApproved = activeApplication?.status === "pre_approved" && approvalVerified;
  const expirationInfo = activeApplication ? getExpirationInfo(activeApplication, approvalVerified) : null;

  const offerCount = activeApplication ? (data?.loanOptionCounts?.[activeApplication.id] || 0) : 0;
  const hasOffers = offerCount > 0;
  const appOptions = (data?.recentOptions || []).filter(
    (opt) => activeApplication && opt.applicationId === activeApplication.id
  );
  const sortedRates = appOptions
    .map((o) => parseFloat(o.interestRate))
    .filter((r: number) => !isNaN(r))
    .sort((a: number, b: number) => a - b);
  const rateRange = hasOffers && sortedRates.length >= 2
    ? `${sortedRates[0].toFixed(2)}% - ${sortedRates[sortedRates.length - 1].toFixed(2)}%`
    : hasOffers && sortedRates.length === 1
    ? `${sortedRates[0].toFixed(2)}%`
    : null;
  const hmdaCompleted = activeApplication ? (data?.hmdaStatus?.[activeApplication.id] || false) : false;

  const verificationStatus = activeApplication
    ? data?.verificationStatus?.[activeApplication.id]
    : undefined;

  const hasCoachSession = (coachConversations?.length || 0) > 0;

  // Signals are scoped to the ACTIVE application — never summed across every
  // application the user has ever had.
  const activeTaskCounts = (activeApplication && pendingTasksByApplication[activeApplication.id]) || {
    total: 0,
    documents: 0,
  };

  const readiness = getReadinessPercent(
    activeApplication || null,
    data?.stats?.pendingDocuments || 0,
    activeTaskCounts.total,
    verificationStatus,
    hasCoachSession,
    browsedProperties,
    approvalVerified,
  );

  // Incubator gate: no workable file and no funded loan → RenterHome (see
  // showIncubatorHome). Covers first visits AND borrowers whose applications
  // all ended terminally (denied/withdrawn/expired) — the latter previously
  // fell through to a generic "start your pre-approval" Dashboard.
  if (showIncubatorHome(applications, activeApplication)) {
    return (
      <RenterHome
        userName={user?.firstName || undefined}
      />
    );
  }

  const { title: greetingTitle, subtitle: greetingSubtitle } = getPersonalizedGreeting(
    user,
    activeApplication || null,
    approvalVerified,
  );

  // Server-computed next action — one source of truth for "what should the
  // borrower do next" (server/services/nextAction.ts). The generic fallback
  // only shows if the payload predates the field (stale cache mid-deploy).
  const dominant: NextActionData = data?.nextAction ?? {
    kind: "in_review",
    title: "Your application is being reviewed",
    description: "We're analyzing your information. You'll hear back shortly.",
    href: "/dashboard",
    buttonLabel: "View Status",
  };

  const DominantIcon = NEXT_ACTION_ICONS[dominant.kind] ?? Clock;

  // File-health signal: pre-underwriting flags drive the header chip — amber
  // "action needed" when flagged, green check once the automated review is clean.
  const activePreUw = getPreUwFlags(activeApplication);
  const fileHealth: "healthy" | "action" | null = activePreUw?.evaluatedAt
    ? (activePreUw.flags?.length ?? 0) > 0
      ? "action"
      : "healthy"
    : null;

  return (
    /* min-h-FULL, not min-h-screen (DESIGN_SYSTEM.md §15). PrivateLayout's
       <main> is `flex-1 overflow-y-auto` — its own scroll container — so a
       100vh child guarantees a viewport of dead scroll below short content,
       and on a phone the layout's `pb-16` bottom-nav gutter sits under that. */
    <div className="min-h-full bg-surface">
      {/* HERO — full-bleed royal-blue band. Uses bg-accent / text-accent-foreground
          (brandable tokens) so it re-skins to a tenant's brand via BrandingProvider;
          never a bare white literal. */}
      <section className="bg-accent text-accent-foreground">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-10 sm:py-14">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold sm:text-3xl" data-testid="text-dashboard-title">
                  {greetingTitle}
                </h1>
                {fileHealth === "healthy" && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-xs font-medium text-success-subtle-foreground"
                    title="Automated pre-underwriting review found no issues"
                    data-testid="chip-file-healthy"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    File healthy
                  </span>
                )}
                {fileHealth === "action" && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-warning-subtle px-2 py-0.5 text-xs font-medium text-warning-subtle-foreground"
                    // Never the raw flag reasons: they carry staff-side signal prose
                    // (creditor names, balances, what-if DTI figures) computed over
                    // unverified data — the C2 class barred from borrower surfaces.
                    // Staff see the full flags on the BorrowerFile panels.
                    title="Automated review found items to address — your loan team will guide you through them"
                    data-testid="chip-file-action-needed"
                  >
                    <AlertTriangle className="h-3 w-3" />
                    Action needed
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-accent-foreground/85" data-testid="text-dashboard-subtitle">
                {greetingSubtitle}
              </p>
            </div>
            {applications.length > 1 && (
              /* White pill so the switcher's dark trigger reads on the royal hero. */
              <div className="shrink-0 rounded-lg bg-background p-1 shadow-card" data-testid="app-switcher-wrap">
                <ApplicationSwitcher
                  applications={applications}
                  activeApplicationId={activeApplication?.id}
                  onSelectApplication={selectApplication}
                />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* CONTENT — centered grid overlapping the hero */}
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 -mt-8 pb-16">
        <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
          {/* LEFT column (wider): next step → tasks → progress */}
          <div className="space-y-4 sm:space-y-6 lg:col-span-2">
            {hasClosedLoan && (
              <Link href="/homeowner-dashboard">
                <div
                  className="flex items-center justify-between rounded-lg border border-card-border bg-card px-4 py-3 shadow-card hover-elevate cursor-pointer"
                  data-testid="link-homeowner-dashboard"
                >
                  <div>
                    <p className="text-sm font-semibold">Your Homeowner Hub</p>
                    <p className="text-xs text-muted-foreground">
                      Track your equity, watch for refinance opportunities, and manage your home.
                    </p>
                  </div>
                  <span className="text-sm font-medium text-primary">Open →</span>
                </div>
              </Link>
            )}

            {/* One dominant action — the "next step" hero card */}
            <Card className="shadow-card-lg hover-elevate" data-testid="card-dominant-action">
              <CardContent className="p-5 sm:p-6">
                <div className="flex flex-col items-center text-center space-y-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold tracking-wide text-accent uppercase">Your next step</span>
                    {dominant.timeEstimate && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="text-dominant-time">
                        <Clock className="h-3 w-3" />
                        {dominant.timeEstimate}
                      </span>
                    )}
                  </div>
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                    <DominantIcon className="h-6 w-6 text-primary" />
                  </div>
                  <div className="space-y-1">
                    <h2 className="text-base font-semibold" data-testid="text-dominant-title">
                      {dominant.title}
                    </h2>
                    <p className="text-sm text-muted-foreground leading-relaxed max-w-sm mx-auto" data-testid="text-dominant-description">
                      {dominant.description}
                    </p>
                    {dominant.whyNeeded && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" className="touch-target inline-flex items-center text-xs text-muted-foreground/70 hover:text-muted-foreground underline decoration-dotted underline-offset-2 cursor-help" data-testid="button-why-needed">
                            Why is this needed?
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="max-w-xs text-xs">
                          <p>{dominant.whyNeeded}</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  <Button asChild size="lg" data-testid="button-dominant-action">
                    <Link href={dominant.href} data-testid="link-dominant-action">
                      {dominant.buttonLabel}
                      <ArrowRight className="h-4 w-4 ml-2" />
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Tasks — what we need from you */}
            {activeApplication && (
              <BorrowerRequests
                applicationId={activeApplication.id}
                data-testid="card-what-we-need"
              />
            )}

            {/* Loan Progress — vertical COMPLETE / CURRENT / UPCOMING timeline.
                Not rendered for a deep-linked denied file: JourneyTracker
                returns null on "denied", which would leave an empty shell. */}
            {activeApplication && activeApplication.status !== "draft" && activeApplication.status !== "denied" && (
              <Card className="shadow-card" data-testid="card-journey">
                <CardContent className="p-5 sm:p-6">
                  <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Loan Progress</p>
                      <div className="mt-1 h-0.5 w-8 rounded-full bg-primary/60" />
                    </div>
                    {/* Every progress display says what it measures
                        (DESIGN_SYSTEM §13). This bar is a weighted estimate of
                        how far the FILE has moved — loan stage plus the
                        verification steps done — not a count of anything, so
                        it is labeled as an estimate and never presented as a
                        tally the borrower could reconcile against a list. */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-xs text-muted-foreground" data-testid="label-readiness">
                        How far your file has moved (estimated)
                      </span>
                      <div
                        className="h-1.5 w-20 rounded-full bg-muted overflow-hidden"
                        role="img"
                        aria-label={`How far your file has moved, estimated: ${readiness}%`}
                      >
                        <div
                          className="h-full rounded-full bg-primary transition-all duration-700"
                          style={{ width: `${readiness}%` }}
                          data-testid="progress-bar-fill"
                        />
                      </div>
                      <span className="text-xs text-muted-foreground" data-testid="text-readiness">
                        {readiness}%
                      </span>
                    </div>
                  </div>
                  <JourneyTracker status={activeApplication.status} approvalVerified={approvalVerified} variant="vertical" showEstimates details={journeyDetails} />
                  <div className="mt-4 pt-3 border-t flex items-center gap-2 text-xs text-muted-foreground/70" data-testid="text-automation-status">
                    <Zap className="h-3 w-3 text-primary" />
                    <span>Platform is automatically tracking compliance deadlines, verifying documents, and updating your progress</span>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* RIGHT column (narrower): pre-approval → contact → loan team */}
          <div className="space-y-4 sm:space-y-6 lg:col-span-1">
            {activeApplication && activeApplication.status === "pre_approved" && approvalVerified && (
              <PreApprovedCard
                applicationId={activeApplication.id}
                amount={activeApplication.preApprovalAmount || activeApplication.purchasePrice}
                validUntil={expirationInfo && expirationInfo.urgency !== "expired" ? expirationInfo.label : null}
              />
            )}
            {activeApplication && (["submitted", "analyzing"].includes(activeApplication.status) ||
              (activeApplication.status === "pre_approved" && !approvalVerified)) && (
              <PreQualLetterCard applicationId={activeApplication.id} />
            )}
            {activeApplication && <ContactCard />}
            {activeApplication && <LoanTeamCard applicationId={activeApplication.id} />}
          </div>
        </div>

        {/* Autopilot live status banner (Phase 4) — three real-time states +
            package-readiness meter. Renders only when a status exists. */}
        {activeApplication && (
          <AutopilotBanner status={autopilot.status} live={autopilot.live} />
        )}

        {/* SECONDARY — full-width detail stack below the grid (collapsed by default) */}
        <div className="mt-6 space-y-4">
          {/* Progress-sharing with a referring partner (PH-2). Self-hides when the
              borrower has no partner referrer. */}
          <PartnerSharingCard />

          {activeApplication && activeApplication.status !== "draft" && (
            <PredictionInsights applicationId={activeApplication.id} financialsVerified={approvalVerified} />
          )}

          {borrowerGraph && !graphError && (
            <FinancialSnapshot graph={borrowerGraph} qualificationVerified={approvalVerified} />
          )}

          {activeApplication && (
            <LoanDetails
              application={activeApplication}
              hasOffers={hasOffers}
              offerCount={offerCount}
              rateRange={rateRange}
              hmdaCompleted={hmdaCompleted}
              expirationInfo={expirationInfo}
              isPreApproved={isPreApproved}
            />
          )}

          <CollapsibleActivity activities={activities} />

          {activeApplication && (
            <div className="flex justify-center pt-2">
              <Button asChild variant="ghost" size="sm" className="touch-target text-muted-foreground gap-1.5">
                <Link href="/onboarding" data-testid="link-view-journey">
                  <Rocket className="h-3.5 w-3.5" />
                  View full journey checklist
                </Link>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
