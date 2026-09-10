import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// PATCH /api/loan-applications/:id/status — the condition gate on the closing
// track (Selling Guide B3-2-05: an Approve/Eligible file is eligible for sale
// only "if all approval conditions have been met").
//
// The defect this pins closed (2026-08-23 review, live repro in
// knowledge-base/feature-review/journey-walks/2026-08-23-lo-submission-review.md):
// the only client-called status route ran nine chokepoints but never consulted
// checkPipelineProgress, so clear_to_close, closing, and funded were granted
// with conditions outstanding — a funded loan with an open prior_to_funding
// condition, HMDA stamped, graduation fired. The engine-side branch behavior
// (including the new `closing` branch) is pinned in
// tests/pipelineEngineStageTransitions.test.ts; THIS file pins the route
// wiring: which targets consult the gate, the 422 contract, the exemption of
// exit dispositions, and the admin-only audited force bypass.
//
// Hermetic: the route is mounted on a real express app with a stub storage and
// driven over an ephemeral port (same pattern as
// tests/documentUploadTerminalGuard.test.ts); pipelineEngine is mocked so the
// wiring — not the engine — is what each assertion sees.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const h = {
  progress: { readyForNextStage: true, blockers: [] as string[] },
  progressCalls: 0,
  stageCalls: [] as { id: string; status: string; options: Row }[],
  auditEntries: [] as { action: string; details: Row }[],
  reset() {
    this.progress = { readyForNextStage: true, blockers: [] };
    this.progressCalls = 0;
    this.stageCalls = [];
    this.auditEntries = [];
  },
};

vi.mock("../server/auth", () => ({
  isAuthenticated: (_req: any, _res: any, next: any) => next(),
  requireRole:
    (...roles: string[]) =>
    (req: any, res: any, next: any) =>
      roles.includes(req.user?.role) ? next() : res.status(403).json({ error: "Forbidden" }),
}));

vi.mock("../server/pipelineEngine", () => ({
  updatePipelineStage: vi.fn(async (id: string, status: string, options: Row) => {
    h.stageCalls.push({ id, status, options });
  }),
  checkPipelineProgress: vi.fn(async () => {
    h.progressCalls += 1;
    return { currentStage: "any", conditions: {}, ...h.progress };
  }),
  PipelineTransitionError: class PipelineTransitionError extends Error {},
}));

vi.mock("../server/auditLog", () => ({
  logAudit: vi.fn((_req: unknown, action: string, _type: string, _id: string, details: Row) => {
    h.auditEntries.push({ action, details });
  }),
}));

// The denial path is not under test; the chokepoint must simply not run here.
vi.mock("../server/services/creditService", () => ({
  ensureAdverseActionForDenial: vi.fn(async () => ({ ok: true, created: false })),
}));
vi.mock("../server/services/emailService", () => ({
  sendNotificationEmail: vi.fn(),
}));
// TRID never blocks in these cases — the gate under test sits after it.
vi.mock("../server/services/trid", () => ({
  evaluateTridTrigger: vi.fn(async () => null),
  tridHardStopError: vi.fn(() => null),
}));
vi.mock("../server/services/currentDecisionGrade", () => ({
  getCurrentDecisionGrade: vi.fn(async () => ({ isDecisionGrade: true, reasons: [], evidence: {} })),
  isCurrentRealCreditPull: vi.fn(() => true),
}));

const storageStub = {
  getLoanApplication: vi.fn(async (id: string) => ({
    id,
    userId: "borrower-1",
    status: "underwriting",
    // Verified provenance + a coherent amount: the pre-existing chokepoints
    // pass, isolating the condition gate.
    financialDataProvenance: "verified",
    preApprovalAmount: "500000",
    purchasePrice: "600000",
    creditScore: 720,
  })),
  getDealTeamMembers: vi.fn(async () => [{ userId: "uw-1" }, { userId: "lo-1" }]),
  createDealActivity: vi.fn(async (a: Row) => a),
  getUser: vi.fn(async () => undefined),
  createNotification: vi.fn(async (n: Row) => n),
} as any;

