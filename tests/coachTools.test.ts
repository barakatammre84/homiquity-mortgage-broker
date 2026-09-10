import { beforeEach, describe, expect, it, vi } from "vitest";

const loadFileTruth = vi.fn();
const loadCoachDocumentEvidence = vi.fn();
const createTask = vi.fn();
const emitEvent = vi.fn();

vi.mock("../server/services/coachProfileSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/coachProfileSync")>();
  return { ...actual, syncCoachIntakeToApplication: vi.fn() };
});

// The DPA lookup tool reads the seed-verified directory through the storage
// singleton; mock it so these tests need no database.
vi.mock("../server/storage", () => ({
  storage: {
    getDpaPrograms: vi.fn(),
    getTasksByApplication: vi.fn(),
    getDealTeamMembers: vi.fn(),
  },
}));

vi.mock("../server/services/coachFileTruth", () => ({
  loadFileTruth: (...args: unknown[]) => loadFileTruth(...args),
}));

vi.mock("../server/services/coachDocumentEvidence", () => ({
  loadCoachDocumentEvidence: (...args: unknown[]) => loadCoachDocumentEvidence(...args),
}));

vi.mock("../server/services/taskEngine", () => ({
  taskEngine: { createTask: (...args: unknown[]) => createTask(...args) },
}));

vi.mock("../server/services/analyticsEventPipeline", () => ({
  emitEvent: (...args: unknown[]) => emitEvent(...args),
}));

import {
  COACH_TOOLS,
  executeCoachTool,
  type CoachStreamEvent,
  type CoachToolContext,
} from "../server/services/coachTools";
import { syncCoachIntakeToApplication } from "../server/services/coachProfileSync";
import { storage } from "../server/storage";

function makeCtx(
  overrides: Partial<CoachToolContext> = {},
): { ctx: CoachToolContext; events: CoachStreamEvent[] } {
  const events: CoachStreamEvent[] = [];
  const ctx: CoachToolContext = {
    req: { user: { id: "user-1" }, headers: {} } as never,
    userId: "user-1",
    userRole: "active_buyer",
    conversationId: "conv-1",
    turnId: "turn-1",
    workableApplicationId: null,
    emit: (e) => events.push(e),
    state: {},
    ...overrides,
  };
  return { ctx, events };
}

