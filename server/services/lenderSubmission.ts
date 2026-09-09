/**
 * Wholesale lender submission — the "submit" action of the broker pipeline.
 *
 * Submitting a file to a lender is gated on the broker submission-readiness
 * workflow (stages 1–3 must carry no blockers) and is recorded as a
 * lender_submissions row with a snapshot of the readiness report at the
 * moment of submission (audit: what did we believe about the file when we
 * sent it?).
 *
 * The lender leg follows the ausSubmission.ts convention: env-gated real
 * integration with a clearly-flagged deterministic simulation until broker
 * agreements exist. No wholesale lender offers a generic submission API —
 * each onboarding (UWM EASE, Rocket TPO portal, etc.) lands behind
 * submitToLenderPortal(), which is the single seam to replace.
 */

import { createHash } from "node:crypto";
import { storage } from "../storage";
import {
  evaluateLenderSubmissionEligibility,
  isValidSubmissionTransition,
  LENDER_SUBMISSION_STATUSES,
  type LenderApprovalStatus,
  type LenderCounterparty,
  type LenderSubmissionStatus,
} from "@shared/wholesaleLenders";
import type { WholesaleLender } from "@shared/schema";
import {
  compensationAmount,
  resolveCompensation,
} from "@shared/compliance/loCompensation";
import { evaluateCompensationVariance } from "@shared/compensationLedger";
import type { LenderSubmission } from "@shared/schema";
import type { BrokerSubmissionReadiness } from "./brokerSubmissionReadiness";
import { generateMISMO34XML, validateMISMOXML, type MISMOLoanDTO } from "../mismo";

/** Statuses that count as a live submission (blocks a duplicate to the same lender). */
const ACTIVE_STATUSES: LenderSubmissionStatus[] = [
  "submitted", "acknowledged", "in_underwriting", "conditions_issued",
  "conditions_cleared", "clear_to_close", "suspended",
];

export class SubmissionBlockedError extends Error {
  constructor(
    message: string,
    public readonly blockers: string[],
  ) {
    super(message);
    this.name = "SubmissionBlockedError";
  }
}

export interface LenderAcknowledgment {
  simulated: boolean;
  confirmationId: string;
}

/**
 * Deterministic simulated lender acknowledgment: stable confirmation id from
 * (lenderId, applicationId), shaped like a lender-side loan number. Pure —
 * unit-tested directly.
 */
export function simulateLenderAcknowledgment(lenderId: string, applicationId: string): LenderAcknowledgment {
  const digest = createHash("sha256").update(`${lenderId}:${applicationId}`).digest("hex");
  const numeric = String(parseInt(digest.slice(0, 10), 16) % 1_000_000_000).padStart(9, "0");
  return {
    simulated: true,
    confirmationId: `${lenderId.toUpperCase().replace(/-/g, "").slice(0, 4)}-${numeric}`,
  };
}

/**
 * The single integration seam per lender portal. Real integrations are gated
 * on per-lender env credentials that do not exist yet; until then this
 * returns the deterministic simulation.
 */
async function submitToLenderPortal(
  lender: WholesaleLender,
  applicationId: string,
): Promise<LenderAcknowledgment> {
  // e.g. process.env.UWM_EASE_CLIENT_ID — no broker agreements are signed, so
  // every lender resolves to the simulation today. Keyed on the business
  // `lenderId`, not the uuid, so a reseed cannot change a confirmation id.
  return simulateLenderAcknowledgment(lender.lenderId, applicationId);
}

/**
 * Narrow a `wholesale_lenders` row to the counterparty shape the pure
 * eligibility rules take. `approvalStatus` is validated rather than cast: the
 * column is a varchar, and an unrecognised value must fail CLOSED (treated as
 * "target") rather than accidentally satisfying an equality check for
 * "approved".
 */
export function toCounterparty(lender: WholesaleLender): LenderCounterparty {
  const raw = lender.approvalStatus;
  const approvalStatus: LenderApprovalStatus =
    raw === "approved" || raw === "application_in_progress" || raw === "inactive" ? raw : "target";
  return {
    lenderId: lender.lenderId,
    lenderName: lender.lenderName,
    approvalStatus,
    isDemo: lender.isDemo,
    status: lender.status,
    nonQm: lender.nonQm,
    epoClawbackDays: lender.epoClawbackDays,
  };
}

export interface LenderPackage {
  xml: string;
  hash: string;
  validation: { valid: boolean; errors: string[] };
}

