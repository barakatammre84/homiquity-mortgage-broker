import { describe, it, expect } from "vitest";
import {
  composeScenario,
  normalizeScenario,
  type ScenarioFacts,
  type EngineEvaluator,
} from "../server/services/scenarioSimulator";
import {
  deriveAntiSteeringOptions,
  hasRiskyFeatures,
  pointsAndFeesDollars,
} from "../server/services/antiSteeringOptions";
import { computeClosingCosts } from "../server/services/loanCosts";
import { fhaMonthlyMIP } from "../server/services/mortgageInsurance";
import { UnderwritingError, type UnderwritingInput, type UnderwritingResult } from "../server/underwritingEngine";
import type { ComputedOffer } from "../server/services/pricingAdapter";

// -----------------------------------------------------------------------------
// LO-2 scenario simulator — pure-layer tests (no HTTP server, no Postgres).
//
// Pins the charter's Done-when: determinism (same inputs → byte-identical
// outputs) and the §1026.36(e)(3) safe-harbor set's presence, plus the shared
// loanCosts model's parity with the Loan Estimate fee schedule it was
// extracted from. The engine evaluator is injected as a deterministic fake —
// the real ConsolidatedUnderwritingEngine is matrix-backed and covered by its
// own suites.
// -----------------------------------------------------------------------------

function offer(overrides: Partial<ComputedOffer>): ComputedOffer {
  return {
    lenderName: "Fixture Lender",
    lenderCode: "FIX",
    lenderId: "lender-1",
    // Default to an APPROVED counterparty so the existing option-set tests keep
    // describing a normal shopped set; unapproved is opted into explicitly.
    lenderApproved: true,
    productId: "product-1",
    productCode: "FIX-C30",
    productName: "Conforming 30-Year Fixed",
    productType: "CONVENTIONAL",
    loanTerm: 360,
    amortizationType: "FIXED",
    baseRate: 6.5,
    adjustedRate: 6.75,
    lockTerm: 30,
    pricingBreakdown: {
      baseRate: 6.5,
      llpaAdjustment: 0.25,
      lockTermAdjustment: 0,
      lenderAdjustments: [],
      totalAdjustments: 0.25,
      finalRate: 6.75,
    },
    estimatedMonthlyPI: 2334.29,
    estimatedMonthlyMI: 0,
    estimatedMonthlyTotal: 2334.29,
    lenderFees: { originationFee: 1195 },
    eligibilityConstraints: null as ComputedOffer["eligibilityConstraints"],
    labels: [],
    ...overrides,
  };
}

/** Deterministic stand-in for the matrix-backed engine. */
const fakeEvaluate: EngineEvaluator = async (input: UnderwritingInput): Promise<UnderwritingResult> => {
  const income = input.baseMonthlyIncome + input.bonusMonthlyIncome;
  const dti = ((input.existingMonthlyDebts + input.proposedPiti) / income) * 100;
  const ltv = (input.originalLoanAmount / Math.min(input.contractSalesPrice, input.appraisalValue)) * 100;
  const reasons: string[] = [];
  if (dti > 50) reasons.push(`DTI ${dti.toFixed(2)}% exceeds 50%`);
  return {
    decision: reasons.length > 0 ? "REJECTED" : dti > 43 ? "MANUAL_REVIEW" : "APPROVED",
    loanType: input.requestedLoanProgram === "VA" ? "VA" : "CONVENTIONAL",
    calculatedLtv: Math.floor(ltv * 100) / 100,
    lookupLtv: Math.ceil(ltv),
    calculatedDti: dti,
    resolvedPmiMonthlyPremium: 0,
    resolvedLlpafUpfrontFee: 0,
    calculatedLiquidAssets: input.assets.reduce((sum, a) => sum + a.balance, 0),
    rejectionReasons: reasons,
    reviewReasons: [],
    resolvedPolicy: {
      loanType: input.requestedLoanProgram === "VA" ? "VA" : "CONVENTIONAL",
      conventionalDtiCapPct: 43,
      conventionalStretchDtiPct: 50,
      conventionalLtvCapPct: 97,
      haircutStockInvestment: 0.7,
      haircutRetirement: 0.6,
      fingerprint: "fixture-policy-fingerprint",
    },
  };
};

