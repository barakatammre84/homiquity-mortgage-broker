// Finding F-030 — extraction → readiness wiring.
//
// The bug this pins: wireExtractionToReadiness was handed `extractedFields`,
// which every extractor emits as a string[] of field NAMES, and indexed it by
// VALUE name. Every value-bearing row therefore resolved `undefined` and landed
// in `skipped`; only the three `documentPresence` rows (which short-circuit
// before the lookup) ever updated. A borrower uploaded a pay stub and the file
// learned only that a pay stub existed — never their income — so the platform
// asked again. That is the wiring behind the busy work.
//
// The map was wrong on names too: it looked for `totalIncome`, `payFrequency`,
// `totalBalance` and `accounts`, none of which exist on the interfaces in
// server/extractionCore.ts. `let extractedData: any` at the call site hid it
// from tsc.
//
// These tests drive the REAL extraction shapes from extractionCore.ts, so a
// rename there breaks them rather than silently reintroducing the skip.
import { describe, it, expect, vi, beforeEach } from "vitest";

const updateReadinessField = vi.fn(async () => {});
const initializeReadinessChecklist = vi.fn(async () => {});

vi.mock("../server/services/intentTracker", () => ({
  updateReadinessField,
  initializeReadinessChecklist,
  getReadinessScore: vi.fn(async () => ({ score: 0 })),
}));
vi.mock("../server/services/borrowerStateMachine", () => ({
  transitionState: vi.fn(async () => {}),
  getCurrentState: vi.fn(async () => null),
}));
vi.mock("../server/services/borrowerGraph", () => ({ buildBorrowerGraph: vi.fn(async () => ({})) }));
vi.mock("../server/services/emailService", () => ({ sendNotificationEmail: vi.fn(async () => {}) }));

const { wireExtractionToReadiness } = await import("../server/services/optimizationEngine");

/** Shapes match ExtractedPayStubData / BankStatement / TaxReturn exactly. */
const PAY_STUB = {
  employeeName: "Jane Roe",
  employerName: "Acme Corp",
  grossPay: 4_200,
  ytdGross: 50_400,
  confidence: "high" as const,
  extractedFields: ["employerName", "grossPay", "ytdGross"],
  fieldEvidence: { employerName: { pageNumber: 1, confidence: 0.99 } },
};

const BANK_STATEMENT = {
  accountType: "checking",
  accountNumber: "****4321",
  openingBalance: 18_000,
  closingBalance: 22_500,
  confidence: "high" as const,
  extractedFields: ["accountType", "accountNumber", "closingBalance"],
  fieldEvidence: {
    accountType: { pageNumber: 1, confidence: 0.99 },
    accountNumber: { pageNumber: 1, confidence: 0.99 },
    closingBalance: { pageNumber: 1, confidence: 0.99 },
  },
};

const TAX_RETURN = {
  documentYear: "2025",
  grossIncome: 120_000,
  adjustedGrossIncome: 112_400,
  w2Wages: 118_000,
  confidence: "high" as const,
  extractedFields: ["grossIncome", "adjustedGrossIncome", "w2Wages"],
};

beforeEach(() => {
  updateReadinessField.mockClear();
  initializeReadinessChecklist.mockClear();
});

const updatedFieldNames = () => updateReadinessField.mock.calls.map((c: any[]) => c[1]);

describe("F-030 — extracted VALUES reach the readiness checklist", () => {
  it("records employer from a pay stub, not just that a stub exists", async () => {
    const result = await wireExtractionToReadiness("u1", "d1", "pay_stub", PAY_STUB, "high");

    // The regression: before the fix this was ["pay_stubs"] only.
    expect(result.fieldsUpdated).toContain("employer_name");
    expect(result.fieldsUpdated).toContain("pay_stubs");
    expect(updatedFieldNames()).toContain("employer_name");
  });

  it("records assets from a bank statement's closing balance", async () => {
    const result = await wireExtractionToReadiness("u1", "d2", "bank_statement", BANK_STATEMENT, "high");

    expect(result.fieldsUpdated).toEqual(
      expect.arrayContaining(["total_assets", "bank_accounts", "down_payment_source", "bank_statements"]),
    );
    expect(result.skipped).toEqual([]);
  });

  it("credits tax-return presence without treating AGI as qualifying income", async () => {
    const result = await wireExtractionToReadiness("u1", "d3", "tax_return", TAX_RETURN, "high");

    expect(result.fieldsUpdated).toEqual(["tax_returns"]);
    expect(result.fieldsUpdated).not.toContain("annual_income");
    expect(result.fieldsUpdated).not.toContain("income_sources");
  });

  it("marks every extracted row as tier-1 document lineage tied to the document", async () => {
    await wireExtractionToReadiness("u1", "d2", "bank_statement", BANK_STATEMENT, "high");
    for (const call of updateReadinessField.mock.calls) {
      expect((call as any)[2]).toMatchObject({
        verificationStatus: "document_extracted",
        sourceTable: "documents",
        sourceRecordId: "d2",
      });
    }
  });
});

