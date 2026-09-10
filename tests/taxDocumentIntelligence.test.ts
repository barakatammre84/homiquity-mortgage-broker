import { describe, it, expect, beforeAll } from "vitest";
import {
  TAX_FORM_FIELD_CATALOG,
  TAX_FORM_TYPES,
  MAX_FORM_INSTANCES,
  ENTITY_BEARING_FORM_TYPES,
  taxDocumentClassificationSchema,
  buildFormFieldsSchema,
  buildFormExtractionResponseSchema,
  aggregateFieldConfidence,
  taxFieldCategory,
  taxFieldValueType,
  fieldValueColumn,
  type TaxFormInstance,
} from "../shared/taxFormExtraction";

/**
 * Unit tests for the Situation Identification Engine's extraction contract
 * (UAL P2a): the untrusted-model-output schemas, the single-source field
 * catalog, and the deterministic simulated scenario the dev/test environment
 * runs on. Pure in-process — no HTTP server, no database, no Anthropic.
 *
 * The simulate-path tests import server/extractionService dynamically AFTER
 * clearing the Anthropic env vars, because the module captures its API key at
 * import time.
 */

let svc: typeof import("../server/extractionService");

beforeAll(async () => {
  delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.EXTRACTION_SIMULATE = "true";
  svc = await import("../server/extractionService");
});

// ---------------------------------------------------------------------------
// Classification schema — untrusted input discipline
// ---------------------------------------------------------------------------

