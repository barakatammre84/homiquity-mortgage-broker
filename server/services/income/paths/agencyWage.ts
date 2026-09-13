import type { EmploymentHistory, OtherIncomeSource } from "@shared/schema";
import type { DtiIncomePathResult } from "@shared/incomePaths";
import { roundCents, parseFinancialNumber, isPresentFinancialNumber } from "@shared/incomePaths";
import {
  classifyOtherIncomeSource,
  otherIncomeTypeLabel,
} from "@shared/incomeTypes";

/**
 * Agency wage path (UAL P3) — the reconciled W-2 / wage income math, the ONE
 * implementation replacing the two that existed (server/underwriting.ts
 * qualifyIncome and decisionEngine aggregateBorrowerFinancials).
 *
 * Semantics preserved from decisionEngine (the richer, live instant-decision
 * producer), Fannie Selling Guide B3-3.1 (stable monthly income):
 *  - itemized fields (base/overtime/bonus/commission/other) win whenever ANY
 *    is present — including when they net to a loss (a net-negative K-1 total
 *    must not be silently deleted by a `> 0` guard);
 *  - otherwise the rolled-up totalMonthlyIncome for the job (which may be a
 *    loss) is used as base;
 *  - self-employed records are SKIPPED here and handled by the self-employment
 *    path (Form 1084) — this is the unification: the instant-decision path now
 *    routes self-employment through the cited calculator instead of counting a
 *    raw captured figure;
 *  - other-income sources add to variable income;
 *  - when NO usable wage line item or self-employment record exists, fall back
 *    to the application-summary annual income (base only). The intake total is
 *    a rough planning value for a self-employed borrower and must never stack
 *    on top of Form 1084 income. A net loss IS usable data, so the fallback
 *    fires only on the true absence of any detailed income record.
 */

const AGENCY_WAGE_CITATIONS = [
  { doc: "docs/fannie-mae (Selling Guide)", section: "B3-3.1 Employment and Other Sources of Income" },
];

function toNum(v: unknown): number {
  const n = parseFinancialNumber(v);
  return isNaN(n) ? 0 : n;
}

const isPresentNumber = isPresentFinancialNumber;

export interface AgencyWageInput {
  employment: EmploymentHistory[];
  otherIncome: OtherIncomeSource[];
  /** Application-summary fallback used only when no wage line item exists. */
  fallbackAnnualIncome?: number | string | null;
  /** Expected note/closing date used for the B3-3.1-01 three-year test. */
  expectedNoteDate?: Date | string | null;
  /** True only for an evidence-backed, approved income workpaper. */
  applyVerifiedOtherIncomeAdjustments?: boolean;
}

