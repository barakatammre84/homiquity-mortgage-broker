import { describe, expect, it } from "vitest";
import { getUploadNextStep } from "./documentCategories";

describe("getUploadNextStep", () => {
  it("uses income-review guidance for the pipeline's self-employed P&L type", () => {
    expect(getUploadNextStep("profit_loss")).toContain("verify your income");
  });

  it("uses asset-review guidance for the pipeline's bank-statement type", () => {
    expect(getUploadNextStep("bank_statement_business")).toContain(
      "down payment and closing costs",
    );
  });
});
