import { describe, expect, it } from "vitest";
import { financialVerificationEvidenceError } from "../server/routes/lending/statusDecisions";

describe("financial verification evidence gate", () => {
  it("requires a current approved memo for income and assets", () => {
    const missing = {
      approvedMemoId: null,
      approvedIncomeWorkpaperId: null,
      approvedAssetWorkpaperId: null,
      creditPullId: "pull-1",
      creditPullIsSimulated: false,
    };
    expect(financialVerificationEvidenceError("income", missing)).toMatch(/Approve the current financial workpapers/i);
    expect(financialVerificationEvidenceError("assets", missing)).toMatch(/Approve the current financial workpapers/i);

    const supported = {
      ...missing,
      approvedMemoId: "memo-1",
      approvedIncomeWorkpaperId: "wp-income",
      approvedAssetWorkpaperId: "wp-assets",
    };
    expect(financialVerificationEvidenceError("income", supported)).toBeNull();
    expect(financialVerificationEvidenceError("assets", supported)).toBeNull();
  });

  it("requires a real completed credit pull and refuses the simulator", () => {
    const noPull = {
      approvedMemoId: "memo-1",
      approvedIncomeWorkpaperId: "wp-income",
      approvedAssetWorkpaperId: "wp-assets",
      creditPullId: null,
      creditPullIsSimulated: false,
    };
    expect(financialVerificationEvidenceError("credit", noPull)).toMatch(/real bureau credit report/i);

    const simulated = { ...noPull, creditPullId: "pull-sim", creditPullIsSimulated: true };
    expect(financialVerificationEvidenceError("credit", simulated)).toMatch(/simulated credit cannot/i);

    const real = { ...simulated, creditPullId: "pull-real", creditPullIsSimulated: false };
    expect(financialVerificationEvidenceError("credit", real)).toBeNull();
  });

  it("does not let an income-only approved memo verify assets", () => {
    const incomeOnly = {
      approvedMemoId: "memo-1",
      approvedIncomeWorkpaperId: "wp-income",
      approvedAssetWorkpaperId: null,
      creditPullId: "pull-real",
      creditPullIsSimulated: false,
    };
    expect(financialVerificationEvidenceError("income", incomeOnly)).toBeNull();
    expect(financialVerificationEvidenceError("assets", incomeOnly)).toMatch(/asset reconciliation/i);
  });
});
