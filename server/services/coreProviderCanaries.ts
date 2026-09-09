import PDFDocument from "pdfkit";
import { and, desc, eq } from "drizzle-orm";
import { coreProviderCanaryRuns } from "@shared/schema";
import { db } from "../db";
import { ObjectStorageService } from "../integrations/object_storage";
import { COACH_MODEL, getAnthropic, isCoachConfigured } from "./coachingClient";
import {
  anthropic as extractionAnthropic,
  EXTRACTION_MODEL_SINGLE_DOC,
} from "../extractionCore";

export const CORE_CANARY_CAPABILITIES = [
  "homi",
  "document_extraction",
  "object_storage",
] as const;

export type CoreCanaryCapabilityId = (typeof CORE_CANARY_CAPABILITIES)[number];
export type CoreCanaryStatus = "success" | "failure" | "configuration_error";
export type CoreCanaryFailureClass =
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "timeout"
  | "provider_unavailable"
  | "invalid_response"
  | "storage_round_trip"
  | "unknown";

export interface CoreCanaryResult {
  id: string;
  capabilityId: CoreCanaryCapabilityId;
  provider: string;
  operation: string;
  environment: string;
  status: CoreCanaryStatus;
  latencyMs: number;
  failureClass: CoreCanaryFailureClass | null;
  commitSha: string | null;
  completedAt: string;
}

export interface CoreCanaryProof {
  latestAttempt: CoreCanaryResult | null;
  lastSuccess: CoreCanaryResult | null;
}

export interface CoreCanarySweepResult {
  total: number;
  successful: number;
  failed: number;
  results: CoreCanaryResult[];
}

export type CoreCanaryProofByCapability = Partial<
  Record<CoreCanaryCapabilityId, CoreCanaryProof>
>;

class CanaryExecutionError extends Error {
  constructor(
    readonly failureClass: CoreCanaryFailureClass,
    readonly status: Exclude<CoreCanaryStatus, "success"> = "failure",
  ) {
    super(failureClass);
  }
}

const CANARY_DEFINITIONS: Record<
  CoreCanaryCapabilityId,
  { provider: string; operation: string }
> = {
  homi: { provider: "Anthropic Claude", operation: "text_response" },
  document_extraction: { provider: "Anthropic Claude vision", operation: "synthetic_pdf_read" },
  object_storage: { provider: "Google Cloud Storage", operation: "private_write_read_delete" },
};

function responseText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

async function syntheticCanaryPdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const pdf = new PDFDocument({ size: "LETTER", margin: 72, info: { Title: "Synthetic extraction canary" } });
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("error", reject);
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.fontSize(20).text("HOMI DOCUMENT CANARY", { align: "center" });
    pdf.moveDown(2).fontSize(16).text("Verification code: 7319", { align: "center" });
    pdf.end();
  });
}

async function runHomiCanary(): Promise<void> {
  if (!isCoachConfigured()) {
    throw new CanaryExecutionError("configuration", "configuration_error");
  }
  const response = await getAnthropic().messages.create({
    model: COACH_MODEL,
    max_tokens: 20,
    system: "This is an operational canary with no borrower data. Reply with exactly HOMI_CANARY_OK.",
    messages: [{ role: "user", content: "Return the required canary token." }],
  });
  if (responseText(response) !== "HOMI_CANARY_OK") {
    throw new CanaryExecutionError("invalid_response");
  }
}

async function runExtractionCanary(): Promise<void> {
  if (!extractionAnthropic) {
    throw new CanaryExecutionError("configuration", "configuration_error");
  }
  if (process.env.NODE_ENV === "production" && process.env.EXTRACTION_SIMULATE === "true") {
    throw new CanaryExecutionError("configuration", "configuration_error");
  }
  const pdf = await syntheticCanaryPdf();
  const response = await extractionAnthropic.messages.create({
    model: EXTRACTION_MODEL_SINGLE_DOC,
    max_tokens: 20,
    messages: [{
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: pdf.toString("base64"),
          },
        },
        {
          type: "text",
          text: "Read the verification code in this synthetic PDF. Reply with exactly EXTRACTION_CANARY_OK_7319.",
        },
      ],
    }],
  });
  if (responseText(response) !== "EXTRACTION_CANARY_OK_7319") {
    throw new CanaryExecutionError("invalid_response");
  }
}

async function runObjectStorageCanary(): Promise<void> {
  const objectStorage = new ObjectStorageService();
  if (!objectStorage.isConfigured()) {
    throw new CanaryExecutionError("configuration", "configuration_error");
  }
  try {
    await objectStorage.verifyPrivateStorageRoundTrip();
  } catch {
    throw new CanaryExecutionError("storage_round_trip");
  }
}

function classifyFailure(error: unknown): {
  status: Exclude<CoreCanaryStatus, "success">;
  failureClass: CoreCanaryFailureClass;
} {
  if (error instanceof CanaryExecutionError) {
    return { status: error.status, failureClass: error.failureClass };
  }
  const candidate = error as { status?: number; name?: string; code?: string };
  if (candidate.status === 401 || candidate.status === 403) {
    return { status: "failure", failureClass: "authentication" };
  }
  if (candidate.status === 429) return { status: "failure", failureClass: "rate_limit" };
  if (candidate.name === "AbortError" || candidate.code === "ETIMEDOUT") {
    return { status: "failure", failureClass: "timeout" };
  }
  if (typeof candidate.status === "number" && candidate.status >= 500) {
    return { status: "failure", failureClass: "provider_unavailable" };
  }
  return { status: "failure", failureClass: "unknown" };
}

