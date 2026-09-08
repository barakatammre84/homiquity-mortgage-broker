import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActiveBorrowerPane, loanOfficerNextAction } from "./ActiveBorrowerPane";
import type { CockpitData, StaffSignal } from "./types";

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

function renderPane(data: CockpitData, signals: StaffSignal[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, queryFn: async () => data } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ActiveBorrowerPane applicationId="app-1" signals={signals} onBack={() => {}} />
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

  it("carries a complex-file signal into a concrete next-action plan", async () => {
    const data = cockpit([
      {
        pathId: "self_employment", role: "component", status: "applicable", kind: "dti_income",
        monthlyQualifyingIncome: 15000, appliedToDti: true, requiresManualReview: true,
      },
      {
        pathId: "rental", role: "component", status: "applicable", kind: "dti_income",
        monthlyQualifyingIncome: 0, appliedToDti: true, requiresManualReview: true,
      },
    ]);
    data.application.financialDataProvenance = "self_reported";
    data.conditions = {
      total: 6,
      open: 6,
      items: Array.from({ length: 6 }, (_, index) => ({
        id: `condition-${index}`,
        title: `Document ${index}`,
        category: "income",
        status: "outstanding",
        priority: "prior_to_approval",
      })),
    };
    data.documents = {
      uploadedCount: 1,
      verifiedCount: 0,
      byType: [{ type: "profit_loss", status: "rejected", fileName: "p-and-l.pdf" }],
    };
    const signal: StaffSignal = {
      type: "preuw_flag",
      priority: 1,
      applicationId: "app-1",
      borrowerName: "Test Borrower",
      title: "complex income check, rental income offset",
      detail: "Self-employed income must be documented before approval-grade decisions.",
    };

    renderPane(data, [signal]);

    await waitFor(() => expect(screen.getByTestId("cockpit-file-plan")).toBeTruthy());
    expect(screen.getByTestId("cockpit-next-action").textContent).toMatch(/focused request for the 6 open items/i);
    expect(screen.getByTestId("cockpit-next-action-control").textContent).toMatch(/draft doc request/i);
    expect(screen.getByTestId("cockpit-top-signal").textContent).toMatch(/rental income offset/i);
    expect(screen.getByTestId("cockpit-file-plan").textContent).toMatch(/0\/1 verified · 6 open/i);
  });

  it("prioritizes an unread borrower message ahead of document follow-up", () => {
    const data = cockpit([]);
    data.messages.unreadFromBorrower = 2;
    data.conditions = { total: 4, open: 4, items: [] };

    expect(loanOfficerNextAction(data)).toBe("Reply to 2 unread borrower messages.");
  });
});
