import { db } from "../db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { loanApplications, situationProfiles, type SituationProfileRow } from "@shared/schema";
import {
  situationProfileSchema,
  type IncomePathSignal,
  type SituationDocumentRequest,
  type SituationFlag,
  type SituationProfile,
} from "@shared/situationProfile";
import { normalizeEntityName } from "@shared/taxFormExtraction";
import { computeHash } from "./encryptionService";
import {
  getLatestInstancesForUser,
  type PublicTaxFormInstance,
} from "./taxDocumentIntelligence";
import { resolveBusinessEntities, type ResolvedEntity } from "./borrowerEntityResolution";
import { runTieOuts, type TieOutCheck } from "./taxReconciliation";
import type { DatabaseTransaction } from "./documentLineage";

/**
 * Situation classifier (UAL P2c) — deterministic rules over the resolved
 * entity set + tie-out results that tell the LO what kind of borrower just
 * uploaded documents, which income paths the file indicates, and which
 * documents are still missing.
 *
 * Discipline:
 * - STRUCTURAL FACTS ONLY. "Two businesses", "a net loss year", "income
 *   declined year-over-year" are facts read off the forms. Whether a decline
 *   disqualifies, whether liquidity is adequate, whether a program fits —
 *   those are the cited calculators' and policy scalars' judgments, and every
 *   flag that borders one says so explicitly.
 * - Income paths are "applicable"/"candidate"/"not_indicated" — never
 *   "eligible". Non-QM paths (DSCR, bank statement) are at most "candidate"
 *   until their lender program references are in-repo (UAL P4 gate).
 * - Document requests cite what in the file makes the document necessary
 *   (a not-evaluable tie-out, a K-1 without its parent return, a single-year
 *   entity), never an uncited guideline.
 */

export interface SituationClassifierInput {
  instances: PublicTaxFormInstance[];
  entities: ResolvedEntity[];
  checks: TieOutCheck[];
  /**
   * UAL P7: borrower-declared intake answer ("financing that avoids
   * interest"). Copied into the profile as a funder-ROUTING signal; part of
   * the inputs fingerprint (a changed answer is a changed situation).
   * Omitted/null = not asked.
   */
  halalNeed?: boolean | null;
}

const num = (i: PublicTaxFormInstance, field: string): number | undefined => {
  const v = i.fields[field]?.value;
  return typeof v === "number" ? v : undefined;
};

