import { describe, it, expect, beforeAll, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PropertySection } from "./PropertySection";
import type { LoanApplication, UrlaLoanDetails } from "@shared/schema";

// WF2-F4 render-level pins. The section-4a Loan Type select shipped DISABLED
// (with a "set during pre-approval" caption while nothing at pre-approval set
// it), and Amortization Type had no control at all — so the two
// loan_applications columns URLA section-4 gating requires were unstatable
// from the product surface. Pinned here: both controls render ENABLED with the
// stated values, and a selection submits its value through the section
// callback (URLAForm carries it into the save payload's `loanDetails`).

beforeAll(() => {
  // Radix + happy-dom pointer shims (same as StateStep.test.tsx).
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

const app = {
  id: "app-1",
  propertyAddress: "123 Main St",
  propertyCity: "Chicago",
  propertyState: "IL",
  propertyZip: "60601",
  propertyValue: "500000",
  purchasePrice: "500000",
  loanPurpose: "purchase",
  preferredLoanType: null,
  amortizationType: null,
} as unknown as LoanApplication;

const loanDetails: UrlaLoanDetails = {
  preferredLoanType: "conventional",
  amortizationType: "fixed",
  loanTermMonths: 360,
};

function renderSection(onLoanDetailsChange = vi.fn(), onChange = vi.fn(), propertyInfo: Record<string, unknown> = {}) {
  render(
    <PropertySection
      propertyInfo={propertyInfo}
      onChange={onChange}
      loanDetails={loanDetails}
      onLoanDetailsChange={onLoanDetailsChange}
      app={app}
    />,
  );
  return onLoanDetailsChange;
}

describe("PropertySection — section 4a loan details", () => {
  it("renders BOTH section-4a controls enabled, showing the stated values", () => {
    renderSection();

    const loanType = screen.getByTestId("select-loan-type") as HTMLButtonElement;
    const amortization = screen.getByTestId("select-amortization-type") as HTMLButtonElement;
    const term = screen.getByTestId("select-loan-term") as HTMLButtonElement;

    expect(loanType.disabled).toBe(false);
    expect(amortization.disabled).toBe(false);
    expect(term.disabled).toBe(false);
    expect(loanType.textContent).toContain("Conventional");
    expect(amortization.textContent).toContain("Fixed Rate");
    expect(term.textContent).toContain("30 years");

    // The disabled-era caption is gone from the two stated controls — only the
    // loan-purpose control (still read-only by design) keeps one.
    expect(screen.getAllByText(/set during pre-approval/i)).toHaveLength(1);
  });

  it("submits a chosen loan type through the section callback", async () => {
    const user = userEvent.setup();
    const onLoanDetailsChange = renderSection();

    await user.click(screen.getByTestId("select-loan-type"));
    await user.click(await screen.findByTestId("option-loan-type-fha"));

    expect(onLoanDetailsChange).toHaveBeenCalledWith({
      preferredLoanType: "fha",
      amortizationType: "fixed",
      loanTermMonths: 360,
    });
  });

  it("submits a chosen amortization type through the section callback", async () => {
    const user = userEvent.setup();
    const onLoanDetailsChange = renderSection();

    await user.click(screen.getByTestId("select-amortization-type"));
    await user.click(await screen.findByTestId("option-amortization-type-adjustable"));

    expect(onLoanDetailsChange).toHaveBeenCalledWith({
      preferredLoanType: "conventional",
      amortizationType: "adjustable",
      loanTermMonths: 360,
    });
  });

  it("submits the selected loan term through the section callback", async () => {
    const user = userEvent.setup();
    const onLoanDetailsChange = renderSection();

    await user.click(screen.getByTestId("select-loan-term"));
    await user.click(await screen.findByTestId("option-loan-term-180"));

    expect(onLoanDetailsChange).toHaveBeenCalledWith({
      preferredLoanType: "conventional",
      amortizationType: "fixed",
      loanTermMonths: 180,
    });
  });

  it("keeps the loan-purpose control read-only (set at pre-approval, by design)", () => {
    renderSection();
    const purpose = screen.getByTestId("select-loan-purpose") as HTMLButtonElement;
    expect(purpose.disabled).toBe(true);
  });

  it("collects every remaining housing cost and reveals second-lien details only when applicable", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderSection(vi.fn(), onChange);
    expect(screen.getByTestId("input-monthly-flood-insurance")).toBeTruthy();
    expect(screen.getByTestId("input-monthly-ground-rent")).toBeTruthy();
    expect(screen.getByTestId("input-monthly-special-assessments")).toBeTruthy();
    expect(screen.queryByTestId("subordinate-financing-details")).toBeNull();

    await user.click(screen.getByTestId("select-subordinate-financing"));
    await user.click(await screen.findByRole("option", { name: "Yes" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ subordinateFinancingExists: true }));
  });

  it("shows the exact second-mortgage and HELOC fields after a yes answer", () => {
    renderSection(vi.fn(), vi.fn(), { subordinateFinancingExists: true });
    expect(screen.getByTestId("subordinate-financing-details")).toBeTruthy();
    expect(screen.getByLabelText(/second-mortgage amount/i)).toBeTruthy();
    expect(screen.getByLabelText(/HELOC amount drawn/i)).toBeTruthy();
    expect(screen.getByLabelText(/full HELOC credit limit/i)).toBeTruthy();
    expect(screen.getByLabelText(/combined monthly payment/i)).toBeTruthy();
  });
});
