import { storage } from "../../storage";
import {
  extractPayStubData,
  extractW2Data,
  extractBankStatementData,
  extractLeaseData,
  extractProfitLossData,
  EXTRACTION_MODEL_ID,
  EXTRACTION_PROMPT_VERSION,
  type ExtractedDocumentData,
} from "../../extractionService";
import { logAiInteraction } from "../aiInteractionLog";
import { recalculateDecision } from "../decisionEngine";
import { evaluateBrokerSubmissionReadiness } from "../brokerSubmissionReadiness";
import {
  getBorrowerProfileFromApplication,
  determineDocumentRequirements,
  generateConditionsFromRequirements,
} from "../../pipelineEngine";
import { isAutopilotEnabled, canGenerateFollowUps } from "./config";
import { materializeFlagsToFollowUps } from "./followUps";
import { publishReviewing, publishCurrentStatus } from "./events";
import type { PreUwFlag } from "../preUnderwriting";
import type { LoanApplication } from "@shared/schema";
import {
  getDocumentProcessingBlockReason,
  type DatabaseTransaction,
} from "../documentLineage";
import { applyExtractionToDocument } from "../extractionPersistence";
import { classifyExtractionResult } from "../documentExtractionOutcome";
import { extractionDocumentType } from "@shared/documentTypes";

/**
 * Autopilot document orchestrator — the always-on agent's reaction to a borrower
 * document upload. Chains the pieces that already exist into one event-driven
 * pass:
 *
 *   PERCEIVE  — extract via the Claude vendor adapter (server/extractionService),
 *               record confidence, stage the document (MR-2: never auto-verify),
 *               and log the model call to ai_interactions.
 *   RECONCILE — compute the stated-vs-documented income delta for narration
 *               (Phase 1 narrates it; canonical writeback is a later phase gated
 *               by canUpdateApplicationData()).
 *   COGNIZE   — refresh the pre-qualification snapshot (recalculateDecision).
 *               Broker pre-qual, NOT a credit decision — the lender decides.
 *   ACT       — materialize cited package-gap follow-ups from the file's flags,
 *               re-check lender-readiness, and narrate one rich activity entry.
 *
 * Runs detached (best-effort on serverless, like the prior auto-extract IIFE it
 * replaces). Never throws — every step is guarded so a failure can't take down
 * the upload request that spawned it.
 */

export interface AutopilotDocumentParams {
  applicationId: string;
  documentId: string;
  documentType: string;
  storagePath: string;
  mimeType?: string | null;
  fileSize?: number | null;
  triggeredBy: string;
  beforePersist?: (transaction: DatabaseTransaction) => Promise<void>;
  assertActive?: () => Promise<void>;
}

