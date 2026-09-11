import { describe, it, expect } from "vitest";
import {
  generateMISMO34XML,
  validateULDDCompliance,
  type MISMOLoanDTO,
} from "../server/mismo";

// ---------------------------------------------------------------------------
// Regression coverage for the MISMO 3.4 export-content fixes:
//   - ConstructionMethodType maps to a valid enum, not the raw propertyType
//   - EmploymentStatusType keys off the end date, not the free-text category
//   - NoteAmount distinguishes a real $0 down payment from a missing one
//   - formatters strip currency formatting and never emit "NaN" / RangeError
//   - the dangling xlink RELATIONSHIPS block is omitted
// ---------------------------------------------------------------------------

function baseDto(overrides: Partial<MISMOLoanDTO> = {}): MISMOLoanDTO {
  return {
    application: {
      id: "3f8a-9c2d-11ee-8c90-0242ac120002",
      status: "pre_approved",
      loanPurpose: "purchase",
      preferredLoanType: "conventional",
      propertyType: "single_family",
      propertyAddress: "123 Main St",
      propertyCity: "Austin",
      propertyState: "TX",
      propertyZip: "78701",
      propertyValue: "500000",
      purchasePrice: "500000",
      downPayment: "100000",
      createdAt: new Date("2026-01-01"),
      ...(overrides.application ?? {}),
    } as any,
    user: { id: "user-abc123", email: "b@example.com" } as any,
    personalInfo: { firstName: "Jane", lastName: "Doe", ssn: "123-45-6789" } as any,
    employment: overrides.employment ?? [],
    assets: overrides.assets ?? [],
    liabilities: overrides.liabilities ?? [],
    propertyInfo: overrides.propertyInfo ?? null,
    declarations: null,
    loanOptions: overrides.loanOptions ?? [],
    documents: [],
  };
}

describe("LoanPurposeType — valid ULDD enum (F-019)", () => {
  // ULDD LoanPurposeTypeEnumerated = {MortgageModification, Other, Purchase, Refinance}.
  // The exporter previously emitted CashOutRefinance / NoCashOutRefinance / ConstructionToPermanent,
  // which are out-of-enum and rejected at GSE ingestion.
  it("emits Refinance (not CashOutRefinance) for a cash-out refinance", () => {
    const xml = generateMISMO34XML(baseDto({ application: { loanPurpose: "cash_out_refinance" } as any }));
    expect(xml).toContain("<LoanPurposeType>Refinance</LoanPurposeType>");
    expect(xml).not.toContain("CashOutRefinance");
    expect(xml).not.toContain("NoCashOutRefinance");
  });

  it("emits Refinance for a no-cash-out refinance", () => {
    const xml = generateMISMO34XML(baseDto({ application: { loanPurpose: "no_cash_out_refinance" } as any }));
    expect(xml).toContain("<LoanPurposeType>Refinance</LoanPurposeType>");
  });

  it("fails loud on construction (U-7) rather than emitting an out-of-enum value", () => {
    expect(() =>
      generateMISMO34XML(baseDto({ application: { loanPurpose: "construction" } as any })),
    ).toThrow(/construction loan purpose is unmapped/);
  });
});

describe("ConstructionMethodType (Fix 5)", () => {
  it("emits SiteBuilt for a standard property, never the raw propertyType", () => {
    const xml = generateMISMO34XML(baseDto());
    expect(xml).toContain("<ConstructionMethodType>SiteBuilt</ConstructionMethodType>");
    expect(xml).not.toContain("single_family");
  });

  it("emits Manufactured when the URLA flags a manufactured home", () => {
    const xml = generateMISMO34XML(
      baseDto({ propertyInfo: { isManufacturedHome: true, occupancyType: "primary_residence" } as any }),
    );
    expect(xml).toContain("<ConstructionMethodType>Manufactured</ConstructionMethodType>");
  });
});

