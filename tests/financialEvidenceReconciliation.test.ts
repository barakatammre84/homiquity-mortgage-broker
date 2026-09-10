import { describe, expect, it } from "vitest";
import { reconcileFinancialEvidence, reconcileSelfEmploymentEvidence } from "../server/services/financialEvidenceReconciliation";
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
  it("ties reviewed pay, bank, and lease facts to the values used by the engine", () => {
    const factsByDocument = new Map<string, ExtractedField[]>([
      ["pay", [field("pay-amount", "pay", "monthly_income_ytd_avg", 6000), field("pay-employer", "pay", "employer_name", "Fictional Hospital")]],
      ["bank", [field("bank-amount", "bank", "closing_balance", 90000), field("bank-account", "bank", "account_number_last4", "1234")]],
      ["lease", [field("lease-amount", "lease", "monthly_rent", 3000), field("lease-address", "lease", "property_address", "10 Rental Way")]],
    ]);
    const result = reconcileFinancialEvidence({
      documents: [document("pay", "paystub"), document("bank", "bank_statement_checking"), document("lease", "lease_agreement")],
      factsByDocument,
      employment: [{ employerName: "Fictional Hospital", isSelfEmployed: false, baseIncome: "6000" } as EmploymentHistory],
      assets: [{ accountNumberLast4: "1234", cashOrMarketValue: "90000" } as UrlaAsset],
      rentalProperties: [{ address: "10 Rental Way", monthlyRentalIncome: "3000" } as RentalPropertyEntry],
    });

    expect(result).toHaveLength(3);
    expect(result.every(item => item.status === "match")).toBe(true);
    expect(result.map(item => item.kind)).toEqual(["asset", "income", "rental"]);
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
});
