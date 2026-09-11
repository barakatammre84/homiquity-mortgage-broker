import type { RealEstateOwned } from "./schema";

type ReoFinancingFacts = Pick<
  RealEstateOwned,
  | "id"
  | "propertyAddress"
  | "propertyType"
  | "mortgageBalance"
  | "helocBalance"
  | "mortgagePayment"
  | "helocPayment"
  | "monthlyRentalIncome"
  | "monthlyInsurance"
  | "monthlyTaxes"
  | "monthlyHoa"
  | "occupancyType"
  | "status"
  | "willBeSold"
  | "willBeRented"
  | "personallyObligated"
>;

function amount(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(String(value).replace(/[,$\s]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function normalizedSubjectOccupancy(value: string | null | undefined): "primary" | "second_home" | "investment" {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("invest") || normalized.includes("rental") || normalized.includes("non_owner")) {
    return "investment";
  }
  if (normalized.includes("second") || normalized.includes("vacation")) return "second_home";
  return "primary";
}

function soldOrPending(property: ReoFinancingFacts): boolean {
  return property.willBeSold === true || property.status === "sold" || property.status === "pending_sale";
}

function isResidentialType(value: string | null): boolean | null {
  if (!value) return null;
  if (["single_family", "condo", "townhouse", "multi_family"].includes(value)) return true;
  if (value === "other") return null;
  return false;
}

export type MultipleFinancedPropertiesAssessment = {
  complete: boolean;
  missingItems: string[];
  financedPropertiesCount: number | null;
  aggregateReserveUpb: number | null;
  reserveFactor: 0 | 0.02 | 0.04 | 0.06 | null;
  additionalReserveRequirement: number | null;
  subjectOccupancy: "primary" | "second_home" | "investment";
  /** Existing retained financed properties included in the count. */
  countedPropertyIds: string[];
};

export type ReoQualificationPicture = {
  rentalProperties: Array<{ address: string; monthlyRentalIncome: string; monthlyDebtPayment: string }>;
  nonRentalMonthlyObligation: number;
  missingItems: string[];
};

/**
 * B2-2-03 / B3-4.1-01 financed-property count and additional reserve burden.
 * The subject purchase counts as one financed property. Additional reserves
 * apply only to second-home/investment subjects and exclude the borrower's
 * principal residence plus sold/pending-sale properties from aggregate UPB.
 * Unknown facts remain unknown; they never become a zero reserve requirement.
 */
export function assessMultipleFinancedProperties(input: {
  ownsOtherRealEstate: boolean | null | undefined;
  properties: ReoFinancingFacts[];
  subjectOccupancyType?: string | null;
}): MultipleFinancedPropertiesAssessment {
  const occupancy = normalizedSubjectOccupancy(input.subjectOccupancyType);
  const missingItems: string[] = [];
  const counted: ReoFinancingFacts[] = [];

  if (input.ownsOtherRealEstate == null) {
    missingItems.push("Answer whether you own any other real estate");
  } else if (input.ownsOtherRealEstate && input.properties.length === 0) {
    missingItems.push("Add every property you own");
  }

  if (input.ownsOtherRealEstate === true) {
    input.properties.forEach((property, index) => {
      if (property.status === "sold") return;
      const label = property.propertyAddress?.trim() || `Property ${index + 1}`;
      const mortgage = amount(property.mortgageBalance);
      const heloc = amount(property.helocBalance);
      const payment = amount(property.mortgagePayment);
      const hasFinancingSignal = (mortgage ?? 0) > 0 || (heloc ?? 0) > 0 || (payment ?? 0) > 0;
      const explicitlyFreeAndClear = mortgage === 0 && heloc === 0 && (payment === 0 || payment === null);

      if (mortgage === null || heloc === null) {
        missingItems.push(`Enter the mortgage and HELOC balances for ${label} (use $0 when none)`);
      }
      if (!hasFinancingSignal && !explicitlyFreeAndClear) return;
      if (!hasFinancingSignal) return;
      if (property.personallyObligated == null) {
        missingItems.push(`Confirm whether a borrower is personally responsible for the financing on ${label}`);
        return;
      }
      if (!property.personallyObligated) return;
      const residential = isResidentialType(property.propertyType);
      if (residential == null) {
        missingItems.push(`Classify ${label} as residential or have a loan officer review it`);
        return;
      }
      if (!residential || property.status === "sold") return;
      counted.push(property);
    });
  }

  if (missingItems.length > 0) {
    return {
      complete: false,
      missingItems: [...new Set(missingItems)],
      financedPropertiesCount: null,
      aggregateReserveUpb: null,
      reserveFactor: null,
      additionalReserveRequirement: null,
      subjectOccupancy: occupancy,
      countedPropertyIds: counted.map(property => property.id),
    };
  }

  const financedPropertiesCount = 1 + counted.length;
  let reserveFactor: MultipleFinancedPropertiesAssessment["reserveFactor"] = 0;
  if (occupancy !== "primary") {
    reserveFactor = financedPropertiesCount <= 4 ? 0.02 : financedPropertiesCount <= 6 ? 0.04 : 0.06;
  }
  const aggregateReserveUpb = occupancy === "primary" ? 0 : counted.reduce((sum, property) => {
    if (soldOrPending(property) || normalizedSubjectOccupancy(property.occupancyType) === "primary") return sum;
    return sum + (amount(property.mortgageBalance) ?? 0) + (amount(property.helocBalance) ?? 0);
  }, 0);

  return {
    complete: true,
    missingItems: [],
    financedPropertiesCount,
    aggregateReserveUpb,
    reserveFactor,
    additionalReserveRequirement: Math.round(aggregateReserveUpb * reserveFactor * 100) / 100,
    subjectOccupancy: occupancy,
    countedPropertyIds: counted.map(property => property.id),
  };
}

export function subjectMinimumReserveMonths(
  occupancyType: string | null | undefined,
  numberOfUnits: number | null | undefined,
): number {
  const occupancy = normalizedSubjectOccupancy(occupancyType);
  if (occupancy === "second_home") return 2;
  if (occupancy === "investment" || (occupancy === "primary" && (numberOfUnits ?? 1) >= 2)) return 6;
  return 0;
}

/** Build the per-property PITIA inputs used by the rental income path. */
export function rentalPropertiesFromReo(properties: ReoFinancingFacts[]) {
  return properties
    .filter(property => !soldOrPending(property))
    .filter(property => property.occupancyType === "investment" || property.willBeRented === true)
    .map(property => ({
      address: property.propertyAddress,
      monthlyRentalIncome: String(amount(property.monthlyRentalIncome) ?? 0),
      monthlyDebtPayment: String(
        (amount(property.mortgagePayment) ?? 0)
        + (amount(property.helocPayment) ?? 0)
        + (amount(property.monthlyTaxes) ?? 0)
        + (amount(property.monthlyInsurance) ?? 0)
        + (amount(property.monthlyHoa) ?? 0),
      ),
    }));
}

/**
 * Turn the complete REO schedule into the income/debt inputs used by the DTI.
 * Rental properties carry full monthly housing expense into the per-property
 * rent offset. Retained non-rentals carry it directly as a monthly obligation.
 */
export function reoQualificationPicture(properties: ReoFinancingFacts[]): ReoQualificationPicture {
  const missingItems: string[] = [];
  for (const [index, property] of properties.entries()) {
    if (soldOrPending(property)) continue;
    const label = property.propertyAddress?.trim() || `Property ${index + 1}`;
    const mortgageBalance = amount(property.mortgageBalance);
    const helocBalance = amount(property.helocBalance);
    const rental = property.occupancyType === "investment" || property.willBeRented === true;
    const required: Array<[unknown, string]> = [
      [property.monthlyTaxes, "monthly property taxes"],
      [property.monthlyInsurance, "monthly property insurance"],
      [property.monthlyHoa, "monthly HOA dues"],
    ];
    if ((mortgageBalance ?? 0) > 0) required.push([property.mortgagePayment, "monthly mortgage payment"]);
    if ((helocBalance ?? 0) > 0) required.push([property.helocPayment, "monthly HELOC payment"]);
    if (rental) required.push([property.monthlyRentalIncome, "monthly rent"]);
    const absent = required.filter(([value]) => amount(value) === null).map(([, field]) => field);
    if (absent.length > 0) missingItems.push(`Enter ${absent.join(", ")} for ${label} (use $0 when none)`);
  }

  const rentalProperties = rentalPropertiesFromReo(properties);
  const rentalIds = new Set(
    properties
      .filter(property => !soldOrPending(property))
      .filter(property => property.occupancyType === "investment" || property.willBeRented === true)
      .map(property => property.id),
  );
  const nonRentalMonthlyObligation = properties.reduce((total, property) => {
    if (soldOrPending(property) || rentalIds.has(property.id)) return total;
    return total
      + (amount(property.mortgagePayment) ?? 0)
      + (amount(property.helocPayment) ?? 0)
      + (amount(property.monthlyTaxes) ?? 0)
      + (amount(property.monthlyInsurance) ?? 0)
      + (amount(property.monthlyHoa) ?? 0);
  }, 0);
  return {
    rentalProperties,
    nonRentalMonthlyObligation: Math.round(nonRentalMonthlyObligation * 100) / 100,
    missingItems: [...new Set(missingItems)],
  };
}

/**
 * Count financed owned properties only when the ownership disclosure and the
 * financing state of every listed property are known. A payment proves
 * financing; an explicit zero balance proves the opposite.
 */
export function confirmedMortgagedReoCount(
  ownsOtherRealEstate: boolean | null | undefined,
  reo: Array<Pick<RealEstateOwned, "mortgageBalance" | "mortgagePayment">>,
): number | undefined {
  if (ownsOtherRealEstate === false) return 0;
  if (ownsOtherRealEstate !== true || reo.length === 0) return undefined;
  if (reo.some((property) => property.mortgageBalance == null && property.mortgagePayment == null)) {
    return undefined;
  }
  return reo.filter((property) =>
    Number(property.mortgageBalance || 0) > 0 || Number(property.mortgagePayment || 0) > 0,
  ).length;
}
