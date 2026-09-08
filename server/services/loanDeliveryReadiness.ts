/**
 * Fannie Mae delivery-readiness workflow: one report combining
 *
 *   1. URLA completeness + GSE gating (services/mismoValidation.ts)
 *   2. ULDD export-shape compliance (server/mismo.ts validateULDDCompliance)
 *   3. Loan Delivery / UCD / EarlyCheck pre-delivery edits
 *      (shared/fannieMae/loanDeliveryEdits.ts)
 *   4. Special Feature Code derivation + set validation
 *      (shared/fannieMae/specialFeatureCodes.ts)
 *
 * Deterministic: same stored data, same report. Data we have not captured is
 * reported as "not evaluated" — never as a pass (this mirrors how the real
 * Loan Delivery edits would simply fire on the missing datapoints).
 */

import { storage } from "../storage";
import {
  evaluateLoanDeliveryEdits,
  type LoanDeliveryDataset,
  type LoanDeliveryEditResult,
  type DiscountPointsFee,
  type LenderCreditsItem,
  type EscrowItemEntry,
  type PrepaidItemEntry,
  type FeeItemEntry,
} from "@shared/fannieMae/loanDeliveryEdits";
import {
  deriveSpecialFeatureCodes,
  validateSfcSet,
  type DerivedSfc,
  type SfcDerivationInput,
  type SfcValidationResult,
} from "@shared/fannieMae/specialFeatureCodes";
import { CONFORMING_LOAN_LIMIT_2026 } from "@shared/lendingLimits";
import { deliveryStackApplicability, type ChannelApplicability } from "@shared/businessChannel";
import { confirmedMortgagedReoCount } from "@shared/realEstateFinancing";
import type { LoanApplication, LoanDeliveryData } from "@shared/schema";

export interface DeliveryReadinessReport {
  applicationId: string;
  /**
   * Whether this report describes an obligation Homiquity actually owes
   * (audit F-14). In the broker channel it does not: the wholesale lender is
   * the seller/servicer and performs GSE delivery itself. The report stays
   * useful as a data-quality pre-flight, but must never read as a delivery
   * gate we are subject to.
   */
  channelApplicability: ChannelApplicability;
  /** True when every locally evaluable gate passes. */
  readyForDelivery: boolean;
  urla: {
    overallScore: number;
    gseReady: boolean;
    gseGatingFailed: boolean;
    criticalErrorCount: number;
  };
  deliveryData: {
    captured: boolean;
    note: string | null;
  };
  edits: LoanDeliveryEditResult;
  specialFeatureCodes: {
    derived: DerivedSfc[];
    manual: string[];
    combined: string[];
    validation: SfcValidationResult;
  };
}

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

function mapMortgageType(loanType: string | null | undefined): string {
  const mapping: Record<string, string> = {
    conventional: "Conventional",
    fha: "FHA",
    va: "VA",
    usda: "USDA",
  };
  return mapping[loanType?.toLowerCase() || ""] || "Conventional";
}

function computeOriginalLoanAmount(application: LoanApplication, delivery: LoanDeliveryData | undefined): number | null {
  const stored = num(delivery?.originalLoanAmount);
  if (stored != null) return stored;
  const price = num(application.purchasePrice);
  const down = num(application.downPayment);
  return price != null && down != null ? price - down : null;
}

/**
 * Assemble the edit-engine dataset from the stored delivery row plus the
 * application fields that already carry the same facts. Fields with no stored
 * source stay undefined so the engine reports them honestly.
 */
export interface DeliveryDatasetContext {
  /** Count of mortgaged REO properties (excluding the subject), when known. */
  mortgagedReoCount?: number;
  /** URLA occupancy type (urla_property_info.occupancy_type), when loaded. */
  occupancyType?: string | null;
}
function mapPropertyUsage(occupancy: string | null | undefined): string | undefined {
  const mapping: Record<string, string> = {
    primary_residence: "PrimaryResidence",
    primary: "PrimaryResidence",
    second_home: "SecondHome",
    secondary: "SecondHome",
    investment: "Investment",
    investment_property: "Investment",
  };
  return mapping[occupancy?.toLowerCase() || ""];
}

