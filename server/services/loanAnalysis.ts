import { storage } from "../storage";
import { recalculateDecision, type InstantDecision } from "./decisionEngine";
import { monthlyPrincipalAndInterest, paymentFactor } from "@shared/lib/amortization";
import { calculateMortgageAPR, estimatePrepaidFinanceCharges } from "./apr";

// =============================================================================
// DETERMINISTIC INTAKE ANALYSIS
//
// Replaces the former LLM-backed intake analysis (server/gemini.ts). Every
// number here is computed with closed-form math; every threshold comes from
// the Postgres lookup matrices or a cited guideline. No AI model sits in this
// path (Reg B / ECOA — see tests/complianceInvariants.test.ts).
//
// Decision locus:
//   - APPROVED + VERIFIED      -> "pre_approved"  (automation may say yes)
//   - APPROVED + PRELIMINARY   -> "under_review"  (planning result only)
//   - MANUAL_REVIEW / REJECTED -> "under_review"  (only a human may say no —
//     a formal denial requires ECOA adverse-action handling, so intake never
//     auto-denies; the engine's reasons are preserved for the underwriter)
//   - NEEDS_MORE_INFO          -> "under_review" with the specific gaps
// =============================================================================

export interface LoanScenario {
  loanType: "conventional" | "fha" | "va";
  loanTerm: number;
  interestRate: string;
  apr: string;
  points: string;
  pointsCost: string;
  monthlyPayment: string;
  principalAndInterest: string;
  propertyTax: string;
  homeInsurance: string;
  pmi: string;
  loanAmount: string;
  closingCosts: string;
  cashToClose: string;
  totalInterestPaid: string;
  downPaymentAmount: string;
  downPaymentPercent: string;
  isRecommended: boolean;
}

export interface IntakeAnalysisResult {
  /** Application status to persist. Intake never sets "denied" (ECOA locus). */
  outcome: "pre_approved" | "under_review";
  /** True only for a current VERIFIED approval that can support outward approval state. */
  isApproved: boolean;
  /** Self-reported facts support a planning candidate, but no approval has been issued. */
  isPreliminaryCandidate: boolean;
  preApprovalAmount: string;
  dtiRatio: string;
  ltvRatio: string;
  analysis: {
    strengths: string[];
    concerns: string[];
    recommendations: string[];
  };
  scenarios: LoanScenario[];
  /** The full engine decision, for callers that want status/qualifier/reasons. */
  decision: InstantDecision | null;
}

// Same rate model as generateLoanEstimate (loanEstimate.ts): product base rate
// with representative-FICO adjustments. Illustrative until real rate-sheet
// pricing (pricingAdapter.computeOffers) is bound to the borrower UI.
function baseRateFor(loanType: "conventional" | "fha" | "va", creditScore: number): number {
  let rate = 6.875;
  if (loanType === "va") rate = 6.25;
  else if (loanType === "fha") rate = 6.5;

  if (creditScore >= 780) rate -= 0.25;
  else if (creditScore >= 760) rate -= 0.125;
  else if (creditScore < 680) rate += 0.375;
  else if (creditScore < 700) rate += 0.25;
  return rate;
}

/** @see @shared/lib/amortization — annualRate is a PERCENT here. */
const monthlyPI = monthlyPrincipalAndInterest;

function toNumber(v: unknown): number {
  const n = parseFloat(String(v ?? "").replace(/[,$]/g, ""));
  return isNaN(n) ? 0 : n;
}

export interface ScenarioInputs {
  purchasePrice: number;
  downPayment: number;
  loanAmount: number;
  creditScore: number;
  isVeteran: boolean;
  isFirstTimeBuyer: boolean;
  /** Engine-resolved monthly PMI for the conventional path (matrix-driven). */
  enginePmiMonthly: number | null;
  /** The exact program evaluated by the current decision. */
  selectedLoanProgram: InstantDecision["loanProgram"];
}

// Escrow model matches generateLoanEstimate: tax 1.2%/yr, insurance
// max($1,200, 0.3% of price)/yr.
function escrowFor(purchasePrice: number): { tax: number; insurance: number } {
  return {
    tax: (purchasePrice * 0.012) / 12,
    insurance: Math.max(1200, purchasePrice * 0.003) / 12,
  };
}

