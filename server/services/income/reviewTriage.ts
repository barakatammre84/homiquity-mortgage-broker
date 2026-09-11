import { db } from "../../db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  reviewItems,
  extractedFields,
  incomePathEvaluations,
  logicalDocuments,
  loanApplications,
  documentLineage,
  documents,
  type ReviewItem,
  type ReviewItemTier,
  type ReviewItemType,
} from "@shared/schema";
import type { IncomePathResult } from "@shared/incomePaths";
import { computeHash } from "../encryptionService";
import {
  getLatestInstancesForUser,
  type PublicTaxFormInstance,
} from "../taxDocumentIntelligence";
import { runTieOuts, type TieOutCheck } from "../taxReconciliation";
import { recalculateDecision } from "../decisionEngine";
import { currentDocumentEvidencePredicate } from "../currentDocumentEvidence";
import { lockDocumentWorkflow } from "../documentLineage";

/**
 * Exception-only review triage (UAL P5). Deterministically turns the accuracy
 * machinery's outputs into the two ACTIONABLE tiers — auto-accepted data never
 * becomes an item:
 *
 *  - one_click  — the machine is fairly sure; a human confirms in one action
 *                 (low-confidence extractions below the existing 0.7
 *                 needs-review convention, DSCR/bank-statement acknowledgments
 *                 whose math is cited but whose program judgment is AE-gated);
 *  - flagged    — the machine found a contradiction or a rule that demands
 *                 judgment (tie-out variances, the Form 1084 calculator's own
 *                 requiresManualReview, low-confidence fields that ALSO sit
 *                 inside a variance).
 *
 * No new thresholds are invented: 0.7 is the documentConfidence needs-review
 * convention already in-repo; variances carry their own arithmetic rounding
 * tolerance from the tie-out engine; path flags come from the cited
 * calculators. The natural key embeds the offending values, so changed inputs
 * mint a NEW item while resolved items stay resolved — resolutions are the
 * accuracy loop's labeled data (measurement + extraction-prompt iteration
 * only; never model retraining inside underwriting).
 */

/** The in-repo needs-review confidence convention (documentConfidence.ts). */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.7;

export interface CandidateReviewItem {
  naturalKey: string;
  itemType: ReviewItemType;
  tier: ReviewItemTier;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
}

const keyHash = (parts: unknown[]) => computeHash(JSON.stringify(parts)).slice(0, 16);

type ReviewItemEvidence = {
  logicalDocumentId?: unknown;
  sourceRefs?: unknown;
};

function evidenceLogicalDocumentIds(item: Pick<ReviewItem, "evidence">): string[] {
  const evidence = (item.evidence ?? {}) as ReviewItemEvidence;
  const ids: string[] = [];
  if (typeof evidence.logicalDocumentId === "string" && evidence.logicalDocumentId) {
    ids.push(evidence.logicalDocumentId);
  }
  if (Array.isArray(evidence.sourceRefs)) {
    for (const ref of evidence.sourceRefs) {
      if (
        ref &&
        typeof ref === "object" &&
        "logicalDocumentId" in ref &&
        typeof ref.logicalDocumentId === "string" &&
        ref.logicalDocumentId
      ) {
        ids.push(ref.logicalDocumentId);
      }
    }
  }
  return [...new Set(ids)];
}

function requiresDocumentEvidence(item: Pick<ReviewItem, "itemType">): boolean {
  return item.itemType === "extraction_low_confidence" || item.itemType === "tieout_variance";
}

/** Latest completed extraction for a still-current physical document. */
function currentLogicalExtractionEvidencePredicate() {
  return sql<boolean>`
    (
      ${logicalDocuments.extractionRunId} IS NULL
      OR EXISTS (
        SELECT 1
          FROM tax_extraction_runs AS current_tax_run
         WHERE current_tax_run.id = ${logicalDocuments.extractionRunId}
           AND current_tax_run.status = 'completed'
           AND NOT EXISTS (
             SELECT 1
               FROM tax_extraction_runs AS newer_tax_run
              WHERE newer_tax_run.document_id = ${documents.id}
                AND newer_tax_run.status = 'completed'
                AND (
                  newer_tax_run.started_at > current_tax_run.started_at
                  OR (
                    newer_tax_run.started_at = current_tax_run.started_at
                    AND newer_tax_run.id > current_tax_run.id
                  )
                )
           )
      )
    )
  `;
}

type LogicalEvidenceScope = {
  id: string;
  applicationId: string | null;
  borrowerId: string;
  documentApplicationId: string | null;
};

