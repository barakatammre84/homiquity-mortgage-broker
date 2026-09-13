import { describe, it, expect, beforeEach, vi } from "vitest";

// Load pipelineEngine at module init, not inside the first test that reaches it.
//
// finalizeIntake does `await import("../pipelineEngine")`, so whichever test hits
// it first pays the cold load of that whole module graph — measured at ~14s
// against ~1-14ms for every sibling. In isolation that fits inside the 45s
// testTimeout; under a full 219-file parallel lane it contends for CPU and can
// exceed it, which is why this ECOA guard failed intermittently (~2 runs in 25)
// and passed on re-run. A compliance invariant that goes green on retry is worse
// than one that fails outright, so the cost is paid here, before any test timer
// starts, rather than being hidden behind a raised timeout.
//
// finalizeIntake lazily imports several heavy modules; these are the ones it
// reaches that no vi.mock replaces (emailService pulls the SendGrid SDK).
// Importing them here only changes WHEN they load, never whether.
import "../server/pipelineEngine";
import "../server/services/preUnderwriting";
import "../server/services/emailService";

// ---------------------------------------------------------------------------
// ECOA locus: automated intake may say YES. It may never say NO.
// (F-014 slice 4; also closes the loanAnalysis half of F-015.)
//
// The rule. ECOA/Reg B §1002.9 requires an adverse-action notice with specific
// reasons whenever credit is denied. Homiquity's design answer is that the
// automated intake path is structurally incapable of denying: the deterministic
// engine's REJECTED / MANUAL_REVIEW / NEEDS_MORE_INFO all collapse to
// "under_review", and a denial can only be entered by a human through the
// statusDecisions route, which is chokepointed on ensureAdverseActionForDenial.
// If intake could persist "denied", it would produce a denial with no notice —
// the §1002.9 hole.
//
// What guarded it before. complianceInvariants.test.ts read the source:
//
//     expect(source).toMatch(/decision\?\.decision === "APPROVED"/);
//     expect(source).toMatch(/"pre_approved" \| "under_review"/);
//     expect(source).not.toMatch(/outcome[^\n]*"denied"/);
//
// The middle assertion matches the TYPE ANNOTATION on IntakeAnalysisResult, not
// any executed behavior — a type is erased at runtime, so it constrains what a
// developer can write in that one file and nothing about what actually reaches
// the database. The third is a negative text search scoped to lines containing
// "outcome"; a denial written any other way, or through a value computed
// elsewhere, is invisible to it. And F-015 separately records that
// finalizeIntake — the ECOA locus itself — had no executing test at all.
//
// So these tests drive the real functions across EVERY engine outcome and assert
// the property directly: whatever the engine says, nothing denies.
// ---------------------------------------------------------------------------

const APP_ID = "app_1";

let application: Record<string, unknown>;
let decisionResult: unknown;
let decisionThrows: Error | null = null;
const updates: Array<Record<string, unknown>> = [];
const lifecycleEvents: string[] = [];

vi.mock("../server/storage", () => ({
  storage: {
    getLoanApplication: async () => application,
    getUser: async () => ({ id: "user_1", firstName: "Dana", email: "d@test.local" }),
    updateLoanApplication: async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
      if (patch.status) lifecycleEvents.push(`status:${patch.status}`);
      application = { ...application, ...patch };
      return application;
    },
    createNotification: async (notification: Record<string, unknown>) => {
      lifecycleEvents.push(`notification:${String(notification.title)}`);
      return {};
    },
    createDealActivity: async (activity: Record<string, unknown>) => {
      lifecycleEvents.push(`activity:${String(activity.title)}`);
      return {};
    },
    deleteLoanOptionsByApplication: async () => {},
    createLoanOption: async () => {
      lifecycleEvents.push("loan_option");
      return {};
    },
    createActivity: async () => ({}),
    getPropertyById: async () => null,
    getPropertiesByUser: async () => [],
    getLoanMilestones: async () => null,
    createLoanMilestone: async () => ({}),
    getOtherIncomeSources: async () => [],
    getEmploymentHistory: async () => [],
    getLoanConditionsByApplication: async () => [],
    createLoanCondition: async (condition: Record<string, unknown>) => {
      lifecycleEvents.push(`condition:${String(condition.requiredDocumentTypes)}`);
      return { id: `condition_${lifecycleEvents.length}`, ...condition };
    },
    getTasksByApplication: async () => [],
    createTask: async (task: Record<string, unknown>) => {
      lifecycleEvents.push(`task:${String(task.documentCategory)}`);
      return { id: `task_${lifecycleEvents.length}`, ...task };
    },
  },
}));

vi.mock("../server/services/decisionEngine", () => ({
  recalculateDecision: async () => {
    if (decisionThrows) throw decisionThrows;
    return decisionResult;
  },
}));

