import { db } from "../db";
import {
  intentEvents,
  readinessChecklist,
  type IntentEventType,
  type ReadinessCategory,
  type FieldVerificationStatus,
} from "@shared/schema";
import { eq, and, sql, gte, desc } from "drizzle-orm";
import type { DatabaseTransaction } from "./documentLineage";

export async function trackIntent(
  eventType: IntentEventType,
  options: {
    userId?: string;
    sessionId?: string;
    targetType?: string;
    targetId?: string;
    targetLabel?: string;
    metadata?: Record<string, any>;
    pagePath?: string;
    referrerPath?: string;
    deviceType?: string;
    durationMs?: number;
    geoState?: string;
    geoMetro?: string;
  } = {}
): Promise<void> {
  const categoryMap: Record<string, string> = {
    page_view: "navigation",
    calculator_use: "engagement",
    rate_quote_view: "engagement",
    property_search: "property",
    property_view: "property",
    property_save: "property",
    property_affordability_check: "property",
    pre_approval_start: "application",
    pre_approval_complete: "application",
    pre_qual_start: "application",
    pre_qual_complete: "application",
    document_upload_start: "document",
    document_upload_complete: "document",
    document_upload_abandon: "document",
    coach_session_start: "coaching",
    coach_session_complete: "coaching",
    coach_question_asked: "coaching",
    cta_click: "conversion",
    form_field_focus: "form",
    form_field_abandon: "form",
    lender_comparison_view: "comparison",
    loan_option_view: "comparison",
    loan_option_select: "comparison",
    letter_download: "milestone",
    letter_share: "milestone",
    referral_link_click: "referral",
    savings_deposit: "financial",
    credit_action_complete: "financial",
    consent_given: "compliance",
    milestone_achieved: "milestone",
    return_visit: "engagement",
    session_start: "session",
    session_end: "session",
    friction_event: "friction",
  };

  await db.insert(intentEvents).values({
    userId: options.userId || null,
    sessionId: options.sessionId || null,
    eventType,
    eventCategory: categoryMap[eventType] || "other",
    targetType: options.targetType || null,
    targetId: options.targetId || null,
    targetLabel: options.targetLabel || null,
    metadata: options.metadata || null,
    pagePath: options.pagePath || null,
    referrerPath: options.referrerPath || null,
    deviceType: options.deviceType || null,
    durationMs: options.durationMs || null,
    geoState: options.geoState || null,
    geoMetro: options.geoMetro || null,
  });
}

