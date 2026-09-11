import { eq, desc } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import {
  incomePathEvaluations,
  scenarioRuns,
  type LoanApplication,
  type IncomePathEvaluation,
} from "@shared/schema";
import {
  computeOffers,
  type BorrowerPricingProfile,
  type ComputedOffer,
} from "./pricingAdapter";
import {
  consolidatedUnderwritingEngine,
  UnderwritingError,
  type UnderwritingInput,
  type UnderwritingLoanProgram,
  type UnderwritingResult,
  type AssetProfile,
} from "../underwritingEngine";
import { calculateLLPA } from "../pricing";
import { calculateMortgageAPR } from "./apr";
import { computeClosingCosts } from "./loanCosts";
import { offerUpfrontMI } from "./mortgageInsurance";
import { activeFeeSchedule } from "./platformFeeSchedule";
import { resolveCompensation, type CompensationModel } from "@shared/compliance/loCompensation";
import { classifyAsset, sumOpenMonthlyLiabilities } from "./decisionEngine";
import {
  deriveAntiSteeringOptions,
  pointsAndFeesDollars,
  type AntiSteeringOptionSet,
} from "./antiSteeringOptions";

// =============================================================================
// LO-2 — Deterministic What-If Scenario Simulator (LO Advisor Program).
//
// Composes engines that already exist, in charter order:
//   pricingAdapter.computeOffers → underwritingEngine qualification → apr.ts
//   → cash-to-close from the shared loanCosts model (the LE fee schedule).
//
// Income is read from the UAL orchestrator's LATEST PERSISTED evaluation
// (income_path_evaluations) — never re-derived here. No income row → the
// simulator reports NEEDS_INCOME_EVALUATION and stops.
//
// Two layers, mirroring the income orchestrator:
//   - composeScenario(facts, evaluate): deterministic composition over
//     pre-loaded facts, with the engine evaluator injectable so unit tests
//     pin byte-identical determinism without Postgres;
//   - runScenario(app, loUserId, scenario): the IO loader — reads the
//     application, persisted income, URLA debts/assets, offers, and active
//     rate-sheet versions; persists every evaluated run to the immutable
//     scenario_runs audit substrate (LO-3/LO-5 hang off those rows).
//
// I1: no model output anywhere. I4: derived financials only — no SSN/account
// numbers in inputs or outputs. I6: the FICO what-if is hypothetical and
// never triggers a pull. I10: rate sheets are simulated until the PPE
// contract, so every run and response carries simulated=true.
// =============================================================================

/**
 * I10 provenance: the rate-sheet catalog is a deterministic simulation until
 * the PPE contract (Lender Price + Mortech) lands. Flip when the PPE adapter
 * replaces the simulated sheets — the flag rides every run row and response.
 */
const SIMULATED_RATE_DATA = true;

/** Identifies the shared fee-schedule model recorded on each run. */
const FEE_MODEL_VERSION = "loanCosts-v1";

/** Prepaid-interest day count for scenarios — the advertised-fee model's
 * documented 15-day assumption (services/apr.ts), keeping runs deterministic
 * (the LE derives days from its dated closing estimate instead). */
const SCENARIO_PREPAID_INTEREST_DAYS = 15;

/** Defensive cap on evaluated offers (catalog is ~a dozen products today). */
const MAX_EVALUATED_OFFERS = 40;

export interface ScenarioRequest {
  purchasePrice: number;
  /** Exactly one of amount/percent (route-validated). */
  downPaymentAmount?: number;
  downPaymentPercent?: number;
  /** Filter to catalog product types (CONVENTIONAL / FHA / VA / JUMBO / ARM). */
  productTypes?: string[];
  occupancyType?: "primary_residence" | "second_home" | "investment";
  propertyType?: "single_family" | "condo" | "townhouse" | "multi_family";
  /** 2–4, only meaningful for multi_family. */
  numberOfUnits?: number;
  /** Hypothetical only — never triggers a credit pull (I6). */
  ficoWhatIf?: number;
  lockTermDays?: number;
  /** Subject-property overrides, typically from the address-first prefill. */
  propertyState?: string;
  /** AVM/appraisal value when the scenario targets a specific property. */
  propertyValue?: number;
  annualPropertyTaxes?: number;
  annualHomeownersInsurance?: number;
  /** Address context recorded for the audit trail (no PII beyond an address). */
  addressContext?: {
    line?: string;
    city?: string;
    stateCode?: string;
    zipcode?: string;
    propertyId?: string;
    source?: string;
    observedPropertyType?: string;
  };
}