function keepItemsWithCurrentApplicationEvidence(
  items: ReviewItem[],
  rows: LogicalEvidenceScope[],
  applicationId?: string,
): ReviewItem[] {
  const evidenceScope = new Map(rows.map((row) => [row.id, row]));

  return items.filter((item) => {
    const ids = evidenceLogicalDocumentIds(item);
    if (requiresDocumentEvidence(item) && ids.length === 0) return false;
    const expectedApplicationId = applicationId ?? item.applicationId;
    return ids.every((id) => {
      const evidence = evidenceScope.get(id);
      const effectiveApplicationId = evidence?.applicationId ?? evidence?.documentApplicationId;
      return (
        !!evidence &&
        evidence.borrowerId === item.userId &&
        (!evidence.applicationId || evidence.applicationId === evidence.documentApplicationId) &&
        (!expectedApplicationId || effectiveApplicationId === expectedApplicationId)
      );
    });
  });
}

async function currentLogicalEvidenceScope(items: ReviewItem[]): Promise<LogicalEvidenceScope[]> {
  const referencedIds = [...new Set(items.flatMap(evidenceLogicalDocumentIds))];
  if (referencedIds.length === 0) return [];
  return db
    .select({
      id: logicalDocuments.id,
      applicationId: logicalDocuments.loanId,
      borrowerId: logicalDocuments.borrowerId,
      documentApplicationId: documents.applicationId,
    })
    .from(logicalDocuments)
    .innerJoin(documents, eq(documents.id, logicalDocuments.sourceDocumentId))
    .leftJoin(documentLineage, eq(documentLineage.documentId, documents.id))
    .where(and(
      inArray(logicalDocuments.id, referencedIds),
      currentDocumentEvidencePredicate(),
      // Re-extraction can create another logical form for the same physical
      // file. Only the latest completed run is current review evidence.
      currentLogicalExtractionEvidencePredicate(),
    ));
}

async function keepCurrentOpenItems(
  items: ReviewItem[],
  applicationId?: string,
): Promise<ReviewItem[]> {
  return keepItemsWithCurrentApplicationEvidence(
    items,
    await currentLogicalEvidenceScope(items),
    applicationId,
  );
}

/** Pure core: candidates from extraction instances + tie-out checks. */
export function triageExtractionAndTieOuts(
  instances: PublicTaxFormInstance[],
  checks: TieOutCheck[],
): CandidateReviewItem[] {
  const items: CandidateReviewItem[] = [];

  // Fields referenced by any variance check — these escalate to flagged.
  const varianceFieldRefs = new Set<string>();
  for (const c of checks) {
    if (c.status !== "variance") continue;
    for (const ref of c.sourceRefs) {
      varianceFieldRefs.add(`${ref.logicalDocumentId}|${ref.fieldName}`);
    }
  }

  // (a) Low-confidence extracted fields (existing 0.7 convention).
  for (const inst of instances) {
    for (const [fieldName, fv] of Object.entries(inst.fields)) {
      if (fv.confidence >= REVIEW_CONFIDENCE_THRESHOLD) continue;
      const inVariance = varianceFieldRefs.has(`${inst.logicalDocumentId}|${fieldName}`);
      items.push({
        naturalKey: `xlc:${inst.logicalDocumentId}:${inst.formType}:${inst.taxYear ?? ""}:${fieldName}:${keyHash([inst.entityName, fv.value, fv.confidence])}`,
        itemType: "extraction_low_confidence",
        tier: inVariance ? "flagged" : "one_click",
        title: `Confirm ${fieldName} on the ${inst.taxYear ?? ""} ${inst.formType}`.trim(),
        detail: `The extractor read ${JSON.stringify(fv.value)} with confidence ${fv.confidence} — below the ${REVIEW_CONFIDENCE_THRESHOLD} needs-review convention${inVariance ? ", and this field sits inside a cross-form variance" : ""}. Confirm against the document or correct it.`,
        evidence: {
          logicalDocumentId: inst.logicalDocumentId,
          formType: inst.formType,
          taxYear: inst.taxYear,
          entityName: inst.entityName,
          fieldName,
          machineValue: fv.value,
          confidence: fv.confidence,
          pageStart: inst.pageStart,
        },
      });
    }
  }

  // (b) Tie-out variances — always flagged; a human resolves the contradiction.
  for (const c of checks) {
    if (c.status !== "variance") continue;
    items.push({
      naturalKey: `tov:${c.checkId}:${c.taxYear}:${c.entityName ?? ""}:${keyHash([
        c.expected,
        c.actual,
        c.sourceRefs
          .map((ref) => `${ref.logicalDocumentId}|${ref.fieldName}`)
          .sort(),
      ])}`,
      itemType: "tieout_variance",
      tier: "flagged",
      title: `Cross-form variance: ${c.checkId.replace(/_/g, " ")} (${c.taxYear})`,
      detail: c.detail,
      evidence: {
        checkId: c.checkId,
        taxYear: c.taxYear,
        entityName: c.entityName ?? null,
        expected: c.expected,
        actual: c.actual,
        varianceAmount: c.varianceAmount,
        tolerance: c.tolerance,
        authority: c.authority,
        sourceRefs: c.sourceRefs,
      },
    });
  }

  return items;
}

