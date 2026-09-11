import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  OTHER_INCOME_TYPES,
  OTHER_INCOME_TYPE_IDS,
  OTHER_INCOME_LABELS,
  classifyOtherIncomeSource,
  hasUncitedQualifyingTreatment,
  otherIncomeTypeLabel,
} from "@shared/incomeTypes";
import { computeAgencyWageIncome } from "../server/services/income/paths/agencyWage";
import { INCOME_PATH_IDS } from "@shared/incomePaths";
import { INCOME_PATH_IDS as PROFILE_INCOME_PATH_IDS } from "@shared/situationProfile";

const REPO_ROOT = path.resolve(__dirname, "..");

describe("Section 1e other-income catalog", () => {
  it("has one definition per id, and no duplicate labels", () => {
    expect(OTHER_INCOME_TYPES).toHaveLength(OTHER_INCOME_TYPE_IDS.length);
    expect(new Set(OTHER_INCOME_TYPES.map((t) => t.id)).size).toBe(OTHER_INCOME_TYPE_IDS.length);
    expect(new Set(OTHER_INCOME_LABELS).size).toBe(OTHER_INCOME_LABELS.length);
  });

  it("round-trips every label the picker can write", () => {
    // The column is free text and the picker writes these exact strings, so a
    // label the classifier cannot read back is a row the engine cannot type.
    for (const def of OTHER_INCOME_TYPES) {
      expect(classifyOtherIncomeSource(def.label)).toBe(def.id);
      expect(otherIncomeTypeLabel(def.id)).toBe(def.label);
    }
  });

  it("tolerates whitespace and case, and nothing beyond that", () => {
    expect(classifyOtherIncomeSource("  social security  ")).toBe("social_security");
    expect(classifyOtherIncomeSource("VA  Compensation")).toBe("va_compensation");
    // Deliberately NOT fuzzy: guessing which benefit a borrower meant is the
    // invention this repo refuses everywhere else.
    expect(classifyOtherIncomeSource("Social Security Disability")).toBeNull();
    expect(classifyOtherIncomeSource("SSI")).toBeNull();
    expect(classifyOtherIncomeSource("")).toBeNull();
    expect(classifyOtherIncomeSource("   ")).toBeNull();
    expect(classifyOtherIncomeSource(null)).toBeNull();
    expect(classifyOtherIncomeSource(undefined)).toBeNull();
  });

  it("no citation, no implementation — every stated authority exists on disk", () => {
    // The mechanical form of the rule, mirroring tests/nonQmProgramGate.test.ts.
    // A type may only claim a qualifying treatment once the document backing it
    // is actually in the repo; a citation naming a missing file fails here rather
    // than shipping a figure nobody can trace.
    for (const def of OTHER_INCOME_TYPES) {
      if (def.qualifyingAuthority === null) continue;
      const abs = path.join(REPO_ROOT, def.qualifyingAuthority.doc);
      expect(fs.existsSync(abs), `${def.id} cites a missing document: ${def.qualifyingAuthority.doc}`).toBe(true);
      expect(def.qualifyingAuthority.section.trim()).not.toBe("");
    }
  });

  it("reports uncited treatment consistently with the catalog", () => {
    for (const def of OTHER_INCOME_TYPES) {
      expect(hasUncitedQualifyingTreatment(def.id)).toBe(def.qualifyingAuthority === null);
    }
  });
});

describe("income path ids have exactly one declaration", () => {
  it("situationProfile re-exports the canonical list rather than copying it", () => {
    // These were two separate `as const` arrays that agreed by luck. A sixth path
    // added to the canonical list would have left the profile's z.enum rejecting
    // it, so a newly-supported path would vanish from the LO's view of which
    // paths apply. Identity, not deep equality — a copy would still pass toEqual.
    expect(PROFILE_INCOME_PATH_IDS).toBe(INCOME_PATH_IDS);
  });
});

