import { createHash } from "crypto";
import { db } from "../db";
import { creditPulls, loanApplications, verificationReports } from "@shared/schema";
import { and, desc, eq } from "drizzle-orm";
import { storage } from "../storage";
import {
  PAID_BY_OTHER_PARTY_CONDITION_RULE,
  THIRD_PARTY_PAYMENT_HISTORY_DOCUMENT_TYPE,
  THIRD_PARTY_PAYMENT_HISTORY_MONTHS,
  assessPaidByOtherParty,
  type PaidByOtherPartyFacts,
} from "@shared/liabilityExclusions";
import { sendEmail } from "./emailService";

/**
 * Pre-underwriting validator.
 *
 * Runs automatically (1) the moment intake completes and (2) whenever a Plaid
 * VOA report lands via the webhook, comparing self-reported income against
 * VERIFIED assets and raising machine-readable flags on the application
 * (loan_applications.pre_uw_flags).
 *
 * Flags do not gate stages by themselves — the conditions system does that.
 * Where a flag needs teeth (e.g. low reserves), this module materializes an
 * outstanding loan condition, and the status route enforces it at the
 * closing track: /api/loan-applications/:id/status runs checkPipelineProgress
 * before granting clear_to_close/closing/funded and 422s while it reports
 * blockers (Selling Guide B3-2-05; before 2026-08-23 this sentence claimed
 * enforcement that no reachable route performed — the walk record
 * knowledge-base/feature-review/journey-walks/2026-08-23-lo-submission-review.md
 * carries the funded-with-open-conditions repro that corrected it).
 * Self-employed files already receive their 2-year tax-return condition
 * from pipelineEngine at intake; the COMPLEX_INCOME_CHECK flag is the compact
 * marker lenders and the UI can read without scanning conditions.
 *
 * The "frictionless fix": when the flag set changes, the borrower gets one
 * personalized email explaining exactly what is needed (deduplicated via a
 * hash so re-evaluations never re-nag).
 */

import type { IncomeSourceEntry } from "@shared/schema";
import { toNum as toNumber } from "@shared/lib/number";
import { COMPANY_CONFIG } from "../config/company";
import { isAutopilotEnabled, canGenerateFollowUps } from "./autopilot/config";
import { materializeFlagsToFollowUps, reconcileFlagFollowUp } from "./autopilot/followUps";
import { assessLargeDepositSourcing } from "./largeDepositSourcing";
import { monthlyPrincipalAndInterestFromFraction } from "@shared/lib/amortization";
import {
  adjustLiabilities,
  assessIncomeSeasoning,
  calculateRentalIncomeOffsets,
  calculateSubjectPropertyRentalOffset,
  computeDti,
  computeWhatIfPayoff,
  SEASONING_FULL_MONTHS,
  STANDARD_DTI_CEILING,
  type DepositoryTransaction,
  type Tradeline,
} from "./underwritingNuance";

export const RESERVES_MONTHS_THRESHOLD = 2;

/**
 * Fannie Mae Selling Guide B3-4.1-01, Minimum Reserve Requirements (08/07/2024)
 * — Determining Required Minimum Reserves. For DU loan casefiles DU requires:
 *
 *   · two months' reserves for a second home transaction;
 *   · six months' reserves for a two- to four-unit principal residence, an
 *     investment property, and a cash-out refinance with a DTI over 45%.
 *
 * A one-unit principal residence purchase has no stated DU minimum — the two
 * months we warn at there is a PLATFORM advisory, not an agency figure, and the
 * copy says so. The flat two-month threshold that used to apply to every
 * transaction was the problem in the other direction: it stayed silent for a
 * two-to-four-unit or investment borrower who was four months short of what
 * Fannie actually requires.
 *
 * The cash-out-refinance leg is not implemented: this function runs on the
 * purchase intake, which carries a purchase price and down payment and has no
 * refinance shape. Recorded in SELLING_GUIDE_CONFORMANCE.md (gap G-9).
 */
export const RESERVES_MONTHS_MULTI_UNIT_OR_INVESTMENT = 6;

export function requiredReserveMonths(
  subjectProperty: { numberOfUnits: number | null; occupancyType: string | null } | null | undefined,
): { months: number; agencyRequired: boolean } {
  const occupancy = (subjectProperty?.occupancyType ?? "").toLowerCase();
  const units = subjectProperty?.numberOfUnits ?? 1;

  if (occupancy === "investment" || occupancy === "investment_property") {
    return { months: RESERVES_MONTHS_MULTI_UNIT_OR_INVESTMENT, agencyRequired: true };
  }
  if ((occupancy === "primary_residence" || occupancy === "primary") && units >= 2 && units <= 4) {
    return { months: RESERVES_MONTHS_MULTI_UNIT_OR_INVESTMENT, agencyRequired: true };
  }
  if (occupancy === "second_home") {
    return { months: RESERVES_MONTHS_THRESHOLD, agencyRequired: true };
  }
  // One-unit principal residence, or occupancy not yet declared.
  return { months: RESERVES_MONTHS_THRESHOLD, agencyRequired: false };
}

