import { describe, expect, it } from "vitest";

import {
  buildDocumentChecklist,
  type ChecklistCondition,
  type ChecklistDocument,
  type ChecklistTask,
} from "../server/services/documentChecklist";

const condition = (over: Partial<ChecklistCondition> & { id: string }): ChecklistCondition => ({
  title: over.id,
  description: null,
  category: "income",
  priority: "prior_to_approval",
  status: "outstanding",
  requiredDocumentTypes: [],
  ...over,
});

const doc = (over: Partial<ChecklistDocument> & { id: string; documentType: string }): ChecklistDocument => ({
  fileName: `${over.id}.pdf`,
  status: "uploaded",
  rejectionReason: null,
  reviewedAt: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
  ...over,
});

const task = (over: Partial<ChecklistTask> & { id: string }): ChecklistTask => ({
  taskType: "document_request",
  documentCategory: null,
  title: over.id,
  status: "OPEN",
  verificationStatus: null,
  verificationNotes: null,
  requestingTeam: null,
  isCustomRequest: true,
  documentInstructions: null,
  ownerRole: "BORROWER",
  ...over,
});

describe("buildDocumentChecklist — personalized (condition-driven) path", () => {
  it("emits the pipeline's personalized requirements, not the standard list (self-employed)", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [
        condition({ id: "c-pnl", title: "Year-to-date P&L", requiredDocumentTypes: ["profit_loss_statement"] }),
        condition({ id: "c-biz", title: "Business bank statements", category: "assets", requiredDocumentTypes: ["business_bank_statement"] }),
        condition({ id: "c-tax", title: "2 years personal returns", requiredDocumentTypes: ["tax_return"] }),
      ],
      documents: [],
      tasks: [],
    });
    expect(documents.map((d) => d.id)).toEqual(["c-pnl", "c-biz", "c-tax"]);
    expect(documents.every((d) => d.source === "condition" && d.status === "needed")).toBe(true);
    expect(documents[1].category).toBe("assets");
    // No silent fallback mixing.
    expect(documents.some((d) => d.source === "standard")).toBe(false);
  });

  it("matches uploads across the type-vocabulary bridge (paystub satisfies pay_stub)", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [condition({ id: "c1", requiredDocumentTypes: ["pay_stub"] })],
      documents: [doc({ id: "d1", documentType: "paystub" })],
      tasks: [],
    });
    expect(documents[0].status).toBe("uploaded");
    expect(documents[0].documentId).toBe("d1");
  });

  it("the LATEST upload of a type decides the status, regardless of fetch order", () => {
    const older = doc({ id: "d-old", documentType: "bank_statement", status: "rejected", rejectionReason: "Blurry", createdAt: new Date("2026-07-01T00:00:00Z") });
    const newer = doc({ id: "d-new", documentType: "bank_statement_checking", status: "uploaded", createdAt: new Date("2026-07-10T00:00:00Z") });
    for (const order of [[older, newer], [newer, older]]) {
      const { documents } = buildDocumentChecklist({
        conditions: [condition({ id: "c1", requiredDocumentTypes: ["bank_statement"] })],
        documents: order,
        tasks: [],
      });
      expect(documents[0].documentId).toBe("d-new");
      expect(documents[0].status).toBe("uploaded");
      expect(documents[0].rejectionReason).toBeUndefined();
    }
  });

  it('a document staged "verifying" surfaces as verifying (the Under Review badge)', () => {
    const { documents } = buildDocumentChecklist({
      conditions: [condition({ id: "c1", requiredDocumentTypes: ["pay_stub"] })],
      documents: [doc({ id: "d1", documentType: "pay_stub", status: "verifying" })],
      tasks: [],
    });
    expect(documents[0].status).toBe("verifying");
  });

  it("rejected items expose the reason and review time for the Action Needed card", () => {
    const reviewedAt = new Date("2026-07-15T12:00:00Z");
    const { documents, stats } = buildDocumentChecklist({
      conditions: [condition({ id: "c1", requiredDocumentTypes: ["w2"] })],
      documents: [doc({ id: "d1", documentType: "w2", status: "rejected", rejectionReason: "Missing page 2", reviewedAt })],
      tasks: [],
    });
    expect(documents[0].status).toBe("rejected");
    expect(documents[0].rejectionReason).toBe("Missing page 2");
    expect(documents[0].reviewedAt).toBe(reviewedAt.toISOString());
    expect(stats.rejected).toBe(1);
  });

  it("doc-less submitted conditions read as verifying; settled conditions leave the checklist", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [
        condition({ id: "c-submitted", status: "submitted", requiredDocumentTypes: ["gift_letter"] }),
        condition({ id: "c-cleared", status: "cleared", requiredDocumentTypes: ["pay_stub"] }),
        condition({ id: "c-waived", status: "waived", requiredDocumentTypes: ["w2"] }),
      ],
      documents: [],
      tasks: [],
    });
    expect(documents.map((d) => d.id)).toEqual(["c-submitted"]);
    expect(documents[0].status).toBe("verifying");
  });

  it("does not resurrect the legacy standard list after every personalized condition is settled", () => {
    const result = buildDocumentChecklist({
      conditions: [
        condition({ id: "c-cleared", status: "cleared", requiredDocumentTypes: ["pay_stub"] }),
        condition({ id: "c-waived", status: "waived", requiredDocumentTypes: ["bank_statement"] }),
      ],
      documents: [],
      tasks: [],
    });
    expect(result.documents).toEqual([]);
    expect(result.personalized).toBe(true);
    expect(result.stats.needed).toBe(0);
  });

  it("collapses overlapping conditions into one upload action that names every cleared item", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [
        condition({ id: "c-2023", title: "2023 personal return", requiredDocumentTypes: ["tax_return"] }),
        condition({ id: "c-2024", title: "2024 personal return", requiredDocumentTypes: ["tax_return_1040"] }),
      ],
      documents: [],
      tasks: [],
    });
    expect(documents).toHaveLength(1);
    expect(documents[0].conditionIds).toEqual(["c-2023", "c-2024"]);
    expect(documents[0].description).toContain("2 loan items");
  });

  it("narrative conditions (no requiredDocumentTypes) never become checklist items", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [
        condition({ id: "c-narrative", requiredDocumentTypes: [] }),
        condition({ id: "c-doc", requiredDocumentTypes: ["tax_return"] }),
      ],
      documents: [],
      tasks: [],
    });
    expect(documents.map((d) => d.id)).toEqual(["c-doc"]);
  });
});

