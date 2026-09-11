import type { UrlaLiability } from "@shared/schema";
import {
  LIABILITY_UNDERWRITING_TREATMENTS,
  type LiabilityUnderwritingTreatment,
} from "@shared/financialReview";
import { liabilityKind } from "@shared/liabilityTypes";
import type { DecisionCreditPicture } from "./decisionCredit";
import { qualifyingTradelinePayment } from "./underwritingNuance";

function amount(value: string | number | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function recommendedLiabilityTreatment(
  liability: UrlaLiability,
): LiabilityUnderwritingTreatment | null {
  const kind = liabilityKind(liability.liabilityType);
  if (
    kind === "installment"
    && liability.remainingTermMonths !== null
    && liability.remainingTermMonths !== undefined
    && liability.remainingTermMonths >= 1
    && liability.remainingTermMonths <= 10
  ) return "exclude_short_term_installment";
  if (
    kind === "student_loan"
    && amount(liability.monthlyPayment) === 0
    && amount(liability.unpaidBalance) > 0
    && liability.studentLoanRepaymentPlan === "income_driven"
  ) return "documented_zero_student_loan";
  return null;
}

export function storedLiabilityTreatment(
  liability: UrlaLiability,
): LiabilityUnderwritingTreatment | null {
  return LIABILITY_UNDERWRITING_TREATMENTS.includes(
    liability.underwritingTreatment as LiabilityUnderwritingTreatment,
  ) ? liability.underwritingTreatment as LiabilityUnderwritingTreatment : null;
}

export function liabilityTreatmentLinkIsCurrent(
  liability: UrlaLiability,
  credit: DecisionCreditPicture | null,
  currentVerifiedDocumentIds: ReadonlySet<string>,
): boolean {
  const treatment = storedLiabilityTreatment(liability);
  if (!treatment || recommendedLiabilityTreatment(liability) !== treatment) return false;
  if (
    !liability.treatmentSourceDocumentId
    || !currentVerifiedDocumentIds.has(liability.treatmentSourceDocumentId)
    || !credit
    || liability.treatmentCreditPullId !== credit.pullId
    || liability.treatmentTradelineIndex === null
    || liability.treatmentTradelineIndex === undefined
  ) return false;
  const tradeline = credit.tradelines[liability.treatmentTradelineIndex];
  if (!tradeline) return false;
  const bureauKind = liabilityKind(tradeline.type);
  return treatment === "documented_zero_student_loan"
    ? bureauKind === "student_loan"
    : bureauKind === "installment";
}

/** Remove stale/invalid staff exceptions before the common liability engine
 * sees them. This makes replacement evidence or a new bureau report fail back
 * to the conservative payment without erasing the historical review fields. */
export function liabilitiesWithCurrentReviewedTreatments(
  liabilities: UrlaLiability[],
  credit: DecisionCreditPicture | null,
  currentVerifiedDocumentIds: ReadonlySet<string>,
): UrlaLiability[] {
  return liabilities.map(liability => liabilityTreatmentLinkIsCurrent(
    liability,
    credit,
    currentVerifiedDocumentIds,
  ) ? liability : { ...liability, underwritingTreatment: null });
}

/** Apply a reviewed exception to the exact bureau line selected by the
 * reviewer. Deduping indexes prevents two URLA rows from subtracting one
 * bureau obligation twice. */
export function adjustedBureauDebtAfterReviewedTreatments(
  credit: DecisionCreditPicture | null,
  liabilities: UrlaLiability[],
  currentVerifiedDocumentIds: ReadonlySet<string>,
): number | null {
  if (!credit) return null;
  const usedIndexes = new Set<number>();
  let adjusted = credit.adjustedMonthlyDebt;
  for (const liability of liabilities) {
    if (!liabilityTreatmentLinkIsCurrent(liability, credit, currentVerifiedDocumentIds)) continue;
    const index = liability.treatmentTradelineIndex!;
    if (usedIndexes.has(index)) continue;
    usedIndexes.add(index);
    adjusted -= qualifyingTradelinePayment(credit.tradelines[index]);
  }
  return Math.max(Math.round(adjusted * 100) / 100, 0);
}
