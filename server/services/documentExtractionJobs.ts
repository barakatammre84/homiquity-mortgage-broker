import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, max, ne, or, sql } from "drizzle-orm";
import {
  auditLogs,
  documentExtractionJobs,
  documents,
  type Document,
  type DocumentExtractionJob,
} from "@shared/schema";
import type { DocumentClassification, ExtractedDocumentData } from "../extractionCore";
import { db } from "../db";
import { storage } from "../storage";
import {
  extractBankStatementData,
  extractLeaseData,
  extractPayStubData,
  extractW2Data,
} from "../extractionService";
import { applyExtractionToDocument } from "./extractionPersistence";
import {
  documentProcessingBlockReason,
  getDocumentProcessingBlockReason,
  withDocumentWorkflowLock,
  type DatabaseTransaction,
} from "./documentLineage";
import { hasUserConsent } from "../consentGate";
import { resolveDocumentBorrowerUserId } from "./documentBorrower";
import { withActiveTaxDocumentConsent } from "./taxConsentWorkflow";
import {
  classifyExtractionResult,
  hasActionableExtractionWarning,
  type ExtractionFailure,
} from "./documentExtractionOutcome";
import {
  CORE_EXTRACTION_RESTART_JOB_ID,
  CORE_EXTRACTION_RESTART_LEASE_MS,
  CoreExtractionRestartProofError,
  coreExtractionRestartCompletionAudit,
  documentExtractionHeartbeatMs,
  documentExtractionLeaseMs,
  holdCoreExtractionRestartFirstResult,
  isCoreExtractionRestartJob,
  recordCoreExtractionRestartProviderReady,
} from "./coreExtractionRestartProof";
import {
  CORE_TAX_PACKET_CANARY_JOB_ID,
  CoreTaxPacketCanaryError,
  assertCoreTaxPacketCanaryRuntimeIdentity,
  isCoreTaxPacketCanaryJob,
} from "./coreTaxPacketCanary";

export const STANDARD_AUTO_EXTRACT_TYPES = [
  "pay_stub",
  "w2",
  "bank_statement",
  "lease_agreement",
] as const;

export type DocumentExtractionMode = "standard" | "autopilot" | "tax_package";
export type DocumentExtractionWorkerLane = "ordinary" | "tax_package";
export type DocumentExtractionJobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

const STANDARD_TYPE_SET = new Set<string>(STANDARD_AUTO_EXTRACT_TYPES);
const LEASE_MS = 5 * 60 * 1000;
const POLL_MS = 5 * 1000;
const RECONCILE_MS = 5 * 60 * 1000;
const RECONCILE_LOOKBACK_MS = 60 * 60 * 1000;
const MAX_RECONCILE_ROWS = 100;
const workerId = `${process.pid}-${randomUUID()}`;

export function jobBelongsToWorkerLane(
  mode: DocumentExtractionMode,
  lane: DocumentExtractionWorkerLane,
): boolean {
  return lane === "tax_package" ? mode === "tax_package" : mode !== "tax_package";
}

export class StaleDocumentExtractionClaimError extends Error {
  readonly code = "STALE_DOCUMENT_EXTRACTION_CLAIM";

  constructor(readonly jobId: string) {
    super(`Document extraction job ${jobId} is no longer owned by this worker`);
  }
}

function jobClaimToken(job: DocumentExtractionJob): string {
  if (!job.claimedBy) throw new StaleDocumentExtractionClaimError(job.id);
  return job.claimedBy;
}

/**
 * Lock the job row and renew its lease for the duration of a persistence
 * critical section. Reclaim uses FOR UPDATE SKIP LOCKED, so another worker
 * cannot take ownership until the protected writes finish.
 */
export async function lockActiveDocumentExtractionClaim(
  job: Pick<DocumentExtractionJob, "id" | "claimedBy">,
  transaction: DatabaseTransaction,
  now = new Date(),
): Promise<void> {
  const claimToken = job.claimedBy;
  if (!claimToken) throw new StaleDocumentExtractionClaimError(job.id);
  const [active] = await transaction
    .select({ id: documentExtractionJobs.id })
    .from(documentExtractionJobs)
    .where(and(
      eq(documentExtractionJobs.id, job.id),
      eq(documentExtractionJobs.status, "processing"),
      eq(documentExtractionJobs.claimedBy, claimToken),
      sql`${documentExtractionJobs.leaseExpiresAt} > CURRENT_TIMESTAMP`,
    ))
    .for("update")
    .limit(1);
  if (!active) throw new StaleDocumentExtractionClaimError(job.id);
  await transaction
    .update(documentExtractionJobs)
    .set({ leaseExpiresAt: new Date(now.getTime() + LEASE_MS), updatedAt: now })
    .where(and(
      eq(documentExtractionJobs.id, job.id),
      eq(documentExtractionJobs.claimedBy, claimToken),
    ));
}

