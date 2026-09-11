import crypto from "crypto";
import { lookupResolver, type LookupQuery } from "./services/lookupResolver";
import {
  RESIDUAL_TAX_RATE,
  VA_CUSHION_MULTIPLIER,
  VA_DTI_CUSHION_TRIGGER,
  VA_EXTRA_MEMBER_FAMILY_CAP,
  VA_RESIDUAL_REDUCTION_FACTOR,
  VA_UTILITY_RATE_PER_SQFT,
} from "./services/underwritingNuance";

/**
 * Classifies why an underwriting evaluation could not complete, so the caller
 * can turn a thrown error into the *right* outcome instead of masking every
 * failure as "needs more info":
 *
 *  - INPUT_INCOMPLETE : a required input was not supplied (e.g. VA family size).
 *                       Genuinely resolvable by collecting more information.
 *  - INPUT_INVALID    : an input was supplied but is not usable (non-positive
 *                       valuation/income, unrecognized state). A data problem.
 *  - POLICY_OUT_OF_BAND : the borrower's coordinates fell outside the automated
 *                       pricing/eligibility matrices (e.g. sub-floor FICO,
 *                       uncovered family size). NOT a gap in the borrower's
 *                       file — it is a decision the automated path cannot make,
 *                       so it must route to a human, never loop for documents.
 *  - POLICY_UNSUPPORTED : the requested product family has no complete policy
 *                       implementation in this engine. Route to a human before
 *                       applying a different program's rules.
 *
 * `publicMessage` is a borrower-safe explanation; `message` keeps the internal
 * audit detail. Missing/expired *policy scalar* matrices are a system
 * misconfiguration, not an underwriting condition — those still throw a plain
 * Error so they surface as a real 500 rather than a borrower-facing outcome.
 */
export type UnderwritingErrorKind =
  | "INPUT_INCOMPLETE"
  | "INPUT_INVALID"
  | "POLICY_OUT_OF_BAND"
  | "POLICY_UNSUPPORTED";

export class UnderwritingError extends Error {
  constructor(
    public readonly kind: UnderwritingErrorKind,
    /** Internal, audit-grade detail. */
    message: string,
    /** Borrower-safe explanation surfaced by the orchestrator. */
    public readonly publicMessage: string,
  ) {
    super(message);
    this.name = "UnderwritingError";
  }
}

/**
 * The policy thresholds and matrix cells the engine actually resolved for a
 * given evaluation. Snapshotting these makes a decision reproducible: the
 * lookup matrices are mutable in Postgres, so re-running later can resolve
 * different values — but the recorded ResolvedPolicy shows exactly which
 * numbers produced the original decision. `fingerprint` is a short hash over
 * these values for quick equality checks / grouping across snapshots.
 */
export interface ResolvedPolicy {
  loanType: "CONVENTIONAL" | "VA";
  conventionalDtiCapPct?: number;
  conventionalStretchDtiPct?: number;
  conventionalLtvCapPct?: number;
  conventionalFicoFloor?: number;
  conformingLoanLimit?: number;
  conventionalOccupancyMaxLtvPct?: number;
  haircutStockInvestment: number;
  haircutRetirement: number;
  pmiRatePct?: number;
  llpaRatePct?: number;
  vaRequiredResidualIncome?: number;
  vaResidualExtraMember?: number;
  vaResidualTaxRate?: number;
  vaUtilityRatePerSqft?: number;
  vaDtiCushionTriggerPct?: number;
  vaCushionMultiplier?: number;
  vaResidualReductionFactor?: number;
  fingerprint: string;
}

export interface AssetProfile {
  type: "CHECKING_SAVINGS" | "STOCK_INVESTMENT" | "RETIREMENT_IRA_401K";
  balance: number;
}

/**
 * Product family the caller is asking this engine to evaluate. Keeping this
 * explicit prevents borrower eligibility (for example, veteran status) from
 * silently selecting a different mortgage program than the application or
 * rate-sheet offer requested.
 */
export type UnderwritingLoanProgram =
  | "CONVENTIONAL"
  | "FHA"
  | "VA"
  | "USDA"
  | "JUMBO"
  | "ARM"
  | "HELOC"
  | "OTHER";

/**
 * Normalizes the free-text occupancy string written across the app
 * (primary_residence / primary, second_home / secondary, investment /
 * investment_property, …) to the matrix's dim3 identifier plus a human label.
 * Unknown/absent values fall back to owner-occupied primary — the least
 * restrictive, pre-existing default.
 */
function normalizeOccupancy(occupancyType: string | null | undefined): {
  code: "PRIMARY" | "SECOND" | "INVESTMENT";
  label: string;
} {
  const t = (occupancyType ?? "").toLowerCase();
  if (/(^|[^a-z])(invest|investor|rental|non[-_ ]?owner)/.test(t)) {
    return { code: "INVESTMENT", label: "investment" };
  }
  if (/(second|secondary|vacation)/.test(t)) {
    return { code: "SECOND", label: "second home" };
  }
  return { code: "PRIMARY", label: "primary residence" };
}

