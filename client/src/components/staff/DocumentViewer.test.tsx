import { describe, expect, it } from "vitest";
import { normalizeEvidenceBox } from "./DocumentViewer";

describe("document evidence overlay coordinates", () => {
  it("accepts a normalized source box that stays within the page", () => {
    expect(normalizeEvidenceBox({ x: 0.1, y: 0.2, width: 0.3, height: 0.04 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.04,
    });
  });

  it("refuses malformed, negative, or off-page boxes", () => {
    expect(normalizeEvidenceBox(null)).toBeNull();
    expect(normalizeEvidenceBox({ x: "0.1", y: 0.2, width: 0.3, height: 0.04 })).toBeNull();
    expect(normalizeEvidenceBox({ x: -0.1, y: 0.2, width: 0.3, height: 0.04 })).toBeNull();
    expect(normalizeEvidenceBox({ x: 0.9, y: 0.2, width: 0.3, height: 0.04 })).toBeNull();
  });
});
