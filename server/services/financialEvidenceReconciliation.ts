import type {
  Document,
  EmploymentHistory,
  ExtractedField,
  LogicalDocument,
  RentalPropertyEntry,
  UrlaAsset,
} from "@shared/schema";
import type { FinancialEvidenceComparison } from "@shared/financialReview";
import { canonicalDocumentType } from "@shared/documentTypes";

type ReconciliationInput = {
  documents: Document[];
  factsByDocument: Map<string, ExtractedField[]>;
  employment: EmploymentHistory[];
  assets: UrlaAsset[];
  rentalProperties: RentalPropertyEntry[];
};

type SelfEmploymentReconciliationInput = {
  documents: Document[];
  forms: LogicalDocument[];
  factsByDocument: Map<string, ExtractedField[]>;
  employment: EmploymentHistory;
  businessEntityId: string;
};

function normalized(value: string | null | undefined) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function effectiveString(field: ExtractedField | undefined) {
  if (!field?.humanVerified) return null;
  const value = field.humanCorrectedValue ?? field.valueString;
  return value?.trim() || null;
}

function effectiveNumber(field: ExtractedField | undefined) {
  if (!field?.humanVerified) return null;
  const value = Number(field.humanCorrectedValue ?? field.valueNumeric);
  return Number.isFinite(value) ? value : null;
}

function fact(rows: ExtractedField[], fieldName: string) {
  return rows.find(row => row.fieldName === fieldName && row.humanVerified);
}

function monthlyEmploymentIncome(employment: EmploymentHistory) {
  if (employment.isSelfEmployed) {
    const annualWages = employment.selfEmploymentIncome?.k1?.w2FromBusiness;
    return typeof annualWages === "number" ? annualWages / 12 : null;
  }
  const itemized = [
    employment.baseIncome,
    employment.overtimeIncome,
    employment.bonusIncome,
    employment.commissionIncome,
    employment.otherIncome,
  ];
  if (itemized.some(value => value !== null && value !== undefined && value !== "")) {
    return itemized.reduce<number>((sum, value) => sum + (Number(value) || 0), 0);
  }
  const total = Number(employment.totalMonthlyIncome);
  return Number.isFinite(total) ? total : null;
}

function comparison(input: {
  kind: FinancialEvidenceComparison["kind"];
  documentId: string;
  facts: ExtractedField[];
  label: string;
  evidenceValue: number;
  calculationValue: number | null;
  tolerance: number;
  unmatchedDetail: string;
}): FinancialEvidenceComparison {
  const variance = input.calculationValue === null
    ? null
    : Math.round((input.evidenceValue - input.calculationValue) * 100) / 100;
  const status = input.calculationValue === null
    ? "unlinked" as const
    : Math.abs(variance!) <= input.tolerance
      ? "match" as const
      : "variance" as const;
  const detail = status === "unlinked"
    ? input.unmatchedDetail
    : status === "match"
      ? "The human-reviewed document figure agrees with the value used by this calculation."
      : `The human-reviewed document figure differs from the calculation input by ${Math.abs(variance!).toLocaleString("en-US", { style: "currency", currency: "USD" })}. Explain the difference before approval or correct the source data.`;
  const factIds = input.facts.map(row => row.id).sort();
  return {
    id: `${input.kind}:${input.documentId}:${factIds.join(":")}`,
    kind: input.kind,
    status,
    documentId: input.documentId,
    verifiedFactIds: factIds,
    label: input.label,
    evidenceValue: input.evidenceValue,
    calculationValue: input.calculationValue,
    variance,
    tolerance: input.tolerance,
    detail,
  };
}

/**
 * Compare human-reviewed document dollars with the structured values the
 * financial engine actually consumes. Matching is deliberately narrow: an
 * employer name, account last four, or property address must tie uniquely.
 * Ambiguous evidence is surfaced for review and is never auto-applied.
 */
