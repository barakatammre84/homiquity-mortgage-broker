import { storage } from "../storage";
import { calculateLLPA } from "../pricing";
import { calculateMortgageAPR } from "./apr";
import { addBusinessDays } from "./businessDays";
import { computeClosingCosts, estimateMonthlyEscrow } from "./loanCosts";
import { offerMonthlyMI, offerUpfrontMI } from "./mortgageInsurance";
import { resolveFeeScheduleForApplication } from "./platformFeeSchedule";
import { resolveCompensation } from "@shared/compliance/loCompensation";
import { toActualFeeMap, type ActualFeeMap } from "@shared/compliance/feeProvenance";
import type { LoanApplication } from "@shared/schema";
import { monthlyPrincipalAndInterest } from "@shared/lib/amortization";
import { assessSubjectPropertyFinancing } from "@shared/subjectPropertyFinancing";

export interface LoanEstimateData {
  applicationId: string;
  /** The selected product family whose terms and insurance were priced. */
  loanProgram: "CONVENTIONAL" | "FHA" | "VA";
  dateIssued: Date;
  expirationDate: Date;
  
  loanTerms: {
    loanAmount: number;
    interestRate: number;
    monthlyPrincipalAndInterest: number;
    prepaymentPenalty: boolean;
    balloonPayment: boolean;
  };
  
  projectedPayments: {
    years1Through5: {
      principalAndInterest: number;
      mortgageInsurance: number;
      estimatedEscrow: number;
      estimatedTotal: number;
    };
    years6Through30?: {
      principalAndInterest: number;
      mortgageInsurance: number;
      estimatedEscrow: number;
      estimatedTotal: number;
    };
  };
  
  costsAtClosing: {
    estimatedClosingCosts: number;
    estimatedCashToClose: number;
  };
  
  closingCostDetails: {
    loanCosts: {
      originationCharges: {
        /**
         * Borrower-paid origination fee. §1026.37(f)(1) requires every
         * origination charge itemized by name and amount — this line used to
         * be folded silently into `total`, so the subtotal exceeded the lines
         * above it by 1% of the loan amount and the platform's largest fee had
         * no name anywhere on the disclosure.
         */
        originationFee: number;
        points: number;
        applicationFee: number;
        underwritingFee: number;
        total: number;
      };
      servicesYouCannotShopFor: {
        appraisal: number;
        creditReport: number;
        floodDetermination: number;
        taxService: number;
        total: number;
      };
      servicesYouCanShopFor: {
        titleInsurance: number;
        titleSearch: number;
        surveyFee: number;
        pestInspection: number;
        total: number;
      };
      totalLoanCosts: number;
    };
    otherCosts: {
      taxesAndGovernmentFees: {
        recordingFees: number;
        transferTaxes: number;
        total: number;
      };
      prepaids: {
        homeownersInsurance: number;
        mortgageInsurance: number;
        prepaidInterest: number;
        propertyTaxes: number;
        total: number;
      };
      initialEscrowPaymentAtClosing: {
        homeownersInsurance: number;
        mortgageInsurance: number;
        propertyTaxes: number;
        total: number;
      };
      otherItems: {
        ownersTitleInsurance: number;
        total: number;
      };
      totalOtherCosts: number;
    };
    totalClosingCosts: number;
  };
  
  cashToClose: {
    totalClosingCosts: number;
    closingCostsPaidBeforeClosing: number;
    downPayment: number;
    deposit: number;
    fundsFromBorrower: number;
    sellerCredits: number;
    adjustmentsAndOtherCredits: number;
    cashToClose: number;
  };
  
  appraisedPropertyValue: number;
  estimatedPropertyTaxes: number;
  homeownersInsurance: number;
  
  comparisons: {
    inFiveYears: {
      totalYouWillHavePaid: number;
      principalPaidOff: number;
    };
    apr: number;
    totalInterestPercentage: number;
  };
  
  lenderCredits: number;
  
  tridCompliance: {
    disclosureProvided: boolean;
    dateProvided: Date | null;
    /**
     * Three-valued on purpose — see `evaluateTridDeliveryWindow`. `null` means
     * the window never opened, and is NOT a pass.
     */
    withinThreeBusinessDays: boolean | null;
    /** When the 6th piece of §1026.2(a)(3) information arrived; null until then. */
    applicationDate: Date | null;
    /** 3 business days after applicationDate (§1026.19(e)(1)(iii)); null until triggered. */
    leDueDate: Date | null;
  };

  /**
   * The platform fee schedule version these figures were computed under.
   * Persisted onto the disclosure at first issuance so the file stays pinned
   * to it (audit FA-20). BASELINE_FEE_SCHEDULE_VERSION = the compiled-in
   * baseline.
   */
  feeScheduleVersion: number;
}

