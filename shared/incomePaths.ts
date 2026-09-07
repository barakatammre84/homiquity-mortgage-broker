import { z } from "zod";

/**
 * Multi-path income orchestrator — the shared envelope (UAL program P3).
 *
 * The industry norm computes income down ONE path and fails at the first
 * guideline it misses. We compute every applicable path in one deterministic
 * pass and describe them all, so the LO sees the whole picture and the
 * highest qualifying path surfaces.
 *
 * Two kinds of path, deliberately not comparable as one number:
 *   - "dti_income": a monthly qualifying-income figure that feeds DTI
 *     (agency wage, self-employment, rental, bank-statement).
 *   - "coverage_ratio": property-level qualification with NO personal DTI
 *     (DSCR). It ranks separately and never competes with an income number.
 *
 * Two roles a path can play:
 *   - "component": additive parts of the standard full-doc income
 *     (agency wage + self-employment + rental all stack).
 *   - "alternative": a competing qualification METHOD (bank-statement, DSCR)
 *     the borrower could use INSTEAD of full-doc.
 *
 * Doctrine: this is deterministic, cited math (L2 I2). A path with no in-repo
 * authority is hard-blocked ("unavailable") and returns NO figure — never a
 * guessed number. Nothing here is an underwriting decision; the deterministic
 * engine consumes the primary figure, a human confirms self-employment and
 * any flagged path (MR-2 / L2 I1).
 */

export const INCOME_PATH_IDS = [
  "agency_wage",
  "self_employment",
  "rental",
  "dscr",
  "bank_statement",
] as const;
export type IncomePathId = (typeof INCOME_PATH_IDS)[number];

export type IncomePathKind = "dti_income" | "coverage_ratio";
export type IncomePathRole = "component" | "alternative";

/**
 * - applicable: evidence exists and the figure was computed.
 * - not_indicated: no evidence for this path in the file.
 * - unavailable: the path exists but its qualification math is gated
 *   (e.g. the lender program reference is not yet in-repo — P4).
 */
export type IncomePathStatus = "applicable" | "not_indicated" | "unavailable";

export interface IncomePathCitation {
  doc: string;
  section: string;
}

interface IncomePathCommon {
  pathId: IncomePathId;
  role: IncomePathRole;
  status: IncomePathStatus;
  citations: IncomePathCitation[];
  requiresManualReview: boolean;
  /** Reason code when status = "unavailable" (e.g. PROGRAM_REFERENCE_NOT_IN_REPO). */
  unavailableReason?: string;
  /** Borrower-supplied facts still required before this path can be decisioned. */
  missingItems?: string[];
  notes: string[];
}

export interface DtiIncomePathResult extends IncomePathCommon {
  kind: "dti_income";
  /** Monthly qualifying income (0 when not_indicated/unavailable). Never negative for wage/SE; rental may be a net drag. */
  monthlyQualifyingIncome: number;
  /** Whether this figure is summed into the primary DTI income fed to the engine. */
  appliedToDti: boolean;
  /**
   * What this path actually CONTRIBUTED to primaryMonthlyQualifyingIncome —
   * which is not always what it is worth. Rental is the case that forced the
   * field: B3-3.8-01 is applied per property, so a portfolio's positive
   * offsets join qualifying income while its losses go to the obligation side,
   * and `monthlyQualifyingIncome` carries the informational NET of the two.
   * A surface that itemises the qualifying total must add up, so it reads this.
   *
   * Optional because evaluations persisted before this field existed omit it:
   * a reader that cannot reconcile a legacy row must say so rather than render
   * a breakdown that does not sum (see sumAppliedIncome).
   */
  appliedMonthlyIncome?: number;
  /**
   * What this path contributed to MONTHLY OBLIGATIONS — the other half of the
   * per-property split (B3-3.8-01 rental losses, always ≥ 0). Never negative
   * income, and never netted against the income side.
   */
  appliedMonthlyObligation?: number;
}

export interface CoverageRatioPathResult extends IncomePathCommon {
  kind: "coverage_ratio";
  /** Debt-service coverage ratio (null when not computed/unavailable). */
  coverageRatio: number | null;
}

export type IncomePathResult = DtiIncomePathResult | CoverageRatioPathResult;

