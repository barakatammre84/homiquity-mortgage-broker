// Zod response schemas, validation + confidence capping, consistency checks, lineage builders.
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

import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { computeHash, encryptSensitiveData } from "./services/encryptionService";
import { type ExtractionLineage, type ExtractedTaxReturnData, type ExtractedPayStubData, type ExtractedW2Data, type ExtractedBankStatementData, type ExtractedLeaseData, type DocumentClassification, EXTRACTION_PROMPT_VERSION } from "./extractionCore";
import { DOCUMENT_TYPE_TAXONOMY, type DocumentTypeTaxonomy } from "@shared/schema/documents";

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

const MAX_MONEY = 100_000_000;

function coerceMoney(v: unknown): unknown {
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return v ?? undefined;
}

// Invalid values yield `undefined` (field dropped) rather than failing the record.
const money = z.preprocess(coerceMoney, z.number().finite().min(0).max(MAX_MONEY)).optional().catch(undefined);
const signedMoney = z.preprocess(coerceMoney, z.number().finite().min(-MAX_MONEY).max(MAX_MONEY)).optional().catch(undefined);
const shortText = z.string().trim().min(1).max(200).optional().catch(undefined);
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined);
const confidenceLevel = z.enum(["high", "medium", "low"]).catch("low");
const extractedFieldsList = z.array(z.string().max(100)).max(50).catch([]);
const warningsList = z.array(z.string().max(500)).max(20).optional().catch(undefined);
const normalizedCoordinate = z.number().finite().min(0).max(1);
const boundingBoxSchema = z.object({
  x: normalizedCoordinate,
  y: normalizedCoordinate,
  width: normalizedCoordinate,
  height: normalizedCoordinate,
}).refine(
  (box) => box.x + box.width <= 1.001 && box.y + box.height <= 1.001,
  "Bounding box must stay within the page",
);
const fieldEvidenceSchema = z.record(
  z.string().trim().min(1).max(100),
  z.object({
    pageNumber: z.number().int().min(1).max(1000),
    confidence: z.number().finite().min(0).max(1),
    boundingBox: boundingBoxSchema.optional().catch(undefined),
  }),
).optional().catch(undefined);
const pageCount = z.number().int().min(1).max(1000).optional().catch(undefined);
const documentTypeTaxonomy = new Set<string>(DOCUMENT_TYPE_TAXONOMY);
const classifiedDocumentType = z.custom<DocumentTypeTaxonomy>(
  (value) => typeof value === "string" && documentTypeTaxonomy.has(value),
  "Unknown mortgage document type",
);
const documentClassificationSchema: z.ZodType<DocumentClassification> = z.object({
  pageCount: z.number().int().min(1).max(1000),
  pages: z.array(z.object({
    pageNumber: z.number().int().min(1).max(1000),
    documentType: classifiedDocumentType,
    confidence: z.number().finite().min(0).max(1),
  }).strict()).min(1).max(1000),
}).strict().superRefine((classification, context) => {
  if (classification.pages.length !== classification.pageCount) {
    context.addIssue({
      code: "custom",
      path: ["pages"],
      message: "Classification must contain exactly one entry for every page",
    });
    return;
  }
  const ordered = [...classification.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].pageNumber !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["pages", index, "pageNumber"],
        message: "Classification pages must cover the source once, in 1-indexed order",
      });
      return;
    }
  }
});

function valueAtPath(value: Record<string, unknown>, pathName: string): unknown {
  return pathName.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function requireSourceEvidence<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
  fieldPaths: readonly string[],
) {
  return schema.superRefine((value, context) => {
    const record = value as Record<string, unknown>;
    const evidence = record.fieldEvidence as Record<string, unknown> | undefined;
    for (const fieldPath of fieldPaths) {
      const fieldValue = valueAtPath(record, fieldPath);
      if (fieldValue === undefined || fieldValue === null || fieldValue === "") continue;
      if (!evidence?.[fieldPath]) {
        context.addIssue({
          code: "custom",
          path: ["fieldEvidence", fieldPath],
          message: `Source page evidence is required for ${fieldPath}`,
        });
      }
    }
  });
}