vi.mock("../server/services/optimizationEngine", () => ({
  syncApplicationStatusToStateMachine: async () => {},
}));
vi.mock("../server/services/outcomeTracker", () => ({
  recordStageTimestamp: async () => {},
}));

import {
  analyzeIntake,
  finalizeIntake,
  refreshEarlyStageIntakeAnalysis,
} from "../server/services/loanAnalysis";

function baseApplication(over: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    userId: "user_1",
    status: "submitted",
    annualIncome: "120000",
    monthlyDebts: "500",
    downPayment: "80000",
    purchasePrice: "400000",
    creditScore: 740,
    loanAmount: "320000",
    ...over,
  };
}

/** Every terminal shape the deterministic engine can hand intake. */
const VERIFIED_APPROVAL = {
  decision: "APPROVED",
  status: "DECISION_READY",
  reasons: [],
  qualifier: "VERIFIED",
  loanProgram: "CONVENTIONAL",
  resolvedPolicy: {
    loanType: "CONVENTIONAL",
    conventionalDtiCapPct: 43,
    conventionalFicoFloor: 640,
  },
  metrics: { dti: 30, ltv: 80, monthlyIncome: 10000, monthlyDebts: 500, pmiMonthly: 0 },
};
const PRELIMINARY_APPROVAL = {
  ...VERIFIED_APPROVAL,
  qualifier: "PRELIMINARY",
};

const ENGINE_OUTCOMES: Array<{ label: string; decision: unknown }> = [
  {
    label: "VERIFIED APPROVED",
    decision: VERIFIED_APPROVAL,
  },
  {
    label: "PRELIMINARY APPROVED",
    decision: PRELIMINARY_APPROVAL,
  },
  {
    label: "REJECTED",
    decision: { decision: "REJECTED", status: "COMPLETE", reasons: ["DTI above ceiling"], qualifier: "PRELIMINARY", metrics: { dti: 62, ltv: 95 } },
  },
  {
    label: "MANUAL_REVIEW",
    decision: { decision: "MANUAL_REVIEW", status: "COMPLETE", reasons: ["Jumbo routing"], qualifier: "PRELIMINARY", metrics: { dti: 45, ltv: 80 } },
  },
  {
    label: "NEEDS_MORE_INFO",
    decision: { decision: "MANUAL_REVIEW", status: "NEEDS_MORE_INFO", reasons: [], missingItems: ["income"], qualifier: "PRELIMINARY", metrics: null },
  },
  { label: "engine returned null", decision: null },
  { label: "engine returned undefined", decision: undefined },
  {
    label: "unknown future decision token",
    decision: { decision: "SOME_NEW_TOKEN", status: "COMPLETE", reasons: [], qualifier: "PRELIMINARY", metrics: { dti: 30, ltv: 80 } },
  },
];

beforeEach(() => {
  application = baseApplication();
  decisionResult = ENGINE_OUTCOMES[0].decision;
  decisionThrows = null;
  updates.length = 0;
  lifecycleEvents.length = 0;
});

