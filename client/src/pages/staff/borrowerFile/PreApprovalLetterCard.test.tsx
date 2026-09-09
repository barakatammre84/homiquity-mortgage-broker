import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PreApprovalLetterCard, LETTER_STATUS_BADGE } from "./PreApprovalLetterCard";
import { loanApplicationKeys } from "@/lib/queryClient";
import { PRE_APPROVAL_LETTER_STATUS } from "@shared/statusVocabularies";
import { letterRevocationSchema } from "@shared/letters";

// Characterization tests for the staff pre-approval-letter card (#340's
// revocation route surface). Pins: the badge map to the SHARED status
// vocabulary (the #247 phantom-status bug class), the confirm gate to the
// SHARED letterRevocationSchema (the server's 400), and the render gates to
// the server's authorization (CREDIT_DECISION_ROLES) and issued-only SQL
// transition — the card must never offer an action the server would reject.

const APP_ID = "app-1";

const issuedLetter = {
  hasLetter: true,
  letterId: "letter-1",
  letterNumber: "BN-TEST123-ABCD",
  status: "issued",
  // Midday UTC so the local-time render stays on the same calendar day in any
  // test-runner timezone.
  expirationDate: "2026-11-02T12:00:00.000Z",
  generatedAt: "2026-08-04T12:00:00.000Z",
  revokedAt: null,
  pdfAvailable: true,
};

function renderCard(
  letterStatus: Record<string, unknown> | null,
  props?: Partial<Parameters<typeof PreApprovalLetterCard>[0]>,
) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  if (letterStatus) {
    client.setQueryData(loanApplicationKeys.letterStatus(APP_ID), letterStatus);
  }
  return render(
    <QueryClientProvider client={client}>
      <PreApprovalLetterCard applicationId={APP_ID} canRevoke={true} {...props} />
    </QueryClientProvider>,
  );
}

describe("LETTER_STATUS_BADGE vocabulary", () => {
  it("covers exactly the shared PRE_APPROVAL_LETTER_STATUS — no phantoms, none missing", () => {
    expect(Object.keys(LETTER_STATUS_BADGE).sort()).toEqual([...PRE_APPROVAL_LETTER_STATUS].sort());
  });

  it("revoked is unmistakably destructive; issued reads as success", () => {
    expect(LETTER_STATUS_BADGE.revoked.variant).toBe("destructive");
    expect(LETTER_STATUS_BADGE.issued.variant).toBe("success");
  });
});

describe("PreApprovalLetterCard", () => {
  it("shows the letter's number, status badge, and expiration", () => {
    renderCard(issuedLetter);
    expect(screen.getByTestId("text-letter-number").textContent).toBe("BN-TEST123-ABCD");
    expect(screen.getByTestId("badge-letter-status").textContent).toBe("Issued");
    expect(screen.getByTestId("text-letter-expiration").textContent).toContain("Nov 2, 2026");
  });

  it("shows the empty state when no letter was ever issued", () => {
    renderCard({ hasLetter: false });
    expect(screen.getByTestId("text-no-letter")).toBeTruthy();
    expect(screen.queryByTestId("button-revoke-letter")).toBeNull();
  });

  it("hides the revoke action for roles outside CREDIT_DECISION_ROLES", () => {
    renderCard(issuedLetter, { canRevoke: false });
    expect(screen.getByTestId("badge-letter-status").textContent).toBe("Issued");
    expect(screen.queryByTestId("button-revoke-letter")).toBeNull();
  });

  it("offers revocation only for issued letters, mirroring the server's SQL guard", () => {
    for (const status of PRE_APPROVAL_LETTER_STATUS) {
      const { unmount } = renderCard({
        ...issuedLetter,
        status,
        revokedAt: status === "revoked" ? "2026-08-04T15:00:00.000Z" : null,
      });
      if (status === "issued") {
        expect(screen.getByTestId("button-revoke-letter"), status).toBeTruthy();
      } else {
        expect(screen.queryByTestId("button-revoke-letter"), status).toBeNull();
      }
      unmount();
    }
  });

  it("shows the revocation date on a revoked letter", () => {
    renderCard({ ...issuedLetter, status: "revoked", revokedAt: "2026-08-04T15:00:00.000Z" });
    expect(screen.getByTestId("badge-letter-status").textContent).toBe("Revoked");
    expect(screen.getByTestId("text-letter-revoked-at").textContent).toContain("Aug 4, 2026");
  });

  it("explains that stale letters require a new decision and issue", () => {
    renderCard({ ...issuedLetter, status: "stale" });
    expect(screen.getByTestId("badge-letter-status").textContent).toBe("Stale");
    expect(screen.getByTestId("text-letter-stale").textContent).toMatch(/re-run the decision/i);
    expect(screen.queryByTestId("button-revoke-letter")).toBeNull();
  });

  it("gates the confirm button on the shared letterRevocationSchema", async () => {
    const user = userEvent.setup();
    renderCard(issuedLetter);
    await user.click(screen.getByTestId("button-revoke-letter"));

    const confirm = screen.getByTestId("button-confirm-revoke-letter");
    expect(confirm.hasAttribute("disabled")).toBe(true);

    const tooShort = "too short";
    expect(letterRevocationSchema.safeParse({ reason: tooShort }).success).toBe(false);
    await user.type(screen.getByTestId("input-revocation-reason"), tooShort);
    expect(confirm.hasAttribute("disabled")).toBe(true);

    const valid = "Material change in the borrower's financial condition.";
    expect(letterRevocationSchema.safeParse({ reason: valid }).success).toBe(true);
    await user.clear(screen.getByTestId("input-revocation-reason"));
    await user.type(screen.getByTestId("input-revocation-reason"), valid);
    expect(confirm.hasAttribute("disabled")).toBe(false);
  });
});
