import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  documentExtractionJobs,
  documents,
  users,
  type DocumentExtractionJob,
} from "@shared/schema";
import type { ExtractedDocumentData } from "../extractionCore";
import { db } from "../db";
import { ObjectStorageService } from "../integrations/object_storage";
import {
  buildSyntheticPayStatementPdf,
  syntheticPayStatementExtractionPasses,
} from "./coreCanaryFixtures";

export const CORE_EXTRACTION_RESTART_USER_ID = "00000000-0000-4000-8000-00000000c101";
export const CORE_EXTRACTION_RESTART_DOCUMENT_ID = "00000000-0000-4000-8000-00000000c102";
export const CORE_EXTRACTION_RESTART_JOB_ID = "00000000-0000-4000-8000-00000000c103";
export const CORE_EXTRACTION_RESTART_FILE_NAME = "core-extraction-restart-proof.pdf";

const CANARY_AUTH_PROVIDER = "operational_canary";
const SEEDED_ACTION = "core.extraction_restart_seeded";
const PROVIDER_READY_ACTION = "core.extraction_restart_provider_ready";
export const COMPLETED_ACTION = "core.extraction_restart_completed";
const PROOF_MAX_AGE_MS = 60 * 60 * 1_000;
const PROVIDER_READY_WAIT_MS = 45_000;
const COMPLETION_WAIT_MS = 75_000;
const POLL_MS = 1_000;
const FIRST_CLAIM_HOLD_MS = 10 * 60 * 1_000;

export const CORE_EXTRACTION_RESTART_LEASE_MS = 30_000;
export const CORE_EXTRACTION_RESTART_HEARTBEAT_MS = 10_000;

export type CoreExtractionRestartProofFailure =
  | "runtime_identity_missing"
  | "proof_in_progress"
  | "proof_missing"
  | "provider_not_ready"
  | "restart_not_observed"
  | "commit_changed"
  | "marker_expired"
  | "extraction_failed"
  | "invariant_failed"
  | "fixture_collision";

export class CoreExtractionRestartProofError extends Error {
  constructor(readonly code: CoreExtractionRestartProofFailure) {
    super(code);
    this.name = "CoreExtractionRestartProofError";
    Object.setPrototypeOf(this, CoreExtractionRestartProofError.prototype);
  }
}

interface RuntimeIdentity {
  deploymentId: string;
  commitSha: string;
}

interface CoreExtractionRestartObjectStore {
  savePrivateDerivedObject(bytes: Buffer, contentType: string, ownerUserId: string): Promise<string>;
  deleteObjectEntity(objectPath: string): Promise<void>;
}

interface SeedMetadata {
  version: 1;
  sourceDeploymentId: string;
  sourceCommitSha: string;
  seededAt: string;
}

interface ProviderReadyMetadata extends SeedMetadata {
  providerReadyAt: string;
  attemptCount: 1;
  modelId: string;
  promptVersion: string;
}

interface CompletionMetadata {
  version: 1;
  completionDeploymentId: string;
  completionCommitSha: string;
  completedAt: string;
  attemptCount: number;
}

export interface CoreExtractionRestartSeedResult {
  status: "provider_read_complete";
  sourceCommitSha: string;
  seededAt: string;
  providerReadyAt: string;
  attemptCount: 1;
  reused: boolean;
}

export interface CoreExtractionRestartSnapshot {
  jobStatus: string;
  attemptCount: number;
  claimedBy: string | null;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  documentStatus: string | null;
  responseHash: string | null;
  confidenceRows: number;
  factRows: number;
  distinctFactRows: number;
  requiredFactRows: number;
  groundedFactRows: number;
  uploadRows: number;
  pageRows: number;
  pageClassificationRows: number;
  logicalDocumentRows: number;
  logicalPageRows: number;
}

export interface CoreExtractionRestartVerifyResult {
  status: "verified";
  sourceCommitSha: string;
  currentCommitSha: string;
  seededAt: string;
  providerReadyAt: string;
  completedAt: string;
  ageMs: number;
  attemptCount: number;
  factRows: number;
  pageRows: number;
  cleanedUp: true;
}