/** Latest-year net figure for an entity's primary income form, if readable. */
function latestNet(instances: PublicTaxFormInstance[], entity: ResolvedEntity): number | undefined {
  const forms = instances
    .filter(
      (i) =>
        i.entityName &&
        normalizeEntityName(i.entityName) === (entity.name ? normalizeEntityName(entity.name) : "") &&
        (i.formType === "schedule_c" || i.formType === "business_tax_return_1065" ||
          i.formType === "business_tax_return_1120s"),
    )
    .sort((a, b) => (b.taxYear ?? 0) - (a.taxYear ?? 0));
  for (const f of forms) {
    const v = num(f, f.formType === "schedule_c" ? "netProfitOrLoss" : "ordinaryBusinessIncomeOrLoss");
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Pure classification core — deterministic for a given input. */
export function classifySituation(input: SituationClassifierInput): SituationProfile {
  const { instances, entities, checks } = input;
  const flags: SituationFlag[] = [];
  const documentRequests: SituationDocumentRequest[] = [];

  const taxYears = [...new Set(instances.map((i) => i.taxYear).filter((y): y is number => y !== null))]
    .sort((a, b) => b - a);
  const seEntities = entities.filter((e) =>
    ["sole_proprietorship", "single_member_llc", "partnership", "s_corporation"].includes(e.entityType),
  );

  // --- Flags (structural facts) -------------------------------------------
  if (seEntities.length > 0) {
    flags.push({
      id: "self_employed",
      label: "Self-employed income",
      detail: `${seEntities.length} business entit${seEntities.length === 1 ? "y" : "ies"} with self-employment-type income in the file. Qualifying income is computed only by the cited self-employment calculator from a confirmed worksheet — never from this extraction.`,
      evidence: seEntities.map((e) => `${e.name ?? e.identityKey} (${e.entityType})`),
    });
  }
  if (seEntities.length >= 2) {
    flags.push({
      id: "multi_entity_self_employed",
      label: "Multi-entity self-employed",
      detail: `The borrower's income runs through ${seEntities.length} distinct businesses — the exact file automated retail engines hard-stop on. Each entity needs its own worksheet and document set.`,
      evidence: seEntities.map((e) => e.name ?? e.identityKey),
    });
  }

  const k1s = instances.filter((i) => i.formType === "schedule_k1");
  if (k1s.length > 0) {
    flags.push({
      id: "k1_income_present",
      label: "K-1 pass-through income",
      detail:
        "K-1 income is usable only when distributions or business liquidity support it — that test lives in the cited self-employment calculator (worksheet liquidity inputs); the Schedule L components extracted here can pre-fill it, human-confirmed.",
      evidence: k1s.map((k) => `${k.entityName ?? "K-1"} ${k.taxYear ?? ""}`.trim()),
    });
  }

  const schEs = instances.filter(
    (i) => i.formType === "schedule_e" && (num(i, "rentsReceivedTotal") ?? 0) > 0,
  );
  if (schEs.length > 0) {
    const props = Math.max(...schEs.map((i) => num(i, "propertyCount") ?? 0));
    flags.push({
      id: "rental_income_present",
      label: "Rental real estate income",
      detail: `Schedule E shows rental activity${props > 0 ? ` across ${props} propert${props === 1 ? "y" : "ies"}` : ""}. Rental offsets follow the cited B3-3.8-01 (formerly B3-3.1-08) treatment; a DSCR route is a candidate only (see income paths).`,
      evidence: schEs.map((i) => `schedule_e ${i.taxYear ?? ""}`.trim()),
    });
  }

  const lossEntities = entities.filter((e) => {
    const net = latestNet(instances, e);
    return net !== undefined && net < 0;
  });
  if (lossEntities.length > 0) {
    flags.push({
      id: "business_loss_present",
      label: "Business operating at a loss",
      detail: `${lossEntities.map((e) => e.name).join(", ")} shows a net loss in the latest extracted year — a fact that shapes which paths maximize qualifying income; the loss treatment itself is the cited calculator's judgment.`,
      evidence: lossEntities.map((e) => e.name ?? e.identityKey),
    });
  }

  const declines = checks.filter(
    (c) => c.checkId === "yoy_business_net" && (c.varianceAmount ?? 0) < 0,
  );
  if (declines.length > 0) {
    flags.push({
      id: "business_income_declined_yoy",
      label: "Business income declined year-over-year",
      detail:
        "Net business income is lower than the prior year for at least one entity. Whether that caps or disqualifies the income is the cited self-employment calculator's declining-trend judgment, not this profile's.",
      evidence: declines.map((c) => `${c.entityName ?? "entity"} ${c.taxYear}`),
    });
  }

  const cCorps = entities.filter((e) => e.entityType === "c_corporation");
  if (cCorps.length > 0) {
    flags.push({
      id: "c_corp_owner",
      label: "C-corporation owner",
      detail:
        "C-corp income reaches the borrower as W-2 wages and dividends; the corporate return informs stability, not qualifying income.",
      evidence: cCorps.map((e) => e.name ?? e.identityKey),
    });
  }

  const f1040s = instances.filter((i) => i.formType === "tax_return_1040");
  const hasWages =
    f1040s.some((i) => (num(i, "wagesSalariesTips") ?? 0) > 0) ||
    instances.some((i) => i.formType === "w2");
  if (hasWages) {
    flags.push({
      id: "w2_income_present",
      label: "W-2 wage income",
      detail: "Wage income is present alongside any business income.",
      evidence: f1040s.map((i) => `tax_return_1040 ${i.taxYear ?? ""}`.trim()),
    });
  }

  const hasCapitalGains = instances.some(
    (i) =>
      (i.formType === "tax_return_1040" && (num(i, "capitalGainOrLoss") ?? 0) !== 0) ||
      (i.formType === "schedule_d" && (num(i, "totalCapitalGainOrLoss") ?? 0) !== 0),
  );
  if (hasCapitalGains) {
    flags.push({
      id: "capital_gains_present",
      label: "Capital gains activity",
      detail: "Capital gain/loss activity appears on the return.",
      evidence: [],
    });
  }

  const variances = checks.filter((c) => c.status === "variance");
  if (variances.length > 0) {
    flags.push({
      id: "extraction_variances_open",
      label: "Cross-form variances need review",
      detail: `${variances.length} tie-out check(s) found figures that do not reconcile across forms — a human must resolve these before any figure from this file is relied on.`,
      evidence: variances.map((c) => `${c.checkId} ${c.taxYear}`),
    });
  }

  // --- Income path signals -------------------------------------------------
  const incomePaths: IncomePathSignal[] = [
    {
      pathId: "agency_wage",
      signal: hasWages ? "applicable" : "not_indicated",
      reason: hasWages
        ? "W-2 wage income present."
        : "No wage income found in the extracted forms.",
    },
    {
      pathId: "self_employment",
      signal: seEntities.length > 0 ? "applicable" : "not_indicated",
      reason:
        seEntities.length > 0
          ? "Self-employment income present; qualifying figure requires a confirmed worksheet through the cited Fannie-1084 calculator."
          : "No self-employment entities resolved.",
    },
    {
      pathId: "rental",
      signal: schEs.length > 0 ? "applicable" : "not_indicated",
      reason:
        schEs.length > 0
          ? "Schedule E rental activity present; offsets follow the cited B3-3.8-01 (formerly B3-3.1-08) treatment."
          : "No rental activity found.",
    },
    {
      pathId: "dscr",
      signal: schEs.length > 0 ? "candidate" : "not_indicated",
      reason:
        schEs.length > 0
          ? "Rental portfolio suggests a DSCR route, but DSCR qualification math is hard-blocked until the lender program reference is in-repo (UAL P4: PROGRAM_REFERENCE_NOT_IN_REPO)."
          : "No rental properties to underwrite on a coverage-ratio basis.",
    },
    {
      pathId: "bank_statement",
      signal: seEntities.length > 0 ? "candidate" : "not_indicated",
      reason:
        seEntities.length > 0
          ? "Self-employment suggests a bank-statement program candidate, but its math is hard-blocked until the lender program reference is in-repo (UAL P4: PROGRAM_REFERENCE_NOT_IN_REPO)."
          : "No self-employment income to document via bank statements.",
    },
  ];

  // --- Document requests ----------------------------------------------------
  // From tie-outs: every not-evaluable is an actionable gap.
  for (const c of checks) {
    if (c.status !== "not_evaluable") continue;
    documentRequests.push({
      id: `tieout:${c.checkId}:${c.taxYear}:${c.entityName ?? ""}`,
      description:
        c.checkId === "k1_sum_to_1065"
          ? `Remaining Schedule(s) K-1 for ${c.entityName ?? "the partnership"} (${c.taxYear})`
          : `Missing or unreadable form for the ${c.taxYear} return`,
      reason: c.detail,
      taxYear: c.taxYear,
      entityName: c.entityName ?? null,
    });
  }
  // K-1 without its parent business return in the file.
  for (const e of entities) {
    const hasK1 = e.sourceForms.some((f) => f.formType === "schedule_k1");
    const hasParent = e.sourceForms.some((f) =>
      ["business_tax_return_1065", "business_tax_return_1120s", "business_tax_return_1120"].includes(
        f.formType,
      ),
    );
    if (hasK1 && !hasParent) {
      documentRequests.push({
        id: `entity-return:${e.identityKey}`,
        description: `${e.entityType === "s_corporation" ? "Form 1120-S" : "Form 1065"} business return for ${e.name ?? "the entity"}`,
        reason:
          "A K-1 from this entity is in the file but the entity's own return is not — the K-1 share cannot be reconciled or its liquidity assessed without it.",
        taxYear: e.lastTaxYear,
        entityName: e.name,
      });
    }
    // Single-year coverage: multi-year history enables trend analysis.
    if (e.firstTaxYear !== null && e.firstTaxYear === e.lastTaxYear && seEntities.includes(e)) {
      documentRequests.push({
        id: `prior-year:${e.identityKey}`,
        description: `Prior-year (${e.firstTaxYear - 1}) return covering ${e.name ?? "the entity"}`,
        reason:
          "Only one tax year of this business is in the file; multi-year history is what the trend analysis in the cited self-employment calculator runs on.",
        taxYear: e.firstTaxYear - 1,
        entityName: e.name,
      });
    }
  }
  documentRequests.sort((a, b) => a.id.localeCompare(b.id));

  // --- Summary ---------------------------------------------------------------
  const parts: string[] = [];
  parts.push(
    `${taxYears.length} tax year(s) on file (${taxYears.join(", ") || "none"}), ${entities.length} business entit${entities.length === 1 ? "y" : "ies"} resolved.`,
  );
  if (seEntities.length > 0) {
    parts.push(
      `Self-employed${seEntities.length > 1 ? ` across ${seEntities.length} entities` : ""}${hasWages ? " with W-2 wages alongside" : ""}.`,
    );
  } else if (hasWages) {
    parts.push("Primarily W-2 wage income.");
  }
  if (schEs.length > 0) parts.push("Rental real estate present (DSCR candidate).");
  if (variances.length > 0) parts.push(`${variances.length} cross-form variance(s) need review.`);
  if (documentRequests.length > 0) parts.push(`${documentRequests.length} document(s) to request.`);

  const profile: SituationProfile = {
    version: 1,
    summary: parts.join(" "),
    taxYears,
    entityCount: entities.length,
    halalNeed: input.halalNeed ?? null,
    flags,
    incomePaths,
    documentRequests,
    tieOutSummary: {
      pass: checks.filter((c) => c.status === "pass").length,
      variance: variances.length,
      notEvaluable: checks.filter((c) => c.status === "not_evaluable").length,
      info: checks.filter((c) => c.status === "info").length,
    },
  };
  return situationProfileSchema.parse(profile);
}

/** Canonical fingerprint of the classification inputs (same inputs → same profile). */
export function situationInputsFingerprint(input: SituationClassifierInput): string {
  const canonical = {
    instances: input.instances
      .map((i) => ({
        f: i.formType,
        y: i.taxYear,
        e: i.entityName,
        fields: Object.fromEntries(
          Object.entries(i.fields)
            .map(([k, v]) => [k, v.value] as const)
            .sort(([a], [b]) => a.localeCompare(b)),
        ),
      }))
      .sort((a, b) => `${a.f}|${a.y}|${a.e}`.localeCompare(`${b.f}|${b.y}|${b.e}`)),
    entities: input.entities.map((e) => ({
      k: e.identityKey,
      t: e.entityType,
      p: e.ownershipPercent,
    })),
    checks: input.checks.map((c) => ({ id: c.checkId, y: c.taxYear, s: c.status, v: c.varianceAmount })),
    halalNeed: input.halalNeed ?? null,
  };
  return computeHash(JSON.stringify(canonical));
}

/**
 * Classify the user's current situation from their latest extractions and
 * persist it (append-only; skipped when the inputs fingerprint is unchanged).
 */
export async function classifyAndPersistSituation(
  userId: string,
  applicationId?: string,
  transaction: DatabaseTransaction | typeof db = db,
): Promise<SituationProfileRow> {
  const instances = await getLatestInstancesForUser(userId, applicationId, transaction);
  const entities = resolveBusinessEntities(instances);
  const checks = runTieOuts(instances);
  // UAL P7: join the borrower's declared routing preference from their most
  // recent application (null when never asked/answered).
  const applicationScope = applicationId
    ? eq(loanApplications.id, applicationId)
    : eq(loanApplications.userId, userId);
  const [latestApplication] = await transaction
    .select({ avoidsInterestFinancing: loanApplications.avoidsInterestFinancing })
    .from(loanApplications)
    .where(applicationScope)
    .orderBy(desc(loanApplications.createdAt))
    .limit(1);
  const input: SituationClassifierInput = {
    instances,
    entities,
    checks,
    halalNeed: latestApplication?.avoidsInterestFinancing ?? null,
  };

  const fingerprint = situationInputsFingerprint(input);
  const profileScope = applicationId
    ? and(eq(situationProfiles.userId, userId), eq(situationProfiles.applicationId, applicationId))
    : and(eq(situationProfiles.userId, userId), isNull(situationProfiles.applicationId));
  const [latest] = await transaction
    .select()
    .from(situationProfiles)
    .where(profileScope)
    .orderBy(desc(situationProfiles.generatedAt))
    .limit(1);
  if (latest && latest.inputsFingerprint === fingerprint) {
    return latest; // no-op re-run: same inputs, same profile
  }

  const profile = classifySituation(input);
  const [row] = await transaction
    .insert(situationProfiles)
    .values({
      userId,
      applicationId: applicationId ?? null,
      profile,
      inputsFingerprint: fingerprint,
      entityCount: profile.entityCount,
      selfEmployed: profile.flags.some((f) => f.id === "self_employed"),
      multiEntity: profile.flags.some((f) => f.id === "multi_entity_self_employed"),
      rentalPresent: profile.flags.some((f) => f.id === "rental_income_present"),
      k1Present: profile.flags.some((f) => f.id === "k1_income_present"),
      varianceCount: profile.tieOutSummary.variance,
      documentRequestCount: profile.documentRequests.length,
    })
    .returning();
  return row;
}

/** Latest persisted profile for a user (null when nothing has been classified). */
export async function getLatestSituationProfile(
  userId: string,
  applicationId?: string,
): Promise<SituationProfileRow | null> {
  const scope = applicationId
    ? and(eq(situationProfiles.userId, userId), eq(situationProfiles.applicationId, applicationId))
    : and(eq(situationProfiles.userId, userId), isNull(situationProfiles.applicationId));
  const [row] = await db
    .select()
    .from(situationProfiles)
    .where(scope)
    .orderBy(desc(situationProfiles.generatedAt))
    .limit(1);
  return row ?? null;
}
