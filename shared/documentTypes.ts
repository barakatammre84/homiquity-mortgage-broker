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
  homeowners_insurance_binder: "homeowners_insurance",
};

export function canonicalDocumentType(type: string): string {
  return DOCUMENT_TYPE_CANONICAL[type] ?? type;
}

/** True when an uploaded document type satisfies a required document type. */
export function documentTypesMatch(requiredType: string, uploadedType: string): boolean {
  return canonicalDocumentType(requiredType) === canonicalDocumentType(uploadedType);
}
