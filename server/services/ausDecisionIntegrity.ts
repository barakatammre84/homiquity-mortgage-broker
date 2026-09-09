import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  documentLineage,
  documents,
  extractedFields,
  verificationReports,
} from "@shared/schema";
import { storage } from "../storage";
import { currentDocumentVersions } from "./documentLineage";
import { runInstantDecision, type InstantDecision } from "./decisionEngine";
import type { DuCasefileInput } from "./ausSubmission";

export const AUS_INPUT_FINGERPRINT_VERSION = "aus-casefile-input-v1";

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function fingerprintAusSubmissionInputs(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export type AusDecisionPath = "automated" | "manual_underwrite";

export interface AusSubmissionContext {
  casefileInput: DuCasefileInput | null;
  decision: InstantDecision;
  decisionPath: AusDecisionPath;
  blockers: string[];
  inputFingerprint: string | null;
  evidenceFingerprint: string;
  verificationReportIds: { voa: string | null; voie: string | null };
}

async function latestVerificationReport(applicationId: string, reportType: string) {
  return db
    .select()
    .from(verificationReports)
    .where(and(
      eq(verificationReports.applicationId, applicationId),
      eq(verificationReports.reportType, reportType),
      eq(verificationReports.status, "completed"),
    ))
    .orderBy(desc(verificationReports.completedAt))
    .limit(1)
    .then(rows => rows[0]);
}

async function currentEvidenceFingerprint(applicationId: string): Promise<string> {
  const [documentRows, lineageRows] = await Promise.all([
    db.select().from(documents).where(eq(documents.applicationId, applicationId)),
    db.select().from(documentLineage).where(eq(documentLineage.applicationId, applicationId)),
  ]);
  const current = currentDocumentVersions(documentRows, lineageRows)
    .map(group => group.current)
    .sort((a, b) => compare(a.document.id, b.document.id));
  const documentIds = current.map(item => item.document.id);
  const facts = documentIds.length
    ? await db.select().from(extractedFields).where(inArray(extractedFields.documentId, documentIds))
    : [];
  const factsByDocument = new Map<string, typeof facts>();
  for (const fact of facts) {
    if (!fact.documentId) continue;
    const rows = factsByDocument.get(fact.documentId) ?? [];
    rows.push(fact);
    factsByDocument.set(fact.documentId, rows);
  }

  return fingerprintAusSubmissionInputs(current.map(({ document, lineage }) => ({
    documentId: document.id,
    documentType: document.documentType,
    status: document.status,
    contentSha256: lineage?.contentSha256 ?? null,
    extractionResponseHash: document.extractionResponseHash,
    fields: (factsByDocument.get(document.id) ?? [])
      .map(field => ({
        fieldName: field.fieldName,
        value: field.humanVerified && field.humanCorrectedValue != null
          ? field.humanCorrectedValue
          : field.valueNumeric ?? field.valueDate ?? field.valueBoolean ?? field.valueString,
        confidence: field.confidence,
        humanVerified: field.humanVerified,
      }))
      .sort((a, b) => compare(a.fieldName, b.fieldName)),
  })));
}

/**
 * Build the exact decision-grade inputs that a DU/LPA run will consume.
 * The deterministic engine remains the single producer of income, debts,
 * housing expense and policy resolution, avoiding a second calculation path.
 */
export async function buildAusSubmissionContext(applicationId: string): Promise<AusSubmissionContext> {
  const application = await storage.getLoanApplication(applicationId);
  if (!application) throw new Error("Application not found");

  const [decision, voa, voie, evidenceFingerprint] = await Promise.all([
    runInstantDecision(applicationId),
    latestVerificationReport(applicationId, "voa"),
    latestVerificationReport(applicationId, "voie"),
    currentEvidenceFingerprint(applicationId),
  ]);
  const decisionPath: AusDecisionPath = decision.decision === "MANUAL_REVIEW"
    ? "manual_underwrite"
    : "automated";
  const blockers = decision.status === "NEEDS_MORE_INFO"
    ? decision.missingItems
    : decision.metrics
      ? []
      : decisionPath === "manual_underwrite"
        ? decision.reasons.length
          ? decision.reasons
          : ["The file is outside the automated underwriting matrix and needs a manual underwriter."]
        : ["Decision inputs could not be assembled."];

  if (!decision.metrics) {
    return {
      casefileInput: null,
      decision,
      decisionPath,
      blockers,
      inputFingerprint: null,
      evidenceFingerprint,
      verificationReportIds: { voa: voa?.id ?? null, voie: voie?.id ?? null },
    };
  }

  const purchasePrice = Number(application.purchasePrice ?? 0);
  if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
    return {
      casefileInput: null,
      decision,
      decisionPath,
      blockers: ["Purchase price is required before automated underwriting can run."],
      inputFingerprint: null,
      evidenceFingerprint,
      verificationReportIds: { voa: voa?.id ?? null, voie: voie?.id ?? null },
    };
  }

  const casefileInput: DuCasefileInput = {
    applicationId,
    loanAmount: decision.metrics.loanAmount,
    propertyValue: purchasePrice,
    creditScore: application.creditScore,
    dti: Number((decision.metrics.dti / 100).toFixed(4)),
    voaReportId: voa?.voaReportId ?? null,
    voieReportId: voie?.voieReportId ?? null,
    auditCopyToken: voa?.auditCopyToken ?? null,
    decisionPath,
    manualUnderwriteReasons: decisionPath === "manual_underwrite" ? decision.reasons : [],
  };
  const inputFingerprint = fingerprintAusSubmissionInputs({
    version: AUS_INPUT_FINGERPRINT_VERSION,
    casefileInput,
    decisionInputsFingerprint: decision.inputsFingerprint,
    policyFingerprint: decision.resolvedPolicy?.fingerprint ?? null,
    incomeEvaluationFingerprint: decision.income?.evaluationFingerprint ?? null,
    evidenceFingerprint,
    verificationReports: {
      voa: voa ? { id: voa.id, reportId: voa.voaReportId, completedAt: voa.completedAt } : null,
      voie: voie ? { id: voie.id, reportId: voie.voieReportId, completedAt: voie.completedAt } : null,
    },
  });

  return {
    casefileInput,
    decision,
    decisionPath,
    blockers,
    inputFingerprint,
    evidenceFingerprint,
    verificationReportIds: { voa: voa?.id ?? null, voie: voie?.id ?? null },
  };
}

