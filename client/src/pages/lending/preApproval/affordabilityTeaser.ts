// Maps the funnel's own answers (by the time the final gate has passed, the
// schema guarantees these are present) into the shared affordability-estimate
// math, so an unauthenticated borrower gets a payoff before the auth wall.
import { type PreApprovalFormData } from "@shared/schema";
import {
  AFFORDABILITY_ESTIMATE_DEFAULTS,
  type AffordabilityEstimateInputs,
} from "@/lib/affordabilityEstimate";
import { sumRentalMonthlyDebts } from "@/lib/preApprovalAnalysis";

// The funnel's creditScore step collects a bucket floor ("760", "720", ...)
// rather than an exact score, plus a "not_sure" option. The estimate math
// only needs a representative score per bucket to pick the right DTI/down-
// payment tier — 680 (the calculator's own default) stands in when unknown.
const CREDIT_SCORE_FALLBACK = 680;

function parseCreditScore(raw: string | undefined): number {
  if (!raw || raw === "not_sure") return CREDIT_SCORE_FALLBACK;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : CREDIT_SCORE_FALLBACK;
}

function parseAmount(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Null when the funnel hasn't collected enough to estimate yet (defensive —
 * the final gate's schema check should already guarantee this). */
export function buildTeaserInputs(values: PreApprovalFormData): AffordabilityEstimateInputs | null {
  const baseAnnualIncome = parseAmount(values.annualIncome);
  if (baseAnnualIncome <= 0) return null;

  // Same composition as the Live Analysis panel: annualIncome is already the
  // borrower's household total, while source rows explain that total and
  // rental debt service still belongs in monthly obligations.
  const annualIncome = baseAnnualIncome;

  const downPaymentSaved = parseAmount(values.downPayment);
  // Mirrors preApprovalMachine's vaZeroDown flag: a veteran purchase can
  // legitimately have $0 down. The estimate math caps max home price by
  // (down payment saved / min down payment %), so a literal 0 would floor
  // the teaser's range at $0 for exactly the borrowers the funnel is
  // steering toward a $0-down VA loan. Infinity removes that cap without
  // touching the shared math (downPaymentSaved has no other use in it).
  const vaZeroDownEligible = values.isVeteran === true && values.loanPurpose === "purchase";

  return {
    annualIncome,
    monthlyDebts: parseAmount(values.monthlyDebts) + sumRentalMonthlyDebts(values.incomeSources),
    downPaymentSaved: downPaymentSaved > 0 || !vaZeroDownEligible ? downPaymentSaved : Number.POSITIVE_INFINITY,
    creditScore: parseCreditScore(values.creditScore),
    ...AFFORDABILITY_ESTIMATE_DEFAULTS,
  };
}

export function parseTargetPrice(raw: string | undefined): number | null {
  const parsed = parseAmount(raw);
  return parsed > 0 ? parsed : null;
}
