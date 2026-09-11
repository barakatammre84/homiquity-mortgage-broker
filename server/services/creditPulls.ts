// Credit pull request + deterministic simulation completion + lookups.
// Split from the old server/services/creditService.ts — which re-exports all of it.
import { db } from "../db";
import { creditPulls, adverseActions, type InsertCreditPull, type CreditPull, type AdverseAction } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { encryptSensitiveData, computeHash } from "./encryptionService";
import { logCreditAction } from "./creditAuditChain";
import { getActiveConsent, consentCoversPullType } from "./creditConsents";
import { normalizeBorrowerCreditScores, type BureauScoreSet } from "./decisionCredit";

/**
 * Per-pull vendor cost, in dollars, by pull type.
 *
 * PLATFORM ASSUMPTION — no credit vendor contract exists (roadmap F3), so
 * these are working figures, not contracted rates. They exist so the spend is
 * METERED rather than invisible; replace them with the vendor's actual price
 * sheet when the contract lands. Every entry booked from them is flagged
 * `simulated` while the credit adapter is a simulation, so they cannot leak
 * into a real margin figure. Ledger: `platform-credit-pull-unit-cost`.
 */
export const CREDIT_PULL_UNIT_COST: Record<"soft" | "hard" | "tri_merge", number> = {
  soft: 5,
  hard: 15,
  tri_merge: 30,
};

/** True while the credit vendor leg is the deterministic simulation. */
function creditVendorIsSimulated(): boolean {
  return !process.env.CREDIT_VENDOR_API_KEY;
}

async function recordCreditPullCost(input: {
  applicationId: string;
  creditPullId: string;
  pullType: "soft" | "hard" | "tri_merge";
  bureaus: string[];
  requestedBy: string;
}): Promise<void> {
  const { storage } = await import("../storage");
  const unitCost = CREDIT_PULL_UNIT_COST[input.pullType] ?? 0;
  if (unitCost <= 0) return;

  await storage.createLoanCostEntry({
    applicationId: input.applicationId,
    category: "credit_report",
    vendor: "credit-bureau-adapter",
    amount: unitCost.toFixed(2),
    incurredAt: new Date(),
    automatic: true,
    simulated: creditVendorIsSimulated(),
    description: `${input.pullType} pull (${input.bureaus.join(", ") || "no bureaus listed"}) — pull ${input.creditPullId}`,
    recordedBy: input.requestedBy,
  });
}

export async function requestCreditPull(
  data: {
    applicationId: string;
    consentId: string;
    requestedBy: string;
    pullType: "soft" | "hard" | "tri_merge";
    bureaus: string[];
    ipAddress?: string;
  }
): Promise<CreditPull> {
  const consent = await getActiveConsent(data.applicationId);
  if (!consent || consent.id !== data.consentId) {
    throw new Error("Valid consent required before credit pull");
  }

  // The consent must AUTHORIZE this pull type, not merely exist (F-035).
  // Previously the only check was the id comparison above — which is
  // tautological, since the caller gets that id from getActiveConsent — so a
  // `soft_pull` consent from the pre-approval funnel (whose checkbox promises
  // "a soft inquiry, which will not affect my credit score") unblocked a hard
  // tri-merge pull. Every other consent surface in this codebase already
  // resolves BY TYPE via consentGate.ts; this was the one call site that
  // ignored the taxonomy its own schema declares.
  if (!consentCoversPullType(consent.consentType, data.pullType)) {
    throw new Error(
      `Consent scope mismatch: a "${consent.consentType}" consent does not authorize a "${data.pullType}" pull. ` +
        `Obtain the borrower's authorization for this inquiry type before pulling.`,
    );
  }

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 120);

  const pull: InsertCreditPull = {
    applicationId: data.applicationId,
    consentId: data.consentId,
    requestedBy: data.requestedBy,
    pullType: data.pullType,
    bureaus: data.bureaus,
    status: "pending",
    requestedAt: new Date(),
    expiresAt,
    // Flag at INSERT, not at completion (F-036). `isSimulated` is
    // `default(false).notNull()` and the only other assignment lives inside
    // simulateCreditPullCompletion — which throws in production before
    // reaching it. So a production row used to persist forever as
    // `tri_merge / pending / isSimulated: FALSE`, affirmatively asserting a
    // REAL bureau inquiry that never happened, corroborated by a
    // `pull_requested` entry in the tamper-evident audit chain. The column's
    // own contract is "Surfaced so staff and audit can tell a real pull from a
    // simulated one at a glance." L2 invariant I10 requires flag AND throw;
    // flagging here makes the record true regardless of which path runs next.
    isSimulated: creditVendorIsSimulated(),
  };

  const [result] = await db.insert(creditPulls).values(pull).returning();

  // Meter the cost at the moment we incur it (audit F-11). A tri-merge pull is
  // real money and the task engine deliberately re-runs them (CRD_EXPIRED), so
  // a stalled file quietly accumulates spend. Booked automatically rather than
  // recalled from an invoice later — and flagged `simulated` while the vendor
  // leg is the deterministic simulation, so demo spend never lands in a real
  // margin figure. Non-fatal: a ledger failure must never block a credit pull.
  try {
    await recordCreditPullCost({
      applicationId: data.applicationId,
      creditPullId: result.id,
      pullType: data.pullType,
      bureaus: data.bureaus,
      requestedBy: data.requestedBy,
    });
  } catch (err) {
    console.warn("[creditPulls] cost ledger entry failed (non-fatal):", err);
  }

  await logCreditAction({
    applicationId: data.applicationId,
    creditPullId: result.id,
    consentId: data.consentId,
    action: "pull_requested",
    actionDetails: {
      pullType: data.pullType,
      bureaus: data.bureaus,
    },
    performedBy: data.requestedBy,
    ipAddress: data.ipAddress,
  });

  return result;
}

