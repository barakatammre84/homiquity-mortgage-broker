import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { storage } from "../storage";
import { runInstantDecision } from "./decisionEngine";
import { evaluateBrokerSubmissionReadiness } from "./brokerSubmissionReadiness";
import { computePrediction } from "./predictiveEngine";
import { getLatestSituationProfile } from "./situationClassifier";
import { logAiInteraction } from "./aiInteractionLog";
import {
  riskBriefNarrativeSchema,
  RISK_BRIEF_DISCLAIMER,
  type RiskBriefFacts,
  type RiskBriefNarrative,
  type RiskBriefResult,
  type RiskBriefDegradedReason,
} from "@shared/riskBrief";

// =============================================================================
// Staff-facing AI "file risk brief" (roadmap A4) — ADVISORY ONLY.
//
// Narrates the deterministic engines' outputs for one application; it never
// computes, gates, or feeds a decision, and it must never reach the
// adverse-action path (both enforced in tests/complianceInvariants.test.ts).
// Model output is untrusted until it passes the Zod schema AND the echo-only
// number check: any figure not present in the deterministic facts discards the
// narrative in favor of the deterministic template (extractionService posture:
// our own validation overrides the model).
// =============================================================================

// Same tier rationale as single-document extraction (extractionService.ts):
// bounded synthesis over pre-computed structured facts — vision-free,
// arithmetic-free, not reasoning-heavy. Opus stays reserved for the
// tax-package pass. Bump the prompt version on ANY prompt change
// (AI_GOVERNANCE_POLICY §5.5).
export const RISK_BRIEF_MODEL = "claude-sonnet-5";
export const RISK_BRIEF_PROMPT_VERSION = "risk-brief-1.0.0";

// max_tokens is the TOTAL budget (adaptive thinking + JSON text) on Sonnet 5,
// so leave headroom above the bounded narrative size.
const MAX_OUTPUT_TOKENS = 4096;

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Env kill switch, read per-request (maintenanceMode pattern — no restart). */
export function isRiskBriefDisabled(): boolean {
  return TRUTHY.has((process.env.RISK_BRIEF_DISABLED ?? "").trim().toLowerCase());
}

export function isRiskBriefConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Lazy client (coachingService pattern): boot must not depend on AI
// credentials, and the degraded template keeps the surface useful without one.
let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 20_000,
      maxRetries: 1,
    });
  }
  return anthropicClient;
}

// ---------------------------------------------------------------------------
// Facts assembly — read-only composition of existing deterministic outputs.
// Deliberately NOT: recalculateDecision (persists a snapshot) or
// runPreUnderwriting (notifies the borrower, writes conditions). PII posture:
// metrics, flags, and engine reason strings only — no name/SSN/DOB/address —
// so the ai_interactions.prompt log stays PII-clean.
// ---------------------------------------------------------------------------

