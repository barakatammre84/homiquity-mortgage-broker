import { describe, it, expect } from "vitest";
import { entryTypeFromSearchParams, loanPurposeForEntryType, occupancyForEntryType } from "./entryType";

describe("entryTypeFromSearchParams", () => {
  it("accepts the legacy goal parameter and gives the current type parameter precedence", () => {
    expect(entryTypeFromSearchParams(new URLSearchParams("goal=purchase"))).toBe("purchase");
    expect(entryTypeFromSearchParams(new URLSearchParams("goal=refinance"))).toBe("refinance");
    expect(entryTypeFromSearchParams(new URLSearchParams("goal=purchase&type=cashout"))).toBe("cashout");
  });
});

// Pins every `?type=` value emitted anywhere in client/src today. The list was
// taken from the source, not invented:
//
//   refinance      pages/public/Refinance.tsx:358,509
//   heloc          pages/calculators/HomeEquityCalculator.tsx:103
//   cashout        pages/rates/CashOutRates.tsx:119,132,148   ← was falling through
//   va             pages/public/VALoans.tsx, calculators/BahCalculator.tsx
//   first-time     pages/public/FirstTimeBuyer.tsx:312,484
//   self-employed  pages/public/SelfEmployed.tsx:33,34,335
//   investment     pages/public/Landing.tsx:81
//
// If a new entry link adds a `?type=`, this file is where it has to be
// answered — including with "purchase, deliberately".

describe("loanPurposeForEntryType", () => {
  it("maps both cash-out spellings onto the funnel's cash_out purpose", () => {
    // The defect: /rates/cash-out says `cashout`, the funnel matched `heloc`.
    expect(loanPurposeForEntryType("cashout")).toBe("cash_out");
    expect(loanPurposeForEntryType("heloc")).toBe("cash_out");
  });

  it("maps refinance", () => {
    expect(loanPurposeForEntryType("refinance")).toBe("refinance");
  });

  it("leaves the borrower-attribute entry types on purchase", () => {
    // These preselect isVeteran / isFirstTimeBuyer / employmentType instead.
    for (const t of ["va", "first-time", "self-employed"]) {
      expect(loanPurposeForEntryType(t)).toBe("purchase");
    }
  });

  it("leaves investment on purchase — an investment purchase is still a purchase", () => {
    expect(loanPurposeForEntryType("investment")).toBe("purchase");
    expect(occupancyForEntryType("investment")).toBe("investment");
  });

  it("does not invent occupancy for entry links that did not provide it", () => {
    for (const type of [null, undefined, "", "va", "refinance", "constructor"]) {
      expect(occupancyForEntryType(type)).toBeUndefined();
    }
  });

  it("is total: absent, empty and unknown types are a purchase", () => {
    expect(loanPurposeForEntryType(null)).toBe("purchase");
    expect(loanPurposeForEntryType(undefined)).toBe("purchase");
    expect(loanPurposeForEntryType("")).toBe("purchase");
    expect(loanPurposeForEntryType("something-marketing-invents-next")).toBe("purchase");
  });

  it("does not answer to prototype keys", () => {
    // `Record<string, …>` + a raw URL value: `?type=constructor` must not
    // resolve to Object.prototype.constructor and blow past the enum.
    expect(loanPurposeForEntryType("constructor")).toBe("purchase");
    expect(loanPurposeForEntryType("toString")).toBe("purchase");
  });
});
