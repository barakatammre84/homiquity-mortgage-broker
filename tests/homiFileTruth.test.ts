import { describe, expect, it, vi, beforeEach } from "vitest";

// storage / engines are mocked; buildDocumentChecklist and the shared
// derivations stay REAL — that is the whole point of the headline test below.
vi.mock("../server/storage", () => ({
  storage: {
    getLoanApplicationWithAccess: vi.fn(),
    getLoanConditionsByApplication: vi.fn(),
    getDocumentsByApplication: vi.fn(),
    getTasksByApplication: vi.fn(),
    getLoanMilestones: vi.fn(),
    getUnreadMessageCount: vi.fn(),
  },
}));
vi.mock("../server/pipelineEngine", () => ({ getPipelineSummary: vi.fn() }));
vi.mock("../server/services/taskEngine", () => ({
  taskEngine: { getBorrowerTasks: vi.fn() },
}));
vi.mock("../server/services/activitySummary", () => ({
  getUserActivitySummary: vi.fn(),
}));

import { loadFileTruth, selectCoachApplications } from "../server/services/coachFileTruth";
import { buildDocumentChecklist } from "../server/services/documentChecklist";
import { storage } from "../server/storage";
import { getPipelineSummary } from "../server/pipelineEngine";
import { taskEngine } from "../server/services/taskEngine";
import { getUserActivitySummary } from "../server/services/activitySummary";
import { BORROWER_TASK_EMBARGOED_COLUMNS } from "@shared/borrowerTaskView";
import { pickWorkableLoanApplication } from "@shared/loanApplicationStatus";

const APP_ID = "app-1";
const USER = { id: "user-1", role: "active_buyer" } as never;

// A file mid-flight: two document-bearing conditions, one satisfied by an
// uploaded doc, one still outstanding, plus a rejected upload.
const CONDITIONS = [
  {
    id: "cond-paystub",
    status: "outstanding",
    category: "income",
    title: "Most recent pay stubs",
    description: "Covering the last 30 days.",
    requiredDocumentTypes: ["pay_stub"],
    priority: "prior_to_approval",
  },
  {
    id: "cond-bank",
    status: "outstanding",
    category: "assets",
    title: "Two months of bank statements",
    description: "All pages, including blank ones.",
    requiredDocumentTypes: ["bank_statement"],
    priority: "prior_to_approval",
  },
] as never[];

const DOCUMENTS = [
  {
    id: "doc-1",
    documentType: "pay_stub",
    fileName: "paystub.pdf",
    status: "uploaded",
    createdAt: new Date("2026-08-10T00:00:00Z"),
    rejectionReason: null,
    reviewedAt: null,
  },
  {
    id: "doc-2",
    documentType: "bank_statement",
    fileName: "bank.pdf",
    status: "rejected",
    createdAt: new Date("2026-08-11T00:00:00Z"),
    rejectionReason: "Page 3 is missing.",
    reviewedAt: new Date("2026-08-12T00:00:00Z"),
  },
] as never[];

const RAW_TASKS = [
  {
    id: "task-1",
    applicationId: APP_ID,
    title: "Upload your pay stubs",
    taskType: "document_request",
    taskTypeCode: "DOC_MISSING",
    ownerRole: "BORROWER",
    status: "OPEN",
    priority: "normal",
    assignedToUserId: "user-1",
    verificationStatus: "pending",
    // Staff-only internals that must never survive the masking layer:
    createdByUserId: "staff-9",
    verificationNotes: "borrower keeps sending the wrong year",
    resolutionNotes: "escalate to processor",
    escalationLevel: 2,
  },
] as never[];

