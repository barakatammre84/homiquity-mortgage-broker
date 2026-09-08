/**
 * Pre-delivery edit engine mirroring the Fannie Mae Loan Delivery / UCD /
 * EarlyCheck edits we can evaluate locally before a loan is submitted.
 *
 * Sources of truth (docs/fannie-mae/):
 *  - "Loan Delivery Qualified Mortgage (QM) Edits Job Aid 2026 Update.pdf"
 *    (C-series Loan Delivery edits; UCD QM edits 3015/3026/3027/3029/3030/
 *    3122/3123/3125/3126/3128/3311/3317; Phase 3a short-reset ARM edits
 *    3670–3673).
 *  - "UCD Phase 3 Critical Edits Job Aid - Loan Discount Points and Lender
 *    Credits.pdf" (3542/3505/3506/3603/3656).
 *  - "UCD Phase 3 Critical Edits Job Aid - Escrows.pdf" (3636/3638/3640/3642).
 *  - "UCD Phase 3 Critical Edits Job Aid -Prepaids.pdf" (3587/3594/3596/
 *    3627/3629).
 *  - "UCDPhase 4 Job Aid LPQIRP April 2026.pdf" (3674/4675).
 *  - "UCD Joint GSE Job Aid Guide Fees updated 09-06-23.pdf" (general FEE
 *    container completeness; fee-type-vs-section enforcement — fatal for
 *    sections A and E, warning for B/C/H; enumerations in
 *    ucdFeeEnumerations.ts).
 *  - "UCD Job Aid Taxes and Other Government Fees updated 09-06-23.pdf"
 *    (recording fee edits 3561/3568/3574/3590/3605/3606/3607/3609).
 *  - "EarlyCheck ULAD Edit Changes 06-30-20.xlsx": "MISMO 3.4" tab (144/1700
 *    — Mortgage Funder Full Name) and "Origination Files" tab
 *    (89/92/1210/1829/6095/6158/6159/6439). Project classification valid
 *    values (E F G P Q R S T U V 1 2) per the ULDD Phase 5 (5.2.0) release
 *    notes, SID 42 — including "Q only for Application Received Date prior
 *    to August 3, 2026".
 *
 * This is a deterministic mirror, not the authority: Fannie Mae's systems run
 * hundreds more edits. Anything we cannot evaluate from local data is
 * reported in `notEvaluated` instead of silently passing (honest gates).
 * Edit IDs and message texts are transcribed from the documents above —
 * never invent new ones.
 */

import {
  evaluateCoveredPointsAndFees,
  evaluateExemptPointsAndFees,
  evaluateCoveredAprSpread,
  evaluateExemptAprSpread,
  resolveQmThresholds,
} from "./qmThresholds";
import { validateSfcSet } from "./specialFeatureCodes";
import {
  isFeeTypeValidForSection,
  isPrepaidItemTypeValid,
  isEscrowItemTypeValid,
  FATAL_FEE_TYPE_SECTIONS,
  type IntegratedDisclosureSection,
} from "./ucdFeeEnumerations";

// ---------------------------------------------------------------------------
// Dataset — what the engine evaluates
// ---------------------------------------------------------------------------

export interface DiscountPointsFee {
  /** FeeTotalPercent (percent of original loan amount). */
  feeTotalPercent?: number | null;
  feePaidToType?: string | null;
  feePaidToTypeOtherDescription?: string | null;
  /** FeeActualPaymentAmount. Required even when $0. */
  actualPaymentAmount?: number | null;
  feePaymentPaidByType?: string | null;
}

export interface LenderCreditsItem {
  /** IntegratedDisclosureSubsectionPaymentAmount (negative or zero). */
  amount?: number | null;
  /** LenderCreditToleranceCureAmount. Required when amount != 0. */
  toleranceCureAmount?: number | null;
}

export interface EscrowItemEntry {
  escrowItemType?: string | null;
  escrowItemTypeOtherDescription?: string | null;
  escrowMonthlyPaymentAmount?: number | null;
  escrowItemActualPaymentAmount?: number | null;
  feePaidToType?: string | null;
  feePaidToTypeOtherDescription?: string | null;
}

export interface PrepaidItemEntry {
  prepaidItemType?: string | null;
  prepaidItemTypeOtherDescription?: string | null;
  prepaidItemActualPaymentAmount?: number | null;
  prepaidItemPaidByType?: string | null;
  feePaidToType?: string | null;
  feePaidToTypeOtherDescription?: string | null;
}

/** A general FEE container (CD sections A/B/C/E/H). */
export interface FeeItemEntry {
  feeType?: string | null;
  feeTypeOtherDescription?: string | null;
  integratedDisclosureSectionType?: IntegratedDisclosureSection | string | null;
  feePaidToType?: string | null;
  feePaidToTypeOtherDescription?: string | null;
  /** FeeActualPaymentAmount — required for all fees except deed/mortgage recording fees. */
  actualPaymentAmount?: number | null;
  /** FeeActualTotalAmount — used ONLY by RecordingFeeForDeed / RecordingFeeForMortgage. */
  actualTotalAmount?: number | null;
  feePaymentPaidByType?: string | null;
}

