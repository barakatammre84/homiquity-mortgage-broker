/**
 * Deterministic Underwriting Engine
 * 
 * Hard-coded rule-based system for mortgage eligibility decisions
 * Does NOT use probabilistic AI to avoid Fair Lending risks
 * AI is used for data extraction only; this engine performs qualification
 */

import type { 
  LoanApplication,
  EmploymentHistory,
  OtherIncomeSource,
  UrlaAsset,
  UrlaLiability,
  UrlaPropertyInfo,
} from "@shared/schema";
import { lookupResolver } from "./services/lookupResolver";
import { computeAgencyWageIncome } from "./services/income/paths/agencyWage";
import { computeSelfEmploymentPath } from "./services/income/paths/selfEmployment";
import { monthlyPrincipalAndInterestFromFraction } from "@shared/lib/amortization";
import { liabilityKind, type LiabilityKind } from "@shared/liabilityTypes";
import { assessPaidByOtherParty } from "@shared/liabilityExclusions";
import {
  DEFERRED_STUDENT_LOAN_FACTOR,
  REVOLVING_MINIMUM_PAYMENT_FLOOR,
  REVOLVING_PAYMENT_FACTOR,
} from "./services/underwritingNuance";

export interface IncomeQualificationResult {
  baseMonthlyIncome: number;
  variableMonthlyIncome: number;
  selfEmploymentMonthlyIncome: number;
  totalQualifyingIncome: number;
  details: {
    employment: {
      type: string;
      yearsEmployed: number;
      monthlyBase?: number;
      twoYearAverage?: number;
      trend?: "stable" | "declining" | "disqualified";
    }[];
    other: {
      type: string;
      monthlyAmount: number;
      yearsReceived?: number;
    }[];
    selfEmployment?: {
      netProfitYear1: number;
      netProfitYear2: number;
      avgNetProfit: number;
      addBacks: number;
      deductions: number;
      qualifyingIncome: number;
      trend?: string;
      requiresManualReview?: boolean;
      notes?: string[];
    };
  };
}

export interface AssetVerificationResult {
  totalAssets: number;
  liquidAssets: number;
  retirementAssets: number;
  reservesMonths: number;
  breakdown: {
    type: string;
    balance: number;
    haircut: number;
    verifiedValue: number;
  }[];
}

export interface LiabilityAssessmentResult {
  totalMonthlyPayment: number;
  excludedDebts: number;
  /** Balance that must be covered by assets in addition to closing funds/reserves. */
  openThirtyDayBalance: number;
  breakdown: {
    type: string;
    payment: number;
    remainingMonths?: number;
    included: boolean;
    reason: string;
  }[];
}

export interface DTICalculationResult {
  qualifyingIncome: number;
  housingExpense: number;
  nonHousingDebts: number;
  frontEndRatio: number;
  backEndRatio: number;
  status: "pass" | "fail" | "stretch";
  maxBackEndRatio: number;
  details: {
    frontend_definition: string;
    backend_definition: string;
    fannie_mae_limit_manual: number;
    fannie_mae_limit_aus: number;
  };
}

export interface PropertyEligibilityResult {
  maxLoanAmount: number;
  maxDownPaymentPercent: number;
  requiredDownPayment: number;
  ltvRatio: number;
  estimatedPITI: number;
  finalDTI: number;
  canBuyProperty: boolean;
  reasons: string[];
}

// ============================================================================
// INCOME QUALIFICATION ENGINE
// ============================================================================

/**
 * @deprecated Adapter over the multi-path income orchestrator
 * (server/services/income/orchestrator.ts) — the single income producer as of
 * UAL P3. The wage math (agency-wage path) and self-employment math (Form 1084
 * path) are the SAME functions the instant-decision engine uses, so this
 * display endpoint can never disagree with a decision on the qualifying total.
 * Fast-follow: move the one remaining caller
 * (POST /api/loan-applications/:id/calculate-income) onto the orchestrator
 * directly and delete this shim.
 */
