import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db";
import {
  applicationProperties,
  auditLogs,
  borrowerBusinessEntities,
  borrowerProfiles,
  dealTeamMembers,
  dealActivities,
  documentExtractionJobs,
  documentLineage,
  documents,
  loanApplications,
  loanConditions,
  logicalDocuments,
  teamMessages,
  users,
  type Document,
  type DocumentLineage,
  type InsertDocument,
} from "@shared/schema";
import { canReviewDocuments, DOCUMENT_STATUS } from "@shared/documentStatus";
import {
  DocumentRequestWorkflowError,
  validateRequestedDocumentResponse,
} from "./documentRequestWorkflow";
import { documentTypesMatch } from "@shared/documentTypes";
import { isAdmin, isInternalStaffRole } from "@shared/roles";
import type { DocumentSubjectOption, DocumentSubjectType, UpdateDocumentLineage } from "@shared/documentLineage";
import { conditionsToRevertAfterRejection } from "./documentConditionWorkflow";
import { currentDocumentEvidencePredicate } from "./currentDocumentEvidence";

export type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DocumentLineageActor = { id: string; role: string };

export class DocumentLineageError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export async function lockDocumentWorkflow(
  transaction: DatabaseTransaction,
  applicationId: string,
) {
  // Every document-version and human-review writer for one loan takes this
  // transaction lock first. That gives replacement and review one linear order
  // before either path locks request/document rows.
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`document-workflow:${applicationId}`}))`,
  );
}

async function lockStandaloneDocumentWorkflow(
  transaction: DatabaseTransaction,
  documentId: string,
) {
  await transaction.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`document-workflow:standalone:${documentId}`}))`,
  );
}

// A locked extraction callback performs a few repository-native writes through
// the shared pool. Bound the number of outer lock transactions so a burst of
// uploads cannot occupy every connection while the lock holder needs one for
// those downstream writes.
const MAX_LOCKED_EXTRACTION_WORKFLOWS = 4;
let activeLockedExtractionWorkflows = 0;
const lockedExtractionWaiters: Array<() => void> = [];

async function withLockedExtractionSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeLockedExtractionWorkflows >= MAX_LOCKED_EXTRACTION_WORKFLOWS) {
    await new Promise<void>((resolve) => lockedExtractionWaiters.push(resolve));
  }
  activeLockedExtractionWorkflows += 1;
  try {
    return await run();
  } finally {
    activeLockedExtractionWorkflows -= 1;
    lockedExtractionWaiters.shift()?.();
  }
}

/**
 * Serialize extraction persistence with the human-review verdict without
 * holding a document row lock while downstream persistence uses the shared
 * database pool. The callback runs while the advisory lock is held.
 */
export async function withDocumentWorkflowLock<T>(
  documentId: string,
  run: (
    document: Document,
    isCurrentVersion: boolean,
    transaction: DatabaseTransaction,
  ) => Promise<T>,
): Promise<T> {
  return withLockedExtractionSlot(() => db.transaction(async (transaction) => {
    const [candidate] = await transaction
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!candidate) throw new DocumentLineageError("Document not found", 404);
    if (candidate.applicationId) {
      await lockDocumentWorkflow(transaction, candidate.applicationId);
    } else {
      await lockStandaloneDocumentWorkflow(transaction, candidate.id);
    }
    const [current] = await transaction
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!current) throw new DocumentLineageError("Document not found", 404);
    const [lineage] = await transaction
      .select({
        applicationId: documentLineage.applicationId,
        lineageId: documentLineage.lineageId,
      })
      .from(documentLineage)
      .where(eq(documentLineage.documentId, current.id))
      .limit(1);
    let isCurrentVersion = true;
    if (lineage) {
      const [latest] = await transaction
        .select({ documentId: documentLineage.documentId })
        .from(documentLineage)
        .where(and(
          eq(documentLineage.applicationId, lineage.applicationId),
          eq(documentLineage.lineageId, lineage.lineageId),
        ))
        .orderBy(desc(documentLineage.versionNumber))
        .limit(1);
      isCurrentVersion = latest?.documentId === current.id;
    }
    return run(current, isCurrentVersion, transaction);
  }));
}

