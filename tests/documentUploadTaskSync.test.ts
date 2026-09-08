import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => ({
  getTasksByApplication: vi.fn(),
  getTaskDocuments: vi.fn(),
  createTaskDocument: vi.fn(),
  updateTask: vi.fn(),
  updateTaskDocument: vi.fn(),
}));
const taskEngineMocks = vi.hoisted(() => ({
  updateTaskStatus: vi.fn(),
}));

vi.mock("../server/storage", () => ({
  storage: storageMocks,
}));
vi.mock("../server/services/taskEngine", () => ({
  taskEngine: taskEngineMocks,
}));

import {
  advanceMatchingDocumentTasks,
  expireSupersededDocumentReviewTasks,
  reconcileDocumentReviewTasks,
} from "../server/pipelineEngine";

const task = (overrides: Record<string, unknown> = {}) => ({
  id: "task-profit-loss",
  taskType: "document_request",
  ownerRole: "BORROWER",
  status: "OPEN",
  documentCategory: "profit_loss_statement",
  ...overrides,
});

describe("document upload borrower-task synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.getTaskDocuments.mockResolvedValue([]);
    storageMocks.createTaskDocument.mockResolvedValue({ id: "link-1" });
    storageMocks.updateTask.mockResolvedValue(undefined);
    storageMocks.updateTaskDocument.mockResolvedValue(undefined);
  });

  it("links an alias-matched upload and advances the borrower task", async () => {
    storageMocks.getTasksByApplication.mockResolvedValue([task()]);

    const result = await advanceMatchingDocumentTasks({
      applicationId: "app-1",
      documentId: "doc-1",
      documentType: "profit_loss",
    });

    expect(result.advancedTaskIds).toEqual(["task-profit-loss"]);
    expect(storageMocks.createTaskDocument).toHaveBeenCalledWith({
      taskId: "task-profit-loss",
      documentId: "doc-1",
    });
    expect(storageMocks.updateTask).toHaveBeenCalledWith("task-profit-loss", {
      status: "IN_PROGRESS",
      completedAt: null,
      verificationStatus: "pending",
      verifiedByUserId: null,
      verifiedAt: null,
      verificationNotes: null,
      documentInstructions: null,
    });
  });

  it("does not advance staff review work or closed borrower tasks", async () => {
    storageMocks.getTasksByApplication.mockResolvedValue([
      task({ id: "staff", ownerRole: "PROCESSOR" }),
      task({ id: "complete", status: "COMPLETED" }),
      task({ id: "expired", status: "EXPIRED" }),
      task({ id: "other", documentCategory: "tax_return" }),
    ]);

    const result = await advanceMatchingDocumentTasks({
      applicationId: "app-1",
      documentId: "doc-1",
      documentType: "profit_loss",
    });

    expect(result.advancedTaskIds).toEqual([]);
    expect(storageMocks.createTaskDocument).not.toHaveBeenCalled();
    expect(storageMocks.updateTask).not.toHaveBeenCalled();
  });

  it("does not duplicate an existing task-document link", async () => {
    storageMocks.getTasksByApplication.mockResolvedValue([task()]);
    storageMocks.getTaskDocuments.mockResolvedValue([{ documentId: "doc-1" }]);

    await advanceMatchingDocumentTasks({
      applicationId: "app-1",
      documentId: "doc-1",
      documentType: "profit_loss",
    });

    expect(storageMocks.createTaskDocument).not.toHaveBeenCalled();
    expect(storageMocks.updateTask).toHaveBeenCalledTimes(1);
  });

  it("reopens completed borrower work when its accepted version is replaced", async () => {
    storageMocks.getTasksByApplication.mockResolvedValue([
      task({ status: "COMPLETED", completedAt: new Date(), verificationStatus: "verified" }),
    ]);
    storageMocks.getTaskDocuments.mockResolvedValue([
      { id: "link-old", documentId: "doc-old", isVerified: true },
    ]);

    const result = await advanceMatchingDocumentTasks({
      applicationId: "app-1",
      documentId: "doc-new",
      documentType: "profit_loss",
      replacesDocumentId: "doc-old",
    });

    expect(result.advancedTaskIds).toEqual(["task-profit-loss"]);
    expect(storageMocks.updateTaskDocument).toHaveBeenCalledWith("link-old", {
      isVerified: false,
      verificationNotes: "Superseded by a newer document version",
    });
    expect(storageMocks.createTaskDocument).toHaveBeenCalledWith({
      taskId: "task-profit-loss",
      documentId: "doc-new",
    });
    expect(storageMocks.updateTask).toHaveBeenCalledWith(
      "task-profit-loss",
      expect.objectContaining({
        status: "IN_PROGRESS",
        completedAt: null,
        verificationStatus: "pending",
        verifiedByUserId: null,
        verifiedAt: null,
      }),
    );
  });
});

