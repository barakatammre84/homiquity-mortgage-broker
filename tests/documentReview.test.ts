import { describe, it, expect } from "vitest";
import {
  parseExtractionNotes,
  documentReviewGroup,
  compareExtractedToStated,
  annualizePayStubGross,
  isExtractableDocumentType,
} from "../client/src/lib/documentReview";

describe("parseExtractionNotes", () => {
  it("parses the routes/documents.ts writer shape (full lineage)", () => {
    const notes = JSON.stringify({
      extractedAt: "2026-07-17T10:00:00.000Z",
      extractedFields: ["grossIncome", "adjustedGrossIncome"],
      confidence: "medium",
      humanReviewRequired: true,
      warnings: ["Simulated extraction"],
      modelId: "claude-sonnet-5",
      promptVersion: "tax-1.2.0",
      responseHash: "abc123",
    });
    const parsed = parseExtractionNotes(notes);
    expect(parsed).not.toBeNull();
    expect(parsed!.confidence).toBe("medium");
    expect(parsed!.humanReviewRequired).toBe(true);
    expect(parsed!.extractedFields).toEqual(["grossIncome", "adjustedGrossIncome"]);
    expect(parsed!.warnings).toEqual(["Simulated extraction"]);
    expect(parsed!.extractedAt).toBe("2026-07-17T10:00:00.000Z");
  });

  it("parses the auto-extract writer shape (no lineage fields)", () => {
    const notes = JSON.stringify({
      extractedAt: "2026-07-17T10:00:00.000Z",
      extractedFields: ["grossPay", "employerName"],
      confidence: "high",
      humanReviewRequired: false,
      warnings: [],
    });
    const parsed = parseExtractionNotes(notes);
    expect(parsed).not.toBeNull();
    expect(parsed!.confidence).toBe("high");
    expect(parsed!.humanReviewRequired).toBe(false);
  });

  it("tolerates legacy value-bearing blobs (the shape the coach reads)", () => {
    const notes = JSON.stringify({
      grossIncome: 150000,
      employerName: "Acme Corp",
      confidence: "high",
    });
    const parsed = parseExtractionNotes(notes);
    expect(parsed).not.toBeNull();
    expect(parsed!.confidence).toBe("high");
    expect(parsed!.extractedFields).toEqual([]);
  });

  it("returns null for a plain-text description", () => {
    expect(parseExtractionNotes("W-2 uploaded via the coach")).toBeNull();
  });

  it("returns null for null/undefined/empty", () => {
    expect(parseExtractionNotes(null)).toBeNull();
    expect(parseExtractionNotes(undefined)).toBeNull();
    expect(parseExtractionNotes("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseExtractionNotes("{not json")).toBeNull();
  });

  it("returns null for JSON without any extraction marker", () => {
    expect(parseExtractionNotes(JSON.stringify({ description: "just a note" }))).toBeNull();
    expect(parseExtractionNotes(JSON.stringify([1, 2, 3]))).toBeNull();
    expect(parseExtractionNotes(JSON.stringify("a string"))).toBeNull();
  });

  it("drops non-string entries from fields and warnings", () => {
    const parsed = parseExtractionNotes(
      JSON.stringify({ confidence: "low", extractedFields: ["a", 1, null], warnings: [2, "real"] }),
    );
    expect(parsed!.extractedFields).toEqual(["a"]);
    expect(parsed!.warnings).toEqual(["real"]);
  });
});

describe("documentReviewGroup", () => {
  const reviewNotes = JSON.stringify({ confidence: "medium", humanReviewRequired: true, extractedFields: [] });

  it("stages 'verifying' as needs_review regardless of notes", () => {
    expect(documentReviewGroup({ status: "verifying", notes: null })).toBe("needs_review");
  });

  it("stages 'uploaded' with humanReviewRequired as needs_review", () => {
    expect(documentReviewGroup({ status: "uploaded", notes: reviewNotes })).toBe("needs_review");
  });

  it("treats a null status like 'uploaded'", () => {
    expect(documentReviewGroup({ status: null, notes: reviewNotes })).toBe("needs_review");
    expect(documentReviewGroup({ status: null, notes: null })).toBe("other");
  });

  it("keeps plain uploads in 'other'", () => {
    expect(documentReviewGroup({ status: "uploaded", notes: "a description" })).toBe("other");
    expect(
      documentReviewGroup({
        status: "uploaded",
        notes: JSON.stringify({ confidence: "high", humanReviewRequired: false }),
      }),
    ).toBe("other");
  });

  it("buckets terminal statuses", () => {
    expect(documentReviewGroup({ status: "verified", notes: reviewNotes })).toBe("verified");
    expect(documentReviewGroup({ status: "rejected", notes: reviewNotes })).toBe("rejected");
  });
});

describe("annualizePayStubGross", () => {
  it("annualizes a biweekly period", () => {
    // 2026-06-01 → 2026-06-14 inclusive = 14 days
    const annual = annualizePayStubGross(5000, "2026-06-01", "2026-06-14");
    expect(annual).toBeCloseTo(5000 * (365 / 14), 5);
  });

  it("annualizes a weekly period", () => {
    const annual = annualizePayStubGross(1200, "2026-06-01", "2026-06-07");
    expect(annual).toBeCloseTo(1200 * (365 / 7), 5);
  });

  it("returns null without dates", () => {
    expect(annualizePayStubGross(5000, undefined, undefined)).toBeNull();
    expect(annualizePayStubGross(5000, "2026-06-01", "not a date")).toBeNull();
  });

  it("returns null for nonsensical periods", () => {
    expect(annualizePayStubGross(5000, "2026-06-14", "2026-06-01")).toBeNull(); // negative
    expect(annualizePayStubGross(5000, "2026-01-01", "2026-06-01")).toBeNull(); // > 62 days
  });

  it("returns null without a gross figure", () => {
    expect(annualizePayStubGross(null, "2026-06-01", "2026-06-14")).toBeNull();
  });
});

describe("compareExtractedToStated", () => {
  it("tax_return: within ±20% is consistent (boundary inclusive)", () => {
    const at10 = compareExtractedToStated("tax_return", { grossIncome: 165000 }, { annualIncome: "150000" });
    expect(at10[0].verdict).toBe("consistent");

    const at20 = compareExtractedToStated("tax_return", { grossIncome: 120000 }, { annualIncome: 100000 });
    expect(at20[0].verdict).toBe("consistent");

    const over = compareExtractedToStated("tax_return", { grossIncome: 121000 }, { annualIncome: 100000 });
    expect(over[0].verdict).toBe("variance");
  });

  it("tax_return: missing either side is insufficient_data", () => {
    expect(compareExtractedToStated("tax_return", {}, { annualIncome: 100000 })[0].verdict).toBe(
      "insufficient_data",
    );
    expect(compareExtractedToStated("tax_return", { grossIncome: 100000 }, {})[0].verdict).toBe(
      "insufficient_data",
    );
  });

  it("pay_stub: annualizes from the pay period and compares income", () => {
    const rows = compareExtractedToStated(
      "pay_stub",
      {
        grossPay: 5000,
        payPeriodStartDate: "2026-06-01",
        payPeriodEndDate: "2026-06-14",
        employerName: "Acme Corp",
      },
      { annualIncome: 130000, employerName: "acme corp" },
    );
    // 5000 * 365/14 ≈ 130,357 vs 130,000 → consistent
    expect(rows[0].verdict).toBe("consistent");
    expect(rows[1].verdict).toBe("consistent"); // employer, case-insensitive
  });

  it("pay_stub: employer mismatch is a variance; missing dates degrade the income row", () => {
    const rows = compareExtractedToStated(
      "pay_stub",
      { grossPay: 5000, employerName: "Globex" },
      { annualIncome: 130000, employerName: "Acme Corp" },
    );
    expect(rows[0].verdict).toBe("insufficient_data");
    expect(rows[0].note).toMatch(/cannot annualize/i);
    expect(rows[1].verdict).toBe("variance");
  });

  it("bank_statement: closing balance covering the down payment is consistent", () => {
    const covers = compareExtractedToStated(
      "bank_statement",
      { closingBalance: 84210 },
      { downPayment: "60000" },
    );
    expect(covers[0].verdict).toBe("consistent");

    const short = compareExtractedToStated(
      "bank_statement",
      { closingBalance: 20000 },
      { downPayment: 60000 },
    );
    expect(short[0].verdict).toBe("variance");

    const unknown = compareExtractedToStated("bank_statement", { closingBalance: 20000 }, {});
    expect(unknown[0].verdict).toBe("insufficient_data");
  });

  it("parses currency-formatted stated values", () => {
    const rows = compareExtractedToStated(
      "tax_return",
      { grossIncome: 150000 },
      { annualIncome: "$150,000" },
    );
    expect(rows[0].verdict).toBe("consistent");
  });

  it("returns no rows for types without compare rules", () => {
    expect(compareExtractedToStated("lease_agreement", { monthlyRent: 2000 }, {})).toEqual([]);
  });
});

describe("extractable-type gate (UI mirror of the /extract support list)", () => {
  // The verify-role gate mirror is covered by tests/documentStatus.test.ts
  // (shared/documentStatus.ts owns DOCUMENT_REVIEW_ROLES).
  it("matches the /extract supported-type list", () => {
    for (const t of ["tax_return", "pay_stub", "w2", "bank_statement", "lease_agreement"]) {
      expect(isExtractableDocumentType(t)).toBe(true);
    }
    expect(isExtractableDocumentType(null)).toBe(false);
  });
});
