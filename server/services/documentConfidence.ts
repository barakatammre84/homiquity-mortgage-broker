import { db } from "../db";
import {
  documentConfidenceScores,
  type InsertDocumentConfidence,
} from "@shared/schema";
import { eq, and, gte, sql, desc, avg } from "drizzle-orm";
import { emitEvent } from "./analyticsEventPipeline";
import type { DatabaseTransaction } from "./documentLineage";

export interface FieldConfidence {
  fieldName: string;
  value: any;
  confidence: number;
  needsReview: boolean;
}

export async function recordExtractionConfidence(options: {
  documentId: string;
  documentType: string;
  applicationId?: string;
  overallConfidence: number;
  fieldConfidences: FieldConfidence[];
  processingTimeMs?: number;
  fileSize?: number;
  pageCount?: number;
  extractionEngine?: string;
  extractionVersion?: string;
}, transaction: DatabaseTransaction | typeof db = db): Promise<{ humanReviewRequired: boolean }> {
  const reviewThreshold = getReviewThreshold(options.documentType);
  const humanReviewRequired = options.overallConfidence < reviewThreshold;

  // Persist the confidence row + analytics event. This is a quality-gate signal,
  // not the extraction itself, so a persistence failure must never break the
  // upload flow — compute the review flag first and return it regardless.
  const persist = async () => {
    await transaction.insert(documentConfidenceScores).values({
      documentId: options.documentId,
      documentType: options.documentType,
      applicationId: options.applicationId || null,
      extractionEngine: options.extractionEngine || "claude",
      extractionVersion: options.extractionVersion || null,
      overallConfidence: options.overallConfidence.toFixed(4),
      fieldConfidences: options.fieldConfidences,
      humanReviewRequired,
      fieldsExtracted: options.fieldConfidences.length,
      processingTimeMs: options.processingTimeMs || null,
      fileSize: options.fileSize || null,
      pageCount: options.pageCount || null,
    });

    await emitEvent("document", "confidence_scored", {
      entityType: "document",
      entityId: options.documentId,
      applicationId: options.applicationId,
      numericValue: options.overallConfidence,
      payload: {
        documentType: options.documentType,
        fieldsExtracted: options.fieldConfidences.length,
        humanReviewRequired,
        lowConfidenceFields: options.fieldConfidences.filter(f => f.confidence < 0.7).map(f => f.fieldName),
      },
      automationTriggered: true,
    }, transaction);
  };

  if (transaction === db) {
    try {
      await persist();
    } catch (err) {
      console.error("[doc-confidence] Failed to record extraction confidence (non-fatal):", err);
    }
  } else {
    // A caller supplied its transaction because confidence is part of a larger
    // document write. Let failures roll the whole unit back for a clean retry.
    await persist();
  }

  return { humanReviewRequired };
}

/**
 * Maps the extractor's coarse confidence label to a representative numeric score
 * for the type-specific review thresholds in {@link getReviewThreshold}. The
 * document extractors (server/extractionService.ts) emit only high/medium/low,
 * so this bridge lets the same threshold table gate every extraction path until
 * the extractor emits a true numeric confidence. Chosen so the prior behavior
 * ("high" ⇒ auto-verify) is preserved for the doc types those routes handle,
 * while medium/low now correctly land on the human-review queue.
 */
export function coarseConfidenceToNumeric(confidence: "high" | "medium" | "low"): number {
  switch (confidence) {
    case "high":
      return 0.9;
    case "medium":
      return 0.7;
    case "low":
      return 0.4;
  }
}

/**
 * Convenience wrapper for the extraction routes: records confidence from the
 * coarse extractor output and returns whether the document must go to human
 * review before it can be marked "verified". This is the single quality gate the
 * upload/extraction paths call — it strengthens human review, it does NOT clear
 * conditions (that remains a human decision).
 */
export async function recordCoarseExtraction(options: {
  documentId: string;
  documentType: string;
  applicationId?: string | null;
  confidence: "high" | "medium" | "low";
  extractedFields: string[];
  fileSize?: number;
}): Promise<{ humanReviewRequired: boolean }> {
  const overallConfidence = coarseConfidenceToNumeric(options.confidence);
  const fieldConfidences: FieldConfidence[] = (options.extractedFields ?? []).map(fieldName => ({
    fieldName,
    value: null,
    confidence: overallConfidence,
    needsReview: false,
  }));
  return recordExtractionConfidence({
    documentId: options.documentId,
    documentType: options.documentType,
    applicationId: options.applicationId ?? undefined,
    overallConfidence,
    fieldConfidences,
    fileSize: options.fileSize,
  });
}

// Exported for unit testing: the per-doc-type review gate that decides whether a
// coarse extractor confidence auto-verifies or lands on the human-review queue.
export function getReviewThreshold(documentType: string): number {
  const thresholds: Record<string, number> = {
    tax_return: 0.85,
    w2: 0.80,
    pay_stub: 0.80,
    bank_statement: 0.80,
    government_id: 0.90,
    appraisal: 0.85,
    title_report: 0.85,
    insurance: 0.75,
    other: 0.80,
  };
  return thresholds[documentType] || 0.80;
}