export type DocumentProcessingBlockReason = "reviewed" | "replaced";

export function documentProcessingBlockReason(
  document: Pick<Document, "status">,
  isCurrentVersion: boolean,
): DocumentProcessingBlockReason | null {
  if (!isCurrentVersion) return "replaced";
  if (
    document.status === DOCUMENT_STATUS.VERIFIED ||
    document.status === DOCUMENT_STATUS.REJECTED
  ) {
    return "reviewed";
  }
  return null;
}

/**
 * Cheap preflight for model-backed work. The post-model persistence path must
 * repeat this check because replacement or review can win while the model runs.
 */
export async function getDocumentProcessingBlockReason(
  documentId: string,
): Promise<DocumentProcessingBlockReason | null> {
  return withDocumentWorkflowLock(documentId, async (document, isCurrentVersion) =>
    documentProcessingBlockReason(document, isCurrentVersion),
  );
}

function userLabel(row: { firstName: string | null; lastName: string | null; email: string | null }) {
  return [row.firstName, row.lastName].filter(Boolean).join(" ") || row.email || "Borrower";
}

async function applicationAndBorrowerIds(transaction: DatabaseTransaction, applicationId: string) {
  const [application] = await transaction.select().from(loanApplications)
    .where(eq(loanApplications.id, applicationId)).limit(1);
  if (!application) throw new DocumentLineageError("Application not found", 404);
  const [profile] = await transaction.select({ coBorrowerUserId: borrowerProfiles.coBorrowerUserId })
    .from(borrowerProfiles).where(eq(borrowerProfiles.userId, application.userId)).limit(1);
  return {
    application,
    borrowerIds: [application.userId, profile?.coBorrowerUserId].filter((id): id is string => Boolean(id)),
  };
}

export async function assertDocumentLineageAccess(
  transaction: DatabaseTransaction,
  applicationId: string,
  actor: DocumentLineageActor,
) {
  if (!isInternalStaffRole(actor.role)) throw new DocumentLineageError("Staff access required", 403);
  const context = await applicationAndBorrowerIds(transaction, applicationId);
  if (!isAdmin(actor)) {
    const [membership] = await transaction.select({ id: dealTeamMembers.id }).from(dealTeamMembers).where(and(
      eq(dealTeamMembers.applicationId, applicationId),
      eq(dealTeamMembers.userId, actor.id),
      eq(dealTeamMembers.isActive, true),
    )).limit(1);
    if (!membership) throw new DocumentLineageError("Application not found", 404);
  }
  return context;
}

async function validateSubject(
  transaction: DatabaseTransaction,
  applicationId: string,
  subjectType: DocumentSubjectType,
  subjectId: string,
) {
  const { borrowerIds } = await applicationAndBorrowerIds(transaction, applicationId);
  if (subjectType === "application") {
    if (subjectId !== applicationId) throw new DocumentLineageError("Choose this loan file as the evidence subject");
    return;
  }
  if (subjectType === "borrower") {
    if (!borrowerIds.includes(subjectId)) throw new DocumentLineageError("Choose a borrower on this application");
    return;
  }
  if (subjectType === "business") {
    const [business] = await transaction.select({ id: borrowerBusinessEntities.id }).from(borrowerBusinessEntities).where(and(
      eq(borrowerBusinessEntities.id, subjectId), eq(borrowerBusinessEntities.applicationId, applicationId),
    )).limit(1);
    if (!business) throw new DocumentLineageError("Choose a business on this application");
    return;
  }
  const [property] = await transaction.select({ id: applicationProperties.id }).from(applicationProperties).where(and(
    eq(applicationProperties.id, subjectId), eq(applicationProperties.applicationId, applicationId),
  )).limit(1);
  if (!property) throw new DocumentLineageError("Choose a property on this application");
}

function defaultSubject(applicationId: string, borrowerIds: string[], uploaderId: string) {
  return borrowerIds.includes(uploaderId)
    ? { subjectType: "borrower" as const, subjectId: uploaderId }
    : { subjectType: "application" as const, subjectId: applicationId };
}

