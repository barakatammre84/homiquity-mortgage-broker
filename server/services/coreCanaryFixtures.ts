import PDFDocument from "pdfkit";
import type { ExtractedDocumentData, ExtractedPayStubData } from "../extractionCore";
import { EXTRACTION_MODEL_SINGLE_DOC } from "../extractionCore";

/**
 * One fixed, borrower-free pay statement shared by the ordinary extraction
 * canary and the restart-recovery proof. Keeping one fixture prevents the two
 * proofs from drifting onto different prompts or expected values.
 */
export async function buildSyntheticPayStatementPdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pdf = new PDFDocument({
      size: "LETTER",
      margin: 72,
      info: { Title: "Synthetic extraction canary" },
    });
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.fontSize(20).text("SYNTHETIC PAY STATEMENT", { align: "center" });
    pdf.moveDown().fontSize(11).text("Operational canary only — no borrower data", { align: "center" });
    pdf.moveDown(2).fontSize(12);
    pdf.text("Employee: Morgan Test");
    pdf.text("Employer: Homiquity Canary Corporation");
    pdf.text("Pay period: 2026-08-01 to 2026-08-15");
    pdf.moveDown();
    pdf.text("Gross pay: $3,000.00");
    pdf.text("Net pay: $2,100.00");
    pdf.text("Year-to-date gross: $15,000.00");
    pdf.text("Year-to-date net: $10,500.00");
    pdf.text("Year-to-date taxes: $4,500.00");
    pdf.moveDown();
    pdf.text("Verification code: 7319");
    pdf.end();
  });
}

/** The minimum exact result that makes the synthetic provider read useful. */
export function syntheticPayStatementExtractionPasses(
  extracted: ExtractedDocumentData,
): extracted is ExtractedPayStubData {
  if (!("grossPay" in extracted)) return false;
  const evidence = extracted.fieldEvidence?.grossPay;
  const classification = extracted.documentClassification;
  return (
    extracted.modelId === EXTRACTION_MODEL_SINGLE_DOC &&
    extracted.promptVersion !== undefined &&
    /^[0-9a-f]{64}$/.test(extracted.rawResponseHash ?? "") &&
    extracted.grossPay === 3_000 &&
    extracted.netPay === 2_100 &&
    extracted.ytdGross === 15_000 &&
    extracted.ytdNetPay === 10_500 &&
    extracted.ytdTaxes === 4_500 &&
    evidence?.pageNumber === 1 &&
    (evidence?.confidence ?? 0) > 0 &&
    extracted.pageCount === 1 &&
    classification?.pageCount === 1 &&
    classification.pages[0]?.pageNumber === 1 &&
    classification.pages[0]?.documentType === "paystub"
  );
}
