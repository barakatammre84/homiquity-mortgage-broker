/**
 * The liability vocabulary the URLA Section 2c picker writes, and the one
 * classifier every reader shares.
 *
 * The column behind the picker (`urla_liabilities.liability_type`) is a
 * free-text varchar that stores the picker's LABEL verbatim — "Revolving
 * (Credit Card)", "Installment (Auto Loan)". Before this module, the engine
 * normalised those labels with a snake_case mapper written for a vocabulary
 * the picker never emits ("credit_card"), so its B3-6-05 revolving branch was
 * dead for every real row while its tests — fed "credit_card" — stayed green.
 * Same class as the B3-6-07 branch that an `installment` type could never
 * reach, and the same fix as INCOME_SOURCES → shared/incomeTypes.ts: the list
 * lives where the server can read what the picker writes. (A second, snake_case
 * LIABILITY_TYPES exists in shared/schema/underwritingFinancials.ts for the staff
 * `liabilities` table — a different table; `liabilityKind` reads both.)
 *
 * `liabilityKind` accepts the picker's labels AND the snake_case synonyms a
 * credit-report tradeline or an older row may carry, so one classifier serves
 * the form, the engine, the pre-underwriting flags and the MISMO export.
 */
export const URLA_LIABILITY_TYPES = [
  "Revolving (Credit Card)",
  "Open 30-day charge account",
  "Lease",
  "Installment (Auto Loan)",
  "Student Loan",
  "Mortgage",
  "HELOC",
  "Alimony",
  "Child Support",
  "Other",
] as const;

export type UrlaLiabilityTypeLabel = (typeof URLA_LIABILITY_TYPES)[number];

export type LiabilityKind =
  | "revolving"
  | "open_30_day"
  | "installment"
  | "student_loan"
  | "mortgage"
  | "heloc"
  | "lease"
  | "alimony"
  | "child_support"
  | "other";

export const STUDENT_LOAN_REPAYMENT_PLANS = [
  "income_driven",
  "deferred",
  "forbearance",
  "standard",
  "other",
] as const;

export function liabilityKind(raw: string | null | undefined): LiabilityKind {
  const t = (raw ?? "").toLowerCase().trim();
  if (!t) return "other";
  // Secured by real estate first: "home equity line of credit" must not fall
  // into the revolving bucket on "line of credit".
  if (/heloc|home\s*equity/.test(t)) return "heloc";
  if (/mortgage/.test(t)) return "mortgage";
  if (/student/.test(t)) return "student_loan";
  if (/open\s*_?30\s*[-–—]?\s*day|30\s*[-–—]?\s*day\s*charge/.test(t)) return "open_30_day";
  if (/revolv|credit\s*_?card|charge\s*_?card|line\s*_?of\s*_?credit/.test(t)) return "revolving";
  if (/install|auto|car\s*loan|personal\s*_?loan/.test(t)) return "installment";
  if (/lease/.test(t)) return "lease";
  if (/alimony/.test(t)) return "alimony";
  if (/child\s*_?support|separate\s*_?maintenance/.test(t)) return "child_support";
  return "other";
}

/**
 * "Mortgage debt" in the sense of B3-6-05, Debts Paid by Others: a liability
 * secured by real estate, whose exclusion carries the three extra conditions
 * (payer obligated, no 12-month delinquency, no rental income from the
 * property). HELOCs are equity lines secured by real estate — B3-6-05 routes
 * them into the housing expense, not the revolving bucket.
 */
export function isMortgageClassLiability(raw: string | null | undefined): boolean {
  const kind = liabilityKind(raw);
  return kind === "mortgage" || kind === "heloc";
}