/** Scenario after defaults are resolved — what gets persisted as `inputs`. */
export interface NormalizedScenario {
  purchasePrice: number;
  downPayment: number;
  downPaymentPercent: number;
  productTypes: string[] | null;
  occupancyType: "primary_residence" | "second_home" | "investment";
  propertyType: "single_family" | "condo" | "townhouse" | "multi_family";
  numberOfUnits: number | null;
  fico: number;
  ficoIsWhatIf: boolean;
  lockTermDays: number;
  propertyState: string | null;
  propertyValue: number;
  annualPropertyTaxes: number | null;
  annualHomeownersInsurance: number | null;
  addressContext: ScenarioRequest["addressContext"] | null;
}

export interface OfferQualification {
  decision: "APPROVED" | "REJECTED" | "MANUAL_REVIEW";
  dti: number | null;
  ltv: number | null;
  reasons: string[];
  /** ResolvedPolicy fingerprint (reproducibility); null for out-of-band routes. */
  policyFingerprint: string | null;
}

export interface EvaluatedOffer {
  lenderId: string;
  lenderName: string;
  productId: string;
  productCode: string;
  productName: string;
  productType: string;
  loanTerm: number;
  lockTerm: number;
  baseRate: number;
  adjustedRate: number;
  pricingBreakdown: ComputedOffer["pricingBreakdown"];
  payment: {
    principalAndInterest: number;
    mortgageInsurance: number;
    escrow: number;
    totalPiti: number;
  };
  apr: number;
  costs: {
    totalClosingCosts: number;
    cashToClose: number;
    lenderCredits: number;
    pointsAndFeesDollars: number;
  };
  qualification: OfferQualification;
}

export type ScenarioStatus =
  | "OK"
  | "NO_ELIGIBLE_PRODUCTS"
  | "NEEDS_MORE_INFO"
  | "NEEDS_INCOME_EVALUATION";

export interface ScenarioResult {
  status: ScenarioStatus;
  simulated: boolean;
  scenario: NormalizedScenario | null;
  missingItems: string[];
  income: {
    evaluationId: string;
    primaryMonthlyQualifyingIncome: number;
    incomeBasis: string;
    recommendedPathId: string | null;
    requiresManualReview: boolean;
    evaluationFingerprint: string;
    evaluatedAt: string;
  } | null;
  monthlyDebts: number | null;
  offers: EvaluatedOffer[];
  /** Products excluded before pricing, with the platform rule that excludes them. */
  excludedProducts: string[];
  antiSteering: AntiSteeringOptionSet | null;
  engineVersions: {
    incomePathEvaluationId: string;
    incomeEvaluationFingerprint: string;
    policyFingerprints: string[];
    feeModel: string;
  } | null;
  rateSheetVersions: RateSheetVersionRef[];
}

export interface RateSheetVersionRef {
  sheetId: string;
  lenderId: string;
  version: string;
  effectiveDate: string;
}

/** Everything the deterministic composition needs, pre-loaded by the IO layer. */
export interface ScenarioFacts {
  application: {
    id: string;
    isVeteran: boolean;
    creditScore: number | null;
    propertyState: string | null;
    isFirstTimeBuyer: boolean;
    householdFamilySize: number | null;
    homeSquareFootage: number | null;
    /** Reg Z 1026.36(d)(2) election — drives the borrower-paid origination fee. */
    loCompensationModel: CompensationModel | null;
    loCompensationBps: number | null;
  };
  scenario: ScenarioRequest;
  urlaOccupancyType: string | null;
  urlaNumberOfUnits: number | null;
  /**
   * Subject-property association/co-op dues, monthly — Selling Guide B3-6-03
   * counts them inside the qualifying PITIA. Pre-loaded like the other URLA
   * property facts so a what-if qualifies on the same housing expense the real
   * decision does. Without it the simulator quoted a condo borrower a PITI
   * (and a DTI) lower than their actual decision, which is the divergence this
   * module's own MI comments exist to prevent.
   */
  urlaMonthlyAssociationDues: number | null;
  income: {
    evaluationId: string;
    primaryMonthlyQualifyingIncome: number;
    incomeBasis: string;
    recommendedPathId: string | null;
    requiresManualReview: boolean;
    evaluationFingerprint: string;
    evaluatedAt: string;
  };
  monthlyDebts: number;
  assets: AssetProfile[];
  /** Priced from THIS scenario's profile — what-if FICO and the scenario's
   * loan amount / purchase price (see runScenario's BorrowerPricingProfile).
   * composeScenario consumes each offer's product-aware estimatedMonthlyMI as
   * the what-if MI, so application-level offers would mis-price it. */
  offers: ComputedOffer[];
  excludedProducts: string[];
  fthbLenderCredits: number;
  rateSheetVersions: RateSheetVersionRef[];
}