export function qualifyIncome(
  employment: EmploymentHistory[],
  otherIncome: OtherIncomeSource[],
  applicationIncome?: { annualIncome?: number | string; employmentYears?: number }
): IncomeQualificationResult {
  const agency = computeAgencyWageIncome({
    employment,
    otherIncome,
    fallbackAnnualIncome: applicationIncome?.annualIncome,
  });
  const se = computeSelfEmploymentPath(employment);

  const result: IncomeQualificationResult = {
    baseMonthlyIncome: agency.baseMonthlyIncome,
    variableMonthlyIncome: agency.variableMonthlyIncome,
    selfEmploymentMonthlyIncome: se.path.monthlyQualifyingIncome,
    totalQualifyingIncome:
      agency.baseMonthlyIncome + agency.variableMonthlyIncome + se.path.monthlyQualifyingIncome,
    details: { employment: [], other: [] },
  };

  // Display detail: per non-SE job and per other-income source (the decision
  // path doesn't need these, so they stay here rather than in the orchestrator).
  for (const emp of employment) {
    if (emp.isSelfEmployed) continue;
    const monthsEmployed = emp.startDate
      ? (Date.now() - new Date(emp.startDate).getTime()) / (1000 * 60 * 60 * 24 * 30.44)
      : 0;
    const monthlyBase =
      emp.totalMonthlyIncome != null
        ? toNumberLike(emp.totalMonthlyIncome)
        : toNumberLike(emp.baseIncome);
    result.details.employment.push({
      type: emp.employmentType || "salaried",
      yearsEmployed: Math.floor(monthsEmployed / 12),
      monthlyBase,
    });
  }
  for (const income of otherIncome) {
    if (!income.monthlyAmount) continue;
    result.details.other.push({
      type: income.incomeSource || "other",
      monthlyAmount: toNumberLike(income.monthlyAmount),
    });
  }

  if (se.perJob.length > 0) {
    const agg = se.perJob.reduce(
      (a, s) => ({
        netProfitYear1: a.netProfitYear1 + s.netProfitYear1,
        netProfitYear2: a.netProfitYear2 + s.netProfitYear2,
        avgNetProfit: a.avgNetProfit + s.avgAnnualCashFlow,
        addBacks: a.addBacks + s.addBacks,
        deductions: a.deductions + s.deductions,
        qualifyingIncome: a.qualifyingIncome + s.monthlyQualifyingIncome,
        notes: [...a.notes, ...s.notes],
      }),
      { netProfitYear1: 0, netProfitYear2: 0, avgNetProfit: 0, addBacks: 0, deductions: 0, qualifyingIncome: 0, notes: [] as string[] },
    );
    result.details.selfEmployment = {
      ...agg,
      trend: se.perJob[se.perJob.length - 1].trend,
      requiresManualReview: se.path.requiresManualReview,
      notes: se.path.notes,
    };
  }

  return result;
}

