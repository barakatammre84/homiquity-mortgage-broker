import type { ExtractedTaxReturnData } from "../extractionService";
import type { InsertTaxInsight, TaxInsight } from "@shared/schema";
import { taxInsights } from "@shared/schema";
import type { PublicTaxFormInstance, TaxIntelligenceRunSummary } from "./taxDocumentIntelligence";
import {
  withActiveTaxDocumentConsent,
  type TaxConsentTransaction,
} from "./taxConsentWorkflow";

/**
 * Turns a validated tax-return extraction into the derived signals stored in
 * tax_insights. Marketing/readiness signals only — never underwriting inputs
 * (figures are re-verified from source documents during an application).
 *
 * dscrCandidate deliberately requires better-than-low confidence: a garbled
 * extraction must not put someone on the staff investor-lead list.
 */

const toMoney = (v: number | undefined): string | null =>
  v === undefined ? null : v.toFixed(2);

export function deriveTaxInsight(
  extracted: ExtractedTaxReturnData,
): Omit<InsertTaxInsight, "userId" | "documentId"> {
  const scheduleE = extracted.scheduleE;
  const hasScheduleE =
    !!scheduleE &&
    (scheduleE.netRentalIncomeLoss !== undefined || (scheduleE.propertyCount ?? 0) > 0);
  const selfEmployed =
    !!extracted.scheduleC && extracted.scheduleC.netProfitLoss !== undefined;

  const parsedYear = parseInt(extracted.documentYear, 10);
  const taxYear = Number.isFinite(parsedYear) ? parsedYear : new Date().getFullYear() - 1;

  return {
    taxYear,
    wagesW2: toMoney(extracted.w2Wages),
    grossIncome: toMoney(extracted.grossIncome),
    adjustedGrossIncome: toMoney(extracted.adjustedGrossIncome),
    scheduleCNetProfit: toMoney(extracted.scheduleC?.netProfitLoss),
    scheduleENetRental: toMoney(scheduleE?.netRentalIncomeLoss),
    scheduleEGrossRents: toMoney(scheduleE?.grossRents),
    rentalPropertyCount: scheduleE?.propertyCount ?? null,
    selfEmployed,
    dscrCandidate: hasScheduleE && extracted.confidence !== "low",
    confidence: extracted.confidence,
    modelId: extracted.modelId ?? null,
    promptVersion: extracted.promptVersion ?? null,
  };
}

/**
 * Derive + upsert (one row per user + tax year). Low-confidence extractions
 * still persist so the client can show "we couldn't read this clearly — try a
 * clearer copy" instead of silently dropping the upload.
 */
export async function saveTaxInsightForDocument(
  userId: string,
  documentId: string,
  extracted: ExtractedTaxReturnData,
): Promise<TaxInsight | null> {
  const result = await withActiveTaxDocumentConsent(userId, async (transaction) => {
    return saveTaxInsightForDocumentInTransaction(
      transaction,
      userId,
      documentId,
      extracted,
    );
  });
  return result.authorized ? result.value : null;
}

export async function saveTaxInsightForDocumentInTransaction(
  transaction: TaxConsentTransaction,
  userId: string,
  documentId: string,
  extracted: ExtractedTaxReturnData,
): Promise<TaxInsight> {
  const data = { userId, documentId, ...deriveTaxInsight(extracted) };
  const [insight] = await transaction
    .insert(taxInsights)
    .values(data)
    .onConflictDoUpdate({
      target: [taxInsights.userId, taxInsights.taxYear],
      set: { ...data, updatedAt: new Date() },
    })
    .returning();
  return insight;
}

function numericField(
  forms: PublicTaxFormInstance[],
  formType: PublicTaxFormInstance["formType"],
  fieldName: string,
): number | undefined {
  const value = forms.find((form) => form.formType === formType)?.fields[fieldName]?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sumNumericField(
  forms: PublicTaxFormInstance[],
  formType: PublicTaxFormInstance["formType"],
  fieldName: string,
): number | undefined {
  const values = forms
    .filter((form) => form.formType === formType)
    .map((form) => form.fields[fieldName]?.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

/**
 * Project the richer page/form extraction into the small borrower readiness
 * card. The source run stays provisional; this derived row is never used as a
 * binding underwriting calculation.
 */
export function deriveTaxInsightFromStructuredRun(
  run: TaxIntelligenceRunSummary,
): Omit<InsertTaxInsight, "userId" | "documentId"> {
  const years = run.forms
    .map((form) => form.taxYear)
    .filter((year): year is number => typeof year === "number" && Number.isFinite(year));
  const taxYear = years.length > 0 ? Math.max(...years) : new Date().getFullYear() - 1;
  const scheduleCNet = sumNumericField(run.forms, "schedule_c", "netProfitOrLoss");
  const scheduleENet = sumNumericField(
    run.forms,
    "schedule_e",
    "netRentalRealEstateIncomeOrLoss",
  );
  const scheduleEGross = sumNumericField(run.forms, "schedule_e", "rentsReceivedTotal");
  const rentalPropertyCount = sumNumericField(run.forms, "schedule_e", "propertyCount");
  const hasRentalForms = run.forms.some(
    (form) => form.formType === "schedule_e" || form.formType === "form_8825",
  );
  const confidence = run.overallConfidence >= 0.85
    ? "high"
    : run.overallConfidence >= 0.7
      ? "medium"
      : "low";

  return {
    taxYear,
    wagesW2: toMoney(numericField(run.forms, "tax_return_1040", "wagesSalariesTips")),
    grossIncome: toMoney(numericField(run.forms, "tax_return_1040", "totalIncome")),
    adjustedGrossIncome: toMoney(
      numericField(run.forms, "tax_return_1040", "adjustedGrossIncome"),
    ),
    scheduleCNetProfit: toMoney(scheduleCNet),
    scheduleENetRental: toMoney(scheduleENet),
    scheduleEGrossRents: toMoney(scheduleEGross),
    rentalPropertyCount: rentalPropertyCount ?? null,
    selfEmployed: scheduleCNet !== undefined,
    dscrCandidate: hasRentalForms && confidence !== "low",
    confidence,
    modelId: run.modelId,
    promptVersion: run.promptVersion,
  };
}

export async function saveTaxInsightFromStructuredRunIfAuthorized(
  userId: string,
  documentId: string,
  run: TaxIntelligenceRunSummary,
): Promise<TaxInsight | null> {
  const result = await withActiveTaxDocumentConsent(userId, async (transaction) => {
    return saveTaxInsightFromStructuredRunInTransaction(transaction, userId, documentId, run);
  });
  return result.authorized ? result.value : null;
}

export async function saveTaxInsightFromStructuredRunInTransaction(
  transaction: TaxConsentTransaction,
  userId: string,
  documentId: string,
  run: TaxIntelligenceRunSummary,
): Promise<TaxInsight> {
  const data = {
    userId,
    documentId,
    ...deriveTaxInsightFromStructuredRun(run),
  };
  const [insight] = await transaction
    .insert(taxInsights)
    .values(data)
    .onConflictDoUpdate({
      target: [taxInsights.userId, taxInsights.taxYear],
      set: { ...data, updatedAt: new Date() },
    })
    .returning();
  return insight;
}
