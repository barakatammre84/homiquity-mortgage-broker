import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { TermTooltip } from "@/components/TermTooltip";
import {
  AlertCircle,
  Briefcase,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Percent,
  PiggyBank,
  Shield,
  Target,
} from "lucide-react";
import { type BorrowerGraphData } from "./model";

/** Collapsible financial-profile card (extracted from Dashboard.tsx): derived
 * signals from the borrower graph — credit tier, DTI, income, max purchase,
 * verified assets, eligible programs — plus "areas to strengthen". */
export function FinancialSnapshot({ graph, qualificationVerified }: { graph: BorrowerGraphData; qualificationVerified: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const { eligibility } = graph;

  const hasData = eligibility.creditScore || graph.bestAnnualIncome || eligibility.estimatedDTI;
  if (!hasData) return null;

  const creditColor = {
    "760_plus": "text-success-subtle-foreground",
    "720_759": "text-success-subtle-foreground",
    "680_719": "text-info",
    "640_679": "text-warning-subtle-foreground",
    "below_640": "text-destructive",
    "unknown": "text-muted-foreground",
  }[eligibility.creditTier] || "text-muted-foreground";

  const dtiColor = eligibility.estimatedDTI
    ? eligibility.estimatedDTI <= 36
      ? "text-success-subtle-foreground"
      : eligibility.estimatedDTI <= 43
      ? "text-warning-subtle-foreground"
      : "text-destructive"
    : "text-muted-foreground";

  const signals: Array<{ icon: React.ElementType; label: string; value: string; color: string; testId: string; termKey?: string }> = [];

  if (eligibility.creditScore) {
    signals.push({
      icon: Shield,
      label: qualificationVerified ? "Verified Credit Score" : "Credit Score Provided",
      value: `${eligibility.creditScore} (${eligibility.creditTier === "unknown" ? "Not provided" : eligibility.creditTier.replace(/_/g, "-")})`,
      color: creditColor,
      testId: "signal-credit",
    });
  }

  if (qualificationVerified && eligibility.estimatedDTI !== null) {
    signals.push({
      icon: Percent,
      label: "Debt-to-Income",
      value: `${eligibility.estimatedDTI}%`,
      color: dtiColor,
      testId: "signal-dti",
      termKey: "dti",
    });
  }

  if (graph.bestAnnualIncome) {
    signals.push({
      icon: Briefcase,
      label: qualificationVerified ? "Verified Annual Income" : "Income Provided",
      value: `$${Math.round(graph.bestAnnualIncome).toLocaleString()}`,
      color: "",
      testId: "signal-income",
    });
  }

  if (qualificationVerified && eligibility.estimatedMaxPurchase) {
    signals.push({
      icon: Target,
      label: "Est. Max Purchase",
      value: `$${eligibility.estimatedMaxPurchase.toLocaleString()}`,
      color: "",
      testId: "signal-max-purchase",
    });
  }

  if (graph.totalVerifiedAssets) {
    signals.push({
      icon: PiggyBank,
      label: "Verified Assets",
      value: `$${graph.totalVerifiedAssets.toLocaleString()}`,
      color: "",
      testId: "signal-assets",
    });
  }

  if (qualificationVerified && eligibility.eligibleLoanTypes.length > 0) {
    signals.push({
      icon: CheckCircle2,
      label: "Eligible Programs",
      value: eligibility.eligibleLoanTypes.map(t => t.toUpperCase()).join(", "),
      color: "text-success-subtle-foreground",
      testId: "signal-programs",
    });
  }

  if (signals.length === 0) return null;

  const previewSignals = signals.slice(0, 3);
  const extraSignals = signals.slice(3);

  return (
    <div className="space-y-2" data-testid="section-financial-snapshot">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="touch-target flex w-full items-center gap-2 text-left group"
        data-testid="button-toggle-snapshot"
      >
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          {qualificationVerified ? "Verified Financial Profile" : "Information Provided"}
        </h3>
        {extraSignals.length > 0 && (
          expanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )
        )}
      </button>
      <Card className="shadow-card" data-testid="card-financial-snapshot">
        <CardContent className="p-4">
          <div className="space-y-3">
            {previewSignals.map((signal) => (
              <div key={signal.testId} className="flex items-center justify-between gap-3 flex-wrap" data-testid={signal.testId}>
                <div className="flex items-center gap-2.5">
                  <signal.icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  {signal.termKey ? (
                    <TermTooltip term={signal.termKey} className="text-xs text-muted-foreground">
                      {signal.label}
                    </TermTooltip>
                  ) : (
                    <span className="text-xs text-muted-foreground">{signal.label}</span>
                  )}
                </div>
                <span className={`text-xs font-medium ${signal.color}`}>{signal.value}</span>
              </div>
            ))}
            {expanded && extraSignals.map((signal) => (
              <div key={signal.testId} className="flex items-center justify-between gap-3 flex-wrap animate-in fade-in slide-in-from-top-1 duration-200" data-testid={signal.testId}>
                <div className="flex items-center gap-2.5">
                  <signal.icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  {signal.termKey ? (
                    <TermTooltip term={signal.termKey} className="text-xs text-muted-foreground">
                      {signal.label}
                    </TermTooltip>
                  ) : (
                    <span className="text-xs text-muted-foreground">{signal.label}</span>
                  )}
                </div>
                <span className={`text-xs font-medium ${signal.color}`}>{signal.value}</span>
              </div>
            ))}
          </div>
          {!qualificationVerified && (
            <p className="mt-3 border-t pt-3 text-xs leading-relaxed text-muted-foreground" data-testid="text-qualification-pending">
              Your loan team is verifying these inputs. Qualification ratios and confirmed program results appear after that review.
            </p>
          )}
          {graph.readiness.outstandingInputs.length > 0 && expanded && (
            <div className="mt-3 pt-3 border-t space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Areas to Strengthen</p>
              {graph.readiness.outstandingInputs.slice(0, 3).map((gap, i) => (
                <div key={i} className="flex items-center gap-2" data-testid={`text-gap-${i}`}>
                  <AlertCircle className="h-3 w-3 text-warning-subtle-foreground shrink-0" />
                  <span className="text-xs text-muted-foreground">{gap}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
