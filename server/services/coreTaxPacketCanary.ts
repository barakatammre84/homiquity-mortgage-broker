import { and, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  borrowerConsents,
  documentExtractionJobs,
  documents,
  users,
  type DocumentExtractionJob,
} from "@shared/schema";
import { EXTRACTION_MODEL_TAX_PACKAGE } from "../extractionCore";
import { db, pool } from "../db";
import { ObjectStorageService } from "../integrations/object_storage";
import {
  buildSyntheticTaxPacketPdf,
  SYNTHETIC_TAX_PACKET_PAGE_COUNT,
} from "./coreCanaryFixtures";

export const CORE_TAX_PACKET_CANARY_USER_ID = "00000000-0000-4000-8000-00000000c201";
export const CORE_TAX_PACKET_CANARY_DOCUMENT_ID = "00000000-0000-4000-8000-00000000c202";
export const CORE_TAX_PACKET_CANARY_JOB_ID = "00000000-0000-4000-8000-00000000c203";
export const CORE_TAX_PACKET_CANARY_FILE_NAME = "core-tax-packet-canary.pdf";

const CANARY_AUTH_PROVIDER = "operational_canary";
const SEEDED_ACTION = "core.tax_packet_canary_seeded";
export const CORE_TAX_PACKET_CANARY_TRIGGERED_ACTION = "core.tax_packet_canary_triggered";
const PROOF_TIMEOUT_MS = 105_000;
const POLL_MS = 1_000;
const RECLAIM_PENDING_AFTER_MS = 2 * 60 * 1_000;
const RERUN_COOLDOWN_MS = 15 * 60 * 1_000;
const LIFECYCLE_LOCK_KEY = "core-tax-packet-canary:lifecycle:v1";

export type CoreTaxPacketCanaryFailure =
  | "runtime_identity_missing"
  | "release_mismatch"
  | "proof_in_progress"
  | "proof_cooldown"
  | "proof_missing"
  | "processing_failed"
  | "proof_timeout"
  | "invariant_failed"
  | "fixture_collision";

export class CoreTaxPacketCanaryError extends Error {
  constructor(readonly code: CoreTaxPacketCanaryFailure) {
    super(code);
    this.name = "CoreTaxPacketCanaryError";
    Object.setPrototypeOf(this, CoreTaxPacketCanaryError.prototype);
  }
}

interface CoreTaxPacketObjectStore {
  savePrivateDerivedObject(bytes: Buffer, contentType: string, ownerUserId: string): Promise<string>;
  deleteObjectEntity(objectPath: string): Promise<void>;
}

interface SeedMetadata {
  version: 1;
  commitSha: string;
  deploymentId: string;
  seededAt: string;
}

export interface CoreTaxPacketCanarySnapshot {
  jobStatus: string;
  attemptCount: number;
  lastErrorCode: string | null;
  documentStatus: string;
  runRows: number;
  completedRunRows: number;
  failedRunRows: number;
  pageCount: number;
  formCount: number;
  modelId: string | null;
  simulated: boolean;
  overallConfidence: number;
  classificationHash: string | null;
  logicalDocumentRows: number;
  distinctFormTypes: number;
  lineageRows: number;
  overlapRows: number;
  maxFormPages: number;
  factRows: number;
  exactFactRows: number;
  groundedFactRows: number;
  uploadRows: number;
  materializedPageRows: number;
  pageClassificationRows: number;
  logicalPageRows: number;
}

export interface CoreTaxPacketCanaryResult {
  status: "verified";
  commitSha: string;
  deploymentId: string;
  seededAt: string;
  completedAt: string;
  durationMs: number;
  pageCount: number;
  formCount: number;
  factRows: number;
  exactFactRows: number;
  groundedFactRows: number;
  cleanedUp: true;
}

function rowsOf<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : candidate.rows ?? [];
}

function runtimeIdentity(): { commitSha: string; deploymentId: string } {
  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim();
  if (!commitSha || !/^[0-9a-f]{40}$/i.test(commitSha) || !deploymentId) {
    throw new CoreTaxPacketCanaryError("runtime_identity_missing");
  }
  return { commitSha, deploymentId };
}