describe("COACH_TOOLS definition stability (prompt-cache contract)", () => {
  it("keeps the tool names in a FIXED order — reordering invalidates the prompt cache", () => {
    expect(COACH_TOOLS.map((t) => t.name)).toEqual([
      "record_intake",
      "set_action_plan",
      "generate_borrower_package",
      "suggest_next_steps",
      // Appended 2026-08-04 (renter-incubation adjudication Leg C) — new tools
      // append at the END only.
      "lookup_dpa_programs",
      // Appended 2026-08-19 — the server-truth read tools.
      "get_loan_status",
      "get_document_checklist",
      "get_borrower_tasks",
      // Appended 2026-08-20 — explicit, auditable human assistance.
      "request_human_help",
      // Appended 2026-09-10 — bounded OCR and financial-review truth.
      "get_document_evidence",
    ]);
  });

  // THE contract this whole change exists to make unrepresentable.
  //
  // set_document_checklist let the model author the borrower's document list.
  // It invented a docType matching no loan_condition, the panel rendered it
  // authoritatively beside an Upload button, the borrower uploaded — and
  // nothing cleared, because the real checklist is derived elsewhere. The UI
  // said the operation happened; the file said it did not.
  //
  // update_readiness was the same shape one level down: the model restating
  // tier/completed/outstanding figures the server had just handed it, with
  // only two possible outcomes — identical, or wrong.
  it("gives the model NO tool that can author file state", () => {
    const names = COACH_TOOLS.map((t) => t.name);
    expect(names).not.toContain("set_document_checklist");
    expect(names).not.toContain("update_readiness");
  });

  it("refuses to execute the removed tools even if a stale model call arrives", async () => {
    // A conversation mid-flight across a deploy can still emit the old name.
    // It must fail loudly as unknown, never silently no-op into a state the
    // borrower then sees rendered as fact.
    for (const stale of ["set_document_checklist", "update_readiness"]) {
      const { ctx, events } = makeCtx();
      const result = await executeCoachTool(ctx, stale, { documents: [], readinessTier: "ready_now" });
      expect(result.isError, stale).toBe(true);
      expect(result.content, stale).toMatch(/unknown tool/i);
      expect(events, stale).toHaveLength(0);
      expect(ctx.state.documentChecklist, stale).toBeUndefined();
      expect(ctx.state.profile, stale).toBeUndefined();
    }
  });

  it("the action plan cannot encroach on the checklist's territory", () => {
    const plan = COACH_TOOLS.find((t) => t.name === "set_action_plan")!;
    const schema = JSON.stringify(plan.input_schema);
    // "documents" is gone from the category enum, so a plan cannot structurally
    // become a second, model-authored document list.
    expect(schema).not.toContain('"documents"');
    expect(plan.description).toMatch(/get_document_checklist/);
    expect(plan.description).toMatch(/get_loan_status/);
  });

  // The read tools resolve the application from the authenticated session.
  // A tool that ACCEPTS an id hands the model an IDOR primitive: it can be
  // argued into emitting someone else's uuid, and the request looks legitimate
  // by the time it reaches storage. Asserted over the whole array so a tool
  // added later inherits the rule instead of quietly opting out of it.
  it("no tool accepts an identifier as input", async () => {
    const FORBIDDEN = ["applicationId", "userId", "conversationId", "loanId", "borrowerId"];
    for (const tool of COACH_TOOLS) {
      const props = Object.keys((tool.input_schema as { properties?: object }).properties ?? {});
      for (const key of FORBIDDEN) {
        expect(props, `${tool.name} must not accept ${key}`).not.toContain(key);
      }
    }
  });

  it("every tool description states WHEN to call it", () => {
    for (const tool of COACH_TOOLS) {
      expect(tool.description, tool.name).toMatch(/call/i);
    }
  });
});