export const taxReturnSchema = requireSourceEvidence(z.object({
  documentYear: z.string().trim().regex(/^\d{4}$/).optional().catch(undefined),
  taxpayerName: shortText,
  w2Wages: money,
  grossIncome: money,
  adjustedGrossIncome: money,
  taxableIncome: money,
  filingStatus: shortText,
  scheduleC: z.object({
    businessIncome: money,
    businessExpenses: money,
    netProfitLoss: signedMoney,
  }).optional().catch(undefined),
  scheduleD: z.object({
    capitalGains: signedMoney,
  }).optional().catch(undefined),
  scheduleE: z.object({
    netRentalIncomeLoss: signedMoney,
    grossRents: money,
    totalDepreciation: money,
    mortgageInterest: money,
    propertyCount: z.preprocess(coerceMoney, z.number().int().min(0).max(50)).optional().catch(undefined),
  }).optional().catch(undefined),
  confidence: confidenceLevel,
  extractedFields: extractedFieldsList,
  warnings: warningsList,
  fieldEvidence: fieldEvidenceSchema,
  pageCount,
}), [
  "taxpayerName", "w2Wages", "grossIncome", "adjustedGrossIncome", "taxableIncome", "filingStatus",
  "scheduleC.businessIncome", "scheduleC.businessExpenses", "scheduleC.netProfitLoss",
  "scheduleD.capitalGains", "scheduleE.netRentalIncomeLoss", "scheduleE.grossRents",
  "scheduleE.totalDepreciation", "scheduleE.mortgageInterest", "scheduleE.propertyCount",
]);

/**
 * Test seam: parse + schema-validate a raw tax-return model response.
 * Exercises the same untrusted-input path extractTaxReturnData uses.
 */
export function validateTaxReturnResponse(rawText: string) {
  return validateExtraction(taxReturnSchema, rawText, "Tax return");
}

export const payStubSchema = requireSourceEvidence(z.object({
  employeeName: shortText,
  employerName: shortText,
  payPeriodStartDate: isoDate,
  payPeriodEndDate: isoDate,
  grossPay: money,
  netPay: money,
  ytdGross: money,
  ytdNetPay: money,
  ytdTaxes: money,
  deductions: z.object({
    federal: money,
    fica: money,
    other: money,
  }).optional().catch(undefined),
  confidence: confidenceLevel,
  extractedFields: extractedFieldsList,
  warnings: warningsList,
  fieldEvidence: fieldEvidenceSchema,
  pageCount,
  documentClassification: documentClassificationSchema,
}), [
  "employeeName", "employerName", "payPeriodStartDate", "payPeriodEndDate", "grossPay", "netPay",
  "ytdGross", "ytdNetPay", "ytdTaxes", "deductions.federal", "deductions.fica", "deductions.other",
]);

export const w2Schema = requireSourceEvidence(z.object({
  employeeName: shortText,
  employerName: shortText,
  taxYear: z.string().trim().regex(/^\d{4}$/).optional().catch(undefined),
  // PII minimization: keep only the final four EIN digits even if a provider
  // returns the full value against instructions.
  employerEinLast4: z.string().trim().max(50)
    .transform((value) => value.replace(/\D/g, "").slice(-4) || undefined)
    .optional().catch(undefined),
  wagesTipsOtherCompensation: money,
  federalIncomeTaxWithheld: money,
  socialSecurityWages: money,
  socialSecurityTaxWithheld: money,
  medicareWagesAndTips: money,
  medicareTaxWithheld: money,
  stateWagesTips: money,
  stateCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional().catch(undefined),
  confidence: confidenceLevel,
  extractedFields: extractedFieldsList,
  warnings: warningsList,
  fieldEvidence: fieldEvidenceSchema,
  pageCount,
  documentClassification: documentClassificationSchema,
}), [
  "employeeName", "employerName", "taxYear", "employerEinLast4",
  "wagesTipsOtherCompensation", "federalIncomeTaxWithheld", "socialSecurityWages",
  "socialSecurityTaxWithheld", "medicareWagesAndTips", "medicareTaxWithheld",
  "stateWagesTips", "stateCode",
]);

/** Test and calibration seam for the same untrusted W-2 response path. */
export function validateW2Response(rawText: string) {
  return validateExtraction(w2Schema, rawText, "W-2");
}

