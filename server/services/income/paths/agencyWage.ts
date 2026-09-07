import type { EmploymentHistory, OtherIncomeSource } from "@shared/schema";
import type { DtiIncomePathResult } from "@shared/incomePaths";
import { roundCents, parseFinancialNumber, isPresentFinancialNumber } from "@shared/incomePaths";
import {
  classifyOtherIncomeSource,
  hasUncitedQualifyingTreatment,
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
}

export interface AgencyWageComputation {
  path: DtiIncomePathResult;
  /** Split retained so the underwriting engine's base/bonus inputs stay exact. */
  baseMonthlyIncome: number;
  variableMonthlyIncome: number;
  /** Whether any wage/other line item was found (vs falling back to app summary). */
  usedLineItems: boolean;
}

export function computeAgencyWageIncome(input: AgencyWageInput): AgencyWageComputation {
  const notes: string[] = [];
  let base = 0;
  let variable = 0;
  let sawLineItem = false;

  for (const e of input.employment) {
    if (e.isSelfEmployed) continue; // handled by the self-employment (1084) path
    const itemized = [e.baseIncome, e.overtimeIncome, e.bonusIncome, e.commissionIncome, e.otherIncome];
    if (itemized.some(isPresentNumber)) {
      base += toNum(e.baseIncome);
      variable +=
        toNum(e.overtimeIncome) + toNum(e.bonusIncome) + toNum(e.commissionIncome) + toNum(e.otherIncome);
      sawLineItem = true;
    } else if (isPresentNumber(e.totalMonthlyIncome)) {
      base += toNum(e.totalMonthlyIncome);
      sawLineItem = true;
    }
  }

  // Section 1e other income. Every source is still summed at exactly its declared
  // amount — that is deliberate and unchanged. What is new is that the TYPE is now
  // read (shared/incomeTypes.ts) so the file can say which types it is carrying at
  // face value and why, instead of the fact being invisible.
  //
  // Face value is not obviously correct for several of these. A non-taxable benefit
  // may be eligible to be grossed up, and a support payment may require documented
  // continuance before it counts at all — the first would UNDER-state this
  // borrower's income, the second could OVER-state it.
  //
  // Neither adjustment is made here, and as of 2026-08-22 that is no longer for
  // want of authority: B3-3.1-01 states both (Nontaxable Income — add 25% of the
  // non-taxable amount; Continuance of Income — income with a defined expiration
  // or asset-depletion dependency must be documented to continue three years from
  // the note date). They are withheld for two DIFFERENT reasons:
  //
  //   * gross-up RAISES qualifying income, loosening the DTI gate. This repo's
  //     rail permits a reading to tighten a gate, never to loosen one — so it is
  //     a founder decision, not an agent's.
  //   * continuance TIGHTENS, which is permitted, but other_income_sources holds
  //     only income_source and monthly_amount. There is no expiration date to
  //     test, so the rule is unimplementable until that is captured.
  //
  // See knowledge-base/compliance/SELLING_GUIDE_CONFORMANCE.md. The note below is
  // how the gap reaches a human instead of silently resolving to "100%".
  const uncitedTypes = new Set<string>();
  const unclassifiedSources = new Set<string>();
  for (const o of input.otherIncome) {
    if (isPresentNumber(o.monthlyAmount)) {
      variable += toNum(o.monthlyAmount);
      sawLineItem = true;
      const typeId = classifyOtherIncomeSource(o.incomeSource);
      if (typeId === null) {
        const raw = (o.incomeSource ?? "").trim();
        unclassifiedSources.add(raw === "" ? "(blank)" : raw);
      } else if (hasUncitedQualifyingTreatment(typeId)) {
        uncitedTypes.add(otherIncomeTypeLabel(typeId));
      }
    }
  }
  if (uncitedTypes.size > 0) {
    notes.push(
      `Other income counted at declared face value, with no adjustment applied: ${[...uncitedTypes]
        .sort()
        .join(", ")}. Selling Guide B3-3.1-01 allows grossing up verified non-taxable income by 25% (raises income — withheld pending a policy decision) and requires three-year continuance for income with a defined expiration date (lowers income — not testable, no expiration date is captured). No factor was applied in either direction; confirm the treatment before this figure reaches a lender.`,
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
      requiresManualReview: false,
      notes,
    },
  };
}
