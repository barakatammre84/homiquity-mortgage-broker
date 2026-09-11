import { createHash } from "node:crypto";
import { detectSignificantDeposits, type DepositoryTransaction } from "./underwritingNuance";

export type LargeDepositSourcingFinding = {
  sourceRule: string;
  largest: { amount: number; date: string; threshold: number };
  depositCount: number;
  totalFlaggedAmount: number;
  reason: string;
  requiredDocs: Array<{ documentType: string; description: string }>;
};

/**
 * B3-4.2-02 review trigger, expressed once for both pre-underwriting and the
 * reviewed asset workpaper. The source rule fingerprints the actual deposit
 * set and income threshold, so clearing yesterday's wire cannot clear a new
 * deposit silently.
 */
export function assessLargeDepositSourcing(
  transactions: DepositoryTransaction[] | null | undefined,
  qualifyingMonthlyIncome: number,
): LargeDepositSourcingFinding | null {
  const deposits = detectSignificantDeposits(transactions, qualifyingMonthlyIncome)
    .sort((a, b) => b.amount - a.amount || a.date.localeCompare(b.date));
  if (deposits.length === 0) return null;
  const largest = deposits[0];
  const fingerprint = createHash("sha256").update(JSON.stringify({
    qualifyingMonthlyIncome: Number(qualifyingMonthlyIncome.toFixed(2)),
    deposits: deposits.map(deposit => ({
      amount: Number(deposit.amount.toFixed(2)),
      date: deposit.date,
      threshold: Number(deposit.threshold.toFixed(2)),
    })),
  })).digest("hex").slice(0, 20);
  return {
    sourceRule: `AUTOPILOT_LARGE_DEPOSIT_SOURCING:${fingerprint}`,
    largest,
    depositCount: deposits.length,
    totalFlaggedAmount: Number(deposits.reduce((sum, deposit) => sum + deposit.amount, 0).toFixed(2)),
    reason: `We noticed a deposit of $${Math.round(largest.amount).toLocaleString()} on ${largest.date}. Deposits above 50% of monthly qualifying income ($${Math.round(largest.threshold).toLocaleString()}) must be sourced — a gift letter if it came from family, or documentation of the sale or transfer otherwise.`,
    requiredDocs: [
      { documentType: "gift_letter", description: "Signed gift letter and donor transfer confirmation, if the funds were a gift" },
      { documentType: "other", description: "Sourcing documentation, such as a sale settlement or transfer records, otherwise" },
    ],
  };
}