/** Bind a release proof request to the exact revision the caller intended. */
export function assertCoreTaxPacketCanaryExpectedCommit(expectedCommitSha: string): void {
  const runtime = runtimeIdentity();
  if (
    !/^[0-9a-f]{40}$/i.test(expectedCommitSha) ||
    expectedCommitSha.toLowerCase() !== runtime.commitSha.toLowerCase()
  ) {
    throw new CoreTaxPacketCanaryError("release_mismatch");
  }
}

async function withLifecycleLock<T>(run: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let releaseWithError = false;
  try {
    let lock;
    try {
      lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [LIFECYCLE_LOCK_KEY],
      );
    } catch (error) {
      releaseWithError = true;
      throw error;
    }
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw new CoreTaxPacketCanaryError("proof_in_progress");
    return await run();
  } finally {
    if (locked) {
      try {
        const unlock = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
          [LIFECYCLE_LOCK_KEY],
        );
        releaseWithError = unlock.rows[0]?.unlocked !== true;
      } catch {
        releaseWithError = true;
      }
    }
    client.release(releaseWithError);
  }
}

function parseSeedMetadata(value: unknown): SeedMetadata {
  const metadata = value as Partial<SeedMetadata>;
  if (
    metadata?.version !== 1 ||
    typeof metadata.commitSha !== "string" || !/^[0-9a-f]{40}$/i.test(metadata.commitSha) ||
    typeof metadata.deploymentId !== "string" || metadata.deploymentId.length < 8 ||
    typeof metadata.seededAt !== "string" || !Number.isFinite(Date.parse(metadata.seededAt))
  ) {
    throw new CoreTaxPacketCanaryError("invariant_failed");
  }
  return metadata as SeedMetadata;
}

export function isCoreTaxPacketCanaryJob(
  job: Pick<DocumentExtractionJob, "id" | "documentId" | "requestedByUserId" | "mode">,
): boolean {
  return (
    job.id === CORE_TAX_PACKET_CANARY_JOB_ID &&
    job.documentId === CORE_TAX_PACKET_CANARY_DOCUMENT_ID &&
    job.requestedByUserId === CORE_TAX_PACKET_CANARY_USER_ID &&
    job.mode === "tax_package"
  );
}

/** Prevent a fixed proof job from crossing a deployment boundary before provider use. */
export async function assertCoreTaxPacketCanaryRuntimeIdentity(): Promise<void> {
  const runtime = runtimeIdentity();
  const seed = await getSeedMetadata();
  if (
    seed.commitSha.toLowerCase() !== runtime.commitSha.toLowerCase() ||
    seed.deploymentId !== runtime.deploymentId
  ) {
    throw new CoreTaxPacketCanaryError("release_mismatch");
  }
}

async function getSeedMetadata(): Promise<SeedMetadata> {
  const [row] = await db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.action, SEEDED_ACTION),
      eq(auditLogs.targetId, CORE_TAX_PACKET_CANARY_JOB_ID),
    ))
    .limit(1);
  if (!row) throw new CoreTaxPacketCanaryError("proof_missing");
  return parseSeedMetadata(row.metadata);
}

async function assertFixtureOwnership(): Promise<void> {
  const [[user], [document], [job]] = await Promise.all([
    db.select({ authProvider: users.authProvider }).from(users)
      .where(eq(users.id, CORE_TAX_PACKET_CANARY_USER_ID)).limit(1),
    db.select({ userId: documents.userId, fileName: documents.fileName }).from(documents)
      .where(eq(documents.id, CORE_TAX_PACKET_CANARY_DOCUMENT_ID)).limit(1),
    db.select({
      documentId: documentExtractionJobs.documentId,
      requestedByUserId: documentExtractionJobs.requestedByUserId,
      mode: documentExtractionJobs.mode,
    }).from(documentExtractionJobs)
      .where(eq(documentExtractionJobs.id, CORE_TAX_PACKET_CANARY_JOB_ID)).limit(1),
  ]);
  if (user && user.authProvider !== CANARY_AUTH_PROVIDER) {
    throw new CoreTaxPacketCanaryError("fixture_collision");
  }
  if (
    document &&
    (document.userId !== CORE_TAX_PACKET_CANARY_USER_ID || document.fileName !== CORE_TAX_PACKET_CANARY_FILE_NAME)
  ) {
    throw new CoreTaxPacketCanaryError("fixture_collision");
  }
  if (job && !isCoreTaxPacketCanaryJob({ id: CORE_TAX_PACKET_CANARY_JOB_ID, ...job })) {
    throw new CoreTaxPacketCanaryError("fixture_collision");
  }
}

