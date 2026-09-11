import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import {
  borrowerBusinessEntities,
  documents,
  loanApplications,
  situationProfiles,
  taxExtractionRuns,
} from "@shared/schema";

export interface PlanningDocumentHandoffResult {
  [key: string]: number;
  documents: number;
  taxRuns: number;
  businessEntities: number;
  situationProfiles: number;
}

/**
 * Move the borrower's account-level planning evidence onto a newly active
 * mortgage file. Renter-path tax analysis intentionally works before an
 * application exists; this is the one ownership-checked bridge that keeps the
 * source document and its derived tax intelligence together once a draft is
 * opened.
 *
 * Idempotent: after the first handoff no applicationless rows remain to move.
 * The application ownership check is inside the same transaction as every
 * update, so a caller bug cannot cross borrower boundaries.
 */
export async function attachPlanningDocumentsToApplication(
  userId: string,
  applicationId: string,
): Promise<PlanningDocumentHandoffResult> {
  return db.transaction(async (tx) => {
    const [ownedApplication] = await tx
      .select({ id: loanApplications.id })
      .from(loanApplications)
      .where(and(
        eq(loanApplications.id, applicationId),
        eq(loanApplications.userId, userId),
      ))
      .limit(1);
    if (!ownedApplication) {
      throw new Error("Planning documents can only be attached to the borrower's own application");
    }

    const movedDocuments = await tx
      .update(documents)
      .set({ applicationId, updatedAt: new Date() })
      .where(and(eq(documents.userId, userId), isNull(documents.applicationId)))
      .returning({ id: documents.id });

    if (movedDocuments.length === 0) {
      return { documents: 0, taxRuns: 0, businessEntities: 0, situationProfiles: 0 };
    }

    const documentIds = movedDocuments.map((document) => document.id);
    const movedTaxRuns = await tx
      .update(taxExtractionRuns)
      .set({ applicationId })
      .where(and(
        inArray(taxExtractionRuns.documentId, documentIds),
        isNull(taxExtractionRuns.applicationId),
      ))
      .returning({ id: taxExtractionRuns.id });
    const movedBusinessEntities = await tx
      .update(borrowerBusinessEntities)
      .set({ applicationId, updatedAt: new Date() })
      .where(and(
        eq(borrowerBusinessEntities.userId, userId),
        isNull(borrowerBusinessEntities.applicationId),
      ))
      .returning({ id: borrowerBusinessEntities.id });
    const movedSituationProfiles = await tx
      .update(situationProfiles)
      .set({ applicationId })
      .where(and(
        eq(situationProfiles.userId, userId),
        isNull(situationProfiles.applicationId),
      ))
      .returning({ id: situationProfiles.id });

    return {
      documents: movedDocuments.length,
      taxRuns: movedTaxRuns.length,
      businessEntities: movedBusinessEntities.length,
      situationProfiles: movedSituationProfiles.length,
    };
  });
}