export function buildDeliveryDataset(
  application: LoanApplication,
  delivery: LoanDeliveryData | undefined,
  combinedSfcs: string[],
  context: DeliveryDatasetContext = {},
): LoanDeliveryDataset {
  const isArm = (application.amortizationType || "").toLowerCase() === "adjustable";
  const propertyType = (application.propertyType || "").toLowerCase();
  const manufactured =
    delivery?.manufacturedHome ?? (propertyType.includes("manufactured") || undefined);

  return {
    noteDate: delivery?.noteDate ?? undefined,
    originalLoanAmount: computeOriginalLoanAmount(application, delivery),
    mortgageType: mapMortgageType(application.preferredLoanType),
    lienPriorityType: delivery?.lienPriorityType ?? "FirstLien",
    amortizationType: application.amortizationType ? (isArm ? "AdjustableRate" : "Fixed") : undefined,
    manufacturedHome: manufactured ?? undefined,
    noteRatePercent: num(delivery?.noteRatePercent) ?? undefined,

    aprPercent: num(delivery?.aprPercent) ?? undefined,
    averagePrimeOfferRatePercent: num(delivery?.averagePrimeOfferRatePercent) ?? undefined,
    currentRateSetDate: delivery?.currentRateSetDate ?? undefined,
    regulationZTotalLoanAmount: num(delivery?.regulationZTotalLoanAmount) ?? undefined,
    regulationZTotalPointsAndFeesAmount: num(delivery?.regulationZTotalPointsAndFeesAmount) ?? undefined,
    regulationZTotalAffiliateFeesAmount: num(delivery?.regulationZTotalAffiliateFeesAmount) ?? undefined,
    abilityToRepayMethodType: delivery?.abilityToRepayMethodType ?? undefined,
    abilityToRepayExemptionReasonType: delivery?.abilityToRepayExemptionReasonType ?? undefined,
    regulationZExcludedBonaFideDiscountPointsIndicator: delivery?.excludedBonaFideDiscountPointsIndicator ?? undefined,
    regulationZExcludedBonaFideDiscountPointsPercent: num(delivery?.excludedBonaFideDiscountPointsPercent) ?? undefined,
    loanPriceQuoteInterestRatePercent: num(delivery?.loanPriceQuoteInterestRatePercent) ?? undefined,

    // Note: armAdjustmentFrequencyMonths is NOT a substitute — a 5/6 ARM has
    // frequency 6 but first change at 60 months. Only the stored value counts.
    firstRateChangeMonthsCount: delivery?.firstRateChangeMonthsCount ?? undefined,
    qualifiedMortgageShortResetArmAprPercent: num(delivery?.qmShortResetArmAprPercent) ?? undefined,

    discountPoints: delivery ? ((delivery.discountPoints as DiscountPointsFee | null) ?? null) : undefined,
    discountPointsOccurrenceCount: delivery?.discountPointsOccurrenceCount ?? undefined,
    lenderCredits: delivery ? ((delivery.lenderCredits as LenderCreditsItem | null) ?? null) : undefined,
    escrowItems: delivery ? ((delivery.escrowItems as EscrowItemEntry[] | null) ?? []) : undefined,
    prepaidItems: delivery ? ((delivery.prepaidItems as PrepaidItemEntry[] | null) ?? []) : undefined,
    fees: delivery?.fees !== undefined && delivery?.fees !== null
      ? (delivery.fees as FeeItemEntry[])
      : undefined,

    projectClassificationIdentifier: delivery?.projectClassificationIdentifier ?? undefined,
    applicationReceivedDate:
      delivery?.applicationReceivedDate
      ?? (application.tridTriggeredAt
        ? new Date(application.tridTriggeredAt as unknown as string).toISOString().slice(0, 10)
        : undefined),
    isCondominium: propertyType.includes("condo") || undefined,
    isCooperative: propertyType.includes("co-op") || propertyType.includes("coop") || undefined,
    hasMortgageInsurance: delivery?.hasMortgageInsurance ?? undefined,
    subordinateFinancingExists: delivery?.subordinateFinancingExists ?? undefined,
    propertyUsageType: delivery?.propertyUsageType ?? mapPropertyUsage(context.occupancyType),
    // Mortgaged-property count = subject (1) + REO properties carrying a
    // mortgage. Only computed when REO data was loaded; a staff-entered
    // value on the delivery row wins.
    financedPropertiesCount:
      delivery?.financedPropertiesCount
      ?? (context.mortgagedReoCount !== undefined ? context.mortgagedReoCount + 1 : undefined),
    purchasePriceAmount: num(application.purchasePrice) ?? undefined,

    mortgageFunderFullName: delivery?.mortgageFunderFullName ?? undefined,
    specialFeatureCodes: combinedSfcs,
  };
}

