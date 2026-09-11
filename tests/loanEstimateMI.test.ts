import { describe, it, expect, vi, afterEach } from "vitest";

// F-077: the Loan Estimate's disclosed MI — and the DTI the instant decision
// is made on — came from loanCosts.calculatePMI, a compile-time FICO×LTV card
// that exceeds the versioned CONVENTIONAL_PMI matrix in every live cell
// (1.42×–2.17×), while derivePricing had already awaited calculateLLPA and
// held the matrix figure. These pin the routing hermetically: the payment
// projection must carry the matrix number, not the card's.
//
// F-077 FHA leg: the same derivation then priced preferredLoanType "fha" —
// reachable from URLA intake (PropertySection → PREFERRED_LOAN_TYPES) — with
// that conventional matrix figure standing in for FHA MIP: $0 MI at ≤80 LTV
// where MIP is still owed, the wrong rate above it, and no up-front MIP
// anywhere in the LE fee model. The FHA blocks below pin the product-aware
// routing (services/mortgageInsurance.ts), the UFMIP fee-model composition,
// and the life-of-loan APR stream.

const MATRIX_MONTHLY_PMI = 239.2; // $368k × 0.78%/yr / 12 — the register's worked example

vi.mock("../server/pricing", () => ({
  calculateLLPA: vi.fn(async () => ({
    baseLLPA: 0,
    propertyTypeAdjustment: 0,
    condoAdjustment: 0,
    fthbWaiver: 0,
    totalLLPA: 0,
    pricing: {
      loanAmount: 368_000,
      lLPAFeeAmount: 0,
      pmiAnnualRate: 0.78,
      pmiMonthlyPayment: MATRIX_MONTHLY_PMI,
    },
  })),
}));

const application = {
  id: "app-f077",
  purchasePrice: "400000",
  downPayment: "32000", // → $368k loan, 92% LTV — the register's worked example
  creditScore: 700,
  isVeteran: false,
  preferredLoanType: "conventional",
  isFirstTimeBuyer: false,
  propertyType: "single_family",
  propertyState: "IL",
  loanPurpose: "purchase",
};

vi.mock("../server/storage", () => ({
  storage: {
    getLoanApplication: vi.fn(async () => application),
    getLoanCostEntries: vi.fn(async () => []),
    // B3-6-03: the projection reads subject-property association dues for the
    // qualifying PITIA. Null = no URLA property row, a fresh intake's real shape.
    getUrlaPropertyInfo: vi.fn(async () => null),
  },
}));

import { computePaymentProjection, generateLoanEstimate } from "../server/services/loanEstimate";
import { computeClosingCosts } from "../server/services/loanCosts";
import { calculateMortgageAPR } from "../server/services/apr";
import {
  FHA_UPFRONT_MIP_RATE,
  fhaUpfrontMIP,
  offerUpfrontMI,
} from "../server/services/mortgageInsurance";

afterEach(() => {
  vi.useRealTimers();
});

