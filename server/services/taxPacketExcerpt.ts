import path from "node:path";
import PDFDocument from "pdfkit";
import { createCanvas } from "@napi-rs/canvas";
import { fileToBase64, getMimeType } from "../extractionCore";

const PROVIDER_RENDER_MAX_DIMENSION = 1_568;
const PROVIDER_RENDER_MAX_SCALE = 2;
const MAX_EXCERPT_BYTES = 20 * 1024 * 1024;

export class TaxPacketExcerptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxPacketExcerptError";
  }
}

export interface TaxPacketExcerpt {
  bytes: Buffer;
  mimeType: "application/pdf" | "image/jpeg" | "image/png";
  pageCount: number;
  /** Add this to a provider-relative page number to recover the source page. */
  sourcePageOffset: number;
}

interface PdfPage {
  getViewport(input: { scale: number }): { width: number; height: number };
  render(input: {
    canvas: never;
    canvasContext: never;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
  cleanup(): void;
}

interface PdfHandle {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

interface PdfLoadingTask {
  promise: Promise<PdfHandle>;
  destroy(): Promise<void>;
}

function assertRange(pageStart: number, pageEnd: number, pageCount: number): void {
  if (
    !Number.isInteger(pageStart) ||
    !Number.isInteger(pageEnd) ||
    pageStart < 1 ||
    pageEnd < pageStart ||
    pageEnd > pageCount
  ) {
    throw new TaxPacketExcerptError(
      `Tax form page range ${pageStart}-${pageEnd} is outside the ${pageCount}-page source`,
    );
  }
}

async function finishPdf(document: PDFKit.PDFDocument, chunks: Buffer[]): Promise<Buffer> {
  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });
  document.end();
  return finished;
}

/**
 * Loads one tax packet once, then produces bounded per-form provider inputs.
 * Rendering is serialized so three concurrent provider calls never rasterize
 * three large form ranges at the same time. The excerpts themselves may be in
 * flight together; each is released when its provider call settles.
 */
export class TaxPacketExcerptSession {
  readonly sourceBytes: Buffer;
  readonly sourceMimeType: string;
  readonly pageCount: number;

  private readonly pdf?: PdfHandle;
  private readonly loadingTask?: PdfLoadingTask;
  private renderQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(input: {
    sourceBytes: Buffer;
    sourceMimeType: string;
    pageCount: number;
    pdf?: PdfHandle;
    loadingTask?: PdfLoadingTask;
  }) {
    this.sourceBytes = input.sourceBytes;
    this.sourceMimeType = input.sourceMimeType;
    this.pageCount = input.pageCount;
    this.pdf = input.pdf;
    this.loadingTask = input.loadingTask;
  }

  static async open(source: string | Buffer, storedMimeType?: string): Promise<TaxPacketExcerptSession> {
    const detectedMimeType = getMimeType(source, storedMimeType);
    const sourceMimeType = detectedMimeType === "image/jpg" ? "image/jpeg" : detectedMimeType;
    if (!["application/pdf", "image/jpeg", "image/png"].includes(sourceMimeType)) {
      throw new TaxPacketExcerptError(`Unsupported tax packet source type: ${detectedMimeType}`);
    }
    const sourceBytes = Buffer.from(await fileToBase64(source), "base64");
    if (sourceMimeType.startsWith("image/")) {
      return new TaxPacketExcerptSession({ sourceBytes, sourceMimeType, pageCount: 1 });
    }

    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const standardFontDataUrl =
      path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(sourceBytes),
      standardFontDataUrl,
    }) as unknown as PdfLoadingTask;
    try {
      const pdf = await loadingTask.promise;
      return new TaxPacketExcerptSession({
        sourceBytes,
        sourceMimeType,
        pageCount: pdf.numPages,
        pdf,
        loadingTask,
      });
    } catch (error) {
      await loadingTask.destroy().catch(() => undefined);
      throw error;
    }
  }

  async excerpt(pageStart: number, pageEnd: number): Promise<TaxPacketExcerpt> {
    if (this.closed) throw new TaxPacketExcerptError("Tax packet excerpt session is closed");
    assertRange(pageStart, pageEnd, this.pageCount);

    const render = this.renderQueue.then(() => this.renderExcerpt(pageStart, pageEnd));
    this.renderQueue = render.then(() => undefined, () => undefined);
    return render;
  }

  private async renderExcerpt(pageStart: number, pageEnd: number): Promise<TaxPacketExcerpt> {
    if (!this.pdf) {
      return {
        bytes: this.sourceBytes,
        mimeType: this.sourceMimeType === "image/png" ? "image/png" : "image/jpeg",
        pageCount: 1,
        sourcePageOffset: 0,
      };
    }

    const chunks: Buffer[] = [];
    const document = new PDFDocument({ autoFirstPage: false, compress: true });
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    for (let pageNumber = pageStart; pageNumber <= pageEnd; pageNumber++) {
      const page = await this.pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        PROVIDER_RENDER_MAX_SCALE,
        PROVIDER_RENDER_MAX_DIMENSION / Math.max(base.width, base.height),
      );
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({
          canvas: canvas as never,
          canvasContext: canvas.getContext("2d") as never,
          viewport,
        }).promise;
        const width = canvas.width;
        const height = canvas.height;
        const pageImage = canvas.toBuffer("image/png");
        document.addPage({ size: [width, height], margin: 0 });
        document.image(pageImage, 0, 0, { width, height });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    const bytes = await finishPdf(document, chunks);
    if (bytes.length > MAX_EXCERPT_BYTES) {
      throw new TaxPacketExcerptError(
        `Tax form excerpt is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; split the source packet before provider extraction`,
      );
    }
    return {
      bytes,
      mimeType: "application/pdf",
      pageCount: pageEnd - pageStart + 1,
      sourcePageOffset: pageStart - 1,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.renderQueue;
    await this.loadingTask?.destroy();
  }
}
