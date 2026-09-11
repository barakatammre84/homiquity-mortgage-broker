import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import IntelligenceTab from "./IntelligenceTab";

function renderTab(homiOverrides: Record<string, unknown> = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: async () => {
          throw new Error("Unexpected network query in IntelligenceTab test");
        },
      },
    },
  });
  client.setQueryData(["/api/outcomes/funnel"], []);
  client.setQueryData(["/api/analytics/automation-metrics"], {
    totalEvents: 0,
    automatedEvents: 0,
    automationRate: 0,
    topAutomations: [],
    byDomain: {},
  });
  client.setQueryData(["/api/documents/confidence/accuracy"], [{
    documentType: "tax_return",
    avgConfidence: 0.9,
    totalExtractions: 2,
    reviewedCount: 2,
    gradedReviewCount: 0,
    needsReviewCount: 0,
    avgAccuracy: null,
  }]);
  client.setQueryData(["/api/outcomes/segments/creditScoreBucket"], []);
  client.setQueryData(["/api/analytics/core-capabilities"], {
    generatedAt: "2026-09-08T12:00:00.000Z",
    environment: "production",
    readyForLiveLoanLifecycle: false,
    counts: { live: 2, simulated: 4, disabled: 5, configuration_error: 0 },
    documentExtractionQueue: {
      pending: 1,
      processing: 1,
      completed: 8,
      failed: 0,
      cancelled: 0,
      retryScheduled: 1,
      staleLeases: 0,
      oldestPendingAt: "2026-09-08T11:59:00.000Z",
      lastCompletedAt: "2026-09-08T12:00:00.000Z",
    },
    capabilities: [{
      id: "credit",
      label: "Mortgage credit report",
      provider: "No contracted bureau adapter",
      state: "disabled",
      criticalForLiveLoan: true,
      verificationRequired: true,
      verificationState: "not_recorded",
      lastVerificationAttemptAt: null,
      lastSuccessfulVerificationAt: null,
      detail: "Production refuses fabricated bureau scores.",
      nextAction: "Contract a credit vendor.",
    }],
  });
  client.setQueryData(["/api/analytics/homi-outcomes"], {
    daysBack: 30,
    turnAttempts: 0,
    turns: 0,
    failedTurns: 0,
    excludedNonBorrowerTurnAttempts: 0,
    turnSuccessRate: 0,
    uniqueBorrowers: 0,
    measuredUniqueBorrowers: 0,
    serverTruthTurns: 0,
    serverActionTurns: 0,
    exactRepeatedQuestions: 0,
    exactRepeatedQuestionRate: 0,
    completionMeasuredTurns: 0,
    completionMeasurementCoverageRate: 0,
    captureAttemptTurns: 0,
    captureSucceededTurns: 0,
    capturedFields: 0,
    completionMeasuredCaptureTurns: 0,
    completionImprovedTurns: 0,
    completionImprovementRate: 0,
    completionRegressedTurns: 0,
    humanHelpRequests: 0,
    openHumanHelpRequests: 0,
    recordedStaffResponses: 0,
    recordedStaffResponseRate: 0,
    averageRecordedStaffResponseMinutes: null,
    medianRecordedStaffResponseMinutes: null,
    completedWithoutRecordedStaffResponse: 0,
    pastDueWithoutRecordedStaffResponse: 0,
    averageTurnResponseMs: null,
    p95TurnResponseMs: null,
    invalidTurnLatencyRows: 0,
    degradedTurns: 0,
    lintReplacedTurns: 0,
    legacyTurns: 0,
    measurement: {
      status: "collecting",
      canClaimReducedFriction: false,
      minimumMeasuredTurns: 30,
      minimumUniqueBorrowers: 10,
      comparisonStudy: {
        status: "not_registered",
        registrationId: null,
        assignmentUnit: null,
        comparisonCohort: null,
      },
      blockers: ["Register the comparison study before enrollment; the 30-turn/10-borrower floor proves measurement coverage, not causation."],
    },
    ...homiOverrides,
  });

  render(
    <QueryClientProvider client={client}>
      <IntelligenceTab />
    </QueryClientProvider>,
  );
}

describe("IntelligenceTab", () => {
  it("distinguishes document approvals from measured field accuracy", async () => {
    renderTab();
    await userEvent.click(screen.getByTestId("tab-documents"));

    expect(screen.getByText("2 documents reviewed")).toBeTruthy();
    expect(screen.getByText("No field-level accuracy measured yet")).toBeTruthy();
    expect(document.body.textContent).not.toContain("NaN");
  });

  it("shows provider truth without implying an unverified live lifecycle", async () => {
    renderTab();
    await userEvent.click(screen.getByTestId("tab-core-systems"));

    expect(screen.getByText("External connections incomplete")).toBeTruthy();
    expect(screen.getByText("Mortgage credit report")).toBeTruthy();
    expect(screen.getByText("Last successful verification: not recorded")).toBeTruthy();
    expect(screen.getByTestId("document-extraction-queue")).toBeTruthy();
    expect(screen.getByText("Retry scheduled")).toBeTruthy();
  });

  it("shows the Homi evidence boundary and labels exact repeats and recorded replies", async () => {
    renderTab({
      turns: 8,
      turnAttempts: 10,
      failedTurns: 2,
      turnSuccessRate: 80,
      uniqueBorrowers: 3,
      measuredUniqueBorrowers: 3,
      serverTruthTurns: 5,
      serverActionTurns: 2,
      exactRepeatedQuestions: 1,
      exactRepeatedQuestionRate: 12.5,
      completionMeasuredTurns: 8,
      completionMeasurementCoverageRate: 100,
      captureAttemptTurns: 2,
      captureSucceededTurns: 2,
      capturedFields: 3,
      completionMeasuredCaptureTurns: 2,
      completionImprovedTurns: 1,
      completionImprovementRate: 50,
      humanHelpRequests: 2,
      openHumanHelpRequests: 1,
      recordedStaffResponses: 1,
      recordedStaffResponseRate: 50,
      averageRecordedStaffResponseMinutes: 18,
      medianRecordedStaffResponseMinutes: 18,
      averageTurnResponseMs: 4_000,
      p95TurnResponseMs: 7_000,
    });
    await userEvent.click(screen.getByTestId("tab-homi-outcomes"));

    expect(screen.getByTestId("homi-measurement-status").textContent).toContain("Collecting evidence");
    expect(screen.getByTestId("homi-claim-boundary").textContent).toContain("cannot prove");
    expect(screen.getByTestId("homi-study-status").textContent).toContain("not registered");
    expect(screen.getByText("Exact repeated wording")).toBeTruthy();
    expect(screen.getByText("Post-request staff messages")).toBeTruthy();
    expect(screen.getByText(/Median first staff message: 18 minutes/)).toBeTruthy();
    expect(screen.getByText(/Each message counts toward one request only/)).toBeTruthy();
  });
});
