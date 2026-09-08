import { describe, expect, it } from "vitest";
import type { LoanApplication } from "@shared/schema";
import { computeNextAction } from "../server/services/nextAction";

const application = (overrides: Partial<LoanApplication>): LoanApplication =>
  ({
    id: "app-1",
    status: "under_review",
    employmentType: "self_employed",
    aiAnalysis: {
      concerns: [
        "Self-employment details and a completed income worksheet for each business or 1099 source",
      ],
    },
    ...overrides,
  }) as LoanApplication;

describe("complex-borrower next action", () => {
  it("sends an incomplete self-employed file to its actual blocking form", () => {
    const next = computeNextAction({
      application: application({
        preUwFlags: { flags: [{ reason: "Upload tax returns" }] },
      }),
      pendingTasks: { total: 6, documents: 6 },
      pendingDocuments: 6,
      unreadMessages: 0,
      activitySummary: null,
    });

    expect(next.href).toBe("/urla-form");
    expect(next.buttonLabel).toBe("Continue Application");
    expect(next.description).toContain("each business or 1099 source");
  });

  it("keeps ordinary document collection first when the worksheet is complete", () => {
    const next = computeNextAction({
      application: application({ aiAnalysis: { concerns: [] } }),
      pendingTasks: { total: 2, documents: 2 },
      pendingDocuments: 2,
      unreadMessages: 0,
      activitySummary: null,
    });

    expect(next.href).toBe("/documents");
  });
});
