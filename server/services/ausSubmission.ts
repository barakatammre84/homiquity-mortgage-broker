import { createHash } from "node:crypto";
import { plaidClient } from "../plaid";
import { COMPANY_IDENTITY } from "@shared/companyIdentity";

/**
 * AUS (Automated Underwriting System) submission service.
 *
 * Orchestrates the GSE leg of the digital pre-approval pipeline:
 *   Plaid asset report parsing → DU casefile payload → DU Messages API
 *   (Fannie Mae Desktop Underwriter, 12.1-shaped) → Day 1 Certainty parsing
 *   → structured commitment letter.
 *
 * Like server/mcp/vendors.ts, external calls are gated on env credentials and
 * fall back to clearly-flagged deterministic simulations until vendor/GSE
 * access exists. Real DU access requires Fannie Mae technology approval — an
 * onboarding process, not just an API key — so the simulation preserves the
 * exact seams where the real integration lands.
 */

const AUS_TIMEOUT_MS = Number(process.env.AUS_TIMEOUT_MS ?? 15_000);

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${AUS_TIMEOUT_MS}ms`)), AUS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Deterministic pseudo-random in [0,1) from a seed (stable simulations). */
function seeded(seed: string): number {
  return createHash("sha256").update(seed).digest().readUInt32BE(0) / 0xffffffff;
}

// ---------------------------------------------------------------------------
// Plaid asset report parsing
// ---------------------------------------------------------------------------

export interface ParsedAssetReport {
  simulated: boolean;
  assetReportId: string;
  institutionCount: number;
  accountCount: number;
  totalBalance: number;
  avgMonthlyBalance: number;
  payroll: { employerName: string; avgMonthlyDeposit: number; monthsObserved: number };
  transactionTrend: "stable" | "growing" | "declining";
  /** Depository transactions (negative = inflow) — feeds B3-4.2-02 large-deposit sourcing. */
  transactions: Array<{ amount: number; date: string; description?: string }>;
}

export async function parsePlaidAssetReport(assetReportToken: string): Promise<ParsedAssetReport> {
  if (process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET) {
    const { data } = await withTimeout(
      plaidClient.assetReportGet({ asset_report_token: assetReportToken }),
      "Plaid /asset_report/get",
    );
    const report = data.report;
    const accounts = report.items.flatMap((item) => item.accounts ?? []);
    const totalBalance = accounts.reduce((s, a) => s + (a.balances.current ?? 0), 0);
    return {
      simulated: false,
      assetReportId: report.asset_report_id,
      institutionCount: report.items.length,
      accountCount: accounts.length,
      totalBalance,
      // Plaid exposes historical_balances per account; average across the window.
      avgMonthlyBalance: Math.round(
        accounts.reduce((s, a) => {
          const hist = a.historical_balances ?? [];
          const avg = hist.length ? hist.reduce((x, h) => x + (h.current ?? 0), 0) / hist.length : (a.balances.current ?? 0);
          return s + avg;
        }, 0),
      ),
      payroll: { employerName: "(see transactions)", avgMonthlyDeposit: 0, monthsObserved: report.days_requested ? Math.round(report.days_requested / 30) : 0 },
      transactionTrend: "stable",
      transactions: accounts.flatMap((a) =>
        (a.transactions ?? []).map((t) => ({
          amount: t.amount,
          date: t.date,
          description: t.original_description ?? undefined,
        })),
      ),
    };
  }

  // Simulation (no Plaid credentials configured)
  const s = assetReportToken.toLowerCase();
  const totalBalance = 20_000 + Math.round(seeded(s) * 180_000);
  const avgDeposit = 4_000 + Math.round(seeded(s + "pay") * 8_000);
  const trends: ParsedAssetReport["transactionTrend"][] = ["stable", "growing", "declining"];
  return {
    simulated: true,
    assetReportId: `sim-voa-${createHash("sha1").update(s).digest("hex").slice(0, 12)}`,
    institutionCount: 1 + Math.round(seeded(s + "inst") * 2),
    accountCount: 2 + Math.round(seeded(s + "acct") * 3),
    totalBalance,
    avgMonthlyBalance: Math.round(totalBalance * 0.82),
    payroll: {
      employerName: "Acme Analytics LLC",
      avgMonthlyDeposit: avgDeposit,
      monthsObserved: 12,
    },
    transactionTrend: trends[Math.floor(seeded(s + "trend") * trends.length)],
    // ~35% of simulated profiles carry one large unsourced deposit within the
    // last 30 days (the "mattress money" nuance — B3-4.2-02 sourcing rule).
    transactions:
      seeded(s + "bigdep") < 0.35
        ? [
            {
              amount: -(4_000 + Math.round(seeded(s + "depamt") * 12_000)),
              date: new Date(Date.now() - Math.round(seeded(s + "depage") * 25 + 3) * 24 * 3600 * 1000)
                .toISOString()
                .slice(0, 10),
              description: "TRANSFER CREDIT — PERSONAL",
            },
          ]
        : [],
  };
}

// ---------------------------------------------------------------------------
// Fannie Mae DU (Desktop Underwriter) Messages API — 12.1-shaped
// ---------------------------------------------------------------------------

/**
 * The qualifying debt-to-income ratio for a DU casefile.
 *
 * B3-6-02 (Debt-to-Income Ratios) with B3-6-03 (Monthly Housing Expense for the Subject
 * Property): the ratio is TOTAL monthly obligations, which INCLUDES the proposed housing
 * payment. Recurring debts alone is the back-end ratio and understates every purchase file.
 *
 * Returns null when any input is unavailable. That is deliberate and it is the safer
 * direction: A2-2-04 conditions the DU limited waiver on the casefile being "complete,
 * accurate, and not fraudulent", so an absent ratio — which DU will ask for — beats a
 * knowingly understated one that could earn an Approve/Eligible the file has not earned.
 *
 * `monthlyDebts` of 0 is a real value, not a missing one: a borrower with no other
 * obligations still has a DTI from the housing payment alone.
 */
export function computeCasefileDti(input: {
  monthlyIncome: number | null;
  monthlyDebts: number | null;
  proposedHousingPayment: number | null;
}): number | null {
  const { monthlyIncome, monthlyDebts, proposedHousingPayment } = input;
  if (!monthlyIncome || monthlyIncome <= 0) return null;
  if (monthlyDebts === null || proposedHousingPayment === null) return null;
  if (!Number.isFinite(monthlyDebts) || !Number.isFinite(proposedHousingPayment)) return null;
  return Number(((monthlyDebts + proposedHousingPayment) / monthlyIncome).toFixed(4));
}

export interface DuCasefileInput {
  applicationId: string;
  loanAmount: number;
  propertyValue: number;
  creditScore: number | null;
  dti: number | null; // ratio, e.g. 0.36
  voaReportId: string | null;
  voieReportId: string | null;
  auditCopyToken: string | null;
  decisionPath?: "automated" | "manual_underwrite";
  manualUnderwriteReasons?: string[];
}

export interface DuFindings {
  simulated: boolean;
  casefileId: string;
  duVersion: string;
  recommendation: "approve_eligible" | "approve_ineligible" | "refer" | "refer_with_caution";
  riskAssessment: { dti: number | null; ltv: number; creditScore: number | null };
  day1Certainty: {
    assets: { relief: boolean; reportId: string | null; reason: string };
    income: { relief: boolean; reportId: string | null; reason: string };
    employment: { relief: boolean; reportId: string | null; reason: string };
  };
  messages: Array<{ code: string; severity: "info" | "condition" | "risk"; text: string }>;
  decisionPath: "automated" | "manual_underwrite";
  inputIntegrity?: {
    version: string;
    inputFingerprint: string;
    evidenceFingerprint: string;
    decisionInputsFingerprint: string;
    policyFingerprint: string | null;
    decisionPath: "automated" | "manual_underwrite";
  };
}

export async function submitToDU(input: DuCasefileInput): Promise<DuFindings> {
  if (process.env.FANNIE_DU_API_KEY) {
    throw new Error(
      "FANNIE_DU_API_KEY is set but the live DU adapter is not implemented yet — DU access requires " +
        "Fannie Mae technology-provider onboarding. Remove the key to use simulation.",
    );
  }

  const ltv = input.propertyValue > 0 ? input.loanAmount / input.propertyValue : 1;
  const messages: DuFindings["messages"] = [];
  const casefileId = `sim-du-${createHash("sha1").update(input.applicationId).digest("hex").slice(0, 10)}`;

  // Recommendation logic mirroring DU's headline gates (simplified).
  let recommendation: DuFindings["recommendation"] = "approve_eligible";
  if (input.decisionPath === "manual_underwrite") {
    recommendation = "refer_with_caution";
    messages.push({
      code: "HMQ-MANUAL-001",
      severity: "condition",
      text: input.manualUnderwriteReasons?.[0] ?? "File is outside the automated underwriting scope and requires manual underwriting.",
    });
  }
  if (input.creditScore === null || input.creditScore < 620) {
    recommendation = "refer";
    messages.push({ code: "DU-3001", severity: "risk", text: "Credit score below conventional minimum (620) or unavailable." });
  }
  if (input.dti !== null && input.dti > 0.5) {
    recommendation = recommendation === "refer" ? "refer_with_caution" : "refer";
    messages.push({ code: "DU-3202", severity: "risk", text: `DTI ${(input.dti * 100).toFixed(1)}% exceeds the 50% DU ceiling.` });
  }
  if (ltv > 0.97) {
    recommendation = "approve_ineligible";
    messages.push({ code: "DU-2105", severity: "condition", text: `LTV ${(ltv * 100).toFixed(1)}% exceeds 97% conforming maximum.` });
  }

  // Day 1 Certainty: relief only on layers backed by a validated report.
  const d1c = (reportId: string | null, layer: string) =>
    reportId
      ? { relief: recommendation === "approve_eligible", reportId, reason: recommendation === "approve_eligible" ? `${layer} validated via ${reportId}` : "Relief withheld: casefile not Approve/Eligible" }
      : { relief: false, reportId: null, reason: `No validated ${layer.toLowerCase()} report on the casefile` };

  const findings: DuFindings = {
    simulated: true,
    casefileId,
    duVersion: "12.1",
    recommendation,
    riskAssessment: { dti: input.dti, ltv: Number(ltv.toFixed(4)), creditScore: input.creditScore },
    day1Certainty: {
      assets: d1c(input.voaReportId, "Assets"),
      income: d1c(input.voieReportId, "Income"),
      employment: d1c(input.voieReportId, "Employment"),
    },
    messages: messages.length ? messages : [{ code: "DU-0001", severity: "info", text: "Casefile underwritten with no adverse findings." }],
    decisionPath: input.decisionPath ?? "automated",
  };

  return await withTimeout(Promise.resolve(findings), "DU Messages API");
}

// ---------------------------------------------------------------------------
// Freddie Mac LPA (Loan Product Advisor) — second AUS leg
//
// Broker doctrine is dual-AUS: run DU and LPA on the same casefile inputs so
// lender selection can follow whichever engine reads the file better. Same
// seam discipline as DU: env-gated real integration (Freddie onboarding
// required), deterministic simulation until then. LPA's headline outputs are
// a risk class (Accept/Caution) and purchase eligibility.
// ---------------------------------------------------------------------------

export interface LpaFindings {
  simulated: boolean;
  /** Our assessment identifier (the live integration will carry Freddie's key). */
  assessmentId: string;
  riskClass: "accept" | "caution";
  purchaseEligibility: "eligible" | "ineligible";
  riskAssessment: { dti: number | null; ltv: number; creditScore: number | null };
  messages: Array<{ code: string; severity: "info" | "condition" | "risk"; text: string }>;
  decisionPath: "automated" | "manual_underwrite";
}

export async function submitToLPA(input: DuCasefileInput): Promise<LpaFindings> {
  if (process.env.FREDDIE_LPA_API_KEY) {
    throw new Error(
      "FREDDIE_LPA_API_KEY is set but the live LPA adapter is not implemented yet — LPA access requires " +
        "Freddie Mac onboarding. Remove the key to use simulation.",
    );
  }

  const ltv = input.propertyValue > 0 ? input.loanAmount / input.propertyValue : 1;
  const messages: LpaFindings["messages"] = [];
  const assessmentId = `sim-lpa-${createHash("sha1").update(input.applicationId).digest("hex").slice(0, 10)}`;

  // Headline gates mirroring the DU simulation so the two legs are
  // comparable; deliberately NOT identical outcomes — LPA reads borderline
  // DTI slightly differently (45–50% takes Caution where the DU sim refers
  // only above 50%), which is the realistic dual-AUS spread lenders exploit.
  let riskClass: LpaFindings["riskClass"] = "accept";
  let purchaseEligibility: LpaFindings["purchaseEligibility"] = "eligible";

  if (input.decisionPath === "manual_underwrite") {
    riskClass = "caution";
    messages.push({
      code: "HMQ-MANUAL-001",
      severity: "condition",
      text: input.manualUnderwriteReasons?.[0] ?? "File is outside the automated underwriting scope and requires manual underwriting.",
    });
  }

  if (input.creditScore === null || input.creditScore < 620) {
    riskClass = "caution";
    messages.push({ code: "LPA-SIM-101", severity: "risk", text: "Credit score below conventional minimum (620) or unavailable." });
  }
  if (input.dti !== null && input.dti > 0.45) {
    riskClass = "caution";
    messages.push({ code: "LPA-SIM-202", severity: "risk", text: `DTI ${(input.dti * 100).toFixed(1)}% above 45% — Caution risk class in simulation.` });
  }
  if (ltv > 0.97) {
    purchaseEligibility = "ineligible";
    messages.push({ code: "LPA-SIM-301", severity: "condition", text: `LTV ${(ltv * 100).toFixed(1)}% exceeds 97% conforming maximum.` });
  }

  const findings: LpaFindings = {
    simulated: true,
    assessmentId,
    riskClass,
    purchaseEligibility,
    riskAssessment: { dti: input.dti, ltv: Number(ltv.toFixed(4)), creditScore: input.creditScore },
    messages: messages.length ? messages : [{ code: "LPA-SIM-001", severity: "info", text: "Assessment completed with no adverse findings." }],
    decisionPath: input.decisionPath ?? "automated",
  };

  return await withTimeout(Promise.resolve(findings), "LPA assessment");
}

// ---------------------------------------------------------------------------
// Commitment letter
// ---------------------------------------------------------------------------

export interface CommitmentLetter {
  letterId: string;
  letterType: "commitment" | "conditional_commitment" | "declined";
  issuedAt: string;
  expiresAt: string;
  lender: { name: string; nmls: string };
  /**
   * True when the AUS findings behind this letter came from the deterministic
   * simulation rather than a live DU submission. Carried onto the document
   * itself, not just the server log — a reader holding the letter must be able
   * to tell, and the log is not attached to it.
   */
  simulated: boolean;
  borrower: { name: string; applicationId: string };
  property: { address: string | null; value: number };
  loanTerms: { loanAmount: number; ltvPercent: number; dtiPercent: number | null };
  ausResult: { casefileId: string; duVersion: string; recommendation: string };
  day1Certainty: { assets: boolean; income: boolean; employment: boolean };
  conditions: string[];
  disclaimer: string;
}

export function buildCommitmentLetter(args: {
  applicationId: string;
  borrowerName: string;
  propertyAddress: string | null;
  loanAmount: number;
  propertyValue: number;
  findings: DuFindings;
}): CommitmentLetter {
  const { findings } = args;
  const approved = findings.recommendation === "approve_eligible";
  const conditional = findings.recommendation !== "approve_eligible" && findings.recommendation !== "approve_ineligible";
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1000);

  return {
    letterId: `HCL-${issuedAt.getFullYear()}-${createHash("sha1").update(args.applicationId + issuedAt.toISOString()).digest("hex").slice(0, 8).toUpperCase()}`,
    letterType: approved ? "commitment" : conditional ? "conditional_commitment" : "declined",
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    // NMLS was hardcoded "PENDING" — false since 2026-07-13, when the company
    // was licensed as #427468. A document issued under the company name stating
    // its own licensure is unresolved is a misstatement about licensure, so it
    // reads from the single source rather than a literal.
    lender: { name: COMPANY_IDENTITY.legalName, nmls: COMPANY_IDENTITY.nmlsId },
    simulated: findings.simulated,
    borrower: { name: args.borrowerName, applicationId: args.applicationId },
    property: { address: args.propertyAddress, value: args.propertyValue },
    loanTerms: {
      loanAmount: args.loanAmount,
      ltvPercent: Number((findings.riskAssessment.ltv * 100).toFixed(2)),
      dtiPercent: findings.riskAssessment.dti !== null ? Number((findings.riskAssessment.dti * 100).toFixed(2)) : null,
    },
    ausResult: { casefileId: findings.casefileId, duVersion: findings.duVersion, recommendation: findings.recommendation },
    day1Certainty: {
      assets: findings.day1Certainty.assets.relief,
      income: findings.day1Certainty.income.relief,
      employment: findings.day1Certainty.employment.relief,
    },
    conditions: findings.messages.filter((m) => m.severity !== "info").map((m) => `[${m.code}] ${m.text}`),
    // A simulated run must say so ON the document, first, before anything a
    // reader could mistake for a commitment. `findings.simulated` is true
    // whenever the DU leg is the deterministic adapter — which is every run
    // today, since a set FANNIE_DU_API_KEY throws rather than going live.
    disclaimer:
      (findings.simulated
        ? "SIMULATED — NOT A REAL UNDERWRITING DECISION. These findings were produced by an " +
          "internal deterministic model, not by Desktop Underwriter, and no automated underwriting " +
          "system has evaluated this file. This document must not be relied on or presented as a " +
          "commitment to lend. "
        : "") +
      "This commitment is based on automated underwriting findings and the information provided. " +
      "It is subject to final verification, property appraisal, and applicable regulatory requirements. " +
      "This is not a loan approval guarantee.",
  };
}