describe("executeCoachTool: record_intake", () => {
  beforeEach(() => vi.clearAllMocks());

  it("filters unknown keys, syncs the rest, emits captured, and reports honestly", async () => {
    vi.mocked(syncCoachIntakeToApplication).mockResolvedValue({
      applicationId: "app-1",
      created: false,
      applied: [{ field: "annualIncome", value: "85000" }],
      skipped: [{ field: "creditScore", reason: "verified_locked" }],
    });
    const { ctx, events } = makeCtx();

    const result = await executeCoachTool(ctx, "record_intake", {
      annualIncome: "85000",
      creditScore: "720",
      favoriteColor: "blue", // hallucinated key must not void the real fields
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("annualIncome");
    expect(result.content).toContain("verified_locked");
    expect(result.content).toContain("favoriteColor");
    expect(vi.mocked(syncCoachIntakeToApplication)).toHaveBeenCalledWith(
      ctx.req,
      "user-1",
      { annualIncome: "85000", creditScore: "720" },
      "conv-1",
    );
    expect(ctx.state.intake).toEqual({ annualIncome: "85000", creditScore: "720" });
    expect(ctx.state.syncedApplicationId).toBe("app-1");
    expect(ctx.state.captureOutcome).toEqual({
      attempts: 1,
      createdApplication: false,
      appliedFields: ["annualIncome"],
      skippedFields: 1,
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "captured", applicationId: "app-1", applied: [{ field: "annualIncome", value: "85000" }] }),
    ]);
  });

  it("rejects wrongly-typed fields with an is_error tool_result (model self-corrects)", async () => {
    const { ctx } = makeCtx();
    const result = await executeCoachTool(ctx, "record_intake", { annualIncome: 85000 });
    expect(result.isError).toBe(true);
    expect(vi.mocked(syncCoachIntakeToApplication)).not.toHaveBeenCalled();
  });

  it("rejects an empty intake", async () => {
    const { ctx } = makeCtx();
    const result = await executeCoachTool(ctx, "record_intake", { nonsense: true });
    expect(result.isError).toBe(true);
  });

  it("keeps the conversation snapshot but tells the model NOT to claim a save when sync fails", async () => {
    vi.mocked(syncCoachIntakeToApplication).mockRejectedValue(new Error("db down"));
    const { ctx, events } = makeCtx();

    const result = await executeCoachTool(ctx, "record_intake", { annualIncome: "85000" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Do NOT tell the user/i);
    expect(ctx.state.intake).toEqual({ annualIncome: "85000" }); // structuredData still persists it
    expect(ctx.state.captureOutcome).toEqual({
      attempts: 1,
      createdApplication: false,
      appliedFields: [],
      skippedFields: 0,
    });
    expect(events).toEqual([]); // no captured event for a failed save
  });
});

describe("executeCoachTool: panel tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("set_action_plan validates items strictly", async () => {
    const { ctx, events } = makeCtx();
    const bad = await executeCoachTool(ctx, "set_action_plan", {
      items: [{ id: "a", phase: 1, title: "t", description: "d", priority: "urgent", category: "credit", completed: false }],
    });
    expect(bad.isError).toBe(true);

    const good = await executeCoachTool(ctx, "set_action_plan", {
      items: [{ id: "a", phase: 1, title: "t", description: "d", priority: "high", category: "credit", completed: false }],
    });
    expect(good.isError).toBeUndefined();
    expect(ctx.state.actionPlan?.length).toBe(1);
    expect(events.at(-1)).toEqual(expect.objectContaining({ type: "panel" }));
  });

  it("generate_borrower_package strips model-authored access links", async () => {
    const { ctx } = makeCtx();
    const pkg = {
      generatedDate: "2026-07-12",
      borrowerOverview: { borrowerNames: "A B", householdComposition: "Single Borrower", primaryResidenceState: "IL", incomeProfileType: "W-2" },
      householdOverview: { firstTimeBuyer: "Yes", veteranStatus: "No" },
      transactionIntent: { transactionType: "Purchase", propertyIntent: "Primary Residence", targetTimeframe: "Not Provided" },
      incomeSources: [{ source: "Acme", type: "W-2", frequency: "Annual", documentationStatus: "Pending" }],
      assetSummary: [{ assetType: "Savings Account", accountCategory: "Liquid", ownershipType: "Individual", documentationStatus: "Pending", lastStatementDate: "Not Provided", validationNotes: "", accessLink: "https://evil.example/exfil" }],
      creditAndDebt: { creditScore: "720", creditScoreVerification: "Tier 3", monthlyDebts: "1200", monthlyDebtsVerification: "Tier 3", dtiRatio: "Insufficient Data", dtiNote: "Preparatory calculation only." },
      propertyContext: { propertyAddress: "Not Provided", estimatedValueOrPrice: "350000", occupancyIntent: "Primary Residence" },
      documentInventory: [{ docType: "pay_stub", label: "Pay Stub", status: "Not Yet Received", flags: [] }],
      readinessStatus: { intakeStatus: "Complete", documentStatus: "Not Started", packageStatus: "Pending Items", pendingItems: ["pay stub"] },
      auditTrail: { intakeStartDate: "2026-07-12", lastUpdateDate: "2026-07-12", events: [{ date: "2026-07-12", activity: "Intake started" }] },
      validationNotes: { recencyChecks: [], completenessChecks: [], consistencyObservations: [] },
      complianceFooter: "This intake summary is prepared for informational purposes only.",
    };
    const result = await executeCoachTool(ctx, "generate_borrower_package", pkg);
    expect(result.isError).toBeUndefined();
    expect(ctx.state.borrowerPackage?.assetSummary[0].accessLink).toBe("");
  });

  it("suggest_next_steps enforces the 1-3 chip contract", async () => {
    const { ctx } = makeCtx();
    const tooMany = await executeCoachTool(ctx, "suggest_next_steps", {
      suggestions: ["a", "b", "c", "d"],
    });
    expect(tooMany.isError).toBe(true);

    const ok = await executeCoachTool(ctx, "suggest_next_steps", {
      suggestions: ["What documents do I need?", "How is my readiness?"],
    });
    expect(ok.isError).toBeUndefined();
    expect(ctx.state.suggestions?.length).toBe(2);
  });

  it("returns is_error for an unknown tool name", async () => {
    const { ctx } = makeCtx();
    const result = await executeCoachTool(ctx, "delete_everything", {});
    expect(result.isError).toBe(true);
  });
});

