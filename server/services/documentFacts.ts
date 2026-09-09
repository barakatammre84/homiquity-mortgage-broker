// ---------------------------------------------------------------------------
// Extracted document FACTS — the values, not just the field names (F-028).
//
// THE GAP THIS CLOSES. A borrower uploads a pay stub. A model reads it. The
// numbers are then discarded: only lineage (field NAMES, confidence, model id)
// is kept, on documents.notes. So the borrower graph had no tier-1 income path
// from pay stubs and no tier-1 asset path at all, and the platform kept asking
// for figures it had already been shown. Tax returns escaped this only because
// tax_insights exists for them specifically.
//
// This is NOT a revert of F-027. That finding removed branches which read
// VALUES out of documents.notes — a column a borrower could write through the
// upload description box, so the only data those branches ever saw was forged.
// The capability was correctly deleted and never replaced; this is the
// replacement, on a server-written table a borrower cannot reach.
//
// WHERE THE VALUES LIVE. `extracted_fields` already models exactly this —
// polymorphic value columns, mandatory confidence, MISMO path, human-review
// columns — and its logicalDocumentId/pageId are already nullable. Migration
// 0054 adds `document_id` so the simple-upload pipeline can attribute rows to a
// `documents` row instead of a UAL logical document. Reusing it beats standing
// up a parallel table that would drift.
// ---------------------------------------------------------------------------

import { db } from "../db";
import { extractedFields } from "@shared/schema";
import { eq, inArray, and, isNotNull } from "drizzle-orm";
import { coarseConfidenceToNumeric } from "./documentConfidence";
import { SIMULATED_MODEL_ID, type ExtractedFieldEvidence } from "../extractionCore";
import type { DatabaseTransaction } from "./documentLineage";

export interface DocumentFact {
  fieldName: string;
  /** Mirrors extracted_fields.field_category. */
  fieldCategory: "income" | "asset" | "identity" | "property";
  valueNumeric?: number;
  valueString?: string;
  valueType: "currency" | "string";
  sourceFieldName: string;
  pageNumber?: number;
  boundingBox?: ExtractedFieldEvidence["boundingBox"];
  confidence?: number;
}

/**
 * Monthly income from a pay stub's year-to-date gross.
 *
 * Deliberately derived from YTD rather than the period gross: annualizing a
 * single period needs a pay frequency the extractor does not emit, whereas
 * YTD-over-months-elapsed is the standard averaging method and needs only the
 * period end date the stub already carries. It also absorbs overtime and
 * commission variation instead of extrapolating one good cheque.
 *
 * Returns null rather than a guess when the inputs cannot support the figure:
 * no date, no YTD, or less than a full month elapsed (a stub dated 8 January
 * would divide by ~0.25 and amplify noise into a fantasy salary).
 */
export function monthlyIncomeFromYtd(
  ytdGross: number | undefined | null,
  payPeriodEndDate: string | undefined | null,
): number | null {
  if (!ytdGross || ytdGross <= 0 || !payPeriodEndDate) return null;

  const end = new Date(payPeriodEndDate);
  if (Number.isNaN(end.getTime())) return null;

  // Read the date in UTC, not local time. `payPeriodEndDate` is a date-only
  // string ("2026-06-30"), which ECMA-262 parses as UTC midnight — but
  // getMonth()/getDate() report LOCAL components. West of Greenwich that shifts
  // the stub back a day: "2026-06-30" reads as 29 June, monthsElapsed becomes
  // 5 + 29/30 = 5.967 instead of 6, and the same stub yields $4,223.46/mo here
  // and $4,200.00/mo in CI. This figure is an underwriting input, so it must not
  // depend on the server's timezone — and the error runs in the dangerous
  // direction, overstating income by ~0.6%.
  const daysInMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  const monthsElapsed = end.getUTCMonth() + end.getUTCDate() / daysInMonth;
  if (monthsElapsed < 1) return null;

  return Math.round((ytdGross / monthsElapsed) * 100) / 100;
}

/**
 * The facts a given extraction yields. Pure — no IO, so the mapping is
 * testable against the real interfaces in server/extractionCore.ts.
 *
 * Lease rent is stored as a property fact, never as qualifying income. Mortgage
 * math therefore stays in its cited path while the reviewer can still inspect
 * every value the extractor read.
 */