export interface AgencyWageComputation {
  path: DtiIncomePathResult;
  /** Split retained so the underwriting engine's base/bonus inputs stay exact. */
  baseMonthlyIncome: number;
  variableMonthlyIncome: number;
  /** Whether any wage/other line item was found (vs falling back to app summary). */
  usedLineItems: boolean;
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? new Date(value) : new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function threeYearsAfter(value: Date): Date {
  const result = new Date(value);
  result.setUTCFullYear(result.getUTCFullYear() + 3);
  return result;
}

export function computeAgencyWageIncome(input: AgencyWageInput): AgencyWageComputation {
  const notes: string[] = [];
  let base = 0;
  let variable = 0;
  let sawLineItem = false;
  const unclassifiedSources = new Set<string>();
  const treatmentGaps = new Set<string>();
  let favorableAdjustmentWithheld = false;
  let otherIncomeRequiresReview = false;

  for (const e of input.employment) {
    if (e.isSelfEmployed) continue; // handled by the self-employment (1084) path
    const jobLabel = e.employerName?.trim() || "Employment income";
    if (e.paidInVirtualCurrency === true) {
      sawLineItem = true;
      notes.push(`${jobLabel} excluded because the income is paid in virtual currency.`);
      continue;
    }
    if (e.paidInVirtualCurrency !== false) {
      otherIncomeRequiresReview = true;
      treatmentGaps.add(`${jobLabel}: confirm whether any income is paid in virtual currency`);
    }
    let jobBase = 0;
    let jobVariable = 0;
    let hasJobLineItem = false;
    const itemized = [
      e.baseIncome,
      e.overtimeIncome,
      e.bonusIncome,
      e.commissionIncome,
      e.militaryEntitlements,
      e.otherIncome,
    ];
    if (itemized.some(isPresentNumber)) {
      jobBase = toNum(e.baseIncome);
      jobVariable =
        toNum(e.overtimeIncome)
        + toNum(e.bonusIncome)
        + toNum(e.commissionIncome)
        + toNum(e.militaryEntitlements)
        + toNum(e.otherIncome);
      sawLineItem = true;
      hasJobLineItem = true;
    } else if (isPresentNumber(e.totalMonthlyIncome)) {
      jobBase = toNum(e.totalMonthlyIncome);
      sawLineItem = true;
      hasJobLineItem = true;
    }

    if (e.hasKnownFutureIncomeReduction === true) {
      const currentMonthly = jobBase + jobVariable;
      if (!isPresentNumber(e.futureMonthlyIncome) || toNum(e.futureMonthlyIncome) < 0) {
        jobBase = 0;
        jobVariable = 0;
        otherIncomeRequiresReview = true;
        treatmentGaps.add(`${jobLabel}: add the lower future gross monthly income`);
        notes.push(`${jobLabel} excluded until the known lower future income is entered.`);
      } else {
        const futureMonthly = toNum(e.futureMonthlyIncome);
        if (hasJobLineItem && futureMonthly >= currentMonthly) {
          jobBase = 0;
          jobVariable = 0;
          otherIncomeRequiresReview = true;
          treatmentGaps.add(`${jobLabel}: the future amount must be lower than the current monthly income`);
          notes.push(`${jobLabel} excluded because the reported future amount does not describe a reduction.`);
        } else {
          jobBase = futureMonthly;
          jobVariable = 0;
          notes.push(`${jobLabel} uses the reported lower future gross monthly income under Selling Guide B3-3.1-01.`);
        }
      }
      if (!parseDate(e.futureIncomeEffectiveDate)) {
        otherIncomeRequiresReview = true;
        treatmentGaps.add(`${jobLabel}: add the effective date of the lower income`);
      }
      if (!e.futureIncomeReason?.trim()) {
        otherIncomeRequiresReview = true;
        treatmentGaps.add(`${jobLabel}: explain the known income change`);
      }
    } else if (e.hasKnownFutureIncomeReduction !== false) {
      otherIncomeRequiresReview = true;
      treatmentGaps.add(`${jobLabel}: confirm whether the income is expected to decrease`);
    }

    base += jobBase;
    variable += jobVariable;
  }

  // Section 1e other income: B3-3.1-01 continuance and nontaxable treatment.
  // A current approved workpaper is required before a favorable gross-up can
  // affect DTI; an ineligible virtual-currency source is excluded immediately.
  for (const o of input.otherIncome) {
    if (isPresentNumber(o.monthlyAmount)) {
      const declaredAmount = Math.max(toNum(o.monthlyAmount), 0);
      sawLineItem = true;
      const typeId = classifyOtherIncomeSource(o.incomeSource);
      const label = typeId === null
        ? ((o.incomeSource ?? "").trim() || "Other income")
        : otherIncomeTypeLabel(typeId);
      // B3-3.4-05 never permits the borrower's typed monthly capital-gains
      // amount to qualify at face value. Its dedicated path uses reviewed
      // Schedule D history plus current portfolio evidence. Mark the detailed
      // row as seen so the application-summary fallback cannot reintroduce the
      // same unsupported amount through the household annual total.
      if (typeId === "capital_gains" || typeId === "employment_related_assets") {
        notes.push(typeId === "capital_gains"
          ? `${label} is calculated separately from reviewed tax returns and portfolio evidence.`
          : `${label} is calculated separately from reviewed retirement-account evidence.`);
        continue;
      }
      if (o.paidInVirtualCurrency === true) {
        notes.push(`${label} excluded because the income is paid in virtual currency.`);
        continue;
      }
      if (o.paidInVirtualCurrency !== false) {
        otherIncomeRequiresReview = true;
        treatmentGaps.add(`${label}: confirm whether any income is paid in virtual currency`);
      }
      if (typeId === null) {
        const raw = (o.incomeSource ?? "").trim();
        unclassifiedSources.add(raw === "" ? "(blank)" : raw);
      }

      let qualifyingAmount = declaredAmount;
      const noteDate = parseDate(input.expectedNoteDate);
      const expirationDate = parseDate(o.expirationDate);
      if (o.hasDefinedExpiration === true) {
        if (!noteDate || !expirationDate) {
          otherIncomeRequiresReview = true;
          treatmentGaps.add(`${label}: confirm the expiration date and expected note date`);
        } else if (expirationDate.getTime() < threeYearsAfter(noteDate).getTime()) {
          qualifyingAmount = 0;
          notes.push(
            `${label} excluded: it is documented to expire before three years after the expected note date.`,
          );
        }
      } else if (o.hasDefinedExpiration !== false) {
        otherIncomeRequiresReview = true;
        treatmentGaps.add(`${label}: confirm whether the income has a defined expiration date`);
      }

      let nonTaxableAmount = 0;
      if (o.taxTreatment === "fully_non_taxable") {
        nonTaxableAmount = declaredAmount;
      } else if (o.taxTreatment === "partially_non_taxable") {
        const captured = isPresentNumber(o.nonTaxableMonthlyAmount)
          ? toNum(o.nonTaxableMonthlyAmount)
          : NaN;
        if (!Number.isFinite(captured) || captured <= 0 || captured > declaredAmount) {
          otherIncomeRequiresReview = true;
          treatmentGaps.add(`${label}: confirm the monthly portion that is exempt from federal income tax`);
        } else {
          nonTaxableAmount = captured;
        }
      } else if (o.taxTreatment !== "taxable") {
        otherIncomeRequiresReview = true;
        treatmentGaps.add(`${label}: confirm its federal income-tax treatment`);
      }

      if (qualifyingAmount > 0 && nonTaxableAmount > 0) {
        if (input.applyVerifiedOtherIncomeAdjustments) {
          const grossUp = roundCents(nonTaxableAmount * 0.25);
          qualifyingAmount = roundCents(qualifyingAmount + grossUp);
          notes.push(
            `${label}: added ${grossUp.toLocaleString("en-US", { style: "currency", currency: "USD" })} (25% of the verified nontaxable portion) to qualifying income.`,
          );
        } else {
          favorableAdjustmentWithheld = true;
        }
      }
      variable += qualifyingAmount;
    }
  }
  if (treatmentGaps.size > 0) {
    notes.push(
      `Other-income qualification needs confirmation: ${[...treatmentGaps].sort().join("; ")}.`,
    );
  }
  if (favorableAdjustmentWithheld) {
    notes.push(
      "A potential nontaxable-income gross-up is shown but not applied until the current evidence-backed income workpaper is approved.",
    );
  }
  if (unclassifiedSources.size > 0) {
    notes.push(
      `Other income of an unrecognised type counted at face value: ${[...unclassifiedSources]
        .sort()
        .join(", ")}. The stored value matches no entry in the Section 1e catalog, so its type could not be determined and was not guessed.`,
    );
  }

  let usedLineItems = sawLineItem;
  const hasSelfEmploymentRecord = input.employment.some((employment) => employment.isSelfEmployed);
  if (!sawLineItem && !hasSelfEmploymentRecord) {
    const annual = toNum(input.fallbackAnnualIncome);
    base = annual / 12;
    variable = 0;
    usedLineItems = false;
    if (annual > 0) {
      notes.push("No wage line items captured — using the application-summary annual income.");
    }
  } else if (!sawLineItem && hasSelfEmploymentRecord) {
    notes.push("Application-summary income excluded because self-employment is calculated from the business worksheets.");
  }

  base = roundCents(base);
  variable = roundCents(variable);
  const monthly = roundCents(base + variable);
  const applicable = monthly !== 0 || usedLineItems;

  return {
    baseMonthlyIncome: base,
    variableMonthlyIncome: variable,
    usedLineItems,
    path: {
      pathId: "agency_wage",
      kind: "dti_income",
      role: "component",
      status: applicable ? "applicable" : "not_indicated",
      monthlyQualifyingIncome: monthly,
      appliedToDti: true,
      citations: AGENCY_WAGE_CITATIONS,
      requiresManualReview: otherIncomeRequiresReview,
      notes,
    },
  };
}
