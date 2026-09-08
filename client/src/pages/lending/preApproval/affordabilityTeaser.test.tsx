import { describe, it, expect } from "vitest";
import type { PreApprovalFormData } from "@shared/schema";
import { buildTeaserInputs, parseTargetPrice } from "./affordabilityTeaser";

const BASE: PreApprovalFormData = {
  annualIncome: "120,000",
  employmentType: "employed",
  employmentYears: "5",
  monthlyDebts: "500",
  creditScore: "720",
  loanPurpose: "purchase",
  propertyType: "single_family",
  purchasePrice: "500,000",
  downPayment: "100,000",
  isVeteran: false,
  isFirstTimeBuyer: false,
  avoidsInterestFinancing: false,
  propertyState: "CA",
  hasAdditionalIncome: false,
  incomeSources: [],
} as PreApprovalFormData;

describe("buildTeaserInputs", () => {
  it("parses comma-formatted currency fields into numbers", () => {
    const inputs = buildTeaserInputs(BASE);
    expect(inputs).toMatchObject({
      annualIncome: 120000,
      monthlyDebts: 500,
      downPaymentSaved: 100000,
      creditScore: 720,
    });
  });

  it("falls back an unset/'not_sure' credit score to the calculator's own default (680)", () => {
    expect(buildTeaserInputs({ ...BASE, creditScore: "not_sure" })?.creditScore).toBe(680);
    expect(buildTeaserInputs({ ...BASE, creditScore: "" })?.creditScore).toBe(680);
  });

  it("does not double-count the source breakdown and still counts rental debt", () => {
    const inputs = buildTeaserInputs({
      ...BASE,
      hasAdditionalIncome: true,
      incomeSources: [
        { type: "other", annualAmount: "50,000" },
        {
          type: "rental",
          annualAmount: "30,000",
          rentalProperties: [
            { address: "12 Elm St", monthlyRentalIncome: "2,500", monthlyDebtPayment: "1,200" },
          ],
        },
      ],
    } as PreApprovalFormData);
    expect(inputs).toMatchObject({
      annualIncome: 120000, // the household total already includes the source breakdown
      monthlyDebts: 1700, // 500 typed + 1,200 rental debt service
    });
  });

  it("returns null when income hasn't been entered (defensive — final gate should prevent this)", () => {
    expect(buildTeaserInputs({ ...BASE, annualIncome: "" })).toBeNull();
    expect(buildTeaserInputs({ ...BASE, annualIncome: "0" })).toBeNull();
  });

  it("removes the down-payment cap for a $0-down VA purchase instead of flooring the estimate at $0", () => {
    const vaZeroDown = buildTeaserInputs({
      ...BASE,
      isVeteran: true,
      loanPurpose: "purchase",
      downPayment: "0",
    });
    expect(vaZeroDown?.downPaymentSaved).toBe(Number.POSITIVE_INFINITY);
  });

  it("still floors at $0 down for a non-veteran with no savings", () => {
    const noSavings = buildTeaserInputs({ ...BASE, isVeteran: false, downPayment: "0" });
    expect(noSavings?.downPaymentSaved).toBe(0);
  });

  it("does not waive the down-payment cap for a veteran refinance ($0-down is purchase-only)", () => {
    const vaRefi = buildTeaserInputs({
      ...BASE,
      isVeteran: true,
      loanPurpose: "refinance",
      downPayment: "0",
    });
    expect(vaRefi?.downPaymentSaved).toBe(0);
  });
});

describe("parseTargetPrice", () => {
  it("parses a comma-formatted price", () => {
    expect(parseTargetPrice("500,000")).toBe(500000);
  });

  it("returns null for blank/zero input", () => {
    expect(parseTargetPrice("")).toBeNull();
    expect(parseTargetPrice("0")).toBeNull();
    expect(parseTargetPrice(undefined)).toBeNull();
  });
});
