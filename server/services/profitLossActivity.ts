import { and, eq, inArray, ne, or } from "drizzle-orm";
import {
  borrowerBusinessEntities,
  documentLineage,
  documents,
  extractedFields,
  logicalDocuments,
  type BorrowerBusinessEntity,
  type Document,
  type DocumentLineage,
  type EmploymentHistory,
  type ExtractedField,
  type LogicalDocument,
} from "@shared/schema";
import { canonicalDocumentType } from "@shared/documentTypes";
import { db } from "../db";
import { currentDocumentVersions, type DatabaseTransaction } from "./documentLineage";
import { computeSelfEmploymentQualifyingIncome } from "./selfEmploymentIncome";

export interface CurrentProfitLossSignal {
  employmentId: string;
  documentId: string;
  periodStart: string;
  periodEnd: string;
  periodMonths: number;
  businessNetProfitLoss: number;
  ownershipPercent: number;
  borrowerMonthlyNet: number;
  taxBasedMonthlyIncome: number;
  direction: "higher_or_equal" | "declining";
  requiresManualReview: boolean;
  note: string;
}

export interface ProfitLossActivityIssue {
  employmentId: string;
  documentId: string;
  message: string;
}

export interface ProfitLossActivityResult {
  signals: CurrentProfitLossSignal[];
  issues: ProfitLossActivityIssue[];
}

