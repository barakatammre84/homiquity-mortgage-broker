export type CoreCapabilityState =
  | "live"
  | "simulated"
  | "disabled"
  | "configuration_error";

export type CoreCapabilityVerificationState =
  | "current"
  | "stale"
  | "failed"
  | "not_recorded"
  | "not_required";

export interface CoreCapabilityStatus {
  id:
    | "homi"
    | "document_extraction"
    | "object_storage"
    | "plaid_verification"
    | "underwriting_engine"
    | "financial_analysis"
    | "credit"
    | "du"
    | "lpa"
    | "pricing"
    | "lender_delivery";
  label: string;
  provider: string;
  state: CoreCapabilityState;
  criticalForLiveLoan: boolean;
  verificationRequired: boolean;
  verificationState: CoreCapabilityVerificationState;
  lastVerificationAttemptAt: string | null;
  lastSuccessfulVerificationAt: string | null;
  detail: string;
  nextAction: string | null;
}

export interface CoreCapabilityCanaryProof {
  latestAttempt: {
    status: "success" | "failure" | "configuration_error";
    completedAt: string;
    environment?: string;
    commitSha?: string | null;
  } | null;
  lastSuccess: { completedAt: string; environment?: string; commitSha?: string | null } | null;
}

export type CoreCapabilityCanaryProofMap = Partial<Record<string, CoreCapabilityCanaryProof>>;

const CANARY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function verificationFor(
  required: boolean,
  proof: CoreCapabilityCanaryProof | undefined,
  now: Date,
  expectedEnvironment: "production" | "non_production",
  expectedCommit: string | null,
): Pick<CoreCapabilityStatus, "verificationRequired" | "verificationState" | "lastVerificationAttemptAt" | "lastSuccessfulVerificationAt"> {
  if (!required) {
    return {
      verificationRequired: false,
      verificationState: "not_required",
      lastVerificationAttemptAt: null,
      lastSuccessfulVerificationAt: null,
    };
  }
  const latestAttemptAt = proof?.latestAttempt?.completedAt ?? null;
  const lastSuccessAt = proof?.lastSuccess?.completedAt ?? null;
  if (!proof?.latestAttempt) {
    return {
      verificationRequired: true,
      verificationState: "not_recorded",
      lastVerificationAttemptAt: null,
      lastSuccessfulVerificationAt: lastSuccessAt,
    };
  }
  if (proof.latestAttempt.status !== "success") {
    return {
      verificationRequired: true,
      verificationState: "failed",
      lastVerificationAttemptAt: latestAttemptAt,
      lastSuccessfulVerificationAt: lastSuccessAt,
    };
  }
  const wrongEnvironment = proof.latestAttempt.environment !== undefined &&
    proof.latestAttempt.environment !== expectedEnvironment;
  const wrongProductionBuild = expectedEnvironment === "production" &&
    (!expectedCommit || proof.latestAttempt.commitSha !== expectedCommit);
  const age = now.getTime() - new Date(proof.latestAttempt.completedAt).getTime();
  return {
    verificationRequired: true,
    verificationState:
      !wrongEnvironment && !wrongProductionBuild && age >= 0 && age <= CANARY_MAX_AGE_MS
        ? "current"
        : "stale",
    lastVerificationAttemptAt: latestAttemptAt,
    lastSuccessfulVerificationAt: lastSuccessAt,
  };
}

export interface CoreCapabilityReport {
  generatedAt: string;
  environment: "production" | "non_production";
  readyForLiveLoanLifecycle: boolean;
  counts: Record<CoreCapabilityState, number>;
  capabilities: CoreCapabilityStatus[];
}

function has(env: NodeJS.ProcessEnv, name: string): boolean {
  return Boolean(env[name]?.trim());
}

function validServiceAccountJson(value: string | undefined): boolean {
  if (!value) return true;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.project_id === "string" && typeof parsed.client_email === "string";
  } catch {
    return false;
  }
}

/**
 * Reports what the deployed code can truthfully do from configuration alone.
 * It never returns secrets and never equates a configured adapter with a
 * successful end-to-end test: lastSuccessfulVerificationAt stays null until a
 * durable verification ledger exists.
 */
