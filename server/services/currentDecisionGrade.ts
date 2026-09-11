import type { CreditPull, LoanApplication } from "@shared/schema";
import { isDecisionGrade, type DataProvenance } from "@shared/dataProvenance";
import { assessCreditPullDecisionData, type DecisionCreditPicture } from "./decisionCredit";
import { loadExpectedBorrowerSequences } from "./borrowerSequences";

export type CurrentDecisionEvidence = {
  financialMemoId: string | null;
  incomeWorkpaperId: string | null;
  assetWorkpaperId: string | null;
  liabilityWorkpaperId: string | null;
  creditPullId: string | null;
  creditPullIsSimulated: boolean;
  creditPullIsCurrent: boolean;
  creditPullHasProviderReference: boolean;
  creditPullScoreIsUsable: boolean;
  creditPullLiabilitiesAreUsable: boolean;
  creditPullHasOpenLiabilities: boolean;
};

export type CurrentDecisionGrade = {
  isDecisionGrade: boolean;
  reasons: string[];
  evidence: CurrentDecisionEvidence;
  verification: {
    income: boolean;
    assets: boolean;
    credit: boolean;
  };
  /** Server-side facts consumed by the decision engine; routes expose only the verification booleans above. */
  decisionCredit: DecisionCreditPicture | null;
};

export function assessCurrentDecisionGrade(
  application: Pick<LoanApplication, "financialDataProvenance" | "incomeVerified" | "assetsVerified" | "creditVerified">,
  evidence: CurrentDecisionEvidence,
): CurrentDecisionGrade {
  const reasons: string[] = [];
  if (!isDecisionGrade(application.financialDataProvenance as DataProvenance)) reasons.push("Application financial provenance is not verified.");
  if (!application.incomeVerified) reasons.push("Income verification has not been recorded.");
  if (!application.assetsVerified) reasons.push("Asset verification has not been recorded.");
  if (!application.creditVerified) reasons.push("Credit verification has not been recorded.");
  if (!evidence.financialMemoId) reasons.push("The approved financial memo is missing or stale.");
  if (!evidence.incomeWorkpaperId) reasons.push("The approved income workpaper is missing or stale.");
  if (!evidence.assetWorkpaperId) reasons.push("The approved asset workpaper is missing or stale.");
  if (!evidence.creditPullId || evidence.creditPullIsSimulated || !evidence.creditPullIsCurrent) reasons.push("A current real bureau credit report is required.");
  if (evidence.creditPullId && !evidence.creditPullHasProviderReference) reasons.push("The bureau report is missing its provider reference.");
  if (evidence.creditPullId && !evidence.creditPullScoreIsUsable) reasons.push("The bureau report does not contain a valid representative credit score.");
  if (evidence.creditPullId && !evidence.creditPullLiabilitiesAreUsable) reasons.push("The bureau report does not contain a reconciled open-liability ledger.");
  if (evidence.creditPullHasOpenLiabilities && !evidence.liabilityWorkpaperId) reasons.push("The bureau liabilities have not been approved in the current financial workpaper and credit memo.");
  return {
    isDecisionGrade: reasons.length === 0,
    reasons,
    evidence,
    verification: {
      income: application.incomeVerified === true && !!evidence.financialMemoId && !!evidence.incomeWorkpaperId,
      assets: application.assetsVerified === true && !!evidence.financialMemoId && !!evidence.assetWorkpaperId,
      credit: application.creditVerified === true
        && !!evidence.creditPullId
        && !evidence.creditPullIsSimulated
        && evidence.creditPullIsCurrent
        && evidence.creditPullHasProviderReference
        && evidence.creditPullScoreIsUsable
        && evidence.creditPullLiabilitiesAreUsable
        && (!evidence.creditPullHasOpenLiabilities || !!evidence.liabilityWorkpaperId),
    },
    decisionCredit: null,
  };
}

/** A completed report stops being decision evidence when it expires or is archived. */
export function isCurrentRealCreditPull(
  creditPull: Pick<CreditPull, "id" | "status" | "isSimulated" | "expiresAt" | "archivedAt"> | null,
  asOf = new Date(),
) {
  if (!creditPull || creditPull.status !== "completed" || creditPull.isSimulated || creditPull.archivedAt) return false;
  if (!creditPull.expiresAt) return false;
  return new Date(creditPull.expiresAt).getTime() > asOf.getTime();
}

/** Re-resolve every proof behind VERIFIED instead of trusting sticky flags. */
export async function getCurrentDecisionGrade(application: LoanApplication): Promise<CurrentDecisionGrade> {
  const emptyEvidence: CurrentDecisionEvidence = {
    financialMemoId: null,
    incomeWorkpaperId: null,
    assetWorkpaperId: null,
    liabilityWorkpaperId: null,
    creditPullId: null,
    creditPullIsSimulated: false,
    creditPullIsCurrent: false,
    creditPullHasProviderReference: false,
    creditPullScoreIsUsable: false,
    creditPullLiabilitiesAreUsable: false,
    creditPullHasOpenLiabilities: false,
  };
  const needsFinancialEvidence = application.incomeVerified
    || application.assetsVerified
    || isDecisionGrade(application.financialDataProvenance as DataProvenance);
  const needsCreditEvidence = application.creditVerified
    || isDecisionGrade(application.financialDataProvenance as DataProvenance);
  if (!needsFinancialEvidence && !needsCreditEvidence) {
    return assessCurrentDecisionGrade(application, emptyEvidence);
  }

  const [financial, creditPull, expectedBorrowerSequenceNumbers] = await Promise.all([
    needsFinancialEvidence
      ? import("./financialReview").then(module => module.getCurrentApprovedFinancialVerificationEvidence(application.id))
      : Promise.resolve({ memo: null, incomeWorkpaperId: null, assetWorkpaperId: null, liabilityWorkpaperId: null }),
    needsCreditEvidence
      ? import("./creditService").then(module => module.getLatestCreditPull(application.id))
      : Promise.resolve(null),
    needsCreditEvidence ? loadExpectedBorrowerSequences(application.id) : Promise.resolve([1]),
  ]);
  const creditAssessment = assessCreditPullDecisionData(creditPull, expectedBorrowerSequenceNumbers);
  const result = assessCurrentDecisionGrade(application, {
    financialMemoId: financial.memo?.id ?? null,
    incomeWorkpaperId: financial.incomeWorkpaperId,
    assetWorkpaperId: financial.assetWorkpaperId,
    liabilityWorkpaperId: financial.liabilityWorkpaperId,
    creditPullId: creditPull?.id ?? null,
    creditPullIsSimulated: creditPull?.isSimulated ?? false,
    creditPullIsCurrent: isCurrentRealCreditPull(creditPull),
    creditPullHasProviderReference: creditAssessment.hasProviderReference,
    creditPullScoreIsUsable: creditAssessment.scoreIsUsable,
    creditPullLiabilitiesAreUsable: creditAssessment.liabilitiesAreUsable,
    creditPullHasOpenLiabilities: (creditAssessment.picture?.tradelines.length ?? 0) > 0,
  });
  const scoreCoverageReasons = creditAssessment.reasons.filter(reason => /borrower \d/i.test(reason));
  return {
    ...result,
    reasons: [...new Set([...result.reasons, ...scoreCoverageReasons])],
    decisionCredit: creditAssessment.picture,
  };
}