function rowsOf<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : candidate.rows ?? [];
}

function runtimeIdentity(): RuntimeIdentity {
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim();
  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (!deploymentId || !commitSha || !/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new CoreExtractionRestartProofError("runtime_identity_missing");
  }
  return { deploymentId, commitSha };
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseSeedMetadata(value: unknown): SeedMetadata {
  const metadata = value as Partial<SeedMetadata>;
  if (
    metadata?.version !== 1 ||
    typeof metadata.sourceDeploymentId !== "string" || metadata.sourceDeploymentId.length < 8 ||
    typeof metadata.sourceCommitSha !== "string" || !/^[0-9a-f]{40}$/i.test(metadata.sourceCommitSha) ||
    !validDate(metadata.seededAt)
  ) {
    throw new CoreExtractionRestartProofError("invariant_failed");
  }
  return metadata as SeedMetadata;
}

function parseProviderReadyMetadata(value: unknown): ProviderReadyMetadata {
  const metadata = value as Partial<ProviderReadyMetadata>;
  const seed = parseSeedMetadata(value);
  if (
    metadata.attemptCount !== 1 ||
    !validDate(metadata.providerReadyAt) ||
    typeof metadata.modelId !== "string" || metadata.modelId.length < 1 ||
    typeof metadata.promptVersion !== "string" || metadata.promptVersion.length < 1
  ) {
    throw new CoreExtractionRestartProofError("invariant_failed");
  }
  return { ...seed, ...metadata } as ProviderReadyMetadata;
}

function parseCompletionMetadata(value: unknown): CompletionMetadata {
  const metadata = value as Partial<CompletionMetadata>;
  if (
    metadata?.version !== 1 ||
    typeof metadata.completionDeploymentId !== "string" || metadata.completionDeploymentId.length < 8 ||
    typeof metadata.completionCommitSha !== "string" || !/^[0-9a-f]{40}$/i.test(metadata.completionCommitSha) ||
    !validDate(metadata.completedAt) ||
    !Number.isInteger(metadata.attemptCount) || (metadata.attemptCount ?? 0) < 1
  ) {
    throw new CoreExtractionRestartProofError("invariant_failed");
  }
  return metadata as CompletionMetadata;
}

export function isCoreExtractionRestartJob(
  job: Pick<DocumentExtractionJob, "id" | "documentId" | "requestedByUserId" | "mode">,
): boolean {
  return (
    job.id === CORE_EXTRACTION_RESTART_JOB_ID &&
    job.documentId === CORE_EXTRACTION_RESTART_DOCUMENT_ID &&
    job.requestedByUserId === CORE_EXTRACTION_RESTART_USER_ID &&
    job.mode === "standard"
  );
}

export function documentExtractionLeaseMs(job: DocumentExtractionJob): number {
  return isCoreExtractionRestartJob(job) ? CORE_EXTRACTION_RESTART_LEASE_MS : 5 * 60 * 1_000;
}

export function documentExtractionHeartbeatMs(job: DocumentExtractionJob): number {
  return isCoreExtractionRestartJob(job) ? CORE_EXTRACTION_RESTART_HEARTBEAT_MS : 60 * 1_000;
}

async function getAuditMetadata(action: string): Promise<unknown | null> {
  const [row] = await db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.action, action),
      eq(auditLogs.targetId, CORE_EXTRACTION_RESTART_JOB_ID),
    ))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  return row?.metadata ?? null;
}

async function getJob(): Promise<DocumentExtractionJob | null> {
  const [job] = await db
    .select()
    .from(documentExtractionJobs)
    .where(eq(documentExtractionJobs.id, CORE_EXTRACTION_RESTART_JOB_ID))
    .limit(1);
  return job ?? null;
}

