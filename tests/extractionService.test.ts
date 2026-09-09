import { describe, it, expect } from "vitest";
import {
  checkTaxReturnConsistency,
  extractBankStatementData,
  extractLeaseData,
  extractPayStubData,
} from "../server/extractionService";
import type { ExtractedTaxReturnData } from "../server/extractionService";
import { extractionSimulationEnabled } from "../server/extractionCore";

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
  it("covers pay stubs, bank statements, and leases with labeled source evidence", async () => {
    const prior = process.env.EXTRACTION_SIMULATE;
    process.env.EXTRACTION_SIMULATE = "true";
    try {
      const [payStub, bank, lease] = await Promise.all([
        extractPayStubData("/objects/demo-paystub"),
        extractBankStatementData("/objects/demo-bank"),
        extractLeaseData(Buffer.from("synthetic lease"), "application/pdf"),
      ]);
      for (const result of [payStub, bank, lease]) {
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
});