export type EngineEvaluator = (input: UnderwritingInput) => Promise<UnderwritingResult>;

const cents = (n: number) => Math.round(n * 100) / 100;

/** Resolve scenario defaults against the application (pure). */
export function normalizeScenario(
  facts: Pick<ScenarioFacts, "application" | "scenario" | "urlaOccupancyType" | "urlaNumberOfUnits">,
): { scenario: NormalizedScenario | null; missingItems: string[] } {
  const { application: app, scenario: raw } = facts;
  const missing: string[] = [];

  const purchasePrice = raw.purchasePrice;
  if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) missing.push("Purchase price");

  let downPayment: number | null = null;
  if (raw.downPaymentAmount !== undefined) {
    downPayment = cents(raw.downPaymentAmount);
  } else if (raw.downPaymentPercent !== undefined) {
    downPayment = cents((purchasePrice * raw.downPaymentPercent) / 100);
  }
  if (downPayment === null || downPayment < 0) missing.push("Down payment");
  if (downPayment !== null && purchasePrice > 0 && downPayment >= purchasePrice) {
    missing.push("Down payment must be less than the purchase price");
  }

  const fico = raw.ficoWhatIf ?? app.creditScore ?? null;
  if (fico === null) missing.push("Credit score (none on file — set a hypothetical FICO)");

  // §1026.36(d)(2): cash-to-close is not defined until the compensation model
  // is elected — under a lender-paid plan the borrower pays no origination
  // fee. Name the gap the way the other gaps are named rather than quoting a
  // fee the borrower may not lawfully be charged.
  if (!resolveCompensation(app.loCompensationModel, app.loCompensationBps)) {
    missing.push(
      "Loan originator compensation (elect lender-paid or borrower-paid, with the plan's bps, before pricing)",
    );
  }

  const propertyState = raw.propertyState ?? app.propertyState ?? null;
  const normalizedProductTypes = raw.productTypes?.length ? [...raw.productTypes].sort() : null;
  const evaluatesVa = app.isVeteran && (
    normalizedProductTypes === null
    || normalizedProductTypes.some((type) => underwritingProgramForProduct(type) === "VA")
  );
  if (evaluatesVa) {
    // VA residual evaluation needs all three — name the gaps like the
    // instant decision does instead of letting the engine throw.
    if (!propertyState) missing.push("Property state (required for VA residual income)");
    if (!app.householdFamilySize) missing.push("Household size (required for VA residual income)");
    if (!app.homeSquareFootage) missing.push("Home square footage (required for VA residual income)");
  }

  if (missing.length > 0) return { scenario: null, missingItems: missing };

  const occupancyType =
    raw.occupancyType ??
    (normalizeUrlaOccupancy(facts.urlaOccupancyType) ?? "primary_residence");
  const propertyType = raw.propertyType ?? "single_family";
  const numberOfUnits =
    propertyType === "multi_family"
      ? raw.numberOfUnits ?? facts.urlaNumberOfUnits ?? null
      : null;

  return {
    scenario: {
      purchasePrice: cents(purchasePrice),
      downPayment: downPayment!,
      downPaymentPercent: cents((downPayment! / purchasePrice) * 100),
      productTypes: normalizedProductTypes,
      occupancyType,
      propertyType,
      numberOfUnits,
      fico: fico!,
      ficoIsWhatIf: raw.ficoWhatIf !== undefined,
      lockTermDays: raw.lockTermDays ?? 30,
      propertyState,
      propertyValue: cents(raw.propertyValue ?? purchasePrice),
      annualPropertyTaxes: raw.annualPropertyTaxes !== undefined ? cents(raw.annualPropertyTaxes) : null,
      annualHomeownersInsurance:
        raw.annualHomeownersInsurance !== undefined ? cents(raw.annualHomeownersInsurance) : null,
      addressContext: raw.addressContext ?? null,
    },
    missingItems: [],
  };
}

