import { describe, expect, it, vi, beforeEach } from "vitest";

import { deriveDocumentTaskOwnerRole, type InsertTask } from "../shared/schema";

// generateDocumentTasks persists through the storage singleton — capture the
// inserts instead of hitting a database (unit suite is hermetic).
vi.mock("../server/storage", () => ({
  storage: {
    createTask: vi.fn(async (data: InsertTask) => ({ id: "task-1", ...data })),
    getTasksByApplication: vi.fn(async () => [] as unknown[]),
    updateTask: vi.fn(async (id: string, data: Partial<InsertTask>) => ({ id, ...data })),
  },
}));

import { generateDocumentTasks } from "../server/pipelineEngine";
import { storage } from "../server/storage";

const createTaskMock = vi.mocked(storage.createTask);
const getTasksMock = vi.mocked(storage.getTasksByApplication);
const updateTaskMock = vi.mocked(storage.updateTask);

const requirement = (documentType: string) => ({
  documentType,
  description: `${documentType} needed`,
  priority: "prior_to_docs" as const,
  conditionCategory: "income",
  conditionTitle: `Upload ${documentType}`,
});

describe("deriveDocumentTaskOwnerRole", () => {
  it("derives BORROWER for a document request assigned to the application owner", () => {
    expect(
      deriveDocumentTaskOwnerRole(
        { taskType: "document_request", assignedToUserId: "borrower-1" },
        "borrower-1",
      ),
    ).toBe("BORROWER");
  });

  it("leaves a document request assigned to someone else (staff chase task) to the default", () => {
    expect(
      deriveDocumentTaskOwnerRole(
        { taskType: "document_request", assignedToUserId: "processor-9" },
        "borrower-1",
      ),
    ).toBeUndefined();
  });

  it("leaves an unassigned document request (document-intelligence review item) to the default", () => {
    expect(
      deriveDocumentTaskOwnerRole({ taskType: "document_request" }, "borrower-1"),
    ).toBeUndefined();
    expect(
      deriveDocumentTaskOwnerRole(
        { taskType: "document_request", assignedToUserId: null },
        "borrower-1",
      ),
    ).toBeUndefined();
  });

  it("never claims non-document task types, even when borrower-assigned", () => {
    expect(
      deriveDocumentTaskOwnerRole(
        { taskType: "review", assignedToUserId: "borrower-1" },
        "borrower-1",
      ),
    ).toBeUndefined();
  });

  it("does not match when the application owner is unknown", () => {
    // Guards the degenerate undefined === undefined coincidence: an unassigned
    // task plus a missing application must not read as borrower work.
    expect(
      deriveDocumentTaskOwnerRole({ taskType: "document_request" }, undefined),
    ).toBeUndefined();
  });
});

