import { describe, it, expect } from "vitest";
import {
  canonicalDocumentType,
  documentTypesMatch,
  extractionDocumentType,
  isBusinessBankStatementDocumentType,
  isTaxReturnDocumentType,
} from "../shared/documentTypes";

// Guards the vocabulary bridge between the pipeline engine's condition
// requirements and the borrower checklist's upload types. Before this bridge,
// uploading "Recent Pay Stubs" (type "paystub") could never clear the
// "Recent Pay Stubs Required" condition (requires "pay_stub") — the exact
// drift this file exists to prevent.

describe("document type vocabulary bridge", () => {
  it("maps every borrower-checklist type that has an engine counterpart", () => {
    // Left: type posted by client/src/pages/borrower/Documents.tsx catalog.
    // Right: type required by server/pipelineEngine.ts conditions.
    const pairs: [string, string][] = [
      ["paystub", "pay_stub"],
      ["drivers_license", "government_id"],
      ["passport", "government_id"],
      ["tax_return_1040", "tax_return"],
      ["bank_statement_checking", "bank_statement"],
      ["bank_statement_savings", "bank_statement"],
      ["bank_statement_business", "business_bank_statement"],
      ["homeowners_insurance_binder", "homeowners_insurance"],
    ];
    for (const [catalog, engine] of pairs) {
      expect(canonicalDocumentType(catalog)).toBe(engine);
      expect(documentTypesMatch(engine, catalog)).toBe(true);
    }
  });

  it("routes checklist aliases through the correct extraction family", () => {
    expect(extractionDocumentType("paystub")).toBe("pay_stub");
    expect(extractionDocumentType("bank_statement_checking")).toBe("bank_statement");
    expect(extractionDocumentType("bank_statement_business")).toBe("bank_statement");
    expect(extractionDocumentType("business_bank_statement")).toBe("bank_statement");
    expect(extractionDocumentType("brokerage_statement")).toBe("bank_statement");
    expect(extractionDocumentType("retirement_statement_401k")).toBe("bank_statement");
    expect(extractionDocumentType("retirement_statement_ira")).toBe("bank_statement");
    expect(extractionDocumentType("tax_return_1040")).toBe("tax_return");
    expect(extractionDocumentType("rental_tax_package")).toBe("tax_return");
    expect(extractionDocumentType("capital_gains_tax_package")).toBe("tax_return");
    expect(extractionDocumentType("1099_misc")).toBe("tax_return");
    expect(extractionDocumentType("1099_nec")).toBe("tax_return");
    expect(extractionDocumentType("business_tax_return_1120s")).toBe("tax_return");
    expect(extractionDocumentType("profit_loss")).toBe("profit_loss");
    expect(extractionDocumentType("profit_loss_statement")).toBe("profit_loss");
    expect(isTaxReturnDocumentType("tax_return_1040")).toBe(true);
    expect(isTaxReturnDocumentType("1099_misc")).toBe(true);
    expect(documentTypesMatch("tax_return", "1099_misc")).toBe(false);
    expect(documentTypesMatch("rental_tax_package", "tax_return_1040")).toBe(false);
    expect(documentTypesMatch("capital_gains_tax_package", "rental_tax_package")).toBe(false);
    expect(isBusinessBankStatementDocumentType("bank_statement_business")).toBe(true);
    expect(extractionDocumentType("government_id")).toBeNull();
  });

  it("matches identical types without an alias entry", () => {
    expect(documentTypesMatch("w2", "w2")).toBe(true);
    expect(documentTypesMatch("purchase_contract", "purchase_contract")).toBe(true);
  });

  it("passes unknown types through unchanged and never cross-matches", () => {
    expect(canonicalDocumentType("letter_of_explanation")).toBe("letter_of_explanation");
    expect(documentTypesMatch("pay_stub", "w2")).toBe(false);
    expect(documentTypesMatch("government_id", "bank_statement_checking")).toBe(false);
  });
});
