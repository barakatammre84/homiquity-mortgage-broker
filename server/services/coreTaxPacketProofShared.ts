import { and, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  documentExtractionJobs,
  documents,
  users,
  type DocumentExtractionJob,
} from "@shared/schema";
import { EXTRACTION_MODEL_TAX_PACKAGE } from "../extractionCore";
import { db } from "../db";
import { ObjectStorageService } from "../integrations/object_storage";
import { SYNTHETIC_TAX_PACKET_PAGE_COUNT } from "./coreCanaryFixtures";

export const CORE_PROOF_AUTH_PROVIDER = "operational_canary";

export interface CoreTaxPacketProofIdentity {
  userId: string;
  documentId: string;
  jobId: string;
  fileName: string;
  preservedAuditAction: string;
}

export interface CoreTaxPacketProofObjectStore {
  savePrivateDerivedObject(bytes: Buffer, contentType: string, ownerUserId: string): Promise<string>;
  deleteObjectEntity(objectPath: string): Promise<void>;
}

export interface CoreTaxPacketEvidenceSnapshot {
  jobStatus: string;
  attemptCount: number;
  claimedBy: string | null;
  leaseExpiresAt: Date | null;
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

function rowsOf<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : candidate.rows ?? [];
}

export function isTaxPacketProofJob(
  job: Pick<DocumentExtractionJob, "id" | "documentId" | "requestedByUserId" | "mode">,
  identity: CoreTaxPacketProofIdentity,
): boolean {
  return (
    job.id === identity.jobId &&
    job.documentId === identity.documentId &&
    job.requestedByUserId === identity.userId &&
    job.mode === "tax_package"
  );
}

export async function assertTaxPacketFixtureOwnership(
  identity: CoreTaxPacketProofIdentity,
): Promise<void> {
  const [[user], [document], [job]] = await Promise.all([
    db.select({ authProvider: users.authProvider }).from(users)
      .where(eq(users.id, identity.userId)).limit(1),
    db.select({ userId: documents.userId, fileName: documents.fileName }).from(documents)
      .where(eq(documents.id, identity.documentId)).limit(1),
    db.select({
      documentId: documentExtractionJobs.documentId,
      requestedByUserId: documentExtractionJobs.requestedByUserId,
      mode: documentExtractionJobs.mode,
    }).from(documentExtractionJobs)
      .where(eq(documentExtractionJobs.id, identity.jobId)).limit(1),
  ]);
  if (user && user.authProvider !== CORE_PROOF_AUTH_PROVIDER) throw new Error("fixture_collision");
  if (document && (document.userId !== identity.userId || document.fileName !== identity.fileName)) {
    throw new Error("fixture_collision");
  }
  if (job && !isTaxPacketProofJob({ id: identity.jobId, ...job }, identity)) {
    throw new Error("fixture_collision");
  }
}