export async function assertActiveDocumentExtractionClaim(
  job: Pick<DocumentExtractionJob, "id" | "claimedBy">,
  now = new Date(),
): Promise<void> {
  const claimToken = job.claimedBy;
  if (!claimToken) throw new StaleDocumentExtractionClaimError(job.id);
  const [active] = await db
    .select({ id: documentExtractionJobs.id })
    .from(documentExtractionJobs)
    .where(and(
      eq(documentExtractionJobs.id, job.id),
      eq(documentExtractionJobs.status, "processing"),
      eq(documentExtractionJobs.claimedBy, claimToken),
      sql`${documentExtractionJobs.leaseExpiresAt} > CURRENT_TIMESTAMP`,
    ))
    .limit(1);
  if (!active) throw new StaleDocumentExtractionClaimError(job.id);
}

interface DocumentExtractionClaimFence {
  assertActive(): Promise<void>;
  lockForPersistence(transaction: DatabaseTransaction): Promise<void>;
}

export function standardDocumentNeedsExtraction(documentType: string): boolean {
  return STANDARD_TYPE_SET.has(documentType);
}

export function classifyTaxPackageFailure(error?: string): ExtractionFailure {
  const normalized = error?.toLowerCase() ?? "";
  if (normalized.includes("extraction_simulate cannot be enabled in production")) {
    return { code: "invalid_production_extraction_configuration", retryable: false };
  }
  if (normalized.includes("not configured")) {
    return { code: "provider_not_configured", retryable: false };
  }
  if (
    normalized.includes("could not be validated") ||
    normalized.includes("failed schema validation") ||
    normalized.includes("no usable result") ||
    normalized.includes("unsupported tax packet source type") ||
    (normalized.includes("outside the") && normalized.includes("-page source")) ||
    (normalized.includes("pages for a") && normalized.includes("-page source")) ||
    normalized.includes("provider excerpt limit") ||
    normalized.includes("tax form page ranges overlap") ||
    normalized.includes("split the source packet before provider extraction")
  ) {
    return { code: "tax_package_validation_failed", retryable: false };
  }
  return { code: "tax_package_processing_failed", retryable: true };
}

export async function enqueueTaxPackageExtraction(
  documentId: string,
  requestedByUserId: string,
): Promise<DocumentExtractionJob> {
  const [inserted] = await db
    .insert(documentExtractionJobs)
    .values({ documentId, requestedByUserId, mode: "tax_package" })
    .onConflictDoNothing({
      target: [documentExtractionJobs.documentId, documentExtractionJobs.mode],
    })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(documentExtractionJobs)
    .where(and(
      eq(documentExtractionJobs.documentId, documentId),
      eq(documentExtractionJobs.mode, "tax_package"),
    ))
    .limit(1);
  if (!existing) throw new Error("Tax package extraction job could not be created");
  if (existing.status === "pending" || existing.status === "processing") return existing;

  const now = new Date();
  const [requeued] = await db
    .update(documentExtractionJobs)
    .set({
      status: "pending",
      attemptCount: 0,
      availableAt: now,
      claimedAt: null,
      leaseExpiresAt: null,
      claimedBy: null,
      lastErrorCode: null,
      lastErrorAt: null,
      completedAt: null,
      requestedByUserId,
      updatedAt: now,
    })
    .where(and(
      eq(documentExtractionJobs.id, existing.id),
      inArray(documentExtractionJobs.status, ["completed", "failed", "cancelled"]),
    ))
    .returning();
  return requeued ?? existing;
}

export async function getTaxPackageExtractionJob(
  documentId: string,
): Promise<DocumentExtractionJob | null> {
  const [job] = await db
    .select()
    .from(documentExtractionJobs)
    .where(and(
      eq(documentExtractionJobs.documentId, documentId),
      eq(documentExtractionJobs.mode, "tax_package"),
    ))
    .limit(1);
  return job ?? null;
}

export function retryDelayMs(attemptCount: number): number {
  return Math.min(15 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attemptCount - 1));
}

export function nextFailureTransition(input: {
  attemptCount: number;
  maxAttempts: number;
  failure: ExtractionFailure;
  now: Date;
}): {
  status: "pending" | "failed";
  availableAt: Date;
  completedAt: Date | null;
} {
  const exhausted = !input.failure.retryable || input.attemptCount >= input.maxAttempts;
  return {
    status: exhausted ? "failed" : "pending",
    availableAt: exhausted
      ? input.now
      : new Date(input.now.getTime() + retryDelayMs(input.attemptCount)),
    completedAt: exhausted ? input.now : null,
  };
}