async function fixtureObjectPaths(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT storage_path AS path
      FROM documents
     WHERE id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
    UNION
    SELECT dp.image_uri AS path
      FROM document_pages dp
      JOIN document_uploads du ON du.id = dp.upload_id
     WHERE du.source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
  `);
  return rowsOf<{ path: string }>(result).map((row) => row.path).filter(Boolean);
}

/** Remove every private object and row created for the fixed synthetic package. */
async function cleanupCoreTaxPacketCanaryUnlocked(
  objectStorage: CoreTaxPacketObjectStore = new ObjectStorageService(),
): Promise<void> {
  await assertFixtureOwnership();
  const objectPaths = await fixtureObjectPaths();
  await db.transaction(async (transaction) => {
    // Workers lock this row before the tax-consent lock. Cleanup must keep the
    // same order so a verifier and a finishing worker cannot deadlock.
    await transaction.execute(sql`
      SELECT id
        FROM document_extraction_jobs
       WHERE id = ${CORE_TAX_PACKET_CANARY_JOB_ID}
       FOR UPDATE
    `);
    // Cleanup is mutually exclusive with every provider use for this fixed
    // identity. Once the transaction commits, later provider calls observe no
    // active consent and stale workers cannot repopulate the evidence graph.
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`tax-consent:${CORE_TAX_PACKET_CANARY_USER_ID}`}, 0)
      )
    `);
    for (const path of objectPaths) {
      await objectStorage.deleteObjectEntity(path);
    }
    await transaction.execute(sql`
      DELETE FROM extracted_fields
       WHERE logical_document_id IN (
         SELECT id FROM logical_documents
          WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM completeness_checks
       WHERE logical_document_id IN (
         SELECT id FROM logical_documents
          WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM logical_document_pages
       WHERE logical_document_id IN (
         SELECT id FROM logical_documents
          WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM page_classifications
       WHERE page_id IN (
         SELECT dp.id FROM document_pages dp
         JOIN document_uploads du ON du.id = dp.upload_id
          WHERE du.source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM document_pages
       WHERE upload_id IN (
         SELECT id FROM document_uploads
          WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM logical_documents
       WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM document_uploads
       WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM document_confidence_scores
       WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM tax_insights WHERE user_id = ${CORE_TAX_PACKET_CANARY_USER_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM review_items WHERE user_id = ${CORE_TAX_PACKET_CANARY_USER_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM situation_profiles WHERE user_id = ${CORE_TAX_PACKET_CANARY_USER_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM borrower_business_entities WHERE user_id = ${CORE_TAX_PACKET_CANARY_USER_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM tax_extraction_runs WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM readiness_checklist WHERE user_id = ${CORE_TAX_PACKET_CANARY_USER_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM borrower_consents WHERE user_id = ${CORE_TAX_PACKET_CANARY_USER_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM analytics_events
       WHERE user_id = ${CORE_TAX_PACKET_CANARY_USER_ID}
          OR actor_id = ${CORE_TAX_PACKET_CANARY_USER_ID}
          OR entity_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM audit_logs
       WHERE action <> ${CORE_TAX_PACKET_CANARY_TRIGGERED_ACTION}
         AND (
           target_id IN (${CORE_TAX_PACKET_CANARY_JOB_ID}, ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID})
           OR actor_user_id = ${CORE_TAX_PACKET_CANARY_USER_ID}
         )
    `);
    await transaction.execute(sql`
      DELETE FROM document_extraction_jobs WHERE id = ${CORE_TAX_PACKET_CANARY_JOB_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM documents WHERE id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
    `);
    await transaction.execute(sql`
      DELETE FROM users
       WHERE id = ${CORE_TAX_PACKET_CANARY_USER_ID}
         AND auth_provider = ${CANARY_AUTH_PROVIDER}
    `);
  });
}