export async function taxPacketFixtureObjectPaths(
  identity: CoreTaxPacketProofIdentity,
): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT storage_path AS path
      FROM documents
     WHERE id = ${identity.documentId}
    UNION
    SELECT dp.image_uri AS path
      FROM document_pages dp
      JOIN document_uploads du ON du.id = dp.upload_id
     WHERE du.source_document_id = ${identity.documentId}
  `);
  return rowsOf<{ path: string }>(result).map((row) => row.path).filter(Boolean);
}

/** Delete the fixed synthetic packet under the same lock order used by its worker. */
export async function cleanupTaxPacketProofFixture(
  identity: CoreTaxPacketProofIdentity,
  objectStorage: CoreTaxPacketProofObjectStore = new ObjectStorageService(),
): Promise<void> {
  await assertTaxPacketFixtureOwnership(identity);
  const objectPaths = await taxPacketFixtureObjectPaths(identity);
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`
      SELECT id FROM document_extraction_jobs
       WHERE id = ${identity.jobId}
       FOR UPDATE
    `);
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`tax-consent:${identity.userId}`}, 0))
    `);
    for (const path of objectPaths) await objectStorage.deleteObjectEntity(path);
    await transaction.execute(sql`
      DELETE FROM extracted_fields
       WHERE logical_document_id IN (
         SELECT id FROM logical_documents WHERE source_document_id = ${identity.documentId}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM completeness_checks
       WHERE logical_document_id IN (
         SELECT id FROM logical_documents WHERE source_document_id = ${identity.documentId}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM logical_document_pages
       WHERE logical_document_id IN (
         SELECT id FROM logical_documents WHERE source_document_id = ${identity.documentId}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM page_classifications
       WHERE page_id IN (
         SELECT dp.id FROM document_pages dp
         JOIN document_uploads du ON du.id = dp.upload_id
         WHERE du.source_document_id = ${identity.documentId}
       )
    `);
    await transaction.execute(sql`
      DELETE FROM document_pages
       WHERE upload_id IN (
         SELECT id FROM document_uploads WHERE source_document_id = ${identity.documentId}
       )
    `);
    await transaction.execute(sql`DELETE FROM logical_documents WHERE source_document_id = ${identity.documentId}`);
    await transaction.execute(sql`DELETE FROM document_uploads WHERE source_document_id = ${identity.documentId}`);
    await transaction.execute(sql`DELETE FROM document_confidence_scores WHERE document_id = ${identity.documentId}`);
    await transaction.execute(sql`DELETE FROM tax_insights WHERE user_id = ${identity.userId}`);
    await transaction.execute(sql`DELETE FROM review_items WHERE user_id = ${identity.userId}`);
    await transaction.execute(sql`DELETE FROM situation_profiles WHERE user_id = ${identity.userId}`);
    await transaction.execute(sql`DELETE FROM borrower_business_entities WHERE user_id = ${identity.userId}`);
    await transaction.execute(sql`DELETE FROM tax_extraction_runs WHERE document_id = ${identity.documentId}`);
    await transaction.execute(sql`DELETE FROM readiness_checklist WHERE user_id = ${identity.userId}`);
    await transaction.execute(sql`DELETE FROM borrower_consents WHERE user_id = ${identity.userId}`);
    await transaction.execute(sql`
      DELETE FROM analytics_events
       WHERE user_id = ${identity.userId}
          OR actor_id = ${identity.userId}
          OR entity_id = ${identity.documentId}
    `);
    await transaction.execute(sql`
      DELETE FROM audit_logs
       WHERE action <> ${identity.preservedAuditAction}
         AND (target_id IN (${identity.jobId}, ${identity.documentId}) OR actor_user_id = ${identity.userId})
    `);
    await transaction.execute(sql`DELETE FROM document_extraction_jobs WHERE id = ${identity.jobId}`);
    await transaction.execute(sql`DELETE FROM documents WHERE id = ${identity.documentId}`);
    await transaction.execute(sql`
      DELETE FROM users WHERE id = ${identity.userId} AND auth_provider = ${CORE_PROOF_AUTH_PROVIDER}
    `);
  });
}

