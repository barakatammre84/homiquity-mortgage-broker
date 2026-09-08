import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { buildEntityWorksheetDraft } from "../server/services/worksheetPrefill";
import {
  triageExtractionAndTieOuts,
  triageIncomePaths,
  REVIEW_CONFIDENCE_THRESHOLD,
} from "../server/services/income/reviewTriage";
import { resolveBusinessEntities } from "../server/services/borrowerEntityResolution";
import { runTieOuts } from "../server/services/taxReconciliation";
import { computeIncomePaths } from "../server/services/income/orchestrator";
import { selfEmploymentWorksheetSchema } from "../shared/schema";
import type { PublicTaxFormInstance } from "../server/services/taxDocumentIntelligence";

/**
 * UAL P5 — the accuracy loop: smart-fill drafts, exception-only triage, the
 * tax_insights import boundary, and the bank-statement capture wiring. Test
 * data = the deterministic simulated scenario (same data the live simulate
 * path persists). Pure in-process — no HTTP server, no database.
 */

let svc: typeof import("../server/extractionService");

beforeAll(async () => {
  delete process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.EXTRACTION_SIMULATE = "true";
  svc = await import("../server/extractionService");
});

function simInstances(seed = "/objects/uploads/accuracy"): PublicTaxFormInstance[] {
  const { instances } = svc.buildSimulatedTaxScenario(seed);
  return instances.map((i, idx) => ({
    logicalDocumentId: `ld-${idx}`,
    formType: i.meta.formType,
    taxYear: i.extraction.taxYear,
    entityName: i.extraction.entityName,
    k1Variant: i.meta.k1Variant ?? null,
    pageStart: i.meta.pageStart ?? null,
    pageEnd: i.meta.pageEnd ?? null,
    classificationConfidence: i.meta.confidence,
    fields: i.extraction.fields,
    warnings: i.extraction.warnings,
  }));
}

// ---------------------------------------------------------------------------
// Smart-fill drafts
// ---------------------------------------------------------------------------

