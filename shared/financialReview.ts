import { z } from "zod";
import type { IncomeOrchestrationResult } from "./incomePaths";
import type { SubjectPropertyFinancingAssessment } from "./subjectPropertyFinancing";

export const LIABILITY_UNDERWRITING_TREATMENTS = [
  "exclude_short_term_installment",
  "documented_zero_student_loan",
] as const;
export type LiabilityUnderwritingTreatment = typeof LIABILITY_UNDERWRITING_TREATMENTS[number];

export const liabilityTreatmentReviewSchema = z.object({
  treatment: z.enum(LIABILITY_UNDERWRITING_TREATMENTS).nullable(),
  sourceDocumentId: z.string().uuid().nullable(),
  creditPullId: z.string().uuid().nullable(),
  tradelineIndex: z.number().int().min(0).max(500).nullable(),
}).superRefine((value, ctx) => {
  const hasCompleteSupport = value.sourceDocumentId !== null
    && value.creditPullId !== null
    && value.tradelineIndex !== null;
  if (value.treatment !== null && !hasCompleteSupport) {
    ctx.addIssue({ code: "custom", message: "A reviewed treatment needs source evidence and a bureau tradeline." });
  }
  if (value.treatment === null && (
    value.sourceDocumentId !== null
    || value.creditPullId !== null
    || value.tradelineIndex !== null
  )) {
    ctx.addIssue({ code: "custom", message: "Clear the treatment evidence and bureau selection together." });
  }
});

export type LiabilityTreatmentCandidate = {
  liabilityId: string;
  borrowerSequenceNumber: number;
  creditorName: string | null;
  liabilityType: string;
  remainingTermMonths: number | null;
  studentLoanRepaymentPlan: string | null;
  recommendedTreatment: LiabilityUnderwritingTreatment;
  currentTreatment: LiabilityUnderwritingTreatment | null;
  sourceDocumentId: string | null;
  creditPullId: string | null;
  tradelineIndex: number | null;
  evidenceCurrent: boolean;
  bureauLinkCurrent: boolean;
};

export type FinancialSelfEmploymentResult = {
  monthlyQualifyingIncome: number;
  netProfitYear1: number;
  netProfitYear2: number;
  avgAnnualCashFlow: number;
  addBacks: number;
  deductions: number;
  trend: string;
  requiresManualReview: boolean;
  notes: string[];
};

export type FinancialAssetResult = {
  totalAssets: number;
  liquidAssets: number;
  retirementAssets: number;
  reservesMonths: number;
  breakdown: Array<{ type: string; balance: number; haircut: number; verifiedValue: number }>;
};

export type FinancialLiabilityResult = {
  totalMonthlyPayment: number;
  excludedDebts: number;
  openThirtyDayBalance: number;
  breakdown: Array<{ type: string; payment: number; remainingMonths?: number; included: boolean; reason: string }>;
};

export const FINANCIAL_WORKPAPER_KINDS = [
  "income_summary",
  "self_employment",
  "business_liquidity",
  "rental_cash_flow",
  "asset_reconciliation",
  "liability_reconciliation",
] as const;
export type FinancialWorkpaperKind = typeof FINANCIAL_WORKPAPER_KINDS[number];

export const FINANCIAL_WORKPAPER_TITLES: Record<FinancialWorkpaperKind, string> = {
  income_summary: "Household qualifying income",
  self_employment: "Self-employment income",
  business_liquidity: "Business liquidity",
  rental_cash_flow: "Rental cash flow",
  asset_reconciliation: "Assets and available funds",
  liability_reconciliation: "Liability reconciliation",
};

export type FinancialSourceReference = {
  documentId: string;
  documentName: string;
  documentType: string;
  lineageId: string | null;
  versionNumber: number;
  contentFingerprint: string | null;
  status: string;
  subjectType: string | null;
  subjectId: string | null;
  pages: number[];
  verifiedFactIds: string[];
  /** Changes whenever any linked fact is re-reviewed, without exposing private string values. */
  verifiedFactReviewFingerprint?: string;
  /**
   * Human-reviewed numeric facts frozen into the workpaper version. Keeping
   * the effective value here means a correction to an existing fact ID
   * changes the workpaper fingerprint instead of leaving an approved memo
   * current over superseded dollars.
   */
  verifiedFacts?: FinancialVerifiedFact[];
};

export type FinancialVerifiedFact = {
  id: string;
  fieldName: string;
  value: number;
  valueType: "currency" | "number";
  pageNumber: number | null;
};

export type FinancialEvidenceComparison = {
  id: string;
  kind: "income" | "business_liquidity" | "asset" | "rental" | "liability";
  status: "match" | "variance" | "unlinked";
  documentId: string;
  verifiedFactIds: string[];
  label: string;
  evidenceValue: number;
  calculationValue: number | null;
  variance: number | null;
  tolerance: number;
  detail: string;
};

export type FinancialWorkpaperInput = {
  dataVersion: 1 | 2;
  subject: Record<string, unknown>;
  evidenceDocumentIds: string[];
  verifiedFactIds: string[];
  evidenceComparisons?: FinancialEvidenceComparison[];
};

export type BusinessLiquidityOutput = {
  method: "current_ratio" | "quick_ratio" | "unavailable";
  currentAssets: number | null;
  currentLiabilities: number | null;
  inventory: number | null;
  currentRatio: number | null;
  quickRatio: number | null;
  supportsOrdinaryIncome: boolean | null;
  explanation: string;
};