/**
 * One-click review completion — the verify/reject route's stamp. Records WHO
 * reviewed and WHEN on the confidence row, deliberately WITHOUT the field
 * accuracy counters: those stay null so the MR-6 accuracy report only averages
 * reviews that actually graded fields (recordHumanReview below). No-op when
 * the document has no un-stamped confidence row (extraction never ran, or a
 * reviewer already completed it).
 */
export async function markHumanReviewCompleted(
  documentId: string,
  reviewedBy: string,
): Promise<void> {
  const updated = await db.update(documentConfidenceScores).set({
    humanReviewCompleted: true,
    humanReviewedBy: reviewedBy,
    humanReviewedAt: new Date(),
  }).where(and(
    eq(documentConfidenceScores.documentId, documentId),
    eq(documentConfidenceScores.humanReviewCompleted, false),
  )).returning({ id: documentConfidenceScores.id });

  if (updated.length > 0) {
    await emitEvent("document", "human_review_completed", {
      entityType: "document",
      entityId: documentId,
      actorId: reviewedBy,
      payload: { oneClick: true, rowsStamped: updated.length },
    });
  }
}

export async function recordHumanReview(
  documentId: string,
  reviewedBy: string,
  corrections: {
    fieldsCorrect: number;
    fieldsCorrected: number;
    fieldsMissed: number;
  },
  transaction: DatabaseTransaction | typeof db = db,
): Promise<void> {
  const totalFields = corrections.fieldsCorrect + corrections.fieldsCorrected + corrections.fieldsMissed;
  const accuracyPct = totalFields > 0
    ? ((corrections.fieldsCorrect / totalFields) * 100).toFixed(2)
    : null;

  await transaction.update(documentConfidenceScores).set({
    humanReviewCompleted: true,
    humanReviewedBy: reviewedBy,
    humanReviewedAt: new Date(),
    fieldsCorrect: corrections.fieldsCorrect,
    fieldsCorrected: corrections.fieldsCorrected,
    fieldsMissed: corrections.fieldsMissed,
    fieldAccuracyPct: accuracyPct,
  }).where(eq(documentConfidenceScores.documentId, documentId));

  await emitEvent("document", "human_review_completed", {
    entityType: "document",
    entityId: documentId,
    actorId: reviewedBy,
    numericValue: accuracyPct ? parseFloat(accuracyPct) : undefined,
    payload: corrections,
  });
}

export async function getAccuracyByDocType(daysBack: number = 90): Promise<Array<{
  documentType: string;
  totalExtractions: number;
  avgConfidence: number;
  reviewedCount: number;
  gradedReviewCount: number;
  avgAccuracy: number | null;
  avgProcessingTimeMs: number | null;
  needsReviewCount: number;
}>> {
  const cutoff = sql`now() - interval '${sql.raw(daysBack.toString())} days'`;

  const rows = await db.select({
    documentType: documentConfidenceScores.documentType,
    totalExtractions: sql<number>`count(*)::int`,
    avgConfidence: sql<number>`avg(${documentConfidenceScores.overallConfidence}::numeric)::numeric(5,4)`,
    reviewedCount: sql<number>`count(*) filter (where ${documentConfidenceScores.humanReviewCompleted} = true)::int`,
    gradedReviewCount: sql<number>`count(*) filter (where ${documentConfidenceScores.fieldAccuracyPct} is not null)::int`,
    avgAccuracy: sql<number>`avg(${documentConfidenceScores.fieldAccuracyPct}::numeric)::numeric(5,2)`,
    avgProcessingTime: sql<number>`avg(${documentConfidenceScores.processingTimeMs})::int`,
    needsReviewCount: sql<number>`count(*) filter (where ${documentConfidenceScores.humanReviewRequired} = true and ${documentConfidenceScores.humanReviewCompleted} = false)::int`,
  }).from(documentConfidenceScores)
    .where(gte(documentConfidenceScores.extractedAt, cutoff))
    .groupBy(documentConfidenceScores.documentType);

  return rows.map(r => ({
    documentType: r.documentType,
    totalExtractions: Number(r.totalExtractions),
    avgConfidence: Number(r.avgConfidence ?? 0),
    reviewedCount: Number(r.reviewedCount),
    gradedReviewCount: Number(r.gradedReviewCount),
    // PostgreSQL returns numeric values as strings with the standard driver
    // even when the query builder is annotated as <number>. Normalize at the
    // API boundary so client formatting never calls number methods on a string.
    avgAccuracy: r.avgAccuracy === null ? null : Number(r.avgAccuracy),
    avgProcessingTimeMs: r.avgProcessingTime === null ? null : Number(r.avgProcessingTime),
    needsReviewCount: Number(r.needsReviewCount),
  }));
}