async function ensureLegacyLineage(
  transaction: DatabaseTransaction,
  applicationId: string,
  document: Document,
  borrowerIds: string[],
): Promise<DocumentLineage> {
  const [existing] = await transaction.select().from(documentLineage)
    .where(eq(documentLineage.documentId, document.id)).limit(1);
  if (existing) return existing;
  const subject = defaultSubject(applicationId, borrowerIds, document.userId);
  const [created] = await transaction.insert(documentLineage).values({
    applicationId,
    documentId: document.id,
    lineageId: document.id,
    versionNumber: 1,
    contentSha256: null,
    ...subject,
    recordedByUserId: document.userId,
  }).returning();
  return created;
}

export interface RegisterDocumentVersionInput {
  actor: DocumentLineageActor;
  document: InsertDocument;
  contentSha256: string | null;
  replacesDocumentId?: string;
  /** Inserted with the document so an acknowledged upload cannot lose work. */
  extractionJob?: {
    mode: "standard" | "autopilot" | "tax_package";
    requestedByUserId: string;
  };
}

async function insertExtractionJob(
  transaction: DatabaseTransaction,
  documentId: string,
  extractionJob: RegisterDocumentVersionInput["extractionJob"],
) {
  if (!extractionJob) return;
  await transaction.insert(documentExtractionJobs).values({
    documentId,
    requestedByUserId: extractionJob.requestedByUserId,
    mode: extractionJob.mode,
  });
}

async function registerDocumentVersionInTransaction(
  transaction: DatabaseTransaction,
  input: RegisterDocumentVersionInput,
  workflowLockHeld = false,
) {
    const applicationId = input.document.applicationId ?? null;
    if (!applicationId) {
      const [document] = await transaction.insert(documents).values(input.document).returning();
      await insertExtractionJob(transaction, document.id, input.extractionJob);
      return { document, lineage: null };
    }
    if (!workflowLockHeld) await lockDocumentWorkflow(transaction, applicationId);
    const { borrowerIds } = await applicationAndBorrowerIds(transaction, applicationId);
    let prior: Document | undefined;
    let priorLineage: DocumentLineage | undefined;
    if (input.replacesDocumentId) {
      [prior] = await transaction.select().from(documents).where(and(
        eq(documents.id, input.replacesDocumentId), eq(documents.applicationId, applicationId),
      )).for("update").limit(1);
      if (!prior) throw new DocumentLineageError("The document to replace is not on this loan file", 404);
      // External partner roles can contribute documents to an assigned file,
      // but only internal staff may supersede evidence another user supplied.
      if (!isInternalStaffRole(input.actor.role) && prior.userId !== input.actor.id) {
        throw new DocumentLineageError("The document to replace is not available", 404);
      }
      if (!documentTypesMatch(prior.documentType ?? "other", input.document.documentType ?? "other")) {
        throw new DocumentLineageError("A replacement must use the same document type");
      }
      priorLineage = await ensureLegacyLineage(transaction, applicationId, prior, borrowerIds);
      const [latest] = await transaction.select({ documentId: documentLineage.documentId })
        .from(documentLineage)
        .where(and(eq(documentLineage.applicationId, applicationId), eq(documentLineage.lineageId, priorLineage.lineageId)))
        .orderBy(desc(documentLineage.versionNumber)).limit(1);
      if (latest?.documentId !== prior.id) {
        throw new DocumentLineageError("A newer replacement already exists. Refresh the document list.", 409);
      }
    }

    const [document] = await transaction.insert(documents).values(input.document).returning();
    const inherited = priorLineage
      ? {
          lineageId: priorLineage.lineageId,
          versionNumber: priorLineage.versionNumber + 1,
          replacesDocumentId: priorLineage.documentId,
          subjectType: priorLineage.subjectType,
          subjectId: priorLineage.subjectId,
          periodStart: priorLineage.periodStart,
          periodEnd: priorLineage.periodEnd,
          taxYear: priorLineage.taxYear,
        }
      : {
          lineageId: randomUUID(),
          versionNumber: 1,
          replacesDocumentId: null,
          ...defaultSubject(applicationId, borrowerIds, input.actor.id),
          periodStart: null,
          periodEnd: null,
          taxYear: null,
        };
    const [lineage] = await transaction.insert(documentLineage).values({
      applicationId,
      documentId: document.id,
      ...inherited,
      contentSha256: input.contentSha256,
      recordedByUserId: input.actor.id,
    }).returning();
    await insertExtractionJob(transaction, document.id, input.extractionJob);
    await transaction.insert(auditLogs).values({
      actorUserId: input.actor.id,
      action: input.replacesDocumentId ? "document.version_replaced" : "document.lineage_recorded",
      targetType: "document",
      targetId: document.id,
      metadata: {
        applicationId,
        lineageId: lineage.lineageId,
        versionNumber: lineage.versionNumber,
        replacesDocumentId: lineage.replacesDocumentId,
        subjectType: lineage.subjectType,
        subjectId: lineage.subjectId,
        contentFingerprintRecorded: Boolean(lineage.contentSha256),
      },
    });
    return { document, lineage };
}

