// Document-type vocabulary bridge.
//
// Two vocabularies grew up independently: the pipeline engine's condition
// requirements use coarse canonical types ("pay_stub", "government_id",
// "bank_statement", "tax_return", "homeowners_insurance"), while the borrower
// Documents checklist uploads finer-grained catalog types ("paystub",
// "drivers_license", "bank_statement_checking", "tax_return_1040",
// "homeowners_insurance_binder"). The condition auto-matcher compares with
// exact equality, so catalog uploads silently failed to clear conditions.
//
// This map canonicalizes on COMPARISON rather than renaming either vocabulary
// — extraction mappers, coaching heuristics, and existing DB rows all keep
// their current strings. Add new aliases here, never a second map elsewhere.

const DOCUMENT_TYPE_CANONICAL: Record<string, string> = {
  // Borrower checklist catalog → pipeline-engine canonical
  paystub: "pay_stub",
  pay_stubs: "pay_stub",
  drivers_license: "government_id",
  passport: "government_id",
  id: "government_id",
  tax_return_1040: "tax_return",
  profit_loss_statement: "profit_loss",
  bank_statement_checking: "bank_statement",
  bank_statement_savings: "bank_statement",
  bank_statement_business: "business_bank_statement",
  homeowners_insurance_binder: "homeowners_insurance",
  retirement_statement_401k: "retirement_statement",
  retirement_statement_ira: "retirement_statement",
};

type ExtractionDocumentType =
  | "tax_return"
  | "pay_stub"
  | "w2"
  | "bank_statement"
  | "lease_agreement"
  | "profit_loss";

const TAX_PACKAGE_UPLOAD_TYPES = new Set([
  "tax_return",
  "tax_return_1040",
  "rental_tax_package",
  "capital_gains_tax_package",
  "tax_return_1065",
  "tax_return_1120",
  "tax_return_1120s",
  "tax_return_k1",
  "business_tax_return_1065",
  "business_tax_return_1120",
  "business_tax_return_1120s",
  "schedule_k1",
  "1099_misc",
  "1099_nec",
]);

/**
 * Resolve the uploader/checklist vocabulary to the extractor family without
 * changing the document type stored on the immutable file record. The stored
 * type still distinguishes a personal statement from a business statement;
 * the provider dispatch only needs to know which reader can parse the bytes.
 */
export function extractionDocumentType(
  type: string | null | undefined,
): ExtractionDocumentType | null {
  if (!type) return null;
  if (TAX_PACKAGE_UPLOAD_TYPES.has(type)) return "tax_return";
  const normalized = canonicalDocumentType(type);
  if (normalized === "tax_return") return "tax_return";
  if (normalized === "pay_stub") return "pay_stub";
  if (normalized === "w2") return "w2";
  if (normalized === "bank_statement" || normalized === "business_bank_statement") {
    return "bank_statement";
  }
  if (["brokerage_statement", "retirement_statement"].includes(normalized)) return "bank_statement";
  if (normalized === "lease_agreement") return "lease_agreement";
  if (normalized === "profit_loss") return "profit_loss";
  return null;
}

export function isTaxReturnDocumentType(type: string | null | undefined): boolean {
  return extractionDocumentType(type) === "tax_return";
}

export function isBusinessBankStatementDocumentType(type: string | null | undefined): boolean {
  return !!type && canonicalDocumentType(type) === "business_bank_statement";
}

export function canonicalDocumentType(type: string): string {
  return DOCUMENT_TYPE_CANONICAL[type] ?? type;
}

/** True when an uploaded document type satisfies a required document type. */
export function documentTypesMatch(requiredType: string, uploadedType: string): boolean {
  return canonicalDocumentType(requiredType) === canonicalDocumentType(uploadedType);
}