export async function getTaxPacketEvidenceSnapshot(
  identity: CoreTaxPacketProofIdentity,
): Promise<CoreTaxPacketEvidenceSnapshot> {
  const result = await db.execute(sql`
    SELECT
      j.status AS job_status,
      j.attempt_count,
      j.claimed_by,
      j.lease_expires_at,
      j.last_error_code,
      d.status AS document_status,
      (SELECT count(*)::int FROM tax_extraction_runs WHERE document_id = ${identity.documentId}) AS run_rows,
      (SELECT count(*)::int FROM tax_extraction_runs WHERE document_id = ${identity.documentId} AND status = 'completed') AS completed_run_rows,
      (SELECT count(*)::int FROM tax_extraction_runs WHERE document_id = ${identity.documentId} AND status = 'failed') AS failed_run_rows,
      (SELECT page_count::int FROM tax_extraction_runs WHERE document_id = ${identity.documentId} AND status = 'completed' ORDER BY completed_at DESC LIMIT 1) AS page_count,
      (SELECT form_count::int FROM tax_extraction_runs WHERE document_id = ${identity.documentId} AND status = 'completed' ORDER BY completed_at DESC LIMIT 1) AS form_count,
      (SELECT model_id FROM tax_extraction_runs WHERE document_id = ${identity.documentId} AND status = 'completed' ORDER BY completed_at DESC LIMIT 1) AS model_id,
      (SELECT simulated FROM tax_extraction_runs WHERE document_id = ${identity.documentId} AND status = 'completed' ORDER BY completed_at DESC LIMIT 1) AS simulated,
      (SELECT overall_confidence::float8 FROM tax_extraction_runs WHERE document_id = ${identity.documentId} AND status = 'completed' ORDER BY completed_at DESC LIMIT 1) AS overall_confidence,
      (SELECT classification_response_hash FROM tax_extraction_runs WHERE document_id = ${identity.documentId} AND status = 'completed' ORDER BY completed_at DESC LIMIT 1) AS classification_hash,
      (SELECT count(*)::int FROM logical_documents WHERE source_document_id = ${identity.documentId}) AS logical_document_rows,
      (SELECT count(DISTINCT document_type)::int FROM logical_documents WHERE source_document_id = ${identity.documentId}) AS distinct_form_types,
      (SELECT count(*)::int FROM logical_documents WHERE source_document_id = ${identity.documentId} AND raw_response_hash ~ '^[0-9a-f]{64}$') AS lineage_rows,
      (SELECT count(*)::int FROM logical_documents a JOIN logical_documents b ON a.id < b.id
        AND a.page_start <= b.page_end AND b.page_start <= a.page_end
        WHERE a.source_document_id = ${identity.documentId} AND b.source_document_id = ${identity.documentId}) AS overlap_rows,
      (SELECT coalesce(max(page_end - page_start + 1), 0)::int FROM logical_documents WHERE source_document_id = ${identity.documentId}) AS max_form_pages,
      (SELECT count(*)::int FROM extracted_fields ef JOIN logical_documents ld ON ld.id = ef.logical_document_id WHERE ld.source_document_id = ${identity.documentId}) AS fact_rows,
      (SELECT count(*)::int FROM extracted_fields ef JOIN logical_documents ld ON ld.id = ef.logical_document_id
        WHERE ld.source_document_id = ${identity.documentId}
          AND ((ld.document_type = 'tax_return_1040' AND ef.field_name = 'wagesSalariesTips' AND ef.value_numeric = 84000)
            OR (ld.document_type = 'tax_return_1040' AND ef.field_name = 'adjustedGrossIncome' AND ef.value_numeric = 103500)
            OR (ld.document_type = 'schedule_c' AND ef.field_name = 'grossReceipts' AND ef.value_numeric = 48000)
            OR (ld.document_type = 'schedule_c' AND ef.field_name = 'netProfitOrLoss' AND ef.value_numeric = 30000)
            OR (ld.document_type = 'schedule_e' AND ef.field_name = 'rentsReceivedTotal' AND ef.value_numeric = 36000)
            OR (ld.document_type = 'schedule_e' AND ef.field_name = 'netRentalRealEstateIncomeOrLoss' AND ef.value_numeric = 14400)
            OR (ld.document_type = 'business_tax_return_1120s' AND ef.field_name = 'grossReceipts' AND ef.value_numeric = 210000)
            OR (ld.document_type = 'business_tax_return_1120s' AND ef.field_name = 'ordinaryBusinessIncomeOrLoss' AND ef.value_numeric = 42000))) AS exact_fact_rows,
      (SELECT count(*)::int FROM extracted_fields ef JOIN logical_documents ld ON ld.id = ef.logical_document_id
        WHERE ld.source_document_id = ${identity.documentId} AND ef.page_id IS NOT NULL
          AND ef.page_number BETWEEN 1 AND ${SYNTHETIC_TAX_PACKET_PAGE_COUNT} AND ef.confidence > 0) AS grounded_fact_rows,
      (SELECT count(*)::int FROM document_uploads WHERE source_document_id = ${identity.documentId}) AS upload_rows,
      (SELECT count(*)::int FROM document_pages dp JOIN document_uploads du ON du.id = dp.upload_id WHERE du.source_document_id = ${identity.documentId}) AS materialized_page_rows,
      (SELECT count(*)::int FROM page_classifications pc JOIN document_pages dp ON dp.id = pc.page_id JOIN document_uploads du ON du.id = dp.upload_id WHERE du.source_document_id = ${identity.documentId}) AS page_classification_rows,
      (SELECT count(*)::int FROM logical_document_pages ldp JOIN logical_documents ld ON ld.id = ldp.logical_document_id WHERE ld.source_document_id = ${identity.documentId}) AS logical_page_rows
    FROM document_extraction_jobs j JOIN documents d ON d.id = j.document_id
    WHERE j.id = ${identity.jobId}
  `);
  const [row] = rowsOf<Record<string, unknown>>(result);
  if (!row) throw new Error("proof_missing");
  return {
    jobStatus: String(row.job_status),
    attemptCount: Number(row.attempt_count),
    claimedBy: row.claimed_by === null ? null : String(row.claimed_by),
    leaseExpiresAt: row.lease_expires_at === null ? null : new Date(String(row.lease_expires_at)),
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

export function validateTaxPacketEvidenceSnapshot(
  snapshot: CoreTaxPacketEvidenceSnapshot,
  expected: { minimumAttempts: number; runRows: number; failedRunRows: number },
): void {
  if (
    snapshot.jobStatus !== "completed" ||
    snapshot.attemptCount < expected.minimumAttempts ||
    snapshot.claimedBy !== null ||
    snapshot.leaseExpiresAt !== null ||
    snapshot.lastErrorCode !== null ||
    !["uploaded", "verifying"].includes(snapshot.documentStatus) ||
    snapshot.runRows !== expected.runRows ||
    snapshot.completedRunRows !== 1 ||
    snapshot.failedRunRows !== expected.failedRunRows ||
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
    throw new Error("invariant_failed");
  }
}