/** @see {@link monthlyPrincipalAndInterest} — annualRate is a PERCENT here. */
const calculateMonthlyPayment = monthlyPrincipalAndInterest;

function estimateClosingDate(): Date {
  const closingDate = new Date();
  closingDate.setDate(closingDate.getDate() + 30);
  return closingDate;
}

/** Days of prepaid interest at closing: the days remaining in the closing month. */
function prepaidInterestDaysFor(closingDate: Date): number {
  const daysInMonth = new Date(closingDate.getFullYear(), closingDate.getMonth() + 1, 0).getDate();
  return daysInMonth - closingDate.getDate();
}

/**
 * Cost-ledger categories that correspond to a disclosed third-party fee. A
 * real invoice booked against the file becomes the disclosed amount.
 *
 * Only categories that map 1:1 to a single LE line are listed — "verification"
 * and "marketing" are real costs but not borrower charges, and must never
 * silently inflate a disclosure.
 */
export const COST_CATEGORY_TO_DISCLOSED_FEE_ID: Record<string, string> = {
  appraisal: "appraisal",
  credit_report: "credit_report",
  flood: "flood_determination",
  title: "title_insurance",
};

/**
 * Actual third-party charges recorded for a file, keyed by fee id. Multiple
 * entries in a category sum (a supplemental appraisal invoice adds to the
 * first) and reversal-negative entries are respected, because both are part of
 * the real invoiced total. Failures degrade to "no actuals" — a ledger problem
 * must not stop a Loan Estimate from being produced.
 *
 * SIMULATED ENTRIES ARE EXCLUDED. The cost ledger records what Homiquity pays
 * a vendor; this function turns that into what the BORROWER is charged on a
 * disclosure. While an adapter is a deterministic simulation it books its
 * platform-assumption unit cost — creditPulls.ts books a soft pull at $5
 * against an estimated $75 credit-report line — and letting that through
 * replaced a disclosed fee with a made-up one. `credit_report` is a
 * zero-tolerance line (shared/compliance/feeTolerance.ts), where an
 * understatement at closing is a dollar-for-dollar cure, so the simulation
 * would have manufactured real liability. creditPulls.ts sets `simulated`
 * precisely "so they cannot leak"; honoring that flag here is what makes the
 * claim true. Only a real invoice may move a disclosed number.
 */
async function resolveActualFeesFor(applicationId: string): Promise<ActualFeeMap> {
  try {
    const entries = await storage.getLoanCostEntries(applicationId);
    const totals: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.simulated) continue;
      const feeId = COST_CATEGORY_TO_DISCLOSED_FEE_ID[entry.category];
      if (!feeId) continue;
      totals[feeId] = (totals[feeId] ?? 0) + Number(entry.amount || 0);
    }
    // A category that nets to zero or below is not a disclosable charge.
    for (const key of Object.keys(totals)) {
      if (!(totals[key] > 0)) delete totals[key];
    }
    return toActualFeeMap(
      Object.entries(totals).map(([feeId, amount]) => ({
        feeId,
        amount,
        source: "loan cost ledger",
        recordedAt: new Date().toISOString(),
      })),
    );
  } catch (err) {
    console.warn("[loanEstimate] actual-fee lookup failed; using estimates:", err);
    return {};
  }
}

/**
 * The pricing derivation SHARED by the disclosable Loan Estimate and the
 * internal payment projection: input guards, note-rate derivation (base rate
 * by product, credit-score adjustments, LLPA), P&I and MI. Extracted verbatim
 * from generateLoanEstimate — one derivation, two consumers, no drift.
 *
 * Deliberately compensation-free: nothing in here reads the §1026.36(d)(2)
 * election, because no monthly-payment input depends on how the originator is
 * paid. The election guard stays on the DISCLOSABLE path below.
 *
 * THAT IS AN INVARIANT, NOT A COINCIDENCE (F-047). computePaymentProjection's
 * whole right to skip the election guard rests on it. If you are about to price
 * lender-paid compensation into `baseRate` here — the industry-standard thing to
 * do, and the reason this needs saying — understand that it silently makes the
 * instant-decision engine compensation-dependent and bypasses the fail-closed
 * guard for a number that now depends on the election.
 *
 * Enforced by tests/paymentProjection.test.ts ("is byte-identical with no
 * election, lender-paid, and borrower-paid"). Note the parity tests in that file
 * CANNOT enforce it: they compare this function's two consumers, which both call
 * it, so a change here moves both sides equally and parity still passes. Verified
 * by mutation — a comp-bearing rate bump left all six pre-existing tests green.
 */
