import { describe, expect, it } from "vitest";
import { assessCurrentDecisionGrade, isCurrentRealCreditPull, type CurrentDecisionEvidence } from "../server/services/currentDecisionGrade";

const complete: CurrentDecisionEvidence = {
  financialMemoId: "memo",
  incomeWorkpaperId: "income",
  assetWorkpaperId: "assets",
  liabilityWorkpaperId: "liabilities",
  creditPullId: "credit",
  creditPullIsSimulated: false,
  creditPullIsCurrent: true,
  creditPullHasProviderReference: true,
  creditPullScoreIsUsable: true,
  creditPullLiabilitiesAreUsable: true,
  creditPullHasOpenLiabilities: false,
};

const verified = {
  financialDataProvenance: "verified",
  incomeVerified: true,
  assetsVerified: true,
  creditVerified: true,
} as const;

describe("current decision-grade evidence", () => {
  it("requires current approved financial artifacts and real credit behind the stored flags", () => {
    expect(assessCurrentDecisionGrade(verified as never, complete).isDecisionGrade).toBe(true);
    const stale = assessCurrentDecisionGrade(verified as never, { ...complete, financialMemoId: null, incomeWorkpaperId: null });
    expect(stale.isDecisionGrade).toBe(false);
    expect(stale.reasons).toEqual(expect.arrayContaining([
      "The approved financial memo is missing or stale.",
      "The approved income workpaper is missing or stale.",
    ]));
    expect(stale.verification).toEqual({ income: false, assets: false, credit: true });
  });

  it("rejects simulated credit even when every sticky application flag is true", () => {
    const result = assessCurrentDecisionGrade(verified as never, { ...complete, creditPullIsSimulated: true });
    expect(result.isDecisionGrade).toBe(false);
    expect(result.reasons).toContain("A current real bureau credit report is required.");
    expect(result.verification.credit).toBe(false);
  });

  it("rejects expired or archived credit even when every sticky application flag is true", () => {
    const result = assessCurrentDecisionGrade(verified as never, { ...complete, creditPullIsCurrent: false });
    expect(result.isDecisionGrade).toBe(false);
    expect(result.reasons).toContain("A current real bureau credit report is required.");
  });

  it("rejects real/current credit when its decision data is incomplete", () => {
    const result = assessCurrentDecisionGrade(verified as never, {
      ...complete,
      creditPullLiabilitiesAreUsable: false,
    });
    expect(result.isDecisionGrade).toBe(false);
    expect(result.verification.credit).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/open-liability ledger/i);
  });

  it("requires the current financial review to approve bureau liabilities", () => {
    const result = assessCurrentDecisionGrade(verified as never, {
      ...complete,
      creditPullHasOpenLiabilities: true,
      liabilityWorkpaperId: null,
    });
    expect(result.isDecisionGrade).toBe(false);
    expect(result.verification.credit).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/bureau liabilities.*financial workpaper/i);
  });

  it("reports each current dimension independently without promoting the whole file", () => {
    const result = assessCurrentDecisionGrade({
      financialDataProvenance: "self_reported",
      incomeVerified: true,
      assetsVerified: false,
      creditVerified: false,
    } as never, {
      ...complete,
      assetWorkpaperId: null,
      creditPullId: null,
      creditPullIsCurrent: false,
    });
    expect(result.isDecisionGrade).toBe(false);
    expect(result.verification).toEqual({ income: true, assets: false, credit: false });
  });

  it("derives credit freshness from completion, expiry, archive, and simulation state", () => {
    const asOf = new Date("2026-09-10T12:00:00.000Z");
    const pull = {
      id: "credit",
      status: "completed",
      isSimulated: false,
      expiresAt: new Date("2026-09-11T12:00:00.000Z"),
      archivedAt: null,
    } as const;
    expect(isCurrentRealCreditPull(pull as never, asOf)).toBe(true);
    expect(isCurrentRealCreditPull({ ...pull, expiresAt: new Date("2026-09-10T11:59:59.000Z") } as never, asOf)).toBe(false);
    expect(isCurrentRealCreditPull({ ...pull, archivedAt: new Date("2026-09-10T11:00:00.000Z") } as never, asOf)).toBe(false);
    expect(isCurrentRealCreditPull({ ...pull, isSimulated: true } as never, asOf)).toBe(false);
    expect(isCurrentRealCreditPull({ ...pull, status: "pending" } as never, asOf)).toBe(false);
  });
});
