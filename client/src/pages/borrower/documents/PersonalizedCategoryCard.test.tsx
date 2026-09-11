import { describe, expect, it } from "vitest";
import { personalizedCategoryDescription } from "./PersonalizedCategoryCard";

describe("personalizedCategoryDescription", () => {
  it("describes the evidence actually requested from a self-employed borrower", () => {
    const description = personalizedCategoryDescription("income", [
      { documentType: "tax_return", acceptedTypes: ["tax_return"] },
      { documentType: "profit_loss", acceptedTypes: ["profit_loss"] },
      { documentType: "business_license", acceptedTypes: ["business_license"] },
    ]);

    expect(description).toBe(
      "Tax returns, profit and loss statements, and business records",
    );
    expect(description).not.toContain("Pay stubs");
  });

  it("keeps the broader income description for a mixed-income file", () => {
    expect(
      personalizedCategoryDescription("income", [
        { documentType: "pay_stub", acceptedTypes: ["pay_stub"] },
        { documentType: "tax_return", acceptedTypes: ["tax_return"] },
      ]),
    ).toBe("Pay stubs, tax returns, and employment documents");
  });

  it("keeps the normal description for other categories", () => {
    expect(
      personalizedCategoryDescription("assets", [
        { documentType: "bank_statement", acceptedTypes: ["bank_statement"] },
      ]),
    ).toBe("Bank statements and reserve documentation");
  });
});
