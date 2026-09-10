import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import pg from "pg";
import { auditLogs, documentExtractionJobs } from "@shared/schema";
import { db } from "../server/db";
import {
  CORE_TAX_PACKET_RESTART_DOCUMENT_ID,
  CORE_TAX_PACKET_RESTART_JOB_ID,
  CORE_TAX_PACKET_RESTART_TRIGGERED_ACTION,
  CORE_TAX_PACKET_RESTART_USER_ID,
  cleanupCoreTaxPacketRestartProof,
  prepareCoreTaxPacketRestartAttempt,
  prepareCoreTaxPacketRestartProof,
  verifyCoreTaxPacketRestartProof,
} from "../server/services/coreTaxPacketRestartProof";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const oldDeployment = process.env.RAILWAY_DEPLOYMENT_ID;
const oldCommit = process.env.RAILWAY_GIT_COMMIT_SHA;
const sourcePath = "/objects/core-tax-restart-source";
const derivedPath = "/objects/core-tax-restart-page";
const deletedPaths: string[] = [];
const objectStore = {
  async savePrivateDerivedObject(): Promise<string> { return sourcePath; },
  async deleteObjectEntity(path: string): Promise<void> { deletedPaths.push(path); },
};

async function deleteReservations(): Promise<void> {
  await pool.query("DELETE FROM audit_logs WHERE action=$1", [CORE_TAX_PACKET_RESTART_TRIGGERED_ACTION]);
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Tax restart proof fixtures require a local test database");
  }
  process.env.RAILWAY_DEPLOYMENT_ID = "local-tax-restart-deployment-a";
  process.env.RAILWAY_GIT_COMMIT_SHA = "a".repeat(40);
  await cleanupCoreTaxPacketRestartProof(objectStore).catch(() => undefined);
  await deleteReservations();
});

beforeEach(async () => {
  await cleanupCoreTaxPacketRestartProof(objectStore).catch(() => undefined);
  await deleteReservations();
  deletedPaths.length = 0;
  process.env.RAILWAY_DEPLOYMENT_ID = "local-tax-restart-deployment-a";
});

