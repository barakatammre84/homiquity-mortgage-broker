import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import {
  CORE_TAX_PACKET_CANARY_DOCUMENT_ID,
  CORE_TAX_PACKET_CANARY_JOB_ID,
  CORE_TAX_PACKET_CANARY_TRIGGERED_ACTION,
  CORE_TAX_PACKET_CANARY_USER_ID,
  assertCoreTaxPacketCanaryRuntimeIdentity,
  cleanupCoreTaxPacketCanary,
  prepareCoreTaxPacketCanary,
} from "../server/services/coreTaxPacketCanary";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const oldDeployment = process.env.RAILWAY_DEPLOYMENT_ID;
const oldCommit = process.env.RAILWAY_GIT_COMMIT_SHA;
const sourcePath = "/objects/core-tax-packet-canary-source";
const derivedPath = "/objects/core-tax-packet-canary-page";
const deletedPaths: string[] = [];
const objectStore = {
  async savePrivateDerivedObject(): Promise<string> {
    return sourcePath;
  },
  async deleteObjectEntity(path: string): Promise<void> {
    deletedPaths.push(path);
  },
};

async function deleteTriggerReservations(): Promise<void> {
  await pool.query(
    "DELETE FROM audit_logs WHERE action=$1",
    [CORE_TAX_PACKET_CANARY_TRIGGERED_ACTION],
  );
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Tax packet canary fixtures require a local test database");
  }
  process.env.RAILWAY_DEPLOYMENT_ID = "local-tax-canary-deployment";
  process.env.RAILWAY_GIT_COMMIT_SHA = "c".repeat(40);
  await cleanupCoreTaxPacketCanary(objectStore).catch(() => undefined);
  await deleteTriggerReservations();
});

beforeEach(async () => {
  await cleanupCoreTaxPacketCanary(objectStore).catch(() => undefined);
  await deleteTriggerReservations();
  deletedPaths.length = 0;
});