export const bankStatementSchema = requireSourceEvidence(z.object({
  accountType: shortText,
  // PII minimization: whatever the model returns, only the last 4 digits are kept.
  accountNumber: z.string().trim().max(50)
    .transform((s) => s.replace(/\D/g, "").slice(-4) || undefined)
    .optional().catch(undefined),
  statementPeriod: z.object({ start: isoDate, end: isoDate }).optional().catch(undefined),
  openingBalance: signedMoney,
  closingBalance: signedMoney,
  totalDeposits: money,
  totalWithdrawals: money,
  averageDailyBalance: signedMoney,
  transactions: z.array(z.object({
    date: z.string().trim().max(20).catch(""),
    description: z.string().trim().max(200).catch(""),
    amount: z.preprocess(coerceMoney, z.number().finite().min(-MAX_MONEY).max(MAX_MONEY)).catch(0),
    type: z.enum(["deposit", "withdrawal"]).catch("deposit"),
  })).max(20).optional().catch(undefined),
  confidence: confidenceLevel,
  extractedFields: extractedFieldsList,
  warnings: warningsList,
  fieldEvidence: fieldEvidenceSchema,
  pageCount,
  documentClassification: documentClassificationSchema,
}), [
  "accountType", "accountNumber", "statementPeriod.start", "statementPeriod.end", "openingBalance",
  "closingBalance", "totalDeposits", "totalWithdrawals", "averageDailyBalance",
]);

export const leaseSchema = requireSourceEvidence(z.object({
  monthlyRent: money,
  tenantName: shortText,
  landlordName: shortText,
  propertyAddress: z.string().trim().min(1).max(300).optional().catch(undefined),
  leaseStartDate: isoDate,
  leaseEndDate: isoDate,
  securityDeposit: money,
  confidence: confidenceLevel,
  extractedFields: extractedFieldsList,
  warnings: warningsList,
  fieldEvidence: fieldEvidenceSchema,
  pageCount,
  documentClassification: documentClassificationSchema,
}), [
  "monthlyRent", "tenantName", "landlordName", "propertyAddress", "leaseStartDate", "leaseEndDate",
  "securityDeposit",
]);

/** Test seam for the page-classification boundary on simple documents. */
export function validateDocumentClassification(value: unknown) {
  const result = documentClassificationSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Parse + schema-validate a raw model response. Returns null when the payload
 * is structurally unusable (no JSON object / not an object) — field-level
 * problems are absorbed by the per-field `.catch()` fallbacks above.
 */
export function validateExtraction<S extends z.ZodTypeAny>(
  schema: S,
  rawText: string,
  docLabel: string,
): z.infer<S> | null {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    console.error(`${docLabel} extraction failed schema validation:`, result.error.issues.slice(0, 3));
    return null;
  }
  return result.data;
}

type ConfidenceLevel = "high" | "medium" | "low";
const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { low: 0, medium: 1, high: 2 };

/** Cap the model's self-reported confidence when our own checks contradict it. */
export function capConfidence(
  data: { confidence: ConfidenceLevel; warnings?: string[] },
  cap: ConfidenceLevel,
  reason: string,
): void {
  data.warnings = [...(data.warnings ?? []), reason];
  if (CONFIDENCE_RANK[data.confidence] > CONFIDENCE_RANK[cap]) {
    data.confidence = cap;
  }
}

// Exported as a test seam: this cross-field hardening runs only in the real
// model path (after schema validation), so the unit tests exercise it directly.
export function checkTaxReturnConsistency(data: ExtractedTaxReturnData): void {
  if (data.taxableIncome !== undefined && data.grossIncome !== undefined && data.taxableIncome > data.grossIncome) {
    capConfidence(data, "medium", "Consistency check: taxable income exceeds gross income");
  }
  if (data.adjustedGrossIncome !== undefined && data.grossIncome !== undefined && data.adjustedGrossIncome > data.grossIncome) {
    capConfidence(data, "medium", "Consistency check: AGI exceeds gross income");
  }
  if (data.w2Wages !== undefined && data.grossIncome !== undefined && data.w2Wages > data.grossIncome) {
    capConfidence(data, "medium", "Consistency check: W-2 wages exceed gross income");
  }
  if (
    data.scheduleE?.netRentalIncomeLoss !== undefined &&
    data.scheduleE.grossRents !== undefined &&
    data.scheduleE.netRentalIncomeLoss > data.scheduleE.grossRents
  ) {
    capConfidence(data, "medium", "Consistency check: Schedule E net rental income exceeds gross rents");
  }
}

