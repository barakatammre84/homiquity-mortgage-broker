import { describe, it, expect } from "vitest";
import { determineDocumentRequirements } from "../server/pipelineEngine";

const baseProfile = {
  employmentYears: 3,
  annualIncome: 90000,
  creditScore: 720,
  ltvRatio: 90,
  loanPurpose: "purchase",
  propertyType: "single_family",
  propertyAddress: null,
  isVeteran: false,
  isFirstTimeBuyer: false,
  isSelfEmployed: false,
  hasRentalIncome: false,
};

describe("determineDocumentRequirements - employmentType 'other'", () => {
  it("does not silently ask an 'other' borrower for a W-2 (the 'employed' bucket)", () => {
    const requirements = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "other",
    });
    const documentTypes = requirements.map((r) => r.documentType);
    expect(documentTypes).not.toContain("w2");
  });

  it("asks an 'other' borrower for 2 years of tax returns instead", () => {
    const requirements = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "other",
    });
    const taxReturn = requirements.find((r) => r.documentType === "tax_return");
    expect(taxReturn).toBeDefined();
    expect(taxReturn?.yearsRequired).toEqual([
      new Date().getFullYear() - 1,
      new Date().getFullYear() - 2,
    ]);
  });

  it("still asks 'employed' borrowers for a W-2 (no regression)", () => {
    const requirements = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "employed",
    });
    const documentTypes = requirements.map((r) => r.documentType);
    expect(documentTypes).toContain("w2");
  });

  it("does not ask a self-employed borrower for pay stubs", () => {
    const requirements = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "self_employed",
      isSelfEmployed: true,
    });
    const documentTypes = requirements.map((requirement) => requirement.documentType);
    expect(documentTypes).not.toContain("pay_stub");
    expect(documentTypes).toContain("tax_return");
    expect(documentTypes).toContain("profit_loss");
    expect(documentTypes).toContain("business_license");
    expect(documentTypes).toContain("bank_statement_business");
  });

  it("does not ask a shopping borrower for a contract or insurance before a home is identified", () => {
    const documentTypes = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "self_employed",
      isSelfEmployed: true,
    }).map((requirement) => requirement.documentType);

    expect(documentTypes).not.toContain("purchase_contract");
    expect(documentTypes).not.toContain("homeowners_insurance");
  });

  it("adds purchase property documents once a home is identified", () => {
    const documentTypes = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "employed",
      propertyAddress: "101 Fictional Way",
    }).map((requirement) => requirement.documentType);

    expect(documentTypes).toContain("purchase_contract");
    expect(documentTypes).toContain("homeowners_insurance");
  });

  it("never asks a refinance borrower for a purchase contract", () => {
    const documentTypes = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "employed",
      loanPurpose: "refinance",
      propertyAddress: "101 Fictional Way",
    }).map((requirement) => requirement.documentType);

    expect(documentTypes).not.toContain("purchase_contract");
    expect(documentTypes).toContain("homeowners_insurance");
  });

  it("asks a W-2 borrower with rental income for Schedule E and current leases", () => {
    const requirements = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "employed",
      hasRentalIncome: true,
    });

    const taxReturn = requirements.find((requirement) => requirement.documentType === "tax_return");
    expect(taxReturn?.conditionTitle).toContain("Schedule E");
    expect(taxReturn?.description).toContain("Schedule E");
    expect(taxReturn?.priority).toBe("prior_to_approval");
    expect(requirements.some((requirement) => requirement.documentType === "lease_agreement")).toBe(true);
  });
});