/** Map URLA free-text occupancy to the scenario's enum (or null). */
function normalizeUrlaOccupancy(
  occupancy: string | null,
): "primary_residence" | "second_home" | "investment" | null {
  const t = (occupancy ?? "").toLowerCase();
  if (!t) return null;
  if (/invest|rental|non[-_ ]?owner/.test(t)) return "investment";
  if (/second|vacation/.test(t)) return "second_home";
  return "primary_residence";
}

/** Convert a rate-sheet family into the explicit program axis the engine audits. */
export function underwritingProgramForProduct(
  productType: string,
  amortizationType?: string | null,
): UnderwritingLoanProgram {
  const amortization = (amortizationType ?? "").trim().toUpperCase();
  if (amortization.includes("ARM") || amortization.includes("ADJUSTABLE")) return "ARM";
  if (amortization.includes("INTEREST_ONLY")) return "OTHER";
  const normalized = productType.trim().toUpperCase();
  switch (normalized) {
    case "CONV":
    case "CONFORMING":
    case "CONVENTIONAL": return "CONVENTIONAL";
    case "FHA": return "FHA";
    case "VA": return "VA";
    case "USDA": return "USDA";
    case "JUMBO": return "JUMBO";
    case "ARM": return "ARM";
    case "HELOC": return "HELOC";
    default: return "OTHER";
  }
}

/**
 * Resolve the product filter without collapsing an explicitly requested but
 * ineligible set into "all products". Exported so the VA-only/non-veteran
 * boundary is pinned without database fixtures.
 */
export function resolveEligibleProductFilter(
  requestedProductTypes: string[] | null,
  isVeteran: boolean,
): { productTypes: string[] | undefined; excludedProducts: string[]; explicitFilterEmpty: boolean } {
  if (isVeteran) {
    return {
      productTypes: requestedProductTypes ?? undefined,
      excludedProducts: [],
      explicitFilterEmpty: requestedProductTypes !== null && requestedProductTypes.length === 0,
    };
  }
  if (requestedProductTypes === null) {
    return {
      productTypes: undefined,
      excludedProducts: ["VA (borrower is not a veteran)"],
      explicitFilterEmpty: false,
    };
  }
  const requestedVa = requestedProductTypes.some((type) => underwritingProgramForProduct(type) === "VA");
  const productTypes = requestedProductTypes.filter((type) => underwritingProgramForProduct(type) !== "VA");
  return {
    productTypes,
    excludedProducts: requestedVa ? ["VA (borrower is not a veteran)"] : [],
    explicitFilterEmpty: productTypes.length === 0,
  };
}

/**
 * Deterministic composition over pre-loaded facts. Same facts (and a
 * deterministic evaluator) → byte-identical result.
 */