export async function getIntentSummary(userId: string, daysBack: number = 30): Promise<{
  totalEvents: number;
  eventsByCategory: Record<string, number>;
  eventsByType: Record<string, number>;
  funnelProgress: {
    hasViewed: boolean;
    hasEngaged: boolean;
    hasApplied: boolean;
    hasUploadedDocs: boolean;
    hasCompared: boolean;
  };
  conversionSignals: {
    intentScore: number;
    topActions: string[];
    recentActivity: string[];
    dropoffPoints: string[];
  };
}> {
  const events = await db.select({
    eventType: intentEvents.eventType,
    eventCategory: intentEvents.eventCategory,
    count: sql<number>`count(*)::int`,
  }).from(intentEvents)
    .where(and(
      eq(intentEvents.userId, userId),
      gte(intentEvents.occurredAt, sql`now() - interval '${sql.raw(daysBack.toString())} days'`)
    ))
    .groupBy(intentEvents.eventType, intentEvents.eventCategory);

  const totalEvents = events.reduce((sum, e) => sum + e.count, 0);
  const eventsByCategory: Record<string, number> = {};
  const eventsByType: Record<string, number> = {};

  for (const e of events) {
    eventsByCategory[e.eventCategory || "other"] = (eventsByCategory[e.eventCategory || "other"] || 0) + e.count;
    eventsByType[e.eventType] = e.count;
  }

  const has = (type: string) => (eventsByType[type] || 0) > 0;

  const funnelProgress = {
    hasViewed: has("page_view"),
    hasEngaged: has("calculator_use") || has("coach_session_start") || has("property_search"),
    hasApplied: has("pre_approval_start") || has("pre_qual_start"),
    hasUploadedDocs: has("document_upload_complete"),
    hasCompared: has("lender_comparison_view") || has("loan_option_view"),
  };

  const weights: Record<string, number> = {
    pre_approval_complete: 30,
    pre_approval_start: 20,
    document_upload_complete: 15,
    property_affordability_check: 10,
    lender_comparison_view: 8,
    coach_session_complete: 8,
    calculator_use: 5,
    property_save: 5,
    cta_click: 4,
    return_visit: 3,
    property_search: 2,
  };

  let intentScore = 0;
  const topActions: string[] = [];

  for (const [type, count] of Object.entries(eventsByType)) {
    const w = weights[type] || 1;
    intentScore += Math.min(w * count, w * 3);
    if (count > 0 && weights[type]) topActions.push(type);
  }
  intentScore = Math.min(100, intentScore);

  const recentEvents = await db.select({
    eventType: intentEvents.eventType,
    occurredAt: intentEvents.occurredAt,
  }).from(intentEvents)
    .where(eq(intentEvents.userId, userId))
    .orderBy(desc(intentEvents.occurredAt))
    .limit(5);

  const recentActivity = recentEvents.map(e =>
    `${e.eventType} at ${e.occurredAt?.toISOString() || "unknown"}`
  );

  const dropoffPoints: string[] = [];
  if (has("form_field_abandon")) dropoffPoints.push("form_field");
  if (has("document_upload_abandon")) dropoffPoints.push("document_upload");
  if (has("pre_approval_start") && !has("pre_approval_complete")) dropoffPoints.push("pre_approval_flow");

  return {
    totalEvents,
    eventsByCategory,
    eventsByType,
    funnelProgress,
    conversionSignals: {
      intentScore,
      topActions: topActions.sort((a, b) => (weights[b] || 0) - (weights[a] || 0)),
      recentActivity,
      dropoffPoints,
    },
  };
}

