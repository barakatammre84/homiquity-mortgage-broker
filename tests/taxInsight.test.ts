import { describe, it, expect } from "vitest";
import { validateTaxReturnResponse, extractTaxReturnData } from "../server/extractionService";
import {
  deriveTaxInsight,
  deriveTaxInsightFromStructuredRun,
} from "../server/services/taxInsightService";
import type { ExtractedTaxReturnData } from "../server/extractionService";

/**
 * Unit tests for the tax-return extraction schema (untrusted model output)
 * and the tax-insight derivation (readiness/DSCR signals). Pure in-process —
 * no HTTP server, no database writes.
 */

const modelResponse = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    documentYear: "2025",
    taxpayerName: "Jordan Sample",
    w2Wages: 68000,
    grossIncome: 115000,
    adjustedGrossIncome: 110000,
    taxableIncome: 95000,
    filingStatus: "single",
    scheduleC: { businessIncome: 50000, businessExpenses: 15000, netProfitLoss: 35000 },
    scheduleE: {
      netRentalIncomeLoss: 12000,
      grossRents: 36000,
      totalDepreciation: 8000,
      mortgageInterest: 9000,
      propertyCount: 2,
    },
    confidence: "high",
    extractedFields: ["w2Wages", "grossIncome", "scheduleE"],
    warnings: [],
    fieldEvidence: {
      taxpayerName: { pageNumber: 1, confidence: 0.99 },
      w2Wages: { pageNumber: 1, confidence: 0.99 },
      grossIncome: { pageNumber: 1, confidence: 0.99 },
      adjustedGrossIncome: { pageNumber: 1, confidence: 0.99 },
      taxableIncome: { pageNumber: 1, confidence: 0.99 },
      filingStatus: { pageNumber: 1, confidence: 0.99 },
      "scheduleC.businessIncome": { pageNumber: 3, confidence: 0.98 },
      "scheduleC.businessExpenses": { pageNumber: 3, confidence: 0.98 },
      "scheduleC.netProfitLoss": { pageNumber: 3, confidence: 0.98 },
      "scheduleE.netRentalIncomeLoss": { pageNumber: 5, confidence: 0.97 },
      "scheduleE.grossRents": { pageNumber: 5, confidence: 0.97 },
      "scheduleE.totalDepreciation": { pageNumber: 5, confidence: 0.97 },
      "scheduleE.mortgageInterest": { pageNumber: 5, confidence: 0.97 },
      "scheduleE.propertyCount": { pageNumber: 5, confidence: 0.97 },
    },
    pageCount: 6,
    ...overrides,
  });

describe("tax return schema validation (Schedule E + W-2)", () => {
  it("parses a full response including Schedule E and W-2 wages", () => {
    const parsed = validateTaxReturnResponse(modelResponse());
    expect(parsed).not.toBeNull();
    expect(parsed!.w2Wages).toBe(68000);
    expect(parsed!.scheduleE?.netRentalIncomeLoss).toBe(12000);
    expect(parsed!.scheduleE?.grossRents).toBe(36000);
    expect(parsed!.scheduleE?.propertyCount).toBe(2);
  });

  it("coerces currency-formatted strings to numbers", () => {
    const parsed = validateTaxReturnResponse(
      modelResponse({ scheduleE: { grossRents: "$36,000.00", netRentalIncomeLoss: "12,000" } }),
    );
    expect(parsed!.scheduleE?.grossRents).toBe(36000);
    expect(parsed!.scheduleE?.netRentalIncomeLoss).toBe(12000);
  });

  it("drops out-of-range values instead of trusting them (prompt-injection posture)", () => {
    const parsed = validateTaxReturnResponse(
      modelResponse({
        w2Wages: 2_000_000_000_000, // > MAX_MONEY — dropped
        scheduleE: { propertyCount: 999, grossRents: 36000 }, // count > 50 — dropped
      }),
    );
    expect(parsed!.w2Wages).toBeUndefined();
    expect(parsed!.scheduleE?.propertyCount).toBeUndefined();
    expect(parsed!.scheduleE?.grossRents).toBe(36000);
  });

  it("returns null for a structurally unusable payload", () => {
    expect(validateTaxReturnResponse("I am not JSON at all")).toBeNull();
    expect(validateTaxReturnResponse("")).toBeNull();
  });
});

