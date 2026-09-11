import type { Request } from "express";
import type { LoanApplication } from "@shared/schema";
import { loanApplicationIntakeUpdateSchema, pickActiveLoanApplication } from "@shared/schema";
import type { CoachIntakeData } from "./coachTools";
import { storage } from "../storage";
import { logAudit } from "../auditLog";
import { isPrelaunchGated } from "./prelaunchGate";
import { evaluateTridTrigger } from "./trid";
import { attachPlanningDocumentsToApplication } from "./planningDocumentHandoff";

// ---------------------------------------------------------------------------
// Coach → loan-application writeback.
//
// Homi captures self-reported intake in chat (via the record_intake
// tool). This service is the ONLY bridge from that capture into the borrower's
// real records: it normalizes the chat values, validates them with the SAME
// shared schema the funnel PATCH uses (loanApplicationIntakeUpdateSchema — so
// coach and funnel field rules can never drift), and applies them to the
// user's DRAFT application with a visible {applied, skipped} trail.
//
// Compliance posture (AI_GOVERNANCE_POLICY P1 "AI never decides"):
//  - Writes land as `self_reported` provenance on a DRAFT only. This service
//    never touches `financialDataProvenance`, the *Verified flags, `status`,
//    or `tridTriggeredAt`.
//  - Verified dimensions are locked: once income/credit/assets are verified,
//    chat can no longer move the corresponding fields.
//  - Submitted applications are never edited (mirrors the borrower PATCH's
//    409 rule in server/routes/lending.ts).
//  - Creation of a brand-new draft is prelaunch-gated (server/services/
//    prelaunchGate.ts) so the coach cannot become a pre-license intake bypass.
//  - After any successful write we evaluate the TRID six-piece trigger via the
//    trid service — the coach can supply the LAST missing item (e.g. income)
//    on an application whose other pieces came from other write paths, and
//    tests/complianceInvariants.test.ts requires every such path to evaluate
//    the trigger. Only the trid service itself writes `tridTriggeredAt`.
// ---------------------------------------------------------------------------

export type SkipReason =
  | "unchanged"
  | "invalid_value"
  | "unmappable_credit_band"
  | "application_submitted"
  | "verified_locked"
  | "provenance_locked"
  | "prelaunch_gated";

export interface AppliedField {
  field: IntakeFieldName;
  /** Column-typed value that was written (post-normalization). */
  value: string | number | boolean;
}

export interface SkippedField {
  field: IntakeFieldName;
  reason: SkipReason;
}

export interface IntakeMappingResult {
  /** Column-typed values ready for storage.create/updateLoanApplication. */
  applied: Record<string, string | number | boolean>;
  appliedFields: AppliedField[];
  skipped: SkippedField[];
}

export interface CoachSyncResult {
  applicationId: string | null;
  created: boolean;
  applied: AppliedField[];
  skipped: SkippedField[];
}

/** The intake fields the coach may write — nothing else ever reaches the DB. */
export const COACH_WRITABLE_FIELDS = [
  "annualIncome",
  "monthlyDebts",
  "creditScore",
  "employmentType",
  "employmentYears",
  "downPayment",
  "purchasePrice",
  "propertyType",
  "loanPurpose",
  "isVeteran",
  "isFirstTimeBuyer",
] as const;
export type IntakeFieldName = (typeof COACH_WRITABLE_FIELDS)[number];

const MONEY_FIELDS: ReadonlySet<IntakeFieldName> = new Set([
  "annualIncome",
  "monthlyDebts",
  "downPayment",
  "purchasePrice",
]);

const ENUM_FIELDS: Record<string, readonly string[]> = {
  employmentType: ["employed", "self_employed", "retired", "other"],
  propertyType: ["single_family", "condo", "townhouse", "multi_family"],
  loanPurpose: ["purchase", "refinance", "cash_out"],
};

