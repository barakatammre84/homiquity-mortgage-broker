import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const userId = randomUUID();

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error("Core canary fixtures require a local test database");
  }
  await pool.query(
    `INSERT INTO users (id,email,role) VALUES ($1,$2,'admin')`,
    [userId, `core-canary-${userId}@example.test`],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM core_provider_canary_runs WHERE triggered_by_user_id=$1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id=$1`, [userId]);
  await pool.end();
});

describe.sequential("core provider canary ledger", () => {
  it("persists a successful redacted synthetic check", async () => {
    const { runCoreProviderCanary } = await import("../server/services/coreProviderCanaries");
    const result = await runCoreProviderCanary("homi", userId, async () => undefined);

    expect(result).toMatchObject({
      capabilityId: "homi",
      provider: "Anthropic Claude",
      operation: "grounded_status_turn",
      environment: "non_production",
      status: "success",
      failureClass: null,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const saved = await pool.query(
      `SELECT capability_id,provider,operation,status,failure_class
         FROM core_provider_canary_runs WHERE id=$1`,
      [result.id],
    );
    expect(saved.rows[0]).toEqual({
      capability_id: "homi",
      provider: "Anthropic Claude",
      operation: "grounded_status_turn",
      status: "success",
      failure_class: null,
    });
  });

  it("retains the failure class while preserving the last success", async () => {
    const { getCoreCanaryProof, runCoreProviderCanary } = await import("../server/services/coreProviderCanaries");
    const failed = await runCoreProviderCanary("homi", userId, async () => {
      throw new Error("provider response containing details that must not be stored");
    });
    expect(failed).toMatchObject({ status: "failure", failureClass: "unknown" });

    const proof = await getCoreCanaryProof();
    expect(proof.homi?.latestAttempt?.id).toBe(failed.id);
    expect(proof.homi?.latestAttempt?.status).toBe("failure");
    expect(proof.homi?.lastSuccess?.status).toBe("success");

    const serialized = JSON.stringify(proof.homi);
    expect(serialized).not.toContain("provider response containing details");
  });

  it("records a bounded timeout instead of leaving the operations screen hanging", async () => {
    const { runCoreProviderCanary } = await import("../server/services/coreProviderCanaries");
    const result = await runCoreProviderCanary(
      "homi",
      userId,
      () => new Promise<void>(() => undefined),
      5,
    );

    expect(result).toMatchObject({ status: "failure", failureClass: "timeout" });
  });

  it("retains the stronger operation label for a completed restart proof", async () => {
    const { runCoreProviderCanary } = await import("../server/services/coreProviderCanaries");
    const result = await runCoreProviderCanary(
      "object_storage",
      userId,
      async () => undefined,
      30_000,
      { provider: "Google Cloud Storage", operation: "private_restart_read_delete" },
    );
    expect(result).toMatchObject({
      capabilityId: "object_storage",
      provider: "Google Cloud Storage",
      operation: "private_restart_read_delete",
      status: "success",
    });
  });

  it("retains the provider-backed extraction restart proof with its dedicated operation", async () => {
    const { runCoreExtractionRestartVerification } = await import("../server/services/coreProviderCanaries");
    const proof = {
      status: "verified" as const,
      sourceCommitSha: "a".repeat(40),
      currentCommitSha: "a".repeat(40),
      seededAt: "2026-09-10T00:00:00.000Z",
      providerReadyAt: "2026-09-10T00:00:10.000Z",
      completedAt: "2026-09-10T00:02:00.000Z",
      ageMs: 120_000,
      attemptCount: 2,
      factRows: 9,
      pageRows: 1,
      cleanedUp: true as const,
    };
    const result = await runCoreExtractionRestartVerification(userId, async () => proof);

    expect(result.proof).toEqual(proof);
    expect(result.canary).toMatchObject({
      capabilityId: "document_extraction",
      provider: "Anthropic Claude vision",
      operation: "synthetic_restart_recovery",
      status: "success",
    });
  });

  it("retains the complete tax-packet proof with its dedicated operation", async () => {
    const { runCoreTaxPacketCanaryVerification } = await import("../server/services/coreProviderCanaries");
    const proof = {
      status: "verified" as const,
      commitSha: "c".repeat(40),
      deploymentId: "local-tax-canary-deployment",
      seededAt: "2026-09-10T03:00:00.000Z",
      completedAt: "2026-09-10T03:00:40.000Z",
      durationMs: 40_000,
      pageCount: 100,
      formCount: 4,
      factRows: 24,
      exactFactRows: 8,
      groundedFactRows: 24,
      cleanedUp: true as const,
    };
    const result = await runCoreTaxPacketCanaryVerification(userId, async () => proof);

    expect(result.proof).toEqual(proof);
    expect(result.canary).toMatchObject({
      capabilityId: "document_extraction",
      provider: "Anthropic Claude vision",
      operation: "synthetic_tax_packet_pipeline",
      status: "success",
    });
  });

  it("retains the two-deployment tax restart proof with its dedicated operation", async () => {
    const { runCoreTaxPacketRestartVerification } = await import("../server/services/coreProviderCanaries");
    const proof = {
      status: "verified" as const,
      sourceCommitSha: "d".repeat(40),
      currentCommitSha: "d".repeat(40),
      seededAt: "2026-09-10T04:00:00.000Z",
      providerReadyAt: "2026-09-10T04:01:20.000Z",
      completedAt: "2026-09-10T04:03:20.000Z",
      ageMs: 200_000,
      attemptCount: 2,
      pageCount: 100,
      formCount: 4,
      factRows: 28,
      exactFactRows: 8,
      groundedFactRows: 28,
      cleanedUp: true as const,
    };
    const result = await runCoreTaxPacketRestartVerification(userId, async () => proof);

    expect(result.proof).toEqual(proof);
    expect(result.canary).toMatchObject({
      capabilityId: "document_extraction",
      provider: "Anthropic Claude vision",
      operation: "synthetic_tax_packet_restart_recovery",
      status: "success",
    });
  });

  it("executes the real mixed-income and underwriting engines with repeatable results", async () => {
    const { runCoreProviderCanary } = await import("../server/services/coreProviderCanaries");
    const financial = await runCoreProviderCanary("financial_analysis", userId);
    const underwriting = await runCoreProviderCanary("underwriting_engine", userId);

    expect(financial).toMatchObject({
      provider: "Homiquity financial analysis",
      operation: "mixed_income_repeatability",
      status: "success",
      failureClass: null,
    });
    expect(underwriting).toMatchObject({
      provider: "Homiquity policy engine",
      operation: "synthetic_conventional_repeatability",
      status: "success",
      failureClass: null,
    });
  });

  it("runs every core proof and reports a red sweep without hiding healthy capabilities", async () => {
    const { runCoreProviderCanarySweep } = await import("../server/services/coreProviderCanaries");
    const calls: string[] = [];
    const result = await runCoreProviderCanarySweep(userId, {
      homi: async () => { calls.push("homi"); },
      document_extraction: async () => {
        calls.push("document_extraction");
        throw new Error("synthetic provider failure");
      },
      object_storage: async () => { calls.push("object_storage"); },
      financial_analysis: async () => { calls.push("financial_analysis"); },
      underwriting_engine: async () => { calls.push("underwriting_engine"); },
    });

    expect(calls.sort()).toEqual([
      "document_extraction",
      "financial_analysis",
      "homi",
      "object_storage",
      "underwriting_engine",
    ]);
    expect(result).toMatchObject({ total: 5, successful: 4, failed: 1 });
    expect(result.results.find((item) => item.capabilityId === "document_extraction")).toMatchObject({
      status: "failure",
      failureClass: "unknown",
    });
    expect(result.results.filter((item) => item.status === "success")).toHaveLength(4);
  });
});