async function assertFixtureOwnership(): Promise<void> {
  const [[user], [document], [job]] = await Promise.all([
    db.select({ authProvider: users.authProvider }).from(users)
      .where(eq(users.id, CORE_EXTRACTION_RESTART_USER_ID)).limit(1),
    db.select({ userId: documents.userId, fileName: documents.fileName }).from(documents)
      .where(eq(documents.id, CORE_EXTRACTION_RESTART_DOCUMENT_ID)).limit(1),
    db.select({ documentId: documentExtractionJobs.documentId, requestedByUserId: documentExtractionJobs.requestedByUserId, mode: documentExtractionJobs.mode })
      .from(documentExtractionJobs)
      .where(eq(documentExtractionJobs.id, CORE_EXTRACTION_RESTART_JOB_ID)).limit(1),
  ]);
  if (user && user.authProvider !== CANARY_AUTH_PROVIDER) {
    throw new CoreExtractionRestartProofError("fixture_collision");
  }
  if (
    document &&
    (document.userId !== CORE_EXTRACTION_RESTART_USER_ID || document.fileName !== CORE_EXTRACTION_RESTART_FILE_NAME)
  ) {
    throw new CoreExtractionRestartProofError("fixture_collision");
  }
  if (job && !isCoreExtractionRestartJob({ id: CORE_EXTRACTION_RESTART_JOB_ID, ...job })) {
    throw new CoreExtractionRestartProofError("fixture_collision");
  }
}