describe("replacement document review synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskEngineMocks.updateTaskStatus.mockResolvedValue(undefined);
  });

  it("expires the open staff review task for the superseded version", async () => {
    storageMocks.getTasksByApplication.mockResolvedValue([
      task({
        id: "review-old",
        ownerRole: "PROCESSOR",
        status: "OPEN",
        taskTypeCode: "DOC_REVIEW",
        triggerMetadata: { documentId: "doc-old" },
      }),
      task({
        id: "review-current",
        ownerRole: "PROCESSOR",
        status: "OPEN",
        taskTypeCode: "DOC_REVIEW",
        triggerMetadata: { documentId: "doc-new" },
      }),
    ]);

    const result = await expireSupersededDocumentReviewTasks({
      applicationId: "app-1",
      replacedDocumentId: "doc-old",
      replacedByUserId: "borrower-1",
    });

    expect(result.expiredTaskIds).toEqual(["review-old"]);
    expect(taskEngineMocks.updateTaskStatus).toHaveBeenCalledWith(
      "review-old",
      "EXPIRED",
      "borrower-1",
      "Superseded by a newer document version",
    );
    expect(taskEngineMocks.updateTaskStatus).toHaveBeenCalledTimes(1);
  });
});

describe("document review borrower-task synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMocks.updateTask.mockResolvedValue(undefined);
    storageMocks.updateTaskDocument.mockResolvedValue(undefined);
  });

  it("reopens the linked borrower task when its submitted document is rejected", async () => {
    storageMocks.getTasksByApplication.mockResolvedValue([task({ status: "IN_PROGRESS" })]);
    storageMocks.getTaskDocuments.mockResolvedValue([
      { id: "link-1", documentId: "doc-1", isVerified: false },
    ]);

    const result = await reconcileDocumentReviewTasks({
      applicationId: "app-1",
      documentId: "doc-1",
      status: "rejected",
      reason: "Upload every page of the signed statement.",
      reviewedBy: "lo-1",
    });

    expect(result.reconciledTaskIds).toEqual(["task-profit-loss"]);
    expect(storageMocks.updateTaskDocument).toHaveBeenCalledWith("link-1", expect.objectContaining({ isVerified: false }));
    expect(storageMocks.updateTask).toHaveBeenCalledWith("task-profit-loss", expect.objectContaining({
      status: "OPEN",
      verificationStatus: "rejected",
      verificationNotes: "Upload every page of the signed statement.",
      documentInstructions: "Upload every page of the signed statement.",
    }));
  });

  it("completes the linked borrower task when the document is accepted", async () => {
    storageMocks.getTasksByApplication.mockResolvedValue([task({ status: "IN_PROGRESS" })]);
    storageMocks.getTaskDocuments.mockResolvedValue([
      { id: "link-1", documentId: "doc-1", isVerified: false },
    ]);

    await reconcileDocumentReviewTasks({
      applicationId: "app-1",
      documentId: "doc-1",
      status: "verified",
      reviewedBy: "lo-1",
    });

    expect(storageMocks.updateTask).toHaveBeenCalledWith("task-profit-loss", expect.objectContaining({
      status: "COMPLETED",
      verificationStatus: "verified",
      documentInstructions: null,
    }));
  });

  it("does not reopen a request already satisfied by another accepted document", async () => {
    storageMocks.getTasksByApplication.mockResolvedValue([task({ status: "COMPLETED", completedAt: new Date() })]);
    storageMocks.getTaskDocuments.mockResolvedValue([
      { id: "link-1", documentId: "doc-1", isVerified: false },
      { id: "link-2", documentId: "doc-2", isVerified: true },
    ]);

    await reconcileDocumentReviewTasks({
      applicationId: "app-1",
      documentId: "doc-1",
      status: "rejected",
      reason: "This version is incomplete.",
      reviewedBy: "lo-1",
    });

    expect(storageMocks.updateTask).toHaveBeenCalledWith("task-profit-loss", expect.objectContaining({
      status: "COMPLETED",
      verificationStatus: "verified",
    }));
  });
});
