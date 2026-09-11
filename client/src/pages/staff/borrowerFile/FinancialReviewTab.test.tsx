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
    bankStatementAnalysis: null,
    bankStatementEvidence: { documentCount: 0, reviewedDepositFactCount: 0, observedTotalDeposits: 0, datedStatementCount: 0, consecutiveMonthCoverage: 0, periodStart: null, periodEnd: null },
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
      sources: [{ documentId: "doc-1", documentName: "Accepted W-2.pdf", documentType: "w2", lineageId: "lineage-1", versionNumber: 2, contentFingerprint: "b".repeat(64), status: "verified", subjectType: "borrower", subjectId: "borrower-1", pages: [1, 2], verifiedFactIds: ["fact-1"], verifiedFacts: [{ id: "fact-1", fieldName: "w2_box_1_wages", value: 72000, valueType: "currency", pageNumber: 1 }] }],
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
  const openEvidence = vi.fn();
  render(<QueryClientProvider client={cache}><FinancialReviewTab applicationId="a" onNavigate={navigate} onOpenEvidence={openEvidence} /></QueryClientProvider>);
  return { navigate, openEvidence };
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
    references: [
      { type: "document", id: "doc-1", documentId: "doc-1", label: "Accepted W-2.pdf · v2 · p. 1, 2", pageNumber: 1 },
      { type: "verified_fact", id: "fact-1", documentId: "doc-1", label: "W-2 Box 1 wages: $72,000 · Accepted W-2.pdf · p. 2", pageNumber: 2 },
    ],
    createdAt: "2026-09-04T00:00:00.000Z",
    isCurrent: true,
    blockers: [],
    review: { action: "approve", reason: "Ready for lender presentation.", reviewedBy: "lo", reviewedAt: "2026-09-04T01:00:00.000Z" },
  };
  return data;
}

