import { describe, expect, it } from "vitest";

import { getLoanOptionsPresentation, isIntakeStillFinalizing } from "./loanOptionsPresentation";

describe("getLoanOptionsPresentation", () => {
  it("describes unverified scenarios as estimates and never claims lender review", () => {
    const presentation = getLoanOptionsPresentation({
      status: "under_review",
      financialsVerified: false,
      hasOptions: true,
    });

    expect(presentation.badge).toBe("Based on your answers");
    expect(presentation.title).toBe("Your estimated loan options are ready");
    expect(presentation.description).toContain("verify");
    expect(`${presentation.badge} ${presentation.title} ${presentation.description}`).not.toMatch(/under review|prepared for review/i);
  });

  it("says scenarios are still being built when none exist yet", () => {
    const presentation = getLoanOptionsPresentation({
      status: "analyzing",
      financialsVerified: false,
      hasOptions: false,
    });

    expect(presentation.title).toBe("We're building your estimated options");
  });
});

describe("isIntakeStillFinalizing", () => {
  it("keeps refreshing while the document plan is still being built", () => {
    expect(isIntakeStillFinalizing("submitted")).toBe(true);
    expect(isIntakeStillFinalizing("analyzing")).toBe(true);
    expect(isIntakeStillFinalizing("under_review")).toBe(false);
    expect(isIntakeStillFinalizing("pre_approved")).toBe(false);
  });
});
