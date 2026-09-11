import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  borrowerBusinessEntities,
  borrowerConsents,
  logicalDocuments,
  reviewItems,
  situationProfiles,
  taxExtractionRuns,
  taxInsights,
} from "@shared/schema";
import { db } from "../db";

export type TaxConsentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockTaxConsentWorkflow(
  transaction: TaxConsentTransaction,
  userId: string,
): Promise<void> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tax-consent:${userId}`}, 0))`,
  );
}

async function lockTaxConsentProviderUse(
  transaction: TaxConsentTransaction,
  userId: string,
): Promise<void> {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`tax-consent:${userId}`}, 0))`,
  );
}

async function hasActiveTaxDocumentConsent(
  transaction: TaxConsentTransaction,
  userId: string,
): Promise<boolean> {
  const [consent] = await transaction
    .select({ id: borrowerConsents.id })
    .from(borrowerConsents)
    .where(and(
      eq(borrowerConsents.consentType, "tax_document_use"),
      eq(borrowerConsents.userId, userId),
      eq(borrowerConsents.consentGiven, true),
      eq(borrowerConsents.isRevoked, false),
    ))
    .orderBy(desc(borrowerConsents.consentedAt))
    .limit(1);
  return Boolean(consent);
}

export type ActiveTaxConsentResult<T> =
  | { authorized: true; value: T }
  | { authorized: false; value: null };

/**
 * Final tax-derived writes and consent revocation share this database lock.
 * Whichever operation wins completes first: a later revocation purges the
 * result, while a later persistence attempt observes revoked consent and stops.
 */
export async function withActiveTaxDocumentConsent<T>(
  userId: string,
  run: (transaction: TaxConsentTransaction) => Promise<T>,
  transaction?: TaxConsentTransaction,
): Promise<ActiveTaxConsentResult<T>> {
  const execute = async (
    activeTransaction: TaxConsentTransaction,
  ): Promise<ActiveTaxConsentResult<T>> => {
    await lockTaxConsentWorkflow(activeTransaction, userId);
    if (!(await hasActiveTaxDocumentConsent(activeTransaction, userId))) {
      return { authorized: false, value: null };
    }
    return { authorized: true, value: await run(activeTransaction) };
  };
  return transaction ? execute(transaction) : db.transaction(execute);
}

/**
 * Hold a shared borrower consent lock for one external tax-document use.
 * Concurrent form reads may proceed together, while revocation takes the
 * exclusive version of this lock and cannot complete until those reads finish.
 * Once revocation succeeds, later provider calls observe inactive consent.
 */
export async function withActiveTaxDocumentConsentUse<T>(
  userId: string,
  run: () => Promise<T>,
): Promise<ActiveTaxConsentResult<T>> {
  return db.transaction(async (transaction) => {
    await lockTaxConsentProviderUse(transaction, userId);
    if (!(await hasActiveTaxDocumentConsent(transaction, userId))) {
      return { authorized: false, value: null };
    }
    return { authorized: true, value: await run() };
  });
}

export async function revokeTaxDocumentConsentAndPurge(
  userId: string,
  reason = "borrower_requested",
): Promise<{
  revoked: typeof borrowerConsents.$inferSelect[];
  taxInsightsDeleted: number;
  taxRunsDisabled: number;
  taxFormsDisabled: number;
  businessEntitiesDeleted: number;
  situationProfilesDeleted: number;
  reviewItemsDeleted: number;
}> {
  return db.transaction(async (transaction) => {
    await lockTaxConsentWorkflow(transaction, userId);
    const now = new Date();
    const revoked = await transaction
      .update(borrowerConsents)
      .set({ isRevoked: true, revokedAt: now, revocationReason: reason })
      .where(and(
        eq(borrowerConsents.consentType, "tax_document_use"),
        eq(borrowerConsents.userId, userId),
        eq(borrowerConsents.isRevoked, false),
      ))
      .returning();
    if (revoked.length === 0) {
      return {
        revoked,
        taxInsightsDeleted: 0,
        taxRunsDisabled: 0,
        taxFormsDisabled: 0,
        businessEntitiesDeleted: 0,
        situationProfilesDeleted: 0,
        reviewItemsDeleted: 0,
      };
    }

    const deletedInsights = await transaction
      .delete(taxInsights)
      .where(eq(taxInsights.userId, userId))
      .returning({ id: taxInsights.id });

    // Disable every completed run before deleting projections. All automated
    // tax readers select completed runs, so encrypted lineage remains available
    // for audit while the extracted values stop feeding active analysis.
    const runRows = await transaction
      .select({ id: taxExtractionRuns.id })
      .from(taxExtractionRuns)
      .where(eq(taxExtractionRuns.userId, userId));
    const runIds = runRows.map((row) => row.id);
    let taxFormsDisabled = 0;
    if (runIds.length > 0) {
      const disabledForms = await transaction
        .update(logicalDocuments)
        .set({ status: "revoked", businessEntityId: null, updatedAt: now })
        .where(inArray(logicalDocuments.extractionRunId, runIds))
        .returning({ id: logicalDocuments.id });
      taxFormsDisabled = disabledForms.length;
    }

    const disabledRuns = await transaction
      .update(taxExtractionRuns)
      .set({
        status: "failed",
        error: "Tax document authorization was revoked",
        completedAt: now,
      })
      .where(and(
        eq(taxExtractionRuns.userId, userId),
        eq(taxExtractionRuns.status, "completed"),
      ))
      .returning({ id: taxExtractionRuns.id });

    const deletedEntities = await transaction
      .delete(borrowerBusinessEntities)
      .where(and(
        eq(borrowerBusinessEntities.userId, userId),
        eq(borrowerBusinessEntities.reportedByBorrower, false),
      ))
      .returning({ id: borrowerBusinessEntities.id });
    // Keep borrower-stated identity and non-tax document lineage while
    // removing every field that came from the revoked tax projections.
    await transaction
      .update(borrowerBusinessEntities)
      .set({
        einLast4: null,
        firstTaxYear: null,
        lastTaxYear: null,
        sourceFormCount: 0,
        resolutionNotes: "Reported by borrower in mortgage intake; tax-derived details removed after authorization revocation.",
        updatedAt: now,
      })
      .where(and(
        eq(borrowerBusinessEntities.userId, userId),
        eq(borrowerBusinessEntities.reportedByBorrower, true),
      ));
    const deletedSituations = await transaction
      .delete(situationProfiles)
      .where(eq(situationProfiles.userId, userId))
      .returning({ id: situationProfiles.id });
    const deletedReviewItems = await transaction
      .delete(reviewItems)
      .where(and(
        eq(reviewItems.userId, userId),
        eq(reviewItems.status, "open"),
        inArray(reviewItems.itemType, ["extraction_low_confidence", "tieout_variance"]),
      ))
      .returning({ id: reviewItems.id });

    return {
      revoked,
      taxInsightsDeleted: deletedInsights.length,
      taxRunsDisabled: disabledRuns.length,
      taxFormsDisabled,
      businessEntitiesDeleted: deletedEntities.length,
      situationProfilesDeleted: deletedSituations.length,
      reviewItemsDeleted: deletedReviewItems.length,
    };
  });
}