export function checkPayStubConsistency(data: ExtractedPayStubData): void {
  if (data.netPay !== undefined && data.grossPay !== undefined && data.netPay > data.grossPay) {
    capConfidence(data, "medium", "Consistency check: net pay exceeds gross pay");
  }
  if (data.ytdNetPay !== undefined && data.ytdGross !== undefined && data.ytdNetPay > data.ytdGross) {
    capConfidence(data, "medium", "Consistency check: YTD net exceeds YTD gross");
  }
  if (data.grossPay !== undefined && data.ytdGross !== undefined && data.grossPay > data.ytdGross) {
    capConfidence(data, "medium", "Consistency check: period gross exceeds YTD gross");
  }
}

export function checkW2Consistency(data: ExtractedW2Data): void {
  if (
    data.federalIncomeTaxWithheld !== undefined &&
    data.wagesTipsOtherCompensation !== undefined &&
    data.federalIncomeTaxWithheld > data.wagesTipsOtherCompensation
  ) {
    capConfidence(data, "medium", "Consistency check: federal withholding exceeds Box 1 wages");
  }
  if (
    data.socialSecurityTaxWithheld !== undefined &&
    data.socialSecurityWages !== undefined &&
    data.socialSecurityTaxWithheld > data.socialSecurityWages
  ) {
    capConfidence(data, "medium", "Consistency check: Social Security withholding exceeds Box 3 wages");
  }
  if (
    data.medicareTaxWithheld !== undefined &&
    data.medicareWagesAndTips !== undefined &&
    data.medicareTaxWithheld > data.medicareWagesAndTips
  ) {
    capConfidence(data, "medium", "Consistency check: Medicare withholding exceeds Box 5 wages");
  }
}

export function checkBankStatementConsistency(data: ExtractedBankStatementData): void {
  if (
    data.openingBalance !== undefined &&
    data.closingBalance !== undefined &&
    data.totalDeposits !== undefined &&
    data.totalWithdrawals !== undefined
  ) {
    const expectedClosing = data.openingBalance + data.totalDeposits - data.totalWithdrawals;
    // Tolerance for fee/interest lines not captured in the two aggregates.
    if (Math.abs(expectedClosing - data.closingBalance) > Math.max(100, Math.abs(data.closingBalance) * 0.05)) {
      capConfidence(data, "medium", "Consistency check: balances do not reconcile (opening + deposits - withdrawals != closing)");
    }
  }
}

export function checkLeaseConsistency(data: ExtractedLeaseData): void {
  if (data.monthlyRent !== undefined && (data.monthlyRent < 100 || data.monthlyRent > 50_000)) {
    capConfidence(data, "medium", "Consistency check: monthly rent outside plausible range");
  }
  if (data.securityDeposit !== undefined && data.monthlyRent !== undefined && data.securityDeposit > 12 * data.monthlyRent) {
    capConfidence(data, "medium", "Consistency check: security deposit exceeds 12x monthly rent");
  }
}

/** Bare model/prompt lineage — used for fallbacks where there is no raw output. */
export function lineageFor(model: string): ExtractionLineage {
  return { modelId: model, promptVersion: EXTRACTION_PROMPT_VERSION };
}
export const VALIDATION_FAILED_WARNING =
  "Model output failed schema validation - values discarded, manual review required";

/**
 * Lineage for a successful extraction: model/prompt ids plus a hash of the raw
 * model response and the raw response itself, encrypted (it can carry PII).
 * Lets an auditor later confirm the stored fields came from that exact output.
 */
export function rawLineage(rawText: string, model: string): ExtractionLineage {
  const enc = encryptSensitiveData(rawText);
  return {
    ...lineageFor(model),
    rawResponseHash: computeHash(rawText),
    rawResponseEncrypted: enc.encryptedContent,
    rawResponseIv: enc.iv,
    rawResponseKeyId: enc.keyId,
  };
}
