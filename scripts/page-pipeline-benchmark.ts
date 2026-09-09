import { createHash, randomUUID } from "node:crypto";
import PDFDocument from "pdfkit";
import pg from "pg";
import type { DocumentClassification } from "../server/extractionCore";

const PAGE_COUNT = 100;
const EXPECTED_SEGMENTS = [
  { documentType: "tax_return_1040", pageStart: 1, pageEnd: 25 },
  { documentType: "schedule_c", pageStart: 26, pageEnd: 50 },
  { documentType: "schedule_e", pageStart: 51, pageEnd: 75 },
  { documentType: "business_tax_return_1065", pageStart: 76, pageEnd: 100 },
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function syntheticTaxPacket(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pdf = new PDFDocument({ size: "LETTER", margin: 72, compress: true });
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber++) {
      if (pageNumber > 1) pdf.addPage();
      const segment = EXPECTED_SEGMENTS.find(
        (candidate) => pageNumber >= candidate.pageStart && pageNumber <= candidate.pageEnd,
      )!;
      pdf.fontSize(18).text("HOMIQUITY PAGE PIPELINE PROOF", { align: "center" });
      pdf.moveDown(2).fontSize(12).text(`Synthetic page ${pageNumber} of ${PAGE_COUNT}`);
      pdf.text(`Expected logical type: ${segment.documentType}`);
      pdf.text("No borrower information. No extracted financial values.");
    }
    pdf.end();
  });
}