async function claimNextJob(
  now = new Date(),
  proofJob: "exclude" | "only" | "tax_canary" = "exclude",
  lane: DocumentExtractionWorkerLane = "ordinary",
): Promise<DocumentExtractionJob | null> {
  return db.transaction(async (transaction) => {
    const [candidate] = await transaction
      .select()
      .from(documentExtractionJobs)
      .where(and(
        proofJob === "only"
          ? eq(documentExtractionJobs.id, CORE_EXTRACTION_RESTART_JOB_ID)
          : proofJob === "tax_canary"
            ? eq(documentExtractionJobs.id, CORE_TAX_PACKET_CANARY_JOB_ID)
            : and(
                ne(documentExtractionJobs.id, CORE_EXTRACTION_RESTART_JOB_ID),
                ne(documentExtractionJobs.id, CORE_TAX_PACKET_CANARY_JOB_ID),
              ),
        lane === "tax_package"
          ? eq(documentExtractionJobs.mode, "tax_package")
          : ne(documentExtractionJobs.mode, "tax_package"),
        lt(documentExtractionJobs.attemptCount, documentExtractionJobs.maxAttempts),
        or(
          and(
            eq(documentExtractionJobs.status, "pending"),
            lte(documentExtractionJobs.availableAt, now),
          ),
          and(
            eq(documentExtractionJobs.status, "processing"),
            lt(documentExtractionJobs.leaseExpiresAt, now),
          ),
        ),
      ))
      .orderBy(asc(documentExtractionJobs.availableAt), asc(documentExtractionJobs.createdAt))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!candidate) return null;

    const claimToken = `${workerId}:${randomUUID()}`;

    const [claimed] = await transaction
      .update(documentExtractionJobs)
      .set({
        status: "processing",
        attemptCount: candidate.attemptCount + 1,
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + documentExtractionLeaseMs(candidate)),
        claimedBy: claimToken,
        updatedAt: now,
      })
      .where(eq(documentExtractionJobs.id, candidate.id))
      .returning();
    return claimed ?? null;
  });
}

/** Database-backed lane selector, exported for the real queue integration proof. */
export async function claimNextDocumentExtractionJobForLane(
  lane: DocumentExtractionWorkerLane,
  now = new Date(),
): Promise<DocumentExtractionJob | null> {
  return claimNextJob(now, "exclude", lane);
}

async function expireExhaustedLeases(now = new Date()): Promise<void> {
  await db
    .update(documentExtractionJobs)
    .set({
      status: "failed",
      completedAt: now,
      leaseExpiresAt: null,
      claimedBy: null,
      lastErrorCode: "worker_stopped_on_final_attempt",
      lastErrorAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(documentExtractionJobs.status, "processing"),
      lt(documentExtractionJobs.leaseExpiresAt, now),
      gte(documentExtractionJobs.attemptCount, documentExtractionJobs.maxAttempts),
    ));
}

async function renewLease(job: DocumentExtractionJob): Promise<boolean> {
  const now = new Date();
  const renewed = await db
    .update(documentExtractionJobs)
    .set({ leaseExpiresAt: new Date(now.getTime() + documentExtractionLeaseMs(job)), updatedAt: now })
    .where(and(
      eq(documentExtractionJobs.id, job.id),
      eq(documentExtractionJobs.status, "processing"),
      eq(documentExtractionJobs.claimedBy, jobClaimToken(job)),
      sql`${documentExtractionJobs.leaseExpiresAt} > CURRENT_TIMESTAMP`,
    ))
    .returning({ id: documentExtractionJobs.id });
  return renewed.length === 1;
}

