import { describe, expect, it } from "vitest";
import {
  buildHomiOutcomeMetrics,
  buildHomiTurnFailurePayload,
  buildHomiTurnOutcomePayload,
  type HomiHandoffMetricRow,
  type HomiStaffMessageMetricRow,
  type HomiTurnMetricRow,
} from "../server/services/homiOutcomeEvaluation";

function currentTurn(overrides: Partial<HomiTurnMetricRow> = {}): HomiTurnMetricRow {
  return {
    userId: "borrower-1",
    userRole: "active_buyer",
    responseMs: 4_000,
    payload: buildHomiTurnOutcomePayload({
      repeatedQuestion: false,
      completionBefore: 20,
      completionAfter: 30,
      degraded: false,
      lintReplaced: false,
      modelCalls: 2,
      toolCalls: ["record_intake", "get_loan_status", "set_action_plan"],
      captureOutcome: {
        attempts: 1,
        createdApplication: false,
        appliedFields: ["annualIncome"],
        skippedFields: 0,
      },
    }),
    ...overrides,
  };
}

function handoff(overrides: Partial<HomiHandoffMetricRow> = {}): HomiHandoffMetricRow {
  return {
    id: "task-1",
    applicationId: "app-1",
    borrowerUserId: "borrower-1",
    status: "OPEN",
    createdAt: new Date("2026-09-10T12:00:00.000Z"),
    completedAt: null,
    slaDueAt: new Date("2026-09-10T16:00:00.000Z"),
    autoResolved: false,
    ...overrides,
  };
}

function staffMessage(overrides: Partial<HomiStaffMessageMetricRow> = {}): HomiStaffMessageMetricRow {
  return {
    applicationId: "app-1",
    recipientId: "borrower-1",
    createdAt: new Date("2026-09-10T12:30:00.000Z"),
    ...overrides,
  };
}

describe("buildHomiTurnOutcomePayload", () => {
  it("separates server truth and server actions from assistant-only tools", () => {
    const payload = buildHomiTurnOutcomePayload({
      repeatedQuestion: true,
      completionBefore: 42,
      completionAfter: 57,
      degraded: false,
      lintReplaced: false,
      modelCalls: 2.9,
      toolCalls: [
        "set_action_plan",
        "get_document_checklist",
        "get_document_checklist",
        "record_intake",
        "request_human_help",
      ],
      captureOutcome: {
        attempts: 1,
        createdApplication: true,
        appliedFields: ["annualIncome", "employmentType"],
        skippedFields: 1,
      },
      humanHelpRequest: { taskId: "task-1", alreadyOpen: false },
    });

    expect(payload).toMatchObject({
      schemaVersion: 2,
      completionBasis: "server_file_snapshot",
      repeatDetection: "normalized_exact_match",
      completionDelta: 15,
      modelCalls: 2,
      captureAttempted: true,
      capturedFieldCount: 2,
      captureCreatedApplication: true,
      captureSkippedFieldCount: 1,
      humanHandoff: true,
      humanHandoffCreated: true,
    });
    expect(payload.toolCalls).toEqual([
      "set_action_plan",
      "get_document_checklist",
      "record_intake",
      "request_human_help",
    ]);
    expect(payload.serverTruthToolCalls).toEqual(["get_document_checklist"]);
    expect(payload.serverActionToolCalls).toEqual(["record_intake", "request_human_help"]);
  });

  it("refuses invalid completion values instead of manufacturing a delta", () => {
    const payload = buildHomiTurnOutcomePayload({
      repeatedQuestion: false,
      completionBefore: -1,
      completionAfter: 101,
      degraded: false,
      lintReplaced: false,
      modelCalls: 1,
      toolCalls: [],
    });

    expect(payload.completionBefore).toBeNull();
    expect(payload.completionAfter).toBeNull();
    expect(payload.completionDelta).toBeNull();
  });

  it("stores only a bounded failure class, never an error message", () => {
    expect(buildHomiTurnFailurePayload({
      code: "provider_rate_limited",
      streamOpened: true,
    })).toEqual({
      schemaVersion: 2,
      failureCode: "provider_rate_limited",
      streamOpened: true,
    });
    expect(buildHomiTurnFailurePayload({
      code: "database exploded with borrower@example.test",
      streamOpened: false,
    })).toEqual({
      schemaVersion: 2,
      failureCode: "internal",
      streamOpened: false,
    });
  });
});