describe("taxDocumentClassificationSchema", () => {
  it("parses a valid classification and keeps its instances", () => {
    const parsed = taxDocumentClassificationSchema.parse({
      pageCount: 25,
      forms: [
        { formType: "tax_return_1040", taxYear: 2025, entityName: null, pageStart: 1, pageEnd: 2, confidence: 0.95 },
        { formType: "schedule_c", taxYear: 2025, entityName: "Acme LLC", pageStart: 3, pageEnd: 5, confidence: 0.9 },
      ],
    });
    expect(parsed.pageCount).toBe(25);
    expect(parsed.forms).toHaveLength(2);
    expect(parsed.forms[1].entityName).toBe("Acme LLC");
  });

  it("drops an invalid instance individually without losing the good ones", () => {
    const parsed = taxDocumentClassificationSchema.parse({
      forms: [
        { formType: "not_a_real_form", taxYear: 2025, confidence: 0.9 },
        { formType: "schedule_e", taxYear: 2025, confidence: 0.8 },
      ],
    });
    expect(parsed.forms).toHaveLength(1);
    expect(parsed.forms[0].formType).toBe("schedule_e");
  });

  it("truncates a runaway forms array to the instance cap instead of discarding it", () => {
    const forms = Array.from({ length: MAX_FORM_INSTANCES + 40 }, (_, i) => ({
      formType: "w2",
      taxYear: 2025,
      entityName: `Employer ${i}`,
      confidence: 0.9,
    }));
    const parsed = taxDocumentClassificationSchema.parse({ forms });
    expect(parsed.forms).toHaveLength(MAX_FORM_INSTANCES);
    expect(parsed.forms[0].entityName).toBe("Employer 0");
  });

  it("clamps garbage confidence to 0 — never trusted upward", () => {
    const parsed = taxDocumentClassificationSchema.parse({
      forms: [{ formType: "schedule_b", taxYear: 2025, confidence: "very sure" }],
    });
    expect(parsed.forms[0].confidence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Per-form field schemas
// ---------------------------------------------------------------------------

describe("per-form field schemas", () => {
  it("coerces formatted money strings and keeps sign discipline", () => {
    const schema = buildFormFieldsSchema("schedule_c");
    const parsed = schema.parse({
      grossReceipts: { value: "1,234.56", confidence: 0.9, pageNumber: 3 },
      netProfitOrLoss: { value: "-4,200", confidence: 0.85, pageNumber: 3 },
    }) as Record<string, { value: unknown; confidence: number }>;
    expect(parsed.grossReceipts?.value).toBeCloseTo(1234.56);
    expect(parsed.netProfitOrLoss?.value).toBe(-4200);
  });

  it("drops an out-of-range value as a whole field (absent, never defaulted)", () => {
    const schema = buildFormFieldsSchema("schedule_c");
    const parsed = schema.parse({
      grossReceipts: { value: 9e12, confidence: 0.99 },
      totalExpenses: { value: 50_000, confidence: 0.9, pageNumber: 1 },
    }) as Record<string, unknown>;
    expect(parsed.grossReceipts).toBeUndefined();
    expect(parsed.totalExpenses).toBeDefined();
  });

  it("reduces a full EIN to last-4 (PII minimization happens in the schema itself)", () => {
    const schema = buildFormFieldsSchema("schedule_k1");
    const parsed = schema.parse({
      entityEinLast4: { value: "12-3456789", confidence: 0.9, pageNumber: 1 },
    }) as Record<string, { value: unknown }>;
    expect(parsed.entityEinLast4?.value).toBe("6789");
  });

  it("normalizes NAICS codes to 6 digits and drops malformed ones", () => {
    const schema = buildFormFieldsSchema("schedule_c");
    const good = schema.parse({
      businessCodeNaics: { value: "54-1611", confidence: 0.9, pageNumber: 1 },
    }) as Record<string, { value: unknown }>;
    expect(good.businessCodeNaics?.value).toBe("541611");
    const bad = schema.parse({
      businessCodeNaics: { value: "consulting", confidence: 0.9, pageNumber: 1 },
    }) as Record<string, unknown>;
    expect(bad.businessCodeNaics).toBeUndefined();
  });

  it("preserves an honest null value ('label seen, value unreadable')", () => {
    const schema = buildFormFieldsSchema("schedule_c");
    const parsed = schema.parse({
      depletion: { value: null, confidence: 0.3, pageNumber: 2 },
    }) as Record<string, { value: unknown; confidence: number }>;
    expect(parsed.depletion?.value).toBeNull();
    expect(parsed.depletion?.confidence).toBe(0.3);
  });

  it("drops a readable value that has no source page", () => {
    const schema = buildFormFieldsSchema("schedule_c");
    const parsed = schema.parse({
      grossReceipts: { value: 125000, confidence: 0.99 },
      netProfitOrLoss: { value: 45000, confidence: 0.97, pageNumber: 2 },
    }) as Record<string, unknown>;
    expect(parsed.grossReceipts).toBeUndefined();
    expect(parsed.netProfitOrLoss).toBeDefined();
  });

  it("catches a structurally broken fields object to {} in the response schema", () => {
    const schema = buildFormExtractionResponseSchema("schedule_e");
    const parsed = schema.parse({ taxYear: 2025, fields: "not an object" });
    expect(parsed.fields).toEqual({});
  });

  it("remaps bounded excerpt pages to the original tax packet and drops invalid evidence", () => {
    const retained = svc.retainTaxFieldsWithEvidence(
      {
        grossReceipts: { value: 125_000, confidence: 0.98, pageNumber: 1 },
        netProfitOrLoss: { value: 48_000, confidence: 0.97, pageNumber: 2 },
        totalExpenses: { value: 77_000, confidence: 0.4, pageNumber: 3 },
        depreciation: { value: 6_000, confidence: 0.5 },
        depletion: { value: null, confidence: 0.3, pageNumber: 1 },
      },
      {
        formType: "schedule_c",
        taxYear: 2025,
        entityName: "Synthetic Consulting",
        k1Variant: null,
        pageStart: 25,
        pageEnd: 26,
        confidence: 0.99,
      },
      { sourcePageOffset: 24, attachedPageCount: 2 },
    );

    expect(retained.fields.grossReceipts.pageNumber).toBe(25);
    expect(retained.fields.netProfitOrLoss.pageNumber).toBe(26);
    expect(retained.fields.totalExpenses).toBeUndefined();
    expect(retained.fields.depreciation).toBeUndefined();
    expect(retained.fields.depletion).toBeUndefined();
    expect(retained.missingEvidence).toBe(2);
    expect(retained.unreadable).toBe(1);
  });

  it("fails a tax run on a provider-pass failure and requires review for incomplete evidence", () => {
    const failed = svc.assessTaxFormExtractions([{
      taxYear: 2025,
      entityName: "Synthetic Consulting",
      fields: {},
      warnings: ["Provider unavailable"],
      lineage: { modelId: "test-model" },
      simulated: false,
      failureReason: "Form extraction (schedule_c) call failed",
      evidenceIncomplete: true,
    }]);
    expect(failed).toEqual({
      failureReason: "Form extraction (schedule_c) call failed",
      evidenceIncomplete: true,
    });

    const emptyButValidated = svc.assessTaxFormExtractions([{
      taxYear: 2025,
      entityName: null,
      fields: {},
      warnings: [],
      lineage: { modelId: "test-model" },
      simulated: false,
    }]);
    expect(emptyButValidated).toEqual({
      failureReason: undefined,
      evidenceIncomplete: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Catalog integrity + persistence typing
// ---------------------------------------------------------------------------

describe("field catalog", () => {
  it("covers every declared form type with described fields", () => {
    for (const formType of TAX_FORM_TYPES) {
      const catalog = TAX_FORM_FIELD_CATALOG[formType];
      expect(Object.keys(catalog).length).toBeGreaterThan(0);
      for (const spec of Object.values(catalog)) {
        expect(spec.description.length).toBeGreaterThan(10);
      }
    }
  });

  it("marks every entity-bearing form type as a real form type", () => {
    for (const t of ENTITY_BEARING_FORM_TYPES) {
      expect(TAX_FORM_TYPES).toContain(t);
    }
  });

  it("types Schedule L components as asset/liability and names as identity", () => {
    expect(taxFieldCategory("scheduleLCashEndOfYear", "currency")).toBe("asset");
    expect(taxFieldCategory("scheduleLAccountsPayableEndOfYear", "currency")).toBe("liability");
    expect(taxFieldCategory("entityName", "text")).toBe("identity");
    expect(taxFieldCategory("netProfitOrLoss", "signedCurrency")).toBe("income");
  });

  it("maps kinds onto the extracted_fields value_type vocabulary", () => {
    expect(taxFieldValueType("currency")).toBe("currency");
    expect(taxFieldValueType("signedCurrency")).toBe("currency");
    expect(taxFieldValueType("integer")).toBe("number");
    expect(taxFieldValueType("text")).toBe("string");
    expect(fieldValueColumn("percent")).toBe("numeric");
  });
});

describe("aggregateFieldConfidence", () => {
  it("returns 0 for an empty run", () => {
    expect(aggregateFieldConfidence([])).toBe(0);
  });

  it("is dragged down by weak fields (bottom-half mean, not overall mean)", () => {
    const instance: TaxFormInstance = {
      formType: "schedule_c",
      taxYear: 2025,
      entityName: "Acme",
      k1Variant: null,
      pageStart: 1,
      pageEnd: 2,
      classificationConfidence: 1,
      fields: {
        a: { value: 1, confidence: 1 },
        b: { value: 1, confidence: 0.5 },
        c: { value: 1, confidence: 0.5 },
      },
      warnings: [],
    };
    // confidences [1, 1, 0.5, 0.5] → bottom half [0.5, 0.5] → 0.5
    expect(aggregateFieldConfidence([instance])).toBeCloseTo(0.5);
  });
});

// ---------------------------------------------------------------------------
// Deterministic simulated scenario
// ---------------------------------------------------------------------------

describe("buildSimulatedTaxScenario", () => {
  it("is deterministic: same file path, identical scenario", () => {
    const a = svc.buildSimulatedTaxScenario("/objects/uploads/abc");
    const b = svc.buildSimulatedTaxScenario("/objects/uploads/abc");
    expect(a).toEqual(b);
  });

  it("varies by seed: different paths give different figures", () => {
    const a = svc.buildSimulatedTaxScenario("/objects/uploads/abc");
    const b = svc.buildSimulatedTaxScenario("/objects/uploads/xyz");
    const netA = a.instances.find((i) => i.meta.entityName === "Simworth Consulting")!
      .extraction.fields.netProfitOrLoss.value;
    const netB = b.instances.find((i) => i.meta.entityName === "Simworth Consulting")!
      .extraction.fields.netProfitOrLoss.value;
    expect(netA).not.toBe(netB);
  });

  it("is internally consistent so the P2b tie-out engine can pass on it", () => {
    const { instances } = svc.buildSimulatedTaxScenario("/objects/uploads/tieout");
    const year = new Date().getFullYear() - 1;
    const byType = (t: string, entity?: string | null, y = year) =>
      instances.find(
        (i) => i.meta.formType === t && (entity === undefined || i.meta.entityName === entity) && i.meta.taxYear === y,
      )!;

    const schCs = instances.filter((i) => i.meta.formType === "schedule_c" && i.meta.taxYear === year);
    const schCTotal = schCs.reduce(
      (s, i) => s + Number(i.extraction.fields.netProfitOrLoss.value),
      0,
    );
    const sch1 = byType("schedule_1", null);
    expect(Number(sch1.extraction.fields.businessIncomeOrLoss.value)).toBe(schCTotal);

    const f1040 = byType("tax_return_1040", null);
    const f = f1040.extraction.fields;
    expect(Number(f.totalIncome.value)).toBe(
      Number(f.wagesSalariesTips.value) +
        Number(f.taxableInterest.value) +
        Number(f.ordinaryDividends.value) +
        Number(f.additionalIncomeFromSchedule1.value),
    );

    const k1 = byType("schedule_k1", "Simworth Ventures LP");
    const f1065 = byType("business_tax_return_1065", "Simworth Ventures LP");
    expect(Number(k1.extraction.fields.ordinaryBusinessIncomeOrLoss.value)).toBe(
      Math.round(Number(f1065.extraction.fields.ordinaryBusinessIncomeOrLoss.value) / 2),
    );

    const schE = byType("schedule_e", null);
    expect(Number(schE.extraction.fields.partnershipSCorpIncomeOrLossTotal.value)).toBe(
      Number(k1.extraction.fields.ordinaryBusinessIncomeOrLoss.value) +
        Number(k1.extraction.fields.guaranteedPayments.value),
    );
  });

  it("keeps the deliberate gaps: absent fields stay absent, weak fields stay weak", () => {
    const { instances } = svc.buildSimulatedTaxScenario("/objects/uploads/gaps");
    const consulting = instances.find(
      (i) => i.meta.entityName === "Simworth Consulting" && i.meta.taxYear === new Date().getFullYear() - 1,
    )!;
    expect(consulting.extraction.fields.depletion).toBeUndefined();
    expect(consulting.extraction.fields.amortizationInOtherExpenses).toBeUndefined();
    expect(consulting.extraction.fields.businessUseOfHomeExpenses.confidence).toBe(0.55);
  });

  it("emits only cataloged fields that pass their own form schema (sim ≡ contract)", () => {
    const { instances } = svc.buildSimulatedTaxScenario("/objects/uploads/contract");
    for (const inst of instances) {
      const catalog = TAX_FORM_FIELD_CATALOG[inst.meta.formType];
      for (const name of Object.keys(inst.extraction.fields)) {
        expect(catalog[name], `${inst.meta.formType}.${name} not in catalog`).toBeDefined();
      }
      const parsed = buildFormFieldsSchema(inst.meta.formType).parse(inst.extraction.fields) as Record<
        string,
        unknown
      >;
      // Nothing may be dropped: the sim must satisfy the same schema real output does.
      expect(Object.keys(parsed).filter((k) => parsed[k] !== undefined)).toHaveLength(
        Object.keys(inst.extraction.fields).length,
      );
    }
  });

  it("pairs every classification entry with exactly one instance", () => {
    const { classification, instances } = svc.buildSimulatedTaxScenario("/objects/uploads/pairs");
    expect(classification.forms).toHaveLength(instances.length);
    expect(classification.pageCount).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Adapter simulate paths (no Anthropic key + EXTRACTION_SIMULATE=true)
// ---------------------------------------------------------------------------

describe("classifyTaxDocument (simulate path)", () => {
  it("returns the simulated classification flagged as simulated", async () => {
    const result = await svc.classifyTaxDocument("/objects/uploads/simdoc");
    expect(result.simulated).toBe(true);
    expect(result.classification?.forms.length).toBeGreaterThan(0);
    expect(result.lineage.modelId).toBe(svc.SIMULATED_MODEL_ID);
    expect(result.classification?.warnings?.some((w) => /simulated/i.test(w))).toBe(true);
  });

  it("uses the same deterministic scenario when the orchestrator loads source bytes once", async () => {
    const source = Buffer.from("synthetic tax packet bytes");
    const classified = await svc.classifyTaxDocument(source, "application/pdf");
    const target = classified.classification!.forms.find((form) => form.formType === "schedule_k1")!;
    const extracted = await svc.extractTaxFormInstanceFields(source, target, "application/pdf");
    expect(classified.simulated).toBe(true);
    expect(extracted.simulated).toBe(true);
    expect(extracted.fields.guaranteedPayments?.value).toBeGreaterThan(0);
    expect(extracted.failureReason).toBeUndefined();
    expect(extracted.evidenceIncomplete).toBeFalsy();
  });

  it("refuses tax-package simulation in production", async () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(svc.classifyTaxDocument("/objects/uploads/production-simdoc"))
        .rejects.toThrow(/cannot be enabled in production/i);
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });
});

describe("extractTaxFormInstanceFields (simulate path)", () => {
  it("returns the matching instance's fields", async () => {
    const { classification } = svc.buildSimulatedTaxScenario("/objects/uploads/simdoc");
    const k1Meta = classification.forms.find((i) => i.formType === "schedule_k1")!;
    const result = await svc.extractTaxFormInstanceFields("/objects/uploads/simdoc", k1Meta);
    expect(result.simulated).toBe(true);
    expect(result.fields.guaranteedPayments?.value).toBeGreaterThan(0);
    expect(result.fields.ownershipPercentEndOfYear?.value).toBe(50);
    expect(result.fields.entityEinLast4?.value).toMatch(/^\d{4}$/);
  });

  it("returns empty fields with a warning for an unknown instance", async () => {
    const result = await svc.extractTaxFormInstanceFields("/objects/uploads/simdoc", {
      formType: "form_8825",
      taxYear: 1999,
      entityName: "Nonexistent LLC",
      k1Variant: null,
      pageStart: null,
      pageEnd: null,
      confidence: 0.5,
    });
    expect(result.fields).toEqual({});
    expect(result.warnings.some((w) => /no simulated data/i.test(w))).toBe(true);
  });
});