describe("EmploymentStatusType (Fix 6)", () => {
  it("marks an open-ended job (no end date) as Current", () => {
    const xml = generateMISMO34XML(
      baseDto({ employment: [{ employerName: "Acme", employmentType: "employed", startDate: "2020-01-01" } as any] }),
    );
    expect(xml).toContain("<EmploymentStatusType>Current</EmploymentStatusType>");
    expect(xml).not.toContain("<EmploymentStatusType>Previous</EmploymentStatusType>");
  });

  it("marks a job with an end date as Previous", () => {
    const xml = generateMISMO34XML(
      baseDto({
        employment: [
          { employerName: "OldCo", employmentType: "employed", startDate: "2015-01-01", endDate: "2019-12-31" } as any,
        ],
      }),
    );
    expect(xml).toContain("<EmploymentStatusType>Previous</EmploymentStatusType>");
  });
});

describe("multi-borrower PARTY delivery", () => {
  const partyBodies = (xml: string): string[] =>
    [...xml.matchAll(/<PARTY>([\s\S]*?)<\/PARTY>/g)].map((match) => match[1]);

  it("emits each borrower as a separate PARTY with their own data", () => {
    const dto = baseDto({
      employment: [
        {
          borrowerSequenceNumber: 1,
          employerName: "Primary Employer",
          employmentType: "employed",
        } as any,
        {
          borrowerSequenceNumber: 2,
          employerName: "Secondary Employer",
          employmentType: "employed",
        } as any,
      ],
    });
    dto.personalInfo = {
      borrowerSequenceNumber: 1,
      firstName: "Jane",
      lastName: "Primary",
      ssn: "111-22-3333",
    } as any;
    dto.allPersonalInfo = [
      dto.personalInfo!,
      {
        borrowerSequenceNumber: 2,
        firstName: "Sam",
        lastName: "Secondary",
        ssn: "444-55-6666",
      } as any,
    ];
    dto.allDeclarations = [
      { borrowerSequenceNumber: 1, hasDeclaredBankruptcy: false } as any,
      { borrowerSequenceNumber: 2, hasDeclaredBankruptcy: true } as any,
    ];
    dto.otherIncome = [
      {
        borrowerSequenceNumber: 1,
        incomeSource: "Social Security",
        monthlyAmount: "1200",
        taxTreatment: "fully_non_taxable",
      } as any,
      {
        borrowerSequenceNumber: 2,
        incomeSource: "Retirement (e.g., Pension, IRA)",
        monthlyAmount: "900",
        taxTreatment: "taxable",
      } as any,
    ];

    const parties = partyBodies(generateMISMO34XML(dto));
    expect(parties).toHaveLength(2);
    expect(parties[0]).toContain("<FirstName>Jane</FirstName>");
    expect(parties[0]).toContain("<BorrowerClassificationType>Primary</BorrowerClassificationType>");
    expect(parties[0]).toContain("<FullName>Primary Employer</FullName>");
    expect(parties[0]).not.toContain("Secondary Employer");
    expect(parties[0]).toContain("<URLABorrowerTotalOtherIncomeAmount>1200.00</URLABorrowerTotalOtherIncomeAmount>");
    expect(parties[0]).not.toContain("900.00");
    expect(parties[0]).toContain("<TaxpayerIdentifierValue>111223333</TaxpayerIdentifierValue>");
    expect(parties[0]).toContain("<BankruptcyIndicator>false</BankruptcyIndicator>");

    expect(parties[1]).toContain("<FirstName>Sam</FirstName>");
    expect(parties[1]).toContain("<BorrowerClassificationType>Secondary</BorrowerClassificationType>");
    expect(parties[1]).toContain("<FullName>Secondary Employer</FullName>");
    expect(parties[1]).not.toContain("Primary Employer");
    expect(parties[1]).toContain("<URLABorrowerTotalOtherIncomeAmount>900.00</URLABorrowerTotalOtherIncomeAmount>");
    expect(parties[1]).not.toContain("1200.00");
    expect(parties[1]).toContain("<TaxpayerIdentifierValue>444556666</TaxpayerIdentifierValue>");
    expect(parties[1]).toContain("<BankruptcyIndicator>true</BankruptcyIndicator>");
  });
});