export async function simulateCreditPullCompletion(
  creditPullId: string,
  simulatedScores?: {
    experian?: number;
    equifax?: number;
    transunion?: number;
  }
): Promise<CreditPull> {
  // INTERLOCK — the two credit-vendor flags must never both be on.
  //
  // CREDIT_VENDOR_API_KEY is a PROVENANCE switch, not a connection setting:
  // while it is unset every row this function writes is stamped
  // `isSimulated: true` (creditVendorIsSimulated, above). Setting it flips that
  // stamp to false. CREDIT_VENDOR_MODE=simulation separately permits this
  // function — which FABRICATES scores with Math.random — to run in production.
  //
  // Together they produce the single worst state available in this codebase:
  // invented bureau scores recorded as a REAL consumer report. Downstream that
  // is not a bad number, it is a falsified regulated record — it would let an
  // FCRA §615(a) adverse-action notice truthfully-looking-ly name a bureau that
  // was never contacted (the check at server/routes/compliance.ts keys off
  // isSimulated, so a false stamp disarms it), and it would book unsimulated
  // cost-ledger entries against a vendor that never invoiced.
  //
  // This refuses at the OPERATION rather than at boot, deliberately. A throw
  // during boot on Railway is near-invisible: the failed deploy leaves the
  // previous container serving, so the site keeps answering 200 while the
  // contradiction persists unnoticed (that is the 2026-08-06 stale-deploy
  // class). Refusing here surfaces as a loud, attributable API error the first
  // time anyone tries a pull.
  //
  // Expected during the F3 handoff: when the live vendor lands, set
  // CREDIT_VENDOR_API_KEY and REMOVE CREDIT_VENDOR_MODE in the same change.
  if (process.env.CREDIT_VENDOR_API_KEY && process.env.CREDIT_VENDOR_MODE === "simulation") {
    throw new Error(
      "Contradictory credit-vendor configuration: CREDIT_VENDOR_API_KEY is set (so pulls are recorded as REAL bureau data) while CREDIT_VENDOR_MODE=simulation permits fabricated scores. Refusing to fabricate a score that would be stamped as a genuine consumer report. Remove CREDIT_VENDOR_MODE now that a live vendor is configured.",
    );
  }

  // Simulated bureau data must never ground a real credit decision. Production
  // refuses to fabricate scores unless CREDIT_VENDOR_MODE=simulation is set
  // explicitly (e.g. a staging deploy running a production build, or the
  // pre-F3 window where the vendor contract has not landed yet). Remove that
  // override entirely once live bureau contracts are wired in.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.CREDIT_VENDOR_MODE !== "simulation"
  ) {
    throw new Error(
      "Simulated credit pulls are disabled in production. Set CREDIT_VENDOR_MODE=simulation to explicitly allow fabricated bureau data in non-live environments."
    );
  }
  const [pull] = await db
    .select()
    .from(creditPulls)
    .where(eq(creditPulls.id, creditPullId));

  if (!pull) {
    throw new Error("Credit pull not found");
  }

  const experian = simulatedScores?.experian || Math.floor(Math.random() * 200) + 600;
  const equifax = simulatedScores?.equifax || Math.floor(Math.random() * 200) + 600;
  const transunion = simulatedScores?.transunion || Math.floor(Math.random() * 200) + 600;

  const scores = [experian, equifax, transunion].sort((a, b) => a - b);
  const representativeScore = scores[1];

  // Line-item liabilities so the deterministic underwriting layer (deferred
  // student loans at 1% of balance, new-tradeline "sleeper debt") has real
  // structure to work with — aggregates are derived from the lines.
  const creditors = ["Chase Card", "Capital One", "Toyota Financial", "Discover", "Wells Fargo Auto"];
  const lineTypes = ["revolving", "revolving", "auto", "installment", "revolving"];
  const lineCount = Math.floor(Math.random() * 3) + 3;
  const liabilityLines: Array<{
    creditor: string;
    type: string;
    balance: number;
    monthlyPayment: number;
    deferred?: boolean;
    openedDaysAgo?: number;
  }> = Array.from({ length: lineCount }, (_, i) => {
    const balance = Math.floor(Math.random() * 20000) + 1000;
    return {
      creditor: creditors[i % creditors.length],
      type: lineTypes[i % lineTypes.length],
      balance,
      monthlyPayment: Math.max(25, Math.floor(balance * 0.03)),
    };
  });
  if (Math.random() < 0.4) {
    liabilityLines.push({
      creditor: "Dept of Education / Nelnet",
      type: "student_loan",
      balance: Math.floor(Math.random() * 55000) + 15000,
      monthlyPayment: 0,
      deferred: true,
    });
  }
  if (Math.random() < 0.3) {
    const balance = Math.floor(Math.random() * 2500) + 500;
    liabilityLines.push({
      creditor: "Wayfair Retail Card",
      type: "retail",
      balance,
      monthlyPayment: Math.max(25, Math.floor(balance * 0.03)),
      openedDaysAgo: Math.floor(Math.random() * 80) + 5,
    });
  }

  const totalDebt = liabilityLines.reduce((s, l) => s + l.balance, 0);
  const monthlyPayments = liabilityLines.reduce((s, l) => s + l.monthlyPayment, 0);
  const totalTradelines = liabilityLines.length;
  const openTradelines = liabilityLines.length;
  const derogatoryCount = Math.floor(Math.random() * 3);
  const inquiryCount30Days = Math.floor(Math.random() * 3);
  const inquiryCount90Days = Math.floor(Math.random() * 5);

  const simulatedRawResponse = JSON.stringify({
    requestId: `SIM-${Date.now()}`,
    timestamp: new Date().toISOString(),
    bureaus: {
      experian: { score: experian, reportDate: new Date().toISOString() },
      equifax: { score: equifax, reportDate: new Date().toISOString() },
      transunion: { score: transunion, reportDate: new Date().toISOString() },
    },
    tradelines: { total: totalTradelines, open: openTradelines },
    derogatory: derogatoryCount,
    inquiries: { last30Days: inquiryCount30Days, last90Days: inquiryCount90Days },
    debt: { total: totalDebt, monthlyPayment: monthlyPayments },
    simulationMode: true,
  });

  const rawResponseHash = computeHash(simulatedRawResponse);
  const encryptedResponse = encryptSensitiveData(simulatedRawResponse);

  const [updated] = await db
    .update(creditPulls)
    .set({
      status: "completed",
      experianScore: experian,
      equifaxScore: equifax,
      transunionScore: transunion,
      representativeScore,
      totalTradelines,
      openTradelines,
      totalDebt: totalDebt.toString(),
      monthlyPayments: monthlyPayments.toString(),
      derogatoryCount,
      inquiryCount30Days,
      inquiryCount90Days,
      liabilities: liabilityLines,
      encryptedRawResponse: encryptedResponse.encryptedContent,
      encryptionKeyId: encryptedResponse.keyId,
      encryptionIV: encryptedResponse.iv,
      vendorResponseHash: rawResponseHash,
      vendorRequestId: `SIM-${creditPullId.substring(0, 8)}`,
      isSimulated: true,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(creditPulls.id, creditPullId))
    .returning();

  await logCreditAction({
    applicationId: pull.applicationId,
    creditPullId: creditPullId,
    consentId: pull.consentId,
    action: "pull_completed",
    actionDetails: {
      representativeScore,
      bureausReturned: pull.bureaus,
      responseHashStored: true,
    },
  });

  return updated;
}

