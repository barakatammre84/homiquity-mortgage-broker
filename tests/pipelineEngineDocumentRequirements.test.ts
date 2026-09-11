import { describe, it, expect } from "vitest";
import { determineDocumentRequirements, getBorrowerProfileFromApplication } from "../server/pipelineEngine";
import type { LoanApplication } from "../shared/schema";

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
  businessNames: [],
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
    expect(requirements.map((requirement) => requirement.documentType)).not.toContain("other");
  });

  it("still asks 'employed' borrowers for a W-2 (no regression)", () => {
    const requirements = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "employed",
    });
    const documentTypes = requirements.map((r) => r.documentType);
    expect(documentTypes).toContain("w2");
  });

  it("does not infer gift funds from a down payment below 20 percent", () => {
    const requirements = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "employed",
      ltvRatio: 90,
    });

    expect(requirements.map((requirement) => requirement.documentType)).not.toContain("gift_letter");
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

  it("names every self-employed business and preserves both business and rental return needs", () => {
    const requirements = determineDocumentRequirements({
      ...baseProfile,
      employmentType: "self_employed",
      isSelfEmployed: true,
      hasRentalIncome: true,
      businessNames: ["Northstar Design LLC", "Lakeshore Consulting Inc"],
    });

    const combined = requirements.map((requirement) => `${requirement.conditionTitle} ${requirement.description}`).join("\n");
    expect(combined).toContain("Northstar Design LLC");
    expect(combined).toContain("Lakeshore Consulting Inc");
    expect(combined).toMatch(/personal.*returns/i);
    expect(combined).toMatch(/business returns/i);
    expect(combined).toContain("Schedule E");
    expect(combined).toMatch(/K-1/i);
  });

  it("keeps W-2 documents and adds full business documents for a side business", () => {
    const profile = getBorrowerProfileFromApplication({
      employmentType: "employed",
      incomeSources: [
        { type: "w2", annualAmount: "125000" },
        { type: "self_employed", annualAmount: "45000", employerName: "Harbor Studio LLC" },
      ],
      purchasePrice: "600000",
      downPayment: "120000",
    } as unknown as LoanApplication);
    const requirements = determineDocumentRequirements(profile);
    const types = requirements.map((requirement) => requirement.documentType);
    const taxReturn = requirements.find((requirement) => requirement.documentType === "tax_return");

    expect(profile.isSelfEmployed).toBe(true);
    expect(types).toContain("w2");
    expect(types).toContain("profit_loss");
    expect(types).toContain("business_license");
    expect(types).toContain("bank_statement_business");
    expect(taxReturn?.yearsRequired).toHaveLength(2);
    expect(taxReturn?.description).toContain("Harbor Studio LLC");
  });
});