// Verified-dimension locks: once a dimension is document/vendor-verified,
// chat-reported values may no longer move its fields (Tier-3 never overwrites
// verified data — same hierarchy the coach prompt teaches the model).
const VERIFICATION_LOCKS: ReadonlyArray<{
  flag: "incomeVerified" | "creditVerified" | "assetsVerified";
  fields: readonly IntakeFieldName[];
}> = [
  { flag: "incomeVerified", fields: ["annualIncome", "employmentType", "employmentYears"] },
  { flag: "creditVerified", fields: ["creditScore", "monthlyDebts"] },
  { flag: "assetsVerified", fields: ["downPayment"] },
];

/**
 * Normalize a chat-reported money string to plain digits ("$85,000" → "85000",
 * "85k" → "85000", "1.2m" → "1200000"). Returns null when unparseable — the
 * caller records an `invalid_value` skip; we never guess.
 */
export function normalizeMoney(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/[$,\s]/g, "");
  const suffixed = cleaned.match(/^(\d+(?:\.\d+)?)(k|m)$/);
  if (suffixed) {
    const mult = suffixed[2] === "k" ? 1_000 : 1_000_000;
    const n = parseFloat(suffixed[1]) * mult;
    return Number.isFinite(n) ? String(Math.round(n)) : null;
  }
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return cleaned;
}

/** The funnel's credit bands (shared/schema/lending.ts CREDIT_SCORE_BAND_VALUES minus not_sure). */
export const CREDIT_SCORE_BANDS = [760, 720, 680, 640, 600] as const;

/**
 * Map a chat-reported score to the funnel's band vocabulary using FLOOR
 * semantics — the band a score actually belongs to ("745" is in the 720–759
 * band, so "720"), matching how the funnel's ranges read. Nearest-band
 * rounding would promote 745 to "760" and overstate the borrower. Below 600
 * there is no funnel band; we skip rather than fabricate (same no-silent-
 * clamp doctrine as the intake schema).
 */
export function creditScoreToBand(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n) || n < 300 || n > 850) return null;
  for (const band of CREDIT_SCORE_BANDS) {
    if (n >= band) return String(band);
  }
  return null;
}

function skipAll(intake: CoachIntakeData, reason: SkipReason): SkippedField[] {
  return presentFields(intake).map((field) => ({ field, reason }));
}

function presentFields(intake: CoachIntakeData): IntakeFieldName[] {
  return COACH_WRITABLE_FIELDS.filter((f) => {
    const v = (intake as Record<string, unknown>)[f];
    return v !== undefined && v !== null && v !== "";
  });
}

