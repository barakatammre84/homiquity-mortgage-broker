// Characterization tests for the Live Analysis math extracted from
// AdvisoryPanel.tsx — written against the extraction, pinning the values the
// inline useMemo produced, so the move is provably behavior-preserving.
// Expected P&I values come from the canonical amortization module (the same
// dependency the panel always used), per its identical-to-the-cent test rule.
import { describe, it, expect } from "vitest";
import { monthlyPrincipalAndInterest } from "@shared/lib/amortization";
import {
  computePreApprovalAnalysis,
  parseMaskedAmount,
  sumIncomeSourcesAnnual,
  sumRentalMonthlyDebts,
  ILLUSTRATIVE_RATE_PCT,
} from "./preApprovalAnalysis";
import type { PreApprovalFormData } from "@shared/schema";

// The panel receives the funnel's partial form values mid-flight; the type is
// the full form shape but every consumer treats fields as possibly absent.
const base = {
  annualIncome: "100,000",
  purchasePrice: "450,000",
  downPayment: "90,000",
  monthlyDebts: "",
  incomeSources: [],
} as unknown as PreApprovalFormData;

const withOverrides = (overrides: Record<string, unknown>): PreApprovalFormData =>
  ({ ...base, ...overrides }) as unknown as PreApprovalFormData;

describe("parseMaskedAmount", () => {
  it("strips currency masking", () => {
    expect(parseMaskedAmount("2,500")).toBe(2500);
    expect(parseMaskedAmount("$450,000")).toBe(450000);
    expect(parseMaskedAmount("")).toBe(0);
    expect(parseMaskedAmount(undefined)).toBe(0);
  });
});