export async function assembleRiskBriefFacts(applicationId: string): Promise<RiskBriefFacts> {
  const application = await storage.getLoanApplication(applicationId);
  if (!application) {
    throw new Error(`Application ${applicationId} not found`);
  }

  const decision = await runInstantDecision(applicationId);

  const persistedFlags = (application.preUwFlags ?? null) as {
    flags?: Array<{
      code: string;
      severity: "warning" | "blocking";
      reason: string;
      requiredDocs?: Array<{ documentType: string; description: string }>;
    }>;
    evaluatedAt?: string;
  } | null;

  const readiness = await evaluateBrokerSubmissionReadiness(applicationId);

  let prediction: RiskBriefFacts["prediction"] = null;
  try {
    const p = await computePrediction(application.userId, applicationId);
    prediction = { riskFactors: p.riskFactors, positiveFactors: p.positiveFactors };
  } catch {
    prediction = null; // advisory input — absence must never fail the brief
  }

  let situation: RiskBriefFacts["situation"] = null;
  try {
    const row = await getLatestSituationProfile(application.userId, applicationId);
    if (row) {
      situation = {
        selfEmployed: row.selfEmployed,
        multiEntity: row.multiEntity,
        rentalPresent: row.rentalPresent,
        k1Present: row.k1Present,
        entityCount: row.entityCount,
        varianceCount: row.varianceCount,
        documentRequestCount: row.documentRequestCount,
      };
    }
  } catch {
    situation = null;
  }

  return {
    applicationId,
    provenanceQualifier: decision.qualifier,
    decision: {
      status: decision.status,
      decision: decision.decision,
      reasons: decision.reasons,
      missingItems: decision.missingItems,
      metrics: decision.metrics
        ? {
            ltv: decision.metrics.ltv,
            dti: decision.metrics.dti,
            monthlyPiti: decision.metrics.monthlyPiti,
            loanAmount: decision.metrics.loanAmount,
            monthlyIncome: decision.metrics.monthlyIncome,
            monthlyDebts: decision.metrics.monthlyDebts,
            monthsOfReserves: decision.metrics.monthsOfReserves,
            incomeBasis: decision.metrics.incomeBasis,
          }
        : null,
      policy: decision.resolvedPolicy
        ? {
            loanType: decision.resolvedPolicy.loanType,
            dtiCapPct: decision.resolvedPolicy.conventionalDtiCapPct ?? null,
            ltvCapPct: decision.resolvedPolicy.conventionalLtvCapPct ?? null,
            fingerprint: decision.resolvedPolicy.fingerprint,
          }
        : null,
    },
    preUwFlags: {
      evaluatedAt: persistedFlags?.evaluatedAt ?? null,
      flags: (persistedFlags?.flags ?? []).map((f) => ({
        code: f.code,
        severity: f.severity,
        reason: f.reason,
        requiredDocs: (f.requiredDocs ?? []).map((d) => d.description),
      })),
    },
    readiness: {
      readyToSubmitToLender: readiness.readyToSubmitToLender,
      currentStage: readiness.currentStage,
      blockers: readiness.stages.flatMap((s) => s.blockers),
      warnings: readiness.stages.flatMap((s) => s.warnings),
      nextActions: readiness.nextActions,
    },
    prediction,
    situation,
  };
}

// ---------------------------------------------------------------------------
// Echo-only number validation. The narrative may only contain figures that
// exist in the facts — as numeric leaves, or inside fact strings (engine
// reasons quote dollar amounts, dates, thresholds). Anything else is treated
// as model-invented and discards the narrative.
// ---------------------------------------------------------------------------

const NUMBER_TOKEN = /\$?\d[\d,]*(?:\.\d+)?%?/g;

function normalizeNumberToken(token: string): string {
  return token.replace(/[$,%]/g, "").replace(/\.$/, "");
}

function addNumberVariants(set: Set<string>, n: number): void {
  if (!Number.isFinite(n)) return;
  set.add(normalizeNumberToken(String(n)));
  set.add(normalizeNumberToken(n.toFixed(0)));
  set.add(normalizeNumberToken(n.toFixed(1)));
  set.add(normalizeNumberToken(n.toFixed(2)));
  set.add(normalizeNumberToken(Math.abs(n).toString()));
}

