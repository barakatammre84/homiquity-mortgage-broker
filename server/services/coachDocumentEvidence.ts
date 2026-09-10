import type { Document, TaxInsight, User } from "@shared/schema";
import { canonicalDocumentType } from "@shared/documentTypes";
import { DOCUMENT_STATUS } from "@shared/documentStatus";
import { storage } from "../storage";
import type { DocumentFactRow } from "./documentFacts";
import { getReviewThreshold } from "./documentConfidencePolicy";

export type CoachEvidenceReviewStatus = "machine_read" | "human_verified";
export type CoachEvidenceConfidence = "high" | "medium" | "low" | "not_applicable";

export interface CoachDocumentEvidenceFact {
  label: string;
  value: number;
  format: "currency" | "number";
  reviewStatus: CoachEvidenceReviewStatus;
  confidence: CoachEvidenceConfidence;
  needsHumanReview: boolean;
  pageNumber: number | null;
}

export interface CoachDocumentEvidenceItem {
  documentType: string;
  label: string;
  documentReviewStatus: "uploaded" | "in_review" | "accepted";
  evidenceStatus: "not_extracted" | "machine_read" | "partly_human_verified" | "human_verified";
  facts: CoachDocumentEvidenceFact[];
  omittedFactCount: number;
}

export interface CoachDocumentEvidenceSnapshot {
  documents: CoachDocumentEvidenceItem[];
  summary: {
    documentCount: number;
    extractedFactCount: number;
    humanVerifiedFactCount: number;
    factsNeedingHumanReview: number;
    omittedDocumentCount: number;
  };
  financialReview: {
    status: "approved_for_lender_package" | "not_approved";
    income: "approved" | "not_approved";
    assets: "approved" | "not_approved";
  };
}

type EvidenceDocument = Pick<Document, "id" | "applicationId" | "documentType" | "status" | "createdAt">;
type EvidenceTaxInsight = Pick<
  TaxInsight,
  | "documentId"
  | "taxYear"
  | "wagesW2"
  | "grossIncome"
  | "adjustedGrossIncome"
  | "scheduleCNetProfit"
  | "scheduleENetRental"
  | "scheduleEGrossRents"
  | "rentalPropertyCount"
  | "confidence"
>;

const MAX_DOCUMENTS = 12;
const MAX_FACTS_PER_DOCUMENT = 8;

function sortCurrentDocuments(
  documents: EvidenceDocument[],
  applicationId: string,
): EvidenceDocument[] {
  return documents
    .filter((document) => document.applicationId === applicationId && document.status !== DOCUMENT_STATUS.REJECTED)
    .sort((left, right) => {
      const rightCreatedAt = right.createdAt ? new Date(right.createdAt).getTime() : 0;
      const leftCreatedAt = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      return rightCreatedAt - leftCreatedAt || right.id.localeCompare(left.id);
    });
}

const FACT_PRESENTATION: Record<string, { label: string; format: "currency" | "number" }> = {
  monthly_income_ytd_avg: { label: "Monthly income average from year-to-date pay", format: "currency" },
  gross_pay: { label: "Gross pay", format: "currency" },
  ytd_gross: { label: "Year-to-date gross pay", format: "currency" },
  w2_box_1_wages: { label: "W-2 Box 1 wages", format: "currency" },
  closing_balance: { label: "Closing balance", format: "currency" },
  total_deposits: { label: "Statement-period deposits", format: "currency" },
  average_daily_balance: { label: "Average daily balance", format: "currency" },
  monthly_rent: { label: "Lease monthly rent", format: "currency" },
};

const TAX_FACTS: Array<{
  key: keyof EvidenceTaxInsight;
  label: string;
  format: "currency" | "number";
}> = [
  { key: "wagesW2", label: "W-2 wages reported on return", format: "currency" },
  { key: "grossIncome", label: "Tax-return gross income", format: "currency" },
  { key: "adjustedGrossIncome", label: "Adjusted gross income", format: "currency" },
  { key: "scheduleCNetProfit", label: "Schedule C net profit", format: "currency" },
  { key: "scheduleENetRental", label: "Schedule E net rental amount", format: "currency" },
  { key: "scheduleEGrossRents", label: "Schedule E gross rents", format: "currency" },
  { key: "rentalPropertyCount", label: "Rental properties found on Schedule E", format: "number" },
];