export async function composeScenario(
  facts: ScenarioFacts,
  evaluate: EngineEvaluator = (input) => consolidatedUnderwritingEngine.evaluate(input),
): Promise<ScenarioResult> {
  const { scenario, missingItems } = normalizeScenario(facts);
  if (!scenario) {
    return {
      status: "NEEDS_MORE_INFO",
      simulated: SIMULATED_RATE_DATA,
      scenario: null,
      missingItems,
      income: facts.income,
      monthlyDebts: facts.monthlyDebts,
      offers: [],
      excludedProducts: facts.excludedProducts,
      antiSteering: null,
      engineVersions: null,
      rateSheetVersions: facts.rateSheetVersions,
    };
  }

  if (facts.offers.length === 0) {
    return {
      status: "NO_ELIGIBLE_PRODUCTS",
      simulated: SIMULATED_RATE_DATA,
      scenario,
      missingItems: [],
      income: facts.income,
      monthlyDebts: facts.monthlyDebts,
      offers: [],
      excludedProducts: facts.excludedProducts,
      antiSteering: deriveAntiSteeringOptions([]),
      engineVersions: {
        incomePathEvaluationId: facts.income.evaluationId,
        incomeEvaluationFingerprint: facts.income.evaluationFingerprint,
        policyFingerprints: [],
        feeModel: FEE_MODEL_VERSION,
      },
      rateSheetVersions: facts.rateSheetVersions,
    };
  }

  const app = facts.application;
  const loanAmount = cents(scenario.purchasePrice - scenario.downPayment);
  // Non-null past normalizeScenario, which lists a missing election as a gap.
  const compensation = resolveCompensation(app.loCompensationModel, app.loCompensationBps)!;

  const offers = facts.offers.slice(0, MAX_EVALUATED_OFFERS);
  const evaluated: EvaluatedOffer[] = [];
  // Qualification depends on both PITI and program. Caching only by payment
  // caused a conventional and FHA/VA offer with the same rounded PITI to share
  // one policy result even though their eligibility rules are different.
  const qualCache = new Map<string, OfferQualification>();
  const policyFingerprints = new Set<string>();

  for (const offer of offers) {
    // MI is the offer's own product-aware figure (the F-077 follow-up):
    // computeOffers priced this scenario's profile through the
    // CONVENTIONAL_PMI matrix — loud failure on a missing band — with FHA MIP
    // at all LTVs and zero on VA/HELOC (services/mortgageInsurance.ts), so a
    // what-if's PITI/DTI now prices the same matrix the instant decision and
    // the LE price, and matches the offer card's own estimatedMonthlyTotal.
    // (The banded loanCosts card that sat here exceeded the matrix in every
    // live cell and was deleted with this migration.) VA treatment follows the
    // offer's product family; veteran status never changes another offer into
    // VA paper.
    const isVaPriced = offer.productType.toUpperCase() === "VA";
    const monthlyPMI = isVaPriced ? 0 : offer.estimatedMonthlyMI;
    const isFhaPriced = !isVaPriced && offer.productType.toUpperCase() === "FHA";
    // FHA up-front MIP rides the scenario's cash-to-close exactly as it rides
    // the LE's prepaids (two surfaces, one schedule); VA-priced files carry
    // none, matching the monthly-MI posture above.
    const upfrontMI = isVaPriced
      ? 0
      : offerUpfrontMI({ productType: offer.productType, loanAmount });

    const costs = computeClosingCosts({
      // Same published schedule the Loan Estimate prices from, so a scenario's
      // cash-to-close still matches the LE for equal inputs.
      feeSchedule: await activeFeeSchedule(),
      purchasePrice: scenario.purchasePrice,
      downPayment: scenario.downPayment,
      loanAmount,
      interestRate: offer.adjustedRate,
      monthlyPMI,
      upfrontMortgageInsurance: upfrontMI,
      prepaidInterestDays: SCENARIO_PREPAID_INTEREST_DAYS,
      compensation,
      annualPropertyTaxes: scenario.annualPropertyTaxes ?? undefined,
      annualHomeownersInsurance: scenario.annualHomeownersInsurance ?? undefined,
      lenderCredits: facts.fthbLenderCredits,
    });

    // B3-6-03: association/co-op dues belong in the qualifying housing expense.
    // This is the same figure the instant decision now qualifies on, so a
    // what-if and a decision cannot disagree about a condo borrower's PITI.
    const associationDues = facts.urlaMonthlyAssociationDues ?? 0;
    const piti = cents(offer.estimatedMonthlyPI + monthlyPMI + costs.monthlyEscrow + associationDues);

    const requestedLoanProgram = underwritingProgramForProduct(
      offer.productType,
      offer.amortizationType,
    );
    const cacheKey = `${requestedLoanProgram}:${Math.round(piti * 100)}`;
    let qualification = qualCache.get(cacheKey);
    if (!qualification) {
      qualification = await qualifyAtPiti(
        { app, scenario, loanAmount, piti, facts, requestedLoanProgram },
        evaluate,
      );
      qualCache.set(cacheKey, qualification);
    }
    if (qualification.policyFingerprint) policyFingerprints.add(qualification.policyFingerprint);

    const apr = calculateMortgageAPR({
      loanAmount,
      noteRatePct: offer.adjustedRate,
      termMonths: offer.loanTerm,
      monthlyMI: monthlyPMI,
      // FHA MIP is life-of-loan — no 78% HPA auto-termination in the APR
      // stream, the same treatment the LE and the advertised model apply
      // (services/apr.ts advertisedAPR). Conventional keeps the termination.
      propertyValue: isFhaPriced ? 0 : scenario.purchasePrice,
      prepaidFinanceCharges: costs.prepaidFinanceCharges,
    });

    evaluated.push({
      lenderId: offer.lenderId,
      lenderName: offer.lenderName,
      productId: offer.productId,
      productCode: offer.productCode,
      productName: offer.productName,
      productType: offer.productType,
      loanTerm: offer.loanTerm,
      lockTerm: offer.lockTerm,
      baseRate: offer.baseRate,
      adjustedRate: offer.adjustedRate,
      pricingBreakdown: offer.pricingBreakdown,
      payment: {
        principalAndInterest: cents(offer.estimatedMonthlyPI),
        mortgageInsurance: cents(monthlyPMI),
        escrow: cents(costs.monthlyEscrow),
        totalPiti: piti,
      },
      apr,
      costs: {
        totalClosingCosts: cents(costs.totalClosingCosts),
        cashToClose: cents(costs.cashToClose),
        lenderCredits: cents(costs.lenderCredits),
        pointsAndFeesDollars: cents(pointsAndFeesDollars(offer)),
      },
      qualification,
    });
  }

  // An INPUT_INCOMPLETE/INVALID engine throw depends only on scenario-level
  // facts, so qualifyAtPiti surfaces it as a scenario-wide gap.
  const inputGap = evaluated.find((o) => o.qualification.reasons.some((r) => r.startsWith("__INPUT_GAP__")));
  if (inputGap) {
    const items = inputGap.qualification.reasons
      .filter((r) => r.startsWith("__INPUT_GAP__"))
      .map((r) => r.replace("__INPUT_GAP__", ""));
    return {
      status: "NEEDS_MORE_INFO",
      simulated: SIMULATED_RATE_DATA,
      scenario,
      missingItems: items,
      income: facts.income,
      monthlyDebts: facts.monthlyDebts,
      offers: [],
      excludedProducts: facts.excludedProducts,
      antiSteering: null,
      engineVersions: null,
      rateSheetVersions: facts.rateSheetVersions,
    };
  }

  const antiSteering = deriveAntiSteeringOptions(offers);

  return {
    status: "OK",
    simulated: SIMULATED_RATE_DATA,
    scenario,
    missingItems: [],
    income: facts.income,
    monthlyDebts: facts.monthlyDebts,
    offers: evaluated,
    excludedProducts: facts.excludedProducts,
    antiSteering,
    engineVersions: {
      incomePathEvaluationId: facts.income.evaluationId,
      incomeEvaluationFingerprint: facts.income.evaluationFingerprint,
      policyFingerprints: [...policyFingerprints].sort(),
      feeModel: FEE_MODEL_VERSION,
    },
    rateSheetVersions: facts.rateSheetVersions,
  };
}

