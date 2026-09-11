import type { DtiIncomePathResult } from "@shared/incomePaths";
import { roundCents } from "@shared/incomePaths";

/**
 * Bank-statement income path — Angel Oak Bank Statement program (UAL P4).
 *
 * AUTHORITY: docs/lender-programs/angel-oak/bank-statement-program-reference.md
 * (transcribed 2026-07-11 from Angel Oak's public program page; the TPO portal
 * matrix controls on conflict). Ledger: data/regulatory/regulatory-ledger.json
 * `aoms-bank-statement-expense-factor-default` / `-high`.
 *
 * Transcribed method: qualifying income derives from 12 or 24 months of
 * business or personal bank-statement deposits with an expense factor —
 * default 50%; 70% for traditionally-high-expense industries; below 50% only
 * with a third-party CPA / tax preparer / bookkeeper statement.
 *
 * WHAT THIS PATH DELIBERATELY DOES NOT DO: scrub deposits. Which deposits are
 * ELIGIBLE (transfer exclusions etc.) is portal-gated, so the calculator takes
 * eligible-deposit totals as input and every result flags manual review until
 * the AE deposit-eligibility rules are transcribed. The financial workbench
 * captures an append-only analysis and requires the complete reviewed statement
 * period, while the orchestrator says exactly what is missing before capture.
 */

export const BANK_STATEMENT_PROGRAM = {
  enabled: true as boolean,
  citationFiles: [
    "docs/lender-programs/angel-oak/bank-statement-program-reference.md",
    "docs/lender-programs/angel-oak/README.md",
  ],
};

const BANK_STATEMENT_CITATIONS = [
  {
    doc: "docs/lender-programs/angel-oak/bank-statement-program-reference.md",
    section: "Income methodology (12/24-month statements, expense factor)",
  },
];

/** "Loans will be qualified using a default expense factor of 50%." */
export const BANK_STATEMENT_DEFAULT_EXPENSE_FACTOR = 0.5;
/** "some industries with traditionally higher expense factors will be underwritten with a 70% expense factor" */
export const BANK_STATEMENT_HIGH_EXPENSE_FACTOR = 0.7;
/** The two statement periods the program accepts: "12 or 24 months'". */
export const BANK_STATEMENT_PERIODS = [12, 24] as const;
export type BankStatementPeriod = (typeof BANK_STATEMENT_PERIODS)[number];

export interface BankStatementAnalysisInput {
  /** 12 or 24 — the statement period being analyzed. */
  months: BankStatementPeriod;
  /**
   * Total ELIGIBLE deposits over the period (post-scrubbing). Deposit
   * eligibility rules are AE-gated; whoever supplies this figure attests the
   * screening, and the result flags review regardless.
   */
  totalEligibleDeposits: number;
  /**
   * Expense factor to apply. Omit for the program default (50%). A factor
   * below the default REQUIRES the third-party CPA/tax-preparer/bookkeeper
   * statement; without it the default is applied instead (conservative).
   */
  expenseFactor?: number;
  /** True when the third-party statement supporting a lower factor is on file. */
  hasThirdPartyExpenseStatement?: boolean;
}

export interface BankStatementIncomeResult {
  monthlyQualifyingIncome: number;
  appliedExpenseFactor: number;
  requiresManualReview: boolean;
  notes: string[];
}

/**
 * The cited program math: monthly qualifying income =
 * (eligible deposits ÷ months) × (1 − expense factor). Conservative factor
 * handling — an unsupported below-default factor is raised to the default,
 * never honored silently.
 */
