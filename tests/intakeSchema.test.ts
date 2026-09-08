import { describe, expect, it } from "vitest";
import {
  CREDIT_SCORE_UNKNOWN_DEFAULT,
  loanApplicationIntakeSchema,
  loanApplicationIntakeUpdateSchema,
  preApprovalFormSchema,
} from "../shared/schema";

/**
 * Client/server validation unification — the server-side intake schema is
 * derived from the same base the funnel validates with, so the server must
 * reject exactly what the client rejects (no silent clamps fabricating data).
 */

const VALID_INTAKE = {
  annualIncome: "95,000",
  employmentType: "employed",
  employmentYears: "4",
  monthlyDebts: "850",
  creditScore: "720",
  loanPurpose: "purchase",
  occupancyType: "primary_residence",
  propertyType: "single_family",
  purchasePrice: "$450,000",
  downPayment: "45,000",
  isVeteran: false,
  isFirstTimeBuyer: true,
  propertyState: "CA",
  softPullConsentAccepted: true,
};

describe("loanApplicationIntakeSchema (server) mirrors the funnel schema (client)", () => {
  it("accepts the canonical funnel payload and normalizes it", () => {
    const parsed = loanApplicationIntakeSchema.parse(VALID_INTAKE);
    expect(parsed.annualIncome).toBe("95000");
    expect(parsed.purchasePrice).toBe("450000");
    expect(parsed.creditScore).toBe(720);
    expect(parsed.employmentYears).toBe(4);
  });

  it("maps 'not_sure' credit to the named default instead of a hidden clamp", () => {
    const parsed = loanApplicationIntakeSchema.parse({ ...VALID_INTAKE, creditScore: "not_sure" });
    expect(parsed.creditScore).toBe(CREDIT_SCORE_UNKNOWN_DEFAULT);
  });

  it("REJECTS out-of-band credit scores the old server schema silently clamped", () => {
    expect(loanApplicationIntakeSchema.safeParse({ ...VALID_INTAKE, creditScore: "900" }).success).toBe(false);
    expect(loanApplicationIntakeSchema.safeParse({ ...VALID_INTAKE, creditScore: "abc" }).success).toBe(false);
  });

  it("REJECTS missing required fields instead of defaulting them to 0", () => {
    const { annualIncome: _a, ...noIncome } = VALID_INTAKE;
    expect(loanApplicationIntakeSchema.safeParse(noIncome).success).toBe(false);
    const { employmentYears: _e, ...noYears } = VALID_INTAKE;
    expect(loanApplicationIntakeSchema.safeParse(noYears).success).toBe(false);
  });

  it("rejects down payment above purchase price (same rule as client)", () => {
    const bad = { ...VALID_INTAKE, downPayment: "500,000" };
    expect(loanApplicationIntakeSchema.safeParse(bad).success).toBe(false);
    expect(preApprovalFormSchema.safeParse({ ...bad, hasAdditionalIncome: false }).success).toBe(false);
  });

  it("rejects a source breakdown above the household total on both sides", () => {
    const bad = {
      ...VALID_INTAKE,
      hasAdditionalIncome: true,
      annualIncome: "40,000",
      incomeSources: [{ type: "investment", annualAmount: "50,000" }],
    };
    expect(preApprovalFormSchema.safeParse(bad).success).toBe(false);
    expect(loanApplicationIntakeSchema.safeParse(bad).success).toBe(false);
  });

  it("requires business identity, history, structure, and ownership for complex income", () => {
    const incomplete = {
      ...VALID_INTAKE,
      hasAdditionalIncome: true,
      incomeSources: [{ type: "self_employed", annualAmount: "45,000" }],
    };
    expect(preApprovalFormSchema.safeParse(incomplete).success).toBe(false);
    expect(loanApplicationIntakeSchema.safeParse(incomplete).success).toBe(false);

    const complete = {
      ...incomplete,
      incomeSources: [{
        type: "self_employed",
        annualAmount: "45,000",
        employerName: "Harbor Studio LLC",
        yearsInRole: "4",
        businessStructure: "single_member_llc",
        ownershipPercent: 100,
      }],
    };
    const parsed = loanApplicationIntakeSchema.parse(complete);
    expect(parsed.incomeSources?.[0]).toMatchObject({
      businessStructure: "single_member_llc",
      ownershipPercent: "100",
    });
  });

  it("tolerates JSON numbers where forms send strings", () => {
    const parsed = loanApplicationIntakeSchema.parse({
      ...VALID_INTAKE,
      annualIncome: 95000,
      employmentYears: 4,
      creditScore: 720,
      purchasePrice: 450000,
      downPayment: 45000,
      monthlyDebts: 850,
    });
    expect(parsed.annualIncome).toBe("95000");
    expect(parsed.creditScore).toBe(720);
  });

  it("normalizes subject-property intent without inventing it", () => {
    const parsed = loanApplicationIntakeSchema.parse({
      ...VALID_INTAKE,
      occupancyType: "investment",
      propertyType: "multi_family",
      numberOfUnits: 3,
      subjectMonthlyRentalIncome: 4200,
    });
    expect(parsed.occupancyType).toBe("investment");
    expect(parsed.numberOfUnits).toBe(3);
    expect(parsed.subjectMonthlyRentalIncome).toBe("4200");

    const withoutOccupancy = { ...VALID_INTAKE } as Record<string, unknown>;
    delete withoutOccupancy.occupancyType;
    expect(loanApplicationIntakeSchema.parse(withoutOccupancy).occupancyType).toBeUndefined();

    const primary = loanApplicationIntakeSchema.parse({
      ...VALID_INTAKE,
      numberOfUnits: "",
      subjectMonthlyRentalIncome: "",
    });
    expect(primary.numberOfUnits).toBe(1);
    expect(primary.subjectMonthlyRentalIncome).toBeNull();
  });

  it("removes rental answers that no longer apply after the borrower changes the property", () => {
    const primary = loanApplicationIntakeSchema.parse({
      ...VALID_INTAKE,
      propertyType: "single_family",
      occupancyType: "primary_residence",
      numberOfUnits: "3",
      subjectMonthlyRentalIncome: "4,200",
    });

    expect(primary.numberOfUnits).toBe(1);
    expect(primary.subjectMonthlyRentalIncome).toBeNull();
  });

  it("requires the subject-property details in the borrower funnel", () => {
    const multiFamily = {
      ...VALID_INTAKE,
      hasAdditionalIncome: false,
      propertyType: "multi_family",
      numberOfUnits: "3",
      subjectMonthlyRentalIncome: "4,200",
    };
    expect(preApprovalFormSchema.safeParse(multiFamily).success).toBe(true);
    expect(preApprovalFormSchema.safeParse({ ...multiFamily, numberOfUnits: "" }).success).toBe(false);
    expect(preApprovalFormSchema.safeParse({ ...multiFamily, subjectMonthlyRentalIncome: "" }).success).toBe(false);

    const noOccupancy = { ...VALID_INTAKE, hasAdditionalIncome: false } as Record<string, unknown>;
    delete noOccupancy.occupancyType;
    expect(preApprovalFormSchema.safeParse(noOccupancy).success).toBe(false);
  });

  it("update variant validates present fields and leaves absent ones alone", () => {
    const parsed = loanApplicationIntakeUpdateSchema.parse({ annualIncome: "110,000" });
    expect(parsed.annualIncome).toBe("110000");
    expect(parsed.creditScore).toBeUndefined();
    expect(loanApplicationIntakeUpdateSchema.safeParse({ employmentYears: "999" }).success).toBe(false);
  });
});