// Assumption used for the reserves estimate before a rate is locked. Matches
// the funnel's advisory math: 30-year amortization + 1.25%/yr tax & insurance.
const ASSUMED_ANNUAL_RATE = 0.07;
const TAX_INSURANCE_ANNUAL_PCT = 0.0125;

export type PreUwFlagCode =
  | "LOW_RESERVES_WARNING"
  | "COMPLEX_INCOME_CHECK"
  | "INCOME_SEASONING"
  | "VERIFIED_DEBT_DTI"
  | "LARGE_DEPOSIT_SOURCING"
  | "RENTAL_INCOME_OFFSET"
  | "SUBJECT_PROPERTY_RENTAL_OFFSET"
  | "RENTAL_CONVERSION_OFFSET"
  | "THIRD_PARTY_PAID_DEBT";

export interface PreUwRequiredDoc {
  documentType: string;
  description: string;
}

export interface PreUwFlag {
  code: PreUwFlagCode;
  severity: "warning" | "blocking";
  reason: string;
  requiredDocs: PreUwRequiredDoc[];
  metrics?: Record<string, number>;
  /** Exact condition identity when the underlying evidence set must be cleared. */
  conditionSourceRule?: string;
}

export interface PreUwInput {
  annualIncome: string | number | null;
  purchasePrice: string | number | null;
  downPayment: string | number | null;
  employmentType: string | null;
  /** Total balance from the latest completed VOA report; null = not yet verified. */
  verifiedAssetsTotal: number | null;
  /** Supplementary income sources from intake (seasoning check, B3-3.5-01). */
  incomeSources?: IncomeSourceEntry[] | null;
  /** Verified liability ledger from the latest soft pull (B3-6-05 math). */
  tradelines?: Tradeline[] | null;
  /** Depository transactions from the latest VOA (B3-4.2-02 large-deposit sourcing). */
  transactions?: DepositoryTransaction[] | null;
  /** Subject property details from URLA (B3-3.8-01 multi-unit rental income). */
  subjectProperty?: {
    numberOfUnits: number | null;
    occupancyType: string | null;
    estimatedMarketRent: string | number | null;
  } | null;
  /** S-07: current-residence disposition + departing figures (B3-3.8-01). */
  currentPropertyDisposition?: string | null;
  departingResidence?: {
    estimatedMarketRent: string | number | null;
    monthlyPitia: string | number | null;
  } | null;
  /**
   * URLA Section 2c rows with the borrower's "someone else pays this" answers
   * (B3-6-05, Debts Paid by Others). The ELIGIBLE ones are excluded from the
   * DTI by both engines and need the Guide's 12-month payment history.
   */
  declaredLiabilities?: DeclaredLiability[] | null;
}

export interface DeclaredLiability extends PaidByOtherPartyFacts {
  id: string;
  creditorName: string | null | undefined;
  monthlyPayment: string | number | null | undefined;
  otherPartyRelationship?: string | null;
}

/** The liabilities B3-6-05 lets out of the ratio, each owing a 12-month history. */
export function excludableThirdPartyPaidDebts(
  liabilities: DeclaredLiability[] | null | undefined,
): DeclaredLiability[] {
  return (liabilities ?? []).filter((l) => assessPaidByOtherParty(l).status === "excludable");
}

function relationshipPhrase(relationship: string | null | undefined): string {
  switch (relationship) {
    case "family_member": return "the family member who pays it";
    case "former_spouse": return "your former spouse or partner";
    case "employer": return "your employer";
    case "business": return "the business that pays it";
    default: return "the person who makes the payments";
  }
}


/** Estimated PITI on the target home: 30-yr P&I at the assumed rate + tax/ins. */
export function estimateMonthlyPITI(purchasePrice: number, downPayment: number): number {
  const loanAmount = Math.max(purchasePrice - downPayment, 0);
  if (loanAmount <= 0 || purchasePrice <= 0) return 0;
  // ASSUMED_ANNUAL_RATE is a FRACTION (0.065-style), not a percent.
  const pAndI = monthlyPrincipalAndInterestFromFraction(loanAmount, ASSUMED_ANNUAL_RATE, 360);
  const taxAndInsurance = (purchasePrice * TAX_INSURANCE_ANNUAL_PCT) / 12;
  return pAndI + taxAndInsurance;
}

/**
 * Post-closing months of reserves: verified liquid assets left AFTER the down
 * payment, divided by the estimated monthly housing payment.
 */
export function computeMonthsOfReserves(input: {
  verifiedAssetsTotal: number;
  purchasePrice: number;
  downPayment: number;
}): number | null {
  const piti = estimateMonthlyPITI(input.purchasePrice, input.downPayment);
  if (piti <= 0) return null;
  const remaining = input.verifiedAssetsTotal - input.downPayment;
  return remaining / piti;
}

