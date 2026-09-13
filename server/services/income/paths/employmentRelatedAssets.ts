import type { OtherIncomeSource } from "@shared/schema";
import type { DtiIncomePathResult } from "@shared/incomePaths";
import { roundCents } from "@shared/incomePaths";
import { classifyOtherIncomeSource } from "@shared/incomeTypes";

export type EmploymentAssetEvidence = {
  assetId: string;
  documentId: string;
  borrowerSequenceNumber: number;
  statementEndDate: string;
  documentedBalance: number;
  fullDistributionPenaltyAmount: number;
  fundsUsedForTransaction: number;
  netDocumentedAssets: number;
  verifiedFactIds: string[];
};

export type EmploymentRelatedAssetsAnalysisInput = {
  amortizationTermMonths: number;
  loanPurpose: "purchase" | "refinance";
  occupancyType: "primary_residence" | "second_home";
  ltvPercent: number;
  cltvPercent: number;
  hcltvPercent: number;
  maximumLienRatioPercent: number;
  assets: EmploymentAssetEvidence[];
  missingItems: string[];
};

const CITATIONS = [{
  doc: "docs/fannie-mae/employment-related-assets-income-reference.md",
  section: "B3-3.4-06, Employment Related Assets as Qualifying Income",
}];

export function computeEmploymentRelatedAssetsPath(
  otherIncome: OtherIncomeSource[],
  analysis?: EmploymentRelatedAssetsAnalysisInput,
): DtiIncomePathResult {
  const declared = otherIncome.filter(source =>
    classifyOtherIncomeSource(source.incomeSource) === "employment_related_assets",
  );
  if (declared.length === 0) {
    return {
      pathId: "employment_related_assets",
      kind: "dti_income",
      role: "component",
      status: "not_indicated",
      monthlyQualifyingIncome: 0,
      appliedToDti: false,
      citations: CITATIONS,
      requiresManualReview: false,
      notes: [],
    };
  }

  if (!analysis || analysis.missingItems.length > 0 || analysis.assets.length !== declared.length) {
    return {
      pathId: "employment_related_assets",
      kind: "dti_income",
      role: "component",
      status: "unavailable",
      monthlyQualifyingIncome: 0,
      appliedToDti: false,
      citations: CITATIONS,
      requiresManualReview: true,
      unavailableReason: "EMPLOYMENT_RELATED_ASSET_EVIDENCE_INCOMPLETE",
      missingItems: analysis?.missingItems ?? [
        "Link each planned employment-related asset to a current reviewed retirement statement and complete the access, ownership, penalty, and transaction-use details.",
      ],
      notes: ["The borrower-entered monthly amount is excluded; qualifying income is calculated only from net documented assets."],
    };
  }

  const netDocumentedAssets = analysis.assets.reduce(
    (sum, asset) => sum + asset.netDocumentedAssets,
    0,
  );
  const monthlyQualifyingIncome = roundCents(netDocumentedAssets / analysis.amortizationTermMonths);
  return {
    pathId: "employment_related_assets",
    kind: "dti_income",
    role: "component",
    status: "applicable",
    monthlyQualifyingIncome,
    appliedToDti: true,
    citations: CITATIONS,
    requiresManualReview: false,
    notes: [
      `Net documented employment-related assets of ${netDocumentedAssets.toLocaleString("en-US", { style: "currency", currency: "USD" })} were divided by the selected ${analysis.amortizationTermMonths}-month amortization term.`,
      "Each account balance was reduced by its full-distribution penalty and the funds assigned to down payment, closing costs, and required reserves.",
    ],
  };
}
