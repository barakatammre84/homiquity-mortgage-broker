import { describe, expect, it } from "vitest";
import type { Document, ExtractedField, LoanApplication, OtherIncomeSource, UrlaAsset } from "../shared/schema";
import { computeIncomePaths, incomeInputsFingerprint } from "../server/services/income/orchestrator";
import { computeEmploymentRelatedAssetsPath } from "../server/services/income/paths/employmentRelatedAssets";
import {
  buildEmploymentRelatedAssetsEvidence,
  employmentRelatedAssetsEvidenceComparisons,
} from "../server/services/income/employmentRelatedAssetsEvidence";

const source = (over: Partial<OtherIncomeSource> = {}) => ({
  id: "income-source",
  applicationId: "application",
  borrowerSequenceNumber: 1,
  incomeSource: "Employment-Related Assets as Income",
  monthlyAmount: "99999",
  taxTreatment: "taxable",
  nonTaxableMonthlyAmount: null,
  hasDefinedExpiration: false,
  expirationDate: null,
  paidInVirtualCurrency: false,
  linkedAssetAccountLast4: "4321",
  assetOwnershipType: "individual",
  hasUnrestrictedAccess: true,
  fullDistributionPenaltyAmount: "50000",
  fundsUsedForTransaction: "100000",
  createdAt: null,
  ...over,
}) as OtherIncomeSource;

const document = (over: Partial<Document> = {}) => ({
  id: "retirement-document",
  applicationId: "application",
  userId: "borrower",
  documentType: "retirement_statement",
  fileName: "retirement.pdf",
  storagePath: "/objects/retirement",
  status: "verified",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  ...over,
}) as Document;

const asset = (over: Partial<UrlaAsset> = {}) => ({
  id: "retirement-asset",
  applicationId: "application",
  borrowerSequenceNumber: 1,
  accountType: "Retirement (e.g., 401k, IRA)",
  financialInstitution: "Fictional Retirement",
  accountNumberLast4: "4321",
  cashOrMarketValue: "500000",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  ...over,
}) as UrlaAsset;

const fact = (id: string, fieldName: string, value: string | number) => ({
  id,
  documentId: "retirement-document",
  logicalDocumentId: null,
  pageId: null,
  pageNumber: 1,
  fieldName,
  fieldCategory: "asset",
  valueType: typeof value === "number" ? "currency" : "string",
  valueNumeric: typeof value === "number" ? String(value) : null,
  valueString: typeof value === "string" ? value : null,
  valueBoolean: null,
  humanVerified: true,
  humanCorrectedValue: null,
  confidence: "0.99",
  extractionMethod: "fixture",
}) as ExtractedField;

function evidenceInput(over: Partial<Parameters<typeof buildEmploymentRelatedAssetsEvidence>[0]> = {}) {
  return {
    application: {
      id: "application",
      closingDate: "2026-10-31",
      loanPurpose: "purchase",
      loanTermMonths: 360,
      occupancyType: "primary_residence",
      purchasePrice: "500000",
      propertyValue: "500000",
      downPayment: "150000",
    } as LoanApplication,
    documents: [document()],
    factsByDocument: new Map([["retirement-document", [
      fact("balance", "closing_balance", 500000),
      fact("date", "statement_period_end", "2026-06-30"),
      fact("last4", "account_number_last4", "4321"),
    ]]]),
    assets: [asset()],
    otherIncome: [source()],
    personalInfo: [{ borrowerSequenceNumber: 1, dateOfBirth: "1970-01-01" }],
    propertyInfo: {
      subordinateFinancingExists: false,
      closedEndSubordinateBalance: "0",
      helocDrawnBalance: "0",
      helocCreditLimit: "0",
    },
    ...over,
  };
}

