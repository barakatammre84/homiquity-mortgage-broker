import { describe, expect, it } from "vitest";
import { isLoanLetterEligible } from "./LoanLetterButton";

describe("loan letter eligibility", () => {
  it("offers only the preliminary letter while a pre-approved stage is unverified", () => {
    expect(isLoanLetterEligible("prequal", "pre_approved", false)).toBe(true);
    expect(isLoanLetterEligible("preapproval", "pre_approved", false)).toBe(false);
  });

  it("offers the pre-approval letter after financial verification", () => {
    expect(isLoanLetterEligible("prequal", "pre_approved", true)).toBe(false);
    expect(isLoanLetterEligible("preapproval", "pre_approved", true)).toBe(true);
  });
});