describe("buildDocumentChecklist — exact request path", () => {
  it("does not invent requirements when no condition or task requests a document", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [condition({ id: "c-narrative", requiredDocumentTypes: [] })],
      documents: [],
      tasks: [],
    });
    expect(documents).toEqual([]);
  });

  it("keeps uploaded history from turning itself into a document request", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [],
      documents: [doc({ id: "d1", documentType: "tax_return_1040", status: "verified" })],
      tasks: [],
    });
    expect(documents).toEqual([]);
  });

  it("uses one exact task checklist instead of mixing in five generic asks", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [],
      documents: [],
      tasks: [
        task({ id: "t1", documentCategory: "pay_stub", status: "IN_PROGRESS", verificationStatus: "pending" }),
      ],
    });
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      id: "t1",
      source: "task",
      documentType: "pay_stub",
      status: "verifying",
    });
  });
});

describe("buildDocumentChecklist — custom document-request tasks", () => {
  it("appends tasks that no existing item covers, and dedupes ones that are covered", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [condition({ id: "c1", requiredDocumentTypes: ["pay_stub"] })],
      documents: [],
      tasks: [
        task({ id: "t-covered", documentCategory: "paystub", title: "Pay stub please" }),
        task({ id: "t-new", documentCategory: "divorce_decree", title: "Divorce decree" }),
      ],
    });
    expect(documents.map((d) => d.id)).toEqual(["c1", "t-new"]);
    expect(documents[1].source).toBe("task");
    expect(documents[1].label).toBe("Divorce decree");
  });

  it("ignores non-document tasks entirely", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [],
      documents: [],
      tasks: [task({ id: "t1", taskType: "call_borrower", documentCategory: "w2" })],
    });
    expect(documents).toEqual([]);
  });

  it("does not turn a staff document-review task into a borrower upload request", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [condition({ id: "c1", status: "cleared", requiredDocumentTypes: ["drivers_license"] })],
      documents: [],
      tasks: [
        task({
          id: "staff-review",
          ownerRole: "PROCESSOR",
          documentCategory: null,
          title: "Review uploaded drivers license",
        }),
      ],
    });
    expect(documents).toEqual([]);
  });
});