export function getCoreCapabilityReport(
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
  canaryProof: CoreCapabilityCanaryProofMap = {},
): CoreCapabilityReport {
  const production = env.NODE_ENV === "production";
  const reportEnvironment = production ? "production" : "non_production";
  const anthropicCoach = has(env, "ANTHROPIC_API_KEY");
  const anthropicExtraction =
    has(env, "AI_INTEGRATIONS_ANTHROPIC_API_KEY") || anthropicCoach;
  const extractionSimulation = env.EXTRACTION_SIMULATE === "true";

  const privateObjectDir = has(env, "PRIVATE_OBJECT_DIR");
  const invalidServiceAccount = !validServiceAccountJson(env.GCS_SERVICE_ACCOUNT_KEY);
  const plaidId = has(env, "PLAID_CLIENT_ID");
  const plaidSecret = has(env, "PLAID_SECRET");
  const plaidWebhook = has(env, "PLAID_WEBHOOK_SECRET");
  const plaidPartial = plaidId !== plaidSecret;

  const creditKey = has(env, "CREDIT_VENDOR_API_KEY");
  const creditSimulation = env.CREDIT_VENDOR_MODE === "simulation";
  const duKey = has(env, "FANNIE_DU_API_KEY");
  const lpaKey = has(env, "FREDDIE_LPA_API_KEY");

  type CapabilityConfig = Omit<
    CoreCapabilityStatus,
    "verificationRequired" | "verificationState" | "lastVerificationAttemptAt"
  >;
  const configuredCapabilities: CapabilityConfig[] = [
    {
      id: "homi",
      label: "Homi guidance",
      provider: "Anthropic Claude",
      state: anthropicCoach ? "live" : "disabled",
      criticalForLiveLoan: false,
      lastSuccessfulVerificationAt: null,
      detail: anthropicCoach
        ? "The AI guidance adapter is configured; remote response success is not yet recorded."
        : "Borrowers receive clearly labeled offline guidance instead of model-generated help.",
      nextAction: anthropicCoach
        ? "Record a redacted production canary so the last successful Homi verification is visible."
        : "Configure ANTHROPIC_API_KEY before promising AI guidance.",
    },
    {
      id: "document_extraction",
      label: "Document extraction",
      provider: "Anthropic Claude vision",
      state: production && extractionSimulation
        ? "configuration_error"
        : anthropicExtraction
        ? "live"
        : extractionSimulation
          ? "simulated"
          : "disabled",
      criticalForLiveLoan: true,
      lastSuccessfulVerificationAt: null,
      detail: production && extractionSimulation
        ? "EXTRACTION_SIMULATE is incompatible with production and extraction will fail closed."
        : anthropicExtraction
        ? "The extraction adapter is configured; field accuracy still requires human-graded evidence."
        : extractionSimulation
          ? "Deterministic sample values are enabled and must never be treated as borrower facts."
          : "Uploads can be reviewed manually, but automated extraction is unavailable.",
      nextAction: production && extractionSimulation
        ? "Remove EXTRACTION_SIMULATE from the production environment."
        : anthropicExtraction
        ? "Run a labeled production document set and grade fields before setting an accuracy claim."
        : "Configure an extraction key and validate it with a representative document set.",
    },
    {
      id: "object_storage",
      label: "Private document storage",
      provider: "Google Cloud Storage",
      state: invalidServiceAccount
        ? "configuration_error"
        : privateObjectDir
          ? "live"
          : "disabled",
      criticalForLiveLoan: true,
      lastSuccessfulVerificationAt: null,
      detail: invalidServiceAccount
        ? "GCS_SERVICE_ACCOUNT_KEY is present but is not valid service-account JSON."
        : privateObjectDir
          ? "A private object directory is configured; upload, redeploy, and download survival is not yet recorded."
          : "Persistent private uploads are unavailable.",
      nextAction: invalidServiceAccount
        ? "Replace the malformed service-account configuration."
        : "Run and record an upload → redeploy → authorized download acceptance test.",
    },
    {
      id: "plaid_verification",
      label: "Asset and income verification",
      provider: "Plaid",
      state: plaidPartial || (production && plaidId && !plaidWebhook)
        ? "configuration_error"
        : plaidId && plaidSecret
          ? "live"
          : "disabled",
      criticalForLiveLoan: false,
      lastSuccessfulVerificationAt: null,
      detail: plaidPartial
        ? "Only one of PLAID_CLIENT_ID and PLAID_SECRET is configured."
        : production && plaidId && !plaidWebhook
          ? "Plaid credentials exist, but the production assets webhook cannot authenticate without PLAID_WEBHOOK_SECRET."
          : plaidId
            ? "The Plaid adapter is configured; a successful verification is not yet recorded."
            : "Plaid verification is unavailable; documents remain the evidence path.",
      nextAction: plaidId && plaidSecret && (!production || plaidWebhook)
        ? "Record a sandbox or production verification canary."
        : "Complete and test the Plaid credential and webhook configuration.",
    },
    {
      id: "underwriting_engine",
      label: "Deterministic underwriting",
      provider: "Homiquity policy engine",
      state: "live",
      criticalForLiveLoan: true,
      lastSuccessfulVerificationAt: null,
      detail: "Deterministic rules, evidence gates, input and policy fingerprints, stale-output blocking, decision snapshots, and a manual-underwrite path are implemented.",
      nextAction: "Run the selected live AUS path and retain its provider-native signed findings before lender handoff.",
    },
    {
      id: "financial_analysis",
      label: "Complex-income analysis",
      provider: "Homiquity financial review",
      state: "live",
      criticalForLiveLoan: true,
      lastSuccessfulVerificationAt: null,
      detail: "Self-employment, rental, tax tie-outs, workpapers, review checkpoints, and cited income packages are implemented.",
      nextAction: "Keep capital gains, gross-up, continuance, asset depletion, and lender-specific non-QM methods blocked until their governing matrices are obtained.",
    },
    {
      id: "credit",
      label: "Mortgage credit report",
      provider: "No contracted bureau adapter",
      state: creditKey
        ? "configuration_error"
        : creditSimulation || !production
          ? "simulated"
          : "disabled",
      criticalForLiveLoan: true,
      lastSuccessfulVerificationAt: null,
      detail: creditKey
        ? "CREDIT_VENDOR_API_KEY is set, but no live bureau adapter exists; the key would misstate provenance."
        : creditSimulation || !production
          ? "The workflow uses clearly marked fabricated scores for testing."
          : "Production refuses fabricated bureau scores.",
      nextAction: "Contract a credit vendor, implement the adapter, and complete FCRA acceptance testing.",
    },
    {
      id: "du",
      label: "Fannie Mae DU",
      provider: "Desktop Underwriter",
      state: duKey ? "configuration_error" : "simulated",
      criticalForLiveLoan: true,
      lastSuccessfulVerificationAt: null,
      detail: duKey
        ? "A DU key is present, but the live adapter is intentionally unimplemented and will refuse the call."
        : "The current result is a clearly labeled deterministic DU-shaped simulation.",
      nextAction: "Complete Fannie technology-provider onboarding and retain the provider-native findings beside Homiquity's hashed package artifact.",
    },
    {
      id: "lpa",
      label: "Freddie Mac LPA",
      provider: "Loan Product Advisor",
      state: lpaKey ? "configuration_error" : "simulated",
      criticalForLiveLoan: true,
      lastSuccessfulVerificationAt: null,
      detail: lpaKey
        ? "An LPA key is present, but the live adapter is intentionally unimplemented and will refuse the call."
        : "The current result is a clearly labeled deterministic LPA-shaped simulation.",
      nextAction: "Complete Freddie technology onboarding and implement the live adapter.",
    },
    {
      id: "pricing",
      label: "Executable mortgage pricing",
      provider: "Stored wholesale rate sheets",
      state: "simulated",
      criticalForLiveLoan: true,
      lastSuccessfulVerificationAt: null,
      detail: "The pricing and adjustment math works, but this report cannot prove an approved current lender sheet is loaded.",
      nextAction: "Load one approved lender's current rate sheet and record effective-date and test-case verification.",
    },
    {
      id: "lender_delivery",
      label: "Wholesale lender delivery",
      provider: "No approved receiver workflow",
      state: "simulated",
      criticalForLiveLoan: true,
      lastSuccessfulVerificationAt: null,
      detail: "Package assembly and submission tracking work, but the receiver acknowledgment is generated locally.",
      nextAction: "Choose one approved lender and pass its real receiver acceptance test.",
    },
  ];

  const canaryRequired = new Set<CoreCapabilityStatus["id"]>([
    "homi",
    "document_extraction",
    "object_storage",
    "plaid_verification",
    "credit",
    "du",
    "lpa",
    "pricing",
    "lender_delivery",
  ]);
  const capabilities: CoreCapabilityStatus[] = configuredCapabilities.map((capability) => ({
    ...capability,
    ...verificationFor(
      canaryRequired.has(capability.id),
      canaryProof[capability.id],
      now,
      reportEnvironment,
      env.RAILWAY_GIT_COMMIT_SHA ?? null,
    ),
  }));

  const counts: Record<CoreCapabilityState, number> = {
    live: 0,
    simulated: 0,
    disabled: 0,
    configuration_error: 0,
  };
  for (const capability of capabilities) counts[capability.state] += 1;

  return {
    generatedAt: now.toISOString(),
    environment: reportEnvironment,
    readyForLiveLoanLifecycle: capabilities
      .filter((capability) => capability.criticalForLiveLoan)
      .every((capability) =>
        capability.state === "live" &&
        (!capability.verificationRequired || capability.verificationState === "current")
      ),
    counts,
    capabilities,
  };
}