async function qualifyAtPiti(
  ctx: {
    app: ScenarioFacts["application"];
    scenario: NormalizedScenario;
    loanAmount: number;
    piti: number;
    facts: ScenarioFacts;
    requestedLoanProgram: UnderwritingLoanProgram;
  },
  evaluate: EngineEvaluator,
): Promise<OfferQualification> {
  const { app, scenario, loanAmount, piti, facts, requestedLoanProgram } = ctx;
  const input: UnderwritingInput = {
    requestedLoanProgram,
    isVeteran: app.isVeteran,
    baseMonthlyIncome: facts.income.primaryMonthlyQualifyingIncome,
    bonusMonthlyIncome: 0,
    existingMonthlyDebts: facts.monthlyDebts,
    originalLoanAmount: loanAmount,
    contractSalesPrice: scenario.purchasePrice,
    appraisalValue: scenario.propertyValue,
    representativeFico: scenario.fico,
    proposedPiti: piti,
    assets: facts.assets,
    subjectPropertyState: scenario.propertyState ?? undefined,
    occupancyType: scenario.occupancyType,
    numberOfUnits: scenario.numberOfUnits ?? undefined,
    propertyType: scenario.propertyType,
    observedPropertyType: scenario.addressContext?.observedPropertyType,
    loanPurpose: "purchase",
    householdFamilySize: app.householdFamilySize ?? undefined,
    homeSquareFootage: app.homeSquareFootage ?? undefined,
  };

  try {
    const result = await evaluate(input);
    return {
      decision: result.decision,
      dti: Math.round(result.calculatedDti * 100) / 100,
      ltv: result.calculatedLtv,
      reasons: [...result.rejectionReasons, ...result.reviewReasons],
      policyFingerprint: result.resolvedPolicy.fingerprint,
    };
  } catch (err) {
    if (err instanceof UnderwritingError) {
      if (err.kind === "POLICY_OUT_OF_BAND" || err.kind === "POLICY_UNSUPPORTED") {
        // A profile outside the automated matrices is a decision for a human,
        // not a documentation gap (same routing as the instant decision).
        return {
          decision: "MANUAL_REVIEW",
          dti: null,
          ltv: null,
          reasons: [err.publicMessage],
          policyFingerprint: null,
        };
      }
      // INPUT_INCOMPLETE / INPUT_INVALID — scenario-level gap; marker is
      // unwrapped by composeScenario into a NEEDS_MORE_INFO result.
      return {
        decision: "MANUAL_REVIEW",
        dti: null,
        ltv: null,
        reasons: [`__INPUT_GAP__${err.publicMessage}`],
        policyFingerprint: null,
      };
    }
    throw err;
  }
}