export async function cleanupCoreTaxPacketCanary(
  objectStorage: CoreTaxPacketObjectStore = new ObjectStorageService(),
): Promise<void> {
  return withLifecycleLock(() => cleanupCoreTaxPacketCanaryUnlocked(objectStorage));
}

async function assertRerunAllowed(runtimeCommitSha: string, now: Date): Promise<void> {
  const [recent] = await db.select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(
      eq(auditLogs.action, CORE_TAX_PACKET_CANARY_TRIGGERED_ACTION),
      sql`${auditLogs.metadata}->>'commitSha' = ${runtimeCommitSha}`,
      // Seed timestamps are normalized ISO strings, so this comparison is
      // deterministic across databases configured with different time zones.
      sql`${auditLogs.metadata}->>'seededAt' > ${new Date(now.getTime() - RERUN_COOLDOWN_MS).toISOString()}`,
    ))
    .limit(1);
  if (recent) throw new CoreTaxPacketCanaryError("proof_cooldown");
}

async function existingProofIsActive(now: Date): Promise<boolean> {
  const [existing] = await db.select({
    status: documentExtractionJobs.status,
    leaseActive: sql<boolean>`${documentExtractionJobs.status} = 'processing'
      AND ${documentExtractionJobs.leaseExpiresAt} > CURRENT_TIMESTAMP`,
  }).from(documentExtractionJobs)
    .where(eq(documentExtractionJobs.id, CORE_TAX_PACKET_CANARY_JOB_ID))
    .limit(1);
  if (!existing) return false;
  if (existing.leaseActive) return true;
  const seed = await getSeedMetadata().catch(() => null);
  if (!seed) return false;
  const runtime = runtimeIdentity();
  const ageMs = now.getTime() - Date.parse(seed.seededAt);
  return (
    seed.commitSha.toLowerCase() === runtime.commitSha.toLowerCase() &&
    seed.deploymentId === runtime.deploymentId &&
    ageMs >= 0 &&
    ageMs < RECLAIM_PENDING_AFTER_MS
  );
}

