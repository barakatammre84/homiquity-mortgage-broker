import { describe, expect, it } from "vitest";
import type {
  Document,
  ExtractedField,
  LogicalDocument,
  OtherIncomeSource,
  UrlaAsset,
} from "@shared/schema";
import { computeIncomePaths, incomeInputsFingerprint } from "../server/services/income/orchestrator";
import {
  buildCapitalGainsEvidence,
  capitalGainsEvidenceComparisons,
} from "../server/services/income/capitalGainsEvidence";
import { selectIncomeForDecision } from "../server/services/decisionEngine";

function capitalGainsSource(overrides: Partial<OtherIncomeSource> = {}): OtherIncomeSource {
  return {
    id: "capital-source",
    applicationId: "application",
    borrowerSequenceNumber: 1,
    incomeSource: "Capital Gains",
    monthlyAmount: "9000",
    taxTreatment: "taxable",
    nonTaxableMonthlyAmount: null,
    hasDefinedExpiration: false,
    expirationDate: null,
    paidInVirtualCurrency: false,
    createdAt: null,
    ...overrides,
  } as OtherIncomeSource;
}

const completeAnalysis = {
  borrowerSequenceNumber: 1,
  expectedTaxYears: [2025, 2024] as [number, number],
  years: [
    {
      taxYear: 2025,
      annualCapitalGainOrLoss: 120_000,
      form1040DocumentId: "return-2025",
      scheduleDDocumentId: "return-2025",
      verifiedFactId: "gain-2025",
      signatureVerifiedFactId: "signature-2025",
    },
    {
      taxYear: 2024,
      annualCapitalGainOrLoss: 96_000,
      form1040DocumentId: "return-2024",
      scheduleDDocumentId: "return-2024",
      verifiedFactId: "gain-2024",
      signatureVerifiedFactId: "signature-2024",
    },
  ],
  portfolio: {
    documentId: "brokerage",
    assetId: "asset",
    statementEndDate: "2026-08-31",
    currentMarketValue: 250_000,
    verifiedFactIds: ["portfolio-balance", "portfolio-date", "portfolio-last4"],
  },
  missingItems: [],
};

