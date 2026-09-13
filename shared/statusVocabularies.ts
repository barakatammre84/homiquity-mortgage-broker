// Closed value vocabularies shared by client and server — statuses, and the
// loan-product enumerations that travel with them.
//
// WHY THESE ARE NOT BESIDE THEIR TABLES
//
// Each is imported by the CLIENT as a runtime value (RateLockDialog,
// LoanPipeline, PreApprovalLetterCard). While they sat in a module that also
// declares pgTable(...), importing one dragged all 174 Drizzle table
// definitions into the public browser bundle — pgTable() is side-effecting, so
// tree-shaking cannot drop it.
//
// This module declares NO table and imports nothing. Keep it that way.
// The schema modules import these back and re-export them, so `@shared/schema`
// consumers and every server import are unchanged.


/**
 * The ONLY statuses `rateLocks.status` may hold. Expiry is computed from
 * `expiresAt`, not stored — an expired lock keeps its last status, so "open"
 * checks must pair OPEN_RATE_LOCK_STATUSES with an `expiresAt` comparison
 * where staleness matters.
 */
export const RATE_LOCK_STATUSES = ["active", "extended", "cancelled"] as const;
export type RateLockStatus = (typeof RATE_LOCK_STATUSES)[number];

/** A live lock: "extended" is still open — only cancellation closes one. */
export const OPEN_RATE_LOCK_STATUSES: readonly RateLockStatus[] = ["active", "extended"];
/**
 * The ONLY statuses `loanConditions.status` may hold. Lifecycle:
 * "outstanding" (issued / reopened) → "submitted" (a borrower upload matched —
 * pipelineEngine) → "cleared" / "waived" / "not_applicable" (staff verdicts,
 * role-gated in server/routes/underwriting/pipeline.ts).
 */
export const LOAN_CONDITION_STATUSES = [
  "outstanding",
  "submitted",
  "cleared",
  "waived",
  "not_applicable",
] as const;
export type LoanConditionStatus = (typeof LOAN_CONDITION_STATUSES)[number];

/**
 * Verdict statuses — the condition no longer needs work. Everything outside
 * this set ("outstanding", "submitted") counts as open; readiness gates and
 * open-condition counts must derive from this so the two can't diverge.
 */
export const SETTLED_CONDITION_STATUSES: readonly LoanConditionStatus[] = [
  "cleared",
  "waived",
  "not_applicable",
];

/**
 * Which staff roles may set each condition verdict — the single source both
 * sides read. The server route (server/routes/underwriting/pipeline.ts) had
 * these as three inline literals while ConditionsTab rendered Clear/Waive/N-A
 * for every staff role, so an LO was offered all three buttons and 403'd on
 * each (2026-08-23 walk record, GATES). Hoisting the lists here lets the UI
 * render only what the server permits without either side widening: the
 * values are the route's literals verbatim.
 */
export const CONDITION_VERDICT_ROLES = {
  cleared: ["admin", "underwriter", "processor", "closer"],
  waived: ["admin", "underwriter"],
  not_applicable: ["admin", "underwriter", "processor"],
} as const satisfies Record<string, readonly string[]>;

export type ConditionVerdict = keyof typeof CONDITION_VERDICT_ROLES;

export function canSetConditionVerdict(role: string | undefined, verdict: ConditionVerdict): boolean {
  return role != null && (CONDITION_VERDICT_ROLES[verdict] as readonly string[]).includes(role);
}
export const PRE_APPROVAL_LETTER_STATUS = [
  "draft",
  "issued",
  "stale",
  "superseded",
  "expired",
  "revoked",
] as const;
export type PreApprovalLetterStatus = typeof PRE_APPROVAL_LETTER_STATUS[number];

/**
 * URLA Section 4a vocabulary — loan type and amortization type as the
 * borrower states them (Form 1003 "Loan and Property Information").
 *
 * The value sets are pinned to the MISMO seam and must move in lockstep:
 *   - `preferredLoanType` keys server/mismo.ts mapMortgageType() → ULDD
 *     MortgageType {Conventional, FHA, VA, USDA}, and the VA branches in
 *     server/services/mismoValidation.ts compare the lowercased value "va";
 *   - `amortizationType` is read lowercased by mismoValidation.validateArm
 *     ("adjustable" ⇒ the ARM term fields become required) and mapped to ULDD
 *     LoanAmortizationType {Fixed, AdjustableRate} by
 *     server/services/loanDeliveryReadiness.ts.
 * Never add a value here without extending those mappers first — an unmapped
 * value would fall through to a wrong MISMO enumeration.
 */
export const PREFERRED_LOAN_TYPES = ["conventional", "fha", "va", "usda"] as const;
export type PreferredLoanType = (typeof PREFERRED_LOAN_TYPES)[number];

export const AMORTIZATION_TYPES = ["fixed", "adjustable"] as const;

/** Supported fixed-rate amortization terms carried end-to-end by URLA,
 * payment projection, option generation, evidence workpapers, and MISMO.
 * Lives here, not in the Drizzle schema, so the client can value-import it
 * without pulling the table definitions into the public bundle (#482). */
export const LOAN_TERM_MONTHS = [120, 180, 240, 300, 360] as const;
export type LoanTermMonths = typeof LOAN_TERM_MONTHS[number];
export type AmortizationType = (typeof AMORTIZATION_TYPES)[number];

/** Cost categories on the immutable per-file cost ledger. */
export const LOAN_COST_CATEGORIES = [
  "credit_report",
  "appraisal",
  "avm",
  "verification",
  "aus",
  "title",
  "flood",
  "rate_lock_extension",
  "marketing",
  "other",
] as const;
export type LoanCostCategory = (typeof LOAN_COST_CATEGORIES)[number];
