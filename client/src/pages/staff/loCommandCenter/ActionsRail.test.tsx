import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActionsRail } from "./ActionsRail";
import type { CockpitData } from "./types";

vi.mock("@/components/RateLockDialog", () => ({ RateLockDialog: () => <button>Rate desk</button> }));
vi.mock("@/components/ScenarioSimulatorDialog", () => ({ ScenarioSimulatorDialog: () => <button>What-If</button> }));
vi.mock("@/components/SubmissionReadinessDialog", () => ({ SubmissionReadinessDialog: () => <button>Submit to lender</button> }));
vi.mock("./CallPrepDialog", () => ({ CallPrepDialog: () => <button>Call Prep</button> }));

const APP_ID = "app-actions";

function cockpit(status: string, financialDataProvenance: string): CockpitData {
  return {
    application: {
      id: APP_ID,
      borrowerUserId: "borrower-1",
      borrowerName: "Casey Complex",
      status,
      loanPurpose: "purchase",
      purchasePrice: "650000",
      downPayment: "130000",
      propertyState: "IL",
      propertyType: "single_family",
      financialDataProvenance,
      isVeteran: false,
      closingDate: null,
      createdAt: null,
    },
    income: null,
    conditions: { total: 0, open: 0, items: [] },
    documents: { uploadedCount: 0, verifiedCount: 0, byType: [] },
    messages: { unreadFromBorrower: 0, recent: [] },
    activity: { totalPageViews: 0, propertySearches: 0, calculatorUses: 0, propertyViews: 0 },
  };
}

function renderRail(data: CockpitData) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["/api/staff/applications", APP_ID, "cockpit"], data);
  return render(
    <QueryClientProvider client={client}>
      <ActionsRail
        applicationId={APP_ID}
        borrowerName="Casey Complex"
        signals={[]}
        onExportMismo={vi.fn()}
        exporting={false}
      />
    </QueryClientProvider>,
  );
}

describe("ActionsRail pre-approval integrity", () => {
  it("blocks a letter while the pre-approval is still based on self-reported financials", () => {
    renderRail(cockpit("pre_approved", "self_reported"));
    expect((screen.getByTestId("action-preapproval-letter") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("preapproval-letter-blocked-reason").textContent).toMatch(/verify income, assets, and credit/i);
  });

  it("enables a letter only for a verified pre-approved file", () => {
    renderRail(cockpit("pre_approved", "verified"));
    expect((screen.getByTestId("action-preapproval-letter") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("preapproval-letter-blocked-reason")).toBeNull();
  });
});
