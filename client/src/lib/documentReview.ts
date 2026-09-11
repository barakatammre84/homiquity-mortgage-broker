/**
 * Pure helpers for the staff document review workbench (roadmap A6).
 *
 * Display-only triage. Everything here renders badges for a human reviewer;
 * nothing is written back and nothing feeds a decision input. Extraction
 * output stays advisory until a staff member verifies the document — MR-2:
 * POST /api/documents/:id/verify (server/routes/documents.ts) is the only
 * path to status "verified", and the deterministic engines read verified
 * application data, never these comparisons.
 */

import {
  extractionDocumentType,
  isBusinessBankStatementDocumentType,
} from "@shared/documentTypes";

// Who may review lives in shared/documentStatus.ts (DOCUMENT_REVIEW_ROLES /
// canReviewDocuments) — the single client+server mirror of the verify gate.

export function isExtractableDocumentType(documentType: string | null | undefined): boolean {
  return extractionDocumentType(documentType) !== null;
}

export interface ParsedExtractionNotes {
  extractedAt: string | null;
  /** Field NAMES the extractor populated — the current notes writers persist
   * names only; extracted values exist solely in a fresh /extract response. */
  extractedFields: string[];
  confidence: "high" | "medium" | "low" | null;
  humanReviewRequired: boolean | null;
  warnings: string[];
  documentClassification: {
    pageCount: number | null;
    compatible: boolean;
    mixedPacket: boolean;
    minimumConfidence: number;
    segments: Array<{
      documentType: string;
      pageStart: number;
      pageEnd: number;
      confidence: number;
    }>;
  } | null;
}

/**
 * documents.notes is SERVER-WRITTEN extraction lineage only, in one of several
 * shapes (routes/documents.ts, routes/lending/documents.ts, the autopilot
 * orchestrator). It is no longer overloaded: the borrower's upload description
 * moved to its own `borrowerDescription` column in migration 0046, because
 * while it shared this column a borrower could type JSON here and have
 * borrowerGraph and Homi read it back as document-verified extraction
 * (F-027). Anything borrower-authored belongs in `borrowerDescription`.
 *
 * Still parse defensively — historical rows predating 0046 may hold a
 * plain-text description, or value-bearing JSON — and return null for anything
 * that isn't an extraction record.
 */