describe("the agency-wage path qualifies other income conservatively", () => {
  const other = (incomeSource: string, monthlyAmount: string, extra: Record<string, unknown> = {}) =>
    ({ id: "x", applicationId: "a", incomeSource, monthlyAmount, createdAt: null, paidInVirtualCurrency: false, ...extra }) as never;

  it("keeps unanswered tax and continuance treatment visible for review", () => {
    const r = computeAgencyWageIncome({
      employment: [],
      otherIncome: [other("Social Security", "2000"), other("Child Support", "500")],
    });
    // The FIGURE is unchanged and deliberately so — face value, no factor.
    expect(r.path.monthlyQualifyingIncome).toBe(2500);
    const note = r.path.notes.find((n) => n.includes("needs confirmation"));
    expect(note, "an unresolved-treatment note must be emitted").toBeDefined();
    expect(note).toContain("Child Support");
    expect(note).toContain("Social Security");
    expect(r.path.requiresManualReview).toBe(true);
  });

  it("applies the 25% gross-up only in the approved-workpaper calculation", () => {
    const source = other("Social Security", "2000", {
      taxTreatment: "fully_non_taxable",
      hasDefinedExpiration: false,
    });
    const preliminary = computeAgencyWageIncome({ employment: [], otherIncome: [source] });
    const approved = computeAgencyWageIncome({
      employment: [],
      otherIncome: [source],
      applyVerifiedOtherIncomeAdjustments: true,
    });
    expect(preliminary.path.monthlyQualifyingIncome).toBe(2000);
    expect(approved.path.monthlyQualifyingIncome).toBe(2500);
    expect(approved.path.notes.join(" ")).toContain("25% of the verified nontaxable portion");
  });

  it("excludes income that ends before three years after the note date", () => {
    const r = computeAgencyWageIncome({
      employment: [],
      otherIncome: [other("Child Support", "1200", {
        taxTreatment: "fully_non_taxable",
        hasDefinedExpiration: true,
        expirationDate: "2028-12-31",
      })],
      expectedNoteDate: "2026-01-01",
      applyVerifiedOtherIncomeAdjustments: true,
    });
    expect(r.path.monthlyQualifyingIncome).toBe(0);
    expect(r.path.notes.join(" ")).toContain("excluded");
  });

  it("keeps qualifying income that continues at least three years", () => {
    const r = computeAgencyWageIncome({
      employment: [],
      otherIncome: [other("Child Support", "1200", {
        taxTreatment: "fully_non_taxable",
        hasDefinedExpiration: true,
        expirationDate: "2029-01-01",
      })],
      expectedNoteDate: "2026-01-01",
      applyVerifiedOtherIncomeAdjustments: true,
    });
    expect(r.path.monthlyQualifyingIncome).toBe(1500);
    expect(r.path.requiresManualReview).toBe(false);
  });

  it("excludes employment and other income paid in virtual currency", () => {
    const r = computeAgencyWageIncome({
      employment: [{
        isSelfEmployed: false,
        employerName: "Crypto Payroll Co",
        baseIncome: "5000",
        paidInVirtualCurrency: true,
      } as never],
      otherIncome: [other("Other", "800", {
        taxTreatment: "taxable",
        hasDefinedExpiration: false,
        paidInVirtualCurrency: true,
      })],
    });
    expect(r.path.monthlyQualifyingIncome).toBe(0);
    expect(r.path.notes.join(" ")).toMatch(/excluded.*virtual currency/i);
  });

  it("reports an unrecognised stored value rather than guessing its type", () => {
    const r = computeAgencyWageIncome({
      employment: [],
      otherIncome: [other("SSDI back pay", "900")],
    });
    expect(r.path.monthlyQualifyingIncome).toBe(900);
    const note = r.path.notes.find((n) => n.includes("unrecognised type"));
    expect(note, "an unclassified-source note must be emitted").toBeDefined();
    expect(note).toContain("SSDI back pay");
  });

  it("says nothing when there is no other income to say it about", () => {
    const r = computeAgencyWageIncome({
      employment: [],
      otherIncome: [],
      fallbackAnnualIncome: 96000,
    });
    expect(r.path.notes.some((n) => n.includes("confirmation") || n.includes("unrecognised"))).toBe(false);
  });
});