async function registerAndSubmitRequests(
  transaction: DatabaseTransaction,
  input: RegisterDocumentVersionInput,
  messages: Array<typeof teamMessages.$inferSelect>,
) {
  const validated = messages.map((message) => {
    try {
      return {
        message,
        requestData: validateRequestedDocumentResponse({
          message,
          actorId: input.actor.id,
          document: input.document,
          replacesDocumentId: input.replacesDocumentId,
        }),
      };
    } catch (error) {
      if (error instanceof DocumentRequestWorkflowError) {
        throw new DocumentLineageError(error.message, error.status);
      }
      throw error;
    }
  });

  const registered = await registerDocumentVersionInTransaction(transaction, input, true);
  const now = new Date().toISOString();
  const updatedRequests = [];
  for (const { message, requestData } of validated) {
    const {
      rejectionReason: _previousRejectionReason,
      reviewedAt: _previousReviewedAt,
      ...resubmittedRequestData
    } = requestData;
    const [updatedRequest] = await transaction
      .update(teamMessages)
      .set({
        documentRequestData: {
          ...resubmittedRequestData,
          status: "submitted",
          documentId: registered.document.id,
          respondedAt: now,
        },
      })
      .where(eq(teamMessages.id, message.id))
      .returning();
    updatedRequests.push(updatedRequest);
    await transaction.insert(auditLogs).values({
      actorUserId: input.actor.id,
      action: "document_request.submitted",
      targetType: "team_message",
      targetId: message.id,
      metadata: {
        applicationId: message.applicationId,
        documentId: registered.document.id,
        replacedDocumentId: input.replacesDocumentId ?? null,
      },
    });
  }
  return {
    ...registered,
    request: updatedRequests[0],
    requests: updatedRequests,
  };
}

export async function registerDocumentVersion(input: RegisterDocumentVersionInput) {
  return db.transaction(async (transaction) => {
    const applicationId = input.document.applicationId ?? null;
    if (!applicationId) {
      return registerDocumentVersionInTransaction(transaction, input);
    }
    await lockDocumentWorkflow(transaction, applicationId);

    // A replacement may start from the Documents page instead of the request
    // card. Resolve the exact rejected request from authoritative server state
    // so every borrower entry point advances it in this same transaction.
    if (
      input.replacesDocumentId &&
      input.document.userId === input.actor.id
    ) {
      const candidates = await transaction
        .select()
        .from(teamMessages)
        .where(and(
          eq(teamMessages.messageType, "document_request"),
          eq(teamMessages.applicationId, applicationId),
          sql`${teamMessages.documentRequestData}->>'documentId' = ${input.replacesDocumentId}`,
        ))
        .for("update");
      const matchingRequests = candidates.filter((message) => {
        const requestData = message.documentRequestData as Record<string, unknown> | null;
        return (
          message.recipientId === input.actor.id &&
          requestData?.status === "rejected" &&
          typeof requestData.documentType === "string" &&
          documentTypesMatch(
            requestData.documentType,
            input.document.documentType ?? "other",
          )
        );
      });
      if (matchingRequests.length > 0) {
        return registerAndSubmitRequests(transaction, input, matchingRequests);
      }
    }

    return registerDocumentVersionInTransaction(transaction, input, true);
  });
}