describe("buildDocumentChecklist — stats", () => {
  it("keeps the legacy stat semantics (uploaded counts verifying)", () => {
    const { stats } = buildDocumentChecklist({
      conditions: [
        condition({ id: "c1", requiredDocumentTypes: ["w2"] }),
        condition({ id: "c2", requiredDocumentTypes: ["pay_stub"] }),
        condition({ id: "c3", requiredDocumentTypes: ["bank_statement"] }),
        condition({ id: "c4", requiredDocumentTypes: ["tax_return"] }),
      ],
      documents: [
        doc({ id: "d1", documentType: "w2", status: "verified" }),
        doc({ id: "d2", documentType: "pay_stub", status: "verifying" }),
        doc({ id: "d3", documentType: "bank_statement", status: "rejected", rejectionReason: "Partial" }),
      ],
      tasks: [],
    });
    expect(stats).toEqual({ total: 4, verified: 1, uploaded: 1, needed: 1, rejected: 1 });
  });
});

describe("buildDocumentChecklist — borrower-facing context (year + instructions, no staff notes)", () => {
  it("never renders completed or expired document tasks as a new borrower ask", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [],
      documents: [],
      tasks: [
        task({ id: "done", status: "COMPLETED", documentCategory: "profit_loss_statement" }),
        task({ id: "expired", status: "EXPIRED", documentCategory: "business_bank_statement" }),
      ],
    });
    expect(documents.some((item) => item.source === "task")).toBe(false);
  });

  it("task items carry documentYear so the checklist can say WHICH year's document", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [],
      documents: [],
      tasks: [
        task({ id: "t-k1", documentCategory: "k1_statement", title: "K-1 (Form 1065)", documentYear: "2023" }),
      ],
    });
    const item = documents.find((d) => d.id === "t-k1");
    expect(item?.documentYear).toBe("2023");
  });

  it("task items carry the requested document year", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [],
      documents: [],
      tasks: [task({ id: "t-tax", documentCategory: "tax_return", documentYear: "2024" })],
    });
    const requested = documents.find((d) => d.documentType === "tax_return");
    expect(requested?.documentYear).toBe("2024");
  });

  it("condition items stay yearless — conditions carry no year field", () => {
    const { documents } = buildDocumentChecklist({
      conditions: [condition({ id: "c-1", title: "P&L", requiredDocumentTypes: ["profit_loss_statement"] })],
      documents: [],
      tasks: [],
    });
    expect(documents[0]?.documentYear).toBeUndefined();
  });

  it("staff verificationNotes NEVER reach the borrower payload (notes carries documentInstructions)", () => {
    // verificationNotes is the staff review-axis free text; documentInstructions
    // is the staff-authored borrower-facing text. Only the latter may surface.
    const { documents } = buildDocumentChecklist({
      conditions: [],
      documents: [],
      tasks: [
        task({
          id: "t-std",
          documentCategory: "tax_return",
          verificationNotes: "internal: borrower disputed AGI, escalate to UW",
          documentInstructions: "Please upload all pages of your 2023 federal return.",
        }),
      ],
    });
    const serialized = JSON.stringify(documents);
    expect(serialized).not.toContain("internal: borrower disputed AGI");
    const requested = documents.find((d) => d.documentType === "tax_return");
    expect(requested?.notes).toBe("Please upload all pages of your 2023 federal return.");
    expect(requested?.instructions).toBe("Please upload all pages of your 2023 federal return.");
  });
});