export function parseExtractionNotes(notes: string | null | undefined): ParsedExtractionNotes | null {
  if (!notes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(notes);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const confidence =
    obj.confidence === "high" || obj.confidence === "medium" || obj.confidence === "low"
      ? obj.confidence
      : null;
  const extractedFields = Array.isArray(obj.extractedFields)
    ? obj.extractedFields.filter((f): f is string => typeof f === "string")
    : [];
  const classificationObject =
    typeof obj.documentClassification === "object" &&
    obj.documentClassification !== null &&
    !Array.isArray(obj.documentClassification)
      ? obj.documentClassification as Record<string, unknown>
      : null;
  const classificationSegments = Array.isArray(classificationObject?.segments)
    ? classificationObject.segments.flatMap((segment) => {
        if (typeof segment !== "object" || segment === null || Array.isArray(segment)) return [];
        const value = segment as Record<string, unknown>;
        if (
          typeof value.documentType !== "string" ||
          typeof value.pageStart !== "number" ||
          typeof value.pageEnd !== "number" ||
          typeof value.confidence !== "number"
        ) return [];
        return [{
          documentType: value.documentType,
          pageStart: value.pageStart,
          pageEnd: value.pageEnd,
          confidence: value.confidence,
        }];
      })
    : [];
  const documentClassification = classificationObject &&
    typeof classificationObject.compatible === "boolean" &&
    typeof classificationObject.mixedPacket === "boolean" &&
    typeof classificationObject.minimumConfidence === "number"
      ? {
          pageCount: typeof classificationObject.pageCount === "number"
            ? classificationObject.pageCount
            : null,
          compatible: classificationObject.compatible,
          mixedPacket: classificationObject.mixedPacket,
          minimumConfidence: classificationObject.minimumConfidence,
          segments: classificationSegments,
        }
      : null;

  // Require at least one extraction marker so an arbitrary JSON-shaped
  // description doesn't render as an extraction record.
  const looksLikeExtraction =
    confidence !== null ||
    extractedFields.length > 0 ||
    typeof obj.humanReviewRequired === "boolean" ||
    typeof obj.extractedAt === "string";
  if (!looksLikeExtraction) return null;

  return {
    extractedAt: typeof obj.extractedAt === "string" ? obj.extractedAt : null,
    extractedFields,
    confidence,
    humanReviewRequired: typeof obj.humanReviewRequired === "boolean" ? obj.humanReviewRequired : null,
    warnings: Array.isArray(obj.warnings)
      ? obj.warnings.filter((w): w is string => typeof w === "string")
      : [],
    documentClassification,
  };
}

export type DocumentReviewGroup = "needs_review" | "verified" | "rejected" | "other";

/**
 * needs_review = staged by extraction for a human ("verifying"), or still
 * "uploaded" but flagged humanReviewRequired by the confidence gate. Everything
 * else buckets by its terminal status; "other" is uploaded-and-unprocessed.
 */
export function documentReviewGroup(doc: {
  status?: string | null;
  notes?: string | null;
}): DocumentReviewGroup {
  if (doc.status === "verifying") return "needs_review";
  if (doc.status === "verified") return "verified";
  if (doc.status === "rejected") return "rejected";
  if (doc.status === "uploaded" || !doc.status) {
    const parsed = parseExtractionNotes(doc.notes);
    if (parsed?.humanReviewRequired === true) return "needs_review";
  }
  return "other";
}

export interface ComparisonRow {
  label: string;
  statedValue: string | null;
  extractedValue: string | null;
  verdict: "consistent" | "variance" | "insufficient_data";
  note?: string;
}

/** ±20% triage bar for income comparisons — a reviewer prompt, not an
 * underwriting rule (those live in the deterministic engines). */
export const INCOME_TOLERANCE = 0.2;

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function formatMoney(n: number | null): string | null {
  if (n === null) return null;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function withinTolerance(actual: number, reference: number, tolerance: number): boolean {
  if (reference === 0) return actual === 0;
  return Math.abs(actual - reference) / Math.abs(reference) <= tolerance;
}

function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Annualize a pay-stub gross from its pay-period dates. Returns null when the
 * dates are missing/nonsensical (period outside 1–62 days) rather than guess a
 * frequency.
 */
export function annualizePayStubGross(
  grossPay: number | null,
  payPeriodStartDate: unknown,
  payPeriodEndDate: unknown,
): number | null {
  if (grossPay === null) return null;
  const start = parseDateOnly(payPeriodStartDate);
  const end = parseDateOnly(payPeriodEndDate);
  if (!start || !end) return null;
  const periodDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (periodDays < 1 || periodDays > 62) return null;
  return grossPay * (365 / periodDays);
}

function incomeRow(
  label: string,
  extractedAnnual: number | null,
  statedAnnual: number | null,
  note?: string,
): ComparisonRow {
  if (extractedAnnual === null || statedAnnual === null) {
    return {
      label,
      statedValue: formatMoney(statedAnnual),
      extractedValue: formatMoney(extractedAnnual),
      verdict: "insufficient_data",
      note,
    };
  }
  return {
    label,
    statedValue: formatMoney(statedAnnual),
    extractedValue: formatMoney(extractedAnnual),
    verdict: withinTolerance(extractedAnnual, statedAnnual, INCOME_TOLERANCE)
      ? "consistent"
      : "variance",
    note,
  };
}

/**
 * Deterministic stated-vs-extracted triage rows for a fresh /extract response.
 * `extracted` is the route's response object (values at the top level);
 * `application` is the already-loaded staff application row.
 */
export function compareExtractedToStated(
  documentType: string,
  extracted: Record<string, unknown>,
  application: {
    annualIncome?: unknown;
    employerName?: unknown;
    downPayment?: unknown;
  },
): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  const statedIncome = toNumber(application.annualIncome);

  const extractorType = extractionDocumentType(documentType);
  if (extractorType === "tax_return") {
    rows.push(
      incomeRow("Gross income vs stated annual income", toNumber(extracted.grossIncome), statedIncome),
    );
  } else if (extractorType === "pay_stub") {
    const annualized = annualizePayStubGross(
      toNumber(extracted.grossPay),
      extracted.payPeriodStartDate,
      extracted.payPeriodEndDate,
    );
    rows.push(
      incomeRow(
        "Annualized gross pay vs stated annual income",
        annualized === null ? null : Math.round(annualized),
        statedIncome,
        annualized === null ? "Pay-period dates missing — cannot annualize" : "Annualized from the pay period",
      ),
    );

    const extractedEmployer =
      typeof extracted.employerName === "string" ? extracted.employerName.trim() : "";
    const statedEmployer =
      typeof application.employerName === "string" ? application.employerName.trim() : "";
    rows.push({
      label: "Employer vs stated employer",
      statedValue: statedEmployer || null,
      extractedValue: extractedEmployer || null,
      verdict:
        extractedEmployer && statedEmployer
          ? extractedEmployer.toLowerCase() === statedEmployer.toLowerCase()
            ? "consistent"
            : "variance"
          : "insufficient_data",
    });
  } else if (extractorType === "bank_statement" && !isBusinessBankStatementDocumentType(documentType)) {
    const closing = toNumber(extracted.closingBalance);
    const down = toNumber(application.downPayment);
    rows.push({
      label: "Closing balance vs stated down payment",
      statedValue: formatMoney(down),
      extractedValue: formatMoney(closing),
      verdict:
        closing !== null && down !== null
          ? closing >= down
            ? "consistent"
            : "variance"
          : "insufficient_data",
      note:
        closing !== null && down !== null
          ? closing >= down
            ? "Balance covers the stated down payment"
            : "Balance is below the stated down payment"
          : undefined,
    });
  }

  return rows;
}
