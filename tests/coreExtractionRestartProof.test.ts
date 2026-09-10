import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DocumentExtractionJob } from "@shared/schema";
import {
  CORE_EXTRACTION_RESTART_DOCUMENT_ID,
  CORE_EXTRACTION_RESTART_HEARTBEAT_MS,
  CORE_EXTRACTION_RESTART_JOB_ID,
  CORE_EXTRACTION_RESTART_LEASE_MS,
  CORE_EXTRACTION_RESTART_USER_ID,
  CoreExtractionRestartProofError,
  documentExtractionHeartbeatMs,
  documentExtractionLeaseMs,
  isCoreExtractionRestartJob,
  validateCoreExtractionRestartSnapshot,
  validateCoreExtractionRestartTransition,
  type CoreExtractionRestartSnapshot,
} from "../server/services/coreExtractionRestartProof";

const commit = "a".repeat(40);
const seededAt = "2026-09-10T00:00:00.000Z";
const providerReadyAt = "2026-09-10T00:00:10.000Z";
const completedAt = "2026-09-10T00:02:00.000Z";

function job(overrides: Partial<DocumentExtractionJob> = {}): DocumentExtractionJob {
  return {
    id: CORE_EXTRACTION_RESTART_JOB_ID,
    documentId: CORE_EXTRACTION_RESTART_DOCUMENT_ID,
    requestedByUserId: CORE_EXTRACTION_RESTART_USER_ID,
    mode: "standard",
    status: "processing",
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: new Date(seededAt),
    claimedAt: new Date(seededAt),
    leaseExpiresAt: new Date("2026-09-10T00:00:30.000Z"),
    claimedBy: "worker-a",
    lastErrorCode: null,
    lastErrorAt: null,
    completedAt: null,
    createdAt: new Date(seededAt),
    updatedAt: new Date(seededAt),
    ...overrides,
  };
}

const seed = {
  version: 1 as const,
  sourceDeploymentId: "deployment-a",
  sourceCommitSha: commit,
  seededAt,
};
const ready = {
  ...seed,
  providerReadyAt,
  attemptCount: 1 as const,
  modelId: "claude-sonnet-5",
  promptVersion: "pay_stub/v3",
};
const completion = {
  version: 1 as const,
  completionDeploymentId: "deployment-b",
  completionCommitSha: commit,
  completedAt,
  attemptCount: 2,
};
const current = { deploymentId: "deployment-b", commitSha: commit };

function failureCode(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(CoreExtractionRestartProofError);
    return (error as CoreExtractionRestartProofError).code;
  }
}

function snapshot(overrides: Partial<CoreExtractionRestartSnapshot> = {}): CoreExtractionRestartSnapshot {
  return {
    jobStatus: "completed",
    attemptCount: 2,
    claimedBy: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    documentStatus: "verifying",
    responseHash: "b".repeat(64),
    confidenceRows: 1,
    factRows: 9,
    distinctFactRows: 9,
    requiredFactRows: 5,
    groundedFactRows: 9,
    uploadRows: 1,
    pageRows: 1,
    pageClassificationRows: 1,
    logicalDocumentRows: 1,
    logicalPageRows: 1,
    ...overrides,
  };
}

