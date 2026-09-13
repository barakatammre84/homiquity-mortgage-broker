/**
 * Borrower-facing income summary — the masked read model behind
 * GET /api/loan-applications/:id/income-summary (Borrower Clarity PR 7,
 * kb log 2026-08-04 §4; user decision: C1 + educational pre-decision state).
 *
 * Two states, one contract:
 *  - AVAILABLE (post-decision only): the file is approved-grade AND its
 *    financial data is decision-grade verified — the same gate class as the
 *    pre-approval letter. The borrower sees how their verified income was
 *    calculated: per-path monthly figures with Selling Guide citations and
 *    the qualifying total. Transparency into a decision already made — never
 *    live math over unverified data (MR-2; Reg N §1014.3(q) — the C2
 *    variant is a recorded binding rejection).
 *  - ANALYZING (any earlier state): an educational payload — which income
 *    sources are under analysis, framed as finding the borrower's full
 *    purchasing power. No figures, no candidacy signals, no recommendations.
 *
 * Strict whitelist in the borrowerOfferView pattern. The raw evaluation row
 * and path payloads carry calculator prose (notes[]), internal gate codes
 * (unavailableReason), triage state (requiresManualReview), and method
 * recommendations (recommendedPathId/-Reason — steering) that never reach a
 * borrower payload.
 */
import {
  incomePathsSchema,
  sumAppliedIncome,
  type IncomePathId,
  type IncomePathResult,
  roundCents,
} from "./incomePaths";

/** Counsel-review item (memo §5): shown under the available breakdown. */
export const BORROWER_INCOME_DISCLAIMER =
  "This summary shows how your verified income was calculated for qualification purposes. " +
  "It is not a commitment to lend and not a Loan Estimate; final loan terms are " +
  "determined at underwriting and closing.";

/** Counsel-review item (memo §5): the educational pre-decision framing. */
export const INCOME_ANALYSIS_EDUCATION =
  "We're analyzing your full income picture to find your full purchasing power. " +
  "Complex income — business returns, rental properties, multiple entities — is our " +
  "specialty, and a careful analysis often supports more than a quick look suggests.";

/** Borrower-friendly source labels — path ids are internal vocabulary. */
export const INCOME_SOURCE_LABELS: Record<IncomePathId, string> = {
  agency_wage: "Employment income",
  self_employment: "Business & self-employment income",
  capital_gains: "Capital gains income",
  employment_related_assets: "Employment-related asset income",
  rental: "Rental income",
  dscr: "Investment-property cash flow",
  bank_statement: "Bank-statement income",
};

/** Counsel-review item (memo §5): shown in place of the itemisation when an
 *  older evaluation cannot be reconciled. Saying so is the honest option; the
 *  alternative — rows that do not sum to the total above them — is the defect
 *  the applied-amount split exists to remove. */
export const BORROWER_INCOME_BREAKDOWN_UNAVAILABLE =
  "A line-by-line breakdown isn't available for this analysis. Your loan officer can walk you through how each source was counted.";

export interface BorrowerIncomePathView {
  pathId: IncomePathId;
  label: string;
  /**
   * What this source CONTRIBUTED to the qualifying total — never what it is
   * notionally worth. The rows sum to totalMonthlyQualifyingIncome exactly.
   */
  monthlyIncomeApplied: number;
  /**
   * What this source contributed to monthly DEBTS instead (a rental loss under
   * B3-3.8-01, always ≥ 0). Shown separately because it is not income, and
   * because a borrower whose rental ran a loss is owed the reason their total
   * is lower than their rent roll suggests.
   */
  monthlyObligationApplied: number;
  /** Selling Guide citations — {doc, section} pairs, safe by construction. */
  citations: Array<{ doc: string; section: string }>;
}

export interface BorrowerIncomeSummaryAvailable {
  available: true;
  evaluatedAt: Date | string;
  incomeBasis: string;
  totalMonthlyQualifyingIncome: number;
  /**
   * Empty when the evaluation predates the applied-amount split and cannot be
   * itemised — read `breakdownAvailable`, never `paths.length`, so the two can
   * never be confused with "this borrower has no income sources".
   */
  paths: BorrowerIncomePathView[];
  /** False ⇒ render the total and `breakdownUnavailable`, not the rows. */
  breakdownAvailable: boolean;
  breakdownUnavailable?: string;
  disclaimer: string;
}

