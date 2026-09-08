import { describe, expect, it } from "vitest";
import { assessBusinessLiquidity, computeSelfEmploymentQualifyingIncome } from "../server/services/selfEmploymentIncome";
import { qualifyIncome } from "../server/underwriting";
import type { EmploymentHistory, SelfEmploymentWorksheet } from "../shared/schema";

// --- factories ---------------------------------------------------------------

const scheduleCYear = (o: Partial<{
  netProfitOrLoss: number; depreciation: number; depletion: number;
  amortizationOrCasualtyLoss: number; businessUseOfHome: number;
  mealsExclusion: number; nonRecurringIncome: number;
}> = {}) => ({
  netProfitOrLoss: 0, depreciation: 0, depletion: 0, amortizationOrCasualtyLoss: 0,
  businessUseOfHome: 0, mealsExclusion: 0, nonRecurringIncome: 0, ...o,
});

const entityAnalysis = (o: Partial<{
  depreciation: number; depletion: number; amortizationCasualtyOtherLosses: number;
  travelMealsExclusion: number; nonRecurringIncome: number;
  shortTermObligations: number; shortTermObligationsWaived: boolean;
}> = {}) => ({
  depreciation: 0, depletion: 0, amortizationCasualtyOtherLosses: 0,
  travelMealsExclusion: 0, nonRecurringIncome: 0,
  shortTermObligations: 0, shortTermObligationsWaived: false, ...o,
});

const k1Year = (o: Partial<{
  ordinaryBusinessIncome: number; netRentalRealEstateIncome: number;
  otherNetRentalIncome: number; guaranteedPayments: number; distributionsReceived: number;
  entityAnalysis: ReturnType<typeof entityAnalysis>;
}> = {}) => ({
  ordinaryBusinessIncome: 0, netRentalRealEstateIncome: 0, otherNetRentalIncome: 0,
  guaranteedPayments: 0, distributionsReceived: 0, ...o,
});

const scheduleCWorksheet = (
  currentYear: ReturnType<typeof scheduleCYear>,
  priorYear?: ReturnType<typeof scheduleCYear>,
): SelfEmploymentWorksheet => ({
  version: 1,
  businessStructure: "sole_proprietorship",
  ownershipPercent: 100,
  yearsSelfEmployed: 5,
  scheduleC: priorYear ? { currentYear, priorYear } : { currentYear },
});

const k1Worksheet = (
  currentYear: ReturnType<typeof k1Year>,
  opts: {
    priorYear?: ReturnType<typeof k1Year>;
    hasTwoYearGuaranteedPayments?: boolean;
    liquidity?: { currentAssets: number; currentLiabilities: number; inventory: number };
    w2FromBusiness?: number;
    ownershipPercent?: number;
    businessStructure?: "partnership" | "s_corporation";
  } = {},
): SelfEmploymentWorksheet => ({
  version: 1,
  businessStructure: opts.businessStructure ?? "partnership",
  ownershipPercent: opts.ownershipPercent,
  k1: {
    currentYear,
    priorYear: opts.priorYear,
    hasTwoYearGuaranteedPayments: opts.hasTwoYearGuaranteedPayments ?? false,
    liquidity: opts.liquidity,
    w2FromBusiness: opts.w2FromBusiness ?? 0,
  },
});

// --- Schedule C (B3-3.6-03) --------------------------------------------------

