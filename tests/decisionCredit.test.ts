import { describe, expect, it } from "vitest";
import type { CreditPull } from "@shared/schema";
import { assessCreditPullDecisionData } from "../server/services/decisionCredit";

function pull(overrides: Partial<CreditPull> = {}): CreditPull {
  return {
    id: "pull-1",
    vendorRequestId: "BUREAU-123",
    externalRequestId: null,
    experianScore: 720,
    equifaxScore: 700,
    transunionScore: 740,
    representativeScore: 720,
    openTradelines: 2,
    monthlyPayments: "200.00",
    liabilities: [
      { creditor: "Card", type: "revolving", balance: 4_000, monthlyPayment: 0 },
      { creditor: "Student Loan", type: "student_loan", balance: 20_000, monthlyPayment: 200 },
    ],
    completedAt: new Date("2026-09-11T12:00:00.000Z"),
    ...overrides,
  } as CreditPull;
}

describe("decision-grade bureau facts", () => {
  it("derives the score and adjusted debt from a coherent provider record", () => {
    const result = assessCreditPullDecisionData(pull());
    expect(result.isReady).toBe(true);
    expect(result.picture).toMatchObject({
      representativeScore: 720,
      reportedMonthlyPayments: 200,
      adjustedMonthlyDebt: 400,
    });
    expect(result.picture?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a representative score that cannot be reproduced from the bureau scores", () => {
    const result = assessCreditPullDecisionData(pull({ representativeScore: 740 }));
    expect(result.isReady).toBe(false);
    expect(result.scoreIsUsable).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/representative credit score/i);
  });

  it("uses the lowest representative score and requires coverage for every joint borrower", () => {
    const joint = assessCreditPullDecisionData(pull({
      experianScore: 660,
      equifaxScore: 640,
      transunionScore: 650,
      representativeScore: 650,
      borrowerScores: [
        { borrowerSequenceNumber: 1, experianScore: 740, equifaxScore: 720, transunionScore: 730, representativeScore: 730 },
        { borrowerSequenceNumber: 2, experianScore: 660, equifaxScore: 640, transunionScore: 650, representativeScore: 650 },
      ],
    }), [1, 2]);
    expect(joint.isReady).toBe(true);
    expect(joint.picture?.representativeScore).toBe(650);
    expect(joint.picture?.borrowerScores).toHaveLength(2);

    const missingCoBorrower = assessCreditPullDecisionData(pull(), [1, 2]);
    expect(missingCoBorrower.isReady).toBe(false);
    expect(missingCoBorrower.scoreIsUsable).toBe(false);
    expect(missingCoBorrower.reasons.join(" ")).toMatch(/borrower 2/i);
  });

  it("rejects a joint report whose top-level score is not the controlling borrower", () => {
    const result = assessCreditPullDecisionData(pull({
      borrowerScores: [
        { borrowerSequenceNumber: 1, experianScore: 720, equifaxScore: 700, transunionScore: 740, representativeScore: 720 },
        { borrowerSequenceNumber: 2, experianScore: 660, equifaxScore: 640, transunionScore: 650, representativeScore: 650 },
      ],
    }), [1, 2]);
    expect(result.isReady).toBe(false);
    expect(result.scoreIsUsable).toBe(false);
  });

  it("rejects an incomplete or aggregate-inconsistent liability ledger", () => {
    expect(assessCreditPullDecisionData(pull({ liabilities: null })).liabilitiesAreUsable).toBe(false);
    expect(assessCreditPullDecisionData(pull({ openTradelines: 1 })).liabilitiesAreUsable).toBe(false);
    expect(assessCreditPullDecisionData(pull({ monthlyPayments: "199.00" })).liabilitiesAreUsable).toBe(false);
  });

  it("accepts a documented zero-tradeline report, but not an ambiguous empty ledger", () => {
    const zero = assessCreditPullDecisionData(pull({
      openTradelines: 0,
      monthlyPayments: "0",
      liabilities: [],
    }));
    expect(zero.isReady).toBe(true);
    expect(assessCreditPullDecisionData(pull({ openTradelines: null, monthlyPayments: "0", liabilities: [] })).isReady).toBe(false);
  });

  it("requires the provider's reference even when the numbers are internally coherent", () => {
    const result = assessCreditPullDecisionData(pull({ vendorRequestId: null, externalRequestId: null }));
    expect(result.isReady).toBe(false);
    expect(result.hasProviderReference).toBe(false);
  });
});
