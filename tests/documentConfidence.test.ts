import { describe, it, expect } from "vitest";
import {
  classifyDocTypeAccuracyStatus,
  coarseConfidenceToNumeric,
  getReviewThreshold,
} from "../server/services/documentConfidence";

/**
 * Unit tests for the document-confidence quality gate: the coarse high/medium/low
 * → numeric mapping and the per-doc-type review thresholds that decide whether an
 * extraction auto-verifies or lands on the human-review queue. This is the gate
 * every extraction path (incl. the tax-return pipeline) passes through. Pure
 * in-process — no HTTP server, no database.
 */

describe("coarseConfidenceToNumeric", () => {
  it("maps each coarse tier to its representative score", () => {
    expect(coarseConfidenceToNumeric("high")).toBe(0.9);
    expect(coarseConfidenceToNumeric("medium")).toBe(0.7);
    expect(coarseConfidenceToNumeric("low")).toBe(0.4);
  });

  it("is strictly monotonic (high > medium > low)", () => {
    expect(coarseConfidenceToNumeric("high")).toBeGreaterThan(coarseConfidenceToNumeric("medium"));
    expect(coarseConfidenceToNumeric("medium")).toBeGreaterThan(coarseConfidenceToNumeric("low"));
  });
});

describe("getReviewThreshold", () => {
  it("returns the type-specific threshold for known document types", () => {
    expect(getReviewThreshold("tax_return")).toBe(0.85);
    expect(getReviewThreshold("government_id")).toBe(0.9);
    expect(getReviewThreshold("w2")).toBe(0.8);
    expect(getReviewThreshold("pay_stub")).toBe(0.8);
    expect(getReviewThreshold("bank_statement")).toBe(0.8);
  });

  it("falls back to the 0.80 default for an unknown document type", () => {
    expect(getReviewThreshold("something_unrecognized")).toBe(0.8);
  });
});

describe("tax-return review gate (tiering × threshold)", () => {
  // Auto-verify only when the coarse score clears the type threshold; otherwise
  // the document must go to a human before it can be marked "verified".
  const clearsTaxReturnGate = (c: "high" | "medium" | "low") =>
    coarseConfidenceToNumeric(c) >= getReviewThreshold("tax_return");

  it("only a high-confidence tax-return extraction auto-verifies", () => {
    expect(clearsTaxReturnGate("high")).toBe(true);
    expect(clearsTaxReturnGate("medium")).toBe(false);
    expect(clearsTaxReturnGate("low")).toBe(false);
  });
});

describe("classifyDocTypeAccuracyStatus", () => {
  it("does not treat document approvals without field grading as measured accuracy", () => {
    expect(classifyDocTypeAccuracyStatus({
      gradedReviewCount: 0,
      avgAccuracy: null,
      targetAccuracyPct: 85,
      minReviews: 10,
    })).toBe("insufficient_reviews");
  });

  it("requires the minimum number of field-graded reviews", () => {
    expect(classifyDocTypeAccuracyStatus({
      gradedReviewCount: 9,
      avgAccuracy: 99,
      targetAccuracyPct: 85,
      minReviews: 10,
    })).toBe("insufficient_reviews");
  });

  it("flags measured accuracy below target and clears accuracy at target", () => {
    expect(classifyDocTypeAccuracyStatus({
      gradedReviewCount: 10,
      avgAccuracy: 84.99,
      targetAccuracyPct: 85,
      minReviews: 10,
    })).toBe("below_target");
    expect(classifyDocTypeAccuracyStatus({
      gradedReviewCount: 10,
      avgAccuracy: 85,
      targetAccuracyPct: 85,
      minReviews: 10,
    })).toBe("ok");
  });
});