describe("Schedule C sole proprietorship (Fannie B3-3.6-03 / B3-3.5-01)", () => {
  it("adds back non-cash items, subtracts non-recurring, and averages two increasing years", () => {
    const wk = scheduleCWorksheet(
      scheduleCYear({ netProfitOrLoss: 100000, depreciation: 10000, amortizationOrCasualtyLoss: 2000, businessUseOfHome: 3000, mealsExclusion: 1000, nonRecurringIncome: 5000 }),
      scheduleCYear({ netProfitOrLoss: 90000, depreciation: 8000 }),
    );
    const r = computeSelfEmploymentQualifyingIncome(wk);
    // current cash flow = 100000 + 15000 - 6000 = 109000; prior = 98000; avg = 103500
    expect(r.netProfitYear1).toBe(109000);
    expect(r.netProfitYear2).toBe(98000);
    expect(r.avgAnnualCashFlow).toBe(103500);
    expect(r.monthlyQualifyingIncome).toBe(8625);
    expect(r.addBacks).toBe(23000);
    expect(r.deductions).toBe(6000);
    expect(r.trend).toBe("increasing");
    expect(r.requiresManualReview).toBe(false);
  });

  it("uses the most recent (lower) year and flags review when income is declining", () => {
    const wk = scheduleCWorksheet(
      scheduleCYear({ netProfitOrLoss: 80000 }),
      scheduleCYear({ netProfitOrLoss: 100000 }),
    );
    const r = computeSelfEmploymentQualifyingIncome(wk);
    expect(r.avgAnnualCashFlow).toBe(80000);
    expect(r.monthlyQualifyingIncome).toBeCloseTo(6666.67, 2);
    expect(r.trend).toBe("declining");
    expect(r.requiresManualReview).toBe(true);
  });

  it("flags a single-year history for manual review (two-year history generally required)", () => {
    const wk = scheduleCWorksheet(scheduleCYear({ netProfitOrLoss: 109000 }));
    const r = computeSelfEmploymentQualifyingIncome(wk);
    expect(r.netProfitYear2).toBe(0);
    expect(r.avgAnnualCashFlow).toBe(109000);
    expect(r.monthlyQualifyingIncome).toBeCloseTo(9083.33, 2);
    expect(r.trend).toBe("insufficient_history");
    expect(r.requiresManualReview).toBe(true);
  });

  it("floors qualifying income at zero and flags a net-loss year", () => {
    const wk = scheduleCWorksheet(
      scheduleCYear({ netProfitOrLoss: -20000 }),
      scheduleCYear({ netProfitOrLoss: 10000 }),
    );
    const r = computeSelfEmploymentQualifyingIncome(wk);
    expect(r.monthlyQualifyingIncome).toBe(0);
    expect(r.trend).toBe("loss");
    expect(r.requiresManualReview).toBe(true);
  });
});

// --- K-1 partnership / S-corp (B3-3.6-07) ------------------------------------

describe("Schedule K-1 partnership / S-corp (Fannie B3-3.6-07)", () => {
  it("exposes the same liquidity result used by the officer workpaper", () => {
    expect(assessBusinessLiquidity({ currentAssets: 50000, currentLiabilities: 25000, inventory: 10000 })).toMatchObject({
      method: "quick_ratio",
      currentRatio: 2,
      quickRatio: 1.6,
      supportsOrdinaryIncome: true,
    });
    expect(assessBusinessLiquidity({ currentAssets: 5000, currentLiabilities: 10000, inventory: 0 })).toMatchObject({
      method: "current_ratio",
      currentRatio: 0.5,
      supportsOrdinaryIncome: false,
    });
  });

  it("uses full ordinary income when documented distributions cover it", () => {
    const wk = k1Worksheet(
      k1Year({ ordinaryBusinessIncome: 60000, distributionsReceived: 60000 }),
      { priorYear: k1Year({ ordinaryBusinessIncome: 50000, distributionsReceived: 50000 }) },
    );
    const r = computeSelfEmploymentQualifyingIncome(wk);
    expect(r.avgAnnualCashFlow).toBe(55000);
    expect(r.monthlyQualifyingIncome).toBeCloseTo(4583.33, 2);
    expect(r.requiresManualReview).toBe(false);
  });

  it("uses full ordinary income when the business-liquidity ratio is ≥ 1", () => {
    const wk = k1Worksheet(
      k1Year({ ordinaryBusinessIncome: 50000, distributionsReceived: 10000 }),
      {
        priorYear: k1Year({ ordinaryBusinessIncome: 50000, distributionsReceived: 10000 }),
        liquidity: { currentAssets: 30000, currentLiabilities: 10000, inventory: 0 },
      },
    );
    const r = computeSelfEmploymentQualifyingIncome(wk);
    expect(r.avgAnnualCashFlow).toBe(50000);
    expect(r.requiresManualReview).toBe(false);
  });

  it("limits income to distributions and flags review when liquidity is inadequate", () => {
    const wk = k1Worksheet(
      k1Year({ ordinaryBusinessIncome: 50000, distributionsReceived: 10000 }),
      {
        priorYear: k1Year({ ordinaryBusinessIncome: 50000, distributionsReceived: 10000 }),
        liquidity: { currentAssets: 5000, currentLiabilities: 10000, inventory: 0 },
      },
    );
    const r = computeSelfEmploymentQualifyingIncome(wk);
    expect(r.avgAnnualCashFlow).toBe(10000);
    expect(r.requiresManualReview).toBe(true);
    expect(r.notes.join(" ")).toMatch(/liquidity/i);
  });

  it("uses guaranteed payments directly when received for 2+ years, gating ordinary income separately", () => {
    const wk = k1Worksheet(
      k1Year({ ordinaryBusinessIncome: 40000, guaranteedPayments: 20000, distributionsReceived: 0 }),
      {
        priorYear: k1Year({ ordinaryBusinessIncome: 40000, guaranteedPayments: 20000, distributionsReceived: 0 }),
        hasTwoYearGuaranteedPayments: true,
        liquidity: { currentAssets: 5000, currentLiabilities: 10000, inventory: 0 },
      },
    );
    const r = computeSelfEmploymentQualifyingIncome(wk);
    // guaranteed 20000 usable directly; ordinary 40000 gated out (liquidity 0.5, no distributions)
    expect(r.avgAnnualCashFlow).toBe(20000);
    expect(r.monthlyQualifyingIncome).toBeCloseTo(1666.67, 2);
    expect(r.requiresManualReview).toBe(true);
  });
});

