import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

const workflowGate = vi.hoisted(() => ({
  status: "uploaded" as string,
  isCurrentVersion: true,
}));
const uploadFanout = vi.hoisted(() => ({
  emitDocumentEvent: vi.fn(async () => undefined),
  matchUploadedDocumentToConditions: vi.fn(async () => ({ matchedConditionIds: [] })),
}));

// ---------------------------------------------------------------------------
// POST /api/documents/upload must never file a document against a CLOSED loan.
//
// The bug class (#271, #273): the handler asked only "does this application
// belong to you?". A denied/withdrawn/funded/expired file still belongs to the
// borrower, so a stale `?app=` — or a replayed/direct API call that never went
// near the client — filed the upload on a closed loan. The unattached path had
// the same hole from the other side: it defaulted to `apps[0]`, and
// getLoanApplicationsByUser orders desc(createdAt) with NO status filter, so
// "newest" is routinely a closed file while an older one is still in flight.
//
// The client resolver (useActiveApplication) is the first line; this is the
// server-side half, so the rule holds without a cooperating client.
//
// Hermetic: the route is mounted on a real express app with a stub storage and
// driven over an ephemeral port (same pattern as tests/taskCancellation.test.ts).
// ---------------------------------------------------------------------------

// Object storage unconfigured → the handler's verify step is a no-op outside
// production, exactly as in local dev. Keeps the test off the network.
vi.mock("../server/integrations/object_storage/objectStorage", () => ({
  ObjectStorageService: class {
    async verifyAndClaimObject() {
      return { configured: false as const };
    }
  },
}));

vi.mock("../server/auth", () => ({
  isAuthenticated: (_req: any, _res: any, next: any) => next(),
}));

// logAudit writes through the real storage singleton; the assertions here are
// about the document record, not the audit row.
vi.mock("../server/auditLog", () => ({ logAudit: vi.fn() }));

vi.mock("../server/services/documentLineage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/documentLineage")>();
  return {
    ...actual,
    withDocumentWorkflowLock: async (
      _documentId: string,
      run: (document: any, isCurrentVersion: boolean) => Promise<any>,
    ) => run(
      { id: _documentId, status: workflowGate.status },
      workflowGate.isCurrentVersion,
    ),
  };
});

// Downstream fan-out on the attached path (task events, condition matching,
// autopilot) all reach the database. Stub them out — this test pins WHICH
// application the document lands on, not what happens afterwards.
vi.mock("../server/services/taskEventEmitter", () => ({
  taskEventEmitter: { emitDocumentEvent: uploadFanout.emitDocumentEvent },
}));
vi.mock("../server/pipelineEngine", () => ({
  expireSupersededDocumentReviewTasks: vi.fn(async () => undefined),
  advanceMatchingDocumentTasks: vi.fn(async () => undefined),
  matchUploadedDocumentToConditions: uploadFanout.matchUploadedDocumentToConditions,
}));
vi.mock("../server/services/autopilot/config", () => ({
  getAutopilotConfig: vi.fn(async () => ({ enabled: false })),
  isAutopilotEnabled: vi.fn(async () => false),
}));

type StubApp = { id: string; status: string; userId: string };

const h = {
  applications: [] as StubApp[],
  createdDocuments: [] as any[],
  dealActivities: [] as any[],
  requestedRegistrations: [] as any[],
  reset() {
    this.applications = [];
    this.createdDocuments = [];
    this.dealActivities = [];
    this.requestedRegistrations = [];
  },
};

const storageStub = {
  // Ownership-scoped read, mirroring server/storage/applications.ts: staff see
  // any file, a borrower only their own.
  getLoanApplicationWithAccess: async (id: string, userId: string, role: string) => {
    const app = h.applications.find((a) => a.id === id);
    if (!app) return undefined;
    const staff = ["admin", "lo", "processor", "underwriter"].includes(role);
    if (!staff && app.userId !== userId) return undefined;
    return app;
  },
  // Newest-first, no status filter — the real ordering the guard has to survive.
  getLoanApplicationsByUser: async (userId: string) => h.applications.filter((a) => a.userId === userId),
  getDocumentsByUser: async () => [],
  createDocument: async (doc: any) => {
    const created = { id: `doc-${h.createdDocuments.length + 1}`, createdAt: new Date(), ...doc };
    h.createdDocuments.push(created);
    return created;
  },
  createDealActivity: async (activity: any) => {
    h.dealActivities.push(activity);
    return activity;
  },
  getLoanApplication: async (id: string) => h.applications.find((a) => a.id === id),
} as any;

const registerDocumentVersion = async ({ document: input }: any) => ({
  document: await storageStub.createDocument(input),
  lineage: input.applicationId ? { documentId: `doc-${h.createdDocuments.length}` } : null,
});
const registerRequestedDocumentVersion = async (input: any) => {
  h.requestedRegistrations.push(input);
  return registerDocumentVersion(input);
};