describe("buildHomiOutcomeMetrics", () => {
  it("does not accept legacy assistant-era completion deltas as server-measured progress", () => {
    const metrics = buildHomiOutcomeMetrics({
      daysBack: 30,
      turns: [{
        userId: "borrower-legacy",
        userRole: "active_buyer",
        responseMs: 5_000,
        payload: {
          completionDelta: 90,
          repeatedQuestion: true,
          toolCalls: ["set_action_plan", "get_loan_status"],
        },
      }],
      failedTurns: [{
        userId: "borrower-failed",
        userRole: "active_buyer",
        responseMs: 2_000,
        payload: buildHomiTurnFailurePayload({ code: "timeout", streamOpened: true }),
      }],
      handoffs: [],
      staffMessages: [],
      now: new Date("2026-09-10T20:00:00.000Z"),
    });

    expect(metrics.legacyTurns).toBe(1);
    expect(metrics.turnAttempts).toBe(2);
    expect(metrics.failedTurns).toBe(1);
    expect(metrics.turnSuccessRate).toBe(50);
    expect(metrics.uniqueBorrowers).toBe(2);
    expect(metrics.measuredUniqueBorrowers).toBe(0);
    expect(metrics.completionMeasuredTurns).toBe(0);
    expect(metrics.completionImprovedTurns).toBe(0);
    expect(metrics.serverTruthTurns).toBe(1);
    expect(metrics.serverActionTurns).toBe(0);
    expect(metrics.exactRepeatedQuestionRate).toBe(0);
    expect(metrics.measurement.status).toBe("collecting");
    expect(metrics.measurement.canClaimReducedFriction).toBe(false);
  });

  it("measures progress only across successful captures with two server snapshots", () => {
    const unmeasuredCapture = currentTurn({
      userId: "borrower-2",
      payload: buildHomiTurnOutcomePayload({
        repeatedQuestion: false,
        completionBefore: null,
        completionAfter: 40,
        degraded: false,
        lintReplaced: false,
        modelCalls: 1,
        toolCalls: ["record_intake"],
        captureOutcome: {
          attempts: 1,
          createdApplication: true,
          appliedFields: ["purchasePrice"],
          skippedFields: 0,
        },
      }),
    });
    const noProgressCapture = currentTurn({
      userId: "borrower-3",
      payload: buildHomiTurnOutcomePayload({
        repeatedQuestion: false,
        completionBefore: 40,
        completionAfter: 40,
        degraded: false,
        lintReplaced: false,
        modelCalls: 1,
        toolCalls: ["record_intake"],
        captureOutcome: {
          attempts: 1,
          createdApplication: false,
          appliedFields: ["purchasePrice"],
          skippedFields: 0,
        },
      }),
    });

    const metrics = buildHomiOutcomeMetrics({
      daysBack: 30,
      turns: [currentTurn(), unmeasuredCapture, noProgressCapture],
      handoffs: [],
      staffMessages: [],
    });

    expect(metrics.captureSucceededTurns).toBe(3);
    expect(metrics.completionMeasuredCaptureTurns).toBe(2);
    expect(metrics.completionImprovedTurns).toBe(1);
    expect(metrics.completionImprovementRate).toBe(50);
    expect(metrics.capturedFields).toBe(3);
  });

  it("links a Homi request only to a later staff message for the same file and borrower", () => {
    const tasks = [
      handoff(),
      handoff({
        id: "task-completed",
        applicationId: "app-2",
        borrowerUserId: "borrower-2",
        status: "COMPLETED",
        completedAt: new Date("2026-09-10T13:00:00.000Z"),
      }),
      handoff({
        id: "task-overdue",
        applicationId: "app-3",
        borrowerUserId: "borrower-3",
        slaDueAt: new Date("2026-09-10T13:00:00.000Z"),
      }),
    ];
    const messages = [
      staffMessage(),
      staffMessage({ createdAt: new Date("2026-09-10T11:59:00.000Z") }),
      staffMessage({ applicationId: "app-2", recipientId: "someone-else" }),
      staffMessage({ applicationId: "wrong-app", recipientId: "borrower-2" }),
    ];

    const metrics = buildHomiOutcomeMetrics({
      daysBack: 30,
      turns: [],
      handoffs: tasks,
      staffMessages: messages,
      now: new Date("2026-09-10T20:00:00.000Z"),
    });

    expect(metrics.humanHelpRequests).toBe(3);
    expect(metrics.recordedStaffResponses).toBe(1);
    expect(metrics.recordedStaffResponseRate).toBe(33.33);
    expect(metrics.averageRecordedStaffResponseMinutes).toBe(30);
    expect(metrics.medianRecordedStaffResponseMinutes).toBe(30);
    expect(metrics.completedWithoutRecordedStaffResponse).toBe(1);
    expect(metrics.pastDueWithoutRecordedStaffResponse).toBe(1);
  });

  it("never counts one later staff message as the response to several handoffs", () => {
    const tasks = [
      handoff({
        id: "task-completed-without-message",
        status: "COMPLETED",
        completedAt: new Date("2026-09-10T12:10:00.000Z"),
      }),
      handoff({
        id: "task-second",
        createdAt: new Date("2026-09-10T12:20:00.000Z"),
      }),
      handoff({
        id: "task-overlapping-history",
        createdAt: new Date("2026-09-10T12:25:00.000Z"),
      }),
    ];

    const metrics = buildHomiOutcomeMetrics({
      daysBack: 30,
      turns: [],
      handoffs: tasks,
      staffMessages: [staffMessage({ createdAt: new Date("2026-09-10T12:30:00.000Z") })],
      now: new Date("2026-09-10T20:00:00.000Z"),
    });

    expect(metrics.recordedStaffResponses).toBe(1);
    expect(metrics.recordedStaffResponseRate).toBe(33.33);
    expect(metrics.completedWithoutRecordedStaffResponse).toBe(1);
  });

  it("requires distinct borrowers with current server-measured turns for the sample floor", () => {
    const turns = Array.from({ length: 30 }, () => currentTurn({ userId: "borrower-measured" }));
    const failedTurns = Array.from({ length: 9 }, (_, index) => ({
      userId: `borrower-failed-${index}`,
      userRole: "active_buyer",
      responseMs: 1_000,
      payload: buildHomiTurnFailurePayload({ code: "timeout", streamOpened: true }),
    }));

    const metrics = buildHomiOutcomeMetrics({
      daysBack: 30,
      turns,
      failedTurns,
      handoffs: [],
      staffMessages: [],
    });

    expect(metrics.uniqueBorrowers).toBe(10);
    expect(metrics.measuredUniqueBorrowers).toBe(1);
    expect(metrics.measurement.status).toBe("collecting");
    expect(metrics.measurement.blockers).toContain(
      "Collect server-measured outcomes from 9 more distinct borrowers.",
    );
  });

  it("does not mix legacy repeat flags into the current exact-repeat rate", () => {
    const metrics = buildHomiOutcomeMetrics({
      daysBack: 30,
      turns: [
        currentTurn(),
        {
          userId: "borrower-legacy",
          userRole: "active_buyer",
          responseMs: 1_000,
          payload: { repeatedQuestion: true },
        },
      ],
      handoffs: [],
      staffMessages: [],
    });

    expect(metrics.exactRepeatedQuestions).toBe(0);
    expect(metrics.exactRepeatedQuestionRate).toBe(0);
    expect(metrics.legacyTurns).toBe(1);
  });

  it("excludes staff and unknown-role turns from borrower evidence", () => {
    const metrics = buildHomiOutcomeMetrics({
      daysBack: 30,
      turns: [
        currentTurn({ userId: "borrower" }),
        currentTurn({ userId: "staff", userRole: "admin" }),
        currentTurn({ userId: "legacy-without-role", userRole: null }),
      ],
      failedTurns: [{
        userId: "loan-officer",
        userRole: "lo",
        responseMs: 500,
        payload: buildHomiTurnFailurePayload({ code: "timeout", streamOpened: true }),
      }],
      handoffs: [],
      staffMessages: [],
    });

    expect(metrics.turnAttempts).toBe(1);
    expect(metrics.turns).toBe(1);
    expect(metrics.uniqueBorrowers).toBe(1);
    expect(metrics.measuredUniqueBorrowers).toBe(1);
    expect(metrics.excludedNonBorrowerTurnAttempts).toBe(3);
  });

  it("shows observational evidence at the sample floor but still refuses a causal claim", () => {
    const turns = Array.from({ length: 30 }, (_, index) => currentTurn({
      userId: `borrower-${index % 10}`,
      responseMs: index === 29 ? 120_001 : (index + 1) * 1_000,
    }));

    const metrics = buildHomiOutcomeMetrics({
      daysBack: 30,
      turns,
      handoffs: [],
      staffMessages: [],
    });

    expect(metrics.measurement.status).toBe("observational_only");
    expect(metrics.measurement.canClaimReducedFriction).toBe(false);
    expect(metrics.measurement.blockers).toContain(
      "Register the comparison study before enrollment; the 30-turn/10-borrower floor proves measurement coverage, not causation.",
    );
    expect(metrics.measurement.comparisonStudy.status).toBe("not_registered");
    expect(metrics.measuredUniqueBorrowers).toBe(10);
    expect(metrics.invalidTurnLatencyRows).toBe(1);
    expect(metrics.p95TurnResponseMs).toBe(28_000);
    expect(metrics.averageTurnResponseMs).toBe(15_000);
  });
});
