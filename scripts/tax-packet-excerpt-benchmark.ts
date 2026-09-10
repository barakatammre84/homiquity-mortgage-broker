import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { TaxPacketExcerptSession } from "../server/services/taxPacketExcerpt";

const PAGE_COUNT = 100;
const SEGMENTS = [
  { formType: "tax_return_1040", pageStart: 1, pageEnd: 25 },
  { formType: "schedule_c", pageStart: 26, pageEnd: 50 },
  { formType: "schedule_e", pageStart: 51, pageEnd: 75 },
  { formType: "business_tax_return_1065", pageStart: 76, pageEnd: 100 },
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function syntheticTaxPacket(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const document = new PDFDocument({ size: "LETTER", margin: 48, compress: true });
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber++) {
    if (pageNumber > 1) document.addPage();
    const segment = SEGMENTS.find(
      (candidate) => pageNumber >= candidate.pageStart && pageNumber <= candidate.pageEnd,
    )!;
    document.fontSize(16).text("HOMIQUITY SYNTHETIC TAX CAPACITY PROOF", { align: "center" });
    document.moveDown().fontSize(11).text(`Form type: ${segment.formType}`);
    document.text(`Synthetic source page ${pageNumber} of ${PAGE_COUNT}`);
    document.text("No borrower information. Values below are synthetic layout material.");
    document.moveDown();
    for (let row = 1; row <= 24; row++) {
      document.text(`Synthetic line ${row.toString().padStart(2, "0")}    ${100_000 + pageNumber * 100 + row}`);
    }
  }
  document.end();
  return finished;
}

async function main(): Promise<void> {
  assert(process.env.NODE_ENV !== "production", "The local excerpt benchmark cannot run in production mode");
  const source = await syntheticTaxPacket();
  const sourceHash = sha256(source);
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);
  const started = performance.now();
  const session = await TaxPacketExcerptSession.open(source, "application/pdf");
  try {
    assert(session.pageCount === PAGE_COUNT, `Expected ${PAGE_COUNT} source pages, found ${session.pageCount}`);
    const excerpts = await Promise.all(
      SEGMENTS.map((segment) => session.excerpt(segment.pageStart, segment.pageEnd)),
    );
    assert(excerpts.every((excerpt) => excerpt.pageCount === 25), "A form excerpt has the wrong page count");
    assert(
      excerpts.every((excerpt, index) => excerpt.sourcePageOffset === SEGMENTS[index].pageStart - 1),
      "A form excerpt has the wrong original-page offset",
    );
    assert(sha256(source) === sourceHash, "The original source bytes changed during excerpting");

    console.log(JSON.stringify({
      status: "passed",
      proofScope: "single source load, bounded form excerpts, original-page offsets and local memory envelope",
      doesNotProve: [
        "provider classification accuracy",
        "field extraction accuracy",
        "production provider latency",
        "production container cost",
      ],
      sourcePageCount: session.pageCount,
      logicalFormCount: SEGMENTS.length,
      providerPagesBeforePerFieldPass: PAGE_COUNT * SEGMENTS.length,
      providerPagesAfterPerFieldPass: excerpts.reduce((sum, excerpt) => sum + excerpt.pageCount, 0),
      excerptPageCounts: excerpts.map((excerpt) => excerpt.pageCount),
      excerptSourcePageOffsets: excerpts.map((excerpt) => excerpt.sourcePageOffset),
      excerptSizesMb: excerpts.map((excerpt) => Number((excerpt.bytes.length / 1024 / 1024).toFixed(2))),
      durationMs: Math.round(performance.now() - started),
      peakProcessRssMb: Number((peakRss / 1024 / 1024).toFixed(1)),
      excerptRssIncreaseMb: Number(((peakRss - baselineRss) / 1024 / 1024).toFixed(1)),
      originalSha256Unchanged: true,
    }, null, 2));
  } finally {
    clearInterval(sampler);
    await session.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