export interface AusFindingsArtifact {
  findings: Record<string, unknown>;
  hash: string;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

/** Build a deterministic, tamper-evident copy of the current DU/LPA findings. */
export function buildAusFindingsArtifact(findings: unknown): AusFindingsArtifact {
  if (!findings || typeof findings !== "object" || Array.isArray(findings)) {
    throw new SubmissionBlockedError(
      "Current DU / LPA findings are missing — re-run underwriting before packaging.",
      ["Run DU / LPA again and review the final findings before lender submission."],
    );
  }
  const record = findings as Record<string, unknown>;
  const integrity = record.inputIntegrity as Record<string, unknown> | undefined;
  if (!record.recommendation || !record.lpa || !integrity?.inputFingerprint) {
    throw new SubmissionBlockedError(
      "Current DU / LPA findings are incomplete — re-run underwriting before packaging.",
      ["Run both DU and LPA so the package contains current input lineage and both findings reports."],
    );
  }
  const canonical = canonicalJsonValue(record) as Record<string, unknown>;
  return {
    findings: canonical,
    hash: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
  };
}

/**
 * Assembles the MISMO 3.4 XML package for a wholesale submission and hashes
 * it for tamper-evident audit (the package is persisted as an immutable
 * snapshot, not regenerated later — see mismoPackageXml on lender_submissions).
 * Pure — unit-tested directly; submitToWholesaleLender supplies the DTO.
 */
export function buildLenderPackage(
  dto: MISMOLoanDTO,
  noteDate?: string,
  generatedAt: Date = new Date(),
): LenderPackage {
  const xml = generateMISMO34XML(dto, { purpose: "loanDelivery", noteDate, generatedAt });
  const validation = validateMISMOXML(xml);
  const hash = createHash("sha256").update(xml).digest("hex");
  return { xml, hash, validation };
}

export interface SubmitResult {
  submission: LenderSubmission;
  readiness: BrokerSubmissionReadiness;
}

export async function submitToWholesaleLender(
  applicationId: string,
  lenderId: string,
  submittedBy: string,
): Promise<SubmitResult> {
  const lender = await storage.getWholesaleLenderByLenderId(lenderId);
  if (!lender) {
    throw new SubmissionBlockedError(`Unknown wholesale lender "${lenderId}"`, []);
  }

  // Counterparty gate (F-5). Nothing used to check whether we actually have a
  // relationship with this lender, so the system would record a "submitted"
  // status — and transmit a borrower's file — to a company that has never
  // heard of us. Production requires a signed agreement; dev/demo may exercise
  // the path as an explicit simulation. Seeded demo rows are refused outright.
  const eligibility = evaluateLenderSubmissionEligibility(toCounterparty(lender), {
    isProduction: process.env.NODE_ENV === "production",
  });
  if (!eligibility.allowed) {
    throw new SubmissionBlockedError(eligibility.reason, eligibility.remediation);
  }
  if (eligibility.simulated) {
    console.warn(`[lender-submission] ${eligibility.reason}`);
  }

  // One live submission per lender: withdrawn/denied submissions may be
  // superseded, active ones may not.
  const existing = await storage.getLenderSubmissionsByApplication(applicationId);
  const active = existing.find(
    s => s.lenderId === lenderId && ACTIVE_STATUSES.includes(s.status as LenderSubmissionStatus),
  );
  if (active) {
    throw new SubmissionBlockedError(
      `An active submission to ${lender.lenderName} already exists (status: ${active.status})`,
      [],
    );
  }

  // Server-enforced readiness gate: stages 1–3 must carry no blockers.
  const { evaluateBrokerSubmissionReadiness } = await import("./brokerSubmissionReadiness");
  const readiness = await evaluateBrokerSubmissionReadiness(applicationId);
  if (!readiness.readyToSubmitToLender) {
    const blockers = readiness.stages.flatMap(s => s.blockers.map(b => `[${s.label}] ${b}`));
    throw new SubmissionBlockedError(
      "File is not ready for lender submission — resolve the workflow blockers first.",
      blockers,
    );
  }

  // Per-lender package assembly: build the exact MISMO 3.4 XML the lender
  // would receive and validate it structurally before allowing submission.
  // A readiness-gate pass doesn't guarantee the export itself is well-formed
  // (different check — see L6 for the fuller XSD-validation slice).
  const mismoData = await storage.getMISMOLoanData(applicationId, {
    sensitiveAccess: { actorUserId: submittedBy, purpose: "lender_submission" },
  });
  if (!mismoData) {
    throw new SubmissionBlockedError(
      "Application data not found — cannot assemble the lender package.",
      [],
    );
  }
  const deliveryData = await storage.getLoanDeliveryData(applicationId);
  const pkg = buildLenderPackage(mismoData as MISMOLoanDTO, deliveryData?.noteDate ?? undefined);
  if (!pkg.validation.valid) {
    throw new SubmissionBlockedError(
      "The assembled MISMO package failed structural validation — cannot submit.",
      pkg.validation.errors,
    );
  }

  // Non-blocking schema diagnostic: validate the exact package against the
  // official MISMO 3.4 XSD (docs/fannie-mae/schemas/) via xmllint, and record
  // the result on the immutable submission snapshot. This is deliberately NOT a
  // blocker: the generator has a known, tracked conformance gap (CTO_ROADMAP L6
  // / F-025) whose remaining element fixes are pending MISMO data-dictionary
  // confirmation, and xmllint is absent in serverless (→ skipped). The
  // structural validateMISMOXML gate above stays the hard gate. A violation here
  // is captured (auditable, shown to staff), not silently swallowed — surfaced by
  // client/src/components/PackageConformanceBadge.tsx, which reads this recorded
  // snapshot value. That "shown to staff" claim was false for as long as it stood
  // here: nothing in the client read the field, so a non-conformant package was
  // recorded and no human was ever told. Keep a reader wired to it.
  //
  // The validator checks BOTH the base model and the ULDD extension. Against the
  // base model alone, everything inside an EXTENSION was skipped in silence
  // (`xsd:any processContents="lax"` with no resolvable declaration), so a
  // fabricated ULDD name recorded as conformant — the badge above would have
  // shown staff a green result over an unvalidated subtree.
  const { validateMismoExport, extractOffendingElements } = await import("./mismoXsdValidation");
  const xsd = validateMismoExport(pkg.xml);
  const xsdConformance = {
    valid: xsd.valid,
    skipped: xsd.skipped,
    offendingElements: xsd.skipped ? [] : extractOffendingElements(xsd.errors),
  };
  if (!xsd.skipped && !xsd.valid) {
    console.warn(
      `[lender-submission] MISMO XSD non-conformance for ${applicationId} ` +
        `(tracked L6/F-025): ${xsdConformance.offendingElements.join(", ")}`,
    );
  }

  // The income analysis package (UAL P6) — the broker's cited income narrative
  // shipped alongside the MISMO package. Build it before the portal handoff so
  // a missing/stale financial review can never fail after an external send.
  // It is per-lender shaped (non-QM sections only for non-QM lenders), with an
  // immutable approved credit-memo snapshot and tamper-evident hash.
  const submittedAt = new Date();
  const { buildIncomeAnalysisPackage, IncomeAnalysisPackageBlockedError } = await import("./incomeAnalysisPackage");
  const incomePkg = await buildIncomeAnalysisPackage(
    applicationId,
    lenderId,
    submittedBy,
    eligibility.simulated,
    submittedAt,
  ).catch(error => {
    if (error instanceof IncomeAnalysisPackageBlockedError) {
      throw new SubmissionBlockedError(error.message, ["Complete the Financial Review step before lender submission."]);
    }
    throw error;
  });

  // Freeze the exact dual-AUS findings that passed the freshness gate above.
  // loan_applications.ausFindings is a mutable working copy; the lender row is
  // the package-of-record and therefore carries its own canonical hash.
  const application = await storage.getLoanApplication(applicationId);
  const ausArtifact = buildAusFindingsArtifact(application?.ausFindings);

  const ack = await submitToLenderPortal(lender, applicationId);

  // Snapshot what this file is expected to earn, from the comp plan elected on
  // the application (Reg Z §1026.36(d)(2) election) and the loan amount as
  // submitted. Snapshotted rather than derived on read: a later plan edit must
  // not rewrite what we believed we were owed on a loan already in flight.
  const compensation = resolveCompensation(
    application?.loCompensationModel,
    application?.loCompensationBps,
  );
  const submittedLoanAmount = expectedLoanAmount(application);
  const expectedComp =
    compensation && submittedLoanAmount !== null
      ? compensationAmount(submittedLoanAmount, compensation)
      : null;

  const submission = await storage.createLenderSubmission({
    applicationId,
    lenderId,
    status: "submitted",
    simulated: ack.simulated,
    compensationModel: compensation?.model ?? null,
    compensationExpectedBps: compensation?.bps ?? null,
    compensationExpectedAmount: expectedComp === null ? null : expectedComp.toFixed(2),
    confirmationId: ack.confirmationId,
    readinessSnapshot: { ...(readiness as unknown as Record<string, unknown>), xsdConformance },
    mismoPackageXml: pkg.xml,
    mismoPackageHash: pkg.hash,
    mismoPackageGeneratedAt: submittedAt,
    incomePackageJson: incomePkg.package as unknown as Record<string, unknown>,
    incomePackageHash: incomePkg.hash,
    incomePackageGeneratedAt: incomePkg.generatedAt,
    ausFindingsJson: ausArtifact.findings,
    ausFindingsHash: ausArtifact.hash,
    ausFindingsGeneratedAt: application?.ausSubmittedAt ?? submittedAt,
    submittedBy,
  });

  await storage.createDealActivity({
    applicationId,
    activityType: "note",
    title: `Submitted to ${lender.lenderName}`,
    description: `Wholesale submission ${ack.confirmationId}${ack.simulated ? " (simulated — no broker agreement live)" : ""} — MISMO package ${pkg.hash.slice(0, 12)}, income package ${incomePkg.hash.slice(0, 12)}, AUS findings ${ausArtifact.hash.slice(0, 12)}`,
    performedBy: submittedBy,
  });

  return { submission, readiness };
}

/** Loan amount as submitted: purchase price − down payment. Pure. */
function expectedLoanAmount(application: { purchasePrice?: unknown; downPayment?: unknown } | undefined | null): number | null {
  if (!application) return null;
  const price = Number(application.purchasePrice);
  const down = Number(application.downPayment);
  if (!Number.isFinite(price) || !Number.isFinite(down)) return null;
  const amount = price - down;
  return amount > 0 ? amount : null;
}

/** What staff must record to mark a submission funded. */
export interface FundingDetails {
  fundedLoanAmount: number;
  compensationReceivedAmount: number;
  fundedAt?: Date;
}

export async function updateSubmissionStatus(
  submissionId: string,
  toStatus: string,
  notes: string | undefined,
  performedBy: string,
  funding?: FundingDetails,
): Promise<LenderSubmission> {
  if (!(LENDER_SUBMISSION_STATUSES as readonly string[]).includes(toStatus)) {
    throw new SubmissionBlockedError(`"${toStatus}" is not a valid submission status`, []);
  }
  const submission = await storage.getLenderSubmission(submissionId);
  if (!submission) {
    throw new Error("Submission not found");
  }
  const from = submission.status as LenderSubmissionStatus;
  if (!isValidSubmissionTransition(from, toStatus as LenderSubmissionStatus)) {
    throw new SubmissionBlockedError(`Cannot move a submission from "${from}" to "${toStatus}"`, []);
  }

  // Display name for the audit activity below. Read from the lender table; a
  // missing row falls back to the raw id rather than failing the transition —
  // a status update must not be blocked by a catalog lookup.
  const lenderRow = await storage.getWholesaleLenderByLenderId(submission.lenderId);

  // Funding is where revenue is realized, so it is where revenue gets
  // captured. Marking a loan funded without recording what the lender actually
  // paid is exactly how the platform ended up unable to state its own revenue
  // — so the status machine refuses it rather than leaving it to discipline.
  let fundingUpdate: Record<string, unknown> = {};
  let variance: ReturnType<typeof evaluateCompensationVariance> | null = null;

  if (toStatus === "funded") {
    if (!funding) {
      throw new SubmissionBlockedError(
        "Marking a submission funded requires the funded loan amount and the compensation received.",
        [
          "Record the final funded loan amount from the lender's closing figures.",
          "Record the compensation actually remitted by the lender.",
        ],
      );
    }
    const fundedAt = funding.fundedAt ?? new Date();
    variance = evaluateCompensationVariance({
      expectedAmount: submission.compensationExpectedAmount,
      receivedAmount: funding.compensationReceivedAmount,
    });
    fundingUpdate = {
      fundedLoanAmount: funding.fundedLoanAmount.toFixed(2),
      fundedAt,
      compensationReceivedAmount: funding.compensationReceivedAmount.toFixed(2),
      compensationReceivedAt: fundedAt,
      compensationRecordedBy: performedBy,
    };
  }

  const updated = await storage.updateLenderSubmission(submissionId, {
    status: toStatus,
    ...(notes !== undefined ? { notes } : {}),
    ...fundingUpdate,
  });

  await storage.createDealActivity({
    applicationId: submission.applicationId,
    activityType: "note",
    title: `Lender submission ${toStatus.replace(/_/g, " ")}`,
    description:
      `${lenderRow?.lenderName ?? submission.lenderId}: ${from} → ${toStatus}` +
      (notes ? ` — ${notes}` : "") +
      (variance ? ` — ${variance.message}` : ""),
    metadata: variance
      ? {
          submissionId,
          compensationStatus: variance.status,
          expectedAmount: variance.expectedAmount,
          receivedAmount: variance.receivedAmount,
          variance: variance.variance,
        }
      : undefined,
    performedBy,
  });

  return updated!;
}