describe("Financial Review in the existing officer workspace", () => {
  it("shows the calculation, exact evidence version, and links to existing tools", async () => {
    const { navigate, openEvidence } = setup();
    expect(screen.getByText(/\$12,000/)).toBeTruthy();
    expect(screen.getByTestId("open-workpaper-source-doc-1").textContent).toContain(
      "Accepted W-2.pdf · v2 · page 1, 2",
    );
    expect(screen.getByText("1 human-reviewed financial figure")).toBeTruthy();
    await userEvent.click(screen.getByText("1 human-reviewed financial figure"));
    expect(screen.getByText("$72,000")).toBeTruthy();
    await userEvent.click(screen.getByText("Review evidence"));
    expect(navigate).toHaveBeenCalledWith("documents");
    await userEvent.click(screen.getByText("Review tax figures"));
    expect(navigate).toHaveBeenCalledWith("tax-intel");
    await userEvent.click(screen.getByTestId("open-workpaper-source-doc-1"));
    expect(openEvidence).toHaveBeenCalledWith("doc-1", 1);
    await userEvent.click(screen.getByTestId("open-workpaper-fact-fact-1"));
    expect(openEvidence).toHaveBeenCalledWith("doc-1", 1);
  });

  it("keeps approval disabled until the officer records a reason", async () => {
    setup();
    const button = screen.getByTestId("approve-income_summary:a");
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.type(screen.getByLabelText("Review reason for Household qualifying income"), "Reviewed current evidence.");
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("requires the officer to acknowledge a document variance before approval", async () => {
    request.mockClear();
    request.mockResolvedValue(new Response(null, { status: 201 }));
    const data = fixture();
    data.workpapers[0].input.evidenceComparisons = [{
      id: "income:doc-1:fact-1",
      kind: "income",
      status: "variance",
      documentId: "doc-1",
      verifiedFactIds: ["fact-1"],
      label: "Pay statement · Fictional Hospital",
      evidenceValue: 6500,
      calculationValue: 6000,
      variance: 500,
      tolerance: 65,
      detail: "The reviewed document differs from the calculation input.",
    }];
    setup(data);
    const button = screen.getByTestId("approve-income_summary:a");
    await userEvent.type(screen.getByLabelText("Review reason for Household qualifying income"), "Confirmed variable pay treatment.");
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByLabelText("Acknowledge Pay statement · Fictional Hospital"));
    expect(button.hasAttribute("disabled")).toBe(false);
    await userEvent.click(button);
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/loan-applications/a/financial-review/workpapers/wp-1/review",
      expect.objectContaining({ acknowledgedComparisonIds: ["income:doc-1:fact-1"] }),
    );
  });

  it("shows the reviewed bureau liability ledger and the higher decision debt", async () => {
    const data = fixture();
    data.workpapers[0] = {
      ...data.workpapers[0],
      key: "liability_reconciliation:a",
      kind: "liability_reconciliation",
      title: "Liability reconciliation",
      output: {
        kind: "liability_reconciliation",
        result: { totalMonthlyPayment: 450, excludedDebts: 0, openThirtyDayBalance: 0, breakdown: [] },
        borrowerSequences: [1],
        bureau: {
          pullId: "credit-1",
          representativeScore: 730,
          borrowerScores: [
            { borrowerSequenceNumber: 1, experianScore: 740, equifaxScore: 730, transunionScore: 720, representativeScore: 730 },
            { borrowerSequenceNumber: 2, experianScore: 760, equifaxScore: 750, transunionScore: 740, representativeScore: 750 },
          ],
          reportedMonthlyPayments: 550,
          adjustedMonthlyDebt: 750,
          tradelineCount: 1,
          fingerprint: "f".repeat(64),
          tradelines: [{ creditor: "Fictional Servicer", type: "student_loan", balance: 20000, monthlyPayment: 0, deferred: true, openedDaysAgo: null }],
        },
        decisionMonthlyPayment: 750,
        openThirtyDayBalance: 0,
        treatmentCandidates: [],
        subjectPropertyFinancing: {
          captured: false, complete: true, missingItems: [],
          monthlyAssociationDues: 0, monthlyFloodInsurance: 0, monthlyGroundRent: 0,
          monthlySpecialAssessments: 0, monthlySubordinateFinancingPayment: 0,
          monthlyHousingExpenseAdditions: 0, subordinateFinancingExists: null,
          closedEndSubordinateBalance: 0, helocDrawnBalance: 0, helocCreditLimit: 0,
          cltv: null, hcltv: null,
        },
      },
    };
    setup(data);
    expect(screen.getByText("$450")).toBeTruthy();
    expect(screen.getAllByText("$750").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByText(/Bureau liability ledger/));
    expect(screen.getByText("Fictional Servicer")).toBeTruthy();
    expect(screen.getByText(/Representative score 730/)).toBeTruthy();
    expect(screen.getByText("Borrower 1")).toBeTruthy();
    expect(screen.getByText("Borrower 2")).toBeTruthy();
  });

  it("lets the officer link a documented debt treatment to source evidence and the exact bureau line", async () => {
    request.mockClear();
    request.mockResolvedValue(new Response(null, { status: 200 }));
    const data = fixture();
    data.workpapers[0] = {
      ...data.workpapers[0],
      key: "liability_reconciliation:a",
      kind: "liability_reconciliation",
      title: "Liability reconciliation",
      sources: [{ ...data.workpapers[0].sources[0], documentName: "Current student loan statement.pdf", documentType: "student_loan_statement" }],
      output: {
        kind: "liability_reconciliation",
        result: { totalMonthlyPayment: 400, excludedDebts: 0, openThirtyDayBalance: 0, breakdown: [] },
        borrowerSequences: [1],
        bureau: {
          pullId: "credit-1",
          representativeScore: 730,
          borrowerScores: [{ borrowerSequenceNumber: 1, experianScore: 740, equifaxScore: 730, transunionScore: 720, representativeScore: 730 }],
          reportedMonthlyPayments: 0,
          adjustedMonthlyDebt: 400,
          tradelineCount: 1,
          fingerprint: "f".repeat(64),
          tradelines: [{ creditor: "Fictional Servicer", type: "student_loan", balance: 40000, monthlyPayment: 0, deferred: true, openedDaysAgo: null }],
        },
        decisionMonthlyPayment: 400,
        openThirtyDayBalance: 0,
        treatmentCandidates: [{
          liabilityId: "liability-1",
          borrowerSequenceNumber: 1,
          creditorName: "Fictional Servicer",
          liabilityType: "Student Loan",
          remainingTermMonths: null,
          studentLoanRepaymentPlan: "income_driven",
          recommendedTreatment: "documented_zero_student_loan",
          currentTreatment: null,
          sourceDocumentId: null,
          creditPullId: null,
          tradelineIndex: null,
          evidenceCurrent: false,
          bureauLinkCurrent: false,
        }],
        subjectPropertyFinancing: {
          captured: true, complete: true, missingItems: [],
          monthlyAssociationDues: 350, monthlyFloodInsurance: 0, monthlyGroundRent: 0,
          monthlySpecialAssessments: 75, monthlySubordinateFinancingPayment: 225,
          monthlyHousingExpenseAdditions: 650, subordinateFinancingExists: true,
          closedEndSubordinateBalance: 20000, helocDrawnBalance: 0, helocCreditLimit: 0,
          cltv: 84, hcltv: 84,
        },
      },
    };
    setup(data);
    expect(screen.getByText("Documented debt treatment")).toBeTruthy();
    const apply = screen.getByTestId("apply-liability-treatment-liability-1");
    expect(apply.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByLabelText("Source statement for Fictional Servicer"));
    await userEvent.click(screen.getByRole("option", { name: /Current student loan statement\.pdf/ }));
    await userEvent.click(screen.getByLabelText("Bureau account for Fictional Servicer"));
    await userEvent.click(screen.getByRole("option", { name: /Fictional Servicer · student loan/ }));
    expect(apply.hasAttribute("disabled")).toBe(false);
    await userEvent.click(apply);
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/loan-applications/a/financial-review/liabilities/liability-1/treatment",
      {
        treatment: "documented_zero_student_loan",
        sourceDocumentId: "doc-1",
        creditPullId: "credit-1",
        tradelineIndex: 0,
      },
    );
  });

  it("turns reviewed statement deposits into a staff-screened analysis draft", async () => {
    request.mockClear();
    request.mockResolvedValue(new Response(null, { status: 201 }));
    const data = fixture();
    data.bankStatementEvidence = { documentCount: 12, reviewedDepositFactCount: 12, observedTotalDeposits: 240000, datedStatementCount: 12, consecutiveMonthCoverage: 12, periodStart: "2025-10-01", periodEnd: "2026-09-30" };
    setup(data);
    expect(screen.getByText(/12 accepted statements/)).toBeTruthy();
    await userEvent.click(screen.getByText("Use observed total as a draft"));
    await userEvent.type(screen.getByLabelText("Screening notes"), "Excluded transfers and duplicate deposits.");
    await userEvent.click(screen.getByTestId("save-bank-statement-analysis"));
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/applications/a/bank-statement-analysis",
      expect.objectContaining({ months: 12, totalEligibleDeposits: 240000 }),
    );
  });

  it("shows a versioned memo and opens a cited source", async () => {
    const data = approvedMemoFixture();
    data.canBuildMemo = true;
    data.memoBlockedReason = null;
    data.memo!.review = null;
    const { openEvidence } = setup(data);
    expect(screen.getByText("Credit memo · version 1")).toBeTruthy();
    await userEvent.click(screen.getByTestId("open-memo-source-doc-1"));
    expect(openEvidence).toHaveBeenCalledWith("doc-1", 1);
    await userEvent.click(screen.getByTestId("open-memo-source-fact-1"));
    expect(openEvidence).toHaveBeenCalledWith("doc-1", 2);
    expect(screen.getByTestId("approve-credit-memo").hasAttribute("disabled")).toBe(true);
  });

  it("turns an approved current memo into evidence-backed income and asset verification", async () => {
    request.mockClear();
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
