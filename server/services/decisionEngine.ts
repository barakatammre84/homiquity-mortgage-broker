import { createHash } from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { BorrowerDeclarations } from "@shared/schema";
import { storage } from "../storage";
import { db } from "../db";
import {
  consolidatedUnderwritingEngine,
  UnderwritingError,
  type UnderwritingInput,
  type UnderwritingLoanProgram,
  type AssetProfile,
  type ResolvedPolicy,
} from "../underwritingEngine";
import { computeDecisionPaymentProjection } from "./loanEstimate";
import { isExcludedAsPaidByOtherParty, type PaidByOtherPartyFacts } from "@shared/liabilityExclusions";
import { decisionSnapshots, incomePathEvaluations, type LoanApplication, type IncomeSourceEntry } from "@shared/schema";
import {
  computeIncomePaths,
  incomeInputsFingerprint,
  incomeEvaluationFingerprint,
  loadLatestBankStatementAnalysis,
  hasMortgageTypeLiability,
  departingResidenceInput,
  estimateSubjectPitia,
  type IncomePathsCoreInput,
} from "./income/orchestrator";
import type { IncomeOrchestrationResult } from "@shared/incomePaths";
import { getCurrentDecisionGrade } from "./currentDecisionGrade";
import { loadProfitLossActivity } from "./profitLossActivity";
import type { DecisionCreditPicture } from "./decisionCredit";
import {
  assessMultipleFinancedProperties,
  reoQualificationPicture,
  type MultipleFinancedPropertiesAssessment,
} from "@shared/realEstateFinancing";
import { assessLiabilities } from "../underwriting";
import {
  adjustedBureauDebtAfterReviewedTreatments,
  liabilitiesWithCurrentReviewedTreatments,
} from "./liabilityTreatments";

// =============================================================================
// INSTANT DECISION ORCHESTRATOR (Tinman-style)
//
// Composes existing deterministic pieces into a single "instant decision":
//   1. Fact-based, multi-borrower financial aggregation from URLA line items.
//   2. Completeness check  -> NEEDS_MORE_INFO with the exact missing items.
//   3. Loan pricing (reuses the loan-estimate service's compensation-
//      independent payment projection) -> proposed PITI.
//   4. Deterministic underwriting (ConsolidatedUnderwritingEngine, matrix-driven,
//      AI-free for Fair Lending) -> APPROVED / REJECTED / MANUAL_REVIEW + reasons.
//   5. Provenance tag: self-reported data yields a PRELIMINARY decision; only
//      verified data yields a VERIFIED (binding-grade) decision.
//
// Read-only: computes and returns a decision. Changes nothing, issues no
// commitment. Binding outcomes still go through the verified-data gate
// (shared/dataProvenance.ts) and human review per the underwriting policy.
// =============================================================================

export type DecisionStatus = "DECISION_READY" | "NEEDS_MORE_INFO";
export type Decision = "APPROVED" | "REJECTED" | "MANUAL_REVIEW";

export interface InstantDecision {
  status: DecisionStatus;
  decision: Decision | null;
  /** Product family evaluated here; see loanProgramSelection for its source. */
  loanProgram: UnderwritingLoanProgram | null;
  /** Whether the program was selected in URLA or is an early preliminary candidate. */
  loanProgramSelection: "application_selected" | "preliminary_conventional_candidate" | null;
  /** PRELIMINARY (self-reported data) vs VERIFIED (document/credit-backed). */
  qualifier: "PRELIMINARY" | "VERIFIED";
  isVerified: boolean;
  reasons: string[];
  missingItems: string[];
  /** SHA-256 over the borrower facts and derived income inputs evaluated in this run. */
  inputsFingerprint: string;
  /** Resolved thresholds/matrix cells + fingerprint for reproducibility (null pre-decision). */
  resolvedPolicy: ResolvedPolicy | null;
  /** The multi-path income evaluation behind this decision (UAL P3). Present once financials are aggregated. */
  income?: {
    result: IncomeOrchestrationResult;
    inputsFingerprint: string;
    evaluationFingerprint: string;
  };
  metrics: {
    ltv: number;
    cltv: number;
    hcltv: number;
    dti: number;
    monthlyPiti: number;
    pmiMonthly: number;
    loanAmount: number;
    monthlyIncome: number;
    monthlyDebts: number;
    creditScore: number;
    creditScoreSource: "bureau_report" | "application";
    monthlyDebtsSource: "bureau_reconciled" | "application_or_urla";
    borrowerCount: number;
    /** "urla_line_items" (fact-based, per-borrower) or "application_summary" (fallback). */
    incomeBasis: "urla_line_items" | "application_summary";
    /** Verified liquid reserves (post-haircut) and how many PITI payments they cover. */
    liquidAssets: number;
    /**
     * Post-closing months of reserves: liquid assets REMAINING AFTER the down
     * payment, divided by PITI — the same basis as preUnderwriting's
     * computeMonthsOfReserves, so the two surfaces can never quote different
     * reserve pictures for the same borrower. Floored at 0.
     */
    monthsOfReserves: number;
    /** Minimum subject-property reserves plus the B3-4.1-01 other-property UPB requirement. */
    requiredReserves: number;
    /** Haircut-adjusted liquid assets remaining after the down payment. */
    postClosingLiquidAssets: number;
    /** Subject purchase plus every qualifying financed property in URLA 2c. */
    financedPropertiesCount: number | null;
  } | null;
}

const DECISION_INPUT_FINGERPRINT_VERSION = "instant-decision-input-v4";

/** Map the persisted URLA vocabulary to the engine's explicit program axis. */
export function requestedUnderwritingProgram(
  value: string | null | undefined,
): UnderwritingLoanProgram | null {
  switch ((value ?? "").trim().toLowerCase()) {
    case "conventional": return "CONVENTIONAL";
    case "fha": return "FHA";
    case "va": return "VA";
    case "usda": return "USDA";
    default: return null;
  }
}

function decisionInputFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Map free-text URLA account types to the engine's asset buckets.
// Exported: the LO-2 scenario simulator buckets the same URLA assets.
export function classifyAsset(accountType: string): AssetProfile["type"] {
  const t = (accountType || "").toLowerCase();
  if (/retire|ira|401|403b|pension|annuity/.test(t)) return "RETIREMENT_IRA_401K";
  if (/stock|bond|mutual|brokerage|investment|securit|equity/.test(t)) return "STOCK_INVESTMENT";
  return "CHECKING_SAVINGS"; // checking, savings, money market, CD, cash
}

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  let s = String(v).trim().replace(/[,$\s]/g, "");
  // Accounting/tax-form negatives are parenthesized, e.g. a K-1 loss of
  // "(21,400)". parseFloat would read this as NaN (then get zeroed by safe),
  // silently deleting the loss from qualifying income — so normalize it to a
  // real negative before parsing.
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  const n = parseFloat(s);
  if (isNaN(n)) return NaN;
  return negative ? -n : n;
}

function safe(v: unknown): number {
  const n = toNumber(v);
  return isNaN(n) ? 0 : n;
}

/**
 * True for infrastructure errors — anything carrying a SQLSTATE-shaped pg
 * error code — which must surface as real faults, never be translated into
 * borrower "missing info". Exported for tests.
 */
export function isSystemFault(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
}

/**
 * Translate a PRICING exception (computePaymentProjection) into borrower/staff-
 * facing "missing info" labels — surfacing raw messages verbatim would leak
 * internal jargon into the decision UI. Order matters — the specific
 * loan-amount case is checked before the generic VALUE INPUT case.
 *
 * The compensation-election mapping stays even though the engine's projection
 * path no longer reads the election (WF1-002 fix): any residual caller that
 * reaches the DISCLOSABLE generator early still deserves the honest staff-side
 * label instead of the generic gap.
 *
 * NOTE: the underwriting engine itself no longer needs this — every engine
 * throw is a typed UnderwritingError carrying its own borrower-safe
 * publicMessage; this mapper only serves the pricing catch below.
 */
export function describeEngineGap(err: unknown): string[] {
  const msg = err instanceof Error ? err.message : String(err);
  // §1026.36(d)(2): the LO compensation election is a STAFF task — name it
  // honestly instead of the generic gap, or every un-elected file reads as
  // the borrower's fault with nothing actionable anywhere.
  if (/compensation model and rate are required/i.test(msg)) {
    return ["Loan pricing setup by our team — no action needed from you"];
  }
  if (/VA PROTOCOL/i.test(msg)) return ["Household size", "Home square footage"];
  if (/INCOME INPUT/i.test(msg)) return ["Qualifying income"];
  if (/Loan amount must be greater than zero/i.test(msg)) {
    return ["Down payment must be less than the purchase price"];
  }
  if (/VALUE INPUT/i.test(msg)) return ["Property value"];
  if (/unrecognized state/i.test(msg)) return ["Valid property state"];
  return ["Additional information required to complete the decision"];
}

/**
 * Monthly payments on liabilities not being paid off at closing, summed across
 * all borrowers; falls back to the application-level summary figure when no
 * URLA line items exist. Shared by the instant decision and the LO-2 scenario
 * simulator so the two can never quote different debt pictures.
 */
export function sumOpenMonthlyLiabilities(
  liabilities: Array<{ toBePaidOff: boolean | null; monthlyPayment: unknown } & PaidByOtherPartyFacts>,
  fallbackMonthlyDebts: unknown,
): number {
  if (liabilities.length === 0) return safe(fallbackMonthlyDebts);
  let total = 0;
  for (const liability of liabilities) {
    if (liability.toBePaidOff) continue;
    // B3-6-05, Debts Paid by Others: a payment another party actually makes
    // leaves the recurring obligations once the borrower's answers satisfy the
    // rule (shared/liabilityExclusions.ts — the same predicate the staff
    // calculations engine and the MISMO export read). The 12-month payment
    // history the Guide requires rides as an auto-generated condition; the
    // borrower is qualified on the ratio the Guide entitles them to, with the
    // paperwork named, rather than on one it says they need not carry.
    if (isExcludedAsPaidByOtherParty(liability)) continue;
    total += safe(liability.monthlyPayment);
  }
  return total;
}

/** True when a value is present and parses to a real number (incl. negatives). */
function isPresentNumber(v: unknown): boolean {
  if (v === null || v === undefined || String(v).trim() === "") return false;
  return !isNaN(toNumber(v));
}

interface AggregatedFinancials {
  baseMonthlyIncome: number;
  variableMonthlyIncome: number;
  totalMonthlyIncome: number;
  monthlyDebts: number;
  disclosedMonthlyDebts: number;
  bureauMonthlyDebts: number | null;
  creditReviewReasons: string[];
  borrowerCount: number;
  incomeBasis: "urla_line_items" | "application_summary";
  assets: AssetProfile[];
  /** The full multi-path evaluation behind this income (UAL P3). */
  income: IncomeOrchestrationResult;
  incomeInputsFingerprint: string;
  incomeEvaluationFingerprint: string;
  /** B3-5.3-07 events declared on URLA Section 5, across all borrowers. */
  declaredDerogatoryEvents: string[];
  multipleFinancedProperties: MultipleFinancedPropertiesAssessment;
  realEstateQualificationMissingItems: string[];
  openThirtyDayChargeBalance: number;
}

/**
 * Final decisions must consume the immutable, current workpaper result an
 * officer approved. Preliminary decisions continue to use the live URLA
 * calculation, which deliberately excludes evidence-only adjustments.
 */