/** Pure flag derivation — same input, same flags. */
export function derivePreUnderwritingFlags(input: PreUwInput): PreUwFlag[] {
  const flags: PreUwFlag[] = [];

  if (input.employmentType === "self_employed") {
    flags.push({
      code: "COMPLEX_INCOME_CHECK",
      severity: "blocking",
      reason:
        "Self-employed income must be documented before approval-grade decisions. Clear-to-close is restricted until the tax-return conditions are fulfilled.",
      requiredDocs: [
        {
          documentType: "tax_return",
          description: "Complete federal tax returns (1040s) for the past 2 years, all schedules",
        },
        {
          documentType: "profit_loss",
          description: "Year-to-date profit and loss statement",
        },
      ],
    });
  }

  const price = toNumber(input.purchasePrice);
  const down = toNumber(input.downPayment);
  if (input.verifiedAssetsTotal !== null && !isNaN(price) && !isNaN(down)) {
    const months = computeMonthsOfReserves({
      verifiedAssetsTotal: input.verifiedAssetsTotal,
      purchasePrice: price,
      downPayment: down,
    });
    const reserveRule = requiredReserveMonths(input.subjectProperty);
    if (months !== null && months < reserveRule.months) {
      const piti = estimateMonthlyPITI(price, down);
      flags.push({
        code: "LOW_RESERVES_WARNING",
        severity: "warning",
        reason:
          `Verified assets cover ${months < 0 ? 0 : months.toFixed(1)} months of the estimated housing payment after the down payment — below the ${reserveRule.months}-month reserve ` +
          (reserveRule.agencyRequired
            ? "requirement for this transaction type (Fannie Mae Selling Guide B3-4.1-01)."
            : "level we look for. Fannie Mae sets no fixed minimum for a one-unit principal residence; this is our own readiness guideline."),
        requiredDocs: [
          {
            documentType: "bank_statement",
            description:
              "Statements for any additional accounts (savings, retirement, brokerage) not yet linked",
          },
          {
            documentType: "gift_letter",
            description: "Gift letter if a relative is contributing funds",
          },
        ],
        metrics: {
          monthsOfReserves: Number(months.toFixed(2)),
          estimatedMonthlyPayment: Number(piti.toFixed(2)),
          verifiedAssets: input.verifiedAssetsTotal,
          downPayment: down,
        },
      });
    }
  }

  // --- Income seasoning (Fannie B3-3.5-01, "Length of Self-Employment"): a
  // two-year history is generally required; under two years only where the
  // returns show a full 12 months in the current business AND prior income at
  // the same-or-greater level in the same field is documented. ---------------
  const seasoning = assessIncomeSeasoning(input.incomeSources);
  if (seasoning.unseasonedSources.length > 0 || seasoning.conditionalSources.length > 0) {
    const worst = [...seasoning.unseasonedSources, ...seasoning.conditionalSources].sort(
      (a, b) => a.months - b.months,
    )[0];
    const blocking = seasoning.unseasonedSources.length > 0;
    flags.push({
      code: "INCOME_SEASONING",
      severity: blocking ? "blocking" : "warning",
      reason: blocking
        ? `Your ${worst.type.replace(/_/g, " ")} income has ${worst.months} months of history — standard guidelines require ${SEASONING_FULL_MONTHS} months before it can count toward qualifying. We can still qualify you on your other income.`
        : `Your ${worst.type.replace(/_/g, " ")} income has ${worst.months} months of history — under ${SEASONING_FULL_MONTHS} months it can count only if your most recent returns reflect a full 12 months from the current business and the file also documents earlier income at the same or greater level in the same field. We will confirm both before counting it.`,
      requiredDocs: [
        {
          documentType: "tax_return",
          description: "Last two years of federal tax returns (1040s) covering the supplementary income",
        },
        {
          documentType: "business_license",
          description:
            "Business license or contract evidencing the income's continuity — and, for income under 24 months, documentation of prior income at the same or greater level in the same field (B3-3.5-01 makes that a separate loan-file item, not something the current business's returns can show)",
        },
      ],
      metrics: {
        shortestSeasoningMonths: worst.months,
        conditionalSources: seasoning.conditionalSources.length,
        unseasonedSources: seasoning.unseasonedSources.length,
      },
    });
  }

  // --- Sleeper debt (Fannie B3-6-05): deferred student loans at 1% of balance,
  // revolving lines reporting no minimum payment at the greater of $10 or 5%,
  // plus newly opened tradelines, recomputed against the 43% DTI ceiling. ----
  const income = toNumber(input.annualIncome);
  if (input.tradelines && input.tradelines.length > 0 && !isNaN(income) && income > 0) {
    const adjustment = adjustLiabilities(input.tradelines);
    const grossMonthly = income / 12;
    const piti = !isNaN(price) && !isNaN(down) ? estimateMonthlyPITI(price, down) : 0;
    const dti = computeDti(adjustment.adjustedMonthlyDebt, piti, grossMonthly);
    // Every contributor that makes the qualifying debt exceed what the borrower
    // sees on their own statements. Revolving imputation belongs here: it is
    // already inside adjustedMonthlyDebt (and so inside `dti`), so omitting it
    // would push a file over the ceiling and then decline to explain why.
    const hiddenDebtCauses: string[] = [];
    if (adjustment.deferredStudentLoans.length > 0) {
      hiddenDebtCauses.push("deferred student loans (qualified at 1% of balance)");
    }
    if (adjustment.imputedRevolvingLines.length > 0) {
      hiddenDebtCauses.push(
        "revolving lines that report no minimum payment (qualified at 5% of balance)",
      );
    }
    if (adjustment.newTradelines.length > 0) {
      hiddenDebtCauses.push("recently opened credit lines");
    }
    const hasHiddenDebt = hiddenDebtCauses.length > 0;
    if (hasHiddenDebt && dti > STANDARD_DTI_CEILING) {
      const whatIf = computeWhatIfPayoff(
        input.tradelines,
        adjustment.adjustedMonthlyDebt,
        piti,
        grossMonthly,
      );
      flags.push({
        code: "VERIFIED_DEBT_DTI",
        severity: "warning",
        reason:
          `Your verified credit file includes ${formatList(hiddenDebtCauses)}` +
          ` that raise your qualifying debt-to-income to ${(dti * 100).toFixed(1)}% — above the ${(STANDARD_DTI_CEILING * 100).toFixed(0)}% standard ceiling.` +
          (whatIf
            ? ` Paying off your ${whatIf.creditor} balance of $${Math.round(whatIf.balance).toLocaleString()} before closing would bring it back to ${(whatIf.dtiAfterPayoff * 100).toFixed(1)}%.`
            : ""),
        requiredDocs: whatIf
          ? [{ documentType: "other", description: `Payoff confirmation for ${whatIf.creditor} (balance ~$${Math.round(whatIf.balance).toLocaleString()})` }]
          : [{ documentType: "letter_of_explanation", description: "Letter of explanation for the recently opened credit lines" }],
        metrics: {
          adjustedDti: Number((dti * 100).toFixed(2)),
          adjustedMonthlyDebt: Number(adjustment.adjustedMonthlyDebt.toFixed(2)),
          deferredImputed: Number(adjustment.deferredStudentLoanImputed.toFixed(2)),
          revolvingImputed: Number(adjustment.revolvingImputed.toFixed(2)),
          imputedRevolvingLines: adjustment.imputedRevolvingLines.length,
          newTradelines: adjustment.newTradelines.length,
          ...(whatIf ? { whatIfPayoffBalance: whatIf.balance, whatIfDti: Number((whatIf.dtiAfterPayoff * 100).toFixed(2)) } : {}),
        },
      });
    }
  }

  // --- Large-deposit sourcing (Fannie B3-4.2-02, "Evaluating Large Deposits"):
  // a single deposit exceeding 50% of total monthly qualifying income. B3-4.3-04
  // governs only the gift RESOLUTION path, not the sourcing rule itself. -------
  if (!isNaN(income) && income > 0) {
    const finding = assessLargeDepositSourcing(input.transactions, income / 12);
    if (finding) {
      flags.push({
        code: "LARGE_DEPOSIT_SOURCING",
        severity: "warning",
        reason: finding.reason,
        requiredDocs: finding.requiredDocs,
        conditionSourceRule: finding.sourceRule,
        metrics: {
          depositAmount: finding.largest.amount,
          threshold: finding.largest.threshold,
          depositCount: finding.depositCount,
          totalFlaggedAmount: finding.totalFlaggedAmount,
        },
      });
    }
  }

  // --- Rental income calculation (Fannie B3-3.8-01, formerly B3-3.1-08): 75%
  // of gross rent, net of the property's PITIA, per rental property declared
  // at intake. Positive offsets reach the decision only once the file is
  // verification-grade; a net loss counts immediately (see
  // docs/fannie-mae/rental-income-reference.md, platform asymmetry policy). --
  const rentalProperties = (input.incomeSources ?? [])
    .filter((s) => s.type === "rental")
    .flatMap((s) => s.rentalProperties ?? []);
  const rentalOffsets = calculateRentalIncomeOffsets(rentalProperties);
  if (rentalOffsets.length > 0) {
    const totalQualifying = rentalOffsets.reduce((sum, r) => sum + r.qualifyingRentalIncome, 0);
    const totalNetOffset = rentalOffsets.reduce((sum, r) => sum + r.netOffset, 0);
    flags.push({
      code: "RENTAL_INCOME_OFFSET",
      severity: "warning",
      reason:
        `We applied a 25% vacancy/expense factor to your reported rental income (standard guidelines): ` +
        `$${Math.round(totalQualifying).toLocaleString()}/month qualifying across ${rentalOffsets.length} propert${rentalOffsets.length === 1 ? "y" : "ies"}, ` +
        (totalNetOffset >= 0
          ? `net of the property payment this adds $${Math.round(totalNetOffset).toLocaleString()}/month toward your qualifying income once your rental documentation is verified.`
          : `net of the property payment this adds $${Math.round(Math.abs(totalNetOffset)).toLocaleString()}/month to your qualifying debt.`) +
        ` Please upload the executed lease agreement(s) and your most recent Schedule E to document rental history.`,
      requiredDocs: [
        { documentType: "lease_agreement", description: "Executed lease agreement for each rental property" },
        { documentType: "tax_return", description: "Most recent Schedule E (Form 1040) documenting rental history" },
      ],
      metrics: {
        propertyCount: rentalOffsets.length,
        totalQualifyingRentalIncome: Number(totalQualifying.toFixed(2)),
        totalNetOffset: Number(totalNetOffset.toFixed(2)),
      },
    });
  }

  // --- Multi-unit subject property rental income (Fannie B3-3.8-01, formerly
  // B3-3.1-08): 75% of appraisal market rent is ADDED to qualifying income;
  // the subject property's full payment stays in monthly obligations — the
  // two are never netted in the applied DTI math (ledger
  // fnma-b3-3-8-01-subject-rental-income). ----------------------------------
  if (input.subjectProperty && !isNaN(price) && !isNaN(down)) {
    const subjectPitia = estimateMonthlyPITI(price, down);
    const subjectOffset = calculateSubjectPropertyRentalOffset(
      input.subjectProperty.estimatedMarketRent,
      subjectPitia,
      input.subjectProperty.numberOfUnits,
      input.subjectProperty.occupancyType,
    );
    if (subjectOffset) {
      flags.push({
        code: "SUBJECT_PROPERTY_RENTAL_OFFSET",
        severity: "warning",
        reason:
          `We applied a 25% vacancy/expense factor to the subject property's projected market rent (standard guidelines): ` +
          `$${Math.round(subjectOffset.qualifyingRentalIncome).toLocaleString()}/month is added toward your qualifying income once the rent schedule is verified, while the property's full estimated payment of $${Math.round(subjectOffset.subjectPitia).toLocaleString()}/month remains in your obligations.` +
          ` Please upload the appraisal rent schedule or executed leases for the other units to confirm market rent.`,
        requiredDocs: [
          { documentType: "other", description: "Appraisal rent schedule (Fannie Mae Form 1025/1007) for the subject property" },
          { documentType: "lease_agreement", description: "Executed lease agreement(s) for the non-owner-occupied unit(s), if available" },
        ],
        metrics: {
          grossMonthlyMarketRent: subjectOffset.grossMonthlyMarketRent,
          qualifyingRentalIncome: Number(subjectOffset.qualifyingRentalIncome.toFixed(2)),
          subjectPitia: Number(subjectOffset.subjectPitia.toFixed(2)),
          netOffset: Number(subjectOffset.netOffset.toFixed(2)),
        },
      });
    }
  }

  // --- S-07: departing residence converting to a rental (Fannie B3-3.8-01;
  // conversions also see B3-6-06). Projected market rent × 75% net of the
  // retained property's PITIA — same per-property treatment as S-05, always
  // review-flagged until appraisal/lease evidence lands. ---------------------
  if (
    input.currentPropertyDisposition === "converted_to_rental" &&
    input.departingResidence
  ) {
    const [offset] = calculateRentalIncomeOffsets([
      {
        address: "Departing residence",
        monthlyRentalIncome: String(input.departingResidence.estimatedMarketRent ?? ""),
        monthlyDebtPayment: String(input.departingResidence.monthlyPitia ?? ""),
      } as never,
    ]);
    if (offset && offset.grossMonthlyRent > 0) {
      flags.push({
        code: "RENTAL_CONVERSION_OFFSET",
        severity: "warning",
        reason:
          `You're converting your current home to a rental. We applied a 25% vacancy factor to your estimated market rent (standard guidelines): ` +
          `$${Math.round(offset.qualifyingRentalIncome).toLocaleString()}/month qualifying, ` +
          (offset.netOffset >= 0
            ? `net of that property's payment this adds $${Math.round(offset.netOffset).toLocaleString()}/month toward your qualifying income once the rental documentation is verified.`
            : `net of that property's payment this adds $${Math.round(Math.abs(offset.netOffset)).toLocaleString()}/month to your qualifying debt.`) +
          ` Please upload a rental appraisal or executed lease to verify these figures.`,
        requiredDocs: [
          { documentType: "lease_agreement", description: "Executed lease agreement for the departing residence (if already leased)" },
          { documentType: "other", description: "Rental appraisal / market-rent schedule (Form 1007) for the departing residence" },
          { documentType: "tax_return", description: "Most recent Schedule E (confirming the property is newly placed in service)" },
        ],
        metrics: {
          grossMonthlyMarketRent: offset.grossMonthlyRent,
          qualifyingRentalIncome: Number(offset.qualifyingRentalIncome.toFixed(2)),
          retainedPitia: Number(offset.monthlyPitia.toFixed(2)),
          netOffset: Number(offset.netOffset.toFixed(2)),
        },
      });
    }
  }

  // B3-6-05, Debts Paid by Others. Each eligible debt has already left the
  // qualifying ratio (shared/liabilityExclusions.ts); what the Guide still
  // requires is "the most recent 12 months' canceled checks (or bank
  // statements) from the other party making the payments". One flag per file,
  // one document line per debt, so the borrower sees exactly which checks to
  // gather — and runPreUnderwriting turns each into its own condition.
  const thirdPartyPaid = excludableThirdPartyPaidDebts(input.declaredLiabilities);
  if (thirdPartyPaid.length > 0) {
    const monthly = thirdPartyPaid.reduce((sum, l) => sum + toMoney(l.monthlyPayment), 0);
    const creditors = thirdPartyPaid.map((l) => l.creditorName || "a debt");
    flags.push({
      code: "THIRD_PARTY_PAID_DEBT",
      severity: "warning",
      reason:
        `You told us someone else makes the payments on ${formatList(creditors)}, so we left ` +
        `$${Math.round(monthly).toLocaleString()}/month out of your debt ratio — the way Fannie Mae allows. ` +
        `To keep it out, we need the most recent ${THIRD_PARTY_PAYMENT_HISTORY_MONTHS} months of cancelled checks or bank statements ` +
        `from the person who pays, showing every payment made on time.`,
      requiredDocs: thirdPartyPaid.map((l) => ({
        documentType: THIRD_PARTY_PAYMENT_HISTORY_DOCUMENT_TYPE,
        description:
          `${THIRD_PARTY_PAYMENT_HISTORY_MONTHS} months of cancelled checks or bank statements from ` +
          `${relationshipPhrase(l.otherPartyRelationship)} showing on-time payments to ${l.creditorName || "the creditor"}`,
      })),
      metrics: {
        thirdPartyPaidDebts: thirdPartyPaid.length,
        monthlyExcluded: Number(monthly.toFixed(2)),
      },
    });
  }

  return flags;
}