describe("POST /api/documents/upload — closed-file guard", () => {
  let server: import("node:http").Server;
  let base: string;
  let currentUser: { id: string; role: string };

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerDocumentRoutes } = await import("../server/routes/lending/documents");

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = currentUser;
      next();
    });
    registerDocumentRoutes(app, storageStub, {
      registerDocumentVersion,
      registerRequestedDocumentVersion,
    });

    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server?.close();
  });

  beforeEach(() => {
    h.reset();
    currentUser = { id: "borrower-1", role: "borrower" };
    workflowGate.status = "uploaded";
    workflowGate.isCurrentVersion = true;
    uploadFanout.emitDocumentEvent.mockClear();
    uploadFanout.matchUploadedDocumentToConditions.mockClear();
  });

  const upload = (body: Record<string, unknown> = {}) =>
    fetch(`${base}/api/documents/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        objectPath: "/objects/uploads/abc-123",
        fileName: "paystub.pdf",
        fileSize: 1024,
        mimeType: "application/pdf",
        ...body,
      }),
    });

  it("rejects a requested application that is withdrawn — access alone is not enough", async () => {
    h.applications = [{ id: "app-closed", status: "withdrawn", userId: "borrower-1" }];

    const res = await upload({ applicationId: "app-closed" });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.applicationStatus).toBe("withdrawn");
    // Nothing filed: the rejection happens before the document record exists.
    expect(h.createdDocuments).toHaveLength(0);
    expect(h.dealActivities).toHaveLength(0);
  });

  it("rejects every terminal status, not just withdrawn", async () => {
    for (const status of ["funded", "denied", "withdrawn", "expired"]) {
      h.reset();
      h.applications = [{ id: "app-closed", status, userId: "borrower-1" }];

      const res = await upload({ applicationId: "app-closed" });

      expect(res.status, `${status} must be rejected`).toBe(409);
      expect(h.createdDocuments, `${status} must file nothing`).toHaveLength(0);
    }
  });

  it("still accepts an in-flight file (including a draft the borrower is filling out)", async () => {
    for (const status of ["draft", "doc_collection", "underwriting", "suspended"]) {
      h.reset();
      h.applications = [{ id: "app-open", status, userId: "borrower-1" }];

      const res = await upload({ applicationId: "app-open" });

      expect(res.status, `${status} must be accepted`).toBe(201);
      expect(h.createdDocuments[0].applicationId).toBe("app-open");
    }
  });

  it("keeps 403 (not 409) for an application the caller does not own", async () => {
    h.applications = [{ id: "app-theirs", status: "withdrawn", userId: "someone-else" }];

    const res = await upload({ applicationId: "app-theirs" });

    expect(res.status).toBe(403);
    expect(h.createdDocuments).toHaveLength(0);
  });

  it("exempts staff: attaching a document to a closed file is legitimate record-keeping", async () => {
    h.applications = [{ id: "app-closed", status: "denied", userId: "borrower-1" }];
    currentUser = { id: "lo-1", role: "lo" };

    const res = await upload({ applicationId: "app-closed" });

    expect(res.status).toBe(201);
    expect(h.createdDocuments[0].applicationId).toBe("app-closed");
  });

  it("with no applicationId, attaches to the workable file — never the newer closed one", async () => {
    // Newest-first, exactly as getLoanApplicationsByUser returns it: the bare
    // `apps[0]` this replaced would have picked the withdrawn file.
    h.applications = [
      { id: "app-newest-closed", status: "withdrawn", userId: "borrower-1" },
      { id: "app-in-flight", status: "doc_collection", userId: "borrower-1" },
    ];

    const res = await upload();

    expect(res.status).toBe(201);
    expect(h.createdDocuments[0].applicationId).toBe("app-in-flight");
    expect(h.dealActivities[0].applicationId).toBe("app-in-flight");
  });

  it("with no applicationId and every file closed, stores the document unattached", async () => {
    h.applications = [
      { id: "app-denied", status: "denied", userId: "borrower-1" },
      { id: "app-funded", status: "funded", userId: "borrower-1" },
    ];

    const res = await upload();

    // Unattached is recoverable — staff can re-file it. Stamping it onto a
    // closed loan is not.
    expect(res.status).toBe(201);
    expect(h.createdDocuments[0].applicationId).toBeNull();
    expect(h.dealActivities).toHaveLength(0);
  });

  it("registers a chat response and its replacement through the atomic request path", async () => {
    h.applications = [{ id: "app-open", status: "underwriting", userId: "borrower-1" }];

    const res = await upload({
      applicationId: "app-open",
      documentType: "pay_stub",
      requestMessageId: "request-1",
      replacesDocumentId: "doc-rejected",
    });

    expect(res.status).toBe(201);
    expect(h.requestedRegistrations).toHaveLength(1);
    expect(h.requestedRegistrations[0]).toMatchObject({
      requestMessageId: "request-1",
      replacesDocumentId: "doc-rejected",
      document: {
        applicationId: "app-open",
        userId: "borrower-1",
        documentType: "pay_stub",
      },
    });
  });

  it("does not resurrect upload tasks or conditions after review wins the race", async () => {
    h.applications = [{ id: "app-open", status: "underwriting", userId: "borrower-1" }];
    workflowGate.status = "rejected";

    const res = await upload({
      applicationId: "app-open",
      documentType: "pay_stub",
    });

    expect(res.status).toBe(201);
    expect(h.createdDocuments).toHaveLength(1);
    expect(uploadFanout.emitDocumentEvent).not.toHaveBeenCalled();
    expect(uploadFanout.matchUploadedDocumentToConditions).not.toHaveBeenCalled();
  });
});
