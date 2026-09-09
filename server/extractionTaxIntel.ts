// Tax-package intelligence: classification, per-form-instance field extraction, simulated tax scenarios.
// Split from the old server/extractionService.ts — which re-exports it.
/**
 * AI Document Extraction Service — the Anthropic (Claude) vendor adapter.
 * Every document-extraction model call in the codebase lives here
 * (vendor-adapter rule); orchestration/persistence live in the services that
 * consume it.
 *
 * Extracts structured financial data from:
 * - Tax Returns — single-pass summary (legacy) AND multi-form classification +
 *   per-form extraction (UAL P2a Situation Identification Engine)
 * - Pay Stubs (income verification)
 * - Bank Statements (asset verification)
 * - Lease agreements (rent auto-fill)
 */

import * as fs from "fs";
import * as path from "path";
import { computeHash } from "./services/encryptionService";
import {
  TAX_FORM_FIELD_CATALOG,
  taxDocumentClassificationSchema,
  buildFormExtractionResponseSchema,
  type ClassifiedFormInstance,
  type TaxDocumentClassification,
  type ExtractedFieldValue,
  type TaxFormType,
} from "@shared/taxFormExtraction";
import {
  anthropic,
  generateExtractionText,
  fileToBase64,
  getMimeType,
  EXTRACTION_MODEL_TAX_PACKAGE,
  EXTRACTION_PROMPT_VERSION,
  SIMULATED_MODEL_ID,
  extractionSimulationEnabled,
  type ExtractionLineage,
} from "./extractionCore";
import { validateExtraction, lineageFor, rawLineage, VALIDATION_FAILED_WARNING } from "./extractionValidation";

// Model lineage, persisted with every extraction so a past result can be traced
// to the exact model + prompt that produced it. Bump EXTRACTION_PROMPT_VERSION
// whenever any extraction prompt text changes.
//
// Extraction is tiered by task. Single-document reads (pay stub, bank statement,
// lease, single-pass tax return) are bounded, high-volume, and vision-bound but
// not reasoning-heavy — Sonnet 5 has the same high-res vision as Opus at lower
// cost, and everything downstream is Zod-validated + confidence-capped. The
// multi-form tax-package pass (UAL P2a: classify every form, then tie the forms
// out across entities and years) is the one genuinely hard reasoning task and it
// feeds the income engine — it stays on Opus. Lineage records the actual model.

const TAX_INTEL_CALL_TIMEOUT_MS = 90_000;

