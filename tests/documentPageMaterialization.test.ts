import PDFDocument from "pdfkit";
import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";
import { renderNormalizedDocumentPages } from "../server/services/documentPageMaterialization";

async function syntheticPdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pdf = new PDFDocument({ size: "LETTER", margin: 72 });
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.fontSize(18).text("Pay statement — page one");
    pdf.addPage().fontSize(18).text("W-2 — page two");
    pdf.end();
  });
}

describe("normalized document page rendering", () => {
  it("materializes every PDF page as a numbered PNG", async () => {
    const pages = await renderNormalizedDocumentPages(await syntheticPdf(), "application/pdf");
    expect(pages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(pages.every((page) => page.bytes.subarray(1, 4).toString() === "PNG")).toBe(true);
    expect(pages.every((page) => page.width > 0 && page.height > 0)).toBe(true);
  });

  it("normalizes an image upload into the same page coordinate space", async () => {
    const source = createCanvas(320, 180);
    source.getContext("2d").fillRect(20, 20, 100, 40);
    const [page] = await renderNormalizedDocumentPages(source.toBuffer("image/png"), "image/png");
    expect(page.pageNumber).toBe(1);
    expect(page.width).toBe(320);
    expect(page.height).toBe(180);
    expect(page.bytes.subarray(1, 4).toString()).toBe("PNG");
  });
});