export interface BorrowerIncomeSummaryAnalyzing {
  available: false;
  state: "analyzing";
  /** Friendly labels only — derived from evidence-bearing paths. */
  sourcesUnderReview: string[];
  education: string;
}

export type BorrowerIncomeSummary =
  | BorrowerIncomeSummaryAvailable
  | BorrowerIncomeSummaryAnalyzing;

/** Parse a persisted paths jsonb; null when absent or off-contract. */
export function parsePersistedPaths(paths: unknown): IncomePathResult[] | null {
  if (!paths) return null;
  const parsed = incomePathsSchema.safeParse(paths);
  return parsed.success ? parsed.data : null;
}

export function toBorrowerIncomeAvailableView(evaluation: {
  createdAt: Date | string;
  incomeBasis: string;
  primaryMonthlyQualifyingIncome: string | number;
  paths: IncomePathResult[];
}): BorrowerIncomeSummaryAvailable {
  const total = roundCents(Number(evaluation.primaryMonthlyQualifyingIncome));

  // A row is what a source CONTRIBUTED, so the itemisation adds up by
  // construction: a rental portfolio's positive offsets are the income line and
  // its losses are the debt line (never one netted figure badged "counted"),
  // the subject property's unit rent rides on the rental row it belongs to, and
  // an alternative METHOD that fed nothing into this total shows no figure at
  // all (showing one would be steering — the same reason recommendedPathId is
  // stripped).
  // An evaluation persisted before the split carries no contributed amounts. It
  // still had a convention — a path's whole figure counted iff appliedToDti —
  // and for a wage-and-salary file that convention was already right, so the
  // breakdown is recoverable. It is exactly WRONG for the cases this change
  // exists for (a split rental portfolio, a subject property's unit rent), and
  // those are precisely the ones where the reconstruction fails to reach the
  // persisted total. So reconstruct, then check: the total is the referee.
  const legacy = (p: Extract<IncomePathResult, { kind: "dti_income" }>) =>
    p.appliedToDti && p.status === "applicable" ? roundCents(p.monthlyQualifyingIncome) : 0;

  const dtiPaths = evaluation.paths.filter(
    (p): p is Extract<IncomePathResult, { kind: "dti_income" }> => p.kind === "dti_income",
  );

  const applied = sumAppliedIncome(evaluation.paths);
  const reconstructed =
    applied === null
      ? roundCents(dtiPaths.reduce((sum, p) => sum + legacy(p), 0))
      : applied;

  // Reconcile against the persisted total rather than trusting the rows: a
  // partial breakdown under a full total is the disagreement being removed, and
  // it is worse than no breakdown because it looks complete.
  const breakdownAvailable = reconstructed === total;

  const rows: BorrowerIncomePathView[] = dtiPaths
    .map((p) => ({
      pathId: p.pathId,
      label: INCOME_SOURCE_LABELS[p.pathId],
      monthlyIncomeApplied: roundCents(p.appliedMonthlyIncome ?? legacy(p)),
      monthlyObligationApplied: roundCents(p.appliedMonthlyObligation ?? 0),
      citations: p.citations.map((c) => ({ doc: c.doc, section: c.section })),
    }))
    .filter((r) => r.monthlyIncomeApplied !== 0 || r.monthlyObligationApplied !== 0);

  return {
    available: true,
    evaluatedAt: evaluation.createdAt,
    incomeBasis: evaluation.incomeBasis,
    totalMonthlyQualifyingIncome: total,
    paths: breakdownAvailable ? rows : [],
    breakdownAvailable,
    ...(breakdownAvailable ? {} : { breakdownUnavailable: BORROWER_INCOME_BREAKDOWN_UNAVAILABLE }),
    disclaimer: BORROWER_INCOME_DISCLAIMER,
  };
}

export function toBorrowerIncomeAnalyzingView(
  paths: IncomePathResult[] | null,
): BorrowerIncomeSummaryAnalyzing {
  // Evidence-bearing paths only ("applicable" computed, "unavailable" gated);
  // "not_indicated" means no evidence in the file. Labels, never figures.
  const sourcesUnderReview = (paths ?? [])
    .filter((p) => p.status !== "not_indicated")
    .map((p) => INCOME_SOURCE_LABELS[p.pathId]);
  return {
    available: false,
    state: "analyzing",
    sourcesUnderReview,
    education: INCOME_ANALYSIS_EDUCATION,
  };
}
