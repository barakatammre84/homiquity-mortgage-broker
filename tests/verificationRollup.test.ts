import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  application: {
    id: "app-1",
    incomeVerified: false,
    assetsVerified: false,
    creditVerified: true,
    financialDataProvenance: "self_reported",
  } as Record<string, unknown>,
}));
const recalculateDecision = vi.hoisted(() => vi.fn());

vi.mock("../server/storage", () => ({
  storage: {
    getLoanApplication: vi.fn(async () => ({ ...state.application })),
    updateLoanApplication: vi.fn(async (_id: string, changes: Record<string, unknown>) => {
      Object.assign(state.application, changes);
      return { ...state.application };
    }),
  },
}));
vi.mock("../server/services/decisionEngine", () => ({ recalculateDecision }));

const { markDimensionVerified } = await import("../server/services/verification");

describe("verification roll-up", () => {
  beforeEach(() => {
    Object.assign(state.application, {
      incomeVerified: false,
      assetsVerified: false,
      creditVerified: true,
      financialDataProvenance: "self_reported",
    });
    recalculateDecision.mockClear();
  });

  it("promotes after concurrent reviewers finish the final two dimensions", async () => {
    await Promise.all([
      markDimensionVerified("app-1", "income", "reviewer-1"),
      markDimensionVerified("app-1", "assets", "reviewer-2"),
    ]);

    expect(state.application.incomeVerified).toBe(true);
    expect(state.application.assetsVerified).toBe(true);
    expect(state.application.creditVerified).toBe(true);
    expect(state.application.financialDataProvenance).toBe("verified");
    expect(recalculateDecision).toHaveBeenCalledWith("app-1", "verified");
  });
});