describe("PATCH /api/loan-applications/:id/status — condition gate wiring", () => {
  let server: import("node:http").Server;
  let base: string;
  let currentUser: { id: string; role: string };

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerStatusDecisionRoutes } = await import("../server/routes/lending/statusDecisions");

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = currentUser;
      next();
    });
    registerStatusDecisionRoutes(app, storageStub);

    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    h.reset();
    currentUser = { id: "uw-1", role: "underwriter" };
  });

  const patchStatus = (body: Row) =>
    fetch(`${base}/api/loan-applications/app-1/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("422s clear_to_close while the engine reports blockers — and never reaches the stage writer", async () => {
    h.progress = { readyForNextStage: false, blockers: ["2 conditions must be cleared before docs"] };

    const res = await patchStatus({ status: "clear_to_close" });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("conditions_outstanding");
    expect(body.blockers).toEqual(["2 conditions must be cleared before docs"]);
    expect(h.stageCalls).toHaveLength(0);
  });

  it("422s closing and funded the same way (the closing track is gated end to end)", async () => {
    h.progress = { readyForNextStage: false, blockers: ["1 condition(s) must be settled before funding"] };

    for (const status of ["closing", "funded"]) {
      const res = await patchStatus({ status });
      expect(res.status, status).toBe(422);
      const body = await res.json();
      expect(body.code, status).toBe("conditions_outstanding");
    }
    expect(h.stageCalls).toHaveLength(0);
  });

  it("passes clear_to_close through to the stage writer when the engine reports ready", async () => {
    h.progress = { readyForNextStage: true, blockers: [] };

    const res = await patchStatus({ status: "clear_to_close" });

    expect(res.status).toBe(200);
    expect(h.progressCalls).toBe(1);
    expect(h.stageCalls).toEqual([
      { id: "app-1", status: "clear_to_close", options: { denialReasons: undefined, force: false } },
    ]);
  });

  it("never consults the gate for exit dispositions — a withdrawal is not blocked by open conditions", async () => {
    h.progress = { readyForNextStage: false, blockers: ["boom"] };

    const res = await patchStatus({ status: "withdrawn" });

    expect(res.status).toBe(200);
    expect(h.progressCalls).toBe(0);
  });

  it("never consults the gate for non-closing forward moves (processing)", async () => {
    h.progress = { readyForNextStage: false, blockers: ["boom"] };
    currentUser = { id: "lo-1", role: "lo" };

    const res = await patchStatus({ status: "processing" });

    expect(res.status).toBe(200);
    expect(h.progressCalls).toBe(0);
  });

  it("admin force bypasses the gate WITH an audit entry carrying the blockers", async () => {
    h.progress = { readyForNextStage: false, blockers: ["1 conditions still outstanding"] };
    currentUser = { id: "admin-1", role: "admin" };

    const res = await patchStatus({ status: "clear_to_close", force: true });

    expect(res.status).toBe(200);
    expect(h.stageCalls).toHaveLength(1);
    const forcedAudit = h.auditEntries.find(e => e.action === "pipeline.condition_gate_forced");
    expect(forcedAudit).toBeDefined();
    expect(forcedAudit!.details).toMatchObject({
      toStatus: "clear_to_close",
      blockers: ["1 conditions still outstanding"],
    });
  });

  it("a non-admin's force is ignored — the 422 stands", async () => {
    h.progress = { readyForNextStage: false, blockers: ["1 conditions still outstanding"] };
    currentUser = { id: "uw-1", role: "underwriter" };

    const res = await patchStatus({ status: "clear_to_close", force: true });

    expect(res.status).toBe(422);
    expect(h.stageCalls).toHaveLength(0);
    expect(h.auditEntries.find(e => e.action === "pipeline.condition_gate_forced")).toBeUndefined();
  });
});
