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
      operation: "text_response",
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
      operation: "text_response",
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