describe("buildEntityWorksheetDraft", () => {
  // Lazy: the sim scenario needs the dynamically imported extraction service,
  // so nothing here may run at collection time.
  let cached: { instances: PublicTaxFormInstance[]; entities: ReturnType<typeof resolveBusinessEntities> } | undefined;
  const ctx = () => {
    if (!cached) {
      const instances = simInstances();
      cached = { instances, entities: resolveBusinessEntities(instances) };
    }
    return cached;
  };

  it("drafts a schema-valid Schedule C worksheet with two years and provenance", () => {
    const { instances, entities } = ctx();
    const consulting = entities.find((e) => e.name === "Simworth Consulting")!;
    const draft = buildEntityWorksheetDraft(consulting, instances)!;
    expect(draft).not.toBeNull();
    expect(() => selfEmploymentWorksheetSchema.parse(draft.worksheet)).not.toThrow();
    expect(draft.worksheet.businessStructure).toBe("sole_proprietorship");
    expect(draft.worksheet.scheduleC?.currentYear.netProfitOrLoss).toBeGreaterThan(0);
    expect(draft.worksheet.scheduleC?.priorYear).toBeDefined();
    // Provenance: extracted fields carry their source; unreadable fields are
    // honest (value 0 + not_readable), never silently defaulted.
    const netProv = draft.provenance.find((p) => p.field === "scheduleC.currentYear.netProfitOrLoss")!;
    expect(netProv.source.kind).toBe("extracted");
    const depletionProv = draft.provenance.find((p) => p.field === "scheduleC.currentYear.depletion")!;
    expect(depletionProv.source.kind).toBe("not_readable"); // absent in the sim
    const nonRecurring = draft.provenance.find((p) => p.field === "scheduleC.currentYear.nonRecurringIncome")!;
    expect(nonRecurring.source.kind).toBe("not_readable"); // never machine-readable
  });

  it("drafts a K-1 worksheet with derived Schedule L liquidity sums (flagged as derived)", () => {
    const { instances, entities } = ctx();
    const lp = entities.find((e) => e.name === "Simworth Ventures LP")!;
    const draft = buildEntityWorksheetDraft(lp, instances)!;
    expect(draft.worksheet.businessStructure).toBe("partnership");
    expect(draft.worksheet.k1?.currentYear.ordinaryBusinessIncome).toBeGreaterThan(0);
    expect(draft.worksheet.k1?.liquidity).toBeDefined();
    const assets = draft.provenance.find((p) => p.field === "k1.liquidity.currentAssets")!;
    expect(assets.source.kind).toBe("derived");
    expect(draft.warnings.some((w) => /accountant confirms/i.test(w))).toBe(true);
    // The borrower attests two-year guaranteed payments; a draft cannot.
    expect(draft.worksheet.k1?.hasTwoYearGuaranteedPayments).toBe(false);
    expect(draft.worksheet.ownershipPercent).toBe(50);
  });

  it("returns null for entity types with no SE worksheet (C-corp) or no forms", () => {
    const { instances, entities } = ctx();
    const fake = { ...entities[0], entityType: "c_corporation" as const };
    expect(buildEntityWorksheetDraft(fake, instances)).toBeNull();
  });

  it("never sets confirmedByBorrowerAt on a draft", () => {
    const { instances, entities } = ctx();
    for (const e of entities) {
      const d = buildEntityWorksheetDraft(e, instances);
      if (d) expect(d.worksheet.confirmedByBorrowerAt).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Exception-only triage
// ---------------------------------------------------------------------------

describe("triageExtractionAndTieOuts", () => {
  it("creates a one-click item for the sim's deliberate low-confidence field and nothing for confident ones", () => {
    const instances = simInstances();
    const items = triageExtractionAndTieOuts(instances, runTieOuts(instances));
    const lowConf = items.filter((i) => i.itemType === "extraction_low_confidence");
    // businessUseOfHomeExpenses is seeded at 0.55 < 0.7 in the sim.
    expect(lowConf.some((i) => i.title.includes("businessUseOfHomeExpenses"))).toBe(true);
    expect(lowConf.every((i) => (i.evidence.confidence as number) < REVIEW_CONFIDENCE_THRESHOLD)).toBe(true);
    // The clean sim has no variances → no flagged tie-out items.
    expect(items.filter((i) => i.itemType === "tieout_variance")).toHaveLength(0);
  });

  it("flags a variance and escalates a low-confidence field that sits inside it", () => {
    const year = new Date().getFullYear() - 1;
    const instances = simInstances().map((i) =>
      i.formType === "schedule_1" && i.taxYear === year
        ? {
            ...i,
            fields: {
              ...i.fields,
              // Break the Schedule C carry AND make this field low-confidence.
              businessIncomeOrLoss: {
                value: (i.fields.businessIncomeOrLoss.value as number) + 7000,
                confidence: 0.5,
              },
            },
          }
        : i,
    );
    const items = triageExtractionAndTieOuts(instances, runTieOuts(instances));
    const variance = items.find((i) => i.itemType === "tieout_variance");
    expect(variance).toBeDefined();
    expect(variance!.tier).toBe("flagged");
    // The low-confidence field participating in the variance escalates to flagged.
    const escalated = items.find(
      (i) => i.itemType === "extraction_low_confidence" && i.title.includes("businessIncomeOrLoss"),
    );
    expect(escalated?.tier).toBe("flagged");
  });

  it("is deterministic: identical inputs → identical natural keys", () => {
    const a = triageExtractionAndTieOuts(simInstances(), runTieOuts(simInstances()));
    const b = triageExtractionAndTieOuts(simInstances(), runTieOuts(simInstances()));
    expect(b.map((i) => i.naturalKey)).toEqual(a.map((i) => i.naturalKey));
  });

  it("gives replacement forms new keys even when the extracted findings are identical", () => {
    const original = simInstances();
    const replacement = original.map((instance) => ({
      ...instance,
      logicalDocumentId: `replacement-${instance.logicalDocumentId}`,
    }));
    const originalItems = triageExtractionAndTieOuts(original, runTieOuts(original));
    const replacementItems = triageExtractionAndTieOuts(
      replacement,
      runTieOuts(replacement),
    );

    expect(replacementItems).toHaveLength(originalItems.length);
    expect(replacementItems.map((item) => item.naturalKey)).not.toEqual(
      originalItems.map((item) => item.naturalKey),
    );
  });
});

describe("triageIncomePaths", () => {
  it("turns path review flags into the right item types and tiers", () => {
    const r = computeIncomePaths({
      employment: [
        { isSelfEmployed: true, selfEmploymentIncome: null } as never, // SE with no worksheet → review
      ],
      otherIncome: [],
      rentalProperties: [{ address: "1 Main", monthlyRentalIncome: 2500, monthlyDebtPayment: 2000 } as never],
      bankStatementAnalysis: { months: 12, totalEligibleDeposits: 240_000 },
    });
    const items = triageIncomePaths(r.paths);
    // An incomplete worksheet is borrower work, not an officer review item;
    // officer review begins after the worksheet produces a figure.
    expect(r.paths.find((p) => p.pathId === "self_employment")?.missingItems).toHaveLength(1);
    expect(items.find((i) => i.itemType === "se_income_review")).toBeUndefined();
    expect(items.find((i) => i.itemType === "dscr_review")?.tier).toBe("one_click");
    expect(items.find((i) => i.itemType === "bank_statement_review")?.tier).toBe("one_click");
  });
});

// ---------------------------------------------------------------------------
// Bank-statement capture wiring (P4's named gap, closed here)
// ---------------------------------------------------------------------------

describe("orchestrator with a captured bank-statement analysis", () => {
  it("computes the alternative-method figure and recommends it when it beats full-doc", () => {
    const r = computeIncomePaths({
      employment: [{ isSelfEmployed: false, baseIncome: 4000 } as never],
      otherIncome: [],
      rentalProperties: [],
      bankStatementAnalysis: { months: 12, totalEligibleDeposits: 240_000 }, // → $10k/mo
    });
    const bank = r.paths.find((p) => p.pathId === "bank_statement")!;
    expect(bank.status).toBe("applicable");
    if (bank.kind === "dti_income") {
      expect(bank.monthlyQualifyingIncome).toBe(10_000);
      expect(bank.appliedToDti).toBe(false); // alternative METHOD, never summed
    }
    // $10k bank-statement > $4k full-doc → recommendation flips.
    expect(r.primaryMonthlyQualifyingIncome).toBe(4000);
    expect(r.recommendedPathId).toBe("bank_statement");
  });

  it("keeps full-doc as the recommendation when it is higher", () => {
    const r = computeIncomePaths({
      employment: [{ isSelfEmployed: false, baseIncome: 20_000 } as never],
      otherIncome: [],
      rentalProperties: [],
      bankStatementAnalysis: { months: 12, totalEligibleDeposits: 240_000 },
    });
    expect(r.recommendedPathId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The tax_insights boundary (structural, enforced by grep)
// ---------------------------------------------------------------------------

describe("tax_insights import boundary", () => {
  it("no underwriting-side module imports taxInsightService (marketing signals only)", () => {
    const ROOT = path.resolve(__dirname, "..");
    const underwritingSide = [
      "server/underwriting.ts",
      "server/underwritingEngine.ts",
      "server/services/decisionEngine.ts",
      "server/services/worksheetPrefill.ts",
      "server/services/taxReconciliation.ts",
      "server/services/borrowerEntityResolution.ts",
      "server/services/situationClassifier.ts",
      ...fs
        .readdirSync(path.join(ROOT, "server/services/income"), { recursive: true })
        .map((f) => `server/services/income/${f}`)
        .filter((f) => f.endsWith(".ts")),
    ];
    for (const rel of underwritingSide) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      expect(src.includes("taxInsightService"), `${rel} must not import taxInsightService`).toBe(false);
    }
  });
});
