import { describe, it, expect } from "vitest";
import {
  checkTaxReturnConsistency,
  extractBankStatementData,
  extractLeaseData,
  extractPayStubData,
  extractW2Data,
  validateW2Response,
} from "../server/extractionService";
import type { ExtractedTaxReturnData } from "../server/extractionService";
import { extractionSimulationEnabled, getMimeType, mediaBlock } from "../server/extractionCore";

/**
 * Unit tests for the tax-return cross-field consistency hardening. This runs in
 * the real model path only (after schema validation), where it caps the model's
 * self-reported confidence when our own arithmetic contradicts it — a garbled or
 * adversarial extraction must not present itself as high-confidence downstream.
 * The schema-validation and simulate paths are covered in taxInsight.test.ts;
 * this file covers the capping the other tests deliberately assert "did not fire".
 * Pure in-process — no HTTP server, no database.
 */

const extraction = (
  overrides: Partial<ExtractedTaxReturnData> = {},
): ExtractedTaxReturnData => ({
  documentYear: "2025",
  confidence: "high",
  extractedFields: [],
  ...overrides,
});

describe("checkTaxReturnConsistency", () => {
  it("caps confidence to medium when taxable income exceeds gross income", () => {
    const data = extraction({ grossIncome: 100_000, taxableIncome: 120_000 });
    checkTaxReturnConsistency(data);
    expect(data.confidence).toBe("medium");
    expect(data.warnings?.some((w) => /taxable income exceeds gross/i.test(w))).toBe(true);
  });

  it("caps when AGI exceeds gross income", () => {
    const data = extraction({ grossIncome: 100_000, adjustedGrossIncome: 110_000 });
    checkTaxReturnConsistency(data);
    expect(data.confidence).toBe("medium");
    expect(data.warnings?.some((w) => /AGI exceeds gross/i.test(w))).toBe(true);
  });

  it("caps when W-2 wages exceed gross income", () => {
    const data = extraction({ grossIncome: 50_000, w2Wages: 60_000 });
    checkTaxReturnConsistency(data);
    expect(data.confidence).toBe("medium");
    expect(data.warnings?.some((w) => /W-2 wages exceed gross/i.test(w))).toBe(true);
  });

  it("caps when Schedule E net rental income exceeds gross rents", () => {
    const data = extraction({
      scheduleE: { netRentalIncomeLoss: 40_000, grossRents: 30_000 },
    });
    checkTaxReturnConsistency(data);
    expect(data.confidence).toBe("medium");
    expect(data.warnings?.some((w) => /Schedule E net rental/i.test(w))).toBe(true);
  });

  it("leaves a self-consistent high-confidence extraction untouched", () => {
    const data = extraction({
      w2Wages: 68_000,
      grossIncome: 115_000,
      adjustedGrossIncome: 110_000,
      taxableIncome: 95_000,
      scheduleE: { netRentalIncomeLoss: 12_000, grossRents: 36_000 },
    });
    checkTaxReturnConsistency(data);
    expect(data.confidence).toBe("high");
    expect(data.warnings).toBeUndefined();
  });

  it("never raises confidence — a low-confidence extraction with a violation stays low", () => {
    const data = extraction({ confidence: "low", grossIncome: 100_000, taxableIncome: 120_000 });
    checkTaxReturnConsistency(data);
    expect(data.confidence).toBe("low");
    expect(data.warnings?.length).toBeGreaterThan(0);
  });

  it("accumulates a warning per violation", () => {
    const data = extraction({
      grossIncome: 100_000,
      taxableIncome: 120_000,
      adjustedGrossIncome: 130_000,
      w2Wages: 140_000,
    });
    checkTaxReturnConsistency(data);
    expect(data.confidence).toBe("medium");
    expect(data.warnings?.length).toBe(3);
  });
});

