import { describe, expect, it } from "vitest";
import { assessLargeDepositSourcing } from "../server/services/largeDepositSourcing";

describe("large-deposit sourcing control", () => {
  it("creates a stable evidence-specific condition from qualifying income", () => {
    const transactions = [
      { amount: -12_000, date: "2026-08-01", description: "WIRE" },
      { amount: -2_000, date: "2026-08-15", description: "PAYROLL" },
    ];
    const first = assessLargeDepositSourcing(transactions, 6_000);
    const replay = assessLargeDepositSourcing(transactions, 6_000);
    expect(first).not.toBeNull();
    expect(first?.sourceRule).toMatch(/^AUTOPILOT_LARGE_DEPOSIT_SOURCING:[a-f0-9]{20}$/);
    expect(replay?.sourceRule).toBe(first?.sourceRule);
    expect(first).toMatchObject({ depositCount: 1, totalFlaggedAmount: 12_000 });
  });

  it("changes the condition identity when the evidence or reviewed income changes", () => {
    const transactions = [{ amount: -12_000, date: "2026-08-01" }];
    const original = assessLargeDepositSourcing(transactions, 6_000);
    const differentIncome = assessLargeDepositSourcing(transactions, 8_000);
    const differentDeposit = assessLargeDepositSourcing([{ amount: -13_000, date: "2026-08-01" }], 6_000);
    expect(differentIncome?.sourceRule).not.toBe(original?.sourceRule);
    expect(differentDeposit?.sourceRule).not.toBe(original?.sourceRule);
  });

  it("returns no condition when no transaction crosses half of qualifying monthly income", () => {
    expect(assessLargeDepositSourcing([{ amount: -2_500, date: "2026-08-01" }], 6_000)).toBeNull();
  });
});