afterAll(async () => {
  await cleanupCoreTaxPacketRestartProof(objectStore).catch(() => undefined);
  await deleteReservations();
  if (oldDeployment === undefined) delete process.env.RAILWAY_DEPLOYMENT_ID;
  else process.env.RAILWAY_DEPLOYMENT_ID = oldDeployment;
  if (oldCommit === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = oldCommit;
  await pool.end();
});

describe.sequential("core tax packet restart fixture lifecycle", () => {
  it("creates one private two-attempt job and removes every synthetic row and object", async () => {
    const now = new Date("2026-09-10T14:00:00.000Z");
    const prepared = await prepareCoreTaxPacketRestartProof(now, objectStore);
    expect(prepared).toEqual({
      sourceCommitSha: "a".repeat(40),
      seededAt: now.toISOString(),
      reused: false,
    });
    const created = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM users WHERE id=$1 AND auth_provider='operational_canary') users,
        (SELECT count(*)::int FROM documents WHERE id=$2 AND storage_path=$4) documents,
        (SELECT count(*)::int FROM borrower_consents WHERE user_id=$1 AND consent_type='tax_document_use' AND consent_given=true) consents,
        (SELECT count(*)::int FROM document_extraction_jobs WHERE id=$3 AND status='pending' AND max_attempts=2) jobs,
        (SELECT count(*)::int FROM audit_logs WHERE target_id=$3 AND action='core.tax_packet_restart_seeded') seeds,
        (SELECT count(*)::int FROM audit_logs WHERE target_id=$3 AND action=$5) reservations`,
      [
        CORE_TAX_PACKET_RESTART_USER_ID,
        CORE_TAX_PACKET_RESTART_DOCUMENT_ID,
        CORE_TAX_PACKET_RESTART_JOB_ID,
        sourcePath,
        CORE_TAX_PACKET_RESTART_TRIGGERED_ACTION,
      ],
    );
    expect(created.rows[0]).toEqual({ users: 1, documents: 1, consents: 1, jobs: 1, seeds: 1, reservations: 1 });

    const uploadId = randomUUID();
    const pageId = randomUUID();
    await pool.query(
      `INSERT INTO document_uploads
        (id,borrower_id,source_document_id,original_file_name,mime_type,file_size_bytes,
         upload_source,raw_file_uri,checksum,processing_status,page_count)
       VALUES ($1,$2,$3,'proof.pdf','application/pdf',1024,'documents_bridge',$4,$5,'completed',1)`,
      [uploadId, CORE_TAX_PACKET_RESTART_USER_ID, CORE_TAX_PACKET_RESTART_DOCUMENT_ID, sourcePath, "b".repeat(64)],
    );
    await pool.query(
      `INSERT INTO document_pages (id,upload_id,page_number,image_uri,width,height,ocr_engine)
       VALUES ($1,$2,1,$3,612,792,'pdfjs_canvas_normalizer')`,
      [pageId, uploadId, derivedPath],
    );

    await cleanupCoreTaxPacketRestartProof(objectStore);
    expect(new Set(deletedPaths)).toEqual(new Set([sourcePath, derivedPath]));
    const remaining = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM users WHERE id=$1) users,
        (SELECT count(*)::int FROM documents WHERE id=$2) documents,
        (SELECT count(*)::int FROM document_extraction_jobs WHERE id=$3) jobs,
        (SELECT count(*)::int FROM document_uploads WHERE source_document_id=$2) uploads,
        (SELECT count(*)::int FROM borrower_consents WHERE user_id=$1) consents,
        (SELECT count(*)::int FROM audit_logs WHERE target_id=$3 AND action<>$4) transient_audit,
        (SELECT count(*)::int FROM audit_logs WHERE target_id=$3 AND action=$4) reservations`,
      [
        CORE_TAX_PACKET_RESTART_USER_ID,
        CORE_TAX_PACKET_RESTART_DOCUMENT_ID,
        CORE_TAX_PACKET_RESTART_JOB_ID,
        CORE_TAX_PACKET_RESTART_TRIGGERED_ACTION,
      ],
    );
    expect(remaining.rows[0]).toEqual({
      users: 0, documents: 0, jobs: 0, uploads: 0, consents: 0, transient_audit: 0, reservations: 1,
    });
  });

  it("closes exactly the abandoned running ledger before attempt two", async () => {
    const now = new Date();
    const prepared = await prepareCoreTaxPacketRestartProof(now, objectStore);
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO tax_extraction_runs
        (id,document_id,user_id,status,simulated,prompt_version,started_at)
       VALUES ($1,$2,$3,'running',false,'tax/v1',CURRENT_TIMESTAMP)`,
      [runId, CORE_TAX_PACKET_RESTART_DOCUMENT_ID, CORE_TAX_PACKET_RESTART_USER_ID],
    );
    await pool.query(
      `UPDATE document_extraction_jobs
          SET status='processing', attempt_count=2, claimed_by='replacement-worker',
              claimed_at=CURRENT_TIMESTAMP, lease_expires_at=CURRENT_TIMESTAMP + interval '2 minutes'
        WHERE id=$1`,
      [CORE_TAX_PACKET_RESTART_JOB_ID],
    );
    await db.insert(auditLogs).values({
      actorUserId: null,
      action: "core.tax_packet_restart_provider_ready",
      targetType: "system",
      targetId: CORE_TAX_PACKET_RESTART_JOB_ID,
      metadata: {
        version: 1,
        sourceDeploymentId: "local-tax-restart-deployment-a",
        sourceCommitSha: prepared.sourceCommitSha,
        seededAt: prepared.seededAt,
        providerReadyAt: new Date(now.getTime() + 1_000).toISOString(),
        attemptCount: 1,
        classificationHash: "c".repeat(64),
        formCount: 4,
        exactFactCount: 8,
      },
    });
    process.env.RAILWAY_DEPLOYMENT_ID = "local-tax-restart-deployment-b";
    const [job] = await db.select().from(documentExtractionJobs)
      .where(eq(documentExtractionJobs.id, CORE_TAX_PACKET_RESTART_JOB_ID)).limit(1);
    await prepareCoreTaxPacketRestartAttempt(job);

    const runs = await pool.query(
      "SELECT status,error FROM tax_extraction_runs WHERE document_id=$1",
      [CORE_TAX_PACKET_RESTART_DOCUMENT_ID],
    );
    expect(runs.rows).toEqual([{
      status: "failed",
      error: "Controlled process interruption after provider read",
    }]);
  });

  it("rejects verification on the seed deployment without deleting the active proof", async () => {
    const now = new Date();
    const prepared = await prepareCoreTaxPacketRestartProof(now, objectStore);
    await db.insert(auditLogs).values({
      actorUserId: null,
      action: "core.tax_packet_restart_provider_ready",
      targetType: "system",
      targetId: CORE_TAX_PACKET_RESTART_JOB_ID,
      metadata: {
        version: 1,
        sourceDeploymentId: "local-tax-restart-deployment-a",
        sourceCommitSha: prepared.sourceCommitSha,
        seededAt: prepared.seededAt,
        providerReadyAt: new Date(now.getTime() + 1_000).toISOString(),
        attemptCount: 1,
        classificationHash: "c".repeat(64),
        formCount: 4,
        exactFactCount: 8,
      },
    });

    await expect(verifyCoreTaxPacketRestartProof(Date.now(), objectStore))
      .rejects.toMatchObject({ code: "restart_not_observed" });
    expect(deletedPaths).toEqual([]);
    const remaining = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM users WHERE id=$1) users,
        (SELECT count(*)::int FROM documents WHERE id=$2) documents,
        (SELECT count(*)::int FROM document_extraction_jobs WHERE id=$3) jobs`,
      [
        CORE_TAX_PACKET_RESTART_USER_ID,
        CORE_TAX_PACKET_RESTART_DOCUMENT_ID,
        CORE_TAX_PACKET_RESTART_JOB_ID,
      ],
    );
    expect(remaining.rows[0]).toEqual({ users: 1, documents: 1, jobs: 1 });
  });
});
