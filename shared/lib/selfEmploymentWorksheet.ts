import type { SelfEmploymentWorksheet } from "@shared/schema";

const nonZero = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value !== 0;

function yearHasFinancialFigures(year: Record<string, unknown> | null | undefined): boolean {
  if (!year) return false;
  return Object.entries(year).some(([key, value]) => {
    if (key === "year") return false;
    if (key === "entityAnalysis" && value && typeof value === "object") {
      return yearHasFinancialFigures(value as Record<string, unknown>);
    }
    return nonZero(value);
  });
}

/**
 * A business worksheet is decision-ready only after the borrower identifies
 * their ownership/history and provides at least one real tax-return figure.
 * Choosing an entity type creates a zero-filled draft for the form controls;
 * that draft must never masquerade as a completed Form 1084 worksheet.
 */
export function isSelfEmploymentWorksheetComplete(
  worksheet: SelfEmploymentWorksheet | null | undefined,
): boolean {
  if (!worksheet || worksheet.ownershipPercent === undefined || worksheet.yearsSelfEmployed === undefined) {
    return false;
  }

  if (worksheet.businessStructure === "sole_proprietorship" || worksheet.businessStructure === "single_member_llc") {
    return yearHasFinancialFigures(worksheet.scheduleC?.currentYear) ||
      yearHasFinancialFigures(worksheet.scheduleC?.priorYear);
  }

  if (worksheet.businessStructure === "partnership" || worksheet.businessStructure === "s_corporation") {
    return nonZero(worksheet.k1?.w2FromBusiness) ||
      yearHasFinancialFigures(worksheet.k1?.currentYear) ||
      yearHasFinancialFigures(worksheet.k1?.priorYear);
  }

  return false;
}