/**
 * The unit-count range implied by a property type, or null when the type does
 * not constrain units (unknown / "other"). single_family, condo, townhouse and
 * manufactured are one-unit dwellings; multi_family is 2-4 units for
 * conforming residential.
 */
function impliedUnitRange(propertyType: string | null | undefined): { min: number; max: number } | null {
  const t = (propertyType ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(single_family|singlefamily|sfr|condo|condominium|townhouse|townhome|manufactured|pud)$/.test(t)) {
    return { min: 1, max: 1 };
  }
  if (/(multi_family|multifamily|duplex|triplex|fourplex|2_4_unit)/.test(t)) {
    return { min: 2, max: 4 };
  }
  return null;
}

/**
 * Reconciles the subject property's declared type/units against (a) their own
 * internal consistency and (b) an externally OBSERVED type/units when supplied.
 * Returns human-readable mismatch reasons; an empty array means no discrepancy.
 * Pure and side-effect free so it can be unit-tested in isolation.
 *
 * NOTE: the internal check only catches contradictory DECLARATIONS (e.g.
 * "single_family" filed with 4 units). Catching a CONSISTENT misstatement
 * (declared single_family / 1 unit that is really a 4-unit) requires the
 * observed descriptor — which depends on capturing the address/AVM lookup at
 * intake (not yet wired), hence the optional observed inputs.
 */
export function reconcileSubjectProperty(input: {
  propertyType?: string;
  numberOfUnits?: number;
  observedPropertyType?: string;
  observedNumberOfUnits?: number;
}): string[] {
  const reasons: string[] = [];
  const declaredUnits =
    input.numberOfUnits && input.numberOfUnits >= 1 ? Math.floor(input.numberOfUnits) : undefined;

  // (a) Internal: does the declared type's implied unit range contain the
  // declared unit count?
  const declaredRange = impliedUnitRange(input.propertyType);
  if (declaredRange && declaredUnits !== undefined) {
    if (declaredUnits < declaredRange.min || declaredUnits > declaredRange.max) {
      reasons.push(
        `Declared property type "${input.propertyType}" is inconsistent with the declared unit count of ${declaredUnits} — verify the subject property`,
      );
    }
  }

  // (b) Observed vs declared: flag a type family or unit-count divergence.
  const observedRange = impliedUnitRange(input.observedPropertyType);
  if (declaredRange && observedRange && declaredRange.max !== observedRange.max) {
    reasons.push(
      `Declared property type "${input.propertyType}" conflicts with the looked-up property type "${input.observedPropertyType}" — verify the subject property`,
    );
  }
  const observedUnits =
    input.observedNumberOfUnits && input.observedNumberOfUnits >= 1
      ? Math.floor(input.observedNumberOfUnits)
      : undefined;
  if (declaredUnits !== undefined && observedUnits !== undefined && declaredUnits !== observedUnits) {
    reasons.push(
      `Declared unit count of ${declaredUnits} conflicts with the looked-up unit count of ${observedUnits} — verify the subject property`,
    );
  }

  return reasons;
}

