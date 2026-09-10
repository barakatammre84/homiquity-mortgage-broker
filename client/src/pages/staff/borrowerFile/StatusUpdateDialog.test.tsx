import { describe, it, expect, beforeAll } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StatusUpdateDialog } from "./StatusUpdateDialog";
import { STAFF_SETTABLE_STATUSES, isApprovalOutcomeStatus, isProtectedCreditDecisionStatus } from "@shared/loanApplicationStatus";
// Characterization tests for the extracted "Update Application Status" dialog.
// The #247 bug class: hand-listed SelectItems drifted from the server's
// staffStatusSchema and staff picks 400'd forever. These tests pin the dialog
// to the SHARED vocabulary — if either side moves, CI goes red.

// Radix Select drives pointer-capture + scroll APIs happy-dom doesn't ship.
beforeAll(() => {
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture ?? (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

function renderDialog(props?: Partial<Parameters<typeof StatusUpdateDialog>[0]>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StatusUpdateDialog
        applicationId="app-1"
        currentDecisionGrade={true}
        canSetCreditDecisions={true}
        {...props}
      />
    </QueryClientProvider>,
  );
}

/** Opens the dialog, then the status select; resolves to the options listbox. */
async function openStatusSelect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("button-update-status"));
  await user.click(screen.getByTestId("select-new-status"));
  return screen.findByRole("listbox");
}

describe("StatusUpdateDialog", () => {
  it("offers exactly the shared STAFF_SETTABLE_STATUSES — no phantoms, none missing", async () => {
    const user = userEvent.setup();
    renderDialog();
    const listbox = await openStatusSelect(user);
    const options = within(listbox).getAllByRole("option");
    const values = options.map((o) => o.getAttribute("data-testid")?.replace("option-status-", ""));
    expect(values).toEqual([...STAFF_SETTABLE_STATUSES]);
  });

  it("locks credit-decision statuses for roles outside CREDIT_DECISION_ROLES", async () => {
    const user = userEvent.setup();
    renderDialog({ canSetCreditDecisions: false });
    const listbox = await openStatusSelect(user);
    for (const s of STAFF_SETTABLE_STATUSES) {
      const item = within(listbox).getByTestId(`option-status-${s}`);
      if (isProtectedCreditDecisionStatus(s)) {
        expect(item.getAttribute("data-disabled"), `${s} should be locked`).not.toBeNull();
        expect(item.textContent).toContain("(underwriter/admin only)");
      } else {
        expect(item.getAttribute("data-disabled"), `${s} should be selectable`).toBeNull();
      }
    }
  });

  it("requires ≥2 HMDA denial reasons before a denial can be submitted", async () => {
    const user = userEvent.setup();
    renderDialog();
    const listbox = await openStatusSelect(user);
    await user.click(within(listbox).getByTestId("option-status-denied"));
    const confirm = screen.getByTestId("button-confirm-status-update");
    expect(confirm.hasAttribute("disabled")).toBe(true);
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[0]);
    expect(confirm.hasAttribute("disabled")).toBe(true);
    await user.click(checkboxes[1]);
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });

  it("blocks approval outcomes while financials are unverified, mirroring the server 422", async () => {
    const user = userEvent.setup();
    renderDialog({ currentDecisionGrade: false });
    const approvalStatus = STAFF_SETTABLE_STATUSES.find((s) => isApprovalOutcomeStatus(s));
    expect(approvalStatus, "vocabulary contains at least one approval outcome").toBeDefined();
    const listbox = await openStatusSelect(user);
    await user.click(within(listbox).getByTestId(`option-status-${approvalStatus}`));
    expect(screen.getByText(/Current approved financial and credit evidence is required/)).toBeTruthy();
    expect(screen.getByTestId("button-confirm-status-update").hasAttribute("disabled")).toBe(true);
  });

  it("enables an approval outcome once financials are verified", async () => {
    const user = userEvent.setup();
    renderDialog(); // current decision evidence defaults to verified
    const approvalStatus = STAFF_SETTABLE_STATUSES.find((s) => isApprovalOutcomeStatus(s));
    const listbox = await openStatusSelect(user);
    await user.click(within(listbox).getByTestId(`option-status-${approvalStatus}`));
    expect(screen.queryByText(/Financials must be verified/)).toBeNull();
    expect(screen.getByTestId("button-confirm-status-update").hasAttribute("disabled")).toBe(false);
  });
});
