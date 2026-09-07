import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FinancialSnapshot } from "./FinancialSnapshot";
import { TooltipProvider } from "@/components/ui/tooltip";

const graph = {
  bestAnnualIncome: 246000,
  bestIncomeSource: "application",
  totalVerifiedAssets: null,
  totalMonthlyDebts: 1200,
  documentsUploaded: 1,
  documentsVerified: 0,
  documentsMissing: [],
  financialVerification: { income: false, assets: false, credit: false, decisionGrade: false },
  readiness: { completionPercentage: 20, tier: "building", completedInputs: [], outstandingInputs: ["Verify income"] },
  eligibility: {
    estimatedDTI: 32.61,
    estimatedLTV: 80,
    creditTier: "760_plus",
    creditScore: 760,
    employmentStable: true,
    hasAdequateSavings: null,
    estimatedMaxPurchase: 890000,
    eligibleLoanTypes: ["conventional"],
  },
  predictiveSignals: { engagementLevel: "high", suggestedNextAction: "Upload documents" },
} as never;

describe("FinancialSnapshot qualification gate", () => {
  const renderSnapshot = (qualificationVerified: boolean) => render(
    <TooltipProvider>
      <FinancialSnapshot graph={graph} qualificationVerified={qualificationVerified} />
    </TooltipProvider>,
  );

  it("shows provided inputs without publishing unverified qualification results", () => {
    renderSnapshot(false);
    expect(screen.getByText("Information Provided")).toBeTruthy();
    expect(screen.getByText("Credit Score Provided")).toBeTruthy();
    expect(screen.getByText("Income Provided")).toBeTruthy();
    expect(screen.queryByTestId("signal-dti")).toBeNull();
    expect(screen.queryByTestId("signal-max-purchase")).toBeNull();
    expect(screen.queryByTestId("signal-programs")).toBeNull();
    expect(screen.getByTestId("text-qualification-pending").textContent).toContain("verifying");
  });

  it("publishes the verified ratios and program result after verification", () => {
    renderSnapshot(true);
    fireEvent.click(screen.getByTestId("button-toggle-snapshot"));
    expect(screen.getByTestId("signal-dti").textContent).toContain("32.61%");
    expect(screen.getByTestId("signal-max-purchase")).toBeTruthy();
    expect(screen.getByTestId("signal-programs")).toBeTruthy();
  });
});