// --- structure dispatch + determinism ---------------------------------------

describe("entity business-return analysis (Fannie B3-3.7-01 / B3-3.7-02)", () => {
  it("applies the borrower's ownership share of entity add-backs and subtractions to the gated pool", () => {
    const year = k1Year({
      ordinaryBusinessIncome: 80000,
      distributionsReceived: 200000,
      entityAnalysis: entityAnalysis({ depreciation: 30000, shortTermObligations: 10000 }),
    });
    const r = computeSelfEmploymentQualifyingIncome(
      k1Worksheet(year, { priorYear: year, ownershipPercent: 50 }),
    );
    // share = (30000 − 10000) × 50% = 10000 → usable 90000/yr, covered by distributions
    expect(r.netProfitYear1).toBe(90000);
    expect(r.avgAnnualCashFlow).toBe(90000);
    expect(r.monthlyQualifyingIncome).toBe(7500);
    expect(r.addBacks).toBe(30000); // 15000 share × 2 years (informational)
    expect(r.deductions).toBe(10000);
    expect(r.requiresManualReview).toBe(false);
  });

  it("waives the short-term-obligation subtraction when flagged as rolling over", () => {
    const year = k1Year({
      ordinaryBusinessIncome: 80000,
      distributionsReceived: 200000,
      entityAnalysis: entityAnalysis({
        depreciation: 30000,
        shortTermObligations: 10000,
        shortTermObligationsWaived: true,
      }),
    });
    const r = computeSelfEmploymentQualifyingIncome(
      k1Worksheet(year, { priorYear: year, ownershipPercent: 50 }),
    );
    expect(r.netProfitYear1).toBe(95000); // share = 30000 × 50%, no subtraction
    expect(r.deductions).toBe(0);
  });

  it("skips the adjustment and flags review when no ownership percentage is captured", () => {
    const year = k1Year({
      ordinaryBusinessIncome: 80000,
      distributionsReceived: 200000,
      entityAnalysis: entityAnalysis({ depreciation: 30000 }),
    });
    const r = computeSelfEmploymentQualifyingIncome(k1Worksheet(year, { priorYear: year }));
    expect(r.netProfitYear1).toBe(80000); // adjustment NOT applied
    expect(r.requiresManualReview).toBe(true);
    expect(r.notes.some((n) => n.includes("no ownership percentage"))).toBe(true);
  });

  it("counts the owner's own-business W-2 directly even when K-1 income is gated down", () => {
    const year = k1Year({ ordinaryBusinessIncome: 100000, distributionsReceived: 0 });
    const r = computeSelfEmploymentQualifyingIncome(
      k1Worksheet(year, {
        priorYear: year,
        w2FromBusiness: 60000,
        businessStructure: "s_corporation",
      }),
    );
    // ordinary income gated to distributions (0); the W-2 salary still counts
    expect(r.avgAnnualCashFlow).toBe(60000);
    expect(r.monthlyQualifyingIncome).toBe(5000);
    expect(r.requiresManualReview).toBe(true); // gated-down flag
  });

  it("lets a negative entity adjustment flow through as a loss (never gated away)", () => {
    const year = k1Year({
      ordinaryBusinessIncome: 5000,
      distributionsReceived: 5000,
      entityAnalysis: entityAnalysis({ shortTermObligations: 30000 }),
    });
    const r = computeSelfEmploymentQualifyingIncome(
      k1Worksheet(year, { ownershipPercent: 100 }),
    );
    // gated pool = 5000 − 30000 = −25000 → flows as a loss; floored at zero
    expect(r.netProfitYear1).toBe(-25000);
    expect(r.monthlyQualifyingIncome).toBe(0);
    expect(r.requiresManualReview).toBe(true);
  });
});