/**
 * Register a borrower response and advance its chat request in one database
 * transaction. A document can never be filed successfully while its visible
 * request remains pending, and a correction must replace the exact rejected
 * document rather than creating a second logical document.
 */
export async function registerRequestedDocumentVersion(
  input: RegisterDocumentVersionInput & { requestMessageId: string },
) {
  return db.transaction(async (transaction) => {
    const applicationId = input.document.applicationId ?? null;
    if (!applicationId) {
      throw new DocumentLineageError("A document request must belong to a loan application");
    }
    // Lock the application workflow before either the request or document row.
    // The review path uses the same first lock, preventing opposite lock-order
    // deadlocks while serializing replacement against review.
    await lockDocumentWorkflow(transaction, applicationId);
    const [message] = await transaction
      .select()
      .from(teamMessages)
      .where(eq(teamMessages.id, input.requestMessageId))
      .for("update")
      .limit(1);
    if (!message) throw new DocumentLineageError("Document request not found", 404);
    return registerAndSubmitRequests(transaction, input, [message]);
  });
}

export interface ReviewCurrentDocumentInput {
  actor: DocumentLineageActor;
  documentId: string;
  status: typeof DOCUMENT_STATUS.VERIFIED | typeof DOCUMENT_STATUS.REJECTED;
  rejectionReason?: string;
}

/**
 * Apply the one authoritative human verdict for the current document version.
 * Replacement, verdict conflict, and request-card synchronization are resolved
 * under the same application workflow lock and database transaction.
 */