/** Create one private, borrower-free 100-page tax upload and its durable job. */
export async function prepareCoreTaxPacketCanary(
  now = new Date(),
  objectStorage: CoreTaxPacketObjectStore = new ObjectStorageService(),
): Promise<SeedMetadata> {
  return withLifecycleLock(async () => {
    const runtime = runtimeIdentity();
    const [existing] = await db.select({ status: documentExtractionJobs.status })
      .from(documentExtractionJobs)
      .where(eq(documentExtractionJobs.id, CORE_TAX_PACKET_CANARY_JOB_ID))
      .limit(1);
    if (existing && await existingProofIsActive(now)) {
      throw new CoreTaxPacketCanaryError("proof_in_progress");
    }
    await assertRerunAllowed(runtime.commitSha, now);
    if (existing || (await fixtureObjectPaths()).length > 0) {
      await cleanupCoreTaxPacketCanaryUnlocked(objectStorage);
    } else {
      await assertFixtureOwnership();
      const [orphan] = await db.select({ id: users.id }).from(users)
        .where(eq(users.id, CORE_TAX_PACKET_CANARY_USER_ID)).limit(1);
      if (orphan) await cleanupCoreTaxPacketCanaryUnlocked(objectStorage);
    }

    let objectPath: string | null = null;
    let userCreated = false;
    try {
      const pdf = await buildSyntheticTaxPacketPdf();
      await db.insert(users).values({
        id: CORE_TAX_PACKET_CANARY_USER_ID,
        email: null,
        passwordHash: null,
        authProvider: CANARY_AUTH_PROVIDER,
        firstName: "Core",
        lastName: "Tax Packet Canary",
        role: "aspiring_owner",
      });
      userCreated = true;
      objectPath = await objectStorage.savePrivateDerivedObject(
        pdf,
        "application/pdf",
        CORE_TAX_PACKET_CANARY_USER_ID,
      );
      const metadata: SeedMetadata = {
        version: 1,
        commitSha: runtime.commitSha,
        deploymentId: runtime.deploymentId,
        seededAt: now.toISOString(),
      };
      await db.transaction(async (transaction) => {
        await transaction.insert(documents).values({
          id: CORE_TAX_PACKET_CANARY_DOCUMENT_ID,
          userId: CORE_TAX_PACKET_CANARY_USER_ID,
          documentType: "tax_return",
          fileName: CORE_TAX_PACKET_CANARY_FILE_NAME,
          fileSize: pdf.length,
          mimeType: "application/pdf",
          storagePath: objectPath!,
          status: "uploaded",
        });
        await transaction.insert(borrowerConsents).values({
          userId: CORE_TAX_PACKET_CANARY_USER_ID,
          consentType: "tax_document_use",
          consentGiven: true,
          consentMethod: "operational_canary",
          contentHash: "synthetic-tax-packet-canary-v1",
        });
        await transaction.insert(documentExtractionJobs).values({
          id: CORE_TAX_PACKET_CANARY_JOB_ID,
          documentId: CORE_TAX_PACKET_CANARY_DOCUMENT_ID,
          requestedByUserId: CORE_TAX_PACKET_CANARY_USER_ID,
          mode: "tax_package",
          status: "pending",
          maxAttempts: 1,
          availableAt: now,
        });
        await transaction.insert(auditLogs).values({
          actorUserId: null,
          action: SEEDED_ACTION,
          targetType: "system",
          targetId: CORE_TAX_PACKET_CANARY_JOB_ID,
          metadata,
          createdAt: now,
        });
        // This reservation commits before the dedicated worker is kicked, so
        // cleanup cannot open a duplicate paid-run window before the provider
        // canary result ledger is written.
        await transaction.insert(auditLogs).values({
          actorUserId: null,
          action: CORE_TAX_PACKET_CANARY_TRIGGERED_ACTION,
          targetType: "system",
          targetId: CORE_TAX_PACKET_CANARY_JOB_ID,
          metadata,
          createdAt: now,
        });
      });
      return metadata;
    } catch (error) {
      if (objectPath) await objectStorage.deleteObjectEntity(objectPath).catch(() => undefined);
      if (userCreated) {
        await db.delete(users).where(and(
          eq(users.id, CORE_TAX_PACKET_CANARY_USER_ID),
          eq(users.authProvider, CANARY_AUTH_PROVIDER),
        )).catch(() => undefined);
      }
      throw error;
    }
  });
}