export function buildAllowedNumberSet(facts: RiskBriefFacts): Set<string> {
  const allowed = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "number") {
      addNumberVariants(allowed, value);
    } else if (typeof value === "string") {
      for (const token of value.match(NUMBER_TOKEN) ?? []) {
        allowed.add(normalizeNumberToken(token));
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(facts);
  return allowed;
}

export function findUnsourcedNumbers(
  narrative: RiskBriefNarrative,
  allowed: Set<string>,
): string[] {
  const texts: string[] = [
    narrative.summary,
    ...narrative.keyRisks.flatMap((r) => [r.factor, r.why, r.remediation]),
    ...narrative.strengths,
    ...narrative.suggestedBorrowerQuestions,
  ];
  const offenders = new Set<string>();
  for (const text of texts) {
    for (const token of text.match(NUMBER_TOKEN) ?? []) {
      if (!allowed.has(normalizeNumberToken(token))) offenders.add(token);
    }
  }
  return [...offenders];
}

// ---------------------------------------------------------------------------
// Model-output parsing (extractionService seam: regex-extract + safeParse;
// hard-fail — a broken narrative falls back to the template, nothing to
// salvage per-field).
// ---------------------------------------------------------------------------

export function validateRiskBriefResponse(rawText: string): RiskBriefNarrative | null {
  const stripped = rawText.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = riskBriefNarrativeSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// Deterministic template fallback — also the keyless unit-test path. Always
// labeled degraded; never silently impersonates the model
// (coachingService generateOfflineResponse posture).
// ---------------------------------------------------------------------------

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function buildDeterministicBrief(facts: RiskBriefFacts): RiskBriefNarrative {
  const d = facts.decision;
  const summaryParts: string[] = [];
  if (d.status === "NEEDS_MORE_INFO") {
    summaryParts.push(
      "The deterministic decision engine needs more information before it can evaluate this file.",
    );
  } else if (d.decision) {
    summaryParts.push(
      `The deterministic decision engine currently reads this file as ${d.decision} on ${facts.provenanceQualifier} data.`,
    );
  }
  if (facts.preUwFlags.flags.length > 0) {
    summaryParts.push(
      `Pre-underwriting raised ${facts.preUwFlags.flags.length === 1 ? "one flag" : "multiple flags"} (see key risks).`,
    );
  }
  summaryParts.push(
    facts.readiness.readyToSubmitToLender
      ? "Submission readiness reports the file can go to a wholesale lender."
      : `Submission readiness is blocked at the ${facts.readiness.currentStage} stage.`,
  );

  const keyRisks: RiskBriefNarrative["keyRisks"] = [];
  for (const reason of d.reasons) {
    keyRisks.push({
      factor: "Underwriting finding",
      why: clip(reason, 500),
      remediation: clip(
        d.missingItems.length > 0
          ? `Complete the missing inputs: ${d.missingItems.join(", ")}`
          : "Review with the borrower and document the resolution before resubmitting.",
        400,
      ),
    });
  }
  for (const flag of facts.preUwFlags.flags) {
    keyRisks.push({
      factor: clip(`Pre-UW flag: ${flag.code}`, 120),
      why: clip(flag.reason, 500),
      remediation: clip(
        flag.requiredDocs.length > 0
          ? `Collect: ${flag.requiredDocs.join("; ")}`
          : "Review the flagged condition with the borrower.",
        400,
      ),
    });
  }
  for (const blocker of facts.readiness.blockers) {
    keyRisks.push({
      factor: "Submission blocker",
      why: clip(blocker, 500),
      remediation: "Clear this blocker before lender submission.",
    });
  }
  for (const rf of facts.prediction?.riskFactors ?? []) {
    keyRisks.push({
      factor: clip(rf, 120),
      why: "Flagged by the deterministic predictive heuristic.",
      remediation: "Discuss with the borrower; not a decision input.",
    });
  }

  const strengths = (facts.prediction?.positiveFactors ?? []).map((s) => clip(s, 300));

  const questions: string[] = [];
  for (const item of d.missingItems) {
    questions.push(clip(`Can you provide your ${item.toLowerCase()}?`, 300));
  }
  for (const action of facts.readiness.nextActions) {
    questions.push(clip(action, 300));
  }

  return riskBriefNarrativeSchema.parse({
    summary: clip(summaryParts.join(" "), 1200),
    keyRisks: keyRisks.slice(0, 8),
    strengths: strengths.slice(0, 8),
    suggestedBorrowerQuestions: questions.slice(0, 6),
  });
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an internal underwriting-support writer for a mortgage BROKER platform. Staff (loan officers and processors) read your brief; borrowers never see it.

You will receive a JSON document of DETERMINISTIC engine outputs for one loan file. Your only job is to narrate and synthesize them. Hard rules:
1. ECHO-ONLY NUMBERS. Never compute, derive, sum, round, or introduce any figure not present verbatim in the input. If a figure is absent, write "not on file". Prefer words for counts ("two flags", not "2 flags").
2. NEVER contradict the engines. The decision, reasons, and flags in the input are ground truth; explain WHY they say what they say using only the input's reason text and metrics.
3. ADVISORY ONLY. No approve/deny recommendations, no eligibility conclusions, no guarantee or approval language, nothing usable in an adverse-action notice.
4. Cite guidelines ONLY by repeating citation strings already present in the input. Never add your own citations.
5. Respond with ONLY a JSON object of this exact shape (no markdown, no prose outside the JSON):
{"summary": string, "keyRisks": [{"factor": string, "why": string, "remediation": string}], "strengths": [string], "suggestedBorrowerQuestions": [string]}
remediation = the documentation or action that would resolve the risk, drawn from the input's requiredDocs, missingItems, and nextActions.`;

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function generateRiskBrief(
  applicationId: string,
  ctx: { userId: string; userRole: string },
): Promise<RiskBriefResult> {
  const facts = await assembleRiskBriefFacts(applicationId);
  const factsJson = JSON.stringify(facts, null, 2);
  const factsFingerprint = createHash("sha256").update(factsJson).digest("hex");
  const generatedAt = new Date().toISOString();

  const degradedResult = (reason: RiskBriefDegradedReason): RiskBriefResult => ({
    applicationId,
    facts,
    narrative: buildDeterministicBrief(facts),
    disclaimer: RISK_BRIEF_DISCLAIMER,
    degraded: true,
    degradedReason: reason,
    lineage: { model: "deterministic-template", promptVersion: RISK_BRIEF_PROMPT_VERSION, generatedAt },
  });

  if (isRiskBriefDisabled()) return degradedResult("disabled");
  if (!isRiskBriefConfigured()) return degradedResult("not_configured");

  const startedAt = Date.now();
  let response: Anthropic.Message;
  try {
    response = await getAnthropic().messages.create({
      model: RISK_BRIEF_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Write the risk brief for this file (data qualifier: ${facts.provenanceQualifier}; pre-UW flags evaluated: ${facts.preUwFlags.evaluatedAt ?? "never"}).\n\n${factsJson}`,
        },
      ],
    });
  } catch (error) {
    console.error("[risk-brief] model call failed:", error);
    await logRiskBriefInteraction({
      applicationId,
      ctx,
      factsJson,
      factsFingerprint,
      rawText: null,
      latencyMs: Date.now() - startedAt,
      degradedReason: "model_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return degradedResult("model_error");
  }

  const latencyMs = Date.now() - startedAt;
  const rawText =
    response.stop_reason === "refusal"
      ? ""
      : response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");

  const narrative = validateRiskBriefResponse(rawText);
  const unsourced = narrative ? findUnsourcedNumbers(narrative, buildAllowedNumberSet(facts)) : [];
  const failed = !narrative || unsourced.length > 0;

  await logRiskBriefInteraction({
    applicationId,
    ctx,
    factsJson,
    factsFingerprint,
    rawText,
    latencyMs,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
    degradedReason: failed ? "validation_failed" : undefined,
    unsourcedNumbers: unsourced.length > 0 ? unsourced : undefined,
  });

  if (failed) return degradedResult("validation_failed");

  return {
    applicationId,
    facts,
    narrative: narrative!,
    disclaimer: RISK_BRIEF_DISCLAIMER,
    degraded: false,
    lineage: {
      model: RISK_BRIEF_MODEL,
      promptVersion: RISK_BRIEF_PROMPT_VERSION,
      rawResponseHash: createHash("sha256").update(rawText).digest("hex"),
      generatedAt,
    },
  };
}

async function logRiskBriefInteraction(entry: {
  applicationId: string;
  ctx: { userId: string; userRole: string };
  factsJson: string;
  factsFingerprint: string;
  rawText: string | null;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  degradedReason?: RiskBriefDegradedReason;
  unsourcedNumbers?: string[];
  errorMessage?: string;
}): Promise<void> {
  await logAiInteraction({
    applicationId: entry.applicationId,
    userId: entry.ctx.userId,
    workflow: "risk_brief",
    userRole: entry.ctx.userRole,
    provider: "claude",
    model: RISK_BRIEF_MODEL,
    systemPrompt: RISK_BRIEF_PROMPT_VERSION,
    prompt: entry.factsJson,
    response: entry.rawText,
    classification: "internal_only",
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    latencyMs: entry.latencyMs,
    isError: entry.errorMessage ? "true" : "false",
    errorMessage: entry.errorMessage,
    metadata: {
      promptVersion: RISK_BRIEF_PROMPT_VERSION,
      factsFingerprint: entry.factsFingerprint,
      ...(entry.degradedReason ? { degradedReason: entry.degradedReason } : {}),
      ...(entry.unsourcedNumbers ? { unsourcedNumbers: entry.unsourcedNumbers } : {}),
    },
  });
}