/** Pure core: candidates from a persisted income-path evaluation's path set. */
export function triageIncomePaths(paths: IncomePathResult[]): CandidateReviewItem[] {
  const items: CandidateReviewItem[] = [];
  for (const p of paths) {
    if (!p.requiresManualReview) continue;
    if (p.pathId === "self_employment" && p.kind === "dti_income") {
      if (p.missingItems?.length) continue;
      items.push({
        naturalKey: `sei:${keyHash([p.monthlyQualifyingIncome, p.notes])}`,
        itemType: "se_income_review",
        tier: "flagged",
        title: "Self-employment income needs human confirmation",
        detail: p.notes.join(" ") || "The Form 1084 calculator flagged this figure for manual review.",
        evidence: { pathId: p.pathId, monthlyQualifyingIncome: p.monthlyQualifyingIncome, notes: p.notes },
      });
    } else if (p.pathId === "dscr" && p.kind === "coverage_ratio") {
      items.push({
        naturalKey: `dscr:${keyHash([p.coverageRatio, p.notes])}`,
        itemType: "dscr_review",
        tier: "one_click",
        title: `Acknowledge DSCR ${p.coverageRatio ?? "—"} (qualifying minimum is AE-gated)`,
        detail: p.notes.join(" "),
        evidence: { pathId: p.pathId, coverageRatio: p.coverageRatio, notes: p.notes },
      });
    } else if (p.pathId === "bank_statement" && p.kind === "dti_income") {
      items.push({
        naturalKey: `bsi:${keyHash([p.monthlyQualifyingIncome, p.notes])}`,
        itemType: "bank_statement_review",
        tier: "one_click",
        title: `Acknowledge bank-statement income $${p.monthlyQualifyingIncome}/mo (deposit screening is AE-gated)`,
        detail: p.notes.join(" "),
        evidence: { pathId: p.pathId, monthlyQualifyingIncome: p.monthlyQualifyingIncome, notes: p.notes },
      });
    }
  }
  return items;
}

/**
 * IO: regenerate candidates from the user's latest extractions (+ the
 * application's latest persisted income evaluation when given) and persist the
 * new ones. Insert-only on (user_id, natural_key): existing items — open or
 * human-resolved — are never touched. Returns the open items.
 */
export async function syncReviewItems(
  userId: string,
  applicationId?: string | null,
): Promise<ReviewItem[]> {
  if (applicationId) {
    const [application] = await db
      .select({ userId: loanApplications.userId })
      .from(loanApplications)
      .where(eq(loanApplications.id, applicationId))
      .limit(1);
    if (application?.userId !== userId) return [];
  }

  const instances = await getLatestInstancesForUser(userId, applicationId ?? undefined);
  const checks = runTieOuts(instances);
  const candidates = [...triageExtractionAndTieOuts(instances, checks)];

  if (applicationId) {
    const [evaluation] = await db
      .select()
      .from(incomePathEvaluations)
      .where(eq(incomePathEvaluations.applicationId, applicationId))
      .orderBy(desc(incomePathEvaluations.createdAt))
      .limit(1);
    if (evaluation) {
      candidates.push(...triageIncomePaths(evaluation.paths as IncomePathResult[]));
    }
  }

  if (candidates.length > 0) {
    await db
      .insert(reviewItems)
      .values(
        candidates.map((c) => ({
          userId,
          applicationId: applicationId ?? null,
          // The table's legacy uniqueness key is borrower-wide. Prefix scoped
          // candidates so the same field/value on two applications cannot make
          // one file suppress or inherit the other's review item.
          naturalKey: applicationId
            ? `app:${applicationId}:${keyHash([c.naturalKey])}`
            : c.naturalKey,
          itemType: c.itemType,
          tier: c.tier,
          title: c.title.slice(0, 300),
          detail: c.detail,
          evidence: c.evidence,
        })),
      )
      .onConflictDoNothing({ target: [reviewItems.userId, reviewItems.naturalKey] });
  }

  const filters = [eq(reviewItems.userId, userId), eq(reviewItems.status, "open")];
  if (applicationId) filters.push(eq(reviewItems.applicationId, applicationId));
  const openItems = await db
    .select()
    .from(reviewItems)
    .where(and(...filters))
    .orderBy(desc(reviewItems.createdAt));
  return applicationId
    ? keepCurrentOpenItems(openItems, applicationId)
    : keepCurrentOpenItems(openItems);
}

export interface ResolveReviewItemInput {
  itemId: string;
  applicationId: string;
  actorId: string;
  action: "confirmed" | "overridden" | "dismissed";
  correctedValue?: string;
  note?: string;
}

