import { describe, expect, it } from "vitest";
import { expectedBorrowerSequences } from "../server/services/borrowerSequences";

describe("expected borrower sequences", () => {
  it("always includes the primary borrower and unions every URLA source", () => {
    expect(expectedBorrowerSequences([])).toEqual([1]);
    expect(expectedBorrowerSequences([
      { borrowerSequenceNumber: 2 },
      { borrowerSequenceNumber: 4 },
    ])).toEqual([1, 2, 4]);
  });

  it("expands a declared borrower count so an incompletely saved co-borrower cannot disappear", () => {
    expect(expectedBorrowerSequences([{ borrowerSequenceNumber: 1, totalBorrowers: 3 }])).toEqual([1, 2, 3]);
  });

  it("ignores malformed and implausibly large sequence values", () => {
    expect(expectedBorrowerSequences([
      { borrowerSequenceNumber: 0, totalBorrowers: 99 },
      { borrowerSequenceNumber: 2.5, totalBorrowers: -1 },
    ])).toEqual([1]);
  });
});