export function selectIncomeForDecision(
  computed: IncomeOrchestrationResult,
  decisionGrade: boolean,
  approvedIncome: { result: IncomeOrchestrationResult } | null,
): IncomeOrchestrationResult {
  return decisionGrade && approvedIncome ? approvedIncome.result : computed;
}

/**
 * Aggregate qualifying income and monthly debts across EVERY borrower on the
 * application, from URLA line items when present. This removes the human step of
 * hand-tallying co-borrower income and debts, and only counts liabilities that
 * are not being paid off at closing. Falls back to the application-level summary
 * figures when line items haven't been captured yet.
 */
/**
 * URLA Section 5 declarations that carry a B3-5.3-07 waiting period, collapsed to
 * human-readable labels across ALL borrowers.
 *
 * Read across every borrower on purpose. Income is already aggregated across
 * `borrowerSequenceNumber`, so scoping a co-borrower's foreclosure to the
 * primary would repeat the asymmetry recorded as G-15 — counting a co-borrower's
 * benefit while ignoring their risk.
 *
 * These are declarations, not verified events; the engine routes them to a human
 * rather than declining, because B3-5.3-07's waiting periods run from discharge /
 * dismissal / completion dates that `borrower_declarations` does not store.
 */
export function summarizeDeclaredDerogatoryEvents(
  declarations: Array<Partial<BorrowerDeclarations>>,
): string[] {
  const events: string[] = [];
  const seen = new Set<string>();
  const add = (label: string) => {
    if (!seen.has(label)) { seen.add(label); events.push(label); }
  };
  for (const d of declarations) {
    if (d.hasDeclaredBankruptcy) {
      const types = (d.bankruptcyTypes ?? "").trim();
      add(types ? `bankruptcy (${types})` : "bankruptcy");
    }
    if (d.hasBeenForeclosed) add("foreclosure");
    if (d.hasConveyedTitleInLieuOfForeclosure) add("deed-in-lieu of foreclosure");
    if (d.hasCompletedShortSale) add("preforeclosure / short sale");
    if (d.hasOutstandingJudgments) add("outstanding judgments");
    if (d.isDelinquentOnFederalDebt) add("delinquency on federal debt");
  }
  return events;
}

