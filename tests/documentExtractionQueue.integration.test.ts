import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { taxInsights } from "@shared/schema";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const userId = randomUUID();
const documentId = randomUUID();
const persistedDocumentId = randomUUID();
const rollbackDocumentId = randomUUID();
const jobId = randomUUID();
let fixturesCreated = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Document extraction queue fixtures require a local test database");
  }
  await pool.query(
    `INSERT INTO users (id,email,role) VALUES ($1,$2,'aspiring_owner')`,
    [userId, `extraction-queue-${userId}@example.test`],
  );
  await pool.query(
    `INSERT INTO documents
       (id,user_id,document_type,file_name,file_size,mime_type,storage_path,status)
     VALUES ($1,$2,'government_id','restart-proof.pdf',1024,'application/pdf',
       '/objects/restart-proof','uploaded')`,
    [documentId, userId],
  );
  await pool.query(
    `INSERT INTO documents
       (id,user_id,document_type,file_name,file_size,mime_type,storage_path,status)
     VALUES ($1,$2,'pay_stub','atomic-paystub.pdf',2048,'application/pdf',
       '/objects/atomic-paystub','uploaded')`,
    [persistedDocumentId, userId],
  );
  await pool.query(
    `INSERT INTO documents
       (id,user_id,document_type,file_name,file_size,mime_type,storage_path,status)
     VALUES ($1,$2,'pay_stub','rollback-paystub.pdf',2048,'application/pdf',
       '/objects/rollback-paystub','uploaded')`,
    [rollbackDocumentId, userId],
  );
  fixturesCreated = true;
});

afterAll(async () => {
  if (!fixturesCreated) {
    await pool.end();
    return;
  }
  await pool.query(`DELETE FROM audit_logs WHERE actor_user_id=$1`, [userId]);
  await pool.query(`DELETE FROM analytics_events WHERE entity_id = ANY($1::varchar[])`, [[documentId, persistedDocumentId, rollbackDocumentId]]);
  await pool.query(`DELETE FROM document_confidence_scores WHERE document_id = ANY($1::varchar[])`, [[documentId, persistedDocumentId, rollbackDocumentId]]);
  await pool.query(`DELETE FROM extracted_fields WHERE document_id = ANY($1::varchar[])`, [[documentId, persistedDocumentId, rollbackDocumentId]]);
  await pool.query(`DELETE FROM readiness_checklist WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM tax_insights WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM review_items WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM situation_profiles WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM logical_documents WHERE borrower_id=$1`, [userId]);
  await pool.query(`DELETE FROM tax_extraction_runs WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM borrower_business_entities WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM borrower_consents WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM document_extraction_jobs WHERE document_id=$1`, [documentId]);
  await pool.query(`DELETE FROM documents WHERE id = ANY($1::varchar[])`, [[documentId, persistedDocumentId, rollbackDocumentId]]);
  await pool.query(`DELETE FROM users WHERE id=$1`, [userId]);
  await pool.end();
});