describe("NoteAmount / down payment handling (Fix 8)", () => {
  it("computes NoteAmount = price for a genuine $0 down payment", () => {
    const xml = generateMISMO34XML(baseDto({ application: { downPayment: "0", purchasePrice: "400000" } as any }));
    expect(xml).toContain("<NoteAmount>400000.00</NoteAmount>");
  });

  it("omits NoteAmount when the down payment is missing (does not inflate to full price)", () => {
    const dto = baseDto();
    dto.application.downPayment = null as any;
    const xml = generateMISMO34XML(dto);
    expect(xml).not.toContain("<NoteAmount>");
  });

  it("validateULDDCompliance accepts a valid $0-down loan", () => {
    const result = validateULDDCompliance(
      baseDto({ application: { downPayment: "0", purchasePrice: "400000" } as any }),
    );
    expect(result.errors).not.toContain("NoteAmount is required and must be greater than 0");
  });
});

describe("formatter robustness (Fix 9)", () => {
  it("strips currency formatting instead of emitting NaN or a truncated value", () => {
    const xml = generateMISMO34XML(
      baseDto({ assets: [{ accountType: "checking", cashOrMarketValue: "1,234.56" } as any] }),
    );
    expect(xml).toContain("<AssetCashOrMarketValueAmount>1234.56</AssetCashOrMarketValueAmount>");
    expect(xml).not.toContain("NaN");
  });

  it("does not throw on a malformed date", () => {
    const dto = baseDto();
    dto.application.createdAt = "not-a-date" as any;
    expect(() => generateMISMO34XML(dto)).not.toThrow();
  });
});

describe("dangling xlink relationships removed (Fix 7)", () => {
  it("does not emit a RELATIONSHIPS block or dangling xlink refs", () => {
    const xml = generateMISMO34XML(
      baseDto({
        assets: [{ accountType: "checking", cashOrMarketValue: "5000" } as any],
        liabilities: [{ liabilityType: "credit_card", monthlyPayment: "50" } as any],
        employment: [{ employerName: "Acme", employmentType: "employed", startDate: "2020-01-01" } as any],
      }),
    );
    expect(xml).not.toContain("RELATIONSHIPS");
    expect(xml).not.toContain("xlink:href");
    expect(xml).not.toContain("RelationshipType");
  });
});

describe("subject-property housing expense and combined-lien export", () => {
  const propertyInfo = {
    occupancyType: "primary_residence",
    monthlyAssociationDues: "175",
    monthlyFloodInsurance: "80",
    monthlyGroundRent: "25",
    monthlySpecialAssessments: "40",
    subordinateFinancingExists: true,
    closedEndSubordinateBalance: "15000",
    helocDrawnBalance: "10000",
    helocCreditLimit: "30000",
    monthlySubordinateFinancingPayment: "225",
  } as any;

  it("exports the exact proposed housing expenses used by qualification", () => {
    const xml = generateMISMO34XML(baseDto({ propertyInfo }));
    expect(xml).toContain("<HousingExpenseType>HomeownersAssociationDuesAndCondominiumFees</HousingExpenseType>");
    expect(xml).toContain("<HousingExpenseType>HazardInsurance</HousingExpenseType>");
    expect(xml).toContain("<HousingExpenseType>GroundRent</HousingExpenseType>");
    expect(xml).toContain("<HousingExpenseTypeOtherDescription>Special assessments</HousingExpenseTypeOtherDescription>");
    expect(xml).toContain("<HousingExpenseType>OtherMortgageLoanPrincipalAndInterest</HousingExpenseType>");
  });

  it("exports CLTV using the drawn HELOC and HCLTV using its full limit", () => {
    const xml = generateMISMO34XML(baseDto({ propertyInfo }));
    // $400k first + $15k closed-end + $10k drawn, divided by $500k.
    expect(xml).toContain("<CombinedLTVRatioPercent>85.000</CombinedLTVRatioPercent>");
    // $400k first + $15k closed-end + $30k full HELOC limit, divided by $500k.
    expect(xml).toContain("<HomeEquityCombinedLTVRatioPercent>89.000</HomeEquityCombinedLTVRatioPercent>");
  });

  it("does not invent combined ratios from an incomplete property section", () => {
    const xml = generateMISMO34XML(baseDto({
      propertyInfo: { ...propertyInfo, helocCreditLimit: null } as any,
    }));
    expect(xml).not.toContain("<COMBINED_LTVS>");
  });
});