/** Numeric-aware equality between a normalized candidate and the stored column value. */
function valuesEqual(field: IntakeFieldName, candidate: string | boolean, existing: LoanApplication): boolean {
  const current = (existing as Record<string, unknown>)[field];
  if (current === undefined || current === null) return false;
  if (typeof candidate === "boolean") return current === candidate;
  if (MONEY_FIELDS.has(field)) {
    const a = parseFloat(candidate);
    const b = parseFloat(String(current));
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  if (field === "creditScore" || field === "employmentYears") {
    return parseInt(candidate, 10) === parseInt(String(current), 10);
  }
  return String(current) === candidate;
}

/**
 * Pure mapping core (no I/O — unit-testable): chat intake → column-typed
 * values for the draft application, plus the per-field skip trail.
 */
export function mapIntakeToApplicationFields(
  intake: CoachIntakeData,
  existing: LoanApplication | null,
): IntakeMappingResult {
  const skipped: SkippedField[] = [];

  // Defense in depth — the wrapper already refuses non-draft targets, but the
  // pure core enforces the same rules so no future caller can bypass them.
  if (existing && existing.status !== "draft") {
    return { applied: {}, appliedFields: [], skipped: skipAll(intake, "application_submitted") };
  }
  if (existing && existing.financialDataProvenance !== "self_reported") {
    return { applied: {}, appliedFields: [], skipped: skipAll(intake, "provenance_locked") };
  }

  const lockedFields = new Set<IntakeFieldName>();
  if (existing) {
    for (const lock of VERIFICATION_LOCKS) {
      if (existing[lock.flag]) {
        for (const f of lock.fields) lockedFields.add(f);
      }
    }
  }

  // Per-field shape normalization → string/boolean candidates in the wire
  // format the shared schema expects.
  const candidates: Record<string, string | boolean> = {};
  for (const field of presentFields(intake)) {
    if (lockedFields.has(field)) {
      skipped.push({ field, reason: "verified_locked" });
      continue;
    }
    const raw = (intake as Record<string, unknown>)[field];

    let candidate: string | boolean | null;
    if (typeof raw === "boolean") {
      candidate = raw;
    } else if (MONEY_FIELDS.has(field)) {
      candidate = normalizeMoney(String(raw));
    } else if (field === "creditScore") {
      candidate = creditScoreToBand(String(raw));
      if (candidate === null) {
        skipped.push({ field, reason: "unmappable_credit_band" });
        continue;
      }
    } else if (field === "employmentYears") {
      // First numeric token, decimals preserved — a bare digit-strip would
      // corrupt "1.5" into "15". The shared schema floors to an integer.
      const numeric = String(raw).match(/\d+(\.\d+)?/);
      candidate = numeric ? numeric[0] : null;
    } else if (field in ENUM_FIELDS) {
      const v = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
      candidate = ENUM_FIELDS[field].includes(v) ? v : null;
    } else {
      candidate = String(raw);
    }

    if (candidate === null) {
      skipped.push({ field, reason: "invalid_value" });
      continue;
    }
    if (existing && valuesEqual(field, candidate, existing)) {
      skipped.push({ field, reason: "unchanged" });
      continue;
    }
    candidates[field] = candidate;
  }

  if (Object.keys(candidates).length === 0) {
    return { applied: {}, appliedFields: [], skipped };
  }

  // Cross-field check support: downPaymentWithinPurchasePrice needs both
  // figures in the same parse. When only one is in play this turn, borrow the
  // stored counterpart for validation only (never re-applied).
  const validationOnly = new Set<string>();
  if (candidates.downPayment !== undefined && candidates.purchasePrice === undefined && existing?.purchasePrice) {
    candidates.purchasePrice = String(existing.purchasePrice);
    validationOnly.add("purchasePrice");
  }
  if (candidates.purchasePrice !== undefined && candidates.downPayment === undefined && existing?.downPayment && !validationOnly.has("purchasePrice")) {
    candidates.downPayment = String(existing.downPayment);
    validationOnly.add("downPayment");
  }

  // Validate with the SAME shared schema the borrower PATCH uses — identical
  // field rules, no silent clamps, values normalized (currency stripped,
  // credit band → integer) by the schema itself. On failure, drop offending
  // keys individually and re-parse so one bad field never blocks the rest.
  let input: Record<string, unknown> = { ...candidates };
  for (let attempt = 0; attempt <= COACH_WRITABLE_FIELDS.length; attempt++) {
    const parsed = loanApplicationIntakeUpdateSchema.safeParse(input);
    if (parsed.success) {
      const applied: Record<string, string | number | boolean> = {};
      const appliedFields: AppliedField[] = [];
      const output = parsed.data as Record<string, unknown>;
      for (const field of COACH_WRITABLE_FIELDS) {
        if (!(field in candidates) || validationOnly.has(field) || !(field in input)) continue;
        const value = output[field];
        if (value === undefined) continue;
        applied[field] = value as string | number | boolean;
        appliedFields.push({ field, value: value as string | number | boolean });
      }
      return { applied, appliedFields, skipped };
    }

    const fieldErrors = parsed.error.flatten().fieldErrors;
    const badKeys = Object.keys(fieldErrors).filter((k) => k in input && !validationOnly.has(k));
    if (badKeys.length === 0) {
      // Non-field (form-level) error we can't attribute — refuse everything
      // rather than guess.
      for (const field of Object.keys(candidates)) {
        if (!validationOnly.has(field)) skipped.push({ field: field as IntakeFieldName, reason: "invalid_value" });
      }
      return { applied: {}, appliedFields: [], skipped };
    }
    for (const key of badKeys) {
      delete input[key];
      skipped.push({ field: key as IntakeFieldName, reason: "invalid_value" });
    }
    if (Object.keys(input).filter((k) => !validationOnly.has(k)).length === 0) {
      return { applied: {}, appliedFields: [], skipped };
    }
  }

  // Unreachable in practice (the loop is bounded by the field count).
  return { applied: {}, appliedFields: [], skipped };
}

/**
 * Persistence wrapper: resolve the target draft (or create one), apply the
 * mapped fields, audit, and evaluate the TRID trigger. Returns the visible
 * trail for the coach UI ("captured" SSE event) and the tool_result the model
 * narrates from.
 */
export async function syncCoachIntakeToApplication(
  req: Request,
  userId: string,
  intake: CoachIntakeData,
  conversationId: string,
): Promise<CoachSyncResult> {
  if (presentFields(intake).length === 0) {
    return { applicationId: null, created: false, applied: [], skipped: [] };
  }

  const applications = await storage.getLoanApplicationsByUser(userId);
  const draft = applications.find((a) => a.status === "draft");

  if (!draft) {
    // An in-flight application exists → its figures change through staff
    // channels, and starting a competing draft from chat would fork the
    // borrower's file. (All-terminal — denied/withdrawn/expired/funded — or
    // no history → a fresh draft is fine; those files are closed, so nothing
    // forks.)
    const inFlight = pickActiveLoanApplication(applications);
    if (inFlight) {
      return {
        applicationId: null,
        created: false,
        applied: [],
        skipped: skipAll(intake, "application_submitted"),
      };
    }
    if (isPrelaunchGated()) {
      // Pre-license: the coach may educate, but must not open an intake
      // surface (same gate as POST /api/loan-applications).
      return { applicationId: null, created: false, applied: [], skipped: skipAll(intake, "prelaunch_gated") };
    }

    const mapping = mapIntakeToApplicationFields(intake, null);
    if (mapping.appliedFields.length === 0) {
      return { applicationId: null, created: false, applied: [], skipped: mapping.skipped };
    }
    const createdApp = await storage.createLoanApplication({ userId, status: "draft" });
    const handoff = await attachPlanningDocumentsToApplication(userId, createdApp.id);
    if (handoff.documents > 0) {
      await logAudit(req, "planning_documents.attached", "loan_application", createdApp.id, handoff);
    }
    await storage.updateLoanApplication(createdApp.id, mapping.applied as Partial<LoanApplication>);
    await afterWrite(req, createdApp.id, mapping, conversationId, true);
    return { applicationId: createdApp.id, created: true, applied: mapping.appliedFields, skipped: mapping.skipped };
  }

  const mapping = mapIntakeToApplicationFields(intake, draft);
  const handoff = await attachPlanningDocumentsToApplication(userId, draft.id);
  if (handoff.documents > 0) {
    await logAudit(req, "planning_documents.attached", "loan_application", draft.id, handoff);
  }
  if (mapping.appliedFields.length === 0) {
    return { applicationId: draft.id, created: false, applied: [], skipped: mapping.skipped };
  }
  await storage.updateLoanApplication(draft.id, mapping.applied as Partial<LoanApplication>);
  await afterWrite(req, draft.id, mapping, conversationId, false);
  return { applicationId: draft.id, created: false, applied: mapping.appliedFields, skipped: mapping.skipped };
}

async function afterWrite(
  req: Request,
  applicationId: string,
  mapping: IntakeMappingResult,
  conversationId: string,
  created: boolean,
): Promise<void> {
  // Field NAMES only in audit metadata — values are borrower financial PII
  // and already live on the application row itself.
  await logAudit(req, "coach.intake_synced", "loan_application", applicationId, {
    fields: mapping.appliedFields.map((f) => f.field),
    skipped: mapping.skipped.length,
    created,
    conversationId,
  });

  // TRID §1026.2(a)(3): this write can supply one of the six items (income,
  // property value, loan amount) — evaluate the Loan Estimate trigger exactly
  // like the borrower PATCH does. Non-fatal: a trigger-evaluation hiccup must
  // not lose the captured data.
  try {
    const trid = await evaluateTridTrigger(applicationId);
    if (trid.justTriggered) {
      logAudit(req, "trid.application_triggered", "loan_application", applicationId, {
        leDueDate: trid.leDueDate?.toISOString(),
        source: "coach_intake_sync",
      });
    }
  } catch (tridErr) {
    console.error("[Coach] TRID trigger evaluation failed (non-fatal):", tridErr);
  }
}
