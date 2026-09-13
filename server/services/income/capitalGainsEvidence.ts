import type {
  Document,
  ExtractedField,
  LogicalDocument,
  OtherIncomeSource,
  UrlaAsset,
} from "@shared/schema";
import { classifyOtherIncomeSource } from "@shared/incomeTypes";
import type { FinancialEvidenceComparison } from "@shared/financialReview";
import type { CapitalGainsAnalysisInput } from "./paths/capitalGains";

export type CapitalGainsEvidenceInput = {
  documents: Document[];
  logicalDocuments: LogicalDocument[];
  factsByDocument: Map<string, ExtractedField[]>;
  assets: UrlaAsset[];
  otherIncome: OtherIncomeSource[];
  expectedNoteDate: Date | string | null | undefined;
};

export type CapitalGainsEvidenceResult = {
  analysis: CapitalGainsAnalysisInput | undefined;
  missingItems: string[];
};

/** Explicit fact-to-calculation links frozen into the income workpaper. */
export function capitalGainsEvidenceComparisons(
  analysis: CapitalGainsAnalysisInput | undefined,
): FinancialEvidenceComparison[] {
  if (!analysis) return [];
  return [...analysis.years]
    .sort((a, b) => b.taxYear - a.taxYear)
    .map(year => ({
      id: `income:capital-gains:${year.scheduleDDocumentId}:${year.verifiedFactId}`,
      kind: "income" as const,
      status: "match" as const,
      documentId: year.scheduleDDocumentId,
      verifiedFactIds: [year.verifiedFactId, year.signatureVerifiedFactId].sort(),
      label: `${year.taxYear} Schedule D capital gain or loss`,
      evidenceValue: year.annualCapitalGainOrLoss,
      calculationValue: year.annualCapitalGainOrLoss,
      variance: 0,
      tolerance: 0,
      detail: "The human-reviewed Schedule D total is the annual amount used by the capital-gains trend calculation.",
    }));
}

function parsedDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function reviewedNumber(field: ExtractedField | undefined) {
  if (!field?.humanVerified) return null;
  const value = Number(field.humanCorrectedValue ?? field.valueNumeric);
  return Number.isFinite(value) ? value : null;
}

function reviewedString(field: ExtractedField | undefined) {
  if (!field?.humanVerified) return null;
  return (field.humanCorrectedValue ?? field.valueString)?.trim() || null;
}

function reviewedBoolean(field: ExtractedField | undefined) {
  if (!field?.humanVerified) return null;
  const corrected = field.humanCorrectedValue?.trim().toLowerCase();
  if (corrected === "true") return true;
  if (corrected === "false") return false;
  return field.valueBoolean ?? null;
}

function reviewedFact(rows: ExtractedField[], name: string, logicalDocumentId?: string) {
  return rows.find(field =>
    field.fieldName === name
    && field.humanVerified
    && (logicalDocumentId === undefined || field.logicalDocumentId === logicalDocumentId),
  );
}

function isInvestmentAsset(asset: UrlaAsset) {
  return /stock|bond|mutual|brokerage|investment|securit|equity/i.test(asset.accountType ?? "");
}

export function isCapitalGainsPortfolioDocumentType(documentType: string | null | undefined) {
  return /brokerage|investment|securit|stock|bond|mutual/i.test(documentType ?? "");
}

/**
 * Conservative expected-year rule. Before the ordinary April filing deadline,
 * the prior filing year remains the latest required return. From April 15 on,
 * require the immediately preceding tax year rather than relying on an
 * extension exception that the file does not model.
 */
export function expectedCapitalGainsTaxYears(noteDate: Date): [number, number] {
  const year = noteDate.getUTCFullYear();
  const afterFilingDeadline = noteDate.getUTCMonth() > 3
    || (noteDate.getUTCMonth() === 3 && noteDate.getUTCDate() >= 15);
  const latest = afterFilingDeadline ? year - 1 : year - 2;
  return [latest, latest - 1];
}

