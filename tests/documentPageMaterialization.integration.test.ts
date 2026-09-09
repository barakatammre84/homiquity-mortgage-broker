import { randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLocalUpload,
  deleteLocalObject,
  writeLocalObject,
} from "../server/integrations/object_storage";
import { storage } from "../server/storage";
import {
  correctDocumentPacketBoundaries,
  extractMaterializedPacketSegments,
  getDocumentPacketReview,
  linkTaxExtractionRunToMaterializedPages,
  materializeDocumentPages,
} from "../server/services/documentPageMaterialization";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const userId = randomUUID();
const documentId = randomUUID();
const taxRunId = randomUUID();
let sourcePath = "";

async function syntheticPacket(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pdf = new PDFDocument({ size: "LETTER", margin: 72 });
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.fontSize(18).text("PAY STATEMENT");
    pdf.addPage().fontSize(18).text("FORM W-2");
    pdf.end();
  });
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Page materialization fixtures require a local test database");
  }
  const packet = await syntheticPacket();
  const local = createLocalUpload();
  sourcePath = local.objectPath;
  writeLocalObject(sourcePath.slice("/objects/".length), packet);
  await pool.query(
    `INSERT INTO users (id,email,role) VALUES ($1,$2,'aspiring_owner')`,
    [userId, `page-materialization-${userId}@example.test`],
  );
  await pool.query(
    `INSERT INTO documents
       (id,user_id,document_type,file_name,file_size,mime_type,storage_path,status)
     VALUES ($1,$2,'pay_stub','mixed-packet.pdf',$3,'application/pdf',$4,'uploaded')`,
    [documentId, userId, packet.length, sourcePath],
  );
});

afterAll(async () => {
  const paths = await pool.query(
    `SELECT p.image_uri
       FROM document_pages p
       JOIN document_uploads u ON u.id=p.upload_id
      WHERE u.source_document_id=$1`,
    [documentId],
  );
  const logicalIds = await pool.query(
    `SELECT id FROM logical_documents WHERE source_document_id=$1`,
    [documentId],
  );
  if (logicalIds.rows.length > 0) {
    await pool.query(
      `DELETE FROM extracted_fields WHERE logical_document_id = ANY($1::varchar[])`,
      [logicalIds.rows.map((row) => row.id)],
    );
    await pool.query(
      `DELETE FROM logical_document_pages WHERE logical_document_id = ANY($1::varchar[])`,
      [logicalIds.rows.map((row) => row.id)],
    );
  }
  await pool.query(`DELETE FROM logical_documents WHERE source_document_id=$1`, [documentId]);
  await pool.query(`DELETE FROM tax_extraction_runs WHERE document_id=$1`, [documentId]);
  await pool.query(
    `DELETE FROM page_classifications WHERE page_id IN (
       SELECT p.id FROM document_pages p
       JOIN document_uploads u ON u.id=p.upload_id
       WHERE u.source_document_id=$1
     )`,
    [documentId],
  );
  await pool.query(
    `DELETE FROM document_pages WHERE upload_id IN (
       SELECT id FROM document_uploads WHERE source_document_id=$1
     )`,
    [documentId],
  );
  await pool.query(`DELETE FROM document_uploads WHERE source_document_id=$1`, [documentId]);
  await pool.query(`DELETE FROM documents WHERE id=$1`, [documentId]);
  await pool.query(`DELETE FROM users WHERE id=$1`, [userId]);
  for (const row of paths.rows) deleteLocalObject(row.image_uri);
  deleteLocalObject(sourcePath);
  await pool.end();
});