export function computeBankStatementIncome(
  input: BankStatementAnalysisInput,
): BankStatementIncomeResult {
  const notes: string[] = [];
  if (!BANK_STATEMENT_PERIODS.includes(input.months)) {
    return {
      monthlyQualifyingIncome: 0,
      appliedExpenseFactor: BANK_STATEMENT_DEFAULT_EXPENSE_FACTOR,
      requiresManualReview: true,
      notes: ["The program accepts 12 or 24 months of statements — no other period is citable."],
    };
  }
  if (!Number.isFinite(input.totalEligibleDeposits) || input.totalEligibleDeposits <= 0) {
    return {
      monthlyQualifyingIncome: 0,
      appliedExpenseFactor: BANK_STATEMENT_DEFAULT_EXPENSE_FACTOR,
      requiresManualReview: true,
      notes: ["No eligible deposit total provided."],
    };
  }

  let factor = input.expenseFactor ?? BANK_STATEMENT_DEFAULT_EXPENSE_FACTOR;
  if (!Number.isFinite(factor) || factor < 0 || factor >= 1) {
    factor = BANK_STATEMENT_DEFAULT_EXPENSE_FACTOR;
    notes.push("Invalid expense factor supplied — the 50% program default was applied.");
  } else if (factor < BANK_STATEMENT_DEFAULT_EXPENSE_FACTOR && !input.hasThirdPartyExpenseStatement) {
    // "Companies with a lower expense factor will require a statement from a
    // third party CPA, tax preparer, or bookkeeping company."
    factor = BANK_STATEMENT_DEFAULT_EXPENSE_FACTOR;
    notes.push(
      "A below-default expense factor requires a third-party CPA/tax-preparer/bookkeeper statement; none is on file, so the 50% default was applied.",
    );
  }
  if (factor === BANK_STATEMENT_HIGH_EXPENSE_FACTOR) {
    notes.push("70% expense factor applied (traditionally-high-expense industry).");
  }

  const monthlyDeposits = input.totalEligibleDeposits / input.months;
  const monthlyQualifyingIncome = roundCents(monthlyDeposits * (1 - factor));
  notes.push(
    `Qualifying income = (${input.totalEligibleDeposits} ÷ ${input.months}) × (1 − ${factor}) per the cited expense-factor method. Deposit-eligibility screening follows AE guidelines (not yet in-repo) — human review required.`,
  );

  return {
    monthlyQualifyingIncome,
    appliedExpenseFactor: factor,
    // Always until the AE deposit-eligibility rules are transcribed.
    requiresManualReview: true,
    notes,
  };
}

export function computeBankStatementPath(
  hasSelfEmployment: boolean,
  analysis?: BankStatementAnalysisInput,
): DtiIncomePathResult {
  if (!BANK_STATEMENT_PROGRAM.enabled) {
    // Defensive branch (see dscr.ts): compile-time true as of P4.
    return {
      pathId: "bank_statement",
      kind: "dti_income",
      role: "alternative",
      status: hasSelfEmployment ? "unavailable" : "not_indicated",
      monthlyQualifyingIncome: 0,
      appliedToDti: false,
      citations: [],
      requiresManualReview: false,
      unavailableReason: hasSelfEmployment ? "PROGRAM_REFERENCE_NOT_IN_REPO" : undefined,
      notes: [],
    };
  }

  if (!analysis) {
    return {
      pathId: "bank_statement",
      kind: "dti_income",
      role: "alternative",
      status: "not_indicated",
      monthlyQualifyingIncome: 0,
      appliedToDti: false,
      citations: BANK_STATEMENT_CITATIONS,
      requiresManualReview: false,
      notes: hasSelfEmployment
        ? [
            "Program available (12/24-month statements, 50% default expense factor — cited), but no bank-statement deposit analysis has been captured for this application yet. Complete the reviewed statement period in the financial workbench.",
          ]
        : [],
    };
  }

  const r = computeBankStatementIncome(analysis);
  return {
    pathId: "bank_statement",
    kind: "dti_income",
    role: "alternative",
    status: "applicable",
    monthlyQualifyingIncome: r.monthlyQualifyingIncome,
    // Alternative METHOD: compared against full-doc, never summed into it.
    appliedToDti: false,
    citations: BANK_STATEMENT_CITATIONS,
    requiresManualReview: r.requiresManualReview,
    notes: r.notes,
  };
}
