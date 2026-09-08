import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RestoreDraftBanner, AuthGateOverlay, AffordabilityTeaserOverlay, FunnelFooter, FunnelProgressHeader } from "./FunnelChrome";
import type { AffordabilityEstimateResults } from "@/lib/affordabilityEstimate";
import { companyNmlsDisplay } from "@shared/companyIdentity";

const SAMPLE_ESTIMATE: AffordabilityEstimateResults = {
  maxHomePrice: 480000,
  maxMonthlyPayment: 2800,
  frontEndDTI: 27,
  backEndDTI: 35,
  comfortablePrice: 408000,
  stretchPrice: 528000,
  requiredDownPayment: 24000,
  monthlyPITI: 2750,
  monthlyPI: 2400,
  monthlyTax: 250,
  monthlyInsurance: 100,
  monthlyPMI: 0,
  withinGuidelines: true,
};

describe("FunnelFooter", () => {
  it("pins the regulatory copy: soft inquiry, no commitment, broker disclosure, Equal Housing", () => {
    render(<FunnelFooter />);
    const text = screen.getByTestId("footer-compliance").textContent ?? "";
    expect(text).toContain("soft credit inquiry");
    expect(text).toContain("will not affect your credit score");
    expect(text).toContain("Pre-approval is not a commitment to lend");
    expect(text).toContain("does not make credit decisions or fund loans");
    expect(text).toContain("Equal Housing Opportunity");
  });

  it("displays the company NMLS identifier inline, not just a Consumer Access link", () => {
    // The borrower submitting income/debt/consent data on this page must see
    // the license credential without leaving the flow. The expectation is
    // computed from the same helper the footer renders (single source, no
    // hardcoded id here) — and it must be non-null first, so this test fails
    // loudly if the id ever reverts to PENDING instead of vacuously passing
    // on an empty string.
    const display = companyNmlsDisplay();
    expect(display).not.toBeNull();
    render(<FunnelFooter />);
    const text = screen.getByTestId("footer-compliance").textContent ?? "";
    expect(text).toContain(display!);
  });
});

describe("AuthGateOverlay", () => {
  it("offers signup and sign-in, and can be dismissed back to the form", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<AuthGateOverlay onDismiss={onDismiss} />);
    expect(screen.getByTestId("button-auth-gate-signup").closest("a")?.getAttribute("href")).toBe("/signup");
    expect(screen.getByTestId("button-auth-gate-login").closest("a")?.getAttribute("href")).toBe("/login");
    expect(screen.getByTestId("auth-gate-overlay").textContent).toContain("personalized result and next steps");
    expect(screen.getByTestId("auth-gate-overlay").textContent).not.toContain("pre-approval results");
    await user.click(screen.getByTestId("button-auth-gate-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("AffordabilityTeaserOverlay", () => {
  it("shows the estimated range and lets the borrower continue to the auth gate", async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    const onDismiss = vi.fn();
    render(
      <AffordabilityTeaserOverlay
        estimate={SAMPLE_ESTIMATE}
        targetPrice={450000}
        onContinue={onContinue}
        onDismiss={onDismiss}
      />,
    );
    const rangeText = screen.getByTestId("text-teaser-range").textContent ?? "";
    expect(rangeText).toContain("$408,000");
    expect(rangeText).toContain("$480,000");
    expect(screen.getByTestId("text-teaser-target-comparison").textContent).toContain("within this range");
    expect(screen.getByTestId("button-teaser-continue").textContent).toContain("Continue to my application");
    await user.click(screen.getByTestId("button-teaser-continue"));
    expect(onContinue).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("button-teaser-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("flags a target price above the estimated max as a stretch rather than claiming it's in range", () => {
    render(
      <AffordabilityTeaserOverlay
        estimate={SAMPLE_ESTIMATE}
        targetPrice={600000}
        onContinue={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByTestId("text-teaser-target-comparison").textContent).toContain("above this estimate");
  });

  it("omits the target-price comparison when no target price is known", () => {
    render(
      <AffordabilityTeaserOverlay
        estimate={SAMPLE_ESTIMATE}
        targetPrice={null}
        onContinue={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("text-teaser-target-comparison")).toBeNull();
  });
});

describe("RestoreDraftBanner", () => {
  it("adopting a draft is an explicit decision — restore and dismiss both offered (#249)", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    const onDismiss = vi.fn();
    render(<RestoreDraftBanner onRestore={onRestore} onDismiss={onDismiss} />);
    await user.click(screen.getByTestId("button-restore-draft"));
    expect(onRestore).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId("button-dismiss-restore"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("FunnelProgressHeader", () => {
  it("keeps Homiquity visibly branded throughout the application", () => {
    render(
      <FunnelProgressHeader
        progress={{
          index: 3,
          total: 12,
          percent: 25,
          remaining: 9,
          sectionId: "goal",
          sections: [
            { id: "goal", number: 1, label: "Your goal", status: "current", percent: 50, stepsReached: 2, stepCount: 4 },
          ],
        }}
        onBack={vi.fn()}
        canGoBack
        showSaved
      />,
    );

    expect(screen.getByTestId("logo-apply")).toBeTruthy();
    expect(screen.getByText("Step 3 of 12")).toBeTruthy();
  });
});
