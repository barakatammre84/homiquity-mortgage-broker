// Finding F-028 — extracted document VALUES reach the borrower graph.
//
// The gap: a borrower uploads a pay stub, a model reads it, and the numbers are
// discarded — only lineage (field names, confidence, model id) is kept on
// documents.notes. So the graph had no tier-1 income path from pay stubs and no
// tier-1 asset path at all, and the platform kept asking for figures it had
// already been shown.
//
// This is NOT a revert of F-027. That finding deleted branches reading VALUES
// out of documents.notes — a column the borrower could write through the upload
// description box, so the only data those branches ever saw was forged. The
// capability was correctly removed and never replaced. These pin the
// replacement, which reads a server-written table instead.
import { describe, it, expect } from "vitest";
import { buildDocumentFacts, monthlyIncomeFromYtd } from "../server/services/documentFacts";

/** Matches ExtractedPayStubData in server/extractionCore.ts. */
const PAY_STUB = {
  employeeName: "Jane Roe",
  employerName: "Acme Corp",
  payPeriodStartDate: "2026-06-16",
  payPeriodEndDate: "2026-06-30",
  grossPay: 4_200,
  ytdGross: 25_200,
  confidence: "high" as const,
  extractedFields: ["employerName", "grossPay", "ytdGross"],
  fieldEvidence: {
    employerName: { pageNumber: 1, confidence: 0.99 },
    grossPay: {
      pageNumber: 1,
      confidence: 0.97,
      boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    },
    ytdGross: { pageNumber: 1, confidence: 0.96 },
  },
};

/** Matches ExtractedBankStatementData. */
const BANK_STATEMENT = {
  accountType: "checking",
  accountNumber: "****4321",
  openingBalance: 18_000,
  closingBalance: 22_500,
  confidence: "high" as const,
  extractedFields: ["accountType", "closingBalance"],
};

describe("F-028 — monthly income from YTD gross", () => {
  it("averages YTD over months elapsed rather than extrapolating one cheque", () => {
    // $25,200 through 30 June = 6 months elapsed = $4,200/mo.
    expect(monthlyIncomeFromYtd(25_200, "2026-06-30")).toBe(4_200);
  });

  it("accounts for a partial month", () => {
    // Through 15 July ≈ 6.48 months, so the average is below the June figure.
    const mid = monthlyIncomeFromYtd(25_200, "2026-07-15");
    expect(mid).toBeGreaterThan(3_800);
    expect(mid).toBeLessThan(4_000);
  });

  it("absorbs a big overtime month instead of annualizing it", () => {
    // A single $9,000 cheque would extrapolate to $108k/yr. YTD averaging over
    // six months returns the real run rate — the reason this uses YTD at all.
    const monthly = monthlyIncomeFromYtd(30_000, "2026-06-30");
    expect(monthly).toBe(5_000);
  });

  it("refuses to divide by a near-zero elapsed period", () => {
    // A stub dated 8 January would divide by ~0.25 and invent a salary.
    expect(monthlyIncomeFromYtd(2_000, "2026-01-08")).toBeNull();
  });

  it("reads the period end date in UTC, so the figure does not move with the server's timezone", () => {
    // Regression pin. `payPeriodEndDate` is a date-only string, which ECMA-262
    // parses as UTC midnight — but getMonth()/getDate() report LOCAL components.
    // Reading them locally shifts the stub back a day west of Greenwich, and
    // these two dates are where that is most visible:
    //
    //   "2026-06-30"  UTC -> 5 + 30/30 = 6.000    local(UTC-4) -> 5 + 29/30 = 5.967
    //   "2026-07-01"  UTC -> 6 +  1/31 = 6.032    local(UTC-4) -> 5 + 30/30 = 6.000
    //
    // The first shipped as a 0.56% OVERSTATEMENT of monthly income — the
    // dangerous direction for an underwriting input, and invisible in CI because
    // GitHub runners are UTC.
    expect(monthlyIncomeFromYtd(25_200, "2026-06-30")).toBe(4_200);
    expect(monthlyIncomeFromYtd(25_200, "2026-07-01")).toBe(4_177.54);

    // Crossing midnight UTC must not change the answer either.
    expect(monthlyIncomeFromYtd(25_200, "2026-06-30T23:59:59Z")).toBe(4_200);
  });

  it("returns null rather than guessing when inputs are missing", () => {
    expect(monthlyIncomeFromYtd(undefined, "2026-06-30")).toBeNull();
    expect(monthlyIncomeFromYtd(25_200, undefined)).toBeNull();
    expect(monthlyIncomeFromYtd(25_200, "not-a-date")).toBeNull();
    expect(monthlyIncomeFromYtd(0, "2026-06-30")).toBeNull();
  });
});

describe("F-028 — facts built from the real extraction shapes", () => {
  it("turns a pay stub into monthly income plus the employer", () => {
    const facts = buildDocumentFacts("pay_stub", PAY_STUB);

    const income = facts.find(f => f.fieldName === "monthly_income_ytd_avg");
    expect(income).toMatchObject({ fieldCategory: "income", valueNumeric: 4_200, valueType: "currency" });

    const employer = facts.find(f => f.fieldName === "employer_name");
    expect(employer).toMatchObject({ fieldCategory: "identity", valueString: "Acme Corp" });
  });

  it("turns a bank statement into an asset balance plus account type", () => {
    const facts = buildDocumentFacts("bank_statement", BANK_STATEMENT);

    expect(facts.find(f => f.fieldName === "closing_balance")).toMatchObject({
      fieldCategory: "asset",
      valueNumeric: 22_500,
    });
    expect(facts.find(f => f.fieldName === "account_type")?.valueString).toBe("checking");
  });

  it("emits no income fact when the stub cannot support one", () => {
    const undated = { ...PAY_STUB, payPeriodEndDate: undefined };
    const facts = buildDocumentFacts("pay_stub", undated);

    expect(facts.find(f => f.fieldName === "monthly_income_ytd_avg")).toBeUndefined();
    // The employer is still a fact — a missing figure does not discard the rest.
    expect(facts.find(f => f.fieldName === "employer_name")).toBeDefined();
  });

  it("preserves an overdrawn balance for review without turning it positive", () => {
    const overdrawn = { ...BANK_STATEMENT, closingBalance: -320 };
    expect(buildDocumentFacts("bank_statement", overdrawn).find(f => f.fieldName === "closing_balance"))
      .toMatchObject({ valueNumeric: -320, fieldCategory: "asset" });
  });

  it("stores lease rent as source evidence without labeling it income", () => {
    expect(buildDocumentFacts("lease_agreement", { monthlyRent: 2_400 })).toEqual([
      expect.objectContaining({
        fieldName: "monthly_rent",
        fieldCategory: "property",
        valueNumeric: 2_400,
      }),
    ]);
  });

  it("carries the source page, field confidence, and box into review facts", () => {
    expect(buildDocumentFacts("pay_stub", PAY_STUB).find(f => f.fieldName === "gross_pay"))
      .toMatchObject({
        sourceFieldName: "grossPay",
        pageNumber: 1,
        confidence: 0.97,
        boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
      });
  });

  it("emits nothing for a document type with no fact mapping", () => {
    expect(buildDocumentFacts("government_id", { fullName: "Jane Roe" })).toEqual([]);
  });

  it("is deterministic", () => {
    expect(buildDocumentFacts("pay_stub", PAY_STUB)).toEqual(buildDocumentFacts("pay_stub", PAY_STUB));
  });
});
