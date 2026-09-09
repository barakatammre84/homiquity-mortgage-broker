import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import IntelligenceTab from "./IntelligenceTab";

function renderTab() {
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
    turns: 0,
    groundedTurns: 0,
    repeatedQuestions: 0,
    repeatedQuestionRate: 0,
    completionImprovedTurns: 0,
    completionImprovementRate: 0,
    humanHelpRequests: 0,
    openHumanHelpRequests: 0,
    averageTurnResponseMs: null,
    averageHumanHelpResolutionMinutes: null,
    degradedTurns: 0,
    lintReplacedTurns: 0,
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
});