/**
 * Resolve one item. A confirm/override on an extracted field also stamps the
 * field row human-verified (the orphaned engine's humanVerified columns — the
 * accuracy loop's ground truth), and any application-linked resolution
 * triggers a decision recalc.
 */
export async function resolveReviewItem(input: ResolveReviewItemInput): Promise<ReviewItem | null> {
  const updated = await db.transaction(async (transaction) => {
    // Replacement registration takes the same lock before it creates a newer
    // lineage row. Whichever operation wins is therefore visible to the other,
    // and obsolete evidence can never be attested during a replacement race.
    await lockDocumentWorkflow(transaction, input.applicationId);
    const [item] = await transaction
      .select()
      .from(reviewItems)
      .where(and(
        eq(reviewItems.id, input.itemId),
        eq(reviewItems.applicationId, input.applicationId),
      ))
      .for("update")
      .limit(1);
    if (!item || item.status !== "open") return null;

    const evidenceIds = evidenceLogicalDocumentIds(item);
    if (requiresDocumentEvidence(item) && evidenceIds.length === 0) return null;
    if (evidenceIds.length > 0) {
      const evidenceRows = await transaction
        .select({
          id: logicalDocuments.id,
          applicationId: logicalDocuments.loanId,
          borrowerId: logicalDocuments.borrowerId,
          documentApplicationId: documents.applicationId,
        })
        .from(logicalDocuments)
        .innerJoin(documents, eq(documents.id, logicalDocuments.sourceDocumentId))
        .leftJoin(documentLineage, eq(documentLineage.documentId, documents.id))
        .where(and(
          inArray(logicalDocuments.id, evidenceIds),
          currentDocumentEvidencePredicate(),
          currentLogicalExtractionEvidencePredicate(),
        ));
      if (
        keepItemsWithCurrentApplicationEvidence(
          [item],
          evidenceRows,
          input.applicationId,
        ).length !== 1
      ) return null;
    }

    const [resolved] = await transaction
      .update(reviewItems)
      .set({
        status: input.action,
        correctedValue: input.action === "overridden" ? (input.correctedValue ?? null) : null,
        resolutionNote: input.note ?? null,
        resolvedBy: input.actorId,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(reviewItems.id, input.itemId),
        eq(reviewItems.applicationId, input.applicationId),
        eq(reviewItems.status, "open"),
      ))
      .returning();
    if (!resolved) return null;

    // Ground-truth stamp on the extracted field, when the item points at one.
    const ev = (item.evidence ?? {}) as { logicalDocumentId?: string; fieldName?: string };
    if (
      (input.action === "confirmed" || input.action === "overridden") &&
      ev.logicalDocumentId &&
      ev.fieldName
    ) {
      await transaction
        .update(extractedFields)
        .set({
          humanVerified: true,
          humanCorrectedValue: input.action === "overridden" ? (input.correctedValue ?? null) : null,
          verifiedByUserId: input.actorId,
          verifiedAt: new Date(),
        })
        .where(and(
          eq(extractedFields.logicalDocumentId, ev.logicalDocumentId),
          eq(extractedFields.fieldName, ev.fieldName),
        ));
      await transaction
        .update(logicalDocuments)
        .set({ verifiedByUserId: input.actorId, verifiedAt: new Date() })
        .where(and(
          eq(logicalDocuments.id, ev.logicalDocumentId),
          eq(logicalDocuments.borrowerId, item.userId),
        ));
    }
    return resolved;
  });

  if (updated) {
    // Fire-and-forget by contract (recalculateDecision never throws upward).
    void recalculateDecision(updated.applicationId!, "review_item_resolved");
  }
  return updated;
}

/** Open-item count per application — the LO Command Center file-health input. */
export async function countOpenReviewItems(
  applicationId: string,
  tier?: ReviewItemTier,
): Promise<number> {
  return (await currentOpenReviewItemsForApplications([applicationId], tier)).get(applicationId) ?? 0;
}

/** Batched current-evidence counts for pipeline and lender-readiness views. */
export async function currentOpenReviewItemsForApplications(
  applicationIds: string[],
  tier?: ReviewItemTier,
): Promise<Map<string, number>> {
  if (applicationIds.length === 0) return new Map();
  const filters = [
    inArray(reviewItems.applicationId, applicationIds),
    eq(reviewItems.status, "open"),
  ];
  if (tier) filters.push(eq(reviewItems.tier, tier));
  const rows = await db
    .select()
    .from(reviewItems)
    .where(and(...filters));
  const currentRows = await keepCurrentOpenItems(rows);
  const counts = new Map<string, number>();
  for (const row of currentRows) {
    if (!row.applicationId) continue;
    counts.set(row.applicationId, (counts.get(row.applicationId) ?? 0) + 1);
  }
  return counts;
}
