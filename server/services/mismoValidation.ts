import { storage } from "../storage";
import { addBusinessDays, subtractBusinessDays } from "./businessDays";
import { evaluateCoveredPointsAndFees } from "@shared/fannieMae/qmThresholds";
import { resolveCompensation } from "@shared/compliance/loCompensation";
import {
  estimatedNoteDate,
  evaluateFileQmFloor,
  regulationZTotalLoanAmountStandIn,
  type PlatformFeeSchedule,
} from "./loanCosts";
import { activeFeeSchedule } from "./platformFeeSchedule";
import type { CompleteUrlaData } from "../storage/urlaBatch";
import type {
  LoanApplication,
  LoanCondition,
  Document,
  UrlaPersonalInfo,
  EmploymentHistory,
  UrlaAsset,
  UrlaLiability,
  UrlaPropertyInfo,
  BorrowerDeclarations,
  OtherIncomeSource,
  RealEstateOwned,
  HmdaDemographics,
  BorrowerProfile,
} from "@shared/schema";

export interface URLASectionScore {
  section: string;
  sectionNumber: string;
  completeness: number;
  requiredFields: number;
  completedFields: number;
  missingFields: string[];
  warnings: string[];
  /** True when this section is part of the GSE hard-gating set (1a, 4, 5). */
  gating?: boolean;
}

export interface CoApplicantScore {
  borrowerSequenceNumber: number;
  name: string | null;
  sections: URLASectionScore[];
}

export interface MISMOValidationResult {
  applicationId: string;
  overallScore: number;
  gseReady: boolean;
  /** True when a required field in a gating section (1a, 4, 5) is missing. */
  gseGatingFailed: boolean;
  ulddCompliant: boolean;
  sections: URLASectionScore[];
  coApplicants: CoApplicantScore[];
  coApplicantLimitation: string | null;
  criticalErrors: string[];
  warnings: string[];
  missingDocuments: string[];
  /** ATR/QM points-and-fees evaluation. */
  qmStatus: "QM" | "Non-QM" | "Unknown";
  pointsAndFeesCompliant: boolean;
  armValidation: {
    applicable: boolean;
    valid: boolean;
    issues: string[];
  };
  hmdaLar: {
    actionTakenProvided: boolean;
    denialReasonsValid: boolean;
    issues: string[];
  };
  tridStatus: {
    leRequired: boolean;
    leDueDate: Date | null;
    leIssued: boolean;
    cdRequired: boolean;
    cdDueDate: Date | null;
    cdIssued: boolean;
  };
}

const GATING_SECTIONS = ["1a", "4", "5"];

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function scoreSection(
  sectionName: string,
  sectionNumber: string,
  fields: { name: string; value: unknown; required: boolean }[]
): URLASectionScore {
  const requiredFields = fields.filter(f => f.required);
  const completedRequired = requiredFields.filter(f => hasValue(f.value));
  const missingFields = requiredFields
    .filter(f => !hasValue(f.value))
    .map(f => f.name);

  const optionalFields = fields.filter(f => !f.required);
  const completedOptional = optionalFields.filter(f => hasValue(f.value));

  const warnings = optionalFields
    .filter(f => !hasValue(f.value))
    .map(f => `${f.name} is recommended but not provided`);

  const requiredWeight = 0.8;
  const optionalWeight = 0.2;

  // If a section has required fields but ALL are missing, it scores 0 — do not
  // award the optional weight for free. If a section has no required fields,
  // distribute the full weight across whatever fields exist.
  let completeness: number;
  if (requiredFields.length > 0) {
    const requiredScore = (completedRequired.length / requiredFields.length) * requiredWeight;
    // Only credit optional weight when there are optional fields present.
    const optionalScore = optionalFields.length > 0
      ? (completedOptional.length / optionalFields.length) * optionalWeight
      : 0;
    // When there are no optional fields, scale required up to fill 100%.
    const denominator = optionalFields.length > 0 ? requiredWeight + optionalWeight : requiredWeight;
    completeness = Math.round(((requiredScore + optionalScore) / denominator) * 100);
  } else if (optionalFields.length > 0) {
    completeness = Math.round((completedOptional.length / optionalFields.length) * 100);
  } else {
    completeness = 100;
  }

  return {
    section: sectionName,
    sectionNumber,
    completeness,
    requiredFields: requiredFields.length,
    completedFields: completedRequired.length,
    missingFields,
    warnings,
    gating: GATING_SECTIONS.includes(sectionNumber),
  };
}

// ---------------------------------------------------------------------------
// Date helpers — TRID business-day math lives in services/businessDays.ts
// (shared with services/trid.ts and services/loanEstimate.ts).
// ---------------------------------------------------------------------------

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = typeof value === "string" ? new Date(value) : value;
  return isNaN(d.getTime()) ? null : d;
}