export function buildDocumentFacts(
  documentType: string,
  extracted: Record<string, any>,
): DocumentFact[] {
  const facts: DocumentFact[] = [];
  const evidence = (extracted.fieldEvidence ?? {}) as Record<string, ExtractedFieldEvidence>;
  const add = (
    sourceFieldName: string,
    fieldName: string,
    fieldCategory: DocumentFact["fieldCategory"],
    value: unknown,
    valueType: DocumentFact["valueType"],
  ) => {
    if (value === undefined || value === null || value === "") return;
    if (valueType === "currency" && (typeof value !== "number" || !Number.isFinite(value))) return;
    const source = evidence[sourceFieldName];
    facts.push({
      sourceFieldName,
      fieldName,
      fieldCategory,
      valueType,
      ...(valueType === "currency" ? { valueNumeric: value as number } : { valueString: String(value) }),
      pageNumber: source?.pageNumber,
      boundingBox: source?.boundingBox,
      confidence: source?.confidence,
    });
  };

  if (documentType === "pay_stub") {
    const monthly = monthlyIncomeFromYtd(extracted.ytdGross, extracted.payPeriodEndDate);
    if (monthly !== null) {
      facts.push({
        fieldName: "monthly_income_ytd_avg",
        fieldCategory: "income",
        valueNumeric: monthly,
        valueType: "currency",
        sourceFieldName: "ytdGross",
        pageNumber: evidence.ytdGross?.pageNumber,
        boundingBox: evidence.ytdGross?.boundingBox,
        confidence: Math.min(
          evidence.ytdGross?.confidence ?? coarseConfidenceToNumeric(extracted.confidence),
          evidence.payPeriodEndDate?.confidence ?? coarseConfidenceToNumeric(extracted.confidence),
        ),
      });
    }
    add("employeeName", "employee_name", "identity", extracted.employeeName, "string");
    add("employerName", "employer_name", "identity", extracted.employerName, "string");
    add("payPeriodStartDate", "pay_period_start_date", "income", extracted.payPeriodStartDate, "string");
    add("payPeriodEndDate", "pay_period_end_date", "income", extracted.payPeriodEndDate, "string");
    add("grossPay", "gross_pay", "income", extracted.grossPay, "currency");
    add("netPay", "net_pay", "income", extracted.netPay, "currency");
    add("ytdGross", "ytd_gross", "income", extracted.ytdGross, "currency");
    add("ytdNetPay", "ytd_net_pay", "income", extracted.ytdNetPay, "currency");
    add("ytdTaxes", "ytd_taxes", "income", extracted.ytdTaxes, "currency");
    add("deductions.federal", "federal_deduction", "income", extracted.deductions?.federal, "currency");
    add("deductions.fica", "fica_deduction", "income", extracted.deductions?.fica, "currency");
    add("deductions.other", "other_deductions", "income", extracted.deductions?.other, "currency");
  }

  if (documentType === "bank_statement") {
    add("accountType", "account_type", "asset", extracted.accountType, "string");
    add("accountNumber", "account_number_last4", "identity", extracted.accountNumber, "string");
    add("statementPeriod.start", "statement_period_start", "asset", extracted.statementPeriod?.start, "string");
    add("statementPeriod.end", "statement_period_end", "asset", extracted.statementPeriod?.end, "string");
    add("openingBalance", "opening_balance", "asset", extracted.openingBalance, "currency");
    add("closingBalance", "closing_balance", "asset", extracted.closingBalance, "currency");
    add("totalDeposits", "total_deposits", "asset", extracted.totalDeposits, "currency");
    add("totalWithdrawals", "total_withdrawals", "asset", extracted.totalWithdrawals, "currency");
    add("averageDailyBalance", "average_daily_balance", "asset", extracted.averageDailyBalance, "currency");
  }

  if (documentType === "lease_agreement") {
    add("monthlyRent", "monthly_rent", "property", extracted.monthlyRent, "currency");
    add("tenantName", "tenant_name", "identity", extracted.tenantName, "string");
    add("landlordName", "landlord_name", "identity", extracted.landlordName, "string");
    add("propertyAddress", "property_address", "property", extracted.propertyAddress, "string");
    add("leaseStartDate", "lease_start_date", "property", extracted.leaseStartDate, "string");
    add("leaseEndDate", "lease_end_date", "property", extracted.leaseEndDate, "string");
    add("securityDeposit", "security_deposit", "property", extracted.securityDeposit, "currency");
  }

  return facts;
}