describe("computePreApprovalAnalysis — characterization of the panel's math", () => {
  it("computes PITI at the advertised rate: P&I + 1.25%/yr taxes+insurance, no PMI at 80% LTV", () => {
    const stats = computePreApprovalAnalysis(base, 6.375);

    const expectedPI = monthlyPrincipalAndInterest(360_000, 6.375, 360);
    expect(stats.loanAmount).toBe(360_000);
    expect(stats.ltv).toBeCloseTo(80, 5);
    expect(stats.pmiMonthly).toBe(0);
    expect(stats.estMortgage).toBeCloseTo(expectedPI + (450_000 * 0.0125) / 12, 2);
    // DTI with no debts entered: est. housing / (100k / 12).
    expect(stats.dti).toBeCloseTo((stats.estMortgage / (100_000 / 12)) * 100, 5);
  });

  it("falls back to the labeled illustrative rate when no advertised rate is loaded", () => {
    const stats = computePreApprovalAnalysis(base, null);
    expect(stats.estRatePct).toBe(ILLUSTRATIVE_RATE_PCT);
    expect(stats.estMortgage).toBeCloseTo(
      monthlyPrincipalAndInterest(360_000, ILLUSTRATIVE_RATE_PCT, 360) + (450_000 * 0.0125) / 12,
      2,
    );
  });

  it("adds illustrative PMI above 80% LTV — and waives it for a veteran purchase", () => {
    const lowDown = withOverrides({ downPayment: "22,500" }); // 5% down → 95% LTV
    const conventional = computePreApprovalAnalysis(lowDown, 6.375);
    expect(conventional.pmiMonthly).toBeCloseTo((427_500 * 0.005) / 12, 2);

    const vaPurchase = computePreApprovalAnalysis(
      withOverrides({ downPayment: "22,500", isVeteran: true, loanPurpose: "purchase" }),
      6.375,
    );
    expect(vaPurchase.vaNoPmi).toBe(true);
    expect(vaPurchase.pmiMonthly).toBe(0);
    expect(vaPurchase.estMortgage).toBeCloseTo(conventional.estMortgage - conventional.pmiMonthly, 2);
  });

  it("does not count the income-source breakdown twice", () => {
    const stats = computePreApprovalAnalysis(
      withOverrides({
        incomeSources: [
          { type: "other", annualAmount: "50,000" },
          { type: "rental", annualAmount: "30,000", rentalProperties: [
            { address: "12 Elm St", monthlyRentalIncome: "2,500" },
          ] },
        ],
      }),
      6.375,
    );
    expect(stats.reportedAnnualIncome).toBe(100_000);
    // The broad household total is the estimate; source rows document what is
    // inside it and must not manufacture extra buying power.
    const baseStats = computePreApprovalAnalysis(base, 6.375);
    expect(stats.dti).toBe(baseStats.dti);
  });

  it("keeps the household total when a self-employed borrower details each entity", () => {
    const stats = computePreApprovalAnalysis(
      withOverrides({
        annualIncome: "240,000",
        employmentType: "self_employed",
        incomeSources: [
          { type: "self_employed", annualAmount: "140,000", employerName: "Northstar Consulting LLC" },
          { type: "self_employed", annualAmount: "70,000", employerName: "Lakeview Design LLC" },
          {
            type: "rental",
            annualAmount: "36,000",
            rentalProperties: [{ address: "233 South Wacker Drive", monthlyRentalIncome: "3,000" }],
          },
        ],
      }),
      6.375,
    );

    expect(stats.reportedAnnualIncome).toBe(240_000);
  });

  it("includes typed monthly debts in DTI and reports when they are present", () => {
    const noDebts = computePreApprovalAnalysis(base, 6.375);
    expect(noDebts.includesMonthlyDebts).toBe(false);

    const withDebts = computePreApprovalAnalysis(withOverrides({ monthlyDebts: "1,000" }), 6.375);
    expect(withDebts.includesMonthlyDebts).toBe(true);
    expect(withDebts.dti).toBeCloseTo(
      ((1_000 + withDebts.estMortgage) / (100_000 / 12)) * 100,
      5,
    );
  });

  // The bug this module exists to fix: rental "Monthly Debt Payment" entered
  // on step 11 previously never reached the DTI, so the analysis sat frozen
  // (and optimistic) while the borrower typed. Deleting the
  // sumRentalMonthlyDebts term reintroduces exactly that: this test fails
  // against the pre-fix math.
  it("counts reported rental debt service in the DTI numerator", () => {
    const noRentalDebt = computePreApprovalAnalysis(
      withOverrides({
        incomeSources: [
          {
            type: "rental",
            annualAmount: "30,000",
            rentalProperties: [{ address: "12 Elm St", monthlyRentalIncome: "2,500" }],
          },
        ],
      }),
      6.375,
    );
    const withRentalDebt = computePreApprovalAnalysis(
      withOverrides({
        incomeSources: [
          {
            type: "rental",
            annualAmount: "30,000",
            rentalProperties: [
              { address: "12 Elm St", monthlyRentalIncome: "2,500", monthlyDebtPayment: "1,200" },
            ],
          },
        ],
      }),
      6.375,
    );

    expect(withRentalDebt.monthlyDebts).toBe(1_200);
    expect(withRentalDebt.dti).toBeGreaterThan(noRentalDebt.dti);
    expect(withRentalDebt.dti).toBeCloseTo(
      ((1_200 + withRentalDebt.estMortgage) / (100_000 / 12)) * 100,
      5,
    );
  });

  it("reports zeroes instead of NaN when nothing is entered yet", () => {
    const empty = computePreApprovalAnalysis(
      withOverrides({ annualIncome: "", purchasePrice: "", downPayment: "" }),
      null,
    );
    expect(empty.dti).toBe(0);
    expect(empty.estMortgage).toBe(0);
    expect(empty.ltv).toBe(0);
    expect(empty.reportedAnnualIncome).toBe(0);
  });
});

describe("income-source helpers", () => {
  it("sumIncomeSourcesAnnual tolerates empty and masked values", () => {
    expect(sumIncomeSourcesAnnual(undefined)).toBe(0);
    expect(sumIncomeSourcesAnnual([])).toBe(0);
    expect(
      sumIncomeSourcesAnnual([
        { type: "other", annualAmount: "50,000" },
        { type: "pension", annualAmount: "" },
      ] as never),
    ).toBe(50_000);
  });

  it("sumRentalMonthlyDebts totals reported rental debt service across sources", () => {
    expect(sumRentalMonthlyDebts(undefined)).toBe(0);
    expect(
      sumRentalMonthlyDebts([
        { type: "other", annualAmount: "50,000" },
        {
          type: "rental",
          annualAmount: "60,000",
          rentalProperties: [
            { address: "12 Elm St", monthlyRentalIncome: "2,500", monthlyDebtPayment: "1,200" },
            { address: "9 Oak Ave", monthlyRentalIncome: "2,500", monthlyDebtPayment: "" },
          ],
        },
      ] as never),
    ).toBe(1_200);
  });
});