describe("structure dispatch and determinism", () => {
  it("returns no self-employment income for a C corporation", () => {
    const wk: SelfEmploymentWorksheet = { version: 1, businessStructure: "c_corporation" };
    const r = computeSelfEmploymentQualifyingIncome(wk);
    expect(r.monthlyQualifyingIncome).toBe(0);
    expect(r.trend).toBe("not_applicable");
  });

  it("returns zero for a null/undefined worksheet", () => {
    expect(computeSelfEmploymentQualifyingIncome(null).monthlyQualifyingIncome).toBe(0);
    expect(computeSelfEmploymentQualifyingIncome(undefined).monthlyQualifyingIncome).toBe(0);
  });

  it("is deterministic — identical inputs produce identical outputs", () => {
    const wk = scheduleCWorksheet(
      scheduleCYear({ netProfitOrLoss: 123456, depreciation: 7890 }),
      scheduleCYear({ netProfitOrLoss: 120000, depreciation: 6000 }),
    );
    const a = computeSelfEmploymentQualifyingIncome(wk);
    const b = computeSelfEmploymentQualifyingIncome(wk);
    expect(a).toEqual(b);
  });
});

// --- qualifyIncome integration (server/underwriting.ts) ----------------------

describe("qualifyIncome integrates the self-employment calculator", () => {
  const seEmp = (wk: SelfEmploymentWorksheet) =>
    ({ isSelfEmployed: true, selfEmploymentIncome: wk } as unknown as EmploymentHistory);

  it("flows worksheet income into selfEmploymentMonthlyIncome, details, and the total", () => {
    const wk = scheduleCWorksheet(
      scheduleCYear({ netProfitOrLoss: 100000, depreciation: 10000, amortizationOrCasualtyLoss: 2000, businessUseOfHome: 3000, mealsExclusion: 1000, nonRecurringIncome: 5000 }),
      scheduleCYear({ netProfitOrLoss: 90000, depreciation: 8000 }),
    );
    const r = qualifyIncome([seEmp(wk)], [], undefined);
    expect(r.selfEmploymentMonthlyIncome).toBe(8625);
    expect(r.totalQualifyingIncome).toBe(8625);
    expect(r.details.selfEmployment?.qualifyingIncome).toBe(8625);
    expect(r.details.selfEmployment?.avgNetProfit).toBe(103500);
    expect(r.details.selfEmployment?.requiresManualReview).toBe(false);
  });

  it("adds W-2 base income and self-employment together", () => {
    const w2 = { isSelfEmployed: false, startDate: "2020-01-01", totalMonthlyIncome: "5000", employmentType: "salaried" } as unknown as EmploymentHistory;
    const se = seEmp(scheduleCWorksheet(scheduleCYear({ netProfitOrLoss: 60000 }))); // single year → 5000/mo, review
    const r = qualifyIncome([w2, se], [], undefined);
    expect(r.baseMonthlyIncome).toBe(5000);
    expect(r.selfEmploymentMonthlyIncome).toBe(5000);
    expect(r.totalQualifyingIncome).toBe(10000);
    expect(r.details.selfEmployment?.requiresManualReview).toBe(true);
  });

  it("contributes no income for a self-employed record with no worksheet captured", () => {
    const bare = { isSelfEmployed: true } as unknown as EmploymentHistory;
    const r = qualifyIncome([bare], [], undefined);
    expect(r.selfEmploymentMonthlyIncome).toBe(0);
    expect(r.details.selfEmployment).toBeUndefined();
  });
});