async function withCallTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${TAX_INTEL_CALL_TIMEOUT_MS}ms`)),
          TAX_INTEL_CALL_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface TaxFormClassificationResult {
  classification: TaxDocumentClassification | null;
  lineage: ExtractionLineage;
  simulated: boolean;
  /** Set when classification is null — why the pass produced nothing. */
  failureReason?: string;
}

export interface TaxFormInstanceExtraction {
  taxYear: number | null;
  entityName: string | null;
  /** Validated fields; a field absent here was not readable — never assume 0. */
  fields: Record<string, ExtractedFieldValue>;
  warnings: string[];
  lineage: ExtractionLineage;
  simulated: boolean;
}

const FORM_TYPE_PROMPT_LABELS: Record<TaxFormType, string> = {
  tax_return_1040: "Form 1040 — U.S. Individual Income Tax Return (the two main pages)",
  schedule_1: "Schedule 1 (Form 1040) — Additional Income and Adjustments to Income",
  schedule_b: "Schedule B (Form 1040) — Interest and Ordinary Dividends",
  schedule_c: "Schedule C (Form 1040) — Profit or Loss From Business (one instance PER business)",
  schedule_d: "Schedule D (Form 1040) — Capital Gains and Losses",
  schedule_e: "Schedule E (Form 1040) — Supplemental Income and Loss",
  schedule_k1: "Schedule K-1 — partner's or shareholder's share of income (one instance PER K-1)",
  business_tax_return_1065: "Form 1065 — U.S. Return of Partnership Income",
  business_tax_return_1120s: "Form 1120-S — U.S. Income Tax Return for an S Corporation",
  business_tax_return_1120: "Form 1120 — U.S. Corporation Income Tax Return",
  form_8825: "Form 8825 — Rental Real Estate Income and Expenses of a Partnership or an S Corporation",
  form_4562: "Form 4562 — Depreciation and Amortization (one instance per business or activity)",
  w2: "Form W-2 — Wage and Tax Statement (one instance per employer per year)",
  "1099_nec": "Form 1099-NEC — Nonemployee Compensation (one instance per payer per year)",
  "1099_misc": "Form 1099-MISC — Miscellaneous Information (one instance per payer per year)",
};

const FIELD_KIND_PROMPT_HINTS: Record<string, string> = {
  currency: "dollar amount, 0 or greater, plain number without $ or commas",
  signedCurrency:
    "dollar amount as a plain number; amounts shown in parentheses on the form are NEGATIVE",
  integer: "whole-number count",
  percent: "percentage between 0 and 100",
  text: "short text exactly as printed",
  naics: "the 6-digit code exactly as printed",
  einLast4: "the LAST 4 DIGITS ONLY — never return a full EIN",
  boolean: "true or false",
};

function buildClassificationPrompt(): string {
  const formList = (Object.entries(FORM_TYPE_PROMPT_LABELS) as [TaxFormType, string][])
    .map(([type, label]) => `- "${type}": ${label}`)
    .join("\n");
  return `You are a mortgage document-intelligence specialist. The attached upload is a tax package that may contain MULTIPLE IRS forms, MULTIPLE tax years, and MULTIPLE business entities. Identify every distinct form instance.

Recognized form types (use these exact identifiers, nothing else):
${formList}

Rules:
- Emit ONE entry per (form type, tax year, entity). Three Schedule Cs for three businesses are three entries; the same business across two years is two entries.
- "entityName": the business or issuing-entity name as printed on that form (null for personal forms like the 1040).
- "k1Variant": for schedule_k1 only — "1065" for a partnership K-1, "1120s" for an S-corporation K-1; null otherwise.
- "pageStart"/"pageEnd": 1-indexed inclusive page range where the instance appears in THIS file.
- "confidence": 0.0-1.0 — your confidence that the instance exists as identified.
- Do NOT guess. If pages are unreadable or ambiguous, lower the confidence and add a note to "warnings".

Return ONLY valid JSON:
{"pageCount": <total pages>, "forms": [{"formType": "...", "taxYear": 2025, "entityName": "... or null", "k1Variant": "1065 or 1120s or null", "pageStart": 1, "pageEnd": 2, "confidence": 0.95}], "warnings": []}`;
}

function buildFormExtractionPrompt(instance: ClassifiedFormInstance): string {
  const catalog = TAX_FORM_FIELD_CATALOG[instance.formType];
  const fieldLines = Object.entries(catalog)
    .map(([name, spec]) => `- "${name}" (${FIELD_KIND_PROMPT_HINTS[spec.kind]}): ${spec.description}`)
    .join("\n");
  const where = [
    instance.taxYear ? `tax year ${instance.taxYear}` : null,
    instance.entityName ? `entity "${instance.entityName}"` : null,
    instance.pageStart
      ? `located approximately at pages ${instance.pageStart}-${instance.pageEnd ?? instance.pageStart}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `You are a tax document analysis specialist. The attached file is a complete tax package. Extract fields from EXACTLY ONE form instance in it:

Target: ${FORM_TYPE_PROMPT_LABELS[instance.formType]}${where ? ` — ${where}` : ""}.

Read ONLY that instance. If the same form appears for another year or another entity, ignore those.

Fields to extract:
${fieldLines}

Rules:
- Every field you return must be {"value": <value>, "confidence": <0.0-1.0>}.
- If a field is not present on the form or is unreadable, OMIT it or return {"value": null, "confidence": <low>}. NEVER estimate, compute, or carry a value from a different form or year.
- Numbers must be plain (no currency symbols, no thousands separators). Parentheses on the form mean a negative number.

Return ONLY valid JSON:
{"taxYear": ${instance.taxYear ?? "<year or null>"}, "entityName": ${instance.entityName ? `"${instance.entityName}"` : "<name or null>"}, "fields": {"<fieldName>": {"value": 12345, "confidence": 0.97}}, "warnings": []}`;
}

