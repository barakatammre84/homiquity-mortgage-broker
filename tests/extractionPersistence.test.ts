import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

const workflowGate = vi.hoisted(() => ({
  status: "uploaded" as string,
  isCurrentVersion: true,
}));
const workflowTransaction = { id: "shared-document-transaction" } as any;

// ---------------------------------------------------------------------------
// The borrower's own upload must persist what the model read — not just the
// field NAMES.
//
// THE SEAM (Workflow 4, step 3 → step 4). There are two extraction paths:
//
//   A. POST /api/documents/:id/extract   — pressed by STAFF in the review
//      workbench (client/src/components/staff/DocumentReviewPanel.tsx is its
//      only caller).
//   B. the durable extraction job inserted by POST /api/documents/upload — the
//      path that runs when a BORROWER uploads a pay stub, bank statement or
//      lease. Nothing in the borrower UI triggers (A).
//
// F-028 (`server/services/documentFacts.ts`) and F-030 (`wireExtractionToReadiness`)
// were both wired into (A) and never into (B) — even though F-028's own docblock
// describes the borrower upload as the scenario it closes: "A borrower uploads a
// pay stub. A model reads it. The numbers are then discarded ... the platform
// kept asking for figures it had already been shown."
//
// So on the only path a borrower can actually reach, the model read the stub,
// the values were thrown away, and the file went on asking for them. Same class
// as the #451 co-borrower fix that covered slot 1 only: the fix landed on one
// caller of a two-caller behaviour.
//
// These tests drive the real upload route to prove the job is registered with
// the document, then drive shared persistence to prove the claimed job keeps
// facts, readiness and lineage under the human-review boundary.
// ---------------------------------------------------------------------------

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

vi.mock("../server/auditLog", () => ({ logAudit: vi.fn() }));

vi.mock("../server/services/documentLineage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/documentLineage")>();
  return {
    ...actual,
    withDocumentWorkflowLock: async (
      _documentId: string,
      run: (document: any, isCurrentVersion: boolean, transaction: any) => Promise<any>,
    ) => run(
      { id: _documentId, status: workflowGate.status },
      workflowGate.isCurrentVersion,
      workflowTransaction,
    ),
  };
});

vi.mock("../server/services/taskEventEmitter", () => ({
  taskEventEmitter: { emitDocumentEvent: vi.fn() },
}));
vi.mock("../server/pipelineEngine", () => ({
  matchUploadedDocumentToConditions: vi.fn(),
}));
vi.mock("../server/services/autopilot/config", () => ({
  getAutopilotConfig: vi.fn(async () => ({ enabled: false })),
  isAutopilotEnabled: vi.fn(async () => false),
}));

// A high-confidence pay stub: YTD gross over a period end date six months in,
// which is exactly the shape buildDocumentFacts turns into a monthly figure.
const PAY_STUB = {
  employeeName: "Dana Reyes",
  employerName: "Northwind Logistics",
  payPeriodStartDate: "2026-06-16",
  payPeriodEndDate: "2026-06-30",
  grossPay: 4200,
  netPay: 3100,
  ytdGross: 50400,
  ytdNetPay: 37200,
  ytdTaxes: 13200,
  confidence: "high" as const,
  extractedFields: ["employerName", "grossPay", "ytdGross", "payPeriodEndDate"],
  warnings: [],
  modelId: "claude-sonnet-5",
  promptVersion: "pay_stub/v3",
  rawResponseHash: "sha256:deadbeef",
  rawResponseEncrypted: "ciphertext",
  rawResponseIv: "iv",
  rawResponseKeyId: "key-1",
  fieldEvidence: {
    employeeName: { pageNumber: 1, confidence: 0.98 },
    employerName: { pageNumber: 1, confidence: 0.98 },
    payPeriodStartDate: { pageNumber: 1, confidence: 0.97 },
    payPeriodEndDate: { pageNumber: 1, confidence: 0.97 },
    grossPay: { pageNumber: 1, confidence: 0.96 },
    netPay: { pageNumber: 1, confidence: 0.95 },
    ytdGross: { pageNumber: 1, confidence: 0.96 },
    ytdNetPay: { pageNumber: 1, confidence: 0.95 },
    ytdTaxes: { pageNumber: 1, confidence: 0.94 },
  },
  documentClassification: {
    pageCount: 1,
    pages: [{ pageNumber: 1, documentType: "paystub" as const, confidence: 0.98 }],
  },
};

vi.mock("../server/extractionService", () => ({
  extractPayStubData: vi.fn(async () => PAY_STUB),
  extractBankStatementData: vi.fn(async () => ({
    confidence: "high" as const,
    extractedFields: [],
    closingBalance: 18_000,
    accountType: "checking",
  })),
  extractLeaseData: vi.fn(async () => ({ confidence: "high" as const, extractedFields: [] })),
}));

