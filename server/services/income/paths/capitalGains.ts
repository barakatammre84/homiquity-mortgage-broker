import type { OtherIncomeSource } from "@shared/schema";
import type { DtiIncomePathResult } from "@shared/incomePaths";
import { roundCents } from "@shared/incomePaths";
import { classifyOtherIncomeSource } from "@shared/incomeTypes";

export type CapitalGainsYearEvidence = {
  taxYear: number;
  annualCapitalGainOrLoss: number;
  form1040DocumentId: string;
  scheduleDDocumentId: string;
  verifiedFactId: string;
  signatureVerifiedFactId: string;
};

export type CapitalGainsPortfolioEvidence = {
  documentId: string;
  assetId: string;
  statementEndDate: string;
  currentMarketValue: number;
  verifiedFactIds: string[];
};

/**
 * Evidence assembled from current, accepted documents and human-reviewed
 * fields. The path never reads the borrower's declared monthly amount.
 */
export type CapitalGainsAnalysisInput = {
  borrowerSequenceNumber: number;
  expectedTaxYears: [number, number];
  years: CapitalGainsYearEvidence[];
  portfolio: CapitalGainsPortfolioEvidence;
  missingItems: string[];
};

export type CapitalGainsComputation = {
  path: DtiIncomePathResult;
  borrowerSequenceNumber: number | null;
};

const CITATIONS = [
  {
    doc: "docs/fannie-mae/capital-gains-income-reference.md",
    section: "B3-3.4-05, Capital Gains Income",
  },
  {
    doc: "docs/fannie-mae/capital-gains-income-reference.md",
    section: "B1-1-03, Allowable Age of Credit Documents and Federal Income Tax Returns",
  },
];

const DEFAULT_MISSING_ITEMS = [
  "Add the most recent two signed personal federal income tax returns, including Form 1040 and Schedule D for each year, and review each Schedule D total.",
  "Add and review a current brokerage statement tied to the borrower's investment asset as evidence of a portfolio that can be sold.",
];

export function computeCapitalGainsPath(
  otherIncome: OtherIncomeSource[],
  analysis?: CapitalGainsAnalysisInput,
): CapitalGainsComputation {
  const declared = otherIncome.filter(source =>
    classifyOtherIncomeSource(source.incomeSource) === "capital_gains",
  );
  if (declared.length === 0) {
    return {
      borrowerSequenceNumber: null,
      path: {
        pathId: "capital_gains",
        kind: "dti_income",
        role: "component",
        status: "not_indicated",
        monthlyQualifyingIncome: 0,
        appliedToDti: false,
        citations: CITATIONS,
        requiresManualReview: false,
        notes: [],
      },
    };
  }

  const borrowerSequenceNumber = declared.length === 1
    ? declared[0].borrowerSequenceNumber ?? 1
    : null;
  const missingItems = [
    ...(declared.length === 1
      ? []
      : ["Keep capital gains under one borrower so the tax-return income is not counted twice."]),
    ...(analysis?.missingItems ?? DEFAULT_MISSING_ITEMS),
  ];
  const expectedYears = analysis?.expectedTaxYears ?? [];
  const evidenceYears = analysis?.years ?? [];
  const completeYears = expectedYears.length === 2
    && evidenceYears.length === 2
    && expectedYears.every(expected => evidenceYears.some(year => year.taxYear === expected));
  const complete = !!analysis
    && borrowerSequenceNumber !== null
    && analysis.borrowerSequenceNumber === borrowerSequenceNumber
    && completeYears
    && analysis.portfolio.currentMarketValue > 0
    && missingItems.length === 0;

  if (!complete) {
    return {
      borrowerSequenceNumber,
      path: {
        pathId: "capital_gains",
        kind: "dti_income",
        role: "component",
        status: "unavailable",
        monthlyQualifyingIncome: 0,
        appliedToDti: false,
        citations: CITATIONS,
        requiresManualReview: true,
        unavailableReason: "CAPITAL_GAINS_EVIDENCE_INCOMPLETE",
        missingItems: [...new Set(missingItems)],
        notes: [
          "The borrower-reported monthly amount is excluded. Capital gains qualify only from the reviewed two-year Schedule D history and current portfolio evidence.",
        ],
      },
    };
  }

  const [recentYear, priorYear] = [...analysis.years]
    .sort((a, b) => b.taxYear - a.taxYear);
  // B3-3.4-05 explicitly permits capital losses to be ignored for both income
  // and liabilities. Floor each annual amount at zero before applying trend.
  const recentGain = Math.max(recentYear.annualCapitalGainOrLoss, 0);
  const priorGain = Math.max(priorYear.annualCapitalGainOrLoss, 0);
  const stableOrIncreasing = recentYear.annualCapitalGainOrLoss >= priorYear.annualCapitalGainOrLoss;
  const annualQualifyingIncome = stableOrIncreasing
    ? (recentGain + priorGain) / 2
    : recentGain;
  const monthly = roundCents(annualQualifyingIncome / 12);

  return {
    borrowerSequenceNumber,
    path: {
      pathId: "capital_gains",
      kind: "dti_income",
      role: "component",
      status: "applicable",
      monthlyQualifyingIncome: monthly,
      appliedToDti: true,
      citations: CITATIONS,
      requiresManualReview: false,
      notes: [
        stableOrIncreasing
          ? `Stable or increasing capital gains: averaged tax years ${priorYear.taxYear} and ${recentYear.taxYear}.`
          : `Decreasing capital gains: used tax year ${recentYear.taxYear} only.`,
        ...(recentYear.annualCapitalGainOrLoss < 0 || priorYear.annualCapitalGainOrLoss < 0
          ? ["Capital loss amounts were excluded from both income and liabilities."]
          : []),
        "Current portfolio ownership is supported by a reviewed brokerage statement.",
      ],
    },
  };
}
