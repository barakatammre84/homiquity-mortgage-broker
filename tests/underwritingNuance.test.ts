import { describe, expect, it } from "vitest";
import {
  adjustLiabilities,
  assessIncomeSeasoning,
  calculateRentalIncomeOffsets,
  calculateSubjectPropertyRentalOffset,
  computeDti,
  computeVaResidualIncome,
  computeWhatIfPayoff,
  detectSignificantDeposits,
  incomeDiscrepancyPct,
  vaRegionForState,
  vaResidualBaseline,
  type Tradeline,
} from "../server/services/underwritingNuance";

describe("assessIncomeSeasoning (Fannie B3-3.5-01)", () => {
  it("treats W-2 income as seasoned regardless of tenure", () => {
    const result = assessIncomeSeasoning([{ type: "w2", annualAmount: "80,000", yearsInRole: "0.5" } as never]);
    expect(result.seasonedSources).toContain("w2");
    expect(result.unseasonedSources).toHaveLength(0);
  });

  it("flags 14 months of self-employment as conditional (12–24 months)", () => {
    const result = assessIncomeSeasoning([
      { type: "self_employed", annualAmount: "40,000", yearsInRole: "1.17" } as never,
    ]);
    expect(result.conditionalSources).toHaveLength(1);
    expect(result.conditionalSources[0].months).toBe(14);
  });

  it("does not apply the self-employment seasoning rule to rental income", () => {
    const result = assessIncomeSeasoning([
      { type: "rental", annualAmount: "18,000", yearsInRole: "0.5" } as never,
    ]);
    expect(result.unseasonedSources).toHaveLength(0);
    expect(result.conditionalSources).toHaveLength(0);
    expect(result.seasonedSources).toContain("rental");
  });

  it("passes 24+ months as fully seasoned", () => {
    const result = assessIncomeSeasoning([
      { type: "self_employed", annualAmount: "40,000", yearsInRole: "3" } as never,
    ]);
    expect(result.seasonedSources).toContain("self_employed");
  });
});

describe("incomeDiscrepancyPct", () => {
  it("computes the delta percentage", () => {
    expect(incomeDiscrepancyPct(120_000, 100_000)).toBeCloseTo(20);
    expect(incomeDiscrepancyPct(102_000, 100_000)).toBeCloseTo(2);
  });
});

describe("adjustLiabilities (Fannie B3-6-05)", () => {
  const scenario3: Tradeline[] = [
    { creditor: "Chase Card", type: "revolving", balance: 2_000, monthlyPayment: 200 },
    { creditor: "Nelnet", type: "student_loan", balance: 60_000, monthlyPayment: 0, deferred: true },
    { creditor: "Wayfair", type: "retail", balance: 1_500, monthlyPayment: 50, openedDaysAgo: 21 },
  ];

  it("reproduces the doc's math: $200 + 1% of $60k + $50 = $850", () => {
    const adj = adjustLiabilities(scenario3);
    expect(adj.reportedMonthlyPayments).toBe(250); // 200 + 0 + 50
    expect(adj.deferredStudentLoanImputed).toBe(600);
    expect(adj.adjustedMonthlyDebt).toBe(850);
    expect(adj.newTradelines).toHaveLength(1);
    expect(adj.deferredStudentLoans).toHaveLength(1);
  });

  it("treats $0-payment student loans as deferred even without the flag", () => {
    const adj = adjustLiabilities([
      { creditor: "Sallie Mae", type: "student_loan", balance: 30_000, monthlyPayment: 0 },
    ]);
    expect(adj.deferredStudentLoanImputed).toBe(300);
  });

  it("ignores seasoned lines for the new-tradeline window", () => {
    const adj = adjustLiabilities([
      { creditor: "Old Card", type: "revolving", balance: 5_000, monthlyPayment: 150, openedDaysAgo: 400 },
    ]);
    expect(adj.newTradelines).toHaveLength(0);
  });
});

