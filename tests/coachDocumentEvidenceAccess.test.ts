import { beforeEach, describe, expect, it, vi } from "vitest";

const getLoanApplicationWithAccess = vi.fn();
const getDocumentsByApplication = vi.fn();
const getFactsForDocuments = vi.fn();
const getCurrentApprovedFinancialVerificationEvidence = vi.fn();

vi.mock("../server/storage", () => ({
  storage: {
    getLoanApplicationWithAccess: (...args: unknown[]) => getLoanApplicationWithAccess(...args),
    getDocumentsByApplication: (...args: unknown[]) => getDocumentsByApplication(...args),
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
    getCurrentApprovedFinancialVerificationEvidence.mockResolvedValue({ memo: null, incomeWorkpaperId: null, assetWorkpaperId: null, liabilityWorkpaperId: null });

    const result = await loadCoachDocumentEvidence("app-1", { id: "borrower-1", role: "active_buyer" });

    expect(getFactsForDocuments).toHaveBeenCalledWith(["doc-current"]);
    expect(getCurrentApprovedFinancialVerificationEvidence).toHaveBeenCalledWith("app-1");
    expect(result?.documents.map((item) => item.documentType)).toEqual(["pay_stub"]);
  });

  it("queries facts only for the 12 newest current documents", async () => {
    getLoanApplicationWithAccess.mockResolvedValue({ id: "app-1" });
    const documents = Array.from({ length: 14 }, (_, index) => ({
      id: `doc-${String(index + 1).padStart(2, "0")}`,
      applicationId: "app-1",
      documentType: "pay_stub",
      status: "verifying",
      createdAt: new Date(Date.UTC(2026, 0, index + 1)),
    }));
    getDocumentsByApplication.mockResolvedValue(documents);
    getFactsForDocuments.mockResolvedValue([]);
    getCurrentApprovedFinancialVerificationEvidence.mockResolvedValue({ memo: null, incomeWorkpaperId: null, assetWorkpaperId: null, liabilityWorkpaperId: null });

    const result = await loadCoachDocumentEvidence("app-1", { id: "borrower-1", role: "active_buyer" });

    expect(getFactsForDocuments).toHaveBeenCalledWith([
      "doc-14", "doc-13", "doc-12", "doc-11", "doc-10", "doc-09",
      "doc-08", "doc-07", "doc-06", "doc-05", "doc-04", "doc-03",
    ]);
    expect(result?.summary).toMatchObject({ documentCount: 12, omittedDocumentCount: 2 });
  });
});