function toMoney(value: string | number | null | undefined): number {
  const n = typeof value === "string" ? parseFloat(value) : value ?? 0;
  return Number.isFinite(n) ? (n as number) : 0;
}

/** The "frictionless fix": one personalized message instead of an LO email chain. */
export function buildFlagOutreach(
  firstName: string | null | undefined,
  flags: PreUwFlag[],
): { subject: string; emailHtml: string; emailText: string; smsBody: string } | null {
  if (flags.length === 0) return null;
  const name = firstName || "there";

  const docLines = flags.flatMap((f) => f.requiredDocs.map((d) => d.description));
  const uniqueDocs = [...new Set(docLines)];

  const explanations = flags.map((f) => {
    switch (f.code) {
      case "COMPLEX_INCOME_CHECK":
        return "Because you're self-employed, lenders need to see your business income history. To proceed with your loan, please upload your last two years of federal tax returns (1040s) and a year-to-date profit & loss statement.";
      case "INCOME_SEASONING":
      case "VERIFIED_DEBT_DTI":
      case "LARGE_DEPOSIT_SOURCING":
      case "RENTAL_INCOME_OFFSET":
      case "SUBJECT_PROPERTY_RENTAL_OFFSET":
      case "RENTAL_CONVERSION_OFFSET":
      case "THIRD_PARTY_PAID_DEBT":
        // These reasons are already written borrower-first with the specific
        // numbers and the resolution path baked in.
        return f.reason;
      default: {
        const months = f.metrics?.monthsOfReserves;
        const monthsLabel =
          months === undefined ? `less than ${RESERVES_MONTHS_THRESHOLD}` : Math.max(months, 0).toFixed(1);
        return `Your linked accounts currently show ${monthsLabel} months of payment reserves after your down payment. This won't stop your application — linking any additional savings, retirement, or brokerage accounts (or documenting gift funds) will strengthen it.`;
      }
    }
  });

  // Configurable so non-production environments never send borrowers to the
  // wrong host; defaults preserve current production behavior.
  const documentsUrl = `${COMPANY_CONFIG.baseUrl}/documents`;

  const subject = "Your Homiquity application: a quick document request";
  const emailText = [
    `Hi ${name},`,
    "",
    // Neutral, factual framing: this is a documentation request, and it must
    // never read as a decision signal in either direction (ECOA/UDAAP).
    "Thanks for your application. Our automated document review found a few items we'll need so nothing slows you down later:",
    "",
    ...explanations.map((e, i) => `${i + 1}. ${e}`),
    "",
    "What to upload:",
    ...uniqueDocs.map((d) => `• ${d}`),
    "",
    `Upload securely in your document center: ${documentsUrl}`,
    "",
    "This is a request for documentation only — not a loan decision. Your file re-checks automatically the moment your documents arrive.",
    "— The Homiquity Team",
  ].join("\n");

  const emailHtml = emailText
    .split("\n")
    .map((line) => (line ? `<p style="margin:4px 0">${line}</p>` : "<br/>"))
    .join("");

  const smsBody = `Homiquity: your loan file needs ${uniqueDocs.length} required document${uniqueDocs.length === 1 ? "" : "s"}. Upload securely: ${documentsUrl}`;

  return { subject, emailHtml, emailText, smsBody };
}