const baseExtraction = (overrides: Partial<ExtractedTaxReturnData> = {}): ExtractedTaxReturnData => ({
  documentYear: "2025",
  confidence: "medium",
  extractedFields: [],
  ...overrides,
});

describe("deriveTaxInsight", () => {
  it("flags a DSCR candidate when Schedule E is present with usable confidence", () => {
    const insight = deriveTaxInsight(
      baseExtraction({
        scheduleE: { netRentalIncomeLoss: 12000, grossRents: 36000, propertyCount: 2 },
        confidence: "high",
      }),
    );
    expect(insight.dscrCandidate).toBe(true);
    expect(insight.scheduleENetRental).toBe("12000.00");
    expect(insight.rentalPropertyCount).toBe(2);
    expect(insight.taxYear).toBe(2025);
  });

  it("does NOT flag DSCR on a low-confidence extraction", () => {
    const insight = deriveTaxInsight(
      baseExtraction({
        scheduleE: { netRentalIncomeLoss: 12000, propertyCount: 2 },
        confidence: "low",
      }),
    );
    expect(insight.dscrCandidate).toBe(false);
    expect(insight.confidence).toBe("low");
  });

  it("flags self-employed from Schedule C without flagging DSCR", () => {
    const insight = deriveTaxInsight(
      baseExtraction({ scheduleC: { netProfitLoss: 35000 }, w2Wages: 68000 }),
    );
    expect(insight.selfEmployed).toBe(true);
    expect(insight.dscrCandidate).toBe(false);
    expect(insight.wagesW2).toBe("68000.00");
    expect(insight.scheduleCNetProfit).toBe("35000.00");
  });

  it("derives no flags and null money fields from an empty extraction", () => {
    const insight = deriveTaxInsight(baseExtraction());
    expect(insight.selfEmployed).toBe(false);
    expect(insight.dscrCandidate).toBe(false);
    expect(insight.wagesW2).toBeNull();
    expect(insight.grossIncome).toBeNull();
    expect(insight.scheduleENetRental).toBeNull();
    expect(insight.rentalPropertyCount).toBeNull();
  });

  it("negative Schedule E (rental loss) still marks the investor signal", () => {
    const insight = deriveTaxInsight(
      baseExtraction({ scheduleE: { netRentalIncomeLoss: -4000, grossRents: 30000, propertyCount: 1 } }),
    );
    expect(insight.dscrCandidate).toBe(true);
    expect(insight.scheduleENetRental).toBe("-4000.00");
  });

  it("falls back to the prior year when documentYear is unparseable", () => {
    const insight = deriveTaxInsight(baseExtraction({ documentYear: "unknown" }));
    expect(insight.taxYear).toBe(new Date().getFullYear() - 1);
  });
});