function facts(overrides: Partial<ScenarioFacts> = {}): ScenarioFacts {
  return {
    application: {
      id: "app-1",
      isVeteran: false,
      creditScore: 740,
      propertyState: "IL",
      isFirstTimeBuyer: false,
      householdFamilySize: null,
      homeSquareFootage: null,
      loCompensationModel: "lender_paid",
      loCompensationBps: 200,
    },
    scenario: { purchasePrice: 400000, downPaymentPercent: 20 },
    urlaOccupancyType: null,
    urlaNumberOfUnits: null,
    income: {
      evaluationId: "income-eval-1",
      primaryMonthlyQualifyingIncome: 10000,
      incomeBasis: "urla_line_items",
      recommendedPathId: null,
      requiresManualReview: false,
      evaluationFingerprint: "income-fingerprint",
      evaluatedAt: "2026-07-11T00:00:00.000Z",
    },
    monthlyDebts: 500,
    assets: [{ type: "CHECKING_SAVINGS", balance: 120000 }],
    offers: [
      offer({}),
      offer({
        lenderId: "lender-2",
        lenderCode: "ALT",
        productId: "product-2",
        productCode: "ALT-C30",
        adjustedRate: 6.5,
        estimatedMonthlyPI: 2275.44,
        lenderFees: { originationFee: 2400 },
      }),
      offer({
        lenderId: "lender-3",
        lenderCode: "IOL",
        productId: "product-3",
        productCode: "IOL-IO30",
        productName: "Interest-Only 30",
        amortizationType: "INTEREST_ONLY",
        adjustedRate: 6.25,
        estimatedMonthlyPI: 2216.97,
        lenderFees: { originationFee: 900 },
      }),
    ],
    excludedProducts: [],
    fthbLenderCredits: 0,
    rateSheetVersions: [
      { sheetId: "SHEET-1", lenderId: "lender-1", version: "v1", effectiveDate: "2026-07-01" },
    ],
    ...overrides,
  };
}

