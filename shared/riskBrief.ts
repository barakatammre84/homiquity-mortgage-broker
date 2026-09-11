import { z } from "zod";

/**
 * Staff-facing AI "file risk brief" — shared contract (roadmap A4; extraction
 * from the 2026-07-17 external-artifacts adjudication).
 *
 * The LLM is a NARRATOR, never a calculator: it synthesizes the platform's
 * already-computed deterministic outputs (instant decision, pre-UW flags,
 * submission readiness, predictive factors, situation profile) into a staff
 * brief. Every number in the narrative must be an echo of an input number —
 * enforced server-side (see server/services/riskBrief.ts). The decision path
 * can never import this module (tests/complianceInvariants.test.ts).
 */

export const riskBriefNarrativeSchema = z.object({
  /** One-paragraph synthesis of where the file stands and why. */
  summary: z.string().min(1).max(1200),
  /** Ranked risks: what the engines flagged, why it matters, what resolves it. */
  keyRisks: z
    .array(
      z.object({
        factor: z.string().min(1).max(120),
        why: z.string().min(1).max(500),
        remediation: z.string().min(1).max(400),
      }),
    )
    .max(8),
  strengths: z.array(z.string().min(1).max(300)).max(8),
  /** Concrete asks the LO can put to the borrower next. */
  suggestedBorrowerQuestions: z.array(z.string().min(1).max(300)).max(6),
});

export type RiskBriefNarrative = z.infer<typeof riskBriefNarrativeSchema>;

/**
 * The deterministic inputs the narrative is grounded in. The UI renders every
 * FIGURE from here (never from narrative text); the server builds the
 * echo-only allowed-number set from these values.
 */
export interface RiskBriefFacts {
  applicationId: string;
  /** PRELIMINARY (self-reported) vs VERIFIED (document/credit-backed). */
  provenanceQualifier: "PRELIMINARY" | "VERIFIED";
  decision: {
    status: "DECISION_READY" | "NEEDS_MORE_INFO";
    decision: "APPROVED" | "REJECTED" | "MANUAL_REVIEW" | null;
    reasons: string[];
    missingItems: string[];
    metrics: {
      ltv: number;
      dti: number;
      monthlyPiti: number;
      loanAmount: number;
      monthlyIncome: number;
      monthlyDebts: number;
      monthsOfReserves: number;
      incomeBasis: string;
    } | null;
    /** Resolved policy caps actually used (reproducibility snapshot). */
    policy: {
      loanType: string;
      /** Conventional caps are null on a VA-only policy snapshot. */
      dtiCapPct: number | null;
      ltvCapPct: number | null;
      fingerprint: string;
    } | null;
  };
  preUwFlags: {
    evaluatedAt: string | null;
    flags: Array<{
      code: string;
      severity: "warning" | "blocking";
      reason: string;
      requiredDocs: string[];
    }>;
  };
  readiness: {
    readyToSubmitToLender: boolean;
    currentStage: string;
    blockers: string[];
    warnings: string[];
    nextActions: string[];
  };
  prediction: {
    riskFactors: string[];
    positiveFactors: string[];
  } | null;
  situation: {
    selfEmployed: boolean;
    multiEntity: boolean;
    rentalPresent: boolean;
    k1Present: boolean;
    entityCount: number;
    varianceCount: number;
    documentRequestCount: number;
  } | null;
}

export type RiskBriefDegradedReason =
  | "disabled"
  | "not_configured"
  | "model_error"
  | "validation_failed";

export interface RiskBriefResult {
  applicationId: string;
  facts: RiskBriefFacts;
  narrative: RiskBriefNarrative;
  /** Server-attached constant — never model-authored. */
  disclaimer: string;
  /** True when the narrative is the deterministic template, not the model. */
  degraded: boolean;
  degradedReason?: RiskBriefDegradedReason;
  lineage: {
    model: string;
    promptVersion: string;
    rawResponseHash?: string;
    generatedAt: string;
  };
}

/**
 * Mandatory advisory disclaimer (UDAAP posture; same doctrine as
 * PREDICTION_INSIGHTS_DISCLAIMER in shared/dataProvenance.ts). Rendered
 * verbatim under the brief. Do not soften without compliance/counsel review.
 */
export const RISK_BRIEF_DISCLAIMER =
  "AI-generated advisory summary for internal staff use only — not a credit " +
  "decision, not underwriting guidance of record, and not for adverse-action " +
  "notices or borrower communication. All figures are echoed from the " +
  "deterministic engines; verify against the decision record before acting.";