async function aggregateBorrowerFinancials(
  app: LoanApplication,
  decisionGrade: boolean,
  decisionCredit: DecisionCreditPicture | null,
  approvedIncome: {
    result: IncomeOrchestrationResult;
    inputsFingerprint: string;
    evaluationFingerprint: string;
  } | null,
): Promise<AggregatedFinancials> {
  const [employment, otherIncome, liabilities, urlaAssets, bankStatementAnalysis, propertyInfo, declarations, realEstateOwned] =
    await Promise.all([
      storage.getEmploymentHistory(app.id),
      storage.getOtherIncomeSources(app.id),
      storage.getUrlaLiabilities(app.id),
      storage.getUrlaAssets(app.id),
      loadLatestBankStatementAnalysis(app.id),
      storage.getUrlaPropertyInfo(app.id),
      // B3-5.3-07 — across ALL borrowers, not just the primary (see G-15).
      storage.getAllBorrowerDeclarations(app.id),
      storage.getRealEstateOwnedByApplication(app.id),
    ]);

  // Assets across all borrowers, bucketed for the engine's reserve haircuts.
  const assets: AssetProfile[] = urlaAssets
    .map((a) => ({ type: classifyAsset(a.accountType), balance: safe(a.cashOrMarketValue) }))
    .filter((a) => a.balance > 0);

  const borrowerSeqs = new Set<number>();
  for (const e of employment) borrowerSeqs.add(e.borrowerSequenceNumber ?? 1);

  // Income: the multi-path orchestrator (UAL P3) is the single income
  // producer. It reconciles the wage math this function used to inline (agency
  // wage path) AND — the fix this cutover lands — routes self-employment
  // through the cited Form 1084 calculator instead of counting a raw captured
  // figure, plus surfaces rental / gated non-QM paths. The engine only uses
  // base+bonus as a sum, so the split is free; self-employment folds into base
  // (stable income), keeping wage-only decisions byte-identical to before.
  const intakeRentalProperties = ((app.incomeSources as IncomeSourceEntry[] | null) ?? [])
    .filter((s) => s.type === "rental")
    .flatMap((s) => s.rentalProperties ?? []);
  const reoQualification = reoQualificationPicture(realEstateOwned);
  // Once URLA 2c has an explicit ownership answer, it is the canonical source
  // for every existing property's rent and PITIA. The three-minute intake list
  // is only a bridge until that section is answered.
  const rentalProperties = app.ownsOtherRealEstate == null
    ? intakeRentalProperties
    : reoQualification.rentalProperties;
  const multipleFinancedProperties = assessMultipleFinancedProperties({
    ownsOtherRealEstate: app.ownsOtherRealEstate,
    properties: realEstateOwned,
    subjectOccupancyType: propertyInfo?.occupancyType ?? app.occupancyType,
  });
  const profitLossActivity = await loadProfitLossActivity(app.id, employment);
  const incomeInput: IncomePathsCoreInput = {
    employment,
    otherIncome,
    rentalProperties,
    fallbackAnnualIncome: app.annualIncome,
    expectedNoteDate: app.closingDate,
    applyVerifiedOtherIncomeAdjustments: decisionGrade,
    bankStatementAnalysis,
    profitLossActivity: profitLossActivity.signals,
    profitLossActivityIssues: profitLossActivity.issues,
    // B3-3.8-01 rental application (docs/fannie-mae/rental-income-reference.md):
    // positive offsets and subject-property rent only on decision-grade
    // provenance; losses always (platform-rental-preliminary-asymmetry).
    applyRentalToDti: decisionGrade,
    hasMortgageLiabilityRows: app.ownsOtherRealEstate == null && hasMortgageTypeLiability(liabilities),
    subjectProperty: propertyInfo
      ? {
          numberOfUnits: propertyInfo.numberOfUnits,
          occupancyType: propertyInfo.occupancyType,
          estimatedMarketRent: propertyInfo.estimatedMarketRent,
          estimatedPitia: estimateSubjectPitia(app.purchasePrice, app.downPayment),
        }
      : null,
    // S-07: a converting departing residence joins the per-property offsets.
    departingResidence: app.ownsOtherRealEstate == null ? departingResidenceInput(app) : null,
  };
  const computedIncome = computeIncomePaths(incomeInput);
  // A VERIFIED decision consumes the exact immutable income calculation the
  // officer approved. assembleWorkspace already proved that workpaper current
  // against every source fact and dependency; recomputing here from URLA rows
  // discarded evidence-only income such as Schedule D capital gains.
  const income = selectIncomeForDecision(computedIncome, decisionGrade, approvedIncome);

  // Debts: monthly payments not being paid off, summed across all borrowers,
  // plus an applied net rental LOSS — B3-3.8-01 puts it in monthly
  // obligations, the numerator of DTI, never in income as a negative.
  for (const l of liabilities) borrowerSeqs.add(l.borrowerSequenceNumber ?? 1);
  // A current approved liability workpaper is the authorization boundary for
  // borrower-favorable documented treatments. Its fingerprint contains these
  // source/pull links, so any row edit, replacement document or new pull makes
  // decisionGrade false and falls back to the conservative payment.
  const currentTreatmentDocumentIds = decisionGrade
    ? new Set(liabilities.flatMap(liability => liability.treatmentSourceDocumentId
        ? [liability.treatmentSourceDocumentId]
        : []))
    : new Set<string>();
  const effectiveLiabilities = liabilitiesWithCurrentReviewedTreatments(
    liabilities,
    decisionGrade ? decisionCredit : null,
    currentTreatmentDocumentIds,
  );
  const liabilityAssessment = assessLiabilities(effectiveLiabilities, {
    allowReviewedTreatments: decisionGrade,
  });
  const nonMortgageLiabilities = effectiveLiabilities.filter(
    liability => !hasMortgageTypeLiability([liability]),
  );
  const nonMortgageLiabilityAssessment = assessLiabilities(nonMortgageLiabilities, {
    allowReviewedTreatments: decisionGrade,
  });
  const disclosedMonthlyDebts = app.ownsOtherRealEstate == null
    ? liabilities.length > 0
      ? liabilityAssessment.totalMonthlyPayment
      : safe(app.monthlyDebts)
    : liabilities.length > 0
      ? nonMortgageLiabilityAssessment.totalMonthlyPayment + reoQualification.nonRentalMonthlyObligation
      : Math.max(safe(app.monthlyDebts), reoQualification.nonRentalMonthlyObligation);
  const bureauMonthlyDebts = decisionGrade
    ? adjustedBureauDebtAfterReviewedTreatments(
        decisionCredit,
        liabilities,
        currentTreatmentDocumentIds,
      )
    : null;
  const creditReviewReasons: string[] = [];
  if (
    bureauMonthlyDebts !== null
    && Math.abs(disclosedMonthlyDebts - bureauMonthlyDebts) > 1
  ) {
    creditReviewReasons.push(
      `The bureau report shows ${bureauMonthlyDebts.toLocaleString("en-US", { style: "currency", currency: "USD" })} in qualifying monthly credit obligations, while the application liability schedule shows ${disclosedMonthlyDebts.toLocaleString("en-US", { style: "currency", currency: "USD" })}. Reconcile the difference before an automated approval.`,
    );
  }
  // A decision-grade screen takes the greater household debt total until the
  // application schedule and bureau ledger agree. This avoids a false approval
  // while still preserving non-bureau obligations disclosed on the URLA.
  const monthlyDebts = Math.max(disclosedMonthlyDebts, bureauMonthlyDebts ?? 0)
    + income.primaryBreakdown.rentalLiabilityApplied;

  // Engine split (base+bonus, used only as a sum): agency variable, capital
  // gains, and employment-related asset income are "bonus";
  // agency base + self-employment are "base"; applied rental income (non-
  // subject positive offsets + subject-property qualifying rent) rides in
  // "variable" so base + variable always equals the primary total. For a
  // wage-only file this is exactly the legacy split.
  return {
    baseMonthlyIncome: income.primaryBreakdown.agencyBase + income.primaryBreakdown.selfEmployment,
    variableMonthlyIncome:
      income.primaryBreakdown.agencyVariable +
      (income.primaryBreakdown.capitalGains ?? 0) +
      (income.primaryBreakdown.employmentRelatedAssets ?? 0) +
      income.primaryBreakdown.rentalIncomeApplied +
      income.primaryBreakdown.subjectRentalIncomeApplied,
    totalMonthlyIncome: income.primaryMonthlyQualifyingIncome,
    monthlyDebts,
    disclosedMonthlyDebts,
    bureauMonthlyDebts,
    creditReviewReasons,
    borrowerCount: Math.max(borrowerSeqs.size, 1),
    declaredDerogatoryEvents: summarizeDeclaredDerogatoryEvents(declarations),
    multipleFinancedProperties,
    realEstateQualificationMissingItems: reoQualification.missingItems,
    openThirtyDayChargeBalance: app.ownsOtherRealEstate == null
      ? liabilityAssessment.openThirtyDayBalance
      : nonMortgageLiabilityAssessment.openThirtyDayBalance,
    incomeBasis: income.incomeBasis,
    assets,
    income,
    incomeInputsFingerprint: decisionGrade && approvedIncome
      ? approvedIncome.inputsFingerprint
      : incomeInputsFingerprint(incomeInput),
    incomeEvaluationFingerprint: decisionGrade && approvedIncome
      ? approvedIncome.evaluationFingerprint
      : incomeEvaluationFingerprint(income),
  };
}

