import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Every sweep's schedule, pinned as a table.
 *
 * WHY THIS FILE EXISTS
 *
 * .github/workflows/cron-jobs.yml is THE scheduler — the platform cron block it
 * once mirrored was deleted at the Railway cutover, so there is no twin to fall
 * back on. Two of the original six sweeps were already pinned at their own call sites
 * (letter-expiry in tests/letterIntegrity.test.ts, task-escalation in
 * tests/taskEngineSlaSeed.test.ts). The other four were not, which meant a
 * `- cron:` line could be deleted and the gate would stay green: removing a
 * trigger produces no error anywhere, it just stops firing. Among the unpinned
 * four was adverse-action-delivery — the ECOA §1002.9 notice watchdog.
 *
 * Each entry asserts BOTH halves, because either alone is insufficient:
 *   - the schedule trigger is registered, and
 *   - the resolve step maps that expression to a job path.
 * An expression with no mapping still fires a run; it just hits the `*)` arm and
 * curls nothing. A mapping with no expression never runs at all.
 *
 * This deliberately duplicates the two existing assertions rather than replacing
 * them — those live next to the code that depends on them, which is where a
 * reader deleting that sweep will actually look.
 */

const SCHEDULES: ReadonlyArray<readonly [string, string]> = [
  ["0 13 * * *", "lifecycle"],
  ["0 12 * * *", "rate-lock-alerts"],
  ["30 12 * * *", "letter-expiry"],
  ["0 14 * * *", "adverse-action-delivery"],
  ["45 13 * * *", "task-escalation"],
  ["17 11 * * 1", "aggregate-data"],
  // Credit monitoring (2026-08-08). Runs after lifecycle so a score drop and the
  // day's other borrower-state changes land in the same working window.
  ["15 13 * * *", "credit-monitoring"],
  // Synthetic, borrower-data-free proof for the five core capabilities. A
  // failed capability makes the workflow fail loudly.
  ["30 11,23 * * *", "core-provider-canaries"],
];

const [workflow, jobs] = await Promise.all([
  readFile(join(__dirname, "../.github/workflows/cron-jobs.yml"), "utf8"),
  readFile(join(__dirname, "../server/routes/jobs.ts"), "utf8"),
]);

describe("cron-jobs.yml schedules", () => {
  it.each(SCHEDULES)('registers a trigger for "%s" (%s)', (schedule) => {
    expect(
      workflow.includes(`- cron: "${schedule}"`),
      `expected cron-jobs.yml to register a schedule trigger for "${schedule}"`,
    ).toBe(true);
  });

  it.each(SCHEDULES)('maps "%s" to the %s job path', (schedule, job) => {
    const escaped = schedule.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(
      new RegExp(`"${escaped}"\\)\\s+job="${job}"`).test(workflow),
      `expected cron-jobs.yml to map "${schedule}" to the ${job} job path`,
    ).toBe(true);
  });

  it("schedules exactly these eight sweeps and no others", () => {
    // Catches the reverse drift: another `- cron:` added without a case arm
    // fires a run that hits the `*)` arm and fails, and a schedule quietly
    // retimed here would otherwise pass every per-entry assertion above.
    const registered = [...workflow.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]);
    expect(registered.sort()).toEqual(SCHEDULES.map(([s]) => s).sort());
  });

  it.each(SCHEDULES)("has a server endpoint for the %s schedule (%s)", (_schedule, job) => {
    expect(jobs).toContain(`"/api/jobs/${job}"`);
  });

  it("uses a CSRF-protected POST for the provider canary side effect", () => {
    expect(jobs).toContain('app.post("/api/jobs/core-provider-canaries"');
    expect(workflow).toContain('method="POST"');
    expect(workflow).toContain('-H "Origin: ${SWEEP_HOST}"');
    expect(workflow).toContain('-X "${METHOD}"');
  });

  it("offers two CSRF-protected manual legs for the controlled storage restart proof", () => {
    for (const job of ["core-storage-restart-seed", "core-storage-restart-verify"]) {
      expect(jobs).toContain(`app.post("/api/jobs/${job}"`);
      expect(workflow).toContain(`- ${job}`);
      expect(workflow).toContain(`core-provider-canaries|core-storage-restart-seed|core-storage-restart-verify) method="POST"`);
    }
  });

  it("prints only redacted provider diagnostics before failing a canary sweep", () => {
    const canaryBlock = workflow.slice(
      workflow.indexOf('# Core proofs are state-changing POSTs.'),
      workflow.indexOf('# Read-only sweeps retain transient retries.'),
    );
    expect(workflow).toContain('core-provider-canaries|core-storage-restart-seed|core-storage-restart-verify)');
    expect(workflow).toContain("results.map((result) => ({");
    for (const field of ["capabilityId", "provider", "operation", "status", "latencyMs", "failureClass", "commitSha", "completedAt"]) {
      expect(workflow).toContain(`${field}: result.${field}`);
    }
    expect(canaryBlock).not.toContain("--retry");
    expect(canaryBlock).not.toContain("console.log(JSON.stringify(body");
    expect(workflow).toContain('Core provider canary returned HTTP ${http_status}');
  });

  it("targets the Railway service domain, not a third-party DNS zone", () => {
    // The sweep is machine-to-machine. Routing it through www.homiquity.com — a
    // CNAME in a Squarespace-hosted zone — cost three sweeps on 2026-08-06 when
    // that zone was mid-edit and curl exited 6 (could not resolve host).
    expect(workflow).toContain("https://homiquity-production.up.railway.app");
    expect(workflow).not.toMatch(/curl[\s\S]{0,200}www\.homiquity\.com/);
  });
});
