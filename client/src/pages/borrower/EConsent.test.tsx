import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { consentKeys, loanApplicationKeys } from "@/lib/queryClient";

// The E-Consent page had no test file. These pin the fact two surfaces were
// disagreeing about (DESIGN_SYSTEM §13, Agreement):
//
// `/api/consents/me` returns the borrower's full consent HISTORY —
// `getBorrowerConsentsByUser` is the one getter in storage/locksAndConsents.ts
// with no `isRevoked` filter — and revoking a consent sets `isRevoked` while
// deliberately leaving `consentGiven: true` as the record of what was once
// given. So a predicate that reads `consentGiven` alone reports a REVOKED
// consent as still in force. This page did; `TaxReturnInsightCard`, reading
// the very same endpoint, did not.

const apiRequest = vi.fn();
const toast = vi.fn();

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequest(...args),
  };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import EConsent from "./EConsent";

const TEMPLATE = {
  id: "tpl-1",
  consentType: "tax_document_use",
  version: "v2",
  title: "Tax Document Use Authorization",
  shortDescription: "Lets us read the tax documents you upload.",
  fullText: "FULL CONSENT TEXT …",
  regulatoryReference: "IRC §7216",
};

function renderPage(consents: Array<Record<string, unknown>>, applicationId?: string) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, queryFn: () => new Promise(() => {}) },
    },
  });
  client.setQueryData(["/api/consent-templates"], [TEMPLATE]);
  client.setQueryData(consentKeys.me(), consents);
  client.setQueryData(
    loanApplicationKeys.all(),
    applicationId ? [{ id: applicationId, status: "processing" }] : [],
  );
  return render(
    <QueryClientProvider client={client}>
      <EConsent />
    </QueryClientProvider>,
  );
}

const given = { id: "c-1", consentType: "tax_document_use", consentGiven: true, consentedAt: "2026-08-01", consentMethod: "click" };

beforeEach(() => {
  apiRequest.mockReset();
  toast.mockReset();
});

describe("EConsent — a revoked consent is not a given consent", () => {
  it("counts a live consent as completed", () => {
    renderPage([{ ...given, isRevoked: false }]);

    expect(screen.getByTestId("card-completed-consents").textContent).toContain("1");
    expect(screen.getByTestId("card-pending-consents").textContent).toContain("0");
    // Nothing to act on, so no agreement control is offered.
    expect(screen.queryByTestId("checkbox-agree-tax_document_use")).toBeNull();
  });

  it("puts a REVOKED consent back into Action Required, not Completed", () => {
    renderPage([{ ...given, isRevoked: true }]);

    // Before the fix this read Completed 1 / Pending 0, and the page told the
    // borrower there was nothing to do — while the Tax card, reading the same
    // endpoint, showed the consent as needed again.
    expect(screen.getByTestId("card-pending-consents").textContent).toContain("1");
    expect(screen.getByTestId("card-completed-consents").textContent).toContain("0");
    expect(screen.getByText("Action Required")).toBeTruthy();
    expect(screen.getByTestId("checkbox-agree-tax_document_use")).toBeTruthy();
  });

  it("treats a consent that was refused (consentGiven false) as still pending", () => {
    renderPage([{ ...given, consentGiven: false, isRevoked: false }]);

    expect(screen.getByTestId("card-pending-consents").textContent).toContain("1");
  });
});

describe("EConsent — the agreement control", () => {
  it("starts unchecked and gates submission until the borrower agrees", async () => {
    const user = userEvent.setup();
    renderPage([]);

    const checkbox = screen.getByTestId("checkbox-agree-tax_document_use");
    const submit = screen.getByTestId(
      "button-submit-tax_document_use",
    ) as HTMLButtonElement;

    expect(checkbox.getAttribute("data-state")).toBe("unchecked");
    expect(submit.disabled).toBe(true);

    await user.click(checkbox);

    expect(checkbox.getAttribute("data-state")).toBe("checked");
    expect(submit.disabled).toBe(false);
  });

  it("attaches the recorded consent to the selected loan application", async () => {
    apiRequest.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage([], "app-1");

    await user.click(screen.getByTestId("checkbox-agree-tax_document_use"));
    await user.click(screen.getByTestId("button-submit-tax_document_use"));

    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith(
        "POST",
        "/api/consents",
        expect.objectContaining({ applicationId: "app-1", consentType: "tax_document_use" }),
      );
    });
  });

  it("names the document it agrees to, and states that nothing is recorded yet", () => {
    renderPage([]);

    // "the above" named nothing; the label now names the document itself.
    expect(screen.getByTestId("label-agree-tax_document_use").textContent).toBe(
      "I have read and agree to the Tax Document Use Authorization.",
    );
    expect(
      screen.getByTestId("consent-agree-tax_document_use-consequence").textContent,
    ).toMatch(/Nothing is recorded until you submit/);
  });
});
