// The live advisory side panel + dynamic step titles for the pre-approval
// funnel. Extracted verbatim from PreApproval.tsx.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { type PreApprovalFormData } from "@shared/schema";
import { CONFORMING_LOAN_LIMIT_2026 } from "@shared/lendingLimits";
import type { MortgageRateWithProgram } from "@/types/rates";
import { TrendingUp, Info } from "lucide-react";

import { type Question } from "./questions";
import { computePreApprovalAnalysis } from "@/lib/preApprovalAnalysis";

export interface AdvisoryPanelProps {
  formValues: PreApprovalFormData;
  currentStepId: string;
}

// The intro renders its own full-screen layout with no analysis column. Every
// question step shows the panel — it now occupies a constant grid column, so
// showing it from the first question keeps the content from jumping when
// numbers start arriving (it used to appear at step 3, shifting the whole
// question column left mid-flow).
export const ADVISORY_HIDDEN_STEPS: string[] = ["intro"];

export function AdvisoryPanel({ formValues, currentStepId }: AdvisoryPanelProps) {
  // Payment estimates use the live advertised 30-year fixed rate — a payment
  // figure shown to a borrower must be reproducible from current pricing,
  // never a hardcoded constant. Falls back to a labeled illustrative rate.
  const { data: advertisedRates } = useQuery<MortgageRateWithProgram[]>({
    queryKey: ["/api/mortgage-rates"],
  });
  const advertised30YrRate = useMemo(() => {
    const row = advertisedRates?.find(
      (r) => r.program?.termYears === 30 && !r.program?.isAdjustable && r.isActive !== false,
    );
    const parsed = row ? parseFloat(row.rate) : NaN;
    return !isNaN(parsed) && parsed > 0 ? parsed : null;
  }, [advertisedRates]);

  const stats = useMemo(
    () => computePreApprovalAnalysis(formValues, advertised30YrRate),
    [formValues, advertised30YrRate],
  );

  if (ADVISORY_HIDDEN_STEPS.includes(currentStepId)) {
    return null;
  }

  const isRefinance = formValues.loanPurpose === "refinance" || formValues.loanPurpose === "cash_out";

  const getContextualAdvice = () => {
    switch (currentStepId) {
      case "loanPurpose":
        return "Your goal determines which loan programs and rates apply — everything after this adapts to it.";
      case "propertyType":
        return "Property type affects your rate and reserve requirements.";
      case "purchasePrice":
        if (isRefinance) {
          return "Your home's value sets the loan-to-value we price against. We'll estimate your new payment from it.";
        }
        return "We use this to estimate your monthly payment and closing costs.";
      case "downPayment":
        if (isRefinance) {
          return "Equity works the same way here that a down payment does on a purchase: more of it generally means a better rate, and 20%+ avoids mortgage insurance.";
        }
        if (formValues.isVeteran && formValues.loanPurpose === "purchase") {
          return (
            <span className="text-success-subtle-foreground font-medium">
              VA benefit detected: VA loans allow $0 down with no PMI. We'll price both VA and conventional options so you can compare.
            </span>
          );
        }
        // The conforming limit has exactly one home (shared/lendingLimits.ts).
        // This line held a hardcoded 766550 — the 2024 limit — so every borrower
        // between $766,500 and $806,500 was told a CONFORMING loan was jumbo, and
        // warned about credit and down payment on a product they were not taking.
        if (stats.loanAmount > CONFORMING_LOAN_LIMIT_2026) {
          return (
            <span className="text-warning-subtle-foreground font-medium">
              Note: This loan amount enters 'Jumbo' territory, which may require a higher credit score and larger down payment.
            </span>
          );
        }
        if (stats.downPaymentPercent >= 20) {
          return (
            <span className="text-success-subtle-foreground">
              Great! Putting 20%+ down avoids PMI (Private Mortgage Insurance), saving you money each month.
            </span>
          );
        }
        return "Tip: A 20% down payment avoids Private Mortgage Insurance (PMI).";
      case "propertyState":
        return "Location affects property taxes and available loan programs.";
      case "householdFamilySize":
        return "VA underwriting checks residual income — what's left after bills — and the required cushion grows with your household size.";
      case "homeSquareFootage":
        return "The VA estimates monthly utilities at $0.14 per square foot when verifying your loan leaves enough residual income.";
      case "annualIncome":
        if (formValues.employmentType === "self_employed") {
          return "Use your best rough yearly total here. On the next steps, each business, 1099, and rental source is captured separately and verified against tax documents.";
        }
        return "We use gross income to calculate your debt-to-income ratio. We'll verify with W-2s or tax returns later.";
      case "employmentType":
        if (formValues.employmentType === "self_employed") {
          return (
            <span className="text-success-subtle-foreground">
              Self-employed income confuses most automated lenders — not us. We handle 1099 and business income all the time, and we'll build you a custom document checklist so nothing stalls your approval.
            </span>
          );
        }
        return "Employment type helps us determine which documents we'll need to verify your income.";
      case "employmentYears":
        return "Most lenders prefer 2+ years of stable employment history.";
      case "hasAdditionalIncome":
        return "Including all income sources gives a more complete picture for underwriting.";
      case "incomeSources":
        if (formValues.employmentType === "self_employed") {
          return "Add a Self-Employment / 1099 entry with your annual figure — that one is required. Anything else you receive is optional, and every source you add can raise your buying power.";
        }
        return "Each income source may require different documentation. We'll let you know what's needed.";
      case "monthlyDebts":
        return "Include car payments, student loans, credit cards, and other monthly obligations.";
      case "creditScore":
        return "A score above 740 typically qualifies for the best interest rates. Not sure? Most Americans score between 670-739. Check yours free at annualcreditreport.com.";
      case "veteranAndFirstTime":
        return "Veterans may qualify for VA loans with no down payment. First-time buyers may access special programs.";
      case "final":
        return "Review complete! Click submit to see your personalized loan options.";
      default:
        return "Keep going! We're building your financial profile.";
    }
  };

  const getDtiStatus = () => {
    if (stats.dti <= 0) return { color: "bg-muted", text: "Enter your info to see DTI" };
    if (stats.dti < 36) return { color: "bg-success", text: "Looking great! Lenders love a DTI under 36%." };
    if (stats.dti < 43) return { color: "bg-warning", text: "You're in the approval zone, but consider the budget." };
    if (stats.dti < 50) return { color: "bg-warning", text: "This is getting tight. You may need to reduce the loan amount." };
    return { color: "bg-destructive", text: "This loan amount might be a stretch for standard approval." };
  };

  const dtiStatus = getDtiStatus();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      // Renders at EVERY width. It used to be `hidden lg:block`, which meant the
      // borrower most likely to abandon — the one on a phone — got no DTI, no
      // payment estimate and none of the why-we-ask advice, while the desktop
      // user got all three (DESIGN_SYSTEM.md §12.3: reassurance is not a desktop
      // luxury). The parent is `flex flex-col` below lg and a two-column grid at
      // lg, so this same element falls below the question and its CTA on a phone
      // and becomes the right-hand column on a desktop — no second instance, no
      // duplicated test ids. Its blocks are individually conditional, so early
      // steps stay short and it grows as the borrower answers.
      className="w-full lg:w-80 mt-8 lg:mt-0 bg-card rounded-2xl shadow-card-lg border p-5 sm:p-6 transition-all duration-500"
      data-testid="advisory-panel"
    >
      <div className="flex items-center gap-2 mb-4 border-b pb-3">
        <div className="bg-primary/10 p-1.5 rounded-lg">
          <TrendingUp className="w-4 h-4 text-primary" />
        </div>
        <span className="font-bold text-foreground text-sm uppercase tracking-wider">Live Analysis</span>
      </div>

      <div className="space-y-5">
        {stats.qualifyingAnnualIncome > 0 && (
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Qualifying income</span>
            <span className="font-medium text-foreground" data-testid="text-qualifying-income">
              ${stats.qualifyingAnnualIncome.toLocaleString(undefined, { maximumFractionDigits: 0 })}/yr
            </span>
          </div>
        )}

        {(stats.dti > 0 || stats.estMortgage > 0) && (
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-muted-foreground">Debt-to-Income Ratio</span>
              <span className={`font-bold ${stats.dti > 43 ? "text-destructive" : stats.dti > 36 ? "text-warning-subtle-foreground" : "text-success-subtle-foreground"}`} data-testid="text-dti-value">
                {stats.dti > 0 ? `${stats.dti.toFixed(0)}%` : "—"}
              </span>
            </div>
            <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
              <motion.div
                className={`h-full transition-colors duration-500 ${dtiStatus.color}`}
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(Math.max(stats.dti, 0), 100)}%` }}
                transition={{ duration: 0.5 }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5">
              {dtiStatus.text}
            </p>
            {!stats.includesMonthlyDebts && stats.dti > 0 && (
              <p className="text-[11px] text-muted-foreground mt-1" data-testid="text-dti-scope-note">
                Doesn't include your monthly debts yet — we ask about those in a later step.
              </p>
            )}
          </div>
        )}

        <div className="bg-muted/50 rounded-xl p-4">
          <div className="flex gap-3">
            <Info className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
            <p className="text-sm text-muted-foreground leading-relaxed">
              {getContextualAdvice()}
            </p>
          </div>
        </div>

        {stats.estMortgage > 0 && (
          <div className="text-center pt-2 border-t">
            <div className="text-xs text-muted-foreground uppercase mb-1">Est. Monthly Payment</div>
            <div className="text-2xl font-bold text-foreground" data-testid="text-est-payment">
              ${stats.estMortgage.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              <span className="text-sm text-muted-foreground font-normal">/mo</span>
            </div>
            <p className="text-[10px] text-muted-foreground mt-1" data-testid="text-payment-disclaimer">
              Estimate only — based on {advertised30YrRate ? "today's advertised" : "an illustrative"} {stats.estRatePct}% rate,
              30-year fixed, plus estimated taxes{stats.pmiMonthly > 0 ? ", insurance, and PMI" : " and insurance"}.
              {stats.vaNoPmi && stats.ltv > 80 ? " No PMI included — VA loans don't require it." : ""}
              {" "}Not an offer of credit; your rate will differ.
            </p>
          </div>
        )}

        {stats.ltv > 0 && stats.ltv < 100 && (
          <div className="flex justify-between text-xs border-t pt-3">
            <span className="text-muted-foreground">Loan-to-Value (LTV)</span>
            <span className={`font-medium ${stats.ltv <= 80 ? "text-success-subtle-foreground" : "text-warning-subtle-foreground"}`}>
              {stats.ltv.toFixed(0)}%
            </span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

/**
 * Per-step copy resolved against the borrower's own answers.
 *
 * Three fields move together, so they resolve together: a step whose TITLE
 * adapts to a refinance but whose subtext and "why we ask" still describe a
 * purchase is worse than one that never adapted at all. `questions.ts` holds
 * the default for each; anything returned here overrides it.
 *
 * The refinance branches matter most. `purchasePrice` and `downPayment` are
 * purchase words for fields the machine uses as (value, value − loan) — so a
 * refinancer was being asked "What is the estimated purchase price?" and "How
 * much are you planning to put down?" about a home they already own. The FIELD
 * SEMANTICS are unchanged here (loan amount is still price − down); only the
 * words are, which is why equity — not the loan balance — is what the reworded
 * down-payment step asks for. Asking for the balance and storing it in
 * `downPayment` would invert the math.
 */
export interface StepCopy {
  title: string;
  subtext?: string;
  why?: string;
}

export function resolveStepCopy(currentQ: Question, formValues: PreApprovalFormData): StepCopy {
  const { purchasePrice, loanPurpose, employmentType } = formValues;
  const isRefi = loanPurpose === "refinance" || loanPurpose === "cash_out";
  const fallback: StepCopy = {
    title: currentQ.question || "",
    subtext: currentQ.subtext,
    why: currentQ.why,
  };

  switch (currentQ.id) {
    case "purchasePrice":
      if (isRefi) {
        return {
          title: "What's your home worth today?",
          subtext: "Your best estimate of its current market value — an appraisal will confirm it later.",
          why: "Value and what you owe set your loan-to-value, which drives the rates you'll see.",
        };
      }
      break;

    case "downPayment":
      if (loanPurpose === "cash_out") {
        return {
          title: "After taking cash out, how much equity would you keep?",
          subtext: "Your home's value minus the new loan amount. An estimate is fine.",
          why: "Cash-out pricing is set by how much equity stays in the home after closing.",
        };
      }
      if (loanPurpose === "refinance") {
        return {
          title: "How much equity do you have in it?",
          subtext: "Your home's value minus what you still owe.",
          why: "Equity does the same job on a refinance that a down payment does on a purchase — it sets your loan-to-value.",
        };
      }
      if (purchasePrice) {
        return { ...fallback, title: `On a $${purchasePrice} home, how much can you put down?` };
      }
      break;

    case "propertyState":
      if (isRefi) {
        return { ...fallback, title: "Which state is the property in?" };
      }
      break;

    case "creditScore":
      if (loanPurpose === "cash_out") {
        return { ...fallback, title: "Since you're pulling cash out, credit score is key. What's yours?" };
      }
      break;

    case "annualIncome":
      if (employmentType === "self_employed") {
        return {
          ...fallback,
          title: "About how much does your household earn in a year?",
          subtext: "A rough total is fine — next we'll separate each business, 1099, rental, and other source.",
        };
      }
      return { ...fallback, title: "What's your total household income?" };

    case "employmentYears":
      if (employmentType === "self_employed") {
        return { ...fallback, title: "How many years have you been self-employed?" };
      }
      if (employmentType === "retired") {
        return { ...fallback, title: "How many years have you been retired?" };
      }
      break;

    case "incomeSources":
      // The step is MANDATORY for a self-employed borrower — the machine skips
      // the "any additional income?" question for them precisely because the
      // answer could not change the route. Which means the default heading,
      // "What other income do you receive?", would be the first thing they see
      // after saying nothing of the sort. Ask for what is actually needed.
      if (employmentType === "self_employed") {
        return {
          title: "Let's detail your self-employment income",
          subtext:
            "Underwriting reviews 1099 and business income line by line, so it needs its own entry. Add any other sources you receive while you're here.",
          why: "Self-employed income is averaged from your returns — detailing it up front is what keeps your approval from stalling later.",
        };
      }
      break;

    case "monthlyDebts":
      return { ...fallback, title: "What are your current monthly debt payments?" };
  }

  return fallback;
}

/** Title-only convenience over {@link resolveStepCopy}. */
export function getDynamicTitle(currentQ: Question, formValues: PreApprovalFormData): string {
  return resolveStepCopy(currentQ, formValues).title;
}
