import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TrendingUp,
  Brain,
  BarChart3,
  FileCheck,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Zap,
  Target,
} from "lucide-react";

interface FunnelData {
  stage: string;
  count: number;
  conversionRate: number;
}

interface AutomationMetrics {
  totalEvents: number;
  automatedEvents: number;
  automationRate: number;
  topAutomations: { name: string; count: number }[];
  byDomain: Record<string, { total: number; automated: number }>;
}

interface DocAccuracy {
  documentType: string;
  avgConfidence: number;
  totalExtractions: number;
  reviewedCount: number;
  gradedReviewCount: number;
  needsReviewCount: number;
  avgAccuracy: number | null;
}

interface OutcomeSegment {
  segment: string;
  totalLoans: number;
  funded: number;
  denied: number;
  withdrawn: number;
  avgDaysToClose: number | null;
  conversionRate: number;
}

interface HomiOutcomeMetrics {
  daysBack: number;
  turnAttempts: number;
  turns: number;
  failedTurns: number;
  excludedNonBorrowerTurnAttempts: number;
  turnSuccessRate: number;
  uniqueBorrowers: number;
  measuredUniqueBorrowers: number;
  serverTruthTurns: number;
  serverActionTurns: number;
  exactRepeatedQuestions: number;
  exactRepeatedQuestionRate: number;
  completionMeasuredTurns: number;
  completionMeasurementCoverageRate: number;
  captureAttemptTurns: number;
  captureSucceededTurns: number;
  capturedFields: number;
  completionMeasuredCaptureTurns: number;
  completionImprovedTurns: number;
  completionImprovementRate: number;
  completionRegressedTurns: number;
  humanHelpRequests: number;
  openHumanHelpRequests: number;
  recordedStaffResponses: number;
  recordedStaffResponseRate: number;
  averageRecordedStaffResponseMinutes: number | null;
  medianRecordedStaffResponseMinutes: number | null;
  completedWithoutRecordedStaffResponse: number;
  pastDueWithoutRecordedStaffResponse: number;
  averageTurnResponseMs: number | null;
  p95TurnResponseMs: number | null;
  invalidTurnLatencyRows: number;
  degradedTurns: number;
  lintReplacedTurns: number;
  legacyTurns: number;
  measurement: {
    status: "collecting" | "observational_only";
    canClaimReducedFriction: false;
    minimumMeasuredTurns: number;
    minimumUniqueBorrowers: number;
    comparisonStudy: {
      status: "not_registered";
      registrationId: null;
      assignmentUnit: null;
      comparisonCohort: null;
    };
    blockers: string[];
  };
}

type CoreCapabilityState = "live" | "simulated" | "disabled" | "configuration_error";

interface CoreCapabilityReport {
  generatedAt: string;
  environment: "production" | "non_production";
  readyForLiveLoanLifecycle: boolean;
  canRunProviderCanaries?: boolean;
  counts: Record<CoreCapabilityState, number>;
  documentExtractionQueue: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
    retryScheduled: number;
    staleLeases: number;
    oldestPendingAt: string | null;
    lastCompletedAt: string | null;
  };
  capabilities: Array<{
    id: string;
    label: string;
    provider: string;
    state: CoreCapabilityState;
    criticalForLiveLoan: boolean;
    verificationRequired: boolean;
    verificationState: "current" | "stale" | "failed" | "not_recorded" | "not_required";
    lastVerificationAttemptAt: string | null;
    lastSuccessfulVerificationAt: string | null;
    detail: string;
    nextAction: string | null;
  }>;
}

