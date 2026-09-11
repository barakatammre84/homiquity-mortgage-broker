import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

const serviceMocks = vi.hoisted(() => ({
  buildTaxReconciliation: vi.fn(),
  getLatestSituationProfile: vi.fn(),
  classifyAndPersistSituation: vi.fn(),
  hasUserConsent: vi.fn(async () => true),
  getLatestTaxIntelligence: vi.fn(),
  getTaxPackageExtractionJob: vi.fn(),
  getDealTeamMembers: vi.fn(async () => [{ userId: "lo-1" }]),
  getFinancialReview: vi.fn(),
}));

vi.mock("../server/auth", () => ({
  isAuthenticated: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../server/auditLog", () => ({ logAudit: vi.fn() }));
vi.mock("../server/services/frictionLog", () => ({ logFriction: vi.fn() }));
vi.mock("../server/consentGate", () => ({ hasUserConsent: serviceMocks.hasUserConsent }));
vi.mock("../server/services/taxDocumentIntelligence", () => ({
  runTaxDocumentIntelligence: vi.fn(),
  getLatestTaxIntelligence: serviceMocks.getLatestTaxIntelligence,
  TaxDocumentIntelligenceError: class TaxDocumentIntelligenceError extends Error {},
}));
vi.mock("../server/services/documentExtractionJobs", () => ({
  enqueueTaxPackageExtraction: vi.fn(),
  getTaxPackageExtractionJob: serviceMocks.getTaxPackageExtractionJob,
  kickDocumentExtractionWorker: vi.fn(),
}));
vi.mock("../server/services/borrowerEntityResolution", () => ({
  resolveAndPersistEntities: vi.fn(),
}));
vi.mock("../server/services/taxReconciliation", () => ({
  buildTaxReconciliation: serviceMocks.buildTaxReconciliation,
}));
vi.mock("../server/services/situationClassifier", () => ({
  classifyAndPersistSituation: serviceMocks.classifyAndPersistSituation,
  getLatestSituationProfile: serviceMocks.getLatestSituationProfile,
}));
vi.mock("../server/services/worksheetPrefill", () => ({ buildSeWorksheetDrafts: vi.fn() }));
vi.mock("../server/services/income/reviewTriage", () => ({
  syncReviewItems: vi.fn(),
  resolveReviewItem: vi.fn(),
}));
vi.mock("../server/services/decisionEngine", () => ({ recalculateDecision: vi.fn() }));
vi.mock("../server/services/financialReview", () => ({ getFinancialReview: serviceMocks.getFinancialReview }));

const application = { id: "app-1", userId: "borrower-1" };
const storage = {
  getDealTeamMembers: serviceMocks.getDealTeamMembers,
  getLoanApplication: async (id: string) => (id === application.id ? application : undefined),
  getDocument: async (id: string) => id === "tax-doc-1"
    ? {
        id,
        userId: "lo-1",
        applicationId: application.id,
        documentType: "tax_return",
      }
    : undefined,
} as any;

describe("staff tax intelligence application scope", () => {
  let server: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerTaxIntelligenceRoutes } = await import("../server/routes/taxIntelligence");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: "lo-1", role: "lo" };
      next();
    });
    registerTaxIntelligenceRoutes(app, storage);
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => server?.close());
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.hasUserConsent.mockResolvedValue(true);
    serviceMocks.getDealTeamMembers.mockResolvedValue([{ userId: "lo-1" }]);
    serviceMocks.getTaxPackageExtractionJob.mockResolvedValue(null);
    serviceMocks.getLatestTaxIntelligence.mockResolvedValue({
      runId: "run-1",
      documentId: "tax-doc-1",
      status: "completed",
      forms: [],
    });
    serviceMocks.buildTaxReconciliation.mockResolvedValue({
      userId: "borrower-1",
      generatedAt: new Date().toISOString(),
      taxYears: [],
      formCount: 0,
      entities: [],
      checks: [],
      summary: { pass: 0, variance: 0, notEvaluable: 0, info: 0 },
    });
    serviceMocks.getLatestSituationProfile.mockResolvedValue({
      id: "profile-1",
      userId: "borrower-1",
      applicationId: "app-1",
      generatedAt: new Date(),
      inputsFingerprint: "fingerprint",
      profile: {},
    });
    serviceMocks.getFinancialReview.mockResolvedValue({
      bankStatementEvidence: {
        documentCount: 5,
        reviewedDepositFactCount: 5,
        observedTotalDeposits: 100000,
        datedStatementCount: 5,
        consecutiveMonthCoverage: 5,
        periodStart: "2026-05-01",
        periodEnd: "2026-09-30",
      },
    });
  });

  it("limits a loan officer's reconciliation to the assigned application", async () => {
    const response = await fetch(
      `${base}/api/tax-intelligence/reconciliation?userId=borrower-1&applicationId=app-1`,
    );

    expect(response.status).toBe(200);
    expect(serviceMocks.buildTaxReconciliation).toHaveBeenCalledWith("borrower-1", "app-1");
  });

  it("treats the application owner as borrower when staff uploaded the tax return", async () => {
    const response = await fetch(
      `${base}/api/documents/tax-doc-1/tax-intelligence?applicationId=app-1`,
    );

    expect(response.status).toBe(200);
    expect(serviceMocks.hasUserConsent).toHaveBeenCalledWith(
      "tax_document_use",
      "borrower-1",
    );
    expect(serviceMocks.getLatestTaxIntelligence).toHaveBeenCalledWith("tax-doc-1");
  });

  it("does not give a former staff uploader owner access after assignment ends", async () => {
    serviceMocks.getDealTeamMembers.mockResolvedValue([]);
    const response = await fetch(
      `${base}/api/documents/tax-doc-1/tax-intelligence?applicationId=app-1`,
    );

    expect(response.status).toBe(403);
    expect(serviceMocks.getLatestTaxIntelligence).not.toHaveBeenCalled();
  });

  it("limits a loan officer's situation profile to the assigned application", async () => {
    const response = await fetch(
      `${base}/api/tax-intelligence/situation?userId=borrower-1&applicationId=app-1`,
    );

    expect(response.status).toBe(200);
    expect(serviceMocks.getLatestSituationProfile).toHaveBeenCalledWith("borrower-1", "app-1");
    expect(serviceMocks.classifyAndPersistSituation).not.toHaveBeenCalled();
  });

  it("stops staff access when the borrower revokes tax-document authorization", async () => {
    serviceMocks.hasUserConsent.mockResolvedValue(false);
    const response = await fetch(
      `${base}/api/tax-intelligence/reconciliation?userId=borrower-1&applicationId=app-1`,
    );

    expect(response.status).toBe(403);
    expect(serviceMocks.buildTaxReconciliation).not.toHaveBeenCalled();
  });

  it("does not require tax-document consent for staff bank-statement analysis", async () => {
    serviceMocks.hasUserConsent.mockResolvedValue(false);
    const response = await fetch(`${base}/api/applications/app-1/bank-statement-analysis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // The empty analysis reaches its own input validation instead of being
    // rejected by the unrelated tax-document consent gate.
    expect(response.status).toBe(400);
    expect(serviceMocks.hasUserConsent).not.toHaveBeenCalled();
  });

  it("refuses a bank-statement analysis without the selected evidence period", async () => {
    const response = await fetch(`${base}/api/applications/app-1/bank-statement-analysis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ months: 12, totalEligibleDeposits: 240000 }),
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/5 consecutive months/i);
    expect(serviceMocks.getFinancialReview).toHaveBeenCalledWith("app-1", expect.objectContaining({ id: "lo-1" }));
  });
});
