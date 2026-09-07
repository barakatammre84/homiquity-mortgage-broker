import { useQuery } from "@tanstack/react-query";
import { predictionKeys } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TrendingUp,
  Clock,
  CheckCircle2,
  AlertTriangle,
  BarChart3,
  Target,
} from "lucide-react";
import { PREDICTION_INSIGHTS_DISCLAIMER } from "@shared/dataProvenance";

interface Prediction {
  likelihoodToClose: number;
  estimatedDaysToFund: number;
  riskOfFallout: number;
  conditionDelayRisk: number;
  riskFactors: string[];
  positiveFactors: string[];
  comparisonCohort: string;
  cohortAvgDaysToClose: number | null;
  cohortConversionRate: number | null;
}

interface Benchmark {
  yourMetrics: {
    creditScore: number | null;
    dti: number | null;
    ltv: number | null;
    documentsSubmitted: number;
    daysInProcess: number | null;
  };
  cohortMetrics: {
    avgCreditScore: number | null;
    avgDti: number | null;
    avgLtv: number | null;
    avgDaysToClose: number | null;
    conversionRate: number | null;
    totalBorrowers: number;
  };
  percentiles: {
    creditScorePercentile: number | null;
    dtiPercentile: number | null;
    speedPercentile: number | null;
  };
  insights: string[];
}

export default function PredictionInsights({ applicationId, financialsVerified = false }: { applicationId?: string; financialsVerified?: boolean }) {
  // No queryFn / no second URL spelling. `/api/predictions/me` reads
  // `?applicationId=` (server/routes/data-intelligence.ts) — it is not
  // `/me/:id` — so the old bare-scalar key resolved to a path that does not
  // exist, and the hand-written queryFn was the only thing making it work.
  // The params-object form makes the key describe the request it performs.
  const { data: prediction, isLoading: predLoading } = useQuery<Prediction>({
    queryKey: predictionKeys.me(applicationId),
  });

  const { data: benchmark, isLoading: benchLoading } = useQuery<Benchmark>({
    queryKey: predictionKeys.benchmark(),
  });

  if (predLoading || benchLoading) {
    return (
      <Card>
        <CardContent className="p-4">
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!prediction) return null;

  const likelihoodPct = Math.round(prediction.likelihoodToClose * 100);
  const statusColor = likelihoodPct >= 70 ? "text-success-subtle-foreground" : likelihoodPct >= 40 ? "text-warning-subtle-foreground" : "text-destructive";
  const statusLabel = likelihoodPct >= 70 ? "Strong" : likelihoodPct >= 40 ? "Moderate" : "Needs Attention";

  // Borrower surface shows a QUALITATIVE outlook + a typical WEEK RANGE, never a
  // bold odds % or a single "days to funding" integer — a precise per-file number
  // reads as a representation / promised date on a pre-underwriting file (UDAAP;
  // compliance decision recorded in PR #137). The heuristic still drives the band.
  const outlookWeeks = Math.max(3, Math.round(prediction.estimatedDaysToFund / 7));
  const timelineRange = `${outlookWeeks - 1}–${outlookWeeks + 1} weeks`;

  return (
    <Card data-testid="prediction-insights">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          Your Loan Progress Insights
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="space-y-1" data-testid="metric-likelihood">
            <p className="text-xs text-muted-foreground">Outlook</p>
            <div className="flex items-center gap-1">
              <Target className={`h-4 w-4 ${statusColor}`} />
              <span className={`text-lg font-bold ${statusColor}`}>{statusLabel}</span>
            </div>
            {/* Qualitative status only — the numeric closing-odds % is intentionally
                not shown to the borrower (UDAAP; PR #137). */}
            <p className="text-xs leading-tight text-muted-foreground">estimate, not a decision</p>
          </div>
          <div className="space-y-1" data-testid="metric-timeline">
            <p className="text-xs text-muted-foreground">Typical timeline</p>
            <div className="flex items-center gap-1">
              <Clock className="h-4 w-4 text-info" />
              <span className="text-base font-bold">{timelineRange}</span>
            </div>
            <p className="text-xs text-muted-foreground">after full submission</p>
            <p className="text-xs leading-tight text-muted-foreground">typical, not a closing date</p>
          </div>
          {financialsVerified && benchmark?.percentiles?.creditScorePercentile != null && (
            <div className="space-y-1" data-testid="metric-credit-percentile">
              <p className="text-xs text-muted-foreground">Credit Standing</p>
              <div className="flex items-center gap-1">
                <TrendingUp className="h-4 w-4 text-success-subtle-foreground" />
                <span className="text-lg font-bold">{benchmark.percentiles.creditScorePercentile}th</span>
              </div>
              <p className="text-xs text-muted-foreground">percentile</p>
            </div>
          )}
          {benchmark?.yourMetrics.documentsSubmitted !== undefined && (
            <div className="space-y-1" data-testid="metric-docs">
              <p className="text-xs text-muted-foreground">Documents</p>
              <div className="flex items-center gap-1">
                <CheckCircle2 className="h-4 w-4 text-success-subtle-foreground" />
                <span className="text-lg font-bold">{benchmark.yourMetrics.documentsSubmitted}</span>
              </div>
              <p className="text-xs text-muted-foreground">submitted</p>
            </div>
          )}
        </div>

        {prediction.positiveFactors.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Working in your favor</p>
            <div className="flex flex-wrap gap-1.5">
              {prediction.positiveFactors.slice(0, 4).map((f, i) => (
                <Badge key={i} variant="secondary" className="text-xs">
                  <CheckCircle2 className="h-3 w-3 mr-1 text-success-subtle-foreground" />
                  {f}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {prediction.riskFactors.length > 0 && prediction.riskFactors[0] !== "Insufficient data for detailed prediction" && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Areas to address</p>
            <div className="flex flex-wrap gap-1.5">
              {prediction.riskFactors.slice(0, 3).map((f, i) => (
                <Badge key={i} variant="outline" className="text-xs">
                  <AlertTriangle className="h-3 w-3 mr-1 text-warning-subtle-foreground" />
                  {f}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {benchmark?.insights && benchmark.insights.length > 0 && (
          <div className="border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground mb-1.5">Compared to similar borrowers</p>
            {benchmark.insights.slice(0, 2).map((insight, i) => (
              <p key={i} className="text-sm text-muted-foreground">{insight}</p>
            ))}
          </div>
        )}

        {/*
          Non-binding-estimate disclaimer (canonical wording in @shared/dataProvenance).
          Rendered as a clear/conspicuous callout, not a de-emphasized footnote: a
          bold "Likelihood 87%" / "22d to funding" is a headline claim a footnote
          alone struggles to cure (UDAAP net-impression, 12 U.S.C. §5531(d)/§5536).
          Do not soften without compliance/counsel review.
        */}
        <p
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-foreground/80"
          data-testid="prediction-disclaimer"
        >
          {PREDICTION_INSIGHTS_DISCLAIMER}
        </p>
      </CardContent>
    </Card>
  );
}
