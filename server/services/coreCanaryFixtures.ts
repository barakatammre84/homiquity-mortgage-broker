import PDFDocument from "pdfkit";
import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { resolve } from "node:path";
import type { ExtractedDocumentData, ExtractedPayStubData } from "../extractionCore";
import { EXTRACTION_MODEL_SINGLE_DOC } from "../extractionCore";

const CANARY_FONT_REGULAR = "HomiquityCanaryRegular";
const CANARY_FONT_SEMIBOLD = "HomiquityCanarySemibold";

function registerCanaryFonts(): void {
  const fontDirectory = resolve(process.cwd(), "attached_assets/brand/fonts");
  if (
    !GlobalFonts.has(CANARY_FONT_REGULAR) &&
    !GlobalFonts.registerFromPath(resolve(fontDirectory, "geist-400.woff2"), CANARY_FONT_REGULAR)
  ) {
    throw new Error("Raster extraction fixture could not register its regular font");
  }
  if (
    !GlobalFonts.has(CANARY_FONT_SEMIBOLD) &&
    !GlobalFonts.registerFromPath(resolve(fontDirectory, "geist-600.woff2"), CANARY_FONT_SEMIBOLD)
  ) {
    throw new Error("Raster extraction fixture could not register its semibold font");
  }
}

function darkPixelCount(
  context: SKRSContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const pixels = context.getImageData(x, y, width, height).data;
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (
      pixels[index]! < 80 &&
      pixels[index + 1]! < 100 &&
      pixels[index + 2]! < 120 &&
      pixels[index + 3]! > 200
    ) {
      count += 1;
    }
  }
  return count;
}

function assertCanaryTextRendered(context: SKRSContext2D): void {
  const titleInk = darkPixelCount(context, 250, 110, 775, 80);
  const financialInk = darkPixelCount(context, 100, 320, 1_075, 850);
  if (titleInk < 500 || financialInk < 2_000) {
    throw new Error("Raster extraction fixture font did not render enough visible text");
  }
}

/**
 * One fixed, borrower-free, image-only pay statement shared by the ordinary
 * extraction canary and the restart-recovery proof. The page has no PDF text
 * layer, so a successful read proves the deployed vision path can read pixels
 * rather than accidentally relying on born-digital text extraction. Keeping
 * one fixture prevents the two proofs from drifting onto different prompts or
 * expected values.
 */
export async function buildSyntheticPayStatementPdf(): Promise<Buffer> {
  // 150 DPI letter page. Keep this clean and high contrast: it proves the
  // raster path is wired and usable. Representative scan quality and model
  // accuracy belong to the protected human-labeled benchmark.
  registerCanaryFonts();
  const page = createCanvas(1_275, 1_650);
  try {
    const context = page.getContext("2d");
    context.fillStyle = "#fdfcf9";
    context.fillRect(0, 0, page.width, page.height);
    context.strokeStyle = "#cbd5e1";
    context.lineWidth = 2;
    context.strokeRect(72, 72, page.width - 144, page.height - 144);

    context.textAlign = "center";
    context.fillStyle = "#111827";
    context.font = `42px ${CANARY_FONT_SEMIBOLD}`;
    context.fillText("SYNTHETIC PAY STATEMENT", page.width / 2, 160);
    context.fillStyle = "#475569";
    context.font = `22px ${CANARY_FONT_REGULAR}`;
    context.fillText("Operational canary only — no borrower data", page.width / 2, 210);

    context.textAlign = "left";
    context.fillStyle = "#111827";
    context.font = `26px ${CANARY_FONT_REGULAR}`;
    const lines = [
      "Employee: Morgan Test",
      "Employer: Homiquity Canary Corporation",
      "Pay period: 2026-08-01 to 2026-08-15",
      "",
      "Gross pay: $3,000.00",
      "Net pay: $2,100.00",
      "Year-to-date gross: $15,000.00",
      "Year-to-date net: $10,500.00",
      "Year-to-date taxes: $4,500.00",
      "",
      "Verification code: 7319",
    ];
    lines.forEach((line, index) => context.fillText(line, 130, 360 + index * 72));
    assertCanaryTextRendered(context);

    const raster = page.toBuffer("image/png");
    return await new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const pdf = new PDFDocument({
        size: "LETTER",
        margin: 0,
        info: { Title: "Synthetic raster extraction canary" },
      });
      pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
      pdf.on("error", reject);
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.image(raster, 0, 0, { width: 612, height: 792 });
      pdf.end();
    });
  } finally {
    page.width = 0;
    page.height = 0;
  }
}