describe.sequential("document extraction restart recovery", () => {
  it("commits document state, confidence, facts, and readiness as one coherent extraction", async () => {
    const { storage } = await import("../server/storage");
    const { applyExtractionToDocument } = await import("../server/services/extractionPersistence");
    const result = await applyExtractionToDocument({
      storage,
      userId,
      documentId: persistedDocumentId,
      documentType: "pay_stub",
      applicationId: null,
      fileSize: 2048,
      extracted: {
        employeeName: "Atomic Borrower",
        employerName: "Northwind Logistics",
        payPeriodStartDate: "2026-06-16",
        payPeriodEndDate: "2026-06-30",
        grossPay: 4200,
        netPay: 3100,
        ytdGross: 50400,
        ytdNetPay: 37200,
        ytdTaxes: 13200,
        confidence: "high",
        extractedFields: ["employerName", "grossPay", "ytdGross", "payPeriodEndDate"],
        warnings: [],
        modelId: "claude-sonnet-5",
        promptVersion: "pay_stub/v3",
        fieldEvidence: {
          employeeName: { pageNumber: 1, confidence: 0.98 },
          employerName: { pageNumber: 1, confidence: 0.98 },
          payPeriodStartDate: { pageNumber: 1, confidence: 0.97 },
          payPeriodEndDate: { pageNumber: 1, confidence: 0.97 },
          grossPay: { pageNumber: 1, confidence: 0.96 },
          netPay: { pageNumber: 1, confidence: 0.95 },
          ytdGross: { pageNumber: 1, confidence: 0.96 },
          ytdNetPay: { pageNumber: 1, confidence: 0.95 },
          ytdTaxes: { pageNumber: 1, confidence: 0.94 },
        },
        pageCount: 1,
        documentClassification: {
          pageCount: 1,
          pages: [{ pageNumber: 1, documentType: "paystub", confidence: 0.98 }],
        },
      },
    });

    expect(result).toMatchObject({
      humanReviewRequired: false,
      factsPersisted: 10,
      readinessFieldsUpdated: expect.arrayContaining(["employer_name", "pay_stubs"]),
    });
    const persisted = await pool.query(
      `SELECT
         (SELECT status FROM documents WHERE id=$1) document_status,
         (SELECT count(*)::int FROM document_confidence_scores WHERE document_id=$1) confidence_rows,
         (SELECT count(*)::int FROM extracted_fields WHERE document_id=$1) fact_rows,
         (SELECT count(*)::int FROM readiness_checklist
           WHERE user_id=$2 AND field_name IN ('employer_name','pay_stubs')
             AND verification_status='document_extracted') readiness_rows`,
      [persistedDocumentId, userId],
    );
    expect(persisted.rows[0]).toEqual({
      document_status: "verifying",
      confidence_rows: 1,
      fact_rows: 10,
      readiness_rows: 2,
    });
  });

  it("rolls confidence and document state back together when persistence fails", async () => {
    const { storage } = await import("../server/storage");
    const { applyExtractionToDocument } = await import("../server/services/extractionPersistence");
    const failingStorage = {
      updateDocument: async (id: string, patch: Record<string, unknown>, transaction: any) => {
        await storage.updateDocument(id, patch as any, transaction);
        throw new Error("injected persistence failure");
      },
    };
    await expect(applyExtractionToDocument({
      storage: failingStorage,
      userId,
      documentId: rollbackDocumentId,
      documentType: "pay_stub",
      applicationId: null,
      fileSize: 2048,
      extracted: {
        employerName: "Northwind Logistics",
        payPeriodEndDate: "2026-06-30",
        ytdGross: 50400,
        confidence: "high",
        extractedFields: ["employerName", "payPeriodEndDate", "ytdGross"],
        warnings: [],
        modelId: "claude-sonnet-5",
        promptVersion: "pay_stub/v3",
        fieldEvidence: {
          employerName: { pageNumber: 1, confidence: 0.98 },
          payPeriodEndDate: { pageNumber: 1, confidence: 0.97 },
          grossPay: { pageNumber: 1, confidence: 0.96 },
          ytdGross: { pageNumber: 1, confidence: 0.96 },
        },
        pageCount: 1,
        documentClassification: {
          pageCount: 1,
          pages: [{ pageNumber: 1, documentType: "paystub", confidence: 0.98 }],
        },
      },
    })).rejects.toThrow("injected persistence failure");

    const persisted = await pool.query(
      `SELECT
         (SELECT status FROM documents WHERE id=$1) document_status,
         (SELECT count(*)::int FROM document_confidence_scores WHERE document_id=$1) confidence_rows`,
      [rollbackDocumentId],
    );
    expect(persisted.rows[0]).toEqual({
      document_status: "uploaded",
      confidence_rows: 0,
    });
  });

  it("reclaims an expired processing lease and records a terminal result", async () => {
    await pool.query(
      `INSERT INTO document_extraction_jobs
         (id,document_id,requested_by_user_id,mode,status,attempt_count,max_attempts,
          available_at,claimed_at,lease_expires_at,claimed_by)
       VALUES ($1,$2,$3,'standard','processing',1,3,now() - interval '10 minutes',
         now() - interval '10 minutes',now() - interval '5 minutes','stopped-worker')`,
      [jobId, documentId, userId],
    );

    const { kickDocumentExtractionWorker } = await import("../server/services/documentExtractionJobs");
    kickDocumentExtractionWorker();

    const deadline = Date.now() + 10_000;
    let row: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
      const result = await pool.query(
        `SELECT status,attempt_count,last_error_code,claimed_by,lease_expires_at
           FROM document_extraction_jobs WHERE id=$1`,
        [jobId],
      );
      row = result.rows[0];
      if (row?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(row).toMatchObject({
      status: "failed",
      attempt_count: 2,
      last_error_code: "unsupported_document_type",
      claimed_by: null,
      lease_expires_at: null,
    });
  });

  it("orders final tax persistence and consent revocation so revoked data stays purged", async () => {
    await pool.query(
      `INSERT INTO borrower_consents
         (user_id,consent_type,consent_given,consent_method,is_revoked)
       VALUES ($1,'tax_document_use',true,'click',false)`,
      [userId],
    );
    const runId = randomUUID();
    const logicalDocumentId = randomUUID();
    const entityId = randomUUID();
    await pool.query(
      `INSERT INTO tax_extraction_runs
         (id,document_id,user_id,status,completed_at)
       VALUES ($1,$2,$3,'completed',now())`,
      [runId, documentId, userId],
    );
    await pool.query(
      `INSERT INTO borrower_business_entities
         (id,user_id,identity_key,entity_type,name)
       VALUES ($1,$2,'name:queue test consulting','sole_proprietorship','Queue Test Consulting')`,
      [entityId, userId],
    );
    await pool.query(
      `INSERT INTO logical_documents
         (id,borrower_id,document_type,aggregated_confidence,status,source_document_id,
          extraction_run_id,business_entity_id)
       VALUES ($1,$2,'schedule_c',0.9000,'needs_review',$3,$4,$5)`,
      [logicalDocumentId, userId, documentId, runId, entityId],
    );
    await pool.query(
      `INSERT INTO situation_profiles (user_id,profile,inputs_fingerprint)
       VALUES ($1,'{}'::jsonb,$2)`,
      [userId, randomUUID().replaceAll("-", "")],
    );
    await pool.query(
      `INSERT INTO review_items
         (user_id,natural_key,item_type,tier,title,detail)
       VALUES
         ($1,$2,'tieout_variance','flagged','Tax variance','Review tax evidence'),
         ($1,$3,'bank_statement_review','flagged','Bank review','Review bank evidence'),
         ($1,$4,'se_income_review','flagged','Business review','Review application business income'),
         ($1,$5,'dscr_review','flagged','Rental review','Review application rental path')`,
      [
        userId,
        `tax-${randomUUID()}`,
        `bank-${randomUUID()}`,
        `business-${randomUUID()}`,
        `rental-${randomUUID()}`,
      ],
    );

    const {
      revokeTaxDocumentConsentAndPurge,
      withActiveTaxDocumentConsent,
    } = await import("../server/services/taxConsentWorkflow");
    let persistenceEntered!: () => void;
    const entered = new Promise<void>((resolve) => { persistenceEntered = resolve; });
    let releasePersistence!: () => void;
    const release = new Promise<void>((resolve) => { releasePersistence = resolve; });

    const persistence = withActiveTaxDocumentConsent(userId, async (transaction) => {
      persistenceEntered();
      await release;
      const [row] = await transaction
        .insert(taxInsights)
        .values({
          userId,
          documentId,
          taxYear: 2025,
          confidence: "high",
          selfEmployed: false,
          dscrCandidate: false,
        })
        .returning({ id: taxInsights.id });
      return row.id;
    });

    await entered;
    let revocationSettled = false;
    const revocation = revokeTaxDocumentConsentAndPurge(userId).then((result) => {
      revocationSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(revocationSettled).toBe(false);

    releasePersistence();
    const [persisted, revoked] = await Promise.all([persistence, revocation]);
    expect(persisted.authorized).toBe(true);
    expect(revoked.revoked).toHaveLength(1);
    expect(revoked.taxInsightsDeleted).toBe(1);
    expect(revoked).toMatchObject({
      taxRunsDisabled: 1,
      taxFormsDisabled: 1,
      businessEntitiesDeleted: 1,
      situationProfilesDeleted: 1,
      reviewItemsDeleted: 1,
    });

    const remaining = await pool.query(`SELECT id FROM tax_insights WHERE user_id=$1`, [userId]);
    expect(remaining.rowCount).toBe(0);
    const run = await pool.query(`SELECT status FROM tax_extraction_runs WHERE id=$1`, [runId]);
    expect(run.rows[0]?.status).toBe("failed");
    const form = await pool.query(
      `SELECT status,business_entity_id FROM logical_documents WHERE id=$1`,
      [logicalDocumentId],
    );
    expect(form.rows[0]).toMatchObject({ status: "revoked", business_entity_id: null });
    const projections = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM borrower_business_entities WHERE user_id=$1) entities,
         (SELECT count(*)::int FROM situation_profiles WHERE user_id=$1) situations,
         (SELECT count(*)::int FROM review_items
           WHERE user_id=$1 AND item_type='tieout_variance') tax_reviews,
         (SELECT count(*)::int FROM review_items
           WHERE user_id=$1 AND item_type='bank_statement_review') bank_reviews,
         (SELECT count(*)::int FROM review_items
           WHERE user_id=$1 AND item_type='se_income_review') business_reviews,
         (SELECT count(*)::int FROM review_items
           WHERE user_id=$1 AND item_type='dscr_review') rental_reviews`,
      [userId],
    );
    expect(projections.rows[0]).toEqual({
      entities: 0,
      situations: 0,
      tax_reviews: 0,
      bank_reviews: 1,
      business_reviews: 1,
      rental_reviews: 1,
    });

    const afterRevocation = await withActiveTaxDocumentConsent(userId, async () => "written");
    expect(afterRevocation).toEqual({ authorized: false, value: null });
  });

  it("locks a live claim through persistence and rejects the old token after takeover", async () => {
    const claimA = `worker-a:${randomUUID()}`;
    const claimB = `worker-b:${randomUUID()}`;
    await pool.query(
      `UPDATE document_extraction_jobs
          SET status='processing',attempt_count=1,claimed_by=$2,claimed_at=now(),
              lease_expires_at=now() + interval '5 minutes',completed_at=NULL
        WHERE id=$1`,
      [jobId, claimA],
    );

    const { db } = await import("../server/db");
    const {
      assertActiveDocumentExtractionClaim,
      lockActiveDocumentExtractionClaim,
      StaleDocumentExtractionClaimError,
    } = await import("../server/services/documentExtractionJobs");
    const before = await pool.query(
      `SELECT status,claimed_by,lease_expires_at > now() AS lease_active
         FROM document_extraction_jobs WHERE id=$1`,
      [jobId],
    );
    expect(before.rows[0]).toMatchObject({
      status: "processing",
      claimed_by: claimA,
      lease_active: true,
    });
    await assertActiveDocumentExtractionClaim({ id: jobId, claimedBy: claimA });

    let lockEntered!: () => void;
    const entered = new Promise<void>((resolve) => { lockEntered = resolve; });
    let releaseLock!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const guardedWrite = db.transaction(async (transaction) => {
      await lockActiveDocumentExtractionClaim({ id: jobId, claimedBy: claimA }, transaction);
      lockEntered();
      await release;
    });
    await entered;

    let takeoverSettled = false;
    const takeover = pool
      .query(
        `UPDATE document_extraction_jobs
            SET claimed_by=$2,lease_expires_at=now() + interval '5 minutes'
          WHERE id=$1`,
        [jobId, claimB],
      )
      .then(() => { takeoverSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(takeoverSettled).toBe(false);

    releaseLock();
    await guardedWrite;
    await takeover;
    await expect(
      assertActiveDocumentExtractionClaim({ id: jobId, claimedBy: claimA }),
    ).rejects.toBeInstanceOf(StaleDocumentExtractionClaimError);
  });
});
