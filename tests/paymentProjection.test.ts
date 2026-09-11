// WF1-002 regression pins — the instant-decision pricing path.
//
// Root cause: since 1967dff the engine priced PITI through the DISCLOSABLE
// generateLoanEstimate, which (correctly, §1026.36(d)(2)) fails closed when
// the LO compensation election is unset — and no intake path sets it, so
// EVERY fresh intake was undecidable (NEEDS_MORE_INFO, null policyFingerprint).
//
// The fix gives the loan-estimate service an internal, compensation-
// independent payment projection (computePaymentProjection) that the engine
// consumes instead. Three properties are load-bearing and pinned here:
//
//   1. NO ELECTION, STILL PRICEABLE — the projection succeeds on a file with
//      no compensation election, while the disclosable generator keeps its
//      fail-closed guard on the very same file (the guard was never the bug;
//      the shared path was).
//   2. NO DRIFT — for identical inputs (election present), the projection's
//      numbers are byte-identical to the Loan Estimate's projectedPayments
//      block: one derivation, one escrow model, one rounding.
//   3. HONEST GAPS + DETERMINISM — a file missing a genuine pricing input
//      still throws the same named error, and same inputs give the same
//      projection (mortgage-calculations house rule).
//
// Hermetic, same harness as tests/leDisclosedFeeProvenance.test.ts: storage
// and the LLPA matrix lookup are mocked; every number the assertions touch is
// pure arithmetic over the mocked inputs.
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  application: null as any,
  costEntries: [] as any[],
  propertyInfo: null as any,
}));

vi.mock("../server/storage", () => ({
  storage: {
    getLoanApplication: async () => h.application,
    getLoanCostEntries: async () => h.costEntries,
    // B3-6-03: the projection reads subject-property association dues to build
    // the qualifying PITIA. `h.propertyInfo` defaults to null (no URLA property
    // row), which is the shape a fresh intake actually has.
    getUrlaPropertyInfo: async () => h.propertyInfo,
  },
}));

// Pricing reaches the rate sheet in the DB; holding the LLPA adjustments at
// zero keeps the projection arithmetic the only moving part. The PMI leg is
// LTV-aware because the projection now takes MI from THIS result (the
// CONVENTIONAL_PMI matrix figure, F-077) rather than the old hardcoded card —
// a representative 0.78%/yr above the 80-LTV trigger, zero below, mirroring
// lookupPMIRate's structural rule.
const MOCK_PMI_ANNUAL_PCT = 0.78;
vi.mock("../server/pricing", () => ({
  calculateLLPA: async (loanAmount: number, _creditScore: number, ltv: number) => {
    const pmiAnnualRate = ltv > 80 ? MOCK_PMI_ANNUAL_PCT : 0;
    return {
      baseLLPA: 0,
      propertyTypeAdjustment: 0,
      condoAdjustment: 0,
      fthbWaiver: 0,
      totalLLPA: 0,
      pricing: {
        loanAmount,
        lLPAFeeAmount: 0,
        pmiAnnualRate,
        pmiMonthlyPayment: (loanAmount * pmiAnnualRate) / 12 / 100,
      },
    };
  },
}));

import { computePaymentProjection, generateLoanEstimate } from "../server/services/loanEstimate";

function application(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    purchasePrice: "500000",
    downPayment: "100000",
    creditScore: 740,
    propertyState: "IL",
    propertyType: "single_family",
    preferredLoanType: "conventional",
    isVeteran: false,
    isFirstTimeBuyer: false,
    // Deliberately NO loCompensationModel / loCompensationBps: this is the
    // exact state of every fresh intake.
    ...overrides,
  };
}

beforeEach(() => {
  h.application = application();
  h.costEntries = [];
});