// MR-6 — periodic extraction-accuracy report with drift alerts. Wraps the
// per-doc-type aggregation above and compares each type's human-verified
// accuracy against its target (the same threshold used to gate review), so a
// silent drop in extraction quality surfaces as an alert.
export interface DocTypeAccuracyStatus {
  documentType: string;
  totalExtractions: number;
  reviewedCount: number;
  gradedReviewCount: number;
  avgConfidence: number;
  avgAccuracy: number | null; // percent
  targetAccuracyPct: number;
  needsReviewCount: number;
  status: "ok" | "below_target" | "insufficient_reviews";
}

/**
 * A document approval only says that a person completed the review step. It is
 * not an OCR accuracy observation unless the reviewer graded the extracted
 * fields. Keep that distinction in one pure function so reports cannot turn a
 * run of one-click approvals into a false green quality signal.
 */
export function classifyDocTypeAccuracyStatus(input: {
  gradedReviewCount: number;
  avgAccuracy: number | null;
  targetAccuracyPct: number;
  minReviews: number;
}): DocTypeAccuracyStatus["status"] {
  if (input.gradedReviewCount < input.minReviews || input.avgAccuracy === null) {
    return "insufficient_reviews";
  }
  return input.avgAccuracy < input.targetAccuracyPct ? "below_target" : "ok";
}

export interface ExtractionAccuracyReport {
  generatedAt: string;
  windowDays: number;
  minReviews: number;
  docTypes: DocTypeAccuracyStatus[];
  alerts: string[];
}

export async function getExtractionAccuracyReport(
  daysBack: number = 30,
  minReviews: number = 10,
): Promise<ExtractionAccuracyReport> {
  const rows = await getAccuracyByDocType(daysBack);

  const docTypes: DocTypeAccuracyStatus[] = rows.map((r) => {
    const targetAccuracyPct = getReviewThreshold(r.documentType) * 100;
    const status = classifyDocTypeAccuracyStatus({
      gradedReviewCount: r.gradedReviewCount,
      avgAccuracy: r.avgAccuracy,
      targetAccuracyPct,
      minReviews,
    });
    return {
      documentType: r.documentType,
      totalExtractions: r.totalExtractions,
      reviewedCount: r.reviewedCount,
      gradedReviewCount: r.gradedReviewCount,
      avgConfidence: r.avgConfidence,
      avgAccuracy: r.avgAccuracy,
      targetAccuracyPct,
      needsReviewCount: r.needsReviewCount,
      status,
    };
  });

  const alerts = docTypes
    .filter((d) => d.status === "below_target")
    .map(
      (d) =>
        `${d.documentType}: avg accuracy ${d.avgAccuracy}% is below the ${d.targetAccuracyPct}% target over ${d.gradedReviewCount} field-graded reviews — investigate model/prompt drift.`,
    );

  return {
    generatedAt: new Date().toISOString(),
    windowDays: daysBack,
    minReviews,
    docTypes: docTypes.sort((a, b) => a.documentType.localeCompare(b.documentType)),
    alerts,
  };
}

export async function getPendingReviews(): Promise<Array<{
  id: string;
  documentId: string;
  documentType: string;
  applicationId: string | null;
  overallConfidence: number;
  fieldsExtracted: number;
  extractedAt: Date;
}>> {
  return db.select({
    id: documentConfidenceScores.id,
    documentId: documentConfidenceScores.documentId,
    documentType: documentConfidenceScores.documentType,
    applicationId: documentConfidenceScores.applicationId,
    overallConfidence: sql<number>`${documentConfidenceScores.overallConfidence}::numeric`,
    fieldsExtracted: documentConfidenceScores.fieldsExtracted,
    extractedAt: documentConfidenceScores.extractedAt,
  }).from(documentConfidenceScores)
    .where(and(
      eq(documentConfidenceScores.humanReviewRequired, true),
      eq(documentConfidenceScores.humanReviewCompleted, false)
    ))
    .orderBy(documentConfidenceScores.overallConfidence)
    .limit(50) as any;
}

export async function getConfidenceTrend(documentType: string, daysBack: number = 90): Promise<Array<{
  date: string;
  avgConfidence: number;
  count: number;
}>> {
  const cutoff = sql`now() - interval '${sql.raw(daysBack.toString())} days'`;

  return db.select({
    date: sql<string>`date(${documentConfidenceScores.extractedAt})`,
    avgConfidence: sql<number>`avg(${documentConfidenceScores.overallConfidence}::numeric)::numeric(5,4)`,
    count: sql<number>`count(*)::int`,
  }).from(documentConfidenceScores)
    .where(and(
      eq(documentConfidenceScores.documentType, documentType),
      gte(documentConfidenceScores.extractedAt, cutoff)
    ))
    .groupBy(sql`date(${documentConfidenceScores.extractedAt})`)
    .orderBy(sql`date(${documentConfidenceScores.extractedAt})`) as any;
}