export interface PersistedAusIntegrity {
  version: string;
  inputFingerprint: string;
  evidenceFingerprint: string;
  decisionInputsFingerprint: string;
  policyFingerprint: string | null;
  decisionPath: AusDecisionPath;
}

export async function evaluateAusInputFreshness(
  applicationId: string,
  persistedFindings: unknown,
): Promise<{ current: boolean; reason: string | null; currentFingerprint: string | null }> {
  const integrity = (persistedFindings as { inputIntegrity?: Partial<PersistedAusIntegrity> } | null)?.inputIntegrity;
  if (!integrity?.inputFingerprint || integrity.version !== AUS_INPUT_FINGERPRINT_VERSION) {
    return {
      current: false,
      reason: "The recorded AUS run predates input lineage and must be run again.",
      currentFingerprint: null,
    };
  }
  const context = await buildAusSubmissionContext(applicationId);
  if (!context.inputFingerprint) {
    return {
      current: false,
      reason: context.blockers[0] ?? "Current decision inputs cannot support an AUS run.",
      currentFingerprint: null,
    };
  }
  if (context.inputFingerprint !== integrity.inputFingerprint) {
    return {
      current: false,
      reason: "Borrower facts, source evidence, verification, or underwriting policy changed after the recorded AUS run.",
      currentFingerprint: context.inputFingerprint,
    };
  }
  return { current: true, reason: null, currentFingerprint: context.inputFingerprint };
}
