import { describe, expect, it } from "vitest";
import { analyzeProfitLossActivity } from "../server/services/profitLossActivity";
import { computeSelfEmploymentPath } from "../server/services/income/paths/selfEmployment";
import type { BorrowerBusinessEntity, Document, DocumentLineage, EmploymentHistory, ExtractedField, LogicalDocument } from "../shared/schema";

const worksheet = {
  version: 1 as const,
  businessStructure: "single_member_llc" as const,
  ownershipPercent: 100,
  yearsSelfEmployed: 4,
  confirmedByBorrowerAt: "2026-09-01T00:00:00.000Z",
  scheduleC: {
    currentYear: {
      taxYear: 2025,
      netProfitOrLoss: 96_000,
      depreciation: 0,
      depletion: 0,
      amortizationOrCasualtyLoss: 0,
      businessUseOfHome: 0,
      mealsExclusion: 0,
      nonRecurringIncome: 0,
    },
    priorYear: {
      taxYear: 2024,
      netProfitOrLoss: 96_000,
      depreciation: 0,
      depletion: 0,
      amortizationOrCasualtyLoss: 0,
      businessUseOfHome: 0,
      mealsExclusion: 0,
      nonRecurringIncome: 0,
    },
  },
};

const employment = {
  id: "employment-1",
  employerName: "North Star Consulting",
  isSelfEmployed: true,
  selfEmploymentIncome: worksheet,
} as EmploymentHistory;
const document = { id: "pnl-1", documentType: "profit_loss", status: "verified" } as Document;
const lineage = { documentId: "pnl-1", subjectType: "business", subjectId: "business-1" } as DocumentLineage;
const business = { id: "business-1", name: "North Star Consulting" } as BorrowerBusinessEntity;
const fact = (fieldName: string, value: string | number, overrides: Partial<ExtractedField> = {}) => ({
  id: fieldName,
  documentId: "pnl-1",
  fieldName,
  valueType: typeof value === "number" ? "currency" : "string",
  valueNumeric: typeof value === "number" ? String(value) : null,
  valueString: typeof value === "string" ? value : null,
  humanVerified: true,
  ...overrides,
} as ExtractedField);

describe("current P&L activity", () => {
  it("routes a current decline to review without raising or silently replacing tax income", () => {
    const result = analyzeProfitLossActivity({
      documents: [document],
      lineageByDocument: new Map([[document.id, lineage]]),
      factsByDocument: new Map([[document.id, [
        fact("pnl_period_start_date", "2026-01-01"),
        fact("pnl_period_end_date", "2026-08-31"),
        fact("pnl_net_profit_loss", 40_000),
      ]]]),
      businesses: [business],
      employment: [employment],
    });

    expect(result.issues).toEqual([]);
    expect(result.signals[0]).toMatchObject({
      employmentId: employment.id,
      businessNetProfitLoss: 40_000,
      ownershipPercent: 100,
      direction: "declining",
      requiresManualReview: true,
      taxBasedMonthlyIncome: 8_000,
    });
    expect(result.signals[0].borrowerMonthlyNet).toBeCloseTo(5_010, -1);

    const path = computeSelfEmploymentPath([employment], result.signals, result.issues).path;
    expect(path.monthlyQualifyingIncome).toBe(8_000);
    expect(path.requiresManualReview).toBe(true);
    expect(path.notes.join(" ")).toMatch(/current p&l/i);
  });

  it("requires human review of the period and net figure before using the statement", () => {
    const result = analyzeProfitLossActivity({
      documents: [document],
      lineageByDocument: new Map([[document.id, lineage]]),
      factsByDocument: new Map([[document.id, [fact("pnl_revenue", 80_000)]]]),
      businesses: [business],
      employment: [employment],
    });

    expect(result.signals).toEqual([]);
    expect(result.issues[0].message).toMatch(/period start, period end, and net profit/i);
    expect(computeSelfEmploymentPath([employment], [], result.issues).path.requiresManualReview).toBe(true);
  });

  it("uses a reviewed P&L segment inside a generically labeled mixed packet", () => {
    const packet = { ...document, id: "packet-1", documentType: "other" } as Document;
    const packetLineage = { ...lineage, documentId: packet.id } as DocumentLineage;
    const form = {
      id: "logical-pnl-1",
      sourceDocumentId: packet.id,
      documentType: "profit_loss_statement",
      businessEntityId: business.id,
      status: "needs_review",
    } as LogicalDocument;
    const rows = [
      fact("pnl_period_start_date", "2026-01-01", { documentId: null, logicalDocumentId: form.id }),
      fact("pnl_period_end_date", "2026-08-31", { documentId: null, logicalDocumentId: form.id }),
      fact("pnl_net_profit_loss", 40_000, { documentId: null, logicalDocumentId: form.id }),
      fact("monthly_income_ytd_avg", 999_999, { documentId: null, logicalDocumentId: "logical-paystub-1" }),
    ];

    const result = analyzeProfitLossActivity({
      documents: [packet],
      lineageByDocument: new Map([[packet.id, packetLineage]]),
      factsByDocument: new Map([[packet.id, rows]]),
      businesses: [business],
      employment: [employment],
      logicalDocuments: [form],
    });

    expect(result.issues).toEqual([]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({ documentId: packet.id, businessNetProfitLoss: 40_000 });
  });
});