function primeHappyPath() {
  vi.mocked(storage.getLoanApplicationWithAccess).mockResolvedValue({
    id: APP_ID,
    status: "underwriting",
    userId: "user-1",
  } as never);
  vi.mocked(storage.getLoanConditionsByApplication).mockResolvedValue(CONDITIONS);
  vi.mocked(storage.getDocumentsByApplication).mockResolvedValue(DOCUMENTS);
  vi.mocked(storage.getTasksByApplication).mockResolvedValue([] as never);
  vi.mocked(storage.getLoanMilestones).mockResolvedValue({
    submittedAt: new Date("2026-08-01T00:00:00Z"),
    underwritingStartedAt: new Date("2026-08-14T00:00:00Z"),
  } as never);
  vi.mocked(storage.getUnreadMessageCount).mockResolvedValue(0);
  vi.mocked(taskEngine.getBorrowerTasks).mockResolvedValue(RAW_TASKS);
  vi.mocked(getUserActivitySummary).mockResolvedValue({
    propertySearches: 0,
    calculatorUses: 0,
  } as never);
  vi.mocked(getPipelineSummary).mockResolvedValue({
    applicationId: APP_ID,
    borrowerName: "Pat Borrower",
    currentStage: "underwriting",
    daysInPipeline: 18,
    targetCloseDate: null,
    conditionsOutstanding: 2,
    conditionsTotal: 5,
    percentComplete: 60,
    nextAction: "Clear conditions",
    priority: "urgent",
    lastActivityAt: new Date("2026-08-18T00:00:00Z"),
    daysIdle: 1,
    fileHealth: { light: "red", reasons: ["Stalled 3 days"] },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  primeHappyPath();
});

describe("the assistant's checklist IS the borrower's checklist", () => {
  // THE headline test. The old set_document_checklist let the MODEL author
  // this list, so it invented a documentType matching no condition; the panel
  // rendered it authoritatively next to an Upload button, the borrower
  // uploaded, and nothing cleared. Pinning the assistant's checklist to the
  // exact output of the same pure builder the Documents page uses is what
  // makes that class of failure unrepresentable.
  it("deep-equals buildDocumentChecklist over the identical inputs", async () => {
    const truth = await loadFileTruth(APP_ID, USER);
    const expected = buildDocumentChecklist({
      conditions: CONDITIONS,
      documents: DOCUMENTS,
      tasks: [] as never,
    });
    expect(truth?.checklist).toEqual(expected);
  });

  it("carries the real per-item status and the rejection reason the borrower must act on", async () => {
    const truth = await loadFileTruth(APP_ID, USER);
    const bank = truth!.checklist.documents.find((d) => d.conditionId === "cond-bank");
    expect(bank?.status).toBe("rejected");
    expect(bank?.rejectionReason).toBe("Page 3 is missing.");
  });
});

describe("staff-only signals never cross to the borrower surface", () => {
  // PipelineSummary carries the LO cockpit's No-Stall signals. "urgent"/red
  // means the FILE needs staff attention; shown to a borrower it reads as a
  // problem with their application, which is not what it means. The snapshot
  // is a whitelist, so this test fails the moment someone spreads instead.
  it.each(["fileHealth", "priority", "borrowerName", "daysIdle"])(
    "omits %s",
    async (field) => {
      const truth = await loadFileTruth(APP_ID, USER);
      expect(JSON.stringify(truth!.status)).not.toContain(field);
    },
  );

  it("omits the staff verdict values too, not just the key names", async () => {
    const truth = await loadFileTruth(APP_ID, USER);
    const serialized = JSON.stringify(truth!.status);
    expect(serialized).not.toContain("Stalled 3 days");
    expect(serialized).not.toContain("Pat Borrower");
  });

  it("masks borrower tasks — no embargoed column survives", async () => {
    const truth = await loadFileTruth(APP_ID, USER);
    const serialized = JSON.stringify(truth!.tasks);
    // Iterating the exported constant means a NEW embargoed column is covered
    // automatically instead of needing someone to remember this test.
    for (const column of BORROWER_TASK_EMBARGOED_COLUMNS) {
      expect(serialized, `embargoed column ${column} leaked`).not.toContain(`"${column}"`);
    }
    expect(serialized).not.toContain("borrower keeps sending the wrong year");
    expect(serialized).not.toContain("escalate to processor");
  });
});

describe("stage and journey come from the shared derivations", () => {
  it("reports the borrower-facing stage meta, not a hand-rolled label", async () => {
    const truth = await loadFileTruth(APP_ID, USER);
    // These values come from LOAN_APP_STATUS_META — the single source the
    // dashboard renders from. A hand-rolled switch here would drift silently.
    expect(truth!.status.stage).toEqual({
      status: "underwriting",
      label: expect.any(String),
      description: expect.any(String),
      progressPercent: expect.any(Number),
      phase: expect.any(String),
    });
  });

  it("derives the condition line borrowers actually read", async () => {
    const truth = await loadFileTruth(APP_ID, USER);
    const uw = truth!.status.journey.find((s) => s.stepId === "underwriting");
    expect(uw?.lines).toContain("Conditions cleared: 3 of 5");
  });

  it("counts a rejected upload as still owed, not as done", async () => {
    const truth = await loadFileTruth(APP_ID, USER);
    const processing = truth!.status.journey.find((s) => s.stepId === "processing");
    // 2 items: one uploaded (borrower's part done), one rejected (not done).
    expect(processing?.lines.join(" ")).toContain("Documents: 1 of 2 complete");
  });
});

describe("the tools target the WORKABLE file, never a closed one", () => {
  // Homi now resolves one coherent current file for both its narrative and its
  // actions. Closed history can inform context only when no workable file exists.
  const closedOnly = [
    { id: "app-denied", status: "denied" },
    { id: "app-withdrawn", status: "withdrawn" },
    { id: "app-funded", status: "funded" },
  ];

  it("resolves to nothing when every file is closed", () => {
    expect(pickWorkableLoanApplication(closedOnly)).toBeUndefined();
    // …whereas the wide chain the narrative context uses would hand back a
    // closed file, which is precisely what must not reach an upload target.
    const wide =
      closedOnly.find((a) => a.status === "funded") ?? closedOnly[0];
    expect(wide.id).toBe("app-funded");
  });

  it("prefers a draft over a closed file", () => {
    expect(
      pickWorkableLoanApplication([...closedOnly, { id: "app-draft", status: "draft" }])?.id,
    ).toBe("app-draft");
  });

  it("uses an in-flight file for both context and actions even when a draft is newer", () => {
    const selected = selectCoachApplications([
      { id: "app-draft", status: "draft" },
      { id: "app-submitted", status: "submitted" },
    ]);
    expect(selected.contextApplication?.id).toBe("app-submitted");
    expect(selected.workableApplication?.id).toBe("app-submitted");
  });

  it("keeps a funded file as narrative-only history", () => {
    const selected = selectCoachApplications(closedOnly);
    expect(selected.contextApplication?.id).toBe("app-funded");
    expect(selected.workableApplication).toBeUndefined();
  });

  it("uses a draft for both context and actions when it is the only workable file", () => {
    const selected = selectCoachApplications([{ id: "app-draft", status: "draft" }]);
    expect(selected.contextApplication?.id).toBe("app-draft");
    expect(selected.workableApplication?.id).toBe("app-draft");
  });
});

describe("authorization", () => {
  it("returns null when the access check refuses — never a partial answer", async () => {
    vi.mocked(storage.getLoanApplicationWithAccess).mockResolvedValue(undefined as never);
    expect(await loadFileTruth(APP_ID, USER)).toBeNull();
  });

  it("re-authorizes on every load rather than trusting its caller", async () => {
    await loadFileTruth(APP_ID, USER);
    expect(storage.getLoanApplicationWithAccess).toHaveBeenCalledWith(
      APP_ID,
      "user-1",
      "active_buyer",
    );
  });
});