describe("composeScenario (LO-2 what-if simulator)", () => {
  it("is deterministic: same facts produce byte-identical results", async () => {
    const first = await composeScenario(facts(), fakeEvaluate);
    const second = await composeScenario(facts(), fakeEvaluate);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("returns OK with the anti-steering safe-harbor set present", async () => {
    const result = await composeScenario(facts(), fakeEvaluate);
    expect(result.status).toBe("OK");
    expect(result.simulated).toBe(true);
    const keys = result.antiSteering!.options.map((o) => o.key);
    expect(keys).toContain("lowest_rate");
    expect(keys).toContain("lowest_rate_no_risky_features");
    expect(keys).toContain("lowest_points_and_fees");
    // (A) lowest rate is the 6.25% interest-only product…
    const lowestRate = result.antiSteering!.options.find((o) => o.key === "lowest_rate")!;
    expect(lowestRate.productId).toBe("product-3");
    // …but (B) excludes it for its risky feature, landing on the 6.5% loan.
    const noRisky = result.antiSteering!.options.find(
      (o) => o.key === "lowest_rate_no_risky_features",
    )!;
    expect(noRisky.productId).toBe("product-2");
  });

  it("qualifies every returned offer (the (e)(3)(ii) good-faith surface)", async () => {
    const result = await composeScenario(facts(), fakeEvaluate);
    expect(result.offers.length).toBe(3);
    for (const evaluated of result.offers) {
      expect(["APPROVED", "REJECTED", "MANUAL_REVIEW"]).toContain(evaluated.qualification.decision);
      expect(evaluated.apr).toBeGreaterThan(evaluated.adjustedRate); // fees make APR exceed note rate
      expect(evaluated.costs.cashToClose).toBeGreaterThan(0);
      expect(evaluated.payment.totalPiti).toBeGreaterThan(evaluated.payment.principalAndInterest);
    }
    expect(result.engineVersions!.policyFingerprints).toEqual(["fixture-policy-fingerprint"]);
  });

  it("qualifies equal-payment offers on their own product policy path", async () => {
    const seenPrograms: UnderwritingInput["requestedLoanProgram"][] = [];
    const evaluator: EngineEvaluator = async (input) => {
      seenPrograms.push(input.requestedLoanProgram);
      if (input.requestedLoanProgram === "FHA") {
        throw new UnderwritingError(
          "POLICY_UNSUPPORTED",
          "FHA policy is not encoded",
          "FHA underwriting is not automated yet. A loan officer must review this program.",
        );
      }
      return fakeEvaluate(input);
    };
    const samePaymentOffers = [
      offer({ productId: "conv", productType: "CONVENTIONAL", estimatedMonthlyMI: 0 }),
      offer({ productId: "fha", productType: "FHA", estimatedMonthlyMI: 0 }),
    ];

    const result = await composeScenario(facts({ offers: samePaymentOffers }), evaluator);

    expect(seenPrograms).toEqual(["CONVENTIONAL", "FHA"]);
    expect(result.offers.find((item) => item.productId === "conv")?.qualification.decision).toBe("APPROVED");
    expect(result.offers.find((item) => item.productId === "fha")?.qualification.decision).toBe("MANUAL_REVIEW");
    expect(result.offers.find((item) => item.productId === "fha")?.qualification.reasons.join(" "))
      .toMatch(/not automated.*loan officer/i);
  });

  it("reports NEEDS_MORE_INFO when no credit score exists and no what-if is set", async () => {
    const result = await composeScenario(
      facts({
        application: { ...facts().application, creditScore: null },
      }),
      fakeEvaluate,
    );
    expect(result.status).toBe("NEEDS_MORE_INFO");
    expect(result.missingItems.join(" ")).toMatch(/credit score/i);
    expect(result.offers).toEqual([]);
  });

  it("rejects a down payment at or above the purchase price", async () => {
    const result = await composeScenario(
      facts({ scenario: { purchasePrice: 400000, downPaymentAmount: 400000 } }),
      fakeEvaluate,
    );
    expect(result.status).toBe("NEEDS_MORE_INFO");
    expect(result.missingItems.join(" ")).toMatch(/less than the purchase price/i);
  });

  it("unwraps an engine input gap into a scenario-wide NEEDS_MORE_INFO", async () => {
    const throwingEvaluate: EngineEvaluator = async () => {
      throw new UnderwritingError(
        "INPUT_INCOMPLETE",
        "internal detail",
        "To evaluate a VA loan we need the subject property state, household size, and home square footage.",
      );
    };
    const result = await composeScenario(facts(), throwingEvaluate);
    expect(result.status).toBe("NEEDS_MORE_INFO");
    expect(result.missingItems[0]).toMatch(/subject property state/);
    expect(result.missingItems[0]).not.toMatch(/__INPUT_GAP__/);
  });

  it("routes an out-of-band profile to MANUAL_REVIEW per offer, not a crash", async () => {
    const outOfBandEvaluate: EngineEvaluator = async () => {
      throw new UnderwritingError(
        "POLICY_OUT_OF_BAND",
        "internal detail",
        "This loan profile is outside our automated pricing coverage and needs a manual review by your loan team.",
      );
    };
    const result = await composeScenario(facts(), outOfBandEvaluate);
    expect(result.status).toBe("OK");
    for (const evaluated of result.offers) {
      expect(evaluated.qualification.decision).toBe("MANUAL_REVIEW");
      expect(evaluated.qualification.reasons[0]).toMatch(/manual review/i);
    }
  });

  it("returns NO_ELIGIBLE_PRODUCTS for an empty offer set", async () => {
    const result = await composeScenario(facts({ offers: [] }), fakeEvaluate);
    expect(result.status).toBe("NO_ELIGIBLE_PRODUCTS");
    expect(result.antiSteering!.options).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// F-077 follow-up — what-if MI is the offer's product-aware matrix figure.
//
// composeScenario used to price every non-VA offer through
// loanCosts.calculatePMI, a compile-time FICO×LTV card that exceeded the
// versioned CONVENTIONAL_PMI matrix in every live cell — after #553 moved the
// LE/decision to the matrix, a what-if OVERSTATED PITI/DTI against the very
// decision it exists to mirror. Now each offer carries its own
// estimatedMonthlyMI, priced by computeOffers from THIS scenario's profile
// (matrix conventional PMI / FHA MIP / zero on VA — services/
// mortgageInsurance.ts), and the simulator consumes it. The card is deleted.
//
// Fixture figures mirror the seeded matrix's worked example (700 FICO × 92 LTV
// → 0.78%/yr); the binding matrix VALUES are pinned by the integration suite
// against seeded matrices, and the product routing by tests/
// pricingAdapterMI.test.ts. Here the offers are injected, so these tests pin
// the SIMULATOR's consumption: per-offer MI into PITI, DTI, APR, and
// cash-to-close, deterministically and without Postgres.
// -----------------------------------------------------------------------------

// The register's worked example: $400k price, $32k down → $368k loan, 92 LTV.
const F077_SCENARIO = { purchasePrice: 400000, downPaymentAmount: 32000 };
// Matrix 0.78%/yr: $368k × 0.78% / 12. The DELETED card's figure for the same
// inputs was $429.33 (700 FICO × 92 LTV → its 1.40%/yr band) — if it ever
// reappears here, the F-077 defect is back.
const MATRIX_MONTHLY_PMI = 239.2;
const DELETED_CARD_FIGURE = 429.33;

describe("what-if MI prices the offer's product-aware matrix figure (F-077 follow-up)", () => {
  const app700 = () => ({ ...facts().application, creditScore: 700 });

  const convOffer = () =>
    offer({
      estimatedMonthlyMI: MATRIX_MONTHLY_PMI,
      estimatedMonthlyTotal: 2334.29 + MATRIX_MONTHLY_PMI,
    });

  it("consumes each offer's own MI — two products, two figures, never one card for all", async () => {
    // FHA MIP at 92 LTV — cross-checked against the shared helper so the
    // fixture cannot drift from what computeOffers actually emits.
    const fhaMI = Math.round(fhaMonthlyMIP(368000, 92) * 100) / 100;
    expect(fhaMI).toBe(245.33);

    const result = await composeScenario(
      facts({
        application: app700(),
        scenario: F077_SCENARIO,
        offers: [
          convOffer(),
          offer({
            lenderId: "lender-fha",
            productId: "product-fha",
            productCode: "FIX-FHA30",
            productName: "FHA 30-Year Fixed",
            productType: "FHA",
            estimatedMonthlyPI: 2360.12,
            estimatedMonthlyMI: fhaMI,
            estimatedMonthlyTotal: 2360.12 + fhaMI,
          }),
        ],
      }),
      fakeEvaluate,
    );

    expect(result.status).toBe("OK");
    const conv = result.offers.find((o) => o.productId === "product-1")!;
    const fha = result.offers.find((o) => o.productId === "product-fha")!;

    // Per-offer product-aware MI — the old code gave every non-VA offer the
    // same card figure, so two DIFFERENT figures here pin the migration.
    expect(conv.payment.mortgageInsurance).toBe(MATRIX_MONTHLY_PMI);
    expect(fha.payment.mortgageInsurance).toBe(fhaMI);
    expect(conv.payment.mortgageInsurance).not.toBe(DELETED_CARD_FIGURE);
    expect(fha.payment.mortgageInsurance).not.toBe(DELETED_CARD_FIGURE);

    // PITI composes from the same figure (default schedule escrow on $400k:
    // $400/mo tax + $100/mo insurance).
    expect(conv.payment.escrow).toBe(500);
    expect(conv.payment.totalPiti).toBe(2334.29 + MATRIX_MONTHLY_PMI + 500);
  });

  it("moves DTI, APR, and cash-to-close — the matrix figure reaches qualification, not just the card", async () => {
    const run = (mi: number) =>
      composeScenario(
        facts({
          application: app700(),
          scenario: F077_SCENARIO,
          offers: [
            offer({ estimatedMonthlyMI: mi, estimatedMonthlyTotal: 2334.29 + mi }),
          ],
        }),
        fakeEvaluate,
      );

    const withMI = (await run(MATRIX_MONTHLY_PMI)).offers[0];
    const control = (await run(0)).offers[0];

    // fakeEvaluate: DTI = ($500 debts + PITI) / $10k income. PITI with the
    // matrix figure: 2334.29 + 239.20 + 500 escrow = 3073.49 → 35.73%;
    // without MI: 2834.29 → 33.34%. The 2.39-point spread is exactly what the
    // decision sees — under the old card the spread was 4.29 points, bouncing
    // borderline what-ifs the real decision approves.
    expect(withMI.qualification.dti).toBe(35.73);
    expect(control.qualification.dti).toBe(33.34);

    // Cash-to-close carries 4 months of MI at the matrix rate — the shared
    // fee model's 2 prepaid months plus its 2-month initial escrow deposit
    // (loanCosts prepaidMortgageInsurance + escrowMortgageInsurance)…
    expect(withMI.costs.cashToClose - control.costs.cashToClose).toBeCloseTo(
      4 * MATRIX_MONTHLY_PMI,
      2,
    );
    // …and the APR stream prices the same MI leg.
    expect(withMI.apr).toBeGreaterThan(control.apr);
  });

  it("prices each offer's program for a veteran instead of treating every product as VA", async () => {
    const result = await composeScenario(
      facts({
        application: {
          ...app700(),
          isVeteran: true,
          // VA residual-income inputs normalizeScenario requires for veterans.
          householdFamilySize: 3,
          homeSquareFootage: 1800,
        },
        scenario: F077_SCENARIO,
        offers: [
          // A conventional offer remains conventional even when the borrower
          // may also be eligible for VA.
          convOffer(),
          offer({
            lenderId: "lender-va",
            productId: "product-va",
            productCode: "FIX-VA30",
            productName: "VA 30-Year Fixed",
            productType: "VA",
            estimatedMonthlyMI: 0,
            estimatedMonthlyTotal: 2334.29,
          }),
        ],
      }),
      fakeEvaluate,
    );

    expect(result.offers.find((item) => item.productId === "product-1")?.payment.mortgageInsurance)
      .toBe(MATRIX_MONTHLY_PMI);
    expect(result.offers.find((item) => item.productId === "product-va")?.payment.mortgageInsurance)
      .toBe(0);
  });
});

describe("normalizeScenario", () => {
  it("converts a percent down payment to a cent-rounded amount", () => {
    const { scenario } = normalizeScenario({
      application: facts().application,
      scenario: { purchasePrice: 333333, downPaymentPercent: 10 },
      urlaOccupancyType: null,
      urlaNumberOfUnits: null,
    });
    expect(scenario!.downPayment).toBe(33333.3);
    expect(scenario!.downPaymentPercent).toBe(10);
  });

  it("marks the FICO what-if as hypothetical", () => {
    const { scenario } = normalizeScenario({
      application: facts().application,
      scenario: { purchasePrice: 400000, downPaymentPercent: 20, ficoWhatIf: 780 },
      urlaOccupancyType: null,
      urlaNumberOfUnits: null,
    });
    expect(scenario!.fico).toBe(780);
    expect(scenario!.ficoIsWhatIf).toBe(true);
  });
});

describe("deriveAntiSteeringOptions (§1026.36(e)(3))", () => {
  it("breaks a points-and-fees tie by the lowest rate (the reg's own tie-break)", () => {
    const offers = [
      offer({ productId: "hi-rate", adjustedRate: 7.0, lenderFees: { originationFee: 1000 } }),
      offer({ productId: "lo-rate", adjustedRate: 6.5, lenderFees: { originationFee: 1000 } }),
    ];
    const set = deriveAntiSteeringOptions(offers);
    const optionC = set.options.find((o) => o.key === "lowest_points_and_fees")!;
    expect(optionC.productId).toBe("lo-rate");
  });

  it("detects risky features from amortization markers only (catalog carries no other flags)", () => {
    expect(hasRiskyFeatures(offer({ amortizationType: "INTEREST_ONLY" }))).toBe(true);
    expect(hasRiskyFeatures(offer({ amortizationType: "BALLOON_7" }))).toBe(true);
    expect(hasRiskyFeatures(offer({ amortizationType: "NEG_AM" }))).toBe(true);
    expect(hasRiskyFeatures(offer({ amortizationType: "FIXED" }))).toBe(false);
    expect(hasRiskyFeatures(offer({ amortizationType: "ARM" }))).toBe(false);
  });

  it("sums origination-type lender fees into the (C) dollar basis", () => {
    const fees = pointsAndFeesDollars(
      offer({
        lenderFees: {
          originationFee: 1000,
          other: [
            { name: "Discount Points", amount: 500 },
            { name: "Flood Cert", amount: 25 },
          ],
        },
      }),
    );
    expect(fees).toBe(1500);
  });

  it("counts distinct creditors quoted", () => {
    const set = deriveAntiSteeringOptions([
      offer({}),
      offer({ lenderId: "lender-2", productId: "p2" }),
      offer({ lenderId: "lender-2", productId: "p3" }),
    ]);
    expect(set.creditorsQuoted).toBe(2);
    expect(set.creditorsQuotedTotal).toBe(2);
    expect(set.noApprovedCreditors).toBe(false);
  });

  // F-0807-01 — the (e)(3)(i) "significant number" surface counted any lender
  // that produced an offer. Offers are selected on `status: "ACTIVE"` (row
  // liveness, not an agreement), so with the three seeded demo lenders it
  // reported creditorsQuoted: 3 / singleCreditor: false — a shopped,
  // plausibly-compliant option set built entirely from fictional companies.
  it("does not count unapproved creditors toward the (e)(3)(i) sufficiency number", () => {
    const set = deriveAntiSteeringOptions([
      offer({ lenderId: "SAMPLE-SUMMIT-001", lenderApproved: false }),
      offer({ lenderId: "SAMPLE-BLUERIVER-001", productId: "p2", lenderApproved: false }),
      offer({ lenderId: "SAMPLE-ATLAS-001", productId: "p3", lenderApproved: false }),
    ]);
    expect(set.creditorsQuoted).toBe(0);
    expect(set.noApprovedCreditors).toBe(true);
    // Strictly worse than single-creditor, and it must say so rather than
    // reading as a three-creditor set.
    expect(set.singleCreditor).toBe(true);
  });

  it("reports the unapproved quotes rather than hiding them", () => {
    // The quotes are real rate-sheet output and still shown; only the
    // sufficiency count excludes them, and the total keeps them visible.
    const set = deriveAntiSteeringOptions([
      offer({ lenderId: "SAMPLE-SUMMIT-001", lenderApproved: false }),
      offer({ lenderId: "SAMPLE-ATLAS-001", productId: "p3", lenderApproved: false }),
    ]);
    expect(set.creditorsQuotedTotal).toBe(2);
    expect(set.options.length).toBeGreaterThan(0);
    expect(set.options.every((o) => o.lenderApproved === false)).toBe(true);
  });

  it("an unapproved lender cannot pad an approved creditor's count", () => {
    const set = deriveAntiSteeringOptions([
      offer({ lenderId: "uwm", lenderApproved: true }),
      offer({ lenderId: "SAMPLE-SUMMIT-001", productId: "p2", lenderApproved: false }),
    ]);
    expect(set.creditorsQuoted).toBe(1);
    expect(set.singleCreditor).toBe(true);
    expect(set.noApprovedCreditors).toBe(false);
  });

  it("treats a missing approval fact as unapproved — fail closed", () => {
    const { lenderApproved: _omitted, ...noFact } = offer({});
    const set = deriveAntiSteeringOptions([noFact as never]);
    expect(set.creditorsQuoted).toBe(0);
    expect(set.noApprovedCreditors).toBe(true);
  });
});

const BORROWER_PAID = { model: "borrower_paid", bps: 100 } as const;

describe("computeClosingCosts (shared LE fee schedule)", () => {
  it("reproduces the Loan Estimate fee schedule for a fixture loan", () => {
    const costs = computeClosingCosts({
      purchasePrice: 400000,
      downPayment: 40000,
      loanAmount: 360000,
      interestRate: 6.875,
      monthlyPMI: 150,
      prepaidInterestDays: 15,
      compensation: BORROWER_PAID,
    });
    expect(costs.originationFee).toBe(3600); // 1% of loan amount
    expect(costs.applicationFee).toBe(500);
    expect(costs.underwritingFee).toBe(1500);
    expect(costs.titleInsurance).toBe(1800); // 0.5% of loan amount
    expect(costs.transferTaxes).toBe(400); // 0.1% of price
    expect(costs.ownersTitleInsurance).toBe(1200); // 0.3% of price
    expect(costs.annualPropertyTax).toBe(4800); // 1.2% of price
    expect(costs.annualHomeownersInsurance).toBe(1200); // max(1200, 0.3%)
    expect(costs.prepaidInterest).toBeCloseTo(((360000 * 0.06875) / 365) * 15, 6);
    expect(costs.prepaidMortgageInsurance).toBe(300); // 2 months PMI
    expect(costs.totalClosingCosts).toBeCloseTo(costs.loanCostsTotal + costs.otherCostsTotal, 6);
    expect(costs.cashToClose).toBeCloseTo(costs.totalClosingCosts + 40000, 6);
    // §1026.4 prepaid finance charges: origination + points + app + UW + tax
    // service + prepaid interest + prepaid MI.
    expect(costs.prepaidFinanceCharges).toBeCloseTo(
      3600 + 0 + 500 + 1500 + 100 + costs.prepaidInterest + 300,
      6,
    );
  });

  it("honors tax/insurance overrides (the address-prefill path)", () => {
    const costs = computeClosingCosts({
      purchasePrice: 400000,
      downPayment: 40000,
      loanAmount: 360000,
      interestRate: 6.875,
      monthlyPMI: 0,
      prepaidInterestDays: 15,
      compensation: BORROWER_PAID,
      annualPropertyTaxes: 9600,
      annualHomeownersInsurance: 2400,
    });
    expect(costs.annualPropertyTax).toBe(9600);
    expect(costs.monthlyEscrow).toBeCloseTo(9600 / 12 + 2400 / 12, 6);
  });

  it("subtracts lender credits from cash to close", () => {
    const base = computeClosingCosts({
      purchasePrice: 400000,
      downPayment: 40000,
      loanAmount: 360000,
      interestRate: 6.875,
      monthlyPMI: 0,
      prepaidInterestDays: 15,
      compensation: BORROWER_PAID,
    });
    const credited = computeClosingCosts({
      purchasePrice: 400000,
      downPayment: 40000,
      loanAmount: 360000,
      interestRate: 6.875,
      monthlyPMI: 0,
      prepaidInterestDays: 15,
      compensation: BORROWER_PAID,
      lenderCredits: 1000,
    });
    expect(credited.cashToClose).toBeCloseTo(base.cashToClose - 1000, 6);
  });
});