interface ExtractionOutcome {
  extracted: ExtractedDocumentData;
  /** Human-readable narration lines derived from the extraction. */
  highlights: string[];
  /** Page classification withheld the extracted values from the evidence graph. */
  classificationBlocked?: boolean;
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString()}`;

const prettyDocType = (t: string): string =>
  t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Dispatch extraction by document type, returning normalized fields + narration
 * highlights. Returns null for types with no extractor (e.g. government_id) —
 * the run still narrates the upload and materializes follow-ups.
 */
export async function extractAutopilotDocument(
  documentType: string,
  storagePath: string,
  mimeType: string | null | undefined,
): Promise<ExtractionOutcome | null> {
  const highlights: string[] = [];
  switch (extractionDocumentType(documentType)) {
    case "pay_stub": {
      const e = await extractPayStubData(storagePath, mimeType ?? undefined);
      if (e.employerName) highlights.push(`Employer: ${e.employerName}`);
      if (e.grossPay != null) highlights.push(`Gross pay (period): ${usd(e.grossPay)}`);
      if (e.ytdGross != null) highlights.push(`YTD gross: ${usd(e.ytdGross)}`);
      return { extracted: e, highlights };
    }
    case "w2": {
      const e = await extractW2Data(storagePath, mimeType ?? undefined);
      if (e.employerName) highlights.push(`Employer: ${e.employerName}`);
      if (e.taxYear) highlights.push(`Tax year: ${e.taxYear}`);
      if (e.wagesTipsOtherCompensation != null) {
        highlights.push(`W-2 Box 1 wages: ${usd(e.wagesTipsOtherCompensation)}`);
      }
      return { extracted: e, highlights };
    }
    case "bank_statement": {
      const e = await extractBankStatementData(storagePath, mimeType ?? undefined, documentType);
      if (e.closingBalance != null) highlights.push(`Closing balance: ${usd(e.closingBalance)}`);
      if (e.totalDeposits != null) highlights.push(`Total deposits: ${usd(e.totalDeposits)}`);
      return { extracted: e, highlights };
    }
    case "lease_agreement": {
      const e = await extractLeaseData(storagePath, mimeType ?? undefined);
      if (e.propertyAddress) highlights.push(`Property: ${e.propertyAddress}`);
      if (e.monthlyRent != null) highlights.push(`Monthly rent: ${usd(e.monthlyRent)}`);
      return { extracted: e, highlights };
    }
    case "profit_loss": {
      const e = await extractProfitLossData(storagePath, mimeType ?? undefined);
      if (e.businessName) highlights.push(`Business: ${e.businessName}`);
      if (e.periodEndDate) highlights.push(`Period ending: ${e.periodEndDate}`);
      if (e.netProfitLoss != null) highlights.push(`YTD net profit or loss: ${usd(e.netProfitLoss)}`);
      return { extracted: e, highlights };
    }
    default:
      return null;
  }
}

function buildNarration(p: {
  outcome: ExtractionOutcome | null;
  extractionFailed: boolean;
  createdFollowUps: string[];
  readinessLine: string | null;
}): string {
  const parts: string[] = [];
  if (p.outcome) {
    const extracted = p.outcome.extracted;
    parts.push(p.outcome.classificationBlocked
      ? "Document received; its page type needs manual classification before any values are used."
      : p.outcome.highlights.length
        ? p.outcome.highlights.join(" · ")
        : `Parsed ${extracted.extractedFields.length} field(s) (confidence: ${extracted.confidence}).`);
    if (extracted.warnings?.length) parts.push(`Notes: ${extracted.warnings.join("; ")}.`);
  } else if (p.extractionFailed) {
    parts.push("Document received; automated parsing was unavailable for this file.");
  } else {
    parts.push("Document received and filed.");
  }
  if (p.createdFollowUps.length) {
    parts.push(`Created ${p.createdFollowUps.length} follow-up(s): ${p.createdFollowUps.join(", ")}.`);
  }
  if (p.readinessLine) parts.push(p.readinessLine);
  return parts.join(" ");
}

/**
 * Autopilot section-completion reaction (Phase 3) — the proactive needs list.
 *
 * The moment a borrower saves their URLA/intake sections, generate the initial
 * document needs from their STATED data (before any upload), so the dead time
 * between "submitted" and "here's what we need" disappears. Reuses the
 * deterministic requirement rules (pipelineEngine.determineDocumentRequirements)
 * and the now-idempotent condition generator, so re-saves and the later intake
 * pipeline init converge on one set instead of duplicating. Narrates only when
 * new needs were added, to stay quiet on no-op re-saves. Never throws.
 */
export async function runAutopilotForSection(params: {
  applicationId: string;
  triggeredBy: string;
}): Promise<void> {
  const { applicationId } = params;
  try {
    const application = await storage.getLoanApplication(applicationId);
    if (!application) return;
    if (!(await isAutopilotEnabled(application.loanOfficerId))) return;
    if (!(await canGenerateFollowUps())) return;

    const [otherIncome, employment] = await Promise.all([
      storage.getOtherIncomeSources(applicationId),
      storage.getEmploymentHistory(applicationId),
    ]);
    const profile = getBorrowerProfileFromApplication(application, otherIncome, employment);
    const requirements = determineDocumentRequirements(profile);
    const created = await generateConditionsFromRequirements(applicationId, requirements);

    // Refresh the pre-qualification snapshot from the newly-stated data.
    await recalculateDecision(applicationId, "autopilot_section");

    if (created.length === 0) return; // idempotent no-op → don't narrate

    let readinessLine: string | null = null;
    try {
      const readiness = await evaluateBrokerSubmissionReadiness(applicationId);
      readinessLine = readiness.readyToSubmitToLender
        ? "File is packaging-complete — ready to submit to a wholesale lender."
        : `${readiness.nextActions.length} item(s) remain before this file is lender-ready.`;
    } catch {
      /* readiness is advisory */
    }

    const needsList = created.map((c) => c.title).slice(0, 8).join(", ");
    await storage.createDealActivity({
      applicationId,
      activityType: "autopilot_review",
      title: "Autopilot built your document needs list",
      description:
        `Based on your stated details, we'll need ${created.length} item(s): ${needsList}.` +
        (readinessLine ? ` ${readinessLine}` : ""),
      performedBy: application.userId,
    });
  } catch (err) {
    console.error(`[Autopilot] Section run failed for ${params.applicationId} (non-fatal):`, err);
  }
}

export interface AutopilotDocumentRunResult {
  status: "completed" | "skipped" | "failed";
  errorCode: string;
  retryable: boolean;
}