export interface UnderwritingInput {
  /** The application or offer's actual product family; never inferred from borrower traits. */
  requestedLoanProgram: UnderwritingLoanProgram;
  isVeteran: boolean;
  isActiveDuty?: boolean;
  hasExchangeAccess?: boolean; // Commissary eligibility discount
  baseMonthlyIncome: number;
  bonusMonthlyIncome: number;
  existingMonthlyDebts: number;
  originalLoanAmount: number;
  contractSalesPrice: number;
  appraisalValue: number;
  representativeFico: number;
  proposedPiti: number;
  assets: AssetProfile[];
  homeSquareFootage?: number;
  subjectPropertyState?: string;
  householdFamilySize?: number;
  /**
   * Subject-property occupancy and unit count. Agency max LTV varies sharply by
   * both — an investment 2-4 unit is capped far below an owner-occupied SFR — so
   * omitting them (the prior behavior) let a multi-unit investment file be
   * priced as an owner-occupied single-family. Free-text occupancy is normalized
   * internally; both default conservatively to a 1-unit primary residence when
   * absent, preserving the pre-existing single-family behavior.
   */
  occupancyType?: string;
  numberOfUnits?: number;
  /**
   * Declared subject-property type (single_family / condo / townhouse /
   * multi_family / manufactured). Used to reconcile against the declared unit
   * count — a "single_family" filed with 4 units is a contradiction worth a
   * human look.
   */
  propertyType?: string;
  /**
   * Loan purpose — `purchase`, `refinance` (rate/term, i.e. limited cash-out),
   * `cash_out` / `cash_out_refinance`. The funnel collects this (it is driven by
   * the `?type=` entry point), and Fannie's maximum LTV/CLTV/HCLTV ratios differ
   * by purpose: B2-1.3-02 and B2-1.3-03 both route the numbers to the
   * **Eligibility Matrix**, a companion document this repo does not hold.
   *
   * This engine prices the PURCHASE grid. Rather than silently apply a purchase
   * ceiling to a cash-out file — which would approve loans well above the
   * cash-out limit — a non-purchase file is routed to human review. Omitted
   * defaults to purchase, preserving prior behavior for the files that are
   * genuinely purchases.
   */
  loanPurpose?: string;
  /**
   * Amortization type — `fixed` or `adjustable`. The URLA Section 4a form offers
   * "Adjustable Rate (ARM)" and `loan_applications.amortization_type` stores it,
   * so a borrower can declare an ARM today.
   *
   * B3-6-04 does NOT qualify an ARM at the note rate: an initial fixed period of
   * five years qualifies at the greater of (note rate + first rate-change cap) or
   * the fully indexed rate, and three years or less at the maximum rate that
   * could apply during the first five years. `derivePricing` prices a 30-year
   * fixed regardless, so an ARM would be qualified at its teaser rate —
   * understating the payment and the DTI.
   *
   * The eight `arm_*` columns that would let us compute the correct rate
   * (index, margin, initial/periodic/lifetime caps, adjustment frequency) exist
   * on the table and are read by `mismoValidation` at delivery — but nothing
   * writes them. So the qualifying rate is not merely unimplemented, it is
   * uncomputable from captured data. Route to a human rather than qualify at the
   * teaser rate.
   */
  amortizationType?: string;
  /**
   * Significant derogatory credit events declared on URLA Section 5, across ALL
   * borrowers — bankruptcy, foreclosure, deed-in-lieu, preforeclosure/short
   * sale — plus outstanding judgments and delinquency on federal debt.
   *
   * B3-5.3-07 sets a WAITING PERIOD after each, measured from the discharge,
   * dismissal or completion date: 4 years for Chapter 7/11, 2 years from
   * discharge (4 from dismissal) for Chapter 13, 5 years for multiple filings
   * within 7 years, 7 years for foreclosure, 4 years for a deed-in-lieu,
   * preforeclosure sale or charge-off.
   *
   * `borrower_declarations` stores these as BOOLEANS with no dates, so the
   * waiting period is uncomputable from captured data — the same shape as the
   * ARM terms above. A declared event therefore routes to a human rather than
   * being ignored, which is what happened before: the entire declarations table
   * (33 columns) reached document generation and MISMO scoring and never the
   * decision path, so a borrower could declare a foreclosure and be decisioned
   * as though they had not.
   */
  declaredDerogatoryEvents?: string[];
  /**
   * Property type and unit count as OBSERVED by an external source (e.g. the
   * address/AVM lookup), when available. Reconciled against the declared values
   * to surface a possible misrepresentation. Optional and additive: when absent,
   * only the internal declared-vs-declared consistency check runs.
   */
  observedPropertyType?: string;
  observedNumberOfUnits?: number;
}

export interface UnderwritingResult {
  decision: "APPROVED" | "REJECTED" | "MANUAL_REVIEW";
  loanType: "CONVENTIONAL" | "VA";
  calculatedLtv: number;
  lookupLtv: number; // Rounded LTV used for pricing lookups
  calculatedDti: number;
  resolvedPmiMonthlyPremium: number;
  resolvedLlpafUpfrontFee: number;
  calculatedLiquidAssets: number;
  actualResidualIncome?: number;
  requiredResidualIncome?: number;
  rejectionReasons: string[];
  /** The resolved thresholds/matrix cells this decision used (reproducibility). */
  resolvedPolicy: ResolvedPolicy;
  /**
   * Reasons the file routed to MANUAL_REVIEW rather than a clean APPROVED —
   * jumbo routing, a subject-property mismatch, etc. Distinct from
   * rejectionReasons: these are "a human must look," not "declined."
   */
  reviewReasons: string[];
}

/**
 * ConsolidatedUnderwritingEngine
 *
 * Deterministic, rules-based decision engine. It is intentionally isolated from
 * any external/AI decisioning path (Fair Lending / Reg B). Every threshold,
 * grid value, and residual requirement is resolved at runtime from the dynamic
 * lookup matrices in Postgres via LookupResolverService — there are no
 * hardcoded fallbacks.
 */
export class ConsolidatedUnderwritingEngine {
  // Use the process-wide shared resolver so a lifecycle mutation invalidated via
  // LookupResolverService.invalidate() also clears the cache this engine reads.
  private resolver = lookupResolver;