const READINESS_FIELDS: Array<{
  category: ReadinessCategory;
  fieldName: string;
  fieldLabel: string;
  isRequired: boolean;
  weight: number;
}> = [
  { category: "identity", fieldName: "full_name", fieldLabel: "Full legal name", isRequired: true, weight: 1.5 },
  { category: "identity", fieldName: "date_of_birth", fieldLabel: "Date of birth", isRequired: true, weight: 1.0 },
  { category: "identity", fieldName: "ssn", fieldLabel: "Social Security number", isRequired: true, weight: 1.5 },
  { category: "identity", fieldName: "citizenship_status", fieldLabel: "Citizenship status", isRequired: true, weight: 1.0 },
  { category: "identity", fieldName: "marital_status", fieldLabel: "Marital status", isRequired: true, weight: 0.5 },

  { category: "income", fieldName: "annual_income", fieldLabel: "Annual income", isRequired: true, weight: 2.0 },
  { category: "income", fieldName: "income_sources", fieldLabel: "Income source breakdown", isRequired: true, weight: 1.5 },
  { category: "income", fieldName: "employment_type", fieldLabel: "Employment type", isRequired: true, weight: 1.0 },

  { category: "employment", fieldName: "employer_name", fieldLabel: "Current employer", isRequired: true, weight: 1.0 },
  { category: "employment", fieldName: "employment_duration", fieldLabel: "Employment duration", isRequired: true, weight: 1.0 },
  { category: "employment", fieldName: "employer_address", fieldLabel: "Employer address", isRequired: false, weight: 0.5 },

  { category: "assets", fieldName: "total_assets", fieldLabel: "Total assets", isRequired: true, weight: 1.5 },
  { category: "assets", fieldName: "down_payment_source", fieldLabel: "Down payment source", isRequired: true, weight: 1.5 },
  { category: "assets", fieldName: "bank_accounts", fieldLabel: "Bank account statements", isRequired: true, weight: 1.0 },

  { category: "liabilities", fieldName: "monthly_debts", fieldLabel: "Monthly debts", isRequired: true, weight: 1.5 },
  { category: "liabilities", fieldName: "outstanding_loans", fieldLabel: "Outstanding loans", isRequired: true, weight: 1.0 },

  { category: "credit", fieldName: "credit_score", fieldLabel: "Credit score", isRequired: true, weight: 2.0 },
  { category: "credit", fieldName: "credit_history", fieldLabel: "Credit history", isRequired: false, weight: 1.0 },

  { category: "property", fieldName: "property_type", fieldLabel: "Property type", isRequired: true, weight: 1.0 },
  { category: "property", fieldName: "property_address", fieldLabel: "Property address", isRequired: false, weight: 0.5 },
  { category: "property", fieldName: "purchase_price", fieldLabel: "Purchase price", isRequired: true, weight: 1.5 },
  { category: "property", fieldName: "occupancy_type", fieldLabel: "Occupancy type", isRequired: true, weight: 1.0 },

  { category: "declarations", fieldName: "bankruptcy_declaration", fieldLabel: "Bankruptcy declaration", isRequired: true, weight: 1.0 },
  { category: "declarations", fieldName: "foreclosure_declaration", fieldLabel: "Foreclosure declaration", isRequired: true, weight: 1.0 },
  { category: "declarations", fieldName: "ownership_interest", fieldLabel: "Real estate ownership", isRequired: true, weight: 0.5 },

  { category: "documents", fieldName: "pay_stubs", fieldLabel: "Recent pay stubs", isRequired: true, weight: 1.5 },
  { category: "documents", fieldName: "w2_forms", fieldLabel: "W-2 forms", isRequired: true, weight: 1.5 },
  { category: "documents", fieldName: "tax_returns", fieldLabel: "Tax returns", isRequired: true, weight: 1.5 },
  { category: "documents", fieldName: "bank_statements", fieldLabel: "Bank statements", isRequired: true, weight: 1.5 },
  { category: "documents", fieldName: "government_id", fieldLabel: "Government-issued ID", isRequired: true, weight: 1.0 },

  { category: "consent", fieldName: "credit_pull_consent", fieldLabel: "Credit pull authorization", isRequired: true, weight: 1.0 },
  { category: "consent", fieldName: "econsent", fieldLabel: "Electronic consent", isRequired: true, weight: 0.5 },
];

export async function initializeReadinessChecklist(
  userId: string,
  applicationId?: string,
  transaction: DatabaseTransaction | typeof db = db,
): Promise<void> {
  const existing = await transaction.select({ id: readinessChecklist.id })
    .from(readinessChecklist)
    .where(eq(readinessChecklist.userId, userId))
    .limit(1);

  if (existing.length > 0) return;

  for (const field of READINESS_FIELDS) {
    await transaction.insert(readinessChecklist).values({
      userId,
      applicationId: applicationId || null,
      category: field.category,
      fieldName: field.fieldName,
      fieldLabel: field.fieldLabel,
      isRequired: field.isRequired,
      weight: field.weight.toFixed(2),
    }).onConflictDoNothing();
  }
}

/** Every readiness fieldName the checklist seeds. The canonical vocabulary. */
export const READINESS_FIELD_NAMES: readonly string[] = READINESS_FIELDS.map(f => f.fieldName);

/**
 * The only verification statuses a BORROWER may assert about themselves.
 *
 * The others — document_extracted, third_party_verified, manually_verified —
 * all map to tier 1 and mean "a model read it", "a vendor confirmed it" or "a
 * human checked it". Those are earned by an event the server observed, never
 * claimed by the subject of the record. Server-side callers use
 * updateReadinessField directly and are not bound by this list.
 */
export const BORROWER_ASSERTABLE_STATUSES: readonly FieldVerificationStatus[] = [
  "not_collected",
  "self_reported",
];

