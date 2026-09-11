import { describe, it, expect } from "vitest";
import { buildScenarios, scenarioAPR, type ScenarioInputs } from "../server/services/loanAnalysis";

// Guards the transparency contract behind the loan comparison matrix:
// monthlyPayment must be the full PITI sum of its displayed parts (no hidden
// math), the amortization must follow the standard compound-interest model,
// and the 15-year scenario must show the equity-velocity trade-off honestly.

const BASE: ScenarioInputs = {
  purchasePrice: 400000,
  downPayment: 80000, // 20% — keeps conventional PMI out of the baseline
  loanAmount: 320000,
  creditScore: 760,
  isVeteran: false,
  isFirstTimeBuyer: false,
  enginePmiMonthly: null,
  selectedLoanProgram: "CONVENTIONAL",
};

const num = (v: string) => parseFloat(v);

function standardPI(principal: number, annualRatePct: number, n: number): number {
  const r = annualRatePct / 100 / 12;
  return (principal * (r * Math.pow(1 + r, n))) / (Math.pow(1 + r, n) - 1);
}

describe("buildScenarios — comparison matrix contract", () => {
  it("includes a 15-year conventional scenario alongside the 30-year options", () => {
    const scenarios = buildScenarios(BASE);
    const terms = scenarios.filter((s) => s.loanType === "conventional").map((s) => s.loanTerm);
    expect(terms).toContain(30);
    expect(terms).toContain(15);
  });

  it("prices the 15-year term 0.50% below the 30-year base rate", () => {
    const scenarios = buildScenarios(BASE);
    const thirty = scenarios.find((s) => s.loanTerm === 30 && s.points === "0")!;
    const fifteen = scenarios.find((s) => s.loanTerm === 15)!;
    expect(num(thirty.interestRate) - num(fifteen.interestRate)).toBeCloseTo(0.5, 6);
  });

  it("computes P&I with the standard amortization formula for both terms", () => {
    const scenarios = buildScenarios(BASE);
    for (const s of scenarios.filter((x) => x.loanType === "conventional")) {
      const expected = standardPI(num(s.loanAmount), num(s.interestRate), s.loanTerm * 12);
      expect(num(s.principalAndInterest)).toBeCloseTo(expected, 1);
    }
  });

  it("shows the 15-year trade-off: higher payment, less lifetime interest", () => {
    const scenarios = buildScenarios(BASE);
    const thirty = scenarios.find((s) => s.loanTerm === 30 && s.points === "0")!;
    const fifteen = scenarios.find((s) => s.loanTerm === 15)!;
    expect(num(fifteen.principalAndInterest)).toBeGreaterThan(num(thirty.principalAndInterest));
    expect(num(fifteen.totalInterestPaid)).toBeLessThan(num(thirty.totalInterestPaid));
  });

  it("monthlyPayment equals the sum of its displayed PITI parts — no hidden math", () => {
    // Include a low-down variant so the PMI component is exercised too.
    const lowDown: ScenarioInputs = {
      ...BASE,
      downPayment: 20000,
      loanAmount: 380000,
      creditScore: 680,
      isFirstTimeBuyer: true,
    };
    for (const inputs of [BASE, lowDown]) {
      for (const s of buildScenarios(inputs)) {
        const parts =
          num(s.principalAndInterest) + num(s.propertyTax) + num(s.homeInsurance) + num(s.pmi);
        expect(num(s.monthlyPayment)).toBeCloseTo(parts, 1);
      }
    }
  });

  // -------------------------------------------------------------------------
  // APR contract (F-076 / F-090). The old assertion here — `apr >= rate` —
  // passed for ANY non-negative constant, and the code under test was exactly
  // `rate + 0.25/0.50`. These pins are the replacement: the stored column must
  // ROUTE through the Appendix J solver, and the fees the scenario itself
  // prices must move it.
  // -------------------------------------------------------------------------

  it("routes every scenario's APR through the Appendix J solver — never a flat spread (F-076)", () => {
    const lowDownFirstTime: ScenarioInputs = {
      ...BASE,
      downPayment: 20000,
      loanAmount: 380000,
      creditScore: 680,
      isFirstTimeBuyer: true,
      enginePmiMonthly: 270,
    };
    const veteran: ScenarioInputs = { ...BASE, isVeteran: true, selectedLoanProgram: "VA" };

    for (const inputs of [BASE, lowDownFirstTime, veteran]) {
      for (const s of buildScenarios(inputs)) {
        const expected = scenarioAPR({
          loanType: s.loanType,
          loanAmount: num(s.loanAmount),
          ratePct: num(s.interestRate),
          termMonths: s.loanTerm * 12,
          monthlyMI: num(s.pmi),
          purchasePrice: inputs.purchasePrice,
          pointsCost: num(s.pointsCost),
        });
        expect(s.apr, `${s.loanType}/${s.loanTerm}yr/${s.points}pt`).toBe(expected.toFixed(3));
        expect(num(s.apr)).toBeGreaterThanOrEqual(num(s.interestRate));
        // Reintroduction canary: the exact F-076 value. Deterministic inputs,
        // verified non-colliding at write time.
        const flatSpread = (num(s.interestRate) + (s.loanType === "fha" ? 0.5 : 0.25)).toFixed(3);
        expect(s.apr, "APR must not be the flat spread over the note rate").not.toBe(flatSpread);
      }
    }
  });

  it("a paid discount point moves the APR — the F-076 specimen moved it by exactly 0.000pp", () => {
    const scenarios = buildScenarios(BASE);
    const noPoints = scenarios.find((s) => s.loanTerm === 30 && s.points === "0")!;
    const onePoint = scenarios.find((s) => s.points === "1")!;
    // Same fee model on both; the $3,200 point must widen the APR-over-rate
    // spread on the scenario that charges it.
    const spreadWithout = num(noPoints.apr) - num(noPoints.interestRate);
    const spreadWith = num(onePoint.apr) - num(onePoint.interestRate);
    expect(spreadWith).toBeGreaterThan(spreadWithout + 0.05);
  });

  it("monthly MI widens the APR spread on the scenario that carries it", () => {
    const withPmi = buildScenarios({
      ...BASE,
      downPayment: 20000,
      loanAmount: 380000,
      enginePmiMonthly: 270,
    });
    const noPmi = buildScenarios(BASE);
    const pick = (list: ReturnType<typeof buildScenarios>) =>
      list.find((s) => s.loanType === "conventional" && s.loanTerm === 30 && s.points === "0")!;
    const spread = (s: ReturnType<typeof buildScenarios>[number]) =>
      num(s.apr) - num(s.interestRate);
    expect(num(pick(withPmi).pmi)).toBeGreaterThan(0);
    expect(spread(pick(withPmi))).toBeGreaterThan(spread(pick(noPmi)));
  });

  it("keeps option cards inside the selected product family", () => {
    expect(buildScenarios({ ...BASE, isVeteran: true }).map((s) => s.loanType))
      .toEqual(["conventional", "conventional", "conventional"]);
    expect(buildScenarios({ ...BASE, selectedLoanProgram: "FHA" }).map((s) => s.loanType))
      .toEqual(["fha"]);
    expect(buildScenarios({ ...BASE, isVeteran: true, selectedLoanProgram: "VA" }).map((s) => s.loanType))
      .toEqual(["va"]);
    expect(buildScenarios({ ...BASE, selectedLoanProgram: "USDA" })).toEqual([]);
  });
});