describe("executeCoachTool: lookup_dpa_programs (renter-incubation adjudication Leg C)", () => {
  const getDpaPrograms = vi.mocked(storage.getDpaPrograms);
  const ihda = {
    name: "IHDAccess Forgivable",
    programType: "state",
    assistanceType: "forgivable_loan",
    state: "IL",
    description: "4% of the purchase price as a forgivable loan.",
    maxAssistanceAmount: "6000",
    maxAssistancePercent: "4",
    minCreditScore: 640,
    firstTimeBuyerOnly: false,
    eligibilityNotes: "County limits apply; as of July 2026.",
    applicationUrl: "https://www.ihda.org/",
    isActive: true,
  };

  beforeEach(() => vi.clearAllMocks());

  it("returns the verified rows with the confirm-with-agency instruction", async () => {
    getDpaPrograms.mockResolvedValueOnce([ihda as never]);
    const { ctx } = makeCtx();
    const result = await executeCoachTool(ctx, "lookup_dpa_programs", { state: "il" });
    expect(result.isError).toBeUndefined();
    // Zod normalizes the state filter before it reaches storage.
    expect(getDpaPrograms).toHaveBeenCalledWith({ state: "IL" });
    expect(result.content).toContain("IHDAccess Forgivable");
    expect(result.content).toContain("minimum credit score 640");
    expect(result.content).toContain("HUD-approved housing counselor");
    expect(result.content).toContain("do not state or imply that they qualify");
  });

  it("tells the model the directory is IL-only on an empty result — never invent", async () => {
    getDpaPrograms.mockResolvedValueOnce([]);
    const { ctx } = makeCtx();
    const result = await executeCoachTool(ctx, "lookup_dpa_programs", { state: "TX" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Illinois programs only");
    expect(result.content).toContain("do NOT invent programs");
  });

  it("rejects malformed filters without touching storage", async () => {
    const { ctx } = makeCtx();
    const result = await executeCoachTool(ctx, "lookup_dpa_programs", { state: "Texas" });
    expect(result.isError).toBe(true);
    expect(getDpaPrograms).not.toHaveBeenCalled();
  });

  it("degrades honestly when the directory read fails", async () => {
    getDpaPrograms.mockRejectedValueOnce(new Error("db down"));
    const { ctx } = makeCtx();
    const result = await executeCoachTool(ctx, "lookup_dpa_programs", {});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("do not answer from memory");
  });
});

describe("executeCoachTool: request_human_help", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadFileTruth.mockResolvedValue({ application: { id: "app-1" } });
    vi.mocked(storage.getTasksByApplication).mockResolvedValue([]);
    vi.mocked(storage.getDealTeamMembers).mockResolvedValue([
      { teamRole: "loan_officer", isActive: true, userId: "lo-1" } as never,
    ]);
    createTask.mockResolvedValue({ id: "task-1" });
    emitEvent.mockResolvedValue(undefined);
  });

  it("creates an owned, redacted follow-up and records the handoff", async () => {
    const { ctx } = makeCtx({ workableApplicationId: "app-1" });
    const result = await executeCoachTool(ctx, "request_human_help", { topic: "complex_income" });

    expect(result.isError).toBeUndefined();
    expect(ctx.state.humanHelpRequest).toEqual({ taskId: "task-1", alreadyOpen: false });
    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: "app-1",
        assignedToUserId: "lo-1",
        ownerRole: "LO",
        priority: "high",
      }),
      "user-1",
      "SYSTEM",
      {
        source: "homi_handoff",
        conversationId: "conv-1",
        turnId: "turn-1",
        topic: "complex_income",
      },
    );
    expect(emitEvent).toHaveBeenCalledWith(
      "borrower",
      "homi_human_help_requested",
      expect.objectContaining({ entityId: "task-1", textValue: "complex_income" }),
    );
  });

  it("rejects free-text handoff content so borrower data cannot enter task metadata", async () => {
    const { ctx } = makeCtx({ workableApplicationId: "app-1" });
    const result = await executeCoachTool(ctx, "request_human_help", {
      topic: "other",
      summary: "My tax ID is sensitive",
    });

    expect(result.isError).toBe(true);
    expect(createTask).not.toHaveBeenCalled();
    expect(loadFileTruth).not.toHaveBeenCalled();
  });

  it("reuses an active Homi handoff instead of creating a duplicate", async () => {
    vi.mocked(storage.getTasksByApplication).mockResolvedValue([
      { id: "task-existing", status: "OPEN", triggerMetadata: { source: "homi_handoff" } } as never,
    ]);
    const { ctx } = makeCtx({ workableApplicationId: "app-1" });
    const result = await executeCoachTool(ctx, "request_human_help", { topic: "loan_options" });

    expect(result.isError).toBeUndefined();
    expect(ctx.state.humanHelpRequest).toEqual({ taskId: "task-existing", alreadyOpen: true });
    expect(createTask).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe("executeCoachTool: get_document_evidence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("distinguishes machine-read, human-verified, and approved financial evidence", async () => {
    loadCoachDocumentEvidence.mockResolvedValue({
      documents: [
        {
          documentType: "pay_stub",
          label: "Pay stub",
          documentReviewStatus: "accepted",
          evidenceStatus: "partly_human_verified",
          omittedFactCount: 0,
          facts: [
            { label: "Year-to-date gross pay", value: 42_000, format: "currency", reviewStatus: "machine_read", confidence: "medium", needsHumanReview: true, pageNumber: 1 },
            { label: "Monthly income average from year-to-date pay", value: 7_000, format: "currency", reviewStatus: "human_verified", confidence: "not_applicable", needsHumanReview: false, pageNumber: 1 },
          ],
        },
      ],
      summary: { documentCount: 1, extractedFactCount: 2, humanVerifiedFactCount: 1, factsNeedingHumanReview: 1, omittedDocumentCount: 0 },
      financialReview: { status: "approved_for_lender_package", income: "approved", assets: "approved" },
    });
    const { ctx } = makeCtx({ workableApplicationId: "app-1" });

    const result = await executeCoachTool(ctx, "get_document_evidence", {});

    expect(result.isError).toBeUndefined();
    expect(loadCoachDocumentEvidence).toHaveBeenCalledWith("app-1", { id: "user-1", role: "active_buyer" });
    expect(result.content).toContain("$42,000.00 (machine read; medium confidence; needs human review; source page 1)");
    expect(result.content).toContain("$7,000.00 (human verified; source page 1)");
    expect(result.content).toContain("approved for lender presentation");
    expect(result.content).toMatch(/not qualifying income or an approval decision|Never turn/i);
    expect(result.content).toMatch(/low-confidence fact needs STAFF review/i);
    expect(result.content).toMatch(/unless get_document_checklist says it was rejected/i);
  });

  it("states the no-application case without inventing an extraction", async () => {
    const { ctx } = makeCtx({ workableApplicationId: null });
    const result = await executeCoachTool(ctx, "get_document_evidence", {});
    expect(result.content).toMatch(/no application in progress/i);
    expect(loadCoachDocumentEvidence).not.toHaveBeenCalled();
  });

  it("fails closed when the authorized evidence read fails", async () => {
    loadCoachDocumentEvidence.mockRejectedValue(new Error("db unavailable"));
    const { ctx } = makeCtx({ workableApplicationId: "app-1" });
    const result = await executeCoachTool(ctx, "get_document_evidence", {});
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/temporarily unavailable/i);
    expect(result.content).toMatch(/do NOT answer from memory/i);
  });
});