describe("computeWhatIfPayoff — the denial-to-coaching calculation", () => {
  it("finds the smallest payoff that restores DTI under the ceiling", () => {
    const lines: Tradeline[] = [
      { creditor: "Chase Card", type: "revolving", balance: 2_000, monthlyPayment: 200 },
      { creditor: "Nelnet", type: "student_loan", balance: 60_000, monthlyPayment: 0, deferred: true },
    ];
    const adjusted = adjustLiabilities(lines).adjustedMonthlyDebt; // 800
    // gross $6,000/mo, PITI $1,900 → DTI (800+1900)/6000 = 45% > 43%
    const whatIf = computeWhatIfPayoff(lines, adjusted, 1_900, 6_000);
    expect(whatIf).not.toBeNull();
    expect(whatIf!.creditor).toBe("Chase Card");
    // (800-200+1900)/6000 = 41.7%
    expect(whatIf!.dtiAfterPayoff).toBeLessThanOrEqual(0.43);
  });

  it("returns null when no single payoff can fix it", () => {
    const lines: Tradeline[] = [
      { creditor: "Nelnet", type: "student_loan", balance: 200_000, monthlyPayment: 0, deferred: true },
    ];
    const adjusted = adjustLiabilities(lines).adjustedMonthlyDebt; // 2000
    expect(computeWhatIfPayoff(lines, adjusted, 2_500, 6_000)).toBeNull();
  });
});

describe("computeVaResidualIncome (VA Pamphlet 26-7 Ch. 4)", () => {
  it("reproduces the doc's Scenario 2: South, family of 4, 2500 sqft, DTI 45%", () => {
    const result = computeVaResidualIncome({
      grossMonthlyIncome: 8_000,
      proposedPiti: 2_400,
      monthlyDebts: 1_200,
      homeSquareFeet: 2_500,
      state: "TX",
      familySize: 4,
      dti: 0.45,
    });
    expect(result.utilityDeduction).toBe(350); // 2500 × $0.14
    expect(result.baseline).toBe(1_003); // South, family of 4
    expect(result.cushionApplied).toBe(true); // DTI > 41%
    expect(result.requiredResidual).toBeCloseTo(1_203.6);
    // 8000 - 1760 (22% tax) - 2400 - 1200 - 350 = 2290 → passes
    expect(result.residualIncome).toBeCloseTo(2_290);
    expect(result.passes).toBe(true);
  });

  it("skips the cushion at or below 41% DTI", () => {
    const result = computeVaResidualIncome({
      grossMonthlyIncome: 8_000,
      proposedPiti: 2_000,
      monthlyDebts: 800,
      homeSquareFeet: 2_000,
      state: "TX",
      familySize: 4,
      dti: 0.38,
    });
    expect(result.cushionApplied).toBe(false);
    expect(result.requiredResidual).toBe(1_003);
  });

  it("adds $80 per family member beyond five", () => {
    expect(vaResidualBaseline("south", 7)).toBe(1_039 + 160);
  });

  it("reproduces the handbook's family-of-8 example: Georgia → $1,199 (eighth member not considered)", () => {
    // 26-7 Ch. 4, Topic 9, Item 43: $1,039 + 2 × $80, capped at a family of seven.
    expect(vaResidualBaseline("south", 8)).toBe(1_199);
    expect(vaResidualBaseline("south", 12)).toBe(1_199);
  });

  it("applies the 5% Item 43 reduction to the guideline figure (active-duty/retired or facility benefits)", () => {
    const result = computeVaResidualIncome({
      grossMonthlyIncome: 8_000,
      proposedPiti: 2_000,
      monthlyDebts: 800,
      homeSquareFeet: 2_000,
      state: "TX",
      familySize: 4,
      dti: 0.38,
      qualifiesForResidualReduction: true,
    });
    expect(result.baseline).toBe(1_003);
    expect(result.reductionApplied).toBe(true);
    expect(result.requiredResidual).toBeCloseTo(952.85); // 1,003 × 0.95
  });

  it("stacks the reduction under the >41%-DTI cushion (reduced guideline × 1.2)", () => {
    const result = computeVaResidualIncome({
      grossMonthlyIncome: 8_000,
      proposedPiti: 2_400,
      monthlyDebts: 1_200,
      homeSquareFeet: 2_500,
      state: "TX",
      familySize: 4,
      dti: 0.45,
      qualifiesForResidualReduction: true,
    });
    expect(result.cushionApplied).toBe(true);
    expect(result.requiredResidual).toBeCloseTo(1_143.42); // 1,003 × 0.95 × 1.2
  });

  it("maps states to VA regions", () => {
    expect(vaRegionForState("NY")).toBe("northeast");
    expect(vaRegionForState("ca")).toBe("west");
    expect(vaRegionForState("XX")).toBe("south"); // conservative default
  });
});

