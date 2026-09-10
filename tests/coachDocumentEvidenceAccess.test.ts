import { beforeEach, describe, expect, it, vi } from "vitest";

const getLoanApplicationWithAccess = vi.fn();
const getDocumentsByApplication = vi.fn();
const getTaxInsightsByUser = vi.fn();
const getFactsForDocuments = vi.fn();
const getCurrentApprovedFinancialVerificationEvidence = vi.fn();

vi.mock("../server/storage", () => ({
  storage: {
    getLoanApplicationWithAccess: (...args: unknown[]) => getLoanApplicationWithAccess(...args),
    getDocumentsByApplication: (...args: unknown[]) => getDocumentsByApplication(...args),
    getTaxInsightsByUser: (...args: unknown[]) => getTaxInsightsByUser(...args),
  },
}));

vi.mock("../server/services/documentFacts", () => ({
  getFactsForDocuments: (...args: unknown[]) => getFactsForDocuments(...args),
}));

vi.mock("../server/services/financialReview", () => ({
  getCurrentApprovedFinancialVerificationEvidence: (...args: unknown[]) =>
    getCurrentApprovedFinancialVerificationEvidence(...args),
}));

import { loadCoachDocumentEvidence } from "../server/services/coachDocumentEvidence";

describe("Homi document-evidence authorization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops before every evidence read when application access is denied", async () => {
    getLoanApplicationWithAccess.mockResolvedValue(undefined);

    const result = await loadCoachDocumentEvidence("app-other", { id: "borrower-1", role: "active_buyer" });

    expect(result).toBeNull();
    expect(getLoanApplicationWithAccess).toHaveBeenCalledWith("app-other", "borrower-1", "active_buyer");
    expect(getDocumentsByApplication).not.toHaveBeenCalled();
    expect(getFactsForDocuments).not.toHaveBeenCalled();
    expect(getTaxInsightsByUser).not.toHaveBeenCalled();
    expect(getCurrentApprovedFinancialVerificationEvidence).not.toHaveBeenCalled();
  });

  it("reads only the re-authorized application's current non-rejected documents", async () => {
    getLoanApplicationWithAccess.mockResolvedValue({ id: "app-1" });
    getDocumentsByApplication.mockResolvedValue([
      { id: "doc-current", applicationId: "app-1", documentType: "pay_stub", status: "verifying", createdAt: new Date() },
      { id: "doc-rejected", applicationId: "app-1", documentType: "bank_statement", status: "rejected", createdAt: new Date() },
      { id: "doc-other", applicationId: "app-other", documentType: "tax_return", status: "verified", createdAt: new Date() },
    ]);
    getFactsForDocuments.mockResolvedValue([]);
    getTaxInsightsByUser.mockResolvedValue([
      { documentId: "doc-current", taxYear: 2025, confidence: "high" },
      { documentId: "doc-other", taxYear: 2024, confidence: "high" },
    ]);
    getCurrentApprovedFinancialVerificationEvidence.mockResolvedValue({ memo: null, incomeWorkpaperId: null, assetWorkpaperId: null });

    const result = await loadCoachDocumentEvidence("app-1", { id: "borrower-1", role: "active_buyer" });

    expect(getFactsForDocuments).toHaveBeenCalledWith(["doc-current"]);
    expect(getTaxInsightsByUser).toHaveBeenCalledWith("borrower-1");
    expect(getCurrentApprovedFinancialVerificationEvidence).toHaveBeenCalledWith("app-1");
    expect(result?.documents.map((item) => item.documentType)).toEqual(["pay_stub"]);
  });
});