/**
 * Actuarial APR for one scenario — the Appendix J solver in services/apr.ts,
 * never a spread over the note rate. The spread was F-076: every borrower
 * option card showed `rate + 0.25/0.50`, which apr.ts's own header calls a
 * TILA violation to advertise, and a paid discount point moved the displayed
 * APR by exactly 0.000pp.
 *
 * Fee basis: these scenarios are PRE-ELECTION estimates — no originator
 * compensation model exists yet, and loanCosts.ts deliberately refuses to
 * assume one (§1026.36(d)(2)). The advertised representative fee model is the
 * platform's treatment for exactly that state, and errs only in the
 * conservative direction (borrower-paid origination kept ⇒ a higher disclosed
 * APR, never a lower one). The scenario's own discount points are added on
 * top — points are prepaid finance charges (§1026.4 per apr.ts's header).
 *
 * MI in the stream is the scenario's own monthly figure: conventional BPMI
 * terminates at 78% LTV (HPA — property value passed), FHA annual MIP runs
 * life-of-loan (same post-2013 treatment as advertisedAPR).
 *
 * Exported so the matrix test can pin that the stored column ROUTES through
 * this (F-090: the old test's `apr >= rate` passed for any constant).
 */
export function scenarioAPR(args: {
  loanType: "conventional" | "fha" | "va";
  loanAmount: number;
  ratePct: number;
  termMonths: number;
  monthlyMI: number;
  purchasePrice: number;
  pointsCost: number;
}): number {
  const { loanType, loanAmount, ratePct, termMonths, monthlyMI, purchasePrice, pointsCost } = args;
  // Degenerate pricing inputs (no positive loan, or fees swallowing the whole
  // amount financed) cannot carry an APR claim; the note rate is the honest
  // floor and the card renders nothing meaningful in these states anyway.
  if (loanAmount <= 0 || ratePct <= 0 || termMonths <= 0) return ratePct;
  const prepaidFinanceCharges =
    estimatePrepaidFinanceCharges(loanAmount, ratePct, { isFHA: loanType === "fha" }) + pointsCost;
  if (loanAmount - prepaidFinanceCharges <= 0) return ratePct;
  return calculateMortgageAPR({
    loanAmount,
    noteRatePct: ratePct,
    termMonths,
    monthlyMI,
    propertyValue: loanType === "fha" ? 0 : purchasePrice,
    prepaidFinanceCharges,
  });
}

function buildScenario(
  loanType: "conventional" | "fha" | "va",
  inputs: ScenarioInputs,
  opts: { points?: number; isRecommended?: boolean; termYears?: 15 | 30 } = {},
): LoanScenario {
  const { purchasePrice, downPayment, loanAmount, creditScore } = inputs;
  const termYears = opts.termYears ?? 30;
  const termMonths = termYears * 12;
  const points = opts.points ?? 0;
  // 1 discount point buys ~0.25% off the rate (standard rule of thumb; the
  // real buy-down comes from rate sheets once Contract 2 lands). 15-year
  // terms carry the customary ~0.50% discount to the 30-year base rate.
  const rate = baseRateFor(loanType, creditScore) - points * 0.25 - (termYears === 15 ? 0.5 : 0);
  const { tax, insurance } = escrowFor(purchasePrice);
  const ltv = (loanAmount / purchasePrice) * 100;

  let mi = 0;
  if (loanType === "conventional" && ltv > 80) {
    // Prefer the engine's matrix-resolved PMI premium; fall back to 0.6%/yr.
    mi = inputs.enginePmiMonthly ?? (loanAmount * 0.006) / 12;
  } else if (loanType === "fha") {
    // FHA annual MIP, 0.85% for LTV > 95% is the common case; 0.80% under.
    mi = (loanAmount * (ltv > 95 ? 0.0085 : 0.008)) / 12;
  }
  // VA loans carry no monthly MI (funding fee is financed, not escrowed).

  const pi = monthlyPI(loanAmount, rate, termMonths);
  const pointsCost = loanAmount * (points / 100); // 1 point = 1% of loan amount
  const closingPct = loanType === "fha" ? 0.035 : loanType === "va" ? 0.025 : 0.03;
  const closingCosts = loanAmount * closingPct + pointsCost;

  const apr = scenarioAPR({
    loanType,
    loanAmount,
    ratePct: rate,
    termMonths,
    monthlyMI: mi,
    purchasePrice,
    pointsCost,
  });

  return {
    loanType,
    loanTerm: termYears,
    interestRate: rate.toFixed(3),
    apr: apr.toFixed(3),
    points: String(points),
    pointsCost: pointsCost.toFixed(2),
    monthlyPayment: (pi + tax + insurance + mi).toFixed(2),
    principalAndInterest: pi.toFixed(2),
    propertyTax: tax.toFixed(2),
    homeInsurance: insurance.toFixed(2),
    pmi: mi.toFixed(2),
    loanAmount: loanAmount.toFixed(2),
    closingCosts: closingCosts.toFixed(2),
    cashToClose: (downPayment + closingCosts).toFixed(2),
    totalInterestPaid: (pi * termMonths - loanAmount).toFixed(2),
    downPaymentAmount: downPayment.toFixed(2),
    downPaymentPercent: ((downPayment / purchasePrice) * 100).toFixed(2),
    isRecommended: opts.isRecommended ?? false,
  };
}

