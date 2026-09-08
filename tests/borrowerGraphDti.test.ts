import { describe, expect, it } from "vitest";
import {
  applicationReportedIncomeRecords,
  usableApplicationDti,
} from "../server/services/borrowerGraph";

describe("borrower graph DTI publication", () => {
  it("treats the application default as uncalculated", () => {
    expect(usableApplicationDti("0.00")).toBeNull();
    expect(usableApplicationDti(0)).toBeNull();
  });

  it("publishes a real calculated ratio", () => {
    expect(usableApplicationDti("37.42")).toBe(37.42);
  });
});

describe("borrower graph application income", () => {
  it("keeps source detail visible without adding it to the household total again", () => {
    const records = applicationReportedIncomeRecords("170,000", [
      {
        type: "self_employed",
        annualAmount: "45,000",
        employerName: "Harbor Studio LLC",
      },
    ]);

    expect(records).toEqual([
      expect.objectContaining({
        type: "application_stated_household_total",
        amount: 170_000,
        includedInBestIncome: true,
      }),
      expect.objectContaining({
        type: "self_employed",
        amount: 45_000,
        employerName: "Harbor Studio LLC",
        includedInBestIncome: false,
      }),
    ]);
    expect(
      records
        .filter((record) => record.includedInBestIncome !== false)
        .reduce((sum, record) => sum + record.amount, 0),
    ).toBe(170_000);
  });

  it("uses detailed sources when no household aggregate exists", () => {
    const records = applicationReportedIncomeRecords(null, [
      { type: "self_employed", annualAmount: "45,000" },
      { type: "rental", annualAmount: "24,000" },
    ]);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.includedInBestIncome)).toBe(true);
  });
});