// Coarse confidence bookkeeping is its own unit (tests/documentConfidence.test.ts);
// here it only has to answer "does this need a human?".
vi.mock("../server/services/documentConfidence", () => ({
  recordExtractionConfidence: vi.fn(async ({ overallConfidence }: { overallConfidence: number }) => ({
    humanReviewRequired: overallConfidence < 0.8,
  })),
  coarseConfidenceToNumeric: (c: string) => (c === "high" ? 0.95 : c === "medium" ? 0.7 : 0.3),
}));

const persistDocumentFacts = vi.fn(async () => 2);
const clearUnverifiedDocumentFacts = vi.fn(async () => undefined);
vi.mock("../server/services/documentFacts", () => ({
  persistDocumentFacts: (...args: any[]) => persistDocumentFacts(...(args as [])),
  clearUnverifiedDocumentFacts: (...args: any[]) => clearUnverifiedDocumentFacts(...(args as [])),
}));

const wireExtractionToReadiness = vi.fn(async () => ({ fieldsUpdated: ["monthly_income"] }));
vi.mock("../server/services/optimizationEngine", () => ({
  wireExtractionToReadiness: (...args: any[]) => wireExtractionToReadiness(...(args as [])),
  creditDocumentPresence: vi.fn(async () => undefined),
}));

const h = {
  createdDocuments: [] as any[],
  updates: [] as Array<{ id: string; patch: any }>,
  registrations: [] as any[],
  reset() {
    this.createdDocuments = [];
    this.updates = [];
    this.registrations = [];
  },
};

const storageStub = {
  getLoanApplicationWithAccess: async () => undefined,
  getLoanApplicationsByUser: async () => [],
  getDocumentsByUser: async () => [],
  createDocument: async (doc: any) => {
    const created = { id: `doc-${h.createdDocuments.length + 1}`, createdAt: new Date(), ...doc };
    h.createdDocuments.push(created);
    return created;
  },
  updateDocument: async (id: string, patch: any) => {
    h.updates.push({ id, patch });
    return { id, ...patch };
  },
  createDealActivity: async (a: any) => a,
  getLoanApplication: async () => undefined,
} as any;

const registerDocumentVersion = async (input: any) => {
  h.registrations.push(input);
  const document = await storageStub.createDocument(input.document);
  return {
    document,
    lineage: input.document.applicationId ? { documentId: document.id } : null,
  };
};

const dispatchQueuedExtraction = vi.fn();

