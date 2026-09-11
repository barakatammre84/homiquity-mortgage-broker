import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const userId = randomUUID();
const otherUserId = randomUUID();
const applicationId = randomUUID();
const otherApplicationId = randomUUID();
const documentId = randomUUID();
const runId = randomUUID();
const entityId = randomUUID();
const profileId = randomUUID();
let fixturesCreated = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Planning-document handoff fixtures require a local test database");
  }

  await pool.query(
    `INSERT INTO users (id,email,role) VALUES
      ($1,$2,'aspiring_owner'),
      ($3,$4,'aspiring_owner')`,
    [
      userId,
      `planning-handoff-${userId}@example.test`,
      otherUserId,
      `planning-handoff-${otherUserId}@example.test`,
    ],
  );
  await pool.query(
    `INSERT INTO loan_applications (id,user_id,status) VALUES
      ($1,$2,'draft'),
      ($3,$4,'draft')`,
    [applicationId, userId, otherApplicationId, otherUserId],
  );
  await pool.query(
    `INSERT INTO documents
      (id,user_id,document_type,file_name,file_size,mime_type,storage_path,status)
     VALUES ($1,$2,'tax_return_1040','planning-return.pdf',2048,'application/pdf',$3,'uploaded')`,
    [documentId, userId, `/objects/${documentId}`],
  );
  await pool.query(
    `INSERT INTO tax_extraction_runs (id,document_id,user_id,status,simulated)
     VALUES ($1,$2,$3,'completed',true)`,
    [runId, documentId, userId],
  );
  await pool.query(
    `INSERT INTO borrower_business_entities
      (id,user_id,identity_key,entity_type,name,auto_resolved)
     VALUES ($1,$2,$3,'sole_proprietorship','Planning Studio',true)`,
    [entityId, userId, `name:planning-studio-${userId}`],
  );
  await pool.query(
    `INSERT INTO situation_profiles
      (id,user_id,profile,inputs_fingerprint)
     VALUES ($1,$2,$3::jsonb,$4)`,
    [profileId, userId, JSON.stringify({ version: "test" }), `handoff-${userId}`],
  );
  fixturesCreated = true;
});

afterAll(async () => {
  if (fixturesCreated) {
    await pool.query(`DELETE FROM situation_profiles WHERE id=$1`, [profileId]);
    await pool.query(`DELETE FROM borrower_business_entities WHERE id=$1`, [entityId]);
    await pool.query(`DELETE FROM tax_extraction_runs WHERE id=$1`, [runId]);
    await pool.query(`DELETE FROM documents WHERE id=$1`, [documentId]);
    await pool.query(`DELETE FROM loan_applications WHERE id = ANY($1::varchar[])`, [[applicationId, otherApplicationId]]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[userId, otherUserId]]);
  }
  await pool.end();
});

describe.sequential("planning document handoff", () => {
  it("fails closed when the destination application belongs to another borrower", async () => {
    const { attachPlanningDocumentsToApplication } = await import("../server/services/planningDocumentHandoff");

    await expect(
      attachPlanningDocumentsToApplication(userId, otherApplicationId),
    ).rejects.toThrow(/borrower's own application/i);

    const document = await pool.query(`SELECT application_id FROM documents WHERE id=$1`, [documentId]);
    expect(document.rows[0].application_id).toBeNull();
  });

  it("moves the source document and its derived tax intelligence together exactly once", async () => {
    const { attachPlanningDocumentsToApplication } = await import("../server/services/planningDocumentHandoff");

    await expect(attachPlanningDocumentsToApplication(userId, applicationId)).resolves.toEqual({
      documents: 1,
      taxRuns: 1,
      businessEntities: 1,
      situationProfiles: 1,
    });
    await expect(attachPlanningDocumentsToApplication(userId, applicationId)).resolves.toEqual({
      documents: 0,
      taxRuns: 0,
      businessEntities: 0,
      situationProfiles: 0,
    });

    const result = await pool.query(
      `SELECT
        (SELECT application_id FROM documents WHERE id=$1) document_application_id,
        (SELECT application_id FROM tax_extraction_runs WHERE id=$2) run_application_id,
        (SELECT application_id FROM borrower_business_entities WHERE id=$3) entity_application_id,
        (SELECT application_id FROM situation_profiles WHERE id=$4) profile_application_id`,
      [documentId, runId, entityId, profileId],
    );
    expect(result.rows[0]).toEqual({
      document_application_id: applicationId,
      run_application_id: applicationId,
      entity_application_id: applicationId,
      profile_application_id: applicationId,
    });
  });
});