export function buildScenarios(inputs: ScenarioInputs): LoanScenario[] {
  // These legacy comparison cards do not run a cross-product eligibility
  // search. They must stay inside the program the current decision evaluated;
  // borrower traits such as veteran or first-time-buyer status never add a
  // different product behind the borrower's selection.
  if (inputs.selectedLoanProgram === "CONVENTIONAL") {
    return [
      buildScenario("conventional", inputs, { isRecommended: true }),
      buildScenario("conventional", inputs, { points: 1 }),
      // 15-year fixed: same deterministic model, shorter amortization — shows
      // the equity-velocity trade-off (higher payment, far less total interest).
      buildScenario("conventional", inputs, { termYears: 15 }),
    ];
  }
  if (inputs.selectedLoanProgram === "FHA") {
    return [buildScenario("fha", inputs, { isRecommended: true })];
  }
  if (inputs.selectedLoanProgram === "VA" && inputs.isVeteran) {
    return [buildScenario("va", inputs, { isRecommended: true })];
  }
  // USDA/Jumbo/ARM/HELOC/other products have no implementation in this legacy
  // card builder. An empty set is honest; the decision reason routes the file
  // to a loan officer without fabricating a conventional option.
  return [];
}

/**
 * Maximum purchase price the borrower's income supports at the policy DTI cap,
 * solved in closed form from the same payment model as the scenarios:
 *
 *   budget = dtiCap * monthlyIncome - monthlyDebts        (max total PITI)
 *   budget = loan*k + (loan+down)*t/12 + ins + loan*p/12  (payment at price)
 *   =>  loan = (budget - ins - down*t/12) / (k + t/12 + p/12)
 *
 * where k is the amortization factor, t the annual tax rate, p the annual
 * PMI rate (0 when the resulting LTV would be <= 80%).
 */
function maxQualifyingPurchase(
  dtiCapPct: number,
  monthlyIncome: number,
  monthlyDebts: number,
  downPayment: number,
  creditScore: number,
): number {
  const budget = (dtiCapPct / 100) * monthlyIncome - monthlyDebts;
  if (budget <= 0) return 0;

  const rate = baseRateFor("conventional", creditScore);
  const n = 360;
  const k = paymentFactor(rate, n);
  const t = 0.012; // annual property-tax model (matches loanEstimate)
  const ins = 150; // flat monthly insurance floor ($1,800/yr conservative)

  const solve = (pmiAnnual: number) => {
    const loan = (budget - ins - (downPayment * t) / 12) / (k + t / 12 + pmiAnnual / 12);
    return loan > 0 ? loan : 0;
  };

  // First assume PMI applies; if the solved LTV is actually <= 80%, re-solve without.
  let loan = solve(0.006);
  const price = loan + downPayment;
  if (price > 0 && loan / price <= 0.8) {
    loan = solve(0);
  }
  const maxPrice = loan + downPayment;
  return Math.floor(maxPrice / 1000) * 1000;
}

/** Friendly rewrite of engine-internal error strings that surface as gaps. */
function friendlyMissingItems(items: string[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (/VA PROTOCOL/i.test(item)) {
      out.push("Household size (required for VA residual-income review, VA Pamphlet 26-7, Ch. 4)");
      out.push("Home square footage (required for the VA utility-cost calculation)");
    } else if (/CRITICAL/i.test(item)) {
      out.push("Additional underwriting inputs are required — an underwriter will follow up.");
    } else {
      out.push(item);
    }
  }
  return out;
}

