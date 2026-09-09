import { describe, expect, it } from "vitest";
import { validateDocumentClassification } from "../server/extractionService";
import {
  assessDocumentClassification,
  classificationSegments,
} from "../server/services/documentClassification";

describe("simple document page classification", () => {
  it("requires exactly one valid classification for every source page", () => {
    expect(validateDocumentClassification({
      pageCount: 2,
      pages: [
        { pageNumber: 1, documentType: "paystub", confidence: 0.98 },
        { pageNumber: 2, documentType: "paystub", confidence: 0.96 },
      ],
    })).not.toBeNull();

    expect(validateDocumentClassification({
      pageCount: 2,
      pages: [{ pageNumber: 2, documentType: "paystub", confidence: 0.98 }],
    })).toBeNull();
    expect(validateDocumentClassification({
      pageCount: 1,
      pages: [{ pageNumber: 1, documentType: "invented_type", confidence: 0.98 }],
    })).toBeNull();
  });

  it("groups consecutive pages into deterministic packet segments", () => {
    expect(classificationSegments({
      pageCount: 4,
      pages: [
        { pageNumber: 1, documentType: "paystub", confidence: 0.98 },
        { pageNumber: 2, documentType: "paystub", confidence: 0.94 },
        { pageNumber: 3, documentType: "w2", confidence: 0.92 },
        { pageNumber: 4, documentType: "paystub", confidence: 0.9 },
      ],
    })).toEqual([
      { documentType: "paystub", pageStart: 1, pageEnd: 2, confidence: 0.96 },
      { documentType: "w2", pageStart: 3, pageEnd: 3, confidence: 0.92 },
      { documentType: "paystub", pageStart: 4, pageEnd: 4, confidence: 0.9 },
    ]);
  });

  it("accepts a matching packet and blocks a mislabeled or mixed packet", () => {
    const paystub = {
      pageCount: 2,
      pages: [
        { pageNumber: 1, documentType: "paystub" as const, confidence: 0.98 },
        { pageNumber: 2, documentType: "paystub" as const, confidence: 0.96 },
      ],
    };
    expect(assessDocumentClassification("pay_stub", paystub)).toMatchObject({
      compatible: true,
      mixedPacket: false,
    });
    expect(assessDocumentClassification("w2", {
      pageCount: 1,
      pages: [{ pageNumber: 1, documentType: "w2", confidence: 0.99 }],
    })).toMatchObject({ compatible: true, mixedPacket: false });

    expect(assessDocumentClassification("bank_statement", paystub)).toMatchObject({
      compatible: false,
      mixedPacket: false,
    });
    expect(assessDocumentClassification("pay_stub", {
      pageCount: 2,
      pages: [
        paystub.pages[0],
        { pageNumber: 2, documentType: "w2", confidence: 0.97 },
      ],
    })).toMatchObject({ compatible: false, mixedPacket: true });
  });

  it("blocks low-confidence classification even when the page type matches", () => {
    expect(assessDocumentClassification("lease_agreement", {
      pageCount: 1,
      pages: [{ pageNumber: 1, documentType: "lease_agreement", confidence: 0.6 }],
    })).toMatchObject({ compatible: false, minimumConfidence: 0.6 });
  });
});
