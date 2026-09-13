import crypto from "crypto";
import type {
  EmploymentHistory,
  OtherIncomeSource,
  RentalPropertyEntry,
  LoanApplication,
  IncomeSourceEntry,
} from "@shared/schema";
import {
  canonicalizePaths,
  roundCents,
  type IncomeOrchestrationResult,
  type IncomePathResult,
  type IncomePathId,
} from "@shared/incomePaths";
import { storage } from "../../storage";
import { calculateSubjectPropertyQualifyingRent } from "../underwritingNuance";
import { estimateMonthlyPITI } from "../preUnderwriting";
import { computeAgencyWageIncome } from "./paths/agencyWage";
import { computeSelfEmploymentPath } from "./paths/selfEmployment";
import {
  computeCapitalGainsPath,
  type CapitalGainsAnalysisInput,
} from "./paths/capitalGains";
import {
  computeEmploymentRelatedAssetsPath,
  type EmploymentRelatedAssetsAnalysisInput,
} from "./paths/employmentRelatedAssets";
import { computeRentalPath, splitRentalOffsets, withSubjectPropertyRent } from "./paths/rental";
import { computeDscrPath } from "./paths/dscr";
import {
  computeBankStatementPath,
  BANK_STATEMENT_PERIODS,
  type BankStatementAnalysisInput,
} from "./paths/bankStatement";
import { loadProfitLossActivity, type CurrentProfitLossSignal, type ProfitLossActivityIssue } from "../profitLossActivity";
import { reoQualificationPicture } from "@shared/realEstateFinancing";

/**
 * Multi-path income orchestrator (UAL P3) — the SINGLE income producer.
 *
 * Two layers, mirroring the underwriting engine:
 *  - a pure core `computeIncomePaths(input)` — deterministic, no IO, unit-
 *    tested directly; runs every applicable path in one pass and ranks them;
 *  - an IO loader `evaluateIncomePaths(applicationId)` that performs the reads
 *    (the same reads decisionEngine.aggregateBorrowerFinancials does).
 *
 * The "primary" DTI income fed to the deterministic engine is the sum of the
 * APPLIED component paths (agency wage + self-employment; rental is surfaced
 * but not auto-applied — see rental.ts). Alternative methods carry their own
 * program authority (P4): DSCR computes the cited Rent-Divided-PITIA ratio
 * over declared rentals (no in-repo qualifying threshold — always review);
 * bank-statement math is cited and has a staff capture surface. Same inputs →
 * same result → same evaluation fingerprint.
 */

export interface IncomePathsCoreInput {
  employment: EmploymentHistory[];
  otherIncome: OtherIncomeSource[];
  rentalProperties: RentalPropertyEntry[];
  fallbackAnnualIncome?: number | string | null;
  expectedNoteDate?: Date | string | null;
  applyVerifiedOtherIncomeAdjustments?: boolean;
  /** Latest captured bank-statement deposit analysis (P5 capture surface). */
  bankStatementAnalysis?: BankStatementAnalysisInput;
  /** Accepted, human-reviewed current business activity. A decline forces
   * review but never increases the tax-return qualifying figure. */
  profitLossActivity?: CurrentProfitLossSignal[];
  profitLossActivityIssues?: ProfitLossActivityIssue[];
  /** Current, human-reviewed Schedule D and portfolio evidence. */
  capitalGainsAnalysis?: CapitalGainsAnalysisInput;
  /** Current, human-reviewed employment-related retirement asset evidence. */
  employmentRelatedAssetsAnalysis?: EmploymentRelatedAssetsAnalysisInput;
  /**
   * Decision-grade provenance gate (shared/dataProvenance isDecisionGrade):
   * POSITIVE rental offsets and subject-property rent apply to qualifying
   * income only when true. Losses apply regardless (ledger
   * platform-rental-preliminary-asymmetry). Defaults false — conservative.
   */
  applyRentalToDti?: boolean;
  /** URLA liabilities contain mortgage-type rows (B3-3.8-01 double-count guard). */
  hasMortgageLiabilityRows?: boolean;
  /** Subject-property facts: B3-3.8-01 2–4-unit owner-occupied rent rule, and
   *  the subject DSCR ratio for an investment purchase (estimatedPitia is the
   *  pre-lock estimate; the ratio always stays manual-review). */
  subjectProperty?: {
    numberOfUnits: number | null;
    occupancyType: string | null;
    estimatedMarketRent: number | string | null;
    estimatedPitia?: number | null;
  } | null;
  /** S-07: the borrower's current primary residence converting to a rental
   *  (currentPropertyDisposition = "converted_to_rental"). Projected market
   *  rent + retained PITIA join the per-property rental offsets, always with
   *  manual review (projected evidence). */
  departingResidence?: {
    estimatedMarketRent: number | string | null;
    monthlyPitia: number | string | null;
  } | null;
}