describe("deriveTaxInsightFromStructuredRun", () => {
  it("feeds the borrower snapshot from the richer multi-form package without double counting", () => {
    const insight = deriveTaxInsightFromStructuredRun({
      runId: "run-1",
      documentId: "doc-1",
      status: "completed",
      simulated: false,
      modelId: "model-1",
      promptVersion: "tax-v1",
      pageCount: 20,
      formCount: 4,
      overallConfidence: 0.9,
      humanReviewRequired: false,
      warnings: [],
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      forms: [
        {
          logicalDocumentId: "1040",
          formType: "tax_return_1040",
          taxYear: 2025,
          entityName: null,
          k1Variant: null,
          pageStart: 1,
          pageEnd: 2,
          classificationConfidence: 0.95,
          fields: {
            wagesSalariesTips: { value: 68_000, confidence: 0.95 },
            totalIncome: { value: 115_000, confidence: 0.92 },
            adjustedGrossIncome: { value: 110_000, confidence: 0.91 },
          },
          warnings: [],
        },
        {
          logicalDocumentId: "schedule-c-1",
          formType: "schedule_c",
          taxYear: 2025,
          entityName: "Consulting One",
          k1Variant: null,
          pageStart: 3,
          pageEnd: 4,
          classificationConfidence: 0.9,
          fields: { netProfitOrLoss: { value: 20_000, confidence: 0.9 } },
          warnings: [],
        },
        {
          logicalDocumentId: "schedule-c-2",
          formType: "schedule_c",
          taxYear: 2025,
          entityName: "Consulting Two",
          k1Variant: null,
          pageStart: 5,
          pageEnd: 6,
          classificationConfidence: 0.9,
          fields: { netProfitOrLoss: { value: 15_000, confidence: 0.9 } },
          warnings: [],
        },
        {
          logicalDocumentId: "schedule-e",
          formType: "schedule_e",
          taxYear: 2025,
          entityName: null,
          k1Variant: null,
          pageStart: 7,
          pageEnd: 8,
          classificationConfidence: 0.9,
          fields: {
            netRentalRealEstateIncomeOrLoss: { value: 12_000, confidence: 0.9 },
            rentsReceivedTotal: { value: 36_000, confidence: 0.9 },
            propertyCount: { value: 2, confidence: 0.9 },
          },
          warnings: [],
        },
      ],
    });

    expect(insight).toMatchObject({
      taxYear: 2025,
      wagesW2: "68000.00",
      grossIncome: "115000.00",
      adjustedGrossIncome: "110000.00",
      scheduleCNetProfit: "35000.00",
      scheduleENetRental: "12000.00",
      scheduleEGrossRents: "36000.00",
      rentalPropertyCount: 2,
      selfEmployed: true,
      dscrCandidate: true,
      confidence: "high",
    });
  });
});

// Simulation runs only when no Anthropic key is configured — with a real key the
// service would attempt a network call, which unit tests must never do.
const hasAnthropicKey = !!(process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY);

describe.skipIf(hasAnthropicKey)("simulated extraction (EXTRACTION_SIMULATE)", () => {
  it("is deterministic per file path, internally consistent, and clearly flagged", async () => {
    process.env.EXTRACTION_SIMULATE = "true";
    try {
      const a = await extractTaxReturnData("/objects/sim-test-a.pdf", "2025");
      const b = await extractTaxReturnData("/objects/sim-test-a.pdf", "2025");
      const c = await extractTaxReturnData("/objects/sim-test-c.pdf", "2025");

      expect(a).toEqual(b); // same path → same figures
      expect(a.w2Wages).not.toBe(c.w2Wages); // different path → different seed
      expect(a.warnings?.join(" ")).toContain("Simulated extraction");
      expect(a.scheduleE?.netRentalIncomeLoss).toBeDefined();
      // Internally consistent: the consistency caps must not have fired.
      expect(a.w2Wages! <= a.grossIncome!).toBe(true);
      expect(a.scheduleE!.netRentalIncomeLoss! <= a.scheduleE!.grossRents!).toBe(true);
      expect(a.confidence).toBe("medium");

      // The simulated payload must clear DSCR derivation end-to-end.
      expect(deriveTaxInsight(a).dscrCandidate).toBe(true);
    } finally {
      delete process.env.EXTRACTION_SIMULATE;
    }
  });

  it("returns the empty low-confidence extraction when the flag is off", async () => {
    delete process.env.EXTRACTION_SIMULATE;
    const result = await extractTaxReturnData("/objects/sim-test-a.pdf", "2025");
    expect(result.confidence).toBe("low");
    expect(result.extractedFields).toEqual([]);
  });
});
