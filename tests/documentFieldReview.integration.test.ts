import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const borrowerId = randomUUID();
const reviewerId = randomUUID();
const documentId = randomUUID();
const confirmedFieldId = randomUUID();
const correctedFieldId = randomUUID();
let fixturesCreated = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Document field review fixtures require a local test database");
  }
  await pool.query(
    `INSERT INTO users (id,email,role) VALUES
      ($1,$2,'aspiring_owner'),($3,$4,'processor')`,
    [
      borrowerId,
      `field-review-borrower-${borrowerId}@example.test`,
      reviewerId,
      `field-review-staff-${reviewerId}@example.test`,
    ],
  );
  await pool.query(
    `INSERT INTO documents
       (id,user_id,document_type,file_name,file_size,mime_type,storage_path,status)
     VALUES ($1,$2,'pay_stub','review.pdf',1024,'application/pdf','/objects/review','verifying')`,
    [documentId, borrowerId],
  );
  await pool.query(
    `INSERT INTO document_confidence_scores
       (document_id,document_type,extraction_engine,overall_confidence,
        human_review_required,fields_extracted)
     VALUES ($1,'pay_stub','claude',0.8400,true,2)`,
    [documentId],
  );
  await pool.query(
    `INSERT INTO extracted_fields
       (id,document_id,page_number,field_name,field_category,value_string,value_numeric,
        value_type,confidence,bounding_box,extraction_method,model_version)
     VALUES
       ($1,$3,1,'employer_name','identity','Northwind Logistics',NULL,'string',0.9800,
        '{"x":0.1,"y":0.1,"width":0.3,"height":0.04}'::jsonb,'claude','model-v1'),
       ($2,$3,1,'gross_pay','income',NULL,4200.0000,'currency',0.7400,
        '{"x":0.6,"y":0.4,"width":0.2,"height":0.04}'::jsonb,'claude','model-v1')`,
    [confirmedFieldId, correctedFieldId, documentId],
  );
  fixturesCreated = true;
});

afterAll(async () => {
  if (fixturesCreated) {
    await pool.query(`DELETE FROM analytics_events WHERE actor_id=$1`, [reviewerId]);
    await pool.query(`DELETE FROM extracted_fields WHERE document_id=$1`, [documentId]);
    await pool.query(`DELETE FROM document_confidence_scores WHERE document_id=$1`, [documentId]);
    await pool.query(`DELETE FROM documents WHERE id=$1`, [documentId]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::varchar[])`, [[borrowerId, reviewerId]]);
  }
  await pool.end();
});

describe.sequential("document field evidence review", () => {
  it("returns source evidence, persists corrections atomically, and grades model accuracy", async () => {
    const { getDocumentFieldReview, reviewDocumentFields } = await import(
      "../server/services/documentFieldReview"
    );

    expect(await getDocumentFieldReview(documentId)).toEqual([
      expect.objectContaining({
        id: confirmedFieldId,
        value: "Northwind Logistics",
        pageNumber: 1,
        confidence: 0.98,
        boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.04 },
      }),
      expect.objectContaining({ id: correctedFieldId, value: 4200, confidence: 0.74 }),
    ]);

    await expect(reviewDocumentFields({
      documentId,
      reviewedBy: reviewerId,
      decisions: [
        { fieldId: confirmedFieldId, action: "confirm" },
        { fieldId: correctedFieldId, action: "correct", correctedValue: "4500" },
      ],
      missingFields: [{
        fieldName: "overtime_ytd",
        fieldCategory: "income",
        valueType: "currency",
        correctedValue: "700",
        pageNumber: 1,
      }],
    })).resolves.toEqual({ fieldsCorrect: 1, fieldsCorrected: 1, fieldsMissed: 1 });

    const reviewed = await getDocumentFieldReview(documentId);
    expect(reviewed.find((field) => field.id === correctedFieldId)).toMatchObject({
      machineValue: 4200,
      value: 4500,
      humanVerified: true,
      humanCorrected: true,
    });
    expect(reviewed.find((field) => field.fieldName === "overtime_ytd")).toMatchObject({
      value: 700,
      humanVerified: true,
      humanCorrected: true,
      extractionMethod: "human_correction",
    });

    const confidence = await pool.query(
      `SELECT human_review_completed,fields_correct,fields_corrected,fields_missed,field_accuracy_pct
         FROM document_confidence_scores WHERE document_id=$1`,
      [documentId],
    );
    expect(confidence.rows[0]).toMatchObject({
      human_review_completed: true,
      fields_correct: 1,
      fields_corrected: 1,
      fields_missed: 1,
      field_accuracy_pct: "33.33",
    });
  });

  it("rejects a repeated review instead of double-counting it", async () => {
    const { reviewDocumentFields } = await import("../server/services/documentFieldReview");
    await expect(reviewDocumentFields({
      documentId,
      reviewedBy: reviewerId,
      decisions: [{ fieldId: confirmedFieldId, action: "confirm" }],
      missingFields: [],
    })).rejects.toThrow("do not belong to this document");
  });
});