function yearsSince(dateStr: string | null | undefined): number | null {
  const d = parseDate(dateStr);
  if (!d) return null;
  const now = new Date();
  return (now.getTime() - d.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Section scorers
// ---------------------------------------------------------------------------

function scorePersonalInfo(personalInfo: UrlaPersonalInfo | null | undefined): URLASectionScore {
  const fields = [
    { name: "First Name", value: personalInfo?.firstName, required: true },
    { name: "Last Name", value: personalInfo?.lastName, required: true },
    // SSN is encrypted at rest; presence (masked) is all validation needs.
    { name: "SSN", value: personalInfo?.ssnLast4 ? `XXX-XX-${personalInfo.ssnLast4}` : undefined, required: true },
    { name: "Date of Birth", value: personalInfo?.dateOfBirth, required: true },
    { name: "Citizenship Status", value: personalInfo?.citizenship, required: true },
    { name: "Marital Status", value: personalInfo?.maritalStatus, required: true },
    { name: "Email", value: personalInfo?.email, required: false },
    { name: "Cell Phone", value: personalInfo?.cellPhone, required: false },
    { name: "Current Street Address", value: personalInfo?.currentStreet, required: true },
    { name: "Current City", value: personalInfo?.currentCity, required: true },
    { name: "Current State", value: personalInfo?.currentState, required: true },
    { name: "Current Zip", value: personalInfo?.currentZip, required: true },
    { name: "Housing Status", value: personalInfo?.currentHousingType, required: true },
  ];

  return scoreSection("Personal Information", "1a", fields);
}

function scoreEmployment(employment: EmploymentHistory[]): URLASectionScore {
  const currentEmployment = employment.find(e => e.employmentType === "current");
  const priorEmployment = employment.find(e => e.employmentType === "previous" || e.employmentType === "prior");

  // If the borrower has under two years at the current job, prior employer
  // becomes required. This is the URLA/Form 1003 two-year employment-history
  // CAPTURE convention — a completeness rule for the form, not an eligibility
  // test. Do not read it as a Guide minimum: B3-3.2-02 says a two-year history
  // "is recommended", and income received for as little as 12 months may be
  // acceptable where positive factors reasonably offset the shorter history.
  // ("Freddie" dropped from this comment on 2026-08-23: no Freddie source is
  // captured in-repo, so nothing here could verify a claim about their rules.)
  const yearsAtCurrent = yearsSince(currentEmployment?.startDate);
  const needsPriorEmployer = yearsAtCurrent !== null && yearsAtCurrent < 2;

  const fields = [
    { name: "Employer Name", value: currentEmployment?.employerName, required: true },
    { name: "Position/Title", value: currentEmployment?.positionTitle, required: true },
    { name: "Start Date", value: currentEmployment?.startDate, required: true },
    { name: "Monthly Income", value: currentEmployment?.monthlyIncomeOrLoss, required: true },
    { name: "Business Phone", value: currentEmployment?.employerPhone, required: false },
    { name: "Employer Address", value: currentEmployment?.employerStreet, required: false },
    { name: "Self Employed", value: currentEmployment?.isSelfEmployed !== undefined && currentEmployment?.isSelfEmployed !== null, required: false },
    { name: "Prior Employer Name (2-year history required)", value: priorEmployment?.employerName, required: needsPriorEmployer },
    { name: "Prior Employer Start Date", value: priorEmployment?.startDate, required: needsPriorEmployer },
    { name: "Prior Employer End Date", value: priorEmployment?.endDate, required: needsPriorEmployer },
  ];

  return scoreSection("Employment", "1b-1d", fields);
}

function scoreOtherIncome(otherIncome: OtherIncomeSource[]): URLASectionScore {
  // Other income (1e) is optional in aggregate, but when a source is declared
  // its source and amount become required for that entry.
  const hasSources = otherIncome.length > 0;
  const fields: { name: string; value: unknown; required: boolean }[] = [
    { name: "Other income reviewed", value: "yes", required: true },
  ];

  if (hasSources) {
    otherIncome.forEach((src, i) => {
      fields.push(
        { name: `Income Source #${i + 1} Type`, value: src.incomeSource, required: true },
        { name: `Income Source #${i + 1} Monthly Amount`, value: src.monthlyAmount, required: true },
      );
    });
  } else {
    fields.push({ name: "Additional income sources (if any)", value: null, required: false });
  }

  return scoreSection("Other Income", "1e", fields);
}

function scoreAssets(assets: UrlaAsset[]): URLASectionScore {
  const hasAssets = assets.length > 0;
  const totalValue = assets.reduce((sum, a) => sum + Number(a.cashOrMarketValue || 0), 0);

  const fields: { name: string; value: unknown; required: boolean }[] = [
    { name: "At least one asset account", value: hasAssets ? "yes" : null, required: true },
    { name: "Total Assets > $0", value: totalValue > 0 ? "yes" : null, required: true },
  ];

  if (assets.length > 0) {
    const firstAsset = assets[0];
    fields.push(
      { name: "Account Type", value: firstAsset.accountType, required: true },
      { name: "Financial Institution", value: firstAsset.financialInstitution, required: true },
      { name: "Account Balance", value: firstAsset.cashOrMarketValue, required: true },
    );
  }

  return scoreSection("Assets & Accounts", "2a", fields);
}

function scoreLiabilities(liabilities: UrlaLiability[]): URLASectionScore {
  // "Liabilities disclosed" reflects actual stored data: a borrower with at
  // least one liability row has affirmatively disclosed. A borrower with none
  // is treated as "no liabilities reported" (still a valid disclosure state),
  // so the section is satisfied either way but real liability details, when
  // present, must be complete.
  const fields: { name: string; value: unknown; required: boolean }[] = [
    { name: "Liabilities Disclosed", value: liabilities.length > 0 ? "yes" : "none reported", required: true },
  ];

  if (liabilities.length > 0) {
    const firstLiability = liabilities[0];
    fields.push(
      { name: "Liability Type", value: firstLiability.liabilityType, required: true },
      { name: "Creditor Name", value: firstLiability.creditorName, required: false },
      { name: "Monthly Payment", value: firstLiability.monthlyPayment, required: true },
      { name: "Unpaid Balance", value: firstLiability.unpaidBalance, required: false },
    );
  }

  return scoreSection("Liabilities & Debts", "2b", fields);
}

function scoreRealEstateOwned(application: LoanApplication, reo: RealEstateOwned[]): URLASectionScore {
  // Section 2c (REO) is only meaningful when the borrower actually owns
  // property. Disclosure is derived from the real real_estate_owned rows
  // rather than a hardcoded assumption.
  const hasReo = reo.length > 0;
  const fields: { name: string; value: unknown; required: boolean }[] = [
    {
      name: "Real estate ownership reviewed",
      value: application.ownsOtherRealEstate === null || application.ownsOtherRealEstate === undefined ? null : "yes",
      required: true,
    },
  ];

  if (application.ownsOtherRealEstate === true && hasReo) {
    reo.forEach((p, i) => {
      fields.push(
        { name: `REO #${i + 1} Address`, value: p.propertyAddress, required: true },
        { name: `REO #${i + 1} Market Value`, value: p.marketValue, required: true },
        { name: `REO #${i + 1} Mortgage Balance`, value: p.mortgageBalance, required: true },
        { name: `REO #${i + 1} Occupancy/Status`, value: p.status || p.occupancyType, required: true },
      );
    });
  } else if (application.ownsOtherRealEstate === true) {
    fields.push({ name: "Owned property details", value: null, required: true });
  } else {
    fields.push({ name: "Owned properties (if any)", value: null, required: false });
  }

  return scoreSection("Real Estate Owned", "2c", fields);
}

function scorePropertyInfo(
  application: LoanApplication,
  propertyInfo: UrlaPropertyInfo | null | undefined
): URLASectionScore {
  const associationRequired = [
    "condo",
    "condominium",
    "co_op",
    "coop",
    "planned_unit_development",
    "townhouse",
    "townhome",
    "town_house",
    "town_home",
  ].includes((application.propertyType ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_"));
  const subordinateExists = propertyInfo?.subordinateFinancingExists === true;
  const fields = [
    { name: "Property Address", value: propertyInfo?.propertyStreet || application.propertyAddress, required: true },
    { name: "Property City", value: propertyInfo?.propertyCity || application.propertyCity, required: true },
    { name: "Property State", value: propertyInfo?.propertyState || application.propertyState, required: true },
    { name: "Property Zip", value: propertyInfo?.propertyZip || application.propertyZip, required: true },
    { name: "Property Type", value: application.propertyType, required: true },
    { name: "Occupancy Type", value: propertyInfo?.occupancyType, required: true },
    { name: "Number of Units", value: propertyInfo?.numberOfUnits, required: false },
    { name: "Monthly HOA / co-op dues", value: propertyInfo?.monthlyAssociationDues, required: associationRequired },
    { name: "Monthly flood insurance", value: propertyInfo?.monthlyFloodInsurance, required: true },
    { name: "Monthly ground rent", value: propertyInfo?.monthlyGroundRent, required: true },
    { name: "Monthly special assessments", value: propertyInfo?.monthlySpecialAssessments, required: true },
    {
      name: "Subordinate financing disclosure",
      value: propertyInfo?.subordinateFinancingExists,
      required: true,
    },
    {
      name: "Closed-end subordinate balance",
      value: propertyInfo?.closedEndSubordinateBalance,
      required: subordinateExists,
    },
    { name: "HELOC drawn balance", value: propertyInfo?.helocDrawnBalance, required: subordinateExists },
    { name: "HELOC credit limit", value: propertyInfo?.helocCreditLimit, required: subordinateExists },
    {
      name: "Monthly subordinate financing payment",
      value: propertyInfo?.monthlySubordinateFinancingPayment,
      required: subordinateExists,
    },
  ];

  return scoreSection("Property Information", "3", fields);
}

function scoreLoanInfo(application: LoanApplication): URLASectionScore {
  const loanAmount = application.purchasePrice && application.downPayment
    ? Number(application.purchasePrice) - Number(application.downPayment)
    : null;

  const fields = [
    { name: "Loan Purpose", value: application.loanPurpose, required: true },
    { name: "Loan Type", value: application.preferredLoanType, required: true },
    { name: "Amortization Type", value: application.amortizationType, required: true },
    { name: "Purchase Price", value: application.purchasePrice, required: true },
    { name: "Down Payment", value: application.downPayment, required: true },
    { name: "Loan Amount", value: loanAmount, required: true },
    { name: "Credit Score", value: application.creditScore, required: true },
    { name: "LTV Ratio", value: application.ltvRatio, required: false },
    { name: "DTI Ratio", value: application.dtiRatio, required: false },
  ];

  return scoreSection("Loan Details", "4", fields);
}

function scoreDeclarations(declarations: BorrowerDeclarations | null | undefined): URLASectionScore {
  const fields = [
    { name: "Primary Residence Intent", value: declarations?.willOccupyAsPrimaryResidence, required: true },
    { name: "Ownership Interest in Property", value: declarations?.hasOwnershipInterestInPast3Years, required: true },
    { name: "Money Borrowed for Transaction", value: declarations?.isBorrowingForDownPayment, required: true },
    { name: "Outstanding Judgments", value: declarations?.hasOutstandingJudgments, required: true },
    { name: "Delinquent Federal Debt", value: declarations?.isDelinquentOnFederalDebt, required: true },
    { name: "Lawsuit Party", value: declarations?.isPartyToLawsuit, required: true },
    { name: "Conveyed Title", value: declarations?.hasConveyedTitleInLieuOfForeclosure, required: true },
    { name: "Pre-Foreclosure", value: declarations?.hasBeenForeclosed, required: true },
    { name: "Bankruptcy Declaration", value: declarations?.hasDeclaredBankruptcy, required: true },
    // Citizenship is deliberately NOT scored here. On the URLA it is Section 1a
    // ("Citizenship: U.S. Citizen / Permanent Resident Alien / Non-Permanent
    // Resident Alien"), not a Section 5 declaration — Section 5 is exactly the
    // eleven questions A–K above. server/mismo.ts says the same thing at its
    // CitizenshipResidencyType mapping ("URLA §1, not §5").
    //
    // It used to require `declarations.isUSCitizen`, a second representation of
    // a fact the borrower already gives in Section 1a — and nothing has ever
    // written that column. Since section 5 is a GSE gating section, that single
    // line blocked EVERY real application from delivery readiness, permanently.
    // It went unnoticed because server/scripts/seedDemoFile.ts sets the field,
    // so demo files passed the gate that no genuine file could.
    //
    // The fact is still required — scoreIdentity asserts `personalInfo.citizenship`
    // in section 1a, which is also a gating section, and that IS the field the
    // borrower fills in. Removing it here narrows a duplicate, not a control.
  ];

  return scoreSection("Borrower Declarations", "5", fields);
}

function scoreMilitary(
  application: LoanApplication,
  profile: BorrowerProfile | null | undefined
): URLASectionScore {
  // Section 6 (Military Service) is only required when the borrower is pursuing
  // a VA loan; otherwise the fields are optional disclosures.
  const isVa = (application.preferredLoanType || "").toLowerCase() === "va";
  const fields = [
    { name: "Military Service Status", value: profile?.militaryStatus, required: isVa },
    { name: "Service Branch", value: profile?.militaryBranch, required: isVa },
    { name: "Service Start Date", value: profile?.militaryServiceStart, required: false },
    { name: "VA Entitlement / Funding Fee Status", value: (profile?.vaEntitlementUsed !== undefined && profile?.vaEntitlementUsed !== null) || (profile?.vaFundingFeeExempt !== undefined && profile?.vaFundingFeeExempt !== null) ? "yes" : null, required: isVa },
  ];

  return scoreSection("Military Service", "6", fields);
}

function scoreDemographics(demographic: HmdaDemographics | null | undefined): URLASectionScore {
  // Section 7 (HMDA/Demographic Information). A borrower's recorded REFUSAL to
  // provide is itself compliant collection under Reg C, so "not provided"
  // flags satisfy the requirement.
  const ethnicityCollected =
    demographic?.ethnicityHispanicLatino !== null && demographic?.ethnicityHispanicLatino !== undefined
    || !!demographic?.ethnicityNotHispanicLatino
    || !!demographic?.ethnicityNotProvided;

  const raceCollected =
    !!demographic?.raceAmericanIndian || !!demographic?.raceAsian || !!demographic?.raceBlack
    || !!demographic?.raceNativeHawaiian || !!demographic?.raceWhite || !!demographic?.raceNotProvided;

  const sexCollected =
    demographic?.sexFemale !== null && demographic?.sexFemale !== undefined
    || demographic?.sexMale !== null && demographic?.sexMale !== undefined
    || !!demographic?.sexNotProvided;

  const fields = [
    { name: "Ethnicity collected (or refusal recorded)", value: ethnicityCollected ? "yes" : null, required: true },
    { name: "Race collected (or refusal recorded)", value: raceCollected ? "yes" : null, required: true },
    { name: "Sex collected (or refusal recorded)", value: sexCollected ? "yes" : null, required: true },
    { name: "Collection Method", value: demographic?.collectionMethod, required: true },
  ];

  return scoreSection("Demographic Information", "7", fields);
}

// ---------------------------------------------------------------------------
// Regulatory validation: ARM, ATR/QM, HMDA LAR
// ---------------------------------------------------------------------------

function validateArm(application: LoanApplication): MISMOValidationResult["armValidation"] {
  const isAdjustable = (application.amortizationType || "").toLowerCase() === "adjustable";
  if (!isAdjustable) {
    return { applicable: false, valid: true, issues: [] };
  }

  const issues: string[] = [];
  if (!hasValue(application.armIndexType)) issues.push("ARM index type is required for adjustable-rate loans");
  if (!hasValue(application.armMargin)) issues.push("ARM margin is required for adjustable-rate loans");
  if (!hasValue(application.armInitialRate)) issues.push("ARM initial rate is required for adjustable-rate loans");
  if (!hasValue(application.armInitialCap)) issues.push("ARM initial adjustment cap is required");
  if (!hasValue(application.armPeriodicCap)) issues.push("ARM periodic adjustment cap is required");
  if (!hasValue(application.armLifetimeCap)) issues.push("ARM lifetime cap is required");
  if (!hasValue(application.armAdjustmentFrequencyMonths)) issues.push("ARM adjustment frequency is required");

  return { applicable: true, valid: issues.length === 0, issues };
}

/**
 * ATR/QM points-and-fees check, Reg Z 1026.43(e)(2)(iii) tiered caps
 * (8% / $ / 5% / $ / 3% by loan amount) per the Loan Delivery QM Edits Job Aid.
 *
 * Two evidence tiers, because pre-closing there is rarely an authoritative
 * figure:
 *
 *   1. `totalPointsAndFees` present — the closing-side figure. Conclusive
 *      either way.
 *   2. Absent — compute the LOWER BOUND from the platform's own charges plus
 *      originator compensation (shared/compliance/loCompensation.ts). A floor
 *      over the cap is a definitive failure; a floor under it proves nothing
 *      and is reported as a warning, never as a pass.
 *
 * This function previously returned `compliant: true` whenever the figure was
 * missing — and nothing in the product ever wrote that column, so the gate
 * passed every file silently. Missing evidence now produces a warning or a
 * block, never a clean bill.
 */
function evaluatePointsAndFees(
  application: LoanApplication,
  feeSchedule: PlatformFeeSchedule,
): {
  qmStatus: "QM" | "Non-QM" | "Unknown";
  compliant: boolean;
  issue: string | null;
  warning: string | null;
} {
  const loanAmount = application.purchasePrice && application.downPayment
    ? Number(application.purchasePrice) - Number(application.downPayment)
    : null;
  const pointsAndFees = hasValue(application.totalPointsAndFees) ? Number(application.totalPointsAndFees) : null;

  if (loanAmount === null || loanAmount <= 0) {
    return { qmStatus: "Unknown", compliant: true, issue: null, warning: null };
  }

  // Thresholds are selected by note-date year; pre-closing there is no note
  // date yet, so the closing date (when scheduled) or today's date stands in
  // as the expected note year. The delivery-readiness edits re-check against
  // the actual note date.
  const noteDate = estimatedNoteDate(application.closingDate);

  // Regulation Z Total Loan Amount (§1026.32(b)(4)) — the amount financed less
  // the financed points and fees. It is ALWAYS less than the note amount, so
  // standing in the note amount (as this did) overstates the percentage cap and
  // makes the check permissive, not conservative — the opposite of what the
  // old comment claimed (audit F-12).
  //
  // Derived here from the platform's own origination-side prepaid finance
  // charges, which are known before closing. That under-counts the true prepaid
  // finance charges (prepaid interest and prepaid MI need a closing date), so
  // the result remains an UPPER bound on the true Total Loan Amount and the cap
  // it yields is still slightly permissive — but strictly tighter than the note
  // amount, never looser. A near-cap file is still re-checked at delivery
  // against the real figure.
  const compensationForBasis = resolveCompensation(
    application.loCompensationModel,
    application.loCompensationBps,
  );
  // Derived by services/loanCosts.ts, which owns the fee schedule this is
  // computed from — the same helper the compensation election scores against,
  // so the two surfaces cannot drift (audit F-18).
  const regZTotalLoanAmountStandIn = regulationZTotalLoanAmountStandIn(
    loanAmount,
    compensationForBasis,
  );

  if (pointsAndFees !== null) {
    const evaluation = evaluateCoveredPointsAndFees(
      noteDate,
      loanAmount,
      regZTotalLoanAmountStandIn,
      pointsAndFees,
    );
    if (!evaluation.evaluated) {
      return {
        qmStatus: "Unknown",
        compliant: true,
        issue: null,
        warning: evaluation.reason ?? "QM points-and-fees cap could not be evaluated",
      };
    }
    if (!evaluation.compliant) {
      return {
        qmStatus: "Non-QM",
        compliant: false,
        issue: `Points and fees ($${pointsAndFees.toFixed(2)}) exceed the QM cap ($${evaluation.maxAllowableAmount?.toFixed(2)}; ${evaluation.tierDescription})`,
        warning: null,
      };
    }
    return { qmStatus: "QM", compliant: true, issue: null, warning: null };
  }

  // No authoritative figure. Fall back to the computed floor.
  const compensation = compensationForBasis;
  if (!compensation) {
    return {
      qmStatus: "Unknown",
      compliant: true,
      issue: null,
      warning:
        "Points and fees not evaluated: no loan originator compensation elected on this file " +
        "(12 CFR 1026.36(d)(2)), so the QM cap cannot be checked even approximately.",
    };
  }

  const floorEvaluation = evaluateFileQmFloor(noteDate, loanAmount, compensation, feeSchedule);

  if (floorEvaluation.verdict === "over_cap") {
    return {
      qmStatus: "Non-QM",
      compliant: false,
      issue: floorEvaluation.message,
      warning: null,
    };
  }
  return {
    qmStatus: "Unknown",
    compliant: true,
    issue: null,
    warning: floorEvaluation.message,
  };
}

function validateHmdaLar(application: LoanApplication): MISMOValidationResult["hmdaLar"] {
  const issues: string[] = [];
  const actionTaken = application.hmdaActionTaken;
  const actionTakenProvided = hasValue(actionTaken);

  if (!actionTakenProvided) {
    issues.push("HMDA action-taken code is required for LAR reporting");
  }

  const isDenied = (actionTaken || "").toLowerCase().includes("deni")
    || actionTaken === "3";
  const denialReasons = application.hmdaDenialReasons || [];
  let denialReasonsValid = true;

  if (isDenied) {
    if (denialReasons.length < 2) {
      denialReasonsValid = false;
      issues.push("At least 2 denial reasons are required when the application is denied (HMDA LAR)");
    }
  }

  return {
    actionTakenProvided,
    denialReasonsValid,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Everything the validator reads. Loading is separated from scoring so a list
 * view can load N applications in a fixed number of queries and still run the
 * IDENTICAL scoring function — the compliance dashboard used to call the
 * single-application path in a loop, which cost 15 queries per file
 * (CTO_ROADMAP §3.2, "the last N+1 loop").
 *
 * Verdicts are unchanged by construction: there is exactly one scoring
 * implementation and both entry points call it. Only the loading differs.
 */
export interface MISMOValidationInputs {
  application: LoanApplication;
  urlaData: CompleteUrlaData;
  conditions: LoanCondition[];
  documents: Document[];
  borrowerProfile: BorrowerProfile | undefined;
  feeSchedule: PlatformFeeSchedule;
}

/** Load one application's validator inputs. Throws when the application is gone. */
async function loadValidationInputs(applicationId: string): Promise<MISMOValidationInputs> {
  const application = await storage.getLoanApplication(applicationId);
  if (!application) {
    throw new Error("Application not found");
  }

  const [urlaData, conditions, documents, borrowerProfile, feeSchedule] = await Promise.all([
    storage.getCompleteUrlaData(applicationId),
    storage.getLoanConditionsByApplication(applicationId),
    storage.getDocumentsByApplication(applicationId),
    storage.getBorrowerProfileByUserId(application.userId),
    activeFeeSchedule(),
  ]);

  return { application, urlaData, conditions, documents, borrowerProfile, feeSchedule };
}

export async function validateMISMOCompleteness(applicationId: string): Promise<MISMOValidationResult> {
  return evaluateMISMOCompleteness(await loadValidationInputs(applicationId));
}

/**
 * Score one application. Pure: no storage, no clock beyond what the inputs
 * carry, no vendor calls — same inputs, same verdict.
 */
export function evaluateMISMOCompleteness(inputs: MISMOValidationInputs): MISMOValidationResult {
  const { application, urlaData, conditions, documents, borrowerProfile, feeSchedule } = inputs;
  const applicationId = application.id;

  const hmdaRows = urlaData.hmdaDemographics || [];
  const primaryHmda =
    hmdaRows.find(h => (h.borrowerSequenceNumber ?? 1) === 1)
    || hmdaRows.find(h => h.borrowerId === application.userId)
    || hmdaRows[0];

  const personalInfoScore = scorePersonalInfo(urlaData.personalInfo);
  const employmentScore = scoreEmployment(urlaData.employmentHistory.filter(e => (e.borrowerSequenceNumber ?? 1) === 1));
  const otherIncomeScore = scoreOtherIncome(
    urlaData.otherIncomeSources.filter(income => (income.borrowerSequenceNumber ?? 1) === 1),
  );
  const assetsScore = scoreAssets(urlaData.assets.filter(a => (a.borrowerSequenceNumber ?? 1) === 1));
  const liabilitiesScore = scoreLiabilities(urlaData.liabilities.filter(l => (l.borrowerSequenceNumber ?? 1) === 1));
  const reoScore = scoreRealEstateOwned(application, urlaData.realEstateOwned);
  const propertyScore = scorePropertyInfo(application, urlaData.propertyInfo);
  const loanScore = scoreLoanInfo(application);
  const declarationsScore = scoreDeclarations(urlaData.declarations);
  const militaryScore = scoreMilitary(application, borrowerProfile);
  const demographicsScore = scoreDemographics(primaryHmda);

  const sections = [
    personalInfoScore,
    employmentScore,
    otherIncomeScore,
    assetsScore,
    liabilitiesScore,
    reoScore,
    propertyScore,
    loanScore,
    declarationsScore,
    militaryScore,
    demographicsScore,
  ];

  // -------------------------------------------------------------------------
  // Co-applicant scoring (scored independently from the primary borrower).
  // -------------------------------------------------------------------------
  const coApplicants: CoApplicantScore[] = [];
  let coApplicantLimitation: string | null = null;

  const coEmploymentSeqs = new Set(
    urlaData.employmentHistory
      .map(e => e.borrowerSequenceNumber ?? 1)
      .filter(seq => seq > 1)
  );
  const coOtherIncomeSeqs = new Set(
    urlaData.otherIncomeSources
      .map(income => income.borrowerSequenceNumber ?? 1)
      .filter(seq => seq > 1)
  );
  const coAssetSeqs = new Set(
    urlaData.assets.map(a => a.borrowerSequenceNumber ?? 1).filter(seq => seq > 1)
  );
  const coLiabilitySeqs = new Set(
    urlaData.liabilities.map(l => l.borrowerSequenceNumber ?? 1).filter(seq => seq > 1)
  );
  const coHmda = hmdaRows.filter(h => (h.borrowerSequenceNumber ?? 1) > 1);
  const coHmdaSeqs = new Set(coHmda.map(h => h.borrowerSequenceNumber ?? 1));
  const coPersonalInfoSeqs = new Set(
    (urlaData.allPersonalInfo || [])
      .map(p => p.borrowerSequenceNumber ?? 1)
      .filter(seq => seq > 1)
  );
  const coDeclarationSeqs = new Set(
    (urlaData.allDeclarations || [])
      .map(d => d.borrowerSequenceNumber ?? 1)
      .filter(seq => seq > 1)
  );

  const coSequences = new Set<number>([
    ...Array.from(coPersonalInfoSeqs),
    ...Array.from(coEmploymentSeqs),
    ...Array.from(coOtherIncomeSeqs),
    ...Array.from(coAssetSeqs),
    ...Array.from(coLiabilitySeqs),
    ...Array.from(coDeclarationSeqs),
    ...Array.from(coHmdaSeqs),
  ]);

  for (const seq of Array.from(coSequences).sort((a, b) => a - b)) {
    const coEmployment = urlaData.employmentHistory.filter(e => (e.borrowerSequenceNumber ?? 1) === seq);
    const coOtherIncome = urlaData.otherIncomeSources.filter(
      income => (income.borrowerSequenceNumber ?? 1) === seq,
    );
    const coAssets = urlaData.assets.filter(a => (a.borrowerSequenceNumber ?? 1) === seq);
    const coLiabilities = urlaData.liabilities.filter(l => (l.borrowerSequenceNumber ?? 1) === seq);
    const coDemographic = coHmda.find(h => (h.borrowerSequenceNumber ?? 1) === seq);
    const coPersonal = (urlaData.allPersonalInfo || []).find(p => (p.borrowerSequenceNumber ?? 1) === seq);
    const coName = coPersonal
      ? [coPersonal.firstName, coPersonal.lastName].filter(Boolean).join(" ").trim() || null
      : null;

    coApplicants.push({
      borrowerSequenceNumber: seq,
      name: coName,
      sections: [
        scoreEmployment(coEmployment),
        scoreOtherIncome(coOtherIncome),
        scoreAssets(coAssets),
        scoreLiabilities(coLiabilities),
        scoreDemographics(coDemographic),
      ],
    });
  }

  // Surface a limitation note when the application indicates a co-borrower
  // exists but the data model holds no per-co-applicant URLA rows yet.
  const declaresCoBorrower =
    !!borrowerProfile?.hasCoBorrower
    || hasValue(urlaData.personalInfo?.coBorrowerNames)
    || (urlaData.personalInfo?.totalBorrowers ?? 1) > 1;
  if (declaresCoBorrower && coApplicants.length === 0) {
    coApplicantLimitation =
      "A co-borrower is indicated for this application, but no per-co-applicant URLA records are stored. Co-applicant personal info, employment, other income, assets, liabilities, declarations, and demographics must be captured (borrowerSequenceNumber > 1) to be scored independently.";
  }

  const overallScore = Math.round(
    sections.reduce((sum, s) => sum + s.completeness, 0) / sections.length
  );

  const criticalErrors: string[] = [];
  const warnings: string[] = [];

  sections.forEach(section => {
    section.missingFields.forEach(field => {
      criticalErrors.push(`${section.section}: ${field} is required`);
    });
    section.warnings.forEach(warning => {
      warnings.push(`${section.section}: ${warning}`);
    });
  });

  coApplicants.forEach(co => {
    const coLabel = co.name
      ? `Co-applicant #${co.borrowerSequenceNumber} (${co.name})`
      : `Co-applicant #${co.borrowerSequenceNumber}`;
    co.sections.forEach(section => {
      section.missingFields.forEach(field => {
        criticalErrors.push(`${coLabel} ${section.section}: ${field} is required`);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Regulatory validation
  // -------------------------------------------------------------------------
  const armValidation = validateArm(application);
  armValidation.issues.forEach(i => criticalErrors.push(`ARM: ${i}`));

  const pointsAndFees = evaluatePointsAndFees(application, feeSchedule);
  if (pointsAndFees.issue) {
    criticalErrors.push(`ATR/QM: ${pointsAndFees.issue}`);
  }
  if (pointsAndFees.warning) {
    warnings.push(`ATR/QM: ${pointsAndFees.warning}`);
  }

  const hmdaLar = validateHmdaLar(application);
  hmdaLar.issues.forEach(i => warnings.push(`HMDA LAR: ${i}`));

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------
  const outstandingConditions = conditions.filter(c => c.status === "outstanding");
  const requiredDocTypes = outstandingConditions
    .flatMap(c => c.requiredDocumentTypes || [])
    .filter((v, i, a) => a.indexOf(v) === i);

  const uploadedDocTypes = documents.map(d => d.documentType);
  const missingDocuments = requiredDocTypes.filter(t => !uploadedDocTypes.includes(t));

  // -------------------------------------------------------------------------
  // TRID date math (business days, excluding weekends + federal holidays)
  // -------------------------------------------------------------------------
  // LE must be delivered/placed in the mail no later than 3 business days
  // after application (Reg Z 1026.19(e)(1)(iii)). The clock anchors to the
  // moment the 6th piece of application information arrived
  // (tridTriggeredAt, written by services/trid.ts) — NOT to record
  // creation: a draft opened during pre-approval predates the regulatory
  // application.
  const tridTriggeredAt = parseDate(application.tridTriggeredAt);
  const leDueDate = tridTriggeredAt ? addBusinessDays(tridTriggeredAt, 3) : null;

  const closingDate = parseDate(application.closingDate);
  // CD must be received by the borrower at least 3 business days before
  // consummation (Reg Z 1026.19(f)(1)(ii)).
  const cdDueDate = closingDate ? subtractBusinessDays(closingDate, 3) : null;

  const leIssued = hasValue(application.leIssuedDate);
  const cdIssued = hasValue(application.cdIssuedDate);

  // -------------------------------------------------------------------------
  // GSE / ULDD gating
  // -------------------------------------------------------------------------
  const gatingSections = sections.filter(s => s.gating);
  const gseGatingFailed = gatingSections.some(s => s.missingFields.length > 0);

  const gseReady =
    overallScore >= 90 &&
    !gseGatingFailed &&
    criticalErrors.length === 0 &&
    missingDocuments.length === 0 &&
    armValidation.valid &&
    pointsAndFees.compliant;

  const ulddCompliant =
    overallScore >= 80 &&
    !gseGatingFailed &&
    personalInfoScore.completeness >= 90 &&
    loanScore.completeness >= 90;

  return {
    applicationId,
    overallScore,
    gseReady,
    gseGatingFailed,
    ulddCompliant,
    sections,
    coApplicants,
    coApplicantLimitation,
    criticalErrors,
    warnings,
    missingDocuments,
    qmStatus: pointsAndFees.qmStatus,
    pointsAndFeesCompliant: pointsAndFees.compliant,
    armValidation,
    hmdaLar,
    tridStatus: {
      leRequired: !!tridTriggeredAt,
      leDueDate,
      leIssued,
      cdRequired: application.status === "clear_to_close",
      cdDueDate,
      cdIssued,
    },
  };
}

/**
 * Score many applications with a fixed number of queries (13 total: 9 URLA + 1
 * conditions + 1 documents + 1 borrower profiles + 1 cached fee schedule)
 * rather than 15 per application.
 *
 * Takes the application ROWS, not ids: every caller is a list view that already
 * holds them, and re-reading each one was itself part of the N+1.
 *
 * Applications whose scoring throws are omitted, matching the per-application
 * callers' `.catch(() => null)` — a single unscoreable file must not blank the
 * whole dashboard.
 */
export async function validateMISMOCompletenessBatch(
  applications: LoanApplication[],
): Promise<Map<string, MISMOValidationResult>> {
  const results = new Map<string, MISMOValidationResult>();
  if (applications.length === 0) return results;

  const applicationIds = applications.map(a => a.id);
  const userIds = Array.from(new Set(applications.map(a => a.userId)));

  const [urlaByApp, conditionsByApp, documentsByApp, profilesByUser, feeSchedule] =
    await Promise.all([
      storage.getCompleteUrlaDataBatch(applicationIds),
      storage.getLoanConditionsByApplications(applicationIds),
      storage.getDocumentsByApplications(applicationIds),
      storage.getBorrowerProfilesByUserIds(userIds),
      activeFeeSchedule(),
    ]);

  for (const application of applications) {
    const urlaData = urlaByApp.get(application.id);
    // A missing URLA bucket means the batch loader was not asked for this id;
    // scoring it against empty data would report a real file as 0% complete, so
    // skip it the way an individual failure is skipped.
    if (!urlaData) continue;
    try {
      results.set(
        application.id,
        evaluateMISMOCompleteness({
          application,
          urlaData,
          conditions: conditionsByApp.get(application.id) ?? [],
          documents: documentsByApp.get(application.id) ?? [],
          borrowerProfile: profilesByUser.get(application.userId),
          feeSchedule,
        }),
      );
    } catch {
      // Omitted, as the per-application path does.
    }
  }
  return results;
}

/** The dashboard-shaped summary of an already-computed validation. */
export function toValidationSummary(validation: MISMOValidationResult) {
  const applicationId = validation.applicationId;
  return {
    applicationId,
    score: validation.overallScore,
    gseReady: validation.gseReady,
    gseGatingFailed: validation.gseGatingFailed,
    ulddCompliant: validation.ulddCompliant,
    qmStatus: validation.qmStatus,
    criticalCount: validation.criticalErrors.length,
    warningCount: validation.warnings.length,
    missingDocsCount: validation.missingDocuments.length,
    coApplicantCount: validation.coApplicants.length,
    coApplicants: validation.coApplicants.map(co => ({
      borrowerSequenceNumber: co.borrowerSequenceNumber,
      name: co.name,
    })),
    sections: validation.sections.map(s => ({
      name: s.section,
      number: s.sectionNumber,
      score: s.completeness,
      complete: s.completeness >= 90,
      gating: !!s.gating,
    })),
  };
}

export async function getApplicationValidationSummary(applicationId: string) {
  return toValidationSummary(await validateMISMOCompleteness(applicationId));
}

/**
 * Dashboard summaries for many applications, in one batched load.
 *
 * Takes rows rather than ids: this used to map ids through the
 * single-application path, which re-read each application and made 15 queries
 * per file. It had no callers, so the shape was free to fix — but leaving the
 * N+1 spelling in place would have handed it to whoever called it next.
 */
export async function getBatchValidationStatus(applications: LoanApplication[]) {
  const validations = await validateMISMOCompletenessBatch(applications);
  return applications
    .map(a => validations.get(a.id))
    .filter((v): v is MISMOValidationResult => v !== undefined)
    .map(toValidationSummary);
}

export interface GseSubmissionGate {
  /** True when the application must not be handed to the GSE (Fannie DU) yet. */
  blocked: boolean;
  /** HTTP status the submit-gse route returns when blocked. */
  status: 422;
  /** Response body the route returns verbatim when blocked. */
  body: {
    error: string;
    gseReady: boolean;
    gseGatingFailed: boolean;
    overallScore: number;
    criticalErrors: string[];
    missingFields: string[];
    /** Set when a declared co-borrower has no URLA records at all (LO-M11). */
    coApplicantLimitation: string | null;
  };
}

/**
 * Pre-submission gate for POST /api/underwrite/submit-gse: decide whether an
 * application may be submitted to Fannie Mae DU, and build the 422 payload the
 * route returns when it may not.
 *
 * Blocks on missing required URLA fields (gating sections 1a/4/5), any
 * criticalError — the latter already folds in ARM and ATR/QM regulatory
 * failures — or a declared co-borrower with no URLA records at all
 * (coApplicantLimitation, LO-M11: a joint application whose co-borrower is
 * entirely absent from the casefile must never reach DU; per-field co-borrower
 * gaps already surface through criticalErrors, this closes the zero-rows edge).
 * Deliberately does NOT block on the >=90 overallScore threshold that gseReady
 * additionally requires: an application with every required field present but
 * sparse optional fields can score below 90, and blocking it would return an
 * empty, unactionable error list. Kept as a pure function so the gate decision
 * is unit-testable without mounting the route.
 */
export function evaluateGseSubmissionReadiness(validation: MISMOValidationResult): GseSubmissionGate {
  const missingFields = validation.sections
    .filter(s => s.missingFields.length > 0)
    .flatMap(s => s.missingFields.map(f => `${s.section}: ${f}`));

  return {
    blocked:
      validation.gseGatingFailed ||
      validation.criticalErrors.length > 0 ||
      validation.coApplicantLimitation !== null,
    status: 422,
    body: {
      error:
        "Application is missing required URLA fields — resolve these before submitting to Fannie Mae DU.",
      gseReady: validation.gseReady,
      gseGatingFailed: validation.gseGatingFailed,
      overallScore: validation.overallScore,
      criticalErrors: validation.criticalErrors,
      missingFields,
      coApplicantLimitation: validation.coApplicantLimitation,
    },
  };
}
