import { createHash } from "node:crypto";
import type { CreditPull } from "@shared/schema";
import { adjustLiabilities, type Tradeline } from "./underwritingNuance";

export type DecisionCreditPicture = {
  pullId: string;
  representativeScore: number;
  borrowerScores: BorrowerCreditScore[];
  tradelines: Tradeline[];
  reportedMonthlyPayments: number;
  adjustedMonthlyDebt: number;
  fingerprint: string;
};

export type BureauScoreSet = {
  experian?: number | null;
  equifax?: number | null;
  transunion?: number | null;
};

export type BorrowerCreditScore = {
  borrowerSequenceNumber: number;
  experianScore: number | null;
  equifaxScore: number | null;
  transunionScore: number | null;
  representativeScore: number;
};

export type DecisionCreditAssessment = {
  isReady: boolean;
  hasProviderReference: boolean;
  scoreIsUsable: boolean;
  liabilitiesAreUsable: boolean;
  reasons: string[];
  picture: DecisionCreditPicture | null;
};

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseTradelines(value: unknown): Tradeline[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: Tradeline[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const row = candidate as Record<string, unknown>;
    if (
      typeof row.creditor !== "string"
      || !row.creditor.trim()
      || typeof row.type !== "string"
      || !row.type.trim()
      || !finiteNonNegative(row.balance)
      || !finiteNonNegative(row.monthlyPayment)
      || (row.deferred !== undefined && typeof row.deferred !== "boolean")
      || (row.openedDaysAgo !== undefined && !finiteNonNegative(row.openedDaysAgo))
    ) return null;
    parsed.push({
      creditor: row.creditor.trim(),
      type: row.type.trim().toLowerCase(),
      balance: row.balance,
      monthlyPayment: row.monthlyPayment,
      ...(row.deferred !== undefined ? { deferred: row.deferred } : {}),
      ...(row.openedDaysAgo !== undefined ? { openedDaysAgo: row.openedDaysAgo } : {}),
    });
  }
  return parsed;
}

export function representativeScoreForBureaus(scores: BureauScoreSet): number | null {
  const present = [scores.experian, scores.equifax, scores.transunion]
    .filter((score): score is number => Number.isInteger(score) && score! >= 300 && score! <= 850)
    .sort((a, b) => a - b);
  if (present.length === 0) return null;
  return present.length >= 3 ? present[1] : present[0];
}

/** Normalize vendor/import score sets and compute every representative score. */
export function normalizeBorrowerCreditScores(
  rows: ReadonlyArray<{ borrowerSequenceNumber: number; scores: BureauScoreSet }>,
): BorrowerCreditScore[] {
  const seen = new Set<number>();
  const normalized = rows.map(row => {
    if (!Number.isInteger(row.borrowerSequenceNumber) || row.borrowerSequenceNumber < 1 || row.borrowerSequenceNumber > 10) {
      throw new Error("Each borrower credit score set needs a valid borrower sequence number.");
    }
    if (seen.has(row.borrowerSequenceNumber)) {
      throw new Error(`Borrower ${row.borrowerSequenceNumber} appears more than once in the credit score sets.`);
    }
    seen.add(row.borrowerSequenceNumber);
    const present = [row.scores.experian, row.scores.equifax, row.scores.transunion]
      .filter((score): score is number => score !== null && score !== undefined);
    if (present.length === 0 || present.some(score => !Number.isInteger(score) || score < 300 || score > 850)) {
      throw new Error(`Borrower ${row.borrowerSequenceNumber} needs at least one valid 300-850 bureau score.`);
    }
    return {
      borrowerSequenceNumber: row.borrowerSequenceNumber,
      experianScore: row.scores.experian ?? null,
      equifaxScore: row.scores.equifax ?? null,
      transunionScore: row.scores.transunion ?? null,
      representativeScore: representativeScoreForBureaus(row.scores)!,
    };
  });
  return normalized.sort((a, b) => a.borrowerSequenceNumber - b.borrowerSequenceNumber);
}

function parseBorrowerScores(pull: CreditPull): BorrowerCreditScore[] | null {
  if (pull.borrowerScores !== null && pull.borrowerScores !== undefined) {
    if (!Array.isArray(pull.borrowerScores) || pull.borrowerScores.length === 0) return null;
    try {
      const normalized = normalizeBorrowerCreditScores(pull.borrowerScores.map(row => {
        if (!row || typeof row !== "object") throw new Error("Invalid borrower score row");
        const value = row as Record<string, unknown>;
        return {
          borrowerSequenceNumber: value.borrowerSequenceNumber as number,
          scores: {
            experian: value.experianScore as number | null | undefined,
            equifax: value.equifaxScore as number | null | undefined,
            transunion: value.transunionScore as number | null | undefined,
          },
        };
      }));
      const storedRepresentativesAreCorrect = normalized.every(normalizedRow => {
        const stored = (pull.borrowerScores as Array<Record<string, unknown>>).find(
          row => row.borrowerSequenceNumber === normalizedRow.borrowerSequenceNumber,
        );
        return stored?.representativeScore === normalizedRow.representativeScore;
      });
      return storedRepresentativesAreCorrect ? normalized : null;
    } catch {
      return null;
    }
  }

  const representativeScore = representativeScoreForBureaus({
    experian: pull.experianScore,
    equifax: pull.equifaxScore,
    transunion: pull.transunionScore,
  });
  if (representativeScore === null) return null;
  return [{
    borrowerSequenceNumber: 1,
    experianScore: pull.experianScore,
    equifaxScore: pull.equifaxScore,
    transunionScore: pull.transunionScore,
    representativeScore,
  }];
}