// ---------------------------------------------------------------------------
// Deterministic simulation (EXTRACTION_SIMULATE=true, no Anthropic key). One
// coherent multi-entity, multi-year self-employed scenario, seeded by file
// path: two Schedule C businesses (one profitable, one loss), a rental on
// Schedule E, a 50% partnership K-1 tied to its Form 1065 (with Schedule L
// liquidity components), plus the prior-year 1040/Schedule C for trend math.
// Internally consistent so the P2b tie-out engine passes on it; a couple of
// fields are deliberately omitted or low-confidence so review tiers and
// missing-value honesty are exercisable in dev and tests.
// ---------------------------------------------------------------------------

function seededFrac(seedText: string): number {
  return parseInt(computeHash(seedText).slice(0, 8), 16) / 0xffffffff;
}

interface SimulatedTaxInstance {
  meta: NonNullable<TaxDocumentClassification["forms"][number]>;
  extraction: Pick<TaxFormInstanceExtraction, "taxYear" | "entityName" | "fields" | "warnings">;
}

export function buildSimulatedTaxScenario(filePath: string): {
  classification: TaxDocumentClassification;
  instances: SimulatedTaxInstance[];
} {
  const frac = seededFrac(`tax-intel-sim:${filePath}`);
  const conf = (tag: string, lo = 0.78, hi = 0.99) =>
    Math.round((lo + seededFrac(`tax-intel-conf:${filePath}:${tag}`) * (hi - lo)) * 100) / 100;
  const f = (value: number | string, tag: string): ExtractedFieldValue => ({
    value,
    confidence: conf(tag),
  });
  const r = Math.round;
  const year = new Date().getFullYear() - 1;
  const priorYear = year - 1;
  const einLast4 = String(1000 + Math.floor(seededFrac(`tax-intel-ein:${filePath}`) * 9000));

  // Businesses
  const consultingNet = r(42_000 + frac * 30_000);
  const consultingReceipts = r(consultingNet * 1.9);
  const consultingExpenses = consultingReceipts - consultingNet;
  const consultingDepreciation = r(4_000 + frac * 3_000);
  const consultingHomeOffice = r(2_400 + frac * 1_200);
  const consultingMeals = r(900 + frac * 600);
  const consultingOtherExpenses = r(1_500 + frac * 1_000);

  const ecomNet = -r(3_000 + frac * 5_000);
  const ecomReceipts = r(18_000 + frac * 6_000);
  const ecomExpenses = ecomReceipts - ecomNet;

  // Partnership + 50% K-1
  const partnershipOrdinary = r(80_000 + frac * 40_000);
  const k1Ordinary = r(partnershipOrdinary / 2);
  const k1Guaranteed = r(12_000 + frac * 6_000);
  const partnershipDistributions = r(30_000 + frac * 10_000);
  const k1Distributions = r(partnershipDistributions / 2);
  const partnershipTotalIncome = r(partnershipOrdinary * 2);
  const partnershipTotalDeductions = partnershipTotalIncome - partnershipOrdinary;

  // Rental (Schedule E Part I)
  const rents = r(30_000 + frac * 20_000);
  const rentalDepreciation = r(rents * 0.25);
  const rentalMortgageInterest = r(rents * 0.3);
  const rentalExpensesTotal = r(rents * 0.62);
  const rentalNet = rents - rentalExpensesTotal;

  // Roll-ups (kept internally consistent for the tie-out engine)
  const schedCTotal = consultingNet + ecomNet;
  const schedEPartII = k1Ordinary + k1Guaranteed;
  const schedETotal = rentalNet + schedEPartII;
  const wages = r(18_000 + frac * 10_000);
  const interest = r(300 + frac * 400);
  const dividends = r(900 + frac * 800);
  const additionalIncome = schedCTotal + schedETotal;
  const totalIncome = wages + interest + dividends + additionalIncome;
  const adjustments = r(6_000 + frac * 2_000);
  const agi = totalIncome - adjustments;
  const taxable = Math.max(0, agi - 21_900);

  // Prior year (primary business trending up into the current year)
  const priorConsultingNet = r(consultingNet * 0.85);
  const priorConsultingReceipts = r(priorConsultingNet * 1.9);
  const priorWages = r(wages * 0.95);
  const priorTotalIncome = priorWages + priorConsultingNet;
  const priorAgi = priorTotalIncome - r(adjustments * 0.9);

  // Schedule L (healthy liquidity: quick ratio well above 1)
  const lCash = r(45_000 + frac * 20_000);
  const lReceivables = r(22_000 + frac * 8_000);
  const lAp = r(9_000 + frac * 3_000);
  const lShortDebt = r(6_000 + frac * 2_000);
  const lOtherCurrent = r(4_000 + frac * 1_500);

  const person = "Alex Simworth";
  const simWarning = "Simulated extraction - no Anthropic credentials (EXTRACTION_SIMULATE)";

  const instances: SimulatedTaxInstance[] = [
    {
      meta: { formType: "tax_return_1040", taxYear: year, entityName: null, k1Variant: null, pageStart: 1, pageEnd: 2, confidence: conf("cls-1040") },
      extraction: {
        taxYear: year,
        entityName: null,
        fields: {
          taxpayerName: f(person, "1040-name"),
          filingStatus: f("married_filing_jointly", "1040-status"),
          wagesSalariesTips: f(wages, "1040-wages"),
          taxableInterest: f(interest, "1040-interest"),
          ordinaryDividends: f(dividends, "1040-dividends"),
          additionalIncomeFromSchedule1: f(additionalIncome, "1040-addl"),
          totalIncome: f(totalIncome, "1040-total"),
          adjustedGrossIncome: f(agi, "1040-agi"),
          taxableIncome: f(taxable, "1040-taxable"),
        },
        warnings: [simWarning],
      },
    },
    {
      meta: { formType: "schedule_1", taxYear: year, entityName: null, k1Variant: null, pageStart: 3, pageEnd: 4, confidence: conf("cls-sch1") },
      extraction: {
        taxYear: year,
        entityName: null,
        fields: {
          businessIncomeOrLoss: f(schedCTotal, "sch1-biz"),
          rentalRealEstatePartnershipsSCorpsIncomeOrLoss: f(schedETotal, "sch1-rental"),
          additionalIncomeTotal: f(additionalIncome, "sch1-total"),
          adjustmentsToIncomeTotal: f(adjustments, "sch1-adj"),
        },
        warnings: [simWarning],
      },
    },
    {
      meta: { formType: "schedule_c", taxYear: year, entityName: "Simworth Consulting", k1Variant: null, pageStart: 5, pageEnd: 7, confidence: conf("cls-schc1") },
      extraction: {
        taxYear: year,
        entityName: "Simworth Consulting",
        fields: {
          businessName: f("Simworth Consulting", "schc1-name"),
          principalBusinessOrProfession: f("Management consulting", "schc1-activity"),
          businessCodeNaics: f("541611", "schc1-naics"),
          grossReceipts: f(consultingReceipts, "schc1-receipts"),
          grossIncome: f(consultingReceipts, "schc1-gross"),
          totalExpenses: f(consultingExpenses, "schc1-expenses"),
          netProfitOrLoss: f(consultingNet, "schc1-net"),
          depreciationAndSection179: f(consultingDepreciation, "schc1-depr"),
          deductibleMeals: f(consultingMeals, "schc1-meals"),
          // Deliberately LOW confidence — exercises the flagged review tier.
          businessUseOfHomeExpenses: { value: consultingHomeOffice, confidence: 0.55 },
          otherExpensesTotal: f(consultingOtherExpenses, "schc1-other"),
          // depletion + amortizationInOtherExpenses deliberately ABSENT —
          // exercises missing-value honesty (absent ≠ 0).
        },
        warnings: [simWarning, "Business use of home figure partially obscured (simulated)"],
      },
    },
    {
      meta: { formType: "schedule_c", taxYear: year, entityName: "Simworth Trading Co", k1Variant: null, pageStart: 8, pageEnd: 10, confidence: conf("cls-schc2") },
      extraction: {
        taxYear: year,
        entityName: "Simworth Trading Co",
        fields: {
          businessName: f("Simworth Trading Co", "schc2-name"),
          principalBusinessOrProfession: f("Online retail", "schc2-activity"),
          businessCodeNaics: f("455110", "schc2-naics"),
          grossReceipts: f(ecomReceipts, "schc2-receipts"),
          totalExpenses: f(ecomExpenses, "schc2-expenses"),
          netProfitOrLoss: f(ecomNet, "schc2-net"),
        },
        warnings: [simWarning],
      },
    },
    {
      meta: { formType: "schedule_e", taxYear: year, entityName: null, k1Variant: null, pageStart: 11, pageEnd: 12, confidence: conf("cls-sche") },
      extraction: {
        taxYear: year,
        entityName: null,
        fields: {
          propertyCount: f(1, "sche-count"),
          rentsReceivedTotal: f(rents, "sche-rents"),
          totalExpensesTotal: f(rentalExpensesTotal, "sche-expenses"),
          depreciationTotal: f(rentalDepreciation, "sche-depr"),
          mortgageInterestTotal: f(rentalMortgageInterest, "sche-interest"),
          netRentalRealEstateIncomeOrLoss: f(rentalNet, "sche-net"),
          partnershipSCorpIncomeOrLossTotal: f(schedEPartII, "sche-partii"),
        },
        warnings: [simWarning],
      },
    },
    {
      meta: { formType: "schedule_k1", taxYear: year, entityName: "Simworth Ventures LP", k1Variant: "1065", pageStart: 13, pageEnd: 14, confidence: conf("cls-k1") },
      extraction: {
        taxYear: year,
        entityName: "Simworth Ventures LP",
        fields: {
          entityName: f("Simworth Ventures LP", "k1-entity"),
          entityEinLast4: f(einLast4, "k1-ein"),
          partnerOrShareholderName: f(person, "k1-partner"),
          ordinaryBusinessIncomeOrLoss: f(k1Ordinary, "k1-ordinary"),
          guaranteedPayments: f(k1Guaranteed, "k1-guaranteed"),
          distributionsTotal: f(k1Distributions, "k1-distributions"),
          ownershipPercentEndOfYear: f(50, "k1-pct"),
        },
        warnings: [simWarning],
      },
    },
    {
      meta: { formType: "business_tax_return_1065", taxYear: year, entityName: "Simworth Ventures LP", k1Variant: null, pageStart: 15, pageEnd: 20, confidence: conf("cls-1065") },
      extraction: {
        taxYear: year,
        entityName: "Simworth Ventures LP",
        fields: {
          entityName: f("Simworth Ventures LP", "1065-entity"),
          entityEinLast4: f(einLast4, "1065-ein"),
          businessCodeNaics: f("541611", "1065-naics"),
          grossReceipts: f(r(partnershipOrdinary * 2.2), "1065-receipts"),
          totalIncome: f(partnershipTotalIncome, "1065-income"),
          totalDeductions: f(partnershipTotalDeductions, "1065-deductions"),
          ordinaryBusinessIncomeOrLoss: f(partnershipOrdinary, "1065-ordinary"),
          guaranteedPaymentsToPartners: f(k1Guaranteed * 2, "1065-guaranteed"),
          depreciationDeduction: f(r(6_000 + frac * 4_000), "1065-depr"),
          numberOfSchedulesK1Attached: f(2, "1065-k1count"),
          distributionsTotal: f(partnershipDistributions, "1065-distributions"),
          scheduleLCashEndOfYear: f(lCash, "1065-lcash"),
          scheduleLReceivablesEndOfYear: f(lReceivables, "1065-lrecv"),
          scheduleLInventoriesEndOfYear: f(0, "1065-linv"),
          scheduleLTotalAssetsEndOfYear: f(lCash + lReceivables + 65_000, "1065-lassets"),
          scheduleLAccountsPayableEndOfYear: f(lAp, "1065-lap"),
          scheduleLShortTermDebtEndOfYear: f(lShortDebt, "1065-lstd"),
          scheduleLOtherCurrentLiabilitiesEndOfYear: f(lOtherCurrent, "1065-locl"),
          scheduleLTotalLiabilitiesEndOfYear: f(r(60_000 + frac * 10_000), "1065-lliab"),
        },
        warnings: [simWarning],
      },
    },
    {
      meta: { formType: "tax_return_1040", taxYear: priorYear, entityName: null, k1Variant: null, pageStart: 21, pageEnd: 22, confidence: conf("cls-1040p") },
      extraction: {
        taxYear: priorYear,
        entityName: null,
        fields: {
          taxpayerName: f(person, "1040p-name"),
          filingStatus: f("married_filing_jointly", "1040p-status"),
          wagesSalariesTips: f(priorWages, "1040p-wages"),
          additionalIncomeFromSchedule1: f(priorConsultingNet, "1040p-addl"),
          totalIncome: f(priorTotalIncome, "1040p-total"),
          adjustedGrossIncome: f(priorAgi, "1040p-agi"),
        },
        warnings: [simWarning],
      },
    },
    {
      meta: { formType: "schedule_c", taxYear: priorYear, entityName: "Simworth Consulting", k1Variant: null, pageStart: 23, pageEnd: 25, confidence: conf("cls-schc1p") },
      extraction: {
        taxYear: priorYear,
        entityName: "Simworth Consulting",
        fields: {
          businessName: f("Simworth Consulting", "schc1p-name"),
          businessCodeNaics: f("541611", "schc1p-naics"),
          grossReceipts: f(priorConsultingReceipts, "schc1p-receipts"),
          totalExpenses: f(priorConsultingReceipts - priorConsultingNet, "schc1p-expenses"),
          netProfitOrLoss: f(priorConsultingNet, "schc1p-net"),
          depreciationAndSection179: f(r(consultingDepreciation * 0.9), "schc1p-depr"),
        },
        warnings: [simWarning],
      },
    },
  ];

  return {
    classification: {
      pageCount: 25,
      forms: instances.map((i) => i.meta),
      warnings: [simWarning],
    },
    instances,
  };
}