/**
 * Runtime assertion used by production canaries. A test alone could prove that
 * yesterday's fixture was raster-only while a later refactor quietly restored
 * a text layer. The deployed proof checks the actual bytes before provider use.
 */
export async function assertRasterOnlyPdf(pdfBytes: Buffer): Promise<void> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBytes) });
  const pdf = await loadingTask.promise;
  try {
    if (pdf.numPages !== 1) {
      throw new Error(`Raster extraction fixture must have exactly one page; received ${pdf.numPages}`);
    }
    const sourcePage = await pdf.getPage(1);
    try {
      const text = await sourcePage.getTextContent();
      if (text.items.length > 0) {
        throw new Error("Raster extraction fixture unexpectedly contains an extractable PDF text layer");
      }
    } finally {
      sourcePage.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
}

export const SYNTHETIC_TAX_PACKET_PAGE_COUNT = 100;

type SyntheticTaxFormSection = {
  startPage: number;
  title: string;
  entity: string | null;
  facts: string[];
};

const SYNTHETIC_TAX_FORM_SECTIONS: SyntheticTaxFormSection[] = [
  {
    startPage: 1,
    title: "FORM 1040 — U.S. INDIVIDUAL INCOME TAX RETURN — TAX YEAR 2025",
    entity: null,
    facts: [
      "Primary taxpayer name: Morgan Test",
      "Filing status: Single",
      "Wages, salaries, tips: $84,000",
      "Total income: $106,000",
      "Adjusted gross income: $103,500",
      "Taxable income: $78,200",
    ],
  },
  {
    startPage: 26,
    title: "SCHEDULE C (FORM 1040) — PROFIT OR LOSS FROM BUSINESS — TAX YEAR 2025",
    entity: "Northstar Test Consulting",
    facts: [
      "Business name: Northstar Test Consulting",
      "Principal business or profession: Technology consulting",
      "Business activity code: 541611",
      "Gross receipts or sales: $48,000",
      "Gross income: $48,000",
      "Total expenses: $18,000",
      "Net profit: $30,000",
      "Depreciation and section 179 expense: $2,000",
    ],
  },
  {
    startPage: 51,
    title: "SCHEDULE E (FORM 1040) — SUPPLEMENTAL INCOME AND LOSS — TAX YEAR 2025",
    entity: null,
    facts: [
      "Number of rental properties: 2",
      "Rents received, total: $36,000",
      "Total expenses, total: $21,600",
      "Depreciation, total: $6,000",
      "Mortgage interest, total: $7,200",
      "Net rental real estate income: $14,400",
    ],
  },
  {
    startPage: 76,
    title: "FORM 1120-S — U.S. INCOME TAX RETURN FOR AN S CORPORATION — TAX YEAR 2025",
    entity: "Harbor Test Services Inc.",
    facts: [
      "S corporation name: Harbor Test Services Inc.",
      "Principal business activity code: 541990",
      "Gross receipts or sales: $210,000",
      "Total income: $210,000",
      "Total deductions: $168,000",
      "Ordinary business income: $42,000",
      "Compensation of officers: $72,000",
      "Number of shareholders: 1",
    ],
  },
];

/**
 * A large, fixed tax package with four recognizable form instances and no real
 * borrower information. Each form occupies two pages; the other pages are
 * plainly labeled supporting worksheets so classification must count the
 * complete 100-page source without inventing extra IRS forms.
 */
export async function buildSyntheticTaxPacketPdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pdf = new PDFDocument({
      autoFirstPage: false,
      size: "LETTER",
      margin: 54,
      info: { Title: "Synthetic 100-page tax packet operational canary" },
    });
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(Buffer.concat(chunks)));

    for (let pageNumber = 1; pageNumber <= SYNTHETIC_TAX_PACKET_PAGE_COUNT; pageNumber++) {
      pdf.addPage();
      const section = [...SYNTHETIC_TAX_FORM_SECTIONS]
        .reverse()
        .find((candidate) => pageNumber >= candidate.startPage)!;
      const formPage = pageNumber - section.startPage + 1;
      pdf.fontSize(9).fillColor("#425466").text(
        `SYNTHETIC OPERATIONAL CANARY · SOURCE PAGE ${pageNumber} OF ${SYNTHETIC_TAX_PACKET_PAGE_COUNT}`,
        { align: "center" },
      );
      pdf.moveDown(2);
      if (formPage <= 2) {
        pdf.fillColor("#111827").fontSize(17).text(section.title, { align: "center" });
        pdf.moveDown().fontSize(10).fillColor("#425466").text(
          `Synthetic test form · page ${formPage} of 2 · no borrower data`,
          { align: "center" },
        );
        pdf.moveDown(2).fontSize(12).fillColor("#111827");
        if (section.entity) pdf.text(`Entity: ${section.entity}`);
        for (const fact of section.facts) pdf.text(fact);
        pdf.moveDown(2).fontSize(10).fillColor("#425466").text(
          formPage === 1
            ? "This synthetic page contains the labeled values used by the production extraction proof."
            : "Continuation page for the same synthetic form instance; no additional values.",
        );
      } else {
        pdf.fillColor("#111827").fontSize(18).text("SUPPORTING TAX WORKSHEET", { align: "center" });
        pdf.moveDown().fontSize(12).text("This page is not an IRS form and contains no financial values.", {
          align: "center",
        });
        pdf.moveDown().fontSize(10).fillColor("#425466").text(
          `Supporting worksheet ${formPage - 2} for the preceding synthetic form section.`,
          { align: "center" },
        );
      }
    }
    pdf.end();
  });
}