/**
 * The delivery-relevant data for one loan. All fields optional; `undefined`
 * means "not captured", which for required data points produces the
 * corresponding missing-data edit (that is exactly what those edits check).
 * Containers (`discountPoints`, `lenderCredits`, `escrowItems`,
 * `prepaidItems`) are `undefined` when closing data has not been entered at
 * all — the fee-level UCD edits are then reported as notEvaluated rather
 * than as a wall of false fatals against a loan that has not reached closing.
 */
export interface LoanDeliveryDataset {
  /** ISO date of the note. Drives QM threshold-year selection. */
  noteDate?: string | null;
  originalLoanAmount?: number | null;
  mortgageType?: string | null; // e.g. "Conventional", "FHA", "VA", "USDARuralDevelopment"
  lienPriorityType?: string | null; // e.g. "FirstLien", "SecondLien"
  amortizationType?: string | null; // "Fixed" | "AdjustableRate"
  manufacturedHome?: boolean;
  noteRatePercent?: number | null;

  // --- QM / Regulation Z (UCD Phase 1 critical data points) ---
  aprPercent?: number | null;
  averagePrimeOfferRatePercent?: number | null;
  currentRateSetDate?: string | null;
  regulationZTotalLoanAmount?: number | null;
  regulationZTotalPointsAndFeesAmount?: number | null;
  regulationZTotalAffiliateFeesAmount?: number | null;
  abilityToRepayMethodType?: string | null; // "General" | "Exempt"
  abilityToRepayExemptionReasonType?: string | null; // "LoanProgram" | "PropertyUsage"
  regulationZExcludedBonaFideDiscountPointsIndicator?: boolean | null;
  regulationZExcludedBonaFideDiscountPointsPercent?: number | null;
  loanPriceQuoteInterestRatePercent?: number | null;

  // --- Short-reset ARM (UCD Phase 3a) ---
  firstRateChangeMonthsCount?: number | null;
  qualifiedMortgageShortResetArmAprPercent?: number | null;

  // --- UCD Phase 3 closing-cost containers ---
  discountPoints?: DiscountPointsFee | null;
  /** Number of LoanDiscountPoints FEE containers in the file (default 1 when discountPoints present). */
  discountPointsOccurrenceCount?: number;
  lenderCredits?: LenderCreditsItem | null;
  escrowItems?: EscrowItemEntry[];
  prepaidItems?: PrepaidItemEntry[];
  /** General closing-cost FEE containers (sections A/B/C/E/H). */
  fees?: FeeItemEntry[];

  // --- Property / project (EarlyCheck origination edits) ---
  /** ULDD SID 42 Project Classification Identifier (E F G P Q R S T U V 1 2). */
  projectClassificationIdentifier?: string | null;
  /** ISO date; SID 42 value "Q" only for applications received before 2026-08-03. */
  applicationReceivedDate?: string | null;
  isCondominium?: boolean;
  isCooperative?: boolean;
  hasMortgageInsurance?: boolean;
  subordinateFinancingExists?: boolean;
  /** MISMO PropertyUsageType: PrimaryResidence | SecondHome | Investment. */
  propertyUsageType?: string | null;
  /** Count of mortgaged properties including the subject. */
  financedPropertiesCount?: number | null;
  purchasePriceAmount?: number | null;

  // --- Investor (EarlyCheck MISMO 3.4 tab) ---
  mortgageFunderFullName?: string | null;

