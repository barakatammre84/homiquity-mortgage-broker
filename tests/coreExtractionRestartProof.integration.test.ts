import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  CORE_EXTRACTION_RESTART_DOCUMENT_ID,
  CORE_EXTRACTION_RESTART_JOB_ID,
  CORE_EXTRACTION_RESTART_USER_ID,
  cleanupCoreExtractionRestartFixture,
  prepareCoreExtractionRestartProof,
} from "../server/services/coreExtractionRestartProof";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const oldDeployment = process.env.RAILWAY_DEPLOYMENT_ID;
const oldCommit = process.env.RAILWAY_GIT_COMMIT_SHA;
const sourcePath = "/objects/core-extraction-restart-source";
const derivedPath = "/objects/core-extraction-restart-page";
const deletedPaths: string[] = [];
const objectStore = {
  async savePrivateDerivedObject(): Promise<string> {
    return sourcePath;
  },
  async deleteObjectEntity(path: string): Promise<void> {
    deletedPaths.push(path);
  },
};

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Extraction restart proof fixtures require a local test database");
  }
  process.env.RAILWAY_DEPLOYMENT_ID = "local-proof-deployment-a";
  process.env.RAILWAY_GIT_COMMIT_SHA = "a".repeat(40);
  await cleanupCoreExtractionRestartFixture(objectStore).catch(() => undefined);
});

