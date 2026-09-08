/**
 * Deterministic underwriting-nuance rules — the "60% of borrowers aren't the
 * happy path" layer. Pure functions only: no IO, no AI, no discretion. Every
 * rule cites its guideline so audits can trace math to policy:
 *
 *  - Income seasoning        Fannie Mae Selling Guide B3-3.5-01 (Length of
 *                            Self-Employment: two-year history, or 12 months
 *                            with documented prior income in the same field)
 *  - Deferred student loans  Fannie Mae Selling Guide B3-6-05 (1% rule)
 *  - VA residual income      VA Pamphlet 26-7 Chapter 4 (incl. 20% cushion)
 *  - Large-deposit sourcing  Fannie Mae Selling Guide B3-4.2-02 (Depository
 *                            Accounts, 50% rule); B3-4.3-04 governs gift funds
 *
 * Reg B note: these are structural rules, deliberately isolated from any AI
 * service — the coach may EXPLAIN outcomes, it never computes them.
 */

import type { IncomeSourceEntry, RentalPropertyEntry } from "@shared/schema";
import { toNum } from "@shared/lib/number";

// ---------------------------------------------------------------------------
// Scenario 1 — income seasoning (B3-3.5-01)
// ---------------------------------------------------------------------------

export interface SeasoningAssessment {
  /** Sources fully usable (≥24 months in the same line of work). */
  seasonedSources: string[];
  /**
   * 12–24 months. B3-3.5-01 does NOT condition this on offsetting strengths —
   * "compensating factors" is B3-3.2-02's test for employment-related income, a
   * different section. The conditions here are documentary: the most recent
   * returns must reflect a full 12 months from the current business, AND the file
   * must separately document prior income at the same (or greater) level in the
   * same field. Neither is captured, so this tier is a flag, never a clearance.
   */
  conditionalSources: Array<{ type: string; months: number }>;
  /** <12 months: not usable for qualifying under standard guidelines. */
  unseasonedSources: Array<{ type: string; months: number }>;
}

export const SEASONING_FULL_MONTHS = 24;
export const SEASONING_CONDITIONAL_MONTHS = 12;

/**
 * Self-employment/contract income types that carry the seasoning requirement.
 *
 * B3-3.5-01 governs self-employment. Rental income follows B3-3.8-01 and must
 * never inherit this 24-month rule; doing so turned a rental documentation need
 * into a false borrower-facing eligibility block.
 */
const SEASONING_GOVERNED_TYPES = new Set(["self_employed", "other"]);

export function assessIncomeSeasoning(
  incomeSources: IncomeSourceEntry[] | null | undefined,
): SeasoningAssessment {
  const result: SeasoningAssessment = {
    seasonedSources: [],
    conditionalSources: [],
    unseasonedSources: [],
  };
  for (const source of incomeSources ?? []) {
    if (!SEASONING_GOVERNED_TYPES.has(source.type)) {
      result.seasonedSources.push(source.type);
      continue;
    }
    const years = toNum(source.yearsInRole);
    const months = isNaN(years) ? 0 : Math.round(years * 12);
    if (months >= SEASONING_FULL_MONTHS) {
      result.seasonedSources.push(source.type);
    } else if (months >= SEASONING_CONDITIONAL_MONTHS) {
      result.conditionalSources.push({ type: source.type, months });
    } else {
      result.unseasonedSources.push({ type: source.type, months });
    }
  }
  return result;
}

/** Discrepancy delta between self-reported and verified seasoned income (%). */
export function incomeDiscrepancyPct(selfReported: number, verifiedSeasoned: number): number {
  if (verifiedSeasoned <= 0) return 0;
  return (Math.abs(selfReported - verifiedSeasoned) / verifiedSeasoned) * 100;
}

// ---------------------------------------------------------------------------
// Scenario 3 — sleeper debt (B3-6-05)
// ---------------------------------------------------------------------------