  // --- Special Feature Codes (combined manual + derived set) ---
  specialFeatureCodes?: string[];
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type EditSeverity = "fatal" | "warning";
export type EditSource = "LoanDelivery" | "UCD" | "EarlyCheck" | "SFC";

export interface EditFinding {
  editId: string;
  source: EditSource;
  severity: EditSeverity;
  message: string;
  dataPoints: string[];
}

export interface NotEvaluatedEdit {
  editId: string;
  source: EditSource;
  reason: string;
}

export interface LoanDeliveryEditResult {
  fatal: EditFinding[];
  warnings: EditFinding[];
  notEvaluated: NotEvaluatedEdit[];
  /** Convenience rollup: no fatal findings. */
  deliverable: boolean;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const has = (v: unknown): boolean => v !== null && v !== undefined && v !== "";

export function evaluateLoanDeliveryEdits(data: LoanDeliveryDataset): LoanDeliveryEditResult {
  const fatal: EditFinding[] = [];
  const warnings: EditFinding[] = [];
  const notEvaluated: NotEvaluatedEdit[] = [];

  const fail = (editId: string, source: EditSource, message: string, dataPoints: string[]) =>
    fatal.push({ editId, source, severity: "fatal", message, dataPoints });
  const warn = (editId: string, source: EditSource, message: string, dataPoints: string[]) =>
    warnings.push({ editId, source, severity: "warning", message, dataPoints });
  const skip = (editId: string, source: EditSource, reason: string) =>
    notEvaluated.push({ editId, source, reason });

  // -------------------------------------------------------------------------
  // UCD Phase 1 QM data-presence edits (fatal since 7/31/2021)
  // -------------------------------------------------------------------------
  if (!has(data.aprPercent) || (data.aprPercent as number) <= 0) {
    fail("3015", "UCD", "Annual Percentage Rate is required and must be greater than 0.0%.", ["APRPercent"]);
  }
  const atr = data.abilityToRepayMethodType;
  if (!has(atr) || (atr !== "General" && atr !== "Exempt")) {
    fail("3026", "UCD", "Ability to Repay Method Type is required and must be a valid enumeration (General or Exempt).", ["AbilityToRepayMethodType"]);
  }
  if (!has(data.averagePrimeOfferRatePercent) || (data.averagePrimeOfferRatePercent as number) <= 0) {
    fail("3027", "UCD", "Average Prime Offer Rate Percent is required and must be greater than 0.0%.", ["AveragePrimeOfferRatePercent"]);
  }
  if (!has(data.regulationZTotalLoanAmount) || (data.regulationZTotalLoanAmount as number) <= 0) {
    fail("3029", "UCD", "Regulation Z Total Loan Amount is required and must be greater than 0.", ["RegulationZTotalLoanAmount"]);
  }
  if (!has(data.currentRateSetDate)) {
    fail("3030", "UCD", "Current Rate Set Date is required (YYYY-MM-DD).", ["CurrentRateSetDate"]);
  }
  if (atr === "Exempt") {
    const reason = data.abilityToRepayExemptionReasonType;
    if (!has(reason) || (reason !== "LoanProgram" && reason !== "PropertyUsage")) {
      fail("3122", "UCD", "When Ability to Repay Method Type equals Exempt, the Exemption Reason Type is required and must be LoanProgram or PropertyUsage.", ["AbilityToRepayExemptionReasonType", "AbilityToRepayMethodType"]);
    }
  }
  if (!has(data.regulationZTotalPointsAndFeesAmount) || (data.regulationZTotalPointsAndFeesAmount as number) < 0) {
    fail("3128", "UCD", "Regulation Z Total Points and Fees Amount is required (excluding bona fide discount points) and cannot be negative.", ["RegulationZTotalPointsAndFeesAmount"]);
  } else if ((data.regulationZTotalPointsAndFeesAmount as number) === 0) {
    warn("3317", "UCD", "The Regulation Z Total Points and Fees Amount provided is $0.00. Validate the amount to ensure accuracy.", ["RegulationZTotalPointsAndFeesAmount"]);
  }
  if (!has(data.regulationZTotalAffiliateFeesAmount) || (data.regulationZTotalAffiliateFeesAmount as number) < 0) {
    fail("3311", "UCD", "Regulation Z Total Affiliate Fees Amount is required and must be greater than or equal to 0.", ["RegulationZTotalAffiliateFeesAmount"]);
  }
  // Job aid note: the Regulation Z Total Loan Amount is the note amount minus
  // finance charges and should not exceed the original loan amount.
  if (
    has(data.regulationZTotalLoanAmount) && has(data.originalLoanAmount) &&
    (data.regulationZTotalLoanAmount as number) > (data.originalLoanAmount as number)
  ) {
    warn("QM-NOTE-1", "LoanDelivery", "Regulation Z Total Loan Amount exceeds the Original Loan Amount; it is calculated as the note amount minus finance charges and should not exceed it.", ["RegulationZTotalLoanAmount", "NoteAmount"]);
  }

  // -------------------------------------------------------------------------
  // Bona fide discount points chain (UCD 3125 → 3126/3123; Phase 4 3674/4675)
  // -------------------------------------------------------------------------
  const dpPercent = data.discountPoints?.feeTotalPercent;
  if (data.discountPoints !== undefined) {
    if (dpPercent != null && dpPercent > 0 && !has(data.regulationZExcludedBonaFideDiscountPointsIndicator)) {
      fail("3125", "UCD", "If Loan Discount Points is greater than zero, the Regulation Z Excluded Bona Fide Discount Points Indicator is required (true or false).", ["FeeTotalPercent", "RegulationZExcludedBonaFideDiscountPointsIndicator"]);
    }
  } else {
    skip("3125", "UCD", "Closing fee data (discount points) not captured yet");
  }
  if (data.regulationZExcludedBonaFideDiscountPointsIndicator === true) {
    if (!has(data.loanPriceQuoteInterestRatePercent) || (data.loanPriceQuoteInterestRatePercent as number) <= 0) {
      fail("3123", "UCD", "If the Excluded Bona Fide Discount Points Indicator is true, the Loan Price Quote Interest Rate Percent is required and must be greater than 0.", ["LoanPriceQuoteInterestRatePercent", "RegulationZExcludedBonaFideDiscountPointsIndicator"]);
    }
    if (!has(data.regulationZExcludedBonaFideDiscountPointsPercent) || (data.regulationZExcludedBonaFideDiscountPointsPercent as number) <= 0) {
      fail("3126", "UCD", "If the Excluded Bona Fide Discount Points Indicator is true, the Excluded Bona Fide Discount Points Percent is required and must be greater than 0.", ["RegulationZExcludedBonaFideDiscountPointsPercent"]);
    }
    if (
      has(data.loanPriceQuoteInterestRatePercent) && has(data.noteRatePercent) &&
      (data.loanPriceQuoteInterestRatePercent as number) <= (data.noteRatePercent as number)
    ) {
      fail("4675", "UCD", "When the Excluded Bona Fide Discount Points Indicator is true, the Loan Price Quote Interest Rate Percent must be greater than the Note Rate Percent.", ["LoanPriceQuoteInterestRatePercent", "NoteRatePercent"]);
    }
  }
  if (dpPercent != null && dpPercent !== 0) {
    if (!has(data.loanPriceQuoteInterestRatePercent) || (data.loanPriceQuoteInterestRatePercent as number) <= 0) {
      fail("3674", "UCD", "When the Loan Discount Points Fee Total Percent is not equal to 0, the Loan Price Quote Interest Rate Percent must be provided and must be greater than 0.", ["LoanPriceQuoteInterestRatePercent", "FeeTotalPercent"]);
    }
  }

  // -------------------------------------------------------------------------
  // Short-reset ARM (UCD Phase 3a, fatal since 5/1/2023)
  // -------------------------------------------------------------------------
  const isArm = data.amortizationType === "AdjustableRate";
  const shortReset = isArm && data.firstRateChangeMonthsCount != null && data.firstRateChangeMonthsCount <= 60;
  if (isArm) {
    if (!has(data.firstRateChangeMonthsCount)) {
      fail("3670", "UCD", "When Amortization Type is Adjustable Rate, the First Rate Change Months Count must be provided.", ["FirstRateChangeMonthsCount"]);
    }
    if (shortReset) {
      const srApr = data.qualifiedMortgageShortResetArmAprPercent;
      if (!has(srApr)) {
        fail("3671", "UCD", "For ARM loans with a first interest rate change within the first 5 years, the Qualified Mortgage Short Reset ARM APR Percent must be provided.", ["gse:QualifiedMortgageShortResetARM_APRPercent"]);
        fail("C93", "LoanDelivery", "Loan Qualified Mortgage Short Reset ARM APR Percent is required at the time of closing for UCD short reset ARM mortgages with a first-rate change within the first five years.", ["gse:QualifiedMortgageShortResetARM_APRPercent"]);
      } else if ((srApr as number) < 0) {
        fail("3673", "UCD", "The Qualified Mortgage Short Reset ARM APR Percent cannot be a negative value.", ["gse:QualifiedMortgageShortResetARM_APRPercent"]);
      } else if ((srApr as number) === 0) {
        fail("3672", "UCD", "The Qualified Mortgage Short Reset ARM APR Percent must be greater than 0%.", ["gse:QualifiedMortgageShortResetARM_APRPercent"]);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Loan Delivery QM edits (C-series) — Conventional first-lien loans
  // -------------------------------------------------------------------------
  const isConventionalFirstLien =
    (data.mortgageType ?? "Conventional") === "Conventional" &&
    (data.lienPriorityType ?? "FirstLien") === "FirstLien";

  if (!isConventionalFirstLien) {
    skip("C47-C99", "LoanDelivery", "QM APR-spread and points-and-fees edits apply to conventional first-lien loans");
  } else if (!has(data.noteDate)) {
    skip("C47-C99", "LoanDelivery", "Note date not captured — QM thresholds are selected by note-date year");
  } else if (!has(data.originalLoanAmount)) {
    skip("C47-C99", "LoanDelivery", "Original loan amount not captured");
  } else if (atr !== "General" && atr !== "Exempt") {
    skip("C47-C99", "LoanDelivery", "Ability to Repay Method Type missing — cannot classify the loan as ATR-covered or exempt");
  } else {
    const noteDate = data.noteDate as string;
    const originalAmount = data.originalLoanAmount as number;
    const thresholdTable = resolveQmThresholds(noteDate);
    if (!thresholdTable) {
      skip("C47-C99", "LoanDelivery", `No QM threshold table for note year of ${noteDate} — manual review against the current CFPB values required`);
    } else if (atr === "Exempt") {
      // Points and fees: edit C47 (5% of the Reg Z total loan amount).
      if (has(data.regulationZTotalLoanAmount) && has(data.regulationZTotalPointsAndFeesAmount)) {
        const pf = evaluateExemptPointsAndFees(
          data.regulationZTotalLoanAmount as number,
          data.regulationZTotalPointsAndFeesAmount as number,
        );
        if (pf.evaluated && !pf.compliant) {
          fail("C47", "LoanDelivery", `Exempt loan: calculated Regulation Z Total Points and Fees Amount exceeds 5% of the Regulation Z Total Loan Amount (max $${pf.maxAllowableAmount}).`, ["RegulationZTotalPointsAndFeesAmount", "RegulationZTotalLoanAmount"]);
        }
      } else {
        skip("C47", "LoanDelivery", "Regulation Z loan amount / points-and-fees not captured");
      }
      // APR spread: C52 (fixed) / C96 (ARM) / C92+C99 (short-reset ARM).
      const exemptApr = shortReset ? data.qualifiedMortgageShortResetArmAprPercent : data.aprPercent;
      if (has(exemptApr) && has(data.averagePrimeOfferRatePercent)) {
        const spread = evaluateExemptAprSpread(exemptApr as number, data.averagePrimeOfferRatePercent as number);
        if (spread.evaluated && !spread.compliant) {
          const editId = shortReset ? "C92" : isArm ? "C96" : "C52";
          fail(editId, "LoanDelivery", `Exempt loan: an APR spread of ${spread.spreadPercent}% equals or exceeds the 6.5% limit for conventional first-lien loans exempt from QM requirements.`, ["APRPercent", "AveragePrimeOfferRatePercent"]);
        }
      } else {
        skip(shortReset ? "C92" : isArm ? "C96" : "C52", "LoanDelivery", "APR / APOR not captured");
      }
    } else {
      // ATR-covered. Points and fees: C87/C88.
      if (has(data.regulationZTotalLoanAmount) && has(data.regulationZTotalPointsAndFeesAmount)) {
        const pf = evaluateCoveredPointsAndFees(
          noteDate,
          originalAmount,
          data.regulationZTotalLoanAmount as number,
          data.regulationZTotalPointsAndFeesAmount as number,
        );
        if (pf.evaluated && !pf.compliant) {
          fail("C87/C88", "LoanDelivery", `Covered loan: Regulation Z Total Points and Fees Amount exceeds the QM cap for this loan amount (${pf.tierDescription}; max $${pf.maxAllowableAmount}).`, ["RegulationZTotalPointsAndFeesAmount", "RegulationZTotalLoanAmount"]);
        } else if (!pf.evaluated) {
          skip("C87/C88", "LoanDelivery", pf.reason ?? "not evaluated");
        }
      } else {
        skip("C87/C88", "LoanDelivery", "Regulation Z loan amount / points-and-fees not captured");
      }
      // APR spread: C85/C86 fixed, C94/C95 ARM, C90/C91 short-reset ARM.
      const coveredApr = shortReset ? data.qualifiedMortgageShortResetArmAprPercent : data.aprPercent;
      const spreadEditId = data.manufacturedHome
        ? (shortReset ? "C91" : isArm ? "C95" : "C86")
        : (shortReset ? "C90" : isArm ? "C94" : "C85");
      if (has(coveredApr) && has(data.averagePrimeOfferRatePercent)) {
        const spread = evaluateCoveredAprSpread(
          noteDate,
          originalAmount,
          coveredApr as number,
          data.averagePrimeOfferRatePercent as number,
          !!data.manufacturedHome,
        );
        if (spread.evaluated && !spread.compliant) {
          fail(spreadEditId, "LoanDelivery", `Covered loan: the APR spread (${spread.spreadPercent}%) is greater than the allowed spread (${spread.maxAllowableSpreadPercent}%) for the original loan amount (${spread.tierDescription}).`, ["APRPercent", "AveragePrimeOfferRatePercent"]);
        } else if (!spread.evaluated) {
          skip(spreadEditId, "LoanDelivery", spread.reason ?? "not evaluated");
        }
      } else {
        skip(spreadEditId, "LoanDelivery", shortReset ? "Short Reset ARM APR / APOR not captured" : "APR / APOR not captured");
      }
    }
  }

  // -------------------------------------------------------------------------
  // UCD Phase 3 critical edits: Loan Discount Points
  // -------------------------------------------------------------------------
  if (data.discountPoints === undefined) {
    skip("3542/3505/3506", "UCD", "Closing fee data (discount points) not captured yet");
  } else if (data.discountPoints === null) {
    fail("3542", "UCD", "Loan Discount Points must be provided, even if a $0 value.", ["FeeType=LoanDiscountPoints"]);
  } else {
    const dp = data.discountPoints;
    if ((data.discountPointsOccurrenceCount ?? 1) > 1) {
      fail("3505", "UCD", "The submission cannot have more than one occurrence of a Fee Type equal to 'LoanDiscountPoints'.", ["FeeType=LoanDiscountPoints"]);
    }
    if (!has(dp.actualPaymentAmount)) {
      fail("3506", "UCD", "Fee Actual Payment Amount is required for Loan Discount Points, even when the value is zero.", ["FeeActualPaymentAmount"]);
    } else if ((dp.actualPaymentAmount as number) > 0) {
      // Non-zero discount points require the full FEE container components.
      const missing: string[] = [];
      if (!has(dp.feeTotalPercent)) missing.push("FeeTotalPercent");
      if (!has(dp.feePaidToType)) missing.push("FeePaidToType");
      if (dp.feePaidToType === "Other" && !has(dp.feePaidToTypeOtherDescription)) missing.push("FeePaidToTypeOtherDescription");
      if (!has(dp.feePaymentPaidByType)) missing.push("FeePaymentPaidByType");
      if (missing.length > 0) {
        fail("P3-DISCOUNT-COMPONENTS", "UCD", `Loan Discount Points FEE container is missing required component data: ${missing.join(", ")}.`, missing);
      }
    }
  }

  // -------------------------------------------------------------------------
  // UCD Phase 3 critical edits: Lender Credits
  // -------------------------------------------------------------------------
  if (data.lenderCredits === undefined) {
    skip("3603/3656", "UCD", "Closing cost data (lender credits) not captured yet");
  } else if (data.lenderCredits === null || !has(data.lenderCredits.amount)) {
    fail("3603", "UCD", "An Integrated Disclosure Subsection Type of 'LenderCredits' is required in the submission, even if a $0 value.", ["IntegratedDisclosureSubsectionType=LenderCredits"]);
  } else {
    const lc = data.lenderCredits;
    if ((lc.amount as number) !== 0 && !has(lc.toleranceCureAmount)) {
      fail("3656", "UCD", "A Lender Credit Tolerance Cure Amount must be provided (even if $0) when the Lender Credits amount does not equal $0.", ["LenderCreditToleranceCureAmount"]);
    }
  }

  // -------------------------------------------------------------------------
  // UCD Phase 3 critical edits: Escrow items
  // -------------------------------------------------------------------------
  if (data.escrowItems === undefined) {
    skip("3636/3638/3640/3642", "UCD", "Escrow item data not captured yet");
  } else {
    data.escrowItems.forEach((item, i) => {
      const label = `Escrow item #${i + 1}`;
      if (!has(item.escrowItemType)) {
        fail("3638", "UCD", `${label}: Escrow Item Type is required and must be a valid enumeration.`, ["EscrowItemType"]);
      } else if (item.escrowItemType === "Other" && !has(item.escrowItemTypeOtherDescription)) {
        fail("3638", "UCD", `${label}: when Escrow Item Type equals Other, the Escrow Item Type Other Description is required.`, ["EscrowItemTypeOtherDescription"]);
      } else if (!isEscrowItemTypeValid(item.escrowItemType as string)) {
        fail("3638", "UCD", `${label}: Escrow Item Type "${item.escrowItemType}" is not a UCD-supported enumeration for Initial Escrow Payment At Closing.`, ["EscrowItemType"]);
      }
      if (!has(item.feePaidToType)) {
        fail("3640", "UCD", `${label}: Fee Paid To Type is required for Initial Escrow Payment At Closing items.`, ["FeePaidToType"]);
      } else if (item.feePaidToType === "Other" && !has(item.feePaidToTypeOtherDescription)) {
        fail("3636", "UCD", `${label}: when Fee Paid To Type equals Other, the Fee Paid To Type Other Description is required.`, ["FeePaidToTypeOtherDescription"]);
      }
      if (!has(item.escrowItemActualPaymentAmount)) {
        fail("3642", "UCD", `${label}: Escrow Item Actual Payment Amount is required.`, ["EscrowItemActualPaymentAmount"]);
      }
      if (!has(item.escrowMonthlyPaymentAmount)) {
        fail("P3-ESCROW-MONTHLY", "UCD", `${label}: Escrow Monthly Payment Amount is required component data for ESCROW_ITEM containers.`, ["EscrowMonthlyPaymentAmount"]);
      }
    });
  }

  // -------------------------------------------------------------------------
  // UCD Phase 3 critical edits: Prepaids
  // -------------------------------------------------------------------------
  if (data.prepaidItems === undefined) {
    skip("3587/3594/3596/3627/3629", "UCD", "Prepaid item data not captured yet");
  } else {
    const hasPrepaidInterest = data.prepaidItems.some(p => p.prepaidItemType === "PrepaidInterest");
    if (!hasPrepaidInterest) {
      fail("3587", "UCD", "A Prepaid Item Type equal to 'PrepaidInterest' must be provided even if a $0 value.", ["PrepaidItemType=PrepaidInterest"]);
    }
    data.prepaidItems.forEach((item, i) => {
      const label = `Prepaid item #${i + 1}`;
      if (!has(item.prepaidItemType)) {
        fail("3627", "UCD", `${label}: Prepaid Item Type is required and must be a valid enumeration.`, ["PrepaidItemType"]);
      } else if (item.prepaidItemType === "Other" && !has(item.prepaidItemTypeOtherDescription)) {
        fail("3627", "UCD", `${label}: when Prepaid Item Type equals Other, the Prepaid Item Type Other Description is required.`, ["PrepaidItemTypeOtherDescription"]);
      } else if (!isPrepaidItemTypeValid(item.prepaidItemType as string)) {
        fail("3627", "UCD", `${label}: Prepaid Item Type "${item.prepaidItemType}" is not a UCD-supported enumeration for Prepaids.`, ["PrepaidItemType"]);
      }
      const isPrepaidInterest = item.prepaidItemType === "PrepaidInterest";
      if (!has(item.feePaidToType)) {
        // Prepaid interest at $0 is the one prepaid that may omit Paid To.
        const amount = item.prepaidItemActualPaymentAmount;
        if (!(isPrepaidInterest && amount === 0)) {
          fail(isPrepaidInterest ? "3594" : "3629", "UCD", `${label}: Fee Paid To Type is required.`, ["FeePaidToType"]);
        }
      } else if (item.feePaidToType === "Other" && !has(item.feePaidToTypeOtherDescription)) {
        fail(isPrepaidInterest ? "3594" : "3629", "UCD", `${label}: when Fee Paid To Type equals Other, the Fee Paid To Type Other Description is required.`, ["FeePaidToTypeOtherDescription"]);
      }
      if (!has(item.prepaidItemActualPaymentAmount)) {
        fail("3596", "UCD", `${label}: Prepaid Item Actual Payment Amount is required.`, ["PrepaidItemActualPaymentAmount"]);
      }
    });
  }

  // -------------------------------------------------------------------------
  // UCD Phase 3 critical edits: general FEE containers (sections A/B/C/E/H)
  // -------------------------------------------------------------------------
  if (data.fees === undefined) {
    skip("P3-FEES", "UCD", "General closing-cost fee data not captured yet");
  } else {
    const RECORDING_ITEMIZED = ["RecordingFeeForDeed", "RecordingFeeForMortgage"];
    data.fees.forEach((fee, i) => {
      const label = `Fee #${i + 1}${fee.feeType ? ` (${fee.feeType})` : ""}`;
      const section = fee.integratedDisclosureSectionType as IntegratedDisclosureSection | null | undefined;

      if (!has(section)) {
        fail("3561", "UCD", `${label}: Integrated Disclosure Section Type is required for all fees.`, ["IntegratedDisclosureSectionType"]);
      }
      if (!has(fee.feeType)) {
        fail("P3-FEE-COMPONENTS", "UCD", `${label}: Fee Type is required for every FEE container.`, ["FeeType"]);
        return;
      }
      const feeType = fee.feeType as string;
      if (feeType === "Other" && !has(fee.feeTypeOtherDescription)) {
        fail("P3-FEE-COMPONENTS", "UCD", `${label}: when Fee Type equals Other, the Fee Type Other Description is required.`, ["FeeTypeOtherDescription"]);
      }

      // Fee-type-vs-section enforcement: fatal for A and E, warning for B/C/H.
      if (has(section)) {
        const valid = isFeeTypeValidForSection(feeType, section as IntegratedDisclosureSection);
        if (valid === false) {
          if (section === "TaxesAndOtherGovernmentFees") {
            fail("3590", "UCD", `${label}: Fee Type for Taxes and Other Government Fees must be a valid enumeration.`, ["FeeType", "IntegratedDisclosureSectionType"]);
          } else if (FATAL_FEE_TYPE_SECTIONS.includes(section as IntegratedDisclosureSection)) {
            fail("P3-FEETYPE-A", "UCD", `${label}: Fee Type "${feeType}" is not a UCD-supported enumeration for Origination Charges.`, ["FeeType", "IntegratedDisclosureSectionType"]);
          } else {
            warn("P3-FEETYPE-SECTION", "UCD", `${label}: Fee Type "${feeType}" is not a UCD-supported enumeration for section ${section}.`, ["FeeType", "IntegratedDisclosureSectionType"]);
          }
        }
      }

      if (RECORDING_ITEMIZED.includes(feeType)) {
        // Deed/mortgage recording fees are the only fees delivered with
        // FeeActualTotalAmount and need no paid-to/paid-by allocation.
        if (!has(fee.actualTotalAmount)) {
          fail("3568", "UCD", `${label}: Fee Actual Total Amount is required when a Fee Type of Recording Fee for Deed or Recording Fee for Mortgage is provided.`, ["FeeActualTotalAmount"]);
        }
        return;
      }

      // Any other fee carrying FeeActualTotalAmount in section E is suspect.
      if (has(fee.actualTotalAmount) && section === "TaxesAndOtherGovernmentFees") {
        warn("3606", "UCD", `${label}: Fee Types of 'RecordingFeeForDeed' and 'RecordingFeeForMortgage' are the only enumerations expected with Fee Actual Total Amount in the Taxes and Other Government Fees section.`, ["FeeActualTotalAmount", "FeeType"]);
      }

      if (!has(fee.actualPaymentAmount)) {
        const editId = section === "TaxesAndOtherGovernmentFees" ? "3574" : "P3-FEE-COMPONENTS";
        fail(editId, "UCD", `${label}: Fee Actual Payment Amount is required.`, ["FeeActualPaymentAmount"]);
      }
      // RecordingFeeTotal needs no Fee Paid To Type (Taxes job aid);
      // every other fee's FEE_DETAIL requires it.
      if (feeType !== "RecordingFeeTotal") {
        if (!has(fee.feePaidToType)) {
          fail("P3-FEE-COMPONENTS", "UCD", `${label}: Fee Paid To Type is required.`, ["FeePaidToType"]);
        } else if (fee.feePaidToType === "Other" && !has(fee.feePaidToTypeOtherDescription)) {
          fail("P3-FEE-COMPONENTS", "UCD", `${label}: when Fee Paid To Type equals Other, the Fee Paid To Type Other Description is required.`, ["FeePaidToTypeOtherDescription"]);
        }
      }
      if (!has(fee.feePaymentPaidByType)) {
        fail("P3-FEE-COMPONENTS", "UCD", `${label}: Fee Paid By Type is required.`, ["FeePaymentPaidByType"]);
      }
      if (feeType === "RecordingFeeTotal" && has(section) && section !== "TaxesAndOtherGovernmentFees") {
        warn("3607", "UCD", `${label}: the Integrated Disclosure Section Type should be Taxes and Other Government Fees when the Fee Type is 'RecordingFeeTotal'.`, ["IntegratedDisclosureSectionType"]);
      }
    });

    // Cross-item recording-fee rules.
    const recordingItemized = data.fees.filter(f => RECORDING_ITEMIZED.includes(f.feeType ?? ""));
    const recordingTotals = data.fees.filter(f => f.feeType === "RecordingFeeTotal");
    const itemizedSum = recordingItemized.reduce((sum, f) => sum + (f.actualTotalAmount ?? 0), 0);
    if (recordingItemized.length > 0 && itemizedSum !== 0 && recordingTotals.length === 0) {
      fail("3605", "UCD", "Recording Fee Total must be provided when Recording Fee for Deed or Recording Fee for Mortgage exists and Fee Actual Total Amount does not equal $0.", ["FeeType=RecordingFeeTotal"]);
    }
    if (recordingTotals.length > 1) {
      warn("3609", "UCD", "The submission should not have more than one occurrence of a Fee Type equal to 'RecordingFeeTotal'.", ["FeeType=RecordingFeeTotal"]);
    }
  }

  // -------------------------------------------------------------------------
  // EarlyCheck origination-file edits (project / MI / lien / property)
  // -------------------------------------------------------------------------
  const VALID_PROJECT_CLASSIFICATIONS = ["E", "F", "G", "P", "Q", "R", "S", "T", "U", "V", "1", "2"];
  const mortgageType = data.mortgageType ?? null;
  const projectClassification = data.projectClassificationIdentifier;

  if (has(projectClassification)) {
    if (!VALID_PROJECT_CLASSIFICATIONS.includes(projectClassification as string)) {
      fail("1210", "EarlyCheck", `The project classification (${projectClassification}) is not valid.`, ["ProjectClassificationIdentifier"]);
    } else if (
      projectClassification === "Q" &&
      has(data.applicationReceivedDate) &&
      (data.applicationReceivedDate as string) >= "2026-08-03"
    ) {
      fail("1210", "EarlyCheck", "Project Type Q is only permitted for loans with an Application Received Date prior to August 3, 2026 (ULDD Phase 5.2.0, SID 42).", ["ProjectClassificationIdentifier", "ApplicationReceivedDate"]);
    }
  } else if (mortgageType === "Conventional") {
    fail("89", "EarlyCheck", "A project classification must be provided for conventional loans.", ["ProjectClassificationIdentifier"]);
  }

  if (
    mortgageType === "FHA" &&
    data.isCondominium === true &&
    has(projectClassification) &&
    projectClassification !== "U"
  ) {
    fail("92", "EarlyCheck", "The provided project classification type must be U for FHA-financed condominiums.", ["ProjectClassificationIdentifier"]);
  }

  if ((mortgageType === "FHA" || mortgageType === "VA" || mortgageType === "USDA") && data.hasMortgageInsurance === true) {
    fail("1829", "EarlyCheck", "A mortgage insurer should not be associated with this loan, because this is an FHA, VA, or Rural Development loan.", ["MICompany", "MortgageType"]);
  }

  if (data.lienPriorityType === "SecondLien" && data.purchasePriceAmount != null) {
    fail("6095", "EarlyCheck", "A purchase price should not be provided for second lien mortgages.", ["PurchasePriceAmount", "LienPriorityType"]);
  }

  if (data.isCooperative === true) {
    if (data.subordinateFinancingExists === true) {
      fail("6158", "EarlyCheck", "Subordinate financing is not allowed on loans secured by cooperatives.", ["SubordinateFinancing"]);
    }
    if (data.propertyUsageType === "Investment") {
      fail("6159", "EarlyCheck", "Investment property loans secured by cooperative properties are not eligible for delivery to Fannie Mae.", ["PropertyUsageType"]);
    }
  }

  if (data.propertyUsageType === "SecondHome" || data.propertyUsageType === "Investment") {
    if (data.financedPropertiesCount == null) {
      skip("6439", "EarlyCheck", "Financed property count has not been confirmed for this application.");
    } else if (data.financedPropertiesCount > 6) {
      fail("6439", "EarlyCheck", "The number of mortgaged properties must be less than or equal to six for second home and investment property loans.", ["FinancedPropertiesCount", "PropertyUsageType"]);
    }
  }

  // -------------------------------------------------------------------------
  // EarlyCheck MISMO 3.4 investor edits
  // -------------------------------------------------------------------------
  const funder = data.mortgageFunderFullName;
  if (!has(funder)) {
    fail("1700", "EarlyCheck", "The Mortgage Funder Full Name is required.", ["MortgageFunderFullName"]);
  } else {
    const f = (funder as string).trim();
    const isAllNumeric = /^[\d\s.,/-]+$/.test(f);
    const hasAlpha = /[A-Za-z]/.test(f);
    const looksLikeDate = !isNaN(Date.parse(f)) && /\d/.test(f) && f.length <= 10;
    if (f.length < 3 || !hasAlpha || isAllNumeric || looksLikeDate) {
      fail("144", "EarlyCheck", `The provided mortgage funder name "${f}" is in an invalid format. The value must be at least three characters, contain alphabetic characters, and may not be a date or all numeric.`, ["MortgageFunderFullName"]);
    }
  }

  // -------------------------------------------------------------------------
  // Special Feature Code set validation
  // -------------------------------------------------------------------------
  if (data.specialFeatureCodes !== undefined) {
    const sfc = validateSfcSet(data.specialFeatureCodes);
    sfc.errors.forEach(e => fail("SFC", "SFC", e, ["SpecialFeatureCodes"]));
    sfc.warnings.forEach(w => warn("SFC", "SFC", w, ["SpecialFeatureCodes"]));
  }

  return {
    fatal,
    warnings,
    notEvaluated,
    deliverable: fatal.length === 0,
  };
}