/**
 * Persist the facts for one extracted document, replacing any prior run's rows
 * for that document so a re-extraction corrects rather than duplicates.
 *
 * Non-fatal by contract: the caller treats a failure here as a lost signal, not
 * a failed extraction.
 */
export async function persistDocumentFacts(
  documentId: string,
  documentType: string,
  extracted: Record<string, any>,
  confidence: "high" | "medium" | "low",
  modelId?: string | null,
  transaction: DatabaseTransaction | typeof db = db,
): Promise<number> {
  const facts = buildDocumentFacts(documentType, extracted);
  const numericConfidence = coarseConfidenceToNumeric(confidence);

  const verifiedRows = await transaction
    .select({ fieldName: extractedFields.fieldName })
    .from(extractedFields)
    .where(and(
      eq(extractedFields.documentId, documentId),
      eq(extractedFields.humanVerified, true),
    ));
  const verifiedNames = new Set(verifiedRows.map((row) => row.fieldName));
  await transaction.delete(extractedFields).where(and(
    eq(extractedFields.documentId, documentId),
    eq(extractedFields.humanVerified, false),
  ));

  // A low-confidence read can clear stale machine values but never replace a
  // human correction or promote a new guess into the evidence graph.
  if (confidence === "low" || facts.length === 0) return 0;
  const modelFacts = facts.filter((fact) => !verifiedNames.has(fact.fieldName));
  if (modelFacts.length === 0) return 0;

  await transaction.insert(extractedFields).values(
    modelFacts.map(f => ({
      documentId,
      fieldName: f.fieldName,
      fieldCategory: f.fieldCategory,
      valueString: f.valueString ?? null,
      valueNumeric: f.valueNumeric !== undefined ? String(f.valueNumeric) : null,
      valueType: f.valueType,
      confidence: String(f.confidence ?? numericConfidence),
      pageNumber: f.pageNumber ?? null,
      boundingBox: f.boundingBox ?? null,
      extractionMethod: modelId === SIMULATED_MODEL_ID ? "simulated" : "claude",
      modelVersion: modelId ?? null,
    })),
  );

  return modelFacts.length;
}

export async function clearUnverifiedDocumentFacts(
  documentId: string,
  transaction: DatabaseTransaction | typeof db = db,
): Promise<void> {
  await transaction.delete(extractedFields).where(and(
    eq(extractedFields.documentId, documentId),
    eq(extractedFields.humanVerified, false),
  ));
}

export interface DocumentFactRow {
  documentId: string;
  fieldName: string;
  fieldCategory: string | null;
  valueNumeric: number | null;
  valueString: string | null;
  humanVerified: boolean;
  humanCorrectedValue: string | null;
}

/** Facts for a set of simple-upload documents, for the borrower graph. */
export async function getFactsForDocuments(documentIds: string[]): Promise<DocumentFactRow[]> {
  if (documentIds.length === 0) return [];

  const rows = await db
    .select()
    .from(extractedFields)
    .where(
      and(
        isNotNull(extractedFields.documentId),
        inArray(extractedFields.documentId, documentIds),
      ),
    );

  return rows.map(r => ({
    documentId: r.documentId as string,
    fieldName: r.fieldName,
    fieldCategory: r.fieldCategory,
    valueNumeric:
      r.humanCorrectedValue !== null && ["currency", "number"].includes(r.valueType)
        ? Number(r.humanCorrectedValue)
        : r.valueNumeric !== null
          ? Number(r.valueNumeric)
          : null,
    valueString:
      r.humanCorrectedValue !== null && !["currency", "number"].includes(r.valueType)
        ? r.humanCorrectedValue
        : r.valueString,
    humanVerified: !!r.humanVerified,
    humanCorrectedValue: r.humanCorrectedValue,
  }));
}