  public async evaluate(input: UnderwritingInput): Promise<UnderwritingResult> {
    const reasons: string[] = [];
    // MANUAL_REVIEW explanations (jumbo routing, subject-property mismatch) —
    // kept separate from `reasons`, which drive a REJECTED decision.
    const reviewReasons: string[] = [];
    let conventionalPricingEligible = true;
    const targetLoanType = input.requestedLoanProgram;

    // Only these two policy families are currently encoded end to end. FHA,
    // USDA and portfolio products have materially different eligibility,
    // insurance/guarantee and AUS requirements. Applying the conventional
    // matrices to one of those products is a false approval, so reject the
    // automated path before resolving any unrelated policy row.
    if (targetLoanType !== "CONVENTIONAL" && targetLoanType !== "VA") {
      throw new UnderwritingError(
        "POLICY_UNSUPPORTED",
        `AUTOMATED POLICY COVERAGE ERROR: ${targetLoanType} is not implemented by the deterministic underwriting engine.`,
        `${targetLoanType} underwriting is not automated yet. A loan officer must review this program using its current governing guidance before eligibility can be determined.`,
      );
    }

    // Selecting VA requires an eligibility signal; veteran status alone never
    // selects VA, and a missing/negative signal cannot be treated as evidence
    // of entitlement. Route the contradiction to a human instead of switching
    // the file to conventional behind the borrower's back.
    if (targetLoanType === "VA" && !input.isVeteran) {
      throw new UnderwritingError(
        "POLICY_OUT_OF_BAND",
        "VA PROGRAM ELIGIBILITY ERROR: The requested program is VA but the application does not indicate veteran or active-duty eligibility.",
        "A loan officer must confirm VA eligibility before this program can be evaluated.",
      );
    }

    // Step 1: Process dynamic values from Postgres lookup tables. Product-
    // specific policy is loaded only for that product. A VA evaluation must
    // remain reproducible and available even if an unrelated conventional row
    // is being changed or repaired.
    let dtiCap: number | undefined;
    let stretchDti: number | undefined;
    let ltvCap: number | undefined;
    if (targetLoanType === "CONVENTIONAL") {
      dtiCap = (await this.resolver.getPolicyScalar("CONVENTIONAL_DTI_CAP")) / 100;
      stretchDti = (await this.resolver.getPolicyScalar("CONVENTIONAL_STRETCH_DTI")) / 100;
      ltvCap = await this.resolver.getPolicyScalar("CONVENTIONAL_LTV_CAP");
    }
    const haircutStock = (await this.resolver.getPolicyScalar("HAIRCUT_STOCK_INVESTMENT")) / 100;
    const haircutRetirement = (await this.resolver.getPolicyScalar("HAIRCUT_RETIREMENT")) / 100;

    // Step 2: Calculate Loan-to-Value (LTV)
    const propertyBasisValue = Math.min(input.contractSalesPrice, input.appraisalValue);
    if (propertyBasisValue <= 0) {
      throw new UnderwritingError(
        "INPUT_INVALID",
        "CRITICAL VALUE INPUT ERROR: Property valuation basis must be greater than zero.",
        "We need a valid purchase price and property value to evaluate this loan.",
      );
    }
    // A non-positive loan amount (e.g. down payment >= price) would produce a
    // sub-zero LTV that silently clears the ceiling, skips MI, and drives a
    // negative LLPA fee — an "approval" on nonsensical inputs. Reject it.
    if (input.originalLoanAmount <= 0) {
      throw new UnderwritingError(
        "INPUT_INVALID",
        "CRITICAL VALUE INPUT ERROR: Loan amount must be greater than zero.",
        "Down payment must be less than the purchase price.",
      );
    }
    const rawLtvFraction = (input.originalLoanAmount / propertyBasisValue) * 100;

    // ELIGIBILITY basis: the true ratio, rounded to 4 decimals only to shed
    // floating-point noise. Eligibility ceilings must compare against the real
    // LTV — flooring first let a loan sized into the truncation window (e.g. a
    // true 95.0099% reading as 95.00%) clear a 95% cap it actually exceeds.
    const preciseLtv = Math.round(rawLtvFraction * 10000) / 10000;

    // REPORTING/PRICING basis: truncated to 2 decimals (display, PMI band
    // lookups) — unchanged so quoted figures stay consistent with rate cards.
    const calculatedLtv = Math.floor(rawLtvFraction * 100) / 100;

    // Round up to the nearest whole percentage point for matrix lookups
    const lookupLtv = Math.ceil(calculatedLtv);

    // Step 3: Enforce the conventional maximum LTV ceiling. The scalar is
    // CONVENTIONAL_LTV_CAP by definition — VA loans are guaranteed to 100% LTV
    // ($0 down), so the cap must not reject the VA path.
    if (targetLoanType === "CONVENTIONAL" && preciseLtv > ltvCap!) {
      reasons.push(`Calculated LTV of ${preciseLtv.toFixed(2)}% exceeds policy ceiling of ${ltvCap}%`);
      conventionalPricingEligible = false;
    }

    // Step 4: Process and aggregate assets using haircuts to determine verified reserves
    let calculatedLiquidAssets = 0;
    for (const asset of input.assets) {
      if (asset.type === "CHECKING_SAVINGS") {
        calculatedLiquidAssets += asset.balance;
      } else if (asset.type === "STOCK_INVESTMENT") {
        calculatedLiquidAssets += asset.balance * haircutStock;
      } else if (asset.type === "RETIREMENT_IRA_401K") {
        calculatedLiquidAssets += asset.balance * haircutRetirement;
      }
    }

    // Step 5: Process standard Debt-to-Income (DTI)
    const combinedGrossMonthlyIncome = input.baseMonthlyIncome + input.bonusMonthlyIncome;
    if (combinedGrossMonthlyIncome <= 0) {
      throw new UnderwritingError(
        "INPUT_INVALID",
        "CRITICAL INCOME INPUT ERROR: Consolidated gross qualifying income must be greater than zero.",
        "We need verifiable qualifying income to evaluate this loan.",
      );
    }
    const combinedMonthlyLiabilities = input.existingMonthlyDebts + input.proposedPiti;
    const calculatedDti = (combinedMonthlyLiabilities / combinedGrossMonthlyIncome) * 100;

    let resolvedPmiMonthlyPremium = 0;
    let resolvedLlpafUpfrontFee = 0;

    // Captured for the reproducibility snapshot (ResolvedPolicy).
    let resolvedPmiRatePct: number | undefined;
    let resolvedLlpaRatePct: number | undefined;
    let resolvedConventionalFicoFloor: number | undefined;
    let resolvedConformingLoanLimit: number | undefined;
    let resolvedConventionalOccupancyMaxLtvPct: number | undefined;
    let resolvedVaExtraMember: number | undefined;

    let actualResidualIncome: number | undefined;
    let requiredResidualIncome: number | undefined;

    // Standard Conforming Loan Path
    if (targetLoanType === "CONVENTIONAL") {
      // Eligibility floor: a credit score below the conventional minimum is a
      // decline, not a pricing gap. Enforce it BEFORE any matrix lookup — the
      // PMI grid's lowest band starts at the floor, so an ineligible score would
      // otherwise miss a cell and surface as a generic out-of-band review
      // instead of a specific, adverse-action-grade credit rejection.
      const conventionalFicoFloor = await this.resolver.getPolicyScalar("CONVENTIONAL_FICO_FLOOR");
      resolvedConventionalFicoFloor = conventionalFicoFloor;
      if (input.representativeFico < conventionalFicoFloor) {
        reasons.push(
          `Representative credit score of ${input.representativeFico} is below the conventional minimum of ${conventionalFicoFloor}`,
        );
        conventionalPricingEligible = false;
      }

      // Conforming loan-limit awareness: this engine prices the conforming
      // product, so a loan above the limit cannot be decisioned as conforming.
      // Route it to jumbo review (not a decline) instead of silently approving
      // it on the conforming grids.
      const conformingLimit = await this.resolver.getPolicyScalar("CONFORMING_LOAN_LIMIT");
      resolvedConformingLoanLimit = conformingLimit;
      if (input.originalLoanAmount > conformingLimit) {
        reviewReasons.push(
          `Loan amount of $${Math.round(input.originalLoanAmount).toLocaleString()} exceeds the conforming limit of $${Math.round(conformingLimit).toLocaleString()} — jumbo product review required`,
        );
        conventionalPricingEligible = false;
      }

      // B2-1.3-02 / B2-1.3-03: the maximum LTV, CLTV and HCLTV ratios for a
      // limited cash-out or cash-out refinance are NOT the purchase ratios —
      // both topics defer the figures to the Eligibility Matrix, which this
      // repo does not hold (the Selling Guide defers to it 39 times). The
      // CONVENTIONAL_MAX_LTV matrix here is keyed on units x occupancy only,
      // with no purpose dimension, so a cash-out file would be measured against
      // a purchase ceiling — approving loans above the cash-out limit.
      //
      // Route it to a human instead. This tightens a gate rather than inventing
      // a ratio we cannot source, which is the only direction a reading is
      // allowed to move without the authority in hand.
      const purpose = (input.loanPurpose ?? "purchase").toLowerCase().trim();
      if (purpose !== "purchase" && purpose !== "") {
        reviewReasons.push(
          `Loan purpose "${purpose}" is not a purchase — refinance LTV ceilings come from the Fannie Mae Eligibility Matrix (B2-1.3-02 / B2-1.3-03), which this system does not yet encode. Manual review required.`,
        );
        conventionalPricingEligible = false;
      }

      // B3-6-04, Qualifying Payment Requirements: the qualifying rate is the note
      // rate for FIXED-RATE mortgages only. An ARM qualifies at the greater of
      // the note rate plus its first rate-change cap or the fully indexed rate
      // (five-year initial period), or at the maximum rate reachable in the
      // first five years (three years or less). We price a 30-year fixed, and
      // the arm_* terms needed to compute the real figure are never captured —
      // so the honest move is a human, not a teaser-rate approval.
      const amortization = (input.amortizationType ?? "fixed").toLowerCase().trim();
      if (amortization === "adjustable" || amortization === "arm") {
        reviewReasons.push(
          `Adjustable-rate loan: B3-6-04 requires qualifying at the greater of the note rate plus the first rate-change cap or the fully indexed rate, not the initial rate. The ARM terms needed to compute that (index, margin, caps) are not captured, so this file cannot be qualified automatically. Manual review required.`,
        );
        conventionalPricingEligible = false;
      }

      // B3-5.3-07, Significant Derogatory Credit Events. Every one of these
      // carries a waiting period measured from a date this system does not
      // capture, so none of them can be cleared automatically — and being
      // unable to clear an event is not a reason to ignore it.
      if (input.declaredDerogatoryEvents && input.declaredDerogatoryEvents.length > 0) {
        reviewReasons.push(
          `Declared on the application: ${input.declaredDerogatoryEvents.join("; ")}. B3-5.3-07 sets a waiting period for each, measured from the discharge, dismissal or completion date — dates this system does not capture, so eligibility cannot be determined automatically. Manual review required.`,
        );
      }

      // Subject-property reconciliation: a declared property type that conflicts
      // with the declared unit count (or with a looked-up descriptor, when
      // available) is a potential misrepresentation — route to human review.
      const subjectPropertyReasons = reconcileSubjectProperty({
          propertyType: input.propertyType,
          numberOfUnits: input.numberOfUnits,
          observedPropertyType: input.observedPropertyType,
          observedNumberOfUnits: input.observedNumberOfUnits,
        });
      reviewReasons.push(...subjectPropertyReasons);
      if (subjectPropertyReasons.length > 0) conventionalPricingEligible = false;

      // Occupancy/units LTV eligibility (Fannie Eligibility Matrix). The agency
      // max LTV depends on both occupancy and unit count — an investment 2-4
      // unit is capped far below an owner-occupied SFR — so enforce the specific
      // cap here. Absent data defaults to a 1-unit primary residence, matching
      // the prior single-family behavior. An unseeded combination (e.g. a 2-unit
      // second home, or 5+ units) is out of band -> human review.
      const occupancy = normalizeOccupancy(input.occupancyType);
      const units = input.numberOfUnits && input.numberOfUnits >= 1 ? Math.floor(input.numberOfUnits) : 1;
      const occupancyMaxLtv = await this.resolveOrOutOfBand(
        { matrixCode: "CONVENTIONAL_MAX_LTV", dim1Value: units, dim3Identifier: occupancy.code },
        "occupancy/units LTV eligibility",
      );
      resolvedConventionalOccupancyMaxLtvPct = occupancyMaxLtv;
      if (preciseLtv > occupancyMaxLtv) {
        reasons.push(
          `Calculated LTV of ${preciseLtv.toFixed(2)}% exceeds the ${occupancyMaxLtv}% maximum for a ${units}-unit ${occupancy.label} property`,
        );
        conventionalPricingEligible = false;
      }

      const stretchDtiPct = stretchDti! * 100;
      if (calculatedDti > stretchDtiPct) {
        reasons.push(
          `Debt-to-Income ratio (${calculatedDti.toFixed(2)}%) exceeds the system's hard stretch ceiling of ${stretchDtiPct.toFixed(0)}%`,
        );
      }

      // Price whenever the loan's product/FICO/LTV coordinates are priceable.
      // DTI can reject an otherwise priceable file and does not change its PMI
      // or LLPA. The prior `reasons.length === 0` gate removed PMI from exactly
      // those rejected payment scenarios. Coordinate failures still skip the
      // matrices because no valid pricing cell exists for them.
      if (conventionalPricingEligible) {
        // Query standard Monthly BPMI rate matrix if LTV > 80%
        if (calculatedLtv > 80.0) {
          const pmiRate = await this.resolveOrOutOfBand(
            {
              matrixCode: "CONVENTIONAL_PMI",
              dim1Value: input.representativeFico,
              dim2Value: calculatedLtv,
            },
            "mortgage-insurance pricing",
          );
          resolvedPmiRatePct = pmiRate;
          resolvedPmiMonthlyPremium = (input.originalLoanAmount * (pmiRate / 100)) / 12;
        }

        // Query dynamic Fannie Mae LLPA Matrix
        const llpaAdjustmentRate = await this.resolveOrOutOfBand(
          {
            matrixCode: "FANNIE_LLPA",
            dim1Value: input.representativeFico,
            dim2Value: lookupLtv,
          },
          "risk-based pricing",
        );
        resolvedLlpaRatePct = llpaAdjustmentRate;
        resolvedLlpafUpfrontFee = input.originalLoanAmount * (llpaAdjustmentRate / 100);
      }

      // VA Veteran Loan Path. The implemented automation is a purchase/fixed
      // residual-income screen. VA refinance and ARM eligibility/payment rules
      // are materially different and are not encoded here, so keep the useful
      // residual analysis but route the overall result to a loan officer.
    } else {
      const purpose = (input.loanPurpose ?? "purchase").toLowerCase().trim();
      if (purpose !== "purchase" && purpose !== "") {
        reviewReasons.push(
          `VA loan purpose "${purpose}" is outside the automated purchase screen. VA refinance eligibility and fee rules require program-specific review.`,
        );
      }
      const amortization = (input.amortizationType ?? "fixed").toLowerCase().trim();
      if (amortization === "adjustable" || amortization === "arm") {
        reviewReasons.push(
          "VA adjustable-rate qualification is not automated because the index, margin, and rate caps needed to calculate the qualifying payment are not captured. Manual review required.",
        );
      }
      if (!input.subjectPropertyState || !input.householdFamilySize || !input.homeSquareFootage) {
        throw new UnderwritingError(
          "INPUT_INCOMPLETE",
          "CRITICAL VA PROTOCOL ERROR: Properties state, family size, and home square footage are required for military residual evaluations.",
          "To evaluate a VA loan we need the subject property state, household size, and home square footage.",
        );
      }

      // Map subject property state to VA regional zone
      const vaRegion = this.resolveVaRegion(input.subjectPropertyState);

      // VA Square-Foot Utility Rule. The rate is the SHARED constant, not a
      // local literal — a forked 0.14 here survived the 2026-07-04 de-forking
      // pass because the guard banned only the literals it already knew about
      // (0.18 tax, 0.95 reduction). tests/vaResidualEngineParity.test.ts pins
      // agreement with the cited reference by result, not by banned spellings.
      const estimatedUtilityCosts = input.homeSquareFootage * VA_UTILITY_RATE_PER_SQFT;

      // Deduct estimated taxes, shelter costs, and utilities to isolate residual take-home pay.
      // Platform estimation model shared with the cited reference module (26-7 Ch. 4 Items 32–34
      // prescribe IRS/state tax-table estimates on documented income; a single fixed rate stands
      // in until real income documents flow) — never fork this number from underwritingNuance.
      const estimatedTaxesWithholding = combinedGrossMonthlyIncome * RESIDUAL_TAX_RATE;

      actualResidualIncome =
        combinedGrossMonthlyIncome -
        estimatedTaxesWithholding -
        input.proposedPiti -
        input.existingMonthlyDebts -
        estimatedUtilityCosts;

      // Select dynamic minimum residual threshold matching regional guidelines.
      // The VA_RESIDUAL table (Pamphlet 26-7 Table 4-2) is defined for family
      // sizes 1-5; larger families use the size-5 baseline plus a per-member
      // addition — resolve at the clamp and add the extra below, instead of
      // crashing off the end of the matrix.
      const familySize = Math.max(1, Math.round(input.householdFamilySize));
      requiredResidualIncome = await this.resolveOrOutOfBand(
        {
          matrixCode: "VA_RESIDUAL",
          dim1Value: Math.min(familySize, 5),
          dim2Value: input.originalLoanAmount,
          dim3Identifier: vaRegion,
        },
        "VA residual-income requirement",
      );
      if (familySize > 5) {
        // The per-member addition applies only "up to a family of seven" — the
        // eighth person and beyond are not considered (26-7 Ch. 4, Topic 9, Item 43).
        const countableMembers = Math.min(familySize, VA_EXTRA_MEMBER_FAMILY_CAP);
        const extraPerMember = await this.resolver.getPolicyScalar("VA_RESIDUAL_EXTRA_MEMBER");
        resolvedVaExtraMember = extraPerMember;
        requiredResidualIncome += (countableMembers - 5) * extraPerMember;
      }

      // "Reducing the Residual Income Figures" (26-7 Ch. 4, Topic 9, Item 43): reduce the
      // table figure by 5% if the borrower is an active-duty OR retired serviceperson, OR
      // there is a clear indication of continued military-facility benefits near the
      // property. The conditions are DISJUNCTIVE per the handbook (a prior && gate
      // under-applied the reduction); the retired-serviceperson / facility-benefits signal
      // routes through hasExchangeAccess until intake carries a dedicated field.
      if (input.isActiveDuty || input.hasExchangeAccess) {
        requiredResidualIncome = requiredResidualIncome * VA_RESIDUAL_REDUCTION_FACTOR;
      }

      // Implement the 20% Cushion Rule for High DTI profiles. Both the trigger
      // and the multiplier are the shared constants; VA_DTI_CUSHION_TRIGGER is
      // a FRACTION (0.41) while calculatedDti here is a PERCENTAGE, hence the
      // ×100 — the unit mismatch is exactly why this one was left as a literal,
      // and why it must be stated once rather than remembered. 0.41 × 100 === 41
      // exactly in IEEE 754, so the conversion cannot move the boundary; the
      // exactly-41.00%-DTI scenario in vaResidualEngineParity.test.ts pins it.
      const cushionTriggerPct = VA_DTI_CUSHION_TRIGGER * 100;
      if (calculatedDti > cushionTriggerPct) {
        const highDtiTarget = requiredResidualIncome * VA_CUSHION_MULTIPLIER;
        if (actualResidualIncome < highDtiTarget) {
          reasons.push(
            `High DTI (${calculatedDti.toFixed(2)}% > ${cushionTriggerPct.toFixed(2)}%) requires residual income buffer of $${highDtiTarget.toFixed(2)}. Current residual is $${actualResidualIncome.toFixed(2)}`,
          );
        }
      } else {
        if (actualResidualIncome < requiredResidualIncome) {
          reasons.push(
            `Actual residual income of $${actualResidualIncome.toFixed(2)} falls below the standard regional requirement of $${requiredResidualIncome.toFixed(2)}`,
          );
        }
      }
    }

    // Evaluate standard pre-approval metrics
    let decision: "APPROVED" | "REJECTED" | "MANUAL_REVIEW" = "APPROVED";

    if (reasons.length > 0) {
      decision = "REJECTED";
    } else if (reviewReasons.length > 0) {
      // Jumbo routing or a subject-property mismatch: a human must look, but it
      // is not a decline.
      decision = "MANUAL_REVIEW";
    } else if (targetLoanType === "CONVENTIONAL" && calculatedDti > dtiCap! * 100) {
      // DTI between baseline (43%) and stretch (50%) moves to Manual Review
      decision = "MANUAL_REVIEW";
    }

    const resolvedPolicy = buildResolvedPolicy({
      loanType: targetLoanType,
      conventionalDtiCapPct: dtiCap === undefined ? undefined : dtiCap * 100,
      conventionalStretchDtiPct: stretchDti === undefined ? undefined : stretchDti * 100,
      conventionalLtvCapPct: ltvCap,
      conventionalFicoFloor: resolvedConventionalFicoFloor,
      conformingLoanLimit: resolvedConformingLoanLimit,
      conventionalOccupancyMaxLtvPct: resolvedConventionalOccupancyMaxLtvPct,
      haircutStockInvestment: haircutStock,
      haircutRetirement: haircutRetirement,
      pmiRatePct: resolvedPmiRatePct,
      llpaRatePct: resolvedLlpaRatePct,
      vaRequiredResidualIncome: requiredResidualIncome,
      vaResidualExtraMember: resolvedVaExtraMember,
      vaResidualTaxRate: targetLoanType === "VA" ? RESIDUAL_TAX_RATE : undefined,
      vaUtilityRatePerSqft: targetLoanType === "VA" ? VA_UTILITY_RATE_PER_SQFT : undefined,
      vaDtiCushionTriggerPct: targetLoanType === "VA" ? VA_DTI_CUSHION_TRIGGER * 100 : undefined,
      vaCushionMultiplier: targetLoanType === "VA" ? VA_CUSHION_MULTIPLIER : undefined,
      vaResidualReductionFactor: targetLoanType === "VA" ? VA_RESIDUAL_REDUCTION_FACTOR : undefined,
    });

    return {
      decision,
      loanType: targetLoanType,
      calculatedLtv,
      lookupLtv,
      calculatedDti,
      resolvedPmiMonthlyPremium,
      resolvedLlpafUpfrontFee,
      calculatedLiquidAssets,
      actualResidualIncome,
      requiredResidualIncome,
      rejectionReasons: reasons,
      resolvedPolicy,
      reviewReasons,
    };
  }