export async function updateReadinessField(
  userId: string,
  fieldName: string,
  options: {
    verificationStatus: FieldVerificationStatus;
    sourceTable?: string;
    sourceField?: string;
    sourceRecordId?: string;
    expiresAt?: Date;
  },
  transaction: DatabaseTransaction | typeof db = db,
): Promise<void> {
  const tierMap: Record<FieldVerificationStatus, string> = {
    not_collected: "",
    self_reported: "tier3",
    application_stated: "tier2",
    document_extracted: "tier1",
    third_party_verified: "tier1",
    manually_verified: "tier1",
  };

  const tierRank: Record<string, number> = {
    "": 0,
    tier3: 1,
    tier2: 2,
    tier1: 3,
  };

  const newTier = tierMap[options.verificationStatus] || "";

  const [existing] = await transaction.select({
    trustTier: readinessChecklist.trustTier,
    verificationStatus: readinessChecklist.verificationStatus,
  })
    .from(readinessChecklist)
    .where(and(
      eq(readinessChecklist.userId, userId),
      eq(readinessChecklist.fieldName, fieldName),
    ))
    .limit(1);

  if (existing) {
    const existingRank = tierRank[existing.trustTier || ""] || 0;
    const newRank = tierRank[newTier] || 0;
    if (newRank < existingRank) {
      return;
    }
  }

  await transaction.update(readinessChecklist)
    .set({
      isCollected: options.verificationStatus !== "not_collected",
      verificationStatus: options.verificationStatus,
      trustTier: newTier || null,
      sourceTable: options.sourceTable || null,
      sourceField: options.sourceField || null,
      sourceRecordId: options.sourceRecordId || null,
      collectedAt: new Date(),
      verifiedAt: options.verificationStatus === "document_extracted" ||
        options.verificationStatus === "third_party_verified" ||
        options.verificationStatus === "manually_verified"
        ? new Date()
        : null,
      expiresAt: options.expiresAt || null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(readinessChecklist.userId, userId),
      eq(readinessChecklist.fieldName, fieldName),
    ));
}

export async function getReadinessScore(userId: string): Promise<{
  overallScore: number;
  weightedScore: number;
  byCategory: Record<string, { score: number; collected: number; total: number }>;
  missingRequired: string[];
  verificationBreakdown: Record<string, number>;
}> {
  const rows = await db.select().from(readinessChecklist)
    .where(eq(readinessChecklist.userId, userId));

  if (rows.length === 0) {
    return {
      overallScore: 0,
      weightedScore: 0,
      byCategory: {},
      missingRequired: [],
      verificationBreakdown: {},
    };
  }

  const byCategory: Record<string, { score: number; collected: number; total: number }> = {};
  const missingRequired: string[] = [];
  const verificationBreakdown: Record<string, number> = {};
  let totalWeight = 0;
  let collectedWeight = 0;

  for (const row of rows) {
    const cat = row.category;
    if (!byCategory[cat]) byCategory[cat] = { score: 0, collected: 0, total: 0 };
    byCategory[cat].total++;
    if (row.isCollected) byCategory[cat].collected++;

    const weight = parseFloat(row.weight || "1");
    totalWeight += weight;
    if (row.isCollected) collectedWeight += weight;

    if (row.isRequired && !row.isCollected) {
      missingRequired.push(row.fieldLabel);
    }

    const status = row.verificationStatus || "not_collected";
    verificationBreakdown[status] = (verificationBreakdown[status] || 0) + 1;
  }

  for (const cat of Object.keys(byCategory)) {
    byCategory[cat].score = byCategory[cat].total > 0
      ? Math.round((byCategory[cat].collected / byCategory[cat].total) * 100)
      : 0;
  }

  return {
    overallScore: Math.round((rows.filter(r => r.isCollected).length / rows.length) * 100),
    weightedScore: totalWeight > 0 ? Math.round((collectedWeight / totalWeight) * 100) : 0,
    byCategory,
    missingRequired,
    verificationBreakdown,
  };
}
