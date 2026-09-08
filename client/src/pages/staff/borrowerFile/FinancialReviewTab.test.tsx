import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FinancialReviewTab } from "./FinancialReviewTab";
import type { FinancialReviewWorkspace } from "@shared/financialReview";

const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest: request };
});

const key = ["/api/loan-applications", "a", "financial-review"] as const;

function fixture(): FinancialReviewWorkspace {
  return {
    applicationId: "a",
    requiredCount: 1,
    currentApprovedCount: 0,
    canPrepare: true,
    prepareBlockedReason: null,
    canBuildMemo: false,
    memoBlockedReason: "Approve every current workpaper before building the memo.",
    workpapers: [{
      id: "wp-1",
      key: "income_summary:a",
      kind: "income_summary",
      title: "Household qualifying income",
      subjectId: "a",
      subjectLabel: "Household",
      versionNumber: 1,
      inputFingerprint: "a".repeat(64),
      input: { dataVersion: 1, subject: {}, evidenceDocumentIds: ["doc-1"], verifiedFactIds: ["fact-1"] },
      output: {
        kind: "income_summary",
        evaluation: {
          paths: [],
          primaryMonthlyQualifyingIncome: 12000,
          primaryBreakdown: { agencyBase: 6000, agencyVariable: 0, selfEmployment: 5550, rental: 450, rentalIncomeApplied: 450, rentalLiabilityApplied: 0, subjectRentalIncomeApplied: 0 },
          recommendedPathId: null,
          recommendationReason: "Full documentation",
          requiresManualReview: true,
          incomeBasis: "urla_line_items",
        },
        borrowerBreakdown: [{ borrowerSequenceNumber: 1, monthlyIncome: 6000 }, { borrowerSequenceNumber: 2, monthlyIncome: 6000 }],
      },
      sources: [{ documentId: "doc-1", documentName: "Accepted W-2.pdf", documentType: "w2", lineageId: "lineage-1", versionNumber: 2, contentFingerprint: "b".repeat(64), status: "verified", subjectType: "borrower", subjectId: "borrower-1", pages: [1, 2], verifiedFactIds: ["fact-1"] }],
      dependencyVersionIds: [],
      createdAt: "2026-09-04T00:00:00.000Z",
      isCurrent: true,
      blockers: [],
      review: null,
    }],
    memo: null,
  };
}

function setup(data = fixture()) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, queryFn: async () => data }, mutations: { retry: false } } });
  cache.setQueryData(key, data);
  const navigate = vi.fn();
  render(<QueryClientProvider client={cache}><FinancialReviewTab applicationId="a" onNavigate={navigate} /></QueryClientProvider>);
  return { navigate };
}

function approvedMemoFixture() {
  const data = fixture();
  data.currentApprovedCount = 1;
  data.workpapers[0].review = { action: "approve", reason: "Reviewed current evidence.", reviewedBy: "lo", reviewedAt: "2026-09-04T00:00:00.000Z" };
  data.memo = {
    id: "memo-1",
    versionNumber: 1,
    inputFingerprint: "c".repeat(64),
    packageHash: "d".repeat(64),
    workpaperVersionIds: ["wp-1"],
    sections: [{ key: "income", title: "Household income", body: "$12,000 monthly qualifying income.", referenceIds: ["workpaper:wp-1"] }],
    references: [{ type: "document", id: "doc-1", label: "Accepted W-2.pdf · v2 · p. 1, 2" }],
    createdAt: "2026-09-04T00:00:00.000Z",
    isCurrent: true,
    blockers: [],
    review: { action: "approve", reason: "Ready for lender presentation.", reviewedBy: "lo", reviewedAt: "2026-09-04T01:00:00.000Z" },
  };
  return data;
}

describe("Financial Review in the existing officer workspace", () => {
  it("shows the calculation, exact evidence version, and links to existing tools", async () => {
    const { navigate } = setup();
    expect(screen.getByText(/\$12,000/)).toBeTruthy();
    expect(screen.getByText("Accepted W-2.pdf · v2 · page 1, 2")).toBeTruthy();
    await userEvent.click(screen.getByText("Review evidence"));
    expect(navigate).toHaveBeenCalledWith("documents");
    await userEvent.click(screen.getByText("Review tax figures"));
    expect(navigate).toHaveBeenCalledWith("tax-intel");
  });

  it("keeps approval disabled until the officer records a reason", async () => {
    setup();
    const button = screen.getByTestId("approve-income_summary:a");
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.type(screen.getByLabelText("Review reason for Household qualifying income"), "Reviewed current evidence.");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("shows a versioned memo and its source index", () => {
    const data = approvedMemoFixture();
    data.canBuildMemo = true;
    data.memoBlockedReason = null;
    data.memo!.review = null;
    setup(data);
    expect(screen.getByText("Credit memo · version 1")).toBeTruthy();
    expect(screen.getByText("Accepted W-2.pdf · v2 · p. 1, 2")).toBeTruthy();
    expect(screen.getByTestId("approve-credit-memo").hasAttribute("disabled")).toBe(true);
  });

  it("turns an approved current memo into evidence-backed income and asset verification", async () => {
    request.mockResolvedValue(new Response(null, { status: 200 }));
    const data = approvedMemoFixture();
    data.requiredCount = 2;
    data.currentApprovedCount = 2;
    data.workpapers.push({
      ...data.workpapers[0],
      id: "wp-assets",
      key: "asset_reconciliation:a",
      kind: "asset_reconciliation",
      title: "Assets and available funds",
      inputFingerprint: "e".repeat(64),
      output: {
        kind: "asset_reconciliation",
        result: { totalAssets: 100000, liquidAssets: 100000, retirementAssets: 0, reservesMonths: 6, breakdown: [] },
        borrowerSequences: [1],
      },
    });
    setup(data);

    await userEvent.click(screen.getByTestId("apply-reviewed-financial-verification"));
    expect(request).toHaveBeenNthCalledWith(1, "POST", "/api/loan-applications/a/verify/income", {});
    expect(request).toHaveBeenNthCalledWith(2, "POST", "/api/loan-applications/a/verify/assets", {});
  });

  it("does not verify assets from an approved income-only memo", async () => {
    request.mockClear();
    request.mockResolvedValue(new Response(null, { status: 200 }));
    setup(approvedMemoFixture());

    expect(screen.getByTestId("reviewed-dimension-support").textContent).toMatch(/Assets: missing approved workpaper/);
    await userEvent.click(screen.getByTestId("apply-reviewed-financial-verification"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("POST", "/api/loan-applications/a/verify/income", {});
  });
});