describe("durable borrower document extraction", () => {
  let server: import("node:http").Server;
  let base: string;

  beforeAll(async () => {
    const express = (await import("express")).default;
    const { registerDocumentRoutes } = await import("../server/routes/lending/documents");

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = { id: "borrower-1", role: "borrower" };
      next();
    });
    registerDocumentRoutes(app, storageStub, {
      registerDocumentVersion,
      dispatchQueuedExtraction,
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
    workflowGate.status = "uploaded";
    workflowGate.isCurrentVersion = true;
    persistDocumentFacts.mockClear();
    clearUnverifiedDocumentFacts.mockClear();
    wireExtractionToReadiness.mockClear();
    dispatchQueuedExtraction.mockClear();
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
        documentType: "pay_stub",
        ...body,
      }),
    });

  it.each(["pay_stub", "bank_statement", "lease_agreement"])(
    "atomically registers a durable standard job for %s",
    async (documentType) => {
      const res = await upload({ documentType });
      expect(res.status).toBe(201);
      expect(h.registrations).toHaveLength(1);
      expect(h.registrations[0].extractionJob).toEqual({
        mode: "standard",
        requestedByUserId: "borrower-1",
      });
      expect(dispatchQueuedExtraction).toHaveBeenCalledTimes(1);
      expect(h.updates).toEqual([]);
    },
  );

  it("does not create paid extraction work for an unsupported type", async () => {
    const res = await upload({ documentType: "government_id" });
    expect(res.status).toBe(201);
    expect(h.registrations[0].extractionJob).toBeUndefined();
    expect(dispatchQueuedExtraction).not.toHaveBeenCalled();
  });

  it("persists extracted values, readiness, lineage, and a human-review status together", async () => {
    const { applyExtractionToDocument } = await import("../server/services/extractionPersistence");
    const result = await applyExtractionToDocument({
      storage: storageStub,
      userId: "borrower-1",
      documentId: "queued-doc",
      documentType: "pay_stub",
      applicationId: "app-1",
      extracted: PAY_STUB,
    });

    expect(result.skipReason).toBeNull();
    expect(persistDocumentFacts).toHaveBeenCalledTimes(1);
    const [documentId, documentType, extracted, confidence] = persistDocumentFacts.mock.calls[0] as any[];
    expect(documentId).toBe("queued-doc");
    expect(documentType).toBe("pay_stub");
    expect(extracted.ytdGross).toBe(50_400);
    expect(confidence).toBe("high");
    expect(wireExtractionToReadiness).toHaveBeenCalledTimes(1);
    expect(persistDocumentFacts.mock.calls[0]?.[5]).toBe(workflowTransaction);
    expect(wireExtractionToReadiness.mock.calls[0]?.[5]).toBe(workflowTransaction);

    expect(h.updates).toHaveLength(1);
    const { patch } = h.updates[0];
    expect(patch.extractionResponseHash).toBe("sha256:deadbeef");
    expect(patch.extractionRawEncrypted).toBe("ciphertext");
    expect(patch.extractionRawIv).toBe("iv");
    expect(patch.extractionRawKeyId).toBe("key-1");
    const notes = JSON.parse(patch.notes);
    expect(notes.modelId).toBe("claude-sonnet-5");
    expect(notes.promptVersion).toBe("pay_stub/v3");
    expect(notes.responseHash).toBe("sha256:deadbeef");
    expect(patch.status).toBe("verifying");
  });

  it("a low-confidence read persists no facts — a guess is not a fact", async () => {
    const { applyExtractionToDocument } = await import("../server/services/extractionPersistence");
    await applyExtractionToDocument({
      storage: storageStub,
      userId: "borrower-1",
      documentId: "low-confidence-doc",
      documentType: "pay_stub",
      applicationId: "app-1",
      extracted: {
        confidence: "low",
        extractedFields: [],
        warnings: ["Values need manual confirmation"],
      },
    });

    expect(persistDocumentFacts).not.toHaveBeenCalled();
    expect(wireExtractionToReadiness).not.toHaveBeenCalled();
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].patch.status).toBe("uploaded");
  });

  it("withholds values when the uploaded pages do not match the selected type", async () => {
    const { applyExtractionToDocument } = await import("../server/services/extractionPersistence");
    const result = await applyExtractionToDocument({
      storage: storageStub,
      userId: "borrower-1",
      documentId: "mislabeled-doc",
      documentType: "pay_stub",
      applicationId: "app-1",
      extracted: {
        ...PAY_STUB,
        documentClassification: {
          pageCount: 2,
          pages: [
            { pageNumber: 1, documentType: "paystub" as const, confidence: 0.98 },
            { pageNumber: 2, documentType: "w2" as const, confidence: 0.97 },
          ],
        },
        pageCount: 2,
      },
    });

    expect(result.classificationBlocked).toBe(true);
    expect(result.factsPersisted).toBe(0);
    expect(persistDocumentFacts).not.toHaveBeenCalled();
    expect(wireExtractionToReadiness).not.toHaveBeenCalled();
    expect(clearUnverifiedDocumentFacts).toHaveBeenCalledWith(
      "mislabeled-doc",
      workflowTransaction,
    );
    const notes = JSON.parse(h.updates[0].patch.notes);
    expect(notes.documentClassification).toMatchObject({
      compatible: false,
      mixedPacket: true,
    });
    expect(notes.warnings.join(" ")).toMatch(/multiple document types/i);
    expect(h.updates[0].patch.status).toBe("uploaded");
  });

  it("publishes no extraction output after a terminal human verdict", async () => {
    workflowGate.status = "verified";
    const { applyExtractionToDocument } = await import("../server/services/extractionPersistence");

    const result = await applyExtractionToDocument({
      storage: storageStub,
      userId: "borrower-1",
      documentId: "reviewed-doc",
      documentType: "pay_stub",
      applicationId: "app-1",
      extracted: PAY_STUB,
    });

    expect(result.skipReason).toBe("reviewed");
    expect(h.updates).toEqual([]);
    expect(persistDocumentFacts).not.toHaveBeenCalled();
    expect(wireExtractionToReadiness).not.toHaveBeenCalled();
  });

  it("publishes no extraction output from a superseded document version", async () => {
    workflowGate.isCurrentVersion = false;
    const { applyExtractionToDocument } = await import("../server/services/extractionPersistence");

    const result = await applyExtractionToDocument({
      storage: storageStub,
      userId: "borrower-1",
      documentId: "superseded-doc",
      documentType: "pay_stub",
      applicationId: "app-1",
      extracted: PAY_STUB,
    });

    expect(result.skipReason).toBe("replaced");
    expect(h.updates).toEqual([]);
    expect(persistDocumentFacts).not.toHaveBeenCalled();
    expect(wireExtractionToReadiness).not.toHaveBeenCalled();
  });
});