describe("detectSignificantDeposits (Fannie B3-4.2-02)", () => {
  it("reproduces the doc's Scenario 4: $12k deposit vs $6k monthly income", () => {
    const deposits = detectSignificantDeposits(
      [
        { amount: -12_000, date: "2026-06-15", description: "TRANSFER CREDIT" },
        { amount: -2_500, date: "2026-06-20", description: "PAYROLL" },
        { amount: 800, date: "2026-06-21", description: "RENT" }, // below threshold — ignored (detection is sign-agnostic)
      ],
      6_000,
    );
    expect(deposits).toHaveLength(1);
    expect(deposits[0].amount).toBe(12_000);
    expect(deposits[0].threshold).toBe(3_000); // 50% of monthly income
  });

  it("returns nothing without income or transactions", () => {
    expect(detectSignificantDeposits(null, 6_000)).toHaveLength(0);
    expect(detectSignificantDeposits([{ amount: -9_000, date: "2026-06-15" }], 0)).toHaveLength(0);
  });
});

describe("computeDti", () => {
  it("matches the doc's DTI spike: $850 debt vs $200 self-reported", () => {
    // gross $6,000/mo, PITI $1,900
    expect(computeDti(200, 1_720, 6_000)).toBeCloseTo(0.32);
    expect(computeDti(850, 1_910, 6_000)).toBeCloseTo(0.46);
  });
});

describe("calculateRentalIncomeOffsets (Fannie B3-3.1-08)", () => {
  it("reproduces S-05's worked example: $2,000 rent, $1,200 PITIA -> +$300/mo", () => {
    const offsets = calculateRentalIncomeOffsets([
      { address: "123 Main St", monthlyRentalIncome: "2000", monthlyDebtPayment: "1200" },
    ]);
    expect(offsets).toHaveLength(1);
    expect(offsets[0].qualifyingRentalIncome).toBeCloseTo(1_500);
    expect(offsets[0].netOffset).toBeCloseTo(300);
  });

  it("produces a negative net offset (added debt) when qualifying rent doesn't cover PITIA", () => {
    const offsets = calculateRentalIncomeOffsets([
      { address: "456 Oak Ave", monthlyRentalIncome: "1000", monthlyDebtPayment: "900" },
    ]);
    expect(offsets[0].qualifyingRentalIncome).toBeCloseTo(750);
    expect(offsets[0].netOffset).toBeCloseTo(-150);
  });

  it("sums across multiple properties independently and returns [] for none", () => {
    const offsets = calculateRentalIncomeOffsets([
      { address: "A", monthlyRentalIncome: "2000", monthlyDebtPayment: "1200" },
      { address: "B", monthlyRentalIncome: "1500", monthlyDebtPayment: "1600" },
    ]);
    expect(offsets).toHaveLength(2);
    expect(offsets.reduce((s, o) => s + o.netOffset, 0)).toBeCloseTo(-175);
    expect(calculateRentalIncomeOffsets(null)).toHaveLength(0);
    expect(calculateRentalIncomeOffsets([])).toHaveLength(0);
  });
});

describe("calculateSubjectPropertyRentalOffset (Fannie B3-3.1-08, S-06)", () => {
  it("reproduces S-06's worked example: $3,000 market rent -> $2,250 qualifying offset", () => {
    const offset = calculateSubjectPropertyRentalOffset("3000", 1800, 3, "primary_residence");
    expect(offset).not.toBeNull();
    expect(offset!.qualifyingRentalIncome).toBeCloseTo(2_250);
    expect(offset!.netOffset).toBeCloseTo(450);
  });

  it("returns null when occupancy is not primary residence", () => {
    expect(calculateSubjectPropertyRentalOffset("3000", 1800, 3, "investment")).toBeNull();
  });

  it("returns null for 1-unit and 5+-unit properties", () => {
    expect(calculateSubjectPropertyRentalOffset("3000", 1800, 1, "primary_residence")).toBeNull();
    expect(calculateSubjectPropertyRentalOffset("3000", 1800, 5, "primary_residence")).toBeNull();
  });

  it("returns null when no market rent is provided", () => {
    expect(calculateSubjectPropertyRentalOffset(null, 1800, 3, "primary_residence")).toBeNull();
    expect(calculateSubjectPropertyRentalOffset(0, 1800, 3, "primary_residence")).toBeNull();
  });
});