afterAll(async () => {
  await cleanupCoreExtractionRestartFixture(objectStore).catch(() => undefined);
  if (oldDeployment === undefined) delete process.env.RAILWAY_DEPLOYMENT_ID;
  else process.env.RAILWAY_DEPLOYMENT_ID = oldDeployment;
  if (oldCommit === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = oldCommit;
  await pool.end();
});

describe.sequential("core extraction restart fixture lifecycle", () => {
  it("creates only fixed synthetic rows and removes every row and object after proof", async () => {
    const seededAt = new Date("2026-09-10T00:00:00.000Z");
    const prepared = await prepareCoreExtractionRestartProof(seededAt, objectStore);
    expect(prepared).toEqual({
      sourceCommitSha: "a".repeat(40),
      seededAt: seededAt.toISOString(),
      reused: false,
    });

    const created = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM users WHERE id=$1) users,
        (SELECT count(*)::int FROM documents WHERE id=$2) documents,
        (SELECT count(*)::int FROM document_extraction_jobs WHERE id=$3 AND status='pending') jobs,
        (SELECT count(*)::int FROM audit_logs WHERE target_id=$3 AND action='core.extraction_restart_seeded') seeds`,
      [CORE_EXTRACTION_RESTART_USER_ID, CORE_EXTRACTION_RESTART_DOCUMENT_ID, CORE_EXTRACTION_RESTART_JOB_ID],
    );
    expect(created.rows[0]).toEqual({ users: 1, documents: 1, jobs: 1, seeds: 1 });

    const uploadId = randomUUID();
    const pageId = randomUUID();
    const logicalId = randomUUID();
    await pool.query(
      `INSERT INTO document_uploads
        (id,borrower_id,source_document_id,original_file_name,mime_type,file_size_bytes,
         upload_source,raw_file_uri,checksum,processing_status,page_count)
       VALUES ($1,$2,$3,'proof.pdf','application/pdf',1024,'documents_bridge',$4,$5,'completed',1)`,
      [uploadId, CORE_EXTRACTION_RESTART_USER_ID, CORE_EXTRACTION_RESTART_DOCUMENT_ID, sourcePath, "b".repeat(64)],
    );
    await pool.query(
      `INSERT INTO document_pages (id,upload_id,page_number,image_uri,width,height,ocr_engine)
       VALUES ($1,$2,1,$3,612,792,'pdfjs_canvas_normalizer')`,
      [pageId, uploadId, derivedPath],
    );
    await pool.query(
      `INSERT INTO page_classifications
        (page_id,document_type,confidence,model_version,classification_method)
       VALUES ($1,'paystub',0.9900,'proof-model','model_vision')`,
      [pageId],
    );
    await pool.query(
      `INSERT INTO logical_documents
        (id,borrower_id,document_type,aggregated_confidence,status,source_document_id,
         page_start,page_end,expected_page_count,actual_page_count,is_complete)
       VALUES ($1,$2,'paystub',0.9900,'needs_review',$3,1,1,1,1,true)`,
      [logicalId, CORE_EXTRACTION_RESTART_USER_ID, CORE_EXTRACTION_RESTART_DOCUMENT_ID],
    );
    await pool.query(
      `INSERT INTO logical_document_pages (logical_document_id,page_id,page_order)
       VALUES ($1,$2,1)`,
      [logicalId, pageId],
    );
    await pool.query(
      `INSERT INTO completeness_checks
        (logical_document_id,document_type,status,missing_items)
       VALUES ($1,'paystub','complete','[]'::jsonb)`,
      [logicalId],
    );
    await pool.query(
      `INSERT INTO extracted_fields
        (logical_document_id,page_id,page_number,document_id,field_name,field_category,
         value_numeric,value_type,confidence,extraction_method)
       VALUES ($1,$2,1,$3,'gross_pay','income',3000,'currency',0.9900,'claude')`,
      [logicalId, pageId, CORE_EXTRACTION_RESTART_DOCUMENT_ID],
    );
    await pool.query(
      `INSERT INTO document_confidence_scores
        (document_id,document_type,extraction_engine,overall_confidence)
       VALUES ($1,'pay_stub','claude',0.9900)`,
      [CORE_EXTRACTION_RESTART_DOCUMENT_ID],
    );
    await pool.query(
      `INSERT INTO readiness_checklist
        (user_id,category,field_name,field_label,source_table,source_record_id)
       VALUES ($1,'income','canary_income_${randomUUID()}','Canary income','documents',$2)`,
      [CORE_EXTRACTION_RESTART_USER_ID, CORE_EXTRACTION_RESTART_DOCUMENT_ID],
    );
    await pool.query(
      `INSERT INTO analytics_events
        (domain,event_name,entity_type,entity_id,user_id)
       VALUES ('document','confidence_scored','document',$1,$2)`,
      [CORE_EXTRACTION_RESTART_DOCUMENT_ID, CORE_EXTRACTION_RESTART_USER_ID],
    );

    await cleanupCoreExtractionRestartFixture(objectStore);
    expect(new Set(deletedPaths)).toEqual(new Set([sourcePath, derivedPath]));
    const remaining = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM users WHERE id=$1) users,
        (SELECT count(*)::int FROM documents WHERE id=$2) documents,
        (SELECT count(*)::int FROM document_extraction_jobs WHERE id=$3) jobs,
        (SELECT count(*)::int FROM document_uploads WHERE source_document_id=$2) uploads,
        (SELECT count(*)::int FROM logical_documents WHERE source_document_id=$2) logical_documents,
        (SELECT count(*)::int FROM extracted_fields WHERE document_id=$2) facts,
        (SELECT count(*)::int FROM document_confidence_scores WHERE document_id=$2) confidence,
        (SELECT count(*)::int FROM readiness_checklist WHERE user_id=$1) readiness,
        (SELECT count(*)::int FROM audit_logs WHERE target_id IN ($2,$3)) audit`,
      [CORE_EXTRACTION_RESTART_USER_ID, CORE_EXTRACTION_RESTART_DOCUMENT_ID, CORE_EXTRACTION_RESTART_JOB_ID],
    );
    expect(remaining.rows[0]).toEqual({
      users: 0,
      documents: 0,
      jobs: 0,
      uploads: 0,
      logical_documents: 0,
      facts: 0,
      confidence: 0,
      readiness: 0,
      audit: 0,
    });
  });
});