describe("computePaymentProjection — compensation independence (WF1-002)", () => {
  it("prices a fresh intake with NO compensation election", async () => {
    const projection = await computePaymentProjection("app-1");

    // 400k @ 80 LTV, FICO 740, conventional: base 6.875, no adjustments,
    // zero LLPA ⇒ 6.875% note rate; LTV ≤ 80 ⇒ no MI.
    expect(projection.loanAmount).toBe(400000);
    expect(projection.interestRate).toBe(6.875);
    expect(projection.monthlyMortgageInsurance).toBe(0);
    // Escrow model: tax 500000*0.012/12 = 500; insurance max(1200, 1500)/12 = 125.
    expect(projection.monthlyEscrow).toBe(625);
    expect(projection.estimatedMonthlyTotal).toBeGreaterThan(0);
    expect(projection.estimatedMonthlyTotal).toBeCloseTo(
      projection.monthlyPrincipalAndInterest +
        projection.monthlyMortgageInsurance +
        projection.monthlyEscrow,
      1,
    );
  });

  it("the DISCLOSABLE generator keeps its §1026.36(d)(2) fail-closed guard on the same file", async () => {
    await expect(generateLoanEstimate("app-1")).rejects.toThrow(
      /compensation model and rate are required/i,
    );
  });

  it("is deterministic — same inputs, same projection", async () => {
    const first = await computePaymentProjection("app-1");
    const second = await computePaymentProjection("app-1");
    expect(second).toEqual(first);
  });

  it("still gaps honestly on a genuinely missing pricing input", async () => {
    h.application = application({ creditScore: null });
    await expect(computePaymentProjection("app-1")).rejects.toThrow(
      /credit score is required/i,
    );
  });

  // F-047 — the assertion the parity test structurally CANNOT make.
  //
  // Parity compares computePaymentProjection against generateLoanEstimate, but
  // both call the same derivePricing. A derivation that started reading the
  // compensation election would move both sides identically and parity would
  // still pass. The sibling "prices a fresh intake with NO election" test above
  // catches only the variant where compensation becomes REQUIRED (it would
  // throw); it does not catch compensation being read WITH A DEFAULT — which is
  // the realistic regression, because lender-paid comp is normally priced into
  // the rate in this industry.
  //
  // The failure that would let through: the engine deciding on a rate that
  // assumes an election nobody made, with §1026.36(d)(2)'s fail-closed guard
  // bypassed for a number that had quietly become compensation-dependent.
  //
  // So: vary ONLY the election and require the projection not to move.
  it("is byte-identical with no election, lender-paid, and borrower-paid", async () => {
    h.application = application();
    const noElection = await computePaymentProjection("app-1");

    h.application = application({
      loCompensationModel: "lender_paid",
      loCompensationBps: 125,
    });
    const lenderPaid = await computePaymentProjection("app-1");

    // A different MODEL and a different RATE, so a derivation reading either
    // field — or reading only one of them — is caught.
    h.application = application({
      loCompensationModel: "borrower_paid",
      loCompensationBps: 275,
    });
    const borrowerPaid = await computePaymentProjection("app-1");

    expect(lenderPaid).toEqual(noElection);
    expect(borrowerPaid).toEqual(noElection);
  });

  it("the note rate specifically does not move with the election", async () => {
    // Called out separately from the whole-object comparison because the rate is
    // where compensation would realistically enter: lender-paid comp is funded
    // by a rate bump. If only this moved, the object comparison above would
    // fail too — but this names the mechanism, so a failure reads as a
    // compliance regression rather than an arithmetic one.
    h.application = application();
    const { interestRate: withoutElection } = await computePaymentProjection("app-1");

    h.application = application({ loCompensationModel: "lender_paid", loCompensationBps: 250 });
    const { interestRate: withElection } = await computePaymentProjection("app-1");

    expect(withElection).toBe(withoutElection);
  });
});

