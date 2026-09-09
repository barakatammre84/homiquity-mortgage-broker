import { z } from "zod";
import { type LoanAppStatus } from "./schema/lendingCore";

/**
 * Statuses in which a borrower may generate a pre-qualification letter — the
 * pre-decision shopping tool. One list for the server gate
 * (server/routes/lending/letters.ts generate-prequal) and the client surface
 * (client/src/pages/lending/LoanOptions.tsx), so the two cannot drift.
 *
 * Scope: the file is in flight and the borrower does not yet hold a
 * full pre-approval-track decision — plus "pre_approved"/"underwriting",
 * where regenerating a prequal remains allowed for offer-letter workflows
 * (the client hides its button once "pre_approved" because the stronger
 * pre-approval letter takes over). Post-conditional and closing-track
 * statuses are excluded: the pre-approval letter supersedes.
 */
export const PREQUAL_ELIGIBLE_STATUSES: readonly LoanAppStatus[] = [
  "submitted",
  "analyzing",
  "under_review",
  "pre_approved",
  "underwriting",
];

/**
 * One schema for both sides of letter revocation: the server route
 * (POST /api/pre-approval-letters/:letterId/revoke) validates the body with
 * it, and the staff revocation dialog gates its confirm button with it — the
 * client can never offer a submission the server would 400.
 */
export const letterRevocationSchema = z.object({
  reason: z.string().trim()
    .min(10, "A revocation reason of at least 10 characters is required")
    .max(2000),
});

/**
 * The status a letter should read as RIGHT NOW, expiry included.
 *
 * The stored status flips to "expired" only when the daily sweep runs
 * (server/services/letterExpiry.ts), which leaves a window where the row
 * still says "issued" on a letter past its expiration date. Read paths
 * (letter-status / prequal-status) go through this helper so the API never
 * asserts "issued" on an expired letter, whatever the sweep's timing.
 *
 * Terminal statuses (revoked, superseded) are already persisted at write
 * time and win over expiry — a revoked letter stays revoked. Expiry is
 * strict: the letter remains issued through its stored expiration instant.
 */
/**
 * The amount a pre-approval letter asserts. The persisted preApprovalAmount
 * wins only when it is a real positive figure — the intake cascade persists
 * "0.00" on undecidable files, and a bare `||` fallback treats that truthy
 * string as an amount, printing "$0" on an outward creditworthiness document.
 * Falls back to purchasePrice − downPayment; returns null when no positive
 * amount exists — callers must refuse to render a letter rather than assert
 * a zero.
 */
export function resolveLetterAmount(
  preApprovalAmount: string | null | undefined,
  purchasePrice: string | null | undefined,
  downPayment: string | null | undefined,
): number | null {
  const persisted = parseFloat(String(preApprovalAmount ?? ""));
  if (!isNaN(persisted) && persisted > 0) return persisted;
  const price = parseFloat(String(purchasePrice ?? ""));
  const down = parseFloat(String(downPayment ?? ""));
  if (isNaN(price)) return null;
  const derived = price - (isNaN(down) ? 0 : down);
  return derived > 0 ? derived : null;
}

export function effectiveLetterStatus<S extends string>(
  letter: { status: S; expirationDate: Date | string },
  now: Date = new Date(),
): S | "expired" {
  if (letter.status === "issued" && new Date(letter.expirationDate).getTime() < now.getTime()) {
    return "expired";
  }
  return letter.status;
}

/** Decision-aware status for outward pre-approval letters. */
export function effectivePreApprovalLetterStatus<S extends string>(
  letter: { status: S; expirationDate: Date | string },
  decisionCurrent: boolean,
  now: Date = new Date(),
): S | "expired" | "stale" {
  const status = effectiveLetterStatus(letter, now);
  return status === "issued" && !decisionCurrent ? "stale" : status;
}
