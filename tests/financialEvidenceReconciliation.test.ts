import { describe, expect, it } from "vitest";
import {
  financialSourceReviewBlockers,
  reconcileBusinessLiquidityEvidence,
  reconcileFinancialEvidence,
  reconcileSelfEmploymentEvidence,
} from "../server/services/financialEvidenceReconciliation";
import type { FinancialSourceReference } from "../shared/financialReview";
import type { Document, EmploymentHistory, ExtractedField, LogicalDocument, RentalPropertyEntry, UrlaAsset } from "../shared/schema";

function document(id: string, documentType: string): Document {
  return { id, documentType, status: "verified" } as Document;
}

function field(id: string, documentId: string, fieldName: string, value: string | number): ExtractedField {
  return {
    id,
    documentId,
    fieldName,
    valueType: typeof value === "number" ? "currency" : "string",
    valueNumeric: typeof value === "number" ? String(value) : null,
    valueString: typeof value === "string" ? value : null,
    humanVerified: true,
  } as ExtractedField;
}

describe("financial evidence reconciliation", () => {
  it("does not treat document acceptance as review of the calculation's dollars", () => {
    const acceptedWithoutReviewedDollars = {
      documentId: "pay",
      documentName: "pay.pdf",
      documentType: "pay_stub",
      lineageId: "lineage-pay",
      versionNumber: 1,
      contentFingerprint: "a".repeat(64),
      status: "verified",
      subjectType: "borrower",
      subjectId: "borrower-1",
      pages: [1],
      verifiedFactIds: [],
      verifiedFacts: [],
    } satisfies FinancialSourceReference;

    expect(financialSourceReviewBlockers([acceptedWithoutReviewedDollars], 1)).toContainEqual(
      expect.objectContaining({
        code: "unverified_evidence",
        message: expect.stringMatching(/numeric source field/i),
      }),
    );
    expect(financialSourceReviewBlockers([{
      ...acceptedWithoutReviewedDollars,
      verifiedFactIds: ["fact-1"],
      verifiedFacts: [{ id: "fact-1", fieldName: "monthly_income_ytd_avg", value: 6000, valueType: "currency", pageNumber: 1 }],
    }], 1)).toEqual([]);

    expect(financialSourceReviewBlockers([
      {
        ...acceptedWithoutReviewedDollars,
        verifiedFactIds: ["fact-1"],
        verifiedFacts: [{ id: "fact-1", fieldName: "monthly_income_ytd_avg", value: 6000, valueType: "currency", pageNumber: 1 }],
      },
      { ...acceptedWithoutReviewedDollars, documentId: "w2", documentName: "w2.pdf" },
    ], 2)).toContainEqual(expect.objectContaining({
      code: "unverified_evidence",
      message: expect.stringContaining("1 remaining"),
    }));
  });

  it("ties reviewed pay, W-2, bank, and lease facts to the values used by the engine", () => {
    const factsByDocument = new Map<string, ExtractedField[]>([
      ["pay", [field("pay-amount", "pay", "monthly_income_ytd_avg", 6000), field("pay-employer", "pay", "employer_name", "Fictional Hospital")]],
      ["w2", [field("w2-amount", "w2", "w2_box_1_wages", 72000), field("w2-employer", "w2", "employer_name", "Fictional Hospital"), field("w2-year", "w2", "tax_year", "2025")]],
      ["bank", [field("bank-amount", "bank", "closing_balance", 90000), field("bank-account", "bank", "account_number_last4", "1234")]],
      ["brokerage", [field("brokerage-amount", "brokerage", "closing_balance", 250000), field("brokerage-account", "brokerage", "account_number_last4", "5678")]],
      ["lease", [field("lease-amount", "lease", "monthly_rent", 3000), field("lease-address", "lease", "property_address", "10 Rental Way")]],
    ]);
    const result = reconcileFinancialEvidence({
      documents: [document("pay", "paystub"), document("w2", "w2"), document("bank", "bank_statement_checking"), document("brokerage", "brokerage_statement"), document("lease", "lease_agreement")],
      factsByDocument,
      employment: [{ employerName: "Fictional Hospital", isSelfEmployed: false, baseIncome: "6000" } as EmploymentHistory],
      assets: [
        { accountNumberLast4: "1234", cashOrMarketValue: "90000" } as UrlaAsset,
        { accountNumberLast4: "5678", cashOrMarketValue: "250000" } as UrlaAsset,
      ],
      rentalProperties: [{ address: "10 Rental Way", monthlyRentalIncome: "3000" } as RentalPropertyEntry],
    });

    expect(result).toHaveLength(5);
    expect(result.every(item => item.status === "match")).toBe(true);
    expect(result.map(item => item.kind)).toEqual(["asset", "asset", "income", "income", "rental"]);
    expect(result.find(item => item.label.includes("Brokerage"))).toMatchObject({
      status: "match",
      evidenceValue: 250000,
      calculationValue: 250000,
    });
    expect(result.find(item => item.label.includes("W-2"))).toMatchObject({
      evidenceValue: 72000,
      calculationValue: 72000,
      tolerance: 14400,
    });
  });

  it("surfaces variances and ambiguous links without changing calculation inputs", () => {
    const result = reconcileFinancialEvidence({
      documents: [document("pay", "pay_stub"), document("bank", "bank_statement")],
      factsByDocument: new Map([
        ["pay", [field("pay-amount", "pay", "monthly_income_ytd_avg", 6500), field("pay-employer", "pay", "employer_name", "Fictional Hospital")]],
        ["bank", [field("bank-amount", "bank", "closing_balance", 91000)]],
      ]),
      employment: [{ employerName: "Fictional Hospital", isSelfEmployed: false, baseIncome: "6000" } as EmploymentHistory],
      assets: [{ accountNumberLast4: "1234", cashOrMarketValue: "90000" } as UrlaAsset],
      rentalProperties: [],
    });

    expect(result.find(item => item.kind === "income")).toMatchObject({ status: "variance", evidenceValue: 6500, calculationValue: 6000, variance: 500 });
    expect(result.find(item => item.kind === "asset")).toMatchObject({ status: "unlinked", evidenceValue: 91000, calculationValue: null });
  });

  it("reconciles a page-classified pay statement inside a generic mixed packet", () => {
    const amount = {
      ...field("pay-amount", "packet", "monthly_income_ytd_avg", 6000),
      documentId: null,
      logicalDocumentId: "logical-pay",
    } as ExtractedField;
    const employer = {
      ...field("pay-employer", "packet", "employer_name", "Fictional Hospital"),
      documentId: null,
      logicalDocumentId: "logical-pay",
    } as ExtractedField;
    const result = reconcileFinancialEvidence({
      documents: [document("packet", "other")],
      logicalDocuments: [{ id: "logical-pay", sourceDocumentId: "packet", documentType: "paystub" } as LogicalDocument],
      factsByDocument: new Map([["packet", [amount, employer]]]),
      employment: [{ employerName: "Fictional Hospital", isSelfEmployed: false, baseIncome: "6000" } as EmploymentHistory],
      assets: [],
      rentalProperties: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "income", status: "match", calculationValue: 6000 });
  });

  it("ties reviewed Schedule C facts to the confirmed Form 1084 worksheet", () => {
    const taxDocument = document("tax", "tax_return");
    const taxFact = {
      ...field("tax-net", "tax", "netProfitOrLoss", 42000),
      logicalDocumentId: "schedule-c",
    } as ExtractedField;
    const employment = {
      selfEmploymentIncome: {
        version: 1,
        businessStructure: "sole_proprietorship",
        confirmedByBorrowerAt: "2026-09-10T00:00:00.000Z",
        scheduleC: {
          currentYear: {
            taxYear: 2025,
            netProfitOrLoss: 40000,
            depreciation: 0,
            depletion: 0,
            amortizationOrCasualtyLoss: 0,
            businessUseOfHome: 0,
            mealsExclusion: 0,
            nonRecurringIncome: 0,
          },
        },
      },
    } as EmploymentHistory;
    const result = reconcileSelfEmploymentEvidence({
      documents: [taxDocument],
      forms: [{ id: "schedule-c", documentType: "schedule_c", businessEntityId: "business", taxYear: 2025, sourceDocumentId: "tax" } as LogicalDocument],
      factsByDocument: new Map([["tax", [taxFact]]]),
      employment,
      businessEntityId: "business",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ status: "variance", evidenceValue: 42000, calculationValue: 40000, variance: 2000 });
  });

  it("ties the business-liquidity ratio inputs to reviewed Schedule L components", () => {
    const facts = [
      ["cash", "scheduleLCashEndOfYear", 100000],
      ["receivables", "scheduleLReceivablesEndOfYear", 10000],
      ["inventory", "scheduleLInventoriesEndOfYear", 10000],
      ["payables", "scheduleLAccountsPayableEndOfYear", 30000],
      ["short-debt", "scheduleLShortTermDebtEndOfYear", 10000],
      ["other-current", "scheduleLOtherCurrentLiabilitiesEndOfYear", 10000],
    ].map(([id, name, value]) => ({
      ...field(String(id), "tax", String(name), Number(value)),
      logicalDocumentId: "1120s",
    } as ExtractedField));
    const employment = {
      selfEmploymentIncome: {
        version: 1,
        businessStructure: "s_corporation",
        confirmedByBorrowerAt: "2026-09-10T00:00:00.000Z",
        k1: {
          currentYear: { taxYear: 2025 },
          liquidity: { currentAssets: 120000, currentLiabilities: 50000, inventory: 10000 },
        },
      },
    } as EmploymentHistory;
    const result = reconcileBusinessLiquidityEvidence({
      documents: [document("tax", "tax_return")],
      forms: [{
        id: "1120s",
        documentType: "business_tax_return_1120s",
        businessEntityId: "business",
        taxYear: 2025,
        sourceDocumentId: "tax",
      } as LogicalDocument],
      factsByDocument: new Map([["tax", facts]]),
      employment,
      businessEntityId: "business",
    });

    expect(result).toHaveLength(3);
    expect(result.every(item => item.status === "match")).toBe(true);
    expect(result.map(item => item.evidenceValue).sort((a, b) => a - b)).toEqual([10000, 50000, 120000]);

    employment.selfEmploymentIncome!.k1!.liquidity!.currentLiabilities = 45000;
    expect(reconcileBusinessLiquidityEvidence({
      documents: [document("tax", "tax_return")],
      forms: [{ id: "1120s", documentType: "business_tax_return_1120s", businessEntityId: "business", taxYear: 2025, sourceDocumentId: "tax" } as LogicalDocument],
      factsByDocument: new Map([["tax", facts]]),
      employment,
      businessEntityId: "business",
    })).toContainEqual(expect.objectContaining({
      label: "2025 Schedule L current liabilities",
      status: "variance",
      evidenceValue: 50000,
      calculationValue: 45000,
    }));
  });
});