export interface Tradeline {
  creditor: string;
  type: string; // revolving | installment | mortgage | auto | student_loan | retail
  balance: number;
  monthlyPayment: number;
  /** Deferred obligations report $0 payment but still count via the 1% rule. */
  deferred?: boolean;
  /** Days since the line was opened — recent lines are "sleeper debt". */
  openedDaysAgo?: number;
}

export const DEFERRED_STUDENT_LOAN_FACTOR = 0.01;
// B3-6-05, Revolving Charge/Lines of Credit: where the credit report carries no
// required minimum payment, the qualifying obligation is 5% of the outstanding
// balance — for DU casefiles, the greater of $10 or 5%. Without this a revolving
// tradeline pulled with a $0 minimum contributed nothing to the DTI.
export const REVOLVING_PAYMENT_FACTOR = 0.05;
export const REVOLVING_MINIMUM_PAYMENT_FLOOR = 10;
// PLATFORM POLICY, not an agency figure — B3-6-05 publishes no recency window
// (ledger: platform-new-tradeline-window-90d). Detection metadata only: the
// flagged lines' payments are in adjustedMonthlyDebt regardless of the window.
export const NEW_TRADELINE_WINDOW_DAYS = 90;
// PLATFORM OVERLAY, not an agency figure — B3-6-02 puts the DU maximum at 50%
// (ledger: platform-dti-ceiling-43, platform-conv-dti-cap-43). We are stricter
// than Fannie here deliberately; that is the permitted direction.
export const STANDARD_DTI_CEILING = 0.43;

export interface LiabilityAdjustment {
  /** Sum of verified monthly obligations after the guideline adjustments. */
  adjustedMonthlyDebt: number;
  /** Payments exactly as reported on the tradelines. */
  reportedMonthlyPayments: number;
  /** Additional payment imputed on deferred student loans (1% of balance). */
  deferredStudentLoanImputed: number;
  /** Additional payment imputed on revolving lines reporting no minimum (B3-6-05). */
  revolvingImputed: number;
  /** Revolving lines that reported no minimum payment and were imputed. */
  imputedRevolvingLines: Tradeline[];
  /** Payments on lines opened within the new-tradeline window. */
  newTradelinePayments: number;
  deferredStudentLoans: Tradeline[];
  newTradelines: Tradeline[];
}

/**
 * B3-6-05 revolving set: "credit cards, department store charge cards, and
 * personal lines of credit". Equity lines secured by real estate are excluded —
 * the same topic routes those into the housing expense.
 */
function isRevolving(type: string): boolean {
  const t = (type || "").toLowerCase();
  return t === "revolving" || t === "credit_card" || t === "retail";
}

export function adjustLiabilities(tradelines: Tradeline[] | null | undefined): LiabilityAdjustment {
  const lines = tradelines ?? [];
  const deferredStudentLoans = lines.filter(
    (t) => t.type === "student_loan" && (t.deferred === true || t.monthlyPayment === 0),
  );
  const newTradelines = lines.filter(
    (t) => t.openedDaysAgo !== undefined && t.openedDaysAgo <= NEW_TRADELINE_WINDOW_DAYS,
  );

  // B3-6-05: revolving lines reporting no minimum payment qualify at the greater
  // of $10 or 5% of balance. Student loans are handled by the 1% rule above and
  // are excluded here so a single tradeline is never imputed twice.
  const imputedRevolvingLines = lines.filter(
    (t) => isRevolving(t.type) && !t.monthlyPayment && t.balance > 0,
  );
  const revolvingImputed = imputedRevolvingLines.reduce(
    (sum, t) => sum + Math.max(REVOLVING_MINIMUM_PAYMENT_FLOOR, t.balance * REVOLVING_PAYMENT_FACTOR),
    0,
  );

  const reportedMonthlyPayments = lines.reduce((sum, t) => sum + (t.monthlyPayment || 0), 0);
  const deferredStudentLoanImputed = deferredStudentLoans.reduce(
    (sum, t) => sum + t.balance * DEFERRED_STUDENT_LOAN_FACTOR,
    0,
  );

  return {
    adjustedMonthlyDebt: reportedMonthlyPayments + deferredStudentLoanImputed + revolvingImputed,
    reportedMonthlyPayments,
    deferredStudentLoanImputed,
    revolvingImputed,
    imputedRevolvingLines,
    // Informational: already inside reportedMonthlyPayments, surfaced so the
    // resolution copy can explain WHERE the debt shift came from.
    newTradelinePayments: newTradelines.reduce((sum, t) => sum + (t.monthlyPayment || 0), 0),
    deferredStudentLoans,
    newTradelines,
  };
}