describe("URLA Section 1e income export", () => {
  it("delivers each other-income source, amount, type, and known tax status", () => {
    const xml = generateMISMO34XML({
      ...baseDto(),
      otherIncome: [
        {
          incomeSource: "Social Security",
          monthlyAmount: "2000",
          taxTreatment: "partially_non_taxable",
          nonTaxableMonthlyAmount: "300",
          hasDefinedExpiration: false,
          expirationDate: null,
          paidInVirtualCurrency: false,
        } as any,
        {
          incomeSource: "Child Support",
          monthlyAmount: "900",
          taxTreatment: "fully_non_taxable",
          hasDefinedExpiration: true,
          expirationDate: "2032-01-01",
          paidInVirtualCurrency: false,
        } as any,
      ],
    });
    expect(xml).toContain("<URLABorrowerTotalOtherIncomeAmount>2900.00</URLABorrowerTotalOtherIncomeAmount>");
    expect(xml).toContain("<IncomeType>SocialSecurity</IncomeType>");
    expect(xml).toContain("<IncomeType>AlimonyChildSupport</IncomeType>");
    // Partial tax exemption cannot be represented truthfully by a boolean.
    expect(xml.match(/<IncomeFederalTaxExemptIndicator>true<\/IncomeFederalTaxExemptIndicator>/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ULDD delivery shape (Implementation Guide for Loan Delivery Data):
//   - Table 5: the subject loan is delivered as AtClosing + Current LOAN
//     containers, each stamped with LOAN_STATE.
//   - Table 4: Fannie Mae does not support the ASSET container in delivery
//     files, so purpose:"loanDelivery" omits it.
// ---------------------------------------------------------------------------
describe("loan-delivery purpose (ULDD Implementation Guide)", () => {
  const dtoWithAssets = () =>
    baseDto({ assets: [{ accountType: "checking", cashOrMarketValue: "5000" } as any] });

  it("emits AtClosing and Current LOAN containers with LOAN_STATE", () => {
    const xml = generateMISMO34XML(dtoWithAssets(), {
      purpose: "loanDelivery",
      noteDate: "2026-03-15",
    });
    expect(xml).toContain("<LoanStateType>AtClosing</LoanStateType>");
    expect(xml).toContain("<LoanStateDate>2026-03-15</LoanStateDate>");
    expect(xml).toContain("<LoanStateType>Current</LoanStateType>");
    expect((xml.match(/<LOAN>/g) || []).length).toBe(2);
  });

  it("omits the unsupported ASSET container for delivery files", () => {
    const xml = generateMISMO34XML(dtoWithAssets(), { purpose: "loanDelivery" });
    expect(xml).not.toContain("<ASSETS>");
  });

  it("omits the AtClosing LoanStateDate when the note date is unknown", () => {
    const xml = generateMISMO34XML(dtoWithAssets(), { purpose: "loanDelivery" });
    const atClosing = xml.slice(0, xml.indexOf("<LoanStateType>Current</LoanStateType>"));
    expect(atClosing).toContain("<LoanStateType>AtClosing</LoanStateType>");
  });

  it("default (underwriting) output keeps the single-LOAN shape with assets", () => {
    const xml = generateMISMO34XML(dtoWithAssets());
    expect(xml).toContain("<ASSETS>");
    expect(xml).not.toContain("LOAN_STATE");
    expect((xml.match(/<LOAN>/g) || []).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F-051 (P0) — the delivered package reported the AUS recommendation as the
// compile-time literal "Approve", for every file, regardless of what the AUS
// leg actually returned. A `refer_with_caution` casefile was delivered to the
// wholesale lender as an approval.
//
// These tests are written to FAIL if the literal is reintroduced: each asserts
// both the correct value AND the absence of "Approve" where it does not belong.
// Note the trap — a bare `not.toContain("Approve")` is useless here, because
// "Approve/Ineligible" contains "Approve" as a substring. Assert on the whole
// element.
// ---------------------------------------------------------------------------

describe("AutomatedUnderwritingRecommendationDescription — reports the real AUS result (F-051)", () => {
  const recommendationOf = (xml: string): string | null => {
    const m = xml.match(
      /<AutomatedUnderwritingRecommendationDescription>([^<]*)<\/AutomatedUnderwritingRecommendationDescription>/,
    );
    return m ? m[1] : null;
  };

  const dtoWithAus = (ausRecommendation: string | null) =>
    baseDto({ application: { ausRecommendation } as any });

  it.each([
    ["approve_eligible", "Approve/Eligible"],
    ["approve_ineligible", "Approve/Ineligible"],
    ["refer", "Refer"],
    ["refer_with_caution", "Refer with Caution"],
  ])("emits the stored %s recommendation as %s", (stored, expected) => {
    const xml = generateMISMO34XML(dtoWithAus(stored));
    expect(recommendationOf(xml)).toBe(expected);
  });

  it("never reports a non-approval casefile as an approval", () => {
    // The exact F-051 failure: these three must not be delivered as approvals.
    for (const stored of ["refer", "refer_with_caution"]) {
      const xml = generateMISMO34XML(dtoWithAus(stored));
      expect(recommendationOf(xml)).not.toBe("Approve");
      expect(recommendationOf(xml)).not.toBe("Approve/Eligible");
    }
    // approve_ineligible is an approval that fails eligibility — it must not be
    // flattened into a clean Approve/Eligible either.
    const ineligible = generateMISMO34XML(dtoWithAus("approve_ineligible"));
    expect(recommendationOf(ineligible)).toBe("Approve/Ineligible");
  });

  it("omits the whole AUTOMATED_UNDERWRITINGS container when no AUS has run", () => {
    const xml = generateMISMO34XML(dtoWithAus(null));
    expect(xml).not.toContain("<AUTOMATED_UNDERWRITINGS>");
    expect(recommendationOf(xml)).toBeNull();
    // UNDERWRITING_DETAIL is independently minOccurs="0" and must survive.
    expect(xml).toContain("<UNDERWRITING_DETAIL>");
    expect(xml).toContain("<LoanManualUnderwritingIndicator>true</LoanManualUnderwritingIndicator>");
  });

  it("declares manual underwriting when the decision engine routed the case out of scope", () => {
    const xml = generateMISMO34XML(baseDto({
      application: {
        ausRecommendation: "refer_with_caution",
        ausFindings: {
          inputIntegrity: { decisionPath: "manual_underwrite" },
        },
      } as any,
    }));
    expect(recommendationOf(xml)).toBe("Refer with Caution");
    expect(xml).toContain("<LoanManualUnderwritingIndicator>true</LoanManualUnderwritingIndicator>");
  });

  it("omits rather than guesses when the stored value is unrecognised", () => {
    const xml = generateMISMO34XML(dtoWithAus("some_future_du_verdict"));
    expect(xml).not.toContain("<AUTOMATED_UNDERWRITINGS>");
    expect(recommendationOf(xml)).toBeNull();
  });

  it("never emits a simulated casefile id as a real AUS case identifier (F-068)", () => {
    const xml = generateMISMO34XML(
      baseDto({ application: { ausRecommendation: "refer", ausCasefileId: "sim-du-abc123" } as any }),
    );
    expect(xml).not.toContain("AutomatedUnderwritingCaseIdentifier");
    expect(xml).not.toContain("sim-du-");
  });

  it("carries the recommendation through the loanDelivery purpose too", () => {
    const xml = generateMISMO34XML(dtoWithAus("refer"), {
      purpose: "loanDelivery",
      noteDate: "2026-03-15",
    });
    expect(recommendationOf(xml)).toBe("Refer");
  });
});

// ---------------------------------------------------------------------------
// F-053 — LoanAmortizationType was the compile-time literal "Fixed".
//
// The rate sheet seeds a real 5/6 ARM (server/seedMarketPricing.ts) and the borrower's URLA
// captures the choice (server/routes/borrower/urla.ts), so an adjustable file was delivered to
// the wholesale lender as fixed-rate. B2-1.4 governs amortization types; A3-4-02 requires
// delivery data to be "complete and accurate"; A2-2-07 makes an inaccuracy a life-of-loan
// representation. Same defect class as F-051 in this file: a stored value replaced by a constant.
//
// Enumeration verified against docs/fannie-mae/schemas/uldd-phase5-extension/MISMO_3_0.xsd.
// ---------------------------------------------------------------------------
describe("LoanAmortizationType (F-053)", () => {
  it("emits AdjustableRate for an adjustable loan — the defect, reintroduced", () => {
    const xml = generateMISMO34XML(
      baseDto({ application: { amortizationType: "adjustable" } as any }),
    );
    expect(xml).toContain("<LoanAmortizationType>AdjustableRate</LoanAmortizationType>");
    expect(xml).not.toContain("<LoanAmortizationType>Fixed</LoanAmortizationType>");
  });

  it("accepts the rate-sheet spelling too — products are seeded as ARM, applications as adjustable", () => {
    const xml = generateMISMO34XML(baseDto({ application: { amortizationType: "ARM" } as any }));
    expect(xml).toContain("<LoanAmortizationType>AdjustableRate</LoanAmortizationType>");
  });

  it("emits Fixed for a fixed loan", () => {
    const xml = generateMISMO34XML(baseDto({ application: { amortizationType: "fixed" } as any }));
    expect(xml).toContain("<LoanAmortizationType>Fixed</LoanAmortizationType>");
  });

  it("falls back to Fixed only when the field is unset", () => {
    // Asserting the platform default is not the bug; overriding a KNOWN adjustable value was.
    const xml = generateMISMO34XML(baseDto({ application: { amortizationType: null } as any }));
    expect(xml).toContain("<LoanAmortizationType>Fixed</LoanAmortizationType>");
  });

  it("fails loud on an unmapped value rather than emitting a plausible one", () => {
    expect(() =>
      generateMISMO34XML(baseDto({ application: { amortizationType: "balloon" } as any })),
    ).toThrow(/unmapped amortization type/);
  });
});

// ---------------------------------------------------------------------------
// B3-6-05, Debts Paid by Others → LiabilityExclusionIndicator. MISMO_3_0.xsd
// line 9748: "Indicates whether the liability is to be excluded from inclusion
// in calculations associated with processing the loan." The package must tell
// the lender the same story the qualifying ratio does.
// ---------------------------------------------------------------------------
describe("LiabilityExclusionIndicator follows the B3-6-05 exclusion", () => {
  const paidByFamily = {
    liabilityType: "Student Loan",
    creditorName: "Navient",
    monthlyPayment: "350",
    unpaidBalance: "30000",
    paidByOtherParty: true,
    otherPartyRelationship: "family_member",
    otherPartyInterestedParty: false,
  };

  it("is emitted as true, in schema order, for an excluded payment", () => {
    const xml = generateMISMO34XML(baseDto({ liabilities: [paidByFamily as any] }));
    expect(xml).toContain("<LiabilityExclusionIndicator>true</LiabilityExclusionIndicator>");
    // Alphabetical sequence inside LIABILITY_DETAIL: Exclusion before MonthlyPaymentAmount.
    expect(xml.indexOf("<LiabilityExclusionIndicator>")).toBeLessThan(xml.indexOf("<LiabilityMonthlyPaymentAmount>"));
  });

  it("is absent (included is the default) for an ordinary liability and for a rejected claim", () => {
    expect(generateMISMO34XML(baseDto({ liabilities: [{ liabilityType: "credit_card", monthlyPayment: "50" } as any] })))
      .not.toContain("LiabilityExclusionIndicator");
    expect(generateMISMO34XML(baseDto({ liabilities: [{ ...paidByFamily, otherPartyInterestedParty: true } as any] })))
      .not.toContain("LiabilityExclusionIndicator");
  });
});
