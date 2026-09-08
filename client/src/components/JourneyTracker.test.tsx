import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { JourneyTracker } from "./JourneyTracker";

// Borrower Clarity PR 6: the vertical tracker can render per-step detail
// lines derived from data the borrower already sees (milestone dates,
// doc/condition counters, the closing-prep transparency line). Details are
// optional — a tracker without them renders exactly as before.

describe("JourneyTracker — detail lines (vertical)", () => {
  const details = {
    submitted: ["Received Aug 1"],
    underwriting: ["Started Aug 5", "Conditions cleared: 1 of 4"],
  };

  it("renders detail lines under their steps", () => {
    render(<JourneyTracker status="underwriting" variant="vertical" details={details} />);
    expect(screen.getByTestId("journey-detail-submitted").textContent).toContain("Received Aug 1");
    const uw = screen.getByTestId("journey-detail-underwriting");
    expect(uw.textContent).toContain("Started Aug 5");
    expect(uw.textContent).toContain("Conditions cleared: 1 of 4");
  });

  it("renders no detail node for steps without lines", () => {
    render(<JourneyTracker status="underwriting" variant="vertical" details={details} />);
    expect(screen.queryByTestId("journey-detail-funded")).toBeNull();
  });

  it("renders unchanged without the details prop", () => {
    render(<JourneyTracker status="underwriting" variant="vertical" />);
    expect(screen.getByTestId("journey-step-underwriting")).toBeTruthy();
    expect(screen.queryByTestId("journey-detail-underwriting")).toBeNull();
  });

  it("shows an under-review intake as the current received application", () => {
    render(<JourneyTracker status="under_review" variant="vertical" />);
    expect(screen.getByTestId("journey-tag-submitted").textContent).toBe("Current");
    expect(screen.getByTestId("journey-tag-pre_approved").textContent).toBe("Upcoming");
  });

  it("does not tell an under-review borrower that a future milestone is complete", () => {
    render(<JourneyTracker status="under_review" variant="vertical" />);
    expect(screen.getByTestId("journey-step-pre_approved").textContent).not.toContain(
      "You're pre-approved",
    );
    expect(screen.getByTestId("journey-step-clear_to_close").textContent).not.toContain(
      "Approved",
    );
  });

  it("labels a self-reported pre-approval stage as an initial review", () => {
    render(<JourneyTracker status="pre_approved" approvalVerified={false} variant="vertical" />);
    expect(screen.getByTestId("journey-label-pre_approved").textContent).toBe("Initial Review");
    expect(screen.getByTestId("journey-step-pre_approved").textContent).toContain("verifies the file");
    expect(screen.getByTestId("journey-step-pre_approved").textContent).not.toContain("Pre-Approved");
  });
});