export function computeDti(monthlyDebt: number, proposedPiti: number, grossMonthlyIncome: number): number {
  if (grossMonthlyIncome <= 0) return Infinity;
  return (monthlyDebt + proposedPiti) / grossMonthlyIncome;
}

export interface WhatIfPayoff {
  creditor: string;
  balance: number;
  monthlyPaymentFreed: number;
  dtiAfterPayoff: number;
}

/**
 * The "turn a denial into a coaching moment" calculation: the smallest single
 * revolving/retail payoff that brings DTI back under the ceiling, if any.
 */
export function computeWhatIfPayoff(
  tradelines: Tradeline[],
  adjustedMonthlyDebt: number,
  proposedPiti: number,
  grossMonthlyIncome: number,
  dtiCeiling: number = STANDARD_DTI_CEILING,
): WhatIfPayoff | null {
  const candidates = tradelines
    .filter((t) => ["revolving", "retail"].includes(t.type) && t.monthlyPayment > 0 && t.balance > 0)
    .sort((a, b) => a.balance - b.balance);

  for (const line of candidates) {
    const dtiAfter = computeDti(adjustedMonthlyDebt - line.monthlyPayment, proposedPiti, grossMonthlyIncome);
    if (dtiAfter <= dtiCeiling) {
      return {
        creditor: line.creditor,
        balance: line.balance,
        monthlyPaymentFreed: line.monthlyPayment,
        dtiAfterPayoff: Number(dtiAfter.toFixed(4)),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scenario 2 — VA residual income (Pamphlet 26-7 Ch. 4)
// ---------------------------------------------------------------------------

export type VaRegion = "northeast" | "midwest" | "south" | "west";

/**
 * VA residual-income baselines for loan amounts ≥ $80,000, by region and
 * family size (VA Pamphlet 26-7, Table 4-2). Family sizes >5 add $80/member.
 */
export const VA_RESIDUAL_MATRIX: Record<VaRegion, Record<number, number>> = {
  northeast: { 1: 450, 2: 755, 3: 909, 4: 1025, 5: 1062 },
  midwest: { 1: 441, 2: 738, 3: 889, 4: 1003, 5: 1039 },
  south: { 1: 441, 2: 738, 3: 889, 4: 1003, 5: 1039 },
  west: { 1: 491, 2: 823, 3: 990, 4: 1117, 5: 1158 },
};

/**
 * The +$80 per family member beyond five (26-7 Ch. 4, Topic 9, Item 43).
 * Exported so a test or a peer module can assert against THIS value rather
 * than restating 80 — a restated literal is the drift this module exists to
 * prevent. The engine resolves the same figure from the `VA_RESIDUAL_EXTRA_MEMBER`
 * policy scalar (seeded at 80 in `server/scripts/seedLendingGrids.ts`), so the
 * two paths agree by construction.
 */
export const VA_EXTRA_MEMBER_ADDITION = 80;
/**
 * The +$80/member addition applies only "up to a family of seven" — the
 * handbook's own example (family of 8, Georgia, $150k) yields $1,199 and
 * states "The eighth person will not be considered." (26-7 Ch. 4, Topic 9,
 * Item 43, verified against the official text 2026-07-04.)
 */
export const VA_EXTRA_MEMBER_FAMILY_CAP = 7;
export const VA_UTILITY_RATE_PER_SQFT = 0.14;
export const VA_DTI_CUSHION_TRIGGER = 0.41;
export const VA_CUSHION_MULTIPLIER = 1.2;
/**
 * "Reducing the Residual Income Figures" (26-7 Ch. 4, Topic 9, Item 43):
 * reduce the table figure by 5% if the borrower is an active-duty OR retired
 * serviceperson, OR there is a clear indication the borrower will receive the
 * benefits of military-based facilities near the property (Guard/Reserve
 * retirees, 100%-disabled Veterans and their family members, Medal of Honor
 * recipients). The conditions are DISJUNCTIVE — any one qualifies.
 */
export const VA_RESIDUAL_REDUCTION_FACTOR = 0.95;

const STATE_TO_VA_REGION: Record<string, VaRegion> = {
  CT: "northeast", MA: "northeast", ME: "northeast", NH: "northeast", NJ: "northeast",
  NY: "northeast", PA: "northeast", RI: "northeast", VT: "northeast",
  IA: "midwest", IL: "midwest", IN: "midwest", KS: "midwest", MI: "midwest",
  MN: "midwest", MO: "midwest", ND: "midwest", NE: "midwest", OH: "midwest",
  SD: "midwest", WI: "midwest",
  AL: "south", AR: "south", DC: "south", DE: "south", FL: "south", GA: "south",
  KY: "south", LA: "south", MD: "south", MS: "south", NC: "south", OK: "south",
  PR: "south", SC: "south", TN: "south", TX: "south", VA: "south", WV: "south",
  AK: "west", AZ: "west", CA: "west", CO: "west", HI: "west", ID: "west",
  MT: "west", NM: "west", NV: "west", OR: "west", UT: "west", WA: "west", WY: "west",
};

export function vaRegionForState(state: string | null | undefined): VaRegion {
  return STATE_TO_VA_REGION[(state || "").toUpperCase()] ?? "south";
}

export function vaResidualBaseline(region: VaRegion, familySize: number): number {
  const table = VA_RESIDUAL_MATRIX[region];
  const clamped = Math.max(1, Math.round(familySize));
  if (clamped <= 5) return table[clamped];
  // Members beyond a family of seven are not considered (Ch. 4 Item 43).
  const countable = Math.min(clamped, VA_EXTRA_MEMBER_FAMILY_CAP);
  return table[5] + (countable - 5) * VA_EXTRA_MEMBER_ADDITION;
}

export interface VaResidualResult {
  residualIncome: number;
  baseline: number;
  /** Baseline (×0.95 when the Item 43 reduction applies) ×1.2 when DTI > 41%. */
  requiredResidual: number;
  utilityDeduction: number;
  cushionApplied: boolean;
  reductionApplied: boolean;
  passes: boolean;
}

/**
 * Platform ESTIMATION model, not a VA figure: 26-7 Ch. 4 Items 32–34 prescribe
 * estimated Federal/state income tax and Social Security from IRS/state tax
 * tables on the borrower's documented income. Until real income documents flow
 * (F3 credit / F5 VOIE vendors), a fixed federal+FICA effective rate of ~22%
 * stands in — the single shared constant for BOTH the reference module and the
 * live engine (underwritingEngine.ts imports it; never fork this number).
 */
export const RESIDUAL_TAX_RATE = 0.22;

export function computeVaResidualIncome(input: {
  grossMonthlyIncome: number;
  proposedPiti: number;
  monthlyDebts: number;
  homeSquareFeet: number;
  state: string | null | undefined;
  familySize: number;
  dti: number;
  /**
   * Item 43 "Reducing the Residual Income Figures": true when the borrower is
   * an active-duty or retired serviceperson, OR there is a clear indication of
   * continued military-facility benefits near the property (disjunctive).
   */
  qualifiesForResidualReduction?: boolean;
}): VaResidualResult {
  const utilityDeduction = input.homeSquareFeet * VA_UTILITY_RATE_PER_SQFT;
  const estimatedTaxes = input.grossMonthlyIncome * RESIDUAL_TAX_RATE;
  const residualIncome =
    input.grossMonthlyIncome - estimatedTaxes - input.proposedPiti - input.monthlyDebts - utilityDeduction;

  const region = vaRegionForState(input.state);
  const baseline = vaResidualBaseline(region, input.familySize);
  const reductionApplied = input.qualifiesForResidualReduction === true;
  // The 5% reduction lowers the table figure itself; the >41%-DTI cushion then
  // applies to that (possibly reduced) guideline figure.
  const guideline = reductionApplied ? baseline * VA_RESIDUAL_REDUCTION_FACTOR : baseline;
  const cushionApplied = input.dti > VA_DTI_CUSHION_TRIGGER;
  const requiredResidual = cushionApplied ? guideline * VA_CUSHION_MULTIPLIER : guideline;

  return {
    residualIncome: Number(residualIncome.toFixed(2)),
    baseline,
    requiredResidual: Number(requiredResidual.toFixed(2)),
    utilityDeduction: Number(utilityDeduction.toFixed(2)),
    cushionApplied,
    reductionApplied,
    passes: residualIncome >= requiredResidual,
  };
}

// ---------------------------------------------------------------------------
// Scenario 4 — large-deposit sourcing (B3-4.2-02; gifts resolved per B3-4.3-04)
// ---------------------------------------------------------------------------

export interface DepositoryTransaction {
  amount: number; // provider convention: negative = inflow/deposit
  date: string;
  description?: string;
}

export const SIGNIFICANT_DEPOSIT_INCOME_FACTOR = 0.5;

export interface SignificantDeposit {
  amount: number;
  date: string;
  description?: string;
  threshold: number;
}

/**
 * Deposits exceeding 50% of monthly qualifying income must be sourced —
 * they may hide undisclosed loans or unverifiable "mattress cash".
 *
 * Detection is deliberately SIGN-AGNOSTIC on the transaction amount: providers
 * disagree on convention (Plaid-style reports inflows as negative; others use
 * positive), and keying off one convention silently disabled this rule for the
 * other. A large OUTFLOW can therefore be flagged too — an acceptable false
 * positive for a warning-severity documentation request, and far cheaper than
 * missing an unsourced six-figure wire because a vendor flipped the sign.
 */
export function detectSignificantDeposits(
  transactions: DepositoryTransaction[] | null | undefined,
  grossMonthlyIncome: number,
): SignificantDeposit[] {
  if (!transactions || grossMonthlyIncome <= 0) return [];
  const threshold = grossMonthlyIncome * SIGNIFICANT_DEPOSIT_INCOME_FACTOR;
  return transactions
    .filter((t) => Math.abs(t.amount) > threshold)
    .map((t) => ({
      amount: Math.abs(t.amount),
      date: t.date,
      description: t.description,
      threshold: Number(threshold.toFixed(2)),
    }));
}

// ---------------------------------------------------------------------------
// Scenario 5 — rental income calculation (Fannie B3-3.8-01, formerly
// B3-3.1-08; renumbering verified live 2026-07-17 —
// docs/fannie-mae/rental-income-reference.md)
// ---------------------------------------------------------------------------

/** Fannie Mae B3-3.8-01 (formerly B3-3.1-08): qualifying rental income = 75%
 * of gross rent (a standard 25% vacancy/expense factor), net of the rental
 * property's PITIA. */
export const RENTAL_INCOME_VACANCY_FACTOR = 0.75;

export interface RentalIncomeOffset {
  address: string;
  grossMonthlyRent: number;
  qualifyingRentalIncome: number;
  monthlyPitia: number;
  /** qualifyingRentalIncome − monthlyPitia. B3-3.8-01: positive → added to
   * qualifying income; negative → the net loss is added to monthly
   * obligations (ledger fnma-b3-3-8-01-rental-offset-dti). */
  netOffset: number;
}

/** Per-property rental income offset from intake's rentalProperties entries. */
export function calculateRentalIncomeOffsets(
  rentalProperties: RentalPropertyEntry[] | null | undefined,
): RentalIncomeOffset[] {
  if (!rentalProperties || rentalProperties.length === 0) return [];
  return rentalProperties.map((p) => {
    const grossMonthlyRent = toNum(p.monthlyRentalIncome);
    const monthlyPitia = toNum(p.monthlyDebtPayment);
    const rent = isNaN(grossMonthlyRent) ? 0 : grossMonthlyRent;
    const pitia = isNaN(monthlyPitia) ? 0 : monthlyPitia;
    const qualifyingRentalIncome = rent * RENTAL_INCOME_VACANCY_FACTOR;
    return {
      address: p.address,
      grossMonthlyRent: rent,
      qualifyingRentalIncome,
      monthlyPitia: pitia,
      netOffset: qualifyingRentalIncome - pitia,
    };
  });
}

// ---------------------------------------------------------------------------
// Scenario 6 — multi-unit subject property rental income (Fannie B3-3.8-01,
// formerly B3-3.1-08)
// ---------------------------------------------------------------------------

export interface SubjectPropertyRentalOffset {
  grossMonthlyMarketRent: number;
  qualifyingRentalIncome: number;
  subjectPitia: number;
  /** Informational context only. B3-3.8-01's applied treatment is INCOME-SIDE:
   * qualifying rent is added to total monthly income while the FULL subject
   * PITIA stays in monthly obligations — the two are never netted in the DTI
   * math (ledger fnma-b3-3-8-01-subject-rental-income). */
  netOffset: number;
}

/** Fannie B3-3.8-01 (formerly B3-3.1-08): an owner-occupied 2–4-unit property
 * qualifies market rent from the appraisal's rent schedule (Form 1025) at the
 * same 75% vacancy/expense factor as investment rental income. Eligibility:
 * the borrower occupies one unit as a primary residence and the property has
 * 2–4 units — a non-owner-occupied multi-unit purchase or a 1-unit/5+-unit
 * property don't fit this rule. Returns the qualifying monthly rent to ADD to
 * income (never net against the subject PITIA), or null when ineligible. */
export function calculateSubjectPropertyQualifyingRent(
  marketMonthlyRent: number | string | null | undefined,
  numberOfUnits: number | null | undefined,
  occupancyType: string | null | undefined,
): number | null {
  if (occupancyType !== "primary_residence") return null;
  if (!numberOfUnits || numberOfUnits < 2 || numberOfUnits > 4) return null;
  const rent = toNum(marketMonthlyRent);
  if (isNaN(rent) || rent <= 0) return null;
  return rent * RENTAL_INCOME_VACANCY_FACTOR;
}

/** Advisory display shape over calculateSubjectPropertyQualifyingRent: keeps
 * the subject PITIA and a net figure for borrower-context messaging. The
 * applied DTI math must use the qualifying rent income-side only (see
 * SubjectPropertyRentalOffset.netOffset doc). */
export function calculateSubjectPropertyRentalOffset(
  marketMonthlyRent: number | string | null | undefined,
  subjectPitia: number,
  numberOfUnits: number | null | undefined,
  occupancyType: string | null | undefined,
): SubjectPropertyRentalOffset | null {
  const qualifyingRentalIncome = calculateSubjectPropertyQualifyingRent(
    marketMonthlyRent,
    numberOfUnits,
    occupancyType,
  );
  if (qualifyingRentalIncome === null) return null;
  const rent = toNum(marketMonthlyRent);
  return {
    grossMonthlyMarketRent: rent,
    qualifyingRentalIncome,
    subjectPitia,
    netOffset: qualifyingRentalIncome - subjectPitia,
  };
}
