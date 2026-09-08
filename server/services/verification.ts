import { storage } from "../storage";
import { recalculateDecision } from "./decisionEngine";

// =============================================================================
// VERIFICATION ROLL-UP
//
// Fact-based lending requires knowing WHICH figures are verified, not just a
// single flag. Income, assets, and credit are verified independently (by a
// document review, a credit pull, or — later — Plaid/Argyle/The Work Number).
// When all three are verified, the application's financialDataProvenance
// auto-promotes to "verified", which is what the decision gate requires for a
// binding outcome. Each change also triggers a decision recalc.
// =============================================================================

export type VerificationDimension = "income" | "assets" | "credit";

const FIELD: Record<VerificationDimension, "incomeVerified" | "assetsVerified" | "creditVerified"> = {
  income: "incomeVerified",
  assets: "assetsVerified",
  credit: "creditVerified",
};

export async function markDimensionVerified(
  applicationId: string,
  dimension: VerificationDimension,
  verifiedBy?: string,
): Promise<void> {
  const app = await storage.getLoanApplication(applicationId);
  if (!app) return;

  await storage.updateLoanApplication(applicationId, { [FIELD[dimension]]: true });

  // Re-read after the dimension write. Two reviewers can finish different
  // dimensions at the same time; calculating from the pre-write row let both
  // updates commit while neither saw the other's flag, leaving all three true
  // but the application stuck at self_reported.
  const current = await storage.getLoanApplication(applicationId);
  if (!current) return;
  const income = current.incomeVerified;
  const assets = current.assetsVerified;
  const credit = current.creditVerified;

  if (income && assets && credit && current.financialDataProvenance !== "verified") {
    await storage.updateLoanApplication(applicationId, {
      financialDataProvenance: "verified",
      financialDataVerifiedAt: new Date(),
      ...(verifiedBy ? { financialDataVerifiedBy: verifiedBy } : {}),
    });
    await recalculateDecision(applicationId, "verified");
  } else {
    await recalculateDecision(applicationId, `${dimension}_verified`);
  }
}
