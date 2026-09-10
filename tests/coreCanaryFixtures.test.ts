import { describe, expect, it } from "vitest";
import {
  assertRasterOnlyPdf,
  buildSyntheticPayStatementPdf,
  syntheticPayStatementExtractionFailures,
} from "../server/services/coreCanaryFixtures";
import { EXTRACTION_MODEL_SINGLE_DOC, type ExtractedPayStubData } from "../server/extractionCore";

const exactExtraction: ExtractedPayStubData = {
  grossPay: 3_000,
  netPay: 2_100,
  ytdGross: 15_000,
  ytdNetPay: 10_500,
  ytdTaxes: 4_500,
  confidence: "high",
  extractedFields: ["grossPay", "netPay", "ytdGross", "ytdNetPay", "ytdTaxes"],
  warnings: [],
  fieldEvidence: { grossPay: { pageNumber: 1, confidence: 0.98 } },
  pageCount: 1,
  documentClassification: {
    pageCount: 1,
    pages: [{ pageNumber: 1, documentType: "paystub", confidence: 0.95 }],
  },
  modelId: EXTRACTION_MODEL_SINGLE_DOC,
  promptVersion: "2026-09-v8",
  rawResponseHash: "a".repeat(64),
};

describe("core extraction canary fixture", () => {
  it("is a real image-only PDF with no extractable text layer", async () => {
    const pdf = await buildSyntheticPayStatementPdf();

    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    await expect(assertRasterOnlyPdf(pdf)).resolves.toBeUndefined();
  });

  it("rejects a born-digital PDF so the production proof cannot silently weaken", async () => {
    const PDFDocument = (await import("pdfkit")).default;
    const bornDigital = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const pdf = new PDFDocument();
      pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
      pdf.on("error", reject);
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.text("This text must be detectable.");
      pdf.end();
    });

    await expect(assertRasterOnlyPdf(bornDigital)).rejects.toThrow(/text layer/i);
  });

  it("reports fixed redacted labels for the exact invariant that failed", () => {
    expect(syntheticPayStatementExtractionFailures(exactExtraction)).toEqual([]);
    expect(syntheticPayStatementExtractionFailures({
      ...exactExtraction,
      ytdGross: 14_999,
      documentClassification: {
        pageCount: 1,
        pages: [{ pageNumber: 1, documentType: "other", confidence: 0.95 }],
      },
    })).toEqual(["ytd_gross", "classification_page"]);
  });
});
