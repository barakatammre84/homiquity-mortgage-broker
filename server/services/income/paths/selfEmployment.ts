import type { EmploymentHistory } from "@shared/schema";
import type { DtiIncomePathResult } from "@shared/incomePaths";
import { roundCents } from "@shared/incomePaths";
import { isSelfEmploymentWorksheetComplete } from "@shared/lib/selfEmploymentWorksheet";
import {
  computeSelfEmploymentQualifyingIncome,
  type SelfEmploymentIncomeResult,
} from "../../selfEmploymentIncome";
import type { CurrentProfitLossSignal, ProfitLossActivityIssue } from "../../profitLossActivity";

/**
 * Self-employment path (UAL P3) — a thin wrapper over the cited Fannie Form
 * 1084 calculator (server/services/selfEmploymentIncome.ts, B3-3.5/B3-3.6).
 * The math is NOT forked here; this only aggregates across a borrower's
 * self-employed jobs and adapts the result to the path envelope.
 *
 * An incomplete self-employed job contributes 0 and returns a borrower-facing
 * missing item. Human review begins only after every listed business has a
 * completed worksheet.
 */

const SELF_EMPLOYMENT_CITATIONS = [
  { doc: "docs/fannie-mae/self-employment-income-reference.md", section: "B3-3.5 / B3-3.6 (Form 1084)" },
];

export interface SelfEmploymentComputation {
  path: DtiIncomePathResult;
  perJob: SelfEmploymentIncomeResult[];
}

export function computeSelfEmploymentPath(
  employment: EmploymentHistory[],
  currentActivity: CurrentProfitLossSignal[] = [],
  currentActivityIssues: ProfitLossActivityIssue[] = [],
): SelfEmploymentComputation {
  const seJobs = employment.filter((e) => e.isSelfEmployed);
  const perJob: SelfEmploymentIncomeResult[] = [];
  const notes: string[] = [];
  let monthly = 0;
  let requiresManualReview = false;
  const missingItems: string[] = [];

  for (const e of seJobs) {
    if (e.paidInVirtualCurrency === true) {
      notes.push(`${e.employerName?.trim() || "Self-employment income"} excluded because the income is earned in virtual currency.`);
      continue;
    }
    if (e.paidInVirtualCurrency !== false) {
      requiresManualReview = true;
      notes.push(`Confirm whether ${e.employerName?.trim() || "the listed business"} earns any borrower income in virtual currency.`);
    }
    if (!isSelfEmploymentWorksheetComplete(e.selfEmploymentIncome)) {
      missingItems.push(
        `Complete the self-employment income worksheet for ${e.employerName?.trim() || "each listed business"}`,
      );
      continue;
    }
    const se = computeSelfEmploymentQualifyingIncome(e.selfEmploymentIncome);
    perJob.push(se);
    monthly += se.monthlyQualifyingIncome;
    requiresManualReview = requiresManualReview || se.requiresManualReview;
    notes.push(...se.notes);
    const activity = currentActivity.find(signal => signal.employmentId === e.id);
    if (activity) {
      requiresManualReview = requiresManualReview || activity.requiresManualReview;
      notes.push(activity.note);
    }
    const activityIssues = currentActivityIssues.filter(issue => issue.employmentId === e.id);
    if (activityIssues.length > 0) {
      requiresManualReview = true;
      notes.push(...activityIssues.map(issue => issue.message));
    }
  }

  if (missingItems.length > 0) {
    notes.push(
      `${missingItems.length} self-employed position(s) have no completed income worksheet and contribute $0 until the Form 1084 details are provided.`,
    );
  }

  monthly = roundCents(monthly);
  const status = seJobs.length === 0 ? "not_indicated" : "applicable";

  return {
    perJob,
    path: {
      pathId: "self_employment",
      kind: "dti_income",
      role: "component",
      status,
      monthlyQualifyingIncome: monthly,
      appliedToDti: true,
      citations: SELF_EMPLOYMENT_CITATIONS,
      requiresManualReview,
      ...(missingItems.length > 0 ? { missingItems } : {}),
      notes,
    },
  };
}
