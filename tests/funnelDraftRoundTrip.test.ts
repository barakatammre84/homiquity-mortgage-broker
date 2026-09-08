import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

// The funnel's server draft silently discarded three captured answers.
//
// `buildDraftPatchPayload` sends every non-empty answer on every debounce, the
// PATCH schema validates all of them, and the route then copied a fixed
// whitelist onto the row — which three funnel fields were never added to after
// the #202 registrar split: `householdFamilySize` and `homeSquareFootage` (the
// two VA residual-income inputs, 38 CFR 36.4340(e)) and
// `avoidsInterestFinancing` (the UAL routing opt-in). Every autosave returned
// 200 and wrote nothing; the restore path then read `avoidsInterestFinancing`
// back off a column nothing had ever written and rendered an explicit opt-in
// as an unchecked box under "We loaded your saved progress". 2026-08-19 wiring
// audit, break 2. These tests drive the real handler and read what reaches the
// storage write — the only place the defect was ever visible.

vi.mock("../server/auth", () => ({
  isAuthenticated: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../server/auditLog", () => ({ logAudit: vi.fn() }));
vi.mock("../server/services/trid", () => ({
  evaluateTridTrigger: vi.fn(async () => ({ justTriggered: false, leDueDate: null })),
  tridHardStopError: vi.fn(() => null),
}));

// Load express and the registrar's module graph at module init, not inside
// beforeAll: the cold load is the expensive part (storage, services), and under
// a full parallel lane on a loaded box it blew the 60s hook timeout, which
// vitest reports as six SKIPPED tests — a green-looking run that proved
// nothing. Same fix as #664 for intakeNeverDenies. (vi.mock is hoisted, so the
// static imports still see the stubs above.)
import express from "express";
import { registerStatusDecisionRoutes } from "../server/routes/lending/statusDecisions";

describe("PATCH /api/loan-applications/:id — the funnel draft round trip keeps every answer", () => {
  const h = {
    applications: [] as Record<string, any>[],
    updates: [] as { id: string; data: Record<string, unknown> }[],
  };

  const storageStub = {
    getLoanApplication: async (id: string) => h.applications.find((a) => a.id === id),
    updateLoanApplication: async (id: string, data: Record<string, unknown>) => {
      h.updates.push({ id, data });
      const app = h.applications.find((a) => a.id === id);
      if (app) Object.assign(app, data);
      return app;
    },
  } as any;

  let server: import("node:http").Server;
  let base: string;

  beforeAll(() => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: "borrower-1", role: "aspiring_owner" };
      next();
    });
    registerStatusDecisionRoutes(app, storageStub);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());

  beforeEach(() => {
    h.applications = [{
      id: "app-1",
      userId: "borrower-1",
      status: "draft",
      annualIncome: "85000",
      monthlyDebts: "450",
      isVeteran: true,
    }];
    h.updates = [];
  });

  const patch = (body: unknown) =>
    fetch(`${base}/api/loan-applications/app-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Forwarded-Proto": "https" },
      body: JSON.stringify(body),
    });

  it("writes the two VA residual-income inputs as INTEGERS and the opt-in as a boolean", async () => {
    // Exactly what useServerDraftAutosave sends: digit strings for the VA
    // fields (the form's wire shape), a boolean for the checkbox.
    const res = await patch({ householdFamilySize: "4", homeSquareFootage: "1800", avoidsInterestFinancing: true });
    expect(res.status).toBe(200);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].data).toEqual({
      householdFamilySize: 4,
      homeSquareFootage: 1800,
      avoidsInterestFinancing: true,
    });
    // Not "4": the column is integer, and a string would have reached the DB
    // driver as one. Pinned by type, not just by value.
    expect(typeof h.updates[0].data.householdFamilySize).toBe("number");
    expect(typeof h.updates[0].data.homeSquareFootage).toBe("number");
  });

  it("accepts the fields as JSON numbers too (stringifyIntakeScalars normalises them)", async () => {
    const res = await patch({ householdFamilySize: 3, homeSquareFootage: 2200 });
    expect(res.status).toBe(200);
    expect(h.updates[0].data).toEqual({ householdFamilySize: 3, homeSquareFootage: 2200 });
  });

  it("clears stale multi-unit rent when a borrower changes to a primary single-family home", async () => {
    const res = await patch({
      propertyType: "single_family",
      occupancyType: "primary_residence",
      numberOfUnits: "3",
      subjectMonthlyRentalIncome: "4200",
    });

    expect(res.status).toBe(200);
    expect(h.updates[0].data).toEqual({
      propertyType: "single_family",
      occupancyType: "primary_residence",
      numberOfUnits: 1,
      subjectMonthlyRentalIncome: null,
    });
  });

  it("an explicit opt-OUT is written as false, not dropped as falsy", async () => {
    const res = await patch({ avoidsInterestFinancing: false });
    expect(res.status).toBe(200);
    expect(h.updates[0].data).toEqual({ avoidsInterestFinancing: false });
  });

  it("never writes NaN: an empty string is 'not answered', so the key does not reach the row", async () => {
    // The base validator lets "" through as the form's untouched state; the
    // autosave omits empties, but a sloppy caller must not turn one into NaN
    // in an integer column.
    const res = await patch({ householdFamilySize: "", homeSquareFootage: "1500" });
    expect(res.status).toBe(200);
    expect(h.updates[0].data).toEqual({ homeSquareFootage: 1500 });
    expect("householdFamilySize" in h.updates[0].data).toBe(false);
  });

  it("still rejects an out-of-range household size — the whitelist did not widen validation", async () => {
    const res = await patch({ householdFamilySize: "25" });
    expect(res.status).toBe(400);
    expect(h.updates).toHaveLength(0);
  });

  it("leaves the rest of the row alone — only the sent answers travel", async () => {
    const res = await patch({ homeSquareFootage: "900" });
    expect(res.status).toBe(200);
    expect(Object.keys(h.updates[0].data)).toEqual(["homeSquareFootage"]);
  });

  it("rejects a partial income update that conflicts with the stored breakdown", async () => {
    h.applications[0].incomeSources = [{ type: "self_employed", annualAmount: "45000" }];
    const res = await patch({ annualIncome: "40000" });
    expect(res.status).toBe(400);
    expect(h.updates).toHaveLength(0);
  });

  it("rejects a partial breakdown update that exceeds the stored household total", async () => {
    const res = await patch({
      incomeSources: [{
        type: "self_employed",
        annualAmount: "90000",
        employerName: "Side Studio LLC",
        yearsInRole: "3",
        businessStructure: "single_member_llc",
        ownershipPercent: "100",
      }],
    });
    expect(res.status).toBe(400);
    expect(h.updates).toHaveLength(0);
  });
});