describe("ECOA §1002.9: automated intake never denies", () => {
  it.each(ENGINE_OUTCOMES.map((o) => [o.label, o.decision] as const))(
    "engine says %s → intake outcome is never 'denied'",
    async (_label, decision) => {
      decisionResult = decision;
      const result = await analyzeIntake(APP_ID);
      expect(["pre_approved", "under_review"]).toContain(result.outcome);
      expect(result.outcome).not.toBe("denied");
    },
  );

  it.each(ENGINE_OUTCOMES.map((o) => [o.label, o.decision] as const))(
    "engine says %s → nothing persisted to the application is 'denied'",
    async (_label, decision) => {
      decisionResult = decision;
      await finalizeIntake(APP_ID);
      // This is the assertion the source-grep could not make: inspect every
      // status actually written to storage, not the text of one file.
      const statuses = updates.map((u) => u.status).filter(Boolean);
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses).not.toContain("denied");
      for (const s of statuses) {
        expect(["analyzing", "pre_approved", "under_review"]).toContain(s);
      }
    },
  );

  // "Never denies" is only half the invariant. The other half is that intake
  // must not APPROVE what the engine refused to approve — mutation testing
  // caught that the tests above pass when MANUAL_REVIEW is treated as approved,
  // which would auto-approve every file the engine flagged for a human. Pin the
  // exact mapping the module header documents, in both directions.
  const EXPECTED_MAPPING: Array<[string, unknown, "pre_approved" | "under_review"]> = [
    ["VERIFIED APPROVED", VERIFIED_APPROVAL, "pre_approved"],
    ["PRELIMINARY APPROVED", PRELIMINARY_APPROVAL, "under_review"],
    ["REJECTED", ENGINE_OUTCOMES[2].decision, "under_review"],
    ["MANUAL_REVIEW", ENGINE_OUTCOMES[3].decision, "under_review"],
    ["NEEDS_MORE_INFO", ENGINE_OUTCOMES[4].decision, "under_review"],
    ["null decision", null, "under_review"],
    ["unknown token", ENGINE_OUTCOMES[7].decision, "under_review"],
  ];

  it.each(EXPECTED_MAPPING)(
    "engine %s maps to exactly '%s' — only APPROVED may auto-approve",
    async (_label, decision, expected) => {
      decisionResult = decision;
      const result = await analyzeIntake(APP_ID);
      expect(result.outcome).toBe(expected);
      expect(result.isApproved).toBe(expected === "pre_approved");
    },
  );

  it("a REJECTED engine decision routes to human review — the ECOA locus", async () => {
    decisionResult = ENGINE_OUTCOMES[2].decision;
    const result = await analyzeIntake(APP_ID);
    // The engine said no. Intake must NOT turn that into a denial; only a human
    // may, via the statusDecisions chokepoint that generates the notice.
    expect(result.outcome).toBe("under_review");
    expect(result.isApproved).toBe(false);
  });

  it("carries the engine's reasons forward as concerns rather than discarding them", async () => {
    decisionResult = ENGINE_OUTCOMES[2].decision;
    const result = await analyzeIntake(APP_ID);
    // Routing to review must not silently drop WHY — those reasons are what an
    // underwriter (and any later adverse-action notice) works from.
    expect(result.analysis.concerns.join(" ")).toMatch(/DTI above ceiling/);
  });

  it("an ABSENT engine decision routes to review and says so to the borrower", async () => {
    decisionResult = null;
    const result = await analyzeIntake(APP_ID);
    expect(result.outcome).toBe("under_review");
    expect(result.isApproved).toBe(false);
    expect(result.analysis.concerns.join(" ")).toMatch(/underwriter will review/i);
  });

  it("a THROWING engine propagates rather than degrading to a decision", async () => {
    // Corrected from a wrong first assumption: analyzeIntake does not catch a
    // throwing engine, and that is the right behavior — inventing an outcome
    // from a failed evaluation is exactly what must not happen. An absent
    // decision (null) is a knowable state and routes to review; a THROW is an
    // unknown state and must not be turned into any decision at all.
    decisionThrows = new Error("engine unavailable");
    await expect(analyzeIntake(APP_ID)).rejects.toThrow(/engine unavailable/);
  });

  it("finalizeIntake resets a failed run to 'submitted' — never denied, never stranded", async () => {
    decisionThrows = new Error("engine unavailable");
    await expect(finalizeIntake(APP_ID)).rejects.toThrow(/engine unavailable/);

    const statuses = updates.map((u) => u.status);
    // It marked the file analyzing, then put it back so the recovery sweep can
    // re-drive it. The ECOA property holds through the failure path too.
    expect(statuses).toContain("analyzing");
    expect(statuses[statuses.length - 1]).toBe("submitted");
    expect(statuses).not.toContain("denied");
  });
});

describe("ECOA: an approval must be a coherent approval (#7)", () => {
  it("does not describe a below-policy credit score as a strength", async () => {
    application = baseApplication({ creditScore: 620 });
    decisionResult = {
      decision: "REJECTED",
      status: "DECISION_READY",
      reasons: ["Representative credit score of 620 is below the conventional minimum of 640"],
      missingItems: [],
      qualifier: "PRELIMINARY",
      loanProgram: "CONVENTIONAL",
      resolvedPolicy: { conventionalFicoFloor: 640 },
      metrics: { dti: 30, ltv: 80 },
    };

    const result = await analyzeIntake(APP_ID);

    expect(result.analysis.strengths.join(" ")).not.toMatch(/Credit score/);
    expect(result.analysis.concerns.join(" ")).toMatch(/below the conventional minimum of 640/);
  });

  it("APPROVED with no usable income routes to review, not a $0 pre-approval", async () => {
    application = baseApplication({ annualIncome: "0" });
    decisionResult = {
      ...VERIFIED_APPROVAL,
      metrics: { ...VERIFIED_APPROVAL.metrics, monthlyIncome: 0 },
    };
    const result = await analyzeIntake(APP_ID);
    expect(result.outcome).toBe("under_review");
    expect(result.isApproved).toBe(false);
  });

  it("APPROVED with real income yields a positive pre-approval amount", async () => {
    decisionResult = ENGINE_OUTCOMES[0].decision;
    const result = await analyzeIntake(APP_ID);
    expect(result.outcome).toBe("pre_approved");
    expect(parseFloat(result.preApprovalAmount)).toBeGreaterThan(0);
  });

  it("a pre-approval is never issued below the price the engine just approved", async () => {
    application = baseApplication({ purchasePrice: "395000" });
    decisionResult = ENGINE_OUTCOMES[0].decision;
    const result = await analyzeIntake(APP_ID);
    expect(parseFloat(result.preApprovalAmount)).toBeGreaterThanOrEqual(395000);
  });

  it("does not size a VA approval with the conventional DTI formula", async () => {
    decisionResult = {
      ...(ENGINE_OUTCOMES[0].decision as Record<string, unknown>),
      loanProgram: "VA",
      resolvedPolicy: { loanType: "VA" },
    };

    const result = await analyzeIntake(APP_ID);

    expect(result.outcome).toBe("pre_approved");
    expect(result.preApprovalAmount).toBe("400000");
    expect(result.analysis.recommendations.join(" ")).toMatch(/higher VA.*program-specific review/i);
  });

  it("does not manufacture a pre-approval amount when the decision omitted its captured DTI cap", async () => {
    decisionResult = {
      ...VERIFIED_APPROVAL,
      resolvedPolicy: { loanType: "CONVENTIONAL" },
    };

    await expect(analyzeIntake(APP_ID)).rejects.toThrow(/CONVENTIONAL_DTI_CAP.*30%-60%/i);
  });

  it.each([0, 29.99, 60.01, Number.NaN])(
    "fails closed when the configured DTI cap is invalid (%s)",
    async (invalidCap) => {
      decisionResult = {
        ...VERIFIED_APPROVAL,
        resolvedPolicy: {
          ...(VERIFIED_APPROVAL.resolvedPolicy),
          conventionalDtiCapPct: invalidCap,
        },
      };

      await expect(analyzeIntake(APP_ID)).rejects.toThrow(/CONVENTIONAL_DTI_CAP.*30%-60%/i);
    },
  );
});

