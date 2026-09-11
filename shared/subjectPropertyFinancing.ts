type MoneyLike = string | number | null | undefined;
type SubjectPropertyInfo = {
  monthlyAssociationDues?: MoneyLike;
  monthlyFloodInsurance?: MoneyLike;
  monthlyGroundRent?: MoneyLike;
  monthlySpecialAssessments?: MoneyLike;
  subordinateFinancingExists?: boolean | null;
  closedEndSubordinateBalance?: MoneyLike;
  helocDrawnBalance?: MoneyLike;
  helocCreditLimit?: MoneyLike;
  monthlySubordinateFinancingPayment?: MoneyLike;
};

export type SubjectPropertyFinancingAssessment = {
  captured: boolean;
  complete: boolean;
  missingItems: string[];
  monthlyAssociationDues: number;
  monthlyFloodInsurance: number;
  monthlyGroundRent: number;
  monthlySpecialAssessments: number;
  monthlySubordinateFinancingPayment: number;
  monthlyHousingExpenseAdditions: number;
  subordinateFinancingExists: boolean | null;
  closedEndSubordinateBalance: number;
  helocDrawnBalance: number;
  helocCreditLimit: number;
  cltv: number | null;
  hcltv: number | null;
};

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(typeof value === "string" ? value.replace(/[,$\s]/g, "") : value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

const cents = (value: number) => Math.round(value * 100) / 100;
const ratio = (numerator: number, denominator: number) =>
  Math.round((numerator / denominator) * 100 * 10_000) / 10_000;

/**
 * Build the exact subject-property payment additions and combined-lien ratios.
 * A missing URLA property row means the borrower is still in the fast estimate
 * journey, so no false zero is asserted and no extra question blocks that
 * preliminary screen. Once the property section exists, each field must be
 * answered (0 is a real answer) before the file can be treated as lender-ready.
 */
export function assessSubjectPropertyFinancing(input: {
  propertyInfo: SubjectPropertyInfo | null | undefined;
  firstMortgageAmount: number;
  salesPrice: number;
  appraisedValue: number;
  associationDuesRequired?: boolean;
}): SubjectPropertyFinancingAssessment {
  const property = input.propertyInfo;
  if (!property) {
    return {
      captured: false,
      complete: true,
      missingItems: [],
      monthlyAssociationDues: 0,
      monthlyFloodInsurance: 0,
      monthlyGroundRent: 0,
      monthlySpecialAssessments: 0,
      monthlySubordinateFinancingPayment: 0,
      monthlyHousingExpenseAdditions: 0,
      subordinateFinancingExists: null,
      closedEndSubordinateBalance: 0,
      helocDrawnBalance: 0,
      helocCreditLimit: 0,
      cltv: null,
      hcltv: null,
    };
  }

  const missingItems: string[] = [];
  const association = numberOrNull(property.monthlyAssociationDues);
  const flood = numberOrNull(property.monthlyFloodInsurance);
  const ground = numberOrNull(property.monthlyGroundRent);
  const assessments = numberOrNull(property.monthlySpecialAssessments);
  if (input.associationDuesRequired && association === null) {
    missingItems.push("Monthly homeowners association (HOA) or co-op dues for the property (enter $0 if none)");
  }
  if (flood === null) missingItems.push("Monthly flood-insurance premium for the property (enter $0 if none or included elsewhere)");
  if (ground === null) missingItems.push("Monthly ground rent for the property (enter $0 if none)");
  if (assessments === null) missingItems.push("Monthly special assessments for the property (enter $0 if none)");

  const subordinateExists = property.subordinateFinancingExists ?? null;
  let closedEnd = 0;
  let helocDrawn = 0;
  let helocLimit = 0;
  let subordinatePayment = 0;
  if (subordinateExists === null) {
    missingItems.push("Whether another new loan or HELOC will be secured by this property");
  } else if (subordinateExists) {
    const closedEndValue = numberOrNull(property.closedEndSubordinateBalance);
    const drawnValue = numberOrNull(property.helocDrawnBalance);
    const limitValue = numberOrNull(property.helocCreditLimit);
    const paymentValue = numberOrNull(property.monthlySubordinateFinancingPayment);
    if (closedEndValue === null) missingItems.push("Closed-end second-mortgage amount (enter $0 if none)");
    if (drawnValue === null) missingItems.push("HELOC amount drawn at closing (enter $0 if none)");
    if (limitValue === null) missingItems.push("Full HELOC credit limit (enter $0 if none)");
    if (paymentValue === null) missingItems.push("Monthly payment for financing secured by this property (enter $0 only when the agreement requires no payment)");
    closedEnd = closedEndValue ?? 0;
    helocDrawn = drawnValue ?? 0;
    helocLimit = limitValue ?? 0;
    subordinatePayment = paymentValue ?? 0;
    if (helocLimit < helocDrawn) missingItems.push("HELOC credit limit must be at least the amount drawn");
    if (closedEnd + helocLimit <= 0) missingItems.push("At least one second-mortgage amount or HELOC limit");
  }

  const basis = Math.min(input.salesPrice, input.appraisedValue);
  const ratiosAvailable = missingItems.length === 0
    && basis > 0
    && input.firstMortgageAmount > 0;
  const cltv = ratiosAvailable
    ? ratio(input.firstMortgageAmount + closedEnd + helocDrawn, basis)
    : null;
  const hcltv = ratiosAvailable
    ? ratio(input.firstMortgageAmount + closedEnd + helocLimit, basis)
    : null;

  const additions = (association ?? 0) + (flood ?? 0) + (ground ?? 0) + (assessments ?? 0) + subordinatePayment;
  return {
    captured: true,
    complete: missingItems.length === 0,
    missingItems,
    monthlyAssociationDues: association ?? 0,
    monthlyFloodInsurance: flood ?? 0,
    monthlyGroundRent: ground ?? 0,
    monthlySpecialAssessments: assessments ?? 0,
    monthlySubordinateFinancingPayment: subordinatePayment,
    monthlyHousingExpenseAdditions: cents(additions),
    subordinateFinancingExists: subordinateExists,
    closedEndSubordinateBalance: closedEnd,
    helocDrawnBalance: helocDrawn,
    helocCreditLimit: helocLimit,
    cltv,
    hcltv,
  };
}
