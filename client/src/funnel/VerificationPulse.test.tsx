import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { VerificationPulse } from "./VerificationPulse";

describe("VerificationPulse", () => {
  it("shows a branded, truthful handoff while a saved application is submitted", () => {
    render(<VerificationPulse active />);

    const pulse = screen.getByTestId("verification-pulse");
    expect(screen.getByTestId("logo-submit-transition")).toBeTruthy();
    expect(pulse.textContent).toContain("Submitting your application");
    expect(pulse.textContent).toContain("Saving your application");
    expect(pulse.textContent).toContain("Preparing your next steps");
    expect(pulse.textContent).not.toContain("Finalizing your decision");
  });
});