function classification(): DocumentClassification {
  return {
    pageCount: PAGE_COUNT,
    pages: Array.from({ length: PAGE_COUNT }, (_, index) => {
      const pageNumber = index + 1;
      const segment = EXPECTED_SEGMENTS.find(
        (candidate) => pageNumber >= candidate.pageStart && pageNumber <= candidate.pageEnd,
      )!;
      return { pageNumber, documentType: segment.documentType, confidence: 1 };
    }),
  };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required. Start the local database, then run DATABASE_URL="$(bash scripts/local-db.sh url)" pnpm tsx scripts/page-pipeline-benchmark.ts',
    );
  }
  const databaseUrl = new URL(connectionString);
  assert(
    ["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname),
    "The page-pipeline benchmark refuses every non-local database",
  );
  assert(process.env.NODE_ENV !== "production", "The page-pipeline benchmark cannot run in production mode");
  assert(!process.env.PRIVATE_OBJECT_DIR, "Unset PRIVATE_OBJECT_DIR; this proof uses isolated local objects only");

  const pool = new pg.Pool({ connectionString });
  const userId = randomUUID();
  const documentId = randomUUID();
  let sourcePath = "";
  let derivedPaths: string[] = [];
  let result: Record<string, unknown> | undefined;

  const {
    createLocalUpload,
    deleteLocalObject,
    localObjectExists,
    readLocalObject,
    sha256LocalObject,
    writeLocalObject,
  } = await import("../server/integrations/object_storage");

  try {
    const packet = await syntheticTaxPacket();
    const sourceHash = sha256(packet);
    const local = createLocalUpload();
    sourcePath = local.objectPath;
    writeLocalObject(sourcePath.slice("/objects/".length), packet);

    await pool.query(
      `INSERT INTO users (id,email,role) VALUES ($1,$2,'aspiring_owner')`,
      [userId, `page-pipeline-${userId}@example.test`],
    );
    await pool.query(
      `INSERT INTO documents
         (id,user_id,document_type,file_name,file_size,mime_type,storage_path,status)
       VALUES ($1,$2,'tax_return','synthetic-100-page-tax-packet.pdf',$3,'application/pdf',$4,'uploaded')`,
      [documentId, userId, packet.length, sourcePath],
    );

    const [{ storage }, { materializeDocumentPages }] = await Promise.all([
      import("../server/storage"),
      import("../server/services/documentPageMaterialization"),
    ]);
    const document = await storage.getDocument(documentId);
    assert(document, "The benchmark source document was not persisted");

    const baselineRssBytes = process.memoryUsage().rss;
    let peakRssBytes = baselineRssBytes;
    const memorySampler = setInterval(() => {
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    }, 20);
    const firstStarted = performance.now();
    let first;
    try {
      first = await materializeDocumentPages({
        document,
        borrowerUserId: userId,
        classification: classification(),
        modelVersion: "benchmark-ground-truth-v1",
      });
    } finally {
      clearInterval(memorySampler);
    }
    const firstDurationMs = Math.round(performance.now() - firstStarted);

    const secondStarted = performance.now();
    const second = await materializeDocumentPages({
      document,
      borrowerUserId: userId,
      classification: classification(),
      modelVersion: "benchmark-ground-truth-v1",
    });
    const secondDurationMs = Math.round(performance.now() - secondStarted);

    const pageRows = await pool.query(
      `SELECT p.page_number,p.image_uri,p.width,p.height,c.document_type
         FROM document_pages p
         JOIN document_uploads u ON u.id=p.upload_id
         JOIN page_classifications c ON c.page_id=p.id
        WHERE u.source_document_id=$1
        ORDER BY p.page_number`,
      [documentId],
    );
    derivedPaths = pageRows.rows.map((row) => row.image_uri as string);
    const logicalRows = await pool.query(
      `SELECT l.document_type,l.page_start,l.page_end,count(ldp.page_id)::int AS linked_pages
         FROM logical_documents l
         LEFT JOIN logical_document_pages ldp ON ldp.logical_document_id=l.id
        WHERE l.source_document_id=$1 AND l.status <> 'rejected'
        GROUP BY l.id,l.document_type,l.page_start,l.page_end
        ORDER BY l.page_start`,
      [documentId],
    );

    assert(first.pageCount === PAGE_COUNT && first.logicalDocumentCount === EXPECTED_SEGMENTS.length, "First pass returned incorrect counts");
    assert(first.reused === false, "First pass unexpectedly reused prior materialization");
    assert(second.pageCount === PAGE_COUNT && second.logicalDocumentCount === EXPECTED_SEGMENTS.length, "Idempotent pass returned incorrect counts");
    assert(second.reused === true, "Second pass did not reuse the materialized page set");
    assert(pageRows.rowCount === PAGE_COUNT, `Expected ${PAGE_COUNT} normalized pages, found ${pageRows.rowCount ?? 0}`);
    assert(logicalRows.rowCount === EXPECTED_SEGMENTS.length, "Logical document count does not match the ground-truth segments");

    for (let index = 0; index < pageRows.rows.length; index++) {
      const row = pageRows.rows[index];
      const expectedPage = index + 1;
      assert(row.page_number === expectedPage, `Normalized page sequence breaks at page ${expectedPage}`);
      assert(Number(row.width) > 0 && Number(row.height) > 0, `Normalized page ${expectedPage} has invalid dimensions`);
      const bytes = readLocalObject(row.image_uri);
      assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Normalized page ${expectedPage} is not a readable PNG`);
    }
    for (let index = 0; index < EXPECTED_SEGMENTS.length; index++) {
      const expected = EXPECTED_SEGMENTS[index];
      const row = logicalRows.rows[index];
      assert(row.document_type === expected.documentType, `Logical segment ${index + 1} has the wrong type`);
      assert(row.page_start === expected.pageStart && row.page_end === expected.pageEnd, `Logical segment ${index + 1} has the wrong boundary`);
      assert(row.linked_pages === expected.pageEnd - expected.pageStart + 1, `Logical segment ${index + 1} is missing page links`);
    }
    assert(sha256LocalObject(sourcePath) === sourceHash, "The original source bytes changed during materialization");

    result = {
      status: "passed",
      proofScope: "normalization, private derived-page persistence, logical segmentation, source immutability and idempotency",
      doesNotProve: [
        "provider classification accuracy",
        "field extraction accuracy",
        "queue restart recovery",
        "cloud object persistence",
      ],
      pageCount: first.pageCount,
      logicalDocumentCount: first.logicalDocumentCount,
      readablePngPages: pageRows.rowCount,
      firstPassDurationMs: firstDurationMs,
      idempotentPassDurationMs: secondDurationMs,
      peakProcessRssMb: Number((peakRssBytes / 1024 / 1024).toFixed(1)),
      pagePipelineRssIncreaseMb: Number(((peakRssBytes - baselineRssBytes) / 1024 / 1024).toFixed(1)),
      originalSha256Unchanged: true,
      modelVersion: "benchmark-ground-truth-v1",
    };
  } finally {
    const paths = await pool.query(
      `SELECT p.image_uri
         FROM document_pages p
         JOIN document_uploads u ON u.id=p.upload_id
        WHERE u.source_document_id=$1`,
      [documentId],
    ).catch(() => ({ rows: [] as Array<{ image_uri: string }> }));
    derivedPaths = [...new Set([...derivedPaths, ...paths.rows.map((row) => row.image_uri)])];
    await pool.query(
      `DELETE FROM logical_document_pages WHERE logical_document_id IN
         (SELECT id FROM logical_documents WHERE source_document_id=$1)`,
      [documentId],
    ).catch(() => undefined);
    await pool.query(`DELETE FROM logical_documents WHERE source_document_id=$1`, [documentId]).catch(() => undefined);
    await pool.query(
      `DELETE FROM page_classifications WHERE page_id IN
         (SELECT p.id FROM document_pages p JOIN document_uploads u ON u.id=p.upload_id WHERE u.source_document_id=$1)`,
      [documentId],
    ).catch(() => undefined);
    await pool.query(
      `DELETE FROM document_pages WHERE upload_id IN
         (SELECT id FROM document_uploads WHERE source_document_id=$1)`,
      [documentId],
    ).catch(() => undefined);
    await pool.query(`DELETE FROM document_uploads WHERE source_document_id=$1`, [documentId]).catch(() => undefined);
    await pool.query(`DELETE FROM documents WHERE id=$1`, [documentId]).catch(() => undefined);
    await pool.query(`DELETE FROM users WHERE id=$1`, [userId]).catch(() => undefined);
    for (const objectPath of derivedPaths) deleteLocalObject(objectPath);
    if (sourcePath) deleteLocalObject(sourcePath);

    const leftover = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM documents WHERE id=$1) documents,
         (SELECT count(*)::int FROM document_uploads WHERE source_document_id=$1) uploads,
         (SELECT count(*)::int FROM logical_documents WHERE source_document_id=$1) logical_documents`,
      [documentId],
    ).catch(() => ({ rows: [{ documents: -1, uploads: -1, logical_documents: -1 }] }));
    const databaseCleanupVerified = Object.values(leftover.rows[0]).every((value) => value === 0);
    const objectCleanupVerified = !sourcePath || (
      !localObjectExists(sourcePath) && derivedPaths.every((objectPath) => !localObjectExists(objectPath))
    );
    await pool.end();
    if (result) {
      assert(databaseCleanupVerified && objectCleanupVerified, "Benchmark cleanup verification failed");
      result.cleanupVerified = true;
      console.log(JSON.stringify(result, null, 2));
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