export async function analyzeIntake(
  applicationId: string,
  trigger = "intake",
): Promise<IntakeAnalysisResult> {
  const app = await storage.getLoanApplication(applicationId);
  if (!app) {
    throw new Error("Application not found");
  }

  // Compute the decision AND stamp an immutable snapshot. Initial submission
  // uses "intake"; later URLA saves name the facts that changed.
  const decision = await recalculateDecision(applicationId, trigger);

  const purchasePrice = toNumber(app.purchasePrice);
  const downPayment = toNumber(app.downPayment);
  const loanAmount = purchasePrice - downPayment;
  const creditScore = app.creditScore ?? 0;
  const monthlyIncome = decision?.metrics?.monthlyIncome ?? toNumber(app.annualIncome) / 12;
  const monthlyDebts = decision?.metrics?.monthlyDebts ?? toNumber(app.monthlyDebts);

  const scenarios =
    purchasePrice > 0 && loanAmount > 0 && creditScore > 0
      ? buildScenarios({
          purchasePrice,
          downPayment,
          loanAmount,
          creditScore,
          isVeteran: app.isVeteran ?? false,
          isFirstTimeBuyer: app.isFirstTimeBuyer ?? false,
          enginePmiMonthly: decision?.metrics ? decision.metrics.pmiMonthly : null,
          selectedLoanProgram: decision?.loanProgram ?? null,
        })
      : [];

  const strengths: string[] = [];
  const concerns: string[] = [];
  const recommendations: string[] = [];

  const conventionalFicoFloor = decision?.resolvedPolicy?.conventionalFicoFloor;
  if (
    creditScore > 0 &&
    decision?.loanProgram === "CONVENTIONAL" &&
    typeof conventionalFicoFloor === "number" &&
    creditScore >= conventionalFicoFloor
  ) {
    strengths.push(
      `Credit score: ${creditScore} (${conventionalFicoFloor} minimum resolved for this conventional decision)`,
    );
  }
  if (purchasePrice > 0 && downPayment > 0) {
    strengths.push(
      `Down payment: ${((downPayment / purchasePrice) * 100).toFixed(1)}% ($${downPayment.toLocaleString()})`,
    );
  }
  if (app.employmentYears) {
    strengths.push(`Employment: ${app.employmentType ?? "employed"}, ${app.employmentYears} years`);
  }

  const metrics = decision?.metrics ?? null;
  if (metrics) {
    if (metrics.monthsOfReserves > 0) {
      strengths.push(
        `Verified reserves: ${metrics.monthsOfReserves} months of PITI (post-haircut, Fannie Mae B3-4.1)`,
      );
    }
    if (metrics.pmiMonthly > 0) {
      recommendations.push(
        `PMI of $${metrics.pmiMonthly.toFixed(2)}/mo applies while LTV exceeds 80% — cancellable at 80% by request, auto-terminating at 78% (Homeowners Protection Act, 12 U.S.C. §4902)`,
      );
    }
  }
  if (app.isVeteran) {
    recommendations.push(
      "VA eligibility: $0-down purchase with no monthly mortgage insurance; qualification uses residual income, not DTI alone (VA Pamphlet 26-7, Ch. 4)",
    );
  }

  // Engine reasons are already threshold-cited — pass them through verbatim.
  if (decision) {
    concerns.push(...decision.reasons);
    if (decision.status === "NEEDS_MORE_INFO") {
      concerns.push(...friendlyMissingItems(decision.missingItems));
    }
    if (decision.decision === "MANUAL_REVIEW" && metrics) {
      concerns.push(
        `DTI of ${metrics.dti.toFixed(2)}% exceeds the 43% manual-underwriting cap (Reg Z ATR/QM, 12 CFR §1026.43; Fannie Mae B3-6-02) — eligible only with AUS approval, up to the 50% ceiling`,
      );
    }
    if (decision.qualifier === "PRELIMINARY") {
      recommendations.push(
        "Figures are based on self-reported information — verifying income and assets upgrades this to a decision-grade result",
      );
    }
  } else {
    concerns.push("Automated evaluation was unavailable — an underwriter will review your application.");
  }

  // The deterministic engine may calculate a useful planning candidate from
  // self-reported facts. That is not an issued pre-approval. Only the verified
  // data grade may change outward status, create options, notify the borrower,
  // or support a formal letter.
  const isApproved = decision?.decision === "APPROVED" && decision.qualifier === "VERIFIED";
  const isPreliminaryCandidate =
    decision?.decision === "APPROVED" && decision.qualifier === "PRELIMINARY";

  let preApprovalAmount = "0";
  if (isApproved && monthlyIncome > 0) {
    if (decision?.loanProgram === "CONVENTIONAL") {
      // Size from the exact cap already captured by the decision. Reading the
      // mutable policy store again here could combine an approval from policy A
      // with an amount from policy B if policy changed between the two reads.
      const dtiCapPct = decision.resolvedPolicy?.conventionalDtiCapPct;
      if (typeof dtiCapPct !== "number" || !Number.isFinite(dtiCapPct) || dtiCapPct < 30 || dtiCapPct > 60) {
        throw new Error(
          `CRITICAL COMPLIANCE ERROR: CONVENTIONAL_DTI_CAP is outside the permitted 30%-60% range (${dtiCapPct})`,
        );
      }
      const maxPrice = maxQualifyingPurchase(dtiCapPct, monthlyIncome, monthlyDebts, downPayment, creditScore);
      // Never issue less than the price the engine just approved.
      preApprovalAmount = String(Math.max(maxPrice, purchasePrice));
    } else {
      // The VA engine evaluates the requested loan, including residual income,
      // but the maximum-purchase calculator is conventional-only. Preserve the
      // approved request without extrapolating a larger VA amount through a
      // conventional DTI formula.
      preApprovalAmount = String(purchasePrice);
      recommendations.push(
        "The requested VA purchase was evaluated; a higher VA pre-approval amount requires program-specific review by the loan team.",
      );
    }
  }

  // A pre-approval must be for a positive amount. If the engine approved but the
  // qualifying math yields no coherent amount (e.g. income missing/zero), route
  // to human review rather than persisting an incoherent $0 pre-approval (#7).
  const approvedForAmount = isApproved && parseFloat(preApprovalAmount) > 0;

  return {
    outcome: approvedForAmount ? "pre_approved" : "under_review",
    isApproved: approvedForAmount,
    isPreliminaryCandidate,
    preApprovalAmount,
    dtiRatio: metrics ? metrics.dti.toFixed(2) : "0",
    ltvRatio: metrics ? metrics.ltv.toFixed(2) : "0",
    analysis: { strengths, concerns, recommendations },
    scenarios,
    decision,
  };
}