describe("production extraction restart proof", () => {
  it("gives only the fixed synthetic job a short renewable lease", () => {
    expect(isCoreExtractionRestartJob(job())).toBe(true);
    expect(documentExtractionLeaseMs(job())).toBe(CORE_EXTRACTION_RESTART_LEASE_MS);
    expect(documentExtractionHeartbeatMs(job())).toBe(CORE_EXTRACTION_RESTART_HEARTBEAT_MS);

    const ordinary = job({ id: "ordinary-job" });
    expect(isCoreExtractionRestartJob(ordinary)).toBe(false);
    expect(documentExtractionLeaseMs(ordinary)).toBe(5 * 60 * 1_000);
    expect(documentExtractionHeartbeatMs(ordinary)).toBe(60 * 1_000);
  });

  it("requires a different deployment on the same commit after the first provider read", () => {
    expect(() => validateCoreExtractionRestartTransition({
      seed,
      ready,
      completion,
      current,
      now: new Date("2026-09-10T00:02:01.000Z"),
    })).not.toThrow();

    expect(failureCode(() => validateCoreExtractionRestartTransition({
      seed,
      ready,
      completion: { ...completion, completionDeploymentId: "deployment-a", attemptCount: 1 },
      current: { deploymentId: "deployment-a", commitSha: commit },
      now: new Date("2026-09-10T00:02:01.000Z"),
    }))).toBe("restart_not_observed");
    expect(failureCode(() => validateCoreExtractionRestartTransition({
      seed,
      ready,
      completion: { ...completion, completionCommitSha: "c".repeat(40) },
      current: { ...current, commitSha: "c".repeat(40) },
      now: new Date("2026-09-10T00:02:01.000Z"),
    }))).toBe("commit_changed");
  });

  it("fails closed on stale, reordered, or one-attempt proof metadata", () => {
    expect(failureCode(() => validateCoreExtractionRestartTransition({
      seed,
      ready,
      completion,
      current,
      now: new Date("2026-09-10T02:00:00.000Z"),
    }))).toBe("marker_expired");
    expect(failureCode(() => validateCoreExtractionRestartTransition({
      seed,
      ready,
      completion: { ...completion, attemptCount: 1 },
      current,
      now: new Date("2026-09-10T00:02:01.000Z"),
    }))).toBe("restart_not_observed");
    expect(failureCode(() => validateCoreExtractionRestartTransition({
      seed,
      ready,
      completion: { ...completion, completedAt: "2026-09-10T00:00:05.000Z" },
      current,
      now: new Date("2026-09-10T00:02:01.000Z"),
    }))).toBe("invariant_failed");
  });

  it("accepts one complete, grounded fact/page set and rejects duplicates or residue", () => {
    expect(() => validateCoreExtractionRestartSnapshot(snapshot())).not.toThrow();
    for (const invalid of [
      snapshot({ attemptCount: 1 }),
      snapshot({ factRows: 10, distinctFactRows: 9, groundedFactRows: 10 }),
      snapshot({ groundedFactRows: 8 }),
      snapshot({ confidenceRows: 2 }),
      snapshot({ pageRows: 2 }),
      snapshot({ claimedBy: "old-worker", leaseExpiresAt: new Date() }),
    ]) {
      expect(failureCode(() => validateCoreExtractionRestartSnapshot(invalid))).toBe("invariant_failed");
    }
  });

  it("holds only after a real validated read and before every persistence call", async () => {
    const source = await readFile(
      join(__dirname, "../server/services/documentExtractionJobs.ts"),
      "utf8",
    );
    const start = source.indexOf("async function executeStandardJob");
    const end = source.indexOf("async function executeTaxPackageJob");
    const standardJob = source.slice(start, end);
    const providerRead = standardJob.indexOf("await extractStandard(document)");
    const recordReady = standardJob.indexOf("await recordCoreExtractionRestartProviderReady");
    const hold = standardJob.indexOf("await holdCoreExtractionRestartFirstResult");
    const materialize = standardJob.indexOf("await materializeDocumentPages");
    const persist = standardJob.indexOf("await applyExtractionToDocument");
    expect(providerRead).toBeGreaterThan(-1);
    expect(recordReady).toBeGreaterThan(providerRead);
    expect(hold).toBeGreaterThan(recordReady);
    expect(materialize).toBeGreaterThan(hold);
    expect(persist).toBeGreaterThan(materialize);
  });

  it("isolates the long first-attempt hold from the ordinary borrower queue", async () => {
    const source = await readFile(
      join(__dirname, "../server/services/documentExtractionJobs.ts"),
      "utf8",
    );
    const ordinary = source.slice(
      source.indexOf("async function drainAvailableJobs"),
      source.indexOf("export function kickDocumentExtractionWorker"),
    );
    const proof = source.slice(
      source.indexOf("async function drainCoreExtractionRestartJob"),
      source.indexOf("export function kickCoreExtractionRestartWorker"),
    );
    expect(ordinary).toContain("await claimNextDocumentExtractionJobForLane(lane)");
    expect(proof).toContain('await claimNextJob(new Date(), "only", "ordinary")');
    expect(proof).toContain("await processClaimedJob(job)");
  });
});