export function reconcileFinancialEvidence(input: ReconciliationInput): FinancialEvidenceComparison[] {
  const comparisons: FinancialEvidenceComparison[] = [];
  const verifiedDocuments = input.documents.filter(document => document.status === "verified");

  for (const document of verifiedDocuments) {
    const rows = input.factsByDocument.get(document.id) ?? [];
    const type = canonicalDocumentType(document.documentType);

    if (type === "pay_stub") {
      const amountFact = fact(rows, "monthly_income_ytd_avg");
      const evidenceValue = effectiveNumber(amountFact);
      if (amountFact && evidenceValue !== null) {
        const employerFact = fact(rows, "employer_name");
        const employerName = effectiveString(employerFact);
        const matches = employerName
          ? input.employment.filter(row => normalized(row.employerName) === normalized(employerName))
          : [];
        const calculationValue = matches.length === 1 ? monthlyEmploymentIncome(matches[0]) : null;
        comparisons.push(comparison({
          kind: "income",
          documentId: document.id,
          facts: [amountFact, ...(employerFact ? [employerFact] : [])],
          label: employerName ? `Pay statement · ${employerName}` : "Pay statement",
          evidenceValue,
          calculationValue,
          tolerance: Math.max(25, Math.round(evidenceValue * 0.01 * 100) / 100),
          unmatchedDetail: employerName
            ? "This employer does not tie uniquely to one employment record. Link or correct the employment record before approval."
            : "Confirm the employer name on this pay statement before approval so its income can be tied to one employment record.",
        }));
      }
    }

    if (type === "bank_statement") {
      const amountFact = fact(rows, "closing_balance");
      const evidenceValue = effectiveNumber(amountFact);
      if (amountFact && evidenceValue !== null) {
        const accountFact = fact(rows, "account_number_last4");
        const last4 = effectiveString(accountFact)?.replace(/\D/g, "").slice(-4) ?? null;
        const matches = last4
          ? input.assets.filter(asset => asset.accountNumberLast4 === last4)
          : [];
        const calculationValue = matches.length === 1 && matches[0].cashOrMarketValue !== null
          ? Number(matches[0].cashOrMarketValue)
          : null;
        comparisons.push(comparison({
          kind: "asset",
          documentId: document.id,
          facts: [amountFact, ...(accountFact ? [accountFact] : [])],
          label: "Bank statement closing balance",
          evidenceValue,
          calculationValue,
          tolerance: 1,
          unmatchedDetail: last4
            ? "This account does not tie uniquely to one asset record. Link or correct the asset before approval."
            : "Confirm the account last four on this statement before approval so its balance can be tied to one asset record.",
        }));
      }
    }

    if (type === "lease_agreement") {
      const amountFact = fact(rows, "monthly_rent");
      const evidenceValue = effectiveNumber(amountFact);
      if (amountFact && evidenceValue !== null) {
        const addressFact = fact(rows, "property_address");
        const address = effectiveString(addressFact);
        const matches = address
          ? input.rentalProperties.filter(property => normalized(property.address) === normalized(address))
          : [];
        const calculationValue = matches.length === 1 ? Number(matches[0].monthlyRentalIncome) : null;
        comparisons.push(comparison({
          kind: "rental",
          documentId: document.id,
          facts: [amountFact, ...(addressFact ? [addressFact] : [])],
          label: address ? `Lease rent · ${address}` : "Lease rent",
          evidenceValue,
          calculationValue: Number.isFinite(calculationValue) ? calculationValue : null,
          tolerance: 1,
          unmatchedDetail: address
            ? "This lease does not tie uniquely to one rental property. Link or correct the property before approval."
            : "Confirm the property address on this lease before approval so its rent can be tied to one rental record.",
        }));
      }
    }
  }

  return comparisons.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

type WorksheetMoneyMapping = {
  formType: "schedule_c" | "schedule_k1";
  extractedField: string;
  worksheetField: string;
  worksheetValue: (year: Record<string, unknown>) => number | null;
};

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const SELF_EMPLOYMENT_MAPPINGS: WorksheetMoneyMapping[] = [
  { formType: "schedule_c", extractedField: "netProfitOrLoss", worksheetField: "Net profit or loss", worksheetValue: year => numeric(year.netProfitOrLoss) },
  { formType: "schedule_c", extractedField: "depreciationAndSection179", worksheetField: "Depreciation and Section 179", worksheetValue: year => numeric(year.depreciation) },
  { formType: "schedule_c", extractedField: "depletion", worksheetField: "Depletion", worksheetValue: year => numeric(year.depletion) },
  { formType: "schedule_c", extractedField: "businessUseOfHomeExpenses", worksheetField: "Business use of home", worksheetValue: year => numeric(year.businessUseOfHome) },
  { formType: "schedule_c", extractedField: "deductibleMeals", worksheetField: "Deductible meals", worksheetValue: year => numeric(year.mealsExclusion) },
  { formType: "schedule_k1", extractedField: "ordinaryBusinessIncomeOrLoss", worksheetField: "Ordinary business income or loss", worksheetValue: year => numeric(year.ordinaryBusinessIncome) },
  { formType: "schedule_k1", extractedField: "netRentalRealEstateIncomeOrLoss", worksheetField: "Net rental real estate income or loss", worksheetValue: year => numeric(year.netRentalRealEstateIncome) },
  { formType: "schedule_k1", extractedField: "otherNetRentalIncomeOrLoss", worksheetField: "Other net rental income or loss", worksheetValue: year => numeric(year.otherNetRentalIncome) },
  { formType: "schedule_k1", extractedField: "guaranteedPayments", worksheetField: "Guaranteed payments", worksheetValue: year => numeric(year.guaranteedPayments) },
  { formType: "schedule_k1", extractedField: "distributionsTotal", worksheetField: "Distributions received", worksheetValue: year => numeric(year.distributionsReceived) },
];

/** Exact Schedule C / K-1 facts that feed a confirmed Form 1084 worksheet. */
export function reconcileSelfEmploymentEvidence(input: SelfEmploymentReconciliationInput): FinancialEvidenceComparison[] {
  const worksheet = input.employment.selfEmploymentIncome;
  if (!worksheet) return [];
  const verifiedDocumentIds = new Set(input.documents.filter(document => document.status === "verified").map(document => document.id));
  const formType = worksheet.scheduleC ? "schedule_c" as const : worksheet.k1 ? "schedule_k1" as const : null;
  if (!formType) return [];
  const years = worksheet.scheduleC ?? worksheet.k1;
  if (!years) return [];
  const yearRows = [years.currentYear, years.priorYear].filter((year): year is NonNullable<typeof year> => !!year);
  const comparisons: FinancialEvidenceComparison[] = [];

  for (const year of yearRows) {
    const taxYear = numeric(year.taxYear);
    if (taxYear === null) continue;
    const matchingForms = input.forms.filter(form =>
      form.documentType === formType
      && form.businessEntityId === input.businessEntityId
      && form.taxYear === taxYear
      && !!form.sourceDocumentId
      && verifiedDocumentIds.has(form.sourceDocumentId),
    );
    if (matchingForms.length !== 1) continue;
    const form = matchingForms[0];
    const rows = (input.factsByDocument.get(form.sourceDocumentId!) ?? [])
      .filter(row => row.logicalDocumentId === form.id);
    for (const mapping of SELF_EMPLOYMENT_MAPPINGS.filter(item => item.formType === formType)) {
      const evidenceFact = fact(rows, mapping.extractedField);
      const evidenceValue = effectiveNumber(evidenceFact);
      const calculationValue = mapping.worksheetValue(year as Record<string, unknown>);
      if (!evidenceFact || evidenceValue === null || calculationValue === null) continue;
      comparisons.push(comparison({
        kind: "income",
        documentId: form.sourceDocumentId!,
        facts: [evidenceFact],
        label: `${taxYear} ${mapping.worksheetField}`,
        evidenceValue,
        calculationValue,
        tolerance: 1,
        unmatchedDetail: "This reviewed tax figure could not be tied to the confirmed self-employment worksheet.",
      }));
    }
  }

  return comparisons.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}