const REFRESHABLE_INTAKE_STATUSES = new Set(["under_review", "pre_approved"]);

/**
 * Reconcile borrower/staff-facing preliminary analysis after URLA facts change.
 *
 * A URLA save used to append a decision snapshot while leaving the application
 * row's DTI, pre-approval amount, status, and loan options untouched. Every UI
 * then showed an older answer than the decision history. This function keeps
 * those projections together for files that are still in the preliminary
 * intake phase. It may promote under_review -> pre_approved after verified facts
 * are supplied. If changed facts no longer support the issued state, it removes
 * the stale amount/options and routes the file to review; that is a review state,
 * never an automated denial.
 */
export async function refreshEarlyStageIntakeAnalysis(
  applicationId: string,
  trigger: string,
): Promise<IntakeAnalysisResult | null> {
  const application = await storage.getLoanApplication(applicationId);
  if (!application || !REFRESHABLE_INTAKE_STATUSES.has(application.status)) return null;

  const result = await analyzeIntake(applicationId, trigger);
  const promotesToPreApproval =
    application.status === "under_review" && result.outcome === "pre_approved";
  const retractsStalePreApproval =
    application.status === "pre_approved" && result.outcome !== "pre_approved";

  await storage.updateLoanApplication(applicationId, {
    ...(promotesToPreApproval ? { status: "pre_approved" } : {}),
    ...(retractsStalePreApproval ? { status: "under_review" } : {}),
    preApprovalAmount: result.preApprovalAmount,
    dtiRatio: result.dtiRatio,
    ltvRatio: result.ltvRatio,
    aiAnalysis: result.analysis,
    aiAnalyzedAt: new Date(),
  });

  // Rebuild quoted options from the same facts as the refreshed headline. A
  // preliminary candidate or review state has no issued options to present.
  await storage.deleteLoanOptionsByApplication(applicationId);
  if (result.isApproved) {
    for (const scenario of result.scenarios) {
      await storage.createLoanOption({ applicationId, ...scenario });
    }
  }

  if (retractsStalePreApproval) {
    try {
      const { syncApplicationStatusToStateMachine } = await import("./optimizationEngine");
      await syncApplicationStatusToStateMachine(application.userId, applicationId, "under_review");
    } catch (syncErr) {
      console.warn("[Analysis] Pre-approval review state sync failed (non-fatal):", syncErr);
    }
    try {
      await storage.createDealActivity({
        applicationId,
        activityType: "status_change",
        title: "Pre-Approval Needs Review",
        description: "New application facts no longer support the prior automated amount. The file has been routed to the loan team for review; no denial was issued.",
      });
      await storage.createNotification({
        userId: application.userId,
        type: "application_under_review",
        title: "Your mortgage plan needs review",
        body: "Your application changed, so the prior pre-approval amount is no longer current. Your loan team will review the updated facts and your dashboard shows any documents needed next.",
        entityType: "loan_application",
        entityId: applicationId,
        status: "unread",
      });
    } catch (notificationErr) {
      console.warn("[Analysis] Pre-approval review notification failed (non-fatal):", notificationErr);
    }
  }

  if (promotesToPreApproval) {
    try {
      const { recordStageTimestamp } = await import("./outcomeTracker");
      await recordStageTimestamp(applicationId, "pre_approved");
    } catch (outcomeErr) {
      console.warn("[Analysis] URLA promotion outcome stamp failed (non-fatal):", outcomeErr);
    }
    try {
      const { syncApplicationStatusToStateMachine } = await import("./optimizationEngine");
      await syncApplicationStatusToStateMachine(application.userId, applicationId, "pre_approved");
    } catch (syncErr) {
      console.warn("[Analysis] URLA promotion state sync failed (non-fatal):", syncErr);
    }
    try {
      const amount = (parseFloat(result.preApprovalAmount) || 0).toLocaleString();
      await storage.createDealActivity({
        applicationId,
        activityType: "status_change",
        title: "Pre-Approval Updated",
        description: `The completed application supports a preliminary pre-approval up to $${amount}. Final terms remain subject to document and underwriting review.`,
      });
      await storage.createNotification({
        userId: application.userId,
        type: "application_pre_approved",
        title: "Your application was updated",
        body: `Your preliminary pre-approval is now up to $${amount}. Next, upload the requested documents so your loan team can verify the file.`,
        entityType: "loan_application",
        entityId: applicationId,
        status: "unread",
      });
    } catch (notificationErr) {
      console.warn("[Analysis] URLA promotion notification failed (non-fatal):", notificationErr);
    }
  }

  return result;
}

