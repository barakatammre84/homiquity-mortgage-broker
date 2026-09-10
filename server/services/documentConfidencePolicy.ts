/**
 * Pure confidence policy shared by extraction persistence and read-only
 * borrower evidence. This file must stay free of database imports so Homi's
 * live tool-trigger harness can load the production tool definitions without
 * provisioning a database.
 */
export function getReviewThreshold(documentType: string): number {
  const thresholds: Record<string, number> = {
    tax_return: 0.85,
    w2: 0.80,
    pay_stub: 0.80,
    bank_statement: 0.80,
    government_id: 0.90,
    appraisal: 0.85,
    title_report: 0.85,
    insurance: 0.75,
    other: 0.80,
  };
  return thresholds[documentType] || 0.80;
}