export interface IncomeOrchestrationResult {
  paths: IncomePathResult[];
  /** The full-doc DTI income fed to the underwriting engine = sum of applied component paths. */
  primaryMonthlyQualifyingIncome: number;
  primaryBreakdown: {
    /** Agency stable base income (W-2 base + rolled-up totals). */
    agencyBase: number;
    /** Agency variable income (overtime/bonus/commission/other + other-income sources). */
    agencyVariable: number;
    selfEmployment: number;
    /** Net non-subject rental offset as computed (may be negative; informational). */
    rental: number;
    /** Positive net rental offset applied to qualifying income (B3-3.8-01; 0 unless applied). */
    rentalIncomeApplied: number;
    /** Net rental LOSS applied to monthly obligations by the decision engine (≥ 0; B3-3.8-01). */
    rentalLiabilityApplied: number;
    /** Subject-property (2–4 unit owner-occupied) qualifying rent added to income — never netted against the subject PITIA (B3-3.8-01). */
    subjectRentalIncomeApplied: number;
  };
  /**
   * Highest-qualifying-income METHOD among the standard full-doc total and any
   * ENABLED alternative. Null while all alternatives are gated (the honest
   * current state: only full-doc is executable).
   */
  recommendedPathId: IncomePathId | null;
  recommendationReason: string;
  requiresManualReview: boolean;
  incomeBasis: "urla_line_items" | "application_summary";
}

const isFiniteNumber = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Round to whole cents; the canonical form used inside fingerprints. */
export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Parse a captured financial figure to a number, matching the instant-decision
 * engine's parser exactly (decisionEngine.toNumber): strips commas/$/spaces and
 * reads accounting-format parenthesized negatives ("(21,400)" → -21400). A K-1
 * loss captured this way must net against income, never be dropped. Returns NaN
 * when unparseable.
 */
export function parseFinancialNumber(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  let s = String(v).trim().replace(/[,$\s]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return negative ? -n : n;
}

/** True when a value is present and parses to a real number (incl. negatives). */
export function isPresentFinancialNumber(v: unknown): boolean {
  if (v === null || v === undefined || String(v).trim() === "") return false;
  return !isNaN(parseFinancialNumber(v));
}

// --- Zod validation for the persisted `paths` jsonb --------------------------
const citationSchema = z.object({ doc: z.string(), section: z.string() });
const commonShape = {
  pathId: z.enum(INCOME_PATH_IDS),
  role: z.enum(["component", "alternative"]),
  status: z.enum(["applicable", "not_indicated", "unavailable"]),
  citations: z.array(citationSchema),
  requiresManualReview: z.boolean(),
  unavailableReason: z.string().optional(),
  missingItems: z.array(z.string()).optional(),
  notes: z.array(z.string()),
};
const dtiPathSchema = z.object({
  ...commonShape,
  kind: z.literal("dti_income"),
  monthlyQualifyingIncome: z.number(),
  appliedToDti: z.boolean(),
  // Optional on purpose: rows persisted before the applied-amount split parse
  // unchanged. New evaluations always carry both.
  appliedMonthlyIncome: z.number().optional(),
  appliedMonthlyObligation: z.number().optional(),
});
const coveragePathSchema = z.object({
  ...commonShape,
  kind: z.literal("coverage_ratio"),
  coverageRatio: z.number().nullable(),
});
export const incomePathResultSchema = z.discriminatedUnion("kind", [dtiPathSchema, coveragePathSchema]);
export const incomePathsSchema = z.array(incomePathResultSchema);

/**
 * Canonical, order-independent fingerprint input for a set of path results.
 * Same paths → same string → same SHA-256 (mirrors the underwriting engine's
 * ResolvedPolicy fingerprint discipline).
 */
export function canonicalizePaths(paths: IncomePathResult[]): string {
  const rows = paths
    .map((p) => {
      const base = {
        id: p.pathId,
        s: p.status,
        r: p.role,
        mr: p.requiresManualReview,
        mi: [...(p.missingItems ?? [])].sort(),
      };
      if (p.kind === "dti_income") {
        return {
          ...base,
          k: "d",
          v: roundCents(p.monthlyQualifyingIncome),
          a: p.appliedToDti,
          // The contributed amount is part of the result's identity: two files
          // can share a net rental figure and contribute different amounts.
          ai: p.appliedMonthlyIncome === undefined ? null : roundCents(p.appliedMonthlyIncome),
          ao: p.appliedMonthlyObligation === undefined ? null : roundCents(p.appliedMonthlyObligation),
        };
      }
      return {
        ...base,
        k: "c",
        v: isFiniteNumber(p.coverageRatio) ? Math.round(p.coverageRatio * 1e4) / 1e4 : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(rows);
}

/**
 * Σ of what the component paths contributed to qualifying income — the number
 * an itemised breakdown must equal.
 *
 * Returns null when ANY dti path that carries a figure omits
 * `appliedMonthlyIncome` (an evaluation persisted before the split existed).
 * Null means "this row cannot be itemised", never "zero": a caller that
 * silently coerced it would render exactly the breakdown-that-does-not-add-up
 * this field was added to remove.
 */
export function sumAppliedIncome(paths: IncomePathResult[]): number | null {
  let total = 0;
  for (const p of paths) {
    if (p.kind !== "dti_income") continue;
    if (p.appliedMonthlyIncome === undefined) {
      // A path with no evidence contributed nothing; only a path that could
      // have contributed makes the set unreconcilable.
      if (p.status === "not_indicated") continue;
      return null;
    }
    total += p.appliedMonthlyIncome;
  }
  return roundCents(total);
}