describe("payment projection MI comes from the CONVENTIONAL_PMI matrix (F-077)", () => {
  it("carries the matrix figure — not the hardcoded card that fed the decision", async () => {
    const projection = await computePaymentProjection("app-f077");

    expect(projection.monthlyMortgageInsurance).toBe(MATRIX_MONTHLY_PMI);

    // The card's figure for the same inputs was materially different — the
    // register's worked example: $429.33 vs $239.20 (+$190.13/mo, 2.38 DTI
    // points on $8k/mo income). loanCosts.calculatePMI was deleted when its
    // last caller (the scenario simulator) migrated to the matrix, so the
    // figure is pinned as a historical constant: 700 FICO × 92 LTV → the
    // card's 1.40%/yr band → $368k × 1.40% / 12 = $429.33. If the projection
    // ever equals it again, the defect is back.
    const DELETED_CARD_FIGURE = 429.33;
    expect(projection.monthlyMortgageInsurance).not.toBe(DELETED_CARD_FIGURE);

    // The PITI total composes from the same figure.
    expect(projection.estimatedMonthlyTotal).toBeCloseTo(
      projection.monthlyPrincipalAndInterest +
        projection.monthlyMortgageInsurance +
        projection.monthlyEscrow,
      2,
    );
  });

  it("keeps VA at zero MI through the VA pricing stub", async () => {
    const { storage } = await import("../server/storage");
    vi.mocked(storage.getLoanApplication).mockResolvedValueOnce({
      ...application,
      isVeteran: true,
      preferredLoanType: "va",
    } as never);

    const projection = await computePaymentProjection("app-f077");
    expect(projection.monthlyMortgageInsurance).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F-077 FHA leg — monthly MIP is product-aware, never the matrix stand-in.
// ---------------------------------------------------------------------------

const fhaApplication = { ...application, preferredLoanType: "fha" };

async function mockApplicationOnce(app: Record<string, unknown>) {
  const { storage } = await import("../server/storage");
  vi.mocked(storage.getLoanApplication).mockResolvedValueOnce(app as never);
}

describe("FHA monthly MI is annual MIP, not the conventional matrix (F-077 FHA leg)", () => {
  it("charges the 0.80%/yr MIP tier above 80 LTV — not the matrix figure", async () => {
    await mockApplicationOnce(fhaApplication);
    const projection = await computePaymentProjection("app-f077");

    // $368k at 92 LTV → ≤95 tier: 368,000 × 0.80% / 12 = $245.33.
    expect(projection.monthlyMortgageInsurance).toBe(245.33);
    // The conventional matrix figure the same derivation resolves must NOT
    // stand in for MIP — that was the defect.
    expect(projection.monthlyMortgageInsurance).not.toBe(MATRIX_MONTHLY_PMI);
  });

  it("keeps charging MIP at ≤80 LTV, where conventional PMI is $0", async () => {
    // $100k down → $300k loan, 75 LTV. Conventional MI is zero at or below
    // the 80-LTV trigger; FHA MIP is owed at EVERY LTV: 300,000 × 0.80% / 12.
    await mockApplicationOnce({ ...fhaApplication, downPayment: "100000" });
    const projection = await computePaymentProjection("app-f077");

    expect(projection.monthlyMortgageInsurance).toBe(200);
    expect(projection.monthlyMortgageInsurance).toBeGreaterThan(0);
  });

  it("prices the 0.85%/yr tier above 95 LTV", async () => {
    // $16k down → $384k loan, 96 LTV: 384,000 × 0.85% / 12 = $272.
    await mockApplicationOnce({ ...fhaApplication, downPayment: "16000" });
    const projection = await computePaymentProjection("app-f077");

    expect(projection.monthlyMortgageInsurance).toBe(272);
  });

  it("keeps the selected FHA pricing for a veteran instead of silently switching to VA", async () => {
    await mockApplicationOnce({ ...fhaApplication, isVeteran: true });
    const projection = await computePaymentProjection("app-f077");

    expect(projection.monthlyMortgageInsurance).toBe(245.33);
  });

  it("is deterministic — same FHA inputs, same projection (mortgage-calculations house rule)", async () => {
    await mockApplicationOnce(fhaApplication);
    const first = await computePaymentProjection("app-f077");
    await mockApplicationOnce(fhaApplication);
    const second = await computePaymentProjection("app-f077");

    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// FHA up-front MIP (UFMIP) — the fee-model composition, hermetic and pure.
// ---------------------------------------------------------------------------

describe("FHA up-front MIP (UFMIP) in the shared fee model", () => {
  it("mirrors the advertised model's figure — 1.75% of the loan amount", () => {
    expect(FHA_UPFRONT_MIP_RATE).toBe(0.0175);
    expect(fhaUpfrontMIP(368_000)).toBeCloseTo(6_440, 8);
  });

  it("applies to FHA only — VA funding fee / USDA guarantee fee stay named gaps at 0", () => {
    expect(offerUpfrontMI({ productType: "FHA", loanAmount: 368_000 })).toBeCloseTo(6_440, 8);
    expect(offerUpfrontMI({ productType: "fha", loanAmount: 368_000 })).toBeCloseTo(6_440, 8);
    for (const productType of ["CONVENTIONAL", "VA", "USDA", "JUMBO", "HELOC"]) {
      expect(offerUpfrontMI({ productType, loanAmount: 368_000 })).toBe(0);
    }
  });

  it("rides the prepaids MI line, both totals, cash to close, and the §1026.4 prepaid finance charges — never the escrow cushion", () => {
    const base = {
      purchasePrice: 400_000,
      downPayment: 32_000,
      loanAmount: 368_000,
      interestRate: 6.5,
      monthlyPMI: (368_000 * 0.008) / 12,
      prepaidInterestDays: 15,
      compensation: { model: "borrower_paid" as const, bps: 275 },
    };
    const without = computeClosingCosts(base);
    const withUfmip = computeClosingCosts({ ...base, upfrontMortgageInsurance: 6_440 });

    expect(withUfmip.prepaidMortgageInsurance).toBeCloseTo(without.prepaidMortgageInsurance + 6_440, 8);
    expect(withUfmip.prepaidFinanceCharges).toBeCloseTo(without.prepaidFinanceCharges + 6_440, 8);
    expect(withUfmip.totalClosingCosts).toBeCloseTo(without.totalClosingCosts + 6_440, 8);
    expect(withUfmip.cashToClose).toBeCloseTo(without.cashToClose + 6_440, 8);
    // UFMIP is a single premium paid at closing — it must not inflate the
    // monthly escrow model or its cushion.
    expect(withUfmip.escrowMortgageInsurance).toBe(without.escrowMortgageInsurance);
    expect(withUfmip.monthlyEscrow).toBe(without.monthlyEscrow);
  });
});

// ---------------------------------------------------------------------------
// The disclosed FHA Loan Estimate — UFMIP on the prepaids line, MIP in the
// projected payments, and the life-of-loan APR stream.
// ---------------------------------------------------------------------------

const electedFhaApplication = {
  ...fhaApplication,
  loCompensationModel: "borrower_paid",
  loCompensationBps: 275,
};

describe("the disclosed FHA Loan Estimate", () => {
  it("discloses UFMIP + 2 months MIP on the prepaids MI line, and prices the APR off the life-of-loan MIP stream", async () => {
    // Pin the clock: the LE's closing-date model (+30 days, prepaid-interest
    // days = days remaining in that month) reads the wall clock, and the APR
    // recomputation below must replicate it exactly.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 18, 12, 0, 0));

    await mockApplicationOnce(electedFhaApplication);
    const le = await generateLoanEstimate("app-f077");

    const monthlyMIP = (368_000 * 0.008) / 12;

    // Prepaids "Mortgage Insurance Premium" line: 2 months of MIP + $6,440
    // UFMIP, rounded as the LE rounds. Before the fix this line carried the
    // conventional figure and no UFMIP existed anywhere in the fee model.
    expect(le.closingCostDetails.otherCosts.prepaids.mortgageInsurance).toBe(
      Math.round(monthlyMIP * 2 + 6_440),
    );
    expect(le.projectedPayments.years1Through5.mortgageInsurance).toBe(245.33);

    // Exact APR recomputation with the platform's own solver: UFMIP inside
    // the prepaid finance charges, and propertyValue 0 — no 78% HPA
    // auto-termination, because FHA MIP is life-of-loan (the advertised
    // model's standing treatment). If generateLoanEstimate ever passes the
    // purchase price again, the stream loses its tail MIP months and this
    // equality breaks.
    const closingDate = new Date();
    closingDate.setDate(closingDate.getDate() + 30);
    const daysInMonth = new Date(closingDate.getFullYear(), closingDate.getMonth() + 1, 0).getDate();
    const expectedCosts = computeClosingCosts({
      purchasePrice: 400_000,
      downPayment: 32_000,
      loanAmount: 368_000,
      interestRate: le.loanTerms.interestRate,
      monthlyPMI: monthlyMIP,
      upfrontMortgageInsurance: 6_440,
      prepaidInterestDays: daysInMonth - closingDate.getDate(),
      compensation: { model: "borrower_paid" as const, bps: 275 },
      noteDate: closingDate,
    });
    const expectedApr = calculateMortgageAPR({
      loanAmount: 368_000,
      noteRatePct: le.loanTerms.interestRate,
      termMonths: 360,
      monthlyMI: monthlyMIP,
      propertyValue: 0,
      prepaidFinanceCharges: expectedCosts.prepaidFinanceCharges,
    });
    expect(le.comparisons.apr).toBe(expectedApr);
    expect(le.comparisons.apr).toBeGreaterThan(le.loanTerms.interestRate);
  });

  it("never shows MIP stepping to zero in years 6–30 — even at ≤78 LTV, where a conventional file does", async () => {
    // FHA at 75 LTV: MIP is owed for the life of the loan, so there is no
    // second projected-payments column with MI at zero.
    await mockApplicationOnce({ ...electedFhaApplication, downPayment: "100000" });
    const fhaLe = await generateLoanEstimate("app-f077");

    expect(fhaLe.projectedPayments.years1Through5.mortgageInsurance).toBe(200);
    expect(fhaLe.projectedPayments.years6Through30).toBeUndefined();

    // The same file priced conventional keeps the existing ≤78-LTV behavior:
    // a years-6–30 column with mortgage insurance at zero.
    await mockApplicationOnce({
      ...application,
      downPayment: "100000",
      loCompensationModel: "borrower_paid",
      loCompensationBps: 275,
    });
    const conventionalLe = await generateLoanEstimate("app-f077");

    expect(conventionalLe.projectedPayments.years6Through30).toBeDefined();
    expect(conventionalLe.projectedPayments.years6Through30!.mortgageInsurance).toBe(0);
  });
});