describe("generateDocumentTasks — borrower ownership", () => {
  beforeEach(() => {
    createTaskMock.mockClear();
    getTasksMock.mockClear();
    updateTaskMock.mockClear();
    getTasksMock.mockResolvedValue([]);
  });

  it("stamps every pipeline document task BORROWER-owned and OPEN", async () => {
    // The regression this pins: omitting ownerRole let the column default
    // (PROCESSOR) hide 1,015 dev tasks from the borrower badge and requests
    // panel while polluting the staff processor queue (migration 0035).
    const tasks = await generateDocumentTasks(
      "app-1",
      "borrower-1",
      [requirement("w2"), requirement("bank_statement")],
      "creator-1",
    );

    expect(tasks).toHaveLength(2);
    expect(createTaskMock).toHaveBeenCalledTimes(2);
    for (const call of createTaskMock.mock.calls) {
      const inserted = call[0];
      expect(inserted.ownerRole).toBe("BORROWER");
      expect(inserted.status).toBe("OPEN");
      expect(inserted.taskType).toBe("document_request");
      expect(inserted.assignedToUserId).toBe("borrower-1");
      expect(inserted.triggerSource).toBe("POLICY");
    }
  });

  it("skips document types that already carry a task — a re-drive must not duplicate the borrower's list", async () => {
    // finalizeIntake is re-drivable (recovery sweep), and the pipeline now
    // also initializes for under_review files that a human may later approve.
    // Without this dedup the second pass would hand the borrower a second
    // copy of every upload task.
    getTasksMock.mockResolvedValue([
      { taskType: "document_request", documentCategory: "w2", status: "COMPLETED" },
      { taskType: "review", documentCategory: "bank_statement", status: "OPEN" },
    ] as never);

    const tasks = await generateDocumentTasks(
      "app-1",
      "borrower-1",
      [requirement("w2"), requirement("bank_statement")],
      "creator-1",
    );

    // w2 already has a document task (even completed — it must not resurrect);
    // bank_statement's existing task is a staff review, not a document
    // request, so the upload task is still owed.
    expect(tasks).toHaveLength(1);
    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock.mock.calls[0][0].documentCategory).toBe("bank_statement");
  });

  it("creates one task per document type when a requirement repeats", async () => {
    const tasks = await generateDocumentTasks(
      "app-1",
      "borrower-1",
      [requirement("w2"), requirement("w2")],
      "creator-1",
    );
    expect(tasks).toHaveLength(1);
  });

  it("never rewrites a staff-authored request that uses the same document category", async () => {
    getTasksMock.mockResolvedValue([
      {
        id: "staff-task",
        taskType: "document_request",
        documentCategory: "tax_return",
        status: "OPEN",
        triggerSource: "MANUAL",
        ownerRole: "BORROWER",
        assignedToUserId: "borrower-1",
        createdByUserId: "loan-officer-1",
        isCustomRequest: false,
        title: "Upload the amended return",
        description: "Include the amended federal return and explanation.",
        priority: "urgent",
      },
    ] as never);

    await generateDocumentTasks(
      "app-1",
      "borrower-1",
      [{
        ...requirement("tax_return"),
        conditionTitle: "Rental Property Tax Return & Schedule E Required",
      }],
      "borrower-1",
    );

    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it("can repair a legacy task created by the borrower-side pipeline", async () => {
    getTasksMock.mockResolvedValue([
      {
        id: "legacy-policy-task",
        taskType: "document_request",
        documentCategory: "tax_return",
        status: "OPEN",
        triggerSource: "MANUAL",
        ownerRole: "BORROWER",
        assignedToUserId: "borrower-1",
        createdByUserId: "borrower-1",
        isCustomRequest: false,
        title: "Upload: Tax Return Verification",
        description: "Federal tax returns for the most recent year",
        priority: "normal",
      },
    ] as never);

    await generateDocumentTasks(
      "app-1",
      "borrower-1",
      [{
        ...requirement("tax_return"),
        conditionTitle: "Rental Property Tax Return & Schedule E Required",
        description: "Most recent signed return including Schedule E",
        priority: "prior_to_approval",
      }],
      "borrower-1",
    );

    expect(updateTaskMock).toHaveBeenCalledWith(
      "legacy-policy-task",
      expect.objectContaining({
        title: "Upload: Rental Property Tax Return & Schedule E Required",
        priority: "high",
      }),
    );
  });

  it("expires an untouched generated request that no longer matches the profile", async () => {
    getTasksMock.mockResolvedValue([
      {
        id: "stale-gift-task",
        taskType: "document_request",
        documentCategory: "gift_letter",
        status: "OPEN",
        triggerSource: "POLICY",
        ownerRole: "BORROWER",
        assignedToUserId: "borrower-1",
        createdByUserId: "borrower-1",
        isCustomRequest: false,
      },
    ] as never);

    await generateDocumentTasks(
      "app-1",
      "borrower-1",
      [requirement("bank_statement")],
      "borrower-1",
    );

    expect(updateTaskMock).toHaveBeenCalledWith(
      "stale-gift-task",
      expect.objectContaining({ status: "EXPIRED", autoResolved: true }),
    );
  });

  it("preserves staff-authored and already-submitted requests during re-evaluation", async () => {
    getTasksMock.mockResolvedValue([
      {
        id: "staff-gift-task",
        taskType: "document_request",
        documentCategory: "gift_letter",
        status: "OPEN",
        triggerSource: "MANUAL",
        ownerRole: "BORROWER",
        assignedToUserId: "borrower-1",
        createdByUserId: "loan-officer-1",
        isCustomRequest: true,
      },
      {
        id: "submitted-gift-task",
        taskType: "document_request",
        documentCategory: "gift_letter",
        status: "IN_PROGRESS",
        triggerSource: "POLICY",
        ownerRole: "BORROWER",
        assignedToUserId: "borrower-1",
        createdByUserId: "borrower-1",
        isCustomRequest: false,
      },
    ] as never);

    await generateDocumentTasks(
      "app-1",
      "borrower-1",
      [requirement("bank_statement")],
      "borrower-1",
    );

    expect(updateTaskMock).not.toHaveBeenCalledWith(
      expect.stringMatching(/gift-task$/),
      expect.objectContaining({ status: "EXPIRED" }),
    );
  });
});
