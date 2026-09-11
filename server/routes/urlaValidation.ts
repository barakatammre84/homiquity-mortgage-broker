import { z } from "zod";
import { getTableColumns, type Table } from "drizzle-orm";
import {
  urlaPersonalInfo,
  employmentHistory,
  otherIncomeSources,
  urlaAssets,
  urlaLiabilities,
  urlaPropertyInfo,
  borrowerDeclarations,
  hmdaDemographics,
} from "@shared/schema";

// =============================================================================
// URLA WRITE-BODY SANITIZATION
//
// The URLA endpoints previously spread raw `req.body` into storage calls, which
// allowed mass-assignment of any column and accepted arbitrarily malformed
// values into regulated borrower records. Every URLA write now goes through
// pickTableFields(): unknown keys are dropped, server-managed keys are always
// stripped, values must be scalars (URLA tables are scalar-only), and identity
// fields get format validation on top.
// =============================================================================

/** Keys the client must never set — server-managed or set from the route. */
const SERVER_MANAGED_KEYS = new Set([
  "id",
  "applicationId",
  "borrowerId",
  "collectionMethod",
  "createdAt",
  "updatedAt",
  // A borrower may supply the underlying liability facts, but only the
  // financial-review route may apply a borrower-favorable underwriting
  // treatment and bind it to accepted evidence/current bureau data.
  "underwritingTreatment",
  "treatmentSourceDocumentId",
  "treatmentCreditPullId",
  "treatmentTradelineIndex",
  "treatmentReviewedBy",
  "treatmentReviewedAt",
]);

/** Sanity cap for any single string value; varchar columns are far shorter. */
const MAX_STRING_LENGTH = 2000;

/**
 * Whitelist `body` down to the given table's columns (minus server-managed
 * ones), keeping only scalar values. `extraKeys` admits virtual fields that
 * are handled by the storage layer rather than stored as-is (e.g. a write-only
 * plaintext SSN that the storage layer encrypts).
 */
export function pickTableFields(
  table: Table,
  body: unknown,
  extraKeys: string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!body || typeof body !== "object" || Array.isArray(body)) return out;
  const source = body as Record<string, unknown>;
  const allowed = new Set([...Object.keys(getTableColumns(table)), ...extraKeys]);

  for (const key of allowed) {
    if (SERVER_MANAGED_KEYS.has(key)) continue;
    // Encrypted-at-rest columns and their derived last4 fragments are computed
    // by the storage layer (piiVault) — never accepted from the client.
    if (/(Encrypted|Iv|KeyId|Last4)$/.test(key)) continue;
    if (!(key in source)) continue;
    const value = source[key];
    if (value === null || value === undefined) {
      out[key] = value;
    } else if (typeof value === "string") {
      if (value.length <= MAX_STRING_LENGTH) out[key] = value;
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    }
    // objects/arrays are dropped — URLA tables have no JSON columns
  }
  return out;
}

// Treat blank and database-null values as "not provided". The edit form sends
// a previously saved partial row back as a whole, and nullable DB columns come
// back as null; rejecting that round-trip prevents every later section save.
const optionalTrimmed = (schema: z.ZodTypeAny) =>
  z.preprocess(
    (v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
    schema.optional(),
  );

/**
 * Format checks for the identity fields on URLA Section 1a. Applied after
 * pickTableFields, so unknown keys are already gone; passthrough keeps the
 * rest of the whitelisted fields.
 *
 * SSN is intentionally NOT validated here — it is validated and encrypted in
 * the storage layer by ssnVault.resolveSsnInput, which also recognises a masked
 * echo (XXX-XX-1234) as "unchanged". Validating the format here would wrongly
 * reject that masked round-trip from an edit form.
 */
export const personalInfoFieldChecks = z
  .object({
    dateOfBirth: optionalTrimmed(
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date of birth must be YYYY-MM-DD"),
    ),
    email: optionalTrimmed(z.string().email().max(255)),
  })
  .passthrough();

export const URLA_TABLES = {
  personalInfo: urlaPersonalInfo,
  employment: employmentHistory,
  otherIncome: otherIncomeSources,
  asset: urlaAssets,
  liability: urlaLiabilities,
  propertyInfo: urlaPropertyInfo,
  declarations: borrowerDeclarations,
  demographics: hmdaDemographics,
} as const;

/**
 * Sanitize a personal-info body: whitelist to table columns (plus the
 * write-only `ssn` virtual field) and validate identity field formats.
 * Returns the cleaned body or a validation error message.
 */
export function sanitizePersonalInfoBody(
  body: unknown,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const picked = pickTableFields(urlaPersonalInfo, body, ["ssn"]);
  const checked = personalInfoFieldChecks.safeParse(picked);
  if (!checked.success) {
    const first = checked.error.issues[0];
    return { ok: false, error: `${first.path.join(".")}: ${first.message}` };
  }
  return { ok: true, data: checked.data as Record<string, unknown> };
}