describe("deterministic document extraction simulation", () => {
  it("preserves the stored MIME type for extensionless private object paths", () => {
    expect(getMimeType("/objects/9cbbff08-75ab-4ad2-9e32-bb664d05d70a", "image/png"))
      .toBe("image/png");
    expect(mediaBlock("image/png", "c3ludGhldGlj").type).toBe("image");
    expect(mediaBlock("application/pdf", "c3ludGhldGlj").type).toBe("document");
  });

  it("covers pay stubs, W-2s, bank statements, and leases with labeled source evidence", async () => {
    const prior = process.env.EXTRACTION_SIMULATE;
    process.env.EXTRACTION_SIMULATE = "true";
    try {
      const [payStub, w2, bank, lease] = await Promise.all([
        extractPayStubData("/objects/demo-paystub"),
        extractW2Data("/objects/demo-w2"),
        extractBankStatementData("/objects/demo-bank"),
        extractLeaseData(Buffer.from("synthetic lease"), "application/pdf"),
      ]);
      for (const result of [payStub, w2, bank, lease]) {
        expect(result.modelId).toBe("simulated");
        expect(result.confidence).toBe("medium");
        expect(result.extractedFields.length).toBeGreaterThan(0);
        expect(result.warnings?.join(" ")).toMatch(/simulated/i);
        expect(result.pageCount).toBeGreaterThan(0);
        expect(result.documentClassification?.pageCount).toBe(result.pageCount);
        expect(result.documentClassification?.pages).toHaveLength(result.pageCount!);
        for (const fieldName of result.extractedFields) {
          expect(result.fieldEvidence?.[fieldName]).toEqual(expect.objectContaining({
            pageNumber: expect.any(Number),
            confidence: expect.any(Number),
          }));
        }
      }
      await expect(extractPayStubData("/objects/demo-paystub"))
        .resolves.toEqual(payStub);
      expect(w2.documentClassification?.pages[0]?.documentType).toBe("w2");
    } finally {
      process.env.EXTRACTION_SIMULATE = prior;
    }
  });

  it("fails closed before any simulated values can be produced in production", async () => {
    const priorEnvironment = process.env.NODE_ENV;
    const priorSimulation = process.env.EXTRACTION_SIMULATE;
    process.env.NODE_ENV = "production";
    process.env.EXTRACTION_SIMULATE = "true";
    try {
      expect(() => extractionSimulationEnabled()).toThrow(
        "EXTRACTION_SIMULATE cannot be enabled in production",
      );
      const attempts = await Promise.allSettled([
        extractPayStubData("/objects/production-paystub"),
        extractW2Data("/objects/production-w2"),
        extractBankStatementData("/objects/production-bank"),
        extractLeaseData(Buffer.from("production lease"), "application/pdf"),
      ]);
      expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true);
      for (const attempt of attempts) {
        if (attempt.status === "rejected") {
          expect(String(attempt.reason)).toMatch(/cannot be enabled in production/i);
        }
      }
    } finally {
      if (priorEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorEnvironment;
      if (priorSimulation === undefined) delete process.env.EXTRACTION_SIMULATE;
      else process.env.EXTRACTION_SIMULATE = priorSimulation;
    }
  });

  it("keeps only the last four EIN digits and requires page evidence for W-2 values", () => {
    const base = {
      employeeName: "Jane Roe",
      employerName: "Acme LLC",
      taxYear: "2025",
      employerEinLast4: "12-3456789",
      wagesTipsOtherCompensation: 85000,
      confidence: "high",
      extractedFields: ["employeeName", "employerName", "taxYear", "employerEinLast4", "wagesTipsOtherCompensation"],
      fieldEvidence: {
        employeeName: { pageNumber: 1, confidence: 0.98 },
        employerName: { pageNumber: 1, confidence: 0.98 },
        taxYear: { pageNumber: 1, confidence: 0.99 },
        employerEinLast4: { pageNumber: 1, confidence: 0.97 },
        wagesTipsOtherCompensation: { pageNumber: 1, confidence: 0.99 },
      },
      pageCount: 1,
      documentClassification: {
        pageCount: 1,
        pages: [{ pageNumber: 1, documentType: "w2", confidence: 0.99 }],
      },
      employeeSsn: "111-22-3333",
    };
    const valid = validateW2Response(JSON.stringify(base));
    expect(valid?.employerEinLast4).toBe("6789");
    expect(valid).not.toHaveProperty("employeeSsn");

    const missingEvidence = structuredClone(base);
    delete (missingEvidence.fieldEvidence as Record<string, unknown>).wagesTipsOtherCompensation;
    expect(validateW2Response(JSON.stringify(missingEvidence))).toBeNull();
  });
});