type CanaryRunner = () => Promise<void>;
const CANARY_TIMEOUT_MS = 30_000;

async function runWithTimeout(runner: CanaryRunner, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      runner(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CanaryExecutionError("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const DEFAULT_RUNNERS: Record<CoreCanaryCapabilityId, CanaryRunner> = {
  homi: runHomiCanary,
  document_extraction: runExtractionCanary,
  object_storage: runObjectStorageCanary,
};

function toResult(row: typeof coreProviderCanaryRuns.$inferSelect): CoreCanaryResult {
  return {
    id: row.id,
    capabilityId: row.capabilityId as CoreCanaryCapabilityId,
    provider: row.provider,
    operation: row.operation,
    environment: row.environment,
    status: row.status as CoreCanaryStatus,
    latencyMs: row.latencyMs,
    failureClass: row.failureClass as CoreCanaryFailureClass | null,
    commitSha: row.commitSha,
    completedAt: row.completedAt.toISOString(),
  };
}

/**
 * Execute one fixed, synthetic check and always retain its redacted outcome.
 * The API receives no prompt, object path, or provider name from the caller.
 */
export async function runCoreProviderCanary(
  capabilityId: CoreCanaryCapabilityId,
  triggeredByUserId: string | null,
  runner: CanaryRunner = DEFAULT_RUNNERS[capabilityId],
  timeoutMs = CANARY_TIMEOUT_MS,
): Promise<CoreCanaryResult> {
  const definition = CANARY_DEFINITIONS[capabilityId];
  const started = Date.now();
  let status: CoreCanaryStatus = "success";
  let failureClass: CoreCanaryFailureClass | null = null;
  try {
    await runWithTimeout(runner, timeoutMs);
  } catch (error) {
    const failure = classifyFailure(error);
    status = failure.status;
    failureClass = failure.failureClass;
    console.warn(`[core-canary] ${capabilityId} failed (${failureClass})`);
  }

  const [saved] = await db.insert(coreProviderCanaryRuns).values({
    capabilityId,
    provider: definition.provider,
    operation: definition.operation,
    environment: process.env.NODE_ENV === "production" ? "production" : "non_production",
    status,
    latencyMs: Math.max(0, Date.now() - started),
    failureClass,
    commitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    triggeredByUserId,
  }).returning();
  return toResult(saved);
}

/**
 * Run the complete borrower-data-free provider proof in parallel. Individual
 * provider failures are persisted and summarized rather than short-circuiting
 * the remaining capabilities, so one outage cannot hide the state of another.
 */
export async function runCoreProviderCanarySweep(
  triggeredByUserId: string | null,
  runners: Partial<Record<CoreCanaryCapabilityId, CanaryRunner>> = {},
  timeoutMs = CANARY_TIMEOUT_MS,
): Promise<CoreCanarySweepResult> {
  const results = await Promise.all(
    CORE_CANARY_CAPABILITIES.map((capabilityId) =>
      runCoreProviderCanary(
        capabilityId,
        triggeredByUserId,
        runners[capabilityId] ?? DEFAULT_RUNNERS[capabilityId],
        timeoutMs,
      ),
    ),
  );
  const successful = results.filter((result) => result.status === "success").length;
  return {
    total: results.length,
    successful,
    failed: results.length - successful,
    results,
  };
}

export async function getCoreCanaryProof(
  environment = process.env.NODE_ENV === "production" ? "production" : "non_production",
): Promise<CoreCanaryProofByCapability> {
  const latestAttempts = await db.selectDistinctOn([coreProviderCanaryRuns.capabilityId])
    .from(coreProviderCanaryRuns)
    .where(eq(coreProviderCanaryRuns.environment, environment))
    .orderBy(coreProviderCanaryRuns.capabilityId, desc(coreProviderCanaryRuns.completedAt));
  const latestSuccesses = await db.selectDistinctOn([coreProviderCanaryRuns.capabilityId])
    .from(coreProviderCanaryRuns)
    .where(and(
      eq(coreProviderCanaryRuns.environment, environment),
      eq(coreProviderCanaryRuns.status, "success"),
    ))
    .orderBy(coreProviderCanaryRuns.capabilityId, desc(coreProviderCanaryRuns.completedAt));

  const proof: CoreCanaryProofByCapability = {};
  for (const capabilityId of CORE_CANARY_CAPABILITIES) {
    const attempt = latestAttempts.find((row) => row.capabilityId === capabilityId);
    const success = latestSuccesses.find((row) => row.capabilityId === capabilityId);
    proof[capabilityId] = {
      latestAttempt: attempt ? toResult(attempt) : null,
      lastSuccess: success ? toResult(success) : null,
    };
  }
  return proof;
}

export async function getRecentCoreProviderCanaries(limit = 30): Promise<CoreCanaryResult[]> {
  const boundedLimit = Math.min(100, Math.max(1, limit));
  const rows = await db.select().from(coreProviderCanaryRuns)
    .orderBy(desc(coreProviderCanaryRuns.completedAt))
    .limit(boundedLimit);
  return rows.map(toResult);
}