/** Latest persisted multi-path income evaluation for an application. */
export async function getLatestIncomePathEvaluation(
  applicationId: string,
): Promise<IncomePathEvaluation | null> {
  const [row] = await db
    .select()
    .from(incomePathEvaluations)
    .where(eq(incomePathEvaluations.applicationId, applicationId))
    .orderBy(desc(incomePathEvaluations.createdAt))
    .limit(1);
  return row ?? null;
}

export interface ScenarioRunOutcome {
  runId: string | null;
  result: ScenarioResult;
}

/**
 * IO layer: load the application's facts, compose the scenario, and persist
 * the run. `NEEDS_INCOME_EVALUATION` cannot persist (the run row requires the
 * income-evaluation link) and returns unrecorded.
 */
export async function runScenario(
  application: LoanApplication,
  loUserId: string,
  request: ScenarioRequest,
): Promise<ScenarioRunOutcome> {
  const incomeRow = await getLatestIncomePathEvaluation(application.id);
  if (!incomeRow) {
    return {
      runId: null,
      result: {
        status: "NEEDS_INCOME_EVALUATION",
        simulated: SIMULATED_RATE_DATA,
        scenario: null,
        missingItems: [
          "No persisted income evaluation — run the instant decision (or update income) so the orchestrator records one. The simulator never re-derives income.",
        ],
        income: null,
        monthlyDebts: null,
        offers: [],
        excludedProducts: [],
        antiSteering: null,
        engineVersions: null,
        rateSheetVersions: [],
      },
    };
  }

  const [liabilities, urlaAssets, propertyInfo, activeSheets] = await Promise.all([
    storage.getUrlaLiabilities(application.id),
    storage.getUrlaAssets(application.id),
    storage.getUrlaPropertyInfo(application.id),
    storage.getActiveRateSheets(),
  ]);

  const monthlyDebts = sumOpenMonthlyLiabilities(liabilities, application.monthlyDebts);
  const assets: AssetProfile[] = urlaAssets
    .map((a) => ({ type: classifyAsset(a.accountType), balance: Number(a.cashOrMarketValue) || 0 }))
    .filter((a) => a.balance > 0);

  const appFacts: ScenarioFacts["application"] = {
    id: application.id,
    isVeteran: application.isVeteran ?? false,
    creditScore: application.creditScore ?? null,
    propertyState: application.propertyState ?? null,
    isFirstTimeBuyer: application.isFirstTimeBuyer ?? false,
    householdFamilySize: application.householdFamilySize ?? null,
    homeSquareFootage: application.homeSquareFootage ?? null,
    loCompensationModel: application.loCompensationModel ?? null,
    loCompensationBps: application.loCompensationBps ?? null,
  };

  // normalizeScenario takes the narrow Pick<> — occupancy and unit count only.
  // Association dues are a PITIA input, not a normalization input, so they stay
  // on the full ScenarioFacts below.
  const { scenario } = normalizeScenario({
    application: appFacts,
    scenario: request,
    urlaOccupancyType: propertyInfo?.occupancyType ?? null,
    urlaNumberOfUnits: propertyInfo?.numberOfUnits ?? null,
  });

  // Price only when the scenario normalized cleanly; composeScenario reports
  // the gaps otherwise.
  let offers: ComputedOffer[] = [];
  const excludedProducts: string[] = [];
  let fthbLenderCredits = 0;
  if (scenario) {
    const loanAmount = scenario.purchasePrice - scenario.downPayment;

    // VA products require a positive veteran/active-duty eligibility signal.
    // Product choice remains explicit; the signal only controls whether a VA
    // offer may be shown and evaluated.
    const eligibleFilter = resolveEligibleProductFilter(scenario.productTypes, appFacts.isVeteran);
    const productTypes = eligibleFilter.productTypes;
    excludedProducts.push(...eligibleFilter.excludedProducts);

    // Preserve the distinction between "no filter" and "the explicit filter
    // became empty after eligibility checks". Passing [] as undefined caused a
    // non-veteran who requested VA-only to receive every unrelated product.
    if (!eligibleFilter.explicitFilterEmpty) {
      const profile: BorrowerPricingProfile = {
        creditScore: scenario.fico,
        loanAmount,
        propertyValue: scenario.purchasePrice,
        propertyType: scenario.propertyType,
        occupancyType: scenario.occupancyType,
        loanPurpose: "purchase",
        isFirstTimeHomeBuyer: appFacts.isFirstTimeBuyer,
        lockTermDays: scenario.lockTermDays,
        productTypes,
      };
      offers = await computeOffers(storage, profile);
      if (!appFacts.isVeteran) {
        offers = offers.filter((o) => o.productType.toUpperCase() !== "VA");
      }
    }

    // FTHB LLPA waiver → lender credit, mirroring generateLoanEstimate.
    const ltv = (loanAmount / scenario.purchasePrice) * 100;
    const llpa = await calculateLLPA(
      loanAmount,
      scenario.fico,
      ltv,
      scenario.propertyType,
      scenario.occupancyType,
      appFacts.isFirstTimeBuyer,
    );
    fthbLenderCredits = llpa.fthbWaiver > 0 ? (llpa.fthbWaiver * loanAmount) / 100 : 0;
  }

  const rateSheetVersions: RateSheetVersionRef[] = activeSheets
    .map((s) => ({
      sheetId: s.sheetId,
      lenderId: s.lenderId,
      version: s.version,
      effectiveDate: String(s.effectiveDate),
    }))
    .sort((a, b) => a.sheetId.localeCompare(b.sheetId));

  const facts: ScenarioFacts = {
    application: appFacts,
    scenario: request,
    urlaOccupancyType: propertyInfo?.occupancyType ?? null,
    urlaMonthlyAssociationDues:
      propertyInfo?.monthlyAssociationDues == null ? null : Number(propertyInfo.monthlyAssociationDues),
    urlaNumberOfUnits: propertyInfo?.numberOfUnits ?? null,
    income: {
      evaluationId: incomeRow.id,
      primaryMonthlyQualifyingIncome: Number(incomeRow.primaryMonthlyQualifyingIncome),
      incomeBasis: incomeRow.incomeBasis,
      recommendedPathId: incomeRow.recommendedPathId ?? null,
      requiresManualReview: incomeRow.requiresManualReview,
      evaluationFingerprint: incomeRow.evaluationFingerprint,
      evaluatedAt: incomeRow.createdAt.toISOString(),
    },
    monthlyDebts,
    assets,
    offers,
    excludedProducts,
    fthbLenderCredits,
    rateSheetVersions,
  };

  const result = await composeScenario(facts);

  // Persist every evaluated run (the audit substrate LO-3/LO-5 build on).
  const [run] = await db
    .insert(scenarioRuns)
    .values({
      applicationId: application.id,
      loUserId,
      incomePathEvaluationId: incomeRow.id,
      inputs: result.scenario ?? { raw: request, missingItems: result.missingItems },
      outputs: {
        status: result.status,
        missingItems: result.missingItems,
        monthlyDebts: result.monthlyDebts,
        income: result.income,
        offers: result.offers,
        excludedProducts: result.excludedProducts,
        antiSteering: result.antiSteering,
      },
      engineVersions:
        result.engineVersions ?? {
          incomePathEvaluationId: incomeRow.id,
          incomeEvaluationFingerprint: incomeRow.evaluationFingerprint,
          policyFingerprints: [],
          feeModel: FEE_MODEL_VERSION,
        },
      rateSheetVersions: result.rateSheetVersions,
      simulated: result.simulated,
    })
    .returning({ id: scenarioRuns.id });

  return { runId: run.id, result };
}