function toNumberLike(v: number | string | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ============================================================================
// ASSET VERIFICATION ENGINE
// ============================================================================

export async function verifyAssets(
  assets: UrlaAsset[],
  downPaymentAndClosing?: number
): Promise<AssetVerificationResult> {
  const result: AssetVerificationResult = {
    totalAssets: 0,
    liquidAssets: 0,
    retirementAssets: 0,
    reservesMonths: 0,
    breakdown: [],
  };

  // Asset valuation haircuts are resolved from the dynamic policy matrices —
  // there are no hardcoded haircut constants. Cash-equivalents count at full
  // value (the definition of liquid reserves); market and retirement assets are
  // discounted per the seeded HAIRCUT_* scalars.
  const haircutStock = (await lookupResolver.getPolicyScalar("HAIRCUT_STOCK_INVESTMENT")) / 100;
  const haircutRetirement = (await lookupResolver.getPolicyScalar("HAIRCUT_RETIREMENT")) / 100;

  const CASH_EQUIVALENTS = new Set([
    "checking",
    "checking_account",
    "savings",
    "savings_account",
    "money_market",
    "money_market_account",
    "cd",
    "certificate_of_deposit",
  ]);

  const isRetirementType = (t: string) =>
    t.includes("retirement") || t.includes("401k") || t.includes("ira");

  for (const asset of assets) {
    if (!asset.cashOrMarketValue) continue;

    const balance = typeof asset.cashOrMarketValue === 'string' 
      ? parseFloat(asset.cashOrMarketValue) 
      : asset.cashOrMarketValue;

    const assetType = asset.accountType?.toLowerCase() || "other";
    // Map the account type onto one of the three engine valuation categories.
    let haircut: number;
    if (CASH_EQUIVALENTS.has(assetType)) {
      haircut = 1.0;
    } else if (isRetirementType(assetType)) {
      haircut = haircutRetirement;
    } else {
      // Stocks, bonds, mutual funds, and any other non-cash holding take the
      // conservative market-asset haircut.
      haircut = haircutStock;
    }
    const verifiedValue = balance * haircut;

    result.breakdown.push({
      type: assetType,
      balance,
      haircut,
      verifiedValue,
    });

    result.totalAssets += balance;

    if (haircut === 1.0) {
      result.liquidAssets += verifiedValue;
    } else if (isRetirementType(assetType)) {
      result.retirementAssets += verifiedValue;
      // Vested retirement funds are liquid/near-liquid reserves after the
      // policy haircut. Keep retirementAssets as the informational subset,
      // while liquidAssets remains the total usable figure shared with the
      // deterministic underwriting engine.
      result.liquidAssets += verifiedValue;
    } else {
      result.liquidAssets += verifiedValue;
    }
  }

  // Calculate reserves after down payment and closing
  if (downPaymentAndClosing) {
    result.liquidAssets = Math.max(0, result.liquidAssets - downPaymentAndClosing);
  }

  return result;
}

// ============================================================================
// LIABILITY ASSESSMENT ENGINE
// ============================================================================

/**
 * Fannie Mae Selling Guide B3-6-05, Monthly Debt Obligations (08/05/2026).
 *
 * Revolving Charge/Lines of Credit: where the credit report shows no required
 * minimum payment and nothing documents a lower one, the qualifying payment is
 * 5% of the outstanding balance; for DU casefiles it is the greater of $10 or
 * 5%. We apply the DU form because every conventional file here is routed to DU.
 * Student Loans: deferred loans or loans in forbearance qualify at 1% of balance.
 *
 * These three were DECLARED here as well as in underwritingNuance.ts — one
 * regulated rule with two sources, which is the drift the VA-residual duplication
 * already cost this repo once. They now come from that module and are re-exported
 * so the public surface is unchanged. underwritingNuance.ts is the definition side
 * because tests/complianceInvariants.test.ts reads ITS source for the 1% literal
 * and the regulatory ledger's codeRef names it.
 */
export { DEFERRED_STUDENT_LOAN_FACTOR, REVOLVING_MINIMUM_PAYMENT_FLOOR, REVOLVING_PAYMENT_FACTOR };

/**
 * `urla_liabilities.liability_type` is a free varchar written from the URLA
 * picker's LABELS ("Revolving (Credit Card)"), while older rows and importers
 * carry snake_case spellings ("credit_card"). The classifier that reads both
 * is `liabilityKind` in shared/liabilityTypes.ts — shared with the picker, the
 * pre-underwriting flags and the MISMO export — because a local normaliser
 * here once mapped only the snake_case half and the B3-6-05 revolving branch
 * below was unreachable for every row the form actually writes.
 *
 * B3-6-05 treats revolving charge accounts and unsecured lines of credit as
 * long-term debt: "credit cards, department store charge cards, and personal
 * lines of credit". HELOCs are deliberately not revolving here — the same
 * topic routes equity lines secured by real estate into the housing expense.
 */
function isRevolvingType(kind: LiabilityKind): boolean {
  return kind === "revolving";
}

function toAmount(value: string | number | null | undefined): number {
  const n = typeof value === "string" ? parseFloat(value) : value ?? 0;
  return Number.isFinite(n) ? (n as number) : 0;
}


export function assessLiabilities(
  liabilities: UrlaLiability[],
  options: { allowReviewedTreatments?: boolean } = {},
): LiabilityAssessmentResult {
  const result: LiabilityAssessmentResult = {
    totalMonthlyPayment: 0,
    excludedDebts: 0,
    openThirtyDayBalance: 0,
    breakdown: [],
  };

  for (const liability of liabilities) {
    const reportedPayment = toAmount(liability.monthlyPayment);
    const balance = toAmount(liability.unpaidBalance);
    const type = liabilityKind(liability.liabilityType);

    // B3-6-05 / B3-6-07: an open 30-day charge account is not part of DTI,
    // but the full balance must be covered by verified funds in addition to
    // cash to close and reserves. Keep the balance explicit for the asset gate.
    if (type === "open_30_day") {
      result.openThirtyDayBalance += balance;
      result.excludedDebts += reportedPayment;
      result.breakdown.push({
        type,
        payment: 0,
        included: false,
        reason: `Excluded from DTI; $${balance.toFixed(2)} balance must be covered by verified funds (B3-6-05 / B3-6-07)`,
      });
      continue;
    }

    // B3-6-07, Debts Paid Off At or Prior to Closing: a revolving balance paid
    // off at/prior to closing needs no payment in the DTI, and an installment
    // loan paid down to 10 or fewer remaining payments drops out of long-term
    // debt. This is checked FIRST and for every type — it previously sat inside
    // an `installment` branch that the liability vocabulary can never produce,
    // so no debt was ever actually excluded.
    if (liability.toBePaidOff) {
      result.excludedDebts += reportedPayment;
      result.breakdown.push({
        type,
        payment: reportedPayment,
        included: false,
        reason: "Paid off at or prior to closing (B3-6-07)",
      });
      continue;
    }

    // B3-6-05, Monthly Debt Obligations — Debts Paid by Others: a payment
    // another party actually makes leaves the recurring obligations once the
    // borrower's answers satisfy the rule (non-mortgage: payer not an
    // interested party; mortgage-class: payer obligated, no rental income
    // from the property). shared/liabilityExclusions.ts is the one predicate
    // every DTI path reads. The Guide's 12-month cancelled-check history is
    // raised as an auto-generated condition, not re-derived here.
    const paidByOther = assessPaidByOtherParty(liability);
    if (paidByOther.status === "excludable") {
      result.excludedDebts += reportedPayment;
      result.breakdown.push({
        type,
        payment: reportedPayment,
        included: false,
        reason: paidByOther.mortgageClass
          ? "Housing expense paid by an obligated third party — excluded on a documented 12-month payment history (B3-6-05, Debts Paid by Others)"
          : "Paid by a third party — excluded on a documented 12-month payment history (B3-6-05, Debts Paid by Others)",
      });
      continue;
    }

    if (
      options.allowReviewedTreatments
      && type === "installment"
      && liability.underwritingTreatment === "exclude_short_term_installment"
      && liability.remainingTermMonths !== null
      && liability.remainingTermMonths !== undefined
      && liability.remainingTermMonths >= 1
      && liability.remainingTermMonths <= 10
    ) {
      result.excludedDebts += reportedPayment;
      result.breakdown.push({
        type,
        payment: 0,
        remainingMonths: liability.remainingTermMonths,
        included: false,
        reason: `Excluded after evidence-linked review of ${liability.remainingTermMonths} remaining payments and ability-to-pay impact (B3-6-05)`,
      });
      continue;
    }

    if (
      options.allowReviewedTreatments
      && type === "student_loan"
      && reportedPayment === 0
      && liability.studentLoanRepaymentPlan === "income_driven"
      && liability.underwritingTreatment === "documented_zero_student_loan"
    ) {
      result.breakdown.push({
        type,
        payment: 0,
        included: false,
        reason: "Documented $0 income-driven repayment plan used for qualifying (B3-6-05)",
      });
      continue;
    }

    // B3-6-05, Monthly Debt Obligations — Student Loans: where the credit
    // report carries no payment (or $0), a deferred/forbearance loan qualifies
    // at 1% of the outstanding balance.
    //
    // The evidence-linked reviewed path above can use a documented $0
    // income-driven payment. Every unreviewed or unsupported $0 stays on the
    // conservative 1% branch.
    if (type === "student_loan" && reportedPayment === 0 && balance > 0) {
      const imputed = balance * DEFERRED_STUDENT_LOAN_FACTOR;
      result.totalMonthlyPayment += imputed;
      result.breakdown.push({
        type: `${type} (deferred)`,
        payment: imputed,
        included: true,
        reason: "1% of balance imputed — deferred student loan (B3-6-05)",
      });
      continue;
    }

    // B3-6-05, Monthly Debt Obligations — Revolving Charge/Lines of Credit:
    // "If the credit report does not show a required minimum payment amount and
    // there is no supplemental documentation to support a payment of less than
    // 5%, the lender must use 5% of the outstanding balance as the borrower's
    // recurring monthly debt obligation." For DU casefiles the floor is the
    // GREATER of $10 or 5% of the balance.
    //
    // Without this, a revolving line reported with no minimum payment
    // contributed $0 to the DTI — understating the ratio and approving files DU
    // would decline. That is the one direction the compliance rail forbids.
    if (isRevolvingType(type) && reportedPayment === 0 && balance > 0) {
      const imputed = Math.max(
        REVOLVING_MINIMUM_PAYMENT_FLOOR,
        balance * REVOLVING_PAYMENT_FACTOR,
      );
      result.totalMonthlyPayment += imputed;
      result.breakdown.push({
        type: `${type} (no minimum payment reported)`,
        payment: imputed,
        included: true,
        reason: "Greater of $10 or 5% of balance imputed — revolving (B3-6-05)",
      });
      continue;
    }

    // B3-6-05 — Lease Payments remain included regardless of term. Installment
    // debts with ten or fewer payments also remain included unless a reviewer
    // explicitly applies the evidence-linked exception above.
    result.totalMonthlyPayment += reportedPayment;
    result.breakdown.push({
      type,
      payment: reportedPayment,
      ...(liability.remainingTermMonths === null || liability.remainingTermMonths === undefined
        ? {}
        : { remainingMonths: liability.remainingTermMonths }),
      included: true,
      reason: "Included in recurring monthly debt obligations (B3-6-05)",
    });
  }

  return result;
}

// ============================================================================
// DTI CALCULATION ENGINE
// ============================================================================

export async function calculateDTI(
  qualifyingIncome: number,
  housingExpense: number,
  nonHousingDebts: number,
  maxBackEndRatio?: number
): Promise<DTICalculationResult> {
  // DTI thresholds are policy-driven, resolved from the dynamic matrices rather
  // than hardcoded 43/50 constants.
  const dtiCap = await lookupResolver.getPolicyScalar("CONVENTIONAL_DTI_CAP");
  const stretchDti = await lookupResolver.getPolicyScalar("CONVENTIONAL_STRETCH_DTI");
  const effectiveCap = maxBackEndRatio ?? dtiCap;

  const frontEndRatio = qualifyingIncome > 0
    ? (housingExpense / qualifyingIncome) * 100
    : 0;

  const backEndRatio = qualifyingIncome > 0
    ? ((housingExpense + nonHousingDebts) / qualifyingIncome) * 100
    : 0;

  // A borrower with zero or negative qualifying income cannot support any debt;
  // the ratio is undefined (division by zero would otherwise read as 0% → pass).
  // Fail explicitly rather than letting the default "pass" stand.
  let status: "pass" | "fail" | "stretch" = "pass";
  if (qualifyingIncome <= 0) {
    status = "fail";
  } else if (backEndRatio > effectiveCap) {
    status = backEndRatio <= stretchDti ? "stretch" : "fail";
  }

  return {
    qualifyingIncome,
    housingExpense,
    nonHousingDebts,
    frontEndRatio: Math.round(frontEndRatio * 100) / 100,
    backEndRatio: Math.round(backEndRatio * 100) / 100,
    status,
    maxBackEndRatio: effectiveCap,
    details: {
      frontend_definition: "Housing expense / Qualifying income",
      backend_definition: "(Housing + Non-housing debts) / Qualifying income",
      fannie_mae_limit_manual: dtiCap,
      fannie_mae_limit_aus: stretchDti,
    },
  };
}

// ============================================================================
// PROPERTY ELIGIBILITY ENGINE - "CAN I BUY THIS HOUSE?"
// ============================================================================

export async function checkPropertyEligibility(
  borrowerAssets: number,
  borrowerIncome: number,
  borrowerDebts: number,
  propertyPrice: number,
  propertyType: string = "single_family",
  propertyTaxAnnual?: number,
  hoaMonthly?: number,
  homeInsuranceEstimate: number = 150,
  maxLtvPercent?: number,
  representativeFico?: number
): Promise<PropertyEligibilityResult> {
  const reasons: string[] = [];

  // Guard non-positive income up front: the final DTI divides by income, so a 0
  // (or NaN) would produce an "Infinity%" DTI in the returned reason text. Fail
  // closed with a clear message instead.
  if (!(borrowerIncome > 0)) {
    return {
      maxLoanAmount: 0,
      maxDownPaymentPercent: 0,
      requiredDownPayment: 0,
      ltvRatio: 0,
      estimatedPITI: 0,
      finalDTI: 0,
      canBuyProperty: false,
      reasons: ["Borrower income must be greater than zero to assess affordability."],
    };
  }

  // Policy ceilings come from the dynamic matrices, not hardcoded 95/50 limits.
  const ltvCap = await lookupResolver.getPolicyScalar("CONVENTIONAL_LTV_CAP");
  const stretchDti = await lookupResolver.getPolicyScalar("CONVENTIONAL_STRETCH_DTI");
  const effectiveMaxLtv = maxLtvPercent ?? ltvCap;

  // 1. Calculate LTV and down payment requirement
  const maxLoanAmount = propertyPrice * (effectiveMaxLtv / 100);
  const requiredDownPayment = propertyPrice - maxLoanAmount;
  const ltvRatio = (maxLoanAmount / propertyPrice) * 100;

  // 2. Check asset sufficiency
  if (borrowerAssets < requiredDownPayment) {
    reasons.push(`Insufficient assets: need $${requiredDownPayment.toFixed(2)}, have $${borrowerAssets.toFixed(2)}`);
  }

  // 3. Estimate PITI
  const principalAndInterestRate = 0.06; // 6% base rate assumption (FRACTION)
  const monthlyPI = monthlyPrincipalAndInterestFromFraction(
    maxLoanAmount,
    principalAndInterestRate,
    360,
  );

  const taxMonthly = (propertyTaxAnnual || propertyPrice * 0.0125) / 12;
  const hoaFees = hoaMonthly || 0;
  // PMI applies structurally above the 80% conventional MI trigger, where the
  // seeded CONVENTIONAL_PMI card (FICO x LTV) provides a premium. When MI is
  // required the rate MUST resolve from the matrix and fails loudly if the
  // FICO/LTV band is missing — no silent fallback. Below the trigger there is
  // structurally no MI.
  let pmi = 0;
  if (ltvRatio > 80) {
    if (representativeFico === undefined) {
      throw new Error(
        "CRITICAL DECISIONING ERROR: representative FICO is required to resolve mortgage insurance for LTV above 80%.",
      );
    }
    const ltvForLookup = Math.ceil(ltvRatio * 100) / 100;
    const pmiAnnualRate = await lookupResolver.resolveMatrixValue({
      matrixCode: "CONVENTIONAL_PMI",
      dim1Value: representativeFico,
      dim2Value: ltvForLookup,
    });
    pmi = (maxLoanAmount * (pmiAnnualRate / 100)) / 12;
  }

  const estimatedPITI = monthlyPI + taxMonthly + homeInsuranceEstimate + hoaFees + pmi;

  // 4. Final DTI check with new property
  const newTotalHousingExpense = estimatedPITI;
  const finalDTI = (newTotalHousingExpense + borrowerDebts) / borrowerIncome * 100;

  if (finalDTI > stretchDti) {
    reasons.push(`DTI too high with this property: ${finalDTI.toFixed(1)}% (limit ${stretchDti}%)`);
  }

  const canBuyProperty = reasons.length === 0;

  return {
    maxLoanAmount: Math.round(maxLoanAmount * 100) / 100,
    maxDownPaymentPercent: effectiveMaxLtv,
    requiredDownPayment: Math.round(requiredDownPayment * 100) / 100,
    ltvRatio: Math.round(ltvRatio * 100) / 100,
    estimatedPITI: Math.round(estimatedPITI * 100) / 100,
    finalDTI: Math.round(finalDTI * 100) / 100,
    canBuyProperty,
    reasons,
  };
}