export default function IntelligenceTab() {
  const queryClient = useQueryClient();
  const { data: funnel, isLoading: funnelLoading } = useQuery<FunnelData[]>({
    queryKey: ["/api/outcomes/funnel"],
  });

  const { data: automation, isLoading: automationLoading } = useQuery<AutomationMetrics>({
    queryKey: ["/api/analytics/automation-metrics"],
  });

  const { data: docAccuracy, isLoading: docLoading } = useQuery<DocAccuracy[]>({
    queryKey: ["/api/documents/confidence/accuracy"],
  });

  const { data: creditSegments, isLoading: segmentsLoading } = useQuery<OutcomeSegment[]>({
    queryKey: ["/api/outcomes/segments/creditScoreBucket"],
  });

  const { data: coreCapabilities, isLoading: coreCapabilitiesLoading } = useQuery<CoreCapabilityReport>({
    queryKey: ["/api/analytics/core-capabilities"],
  });

  const { data: homiOutcomes, isLoading: homiOutcomesLoading } = useQuery<HomiOutcomeMetrics>({
    queryKey: ["/api/analytics/homi-outcomes"],
  });

  const canaryMutation = useMutation({
    mutationFn: async (capabilityId: string) => {
      const response = await apiRequest("POST", `/api/admin/core-capabilities/${capabilityId}/canary`, {});
      return response.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/analytics/core-capabilities"] }),
  });

  const isLoading = funnelLoading || automationLoading || docLoading || segmentsLoading || coreCapabilitiesLoading || homiOutcomesLoading;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <Card key={i}><CardContent className="p-4"><Skeleton className="h-16 w-full" /></CardContent></Card>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[1, 2].map(i => (
            <Card key={i}><CardContent className="p-4"><Skeleton className="h-48 w-full" /></CardContent></Card>
          ))}
        </div>
      </div>
    );
  }

  const totalAutomated = automation?.automatedEvents || 0;
  const automationRate = automation?.automationRate || 0;
  const totalEvents = automation?.totalEvents || 0;
  const avgDocConfidence = docAccuracy && docAccuracy.length > 0
    ? docAccuracy.reduce((s, d) => s + d.avgConfidence, 0) / docAccuracy.length
    : 0;
  const pendingReviews = docAccuracy?.reduce((s, d) => s + d.needsReviewCount, 0) || 0;

  const funnelStages = funnel || [];
  const topConversion = funnelStages.length > 0 ? funnelStages[0].count : 0;
  const bottomConversion = funnelStages.length > 0 ? funnelStages[funnelStages.length - 1].count : 0;
  const overallConversionRate = topConversion > 0 ? ((bottomConversion / topConversion) * 100) : 0;

  return (
    <div className="space-y-6" data-testid="intelligence-tab">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="kpi-automation-rate">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Zap className="h-4 w-4 text-warning-subtle-foreground" />
              <p className="text-sm text-muted-foreground">Automation Rate</p>
            </div>
            <p className="text-2xl font-bold">{automationRate.toFixed(0)}%</p>
            <p className="text-xs text-muted-foreground">{totalAutomated} of {totalEvents} tasks automated</p>
          </CardContent>
        </Card>
        <Card data-testid="kpi-conversion-rate">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Target className="h-4 w-4 text-success-subtle-foreground" />
              <p className="text-sm text-muted-foreground">Pipeline Conversion</p>
            </div>
            <p className="text-2xl font-bold">{overallConversionRate.toFixed(1)}%</p>
            <p className="text-xs text-muted-foreground">Submitted to funded</p>
          </CardContent>
        </Card>
        <Card data-testid="kpi-doc-confidence">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Brain className="h-4 w-4 text-info" />
              <p className="text-sm text-muted-foreground">Doc Intelligence</p>
            </div>
            <p className="text-2xl font-bold">{(avgDocConfidence * 100).toFixed(0)}%</p>
            <p className="text-xs text-muted-foreground">Avg extraction confidence</p>
          </CardContent>
        </Card>
        <Card data-testid="kpi-pending-reviews">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <FileCheck className="h-4 w-4 text-warning-subtle-foreground" />
              <p className="text-sm text-muted-foreground">Needs Review</p>
            </div>
            <p className="text-2xl font-bold">{pendingReviews}</p>
            <p className="text-xs text-muted-foreground">Low-confidence extractions</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="funnel">
        <TabsList>
          <TabsTrigger value="funnel" data-testid="tab-funnel">
            <BarChart3 className="h-4 w-4 mr-1" />
            Conversion Funnel
          </TabsTrigger>
          <TabsTrigger value="documents" data-testid="tab-documents">
            <FileCheck className="h-4 w-4 mr-1" />
            Document Intelligence
          </TabsTrigger>
          <TabsTrigger value="automation" data-testid="tab-automation">
            <Zap className="h-4 w-4 mr-1" />
            Automation Activity
          </TabsTrigger>
          <TabsTrigger value="segments" data-testid="tab-segments">
            <TrendingUp className="h-4 w-4 mr-1" />
            Outcome Segments
          </TabsTrigger>
          <TabsTrigger value="systems" data-testid="tab-core-systems">
            <Activity className="h-4 w-4 mr-1" />
            Core Systems
          </TabsTrigger>
          <TabsTrigger value="homi" data-testid="tab-homi-outcomes">
            <Brain className="h-4 w-4 mr-1" />
            Homi Outcomes
          </TabsTrigger>
        </TabsList>

        <TabsContent value="funnel" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4" />
                Pipeline Conversion Funnel (Last 90 Days)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {funnelStages.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No outcome data yet. Conversion metrics will appear as loans progress through the pipeline.
                </p>
              ) : (
                <div className="space-y-3">
                  {funnelStages.map((stage, idx) => {
                    const maxCount = funnelStages[0]?.count || 1;
                    const pct = (stage.count / maxCount) * 100;
                    return (
                      <div key={stage.stage} className="space-y-1" data-testid={`funnel-stage-${stage.stage}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium capitalize">
                            {stage.stage.replace(/_/g, " ")}
                          </span>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold">{stage.count}</span>
                            {idx > 0 && (
                              <Badge variant="secondary">
                                {stage.conversionRate.toFixed(0)}% from previous
                              </Badge>
                            )}
                          </div>
                        </div>
                        <Progress value={pct} className="h-2" />
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="documents" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="h-4 w-4" />
                Extraction Accuracy by Document Type
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(!docAccuracy || docAccuracy.length === 0) ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No document extractions recorded yet. Metrics will populate as documents are processed.
                </p>
              ) : (
                <div className="space-y-4">
                  {docAccuracy.map(doc => (
                    <div key={doc.documentType} className="flex items-center gap-4" data-testid={`doc-accuracy-${doc.documentType}`}>
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium capitalize">{doc.documentType.replace(/_/g, " ")}</span>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold">{(doc.avgConfidence * 100).toFixed(0)}%</span>
                            <Badge variant={doc.needsReviewCount > 0 ? "destructive" : "secondary"}>
                              {doc.totalExtractions} extractions
                            </Badge>
                          </div>
                        </div>
                        <Progress value={doc.avgConfidence * 100} className="h-2" />
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            {doc.reviewedCount} documents reviewed
                          </span>
                          {doc.needsReviewCount > 0 && (
                            <span className="flex items-center gap-1 text-warning-subtle-foreground">
                              <AlertTriangle className="h-3 w-3" />
                              {doc.needsReviewCount} need review
                            </span>
                          )}
                          {doc.avgAccuracy !== null && (
                            <span className="flex items-center gap-1">
                              <TrendingUp className="h-3 w-3" />
                              {doc.avgAccuracy.toFixed(0)}% field accuracy ({doc.gradedReviewCount} graded)
                            </span>
                          )}
                          {doc.avgAccuracy === null && doc.reviewedCount > 0 && (
                            <span>No field-level accuracy measured yet</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="automation" className="space-y-4 mt-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Zap className="h-4 w-4" />
                  Automation by Domain
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(!automation?.byDomain || Object.keys(automation.byDomain).length === 0) ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    No automation events recorded yet.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {Object.entries(automation.byDomain).map(([domain, stats]) => {
                      const rate = stats.total > 0 ? (stats.automated / stats.total) * 100 : 0;
                      return (
                        <div key={domain} className="space-y-1" data-testid={`automation-domain-${domain}`}>
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium capitalize">{domain}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-sm">{stats.automated}/{stats.total}</span>
                              <Badge variant="secondary">{rate.toFixed(0)}%</Badge>
                            </div>
                          </div>
                          <Progress value={rate} className="h-1.5" />
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="h-4 w-4" />
                  Top Automated Tasks
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(!automation?.topAutomations || automation.topAutomations.length === 0) ? (
                  <p className="text-sm text-muted-foreground py-8 text-center">
                    No automated tasks recorded yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {automation.topAutomations.slice(0, 8).map((item, idx) => (
                      <div key={item.name} className="flex items-center justify-between py-1" data-testid={`top-automation-${idx}`}>
                        <span className="text-sm">{item.name.replace(/_/g, " ")}</span>
                        <Badge variant="outline">{item.count}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="segments" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Outcomes by Credit Score Segment
              </CardTitle>
            </CardHeader>
            <CardContent>
              {(!creditSegments || creditSegments.length === 0) ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No outcome segments available yet. Data will appear as loans reach resolution.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 font-medium">Segment</th>
                        <th className="text-right py-2 font-medium">Total</th>
                        <th className="text-right py-2 font-medium">Funded</th>
                        <th className="text-right py-2 font-medium">Denied</th>
                        <th className="text-right py-2 font-medium">Conversion</th>
                        <th className="text-right py-2 font-medium">Avg Days</th>
                      </tr>
                    </thead>
                    <tbody>
                      {creditSegments.map(seg => (
                        <tr key={seg.segment} className="border-b last:border-0" data-testid={`segment-row-${seg.segment}`}>
                          <td className="py-2 font-medium">{seg.segment}</td>
                          <td className="text-right py-2">{seg.totalLoans}</td>
                          <td className="text-right py-2 text-success-subtle-foreground">{seg.funded}</td>
                          <td className="text-right py-2 text-destructive">{seg.denied}</td>
                          <td className="text-right py-2">
                            <Badge variant={seg.conversionRate > 0.5 ? "default" : "secondary"}>
                              {(seg.conversionRate * 100).toFixed(0)}%
                            </Badge>
                          </td>
                          <td className="text-right py-2">
                            {seg.avgDaysToClose ? `${seg.avgDaysToClose}d` : "--"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="homi" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-base">Homi borrower outcomes</CardTitle>
                {homiOutcomes && (
                  <Badge variant="secondary" data-testid="homi-measurement-status">
                    {homiOutcomes.measurement.status === "collecting" ? "Collecting evidence" : "Observational evidence"}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Server-measured file progress, exact repeated wording, response speed and recorded staff replies over the last {homiOutcomes?.daysBack ?? 30} days.
              </p>
            </CardHeader>
            <CardContent>
              {!homiOutcomes || (homiOutcomes.turnAttempts === 0 && homiOutcomes.humanHelpRequests === 0) ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No measured Homi turns yet. Results appear after borrowers use Homi on this build.
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="rounded-lg border bg-muted p-3 text-sm text-foreground" data-testid="homi-claim-boundary">
                    These measures describe observed work. The 30-turn, 10-borrower floor checks whether measurement works; it cannot prove that Homi reduced friction without a comparison study registered before enrollment.
                    <p className="mt-2 font-medium" data-testid="homi-study-status">
                      Comparison study: not registered. No cohort has been enrolled.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="rounded-lg border p-3">
                      <p className="text-xs text-muted-foreground">Saved work advanced file</p>
                      <p className="text-xl font-semibold">
                        {homiOutcomes.completionMeasuredCaptureTurns === 0 ? "—" : `${homiOutcomes.completionImprovementRate.toFixed(1)}%`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {homiOutcomes.completionImprovedTurns} of {homiOutcomes.completionMeasuredCaptureTurns} measured capture turns
                      </p>
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-xs text-muted-foreground">Exact repeated wording</p>
                      <p className="text-xl font-semibold">{homiOutcomes.exactRepeatedQuestionRate.toFixed(1)}%</p>
                      <p className="text-xs text-muted-foreground">{homiOutcomes.exactRepeatedQuestions} of {Math.max(0, homiOutcomes.turns - homiOutcomes.legacyTurns)} current-format turns</p>
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-xs text-muted-foreground">Average response</p>
                      <p className="text-xl font-semibold">
                        {homiOutcomes.averageTurnResponseMs === null ? "—" : `${(homiOutcomes.averageTurnResponseMs / 1000).toFixed(1)}s`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {homiOutcomes.p95TurnResponseMs === null ? "No p95 yet" : `p95 ${(homiOutcomes.p95TurnResponseMs / 1000).toFixed(1)}s`}
                      </p>
                    </div>
                    <div className="rounded-lg border p-3">
                      <p className="text-xs text-muted-foreground">Post-request staff messages</p>
                      <p className="text-xl font-semibold">
                        {homiOutcomes.humanHelpRequests === 0 ? "—" : `${homiOutcomes.recordedStaffResponseRate.toFixed(1)}%`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {homiOutcomes.recordedStaffResponses} of {homiOutcomes.humanHelpRequests} Homi requests
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">Grounded and saved work</p>
                      <p className="mt-1 text-muted-foreground">
                        {homiOutcomes.serverTruthTurns} turns read a server-truth tool; {homiOutcomes.serverActionTurns} used a server action. Homi saved {homiOutcomes.capturedFields} fields across {homiOutcomes.captureSucceededTurns} turns.
                      </p>
                    </div>
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">Recorded human follow-up signal</p>
                      <p className="mt-1 text-muted-foreground">
                        {homiOutcomes.medianRecordedStaffResponseMinutes === null
                          ? "No staff message in secure Messages is recorded while a Homi request is open."
                          : `Median first staff message: ${homiOutcomes.medianRecordedStaffResponseMinutes} minutes; average ${homiOutcomes.averageRecordedStaffResponseMinutes} minutes.`}
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        Each message counts toward one request only. Message content, calls and work outside secure Messages are not measured. {homiOutcomes.openHumanHelpRequests} open · {homiOutcomes.pastDueWithoutRecordedStaffResponse} past due without a message · {homiOutcomes.completedWithoutRecordedStaffResponse} completed without a message
                      </p>
                    </div>
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">Measurement coverage</p>
                      <p className="mt-1 text-muted-foreground">
                        {homiOutcomes.completionMeasuredTurns} of {homiOutcomes.turns} turns ({homiOutcomes.completionMeasurementCoverageRate.toFixed(1)}%) have two server file snapshots across {homiOutcomes.measuredUniqueBorrowers} eligible borrowers. {homiOutcomes.uniqueBorrowers} borrowers made an attempt; {homiOutcomes.legacyTurns} turns use the earlier metric format.
                      </p>
                    </div>
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">Quality exceptions</p>
                      <p className="mt-1 text-muted-foreground">
                        {homiOutcomes.turns} of {homiOutcomes.turnAttempts} borrower attempts completed ({homiOutcomes.turnSuccessRate.toFixed(1)}%) · {homiOutcomes.failedTurns} failed · {homiOutcomes.excludedNonBorrowerTurnAttempts} staff/unknown-role attempts excluded · {homiOutcomes.degradedTurns} offline-guidance turns · {homiOutcomes.lintReplacedTurns} compliance replacements · {homiOutcomes.completionRegressedTurns} measured regressions · {homiOutcomes.invalidTurnLatencyRows} invalid latency rows
                      </p>
                    </div>
                  </div>
                  <div className="rounded-lg border p-3 text-sm">
                    <p className="font-medium">Evidence blockers</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                      {homiOutcomes.measurement.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
                    </ul>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="systems" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base">Live capability truth</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Configuration and integration state for the mortgage workflow.
                  </p>
                </div>
                <Badge variant={coreCapabilities?.readyForLiveLoanLifecycle ? "default" : "secondary"}>
                  {coreCapabilities?.readyForLiveLoanLifecycle
                    ? "Live lifecycle ready"
                    : "External connections incomplete"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              {!coreCapabilities ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  Capability status is unavailable.
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {(["live", "simulated", "disabled", "configuration_error"] as const).map(state => (
                      <div key={state} className="rounded-lg border p-3">
                        <p className="text-xs capitalize text-muted-foreground">
                          {state.replace(/_/g, " ")}
                        </p>
                        <p className="text-xl font-semibold">{coreCapabilities.counts[state]}</p>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-lg border p-4" data-testid="document-extraction-queue">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="font-medium">Document extraction queue</p>
                        <p className="text-xs text-muted-foreground">
                          Durable work that resumes after a deploy or process restart.
                        </p>
                      </div>
                      <Badge
                        variant={
                          coreCapabilities.documentExtractionQueue.failed > 0 ||
                          coreCapabilities.documentExtractionQueue.staleLeases > 0
                            ? "destructive"
                            : coreCapabilities.documentExtractionQueue.pending > 0 ||
                                coreCapabilities.documentExtractionQueue.processing > 0
                              ? "secondary"
                              : "default"
                        }
                      >
                        {coreCapabilities.documentExtractionQueue.failed > 0
                          ? "Needs attention"
                          : coreCapabilities.documentExtractionQueue.pending > 0 ||
                              coreCapabilities.documentExtractionQueue.processing > 0
                            ? "Working"
                            : "Healthy"}
                      </Badge>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {([
                        ["Pending", coreCapabilities.documentExtractionQueue.pending],
                        ["Processing", coreCapabilities.documentExtractionQueue.processing],
                        ["Retry scheduled", coreCapabilities.documentExtractionQueue.retryScheduled],
                        ["Failed", coreCapabilities.documentExtractionQueue.failed],
                        ["Stale leases", coreCapabilities.documentExtractionQueue.staleLeases],
                      ] as const).map(([label, value]) => (
                        <div key={label} className="rounded-md bg-muted/40 p-2">
                          <p className="text-xs text-muted-foreground">{label}</p>
                          <p className="text-lg font-semibold">{value}</p>
                        </div>
                      ))}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      Last completed:{" "}
                      {coreCapabilities.documentExtractionQueue.lastCompletedAt
                        ? new Date(coreCapabilities.documentExtractionQueue.lastCompletedAt).toLocaleString()
                        : "not recorded"}
                    </p>
                  </div>
                  {coreCapabilities.capabilities.map(capability => (
                    <div
                      key={capability.id}
                      className="rounded-lg border p-4"
                      data-testid={`core-capability-${capability.id}`}
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <p className="font-medium">{capability.label}</p>
                          <p className="text-xs text-muted-foreground">{capability.provider}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {capability.verificationRequired && (
                            <Badge
                              variant={
                                capability.verificationState === "current"
                                  ? "default"
                                  : capability.verificationState === "failed"
                                    ? "destructive"
                                    : "outline"
                              }
                              data-testid={`core-verification-${capability.id}`}
                            >
                              {capability.verificationState === "current"
                                ? "Canary current"
                                : capability.verificationState === "not_recorded"
                                  ? "Canary not run"
                                  : `Canary ${capability.verificationState}`}
                            </Badge>
                          )}
                          <Badge
                            variant={
                              capability.state === "configuration_error"
                                ? "destructive"
                                : capability.state === "live"
                                  ? "default"
                                  : capability.state === "disabled"
                                    ? "outline"
                                    : "secondary"
                            }
                          >
                            {capability.state.replace(/_/g, " ")}
                          </Badge>
                        </div>
                      </div>
                      <p className="mt-3 text-sm">{capability.detail}</p>
                      <div className="mt-2 text-xs text-muted-foreground">
                        Last successful verification:{" "}
                        {capability.lastSuccessfulVerificationAt
                          ? new Date(capability.lastSuccessfulVerificationAt).toLocaleString()
                          : "not recorded"}
                      </div>
                      {coreCapabilities.canRunProviderCanaries &&
                        ["homi", "document_extraction", "object_storage"].includes(capability.id) && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-3 touch-target"
                            disabled={canaryMutation.isPending}
                            onClick={() => canaryMutation.mutate(capability.id)}
                            data-testid={`run-canary-${capability.id}`}
                          >
                            {canaryMutation.isPending && canaryMutation.variables === capability.id
                              ? "Running check…"
                              : "Run operational check"}
                          </Button>
                        )}
                      {canaryMutation.isError && canaryMutation.variables === capability.id && (
                        <p className="mt-2 text-xs text-destructive">The check could not be recorded. Try again or review server health.</p>
                      )}
                      {capability.nextAction && (
                        <p className="mt-2 text-sm text-muted-foreground">
                          Next: {capability.nextAction}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