export async function runInstantDecision(applicationId: string): Promise<InstantDecision> {
  const app = await storage.getLoanApplication(applicationId);
  if (!app) {
    throw new Error("Application not found");
  }

  const currentGrade = await getCurrentDecisionGrade(app);
  const isVerified = currentGrade.isDecisionGrade && currentGrade.decisionCredit !== null;
  const decisionCredit = isVerified ? currentGrade.decisionCredit : null;
  const qualifier: InstantDecision["qualifier"] = isVerified ? "VERIFIED" : "PRELIMINARY";
  const selectedLoanProgram = requestedUnderwritingProgram(app.preferredLoanType);
  // The fast application deliberately does not ask a novice borrower to pick a
  // program. Preserve a fast PRELIMINARY result by evaluating a conventional
  // candidate, but never use that fallback for a verified/outward decision.
  const requestedLoanProgram = selectedLoanProgram ?? (isVerified ? null : "CONVENTIONAL");
  const loanProgramSelection: InstantDecision["loanProgramSelection"] = selectedLoanProgram
    ? "application_selected"
    : requestedLoanProgram
      ? "preliminary_conventional_candidate"
      : null;

  const fin = await aggregateBorrowerFinancials(
    app,
    isVerified,
    decisionCredit,
    currentGrade.approvedIncome,
  );
  const effectiveCreditScore = decisionCredit?.representativeScore ?? app.creditScore;

  // A policy fingerprint proves which rules were used; this separate digest
  // proves which borrower facts were evaluated. Keep the payload explicit so
  // adding an unrelated application column cannot invalidate every decision.
  const decisionEvidence = {
    version: DECISION_INPUT_FINGERPRINT_VERSION,
    application: {
      annualIncome: app.annualIncome,
      monthlyDebts: app.monthlyDebts,
      creditScore: app.creditScore,
      employmentType: app.employmentType,
      purchasePrice: app.purchasePrice,
      downPayment: app.downPayment,
      propertyValue: app.propertyValue,
      propertyState: app.propertyState,
      propertyType: app.propertyType,
      loanPurpose: app.loanPurpose,
      preferredLoanType: app.preferredLoanType,
      amortizationType: app.amortizationType,
      loanTermMonths: app.loanTermMonths,
      isVeteran: app.isVeteran,
      householdFamilySize: app.householdFamilySize,
      homeSquareFootage: app.homeSquareFootage,
      financialDataProvenance: app.financialDataProvenance,
      incomeVerified: app.incomeVerified,
      assetsVerified: app.assetsVerified,
      creditVerified: app.creditVerified,
      currentPropertyDisposition: app.currentPropertyDisposition,
      departingResidence: app.departingResidence,
      ownsOtherRealEstate: app.ownsOtherRealEstate,
    },
    incomeInputsFingerprint: fin.incomeInputsFingerprint,
    incomeEvaluationFingerprint: fin.incomeEvaluationFingerprint,
    currentVerification: {
      isDecisionGrade: currentGrade.isDecisionGrade,
      evidence: currentGrade.evidence,
    },
    decisionCredit: decisionCredit
      ? {
          pullId: decisionCredit.pullId,
          representativeScore: decisionCredit.representativeScore,
          reportedMonthlyPayments: decisionCredit.reportedMonthlyPayments,
          adjustedMonthlyDebt: decisionCredit.adjustedMonthlyDebt,
          fingerprint: decisionCredit.fingerprint,
        }
      : null,
    multipleFinancedProperties: fin.multipleFinancedProperties,
    openThirtyDayChargeBalance: fin.openThirtyDayChargeBalance,
    underwritingProgram: {
      evaluated: requestedLoanProgram,
      selection: loanProgramSelection,
    },
  };
  const prePricingInputsFingerprint = decisionInputFingerprint(decisionEvidence);

  // Every decision (including NEEDS_MORE_INFO) carries the income evaluation
  // that produced its income figure, so recalculateDecision can persist it and
  // link it to the snapshot.
  const base: Pick<InstantDecision, "qualifier" | "isVerified" | "income" | "inputsFingerprint" | "loanProgram" | "loanProgramSelection"> = {
    qualifier,
    isVerified,
    loanProgram: requestedLoanProgram,
    loanProgramSelection,
    inputsFingerprint: prePricingInputsFingerprint,
    income: {
      result: fin.income,
      inputsFingerprint: fin.incomeInputsFingerprint,
      evaluationFingerprint: fin.incomeEvaluationFingerprint,
    },
  };

  // Completeness — the "Need More Info" state, with the specific gaps.
  const purchasePrice = toNumber(app.purchasePrice);
  const downPayment = toNumber(app.downPayment);
  const missing: string[] = [];
  const selfEmploymentPath = fin.income.paths.find((path) => path.pathId === "self_employment");
  const selfEmploymentMissingItems = selfEmploymentPath?.missingItems ?? [];
  // The intake's annual-income figure is only a rough planning estimate for a
  // self-employed borrower. The cited income path requires a URLA employment
  // record and Form 1084 worksheet for each business before that income can
  // produce an automated decision. Without the record, the wage fallback
  // would otherwise auto-approve the exact income the self-employment path is
  // designed to refuse at face value.
  if (selfEmploymentMissingItems.length > 0) {
    missing.push(...selfEmploymentMissingItems);
  } else if (app.employmentType === "self_employed" && selfEmploymentPath?.status !== "applicable") {
    missing.push("Self-employment details and a completed income worksheet for each business or 1099 source");
  }
  if (fin.totalMonthlyIncome <= 0) {
    missing.push(
      fin.incomeBasis === "urla_line_items"
        ? "Net qualifying income is zero or negative after business losses — a self-employed income review is required before a decision."
        : "Income (no employment or income sources on file)",
    );
  }
  if (!effectiveCreditScore) missing.push("Credit score");
  if (!requestedLoanProgram) missing.push("Preferred loan program");
  if (!purchasePrice || purchasePrice <= 0) missing.push("Purchase price");
  if (isNaN(downPayment) || downPayment < 0) missing.push("Down payment");
  // A down payment at or above the price leaves a zero/negative loan amount,
  // which the engine would otherwise "approve" (LTV <= 0 clears every ceiling).
  if (!isNaN(downPayment) && purchasePrice > 0 && downPayment >= purchasePrice) {
    missing.push("Down payment must be less than the purchase price");
  }
  if (!app.propertyState) missing.push("Property state");
  missing.push(...fin.multipleFinancedProperties.missingItems);
  missing.push(...fin.realEstateQualificationMissingItems);
  // VA path: the residual-income evaluation needs both of these — surface them
  // as named gaps here instead of letting the engine throw its protocol error.
  if (requestedLoanProgram === "VA" && app.isVeteran) {
    if (!app.householdFamilySize) missing.push("Household size (required for VA residual income)");
    if (!app.homeSquareFootage) missing.push("Home square footage (required for VA residual income)");
  }

  if (missing.length > 0) {
    return { status: "NEEDS_MORE_INFO", decision: null, reasons: [], missingItems: missing, metrics: null, resolvedPolicy: null, ...base };
  }

  // Product selection is part of the decision, not a hint. The current engine
  // has cited deterministic policy for conventional and VA only. FHA and USDA
  // therefore route to a loan officer before any conventional/VA projection
  // can be mistaken for an automated eligibility result.
  if (requestedLoanProgram === "FHA" || requestedLoanProgram === "USDA") {
    return {
      status: "DECISION_READY",
      decision: "MANUAL_REVIEW",
      reasons: [
        `${requestedLoanProgram} underwriting is not automated yet. A loan officer must review this program using its current governing guidance before eligibility can be determined.`,
      ],
      missingItems: [],
      metrics: null,
      resolvedPolicy: null,
      ...base,
    };
  }

  if (requestedLoanProgram === "VA" && !app.isVeteran) {
    return {
      status: "DECISION_READY",
      decision: "MANUAL_REVIEW",
      reasons: ["A loan officer must confirm VA eligibility before this program can be evaluated."],
      missingItems: [],
      metrics: null,
      resolvedPolicy: null,
      ...base,
    };
  }

  // The internal payment model below is a fixed-rate purchase projection using
  // the amortization term explicitly stored on the application.
  // Do not calculate a plausible-looking payment and only then discover that
  // the selected transaction needs different program rules. Preserve the exact
  // product in the snapshot and route it to review before pricing.
  const loanPurpose = (app.loanPurpose ?? "purchase").trim().toLowerCase();
  if (loanPurpose && loanPurpose !== "purchase") {
    return {
      status: "DECISION_READY",
      decision: "MANUAL_REVIEW",
      reasons: [
        `${requestedLoanProgram} ${loanPurpose} underwriting is outside the automated purchase screen and requires program-specific loan officer review.`,
      ],
      missingItems: [],
      metrics: null,
      resolvedPolicy: null,
      ...base,
    };
  }
  const amortizationType = (app.amortizationType ?? "fixed").trim().toLowerCase();
  if (amortizationType === "adjustable" || amortizationType === "arm") {
    return {
      status: "DECISION_READY",
      decision: "MANUAL_REVIEW",
      reasons: [
        `${requestedLoanProgram} adjustable-rate qualification is not automated because the index, margin, and rate caps needed to calculate the qualifying payment are not captured.`,
      ],
      missingItems: [],
      metrics: null,
      resolvedPolicy: null,
      ...base,
    };
  }

  // Price the loan to get a proposed PITI — the loan-estimate service's
  // INTERNAL payment projection: the same rate/P&I/MI/escrow derivation the
  // disclosable Loan Estimate prices, minus the §1026.36(d)(2) compensation
  // guard and every disclosable fee/closing-cost/APR section. PITI is
  // compensation-independent (no origination fee rides in a monthly payment),
  // and routing the engine through the disclosable generator made every fresh
  // intake undecidable (WF1-002) because no intake path elects compensation.
  // The disclosable generator keeps its guard; files missing a genuine pricing
  // input (price, down payment, credit score, state) still gap honestly here.
  let monthlyPiti: number;
  let subordinateFinancingExists: boolean | null = null;
  let calculatedCltv: number | null = null;
  let calculatedHcltv: number | null = null;
  try {
    const program = requestedLoanProgram!.toLowerCase() as "conventional" | "fha" | "va" | "usda";
    const projection = decisionCredit
      ? await computeDecisionPaymentProjection(applicationId, program, { creditScore: decisionCredit.representativeScore })
      : await computeDecisionPaymentProjection(applicationId, program);

    // B3-6-03: owners' association and co-op dues belong inside the qualifying
    // housing expense. On a condo, co-op, PUD or townhouse we cannot treat an
    // uncaptured figure as zero — that qualifies the borrower on a housing
    // expense we know to be incomplete, and understates the DTI by an unknown
    // amount. A NULL is an honest gap; a fabricated zero is a falsified record.
    if (projection.associationDuesUncaptured) {
      return {
        status: "NEEDS_MORE_INFO",
        decision: null,
        reasons: [],
        missingItems: ["Monthly homeowners association (HOA) or co-op dues for the property"],
        metrics: null,
        resolvedPolicy: null,
        ...base,
      };
    }
    if ((projection.housingExpenseMissingItems ?? []).length > 0) {
      return {
        status: "NEEDS_MORE_INFO",
        decision: null,
        reasons: [],
        missingItems: projection.housingExpenseMissingItems ?? [],
        metrics: null,
        resolvedPolicy: null,
        ...base,
      };
    }

    // B3-6-03: the DTI is built on the QUALIFYING housing expense, which
    // includes association dues. estimatedMonthlyTotal deliberately excludes
    // them to hold Loan Estimate parity — it is not the qualifying figure.
    //
    // Fail loudly on a missing figure rather than decisioning on it. An
    // undefined PITI does not blow up downstream: it propagates into the DTI
    // and reserve math and comes out as a plausible-looking decision with zero
    // months of reserves — a decision computed on nothing, which is the exact
    // silent-success shape this codebase keeps paying for. Deliberately NOT
    // falling back to estimatedMonthlyTotal: that would quietly resurrect the
    // dues-omission defect this field exists to fix.
    if (typeof projection.qualifyingPitia !== "number" || !Number.isFinite(projection.qualifyingPitia)) {
      throw new Error(
        "CRITICAL DECISIONING ERROR: qualifying PITIA (B3-6-03) is unavailable — refusing to decision on an incomplete housing expense.",
      );
    }
    monthlyPiti = projection.qualifyingPitia;
    subordinateFinancingExists = projection.subordinateFinancingExists;
    calculatedCltv = projection.cltv;
    calculatedHcltv = projection.hcltv;
  } catch (err) {
    // A database/system fault must never masquerade as a borrower-info gap —
    // the underwriting catch below already rethrows faults; this catch must
    // match (a missing table once surfaced as "additional information
    // required" and blocked files with an unactionable message).
    if (isSystemFault(err)) throw err;
    return { status: "NEEDS_MORE_INFO", decision: null, reasons: [], missingItems: describeEngineGap(err), metrics: null, resolvedPolicy: null, ...base };
  }

  // Subject-property occupancy and unit count drive the agency max-LTV
  // eligibility caps; pull them from the URLA property record when captured so a
  // multi-unit or investment property is not decisioned as an owner-occupied SFR.
  const propertyInfo = await storage.getUrlaPropertyInfo(applicationId);

  // Run the deterministic engine on the aggregated, multi-borrower figures.
  const input: UnderwritingInput = {
    requestedLoanProgram: requestedLoanProgram!,
    isVeteran: app.isVeteran ?? false,
    baseMonthlyIncome: fin.baseMonthlyIncome,
    bonusMonthlyIncome: fin.variableMonthlyIncome,
    existingMonthlyDebts: fin.monthlyDebts,
    originalLoanAmount: purchasePrice - downPayment,
    contractSalesPrice: purchasePrice,
    appraisalValue: toNumber(app.propertyValue) || purchasePrice,
    subordinateFinancingExists,
    combinedLoanToValue: calculatedCltv,
    homeEquityCombinedLoanToValue: calculatedHcltv,
    representativeFico: effectiveCreditScore!, // guaranteed non-null by the completeness check above
    proposedPiti: monthlyPiti,
    assets: fin.assets,
    multipleFinancedProperties: fin.multipleFinancedProperties,
    subjectPropertyState: app.propertyState ?? undefined,
    occupancyType: propertyInfo?.occupancyType ?? undefined,
    numberOfUnits: propertyInfo?.numberOfUnits ?? undefined,
    // Declared property type, reconciled against the declared unit count. The
    // OBSERVED (vendor-lookup) descriptor is not yet wired — capturing it at
    // intake is the remaining piece to catch a consistent misstatement.
    propertyType: app.propertyType ?? undefined,
    // B2-1.3-02 / B2-1.3-03: refinance LTV ceilings differ from purchase and
    // live in the Eligibility Matrix. Passing the purpose lets the engine route
    // a non-purchase file to review instead of measuring it against a purchase
    // ceiling it was never entitled to.
    loanPurpose: app.loanPurpose ?? undefined,
    // B3-6-04: an ARM is not qualified at its note rate. The URLA offers
    // "Adjustable Rate (ARM)" and this column stores it, so the engine must see
    // it rather than price every file as a 30-year fixed.
    amortizationType: app.amortizationType ?? undefined,
    // B3-5.3-07: a declared bankruptcy/foreclosure must reach the decision.
    // Before this the whole declarations table stopped at document generation.
    declaredDerogatoryEvents: fin.declaredDerogatoryEvents,
    householdFamilySize: app.householdFamilySize ?? undefined,
    homeSquareFootage: app.homeSquareFootage ?? undefined,
  };
  const pricedInputsFingerprint = decisionInputFingerprint({
    ...decisionEvidence,
    underwritingInput: input,
  });

  let result;
  try {
    result = await consolidatedUnderwritingEngine.evaluate(input);
  } catch (err) {
    if (err instanceof UnderwritingError) {
      // A genuinely missing/unusable input is the only case that should loop
      // back for more information — and only with a borrower-safe message, never
      // the raw internal detail.
      if (err.kind === "INPUT_INCOMPLETE" || err.kind === "INPUT_INVALID") {
        return { status: "NEEDS_MORE_INFO", decision: null, reasons: [], missingItems: [err.publicMessage], metrics: null, resolvedPolicy: null, ...base };
      }
      // A profile outside the automated pricing/eligibility matrices is a
      // DECISION, not a documentation gap: route it to a human as MANUAL_REVIEW
      // so it lands in the queue with an auditable reason instead of crashing or
      // looping forever asking for documents that would never resolve it.
      if (err.kind === "POLICY_OUT_OF_BAND" || err.kind === "POLICY_UNSUPPORTED") {
        return { status: "DECISION_READY", decision: "MANUAL_REVIEW", reasons: [err.publicMessage], missingItems: [], metrics: null, resolvedPolicy: null, ...base, inputsFingerprint: pricedInputsFingerprint };
      }
    }
    // Anything else (e.g. a missing policy matrix) is a system fault, not an
    // underwriting outcome — let it surface as a real error rather than masking
    // it as "needs more info".
    throw err;
  }

  const incomeReviewReasons = fin.income.requiresManualReview
    ? fin.income.paths
        .filter(path => path.requiresManualReview)
        .flatMap(path => path.notes)
        .filter((note) => note.trim().length > 0)
    : [];
  const creditRequiresReview = fin.creditReviewReasons.length > 0;

  return {
    status: "DECISION_READY",
    decision: fin.income.requiresManualReview || creditRequiresReview ? "MANUAL_REVIEW" : result.decision,
    // Rejections and review reasons both explain the outcome to the borrower/LO;
    // the decision field distinguishes a decline from a "needs a human" review.
    reasons: [...result.rejectionReasons, ...result.reviewReasons, ...incomeReviewReasons, ...fin.creditReviewReasons],
    missingItems: [],
    resolvedPolicy: result.resolvedPolicy,
    metrics: {
      ltv: result.calculatedLtv,
      cltv: result.calculatedCltv,
      hcltv: result.calculatedHcltv,
      dti: result.calculatedDti,
      monthlyPiti,
      pmiMonthly: result.resolvedPmiMonthlyPremium,
      loanAmount: input.originalLoanAmount,
      monthlyIncome: fin.totalMonthlyIncome,
      monthlyDebts: fin.monthlyDebts,
      creditScore: effectiveCreditScore!,
      creditScoreSource: decisionCredit ? "bureau_report" : "application",
      monthlyDebtsSource: decisionCredit ? "bureau_reconciled" : "application_or_urla",
      borrowerCount: fin.borrowerCount,
      incomeBasis: fin.incomeBasis,
      liquidAssets: result.calculatedLiquidAssets,
      // Net of the down payment (post-closing reserves), matching
      // preUnderwriting.computeMonthsOfReserves — previously the gross balance
      // was divided, overstating reserves by the entire down payment.
      monthsOfReserves: monthlyPiti > 0
        ? Math.round((Math.max(result.calculatedLiquidAssets - downPayment, 0) / monthlyPiti) * 10) / 10
        : 0,
      requiredReserves: result.calculatedRequiredReserves,
      postClosingLiquidAssets: result.calculatedPostClosingLiquidAssets,
      financedPropertiesCount: result.financedPropertiesCount,
    },
    ...base,
    inputsFingerprint: pricedInputsFingerprint,
  };
}