afterAll(async () => {
  await cleanupCoreTaxPacketCanary(objectStore).catch(() => undefined);
  await deleteTriggerReservations();
  if (oldDeployment === undefined) delete process.env.RAILWAY_DEPLOYMENT_ID;
  else process.env.RAILWAY_DEPLOYMENT_ID = oldDeployment;
  if (oldCommit === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = oldCommit;
  await pool.end();
});

describe.sequential("core tax packet canary fixture lifecycle", () => {
  it("serializes concurrent seed requests across database clients", async () => {
    const seededAt = new Date();
    let releaseSave!: () => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    const saveReleased = new Promise<void>((resolve) => { releaseSave = resolve; });
    const blockingStore = {
      ...objectStore,
      async savePrivateDerivedObject(): Promise<string> {
        markSaveStarted();
        await saveReleased;
        return sourcePath;
      },
    };

    const first = prepareCoreTaxPacketCanary(seededAt, blockingStore);
    await saveStarted;
    const duplicate = expect(prepareCoreTaxPacketCanary(
      new Date(seededAt.getTime() + 1_000),
      objectStore,
    )).rejects.toMatchObject({ code: "proof_in_progress" });
    await duplicate;
    releaseSave();

    await first;
    await cleanupCoreTaxPacketCanary(objectStore);
  });

  it("blocks a live duplicate and safely reclaims a stale pending proof", async () => {
    const seededAt = new Date();
    await prepareCoreTaxPacketCanary(seededAt, objectStore);

    await expect(prepareCoreTaxPacketCanary(
      new Date(seededAt.getTime() + 60_000),
      objectStore,
    )).rejects.toMatchObject({ code: "proof_in_progress" });

    await expect(prepareCoreTaxPacketCanary(
      new Date(seededAt.getTime() + 3 * 60_000),
      objectStore,
    )).rejects.toMatchObject({ code: "proof_cooldown" });

    const recovered = await prepareCoreTaxPacketCanary(
      new Date(seededAt.getTime() + 16 * 60_000),
      objectStore,
    );
    expect(recovered.seededAt).toBe(new Date(seededAt.getTime() + 16 * 60_000).toISOString());
    await cleanupCoreTaxPacketCanary(objectStore);
  });

  it("does not reclaim a processing proof with an active worker lease", async () => {
    const now = new Date();
    const seededAt = new Date(now.getTime() - 3 * 60_000);
    await prepareCoreTaxPacketCanary(seededAt, objectStore);
    await pool.query(
      `UPDATE document_extraction_jobs
          SET status='processing', lease_expires_at=CURRENT_TIMESTAMP + interval '10 minutes',
              claimed_by='tax-canary-test-worker'
        WHERE id=$1`,
      [CORE_TAX_PACKET_CANARY_JOB_ID],
    );

    await expect(prepareCoreTaxPacketCanary(
      now,
      objectStore,
    )).rejects.toMatchObject({ code: "proof_in_progress" });
    await cleanupCoreTaxPacketCanary(objectStore);
  });

  it("applies a per-commit cooldown after a paid proof attempt", async () => {
    const now = new Date();
    await pool.query(
      `INSERT INTO audit_logs (action,target_type,target_id,metadata,created_at)
       VALUES ($1,'system',$2,jsonb_build_object('commitSha',$3::text,'seededAt',$4::text),CURRENT_TIMESTAMP)`,
      [
        CORE_TAX_PACKET_CANARY_TRIGGERED_ACTION,
        CORE_TAX_PACKET_CANARY_JOB_ID,
        "c".repeat(40),
        now.toISOString(),
      ],
    );

    await expect(prepareCoreTaxPacketCanary(
      new Date(now.getTime() + 60_000),
      objectStore,
    )).rejects.toMatchObject({ code: "proof_cooldown" });
    await deleteTriggerReservations();
  });

  it("rejects a canary job when the deployment changes before provider use", async () => {
    await prepareCoreTaxPacketCanary(new Date(), objectStore);
    try {
      process.env.RAILWAY_DEPLOYMENT_ID = "different-tax-canary-deployment";
      await expect(assertCoreTaxPacketCanaryRuntimeIdentity())
        .rejects.toMatchObject({ code: "release_mismatch" });
    } finally {
      process.env.RAILWAY_DEPLOYMENT_ID = "local-tax-canary-deployment";
    }
  });

  it("creates the fixed private job and deletes its complete evidence graph", async () => {
    const seededAt = new Date("2026-09-10T03:00:00.000Z");
    await prepareCoreTaxPacketCanary(seededAt, objectStore);

    const created = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM users WHERE id=$1 AND auth_provider='operational_canary') users,
        (SELECT count(*)::int FROM documents WHERE id=$2 AND storage_path=$4) documents,
        (SELECT count(*)::int FROM document_extraction_jobs
          WHERE id=$3 AND status='pending' AND mode='tax_package' AND max_attempts=1) jobs,
        (SELECT count(*)::int FROM borrower_consents
          WHERE user_id=$1 AND consent_type='tax_document_use' AND consent_given=true) consents,
        (SELECT count(*)::int FROM audit_logs
          WHERE target_id=$3 AND action='core.tax_packet_canary_seeded') seeds,
        (SELECT count(*)::int FROM audit_logs
          WHERE target_id=$3 AND action=$5) reservations`,
      [
        CORE_TAX_PACKET_CANARY_USER_ID,
        CORE_TAX_PACKET_CANARY_DOCUMENT_ID,
        CORE_TAX_PACKET_CANARY_JOB_ID,
        sourcePath,
        CORE_TAX_PACKET_CANARY_TRIGGERED_ACTION,
      ],
    );
    expect(created.rows[0]).toEqual({
      users: 1,
      documents: 1,
      jobs: 1,
      consents: 1,
      seeds: 1,
      reservations: 1,
    });

    const runId = randomUUID();
    const uploadId = randomUUID();
    const pageId = randomUUID();
    const logicalId = randomUUID();
    await pool.query(
      `INSERT INTO tax_extraction_runs
        (id,document_id,user_id,status,simulated,model_id,prompt_version,
         classification_response_hash,page_count,form_count,overall_confidence,completed_at)
       VALUES ($1,$2,$3,'completed',false,'proof-model','proof-v1',$4,100,4,0.9900,now())`,
      [runId, CORE_TAX_PACKET_CANARY_DOCUMENT_ID, CORE_TAX_PACKET_CANARY_USER_ID, "d".repeat(64)],
    );
    await pool.query(
      `INSERT INTO document_uploads
        (id,borrower_id,source_document_id,original_file_name,mime_type,file_size_bytes,
         upload_source,raw_file_uri,checksum,processing_status,page_count)
       VALUES ($1,$2,$3,'proof.pdf','application/pdf',1024,'documents_bridge',$4,$5,'completed',100)`,
      [uploadId, CORE_TAX_PACKET_CANARY_USER_ID, CORE_TAX_PACKET_CANARY_DOCUMENT_ID, sourcePath, "e".repeat(64)],
    );
    await pool.query(
      `INSERT INTO document_pages (id,upload_id,page_number,image_uri,width,height,ocr_engine)
       VALUES ($1,$2,1,$3,612,792,'pdfjs_canvas_normalizer')`,
      [pageId, uploadId, derivedPath],
    );
    await pool.query(
      `INSERT INTO page_classifications
        (page_id,document_type,confidence,model_version,classification_method)
       VALUES ($1,'tax_return_1040',0.9900,'proof-model','model_vision')`,
      [pageId],
    );
    await pool.query(
      `INSERT INTO logical_documents
        (id,borrower_id,document_type,aggregated_confidence,status,source_document_id,
         extraction_run_id,page_start,page_end,expected_page_count,actual_page_count,is_complete,
         raw_response_hash)
       VALUES ($1,$2,'tax_return_1040',0.9900,'needs_review',$3,$4,1,2,2,2,true,$5)`,
      [logicalId, CORE_TAX_PACKET_CANARY_USER_ID, CORE_TAX_PACKET_CANARY_DOCUMENT_ID, runId, "f".repeat(64)],
    );
    await pool.query(
      `INSERT INTO logical_document_pages (logical_document_id,page_id,page_order)
       VALUES ($1,$2,1)`,
      [logicalId, pageId],
    );
    await pool.query(
      `INSERT INTO completeness_checks
        (logical_document_id,document_type,status,missing_items)
       VALUES ($1,'tax_return_1040','complete','[]'::jsonb)`,
      [logicalId],
    );
    await pool.query(
      `INSERT INTO extracted_fields
        (logical_document_id,page_id,page_number,document_id,field_name,field_category,
         value_numeric,value_type,confidence,extraction_method)
       VALUES ($1,$2,1,$3,'wagesSalariesTips','income',84000,'currency',0.9900,'claude')`,
      [logicalId, pageId, CORE_TAX_PACKET_CANARY_DOCUMENT_ID],
    );
    await pool.query(
      `INSERT INTO document_confidence_scores
        (document_id,document_type,extraction_engine,overall_confidence)
       VALUES ($1,'tax_return','claude',0.9900)`,
      [CORE_TAX_PACKET_CANARY_DOCUMENT_ID],
    );
    await pool.query(
      `INSERT INTO tax_insights (user_id,document_id,tax_year,confidence)
       VALUES ($1,$2,2025,'high')`,
      [CORE_TAX_PACKET_CANARY_USER_ID, CORE_TAX_PACKET_CANARY_DOCUMENT_ID],
    );
    await pool.query(
      `INSERT INTO review_items (user_id,natural_key,item_type,tier,title,detail)
       VALUES ($1,$2,'se_income_review','staff','Synthetic review','Synthetic canary only')`,
      [CORE_TAX_PACKET_CANARY_USER_ID, `tax-canary-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO situation_profiles (user_id,profile,inputs_fingerprint,self_employed)
       VALUES ($1,'{}'::jsonb,$2,true)`,
      [CORE_TAX_PACKET_CANARY_USER_ID, "1".repeat(64)],
    );
    await pool.query(
      `INSERT INTO borrower_business_entities
        (user_id,identity_key,entity_type,name,source_form_count)
       VALUES ($1,$2,'sole_proprietorship','Synthetic business',1)`,
      [CORE_TAX_PACKET_CANARY_USER_ID, `name:synthetic-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO readiness_checklist
        (user_id,category,field_name,field_label,source_table,source_record_id)
       VALUES ($1,'income',$2,'Synthetic income','documents',$3)`,
      [CORE_TAX_PACKET_CANARY_USER_ID, `canary_income_${randomUUID()}`, CORE_TAX_PACKET_CANARY_DOCUMENT_ID],
    );
    await pool.query(
      `INSERT INTO analytics_events (domain,event_name,entity_type,entity_id,user_id)
       VALUES ('document','tax_canary','document',$1,$2)`,
      [CORE_TAX_PACKET_CANARY_DOCUMENT_ID, CORE_TAX_PACKET_CANARY_USER_ID],
    );

    await cleanupCoreTaxPacketCanary(objectStore);
    expect(new Set(deletedPaths)).toEqual(new Set([sourcePath, derivedPath]));
    const remaining = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM users WHERE id=$1) users,
        (SELECT count(*)::int FROM documents WHERE id=$2) documents,
        (SELECT count(*)::int FROM document_extraction_jobs WHERE id=$3) jobs,
        (SELECT count(*)::int FROM borrower_consents WHERE user_id=$1) consents,
        (SELECT count(*)::int FROM tax_extraction_runs WHERE document_id=$2) runs,
        (SELECT count(*)::int FROM document_uploads WHERE source_document_id=$2) uploads,
        (SELECT count(*)::int FROM logical_documents WHERE source_document_id=$2) logical_documents,
        (SELECT count(*)::int FROM extracted_fields WHERE document_id=$2) facts,
        (SELECT count(*)::int FROM document_confidence_scores WHERE document_id=$2) confidence,
        (SELECT count(*)::int FROM tax_insights WHERE user_id=$1) insights,
        (SELECT count(*)::int FROM review_items WHERE user_id=$1) reviews,
        (SELECT count(*)::int FROM situation_profiles WHERE user_id=$1) profiles,
        (SELECT count(*)::int FROM borrower_business_entities WHERE user_id=$1) businesses,
        (SELECT count(*)::int FROM readiness_checklist WHERE user_id=$1) readiness,
        (SELECT count(*)::int FROM audit_logs
          WHERE target_id IN ($2,$3) AND action<>$4) audit,
        (SELECT count(*)::int FROM audit_logs WHERE target_id=$3 AND action=$4) reservations`,
      [
        CORE_TAX_PACKET_CANARY_USER_ID,
        CORE_TAX_PACKET_CANARY_DOCUMENT_ID,
        CORE_TAX_PACKET_CANARY_JOB_ID,
        CORE_TAX_PACKET_CANARY_TRIGGERED_ACTION,
      ],
    );
    expect(remaining.rows[0]).toEqual({
      users: 0,
      documents: 0,
      jobs: 0,
      consents: 0,
      runs: 0,
      uploads: 0,
      logical_documents: 0,
      facts: 0,
      confidence: 0,
      insights: 0,
      reviews: 0,
      profiles: 0,
      businesses: 0,
      readiness: 0,
      audit: 0,
      reservations: 1,
    });
  });
});
