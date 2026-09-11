/**
 * Other-income type catalog — the shared vocabulary for URLA Section 1e.
 *
 * The cross-cutting B3-3.1-01 rules no longer depend on this catalog. URLA
 * captures tax treatment, the non-taxable amount, defined expiration and
 * virtual-currency payment for every source. The deterministic agency-income
 * path excludes virtual-currency income, removes income that will not continue
 * for three years from the expected note date, and applies the documented 25%
 * non-taxable adjustment only through a current approved income workpaper.
 *
 * `qualifyingAuthority` remains type-specific. A null value means Homiquity has
 * no in-repo rule for that income family's own history, document and calculation
 * method; it does not disable the cross-cutting safety rules above. Any future
 * citation must name a tracked file and ship with the calculator that consumes
 * it. `tests/incomeTypes.test.ts` enforces that boundary.
 */

export const OTHER_INCOME_TYPE_IDS = [
  "alimony",
  "child_support",
  "interest_and_dividends",
  "notes_receivable",
  "royalty_payments",
  "unemployment_benefits",
  "automobile_allowance",
  "disability",
  "mortgage_credit_certificate",
  "public_assistance",
  "retirement",
  "social_security",
  "boarder_income",
  "foster_care",
  "housing_or_parsonage",
  "separate_maintenance",
  "trust",
  "va_compensation",
  "capital_gains",
  "other",
] as const;

export type OtherIncomeTypeId = (typeof OTHER_INCOME_TYPE_IDS)[number];

/** An in-repo authority for how an income type qualifies. Never a URL, never a memory. */
export interface IncomeTypeCitation {
  /** Repo-relative path to a document that exists on disk. */
  doc: string;
  /** The section within it, e.g. "B3-3.1-09". */
  section: string;
}

export interface OtherIncomeTypeDefinition {
  id: OtherIncomeTypeId;
  /**
   * The EXACT string the URLA picker writes and `other_income_sources.income_source`
   * stores. Changing one of these orphans every row already written with the old
   * text, so treat it as data, not copy — `classifyOtherIncomeSource` is the only
   * safe way to read the column, and the drift test pins this list.
   */
  label: string;
  /**
   * In-repo authority for this type's qualifying treatment (gross-up eligibility,
   * continuance requirement, history requirement). `null` means NOT IN REPO: the
   * declared amount is used at face value and the fact is surfaced, never adjusted
   * by a guessed factor.
   */
  qualifyingAuthority: IncomeTypeCitation | null;
}

export const OTHER_INCOME_TYPES: readonly OtherIncomeTypeDefinition[] = [
  { id: "alimony", label: "Alimony", qualifyingAuthority: null },
  { id: "child_support", label: "Child Support", qualifyingAuthority: null },
  { id: "interest_and_dividends", label: "Interest and Dividends", qualifyingAuthority: null },
  { id: "notes_receivable", label: "Notes Receivable", qualifyingAuthority: null },
  { id: "royalty_payments", label: "Royalty Payments", qualifyingAuthority: null },
  { id: "unemployment_benefits", label: "Unemployment Benefits", qualifyingAuthority: null },
  { id: "automobile_allowance", label: "Automobile Allowance", qualifyingAuthority: null },
  { id: "disability", label: "Disability", qualifyingAuthority: null },
  { id: "mortgage_credit_certificate", label: "Mortgage Credit Certificate", qualifyingAuthority: null },
  { id: "public_assistance", label: "Public Assistance", qualifyingAuthority: null },
  { id: "retirement", label: "Retirement (e.g., Pension, IRA)", qualifyingAuthority: null },
  { id: "social_security", label: "Social Security", qualifyingAuthority: null },
  { id: "boarder_income", label: "Boarder Income", qualifyingAuthority: null },
  { id: "foster_care", label: "Foster Care", qualifyingAuthority: null },
  { id: "housing_or_parsonage", label: "Housing or Parsonage", qualifyingAuthority: null },
  { id: "separate_maintenance", label: "Separate Maintenance", qualifyingAuthority: null },
  { id: "trust", label: "Trust", qualifyingAuthority: null },
  { id: "va_compensation", label: "VA Compensation", qualifyingAuthority: null },
  { id: "capital_gains", label: "Capital Gains", qualifyingAuthority: null },
  { id: "other", label: "Other", qualifyingAuthority: null },
];

/**
 * The picker's options, in the order the borrower sees them. The URLA select
 * renders this rather than its own list, so the stored strings and the catalog
 * cannot drift apart — they are now the same array.
 */
export const OTHER_INCOME_LABELS: readonly string[] = OTHER_INCOME_TYPES.map((t) => t.label);

const BY_ID = new Map<OtherIncomeTypeId, OtherIncomeTypeDefinition>(
  OTHER_INCOME_TYPES.map((t) => [t.id, t]),
);

/**
 * Normalised only for whitespace and case — deliberately NOT fuzzy. A stored
 * value that does not match a known label returns `null` and is reported as
 * unclassified, because guessing which benefit a borrower meant is exactly the
 * kind of invention this repo refuses everywhere else.
 */
function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const BY_NORMALISED_LABEL = new Map<string, OtherIncomeTypeId>(
  OTHER_INCOME_TYPES.map((t) => [normalise(t.label), t.id]),
);

/**
 * Read the free-text `other_income_sources.income_source` column as a type.
 * Returns `null` for anything unrecognised — including rows written before this
 * catalog existed with text that no longer matches a picker option.
 */
export function classifyOtherIncomeSource(stored: string | null | undefined): OtherIncomeTypeId | null {
  if (typeof stored !== "string") return null;
  const trimmed = stored.trim();
  if (trimmed === "") return null;
  return BY_NORMALISED_LABEL.get(normalise(trimmed)) ?? null;
}

export function otherIncomeTypeDefinition(id: OtherIncomeTypeId): OtherIncomeTypeDefinition {
  const found = BY_ID.get(id);
  // Unreachable while the id is typed; a runtime guard for values crossing the wire.
  if (!found) throw new Error(`Unknown other-income type id: ${id}`);
  return found;
}

export function otherIncomeTypeLabel(id: OtherIncomeTypeId): string {
  return otherIncomeTypeDefinition(id).label;
}

/**
 * True when this type's qualifying treatment has no in-repo authority — i.e. the
 * amount is being used exactly as declared because no cited rule says otherwise.
 * Today that is every type; see the module docstring for why that is the honest
 * state and what changes it.
 */
export function hasUncitedQualifyingTreatment(id: OtherIncomeTypeId): boolean {
  return otherIncomeTypeDefinition(id).qualifyingAuthority === null;
}
