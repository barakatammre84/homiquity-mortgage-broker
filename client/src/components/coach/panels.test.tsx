import { describe, it, expect, vi } from "vitest";
import { fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { ConnectedFilePanel, DocumentChecklistPanel, DocumentEvidencePanel, FileSnapshotPanel, ReadinessPanel, StatusPanel } from "./panels";
import type { ChecklistItemView } from "@/lib/documentChecklist";
import type { CoachProfile, LoanStatusView } from "./types";

/**
 * These panels are where the assistant's silent-success bug actually reached
 * the borrower.
 *
 * The checklist used to be authored by the model through set_document_checklist:
 * it invented a `docType` matching no loan_condition, this component rendered it
 * authoritatively next to an Upload button, the borrower uploaded — and the item
 * never cleared, because the real checklist is derived from loan_conditions
 * elsewhere. The UI said the operation happened; the file said it did not.
 *
 * So the load-bearing assertion here is not "it renders" — it is that the
 * upload target is the REAL condition's documentType, and that every state the
 * server can report is shown honestly rather than flattened to "needed".
 */

// Plaid-eligible rows mount PlaidConnectButton, which needs a query client.
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const item = (over: Partial<ChecklistItemView> = {}): ChecklistItemView => ({
  id: "cond-1",
  source: "condition",
  conditionId: "cond-1",
  category: "income",
  documentType: "pay_stub",
  acceptedTypes: ["pay_stub"],
  label: "Most recent pay stubs",
  description: "Covering the last 30 days.",
  required: true,
  status: "needed",
  ...over,
});

describe("DocumentChecklistPanel — the borrower's real checklist", () => {
  it("uploads against the REAL condition documentType", () => {
    // The whole bug in one assertion. This id comes from a loan_condition, so
    // the upload matches a real requirement and the pipeline engine's
    // zero-touch matcher flips it outstanding → submitted.
    render(<DocumentChecklistPanel docs={[item()]} applicationId="app-1" />);
    expect(screen.getByTestId("button-upload-pay_stub")).toBeTruthy();
  });

  it("shows a rejection with the reason the borrower must act on", () => {
    render(
      <DocumentChecklistPanel
        docs={[item({ status: "rejected", rejectionReason: "Page 3 is missing." })]}
        applicationId="app-1"
      />,
    );
    // A rejected item is the one state the borrower cannot self-diagnose: the
    // file IS uploaded, so it looks done, and only the reviewer's reason says
    // why it bounced.
    expect(screen.getByTestId("doc-rejection-pay_stub").textContent).toContain("Page 3 is missing.");
    expect(screen.getByTestId("doc-status-pay_stub").textContent).toMatch(/needs a fix/i);
    expect(screen.getByTestId("button-upload-pay_stub").textContent).toMatch(/re-upload/i);
  });

  it.each([
    ["uploaded", /received/i],
    ["verifying", /in review/i],
    ["verified", /verified/i],
  ] as const)("reports %s honestly instead of flattening it to 'needed'", (status, label) => {
    render(<DocumentChecklistPanel docs={[item({ status })]} applicationId="app-1" />);
    expect(screen.getByTestId("doc-status-pay_stub").textContent).toMatch(label);
  });

  it("offers no upload on work already done", () => {
    // Offering "Upload" beside a verified document invites the borrower to redo
    // work the lender has already accepted.
    render(<DocumentChecklistPanel docs={[item({ status: "verified" })]} applicationId="app-1" />);
    expect(screen.queryByTestId("button-upload-pay_stub")).toBeNull();
  });

  it("renders the staff-authored instructions and the requested year", () => {
    render(
      <DocumentChecklistPanel
        docs={[item({ documentYear: "2025", instructions: "All pages, including blanks." })]}
        applicationId="app-1"
      />,
    );
    expect(screen.getByTestId("doc-item-pay_stub").textContent).toContain("2025");
    expect(screen.getByTestId("doc-item-pay_stub").textContent).toContain("All pages, including blanks.");
  });
});

const status: LoanStatusView = {
  hasApplication: true,
  stage: {
    status: "underwriting",
    label: "Underwriting",
    description: "An underwriter is reviewing your file.",
    progressPercent: 65,
    phase: "processing",
  },
  pipeline: {
    daysInPipeline: 17,
    conditionsOutstanding: 4,
    conditionsTotal: 7,
    percentComplete: 43,
    targetCloseDate: null,
  },
  journey: [{ stepId: "underwriting", lines: ["Conditions cleared: 3 of 7"] }],
  nextAction: {
    kind: "upload_documents",
    title: "Upload your documents — 4 needed",
    description: "Everything on the list unlocks your next stage.",
    href: "/documents",
    buttonLabel: "Upload Documents",
  },
  lastActivityAt: null,
};

describe("StatusPanel — where the file stands", () => {
  it("states the stage and the conditions in the borrower's own terms", () => {
    render(<StatusPanel status={status} />);
    expect(screen.getByTestId("text-stage-label").textContent).toBe("Underwriting");
    expect(screen.getByTestId("text-conditions").textContent).toContain("3 of 7");
    expect(screen.getByTestId("journey-underwriting").textContent).toContain("Conditions cleared: 3 of 7");
  });

  it("marks itself as fact, not suggestion", () => {
    // The defect was never that the assistant suggests things — it is that a
    // suggestion rendered identically to a file-derived panel reads as fact.
    render(<StatusPanel status={status} />);
    expect(screen.getByTestId("badge-panel-source-file").textContent).toMatch(/on your file/i);
  });

  it("renders nothing when there is no application, rather than an empty stage", () => {
    const { container } = render(
      <StatusPanel status={{ ...status, hasApplication: false, stage: null }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("FileSnapshotPanel — one source of truth", () => {
  it("shows the file stage, evidence count, next action, and human handoff without competing percentages", () => {
    render(
      <FileSnapshotPanel
        status={status}
        docs={[
          item({ status: "verified" }),
          item({ id: "cond-2", documentType: "w2", status: "uploaded" }),
          item({ id: "cond-3", documentType: "bank_statement", status: "needed" }),
        ]}
      />,
    );

    const panel = screen.getByTestId("card-file-snapshot");
    expect(screen.getByTestId("file-snapshot-stage").textContent).toContain("Underwriting");
    expect(screen.getByTestId("file-snapshot-evidence").textContent).toMatch(/1 of 3 verified/i);
    expect(screen.getByTestId("file-snapshot-evidence").textContent).toMatch(/1 received/i);
    expect(screen.getByTestId("link-file-snapshot-next").getAttribute("href")).toBe("/documents");
    expect(screen.getByTestId("link-message-loan-officer").getAttribute("href")).toBe("/messages");
    expect(panel.textContent).not.toMatch(/65%|43%/);
    expect(panel.querySelector('[data-testid^="doc-item-"]')).toBeNull();
  });

  it("gives an aspiring owner a homebuyer-plan action before an application exists", () => {
    render(<FileSnapshotPanel status={{ ...status, hasApplication: false, stage: null, nextAction: null }} docs={[]} />);
    expect(screen.getByTestId("file-snapshot-stage").textContent).toMatch(/planning/i);
    expect(screen.getByTestId("link-file-snapshot-next").getAttribute("href")).toBe("/gap-calculator");
  });

  it("shows account-level planning documents without calling them a mortgage checklist", () => {
    render(
      <FileSnapshotPanel
        status={{ ...status, hasApplication: false, stage: null, nextAction: null }}
        docs={[]}
        planningDocuments={{ total: 2, verified: 0, underReview: 2, rejected: 0 }}
      />,
    );
    expect(screen.getByTestId("file-snapshot-planning-documents").textContent).toMatch(/2 saved to your account/i);
    expect(screen.getByTestId("file-snapshot-planning-documents").textContent).toMatch(/2 being reviewed/i);
    expect(screen.getByTestId("button-view-planning-documents").getAttribute("href")).toBe("/documents");
  });

  it("keeps uploaded file evidence visible before the first exact request exists", () => {
    render(
      <FileSnapshotPanel
        status={{ ...status, stage: { ...status.stage!, status: "draft", label: "Incomplete" } }}
        docs={[]}
        fileDocuments={{ total: 2, verified: 0, underReview: 2, rejected: 0 }}
      />,
    );
    expect(screen.getByTestId("file-snapshot-uploaded-documents").textContent).toMatch(/2 saved to this application/i);
    expect(screen.getByTestId("file-snapshot-uploaded-documents").textContent).toMatch(/2 being reviewed/i);
    expect(screen.getByTestId("button-view-file-documents").getAttribute("href")).toBe("/documents");
  });
});

describe("ConnectedFilePanel", () => {
  it("stops loading when no accessible borrower file is available", () => {
    render(<ConnectedFilePanel status={null} docs={[]} loading={false} />);

    expect(screen.getByTestId("coach-side-panel-unavailable").textContent).toMatch(/no connected file/i);
    expect(screen.queryByTestId("coach-side-panel-loading")).toBeNull();
  });

  it("shows a recoverable error instead of claiming there is no file", () => {
    const onRetry = vi.fn();
    render(<ConnectedFilePanel status={null} docs={[]} loading={false} error onRetry={onRetry} />);

    expect(screen.getByTestId("coach-side-panel-error").textContent).toMatch(/won't guess|will not guess/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("coach-side-panel-unavailable")).toBeNull();
  });
});

describe("DocumentEvidencePanel — traceable file evidence", () => {
  it("separates machine-read and human-verified facts and links the exact source page", () => {
    render(
      <DocumentEvidencePanel
        evidence={{
          documents: [{
            documentId: "doc-1",
            documentType: "pay_stub",
            label: "Pay stub",
            documentReviewStatus: "accepted",
            evidenceStatus: "partly_human_verified",
            omittedFactCount: 0,
            facts: [
              { label: "Year-to-date gross pay", value: 42_000, format: "currency", reviewStatus: "machine_read", confidence: "medium", needsHumanReview: true, pageNumber: 1 },
              { label: "Monthly income average", value: 7_000, format: "currency", reviewStatus: "human_verified", confidence: "not_applicable", needsHumanReview: false, pageNumber: 1 },
            ],
          }],
          summary: { documentCount: 1, extractedFactCount: 2, humanVerifiedFactCount: 1, factsNeedingHumanReview: 1, omittedDocumentCount: 0 },
          financialReview: { status: "not_approved", income: "not_approved", assets: "not_approved", liabilities: "not_approved" },
        }}
      />,
    );

    expect(screen.getByText(/machine read · medium/i)).toBeTruthy();
    expect(screen.getAllByText(/human verified/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/staff review needed/i)).toBeTruthy();
    expect(screen.getByTestId("link-evidence-source-doc-1-0").getAttribute("href"))
      .toBe("/api/documents/doc-1/pages/1/image");
    expect(screen.getByTestId("card-document-evidence").textContent).toMatch(/does not by itself approve a loan/i);
  });
});

// ---------------------------------------------------------------------------
// Kept from main (#595) and still load-bearing after update_readiness was
// deleted. deriveReadinessProfile now always produces a COMPLETE profile, so
// nothing writes the partial shape any more — but the rows the old tool wrote
// already exist and cannot be un-written, and /api/coach/profile still serves
// them. The panel has to survive its own history.
// ---------------------------------------------------------------------------

/**
 * The readiness panel against a PARTIAL profile — the shape that actually sits
 * in the database.
 *
 * `coach_conversations.financial_profile` was being written from two places: a
 * complete `set_readiness` tool result, and a fallback that spread only the
 * server-derived percentage over `existingProfile`. On a conversation's first
 * turn that fallback's `existingProfile` is `{}`, so the column ended up holding
 * literally `{"completionPercentage": 88}` — verified against the dev database,
 * which has three such rows.
 *
 * `CoachProfile` declared all six fields required, so this panel read
 * `profile.completedInputs.length` off `undefined` and threw, and because it
 * renders inside AppErrorBoundary the whole /ai-coach page went to "Something
 * went wrong". The server no longer writes that shape, but rows in it already
 * exist and cannot be un-written, so the panel has to survive it.
 */

describe("ReadinessPanel — surviving the rows the deleted tool left behind", () => {
  it("renders a profile that carries nothing but a completion percentage", () => {
    // Exactly the row shape found in the database — cast because the point of
    // the test is a payload no honest caller would construct.
    const partial = { completionPercentage: 88 } as CoachProfile;

    render(<ReadinessPanel profile={partial} />);

    expect(screen.getByTestId("card-readiness-panel")).toBeTruthy();
    expect(screen.getByTestId("badge-readiness-score").textContent).toContain("88%");
    // No tier was ever recorded, so it falls back rather than blowing up.
    expect(screen.getByTestId("text-readiness-tier").textContent).toBeTruthy();
    // The two input lists simply do not render.
    expect(screen.queryByText("COMPLETED INPUTS")).toBeNull();
    expect(screen.queryByText("OUTSTANDING INPUTS")).toBeNull();
  });

  it("still renders both input lists when the profile is complete", () => {
    const full: CoachProfile = {
      readinessTier: "building",
      completionPercentage: 60,
      statusNote: "Keep going.",
      completedInputs: ["Income", "Credit score"],
      outstandingInputs: ["Down payment"],
      estimatedTimeline: "3-6 months",
    };

    render(<ReadinessPanel profile={full} />);

    expect(screen.getByText("COMPLETED INPUTS")).toBeTruthy();
    expect(screen.getByText("OUTSTANDING INPUTS")).toBeTruthy();
    expect(screen.getByText("Income")).toBeTruthy();
    expect(screen.getByText("Down payment")).toBeTruthy();
    expect(screen.getByTestId("text-readiness-summary").textContent).toBe("Keep going.");
  });
});
