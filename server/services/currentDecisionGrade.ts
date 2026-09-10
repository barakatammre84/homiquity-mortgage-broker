import type { CreditPull, LoanApplication } from "@shared/schema";
import { isDecisionGrade, type DataProvenance } from "@shared/dataProvenance";

export type CurrentDecisionEvidence = {
  financialMemoId: string | null;
  incomeWorkpaperId: string | null;
  assetWorkpaperId: string | null;
  creditPullId: string | null;
  creditPullIsSimulated: boolean;
  creditPullIsCurrent: boolean;
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
        && evidence.creditPullIsCurrent,
    },
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
    creditPullId: null,
    creditPullIsSimulated: false,
    creditPullIsCurrent: false,
  };
  const needsFinancialEvidence = application.incomeVerified
    || application.assetsVerified
    || isDecisionGrade(application.financialDataProvenance as DataProvenance);
  const needsCreditEvidence = application.creditVerified
    || isDecisionGrade(application.financialDataProvenance as DataProvenance);
  if (!needsFinancialEvidence && !needsCreditEvidence) {
    return assessCurrentDecisionGrade(application, emptyEvidence);
  }

  const [financial, creditPull] = await Promise.all([
    needsFinancialEvidence
      ? import("./financialReview").then(module => module.getCurrentApprovedFinancialVerificationEvidence(application.id))
      : Promise.resolve({ memo: null, incomeWorkpaperId: null, assetWorkpaperId: null }),
    needsCreditEvidence
      ? import("./creditService").then(module => module.getLatestCreditPull(application.id))
      : Promise.resolve(null),
  ]);
  return assessCurrentDecisionGrade(application, {
    financialMemoId: financial.memo?.id ?? null,
    incomeWorkpaperId: financial.incomeWorkpaperId,
    assetWorkpaperId: financial.assetWorkpaperId,
    creditPullId: creditPull?.id ?? null,
    creditPullIsSimulated: creditPull?.isSimulated ?? false,
    creditPullIsCurrent: isCurrentRealCreditPull(creditPull),
  });
}