interface PricingDerivation {
  application: LoanApplication;
  loanProgram: LoanEstimateData["loanProgram"];
  purchasePrice: number;
  downPayment: number;
  loanAmount: number;
  ltv: number;
  isVaLoan: boolean;
  /** Selected FHA product: MIP applies. */
  isFhaLoan: boolean;
  llpaResult: Awaited<ReturnType<typeof calculateLLPA>>;
  interestRate: number;
  termMonths: number;
  monthlyPandI: number;
  monthlyPMI: number;
  /** FHA up-front MIP in dollars (cash-at-closing model); 0 for every other product. */
  upfrontMIP: number;
}

/**
 * Non-persisted what-if inputs (ARC-3).
 *
 * These shadow the application's own values for ONE derivation and are never
 * written back — the borrower asking "what if I put more down?" must not mutate
 * their file. Deliberately limited to the three levers a borrower actually
 * controls; loan PROGRAM is not overridable because changing the selected
 * mortgage product requires a new product evaluation, not a payment-only
 * self-serve calculation.
 *
 * The disclosable Loan Estimate path never passes these, so the byte-identical
 * parity with computePaymentProjection (F-047) is preserved by construction:
 * with no overrides this function is exactly what it was.
 */
export interface PricingOverrides {
  purchasePrice?: number;
  downPayment?: number;
  creditScore?: number;
}

async function derivePricing(
  applicationId: string,
  overrides?: PricingOverrides,
  decisionLoanProgram?: "conventional" | "fha" | "va" | "usda",
): Promise<PricingDerivation> {
  const application = await storage.getLoanApplication(applicationId);
  if (!application) {
    throw new Error("Application not found");
  }

  const purchasePrice = Number(overrides?.purchasePrice ?? application.purchasePrice);
  if (!purchasePrice || purchasePrice <= 0) {
    throw new Error("Purchase price is required to generate a loan estimate");
  }
  const downPayment = Number(overrides?.downPayment ?? application.downPayment);
  if (isNaN(downPayment) || downPayment < 0) {
    throw new Error("Down payment is required to generate a loan estimate");
  }
  const loanAmount = purchasePrice - downPayment;
  if (loanAmount <= 0) {
    throw new Error("Loan amount must be positive (purchase price must exceed down payment)");
  }
  const creditScore = overrides?.creditScore ?? application.creditScore;
  if (!creditScore) {
    throw new Error("Credit score is required to generate a loan estimate");
  }
  const propertyState = application.propertyState;
  if (!propertyState) {
    throw new Error("Property state is required to generate a loan estimate");
  }

  const ltv = (loanAmount / purchasePrice) * 100;
  const loanType = (decisionLoanProgram ?? application.preferredLoanType)?.trim().toLowerCase();
  if (!loanType) {
    throw new Error("Preferred loan program is required to generate a loan estimate");
  }
  if (loanType === "usda") {
    throw new Error("USDA pricing is not automated yet; loan officer review is required");
  }
  if (loanType !== "conventional" && loanType !== "fha" && loanType !== "va") {
    throw new Error(`Pricing is not automated for loan program "${loanType}"; loan officer review is required`);
  }
  const amortizationType = (application.amortizationType ?? "fixed").trim().toLowerCase();
  if (amortizationType === "adjustable" || amortizationType === "arm") {
    throw new Error(
      "Adjustable-rate pricing is not automated because the index, margin, and rate caps are not captured; loan officer review is required",
    );
  }
  // Program selection comes from the application. Veteran status establishes
  // possible eligibility for VA; it does not silently change a conventional,
  // FHA or USDA request into a VA loan.
  const isVaLoan = loanType === "va";
  if (isVaLoan && !application.isVeteran) {
    throw new Error("VA eligibility must be confirmed before VA terms can be priced");
  }
  const loanProgram: LoanEstimateData["loanProgram"] =
    isVaLoan ? "VA" : loanType === "fha" ? "FHA" : "CONVENTIONAL";

  let baseRate = 6.875;
  if (isVaLoan) baseRate = 6.250;
  else if (loanType === "fha") baseRate = 6.500;

  if (creditScore >= 780) baseRate -= 0.25;
  else if (creditScore >= 760) baseRate -= 0.125;
  else if (creditScore < 680) baseRate += 0.375;
  else if (creditScore < 700) baseRate += 0.25;

  const propertyType = (application.propertyType || "single_family") as "single_family" | "condo" | "townhouse" | "multi_family";

  // Fannie Mae LLPAs and private MI do not apply to VA loans — VA guarantees
  // the loan (funding fee instead) and allows up to 100% LTV, which the
  // FANNIE_LLPA matrix has no band for. Price VA at its base-rate model.
  const llpaResult = isVaLoan
    ? {
        baseLLPA: 0,
        propertyTypeAdjustment: 0,
        condoAdjustment: 0,
        fthbWaiver: 0,
        totalLLPA: 0,
        pricing: { loanAmount, lLPAFeeAmount: 0, pmiAnnualRate: 0, pmiMonthlyPayment: 0 },
      }
    : await calculateLLPA(
        loanAmount,
        creditScore,
        ltv,
        propertyType,
        "primary_residence",
        application.isFirstTimeBuyer || false
      );

  baseRate += llpaResult.totalLLPA * 0.125;
  const interestRate = Math.round(baseRate * 1000) / 1000;

  const termMonths = 360;
  const monthlyPandI = calculateMonthlyPayment(loanAmount, interestRate, termMonths);
  // Product-aware MI through the one product-aware module (services/
  // mortgageInsurance.ts, F-087): conventional keeps the CONVENTIONAL_PMI
  // matrix figure calculateLLPA just resolved — the versioned rate card that
  // governs every policy number, which replaced the compile-time band table
  // that exceeded the matrix in all 32 live cells (1.42×–2.17×, F-077) —
  // VA carries no monthly MI (the stub above already prices 0), and FHA
  // charges annual MIP at ALL LTVs (the matrix figure was standing in for
  // MIP: $0 at ≤80 LTV where MIP is still owed, and the wrong rate above it
  // — the same F-077 defect class, for FHA borrowers). The effective product is
  // always the product selected on the application.
  const effectiveProduct = isVaLoan ? "va" : loanType;
  const isFhaLoan = effectiveProduct === "fha";
  const monthlyPMI = offerMonthlyMI({
    productType: effectiveProduct,
    loanAmount,
    ltvPct: ltv,
    conventionalMonthlyPMI: llpaResult.pricing.pmiMonthlyPayment,
  });
  // FHA up-front MIP (UFMIP), disclosed in the LE's prepaids and counted as a
  // §1026.4 prepaid finance charge — the posture services/apr.ts has always
  // taken on the advertised surface. 0 for every other product; the VA
  // funding fee and USDA guarantee fee are named gaps (see
  // services/mortgageInsurance.ts offerUpfrontMI).
  const upfrontMIP = offerUpfrontMI({ productType: effectiveProduct, loanAmount });

  return {
    application,
    loanProgram,
    purchasePrice,
    downPayment,
    loanAmount,
    ltv,
    isVaLoan,
    isFhaLoan,
    llpaResult,
    interestRate,
    termMonths,
    monthlyPandI,
    monthlyPMI,
    upfrontMIP,
  };
}

