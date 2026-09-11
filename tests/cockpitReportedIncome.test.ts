import { describe, expect, it } from "vitest";
import { buildReportedIncomeStory } from "../server/routes/cockpit";
import type { LoanApplication } from "@shared/schema";

describe("loan-officer reported income story", () => {
  it("reconciles the household total, complex sources, and rental planning offset", () => {
    const result = buildReportedIncomeStory({
      annualIncome: "180000",
      employmentType: "employed",
      incomeSources: [
        {
          type: "self_employed",
          annualAmount: "50000",
          employerName: "North Star Consulting",
          yearsInRole: "4",
          businessStructure: "single_member_llc",
          ownershipPercent: "100",
        },
        {
          type: "rental",
          annualAmount: "51600",
          rentalProperties: [
            { address: "A", monthlyRentalIncome: "2500", monthlyDebtPayment: "1500" },
            { address: "B", monthlyRentalIncome: "1800", monthlyDebtPayment: "1000" },
          ],
        },
      ],
    } as Pick<LoanApplication, "annualIncome" | "employmentType" | "incomeSources">);

    expect(result.householdAnnualTotal).toBe(180000);
    expect(result.detailedAnnualTotal).toBe(101600);
    expect(result.unitemizedAnnualAmount).toBe(78400);
    expect(result.sources[0]).toMatchObject({
      type: "self_employed",
      annualAmount: 50000,
      name: "North Star Consulting",
    });
    expect(result.rental).toEqual({
      propertyCount: 2,
      grossMonthlyRent: 4300,
      planningMonthlyRent: 3225,
      monthlyPropertyPayments: 2500,
      preliminaryMonthlyOffset: 725,
    });
  });

  it("flags a contradictory source breakdown instead of hiding it", () => {
    const result = buildReportedIncomeStory({
      annualIncome: "100000",
      employmentType: "employed",
      incomeSources: [{ type: "self_employed", annualAmount: "120000" }],
    } as Pick<LoanApplication, "annualIncome" | "employmentType" | "incomeSources">);

    expect(result.breakdownExceedsHouseholdTotal).toBe(true);
    expect(result.unitemizedAnnualAmount).toBe(0);
  });
});