const DOCUMENT_LABELS: Record<string, string> = {
  pay_stub: "Pay stub",
  w2: "W-2",
  bank_statement: "Bank statement",
  tax_return: "Tax return",
  lease_agreement: "Lease agreement",
};

function normalizeDocumentType(value: string): string {
  return canonicalDocumentType(value).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function documentLabel(type: string): string {
  return DOCUMENT_LABELS[type] ?? type.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function confidenceBand(value: number): CoachEvidenceConfidence {
  if (value >= 0.85) return "high";
  if (value >= 0.7) return "medium";
  return "low";
}

function documentReviewStatus(status: string | null): CoachDocumentEvidenceItem["documentReviewStatus"] {
  if (status === DOCUMENT_STATUS.VERIFIED) return "accepted";
  if (status === DOCUMENT_STATUS.VERIFYING) return "in_review";
  return "uploaded";
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function factFromRow(type: string, row: DocumentFactRow): CoachDocumentEvidenceFact | null {
  const presentation = FACT_PRESENTATION[row.fieldName];
  const value = finiteNumber(row.valueNumeric);
  if (!presentation || value === null) return null;
  const verified = row.humanVerified;
  return {
    label: presentation.label,
    value,
    format: presentation.format,
    reviewStatus: verified ? "human_verified" : "machine_read",
    confidence: verified ? "not_applicable" : confidenceBand(row.confidence),
    needsHumanReview: !verified && row.confidence < getReviewThreshold(type),
    pageNumber: row.pageNumber,
  };
}

function factsFromTaxInsight(type: string, insight: EvidenceTaxInsight): CoachDocumentEvidenceFact[] {
  const numericConfidence = insight.confidence === "high" ? 0.9 : insight.confidence === "medium" ? 0.7 : 0.4;
  const facts: CoachDocumentEvidenceFact[] = [];
  for (const definition of TAX_FACTS) {
    const value = finiteNumber(insight[definition.key]);
    if (value === null) continue;
    facts.push({
      label: definition.label,
      value,
      format: definition.format,
      reviewStatus: "machine_read",
      confidence: confidenceBand(numericConfidence),
      needsHumanReview: numericConfidence < getReviewThreshold(type),
      pageNumber: null,
    });
  }
  return facts;
}

function evidenceStatus(facts: CoachDocumentEvidenceFact[]): CoachDocumentEvidenceItem["evidenceStatus"] {
  if (facts.length === 0) return "not_extracted";
  const verified = facts.filter((fact) => fact.reviewStatus === "human_verified").length;
  if (verified === facts.length) return "human_verified";
  if (verified > 0) return "partly_human_verified";
  return "machine_read";
}

/**
 * Borrower-safe projection of document evidence. Only allowlisted numeric
 * facts cross the Homi boundary: no OCR text, filenames, account numbers,
 * taxpayer identifiers, borrower descriptions, staff notes, or reviewer ids.
 */
export function buildCoachDocumentEvidence(input: {
  applicationId: string;
  documents: EvidenceDocument[];
  facts: DocumentFactRow[];
  taxInsights: EvidenceTaxInsight[];
  approvedMemoId: string | null;
  approvedIncomeWorkpaperId: string | null;
  approvedAssetWorkpaperId: string | null;
}): CoachDocumentEvidenceSnapshot {
  const currentDocuments = sortCurrentDocuments(input.documents, input.applicationId);
  const shownDocuments = currentDocuments.slice(0, MAX_DOCUMENTS);
  const factsByDocument = new Map<string, DocumentFactRow[]>();
  for (const fact of input.facts) {
    if (!shownDocuments.some((document) => document.id === fact.documentId)) continue;
    const rows = factsByDocument.get(fact.documentId) ?? [];
    rows.push(fact);
    factsByDocument.set(fact.documentId, rows);
  }
  const taxByDocument = new Map(
    input.taxInsights
      .filter((insight): insight is EvidenceTaxInsight & { documentId: string } =>
        !!insight.documentId && shownDocuments.some((document) => document.id === insight.documentId))
      .map((insight) => [insight.documentId, insight]),
  );

  const documents = shownDocuments.map((document): CoachDocumentEvidenceItem => {
    const type = normalizeDocumentType(document.documentType);
    const extracted = (factsByDocument.get(document.id) ?? [])
      .map((row) => factFromRow(type, row))
      .filter((fact): fact is CoachDocumentEvidenceFact => fact !== null);
    const tax = taxByDocument.get(document.id);
    const allFacts = [
      ...extracted,
      ...(tax ? factsFromTaxInsight(type, tax) : []),
    ].sort((left, right) =>
      Number(right.reviewStatus === "human_verified") - Number(left.reviewStatus === "human_verified") ||
      left.label.localeCompare(right.label),
    );
    const facts = allFacts.slice(0, MAX_FACTS_PER_DOCUMENT);
    return {
      documentType: type,
      label: tax ? `${documentLabel(type)} (${tax.taxYear})` : documentLabel(type),
      documentReviewStatus: documentReviewStatus(document.status),
      evidenceStatus: evidenceStatus(facts),
      facts,
      omittedFactCount: Math.max(0, allFacts.length - facts.length),
    };
  });
  const allShownFacts = documents.flatMap((document) => document.facts);

  return {
    documents,
    summary: {
      documentCount: documents.length,
      extractedFactCount: allShownFacts.length,
      humanVerifiedFactCount: allShownFacts.filter((fact) => fact.reviewStatus === "human_verified").length,
      factsNeedingHumanReview: allShownFacts.filter((fact) => fact.needsHumanReview).length,
      omittedDocumentCount: Math.max(0, currentDocuments.length - documents.length),
    },
    financialReview: {
      status: input.approvedMemoId ? "approved_for_lender_package" : "not_approved",
      income: input.approvedIncomeWorkpaperId ? "approved" : "not_approved",
      assets: input.approvedAssetWorkpaperId ? "approved" : "not_approved",
    },
  };
}

export async function loadCoachDocumentEvidence(
  applicationId: string,
  user: Pick<User, "id" | "role">,
): Promise<CoachDocumentEvidenceSnapshot | null> {
  const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
  if (!application) return null;

  const documents = sortCurrentDocuments(
    await storage.getDocumentsByApplication(applicationId),
    applicationId,
  );
  // Bound the database-backed extraction read to the exact same newest-first
  // window that can reach the model. The full document list still reaches the
  // pure projection so omittedDocumentCount remains honest.
  const evidenceDocuments = documents.slice(0, MAX_DOCUMENTS);
  const documentIds = evidenceDocuments.map((document) => document.id);
  // These modules own database-backed extraction and workpaper reads. Keep
  // them lazy so importing Homi's production tool definitions remains usable
  // by the no-database live model-trigger harness.
  const [{ getFactsForDocuments }, { getCurrentApprovedFinancialVerificationEvidence }] = await Promise.all([
    import("./documentFacts"),
    import("./financialReview"),
  ]);
  const [facts, userTaxInsights, approved] = await Promise.all([
    getFactsForDocuments(documentIds),
    storage.getTaxInsightsByUser(user.id),
    getCurrentApprovedFinancialVerificationEvidence(applicationId),
  ]);
  const ids = new Set(documentIds);
  const taxInsights = userTaxInsights.filter((insight) => insight.documentId && ids.has(insight.documentId));

  return buildCoachDocumentEvidence({
    applicationId,
    documents,
    facts,
    taxInsights,
    approvedMemoId: approved.memo?.id ?? null,
    approvedIncomeWorkpaperId: approved.incomeWorkpaperId,
    approvedAssetWorkpaperId: approved.assetWorkpaperId,
  });
}