/**
 * INTERNAL PRICING PROJECTION — not a disclosure.
 *
 * The instant-decision engine consumes exactly one pricing number: the
 * proposed monthly PITI (P&I + MI + escrow). Every input of that number is
 * independent of the §1026.36(d)(2) compensation election — no origination
 * fee rides in a monthly payment, and the rate derivation never reads the
 * election — so this path omits the election guard that generateLoanEstimate
 * applies to the DISCLOSABLE Loan Estimate. (WF1-002: routing the engine
 * through the disclosable generator made every fresh intake undecidable,
 * because no intake path elects compensation.)
 *
 * Equally deliberately, the return shape carries ONLY the payment projection:
 * no fee lines, no closing costs, no APR — nothing disclosable that could
 * ever reach a borrower as a Loan Estimate. The numbers are byte-identical to
 * the LE's projectedPayments.years1Through5 for the same inputs (same
 * derivation, same escrow model, same rounding).
 */
export interface PaymentProjection {
  loanAmount: number;
  /** Note rate, % — the same derivation the Loan Estimate prices. */
  interestRate: number;
  monthlyPrincipalAndInterest: number;
  monthlyMortgageInsurance: number;
  monthlyEscrow: number;
  /**
   * Owners' association / co-op dues for the subject property — Selling Guide
   * B3-6-03 counts them inside PITIA. `null` means NOT CAPTURED, which is not
   * the same as zero; see `associationDuesUncaptured`.
   */
  monthlyAssociationDues: number | null;
  /**
   * True when the subject property is an association-bearing type (condo,
   * co-op, PUD, townhouse) and its dues have not been captured. The DTI built
   * on this projection is then understated by an unknown amount, so callers
   * must gap the file rather than decision it.
   */
  associationDuesUncaptured: boolean;
  monthlyFloodInsurance: number;
  monthlyGroundRent: number;
  monthlySpecialAssessments: number;
  monthlySubordinateFinancingPayment: number;
  subordinateFinancingExists: boolean | null;
  cltv: number | null;
  hcltv: number | null;
  /** Once the full URLA property section exists, every unknown B3-6-03 cost is
   * named here so decision callers cannot silently treat it as $0. */
  housingExpenseMissingItems: string[];
  /**
   * P&I + MI + escrow. Byte-identical to the Loan Estimate's
   * projectedPayments.years1Through5.estimatedTotal — same derivation, same
   * escrow model, same rounding. Deliberately EXCLUDES association dues so that
   * parity holds; use `qualifyingPitia` for the DTI.
   */
  estimatedMonthlyTotal: number;
  /**
   * The Selling Guide B3-6-03 qualifying housing expense: `estimatedMonthlyTotal`
   * plus association/co-op dues. **This is the figure the DTI is built on.**
   *
   * It is a separate field, not a redefinition of `estimatedMonthlyTotal`,
   * because the two answer different questions under different regimes. B3-6-03
   * governs what Fannie qualifies on and is verifiable against the committed
   * Guide. What belongs on the DISCLOSED Loan Estimate is Reg Z §1026.37(c) —
   * and per CLAUDE.md, `docs/reg-z/` holds no captured source text, so a Reg Z
   * reading is flagged, never asserted, and may never be acted on unilaterally.
   * Changing the disclosure on an unverifiable reading is exactly what that rail
   * forbids. Recorded as gap G-11.
   */
  qualifyingPitia: number;
}