describe("finalizeIntake guards (F-015: this function had no executing test)", () => {
  it("leaves an application that has already progressed alone", async () => {
    application = baseApplication({ status: "underwriting" });
    await finalizeIntake(APP_ID);
    expect(updates).toEqual([]);
  });

  it("marks the file 'analyzing' before it decides, so the state is never a lie", async () => {
    decisionResult = ENGINE_OUTCOMES[0].decision;
    await finalizeIntake(APP_ID);
    expect(updates[0]?.status).toBe("analyzing");
  });

  it("does not publish a settled status until the borrower checklist exists", async () => {
    decisionResult = ENGINE_OUTCOMES[0].decision;
    await finalizeIntake(APP_ID);

    const settledIndex = lifecycleEvents.indexOf("status:pre_approved");
    const lastTaskIndex = lifecycleEvents.reduce(
      (latest, event, index) => event.startsWith("task:") ? index : latest,
      -1,
    );
    expect(lastTaskIndex).toBeGreaterThan(-1);
    expect(settledIndex).toBeGreaterThan(lastTaskIndex);
  });

  it("never turns a preliminary candidate into pre-approval status, options, or issued messaging", async () => {
    decisionResult = PRELIMINARY_APPROVAL;
    await finalizeIntake(APP_ID);

    expect(updates.some((patch) => patch.status === "pre_approved")).toBe(false);
    expect(updates.some((patch) => patch.status === "under_review")).toBe(true);
    expect(lifecycleEvents).not.toContain("loan_option");
    expect(lifecycleEvents.some((event) => /Pre-Approval Issued/.test(event))).toBe(false);
    expect(lifecycleEvents).toContain("activity:Preliminary Mortgage Plan Ready");
    expect(lifecycleEvents).toContain("notification:Your preliminary mortgage plan is ready");
  });
});

describe("URLA preliminary-analysis refresh", () => {
  it("promotes an under-review file and persists the same current metrics", async () => {
    application = baseApplication({ status: "under_review" });
    decisionResult = ENGINE_OUTCOMES[0].decision;

    const result = await refreshEarlyStageIntakeAnalysis(APP_ID, "urla_updated");

    expect(result?.outcome).toBe("pre_approved");
    expect(updates).toContainEqual(expect.objectContaining({
      status: "pre_approved",
      dtiRatio: "30.00",
      ltvRatio: "80.00",
    }));
  });

  it("removes stale approval state and amount when new facts require review", async () => {
    application = baseApplication({ status: "pre_approved", preApprovalAmount: "500000" });
    decisionResult = ENGINE_OUTCOMES[3].decision;

    const result = await refreshEarlyStageIntakeAnalysis(APP_ID, "urla_updated");

    expect(result?.outcome).toBe("under_review");
    expect(updates.some((patch) => patch.status === "under_review")).toBe(true);
    expect(updates.some((patch) => patch.preApprovalAmount === "0")).toBe(true);
    expect(lifecycleEvents).toContain("activity:Pre-Approval Needs Review");
    expect(lifecycleEvents).toContain("notification:Your mortgage plan needs review");
  });
});