  /**
   * Evaluates state code parameters and returns official regional groups.
   */
  private resolveVaRegion(state: string): "NORTHEAST" | "MIDWEST" | "SOUTH" | "WEST" {
    const st = state.toUpperCase().trim();

    const regions = {
      NORTHEAST: ["CT", "MA", "ME", "NH", "NJ", "NY", "PA", "RI", "VT"],
      MIDWEST: ["IL", "IN", "IA", "KS", "MI", "MN", "MO", "NE", "ND", "OH", "SD", "WI"],
      SOUTH: ["AL", "AR", "DE", "DC", "FL", "GA", "KY", "LA", "MD", "MS", "NC", "OK", "PR", "SC", "TN", "TX", "VA", "WV"],
      WEST: ["AK", "AZ", "CA", "CO", "HI", "ID", "MT", "NV", "NM", "OR", "UT", "WA", "WY"],
    };

    if (regions.NORTHEAST.includes(st)) return "NORTHEAST";
    if (regions.MIDWEST.includes(st)) return "MIDWEST";
    if (regions.SOUTH.includes(st)) return "SOUTH";
    if (regions.WEST.includes(st)) return "WEST";

    throw new UnderwritingError(
      "INPUT_INVALID",
      `CRITICAL COMPLIANCE ERROR: Received unrecognized state parameter [${state}]. Unable to resolve geographic region mapping.`,
      "We could not recognize the subject property state. Please provide a valid two-letter state code.",
    );
  }