/**
 * Real-time recalc ("context graph"): re-run the decision and persist an
 * immutable snapshot with the trigger that caused it. Call this fire-and-forget
 * whenever a fact changes (credit pull, income/liability update, verification).
 * Best-effort — it never throws into the calling request.
 */
export async function recalculateDecision(
  applicationId: string,
  trigger: string,
): Promise<InstantDecision | null> {
  try {
    const d = await runInstantDecision(applicationId);

    // Persist the multi-path income evaluation (UAL P3) first, so the decision
    // snapshot can record which evaluation produced its income figure. This is
    // append-only, exactly like the snapshot; a re-run with unchanged inputs
    // makes a new row (the evaluationFingerprint identifies duplicates).
    let incomePathEvaluationId: string | null = null;
    if (d.income) {
      const [evaluation] = await db
        .insert(incomePathEvaluations)
        .values({
          applicationId,
          trigger,
          paths: d.income.result.paths,
          primaryMonthlyQualifyingIncome: String(d.income.result.primaryMonthlyQualifyingIncome),
          recommendedPathId: d.income.result.recommendedPathId,
          incomeBasis: d.income.result.incomeBasis,
          requiresManualReview: d.income.result.requiresManualReview,
          inputsFingerprint: d.income.inputsFingerprint,
          evaluationFingerprint: d.income.evaluationFingerprint,
        })
        .returning({ id: incomePathEvaluations.id });
      incomePathEvaluationId = evaluation.id;
    }

    await db.insert(decisionSnapshots).values({
      applicationId,
      trigger,
      status: d.status,
      decision: d.decision,
      qualifier: d.qualifier,
      loanProgram: d.loanProgram,
      loanProgramSelection: d.loanProgramSelection,
      dti: d.metrics ? String(d.metrics.dti) : null,
      ltv: d.metrics ? String(d.metrics.ltv) : null,
      monthlyIncome: d.metrics ? String(d.metrics.monthlyIncome) : null,
      monthlyDebts: d.metrics ? String(d.metrics.monthlyDebts) : null,
      monthlyPiti: d.metrics ? String(d.metrics.monthlyPiti) : null,
      loanAmount: d.metrics ? String(d.metrics.loanAmount) : null,
      borrowerCount: d.metrics ? d.metrics.borrowerCount : null,
      incomeBasis: d.metrics ? d.metrics.incomeBasis : null,
      reasons: d.reasons,
      missingItems: d.missingItems,
      inputFingerprint: d.inputsFingerprint,
      resolvedPolicy: d.resolvedPolicy ?? null,
      policyFingerprint: d.resolvedPolicy?.fingerprint ?? null,
      incomePathEvaluationId,
    });
    return d;
  } catch (err) {
    console.error(`[decisionEngine] recalc failed for ${applicationId} (${trigger}):`, err);
    return null;
  }
}

/** Time-ordered decision snapshots for an application (newest first). */
export async function getDecisionHistory(applicationId: string, limit = 20) {
  return db
    .select()
    .from(decisionSnapshots)
    .where(eq(decisionSnapshots.applicationId, applicationId))
    .orderBy(desc(decisionSnapshots.createdAt))
    .limit(limit);
}
