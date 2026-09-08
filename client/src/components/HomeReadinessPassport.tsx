import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency } from "@/lib/formatters";
import {
  Shield,
  Briefcase,
  PiggyBank,
  FileText,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Target,
  Percent,
  ArrowRight,
  Bot,
} from "lucide-react";

interface BorrowerGraphData {
  financialVerification: {
    income: boolean;
    assets: boolean;
    credit: boolean;
    decisionGrade: boolean;
  };
  bestAnnualIncome: number | null;
  bestIncomeSource: string | null;
  totalVerifiedAssets: number | null;
  totalMonthlyDebts: number | null;
  documentsUploaded: number;
  documentsVerified: number;
  documentsMissing: string[];
  readiness: {
    completionPercentage: number;
    tier: string;
    completedInputs: string[];
    outstandingInputs: string[];
  };
  eligibility: {
    estimatedDTI: number | null;
    estimatedLTV: number | null;
    creditTier: string;
    creditScore: number | null;
    employmentStable: boolean | null;
    employmentYears: number | null;
    hasAdequateSavings: boolean | null;
    estimatedMaxPurchase: number | null;
    eligibleLoanTypes: string[];
  };
  predictiveSignals: {
    engagementLevel: string;
    suggestedNextAction: string;
  };
}

const tierLabels: Record<string, { label: string; color: string }> = {
  ready_now: { label: "Ready to Buy", color: "bg-success-subtle text-success-subtle-foreground" },
  almost_ready: { label: "Almost Ready", color: "bg-info-subtle text-info" },
  building: { label: "Building", color: "bg-warning-subtle text-warning-subtle-foreground" },
  exploring: { label: "Exploring", color: "bg-muted text-muted-foreground" },
  unknown: { label: "Getting Started", color: "bg-muted text-muted-foreground" },
};

function ReadinessRing({ score }: { score: number }) {
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  const color = score >= 80 ? "stroke-success" : score >= 50 ? "stroke-info" : score >= 25 ? "stroke-warning" : "stroke-muted-foreground";

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="88" height="88" className="-rotate-90">
        <circle cx="44" cy="44" r={radius} fill="none" stroke="currentColor" className="text-muted/30" strokeWidth="6" />
        <circle cx="44" cy="44" r={radius} fill="none" className={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} style={{ transition: "stroke-dashoffset 0.6s ease" }} />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-xl font-bold" data-testid="text-readiness-score">{score}</span>
        <span className="text-[10px] text-muted-foreground">/ 100</span>
      </div>
    </div>
  );
}

