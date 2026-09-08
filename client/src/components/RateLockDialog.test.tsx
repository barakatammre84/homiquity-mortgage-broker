import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RateLockDialog } from "./RateLockDialog";
import { loanApplicationKeys } from "@/lib/queryClient";

const apiRequestMock = vi.fn();
vi.mock("@/lib/queryClient", async () => {
  const actual = await vi.importActual<typeof import("@/lib/queryClient")>("@/lib/queryClient");
  return { ...actual, apiRequest: (...args: unknown[]) => apiRequestMock(...args) };
});

const APP_ID = "app-rate-desk";
const locksKey = ["/api/rate-locks/application", APP_ID] as const;

const option = {
  id: "option-1",
  interestRate: "6.375",
  points: "0.500",
  loanAmount: "480000.00",
  loanType: "CONV",
  loanTerm: 30,
};

const lender = {
  lenderId: "real-wholesale",
  lenderName: "Real Wholesale Bank",
  approvalStatus: "approved",
  isDemo: false,
  status: "ACTIVE",
};

function renderDialog(locks: Record<string, unknown>[] = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, enabled: false } },
  });
  client.setQueryData(locksKey, locks);
  client.setQueryData(loanApplicationKeys.options(APP_ID), { options: [option] });
  client.setQueryData(["/api/wholesale-lenders"], [lender]);

  return render(
    <QueryClientProvider client={client}>
      <RateLockDialog applicationId={APP_ID} borrowerName="Casey Complex" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  apiRequestMock.mockResolvedValue({ json: async () => ({ simulated: false }) });
});

describe("RateLockDialog lender-confirmation contract", () => {
  it("collects every field the create route requires and posts the lender business key", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByTestId(`rate-lock-${APP_ID}`));

    await user.click(await screen.findByTestId("lock-lender-select"));
    await user.click(await screen.findByTestId("lock-lender-option-real-wholesale"));
    await user.click(screen.getByTestId("lock-option-select"));
    await user.click(await screen.findByText("6.375% · CONV · 30yr"));
    await user.type(screen.getByLabelText("Lender confirmation number"), "LOCK-CASEY-01");
    await user.type(screen.getByLabelText("Lender-confirmed expiration"), "2026-10-07T17:00");
    await user.click(screen.getByTestId("submit-lock"));

    expect(apiRequestMock).toHaveBeenCalledWith("POST", "/api/rate-locks", {
      applicationId: APP_ID,
      loanOptionId: "option-1",
      lockPeriodDays: 30,
      lenderId: "real-wholesale",
      lockConfirmationNumber: "LOCK-CASEY-01",
      confirmedRate: 6.375,
      confirmedExpiresAt: new Date("2026-10-07T17:00").toISOString(),
    });
  });

  it("never offers a lender extension for an indicative quote", async () => {
    const user = userEvent.setup();
    renderDialog([{
      id: "quote-1",
      applicationId: APP_ID,
      status: "active",
      simulated: true,
      interestRate: "6.500",
      lockedAt: "2026-09-07T12:00:00.000Z",
      expiresAt: "2026-10-07T12:00:00.000Z",
      lockPeriodDays: 30,
      loanType: "CONV",
      loanTerm: 30,
      extensionCount: 0,
    }]);
    await user.click(screen.getByTestId(`rate-lock-${APP_ID}`));

    expect(await screen.findByText("Indicative quote — no lender commitment")).toBeTruthy();
    expect(screen.getByTestId("indicative-extension-blocked").textContent).toMatch(/cannot be extended as a lock/i);
    expect(screen.queryByTestId("extend-lock")).toBeNull();
  });

  it("posts the lender's extension confirmation and fee ownership", async () => {
    const user = userEvent.setup();
    renderDialog([{
      id: "lock-1",
      applicationId: APP_ID,
      status: "active",
      simulated: false,
      interestRate: "6.375",
      lockedAt: "2026-09-07T12:00:00.000Z",
      expiresAt: "2026-10-07T12:00:00.000Z",
      lockPeriodDays: 30,
      loanType: "CONV",
      loanTerm: 30,
      extensionCount: 0,
    }]);
    await user.click(screen.getByTestId(`rate-lock-${APP_ID}`));

    await user.clear(screen.getByLabelText("Additional days"));
    await user.type(screen.getByLabelText("Additional days"), "15");
    await user.type(screen.getByLabelText("Confirmed expiration"), "2026-10-22T17:00");
    await user.type(screen.getByLabelText("Lender confirmation number"), "EXT-CASEY-01");
    await user.type(screen.getByLabelText("Extension fee (optional)"), "250");
    await user.click(screen.getByLabelText("Fee paid by"));
    await user.click(await screen.findByText("Broker"));
    await user.click(screen.getByTestId("extend-lock"));

    expect(apiRequestMock).toHaveBeenCalledWith("POST", "/api/rate-locks/lock-1/extend", {
      additionalDays: 15,
      lockConfirmationNumber: "EXT-CASEY-01",
      confirmedExpiresAt: new Date("2026-10-22T17:00").toISOString(),
      extensionFee: 250,
      extensionFeePaidBy: "broker",
    });
  });
});