/**
 * Property types that carry owners' association or co-op dues. B3-6-03 requires
 * those dues inside PITIA, so a null on one of these is a captured-nothing gap
 * rather than a genuine zero. A detached single-family property may still have
 * an HOA; the difference is that zero is a plausible default there and is not
 * on a condo or co-op.
 */
const ASSOCIATION_BEARING_PROPERTY_TYPES = new Set([
  "condo",
  "condominium",
  "co_op",
  "coop",
  "cooperative",
  "pud",
  "planned_unit_development",
  "townhouse",
  "townhome",
  // "Town House" / "town-house" normalise to this — a real intake spelling.
  "town_house",
  "town_home",
]);

export function isAssociationBearingPropertyType(propertyType: string | null | undefined): boolean {
  const t = (propertyType ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  return ASSOCIATION_BEARING_PROPERTY_TYPES.has(t);
}

/**
 * The §1026.19(e)(1)(iii) delivery-window verdict, three-valued on purpose.
 *
 * - `true`  — the LE was (or still can be) delivered on or before the deadline.
 * - `false` — the deadline passed.
 * - `null`  — **not determinable**: the TRID clock never started, so there is
 *   no `leDueDate` and therefore no deadline to have met or missed.
 *
 * `null` used to be `true` (finding ux-30). That single default meant a file
 * whose window had never opened rendered an affirmative green "TRID Compliant"
 * badge, and wrote `withinThreeBusinessDays: true` into the `trid.
 * loan_estimate_delivered` audit record — an unearned compliance assertion in
 * both the UI and the permanent audit trail. The QA sweep measured it at
 * **173 of 176 files**, with exactly one file rendering the red state honestly.
 *
 * An unknown is not a pass. This is the same rule `server/mismo.ts:405-408`
 * applies when it omits an unanswered declaration rather than sending
 * "Unknown": a NULL is an honest gap, a fabricated affirmative is a falsified
 * record. Callers must branch on all three states — `if (!x)` collapses
 * `false` and `null`, which are materially different findings.
 */
export function evaluateTridDeliveryWindow(
  complianceCheckDate: Date,
  endOfDueDay: Date | null,
): boolean | null {
  if (!endOfDueDay) return null;
  return complianceCheckDate.getTime() <= endOfDueDay.getTime();
}

async function computePaymentProjectionInternal(
  applicationId: string,
  overrides?: PricingOverrides,
  decisionLoanProgram?: "conventional" | "fha" | "va" | "usda",
): Promise<PaymentProjection> {
  const { application, purchasePrice, loanAmount, interestRate, monthlyPandI, monthlyPMI } =
    await derivePricing(applicationId, overrides, decisionLoanProgram);
  const { monthlyEscrow } = estimateMonthlyEscrow({ purchasePrice });

  // B3-6-03, Monthly Housing Expense: PITIA includes "any owners' association
  // dues" and "any monthly co-op corporation fee". They were absent from this
  // projection entirely, so a condo borrower's DTI was computed without their
  // dues — routinely $300-800/month, understating the ratio in the one
  // direction that approves files it should decline.
  const propertyInfo = await storage.getUrlaPropertyInfo(applicationId);
  const rawDues = propertyInfo?.monthlyAssociationDues;
  const monthlyAssociationDues = rawDues === null || rawDues === undefined ? null : Number(rawDues);

  // A null on a condo/co-op/PUD is "not captured", never zero. Surfacing it lets
  // the decision path gap the file instead of qualifying on a housing expense it
  // knows is incomplete.
  const associationDuesUncaptured =
    monthlyAssociationDues === null && isAssociationBearingPropertyType(application.propertyType);
  const propertyValue = Number(application.propertyValue ?? purchasePrice);
  const subjectFinancing = assessSubjectPropertyFinancing({
    propertyInfo,
    firstMortgageAmount: loanAmount,
    salesPrice: purchasePrice,
    appraisedValue: Number.isFinite(propertyValue) && propertyValue > 0 ? propertyValue : purchasePrice,
    associationDuesRequired: isAssociationBearingPropertyType(application.propertyType),
  });

  return {
    loanAmount,
    interestRate,
    monthlyPrincipalAndInterest: Math.round(monthlyPandI * 100) / 100,
    monthlyMortgageInsurance: Math.round(monthlyPMI * 100) / 100,
    monthlyEscrow: Math.round(monthlyEscrow * 100) / 100,
    monthlyAssociationDues,
    associationDuesUncaptured,
    monthlyFloodInsurance: subjectFinancing.monthlyFloodInsurance,
    monthlyGroundRent: subjectFinancing.monthlyGroundRent,
    monthlySpecialAssessments: subjectFinancing.monthlySpecialAssessments,
    monthlySubordinateFinancingPayment: subjectFinancing.monthlySubordinateFinancingPayment,
    subordinateFinancingExists: subjectFinancing.subordinateFinancingExists,
    cltv: subjectFinancing.cltv,
    hcltv: subjectFinancing.hcltv,
    housingExpenseMissingItems: subjectFinancing.missingItems,
    estimatedMonthlyTotal: Math.round((monthlyPandI + monthlyPMI + monthlyEscrow) * 100) / 100,
    qualifyingPitia:
      Math.round((monthlyPandI + monthlyPMI + monthlyEscrow + subjectFinancing.monthlyHousingExpenseAdditions) * 100) / 100,
  };
}

export async function computePaymentProjection(
  applicationId: string,
  /** ARC-3 what-if inputs. Omitted by the engine and the LE — see PricingOverrides. */
  overrides?: PricingOverrides,
): Promise<PaymentProjection> {
  return computePaymentProjectionInternal(applicationId, overrides);
}

/**
 * Internal decision-only projection for the fast application's labeled program
 * candidate. This keeps the public borrower what-if surface unable to switch
 * programs while avoiding a fabricated persisted preference.
 */
export async function computeDecisionPaymentProjection(
  applicationId: string,
  decisionLoanProgram: "conventional" | "fha" | "va" | "usda",
  /** A verified bureau score may override the intake estimate for this decision only. */
  overrides?: Pick<PricingOverrides, "creditScore">,
): Promise<PaymentProjection> {
  return computePaymentProjectionInternal(applicationId, overrides, decisionLoanProgram);
}

export async function generateLoanEstimate(applicationId: string): Promise<LoanEstimateData> {
  const {
    application,
    loanProgram,
    purchasePrice,
    downPayment,
    loanAmount,
    ltv,
    isFhaLoan,
    llpaResult,
    interestRate,
    termMonths,
    monthlyPandI,
    monthlyPMI,
    upfrontMIP,
  } = await derivePricing(applicationId);

  // §1026.36(d)(2): the fee schedule cannot be built without knowing who pays
  // the originator — a guessed model produces either an unlawful borrower
  // charge or an understated disclosure. Fail closed. This guard binds the
  // DISCLOSABLE Loan Estimate only; the engine's payment projection above is
  // compensation-independent by construction.
  const compensation = resolveCompensation(
    application.loCompensationModel,
    application.loCompensationBps,
  );
  if (!compensation) {
    throw new Error(
      "Loan originator compensation model and rate are required to generate a loan estimate (12 CFR 1026.36(d)(2))",
    );
  }

  // Fee schedule + cost structure from the shared platform model
  // (services/loanCosts.ts) — the LO-2 scenario simulator reads the same
  // function, so a scenario's cash-to-close matches the LE for equal inputs.
  const closingDate = estimateClosingDate();
  // The schedule that governs THIS file. Once an LE has been issued the file
  // is pinned to the schedule it was disclosed under, so re-pricing the
  // platform cannot move its zero-tolerance lines and manufacture a cure
  // (audit FA-20). Before first issuance this is the active schedule.
  const { schedule: feeSchedule, version: feeScheduleVersion } =
    await resolveFeeScheduleForApplication(applicationId);
  const costs = computeClosingCosts({
    purchasePrice,
    downPayment,
    loanAmount,
    interestRate,
    monthlyPMI,
    upfrontMortgageInsurance: upfrontMIP,
    prepaidInterestDays: prepaidInterestDaysFor(closingDate),
    compensation,
    feeSchedule,
    noteDate: closingDate,
    // Real quotes for this file replace the unverified national estimates
    // (F-9). Derived from the cost ledger: an appraisal invoice already booked
    // against the file is the actual charge, so disclose it rather than the
    // $650 working figure and remove the cure instead of measuring it.
    actualFees: await resolveActualFeesFor(applicationId),
    lenderCredits: llpaResult.fthbWaiver > 0 ? llpaResult.fthbWaiver * loanAmount / 100 : 0,
  });
  const {
    originationFee, points, applicationFee, underwritingFee,
    appraisalFee, creditReportFee, floodDeterminationFee, taxServiceFee,
    titleInsurance, titleSearch, surveyFee, pestInspectionFee,
    recordingFees, transferTaxes, ownersTitleInsurance,
    annualPropertyTax, annualHomeownersInsurance, monthlyEscrow,
    prepaidInterest, prepaidHomeownersInsurance, prepaidMortgageInsurance, prepaidPropertyTaxes,
    escrowHomeownersInsurance, escrowMortgageInsurance, escrowPropertyTaxes,
    loanCostsTotal, otherCostsTotal, totalClosingCosts, lenderCredits, cashToClose,
  } = costs;

  const monthlyTotal = monthlyPandI + monthlyPMI + monthlyEscrow;

  const totalPaidIn5Years = (monthlyTotal * 60) + totalClosingCosts;
  
  let principalPaidOff = 0;
  let balance = loanAmount;
  const monthlyRate = interestRate / 12 / 100;
  for (let i = 0; i < 60; i++) {
    const interestPayment = balance * monthlyRate;
    const principalPayment = monthlyPandI - interestPayment;
    balance -= principalPayment;
    principalPaidOff += principalPayment;
  }
  
  const totalInterest = (monthlyPandI * termMonths) - loanAmount;
  const totalInterestPercentage = (totalInterest / loanAmount) * 100;
  
  // Actuarial APR (§1026.22 / Appendix J): solve the payment stream against
  // the amount financed. Prepaid finance charges per §1026.4 come from the
  // shared cost model (services/loanCosts.ts).
  const apr = calculateMortgageAPR({
    loanAmount,
    noteRatePct: interestRate,
    termMonths,
    monthlyMI: monthlyPMI,
    // FHA MIP is life-of-loan — no 78% HPA auto-termination in the APR
    // stream (propertyValue 0 disables the test; the same treatment the
    // advertised model applies, services/apr.ts advertisedAPR). UFMIP rides
    // costs.prepaidFinanceCharges. Conventional keeps the HPA termination.
    propertyValue: isFhaLoan ? 0 : purchasePrice,
    prepaidFinanceCharges: costs.prepaidFinanceCharges,
  });

  // TRID timing (§1026.19(e)(1)(iii)): the clock anchors to tridTriggeredAt —
  // the moment the 6th piece of application information arrived (written by
  // services/trid.ts) — and runs in business days, never calendar days.
  const tridTriggeredAt = application.tridTriggeredAt ? new Date(application.tridTriggeredAt) : null;
  const leDueDate = tridTriggeredAt ? addBusinessDays(tridTriggeredAt, 3) : null;
  const leIssuedDate = application.leIssuedDate ? new Date(`${application.leIssuedDate}T00:00:00Z`) : null;

  const now = new Date();
  const complianceCheckDate = leIssuedDate ?? now;
  const endOfDueDay = leDueDate ? new Date(leDueDate) : null;
  if (endOfDueDay) endOfDueDay.setUTCHours(23, 59, 59, 999);
  const dateIssued = now;
  const expirationDate = new Date(now);
  expirationDate.setDate(expirationDate.getDate() + 10);
  
  return {
    applicationId,
    loanProgram,
    dateIssued,
    expirationDate,
    
    loanTerms: {
      loanAmount,
      interestRate,
      monthlyPrincipalAndInterest: Math.round(monthlyPandI * 100) / 100,
      prepaymentPenalty: false,
      balloonPayment: false,
    },
    
    projectedPayments: {
      years1Through5: {
        principalAndInterest: Math.round(monthlyPandI * 100) / 100,
        mortgageInsurance: Math.round(monthlyPMI * 100) / 100,
        estimatedEscrow: Math.round(monthlyEscrow * 100) / 100,
        estimatedTotal: Math.round(monthlyTotal * 100) / 100,
      },
      // FHA MIP never steps off the payment (life-of-loan, matching the APR
      // stream above), so an FHA file gets no MI-drops-to-zero column at any
      // LTV. Conventional keeps the existing 78-LTV behavior.
      years6Through30: ltv > 78 || isFhaLoan ? undefined : {
        principalAndInterest: Math.round(monthlyPandI * 100) / 100,
        mortgageInsurance: 0,
        estimatedEscrow: Math.round(monthlyEscrow * 100) / 100,
        estimatedTotal: Math.round((monthlyPandI + monthlyEscrow) * 100) / 100,
      },
    },
    
    costsAtClosing: {
      estimatedClosingCosts: Math.round(totalClosingCosts),
      estimatedCashToClose: Math.round(cashToClose),
    },
    
    closingCostDetails: {
      loanCosts: {
        originationCharges: {
          originationFee: Math.round(originationFee),
          points: Math.round(points),
          applicationFee: Math.round(applicationFee),
          underwritingFee: Math.round(underwritingFee),
          total: Math.round(originationFee + points + applicationFee + underwritingFee),
        },
        servicesYouCannotShopFor: {
          appraisal: Math.round(appraisalFee),
          creditReport: Math.round(creditReportFee),
          floodDetermination: Math.round(floodDeterminationFee),
          taxService: Math.round(taxServiceFee),
          total: Math.round(appraisalFee + creditReportFee + floodDeterminationFee + taxServiceFee),
        },
        servicesYouCanShopFor: {
          titleInsurance: Math.round(titleInsurance),
          titleSearch: Math.round(titleSearch),
          surveyFee: Math.round(surveyFee),
          pestInspection: Math.round(pestInspectionFee),
          total: Math.round(titleInsurance + titleSearch + surveyFee + pestInspectionFee),
        },
        totalLoanCosts: Math.round(loanCostsTotal),
      },
      otherCosts: {
        taxesAndGovernmentFees: {
          recordingFees: Math.round(recordingFees),
          transferTaxes: Math.round(transferTaxes),
          total: Math.round(recordingFees + transferTaxes),
        },
        prepaids: {
          homeownersInsurance: Math.round(prepaidHomeownersInsurance),
          mortgageInsurance: Math.round(prepaidMortgageInsurance),
          prepaidInterest: Math.round(prepaidInterest),
          propertyTaxes: Math.round(prepaidPropertyTaxes),
          total: Math.round(prepaidHomeownersInsurance + prepaidMortgageInsurance + prepaidInterest + prepaidPropertyTaxes),
        },
        initialEscrowPaymentAtClosing: {
          homeownersInsurance: Math.round(escrowHomeownersInsurance),
          mortgageInsurance: Math.round(escrowMortgageInsurance),
          propertyTaxes: Math.round(escrowPropertyTaxes),
          total: Math.round(escrowHomeownersInsurance + escrowMortgageInsurance + escrowPropertyTaxes),
        },
        otherItems: {
          ownersTitleInsurance: Math.round(ownersTitleInsurance),
          total: Math.round(ownersTitleInsurance),
        },
        totalOtherCosts: Math.round(otherCostsTotal),
      },
      totalClosingCosts: Math.round(totalClosingCosts),
    },
    
    cashToClose: {
      totalClosingCosts: Math.round(totalClosingCosts),
      closingCostsPaidBeforeClosing: 0,
      downPayment: Math.round(downPayment),
      deposit: 0,
      fundsFromBorrower: Math.round(downPayment + totalClosingCosts),
      sellerCredits: 0,
      adjustmentsAndOtherCredits: Math.round(lenderCredits),
      cashToClose: Math.round(cashToClose),
    },
    
    appraisedPropertyValue: purchasePrice,
    estimatedPropertyTaxes: Math.round(annualPropertyTax),
    homeownersInsurance: Math.round(annualHomeownersInsurance),
    
    comparisons: {
      inFiveYears: {
        totalYouWillHavePaid: Math.round(totalPaidIn5Years),
        principalPaidOff: Math.round(principalPaidOff),
      },
      apr: Math.round(apr * 1000) / 1000,
      totalInterestPercentage: Math.round(totalInterestPercentage * 10) / 10,
    },
    
    lenderCredits: Math.round(lenderCredits),
    
    tridCompliance: {
      disclosureProvided: !!leIssuedDate,
      dateProvided: leIssuedDate,
      withinThreeBusinessDays: evaluateTridDeliveryWindow(complianceCheckDate, endOfDueDay),
      applicationDate: tridTriggeredAt,
      leDueDate,
    },
    feeScheduleVersion,
  };
}

export function formatLoanEstimateForDisplay(le: LoanEstimateData) {
  return {
    ...le,
    loanTerms: {
      ...le.loanTerms,
      loanAmountFormatted: `$${le.loanTerms.loanAmount.toLocaleString()}`,
      interestRateFormatted: `${le.loanTerms.interestRate}%`,
      monthlyPIFormatted: `$${le.loanTerms.monthlyPrincipalAndInterest.toLocaleString()}`,
    },
    costsAtClosing: {
      ...le.costsAtClosing,
      estimatedClosingCostsFormatted: `$${le.costsAtClosing.estimatedClosingCosts.toLocaleString()}`,
      estimatedCashToCloseFormatted: `$${le.costsAtClosing.estimatedCashToClose.toLocaleString()}`,
    },
  };
}