/**
 * Validate the exact bureau facts that may enter automated underwriting.
 * A completed/non-simulated row is only provenance; it is not useful decision
 * evidence until its provider reference, representative score, and structured
 * open-liability ledger are internally coherent.
 */
export function assessCreditPullDecisionData(
  pull: CreditPull | null | undefined,
  expectedBorrowerSequenceNumbers: readonly number[] = [1],
): DecisionCreditAssessment {
  if (!pull) {
    return {
      isReady: false,
      hasProviderReference: false,
      scoreIsUsable: false,
      liabilitiesAreUsable: false,
      reasons: ["A bureau credit report is required."],
      picture: null,
    };
  }

  const reasons: string[] = [];
  const hasProviderReference = Boolean(pull.vendorRequestId?.trim() || pull.externalRequestId?.trim());
  if (!hasProviderReference) reasons.push("The bureau report is missing its provider reference.");

  const borrowerScores = parseBorrowerScores(pull);
  const expectedBorrowers = [...new Set(expectedBorrowerSequenceNumbers.filter(
    sequence => Number.isInteger(sequence) && sequence > 0,
  ))].sort((a, b) => a - b);
  if (expectedBorrowers.length === 0) expectedBorrowers.push(1);
  const scoreByBorrower = new Map(borrowerScores?.map(row => [row.borrowerSequenceNumber, row]) ?? []);
  const missingBorrowers = expectedBorrowers.filter(sequence => !scoreByBorrower.has(sequence));
  const controllingBorrower = borrowerScores?.reduce(
    (lowest, row) => row.representativeScore < lowest.representativeScore ? row : lowest,
  );
  const topLevelMatchesControllingBorrower = !!controllingBorrower
    && pull.representativeScore === controllingBorrower.representativeScore
    && pull.experianScore === controllingBorrower.experianScore
    && pull.equifaxScore === controllingBorrower.equifaxScore
    && pull.transunionScore === controllingBorrower.transunionScore;
  const scoreIsUsable = Number.isInteger(pull.representativeScore)
    && pull.representativeScore! >= 300
    && pull.representativeScore! <= 850
    && borrowerScores !== null
    && missingBorrowers.length === 0
    && topLevelMatchesControllingBorrower;
  if (missingBorrowers.length > 0) {
    reasons.push(`The bureau report is missing a credit score set for borrower ${missingBorrowers.join(", ")}.`);
  } else if (!scoreIsUsable) {
    reasons.push("The bureau report does not contain valid, reproducible borrower and representative credit scores.");
  }

  const tradelines = parseTradelines(pull.liabilities);
  const openCountMatches = tradelines !== null
    && Number.isInteger(pull.openTradelines)
    && pull.openTradelines! >= 0
    && pull.openTradelines === tradelines.length;
  let aggregateMatches = false;
  if (tradelines && openCountMatches) {
    const reported = tradelines.reduce((sum, line) => sum + line.monthlyPayment, 0);
    const stored = pull.monthlyPayments === null ? NaN : Number(pull.monthlyPayments);
    aggregateMatches = Number.isFinite(stored) && Math.abs(stored - reported) <= 0.01;
  }
  const liabilitiesAreUsable = tradelines !== null && openCountMatches && aggregateMatches;
  if (!liabilitiesAreUsable) {
    reasons.push("The bureau report is missing a reconciled open-liability ledger and monthly-payment total.");
  }

  if (!hasProviderReference || !scoreIsUsable || !liabilitiesAreUsable || !tradelines || !borrowerScores) {
    return {
      isReady: false,
      hasProviderReference,
      scoreIsUsable,
      liabilitiesAreUsable,
      reasons,
      picture: null,
    };
  }

  const adjustment = adjustLiabilities(tradelines);
  const fingerprintPayload = {
    pullId: pull.id,
    completedAt: pull.completedAt?.toISOString() ?? null,
    representativeScore: pull.representativeScore,
    borrowerScores,
    tradelines,
    reportedMonthlyPayments: adjustment.reportedMonthlyPayments,
    adjustedMonthlyDebt: adjustment.adjustedMonthlyDebt,
  };
  return {
    isReady: true,
    hasProviderReference,
    scoreIsUsable,
    liabilitiesAreUsable,
    reasons,
    picture: {
      pullId: pull.id,
      representativeScore: pull.representativeScore!,
      borrowerScores,
      tradelines,
      reportedMonthlyPayments: adjustment.reportedMonthlyPayments,
      adjustedMonthlyDebt: adjustment.adjustedMonthlyDebt,
      fingerprint: createHash("sha256").update(JSON.stringify(fingerprintPayload)).digest("hex"),
    },
  };
}