  /**
   * Resolves a borrower-coordinate matrix value, converting a "no cell matches"
   * miss into a POLICY_OUT_OF_BAND {@link UnderwritingError}. A missing/expired
   * *matrix* (system misconfiguration) is re-thrown unchanged so it surfaces as
   * a real error, not an underwriting outcome.
   */
  private async resolveOrOutOfBand(query: LookupQuery, priceable: string): Promise<number> {
    try {
      return await this.resolver.resolveMatrixValue(query);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The resolver distinguishes a coordinate miss ("...fell outside permitted
      // compliance intervals...") from a missing matrix. Only the former is an
      // out-of-band borrower profile; the latter is an infrastructure fault.
      if (message.includes("fell outside permitted compliance intervals")) {
        throw new UnderwritingError(
          "POLICY_OUT_OF_BAND",
          message,
          "This loan profile is outside our automated pricing coverage and needs a manual review by your loan team.",
        );
      }
      throw err;
    }
  }
}

/**
 * Build a ResolvedPolicy and stamp it with a deterministic fingerprint over the
 * threshold values (undefined fields omitted, numbers rounded to 4 dp so
 * floating-point noise doesn't change the hash).
 */
function buildResolvedPolicy(p: Omit<ResolvedPolicy, "fingerprint">): ResolvedPolicy {
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  const canonical: Record<string, unknown> = { loanType: p.loanType };
  for (const [k, v] of Object.entries(p)) {
    if (k === "loanType") continue;
    if (typeof v === "number" && Number.isFinite(v)) canonical[k] = round(v);
  }
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
  return { ...p, fingerprint };
}

export const consolidatedUnderwritingEngine = new ConsolidatedUnderwritingEngine();
