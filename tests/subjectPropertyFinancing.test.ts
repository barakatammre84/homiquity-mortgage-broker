import { describe, expect, it } from "vitest";
import { assessSubjectPropertyFinancing } from "@shared/subjectPropertyFinancing";

describe("subject-property housing expense and combined liens", () => {
  it("keeps the fast estimate lightweight before the full property section exists", () => {
    const result = assessSubjectPropertyFinancing({
      propertyInfo: null,
      firstMortgageAmount: 400_000,
      salesPrice: 500_000,
      appraisedValue: 500_000,
    });
    expect(result).toMatchObject({ captured: false, complete: true, missingItems: [], cltv: null, hcltv: null });
  });

  it("treats unanswered lender-ready costs as gaps rather than zero", () => {
    const result = assessSubjectPropertyFinancing({
      propertyInfo: { monthlyAssociationDues: "350" },
      firstMortgageAmount: 400_000,
      salesPrice: 500_000,
      appraisedValue: 500_000,
      associationDuesRequired: true,
    });
    expect(result.complete).toBe(false);
    expect(result.missingItems.join(" ")).toMatch(/flood-insurance/i);
    expect(result.missingItems.join(" ")).toMatch(/ground rent/i);
    expect(result.missingItems.join(" ")).toMatch(/special assessments/i);
    expect(result.missingItems.join(" ")).toMatch(/another new loan or HELOC/i);
  });

  it("adds all B3-6-03 costs and calculates CLTV from drawn funds and HCLTV from the full HELOC line", () => {
    const result = assessSubjectPropertyFinancing({
      propertyInfo: {
        monthlyAssociationDues: "350",
        monthlyFloodInsurance: "125",
        monthlyGroundRent: "40",
        monthlySpecialAssessments: "85",
        subordinateFinancingExists: true,
        closedEndSubordinateBalance: "20,000",
        helocDrawnBalance: "10,000",
        helocCreditLimit: "50,000",
        monthlySubordinateFinancingPayment: "225",
      },
      firstMortgageAmount: 400_000,
      salesPrice: 500_000,
      appraisedValue: 490_000,
      associationDuesRequired: true,
    });
    expect(result).toMatchObject({
      complete: true,
      monthlyHousingExpenseAdditions: 825,
      cltv: 87.7551,
      hcltv: 95.9184,
    });
  });

  it("rejects a drawn HELOC balance above the recorded credit limit", () => {
    const result = assessSubjectPropertyFinancing({
      propertyInfo: {
        monthlyFloodInsurance: 0,
        monthlyGroundRent: 0,
        monthlySpecialAssessments: 0,
        subordinateFinancingExists: true,
        closedEndSubordinateBalance: 0,
        helocDrawnBalance: 60_000,
        helocCreditLimit: 50_000,
        monthlySubordinateFinancingPayment: 200,
      },
      firstMortgageAmount: 400_000,
      salesPrice: 500_000,
      appraisedValue: 500_000,
    });
    expect(result.complete).toBe(false);
    expect(result.missingItems).toContain("HELOC credit limit must be at least the amount drawn");
    expect(result.cltv).toBeNull();
    expect(result.hcltv).toBeNull();
  });
});