export async function reviewCurrentDocument(input: ReviewCurrentDocumentInput) {
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction
      .select()
      .from(documents)
      .where(eq(documents.id, input.documentId))
      .limit(1);
    if (!candidate) throw new DocumentLineageError("Document not found", 404);

    if (!canReviewDocuments(input.actor.role)) {
      throw new DocumentLineageError("Document reviewer access required", 403);
    }

    let borrowerIds: string[] = [];
    if (candidate.applicationId) {
      await lockDocumentWorkflow(transaction, candidate.applicationId);
      const context = await applicationAndBorrowerIds(transaction, candidate.applicationId);
      borrowerIds = context.borrowerIds;
      if (!isAdmin(input.actor)) {
        const [membership] = await transaction
          .select({ id: dealTeamMembers.id })
          .from(dealTeamMembers)
          .where(and(
            eq(dealTeamMembers.applicationId, candidate.applicationId),
            eq(dealTeamMembers.userId, input.actor.id),
            eq(dealTeamMembers.isActive, true),
          ))
          .limit(1);
        if (!membership) throw new DocumentLineageError("Unauthorized", 403);
      }
    } else {
      if (!isAdmin(input.actor)) {
        throw new DocumentLineageError("Unauthorized", 403);
      }
      await lockStandaloneDocumentWorkflow(transaction, candidate.id);
    }

    const [document] = await transaction
      .select()
      .from(documents)
      .where(eq(documents.id, input.documentId))
      .for("update")
      .limit(1);
    if (!document) throw new DocumentLineageError("Document not found", 404);

    if (document.applicationId) {
      const lineage = await ensureLegacyLineage(
        transaction,
        document.applicationId,
        document,
        borrowerIds,
      );
      const [latest] = await transaction
        .select({ documentId: documentLineage.documentId })
        .from(documentLineage)
        .where(and(
          eq(documentLineage.applicationId, document.applicationId),
          eq(documentLineage.lineageId, lineage.lineageId),
        ))
        .orderBy(desc(documentLineage.versionNumber))
        .limit(1);
      if (latest?.documentId !== document.id) {
        throw new DocumentLineageError(
          "A newer replacement is already on file. Review the current version instead.",
          409,
        );
      }
    }

    const alreadyFinal =
      document.status === DOCUMENT_STATUS.VERIFIED ||
      document.status === DOCUMENT_STATUS.REJECTED;
    if (alreadyFinal && document.status !== input.status) {
      throw new DocumentLineageError(
        "This document was already reviewed. Refresh the file before changing the decision.",
        409,
      );
    }

    let reviewedDocument = document;
    const decisionApplied = document.status !== input.status;
    if (decisionApplied) {
      const [updated] = await transaction
        .update(documents)
        .set({
          status: input.status,
          rejectionReason:
            input.status === DOCUMENT_STATUS.REJECTED
              ? input.rejectionReason ?? null
              : null,
          reviewedByUserId: input.actor.id,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(documents.id, document.id))
        .returning();
      reviewedDocument = updated;
      await transaction.update(logicalDocuments).set({
        status: input.status === DOCUMENT_STATUS.VERIFIED ? "accepted" : "rejected",
        verifiedByUserId: input.actor.id,
        verifiedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(logicalDocuments.sourceDocumentId, document.id),
        ne(logicalDocuments.status, "rejected"),
      ));
    }

    // Repair the borrower-facing projection on an idempotent retry as well.
    const requests = await transaction
      .select()
      .from(teamMessages)
      .where(and(
        eq(teamMessages.messageType, "document_request"),
        ...(document.applicationId
          ? [eq(teamMessages.applicationId, document.applicationId)]
          : []),
        sql`${teamMessages.documentRequestData}->>'documentId' = ${document.id}`,
      ))
      .for("update");
    for (const request of requests) {
      const current = request.documentRequestData as Record<string, unknown> | null;
      if (
        !current ||
        current.status !== "submitted" ||
        request.recipientId !== document.userId ||
        typeof current.documentType !== "string" ||
        !documentTypesMatch(current.documentType, document.documentType ?? "other")
      ) {
        continue;
      }
      const next: Record<string, unknown> = {
        ...current,
        status:
          input.status === DOCUMENT_STATUS.VERIFIED ? "approved" : "rejected",
        reviewedAt: new Date().toISOString(),
      };
      if (input.status === DOCUMENT_STATUS.REJECTED) {
        next.rejectionReason = input.rejectionReason;
      } else {
        delete next.rejectionReason;
      }
      await transaction
        .update(teamMessages)
        .set({ documentRequestData: next })
        .where(eq(teamMessages.id, request.id));
    }

    // The verdict and its condition re-arm are one application transaction.
    // Replacement registration and upload matching take the same advisory lock,
    // so neither ordering can leave a current replacement paired with an
    // outstanding condition.
    if (input.status === DOCUMENT_STATUS.REJECTED && document.applicationId) {
      const conditions = await transaction
        .select()
        .from(loanConditions)
        .where(and(
          eq(loanConditions.applicationId, document.applicationId),
          eq(loanConditions.status, "submitted"),
        ))
        .for("update");
      const applicationDocuments = await transaction
        .select({ documentType: documents.documentType, status: documents.status })
        .from(documents)
        .leftJoin(documentLineage, eq(documentLineage.documentId, documents.id))
        .where(and(
          eq(documents.applicationId, document.applicationId),
          currentDocumentEvidencePredicate(),
        ));
      const revertIds = conditionsToRevertAfterRejection({
        conditions,
        documents: applicationDocuments,
        rejectedDocumentType: document.documentType,
      });
      for (const conditionId of revertIds) {
        const [reverted] = await transaction
          .update(loanConditions)
          .set({ status: "outstanding", updatedAt: new Date() })
          .where(and(
            eq(loanConditions.id, conditionId),
            eq(loanConditions.status, "submitted"),
          ))
          .returning({ id: loanConditions.id, title: loanConditions.title });
        if (!reverted) continue;
        await transaction.insert(dealActivities).values({
          applicationId: document.applicationId,
          activityType: "note",
          title: `Condition back to outstanding: ${reverted.title}`,
          description: `${document.fileName} (${document.documentType.replace(/_/g, " ")}) was rejected on review — a replacement document is needed.`,
          performedBy: input.actor.id,
        });
      }
    }

    return { document: reviewedDocument, decisionApplied };
  });
}