describe("capital-gains income path", () => {
  it("does not count the borrower's typed monthly amount without qualifying evidence", () => {
    const result = computeIncomePaths({
      employment: [],
      otherIncome: [capitalGainsSource()],
      rentalProperties: [],
      fallbackAnnualIncome: 108_000,
    });
    const capital = result.paths.find(path => path.pathId === "capital_gains");

    expect(result.primaryMonthlyQualifyingIncome).toBe(0);
    expect(capital).toMatchObject({
      status: "unavailable",
      monthlyQualifyingIncome: 0,
      appliedToDti: false,
      requiresManualReview: true,
    });
    expect(capital?.missingItems?.join(" ")).toMatch(/two.*tax return|schedule d|portfolio/i);
  });

  it("averages the most recent two years when gains are stable or increasing", () => {
    const result = computeIncomePaths({
      employment: [],
      otherIncome: [capitalGainsSource()],
      rentalProperties: [],
      capitalGainsAnalysis: completeAnalysis,
    });
    const capital = result.paths.find(path => path.pathId === "capital_gains");

    expect(capital).toMatchObject({
      status: "applicable",
      monthlyQualifyingIncome: 9000,
      appliedMonthlyIncome: 9000,
      appliedToDti: true,
      requiresManualReview: false,
    });
    expect(result.primaryBreakdown.capitalGains).toBe(9000);
    expect(result.primaryMonthlyQualifyingIncome).toBe(9000);
  });

  it("uses only the most recent year when gains decrease", () => {
    const result = computeIncomePaths({
      employment: [],
      otherIncome: [capitalGainsSource()],
      rentalProperties: [],
      capitalGainsAnalysis: {
        ...completeAnalysis,
        years: [
          { ...completeAnalysis.years[0], annualCapitalGainOrLoss: 60_000 },
          { ...completeAnalysis.years[1], annualCapitalGainOrLoss: 120_000 },
        ],
      },
    });
    expect(result.paths.find(path => path.pathId === "capital_gains")).toMatchObject({
      monthlyQualifyingIncome: 5000,
    });
  });

  it("ignores capital losses rather than turning them into income or a liability", () => {
    const result = computeIncomePaths({
      employment: [],
      otherIncome: [capitalGainsSource()],
      rentalProperties: [],
      capitalGainsAnalysis: {
        ...completeAnalysis,
        years: [
          { ...completeAnalysis.years[0], annualCapitalGainOrLoss: -24_000 },
          { ...completeAnalysis.years[1], annualCapitalGainOrLoss: 60_000 },
        ],
      },
    });
    expect(result.primaryMonthlyQualifyingIncome).toBe(0);
    expect(result.paths.find(path => path.pathId === "capital_gains")).toMatchObject({
      status: "applicable",
      monthlyQualifyingIncome: 0,
      appliedMonthlyObligation: 0,
    });
  });

  it("keeps evidence and trend changes in the deterministic fingerprint", () => {
    const base = {
      employment: [],
      otherIncome: [capitalGainsSource()],
      rentalProperties: [],
      capitalGainsAnalysis: completeAnalysis,
    };
    expect(incomeInputsFingerprint(base)).not.toBe(incomeInputsFingerprint({
      ...base,
      capitalGainsAnalysis: {
        ...completeAnalysis,
        years: completeAnalysis.years.map((year, index) => index ? year : {
          ...year,
          annualCapitalGainOrLoss: year.annualCapitalGainOrLoss + 1,
        }),
      },
    }));
  });

  it("uses the exact approved workpaper result for a decision-grade file", () => {
    const preliminary = computeIncomePaths({
      employment: [],
      otherIncome: [capitalGainsSource()],
      rentalProperties: [],
    });
    const reviewed = computeIncomePaths({
      employment: [],
      otherIncome: [capitalGainsSource()],
      rentalProperties: [],
      capitalGainsAnalysis: completeAnalysis,
    });

    expect(selectIncomeForDecision(preliminary, false, { result: reviewed }))
      .toBe(preliminary);
    expect(selectIncomeForDecision(preliminary, true, { result: reviewed }))
      .toBe(reviewed);
    expect(selectIncomeForDecision(preliminary, true, { result: reviewed })
      .primaryBreakdown.capitalGains).toBe(9000);
  });
});

function document(id: string, type: string): Document {
  return {
    id,
    applicationId: "application",
    userId: "borrower",
    documentType: type,
    fileName: `${id}.pdf`,
    storagePath: `/objects/${id}`,
    status: "verified",
  } as Document;
}

function form(id: string, type: string, year: number, sourceDocumentId: string): LogicalDocument {
  return {
    id,
    loanId: "application",
    borrowerId: "borrower",
    documentType: type,
    taxYear: year,
    sourceDocumentId,
    aggregatedConfidence: "0.99",
    status: "needs_review",
  } as LogicalDocument;
}

function fact(
  id: string,
  documentId: string,
  fieldName: string,
  value: string | number | boolean,
  logicalDocumentId: string | null = null,
): ExtractedField {
  return {
    id,
    documentId,
    logicalDocumentId,
    fieldName,
    fieldCategory: typeof value === "number" ? "income" : "asset",
    valueType: typeof value === "number" ? "currency" : typeof value === "boolean" ? "boolean" : "string",
    valueNumeric: typeof value === "number" ? String(value) : null,
    valueString: typeof value === "string" ? value : null,
    valueBoolean: typeof value === "boolean" ? value : null,
    humanVerified: true,
    humanCorrectedValue: null,
    confidence: "0.99",
    extractionMethod: "model_vision",
    pageNumber: 1,
  } as ExtractedField;
}