// Pre-analysis statuses this finalizer is allowed to act on. Anything further
// along the pipeline is left alone — finalizeIntake never rewinds a live file.
const FINALIZABLE_STATUSES = new Set(["draft", "submitted", "analyzing"]);

/**
 * Run the full intake finalization for one application: deterministic decision,
 * loan options, status, deal activity, borrower notification, pipeline init,
 * and pre-underwriting. Extracted from the POST /api/loan-applications handler
 * so the SAME path can be re-driven if a downstream drop (DB/process restart)
 * strands an application mid-analysis.
 *
 * Idempotent by construction: options are cleared before re-creation, and the
 * status guard prevents acting on an application that has moved on. On failure
 * it resets the status to "submitted" so the recovery sweep will retry.
 */
export async function finalizeIntake(applicationId: string): Promise<void> {
  const app = await storage.getLoanApplication(applicationId);
  if (!app) return;
  if (!FINALIZABLE_STATUSES.has(app.status)) return; // already progressed — leave it

  const userId = app.userId;
  const borrower = await storage.getUser(userId);
  const borrowerName = borrower?.firstName || "Borrower";

  try {
    await storage.updateLoanApplication(applicationId, { status: "analyzing" });
    try {
      const { syncApplicationStatusToStateMachine } = await import("./optimizationEngine");
      await syncApplicationStatusToStateMachine(userId, applicationId, "analyzing");
    } catch (syncErr) {
      console.warn("[OPT-5] State sync failed for analyzing (non-fatal):", syncErr);
    }

    // Decisioning reads subject-property facts from URLA. The fast intake also
    // stores them on the application for pricing, so reconcile the two before
    // any outcome is calculated. A failed sync is retryable and must not
    // degrade into an analysis that silently assumes the property details.
    if (app.occupancyType) {
      await storage.upsertUrlaPropertyInfo({
        applicationId,
        occupancyType: app.occupancyType,
        numberOfUnits: app.numberOfUnits ?? (app.propertyType === "multi_family" ? null : 1),
        estimatedMarketRent: app.subjectMonthlyRentalIncome ?? null,
      });
    }

    const analysisResult = await analyzeIntake(applicationId);
    const newStatus = analysisResult.outcome;

    await storage.updateLoanApplication(applicationId, {
      preApprovalAmount: analysisResult.preApprovalAmount,
      dtiRatio: analysisResult.dtiRatio,
      ltvRatio: analysisResult.ltvRatio,
      aiAnalysis: analysisResult.analysis,
      aiAnalyzedAt: new Date(),
    });

    // Clear then recreate options so a re-drive never duplicates scenarios.
    try {
      await storage.deleteLoanOptionsByApplication(applicationId);
    } catch (delErr) {
      console.error("[Analysis] Failed to clear prior loan options (non-fatal):", delErr);
    }
    if (analysisResult.isApproved) {
      for (const scenario of analysisResult.scenarios) {
        try {
          await storage.createLoanOption({ applicationId, ...scenario });
        } catch (optErr) {
          console.error("[Analysis] Failed to create loan option:", optErr);
        }
      }
    }

    // Document collection starts for BOTH outcomes. This used to run only for
    // auto-approved files, which left an under_review borrower with zero
    // conditions and zero tasks — every action surface (dashboard nextAction,
    // borrower tasks, the document checklist, /loan-options next steps)
    // rendered "nothing needed from you" at the exact moment verification
    // documents were the one thing that could move the file. The requirements
    // engine is deterministic off the borrower's own answers, and both
    // generators are idempotent, so a later human approval re-drives safely.
    // A settled status tells every borrower surface that analysis is finished.
    // Keep the file in `analyzing` until its conditions and upload tasks exist;
    // otherwise the first dashboard render can truthfully read the status but
    // receive a partial checklist until the next 30-second refresh.
    const updatedApp = await storage.getLoanApplication(applicationId);
    if (!updatedApp) throw new Error("Application disappeared during intake finalization");
    const { initializeLoanPipeline } = await import("../pipelineEngine");
    await initializeLoanPipeline(updatedApp, userId);
    await storage.createDealActivity({
      applicationId,
      activityType: "status_change",
      title: "Document Collection Started",
      description: analysisResult.isApproved
        ? "Required documents have been identified. Please upload them to continue your application."
        : analysisResult.isPreliminaryCandidate
          ? "Your preliminary plan is ready. Upload the requested documents so the loan team can verify your income, assets, and property details."
          : "Required documents have been identified. Uploading them now gives your loan team what they need to review your file.",
    });

    try {
      const { runPreUnderwriting } = await import("./preUnderwriting");
      await runPreUnderwriting(applicationId, "intake");
    } catch (preUwErr) {
      console.error("[Analysis] Pre-underwriting validation failed (non-fatal):", preUwErr);
    }

    await storage.updateLoanApplication(applicationId, { status: newStatus });
    try {
      const { syncApplicationStatusToStateMachine } = await import("./optimizationEngine");
      await syncApplicationStatusToStateMachine(userId, applicationId, newStatus);
    } catch (syncErr) {
      console.warn(`[OPT-5] State sync failed for ${newStatus} (non-fatal):`, syncErr);
    }

    // The automated intake decision sets pre_approved directly (not via
    // updatePipelineStage), so record the outcome timestamp here too — otherwise
    // the conversion funnel would miss the whole auto-pre-approval path.
    try {
      const { recordStageTimestamp } = await import("./outcomeTracker");
      await recordStageTimestamp(applicationId, newStatus);
    } catch (outcomeErr) {
      console.warn("[Analysis] Outcome stamp failed (non-fatal):", outcomeErr);
    }
    try {
      const firstReason = analysisResult.analysis.concerns[0];
      const preliminary = analysisResult.isPreliminaryCandidate;
      await storage.createDealActivity({
        applicationId,
        activityType: "status_change",
        title: analysisResult.isApproved
          ? "Pre-Approval Issued"
          : preliminary
            ? "Preliminary Mortgage Plan Ready"
            : "Application Under Review",
        description: analysisResult.isApproved
          ? `Pre-approval issued for up to $${(parseFloat(analysisResult.preApprovalAmount) || 0).toLocaleString()}. Final terms subject to underwriting review.`
          : preliminary
            ? "Your self-reported information supports a preliminary mortgage plan. Upload the requested documents so the loan team can verify the figures; no pre-approval has been issued yet."
          : firstReason
            ? `A licensed underwriter will review your application. Flagged for review: ${firstReason}`
            : "A licensed underwriter will review your application.",
      });
    } catch (actErr) {
      console.error("[Analysis] Failed to create deal activity:", actErr);
    }

    try {
      const { sendNotificationEmail } = await import("./emailService");
      if (analysisResult.isApproved) {
        await storage.createNotification({
          userId,
          type: "application_pre_approved",
          title: "Pre-Approval Issued",
          body: `Your pre-approval has been issued for up to $${(parseFloat(analysisResult.preApprovalAmount) || 0).toLocaleString()}. Final terms are subject to underwriting review.`,
          entityType: "loan_application",
          entityId: applicationId,
          status: "unread",
        });
        if (borrower?.email) {
          sendNotificationEmail({
            type: "application_pre_approved",
            recipientEmail: borrower.email,
            data: { borrowerName, amount: (parseFloat(analysisResult.preApprovalAmount) || 0).toLocaleString(), applicationId },
          });
        }
      } else {
        const preliminary = analysisResult.isPreliminaryCandidate;
        await storage.createNotification({
          userId,
          type: "application_under_review",
          title: preliminary ? "Your preliminary mortgage plan is ready" : "Application Under Review",
          body: preliminary
            ? "Your self-reported information supports a preliminary plan. Upload the requested documents so your loan team can verify the figures; no pre-approval has been issued yet."
            : "Your application needs review by the loan team. Check your dashboard to see what was flagged and what happens next.",
          entityType: "loan_application",
          entityId: applicationId,
          status: "unread",
        });
        if (borrower?.email) {
          // The single submission email for this path — receipt + what an
          // underwriter review means + what the borrower can do now. The
          // generic status_update template stays for staff-driven status
          // changes; this moment needs the action-oriented one.
          sendNotificationEmail({
            type: preliminary ? "application_preliminary_plan" : "application_under_review",
            recipientEmail: borrower.email,
            data: { borrowerName, applicationId },
          });
        }
      }
    } catch (notifErr) {
      console.error("[Analysis] Failed to send notifications:", notifErr);
    }

  } catch (analysisError) {
    console.error(`[Analysis] finalizeIntake failed for ${applicationId}:`, analysisError);
    // Reset so the application isn't stranded in "analyzing" — the recovery
    // sweep (or a resubmit) will re-drive from "submitted".
    await storage.updateLoanApplication(applicationId, { status: "submitted" }).catch(() => {});
    throw analysisError;
  }
}

/**
 * Recovery sweep: re-drive any application stranded in "analyzing" past the
 * grace window (a downstream drop or process restart mid-finalize). Safe to
 * run repeatedly — finalizeIntake is idempotent and status-guarded.
 */
export async function recoverStuckIntakeApplications(
  graceMinutes = 10,
): Promise<{ scanned: number; recovered: number }> {
  const { db } = await import("../db");
  const { loanApplications } = await import("@shared/schema");
  const { and, eq, lt } = await import("drizzle-orm");
  const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000);

  const stuck = await db
    .select({ id: loanApplications.id })
    .from(loanApplications)
    .where(and(eq(loanApplications.status, "analyzing"), lt(loanApplications.updatedAt, cutoff)));

  let recovered = 0;
  for (const row of stuck) {
    try {
      await finalizeIntake(row.id);
      recovered += 1;
    } catch (err) {
      console.error(`[Analysis] Recovery failed for ${row.id} (will retry next sweep):`, err);
    }
  }
  if (stuck.length > 0) {
    console.log(`[Analysis] Stuck-intake recovery: ${recovered}/${stuck.length} re-driven`);
  }
  return { scanned: stuck.length, recovered };
}