async function getSnapshot(): Promise<CoreTaxPacketCanarySnapshot> {
  const result = await db.execute(sql`
    SELECT
      j.status AS job_status,
      j.attempt_count,
      j.last_error_code,
      d.status AS document_status,
      (SELECT count(*)::int FROM tax_extraction_runs
        WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}) AS run_rows,
      (SELECT count(*)::int FROM tax_extraction_runs
        WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID} AND status = 'completed') AS completed_run_rows,
      (SELECT count(*)::int FROM tax_extraction_runs
        WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID} AND status = 'failed') AS failed_run_rows,
      (SELECT page_count::int FROM tax_extraction_runs
        WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID} AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1) AS page_count,
      (SELECT form_count::int FROM tax_extraction_runs
        WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID} AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1) AS form_count,
      (SELECT model_id FROM tax_extraction_runs
        WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID} AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1) AS model_id,
      (SELECT simulated FROM tax_extraction_runs
        WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID} AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1) AS simulated,
      (SELECT overall_confidence::float8 FROM tax_extraction_runs
        WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID} AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1) AS overall_confidence,
      (SELECT classification_response_hash FROM tax_extraction_runs
        WHERE document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID} AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1) AS classification_hash,
      (SELECT count(*)::int FROM logical_documents
        WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}) AS logical_document_rows,
      (SELECT count(DISTINCT document_type)::int FROM logical_documents
        WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}) AS distinct_form_types,
      (SELECT count(*)::int FROM logical_documents
        WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
          AND raw_response_hash ~ '^[0-9a-f]{64}$') AS lineage_rows,
      (SELECT count(*)::int FROM logical_documents a
        JOIN logical_documents b ON a.id < b.id
         AND a.page_start <= b.page_end AND b.page_start <= a.page_end
        WHERE a.source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
          AND b.source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}) AS overlap_rows,
      (SELECT coalesce(max(page_end - page_start + 1), 0)::int FROM logical_documents
        WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}) AS max_form_pages,
      (SELECT count(*)::int FROM extracted_fields ef
        JOIN logical_documents ld ON ld.id = ef.logical_document_id
        WHERE ld.source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}) AS fact_rows,
      (SELECT count(*)::int FROM extracted_fields ef
        JOIN logical_documents ld ON ld.id = ef.logical_document_id
        WHERE ld.source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
          AND ((ld.document_type = 'tax_return_1040' AND ef.field_name = 'wagesSalariesTips' AND ef.value_numeric = 84000)
            OR (ld.document_type = 'tax_return_1040' AND ef.field_name = 'adjustedGrossIncome' AND ef.value_numeric = 103500)
            OR (ld.document_type = 'schedule_c' AND ef.field_name = 'grossReceipts' AND ef.value_numeric = 48000)
            OR (ld.document_type = 'schedule_c' AND ef.field_name = 'netProfitOrLoss' AND ef.value_numeric = 30000)
            OR (ld.document_type = 'schedule_e' AND ef.field_name = 'rentsReceivedTotal' AND ef.value_numeric = 36000)
            OR (ld.document_type = 'schedule_e' AND ef.field_name = 'netRentalRealEstateIncomeOrLoss' AND ef.value_numeric = 14400)
            OR (ld.document_type = 'business_tax_return_1120s' AND ef.field_name = 'grossReceipts' AND ef.value_numeric = 210000)
            OR (ld.document_type = 'business_tax_return_1120s' AND ef.field_name = 'ordinaryBusinessIncomeOrLoss' AND ef.value_numeric = 42000))) AS exact_fact_rows,
      (SELECT count(*)::int FROM extracted_fields ef
        JOIN logical_documents ld ON ld.id = ef.logical_document_id
        WHERE ld.source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}
          AND ef.page_id IS NOT NULL AND ef.page_number BETWEEN 1 AND ${SYNTHETIC_TAX_PACKET_PAGE_COUNT}
          AND ef.confidence > 0) AS grounded_fact_rows,
      (SELECT count(*)::int FROM document_uploads
        WHERE source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}) AS upload_rows,
      (SELECT count(*)::int FROM document_pages dp
        JOIN document_uploads du ON du.id = dp.upload_id
        WHERE du.source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}) AS materialized_page_rows,
      (SELECT count(*)::int FROM page_classifications pc
        JOIN document_pages dp ON dp.id = pc.page_id
        JOIN document_uploads du ON du.id = dp.upload_id
        WHERE du.source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}) AS page_classification_rows,
      (SELECT count(*)::int FROM logical_document_pages ldp
        JOIN logical_documents ld ON ld.id = ldp.logical_document_id
        WHERE ld.source_document_id = ${CORE_TAX_PACKET_CANARY_DOCUMENT_ID}) AS logical_page_rows
    FROM document_extraction_jobs j
    JOIN documents d ON d.id = j.document_id
    WHERE j.id = ${CORE_TAX_PACKET_CANARY_JOB_ID}
  `);
  const [row] = rowsOf<Record<string, unknown>>(result);
  if (!row) throw new CoreTaxPacketCanaryError("proof_missing");
  return {
    jobStatus: String(row.job_status),
    attemptCount: Number(row.attempt_count),
    lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code),
    documentStatus: String(row.document_status),
    runRows: Number(row.run_rows),
    completedRunRows: Number(row.completed_run_rows),
    failedRunRows: Number(row.failed_run_rows),
    pageCount: Number(row.page_count),
    formCount: Number(row.form_count),
    modelId: row.model_id === null ? null : String(row.model_id),
    simulated: Boolean(row.simulated),
    overallConfidence: Number(row.overall_confidence),
    classificationHash: row.classification_hash === null ? null : String(row.classification_hash),
    logicalDocumentRows: Number(row.logical_document_rows),
    distinctFormTypes: Number(row.distinct_form_types),
    lineageRows: Number(row.lineage_rows),
    overlapRows: Number(row.overlap_rows),
    maxFormPages: Number(row.max_form_pages),
    factRows: Number(row.fact_rows),
    exactFactRows: Number(row.exact_fact_rows),
    groundedFactRows: Number(row.grounded_fact_rows),
    uploadRows: Number(row.upload_rows),
    materializedPageRows: Number(row.materialized_page_rows),
    pageClassificationRows: Number(row.page_classification_rows),
    logicalPageRows: Number(row.logical_page_rows),
  };
}

