import { describe, expect, it } from "vitest";
import { reportedIncomeDetailBlockers } from "../server/services/financialReview";

describe("reported income coverage in financial review", () => {
  it("blocks a fast mixed-income total until its W-2 and business details exist", () => {
    const blockers = reportedIncomeDetailBlockers({
      primaryEmploymentType: "employed",
      incomeSources: [
        { type: "w2", annualAmount: "78000" },
        {
          type: "self_employed",
          annualAmount: "50000",
          employerName: "North Star Consulting",
          businessStructure: "single_member_llc",
          ownershipPercent: "100",
        },
        {
          type: "rental",
          annualAmount: "51600",
          rentalProperties: [{ address: "10 Rental Way", monthlyRentalIncome: "4300" }],
        },
      ],
      employment: [],
      otherIncome: [],
    } as any);

    expect(blockers).toEqual([
      expect.objectContaining({ message: expect.stringContaining("full employment record") }),
      expect.objectContaining({ message: expect.stringContaining("North Star Consulting") }),
    ]);
    expect(blockers.some(blocker => /rental/i.test(blocker.message))).toBe(false);
  });

  it("requires the primary employed record when fast intake did not itemize it", () => {
    const blockers = reportedIncomeDetailBlockers({
      primaryEmploymentType: "employed",
      incomeSources: [{ type: "self_employed", annualAmount: "50000", employerName: "North Star Consulting" }],
      employment: [],
      otherIncome: [],
    } as any);

    expect(blockers).toEqual([
      expect.objectContaining({ message: expect.stringContaining("primary borrower") }),
      expect.objectContaining({ message: expect.stringContaining("North Star Consulting") }),
    ]);
  });

  it("clears only when each reported component has its own detailed record", () => {
    const blockers = reportedIncomeDetailBlockers({
      primaryEmploymentType: "employed",
      incomeSources: [
        { type: "w2", annualAmount: "78000", employerName: "Acme" },
        { type: "self_employed", annualAmount: "50000", employerName: "North Star Consulting" },
        { type: "social_security", annualAmount: "18000" },
      ],
      employment: [
        { id: "w2", employerName: "Acme", isSelfEmployed: false, selfEmploymentIncome: null, paidInVirtualCurrency: false },
        {
          id: "business",
          employerName: "North Star Consulting",
          isSelfEmployed: true,
          paidInVirtualCurrency: false,
          selfEmploymentIncome: { version: 1, businessStructure: "single_member_llc" },
        },
      ],
      otherIncome: [{
        id: "ssa",
        incomeSource: "social_security",
        monthlyAmount: "1500",
        taxTreatment: "fully_non_taxable",
        nonTaxableMonthlyAmount: null,
        hasDefinedExpiration: false,
        expirationDate: null,
        paidInVirtualCurrency: false,
      }],
    } as any);

    expect(blockers).toEqual([]);
  });

  it("blocks approval until tax treatment and continuance are answered", () => {
    const blockers = reportedIncomeDetailBlockers({
      incomeSources: [],
      employment: [],
      otherIncome: [{
        id: "ssa",
        incomeSource: "Social Security",
        monthlyAmount: "1500",
        taxTreatment: "unknown",
        nonTaxableMonthlyAmount: null,
        hasDefinedExpiration: null,
        expirationDate: null,
        paidInVirtualCurrency: false,
      }],
    });
    expect(blockers.map(blocker => blocker.message).join(" ")).toMatch(/federal income tax/i);
    expect(blockers.map(blocker => blocker.message).join(" ")).toMatch(/expiration date/i);
  });

  it("does not let an unrelated employment row hide a named source", () => {
    const blockers = reportedIncomeDetailBlockers({
      incomeSources: [{ type: "w2", annualAmount: "78000", employerName: "Acme" }],
      employment: [{ id: "other", employerName: "Different Employer", isSelfEmployed: false, selfEmploymentIncome: null, paidInVirtualCurrency: false }],
      otherIncome: [],
    } as any);

    expect(blockers).toHaveLength(1);
  });
});