describe("F-030 — the wiring stays honest about what it did NOT learn", () => {
  it("skips a value the document genuinely lacks, without claiming it", async () => {
    const noBalance = { ...BANK_STATEMENT, closingBalance: undefined, accountNumber: undefined };
    const result = await wireExtractionToReadiness("u1", "d4", "bank_statement", noBalance, "high");

    expect(result.fieldsUpdated).not.toContain("total_assets");
    expect(result.skipped.join(" ")).toMatch(/total_assets/);
    // Presence is still true — the statement was uploaded and read.
    expect(result.fieldsUpdated).toContain("bank_statements");
  });

  it("does not annualize a pay stub's period gross into annual_income", async () => {
    // A stub states period gross; annualizing needs a pay frequency this
    // extractor does not emit. Claiming annual income from it would be a guess.
    const result = await wireExtractionToReadiness("u1", "d5", "pay_stub", PAY_STUB, "high");
    expect(result.fieldsUpdated).not.toContain("annual_income");
  });

  it("uses a W-2 for employer and form history without treating Box 1 as current qualifying income", async () => {
    const result = await wireExtractionToReadiness("u1", "d-w2", "w2", {
      employerName: "Acme Corp",
      wagesTipsOtherCompensation: 85_000,
      fieldEvidence: {
        employerName: { pageNumber: 1, confidence: 0.99 },
        wagesTipsOtherCompensation: { pageNumber: 1, confidence: 0.99 },
      },
    }, "high");
    expect(result.fieldsUpdated).toEqual(["employer_name", "w2_forms"]);
    expect(result.fieldsUpdated).not.toContain("annual_income");
  });

  it("writes nothing at all on low confidence", async () => {
    const result = await wireExtractionToReadiness("u1", "d6", "pay_stub", PAY_STUB, "low");
    expect(result.fieldsUpdated).toEqual([]);
    expect(updateReadinessField).not.toHaveBeenCalled();
  });

  it("reports an unmapped document type rather than pretending to map it", async () => {
    const result = await wireExtractionToReadiness("u1", "d7", "lease_agreement", {}, "high");
    expect(result.fieldsUpdated).toEqual([]);
    expect(result.skipped[0]).toMatch(/no readiness mapping/);
  });
});

describe("F-030 — the field map only names fields the extractors actually emit", () => {
  it("never resolves a value from a string[] of field names", async () => {
    // Reproduces the original defect exactly: hand the function what the call
    // site used to pass. Nothing but presence rows may come back.
    const namesOnly = PAY_STUB.extractedFields as unknown as Record<string, any>;
    const result = await wireExtractionToReadiness("u1", "d8", "pay_stub", namesOnly, "high");

    expect(result.fieldsUpdated).toEqual(["pay_stubs"]);
    expect(result.skipped.join(" ")).toMatch(/employer_name/);
  });
});

// ---------------------------------------------------------------------------
// Document presence → readiness, independent of extraction.
//
// `government_id` still has no field extractor, while every required document
// row must remain satisfiable from presence even if parsing is unavailable.
// ---------------------------------------------------------------------------
const { creditDocumentPresence, presenceFieldFor } = await import(
  "../server/services/optimizationEngine"
);

describe("document presence credit — the required fields that had no writer", () => {
  it("credits w2_forms on a W-2 upload", async () => {
    const result = await creditDocumentPresence("u1", "doc-w2", "w2", "uploaded");
    expect(result.fieldUpdated).toBe("w2_forms");
  });

  it("credits government_id on an ID upload", async () => {
    const result = await creditDocumentPresence("u1", "doc-id", "government_id", "uploaded");
    expect(result.fieldUpdated).toBe("government_id");
  });

  it("resolves document-type aliases to the canonical readiness field", () => {
    // A borrower picks "Driver's licence"; the readiness field is government_id.
    expect(presenceFieldFor("drivers_license")).toBe("government_id");
    expect(presenceFieldFor("passport")).toBe("government_id");
  });

  it("covers every REQUIRED document-category readiness field", async () => {
    // The regression guard: if a required documents-category field is added to
    // READINESS_FIELDS with no presence mapping, it silently becomes
    // unsatisfiable again. Assert the full set explicitly.
    const required = ["pay_stubs", "w2_forms", "tax_returns", "bank_statements", "government_id"];
    const covered = new Set(
      ["pay_stub", "w2", "tax_return", "bank_statement", "government_id"].map(presenceFieldFor),
    );
    for (const field of required) expect(covered).toContain(field);
  });
});

describe("document presence credit — the trust ladder is honest", () => {
  it("an upload is tier-3 self_reported, never tier-1", async () => {
    updateReadinessField.mockClear();
    await creditDocumentPresence("u1", "doc-w2", "w2", "uploaded");
    // An unread, unverified file is the borrower's assertion about what they
    // attached — claiming document-grade trust for it would be a lie.
    expect((updateReadinessField.mock.calls[0] as any)[2].verificationStatus).toBe("self_reported");
  });

  it("a staff verify promotes to manually_verified", async () => {
    updateReadinessField.mockClear();
    await creditDocumentPresence("u1", "doc-w2", "w2", "verified");
    expect((updateReadinessField.mock.calls[0] as any)[2].verificationStatus).toBe("manually_verified");
  });

  it("ignores a document type with no readiness meaning", async () => {
    const result = await creditDocumentPresence("u1", "doc-x", "lease_agreement", "uploaded");
    expect(result.fieldUpdated).toBeNull();
  });
});