function simulatedLineage(): ExtractionLineage {
  return { modelId: SIMULATED_MODEL_ID, promptVersion: EXTRACTION_PROMPT_VERSION };
}

/** Pass 1: find every IRS form instance in the uploaded tax package. */
export async function classifyTaxDocument(
  filePath: string,
  storedMimeType?: string,
): Promise<TaxFormClassificationResult> {
  const model = EXTRACTION_MODEL_TAX_PACKAGE;
  if (!anthropic) {
    if (extractionSimulationEnabled()) {
      const sim = buildSimulatedTaxScenario(filePath);
      return { classification: sim.classification, lineage: simulatedLineage(), simulated: true };
    }
    return {
      classification: null,
      lineage: lineageFor(model),
      simulated: false,
      failureReason: "Anthropic API not configured - tax document classification unavailable",
    };
  }

  try {
    const base64 = await fileToBase64(filePath);
    const mimeType = getMimeType(filePath, storedMimeType);
    const text = await withCallTimeout(
      generateExtractionText(anthropic, mimeType, base64, buildClassificationPrompt(), model),
      "Tax document classification",
    );
    const validated = validateExtraction(taxDocumentClassificationSchema, text, "Tax document classification");
    if (validated) {
      return { classification: validated, lineage: rawLineage(text, model), simulated: false };
    }
    return {
      classification: null,
      lineage: rawLineage(text, model),
      simulated: false,
      failureReason: VALIDATION_FAILED_WARNING,
    };
  } catch (error) {
    console.error("Tax document classification error:", error);
    return {
      classification: null,
      lineage: lineageFor(model),
      simulated: false,
      failureReason: "Tax document classification call failed",
    };
  }
}

