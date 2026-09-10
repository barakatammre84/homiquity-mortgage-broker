import { describe, expect, it } from "vitest";
import {
  assertRasterOnlyPdf,
  buildSyntheticPayStatementPdf,
} from "../server/services/coreCanaryFixtures";

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
});