export function validateCoreTaxPacketCanarySnapshot(snapshot: CoreTaxPacketCanarySnapshot): void {
  if (
    snapshot.jobStatus !== "completed" ||
    snapshot.attemptCount !== 1 ||
    snapshot.lastErrorCode !== null ||
    !["uploaded", "verifying"].includes(snapshot.documentStatus) ||
    snapshot.runRows !== 1 ||
    snapshot.completedRunRows !== 1 ||
    snapshot.failedRunRows !== 0 ||
    snapshot.pageCount !== SYNTHETIC_TAX_PACKET_PAGE_COUNT ||
    snapshot.formCount !== 4 ||
    snapshot.modelId !== EXTRACTION_MODEL_TAX_PACKAGE ||
    snapshot.simulated ||
    !(snapshot.overallConfidence > 0) ||
    !/^[0-9a-f]{64}$/.test(snapshot.classificationHash ?? "") ||
    snapshot.logicalDocumentRows !== 4 ||
    snapshot.distinctFormTypes !== 4 ||
    snapshot.lineageRows !== 4 ||
    snapshot.overlapRows !== 0 ||
    snapshot.maxFormPages > 25 ||
    snapshot.factRows < 8 ||
    snapshot.exactFactRows !== 8 ||
    snapshot.groundedFactRows !== snapshot.factRows ||
    snapshot.uploadRows !== 1 ||
    snapshot.materializedPageRows !== SYNTHETIC_TAX_PACKET_PAGE_COUNT ||
    snapshot.pageClassificationRows !== SYNTHETIC_TAX_PACKET_PAGE_COUNT ||
    snapshot.logicalPageRows < 8
  ) {
    throw new CoreTaxPacketCanaryError("invariant_failed");
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for the real durable job, validate its complete evidence graph, and clean up. */
export async function verifyCoreTaxPacketCanary(
  deadlineMs = Date.now() + PROOF_TIMEOUT_MS,
  objectStorage: CoreTaxPacketObjectStore = new ObjectStorageService(),
): Promise<CoreTaxPacketCanaryResult> {
  const runtime = runtimeIdentity();
  const seed = await getSeedMetadata();
  if (seed.commitSha !== runtime.commitSha || seed.deploymentId !== runtime.deploymentId) {
    throw new CoreTaxPacketCanaryError("invariant_failed");
  }
  try {
    let snapshot: CoreTaxPacketCanarySnapshot;
    for (;;) {
      snapshot = await getSnapshot();
      if (snapshot.jobStatus === "completed") break;
      if (["failed", "cancelled"].includes(snapshot.jobStatus)) {
        throw new CoreTaxPacketCanaryError("processing_failed");
      }
      if (Date.now() >= deadlineMs) throw new CoreTaxPacketCanaryError("proof_timeout");
      await delay(POLL_MS);
    }
    validateCoreTaxPacketCanarySnapshot(snapshot);
    const completedAt = new Date().toISOString();
    const result: CoreTaxPacketCanaryResult = {
      status: "verified",
      commitSha: runtime.commitSha,
      deploymentId: runtime.deploymentId,
      seededAt: seed.seededAt,
      completedAt,
      durationMs: Date.now() - Date.parse(seed.seededAt),
      pageCount: snapshot.pageCount,
      formCount: snapshot.formCount,
      factRows: snapshot.factRows,
      exactFactRows: snapshot.exactFactRows,
      groundedFactRows: snapshot.groundedFactRows,
      cleanedUp: true,
    };
    await cleanupCoreTaxPacketCanary(objectStorage);
    return result;
  } catch (error) {
    await cleanupCoreTaxPacketCanary(objectStorage).catch(() => undefined);
    throw error;
  }
}