/** Instances match on (formType, taxYear, entityName) — the classifier's identity triple. */
function matchesSimInstance(
  sim: SimulatedTaxInstance,
  instance: ClassifiedFormInstance,
): boolean {
  return (
    sim.meta.formType === instance.formType &&
    (sim.meta.taxYear ?? null) === (instance.taxYear ?? null) &&
    (sim.meta.entityName ?? null) === (instance.entityName ?? null)
  );
}

/** Pass 2: extract one classified form instance's fields as {value, confidence}. */
export async function extractTaxFormInstanceFields(
  filePath: string,
  instance: ClassifiedFormInstance,
  storedMimeType?: string,
): Promise<TaxFormInstanceExtraction> {
  const model = EXTRACTION_MODEL_TAX_PACKAGE;
  if (!anthropic) {
    if (extractionSimulationEnabled()) {
      const sim = buildSimulatedTaxScenario(filePath);
      const match = sim.instances.find((i) => matchesSimInstance(i, instance));
      if (match) {
        return { ...match.extraction, lineage: simulatedLineage(), simulated: true };
      }
      return {
        taxYear: instance.taxYear ?? null,
        entityName: instance.entityName ?? null,
        fields: {},
        warnings: ["Simulated extraction: no simulated data for this form instance"],
        lineage: simulatedLineage(),
        simulated: true,
      };
    }
    return {
      taxYear: instance.taxYear ?? null,
      entityName: instance.entityName ?? null,
      fields: {},
      warnings: ["Anthropic API not configured - form extraction unavailable"],
      lineage: lineageFor(model),
      simulated: false,
    };
  }

  try {
    const base64 = await fileToBase64(filePath);
    const mimeType = getMimeType(filePath, storedMimeType);
    const text = await withCallTimeout(
      generateExtractionText(anthropic, mimeType, base64, buildFormExtractionPrompt(instance), model),
      `Form extraction (${instance.formType})`,
    );
    const schema = buildFormExtractionResponseSchema(instance.formType);
    const validated = validateExtraction(schema, text, `Form extraction (${instance.formType})`);
    if (!validated) {
      return {
        taxYear: instance.taxYear ?? null,
        entityName: instance.entityName ?? null,
        fields: {},
        warnings: [VALIDATION_FAILED_WARNING],
        lineage: rawLineage(text, model),
        simulated: false,
      };
    }

    // Keep only readable values: a {value: null} entry means "label seen,
    // value unreadable" — that surfaces as a count, never as a number.
    const fields: Record<string, ExtractedFieldValue> = {};
    let unreadable = 0;
    for (const [name, fv] of Object.entries(validated.fields as Record<string, ExtractedFieldValue | undefined>)) {
      if (!fv) continue;
      if (fv.value === null) {
        unreadable += 1;
        continue;
      }
      fields[name] = fv;
    }
    const warnings = [...(validated.warnings ?? [])];
    if (unreadable > 0) {
      warnings.push(`${unreadable} field(s) visible but unreadable - omitted, manual review may be needed`);
    }

    return {
      taxYear: validated.taxYear ?? instance.taxYear ?? null,
      entityName: validated.entityName ?? instance.entityName ?? null,
      fields,
      warnings,
      lineage: rawLineage(text, model),
      simulated: false,
    };
  } catch (error) {
    console.error(`Form extraction error (${instance.formType}):`, error);
    return {
      taxYear: instance.taxYear ?? null,
      entityName: instance.entityName ?? null,
      fields: {},
      warnings: [`Failed to extract ${instance.formType} fields`],
      lineage: lineageFor(model),
      simulated: false,
    };
  }
}