export function computeIncomePaths(input: IncomePathsCoreInput): IncomeOrchestrationResult {
  const agency = computeAgencyWageIncome({
    employment: input.employment,
    otherIncome: input.otherIncome,
    fallbackAnnualIncome: input.fallbackAnnualIncome,
    expectedNoteDate: input.expectedNoteDate,
    applyVerifiedOtherIncomeAdjustments: input.applyVerifiedOtherIncomeAdjustments,
  });
  const selfEmployment = computeSelfEmploymentPath(
    input.employment,
    input.profitLossActivity,
    input.profitLossActivityIssues,
  );
  const capitalGains = computeCapitalGainsPath(input.otherIncome, input.capitalGainsAnalysis);
  const employmentRelatedAssets = computeEmploymentRelatedAssetsPath(
    input.otherIncome,
    input.employmentRelatedAssetsAnalysis,
  );

  // S-07: the departing residence enters the per-property offset set as one
  // more rental (projected rent − retained PITIA), never the DSCR portfolio.
  const departingEntries: RentalPropertyEntry[] = input.departingResidence
    ? [
        {
          address: "Departing residence (converting to rental)",
          monthlyRentalIncome: String(input.departingResidence.estimatedMarketRent ?? ""),
          monthlyDebtPayment: String(input.departingResidence.monthlyPitia ?? ""),
        } as RentalPropertyEntry,
      ]
    : [];
  const rentalEntries = [...input.rentalProperties, ...departingEntries];
  const rentalPath = computeRentalPath(rentalEntries, {
    applyPositiveToDti: input.applyRentalToDti === true,
    hasMortgageLiabilityRows: input.hasMortgageLiabilityRows === true,
    departingResidenceIncluded: departingEntries.length > 0,
  });

  const hasSelfEmployment = selfEmployment.path.status === "applicable";
  const dscr = computeDscrPath(input.rentalProperties, input.subjectProperty ?? null);
  const bankStatement = computeBankStatementPath(hasSelfEmployment, input.bankStatementAnalysis);

  // Primary DTI income = applied component dti_income paths. Rental applies
  // PER PROPERTY per B3-3.8-01 (ledger fnma-b3-3-8-01-rental-offset-dti):
  // each positive per-property offset joins the income side (provenance-
  // gated); each property's loss is surfaced as a liability for the decision
  // engine to add to monthly obligations — never negative income, and never
  // netted across properties (the split is strictly conservative).
  const agencyApplied = agency.path.monthlyQualifyingIncome;
  const seApplied = selfEmployment.path.monthlyQualifyingIncome;
  const capitalGainsApplied = capitalGains.path.monthlyQualifyingIncome;
  const employmentRelatedAssetsApplied = employmentRelatedAssets.monthlyQualifyingIncome;
  const rentalSplit = splitRentalOffsets(rentalEntries);
  const rentalNet = rentalSplit.count > 0 ? rentalSplit.net : 0;
  const rentalIncomeApplied =
    input.applyRentalToDti === true ? rentalSplit.positiveTotal : 0;
  const rentalLiabilityApplied = rentalSplit.negativeTotal;

  // Subject-property 2–4-unit owner-occupied rent (B3-3.8-01, ledger
  // fnma-b3-3-8-01-subject-rental-income): qualifying rent is ADDED to income;
  // the full subject PITIA stays in the housing expense — never netted here.
  // Same provenance gate as positive rental (platform asymmetry policy).
  const subjectQualifyingRent = calculateSubjectPropertyQualifyingRent(
    input.subjectProperty?.estimatedMarketRent,
    input.subjectProperty?.numberOfUnits,
    input.subjectProperty?.occupancyType,
  );
  const subjectRentalIncomeApplied =
    input.applyRentalToDti === true && subjectQualifyingRent !== null
      ? roundCents(subjectQualifyingRent)
      : 0;

  const primary = roundCents(
    agencyApplied
      + seApplied
      + capitalGainsApplied
      + employmentRelatedAssetsApplied
      + rentalIncomeApplied
      + subjectRentalIncomeApplied,
  );

  // Every path states what it CONTRIBUTED to `primary`, not merely what it is
  // worth. The two differ for rental (per-property B3-3.8-01 splits the
  // portfolio between the income and obligation sides) and for the subject
  // property's unit rent (which had no path to belong to at all). Without this,
  // any surface that itemises the qualifying total renders rows that do not sum
  // to the number above them — which is what the borrower's "how your
  // qualifying income was calculated" card and the LO cockpit both did.
  const paths: IncomePathResult[] = [
    { ...agency.path, appliedMonthlyIncome: agencyApplied, appliedMonthlyObligation: 0 },
    { ...selfEmployment.path, appliedMonthlyIncome: seApplied, appliedMonthlyObligation: 0 },
    { ...capitalGains.path, appliedMonthlyIncome: capitalGainsApplied, appliedMonthlyObligation: 0 },
    { ...employmentRelatedAssets, appliedMonthlyIncome: employmentRelatedAssetsApplied, appliedMonthlyObligation: 0 },
    withSubjectPropertyRent(rentalPath, subjectRentalIncomeApplied),
    // Alternatives are a competing METHOD, never summed into the full-doc
    // total: their contribution is zero by construction.
    { ...bankStatement, appliedMonthlyIncome: 0, appliedMonthlyObligation: 0 },
    dscr,
  ];

  // Recommendation: max qualifying income among the full-doc total and any
  // ENABLED alternative method. All alternatives are gated today, so this is
  // the full-doc total; recommendedPathId stays null until an alternative is
  // both enabled and higher (honest about the current state).
  const enabledAlternatives = paths.filter(
    (p): p is Extract<IncomePathResult, { kind: "dti_income" }> =>
      p.role === "alternative" && p.kind === "dti_income" && p.status === "applicable",
  );
  let recommendedPathId: IncomePathId | null = null;
  let recommendationReason =
    "Standard full-documentation income (wage + self-employment). No alternative program is enabled yet.";
  for (const alt of enabledAlternatives) {
    if (alt.monthlyQualifyingIncome > primary) {
      recommendedPathId = alt.pathId;
      recommendationReason = `Alternative program (${alt.pathId}) yields higher qualifying income than full-doc.`;
    }
  }

  const requiresManualReview =
    agency.path.requiresManualReview
    || selfEmployment.path.requiresManualReview
    || capitalGains.path.requiresManualReview
    || employmentRelatedAssets.requiresManualReview
    || rentalPath.requiresManualReview;

  return {
    paths,
    primaryMonthlyQualifyingIncome: primary,
    primaryBreakdown: {
      agencyBase: agency.baseMonthlyIncome,
      agencyVariable: agency.variableMonthlyIncome,
      selfEmployment: seApplied,
      capitalGains: capitalGainsApplied,
      employmentRelatedAssets: employmentRelatedAssetsApplied,
      rental: roundCents(rentalNet),
      rentalIncomeApplied,
      rentalLiabilityApplied,
      subjectRentalIncomeApplied,
    },
    recommendedPathId,
    recommendationReason,
    requiresManualReview,
    incomeBasis:
      agency.usedLineItems || selfEmployment.path.status === "applicable"
        ? "urla_line_items"
        : "application_summary",
  };
}

