import type {
  Document,
  EmploymentHistory,
  ExtractedField,
  LogicalDocument,
  RentalPropertyEntry,
  UrlaAsset,
} from "@shared/schema";
import type {
  FinancialEvidenceComparison,
  FinancialReviewBlocker,
  FinancialSourceReference,
} from "@shared/financialReview";
import { canonicalDocumentType } from "@shared/documentTypes";

type ReconciliationInput = {
  documents: Document[];
  logicalDocuments?: LogicalDocument[];
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

type BusinessLiquidityReconciliationInput = SelfEmploymentReconciliationInput;

/**
 * A document-level acceptance says the file was reviewed, not that the dollar
 * used by a calculation was checked. Financial workpapers must carry at least
 * one human-reviewed numeric fact before that evidence can support approval.
 */
export function financialSourceReviewBlockers(
  sources: FinancialSourceReference[],
  relevantDocumentCount: number,
  requireReviewedNumericFact = true,
): FinancialReviewBlocker[] {
  const blockers: FinancialReviewBlocker[] = [];
  if (!sources.length) {
    blockers.push({
      code: relevantDocumentCount ? "unverified_evidence" : "missing_evidence",
      message: relevantDocumentCount
        ? "Review and accept at least one relevant source document."
        : "Add a relevant source document before approving this workpaper.",
    });
  }
  if (sources.some(source => !source.contentFingerprint)) {
    blockers.push({
      code: "missing_byte_fingerprint",
      message: "Replace legacy source evidence with a fingerprinted version before approval.",
    });
  }
  const sourcesWithoutReviewedNumbers = requireReviewedNumericFact
    ? sources.filter(source => (source.verifiedFacts?.length ?? 0) === 0)
    : [];
  if (sourcesWithoutReviewedNumbers.length > 0) {
    blockers.push({
      code: "unverified_evidence",
      message: `Review at least one numeric source field on each accepted source used by this calculation (${sourcesWithoutReviewedNumbers.length} remaining).`,
    });
  }
  return blockers;
}

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
  const logicalTypeById = new Map((input.logicalDocuments ?? []).map(form => [form.id, form.documentType]));

  for (const document of verifiedDocuments) {
    const allRows = input.factsByDocument.get(document.id) ?? [];
    const units = new Map<string, { type: string; rows: ExtractedField[] }>();
    for (const row of allRows) {
      const key = row.logicalDocumentId ?? "source";
      const rawType = row.logicalDocumentId ? logicalTypeById.get(row.logicalDocumentId) : document.documentType;
      if (!rawType) continue;
      const unit = units.get(key) ?? { type: canonicalDocumentType(rawType), rows: [] };
      unit.rows.push(row);
      units.set(key, unit);
    }

    for (const { type, rows } of units.values()) {

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

    if (type === "w2") {
      const amountFact = fact(rows, "w2_box_1_wages");
      const evidenceValue = effectiveNumber(amountFact);
      if (amountFact && evidenceValue !== null) {
        const employerFact = fact(rows, "employer_name");
        const employerName = effectiveString(employerFact);
        const yearFact = fact(rows, "tax_year");
        const taxYear = effectiveString(yearFact);
        const matches = employerName
          ? input.employment.filter(row => normalized(row.employerName) === normalized(employerName))
          : [];
        const monthly = matches.length === 1 ? monthlyEmploymentIncome(matches[0]) : null;
        const calculationValue = monthly === null ? null : monthly * 12;
        comparisons.push(comparison({
          kind: "income",
          documentId: document.id,
          facts: [amountFact, ...(employerFact ? [employerFact] : []), ...(yearFact ? [yearFact] : [])],
          label: `${taxYear ? `${taxYear} ` : ""}W-2${employerName ? ` · ${employerName}` : ""}`,
          evidenceValue,
          calculationValue,
          // A W-2 is prior-year history while the application holds current
          // monthly earnings. A visible 20% movement needs explanation, but a
          // normal raise should not become a false hard mismatch.
          tolerance: Math.max(100, Math.round(evidenceValue * 0.2 * 100) / 100),
          unmatchedDetail: employerName
            ? "This employer does not tie uniquely to one employment record. Link or correct the employment record before approval."
            : "Confirm the employer name on this W-2 before approval so its wages can be tied to one employment record.",
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
  const eligibleForms = input.forms.filter(form =>
    form.documentType === formType
    && form.businessEntityId === input.businessEntityId
    && !!form.sourceDocumentId
    && verifiedDocumentIds.has(form.sourceDocumentId),
  );
  const usedFormIds = new Set<string>();

  for (const year of yearRows) {
    const requestedTaxYear = numeric(year.taxYear);
    const unusedForms = eligibleForms.filter(form => !usedFormIds.has(form.id));
    const inferredTaxYear = requestedTaxYear ?? Math.max(
      ...unusedForms.map(form => form.taxYear ?? Number.NEGATIVE_INFINITY),
    );
    if (!Number.isFinite(inferredTaxYear)) continue;
    const matchingForms = unusedForms.filter(form => form.taxYear === inferredTaxYear);
    if (matchingForms.length !== 1) continue;
    const form = matchingForms[0];
    usedFormIds.add(form.id);
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
        label: `${form.taxYear ?? "Current"} ${mapping.worksheetField}`,
        evidenceValue,
        calculationValue,
        tolerance: 1,
        unmatchedDetail: "This reviewed tax figure could not be tied to the confirmed self-employment worksheet.",
      }));
    }
  }

  return comparisons.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/**
 * Tie the three figures used by the business-liquidity ratio to the reviewed
 * Schedule L components that produced the smart-fill draft. The worksheet is
 * still borrower-confirmed and editable; an edit becomes a visible variance
 * instead of silently breaking the evidence chain.
 */
export function reconcileBusinessLiquidityEvidence(
  input: BusinessLiquidityReconciliationInput,
): FinancialEvidenceComparison[] {
  const worksheet = input.employment.selfEmploymentIncome;
  const liquidity = worksheet?.k1?.liquidity;
  if (!worksheet || !liquidity) return [];
  const formType = worksheet.businessStructure === "partnership"
    ? "business_tax_return_1065"
    : worksheet.businessStructure === "s_corporation"
      ? "business_tax_return_1120s"
      : null;
  if (!formType) return [];

  const verifiedDocumentIds = new Set(
    input.documents.filter(document => document.status === "verified").map(document => document.id),
  );
  const eligible = input.forms.filter(form =>
    form.documentType === formType
    && form.businessEntityId === input.businessEntityId
    && !!form.sourceDocumentId
    && verifiedDocumentIds.has(form.sourceDocumentId),
  );
  const worksheetTaxYear = numeric(worksheet.k1?.currentYear.taxYear);
  const latestTaxYear = worksheetTaxYear ?? Math.max(
    ...eligible.map(form => form.taxYear ?? Number.NEGATIVE_INFINITY),
  );
  const matching = Number.isFinite(latestTaxYear)
    ? eligible.filter(form => form.taxYear === latestTaxYear)
    : eligible;
  if (matching.length !== 1) return [];

  const form = matching[0];
  const rows = (input.factsByDocument.get(form.sourceDocumentId!) ?? [])
    .filter(row => row.logicalDocumentId === form.id);
  const comparisons: FinancialEvidenceComparison[] = [];
  const addDerived = (
    label: string,
    fieldNames: string[],
    calculationValue: number,
  ) => {
    const facts = fieldNames
      .map(fieldName => fact(rows, fieldName))
      .filter((row): row is ExtractedField => !!row && effectiveNumber(row) !== null);
    if (!facts.length) return;
    const evidenceValue = facts.reduce((sum, row) => sum + effectiveNumber(row)!, 0);
    comparisons.push(comparison({
      kind: "business_liquidity",
      documentId: form.sourceDocumentId!,
      facts,
      label: `${form.taxYear ?? "Current"} Schedule L ${label}`,
      evidenceValue,
      calculationValue,
      tolerance: 1,
      unmatchedDetail: `The reviewed Schedule L ${label.toLowerCase()} could not be tied to the confirmed business-liquidity worksheet.`,
    }));
  };

  addDerived("current assets", [
    "scheduleLCashEndOfYear",
    "scheduleLReceivablesEndOfYear",
    "scheduleLInventoriesEndOfYear",
  ], liquidity.currentAssets);
  addDerived("current liabilities", [
    "scheduleLAccountsPayableEndOfYear",
    "scheduleLShortTermDebtEndOfYear",
    "scheduleLOtherCurrentLiabilitiesEndOfYear",
  ], liquidity.currentLiabilities);
  const inventoryFact = fact(rows, "scheduleLInventoriesEndOfYear");
  const inventoryValue = effectiveNumber(inventoryFact);
  if (inventoryFact && inventoryValue !== null) {
    comparisons.push(comparison({
      kind: "business_liquidity",
      documentId: form.sourceDocumentId!,
      facts: [inventoryFact],
      label: `${form.taxYear ?? "Current"} Schedule L inventory`,
      evidenceValue: inventoryValue,
      calculationValue: liquidity.inventory,
      tolerance: 1,
      unmatchedDetail: "The reviewed Schedule L inventory could not be tied to the confirmed business-liquidity worksheet.",
    }));
  }

  return comparisons.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}
