import { describe, expect, it } from "vitest";
import {
  assessMultipleFinancedProperties,
  reoQualificationPicture,
  subjectMinimumReserveMonths,
} from "../shared/realEstateFinancing";

function property(overrides: Record<string, unknown> = {}) {
  return {
    id: String(overrides.id ?? "reo-1"),
    propertyAddress: String(overrides.propertyAddress ?? "10 Rental Way"),
    propertyType: "single_family",
    mortgageBalance: "200000",
    helocBalance: "0",
    mortgagePayment: "1200",
    helocPayment: "0",
    monthlyRentalIncome: "2500",
    monthlyInsurance: "150",
    monthlyTaxes: "300",
    monthlyHoa: "0",
    occupancyType: "investment",
    status: "retained",
    willBeSold: false,
    willBeRented: true,
    personallyObligated: true,
    ...overrides,
  } as never;
}

describe("multiple financed property assessment", () => {
  it("keeps unknown ownership unknown instead of treating it as zero properties", () => {
    const result = assessMultipleFinancedProperties({
      ownsOtherRealEstate: null,
      properties: [],
      subjectOccupancyType: "primary_residence",
    });
    expect(result.complete).toBe(false);
    expect(result.financedPropertiesCount).toBeNull();
    expect(result.missingItems[0]).toMatch(/whether you own/i);
  });

  it("counts the subject and personally obligated properties while excluding entity-only financing", () => {
    const result = assessMultipleFinancedProperties({
      ownsOtherRealEstate: true,
      subjectOccupancyType: "second_home",
      properties: [
        property({ id: "personal" }),
        property({ id: "entity", personallyObligated: false, mortgageBalance: "500000" }),
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.financedPropertiesCount).toBe(2);
    expect(result.countedPropertyIds).toEqual(["personal"]);
    expect(result.aggregateReserveUpb).toBe(200000);
    expect(result.additionalReserveRequirement).toBe(4000);
  });

  it("applies the 4% tier and excludes principal/pending-sale UPB from the reserve base", () => {
    const result = assessMultipleFinancedProperties({
      ownsOtherRealEstate: true,
      subjectOccupancyType: "investment",
      properties: [
        property({ id: "primary", occupancyType: "primary", mortgageBalance: "100000" }),
        property({ id: "rental-a", mortgageBalance: "200000" }),
        property({ id: "rental-b", mortgageBalance: "150000", helocBalance: "25000" }),
        property({ id: "pending", mortgageBalance: "300000", status: "pending_sale", willBeSold: true }),
      ],
    });
    expect(result.financedPropertiesCount).toBe(5);
    expect(result.reserveFactor).toBe(0.04);
    expect(result.aggregateReserveUpb).toBe(375000);
    expect(result.additionalReserveRequirement).toBe(15000);
  });

  it("requires explicit mortgage, HELOC and personal-obligation facts", () => {
    const result = assessMultipleFinancedProperties({
      ownsOtherRealEstate: true,
      properties: [property({ mortgageBalance: null, helocBalance: null, personallyObligated: null })],
      subjectOccupancyType: "investment",
    });
    expect(result.complete).toBe(false);
    expect(result.missingItems.join(" ")).toMatch(/mortgage and HELOC balances/i);
    expect(result.missingItems.join(" ")).toMatch(/personally responsible/i);
  });

  it("builds rental PITIA from the full property schedule and carries zero rent as a loss", () => {
    const result = reoQualificationPicture([
      property({ monthlyRentalIncome: "0", mortgagePayment: "1200", helocPayment: "50", monthlyTaxes: "300", monthlyInsurance: "150", monthlyHoa: "25" }),
    ]);
    expect(result.missingItems).toEqual([]);
    expect(result.rentalProperties).toEqual([expect.objectContaining({
      monthlyRentalIncome: "0",
      monthlyDebtPayment: "1725",
    })]);
  });

  it("pins the subject-property DU reserve months", () => {
    expect(subjectMinimumReserveMonths("primary_residence", 1)).toBe(0);
    expect(subjectMinimumReserveMonths("primary_residence", 2)).toBe(6);
    expect(subjectMinimumReserveMonths("second_home", 1)).toBe(2);
    expect(subjectMinimumReserveMonths("investment", 1)).toBe(6);
  });
});
