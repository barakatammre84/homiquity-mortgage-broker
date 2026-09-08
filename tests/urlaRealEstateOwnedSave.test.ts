import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

vi.mock("../server/auth", () => ({
  isAuthenticated: (_req: any, _res: any, next: any) => next(),
}));

const logAuditMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../server/auditLog", () => ({ logAudit: logAuditMock }));
vi.mock("../server/services/trid", () => ({
  evaluateTridTrigger: vi.fn(async () => ({ justTriggered: false, leDueDate: null })),
}));
vi.mock("../server/services/decisionEngine", () => ({
  recalculateDecision: vi.fn(async () => null),
}));
vi.mock("../server/services/autopilot/config", () => ({
  getAutopilotConfig: vi.fn(async () => ({ enabled: false })),
}));

const h = {
  calls: [] as any[],
  result: [] as any[] | undefined,
  reset() {
    this.calls = [];
    this.result = [];
  },
};

const storageStub = {
  getLoanApplicationWithAccess: async (id: string, userId: string) =>
    id === "app-1" && userId === "borrower-1"
      ? { id, userId: "borrower-1", preferredLoanType: "conventional", amortizationType: "fixed" }
      : undefined,
  replaceRealEstateOwnedForApplication: async (...args: any[]) => {
    h.calls.push(args);
    return h.result;
  },
} as any;

describe("POST /api/urla/:applicationId/save — real estate owned", () => {
  let server: import("node:http").Server;
  let base: string;
  let currentUser = { id: "borrower-1", role: "active_buyer" };

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

  afterAll(() => server?.close());
  beforeEach(() => {
    h.reset();
    logAuditMock.mockClear();
    currentUser = { id: "borrower-1", role: "active_buyer" };
  });

  const save = (realEstateOwned: unknown) => fetch(`${base}/api/urla/app-1/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ realEstateOwned }),
  });

  it("stores the completed property once under the application borrower", async () => {
    h.result = [{ id: "reo-1", propertyAddress: "233 South Wacker Drive" }];
    const res = await save({
      ownsOtherRealEstate: true,
      properties: [{
        propertyAddress: "233 South Wacker Drive",
        propertyCity: "Chicago",
        propertyState: "IL",
        propertyType: "single_family",
        marketValue: "500,000",
        mortgageBalance: "250000",
        mortgagePayment: "1450",
        monthlyRentalIncome: "3000",
        occupancyType: "investment",
        status: "retained",
      }],
    });
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual([
      "app-1",
      "borrower-1",
      [expect.objectContaining({ marketValue: "500000", mortgagePayment: "1450" })],
      true,
    ]);
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      "urla.real_estate_owned.saved",
      "loan_application",
      "app-1",
      { ownsOtherRealEstate: true, propertyCount: 1 },
    );
  });

  it("persists an explicit No and clears application-scoped property rows", async () => {
    const res = await save({ ownsOtherRealEstate: false, properties: [] });
    expect(res.status).toBe(200);
    expect(h.calls[0]).toEqual(["app-1", "borrower-1", [], false]);
  });

  it("refuses Yes without a property instead of recording a false completed disclosure", async () => {
    const res = await save({ ownsOtherRealEstate: true, properties: [] });
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a malformed dollar amount before any write", async () => {
    const res = await save({
      ownsOtherRealEstate: true,
      properties: [{ propertyAddress: "233 South Wacker Drive", marketValue: "not money" }],
    });
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("does not expose or change another borrower's file", async () => {
    currentUser = { id: "someone-else", role: "active_buyer" };
    const res = await save({ ownsOtherRealEstate: false, properties: [] });
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });
});
