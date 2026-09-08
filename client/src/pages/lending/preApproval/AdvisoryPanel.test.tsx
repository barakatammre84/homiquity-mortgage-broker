import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PreApprovalFormData } from "@shared/schema";

import { AdvisoryPanel } from "./AdvisoryPanel";
import { computePreApprovalAnalysis } from "@/lib/preApprovalAnalysis";

// The Live Analysis panel — the wiring test: what the math module computes is
// what the borrower sees, including the step-11 additions (income sources and
// rental debt service) that previously never moved the display.

const ADVERTISED_RATE = 6.375;

function renderPanel(formValues: PreApprovalFormData, currentStepId = "incomeSources") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  // Preseed the advertised-rates query so the panel computes at a known rate
  // without a network layer.
  queryClient.setQueryData(
    ["/api/mortgage-rates"],
    [{ rate: String(ADVERTISED_RATE), isActive: true, program: { termYears: 30, isAdjustable: false } }],
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <AdvisoryPanel formValues={formValues} currentStepId={currentStepId} />
    </QueryClientProvider>,
  );
}

const base = {
  annualIncome: "100,000",
  purchasePrice: "450,000",
  downPayment: "90,000",
  monthlyDebts: "",
  incomeSources: [],
} as unknown as PreApprovalFormData;

const rentalWithDebt = {
  ...base,
  incomeSources: [
    {
      type: "rental",
      annualAmount: "30,000",
      rentalProperties: [
        { address: "12 Elm St", monthlyRentalIncome: "2,500", monthlyDebtPayment: "1,200" },
      ],
    },
  ],
} as unknown as PreApprovalFormData;

describe("AdvisoryPanel", () => {
  it("renders the DTI the analysis module computes — including rental debt service from step 11", () => {
    renderPanel(rentalWithDebt);

    const expected = computePreApprovalAnalysis(rentalWithDebt, ADVERTISED_RATE);
    expect(screen.getByTestId("text-dti-value").textContent).toBe(`${expected.dti.toFixed(0)}%`);

    // Reintroduction guard: the pre-fix math (no rental debt) produces a
    // different DTI, so this assertion fails if the debt term is dropped.
    const preFix = computePreApprovalAnalysis(
      { ...rentalWithDebt, incomeSources: [{ type: "rental", annualAmount: "30,000", rentalProperties: [{ address: "12 Elm St", monthlyRentalIncome: "2,500" }] }] } as unknown as PreApprovalFormData,
      ADVERTISED_RATE,
    );
    expect(expected.dti.toFixed(0)).not.toBe(preFix.dti.toFixed(0));
  });

  it("shows the household total once without re-adding its source breakdown", () => {
    renderPanel(rentalWithDebt);
    expect(screen.getByTestId("text-qualifying-income").textContent).toBe("$100,000/yr");
    expect(screen.getByText("Reported household income")).toBeTruthy();
    expect(screen.getByTestId("text-complex-income-scope").textContent).toMatch(/may differ/i);
    expect(screen.getByText(/recalculate business, investment, and rental income/i)).toBeTruthy();
    expect(screen.queryByText(/manageable/i)).toBeNull();
  });

  it("says the DTI excludes monthly debts until they have been asked", () => {
    renderPanel(rentalWithDebt);
    expect(screen.getByTestId("text-dti-scope-note")).toBeTruthy();
  });

  it("drops the scope note once monthly debts are in the number", () => {
    renderPanel({ ...rentalWithDebt, monthlyDebts: "500" } as unknown as PreApprovalFormData);
    expect(screen.queryByTestId("text-dti-scope-note")).toBeNull();
  });

  it("is present on the first question with guidance instead of empty metrics", () => {
    renderPanel(
      { annualIncome: "", purchasePrice: "", downPayment: "", monthlyDebts: "", incomeSources: [] } as unknown as PreApprovalFormData,
      "loanPurpose",
    );
    expect(screen.getByTestId("advisory-panel")).toBeTruthy();
    expect(screen.queryByTestId("text-qualifying-income")).toBeNull();
    expect(screen.queryByTestId("text-dti-value")).toBeNull();
    expect(screen.getByText("Live Estimate")).toBeTruthy();
    expect(screen.getByText("Self-reported")).toBeTruthy();
  });

  // Regression pin for a defect no guard can see. The panel shipped as
  // `hidden lg:block`, so every borrower on a phone got no DTI, no payment
  // estimate and none of the why-we-ask advice — the borrower most likely to
  // abandon received the least reassurance (DESIGN_SYSTEM.md §12.3). happy-dom
  // has no layout engine, so this asserts the CONTRACT that makes it visible
  // (no width-gated `hidden`, and a width that fits a 320px screen) rather than
  // pretending to measure a rendered viewport.
  it("renders at every width — never re-hidden behind a desktop breakpoint", () => {
    renderPanel(rentalWithDebt);
    const cls = screen.getByTestId("advisory-panel").className;
    expect(cls.split(/\s+/)).not.toContain("hidden");
    expect(cls).toContain("w-full");
  });

  it("still carries the live numbers a phone previously never saw", () => {
    renderPanel(rentalWithDebt);
    expect(screen.getByTestId("text-dti-value")).toBeTruthy();
    expect(screen.getByTestId("text-est-payment")).toBeTruthy();
    expect(screen.getByTestId("text-payment-disclaimer").textContent).toContain(
      "Not an offer of credit",
    );
  });

  it("describes borrower estimates as preliminary and never claims a review or approval", () => {
    renderPanel({ ...base, monthlyDebts: "500" } as unknown as PreApprovalFormData, "final");
    expect(screen.getByText(/ready to submit/i).textContent).toMatch(/estimate/i);
    expect(screen.queryByText(/review complete/i)).toBeNull();
    expect(screen.queryByText(/approval zone/i)).toBeNull();
  });
});