describe("employment-related assets income", () => {
  it("never counts the borrower-entered monthly amount without complete reviewed evidence", () => {
    const result = computeIncomePaths({
      employment: [],
      otherIncome: [source()],
      rentalProperties: [],
      fallbackAnnualIncome: null,
    });
    const path = result.paths.find(item => item.pathId === "employment_related_assets");
    expect(path).toMatchObject({ status: "unavailable", monthlyQualifyingIncome: 0, appliedToDti: false });
    expect(result.primaryMonthlyQualifyingIncome).toBe(0);
  });

  it("subtracts full-distribution penalties and transaction funds before amortizing over the selected term", () => {
    const evidence = buildEmploymentRelatedAssetsEvidence(evidenceInput());
    expect(evidence.missingItems).toEqual([]);
    const path = computeEmploymentRelatedAssetsPath([source()], evidence.analysis);
    expect(path).toMatchObject({
      status: "applicable",
      monthlyQualifyingIncome: 972.22,
      appliedToDti: true,
      requiresManualReview: false,
    });
    expect(evidence.analysis?.assets[0].netDocumentedAssets).toBe(350000);
    expect(employmentRelatedAssetsEvidenceComparisons(evidence.analysis)).toHaveLength(1);
  });

  it("uses a shorter selected loan term instead of silently fixing the calculation at 30 years", () => {
    const evidence = buildEmploymentRelatedAssetsEvidence(evidenceInput({
      application: { ...evidenceInput().application, loanTermMonths: 180 } as LoanApplication,
    }));
    const path = computeEmploymentRelatedAssetsPath([source()], evidence.analysis);
    expect(path.monthlyQualifyingIncome).toBe(1944.44);
    expect(path.notes.join(" ")).toMatch(/180-month amortization term/i);
  });

  it("enforces the 70% LTV limit under age 62 and permits 80% at age 62", () => {
    const under62 = buildEmploymentRelatedAssetsEvidence(evidenceInput({
      application: { ...evidenceInput().application, downPayment: "100000" } as LoanApplication,
      personalInfo: [{ borrowerSequenceNumber: 1, dateOfBirth: "1965-11-01" }],
    }));
    expect(under62.analysis).toBeUndefined();
    expect(under62.missingItems.join(" ")).toMatch(/maximum LTV\/CLTV\/HCLTV ratio of 80\.00% exceeds the 70% limit/i);

    const age62 = buildEmploymentRelatedAssetsEvidence(evidenceInput({
      application: { ...evidenceInput().application, downPayment: "100000" } as LoanApplication,
      personalInfo: [{ borrowerSequenceNumber: 1, dateOfBirth: "1964-10-31" }],
    }));
    expect(age62.missingItems).toEqual([]);
    expect(age62.analysis?.ltvPercent).toBe(80);
  });

  it("uses the highest LTV, CLTV, or HCLTV ratio when subordinate financing exists", () => {
    const result = buildEmploymentRelatedAssetsEvidence(evidenceInput({
      propertyInfo: {
        subordinateFinancingExists: true,
        closedEndSubordinateBalance: "10000",
        helocDrawnBalance: "5000",
        helocCreditLimit: "15000",
      },
    }));
    expect(result.analysis).toBeUndefined();
    expect(result.missingItems.join(" ")).toMatch(/maximum LTV\/CLTV\/HCLTV ratio of 75\.00% exceeds the 70% limit/i);
  });

  it("blocks cash-out, investment properties, restricted access, stale statements, and duplicate assets", () => {
    const result = buildEmploymentRelatedAssetsEvidence(evidenceInput({
      application: {
        ...evidenceInput().application,
        loanPurpose: "cash_out",
        occupancyType: "investment",
      } as LoanApplication,
      documents: [document()],
      factsByDocument: new Map([["retirement-document", [
        fact("balance", "closing_balance", 500000),
        fact("date", "statement_period_end", "2026-06-29"),
        fact("last4", "account_number_last4", "4321"),
      ]]]),
      otherIncome: [source({ hasUnrestrictedAccess: false }), source({ id: "duplicate" })],
    }));
    expect(result.analysis).toBeUndefined();
    expect(result.missingItems.join(" ")).toMatch(/purchase or limited cash-out refinance/i);
    expect(result.missingItems.join(" ")).toMatch(/principal residence or second home/i);
    expect(result.missingItems.join(" ")).toMatch(/unqualified and unlimited right/i);
    expect(result.missingItems.join(" ")).toMatch(/same retirement account cannot be counted twice/i);
    expect(result.missingItems.join(" ")).toMatch(/current 401\(k\) or IRA statement/i);
  });

  it("includes reviewed asset evidence and deductions in the deterministic fingerprint", () => {
    const first = buildEmploymentRelatedAssetsEvidence(evidenceInput()).analysis!;
    const second = {
      ...first,
      assets: first.assets.map(item => ({ ...item, fundsUsedForTransaction: 110000, netDocumentedAssets: 340000 })),
    };
    const base = { employment: [], otherIncome: [source()], rentalProperties: [], fallbackAnnualIncome: null };
    expect(incomeInputsFingerprint({ ...base, employmentRelatedAssetsAnalysis: first }))
      .not.toBe(incomeInputsFingerprint({ ...base, employmentRelatedAssetsAnalysis: second }));
  });
});
