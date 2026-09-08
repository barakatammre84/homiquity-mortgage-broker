import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActiveBorrowerPane } from "./ActiveBorrowerPane";
import type { CockpitData } from "./types";

/**
 * The LO reads the same evaluation the borrower does, and inherited the same
 * defect: a headline qualifying figure over a per-path list that did not sum to
 * it. A rental portfolio contributing +1,250 of income and 750 of debt was
 * listed as one 500 net line, so a loan officer reconciling the file by eye
 * found 750 missing and no explanation of where it went.
 */
const cockpit = (paths: CockpitData["income"] extends null ? never : NonNullable<CockpitData["income"]>["paths"]): CockpitData => ({
  application: {
    id: "app-1", borrowerUserId: "u-1", borrowerName: "Test Borrower", status: "approved",
    loanPurpose: "purchase", purchasePrice: "500000", downPayment: "100000",
    propertyState: "IL", propertyType: "multi_family", isVeteran: false,
    financialDataProvenance: "verified",
    closingDate: null, createdAt: null,
  },
  income: {
    primaryMonthlyQualifyingIncome: 7250,
    incomeBasis: "urla_line_items",
    recommendedPathId: null,
    requiresManualReview: true,
    evaluatedAt: null,
    paths,
  },
  conditions: { total: 0, open: 0, items: [] },
  documents: { uploadedCount: 0, verifiedCount: 0, byType: [] },
  messages: { unreadFromBorrower: 0, recent: [] },
  activity: { totalPageViews: 0, propertySearches: 0, calculatorUses: 0, propertyViews: 0 },
});

function renderPane(data: CockpitData) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, queryFn: async () => data } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ActiveBorrowerPane applicationId="app-1" onBack={() => {}} />
    </QueryClientProvider>,
  );
}

describe("ActiveBorrowerPane — the qualifying-income list reconciles", () => {
  it("lists what each path contributed, and names the loss that went to debts", async () => {
    renderPane(
      cockpit([
        {
          pathId: "agency_wage", role: "component", status: "applicable", kind: "dti_income",
          monthlyQualifyingIncome: 6000, appliedToDti: true,
          appliedMonthlyIncome: 6000, appliedMonthlyObligation: 0, requiresManualReview: false,
        },
        {
          pathId: "rental", role: "component", status: "applicable", kind: "dti_income",
          monthlyQualifyingIncome: 500, appliedToDti: true,
          appliedMonthlyIncome: 1250, appliedMonthlyObligation: 750, requiresManualReview: true,
        },
      ]),
    );
    await waitFor(() => {
      expect(screen.getByTestId("cockpit-active-borrower")).toBeTruthy();
    });
    const pane = screen.getByTestId("cockpit-active-borrower");
    // 6,000 + 1,250 = the 7,250 headline; the net 500 is never shown as income
    expect(pane.textContent).toContain("$1,250/mo");
    expect(pane.textContent).not.toContain("$500/mo");
    expect(pane.textContent).toContain("to debts");
  });

  it("falls back to the stored figure for an evaluation predating the split", async () => {
    renderPane(
      cockpit([
        {
          pathId: "agency_wage", role: "component", status: "applicable", kind: "dti_income",
          monthlyQualifyingIncome: 6000, appliedToDti: true, requiresManualReview: false,
        },
      ]),
    );
    await waitFor(() => {
      expect(screen.getByTestId("cockpit-active-borrower")).toBeTruthy();
    });
    expect(screen.getByTestId("cockpit-active-borrower").textContent).toContain("$6,000/mo");
  });

  it("labels a self-reported calculation as an initial review rather than a pre-approval", async () => {
    const data = cockpit([
      {
        pathId: "self_employment", role: "component", status: "applicable", kind: "dti_income",
        monthlyQualifyingIncome: 15000, appliedToDti: true, requiresManualReview: false,
      },
    ]);
    data.application.status = "pre_approved";
    data.application.financialDataProvenance = "self_reported";
    renderPane(data);

    await waitFor(() => expect(screen.getByTestId("cockpit-active-borrower")).toBeTruthy());
    const pane = screen.getByTestId("cockpit-active-borrower");
    expect(pane.textContent).toContain("Initial review");
    expect(pane.textContent).toContain("Income calculation");
    expect(pane.textContent).toContain("self-reported");
    expect(pane.textContent).toMatch(/Verify income, assets, credit, and property evidence/i);
    expect(pane.textContent).not.toContain("Pre-Approved");
  });
});