/**
 * Complete a credit pull with REAL bureau data, obtained outside the app.
 *
 * WHY THIS EXISTS RATHER THAN A HAND-WRITTEN INSERT
 *
 * Completing a pull is not one row. It also appends to `credit_audit_log` —
 * a hash chain (entryHash / previousEntryHash / sequenceNumber, with a v2
 * hashVersion that folds the sequence number into the digest) — and updates
 * `credit_audit_chain_tips` in the SAME transaction, the external end-marker
 * that exists to detect tail truncation.
 *
 * An `UPDATE credit_pulls SET ...` by hand gets the scores and none of that.
 * The chain would not break, because nothing touched it — you would simply
 * have a real consumer report with no audit entry saying who pulled it, when,
 * or under which consent. In an FCRA or ECOA dispute that log IS the artifact,
 * and a missing entry is worse than a corrupt one because nothing flags it.
 *
 * Hand-writing the audit row instead is worse again: it means reproducing the
 * v2 digest, linking previousEntryHash to the live tip, incrementing the
 * sequence and updating the tip table atomically. Any slip produces a
 * verification failure that is indistinguishable from tampering.
 *
 * PROVENANCE IS A PROPERTY OF THE DATA, NOT OF THE ENVIRONMENT
 *
 * `isSimulated` is written FALSE here unconditionally — deliberately not via
 * creditVendorIsSimulated(), which reads CREDIT_VENDOR_API_KEY and describes
 * the *adapter's* posture. During the pre-F3 window that key is unset (there is
 * no adapter), yet a report typed in from a real bureau is real. The stamp must
 * describe where THIS report came from.
 *
 * That is also why `vendorRequestId` is required and must be non-empty: it is
 * the only link back to the bureau's own record, and an unattributable "real"
 * pull is not meaningfully better than a simulated one.
 */