describe.sequential("document page materialization", () => {
  it("creates private normalized pages and logical packet segments once", async () => {
    const document = await storage.getDocument(documentId);
    expect(document).toBeDefined();
    const first = await materializeDocumentPages({
      document: document!,
      borrowerUserId: userId,
      modelVersion: "test-classifier-v1",
      classification: {
        pageCount: 2,
        pages: [
          { pageNumber: 1, documentType: "paystub", confidence: 0.98 },
          { pageNumber: 2, documentType: "w2", confidence: 0.96 },
        ],
      },
    });
    expect(first).toMatchObject({ pageCount: 2, logicalDocumentCount: 2, reused: false });

    const second = await materializeDocumentPages({
      document: document!,
      borrowerUserId: userId,
      modelVersion: "test-classifier-v1",
      classification: {
        pageCount: 2,
        pages: [
          { pageNumber: 1, documentType: "paystub", confidence: 0.98 },
          { pageNumber: 2, documentType: "w2", confidence: 0.96 },
        ],
      },
    });
    expect(second).toMatchObject({ pageCount: 2, logicalDocumentCount: 2, reused: true });

    const counts = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM document_uploads WHERE source_document_id=$1) uploads,
         (SELECT count(*)::int FROM document_pages p JOIN document_uploads u ON u.id=p.upload_id WHERE u.source_document_id=$1) pages,
         (SELECT count(*)::int FROM logical_documents WHERE source_document_id=$1 AND status <> 'rejected') active_logical`,
      [documentId],
    );
    expect(counts.rows[0]).toEqual({ uploads: 1, pages: 2, active_logical: 2 });
  }, 60_000);

  it("routes each logical segment to its specialized extractor and preserves source pages", async () => {
    const prior = process.env.EXTRACTION_SIMULATE;
    process.env.EXTRACTION_SIMULATE = "true";
    try {
      const summary = await extractMaterializedPacketSegments({
        documentId,
        borrowerUserId: userId,
      });
      expect(summary).toMatchObject({ attemptedSegments: 2, extractedSegments: 2 });
      expect(summary.factsPersisted).toBeGreaterThan(0);

      const facts = await pool.query(
        `SELECT f.field_name,f.page_number,l.document_type
           FROM extracted_fields f
           JOIN logical_documents l ON l.id=f.logical_document_id
          WHERE l.source_document_id=$1 AND l.status <> 'rejected'`,
        [documentId],
      );
      expect(facts.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ field_name: "employer_name", page_number: 1, document_type: "paystub" }),
        expect.objectContaining({ field_name: "w2_box_1_wages", page_number: 2, document_type: "w2" }),
      ]));
    } finally {
      if (prior === undefined) delete process.env.EXTRACTION_SIMULATE;
      else process.env.EXTRACTION_SIMULATE = prior;
    }
  });

  it("links tax form values and boundaries to the exact normalized source pages idempotently", async () => {
    await pool.query(
      `INSERT INTO tax_extraction_runs
         (id,document_id,user_id,status,simulated,page_count,form_count,overall_confidence)
       VALUES ($1,$2,$3,'completed',true,2,1,0.95)`,
      [taxRunId, documentId, userId],
    );
    const logical = await pool.query(
      `INSERT INTO logical_documents
         (borrower_id,document_type,aggregated_confidence,status,source_document_id,extraction_run_id,page_start,page_end)
       VALUES ($1,'schedule_c',0.95,'needs_review',$2,$3,1,2)
       RETURNING id`,
      [userId, documentId, taxRunId],
    );
    const logicalId = logical.rows[0].id as string;
    const field = await pool.query(
      `INSERT INTO extracted_fields
         (logical_document_id,page_number,field_name,field_category,value_numeric,value_type,confidence,extraction_method)
       VALUES ($1,2,'netProfitOrLoss','income',42000,'currency',0.96,'simulated')
       RETURNING id`,
      [logicalId],
    );

    const first = await linkTaxExtractionRunToMaterializedPages({ documentId, extractionRunId: taxRunId });
    const second = await linkTaxExtractionRunToMaterializedPages({ documentId, extractionRunId: taxRunId });
    expect(first).toEqual({ logicalDocumentsLinked: 1, fieldsLinked: 1 });
    expect(second).toEqual(first);

    const evidence = await pool.query(
      `SELECT f.page_number,p.page_number AS linked_page,
              (SELECT count(*)::int FROM logical_document_pages WHERE logical_document_id=$1) AS linked_pages
         FROM extracted_fields f
         JOIN document_pages p ON p.id=f.page_id
        WHERE f.id=$2`,
      [logicalId, field.rows[0].id],
    );
    expect(evidence.rows[0]).toEqual({ page_number: 2, linked_page: 2, linked_pages: 2 });
  });

  it("records human page corrections and rebuilds active boundaries", async () => {
    const document = await storage.getDocument(documentId);
    const before = await getDocumentPacketReview(documentId);
    expect(before).toMatchObject({ pageCount: 2, mixedPacket: true });

    const corrected = await correctDocumentPacketBoundaries({
      document: document!,
      borrowerUserId: userId,
      reviewedByUserId: userId,
      corrections: [{ pageNumber: 2, documentType: "paystub" }],
    });
    expect(corrected.mixedPacket).toBe(false);
    expect(corrected.segments).toMatchObject([
      { documentType: "paystub", pageStart: 1, pageEnd: 2 },
    ]);
    expect(corrected.pages[1]).toMatchObject({
      documentType: "paystub",
      machineDocumentType: "w2",
      humanReviewed: true,
    });

    const logical = await pool.query(
      `SELECT status,page_start,page_end,document_type
         FROM logical_documents
        WHERE source_document_id=$1 AND extraction_run_id IS NULL
        ORDER BY created_at`,
      [documentId],
    );
    expect(logical.rows.filter((row) => row.status === "rejected")).toHaveLength(2);
    expect(logical.rows.filter((row) => row.status !== "rejected")).toMatchObject([
      { status: "needs_review", page_start: 1, page_end: 2, document_type: "paystub" },
    ]);
  });
});