export type FinancialWorkpaperOutput =
  | { kind: "income_summary"; evaluation: IncomeOrchestrationResult; borrowerBreakdown: Array<{ borrowerSequenceNumber: number; monthlyIncome: number }> }
  | { kind: "self_employment"; result: FinancialSelfEmploymentResult; borrowerSequenceNumber: number; businessStructure: string; ownershipPercent: number | null; currentActivity?: {
      documentId: string;
      periodStart: string;
      periodEnd: string;
      periodMonths: number;
      businessNetProfitLoss: number;
      borrowerMonthlyNet: number;
      taxBasedMonthlyIncome: number;
      direction: "higher_or_equal" | "declining";
    } | null }
  | ({ kind: "business_liquidity" } & BusinessLiquidityOutput)
  | { kind: "rental_cash_flow"; result: IncomeOrchestrationResult["paths"][number] }
  | { kind: "asset_reconciliation"; result: FinancialAssetResult; borrowerSequences: number[]; realEstateReserves?: {
      financedPropertiesCount: number | null;
      aggregateReserveUpb: number | null;
      reserveFactor: number | null;
      baseReserveMonths: number;
      baseReserveRequirement: number;
      additionalReserveRequirement: number | null;
      totalReserveRequirement: number | null;
      postClosingLiquidAssets: number;
      openThirtyDayChargeBalance: number;
      combinedPostClosingRequirement: number | null;
    } }
  | {
      kind: "liability_reconciliation";
      result: FinancialLiabilityResult;
      borrowerSequences: number[];
      bureau: {
        pullId: string;
        representativeScore: number;
        borrowerScores: Array<{
          borrowerSequenceNumber: number;
          experianScore: number | null;
          equifaxScore: number | null;
          transunionScore: number | null;
          representativeScore: number;
        }>;
        reportedMonthlyPayments: number;
        adjustedMonthlyDebt: number;
        tradelineCount: number;
        fingerprint: string;
        tradelines: Array<{
          creditor: string;
          type: string;
          balance: number;
          monthlyPayment: number;
          deferred: boolean;
          openedDaysAgo: number | null;
        }>;
      } | null;
      decisionMonthlyPayment: number;
      openThirtyDayBalance: number;
      treatmentCandidates: LiabilityTreatmentCandidate[];
      subjectPropertyFinancing: SubjectPropertyFinancingAssessment;
    };

export type FinancialReviewBlocker = {
  code: "missing_evidence" | "unverified_evidence" | "missing_byte_fingerprint" | "unconfirmed_worksheet" | "missing_dependency" | "stale_version";
  message: string;
};

export type FinancialWorkpaperReviewView = {
  action: "approve" | "reject";
  reason: string;
  reviewedBy: string;
  reviewedAt: string;
};

export type FinancialWorkpaperView = {
  id: string | null;
  key: string;
  kind: FinancialWorkpaperKind;
  title: string;
  subjectId: string;
  subjectLabel: string;
  versionNumber: number;
  inputFingerprint: string;
  input: FinancialWorkpaperInput;
  output: FinancialWorkpaperOutput;
  sources: FinancialSourceReference[];
  dependencyVersionIds: string[];
  createdAt: string;
  isCurrent: boolean;
  blockers: FinancialReviewBlocker[];
  review: FinancialWorkpaperReviewView | null;
};

export type CreditMemoReference = {
  type: "workpaper" | "document" | "verified_fact";
  id: string;
  label: string;
  /** Source document for a page-grounded reference; absent on workpapers and legacy memos. */
  documentId?: string;
  pageNumber?: number;
};

export type CreditMemoSection = {
  key: "transaction" | "income" | "business" | "assets" | "liabilities_reo" | "risks" | "conclusion";
  title: string;
  body: string;
  referenceIds: string[];
};

export type CreditMemoView = {
  id: string;
  versionNumber: number;
  inputFingerprint: string;
  packageHash: string;
  workpaperVersionIds: string[];
  sections: CreditMemoSection[];
  references: CreditMemoReference[];
  createdAt: string;
  isCurrent: boolean;
  blockers: FinancialReviewBlocker[];
  review: FinancialWorkpaperReviewView | null;
};

export type FinancialReviewWorkspace = {
  applicationId: string;
  requiredCount: number;
  currentApprovedCount: number;
  canPrepare: boolean;
  prepareBlockedReason: string | null;
  workpapers: FinancialWorkpaperView[];
  memo: CreditMemoView | null;
  canBuildMemo: boolean;
  memoBlockedReason: string | null;
  bankStatementAnalysis: {
    id: string;
    months: 12 | 24;
    totalEligibleDeposits: number;
    expenseFactor: number | null;
    hasThirdPartyExpenseStatement: boolean;
    notes: string | null;
    createdAt: string;
  } | null;
  bankStatementEvidence: {
    documentCount: number;
    reviewedDepositFactCount: number;
    observedTotalDeposits: number;
    datedStatementCount: number;
    consecutiveMonthCoverage: number;
    periodStart: string | null;
    periodEnd: string | null;
  };
};

export const reviewFinancialArtifactSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(8).max(1000),
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgedComparisonIds: z.array(z.string().min(1).max(1000)).max(100).optional(),
});
