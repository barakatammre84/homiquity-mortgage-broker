// WF2-F4 regression pins — the URLA Section 4a write path.
//
// loan_applications.preferredLoanType and .amortizationType are REQUIRED by
// URLA section-4 gating (server/services/mismoValidation.ts) yet had NO write
// path on any HTTP surface — the funnel intake schema, the borrower PATCH
// whitelist, and the URLA save tables all excluded them; only the demo seed
// set them. Consequence chain (verified live): gseGatingFailed → AUS blocked →
// lender package blocked → wholesale submission 422, permanently, for every
// product-created file.
//
// POST /api/urla/:applicationId/save now accepts a `loanDetails` section that
// the borrower states and the server validates against the shared,
// MISMO-pinned vocabulary (urlaLoanDetailsSchema). Pinned here:
//   - a valid section-4 save writes BOTH columns (and only those two);
//   - an out-of-vocabulary or partial section is a 400, never a guessed value;
//   - a changed loan type re-runs the deterministic decision (pricing input),
//     while an unchanged save writes and recalcs nothing;
//   - payloads without the section are untouched (legacy saves keep working).
//
// Hermetic: the real route is mounted on an express app with a stub storage
// over an ephemeral port (same pattern as tests/documentUploadTerminalGuard).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

vi.mock("../server/auth", () => ({
  isAuthenticated: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../server/auditLog", () => ({ logAudit: vi.fn() }));

// The TRID evaluator only runs for personalInfo saves (not exercised here),
// but stub it so the suite never reaches services that expect a database.
vi.mock("../server/services/trid", () => ({
  evaluateTridTrigger: vi.fn(async () => ({ justTriggered: false, leDueDate: null })),
}));

const refreshAnalysisMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../server/services/loanAnalysis", () => ({
  refreshEarlyStageIntakeAnalysis: refreshAnalysisMock,
}));

// The handler's fire-and-forget autopilot fan-out reaches the database; an OFF
// agent is the local-dev reality and keeps the test hermetic.
vi.mock("../server/services/autopilot/config", () => ({
  getAutopilotConfig: vi.fn(async () => ({ enabled: false })),
}));

type StubApp = {
  id: string;
  userId: string;
  preferredLoanType: string | null;
  amortizationType: string | null;
};

const h = {
  applications: [] as StubApp[],
  updates: [] as { id: string; data: Record<string, unknown> }[],
  reset() {
    this.applications = [];
    this.updates = [];
  },
};

const storageStub = {
  getLoanApplicationWithAccess: async (id: string, userId: string, role: string) => {
    const app = h.applications.find((a) => a.id === id);
    if (!app) return undefined;
    const staff = ["admin", "lo", "processor", "underwriter"].includes(role);
    if (!staff && app.userId !== userId) return undefined;
    return app;
  },
  updateLoanApplication: async (id: string, data: Record<string, unknown>) => {
    h.updates.push({ id, data });
    const app = h.applications.find((a) => a.id === id);
    if (!app) return undefined;
    Object.assign(app, data);
    return app;
  },
} as any;

describe("POST /api/urla/:applicationId/save — section 4a loanDetails", () => {
  let server: import("node:http").Server;
  let base: string;
  let currentUser: { id: string; role: string };

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerUrlaRoutes } = await import("../server/routes/borrower/urla");

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = currentUser;
      next();
    });
    registerUrlaRoutes(app, storageStub);

    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    h.reset();
    refreshAnalysisMock.mockClear();
    currentUser = { id: "borrower-1", role: "aspiring_owner" };
    h.applications.push({
      id: "app-1",
      userId: "borrower-1",
      preferredLoanType: null,
      amortizationType: null,
    });
  });

  const save = (body: unknown) =>
    fetch(`${base}/api/urla/app-1/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("writes BOTH columns from a stated section 4 and echoes them back", async () => {
    const res = await save({
      loanDetails: { preferredLoanType: "fha", amortizationType: "adjustable" },
    });
    expect(res.status).toBe(200);

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].id).toBe("app-1");
    // Exactly the two validated columns — no mass assignment.
    expect(h.updates[0].data).toEqual({
      preferredLoanType: "fha",
      amortizationType: "adjustable",
    });

    const body = await res.json();
    expect(body.loanDetails).toEqual({
      preferredLoanType: "fha",
      amortizationType: "adjustable",
    });
  });

  it("refreshes the shared preliminary analysis when the values change", async () => {
    const res = await save({
      loanDetails: { preferredLoanType: "va", amortizationType: "fixed" },
    });
    expect(res.status).toBe(200);
    expect(refreshAnalysisMock).toHaveBeenCalledWith("app-1", "urla_updated");
  });

  it("rejects an out-of-vocabulary loan type with a 400 and writes nothing", async () => {
    const res = await save({
      loanDetails: { preferredLoanType: "jumbo", amortizationType: "fixed" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid loan details");
    expect(h.updates).toHaveLength(0);
    expect(refreshAnalysisMock).not.toHaveBeenCalled();
  });

  it("rejects a partial section (one field alone would recreate the half-set state)", async () => {
    const res = await save({ loanDetails: { preferredLoanType: "conventional" } });
    expect(res.status).toBe(400);
    expect(h.updates).toHaveLength(0);
  });

  it("does not rewrite or recalc when the stated values are unchanged", async () => {
    h.applications[0].preferredLoanType = "conventional";
    h.applications[0].amortizationType = "fixed";

    const res = await save({
      loanDetails: { preferredLoanType: "conventional", amortizationType: "fixed" },
    });
    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(0);
    expect(refreshAnalysisMock).not.toHaveBeenCalled();
    // The section is still acknowledged so the client can render the truth.
    const body = await res.json();
    expect(body.loanDetails).toEqual({
      preferredLoanType: "conventional",
      amortizationType: "fixed",
    });
  });

  it("leaves payloads without the section untouched (legacy save bodies)", async () => {
    const res = await save({});
    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(0);
    const body = await res.json();
    expect(body.loanDetails).toBeUndefined();
  });

  it("refuses a non-owner before any write", async () => {
    currentUser = { id: "someone-else", role: "aspiring_owner" };
    const res = await save({
      loanDetails: { preferredLoanType: "fha", amortizationType: "fixed" },
    });
    expect(res.status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });
});