/**
 * Build the SFC derivation input from what the application and delivery row
 * actually record. Attributes with no source of truth in the data model are
 * only honored via the staff-maintained sfcAttributes blob — never inferred.
 */
export function buildSfcInput(
  application: LoanApplication,
  delivery: LoanDeliveryData | undefined,
): SfcDerivationInput {
  const staffAttributes = (delivery?.sfcAttributes as SfcDerivationInput | null) ?? {};
  const derivedFromApp: SfcDerivationInput = {
    underwrittenThroughDu: application.ausCasefileId ? true : undefined,
    manufacturedHome: (application.propertyType || "").toLowerCase().includes("manufactured") || undefined,
    originalLoanAmount: computeOriginalLoanAmount(application, delivery),
    conformingLoanLimit: CONFORMING_LOAN_LIMIT_2026,
  };
  // Staff-recorded attributes win over app-level inference.
  return { ...derivedFromApp, ...staffAttributes };
}

export async function evaluateDeliveryReadiness(applicationId: string): Promise<DeliveryReadinessReport> {
  const application = await storage.getLoanApplication(applicationId);
  if (!application) {
    throw new Error("Application not found");
  }
  const delivery = await storage.getLoanDeliveryData(applicationId);

  // 1. URLA completeness (existing validator).
  const { validateMISMOCompleteness } = await import("./mismoValidation");
  const urla = await validateMISMOCompleteness(applicationId);

  // 2. Special Feature Codes: deterministic derivation + manual set.
  const sfcInput = buildSfcInput(application, delivery);
  const derived = deriveSpecialFeatureCodes(sfcInput);
  const manual = delivery?.manualSpecialFeatureCodes ?? [];
  const combined = Array.from(new Set([...derived.map(d => d.code), ...manual])).sort();
  const sfcValidation = validateSfcSet(combined);

  // 3. Loan Delivery / UCD / EarlyCheck edits. REO rows feed the
  // mortgaged-property count (edit 6439); URLA property info feeds the
  // occupancy-based usage type (edits 6159/6439).
  const [reo, propertyInfo] = await Promise.all([
    storage.getRealEstateOwnedByApplication(applicationId),
    storage.getUrlaPropertyInfo(applicationId),
  ]);
  const mortgagedReoCount = confirmedMortgagedReoCount(application.ownsOtherRealEstate, reo);
  const dataset = buildDeliveryDataset(application, delivery, combined, {
    mortgagedReoCount,
    occupancyType: propertyInfo?.occupancyType ?? null,
  });
  const edits = evaluateLoanDeliveryEdits(dataset);

  const deliveryDataCaptured = !!delivery;

  return {
    applicationId,
    channelApplicability: deliveryStackApplicability(),
    readyForDelivery:
      deliveryDataCaptured &&
      edits.deliverable &&
      sfcValidation.valid &&
      !urla.gseGatingFailed &&
      urla.criticalErrors.length === 0,
    urla: {
      overallScore: urla.overallScore,
      gseReady: urla.gseReady,
      gseGatingFailed: urla.gseGatingFailed,
      criticalErrorCount: urla.criticalErrors.length,
    },
    deliveryData: {
      captured: deliveryDataCaptured,
      note: deliveryDataCaptured
        ? null
        : "Closing-stage delivery data (APR/APOR, Regulation Z amounts, fees, note date) has not been captured; UCD and QM edits cannot pass until it is.",
    },
    edits,
    specialFeatureCodes: {
      derived,
      manual,
      combined,
      validation: sfcValidation,
    },
  };
}