async function fixtureObjectPaths(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT storage_path AS path
      FROM documents
     WHERE id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
    UNION
    SELECT dp.image_uri AS path
      FROM document_pages dp
      JOIN document_uploads du ON du.id = dp.upload_id
     WHERE du.source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
  `);
  return rowsOf<{ path: string }>(result).map((row) => row.path).filter(Boolean);
}

/** Remove every temporary row and private object created by this fixed proof. */
export async function cleanupCoreExtractionRestartFixture(
  objectStorage: CoreExtractionRestartObjectStore = new ObjectStorageService(),
): Promise<void> {
  await assertFixtureOwnership();
  for (const path of await fixtureObjectPaths()) {
    await objectStorage.deleteObjectEntity(path);
  }

  await db.transaction(async (transaction) => {
    await transaction.execute(sql`
      DELETE FROM extracted_fields
       WHERE document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
          OR logical_document_id IN (
            SELECT id FROM logical_documents
             WHERE source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
          )
    `);
    await transaction.execute(sql`
      DELETE FROM completeness_checks
       WHERE logical_document_id IN (
         SELECT id FROM logical_documents
          WHERE source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM logical_document_pages
       WHERE logical_document_id IN (
         SELECT id FROM logical_documents
          WHERE source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM page_classifications
       WHERE page_id IN (
         SELECT dp.id FROM document_pages dp
         JOIN document_uploads du ON du.id = dp.upload_id
          WHERE du.source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM document_pages
       WHERE upload_id IN (
         SELECT id FROM document_uploads
          WHERE source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM logical_documents
       WHERE source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM document_uploads
       WHERE source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM document_confidence_scores
       WHERE document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM readiness_checklist
       WHERE user_id = ${CORE_EXTRACTION_RESTART_USER_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM analytics_events
       WHERE user_id = ${CORE_EXTRACTION_RESTART_USER_ID}
          OR actor_id = ${CORE_EXTRACTION_RESTART_USER_ID}
          OR entity_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM audit_logs
       WHERE target_id IN (${CORE_EXTRACTION_RESTART_JOB_ID}, ${CORE_EXTRACTION_RESTART_DOCUMENT_ID})
          OR actor_user_id = ${CORE_EXTRACTION_RESTART_USER_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM document_extraction_jobs
       WHERE id = ${CORE_EXTRACTION_RESTART_JOB_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM documents
       WHERE id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM users
       WHERE id = ${CORE_EXTRACTION_RESTART_USER_ID}
         AND auth_provider = ${CANARY_AUTH_PROVIDER}
    `);
  });
}

/** Create the fixed synthetic upload and pending durable job. */
export async function prepareCoreExtractionRestartProof(
  now = new Date(),
  objectStorage: CoreExtractionRestartObjectStore = new ObjectStorageService(),
): Promise<{ sourceCommitSha: string; seededAt: string; reused: boolean }> {
  const runtime = runtimeIdentity();
  const existing = await getJob();
  if (existing && ["pending", "processing"].includes(existing.status)) {
    await assertFixtureOwnership();
    const seeded = parseSeedMetadata(await getAuditMetadata(SEEDED_ACTION));
    if (
      seeded.sourceDeploymentId !== runtime.deploymentId ||
      seeded.sourceCommitSha !== runtime.commitSha
    ) {
      throw new CoreExtractionRestartProofError("proof_in_progress");
    }
    return { sourceCommitSha: seeded.sourceCommitSha, seededAt: seeded.seededAt, reused: true };
  }
  if (existing || (await fixtureObjectPaths()).length > 0) {
    await cleanupCoreExtractionRestartFixture(objectStorage);
  } else {
    await assertFixtureOwnership();
    const [orphanDocument] = await db.select({ id: documents.id }).from(documents)
      .where(eq(documents.id, CORE_EXTRACTION_RESTART_DOCUMENT_ID)).limit(1);
    const [orphanUser] = await db.select({ id: users.id }).from(users)
      .where(eq(users.id, CORE_EXTRACTION_RESTART_USER_ID)).limit(1);
    if (orphanDocument || orphanUser) await cleanupCoreExtractionRestartFixture(objectStorage);
  }

  let objectPath: string | null = null;
  try {
    await db.insert(users).values({
      id: CORE_EXTRACTION_RESTART_USER_ID,
      email: null,
      passwordHash: null,
      authProvider: CANARY_AUTH_PROVIDER,
      firstName: "Core",
      lastName: "Extraction Canary",
      role: "aspiring_owner",
    });

    const pdf = await buildSyntheticPayStatementPdf();
    objectPath = await objectStorage.savePrivateDerivedObject(
      pdf,
      "application/pdf",
      CORE_EXTRACTION_RESTART_USER_ID,
    );
    const seededAt = now.toISOString();
    await db.transaction(async (transaction) => {
      await transaction.insert(documents).values({
        id: CORE_EXTRACTION_RESTART_DOCUMENT_ID,
        userId: CORE_EXTRACTION_RESTART_USER_ID,
        documentType: "pay_stub",
        fileName: CORE_EXTRACTION_RESTART_FILE_NAME,
        fileSize: pdf.length,
        mimeType: "application/pdf",
        storagePath: objectPath!,
        status: "uploaded",
      });
      await transaction.insert(documentExtractionJobs).values({
        id: CORE_EXTRACTION_RESTART_JOB_ID,
        documentId: CORE_EXTRACTION_RESTART_DOCUMENT_ID,
        requestedByUserId: CORE_EXTRACTION_RESTART_USER_ID,
        mode: "standard",
        status: "pending",
        maxAttempts: 3,
        availableAt: now,
      });
      await transaction.insert(auditLogs).values({
        actorUserId: null,
        action: SEEDED_ACTION,
        targetType: "system",
        targetId: CORE_EXTRACTION_RESTART_JOB_ID,
        metadata: {
          version: 1,
          sourceDeploymentId: runtime.deploymentId,
          sourceCommitSha: runtime.commitSha,
          seededAt,
        } satisfies SeedMetadata,
      });
    });
    return { sourceCommitSha: runtime.commitSha, seededAt, reused: false };
  } catch (error) {
    if (objectPath) await objectStorage.deleteObjectEntity(objectPath).catch(() => undefined);
    await db.delete(users).where(and(
      eq(users.id, CORE_EXTRACTION_RESTART_USER_ID),
      eq(users.authProvider, CANARY_AUTH_PROVIDER),
    )).catch(() => undefined);
    throw error;
  }
}

/**
 * Called only after the first worker has completed and validated the real
 * provider read, before it writes any document state or fact.
 */
export async function recordCoreExtractionRestartProviderReady(
  job: DocumentExtractionJob,
  extracted: ExtractedDocumentData,
  now = new Date(),
): Promise<void> {
  if (!isCoreExtractionRestartJob(job) || job.attemptCount !== 1) return;
  if (!syntheticPayStatementExtractionPasses(extracted)) {
    throw new CoreExtractionRestartProofError("invariant_failed");
  }
  const runtime = runtimeIdentity();
  const seeded = parseSeedMetadata(await getAuditMetadata(SEEDED_ACTION));
  if (
    seeded.sourceDeploymentId !== runtime.deploymentId ||
    seeded.sourceCommitSha !== runtime.commitSha
  ) {
    throw new CoreExtractionRestartProofError("invariant_failed");
  }
  const countsResult = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM document_confidence_scores
        WHERE document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}) AS confidence_rows,
      (SELECT count(*)::int FROM extracted_fields
        WHERE document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}) AS fact_rows
  `);
  const [counts] = rowsOf<{ confidence_rows: number; fact_rows: number }>(countsResult);
  if (Number(counts?.confidence_rows ?? -1) !== 0 || Number(counts?.fact_rows ?? -1) !== 0) {
    throw new CoreExtractionRestartProofError("invariant_failed");
  }
  const existing = await getAuditMetadata(PROVIDER_READY_ACTION);
  if (existing) return;
  await db.insert(auditLogs).values({
    actorUserId: null,
    action: PROVIDER_READY_ACTION,
    targetType: "system",
    targetId: CORE_EXTRACTION_RESTART_JOB_ID,
    metadata: {
      ...seeded,
      providerReadyAt: now.toISOString(),
      attemptCount: 1,
      modelId: extracted.modelId!,
      promptVersion: extracted.promptVersion!,
    } satisfies ProviderReadyMetadata,
  });
}

/** Keep the first validated result in memory until the process is replaced. */
export async function holdCoreExtractionRestartFirstResult(job: DocumentExtractionJob): Promise<void> {
  if (!isCoreExtractionRestartJob(job) || job.attemptCount !== 1) return;
  await new Promise<void>((resolve) => setTimeout(resolve, FIRST_CLAIM_HOLD_MS));
}

export function coreExtractionRestartCompletionAudit(
  job: DocumentExtractionJob,
  now = new Date(),
): typeof auditLogs.$inferInsert | null {
  if (!isCoreExtractionRestartJob(job)) return null;
  const runtime = runtimeIdentity();
  return {
    actorUserId: null,
    action: COMPLETED_ACTION,
    targetType: "system",
    targetId: CORE_EXTRACTION_RESTART_JOB_ID,
    metadata: {
      version: 1,
      completionDeploymentId: runtime.deploymentId,
      completionCommitSha: runtime.commitSha,
      completedAt: now.toISOString(),
      attemptCount: job.attemptCount,
    } satisfies CompletionMetadata,
  };
}

function ensureFresh(seed: SeedMetadata, now: Date): void {
  const seededMs = Date.parse(seed.seededAt);
  if (seededMs > now.getTime() + 5_000 || now.getTime() - seededMs > PROOF_MAX_AGE_MS) {
    throw new CoreExtractionRestartProofError("marker_expired");
  }
}

export function validateCoreExtractionRestartTransition(input: {
  seed: SeedMetadata;
  ready: ProviderReadyMetadata;
  completion: CompletionMetadata;
  current: RuntimeIdentity;
  now: Date;
}): void {
  ensureFresh(input.seed, input.now);
  if (
    input.ready.sourceDeploymentId !== input.seed.sourceDeploymentId ||
    input.ready.sourceCommitSha !== input.seed.sourceCommitSha ||
    input.ready.seededAt !== input.seed.seededAt
  ) {
    throw new CoreExtractionRestartProofError("invariant_failed");
  }
  if (input.seed.sourceDeploymentId === input.current.deploymentId) {
    throw new CoreExtractionRestartProofError("restart_not_observed");
  }
  if (
    input.seed.sourceCommitSha !== input.current.commitSha ||
    input.completion.completionCommitSha !== input.current.commitSha
  ) {
    throw new CoreExtractionRestartProofError("commit_changed");
  }
  if (input.completion.completionDeploymentId !== input.current.deploymentId) {
    throw new CoreExtractionRestartProofError("invariant_failed");
  }
  if (input.completion.attemptCount < 2) {
    throw new CoreExtractionRestartProofError("restart_not_observed");
  }
  if (Date.parse(input.completion.completedAt) < Date.parse(input.ready.providerReadyAt)) {
    throw new CoreExtractionRestartProofError("invariant_failed");
  }
}

export function validateCoreExtractionRestartSnapshot(snapshot: CoreExtractionRestartSnapshot): void {
  if (
    snapshot.jobStatus !== "completed" ||
    snapshot.attemptCount < 2 ||
    snapshot.claimedBy !== null ||
    snapshot.leaseExpiresAt !== null ||
    snapshot.lastErrorCode !== null ||
    snapshot.documentStatus !== "verifying" ||
    !/^[0-9a-f]{64}$/.test(snapshot.responseHash ?? "") ||
    snapshot.confidenceRows !== 1 ||
    snapshot.factRows < 5 ||
    snapshot.factRows !== snapshot.distinctFactRows ||
    snapshot.requiredFactRows !== 5 ||
    snapshot.groundedFactRows !== snapshot.factRows ||
    snapshot.uploadRows !== 1 ||
    snapshot.pageRows !== 1 ||
    snapshot.pageClassificationRows !== 1 ||
    snapshot.logicalDocumentRows !== 1 ||
    snapshot.logicalPageRows !== 1
  ) {
    throw new CoreExtractionRestartProofError("invariant_failed");
  }
}

async function getSnapshot(): Promise<CoreExtractionRestartSnapshot> {
  const result = await db.execute(sql`
    SELECT
      j.status AS job_status,
      j.attempt_count,
      j.claimed_by,
      j.lease_expires_at,
      j.last_error_code,
      d.status AS document_status,
      d.extraction_response_hash AS response_hash,
      (SELECT count(*)::int FROM document_confidence_scores
        WHERE document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}) AS confidence_rows,
      (SELECT count(*)::int FROM extracted_fields
        WHERE document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}) AS fact_rows,
      (SELECT count(DISTINCT field_name)::int FROM extracted_fields
        WHERE document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}) AS distinct_fact_rows,
      (SELECT count(*)::int FROM extracted_fields
        WHERE document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
          AND ((field_name = 'gross_pay' AND value_numeric = 3000)
            OR (field_name = 'net_pay' AND value_numeric = 2100)
            OR (field_name = 'ytd_gross' AND value_numeric = 15000)
            OR (field_name = 'ytd_net_pay' AND value_numeric = 10500)
            OR (field_name = 'ytd_taxes' AND value_numeric = 4500))) AS required_fact_rows,
      (SELECT count(*)::int FROM extracted_fields
        WHERE document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}
          AND page_number = 1 AND confidence > 0) AS grounded_fact_rows,
      (SELECT count(*)::int FROM document_uploads
        WHERE source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}) AS upload_rows,
      (SELECT count(*)::int FROM document_pages dp
        JOIN document_uploads du ON du.id = dp.upload_id
        WHERE du.source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}) AS page_rows,
      (SELECT count(*)::int FROM page_classifications pc
        JOIN document_pages dp ON dp.id = pc.page_id
        JOIN document_uploads du ON du.id = dp.upload_id
        WHERE du.source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}) AS page_classification_rows,
      (SELECT count(*)::int FROM logical_documents
        WHERE source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}) AS logical_document_rows,
      (SELECT count(*)::int FROM logical_document_pages ldp
        JOIN logical_documents ld ON ld.id = ldp.logical_document_id
        WHERE ld.source_document_id = ${CORE_EXTRACTION_RESTART_DOCUMENT_ID}) AS logical_page_rows
    FROM document_extraction_jobs j
    JOIN documents d ON d.id = j.document_id
    WHERE j.id = ${CORE_EXTRACTION_RESTART_JOB_ID}
  `);
  const [row] = rowsOf<Record<string, unknown>>(result);
  if (!row) throw new CoreExtractionRestartProofError("proof_missing");
  return {
    jobStatus: String(row.job_status),
    attemptCount: Number(row.attempt_count),
    claimedBy: row.claimed_by === null ? null : String(row.claimed_by),
    leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)) : null,
    lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code),
    documentStatus: row.document_status === null ? null : String(row.document_status),
    responseHash: row.response_hash === null ? null : String(row.response_hash),
    confidenceRows: Number(row.confidence_rows),
    factRows: Number(row.fact_rows),
    distinctFactRows: Number(row.distinct_fact_rows),
    requiredFactRows: Number(row.required_fact_rows),
    groundedFactRows: Number(row.grounded_fact_rows),
    uploadRows: Number(row.upload_rows),
    pageRows: Number(row.page_rows),
    pageClassificationRows: Number(row.page_classification_rows),
    logicalDocumentRows: Number(row.logical_document_rows),
    logicalPageRows: Number(row.logical_page_rows),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCoreExtractionRestartProviderReady(
  reused: boolean,
  deadlineMs = Date.now() + PROVIDER_READY_WAIT_MS,
): Promise<CoreExtractionRestartSeedResult> {
  for (;;) {
    const readyValue = await getAuditMetadata(PROVIDER_READY_ACTION);
    if (readyValue) {
      const ready = parseProviderReadyMetadata(readyValue);
      const job = await getJob();
      if (!job || job.status !== "processing" || job.attemptCount !== 1) {
        throw new CoreExtractionRestartProofError("invariant_failed");
      }
      return {
        status: "provider_read_complete",
        sourceCommitSha: ready.sourceCommitSha,
        seededAt: ready.seededAt,
        providerReadyAt: ready.providerReadyAt,
        attemptCount: 1,
        reused,
      };
    }
    const job = await getJob();
    if (!job) throw new CoreExtractionRestartProofError("proof_missing");
    if (["failed", "cancelled", "completed"].includes(job.status)) {
      throw new CoreExtractionRestartProofError("extraction_failed");
    }
    if (Date.now() >= deadlineMs) {
      throw new CoreExtractionRestartProofError("provider_not_ready");
    }
    await delay(POLL_MS);
  }
}

export async function verifyCoreExtractionRestartProof(
  now = new Date(),
  deadlineMs = Date.now() + COMPLETION_WAIT_MS,
): Promise<CoreExtractionRestartVerifyResult> {
  const current = runtimeIdentity();
  const seed = parseSeedMetadata(await getAuditMetadata(SEEDED_ACTION));
  const ready = parseProviderReadyMetadata(await getAuditMetadata(PROVIDER_READY_ACTION));
  ensureFresh(seed, now);

  let snapshot: CoreExtractionRestartSnapshot;
  for (;;) {
    snapshot = await getSnapshot();
    if (snapshot.jobStatus === "completed") break;
    if (["failed", "cancelled"].includes(snapshot.jobStatus)) {
      throw new CoreExtractionRestartProofError("extraction_failed");
    }
    if (Date.now() >= deadlineMs) {
      throw new CoreExtractionRestartProofError("provider_not_ready");
    }
    await delay(POLL_MS);
  }
  const completion = parseCompletionMetadata(await getAuditMetadata(COMPLETED_ACTION));
  validateCoreExtractionRestartTransition({ seed, ready, completion, current, now: new Date() });
  validateCoreExtractionRestartSnapshot(snapshot);

  const result: CoreExtractionRestartVerifyResult = {
    status: "verified",
    sourceCommitSha: seed.sourceCommitSha,
    currentCommitSha: current.commitSha,
    seededAt: seed.seededAt,
    providerReadyAt: ready.providerReadyAt,
    completedAt: completion.completedAt,
    ageMs: Date.now() - Date.parse(seed.seededAt),
    attemptCount: snapshot.attemptCount,
    factRows: snapshot.factRows,
    pageRows: snapshot.pageRows,
    cleanedUp: true,
  };
  await cleanupCoreExtractionRestartFixture();
  return result;
}