export async function runAutopilotForDocument(
  params: AutopilotDocumentParams,
): Promise<AutopilotDocumentRunResult> {
  const {
    applicationId,
    documentId,
    documentType,
    storagePath,
    mimeType,
    fileSize,
    triggeredBy,
    beforePersist,
    assertActive,
  } = params;
  const startedAt = Date.now();
  let extractionPersisted = false;
  try {
    const application = await storage.getLoanApplication(applicationId);
    if (!application) {
      return { status: "skipped", errorCode: "application_not_found", retryable: false };
    }

    // Defensive re-check of the kill switch + pilot allowlist (the caller also
    // gates; this makes the orchestrator safe to invoke from anywhere).
    if (!(await isAutopilotEnabled(application.loanOfficerId))) {
      return { status: "skipped", errorCode: "autopilot_disabled", retryable: false };
    }

    // Avoid model work when this upload was already reviewed or replaced
    // before the detached job started. Persistence repeats the check because
    // the state can still change while the model is running.
    if (await getDocumentProcessingBlockReason(documentId)) {
      return { status: "skipped", errorCode: "document_no_longer_processable", retryable: false };
    }

    // Live banner: flip the borrower's status to "We're reviewing your
    // information…" for anyone watching the SSE stream in this process.
    await publishReviewing(applicationId);

    // 1. PERCEIVE (+ 2. RECONCILE narration) ---------------------------------
    let outcome: ExtractionOutcome | null = null;
    try {
      outcome = await extractAutopilotDocument(documentType, storagePath, mimeType);
    } catch (err) {
      console.error(`[Autopilot] Extraction failed for ${documentId}:`, err);
      await publishCurrentStatus(applicationId);
      return { status: "failed", errorCode: "provider_or_storage_failure", retryable: true };
    }

    if (outcome) {
      const failure = classifyExtractionResult(outcome.extracted);
      if (failure) {
        await publishCurrentStatus(applicationId);
        return { status: "failed", errorCode: failure.code, retryable: failure.retryable };
      }
      const persisted = await applyExtractionToDocument({
        storage,
        userId: application.userId,
        documentId,
        documentType,
        applicationId,
        fileSize: fileSize ?? undefined,
        extracted: outcome.extracted,
        beforePersist,
      });
      if (persisted.skipReason) {
        await publishCurrentStatus(applicationId);
        return { status: "skipped", errorCode: `document_${persisted.skipReason}`, retryable: false };
      }
      outcome.classificationBlocked = persisted.classificationBlocked;
      extractionPersisted = true;
      await assertActive?.();

      // Governance log stays separate from the encrypted raw response and the
      // structured fact rows written by applyExtractionToDocument.
      await logAiInteraction({
        applicationId,
        userId: triggeredBy,
        workflow: "autopilot_extraction",
        provider: "claude",
        model: outcome.extracted.modelId ?? EXTRACTION_MODEL_ID,
        systemPrompt: outcome.extracted.promptVersion ?? EXTRACTION_PROMPT_VERSION,
        prompt: `Autopilot document extraction: ${documentType} (${documentId})`,
        response: outcome.extracted.extractedFields.join(", "),
        classification: "internal_only",
        latencyMs: Date.now() - startedAt,
      });
    }

    // 3. COGNIZE — refresh the pre-qualification snapshot (append-only, safe). --
    await assertActive?.();
    await recalculateDecision(applicationId, "autopilot_document");

    // 4. ACT — give the file's current flags teeth (cited package follow-ups). -
    let createdFollowUps: string[] = [];
    const flags = (application.preUwFlags as { flags?: PreUwFlag[] } | null)?.flags ?? [];
    if (flags.length > 0 && (await canGenerateFollowUps())) {
      await assertActive?.();
      const res = await materializeFlagsToFollowUps(applicationId, flags);
      createdFollowUps = res.created;
    }

    // 5. Re-check how close the file is to lender-ready (advisory). ------------
    let readinessLine: string | null = null;
    try {
      const readiness = await evaluateBrokerSubmissionReadiness(applicationId);
      readinessLine = readiness.readyToSubmitToLender
        ? "File is packaging-complete — ready to submit to a wholesale lender."
        : `${readiness.nextActions.length} item(s) remain before this file is lender-ready.`;
    } catch {
      /* readiness is advisory; never block narration on it */
    }

    // 6. NARRATE — one rich activity-feed entry (LO Timeline + borrower file). --
    await assertActive?.();
    await storage.createDealActivity({
      applicationId,
      activityType: "autopilot_review",
      title: `Autopilot reviewed ${prettyDocType(documentType)}`,
      description: buildNarration({ outcome, extractionFailed: false, createdFollowUps, readinessLine }),
      performedBy: application.userId,
    });

    // 7. Live banner: push the result state ("Looks good!" / "A few items
    // needed.") to anyone watching the borrower's SSE stream.
    await publishCurrentStatus(applicationId);
    return { status: "completed", errorCode: "none", retryable: false };
  } catch (err) {
    console.error(`[Autopilot] Document run failed for ${params.documentId} (non-fatal):`, err);
    try {
      await publishCurrentStatus(applicationId);
    } catch {
      /* a status refresh must not hide the extraction result */
    }
    // Once structured facts are committed, retrying the whole Autopilot pass
    // would pay for and persist the same extraction twice. The remaining steps
    // are advisory and report their own failures.
    return extractionPersisted
      ? { status: "completed", errorCode: "post_extraction_advisory_failure", retryable: false }
      : { status: "failed", errorCode: "unexpected_autopilot_failure", retryable: true };
  }
}