export async function recordLiveCreditPullCompletion(input: {
  creditPullId: string;
  /** The bureau's own reference for this inquiry. Required — this is the provenance. */
  vendorRequestId: string;
  scores: { experian?: number; equifax?: number; transunion?: number };
  /** One score set per borrower for a joint report. Omit only for a single-borrower report. */
  borrowerScores?: Array<{ borrowerSequenceNumber: number; scores: BureauScoreSet }>;
  /** Verbatim vendor payload, if you have it. Encrypted at rest like any other. */
  rawResponse?: string;
  tradelines?: { total?: number; open?: number };
  derogatoryCount?: number;
  inquiries?: { last30Days?: number; last90Days?: number };
  debt?: { total?: number; monthlyPayment?: number };
  liabilities?: unknown[];
}): Promise<CreditPull> {
  const { creditPullId, vendorRequestId } = input;

  if (!vendorRequestId?.trim()) {
    throw new Error(
      "vendorRequestId is required: a credit pull recorded as REAL bureau data must carry the bureau's own reference, or it cannot be tied back to an actual inquiry.",
    );
  }

  // Claiming real data while the fabricating path is still permitted is a
  // contradiction — resolve the configuration before importing.
  if (process.env.CREDIT_VENDOR_MODE === "simulation") {
    throw new Error(
      "CREDIT_VENDOR_MODE=simulation is set, which permits fabricated scores in this environment. Refusing to record a pull as REAL bureau data until that override is removed, so a simulated and a genuine report cannot coexist under the same configuration.",
    );
  }

  const requestedBorrowerScores = input.borrowerScores?.length
    ? input.borrowerScores
    : [{ borrowerSequenceNumber: 1, scores: input.scores }];
  const presentScores = requestedBorrowerScores.flatMap(row => [
    row.scores.experian,
    row.scores.equifax,
    row.scores.transunion,
  ]).filter((score): score is number => score !== null && score !== undefined);
  if (presentScores.length === 0) {
    throw new Error("At least one bureau score is required to complete a credit pull.");
  }
  for (const score of presentScores) {
    if (!Number.isInteger(score) || score < 300 || score > 850) {
      throw new Error(`Credit score ${score} is outside the valid 300-850 range.`);
    }
  }
  const borrowerScores = normalizeBorrowerCreditScores(requestedBorrowerScores);
  const controllingBorrower = borrowerScores.reduce(
    (lowest, borrower) => borrower.representativeScore < lowest.representativeScore ? borrower : lowest,
  );

  const [pull] = await db.select().from(creditPulls).where(eq(creditPulls.id, creditPullId));
  if (!pull) throw new Error("Credit pull not found");
  if (pull.status === "completed") {
    throw new Error(
      `Credit pull ${creditPullId} is already completed. Completing it twice would append a second "pull_completed" entry to the audit chain for one inquiry.`,
    );
  }

  // A borrower's representative is the middle of three or lower of two. On a
  // joint file the controlling score is the lowest borrower representative.
  const representativeScore = controllingBorrower.representativeScore;

  const encrypted = input.rawResponse ? encryptSensitiveData(input.rawResponse) : null;

  const [updated] = await db
    .update(creditPulls)
    .set({
      status: "completed",
      experianScore: controllingBorrower.experianScore,
      equifaxScore: controllingBorrower.equifaxScore,
      transunionScore: controllingBorrower.transunionScore,
      representativeScore,
      borrowerScores,
      totalTradelines: input.tradelines?.total ?? null,
      openTradelines: input.tradelines?.open ?? null,
      totalDebt: input.debt?.total?.toString() ?? null,
      monthlyPayments: input.debt?.monthlyPayment?.toString() ?? null,
      derogatoryCount: input.derogatoryCount ?? null,
      inquiryCount30Days: input.inquiries?.last30Days ?? null,
      inquiryCount90Days: input.inquiries?.last90Days ?? null,
      liabilities: input.liabilities ?? null,
      encryptedRawResponse: encrypted?.encryptedContent ?? null,
      encryptionKeyId: encrypted?.keyId ?? null,
      encryptionIV: encrypted?.iv ?? null,
      vendorResponseHash: input.rawResponse ? computeHash(input.rawResponse) : null,
      vendorRequestId: vendorRequestId.trim(),
      isSimulated: false,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(creditPulls.id, creditPullId))
    .returning();

  await logCreditAction({
    applicationId: pull.applicationId,
    creditPullId,
    consentId: pull.consentId,
    action: "pull_completed",
    actionDetails: {
      representativeScore,
      borrowerCount: borrowerScores.length,
      bureausReturned: pull.bureaus,
      responseHashStored: Boolean(input.rawResponse),
      // Recorded explicitly: this pull was completed from data entered outside
      // the app, not returned by an in-process adapter.
      source: "manual_import",
      vendorRequestId: vendorRequestId.trim(),
    },
  });

  return updated;
}

export async function getCreditPullById(creditPullId: string): Promise<CreditPull | null> {
  const [pull] = await db
    .select()
    .from(creditPulls)
    .where(eq(creditPulls.id, creditPullId));
  return pull ?? null;
}

export async function getAdverseActionById(adverseActionId: string): Promise<AdverseAction | null> {
  const [action] = await db
    .select()
    .from(adverseActions)
    .where(eq(adverseActions.id, adverseActionId));
  return action ?? null;
}

export async function getCreditPullsByApplication(applicationId: string): Promise<CreditPull[]> {
  return db
    .select()
    .from(creditPulls)
    .where(eq(creditPulls.applicationId, applicationId))
    .orderBy(desc(creditPulls.requestedAt));
}

export async function getLatestCreditPull(applicationId: string): Promise<CreditPull | null> {
  const [pull] = await db
    .select()
    .from(creditPulls)
    .where(
      and(
        eq(creditPulls.applicationId, applicationId),
        eq(creditPulls.status, "completed")
      )
    )
    .orderBy(desc(creditPulls.completedAt))
    .limit(1);

  return pull || null;
}
