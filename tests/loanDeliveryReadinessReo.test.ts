import { describe, expect, it, vi } from "vitest";

import { confirmedMortgagedReoCount } from "../shared/realEstateFinancing";

describe("lender-readiness financed-property count", () => {
  it("keeps an unanswered ownership question unknown", () => {
    expect(confirmedMortgagedReoCount(null, [])).toBeUndefined();
  });

  it("accepts an explicit no-properties answer as zero", () => {
    expect(confirmedMortgagedReoCount(false, [])).toBe(0);
  });

  it("keeps a listed property's financing state unknown until balance or payment is supplied", () => {
    expect(confirmedMortgagedReoCount(true, [{ mortgageBalance: null, mortgagePayment: null }])).toBeUndefined();
  });

  it("counts a monthly payment as proof of financing and a zero balance as unfinanced", () => {
    expect(confirmedMortgagedReoCount(true, [
      { mortgageBalance: null, mortgagePayment: "1450" },
      { mortgageBalance: "0", mortgagePayment: null },
      { mortgageBalance: "225000", mortgagePayment: null },
    ])).toBe(2);
  });
});
