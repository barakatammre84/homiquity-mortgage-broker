import { describe, expect, it } from "vitest";
import { scoreFinancialPredictionSignals } from "../server/services/predictiveEngine";

const strongProfile = {
  creditScore: 760,
  dti: 32.61,
  ltv: 80,
  employmentYears: 6,
  isVeteran: false,
};

describe("borrower prediction financial verification gate", () => {
  it("does not score or praise unverified qualification inputs", () => {
    expect(scoreFinancialPredictionSignals({ ...strongProfile, financialsVerified: false })).toEqual({
      scoreDelta: 0,
      riskFactors: [],
      positiveFactors: [],
    });
  });

  it("uses the same inputs after they become decision-grade", () => {
    const result = scoreFinancialPredictionSignals({ ...strongProfile, financialsVerified: true });
    expect(result.scoreDelta).toBeGreaterThan(0);
    expect(result.positiveFactors).toContain("Low debt-to-income ratio");
    expect(result.positiveFactors).toContain("Excellent credit score");
  });
});
