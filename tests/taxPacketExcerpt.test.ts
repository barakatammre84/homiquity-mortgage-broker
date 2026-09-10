import path from "node:path";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import {
  TaxPacketExcerptError,
  TaxPacketExcerptSession,
} from "../server/services/taxPacketExcerpt";

async function syntheticPdf(pageCount: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const document = new PDFDocument({ size: "LETTER", margin: 72, compress: true });
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  for (let page = 1; page <= pageCount; page++) {
    if (page > 1) document.addPage();
    document.fontSize(18).text(`Synthetic tax source page ${page}`);
  }
  document.end();
  return finished;
}

async function pdfPageCount(bytes: Buffer): Promise<number> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl =
    path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl });
  try {
    return (await loading.promise).numPages;
  } finally {
    await loading.destroy();
  }
}

describe("tax packet provider excerpts", () => {
  it("loads a PDF once and emits only the classified page range", async () => {
    const session = await TaxPacketExcerptSession.open(
      await syntheticPdf(6),
      "application/pdf",
    );
    try {
      expect(session.pageCount).toBe(6);
      const excerpt = await session.excerpt(3, 4);
      expect(excerpt.mimeType).toBe("application/pdf");
      expect(excerpt.pageCount).toBe(2);
      expect(excerpt.sourcePageOffset).toBe(2);
      expect(await pdfPageCount(excerpt.bytes)).toBe(2);
    } finally {
      await session.close();
    }
  });

  it("fails closed on a classifier range outside the rendered source", async () => {
    const session = await TaxPacketExcerptSession.open(
      await syntheticPdf(2),
      "application/pdf",
    );
    try {
      await expect(session.excerpt(2, 3)).rejects.toBeInstanceOf(TaxPacketExcerptError);
      await expect(session.excerpt(0, 1)).rejects.toBeInstanceOf(TaxPacketExcerptError);
    } finally {
      await session.close();
    }
  });

  it("keeps a one-page image byte-identical and rejects work after close", async () => {
    const canvas = createCanvas(800, 1_000);
    canvas.getContext("2d").fillText("Synthetic Schedule C", 40, 60);
    const source = canvas.toBuffer("image/png");
    canvas.width = 0;
    canvas.height = 0;

    const session = await TaxPacketExcerptSession.open(source, "image/png");
    expect(session.pageCount).toBe(1);
    const excerpt = await session.excerpt(1, 1);
    expect(excerpt.bytes.equals(source)).toBe(true);
    expect(excerpt.mimeType).toBe("image/png");
    expect(excerpt.sourcePageOffset).toBe(0);
    await session.close();
    await expect(session.excerpt(1, 1)).rejects.toBeInstanceOf(TaxPacketExcerptError);
  });
});