export function HomeReadinessPassport({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(!compact);

  const { data: graph, isLoading, isError } = useQuery<BorrowerGraphData>({
    queryKey: ["/api/borrower-graph"],
    enabled: !!user,
    staleTime: 60000,
    retry: 1,
  });

  if (!user) return null;
  if (isLoading) return <Skeleton className="h-32 w-full" data-testid="passport-loading" />;
  if (isError || !graph) {
    return (
      <Card data-testid="card-passport-unavailable">
        <CardContent className="flex flex-col items-center gap-2 p-5 text-center">
          <AlertCircle className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Readiness data is temporarily unavailable</p>
          <Button asChild variant="outline" size="sm" className="touch-target gap-2" data-testid="button-passport-coach-fallback">
            <Link href="/ai-coach">
              <Bot className="h-4 w-4" />
              Talk to Homi
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const tier = tierLabels[graph.readiness.tier] || tierLabels.unknown;
  const { eligibility } = graph;

  const verificationItems = [
    {
      icon: Shield,
      label: "Credit Score",
      verified: graph.financialVerification.credit,
      value: eligibility.creditScore ? `${eligibility.creditScore}` : null,
      testId: "passport-credit",
    },
    {
      icon: Briefcase,
      label: "Income",
      verified: graph.financialVerification.income,
      value: graph.bestAnnualIncome ? formatCurrency(Math.round(graph.bestAnnualIncome)) : null,
      source: graph.bestIncomeSource,
      testId: "passport-income",
    },
    {
      icon: PiggyBank,
      label: "Assets",
      verified: !!graph.totalVerifiedAssets,
      value: graph.totalVerifiedAssets ? formatCurrency(graph.totalVerifiedAssets) : null,
      testId: "passport-assets",
    },
    {
      icon: Briefcase,
      label: "Employment",
      verified: eligibility.employmentStable === true,
      value: eligibility.employmentYears ? `${eligibility.employmentYears}+ years` : null,
      testId: "passport-employment",
    },
    {
      icon: FileText,
      label: "Documents",
      verified: graph.documentsVerified > 0,
      value: `${graph.documentsUploaded} uploaded`,
      testId: "passport-documents",
    },
  ];

  const verifiedCount = verificationItems.filter(v => v.verified).length;

  if (compact) {
    return (
      <Card className="hover-elevate" data-testid="card-readiness-passport-compact">
        <CardContent className="p-4">
          <div className="flex items-center gap-4">
            <ReadinessRing score={graph.readiness.completionPercentage} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold text-sm">Home Readiness</p>
                <Badge variant="secondary" className={`text-[10px] no-default-hover-elevate no-default-active-elevate ${tier.color}`} data-testid="badge-readiness-tier">
                  {tier.label}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {verifiedCount} of {verificationItems.length} verified
              </p>
              {graph.financialVerification.decisionGrade && eligibility.estimatedMaxPurchase && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Estimated max: {formatCurrency(eligibility.estimatedMaxPurchase)}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2" data-testid="section-readiness-passport">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left"
        data-testid="button-toggle-passport"
      >
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Home Readiness Passport
        </h3>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </button>

      <Card data-testid="card-readiness-passport">
        <CardContent className="p-5">
          <div className="flex items-start gap-5">
            <ReadinessRing score={graph.readiness.completionPercentage} />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold">Home Readiness</p>
                <Badge variant="secondary" className={`text-[10px] no-default-hover-elevate no-default-active-elevate ${tier.color}`} data-testid="badge-readiness-tier">
                  {tier.label}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {verifiedCount} of {verificationItems.length} items verified
              </p>
              {eligibility.estimatedMaxPurchase && (
                <div className="flex items-center gap-1.5 text-xs">
                  <Target className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground">Max purchase:</span>
                  <span className="font-medium">{formatCurrency(eligibility.estimatedMaxPurchase)}</span>
                </div>
              )}
              {graph.financialVerification.decisionGrade && eligibility.estimatedDTI !== null && (
                <div className="flex items-center gap-1.5 text-xs">
                  <Percent className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground">Current DTI:</span>
                  <span className={`font-medium ${eligibility.estimatedDTI <= 43 ? "text-success-subtle-foreground" : "text-warning-subtle-foreground"}`}>
                    {eligibility.estimatedDTI}%
                  </span>
                </div>
              )}
            </div>
          </div>

          {expanded && (
            <div className="mt-5 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
              <div className="space-y-2.5">
                {verificationItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.testId} className="flex items-center justify-between gap-3 flex-wrap" data-testid={item.testId}>
                      <div className="flex items-center gap-2.5">
                        <div className={`flex h-6 w-6 items-center justify-center rounded-full ${item.verified ? "bg-success-subtle" : "bg-muted"}`}>
                          {item.verified ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-success-subtle-foreground" />
                          ) : (
                            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">{item.label}</span>
                      </div>
                      <span className={`text-xs font-medium ${item.verified ? "" : "text-muted-foreground"}`}>
                        {item.value || "Not yet provided"}
                      </span>
                    </div>
                  );
                })}
              </div>

              {graph.financialVerification.decisionGrade && eligibility.eligibleLoanTypes.length > 0 && (
                <div className="pt-2 border-t">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Eligible Programs</p>
                  <div className="flex flex-wrap gap-1.5">
                    {eligibility.eligibleLoanTypes.map((type) => (
                      <Badge key={type} variant="secondary" className="text-[10px] no-default-hover-elevate no-default-active-elevate" data-testid={`badge-program-${type}`}>
                        {type.toUpperCase()}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {graph.readiness.outstandingInputs.length > 0 && (
                <div className="pt-2 border-t">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Areas to Strengthen</p>
                  {graph.readiness.outstandingInputs.slice(0, 3).map((gap, i) => (
                    <div key={i} className="flex items-center gap-2 mt-1.5" data-testid={`text-passport-gap-${i}`}>
                      <AlertCircle className="h-3 w-3 text-warning-subtle-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground">{gap}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="pt-2 border-t flex gap-2">
                <Button asChild variant="outline" size="sm" className="touch-target flex-1 w-full gap-1.5" data-testid="button-passport-coach">
                  <Link href="/ai-coach">
                    <Bot className="h-3.5 w-3.5" />
                    Talk to Coach
                  </Link>
                </Button>
                <Button asChild size="sm" className="touch-target flex-1 w-full gap-1.5" data-testid="button-passport-apply">
                  <Link href="/apply">
                    Get Pre-Approved
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