describe("capital-gains evidence assembly", () => {
  const documents = [
    document("return-2025", "tax_return_1040"),
    document("return-2024", "tax_return_1040"),
    document("brokerage", "brokerage_statement"),
  ];
  const forms = [
    form("1040-2025", "tax_return_1040", 2025, "return-2025"),
    form("d-2025", "schedule_d", 2025, "return-2025"),
    form("1040-2024", "tax_return_1040", 2024, "return-2024"),
    form("d-2024", "schedule_d", 2024, "return-2024"),
  ];
  const factsByDocument = new Map<string, ExtractedField[]>([
    ["return-2025", [
      fact("signature-2025", "return-2025", "signatureEvidencePresent", true, "1040-2025"),
      fact("gain-2025", "return-2025", "totalCapitalGainOrLoss", 120_000, "d-2025"),
    ]],
    ["return-2024", [
      fact("signature-2024", "return-2024", "signatureEvidencePresent", true, "1040-2024"),
      fact("gain-2024", "return-2024", "totalCapitalGainOrLoss", 96_000, "d-2024"),
    ]],
    ["brokerage", [
      fact("portfolio-balance", "brokerage", "closing_balance", 250_000),
      fact("portfolio-date", "brokerage", "statement_period_end", "2026-08-31"),
      fact("portfolio-last4", "brokerage", "account_number_last4", "1234"),
    ]],
  ]);
  const assets = [{
    id: "asset",
    applicationId: "application",
    borrowerSequenceNumber: 1,
    accountType: "Brokerage account",
    accountNumberLast4: "1234",
    cashOrMarketValue: "250000",
  }] as UrlaAsset[];

  it("requires the two expected signed-return packets, reviewed Schedule D totals, and a current matched portfolio", () => {
    const result = buildCapitalGainsEvidence({
      documents,
      logicalDocuments: forms,
      factsByDocument,
      assets,
      otherIncome: [capitalGainsSource()],
      expectedNoteDate: "2026-10-15",
    });

    expect(result.missingItems).toEqual([]);
    expect(result.analysis).toMatchObject({
      borrowerSequenceNumber: 1,
      expectedTaxYears: [2025, 2024],
      portfolio: { documentId: "brokerage", assetId: "asset", currentMarketValue: 250_000 },
    });
    expect(capitalGainsEvidenceComparisons(result.analysis)).toEqual([
      expect.objectContaining({ label: "2025 Schedule D capital gain or loss", status: "match" }),
      expect.objectContaining({ label: "2024 Schedule D capital gain or loss", status: "match" }),
    ]);
  });

  it("withholds the path when Schedule D is missing or the portfolio statement is stale", () => {
    const result = buildCapitalGainsEvidence({
      documents,
      logicalDocuments: forms.filter(row => row.id !== "d-2024"),
      factsByDocument: new Map([
        ...factsByDocument,
        ["brokerage", [
          fact("portfolio-balance", "brokerage", "closing_balance", 250_000),
          fact("portfolio-date", "brokerage", "statement_period_end", "2026-05-01"),
          fact("portfolio-last4", "brokerage", "account_number_last4", "1234"),
        ]],
      ]),
      assets,
      otherIncome: [capitalGainsSource()],
      expectedNoteDate: "2026-10-15",
    });

    expect(result.analysis).toBeUndefined();
    expect(result.missingItems.join(" ")).toMatch(/2024.*schedule d/i);
    expect(result.missingItems.join(" ")).toMatch(/four months/i);
  });

  it("accepts the final valid day at a four-month end-of-month boundary", () => {
    const result = buildCapitalGainsEvidence({
      documents,
      logicalDocuments: forms,
      factsByDocument: new Map([
        ...factsByDocument,
        ["brokerage", [
          fact("portfolio-balance", "brokerage", "closing_balance", 250_000),
          fact("portfolio-date", "brokerage", "statement_period_end", "2026-06-30"),
          fact("portfolio-last4", "brokerage", "account_number_last4", "1234"),
        ]],
      ]),
      assets,
      otherIncome: [capitalGainsSource()],
      expectedNoteDate: "2026-10-31",
    });

    expect(result.missingItems).toEqual([]);
    expect(result.analysis?.portfolio.statementEndDate).toBe("2026-06-30");
  });

  it("does not invent borrower attribution when two borrowers declare capital gains", () => {
    const result = buildCapitalGainsEvidence({
      documents,
      logicalDocuments: forms,
      factsByDocument,
      assets,
      otherIncome: [
        capitalGainsSource({ id: "one", borrowerSequenceNumber: 1 }),
        capitalGainsSource({ id: "two", borrowerSequenceNumber: 2 }),
      ],
      expectedNoteDate: "2026-10-15",
    });
    expect(result.analysis).toBeUndefined();
    expect(result.missingItems.join(" ")).toMatch(/one borrower/i);
  });
});