const normalized = (value: string | null | undefined) =>
  (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function reviewedString(rows: ExtractedField[], fieldName: string) {
  const row = rows.find(field => field.fieldName === fieldName && field.humanVerified);
  return (row?.humanCorrectedValue ?? row?.valueString)?.trim() || null;
}

function reviewedNumber(rows: ExtractedField[], fieldName: string) {
  const row = rows.find(field => field.fieldName === fieldName && field.humanVerified);
  const value = Number(row?.humanCorrectedValue ?? row?.valueNumeric);
  return Number.isFinite(value) ? value : null;
}

function periodMonths(start: string, end: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  const days = (endMs - startMs) / 86_400_000 + 1;
  if (days < 28 || days > 550) return null;
  return Math.round((days / (365.25 / 12)) * 100) / 100;
}

/**
 * Turn accepted, human-reviewed P&L facts into a current-activity signal. The
 * signal never raises qualifying income. A decrease routes the file to human
 * review because current business stability and continuance require judgment.
 */
export function analyzeProfitLossActivity(input: {
  documents: Document[];
  lineageByDocument: Map<string, DocumentLineage>;
  factsByDocument: Map<string, ExtractedField[]>;
  businesses: BorrowerBusinessEntity[];
  employment: EmploymentHistory[];
  logicalDocuments?: LogicalDocument[];
}): ProfitLossActivityResult {
  const businessById = new Map(input.businesses.map(business => [business.id, business]));
  const employmentByBusinessName = new Map(input.employment.flatMap(row => {
    const name = row.isSelfEmployed ? normalized(row.employerName) : "";
    return name ? [[name, row] as const] : [];
  }));
  const signalsByEmployment = new Map<string, CurrentProfitLossSignal>();
  const issues: ProfitLossActivityIssue[] = [];

  const sourceDocuments = new Map(input.documents.map(document => [document.id, document]));
  const pnlForms = (input.logicalDocuments ?? []).filter(form =>
    !!form.sourceDocumentId && canonicalDocumentType(form.documentType) === "profit_loss",
  );
  const sourcesWithPnlForms = new Set(pnlForms.flatMap(form => form.sourceDocumentId ? [form.sourceDocumentId] : []));
  const units: Array<{ document: Document; form: LogicalDocument | null; facts: ExtractedField[] }> = [
    ...pnlForms.flatMap(form => {
      const document = form.sourceDocumentId ? sourceDocuments.get(form.sourceDocumentId) : undefined;
      if (!document) return [];
      return [{
        document,
        form,
        facts: (input.factsByDocument.get(document.id) ?? []).filter(fact => fact.logicalDocumentId === form.id),
      }];
    }),
    ...input.documents.flatMap(document =>
      canonicalDocumentType(document.documentType) === "profit_loss" && !sourcesWithPnlForms.has(document.id)
        ? [{
            document,
            form: null,
            facts: (input.factsByDocument.get(document.id) ?? []).filter(fact => !fact.logicalDocumentId),
          }]
        : [],
    ),
  ];

  for (const unit of units) {
    const { document, form, facts: rows } = unit;
    if (document.status !== "verified") continue;
    const lineage = input.lineageByDocument.get(document.id);
    const businessId = form?.businessEntityId
      ?? (lineage?.subjectType === "business" ? lineage.subjectId : null);
    if (!businessId) continue;
    const business = businessById.get(businessId);
    const employment = business?.name ? employmentByBusinessName.get(normalized(business.name)) : undefined;
    if (!employment) continue;
    const start = reviewedString(rows, "pnl_period_start_date");
    const end = reviewedString(rows, "pnl_period_end_date");
    const net = reviewedNumber(rows, "pnl_net_profit_loss");
    if (!start || !end || net === null) {
      issues.push({
        employmentId: employment.id,
        documentId: document.id,
        message: `Review the P&L period start, period end, and net profit or loss for ${employment.employerName || "this business"}.`,
      });
      continue;
    }
    const months = periodMonths(start, end);
    if (months === null) {
      issues.push({
        employmentId: employment.id,
        documentId: document.id,
        message: `Correct the P&L reporting period for ${employment.employerName || "this business"}; it must be a valid period between 28 days and 18 months.`,
      });
      continue;
    }
    const ownership = employment.selfEmploymentIncome?.ownershipPercent;
    if (ownership === null || ownership === undefined) {
      issues.push({
        employmentId: employment.id,
        documentId: document.id,
        message: `Record the ownership percentage for ${employment.employerName || "this business"} before using its current P&L.`,
      });
      continue;
    }
    const borrowerMonthlyNet = Math.round((net / months) * (ownership / 100) * 100) / 100;
    const taxBasedMonthlyIncome = computeSelfEmploymentQualifyingIncome(
      employment.selfEmploymentIncome,
    ).monthlyQualifyingIncome;
    const declining = borrowerMonthlyNet + 1 < taxBasedMonthlyIncome;
    const signal: CurrentProfitLossSignal = {
      employmentId: employment.id,
      documentId: document.id,
      periodStart: start,
      periodEnd: end,
      periodMonths: months,
      businessNetProfitLoss: net,
      ownershipPercent: ownership,
      borrowerMonthlyNet,
      taxBasedMonthlyIncome,
      direction: declining ? "declining" : "higher_or_equal",
      requiresManualReview: declining,
      note: declining
        ? `Current P&L annualizes to ${borrowerMonthlyNet.toLocaleString("en-US", { style: "currency", currency: "USD" })} monthly at ${ownership}% ownership, below the tax-based ${taxBasedMonthlyIncome.toLocaleString("en-US", { style: "currency", currency: "USD" })}. Determine the current stable amount before qualification.`
        : `Current P&L does not support increasing qualifying income above the tax-based ${taxBasedMonthlyIncome.toLocaleString("en-US", { style: "currency", currency: "USD" })} monthly calculation.`,
    };
    const prior = signalsByEmployment.get(employment.id);
    if (!prior || signal.periodEnd > prior.periodEnd) signalsByEmployment.set(employment.id, signal);
  }

  return {
    signals: [...signalsByEmployment.values()].sort((a, b) => a.employmentId.localeCompare(b.employmentId)),
    issues: issues.sort((a, b) => a.employmentId.localeCompare(b.employmentId) || a.documentId.localeCompare(b.documentId)),
  };
}

export async function loadProfitLossActivity(
  applicationId: string,
  employment: EmploymentHistory[],
  existingTransaction?: DatabaseTransaction,
): Promise<ProfitLossActivityResult> {
  const transaction = existingTransaction ?? db;
  const allDocuments = await transaction.select().from(documents)
    .where(eq(documents.applicationId, applicationId));
  const lineages = await transaction.select().from(documentLineage)
    .where(eq(documentLineage.applicationId, applicationId));
  const groups = currentDocumentVersions(allDocuments, lineages);
  const currentDocuments = groups.map(group => group.current.document);
  const currentLineages = groups.flatMap(group => group.current.lineage ? [group.current.lineage] : []);
  const documentIds = currentDocuments.map(document => document.id);
  const forms = documentIds.length
    ? await transaction.select().from(logicalDocuments).where(and(
        inArray(logicalDocuments.sourceDocumentId, documentIds),
        ne(logicalDocuments.status, "rejected"),
        ne(logicalDocuments.status, "revoked"),
      ))
    : [];
  const formIds = forms.map(form => form.id);
  const facts = documentIds.length || formIds.length
    ? await transaction.select().from(extractedFields).where(or(
        ...(documentIds.length ? [inArray(extractedFields.documentId, documentIds)] : []),
        ...(formIds.length ? [inArray(extractedFields.logicalDocumentId, formIds)] : []),
      ))
    : [];
  const businessIds = [...new Set([
    ...currentLineages.flatMap(lineage =>
      lineage.subjectType === "business" && lineage.subjectId ? [lineage.subjectId] : [],
    ),
    ...forms.flatMap(form => form.businessEntityId ? [form.businessEntityId] : []),
  ])];
  const businesses = businessIds.length
    ? await transaction.select().from(borrowerBusinessEntities).where(inArray(borrowerBusinessEntities.id, businessIds))
    : [];
  const formDocument = new Map(forms.flatMap(form => form.sourceDocumentId ? [[form.id, form.sourceDocumentId] as const] : []));
  const factsByDocument = new Map<string, ExtractedField[]>();
  for (const fact of facts) {
    const documentId = fact.documentId ?? (fact.logicalDocumentId ? formDocument.get(fact.logicalDocumentId) : null);
    if (!documentId) continue;
    const rows = factsByDocument.get(documentId) ?? [];
    rows.push(fact);
    factsByDocument.set(documentId, rows);
  }
  return analyzeProfitLossActivity({
    documents: currentDocuments,
    lineageByDocument: new Map(currentLineages.map(lineage => [lineage.documentId, lineage])),
    factsByDocument,
    businesses,
    employment,
    logicalDocuments: forms,
  });
}
