import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { reviewCurrentDocument } from "../server/services/documentLineage";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const borrowerId = randomUUID();
const reviewerId = randomUUID();
const applicationId = randomUUID();
const documentId = randomUUID();

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Tax-document review fixtures require a local test database");
  }
  await pool.query(
    "INSERT INTO users (id,email,role) VALUES ($1,$2,'active_buyer'),($3,$4,'processor')",
    [borrowerId, `tax-review-borrower-${borrowerId}@example.test`, reviewerId, `tax-review-staff-${reviewerId}@example.test`],
  );
  await pool.query(
    "INSERT INTO loan_applications (id,user_id,status) VALUES ($1,$2,'under_review')",
    [applicationId, borrowerId],
  );
  await pool.query(
    "INSERT INTO deal_team_members (application_id,user_id,team_role,is_active) VALUES ($1,$2,'processor',true)",
    [applicationId, reviewerId],
  );
  await pool.query(
    `INSERT INTO documents
       (id,user_id,application_id,document_type,file_name,file_size,mime_type,storage_path,status)
     VALUES ($1,$2,$3,'tax_return','return.pdf',1024,'application/pdf','/objects/return','uploaded')`,
    [documentId, borrowerId, applicationId],
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM logical_documents WHERE source_document_id=$1", [documentId]);
  await pool.query("DELETE FROM document_lineage WHERE document_id=$1", [documentId]);
  await pool.query("DELETE FROM borrower_consents WHERE user_id=$1", [borrowerId]);
  await pool.query("DELETE FROM documents WHERE id=$1", [documentId]);
  await pool.query("DELETE FROM deal_team_members WHERE application_id=$1", [applicationId]);
  await pool.query("DELETE FROM loan_applications WHERE id=$1", [applicationId]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::varchar[])", [[borrowerId, reviewerId]]);
  await pool.end();
});

describe.sequential("tax-document final review consent", () => {
  it("blocks a final verdict while authorization is inactive", async () => {
    await expect(reviewCurrentDocument({
      actor: { id: reviewerId, role: "processor" },
      documentId,
      status: "verified",
    })).rejects.toMatchObject({
      message: "Tax document authorization is no longer active",
      status: 403,
    });
  });

  it("allows the assigned reviewer after the borrower authorizes tax use", async () => {
    await pool.query(
      `INSERT INTO borrower_consents
         (user_id,application_id,consent_type,consent_given,consent_method,is_revoked)
       VALUES ($1,$2,'tax_document_use',true,'click',false)`,
      [borrowerId, applicationId],
    );
    const result = await reviewCurrentDocument({
      actor: { id: reviewerId, role: "processor" },
      documentId,
      status: "verified",
    });
    expect(result.decisionApplied).toBe(true);
    expect(result.document.status).toBe("verified");
  });
});