/** The minimum exact result that makes the synthetic provider read useful. */
export const SYNTHETIC_PAY_STATEMENT_INVARIANTS = [
  "document_shape",
  "model_lineage",
  "prompt_lineage",
  "raw_response_hash",
  "gross_pay",
  "net_pay",
  "ytd_gross",
  "ytd_net_pay",
  "ytd_taxes",
  "gross_pay_evidence",
  "page_count",
  "classification_page_count",
  "classification_page",
] as const;

export type SyntheticPayStatementInvariant =
  (typeof SYNTHETIC_PAY_STATEMENT_INVARIANTS)[number];

/**
 * Return fixed invariant labels only. The production canary may log these
 * labels to diagnose its borrower-free fixture, without logging model output
 * or values from a real document.
 */
export function syntheticPayStatementExtractionFailures(
  extracted: ExtractedDocumentData,
): SyntheticPayStatementInvariant[] {
  if (!("grossPay" in extracted)) return ["document_shape"];
  const failures: SyntheticPayStatementInvariant[] = [];
  const evidence = extracted.fieldEvidence?.grossPay;
  const classification = extracted.documentClassification;
  if (extracted.modelId !== EXTRACTION_MODEL_SINGLE_DOC) failures.push("model_lineage");
  if (extracted.promptVersion === undefined) failures.push("prompt_lineage");
  if (!/^[0-9a-f]{64}$/.test(extracted.rawResponseHash ?? "")) failures.push("raw_response_hash");
  if (extracted.grossPay !== 3_000) failures.push("gross_pay");
  if (extracted.netPay !== 2_100) failures.push("net_pay");
  if (extracted.ytdGross !== 15_000) failures.push("ytd_gross");
  if (extracted.ytdNetPay !== 10_500) failures.push("ytd_net_pay");
  if (extracted.ytdTaxes !== 4_500) failures.push("ytd_taxes");
  if (evidence?.pageNumber !== 1 || (evidence?.confidence ?? 0) <= 0) {
    failures.push("gross_pay_evidence");
  }
  if (extracted.pageCount !== 1) failures.push("page_count");
  if (classification?.pageCount !== 1) failures.push("classification_page_count");
  if (
    classification?.pages[0]?.pageNumber !== 1 ||
    classification?.pages[0]?.documentType !== "paystub"
  ) {
    failures.push("classification_page");
  }
  return failures;
}

export function syntheticPayStatementExtractionPasses(
  extracted: ExtractedDocumentData,
): extracted is ExtractedPayStubData {
  return syntheticPayStatementExtractionFailures(extracted).length === 0;
}
