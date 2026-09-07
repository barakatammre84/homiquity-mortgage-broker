import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AttentionRail } from "./AttentionRail";
import type { PipelineSummary, StaffSignal } from "./types";

function file(index: number): PipelineSummary {
  return {
    applicationId: `app-${index}`,
    borrowerName: index === 24 ? "Casey Complex" : `Borrower ${index}`,
    currentStage: "application_received",
    daysInPipeline: 30 - index,
    conditionsOutstanding: 2,
    conditionsTotal: 4,
    nextAction: "Review file",
    priority: "normal",
    daysIdle: 30 - index,
    fileHealth: { light: "yellow", reasons: [] },
  };
}

function signal(index: number): StaffSignal {
  return {
    type: "stalled",
    priority: 1,
    applicationId: `app-${index}`,
    borrowerName: `Borrower ${index}`,
    title: `Signal ${index}`,
    detail: "Needs review",
  };
}

describe("AttentionRail", () => {
  it("bounds large queues and searches the full book", async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <AttentionRail
          queue={Array.from({ length: 25 }, (_, index) => file(index))}
          signals={Array.from({ length: 12 }, (_, index) => signal(index))}
          selectedId={null}
          onSelect={vi.fn()}
          loading={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getAllByTestId(/^pipeline-file-/)).toHaveLength(20);
    expect(screen.getAllByTestId(/^signal-/)).toHaveLength(8);
    expect(screen.getByTestId("text-pipeline-limited").textContent).toMatch(/20 most urgent/i);

    await user.type(screen.getByLabelText("Find a pipeline borrower"), "casey");
    expect(screen.getByText("Casey Complex")).toBeTruthy();
    expect(screen.getAllByTestId(/^pipeline-file-/)).toHaveLength(1);
  });

  it("keeps the selected file visible when it falls below the default cutoff", () => {
    render(
      <TooltipProvider>
        <AttentionRail
          queue={Array.from({ length: 25 }, (_, index) => file(index))}
          signals={[]}
          selectedId="app-24"
          onSelect={vi.fn()}
          loading={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByTestId("pipeline-file-app-24").getAttribute("aria-current")).toBe("true");
  });
});