describe("B3-6-03 qualifying PITIA vs the disclosed projected payment", () => {
  it("adds flood, ground rent, assessments, and subordinate payment only to the qualifying figure", async () => {
    h.application = application({ loCompensationModel: "lender_paid", loCompensationBps: 125 });
    h.propertyInfo = {
      monthlyAssociationDues: "200",
      monthlyFloodInsurance: "125",
      monthlyGroundRent: "40",
      monthlySpecialAssessments: "85",
      subordinateFinancingExists: true,
      closedEndSubordinateBalance: "20000",
      helocDrawnBalance: "10000",
      helocCreditLimit: "50000",
      monthlySubordinateFinancingPayment: "225",
    } as any;
    const p = await computePaymentProjection("app-1");
    expect(p.housingExpenseMissingItems).toEqual([]);
    expect(p.qualifyingPitia).toBe(Math.round((p.estimatedMonthlyTotal + 675) * 100) / 100);
    expect(p.cltv).toBe(86);
    expect(p.hcltv).toBe(94);
  });

  // Two figures, two regimes. estimatedMonthlyTotal holds Loan Estimate parity;
  // qualifyingPitia is what the DTI is built on and adds association dues per
  // Selling Guide B3-6-03. Collapsing them would either drop the dues from the
  // DTI (the defect) or silently change a disclosure on an unverifiable Reg Z
  // reading (what CLAUDE.md's Reg Z rail forbids).
  it("adds association dues to the qualifying figure but not to the LE figure", async () => {
    h.application = application({ loCompensationModel: "lender_paid", loCompensationBps: 125 });
    h.propertyInfo = { monthlyAssociationDues: "450.00" } as any;

    const p = await computePaymentProjection("app-1");

    expect(p.monthlyAssociationDues).toBe(450);
    expect(p.qualifyingPitia).toBe(Math.round((p.estimatedMonthlyTotal + 450) * 100) / 100);

    const le = await generateLoanEstimate("app-1");
    expect(
      p.estimatedMonthlyTotal,
      "the LE-parity figure must not move when dues are captured",
    ).toBe(le.projectedPayments.years1Through5.estimatedTotal);
  });

  it("leaves the two equal when there are no dues", async () => {
    h.application = application({ loCompensationModel: "lender_paid", loCompensationBps: 125 });
    h.propertyInfo = { monthlyAssociationDues: "0" } as any;
    const p = await computePaymentProjection("app-1");
    expect(p.qualifyingPitia).toBe(p.estimatedMonthlyTotal);
  });

  // A null on a condo is "not captured", and the decision path must gap on it
  // rather than qualify the borrower on a housing expense it knows is short.
  it("flags uncaptured dues on an association-bearing property", async () => {
    h.application = application({ propertyType: "condo" } as any);
    h.propertyInfo = null as any;
    const p = await computePaymentProjection("app-1");
    expect(p.monthlyAssociationDues).toBeNull();
    expect(p.associationDuesUncaptured).toBe(true);
  });

  it("does not flag a detached single-family file", async () => {
    h.application = application({ propertyType: "single_family" } as any);
    h.propertyInfo = null as any;
    const p = await computePaymentProjection("app-1");
    expect(p.associationDuesUncaptured).toBe(false);
  });
});

describe("computePaymentProjection — no drift from the Loan Estimate", () => {
  it("matches projectedPayments.years1Through5 byte-for-byte when the election exists", async () => {
    h.application = application({
      loCompensationModel: "lender_paid",
      loCompensationBps: 125,
    });

    const le = await generateLoanEstimate("app-1");
    const projection = await computePaymentProjection("app-1");

    expect(projection.estimatedMonthlyTotal).toBe(
      le.projectedPayments.years1Through5.estimatedTotal,
    );
    expect(projection.monthlyPrincipalAndInterest).toBe(
      le.projectedPayments.years1Through5.principalAndInterest,
    );
    expect(projection.monthlyMortgageInsurance).toBe(
      le.projectedPayments.years1Through5.mortgageInsurance,
    );
    expect(projection.monthlyEscrow).toBe(
      le.projectedPayments.years1Through5.estimatedEscrow,
    );
    expect(projection.interestRate).toBe(le.loanTerms.interestRate);
    expect(projection.loanAmount).toBe(le.loanTerms.loanAmount);
    expect(le.loanProgram).toBe("CONVENTIONAL");
  });

  it("holds parity on an MI-bearing file too (LTV > 80)", async () => {
    h.application = application({
      downPayment: "50000", // 450k / 500k = 90 LTV ⇒ conventional BPMI applies
      loCompensationModel: "borrower_paid",
      loCompensationBps: 100,
    });

    const le = await generateLoanEstimate("app-1");
    const projection = await computePaymentProjection("app-1");

    expect(projection.monthlyMortgageInsurance).toBeGreaterThan(0);
    expect(projection.estimatedMonthlyTotal).toBe(
      le.projectedPayments.years1Through5.estimatedTotal,
    );
    expect(projection.monthlyMortgageInsurance).toBe(
      le.projectedPayments.years1Through5.mortgageInsurance,
    );
  });

  it("keeps a veteran's selected conventional Loan Estimate conventional", async () => {
    h.application = application({
      isVeteran: true,
      preferredLoanType: "conventional",
      loCompensationModel: "lender_paid",
      loCompensationBps: 125,
    });

    const le = await generateLoanEstimate("app-1");
    expect(le.loanProgram).toBe("CONVENTIONAL");
  });

  it("refuses VA terms without a VA eligibility signal", async () => {
    h.application = application({
      preferredLoanType: "va",
      isVeteran: false,
      loCompensationModel: "lender_paid",
      loCompensationBps: 125,
    });
    await expect(generateLoanEstimate("app-1")).rejects.toThrow(/VA eligibility.*confirmed/i);
  });

  it("refuses to disclose a fixed-rate estimate for an adjustable-rate selection", async () => {
    h.application = application({
      amortizationType: "adjustable",
      loCompensationModel: "lender_paid",
      loCompensationBps: 125,
    });
    await expect(generateLoanEstimate("app-1")).rejects.toThrow(/adjustable-rate pricing is not automated/i);
  });
});
