import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { FunnelProgressHeader } from "./FunnelChrome";
import {
  computeRoute,
  routeProgress,
  PRE_APPROVAL_DEFAULTS,
  type FunnelStepId,
} from "@/funnel/preApprovalMachine";
import type { PreApprovalFormData } from "@shared/schema";

// The funnel's orientation chrome. What a borrower must be able to read off the
// top of the page at any moment: which named chapter they are inside and
// roughly how long is left. Route length is adaptive, so no number, denominator,
// or percentage is shown that could repeat or move backward after an answer
// injects or removes a conditional question.

function answers(overrides: Partial<PreApprovalFormData> = {}): PreApprovalFormData {
  return { ...PRE_APPROVAL_DEFAULTS, ...overrides };
}

function renderAt(stepId: FunnelStepId, overrides: Partial<PreApprovalFormData> = {}, onBack = vi.fn()) {
  const route = computeRoute(answers(overrides));
  const progress = routeProgress(route, stepId);
  render(
    <FunnelProgressHeader
      progress={progress}
      onBack={onBack}
      canGoBack={progress.index > 0}
      showSaved={progress.index > 0}
    />,
  );
  return { progress, onBack };
}

describe("FunnelProgressHeader", () => {
  it("uses a stable application label instead of a changing route number", () => {
    renderAt("annualIncome");
    expect(screen.getByTestId("text-step-counter").textContent).toBe("Application");
    expect(screen.queryByTestId("text-progress-percent")).toBeNull();
  });

  it("names all four chapters and marks the one the borrower is in", () => {
    renderAt("purchasePrice");
    const rail = screen.getByTestId("progress-section-rail");
    for (const label of ["Your goal", "The home", "Your finances", "Finish"]) {
      expect(within(rail).getByText(label)).toBeTruthy();
    }
    // Chapter 1 is behind them, so it carries a completion check; the chapter
    // they are inside does not.
    expect(screen.getByTestId("icon-section-done-goal")).toBeTruthy();
    expect(screen.queryByTestId("icon-section-done-property")).toBeNull();
    // The chapter is named once, in the rail; row 3 gives the position inside it.
    expect(screen.getByTestId("text-section-position").textContent).toBe("The home");
  });

  it("reports position within the current chapter", () => {
    renderAt("propertyState");
    // Chapter 2 on the base route is purchasePrice → downPayment → propertyState.
    expect(screen.getByTestId("text-section-position").textContent).toBe("The home");
  });

  it("counts the VA residual-income steps into the chapter a veteran is in", () => {
    renderAt("propertyState", { isVeteran: true });
    expect(screen.getByTestId("text-section-position").textContent).toBe("The home");
  });

  it("derives the time estimate from the steps actually left", () => {
    renderAt("loanPurpose");
    expect(screen.getByTestId("text-time-remaining").textContent).toBe("~3 min left");
  });

  it("says the last step is the last step", () => {
    renderAt("final");
    expect(screen.getByTestId("text-time-remaining").textContent).toBe("Last step");
    expect(screen.queryByTestId("text-progress-percent")).toBeNull();
  });

  it("exposes the current named section to assistive tech", () => {
    renderAt("employmentType");
    const rail = screen.getByRole("list", { name: /application progress/i });
    expect(rail.getAttribute("aria-label")).toContain("Your finances");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("goes back on request", () => {
    const onBack = vi.fn();
    renderAt("loanPurpose", {}, onBack);
    fireEvent.click(screen.getByTestId("button-back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("hides the back affordance and the autosave chip on the intro", () => {
    renderAt("intro");
    expect((screen.getByTestId("button-back") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("text-autosave-indicator")).toBeNull();
  });
});