/** SHA-256 over the canonical inputs — same inputs, same evaluation. */
export function incomeInputsFingerprint(input: IncomePathsCoreInput): string {
  const canonical = {
    employment: input.employment
      .map((e) => ({
        se: !!e.isSelfEmployed,
        b: numOrNull(e.baseIncome),
        ot: numOrNull(e.overtimeIncome),
        bo: numOrNull(e.bonusIncome),
        c: numOrNull(e.commissionIncome),
        m: numOrNull(e.militaryEntitlements),
        o: numOrNull(e.otherIncome),
        t: numOrNull(e.totalMonthlyIncome),
        crypto: e.paidInVirtualCurrency,
        futureReduction: e.hasKnownFutureIncomeReduction,
        futureMonthly: numOrNull(e.futureMonthlyIncome),
        futureDate: e.futureIncomeEffectiveDate,
        futureReason: e.futureIncomeReason,
        // Self-employment worksheet drives the 1084 figure — hash its content.
        w: e.selfEmploymentIncome ?? null,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    otherIncome: input.otherIncome
      .map((o) => ({
        borrowerSequenceNumber: o.borrowerSequenceNumber ?? 1,
        source: o.incomeSource,
        amount: numOrNull(o.monthlyAmount),
        taxTreatment: o.taxTreatment,
        nonTaxableAmount: numOrNull(o.nonTaxableMonthlyAmount),
        hasDefinedExpiration: o.hasDefinedExpiration,
        expirationDate: o.expirationDate,
        crypto: o.paidInVirtualCurrency,
        linkedAssetAccountLast4: o.linkedAssetAccountLast4,
        assetOwnershipType: o.assetOwnershipType,
        hasUnrestrictedAccess: o.hasUnrestrictedAccess,
        fullDistributionPenaltyAmount: numOrNull(o.fullDistributionPenaltyAmount),
        fundsUsedForTransaction: numOrNull(o.fundsUsedForTransaction),
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    expectedNoteDate: input.expectedNoteDate instanceof Date
      ? input.expectedNoteDate.toISOString().slice(0, 10)
      : input.expectedNoteDate ?? null,
    applyVerifiedOtherIncomeAdjustments: input.applyVerifiedOtherIncomeAdjustments === true,
    rental: input.rentalProperties
      .map((p) => ({ r: numOrNull(p.monthlyRentalIncome), d: numOrNull(p.monthlyDebtPayment) }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    fallback: numOrNull(input.fallbackAnnualIncome ?? null),
    bankStatement: input.bankStatementAnalysis
      ? {
          m: input.bankStatementAnalysis.months,
          d: numOrNull(input.bankStatementAnalysis.totalEligibleDeposits),
          f: numOrNull(input.bankStatementAnalysis.expenseFactor ?? null),
          c: !!input.bankStatementAnalysis.hasThirdPartyExpenseStatement,
        }
      : null,
    profitLossActivity: (input.profitLossActivity ?? [])
      .map(signal => ({
        employmentId: signal.employmentId,
        documentId: signal.documentId,
        periodStart: signal.periodStart,
        periodEnd: signal.periodEnd,
        periodMonths: signal.periodMonths,
        businessNetProfitLoss: signal.businessNetProfitLoss,
        ownershipPercent: signal.ownershipPercent,
        borrowerMonthlyNet: signal.borrowerMonthlyNet,
        taxBasedMonthlyIncome: signal.taxBasedMonthlyIncome,
        direction: signal.direction,
      }))
      .sort((a, b) => a.employmentId.localeCompare(b.employmentId)),
    profitLossActivityIssues: (input.profitLossActivityIssues ?? [])
      .map(issue => ({ employmentId: issue.employmentId, documentId: issue.documentId, message: issue.message }))
      .sort((a, b) => a.employmentId.localeCompare(b.employmentId) || a.documentId.localeCompare(b.documentId)),
    capitalGains: input.capitalGainsAnalysis
      ? {
          borrowerSequenceNumber: input.capitalGainsAnalysis.borrowerSequenceNumber,
          expectedTaxYears: input.capitalGainsAnalysis.expectedTaxYears,
          years: input.capitalGainsAnalysis.years
            .map(year => ({
              taxYear: year.taxYear,
              annualCapitalGainOrLoss: roundCents(year.annualCapitalGainOrLoss),
              form1040DocumentId: year.form1040DocumentId,
              scheduleDDocumentId: year.scheduleDDocumentId,
              verifiedFactId: year.verifiedFactId,
              signatureVerifiedFactId: year.signatureVerifiedFactId,
            }))
            .sort((a, b) => b.taxYear - a.taxYear),
          portfolio: {
            ...input.capitalGainsAnalysis.portfolio,
            currentMarketValue: roundCents(input.capitalGainsAnalysis.portfolio.currentMarketValue),
            verifiedFactIds: [...input.capitalGainsAnalysis.portfolio.verifiedFactIds].sort(),
          },
          missingItems: [...input.capitalGainsAnalysis.missingItems].sort(),
        }
      : null,
    employmentRelatedAssets: input.employmentRelatedAssetsAnalysis
      ? {
          ...input.employmentRelatedAssetsAnalysis,
          ltvPercent: roundCents(input.employmentRelatedAssetsAnalysis.ltvPercent),
          assets: input.employmentRelatedAssetsAnalysis.assets
            .map(asset => ({
              ...asset,
              documentedBalance: roundCents(asset.documentedBalance),
              fullDistributionPenaltyAmount: roundCents(asset.fullDistributionPenaltyAmount),
              fundsUsedForTransaction: roundCents(asset.fundsUsedForTransaction),
              netDocumentedAssets: roundCents(asset.netDocumentedAssets),
              verifiedFactIds: [...asset.verifiedFactIds].sort(),
            }))
            .sort((a, b) => a.assetId.localeCompare(b.assetId)),
          missingItems: [...input.employmentRelatedAssetsAnalysis.missingItems].sort(),
        }
      : null,
    // Rental DTI application context (B3-3.8-01 wiring): the provenance gate,
    // the mortgage-liability coexistence guard, and the subject-property facts
    // all change the applied result, so they are part of the inputs identity.
    rentalApply: input.applyRentalToDti === true,
    mortgageLiabRows: input.hasMortgageLiabilityRows === true,
    subject: input.subjectProperty
      ? {
          u: input.subjectProperty.numberOfUnits ?? null,
          o: input.subjectProperty.occupancyType ?? null,
          r: numOrNull(input.subjectProperty.estimatedMarketRent),
          p: numOrNull(input.subjectProperty.estimatedPitia ?? null),
        }
      : null,
    departing: input.departingResidence
      ? {
          r: numOrNull(input.departingResidence.estimatedMarketRent),
          p: numOrNull(input.departingResidence.monthlyPitia),
        }
      : null,
  };
  return sha256(JSON.stringify(canonical));
}

/** SHA-256 over the canonical path RESULTS — reproducibility of the evaluation. */
export function incomeEvaluationFingerprint(result: IncomeOrchestrationResult): string {
  return sha256(
    JSON.stringify({
      paths: canonicalizePaths(result.paths),
      primary: roundCents(result.primaryMonthlyQualifyingIncome),
      recommended: result.recommendedPathId,
      basis: result.incomeBasis,
    }),
  );
}

export interface EvaluatedIncomePaths {
  result: IncomeOrchestrationResult;
  inputsFingerprint: string;
  evaluationFingerprint: string;
}

/**
 * Latest captured bank-statement deposit analysis for an application (P5
 * capture surface), adapted to the calculator's input shape. Null when none
 * captured or the row fails the program's period constraint.
 */
export async function loadLatestBankStatementAnalysis(
  applicationId: string,
): Promise<BankStatementAnalysisInput | undefined> {
  const row = await storage.getLatestBankStatementAnalysis(applicationId);
  if (!row) return undefined;
  const months = row.months as (typeof BANK_STATEMENT_PERIODS)[number];
  if (!BANK_STATEMENT_PERIODS.includes(months)) return undefined;
  return {
    months,
    totalEligibleDeposits: Number(row.totalEligibleDeposits),
    expenseFactor: row.expenseFactor !== null ? Number(row.expenseFactor) : undefined,
    hasThirdPartyExpenseStatement: row.hasThirdPartyExpenseStatement,
  };
}

/**
 * True when any URLA liability row is mortgage-shaped (mortgage/HELOC/home
 * equity). Used by the B3-3.8-01 double-count guard: an applied rental offset
 * already carries the property's PITIA inside the net, so a coexisting
 * mortgage-type liability row may count the same payment twice.
 */
export function hasMortgageTypeLiability(
  liabilities: Array<{ liabilityType: string | null }>,
): boolean {
  return liabilities.some((l) => /mortgage|heloc|home[\s_-]?equity/i.test(l.liabilityType ?? ""));
}

/**
 * S-07 input gate: only a "converted_to_rental" disposition with parseable
 * figures produces a departing-residence entry. Shared by both IO loaders so
 * the instant decision and the persisted evaluation can never disagree.
 */
export function departingResidenceInput(
  app: Pick<LoanApplication, "currentPropertyDisposition" | "departingResidence">,
): IncomePathsCoreInput["departingResidence"] {
  if (app.currentPropertyDisposition !== "converted_to_rental") return null;
  const dr = app.departingResidence as {
    estimatedMarketRent?: number | string | null;
    monthlyPitia?: number | string | null;
  } | null;
  if (!dr || dr.estimatedMarketRent === undefined || dr.monthlyPitia === undefined) return null;
  return { estimatedMarketRent: dr.estimatedMarketRent, monthlyPitia: dr.monthlyPitia };
}

/** Pre-lock subject PITIA estimate for the DSCR ratio (30-yr at the funnel's
 *  advisory assumptions — the ratio is always manual-review, so an estimate
 *  is honest here; the lender's lock reprices it). Null until price and down
 *  payment are captured. */
export function estimateSubjectPitia(
  purchasePrice: unknown,
  downPayment: unknown,
): number | null {
  const price = numOrNull(purchasePrice);
  const down = numOrNull(downPayment);
  if (price === null || down === null || price <= 0) return null;
  const piti = estimateMonthlyPITI(price, down);
  return piti > 0 ? roundCents(piti) : null;
}

/**
 * IO layer: load an application's income facts and evaluate every path. Reads
 * exactly what the instant-decision path reads, plus rental properties from
 * the application's incomeSources jsonb, the latest captured bank-statement
 * analysis, URLA liabilities (double-count guard), and the subject-property
 * facts (B3-3.8-01 2–4-unit owner-occupied rent).
 */
export async function evaluateIncomePaths(
  app: LoanApplication,
  options: { applyRentalToDti: boolean } = { applyRentalToDti: false },
): Promise<EvaluatedIncomePaths> {
  const [employment, otherIncome, bankStatementAnalysis, liabilities, propertyInfo, realEstateOwned] =
    await Promise.all([
      storage.getEmploymentHistory(app.id),
      storage.getOtherIncomeSources(app.id),
      loadLatestBankStatementAnalysis(app.id),
      storage.getUrlaLiabilities(app.id),
      storage.getUrlaPropertyInfo(app.id),
      storage.getRealEstateOwnedByApplication(app.id),
    ]);
  const intakeRentalProperties = ((app.incomeSources as IncomeSourceEntry[] | null) ?? [])
    .filter((s) => s.type === "rental")
    .flatMap((s) => s.rentalProperties ?? []);
  const rentalProperties = app.ownsOtherRealEstate == null
    ? intakeRentalProperties
    : reoQualificationPicture(realEstateOwned).rentalProperties;
  const profitLossActivity = await loadProfitLossActivity(app.id, employment);

  const input: IncomePathsCoreInput = {
    employment,
    otherIncome,
    rentalProperties,
    fallbackAnnualIncome: app.annualIncome,
    bankStatementAnalysis,
    profitLossActivity: profitLossActivity.signals,
    profitLossActivityIssues: profitLossActivity.issues,
    // Callers must explicitly opt into positive rental income after resolving
    // current decision evidence. A sticky application label is not enough.
    applyRentalToDti: options.applyRentalToDti,
    hasMortgageLiabilityRows: app.ownsOtherRealEstate == null && hasMortgageTypeLiability(liabilities),
    subjectProperty: propertyInfo
      ? {
          numberOfUnits: propertyInfo.numberOfUnits,
          occupancyType: propertyInfo.occupancyType,
          estimatedMarketRent: propertyInfo.estimatedMarketRent,
          estimatedPitia: estimateSubjectPitia(app.purchasePrice, app.downPayment),
        }
      : null,
    departingResidence: app.ownsOtherRealEstate == null ? departingResidenceInput(app) : null,
  };
  const result = computeIncomePaths(input);
  return {
    result,
    inputsFingerprint: incomeInputsFingerprint(input),
    evaluationFingerprint: incomeEvaluationFingerprint(result),
  };
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