function flagsHash(flags: PreUwFlag[]): string {
  return createHash("sha256")
    .update(flags.map((f) => f.code).sort().join("|"))
    .digest("hex")
    .slice(0, 16);
}

/** "a", "a and b", "a, b and c" — used in borrower-facing flag copy. */
/**
 * Keep the per-liability B3-6-05 documentation conditions in step with the
 * borrower's current declarations: create for newly eligible debts, re-open a
 * retired one if the claim returns, retire (not_applicable) an open one whose
 * debt is no longer excludable. A cleared condition is history and is left
 * alone. Exported for its test.
 */
export async function reconcileThirdPartyPaidDebtConditions(
  applicationId: string,
  declaredLiabilities: DeclaredLiability[] | null | undefined,
): Promise<void> {
  const prefix = `${PAID_BY_OTHER_PARTY_CONDITION_RULE}:`;
  const wanted = new Map<string, DeclaredLiability>(
    excludableThirdPartyPaidDebts(declaredLiabilities).map((d) => [`${prefix}${d.id}`, d]),
  );
  const existing = await storage.getLoanConditionsByApplication(applicationId);
  for (const c of existing) {
    if (!c.sourceRule?.startsWith(prefix)) continue;
    if (wanted.has(c.sourceRule)) {
      if (c.status === "not_applicable") {
        await storage.updateLoanCondition(c.id, { status: "outstanding", clearanceNotes: null });
      }
      wanted.delete(c.sourceRule);
    } else if (c.status === "outstanding" || c.status === "submitted") {
      await storage.updateLoanCondition(c.id, {
        status: "not_applicable",
        clearanceNotes:
          "The borrower withdrew the third-party payment claim on this liability (or the answers no longer qualify " +
          "under B3-6-05), so the payment is back in the qualifying ratio — no payment history is needed.",
      });
    }
  }
  for (const [sourceRule, debt] of wanted) {
    await storage.createLoanCondition({
      applicationId,
      category: "credit",
      title: `Third-party payment history — ${debt.creditorName || "liability"}`,
      description:
        `The borrower reports that ${relationshipPhrase(debt.otherPartyRelationship)} makes the payments on this ` +
        `${debt.creditorName || "debt"}, and the payment has been excluded from the qualifying DTI under ` +
        `Selling Guide B3-6-05, Debts Paid by Others. To sustain the exclusion, obtain the most recent ` +
        `${THIRD_PARTY_PAYMENT_HISTORY_MONTHS} months' cancelled checks (or bank statements) from that party ` +
        `documenting a ${THIRD_PARTY_PAYMENT_HISTORY_MONTHS}-month payment history with no delinquent payments. ` +
        `If the history cannot be documented, uncheck "someone else pays this" on the liability so the payment returns to the ratio.`,
      priority: "prior_to_docs",
      status: "outstanding",
      requiredDocumentTypes: [THIRD_PARTY_PAYMENT_HISTORY_DOCUMENT_TYPE],
      isAutoGenerated: true,
      sourceRule,
    });
  }
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Evaluate an application, persist the flags, materialize conditions that
 * need teeth, and notify the borrower once per distinct flag set.
 */
export async function runPreUnderwriting(
  applicationId: string,
  trigger: "intake" | "voa_received" | "liability_declared",
): Promise<{ flags: PreUwFlag[]; notified: boolean }> {
  const [application] = await db
    .select()
    .from(loanApplications)
    .where(eq(loanApplications.id, applicationId))
    .limit(1);
  if (!application) throw new Error(`Application ${applicationId} not found`);

  const [[voa], [pull], propertyInfo, declaredLiabilities] = await Promise.all([
    db
      .select({ totalBalance: verificationReports.totalBalance, rawPayload: verificationReports.rawPayload })
      .from(verificationReports)
      .where(
        and(
          eq(verificationReports.applicationId, applicationId),
          eq(verificationReports.reportType, "voa"),
          eq(verificationReports.status, "completed"),
        ),
      )
      .orderBy(desc(verificationReports.completedAt))
      .limit(1),
    // Fabricated tradelines must not drive borrower-facing output in production
    // (F-037). This selected the latest completed pull with no `isSimulated`
    // predicate, so simulated liabilities flowed into derivePreUnderwritingFlags —
    // which persists flags, materializes conditions and notifies the borrower.
    // `isSimulated` exists precisely so a real pull is distinguishable from an
    // invented one; outside production we still consume simulated pulls, because
    // that is the whole point of the simulation in dev and preview.
    db
      .select({ liabilities: creditPulls.liabilities })
      .from(creditPulls)
      .where(
        and(
          eq(creditPulls.applicationId, applicationId),
          eq(creditPulls.status, "completed"),
          ...(process.env.NODE_ENV === "production"
            ? [eq(creditPulls.isSimulated, false)]
            : []),
        ),
      )
      .orderBy(desc(creditPulls.completedAt))
      .limit(1),
    storage.getUrlaPropertyInfo(applicationId),
    storage.getUrlaLiabilities(applicationId),
  ]);

  const flags = derivePreUnderwritingFlags({
    annualIncome: application.annualIncome,
    purchasePrice: application.purchasePrice,
    downPayment: application.downPayment,
    employmentType: application.employmentType,
    verifiedAssetsTotal: voa?.totalBalance ? parseFloat(voa.totalBalance) : null,
    incomeSources: (application.incomeSources as IncomeSourceEntry[] | null) ?? null,
    tradelines: (pull?.liabilities as Tradeline[] | null) ?? null,
    transactions:
      ((voa?.rawPayload as { transactions?: DepositoryTransaction[] } | null)?.transactions as
        | DepositoryTransaction[]
        | undefined) ?? null,
    subjectProperty: propertyInfo
      ? {
          numberOfUnits: propertyInfo.numberOfUnits,
          occupancyType: propertyInfo.occupancyType,
          estimatedMarketRent: propertyInfo.estimatedMarketRent,
        }
      : null,
    declaredLiabilities,
    currentPropertyDisposition: application.currentPropertyDisposition,
    departingResidence:
      (application.departingResidence as {
        estimatedMarketRent: string | number | null;
        monthlyPitia: string | number | null;
      } | null) ?? null,
  });

  const previous = (application.preUwFlags ?? null) as { notifiedHash?: string } | null;
  const hash = flagsHash(flags);
  const alreadyNotified = previous?.notifiedHash === hash;

  // Give the reserves warning teeth: an outstanding condition (idempotent —
  // pipelineEngine only creates it for LTV > 95%, so check before inserting).
  if (flags.some((f) => f.code === "LOW_RESERVES_WARNING")) {
    const existing = await storage.getLoanConditionsByApplication(applicationId);
    const hasReserveCondition = existing.some(
      (c) => c.requiredDocumentTypes?.includes("reserves_proof") && c.status === "outstanding",
    );
    if (!hasReserveCondition) {
      await storage.createLoanCondition({
        applicationId,
        category: "assets",
        title: "Reserve Funds Verification",
        description: `Verified assets fall below the reserve level required for this transaction. Provide additional asset statements or gift documentation.`,
        priority: "prior_to_docs",
        status: "outstanding",
        requiredDocumentTypes: ["reserves_proof"],
        isAutoGenerated: true,
        sourceRule: "PRE_UW_LOW_RESERVES",
      });
    }
  }

  // B3-6-05, Debts Paid by Others: one outstanding condition per excluded
  // debt, keyed by liability id so a re-run never duplicates it, and so the
  // staff clearing workflow on the conditions tab IS the Guide's verification
  // of the 12-month payment history — no staff-only column on the liability
  // row for a borrower to self-set. Reconciled on every run, regardless of the
  // Autopilot kill switch (like the reserves condition above): the exclusion
  // is live in the ratio the moment it is claimed, so the paperwork must be
  // live with it — and retired the moment the claim is withdrawn, so no one
  // is chasing cancelled checks for a payment that is back in the ratio.
  await reconcileThirdPartyPaidDebtConditions(applicationId, declaredLiabilities);

  // An unexplained large deposit changes usable assets, so its condition is a
  // decision control even when the optional Autopilot follow-up feature is
  // disabled. A new deposit set gets a new fingerprinted condition; stale open
  // versions are retired and a prior clearance cannot clear different funds.
  await reconcileFlagFollowUp(
    applicationId,
    "LARGE_DEPOSIT_SOURCING",
    flags.find(flag => flag.code === "LARGE_DEPOSIT_SOURCING") ?? null,
  );

  // Autopilot: give the remaining flags teeth. runPreUnderwriting only
  // materializes LOW_RESERVES above; when Autopilot is active this converts the
  // other cited flags into idempotent loan_conditions (packaging follow-ups —
  // never a decision). No-op when the kill switch is off, so today's behavior is
  // unchanged for any lender who hasn't activated the agent.
  if (
    flags.length > 0 &&
    (await isAutopilotEnabled(application.loanOfficerId)) &&
    (await canGenerateFollowUps())
  ) {
    await materializeFlagsToFollowUps(applicationId, flags);
  }

  let notified = false;
  if (flags.length > 0 && !alreadyNotified) {
    const borrower = await storage.getUser(application.userId);
    const outreach = buildFlagOutreach(borrower?.firstName, flags);
    if (outreach && borrower) {
      await storage.createNotification({
        userId: borrower.id,
        type: "document_request",
        title: "A few items needed on your application",
        body: outreach.emailText,
        entityType: "loan_application",
        entityId: applicationId,
        metadata: { flags: flags.map((f) => f.code), trigger, sms: outreach.smsBody },
      });
      if (borrower.email) {
        await sendEmail({
          to: borrower.email,
          subject: outreach.subject,
          html: outreach.emailHtml,
          text: outreach.emailText,
        });
      }
      notified = true;
    }
  }

  await db
    .update(loanApplications)
    .set({
      preUwFlags: {
        flags,
        evaluatedAt: new Date().toISOString(),
        trigger,
        notifiedHash: notified || alreadyNotified ? hash : previous?.notifiedHash ?? null,
      },
    })
    .where(eq(loanApplications.id, applicationId));

  await storage.createDealActivity({
    applicationId,
    activityType: "note",
    title: flags.length > 0 ? `Pre-underwriting flags: ${flags.map((f) => f.code).join(", ")}` : "Pre-underwriting check passed",
    description:
      flags.length > 0
        ? flags.map((f) => f.reason).join(" ")
        : `Automated pre-underwriting review found no issues (trigger: ${trigger}).`,
    performedBy: application.userId,
  });

  console.error(
    `[pre-uw] ${applicationId} (${trigger}): ${flags.length === 0 ? "clean" : flags.map((f) => f.code).join(", ")}${notified ? " — borrower notified" : ""}`,
  );

  return { flags, notified };
}
