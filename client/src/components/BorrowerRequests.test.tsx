import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BorrowerRequests } from "./BorrowerRequests";

// Borrower Clarity PR 4: the dashboard card renders visible staff tasks as
// read-only "In progress on our side" rows using the mapping's
// borrowerDisplayText, in addition to the BORROWER-owned actionables it always
// showed. Transparency rows must never grow an action affordance.
//
// Added by the one-selector change: the card used to select
// `status === "OPEN"` alone, so a BLOCKED task — and worse, a task whose
// document came back REJECTED — was invisible here while /tasks listed it
// under "Needs Your Attention". The borrower was told nothing was needed at
// the moment something was wrong (DESIGN_SYSTEM §13, Agreement). Both surfaces
// now derive from lib/outstandingWork.ts.

interface FixtureTask {
  id: string;
  applicationId: string;
  title: string;
  taskType: string;
  taskTypeCode?: string;
  ownerRole?: string;
  status: string;
  verificationStatus?: string | null;
  slaStatus: "green" | "amber" | "red";
  timeRemaining: number | null;
  percentageElapsed: number | null;
  borrowerDisplayText?: string;
}

let tasks: FixtureTask[];

const actionable: FixtureTask = {
  id: "t-act",
  applicationId: "app-1",
  title: "Upload Tax Returns",
  taskType: "document_request",
  taskTypeCode: "DOC_TAX_RETURN_REQUEST",
  ownerRole: "BORROWER",
  status: "OPEN",
  slaStatus: "green",
  timeRemaining: 2880,
  percentageElapsed: 10,
};

const transparency: FixtureTask = {
  id: "t-close",
  applicationId: "app-1",
  title: "We're preparing your closing paperwork.",
  taskType: "action",
  taskTypeCode: "CMP_CLOSING_DISC",
  ownerRole: "CLOSER",
  status: "OPEN",
  slaStatus: "green",
  timeRemaining: null,
  percentageElapsed: null,
  borrowerDisplayText: "We're preparing your closing paperwork.",
};

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, queryFn: async () => tasks } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BorrowerRequests applicationId="app-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  tasks = [actionable, transparency];
});

describe("BorrowerRequests — transparency rows", () => {
  it("renders visible staff tasks read-only under 'In progress on our side'", async () => {
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId("section-in-progress")).toBeTruthy();
    });
    const row = screen.getByTestId("row-transparency-t-close");
    expect(row.textContent).toContain("We're preparing your closing paperwork.");
    // Read-only: no button/link affordance inside a transparency row.
    expect(row.querySelector("button")).toBeNull();
    expect(row.querySelector("a")).toBeNull();
  });

  it("keeps BORROWER-owned actionables with their Upload affordance", async () => {
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId("row-request-t-act")).toBeTruthy();
    });
    expect(screen.getByTestId("button-upload-t-act")).toBeTruthy();
    // The actionable count badge counts actionables only, not transparency rows.
    expect(screen.queryByTestId("row-transparency-t-act")).toBeNull();
  });

  it("shows the in-progress section even when nothing is actionable", async () => {
    tasks = [transparency];
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId("section-in-progress")).toBeTruthy();
    });
    expect(screen.queryByTestId("row-request-t-act")).toBeNull();
  });

  it("shows repeated internal review work as one clear borrower update", async () => {
    tasks = Array.from({ length: 8 }, (_, index) => ({
      ...transparency,
      id: `review-${index}`,
      borrowerDisplayText: "We're reviewing a document you uploaded.",
    }));
    renderCard();

    await waitFor(() => {
      expect(screen.getByTestId("section-in-progress")).toBeTruthy();
    });
    expect(screen.getAllByText("We're reviewing a document you uploaded.")).toHaveLength(1);
    expect(screen.queryByTestId("text-in-progress-overflow")).toBeNull();
  });

  it("still shows the all-caught-up state when there are no tasks at all", async () => {
    tasks = [];
    renderCard();
    await waitFor(() => {
      expect(screen.getByTestId("text-tasks-caught-up")).toBeTruthy();
    });
    expect(screen.queryByTestId("section-in-progress")).toBeNull();
  });
});

describe("BorrowerRequests — outstanding work matches /tasks", () => {
  it("surfaces a REJECTED task instead of claiming nothing is needed", async () => {
    tasks = [{ ...actionable, status: "IN_PROGRESS", verificationStatus: "rejected" }];
    renderCard();

    // Before the fix this rendered the empty state.
    await waitFor(() => {
      expect(screen.getByTestId("row-request-t-act")).toBeTruthy();
    });
    expect(screen.queryByTestId("text-tasks-caught-up")).toBeNull();
  });

  it("surfaces a BLOCKED task", async () => {
    tasks = [{ ...actionable, status: "BLOCKED" }];
    renderCard();

    await waitFor(() => {
      expect(screen.getByTestId("row-request-t-act")).toBeTruthy();
    });
    expect(screen.queryByTestId("text-tasks-caught-up")).toBeNull();
  });

  it("still ignores completed, expired, and submitted-awaiting-review work", async () => {
    tasks = [
      { ...actionable, id: "a", status: "COMPLETED" },
      { ...actionable, id: "b", status: "EXPIRED" },
      { ...actionable, id: "c", status: "IN_PROGRESS" },
    ];
    renderCard();

    await waitFor(() => {
      expect(screen.getByTestId("text-tasks-caught-up")).toBeTruthy();
    });
  });
});

describe("BorrowerRequests — the empty state speaks only for this loan", () => {
  it("does not make an account-wide 'all caught up' claim", async () => {
    tasks = [];
    renderCard();

    await waitFor(() => {
      expect(screen.getByTestId("text-tasks-caught-up")).toBeTruthy();
    });
    const text = screen.getByTestId("text-tasks-caught-up").textContent!;
    expect(text).toBe("Nothing to do on this loan");
    expect(text).not.toMatch(/caught up/i);
  });
});
