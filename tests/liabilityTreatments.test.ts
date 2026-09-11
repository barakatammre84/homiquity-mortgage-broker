import { describe, expect, it } from "vitest";
import type { UrlaLiability } from "@shared/schema";
import type { DecisionCreditPicture } from "../server/services/decisionCredit";
import {
  adjustedBureauDebtAfterReviewedTreatments,
  liabilityTreatmentLinkIsCurrent,
  liabilitiesWithCurrentReviewedTreatments,
  recommendedLiabilityTreatment,
} from "../server/services/liabilityTreatments";

const liability = (over: Partial<UrlaLiability> = {}) => ({
  id: "liability-1",
  applicationId: "application-1",
  borrowerSequenceNumber: 1,
  liabilityType: "Student Loan",
  creditorName: "Federal Servicer",
  accountNumberEncrypted: null,
  accountNumberIv: null,
  accountNumberKeyId: null,
  accountNumberLast4: "1234",
  unpaidBalance: "40000",
  monthlyPayment: "0",
  toBePaidOff: false,
  remainingTermMonths: null,
  studentLoanRepaymentPlan: "income_driven",
  underwritingTreatment: "documented_zero_student_loan",
  treatmentSourceDocumentId: "document-1",
  treatmentCreditPullId: "credit-1",
  treatmentTradelineIndex: 0,
  treatmentReviewedBy: "reviewer-1",
  treatmentReviewedAt: new Date("2026-09-11T00:00:00Z"),
  paidByOtherParty: false,
  otherPartyRelationship: null,
  otherPartyObligated: null,
  otherPartyInterestedParty: null,
  usesRentalIncomeFromProperty: null,
  createdAt: new Date("2026-09-11T00:00:00Z"),
  ...over,
}) as UrlaLiability;

const credit: DecisionCreditPicture = {
  pullId: "credit-1",
  representativeScore: 740,
  borrowerScores: [{ borrowerSequenceNumber: 1, experianScore: 740, equifaxScore: 750, transunionScore: 730, representativeScore: 740 }],
  tradelines: [
    { creditor: "Federal Servicer", type: "student_loan", balance: 40000, monthlyPayment: 0, deferred: true },
    { creditor: "Auto Finance", type: "auto", balance: 1800, monthlyPayment: 450 },
  ],
  reportedMonthlyPayments: 450,
  adjustedMonthlyDebt: 850,
  fingerprint: "f".repeat(64),
};

describe("evidence-linked liability treatments", () => {
  it("recognizes only facts eligible for a reviewed borrower-favorable treatment", () => {
    expect(recommendedLiabilityTreatment(liability())).toBe("documented_zero_student_loan");
    expect(recommendedLiabilityTreatment(liability({ studentLoanRepaymentPlan: "deferred" }))).toBeNull();
    expect(recommendedLiabilityTreatment(liability({
      liabilityType: "Installment (Auto Loan)",
      remainingTermMonths: 6,
      monthlyPayment: "450",
    }))).toBe("exclude_short_term_installment");
    expect(recommendedLiabilityTreatment(liability({
      liabilityType: "Lease",
      remainingTermMonths: 6,
      monthlyPayment: "450",
    }))).toBeNull();
  });

  it("falls back to conservative treatment when evidence or the bureau pull changes", () => {
    const row = liability();
    expect(liabilityTreatmentLinkIsCurrent(row, credit, new Set(["document-1"]))).toBe(true);
    expect(liabilityTreatmentLinkIsCurrent(row, credit, new Set())).toBe(false);
    expect(liabilityTreatmentLinkIsCurrent(row, { ...credit, pullId: "new-credit" }, new Set(["document-1"]))).toBe(false);
    expect(liabilitiesWithCurrentReviewedTreatments([row], credit, new Set())[0].underwritingTreatment).toBeNull();
  });

  it("subtracts the exact guideline-adjusted bureau payment once", () => {
    const student = liability();
    const duplicate = liability({ id: "liability-2" });
    expect(adjustedBureauDebtAfterReviewedTreatments(
      credit,
      [student, duplicate],
      new Set(["document-1"]),
    )).toBe(450);

    const auto = liability({
      id: "liability-3",
      liabilityType: "Installment (Auto Loan)",
      creditorName: "Auto Finance",
      unpaidBalance: "1800",
      monthlyPayment: "450",
      remainingTermMonths: 4,
      studentLoanRepaymentPlan: null,
      underwritingTreatment: "exclude_short_term_installment",
      treatmentTradelineIndex: 1,
    });
    expect(adjustedBureauDebtAfterReviewedTreatments(
      credit,
      [student, auto],
      new Set(["document-1"]),
    )).toBe(0);
  });
});
