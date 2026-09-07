import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { IntakeInboxCard } from "./IntakeInboxCard";
import type { PipelineSummary } from "./types";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest: request };
});

function file(index: number): PipelineSummary {
  return {
    applicationId: `app-${index}`,
    borrowerName: index === 10 ? "Casey Complex" : `Borrower ${index}`,
    currentStage: "application_received",
    daysInPipeline: 20 - index,
    conditionsOutstanding: 2,
    conditionsTotal: 4,
    nextAction: "Review file",
    priority: "normal",
    daysIdle: null,
    fileHealth: { light: "yellow", reasons: [] },
  };
}

function renderCard(onClaim = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(["/api/pipeline/unassigned"], { total: 12, queue: Array.from({ length: 12 }, (_, i) => file(i)) });
  render(
    <QueryClientProvider client={client}>
      <IntakeInboxCard onClaim={onClaim} />
    </QueryClientProvider>,
  );
  return { client, onClaim };
}

describe("IntakeInboxCard", () => {
  it("bounds a large intake queue and lets the officer find a specific borrower", async () => {
    const user = userEvent.setup();
    renderCard();
    expect(screen.getAllByRole("button", { name: "Claim" })).toHaveLength(8);
    expect(screen.getByTestId("text-intake-limited").textContent).toMatch(/8 most urgent/i);

    await user.type(screen.getByLabelText("Find an unassigned borrower"), "casey");
    expect(screen.getByText("Casey Complex")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Claim" })).toHaveLength(1);
  });

  it("opens the file immediately after a successful claim", async () => {
    const user = userEvent.setup();
    const onClaim = vi.fn();
    request.mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    renderCard(onClaim);

    await user.click(screen.getAllByRole("button", { name: "Claim" })[0]);
    expect(onClaim).toHaveBeenCalledWith("app-0");
  });
});