export async function updateDocumentLineage(
  applicationId: string,
  documentId: string,
  actor: DocumentLineageActor,
  input: UpdateDocumentLineage,
) {
  return db.transaction(async transaction => {
    await lockDocumentWorkflow(transaction, applicationId);
    const { borrowerIds } = await assertDocumentLineageAccess(transaction, applicationId, actor);
    if (!canReviewDocuments(actor.role)) throw new DocumentLineageError("Document reviewer access required", 403);
    const [document] = await transaction.select().from(documents).where(and(
      eq(documents.id, documentId), eq(documents.applicationId, applicationId),
    )).for("update").limit(1);
    if (!document) throw new DocumentLineageError("Document not found", 404);
    await validateSubject(transaction, applicationId, input.subjectType, input.subjectId);
    const current = await ensureLegacyLineage(transaction, applicationId, document, borrowerIds);
    const [latest] = await transaction.select({ documentId: documentLineage.documentId }).from(documentLineage)
      .where(and(eq(documentLineage.applicationId, applicationId), eq(documentLineage.lineageId, current.lineageId)))
      .orderBy(desc(documentLineage.versionNumber)).limit(1);
    if (latest?.documentId !== documentId) {
      throw new DocumentLineageError("This version has been replaced. Edit the current version instead.", 409);
    }
    const [updated] = await transaction.update(documentLineage).set({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      taxYear: input.taxYear ?? null,
    }).where(eq(documentLineage.id, current.id)).returning();
    await transaction.insert(auditLogs).values({
      actorUserId: actor.id,
      action: "document.lineage_updated",
      targetType: "document",
      targetId: documentId,
      metadata: {
        applicationId,
        lineageId: updated.lineageId,
        versionNumber: updated.versionNumber,
        subjectType: updated.subjectType,
        subjectId: updated.subjectId,
        periodStart: updated.periodStart,
        periodEnd: updated.periodEnd,
        taxYear: updated.taxYear,
      },
    });
    return updated;
  });
}

export async function subjectOptions(
  transaction: DatabaseTransaction,
  applicationId: string,
): Promise<DocumentSubjectOption[]> {
  const { borrowerIds } = await applicationAndBorrowerIds(transaction, applicationId);
  const [borrowers, businesses, properties] = await Promise.all([
    borrowerIds.length ? transaction.select({ id: users.id, firstName: users.firstName, lastName: users.lastName, email: users.email })
      .from(users).where(inArray(users.id, borrowerIds)) : [],
    transaction.select({ id: borrowerBusinessEntities.id, name: borrowerBusinessEntities.name })
      .from(borrowerBusinessEntities).where(eq(borrowerBusinessEntities.applicationId, applicationId)),
    transaction.select({ id: applicationProperties.id, address: applicationProperties.address })
      .from(applicationProperties).where(eq(applicationProperties.applicationId, applicationId)),
  ]);
  return [
    { type: "application", id: applicationId, label: "Whole loan file" },
    ...borrowers.map(row => ({ type: "borrower" as const, id: row.id, label: userLabel(row) })),
    ...businesses.map(row => ({ type: "business" as const, id: row.id, label: row.name || "Unnamed business" })),
    ...properties.map(row => ({ type: "property" as const, id: row.id, label: row.address })),
  ];
}

export function currentDocumentVersions(
  documentRows: Document[],
  lineageRows: DocumentLineage[],
) {
  const byDocument = new Map(lineageRows.map(row => [row.documentId, row]));
  const histories = new Map<string, Array<{ document: Document; lineage: DocumentLineage | null }>>();
  for (const document of documentRows) {
    const lineage = byDocument.get(document.id) ?? null;
    const key = lineage?.lineageId ?? document.id;
    const history = histories.get(key) ?? [];
    history.push({ document, lineage });
    histories.set(key, history);
  }
  for (const history of histories.values()) history.sort((a, b) =>
    (a.lineage?.versionNumber ?? 1) - (b.lineage?.versionNumber ?? 1)
      || String(a.document.createdAt ?? "").localeCompare(String(b.document.createdAt ?? ""))
      || a.document.id.localeCompare(b.document.id),
  );
  return [...histories.entries()].map(([lineageId, history]) => ({
    lineageId,
    history,
    current: history[history.length - 1],
  }));
}