async function completeJob(job: DocumentExtractionJob): Promise<void> {
  const now = new Date();
  await db.transaction(async (transaction) => {
    const [completed] = await transaction
      .update(documentExtractionJobs)
      .set({
        status: "completed",
        completedAt: now,
        leaseExpiresAt: null,
        claimedBy: null,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(and(
        eq(documentExtractionJobs.id, job.id),
        eq(documentExtractionJobs.status, "processing"),
        eq(documentExtractionJobs.claimedBy, jobClaimToken(job)),
      ))
      .returning({ id: documentExtractionJobs.id });
    if (!completed) return;
    const canaryAudit = coreExtractionRestartCompletionAudit(job, now);
    await transaction.insert(auditLogs).values(canaryAudit ?? {
      actorUserId: job.requestedByUserId,
      action: "document.extraction_completed",
      targetType: "document",
      targetId: job.documentId,
      metadata: { jobId: job.id, mode: job.mode, attemptCount: job.attemptCount },
    });
  });
}

async function cancelJob(job: DocumentExtractionJob, code: string): Promise<void> {
  const now = new Date();
  await db
    .update(documentExtractionJobs)
    .set({
      status: "cancelled",
      completedAt: now,
      leaseExpiresAt: null,
      claimedBy: null,
      lastErrorCode: code,
      lastErrorAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(documentExtractionJobs.id, job.id),
      eq(documentExtractionJobs.status, "processing"),
      eq(documentExtractionJobs.claimedBy, jobClaimToken(job)),
    ));
}

async function failJob(job: DocumentExtractionJob, failure: ExtractionFailure): Promise<void> {
  const now = new Date();
  const transition = nextFailureTransition({
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    failure,
    now,
  });
  const exhausted = transition.status === "failed";
  const updated = await db.transaction(async (transaction) => {
    const [transitioned] = await transaction
      .update(documentExtractionJobs)
      .set({
        status: transition.status,
        availableAt: transition.availableAt,
        completedAt: transition.completedAt,
        leaseExpiresAt: null,
        claimedBy: null,
        lastErrorCode: failure.code,
        lastErrorAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(documentExtractionJobs.id, job.id),
        eq(documentExtractionJobs.status, "processing"),
        eq(documentExtractionJobs.claimedBy, jobClaimToken(job)),
      ))
      .returning({ id: documentExtractionJobs.id });
    if (transitioned && exhausted) {
      await transaction.insert(auditLogs).values({
        actorUserId: job.requestedByUserId,
        action: "document.extraction_failed",
        targetType: "document",
        targetId: job.documentId,
        metadata: {
          jobId: job.id,
          mode: job.mode,
          attemptCount: job.attemptCount,
          errorCode: failure.code,
        },
      });
    }
    return transitioned;
  });
  if (!updated || !exhausted) return;

  try {
    const document = await storage.getDocument(job.documentId);
    if (document?.applicationId) {
      const { taskEventEmitter } = await import("./taskEventEmitter");
      await taskEventEmitter.emitDocumentEvent("DOCUMENT_EXTRACTION_FAILED", {
        applicationId: document.applicationId,
        documentId: document.id,
        documentType: document.documentType,
        errorMessage: "We couldn't process this document automatically. Please review it manually or request a clearer copy.",
        triggeredBy: job.requestedByUserId,
      });
    }
  } catch (taskError) {
    console.warn(`[DocumentExtraction] Could not create failure task for ${job.documentId}:`, taskError);
  }
}

async function extractStandard(document: Document): Promise<ExtractedDocumentData> {
  switch (document.documentType) {
    case "pay_stub":
      return extractPayStubData(document.storagePath, document.mimeType ?? undefined);
    case "w2":
      return extractW2Data(document.storagePath, document.mimeType ?? undefined);
    case "bank_statement":
      return extractBankStatementData(document.storagePath, document.mimeType ?? undefined);
    case "lease_agreement":
      return extractLeaseData(document.storagePath, document.mimeType ?? undefined);
    default:
      throw Object.assign(new Error("Unsupported standard extraction type"), {
        extractionFailure: { code: "unsupported_document_type", retryable: false } satisfies ExtractionFailure,
      });
  }
}

async function executeStandardJob(
  document: Document,
  job: DocumentExtractionJob,
  borrowerUserId: string,
  claimFence: DocumentExtractionClaimFence,
): Promise<"completed" | "cancelled"> {
  const extracted = await extractStandard(document);
  const extractionFailure = classifyExtractionResult(extracted);
  if (extractionFailure) {
    throw Object.assign(new Error("Standard extraction failed"), { extractionFailure });
  }
  if (isCoreExtractionRestartJob(job) && job.attemptCount === 1) {
    // The production restart proof deliberately stops after the real provider
    // result passes its fixed invariants but before any borrower-shaped state
    // is persisted. A different deployment must reclaim and repeat this job.
    await recordCoreExtractionRestartProviderReady(job, extracted);
    await holdCoreExtractionRestartFirstResult(job);
  }
  if (extracted.documentClassification) {
    const { materializeDocumentPages } = await import("./documentPageMaterialization");
    await materializeDocumentPages({
      document,
      borrowerUserId,
      classification: extracted.documentClassification,
      modelVersion: extracted.modelId ?? "unknown_extraction_model",
      beforePersist: claimFence.lockForPersistence,
    });
  }
  const result = await applyExtractionToDocument({
    storage,
    userId: borrowerUserId,
    documentId: document.id,
    documentType: document.documentType,
    applicationId: document.applicationId,
    fileSize: document.fileSize ?? undefined,
    extracted,
    beforePersist: claimFence.lockForPersistence,
  });
  if (result.skipReason) return "cancelled";
  if (result.classificationBlocked) {
    try {
      const { extractMaterializedPacketSegments } = await import("./documentPageMaterialization");
      await extractMaterializedPacketSegments({
        documentId: document.id,
        borrowerUserId,
        beforePersist: claimFence.lockForPersistence,
      });
    } catch (packetError) {
      // The source remains safely blocked and visible for review. A segment
      // failure must not discard it or loop paid extraction retries.
      console.warn(`[DocumentExtraction] Packet segment extraction failed for ${document.id}:`, packetError);
    }
  }

  if (
    document.applicationId &&
    (extracted.confidence === "low" || hasActionableExtractionWarning(extracted.warnings))
  ) {
    await claimFence.assertActive();
    try {
      const { taskEventEmitter } = await import("./taskEventEmitter");
      await taskEventEmitter.emitDocumentEvent("DOCUMENT_OCR_ISSUE", {
        applicationId: document.applicationId,
        documentId: document.id,
        documentType: document.documentType,
        errorMessage: "Some details couldn't be read automatically and need a manual review.",
        triggeredBy: job.requestedByUserId,
      });
    } catch (taskError) {
      console.warn(`[DocumentExtraction] Could not create review task for ${document.id}:`, taskError);
    }
  }
  return "completed";
}

async function executeTaxPackageJob(
  document: Document,
  borrowerUserId: string,
  claimFence: DocumentExtractionClaimFence,
): Promise<"completed" | "cancelled" | "cancelled_consent"> {
  if (document.documentType !== "tax_return") {
    throw Object.assign(new Error("Tax package job requires a tax return"), {
      extractionFailure: {
        code: "unsupported_document_type",
        retryable: false,
      } satisfies ExtractionFailure,
    });
  }
  // Consent is checked both when the borrower queues the work and again at
  // execution, so a revocation that wins the race stops document use.
  if (!(await hasUserConsent("tax_document_use", borrowerUserId))) return "cancelled_consent";

  const {
    getLatestTaxIntelligence,
    runTaxDocumentIntelligence,
  } = await import("./taxDocumentIntelligence");
  let summary = await getLatestTaxIntelligence(document.id);
  if (!summary || summary.status !== "completed") {
    summary = await runTaxDocumentIntelligence(
      document,
      borrowerUserId,
      claimFence.lockForPersistence,
    );
  }
  if (summary.status === "failed") {
    if (summary.error?.toLowerCase().includes("authorization was revoked")) return "cancelled_consent";
    throw Object.assign(new Error("Tax package extraction failed"), {
      extractionFailure: classifyTaxPackageFailure(summary.error),
    });
  }
  if (summary.status !== "completed") {
    throw Object.assign(new Error("Tax package extraction is still running"), {
      extractionFailure: {
        code: "tax_package_already_running",
        retryable: true,
      } satisfies ExtractionFailure,
    });
  }
  if (!summary.pageCount || summary.pageCount < 1) {
    throw Object.assign(new Error("Tax package extraction did not return a reviewable page manifest"), {
      extractionFailure: {
        code: "tax_package_page_manifest_missing",
        retryable: false,
      } satisfies ExtractionFailure,
    });
  }

  // Convert the richer per-form classification into exactly one conservative
  // label per source page for the reviewer. Overlaps choose the most confident
  // form; uncovered pages stay unknown rather than inheriting a nearby label.
  const classification: DocumentClassification = {
    pageCount: summary.pageCount,
    pages: Array.from({ length: summary.pageCount }, (_, index) => {
      const pageNumber = index + 1;
      const candidates = summary.forms
        .filter((form) =>
          form.pageStart !== null &&
          form.pageEnd !== null &&
          pageNumber >= form.pageStart &&
          pageNumber <= form.pageEnd,
        )
        .sort((left, right) => right.classificationConfidence - left.classificationConfidence);
      const selected = candidates[0];
      return {
        pageNumber,
        documentType: selected?.formType ?? "unknown",
        confidence: selected?.classificationConfidence ?? 0,
      };
    }),
  };
  const {
    linkTaxExtractionRunToMaterializedPages,
    materializeDocumentPages,
  } = await import("./documentPageMaterialization");
  await materializeDocumentPages({
    document,
    borrowerUserId,
    classification,
    modelVersion: summary.modelId ?? "unknown_tax_extraction_model",
    createLogicalDocuments: false,
    beforePersist: claimFence.lockForPersistence,
  });
  await linkTaxExtractionRunToMaterializedPages({
    documentId: document.id,
    extractionRunId: summary.runId,
    beforePersist: claimFence.lockForPersistence,
  });

  // These projections are idempotent and run after the paid extraction. If a
  // projection fails, the next queue attempt reuses the completed run instead
  // of paying for another model pass.
  return withDocumentWorkflowLock(
    document.id,
    async (currentDocument, isCurrentVersion, transaction) => {
      await claimFence.lockForPersistence(transaction);
      if (documentProcessingBlockReason(currentDocument, isCurrentVersion)) return "cancelled";

      const projection = await withActiveTaxDocumentConsent(borrowerUserId, async (consentTx) => {
        const { saveTaxInsightFromStructuredRunInTransaction } = await import("./taxInsightService");
        await saveTaxInsightFromStructuredRunInTransaction(
          consentTx,
          borrowerUserId,
          document.id,
          summary,
        );

    const { resolveAndPersistEntities } = await import("./borrowerEntityResolution");
    const { classifyAndPersistSituation } = await import("./situationClassifier");
        await resolveAndPersistEntities(
          borrowerUserId,
          document.applicationId ?? undefined,
          consentTx,
        );
        await classifyAndPersistSituation(
          borrowerUserId,
          document.applicationId ?? undefined,
          consentTx,
        );
        return true;
      }, transaction);
      return projection.authorized ? "completed" : "cancelled_consent";
    },
  );
}

async function executeJob(
  job: DocumentExtractionJob,
  claimFence: DocumentExtractionClaimFence,
): Promise<"completed" | "cancelled" | "cancelled_consent"> {
  const document = await storage.getDocument(job.documentId);
  if (!document) return "cancelled";
  const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
  const block = await getDocumentProcessingBlockReason(document.id);
  if (block) return "cancelled";

  if (job.mode === "tax_package") {
    return executeTaxPackageJob(document, borrowerUserId, claimFence);
  }

  if (job.mode === "autopilot") {
    const { runAutopilotForDocument } = await import("./autopilot/orchestrator");
    const result = await runAutopilotForDocument({
      applicationId: document.applicationId ?? "",
      documentId: document.id,
      documentType: document.documentType,
      storagePath: document.storagePath,
      mimeType: document.mimeType,
      fileSize: document.fileSize,
      triggeredBy: job.requestedByUserId,
      beforePersist: claimFence.lockForPersistence,
      assertActive: claimFence.assertActive,
    });
    if (result.status === "skipped") {
      // The kill switch controls Autopilot's broader actions. A standard
      // supported document still deserves extraction after the switch is
      // turned off between upload and claim.
      if (
        result.errorCode === "autopilot_disabled" &&
        standardDocumentNeedsExtraction(document.documentType)
      ) {
        return executeStandardJob(document, job, borrowerUserId, claimFence);
      }
      return "cancelled";
    }
    if (result.status === "failed") {
      throw Object.assign(new Error("Autopilot extraction failed"), {
        extractionFailure: { code: result.errorCode, retryable: result.retryable } satisfies ExtractionFailure,
      });
    }
    return "completed";
  }

  return executeStandardJob(document, job, borrowerUserId, claimFence);
}

export function failureFromUnknown(error: unknown): ExtractionFailure {
  if (error instanceof CoreExtractionRestartProofError) {
    return { code: `core_restart_${error.code}`, retryable: false };
  }
  if (error instanceof CoreTaxPacketCanaryError) {
    return { code: `core_tax_packet_${error.code}`, retryable: false };
  }
  if (
    error &&
    typeof error === "object" &&
    "extractionFailure" in error
  ) {
    const failure = (error as { extractionFailure?: ExtractionFailure }).extractionFailure;
    if (failure && typeof failure.code === "string" && typeof failure.retryable === "boolean") {
      return failure;
    }
  }
  if (
    error instanceof Error &&
    error.message.includes("EXTRACTION_SIMULATE cannot be enabled in production")
  ) {
    return { code: "invalid_production_extraction_configuration", retryable: false };
  }
  return { code: "unexpected_extraction_failure", retryable: true };
}

async function processClaimedJob(job: DocumentExtractionJob): Promise<void> {
  let claimLost = false;
  const claimFence: DocumentExtractionClaimFence = {
    assertActive: async () => {
      if (claimLost) throw new StaleDocumentExtractionClaimError(job.id);
      await assertActiveDocumentExtractionClaim(job);
    },
    lockForPersistence: async (transaction) => {
      if (claimLost) throw new StaleDocumentExtractionClaimError(job.id);
      await lockActiveDocumentExtractionClaim(job, transaction);
    },
  };
  const heartbeat = setInterval(() => {
    void renewLease(job)
      .then((renewed) => {
        if (!renewed) claimLost = true;
      })
      .catch((error) => {
        claimLost = true;
        console.error(`[DocumentExtraction] Lease renewal failed for ${job.id}:`, error);
      });
  }, documentExtractionHeartbeatMs(job));
  heartbeat.unref();
  try {
    if (isCoreTaxPacketCanaryJob(job)) {
      await assertCoreTaxPacketCanaryRuntimeIdentity();
    }
    const outcome = await executeJob(job, claimFence);
    if (outcome === "cancelled" || outcome === "cancelled_consent") {
      await cancelJob(
        job,
        outcome === "cancelled_consent" ? "tax_consent_revoked" : "document_no_longer_processable",
      );
    } else {
      await completeJob(job);
    }
  } catch (error) {
    if (error instanceof StaleDocumentExtractionClaimError) {
      console.warn(`[DocumentExtraction] Discarded stale result for ${job.id}`);
      return;
    }
    const failure = failureFromUnknown(error);
    console.error(
      `[DocumentExtraction] Job ${job.id} failed (${failure.code}, attempt ${job.attemptCount}/${job.maxAttempts})`,
    );
    await failJob(job, failure);
  } finally {
    clearInterval(heartbeat);
  }
}

let ordinaryWorkerRunning: Promise<void> | null = null;
let taxPackageWorkerRunning: Promise<void> | null = null;
let coreRestartWorkerRunning: Promise<void> | null = null;
let coreTaxPacketCanaryWorkerRunning: Promise<void> | null = null;
let workerStarted = false;
let pollTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;

async function drainAvailableJobs(lane: DocumentExtractionWorkerLane): Promise<void> {
  await expireExhaustedLeases();
  for (;;) {
    const job = await claimNextDocumentExtractionJobForLane(lane);
    if (!job) return;
    await processClaimedJob(job);
  }
}

function kickWorkerLane(lane: DocumentExtractionWorkerLane): void {
  const running = lane === "tax_package" ? taxPackageWorkerRunning : ordinaryWorkerRunning;
  if (running) return;
  const work = drainAvailableJobs(lane)
    .catch((error) => console.error(`[DocumentExtraction] ${lane} worker loop failed:`, error))
    .finally(() => {
      if (lane === "tax_package") taxPackageWorkerRunning = null;
      else ordinaryWorkerRunning = null;
    });
  if (lane === "tax_package") taxPackageWorkerRunning = work;
  else ordinaryWorkerRunning = work;
}

export function kickDocumentExtractionWorker(): void {
  // A slow complex return must not delay pay stubs, W-2s, statements, leases,
  // or Autopilot. Each lane remains serial so paid calls stay bounded.
  kickWorkerLane("ordinary");
  kickWorkerLane("tax_package");
}

async function drainCoreExtractionRestartJob(): Promise<void> {
  const deadline = Date.now() + CORE_EXTRACTION_RESTART_LEASE_MS + 10_000;
  for (;;) {
    const job = await claimNextJob(new Date(), "only", "ordinary");
    if (job) {
      await processClaimedJob(job);
      return;
    }
    const [current] = await db
      .select({ status: documentExtractionJobs.status })
      .from(documentExtractionJobs)
      .where(eq(documentExtractionJobs.id, CORE_EXTRACTION_RESTART_JOB_ID))
      .limit(1);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status)) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * Run the controlled restart proof outside the serial borrower queue. The first
 * attempt may wait in memory for ten minutes, so sharing the ordinary lane
 * would otherwise delay every document queued behind this synthetic job.
 */
export function kickCoreExtractionRestartWorker(): void {
  if (coreRestartWorkerRunning) return;
  coreRestartWorkerRunning = drainCoreExtractionRestartJob()
    .catch((error) => console.error("[DocumentExtraction] Core restart proof worker failed:", error))
    .finally(() => {
      coreRestartWorkerRunning = null;
    });
}

async function drainCoreTaxPacketCanaryJob(): Promise<void> {
  const job = await claimNextJob(new Date(), "tax_canary", "tax_package");
  if (job) await processClaimedJob(job);
}

/**
 * Run the paid 100-page synthetic package outside the borrower tax lane. This
 * keeps the operational proof from delaying a real borrower's return.
 */
export function kickCoreTaxPacketCanaryWorker(): void {
  if (coreTaxPacketCanaryWorkerRunning) return;
  coreTaxPacketCanaryWorkerRunning = drainCoreTaxPacketCanaryJob()
    .catch((error) => console.error("[DocumentExtraction] Core tax packet canary worker failed:", error))
    .finally(() => {
      coreTaxPacketCanaryWorkerRunning = null;
    });
}

/**
 * Repairs the narrow deployment window where the migration exists but the old
 * web process can still acknowledge a supported upload without inserting a
 * job. The one-hour lookback and row cap prevent a surprise historical backfill.
 */
export async function reconcileRecentUnqueuedDocumentExtractions(now = new Date()): Promise<number> {
  const candidates = await db
    .select({
      documentId: documents.id,
      userId: documents.userId,
    })
    .from(documents)
    .leftJoin(documentExtractionJobs, eq(documentExtractionJobs.documentId, documents.id))
    .where(and(
      inArray(documents.documentType, [...STANDARD_AUTO_EXTRACT_TYPES]),
      eq(documents.status, "uploaded"),
      isNull(documents.notes),
      isNull(documents.reviewedAt),
      isNull(documentExtractionJobs.id),
      gte(documents.createdAt, new Date(now.getTime() - RECONCILE_LOOKBACK_MS)),
    ))
    .orderBy(desc(documents.createdAt))
    .limit(MAX_RECONCILE_ROWS);
  if (candidates.length === 0) return 0;
  const inserted = await db
    .insert(documentExtractionJobs)
    .values(candidates.map((candidate) => ({
      documentId: candidate.documentId,
      requestedByUserId: candidate.userId,
      mode: "standard" as const,
    })))
    .onConflictDoNothing({
      target: [documentExtractionJobs.documentId, documentExtractionJobs.mode],
    })
    .returning({ id: documentExtractionJobs.id });
  return inserted.length;
}

export function startDocumentExtractionWorker(): { stop: () => void } {
  if (workerStarted) return { stop: stopDocumentExtractionWorker };
  workerStarted = true;
  void reconcileRecentUnqueuedDocumentExtractions()
    .then((inserted) => {
      if (inserted > 0) console.log(`[DocumentExtraction] Recovered ${inserted} recent unqueued upload(s)`);
    })
    .catch((error) => console.error("[DocumentExtraction] Startup reconciliation failed:", error))
    .finally(kickDocumentExtractionWorker);
  pollTimer = setInterval(kickDocumentExtractionWorker, POLL_MS);
  reconcileTimer = setInterval(() => {
    void reconcileRecentUnqueuedDocumentExtractions()
      .then(() => kickDocumentExtractionWorker())
      .catch((error) => console.error("[DocumentExtraction] Reconciliation failed:", error));
  }, RECONCILE_MS);
  pollTimer.unref();
  reconcileTimer.unref();
  return { stop: stopDocumentExtractionWorker };
}

export function stopDocumentExtractionWorker(): void {
  workerStarted = false;
  if (pollTimer) clearInterval(pollTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  pollTimer = null;
  reconcileTimer = null;
}

export interface DocumentExtractionQueueSummary {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  retryScheduled: number;
  staleLeases: number;
  oldestPendingAt: string | null;
  lastCompletedAt: string | null;
}

export async function getDocumentExtractionQueueSummary(
  now = new Date(),
): Promise<DocumentExtractionQueueSummary> {
  const [statusRows, [retryRow], [staleRow], [oldestRow], [lastCompletedRow]] = await Promise.all([
    db
      .select({ status: documentExtractionJobs.status, value: count() })
      .from(documentExtractionJobs)
      .groupBy(documentExtractionJobs.status),
    db
      .select({ value: count() })
      .from(documentExtractionJobs)
      .where(and(
        eq(documentExtractionJobs.status, "pending"),
        gt(documentExtractionJobs.attemptCount, 0),
      )),
    db
      .select({ value: count() })
      .from(documentExtractionJobs)
      .where(and(
        eq(documentExtractionJobs.status, "processing"),
        lt(documentExtractionJobs.leaseExpiresAt, now),
      )),
    db
      .select({ value: sql<Date | null>`min(${documentExtractionJobs.createdAt})` })
      .from(documentExtractionJobs)
      .where(eq(documentExtractionJobs.status, "pending")),
    db
      .select({ value: max(documentExtractionJobs.completedAt) })
      .from(documentExtractionJobs)
      .where(eq(documentExtractionJobs.status, "completed")),
  ]);
  const byStatus = new Map(statusRows.map((row) => [row.status, Number(row.value)]));
  return {
    pending: byStatus.get("pending") ?? 0,
    processing: byStatus.get("processing") ?? 0,
    completed: byStatus.get("completed") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    cancelled: byStatus.get("cancelled") ?? 0,
    retryScheduled: Number(retryRow?.value ?? 0),
    staleLeases: Number(staleRow?.value ?? 0),
    oldestPendingAt: oldestRow?.value ? new Date(oldestRow.value).toISOString() : null,
    lastCompletedAt: lastCompletedRow?.value
      ? new Date(lastCompletedRow.value).toISOString()
      : null,
  };
}