export function fourMonthsBefore(noteDate: Date) {
  const targetMonthStart = new Date(Date.UTC(
    noteDate.getUTCFullYear(),
    noteDate.getUTCMonth() - 4,
    1,
    noteDate.getUTCHours(),
    noteDate.getUTCMinutes(),
    noteDate.getUTCSeconds(),
    noteDate.getUTCMilliseconds(),
  ));
  const targetMonthLastDay = new Date(Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  targetMonthStart.setUTCDate(Math.min(noteDate.getUTCDate(), targetMonthLastDay));
  return targetMonthStart;
}

export function buildCapitalGainsEvidence(
  input: CapitalGainsEvidenceInput,
): CapitalGainsEvidenceResult {
  const declared = input.otherIncome.filter(source =>
    classifyOtherIncomeSource(source.incomeSource) === "capital_gains",
  );
  if (declared.length === 0) return { analysis: undefined, missingItems: [] };

  const missingItems: string[] = [];
  if (declared.length !== 1) {
    missingItems.push("Keep capital gains under one borrower so the same joint tax-return income cannot be counted twice.");
  }
  const borrowerSequenceNumber = declared.length === 1
    ? declared[0].borrowerSequenceNumber ?? 1
    : null;
  const noteDate = parsedDate(input.expectedNoteDate);
  if (!noteDate) {
    missingItems.push("Add the expected note date so tax-return recency and the four-month asset-document age can be checked.");
  }
  const expectedTaxYears = noteDate ? expectedCapitalGainsTaxYears(noteDate) : null;
  const verifiedDocumentIds = new Set(
    input.documents.filter(document => document.status === "verified").map(document => document.id),
  );
  const evidenceYears: CapitalGainsAnalysisInput["years"] = [];

  for (const taxYear of expectedTaxYears ?? []) {
    const form1040s = input.logicalDocuments.filter(form =>
      form.documentType === "tax_return_1040"
      && form.taxYear === taxYear
      && !!form.sourceDocumentId
      && verifiedDocumentIds.has(form.sourceDocumentId),
    );
    const schedulesD = input.logicalDocuments.filter(form =>
      form.documentType === "schedule_d"
      && form.taxYear === taxYear
      && !!form.sourceDocumentId
      && verifiedDocumentIds.has(form.sourceDocumentId),
    );
    if (form1040s.length !== 1) {
      missingItems.push(`Add and accept one complete ${taxYear} personal Form 1040 return packet.`);
    }
    if (schedulesD.length !== 1) {
      missingItems.push(`Add and accept one ${taxYear} Schedule D in the personal return packet.`);
    }
    if (form1040s.length !== 1 || schedulesD.length !== 1) continue;
    const form1040 = form1040s[0];
    const scheduleD = schedulesD[0];
    if (form1040.sourceDocumentId !== scheduleD.sourceDocumentId) {
      missingItems.push(`Link the ${taxYear} Form 1040 and Schedule D in one accepted personal return packet.`);
      continue;
    }
    const rows = input.factsByDocument.get(scheduleD.sourceDocumentId!) ?? [];
    const signatureFact = reviewedFact(rows, "signatureEvidencePresent", form1040.id);
    if (reviewedBoolean(signatureFact) !== true) {
      missingItems.push(`Confirm that the ${taxYear} personal return includes the borrower's signature or accepted electronic-signature evidence.`);
      continue;
    }
    const gainFact = reviewedFact(rows, "totalCapitalGainOrLoss", scheduleD.id);
    const gain = reviewedNumber(gainFact);
    if (!gainFact || gain === null) {
      missingItems.push(`Review the ${taxYear} Schedule D total capital gain or loss.`);
      continue;
    }
    evidenceYears.push({
      taxYear,
      annualCapitalGainOrLoss: gain,
      form1040DocumentId: form1040.sourceDocumentId!,
      scheduleDDocumentId: scheduleD.sourceDocumentId!,
      verifiedFactId: gainFact.id,
      signatureVerifiedFactId: signatureFact!.id,
    });
  }

  let portfolio: CapitalGainsAnalysisInput["portfolio"] | null = null;
  if (noteDate) {
    const earliest = fourMonthsBefore(noteDate);
    const candidates = input.documents
      .filter(document => document.status === "verified" && isCapitalGainsPortfolioDocumentType(document.documentType))
      .flatMap(document => {
        const rows = input.factsByDocument.get(document.id) ?? [];
        const balanceFact = reviewedFact(rows, "closing_balance");
        const dateFact = reviewedFact(rows, "statement_period_end");
        const last4Fact = reviewedFact(rows, "account_number_last4");
        const balance = reviewedNumber(balanceFact);
        const statementEnd = parsedDate(reviewedString(dateFact));
        const last4 = reviewedString(last4Fact)?.replace(/\D/g, "").slice(-4) ?? null;
        if (!balanceFact || !dateFact || !last4Fact || balance === null || !statementEnd || !last4) return [];
        const matchingAssets = input.assets.filter(asset =>
          isInvestmentAsset(asset)
          && asset.accountNumberLast4 === last4
          && Number(asset.cashOrMarketValue ?? 0) > 0,
        );
        if (matchingAssets.length !== 1) return [];
        if (balance <= 0 || statementEnd > noteDate || statementEnd < earliest) return [];
        return [{
          documentId: document.id,
          assetId: matchingAssets[0].id,
          statementEndDate: dateOnly(statementEnd),
          currentMarketValue: balance,
          verifiedFactIds: [balanceFact.id, dateFact.id, last4Fact.id].sort(),
        }];
      })
      .sort((a, b) => b.statementEndDate.localeCompare(a.statementEndDate) || a.documentId.localeCompare(b.documentId));
    portfolio = candidates[0] ?? null;
  }
  if (!portfolio) {
    missingItems.push("Add and review a brokerage statement dated within four months of the expected note date, then tie its account last four to one positive investment asset.");
  }

  const uniqueMissingItems = [...new Set(missingItems)];
  if (
    uniqueMissingItems.length > 0
    || borrowerSequenceNumber === null
    || expectedTaxYears === null
    || evidenceYears.length !== 2
    || !portfolio
  ) {
    return { analysis: undefined, missingItems: uniqueMissingItems };
  }

  return {
    missingItems: [],
    analysis: {
      borrowerSequenceNumber,
      expectedTaxYears,
      years: evidenceYears.sort((a, b) => b.taxYear - a.taxYear),
      portfolio,
      missingItems: [],
    },
  };
}
