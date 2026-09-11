import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  ConsolidatedUnderwritingEngine,
  consolidatedUnderwritingEngine,
  reconcileSubjectProperty,
  type UnderwritingInput,
} from "../server/underwritingEngine";
import { LookupResolverService, type ValueResolver } from "../server/services/lookupResolver";
import { computeMonthsOfReserves, estimateMonthlyPITI } from "../server/services/preUnderwriting";
import { detectSignificantDeposits, vaRegionForState } from "../server/services/underwritingNuance";
import { CONFORMING_LOAN_LIMIT_2026 } from "../shared/lendingLimits";

// ---------------------------------------------------------------------------
// Adversarial persona regression suite.
//
// Five synthetic borrowers engineered to sit on the engine's seams: negative
// K-1 income, occupancy misrepresentation, exact conforming boundaries, a
// sub-620 credit file, and a VA family of six. Two kinds of tests:
//
//   plain `it`  — pins CURRENT behavior (including crashes and known
//                 miscalculations) so any change is deliberate and visible.
//   `it.fails`  — encodes the CORRECT policy outcome the engine does not yet
//                 produce. The suite stays green today; when a gap is fixed,
//                 vitest reports the test as "expected to fail but passed",
//                 forcing the .fails marker (and this documentation) to be
//                 removed in the same change.
//
// Hermetic: the Postgres-backed LookupResolverService is replaced with an
// in-memory resolver seeded with the exact grid data from
// server/scripts/seedLendingGrids.ts — including its coverage gaps, which are
// themselves under test. Storage and loan pricing are mocked.
// ---------------------------------------------------------------------------

// --- In-memory replica of the seeded lookup grids --------------------------

interface Cell {
  d1Min?: number;
  d1Max?: number;
  d2Min?: number;
  d2Max?: number;
  d3?: string;
  value: number;
}

const GRIDS: Record<string, Cell[]> = {
  CONVENTIONAL_DTI_CAP: [{ value: 43 }],
  CONVENTIONAL_STRETCH_DTI: [{ value: 50 }],
  CONVENTIONAL_LTV_CAP: [{ value: 95 }],
  CONVENTIONAL_FICO_FLOOR: [{ value: 620 }],
  CONFORMING_LOAN_LIMIT: [{ value: CONFORMING_LOAN_LIMIT_2026 }],
  VA_RESIDUAL_EXTRA_MEMBER: [{ value: 80 }],
  // Occupancy x units max LTV (Fannie Eligibility Matrix). Second homes are
  // 1-unit only; other combinations are intentionally unseeded (out of band).
  CONVENTIONAL_MAX_LTV: [
    { d1Min: 1, d1Max: 1, d3: "PRIMARY", value: 95 },
    { d1Min: 2, d1Max: 2, d3: "PRIMARY", value: 85 },
    { d1Min: 3, d1Max: 3, d3: "PRIMARY", value: 75 },
    { d1Min: 4, d1Max: 4, d3: "PRIMARY", value: 75 },
    { d1Min: 1, d1Max: 1, d3: "SECOND", value: 90 },
    { d1Min: 1, d1Max: 1, d3: "INVESTMENT", value: 85 },
    { d1Min: 2, d1Max: 2, d3: "INVESTMENT", value: 75 },
    { d1Min: 3, d1Max: 3, d3: "INVESTMENT", value: 75 },
    { d1Min: 4, d1Max: 4, d3: "INVESTMENT", value: 75 },
  ],
  HAIRCUT_STOCK_INVESTMENT: [{ value: 60 }],
  HAIRCUT_RETIREMENT: [{ value: 70 }],
  CONVENTIONAL_PMI: [],
  FANNIE_LLPA: [],
  VA_RESIDUAL: [],
};

// CONVENTIONAL_PMI — FICO floor is 620; LTV ceiling is 97.00 (both gaps are
// exercised by personas 3 and 4).
const PMI_FICO_ROWS: Array<[number, number]> = [
  [760, 850], [740, 759], [720, 739], [700, 719], [680, 699], [660, 679], [640, 659], [620, 639],
];
const PMI_LTV_BANDS: Array<{ min: number; max: number; rates: number[] }> = [
  { min: 95.01, max: 97.0, rates: [0.58, 0.7, 0.87, 0.99, 1.21, 1.54, 1.65, 1.86] },
  { min: 90.01, max: 95.0, rates: [0.38, 0.53, 0.66, 0.78, 0.96, 1.28, 1.33, 1.42] },
  { min: 85.01, max: 90.0, rates: [0.28, 0.38, 0.46, 0.54, 0.67, 0.9, 0.94, 1.02] },
  { min: 80.01, max: 85.0, rates: [0.19, 0.23, 0.27, 0.3, 0.38, 0.49, 0.52, 0.58] },
];
for (const band of PMI_LTV_BANDS) {
  band.rates.forEach((rate, i) => {
    GRIDS.CONVENTIONAL_PMI.push({
      d1Min: PMI_FICO_ROWS[i][0], d1Max: PMI_FICO_ROWS[i][1],
      d2Min: band.min, d2Max: band.max, value: rate,
    });
  });
}

// FANNIE_LLPA — FICO 300–850, rounded LTV 0–97.
const LLPA_FICO_SLICES: Array<[number, number]> = [
  [780, 850], [760, 779], [740, 759], [720, 739], [700, 719], [680, 699], [660, 679], [640, 659], [300, 639],
];
const LLPA_LTV_BANDS: Array<{ min: number; max: number; rates: number[] }> = [
  { min: 0, max: 60, rates: [0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { min: 61, max: 70, rates: [0, 0, 0, 0, 0, 0, 0, 0.125, 0.125] },
  { min: 71, max: 75, rates: [0, 0, 0.125, 0.25, 0.375, 0.625, 0.875, 1.125, 1.5] },
  { min: 76, max: 80, rates: [0.375, 0.625, 0.875, 1.0, 1.125, 1.375, 1.75, 2.0, 2.25] },
  { min: 81, max: 85, rates: [0.375, 0.625, 1.0, 1.25, 1.5, 1.625, 1.875, 2.5, 2.875] },
  { min: 86, max: 90, rates: [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.625] },
  { min: 91, max: 95, rates: [0.25, 0.5, 0.625, 0.875, 1.125, 1.375, 1.625, 1.875, 2.25] },
  { min: 96, max: 97, rates: [0.125, 0.25, 0.5, 0.75, 0.875, 1.125, 1.375, 1.5, 1.75] },
];
for (const band of LLPA_LTV_BANDS) {
  band.rates.forEach((rate, i) => {
    GRIDS.FANNIE_LLPA.push({
      d1Min: LLPA_FICO_SLICES[i][0], d1Max: LLPA_FICO_SLICES[i][1],
      d2Min: band.min, d2Max: band.max, value: rate,
    });
  });
}

// VA_RESIDUAL — family sizes 1–5 exactly (dim1Min = dim1Max; sizes >5 use the
// size-5 cell + VA_RESIDUAL_EXTRA_MEMBER per member), loan bands
// [0, 79999.99] and [80000, 9999999] (cent-continuous — mirrors the seed).
const VA_TABLE: Record<string, number[]> = {
  NORTHEAST: [450, 755, 909, 1025, 1062],
  MIDWEST: [441, 738, 889, 1003, 1039],
  SOUTH: [441, 738, 889, 1003, 1039],
  WEST: [491, 823, 990, 1117, 1158],
};
const VA_LOW_TABLE: Record<string, number[]> = {
  NORTHEAST: [390, 654, 788, 888, 921],
  MIDWEST: [382, 641, 772, 868, 902],
  SOUTH: [382, 641, 772, 868, 902],
  WEST: [425, 713, 859, 967, 1004],
};
for (const [region, values] of Object.entries(VA_TABLE)) {
  values.forEach((value, i) => {
    GRIDS.VA_RESIDUAL.push({ d1Min: i + 1, d1Max: i + 1, d2Min: 80000, d2Max: 9999999, d3: region, value });
  });
}
for (const [region, values] of Object.entries(VA_LOW_TABLE)) {
  values.forEach((value, i) => {
    GRIDS.VA_RESIDUAL.push({ d1Min: i + 1, d1Max: i + 1, d2Min: 0, d2Max: 79999.99, d3: region, value });
  });
}

// Mirrors defaultValueResolver's matching and error semantics exactly.
const gridValueResolver: ValueResolver = async (query) => {
  const cells = GRIDS[query.matrixCode];
  if (!cells) {
    throw new Error(
      `CRITICAL COMPLIANCE ERROR: Required matrix configuration [${query.matrixCode}] is missing, expired, or not active`,
    );
  }
  const cell = cells.find((c) => {
    if (query.dim1Value !== undefined) {
      if (c.d1Min !== undefined && c.d1Min > query.dim1Value) return false;
      if (c.d1Max !== undefined && c.d1Max < query.dim1Value) return false;
    }
    if (query.dim2Value !== undefined) {
      if (c.d2Min !== undefined && c.d2Min > query.dim2Value) return false;
      if (c.d2Max !== undefined && c.d2Max < query.dim2Value) return false;
    }
    if (query.dim3Identifier !== undefined && c.d3 !== query.dim3Identifier) return false;
    return true;
  });
  if (!cell) {
    throw new Error(
      `CRITICAL DECISIONING ERROR: Lookup parameters [d1: ${query.dim1Value ?? "N/A"}, d2: ${query.dim2Value ?? "N/A"}, d3: ${query.dim3Identifier ?? "N/A"}] fell outside permitted compliance intervals in active matrix [${query.matrixCode}]`,
    );
  }
  return { value: cell.value, expiresAt: null };
};

const seededResolver = new LookupResolverService({
  stampReader: async () => 1,
  valueResolver: gridValueResolver,
});

function makeEngine(): ConsolidatedUnderwritingEngine {
  const engine = new ConsolidatedUnderwritingEngine();
  (engine as unknown as { resolver: LookupResolverService }).resolver = seededResolver;
  return engine;
}
// The instant-decision orchestrator uses the exported singleton.
(consolidatedUnderwritingEngine as unknown as { resolver: LookupResolverService }).resolver = seededResolver;

// --- Mocks for the instant-decision orchestrator ---------------------------

const mocks = vi.hoisted(() => ({
  getLoanApplication: vi.fn(),
  getEmploymentHistory: vi.fn(),
  getOtherIncomeSources: vi.fn(),
  getUrlaLiabilities: vi.fn(),
  getUrlaAssets: vi.fn(),
  getUrlaPropertyInfo: vi.fn(),
  getRealEstateOwnedByApplication: vi.fn(),
  // B3-5.3-07: the decision now reads Section 5 declarations across ALL
  // borrowers. These personas declare no derogatory events, so the default is
  // an empty list — set `data.declarations` to exercise the review route.
  getAllBorrowerDeclarations: vi.fn(),
  getLatestBankStatementAnalysis: vi.fn(),
  generateLoanEstimate: vi.fn(),
  computeDecisionPaymentProjection: vi.fn(),
  getCurrentDecisionGrade: vi.fn(),
  loadProfitLossActivity: vi.fn(async () => ({ signals: [], issues: [] })),
}));

vi.mock("../server/storage", () => ({ storage: mocks }));
vi.mock("../server/services/loanEstimate", () => ({
  generateLoanEstimate: mocks.generateLoanEstimate,
  // The engine prices via the compensation-independent projection (WF1-002).
  computeDecisionPaymentProjection: mocks.computeDecisionPaymentProjection,
}));
vi.mock("../server/services/currentDecisionGrade", () => ({
  getCurrentDecisionGrade: mocks.getCurrentDecisionGrade,
}));
vi.mock("../server/services/profitLossActivity", () => ({
  loadProfitLossActivity: mocks.loadProfitLossActivity,
}));

import { runInstantDecision } from "../server/services/decisionEngine";

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: "app-1",
    userId: "user-1",
    isVeteran: false,
    creditScore: 741,
    purchasePrice: "900000",
    downPayment: "180000",
    propertyValue: "905000",
    propertyState: "TX",
    annualIncome: "0",
    monthlyDebts: "0",
    financialDataProvenance: null,
    ownsOtherRealEstate: false,
    preferredLoanType: "conventional",
    ...overrides,
  };
}

function primeOrchestrator(app: Record<string, unknown>, data: {
  employment?: Record<string, unknown>[];
  otherIncome?: Record<string, unknown>[];
  liabilities?: Record<string, unknown>[];
  urlaAssets?: Record<string, unknown>[];
  propertyInfo?: Record<string, unknown>;
  piti?: number;
} = {}) {
  mocks.getLoanApplication.mockResolvedValue(app);
  mocks.getEmploymentHistory.mockResolvedValue(data.employment ?? []);
  mocks.getOtherIncomeSources.mockResolvedValue(data.otherIncome ?? []);
  mocks.getUrlaLiabilities.mockResolvedValue(data.liabilities ?? []);
  mocks.getUrlaAssets.mockResolvedValue(data.urlaAssets ?? []);
  mocks.getUrlaPropertyInfo.mockResolvedValue(data.propertyInfo ?? undefined);
  mocks.getRealEstateOwnedByApplication.mockResolvedValue([]);
  mocks.getAllBorrowerDeclarations.mockResolvedValue(data.declarations ?? []);
  mocks.getLatestBankStatementAnalysis.mockResolvedValue(undefined);
  mocks.generateLoanEstimate.mockResolvedValue({
    projectedPayments: { years1Through5: { estimatedTotal: data.piti ?? 3000 } },
  });
  mocks.computeDecisionPaymentProjection.mockResolvedValue({
    estimatedMonthlyTotal: data.piti ?? 3000,
    // B3-6-03 qualifying PITIA — what the DTI and reserves are actually built
    // on. These personas carry no association dues, so it equals the LE figure.
    qualifyingPitia: data.piti ?? 3000,
    monthlyAssociationDues: null,
    associationDuesUncaptured: false,
  });
}

function baseConventionalInput(overrides: Partial<UnderwritingInput> = {}): UnderwritingInput {
  return {
    requestedLoanProgram: "CONVENTIONAL",
    isVeteran: false,
    baseMonthlyIncome: 40000,
    bonusMonthlyIncome: 0,
    existingMonthlyDebts: 0,
    originalLoanAmount: 500000,
    contractSalesPrice: 1_000_000,
    appraisalValue: 1_000_000,
    representativeFico: 780,
    proposedPiti: 4000,
    assets: [],
    ...overrides,
  };
}

describe("Multiple financed property decision gates", () => {
  const assessment = (count: number, additionalReserveRequirement: number) => ({
    ...(count <= 4 ? { aggregateReserveUpb: additionalReserveRequirement / 0.02, reserveFactor: 0.02 as const }
      : count <= 6 ? { aggregateReserveUpb: additionalReserveRequirement / 0.04, reserveFactor: 0.04 as const }
      : { aggregateReserveUpb: additionalReserveRequirement / 0.06, reserveFactor: 0.06 as const }),
    complete: true,
    missingItems: [],
    financedPropertiesCount: count,
    additionalReserveRequirement,
    subjectOccupancy: "investment" as const,
    countedPropertyIds: [],
  });

  it("routes an investment borrower with more than ten financed properties to review", async () => {
    const result = await consolidatedUnderwritingEngine.evaluate(baseConventionalInput({
      occupancyType: "investment",
      contractSalesPrice: 600000,
      appraisalValue: 600000,
      assets: [{ type: "CHECKING_SAVINGS", balance: 500000 }],
      multipleFinancedProperties: assessment(11, 10000),
    }));
    expect(result.decision).toBe("MANUAL_REVIEW");
    expect(result.reviewReasons.join(" ")).toMatch(/maximum of 10/i);
  });

  it("routes an investment borrower below combined subject and other-property reserves to review", async () => {
    const result = await consolidatedUnderwritingEngine.evaluate(baseConventionalInput({
      occupancyType: "investment",
      contractSalesPrice: 600000,
      appraisalValue: 600000,
      assets: [{ type: "CHECKING_SAVINGS", balance: 130000 }],
      multipleFinancedProperties: assessment(3, 10000),
    }));
    // $100k down leaves $30k; six months of $4k PITIA plus $10k additional = $34k.
    expect(result.calculatedPostClosingLiquidAssets).toBe(30000);
    expect(result.calculatedRequiredReserves).toBe(34000);
    expect(result.decision).toBe("MANUAL_REVIEW");
    expect(result.reviewReasons.join(" ")).toMatch(/below the .*reserve requirement/i);
  });

  it("keeps a sufficiently reserved investment file priceable", async () => {
    const result = await consolidatedUnderwritingEngine.evaluate(baseConventionalInput({
      occupancyType: "investment",
      contractSalesPrice: 600000,
      appraisalValue: 600000,
      assets: [{ type: "CHECKING_SAVINGS", balance: 140000 }],
      multipleFinancedProperties: assessment(3, 10000),
    }));
    expect(result.calculatedPostClosingLiquidAssets).toBe(40000);
    expect(result.calculatedRequiredReserves).toBe(34000);
    expect(result.decision).toBe("APPROVED");
    expect(result.resolvedLlpafUpfrontFee).toBeGreaterThanOrEqual(0);
  });
});

describe("Open 30-day charge account asset gate", () => {
  const completePrimaryAssessment = {
    complete: true,
    missingItems: [],
    financedPropertiesCount: 1,
    aggregateReserveUpb: 0,
    reserveFactor: 0 as const,
    additionalReserveRequirement: 0,
    subjectOccupancy: "primary" as const,
    countedPropertyIds: [],
  };

  it("routes the file to review when verified assets cannot cover the down payment and open balance", async () => {
    const result = await consolidatedUnderwritingEngine.evaluate(baseConventionalInput({
      contractSalesPrice: 600000,
      appraisalValue: 600000,
      assets: [{ type: "CHECKING_SAVINGS", balance: 105000 }],
      openThirtyDayChargeBalance: 10000,
      multipleFinancedProperties: completePrimaryAssessment,
    }));
    expect(result.decision).toBe("MANUAL_REVIEW");
    expect(result.reviewReasons.join(" ")).toMatch(/open 30-day charge balances/i);
  });

  it("keeps the file priceable when the same balance is fully covered after down payment", async () => {
    const result = await consolidatedUnderwritingEngine.evaluate(baseConventionalInput({
      contractSalesPrice: 600000,
      appraisalValue: 600000,
      assets: [{ type: "CHECKING_SAVINGS", balance: 112000 }],
      openThirtyDayChargeBalance: 10000,
      multipleFinancedProperties: completePrimaryAssessment,
    }));
    expect(result.decision).toBe("APPROVED");
  });
});

describe("Subject-property subordinate financing gate", () => {
  it("calculates all three lien ratios and routes the file to current-matrix review", async () => {
    const result = await consolidatedUnderwritingEngine.evaluate(baseConventionalInput({
      originalLoanAmount: 400000,
      contractSalesPrice: 500000,
      appraisalValue: 490000,
      subordinateFinancingExists: true,
      combinedLoanToValue: 87.7551,
      homeEquityCombinedLoanToValue: 95.9184,
    }));
    expect(result).toMatchObject({
      calculatedLtv: 81.63,
      calculatedCltv: 87.7551,
      calculatedHcltv: 95.9184,
      decision: "MANUAL_REVIEW",
    });
    expect(result.reviewReasons.join(" ")).toMatch(/eligibility matrix/i);
  });

  it("rejects internally inconsistent combined-lien ratios", async () => {
    await expect(consolidatedUnderwritingEngine.evaluate(baseConventionalInput({
      subordinateFinancingExists: true,
      combinedLoanToValue: 45,
      homeEquityCombinedLoanToValue: 40,
    }))).rejects.toMatchObject({ kind: "INPUT_INVALID" });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentDecisionGrade.mockResolvedValue({
    isDecisionGrade: false,
    reasons: ["Preliminary fixture"],
    evidence: {
      financialMemoId: null,
      incomeWorkpaperId: null,
      assetWorkpaperId: null,
      liabilityWorkpaperId: null,
      creditPullId: null,
      creditPullIsSimulated: false,
      creditPullIsCurrent: false,
      creditPullHasProviderReference: false,
      creditPullScoreIsUsable: false,
      creditPullLiabilitiesAreUsable: false,
      creditPullHasOpenLiabilities: false,
    },
    verification: { income: false, assets: false, credit: false },
    decisionCredit: null,
  });
});

describe("Instant-decision liability parity", () => {
  it("uses the same revolving-payment imputation as the reviewed liability workpaper", async () => {
    const app = makeApp({ annualIncome: "180000" });
    primeOrchestrator(app, {
      liabilities: [{
        id: "card-1",
        applicationId: "app-1",
        borrowerSequenceNumber: 1,
        liabilityType: "Revolving (Credit Card)",
        unpaidBalance: "12000",
        monthlyPayment: "0",
        toBePaidOff: false,
      }],
    });
    const result = await runInstantDecision("app-1");
    expect(result.metrics?.monthlyDebts).toBe(600);
  });
});

describe("Self-employed intake decision gate", () => {
  it("requires URLA self-employment detail before a rough intake total can be decisioned", async () => {
    primeOrchestrator(makeApp({ employmentType: "self_employed", annualIncome: "240000" }), {
      employment: [],
      piti: 4200,
    });

    const decision = await runInstantDecision("app-1");

    expect(decision.status).toBe("NEEDS_MORE_INFO");
    expect(decision.decision).toBeNull();
    expect(decision.missingItems.join(" ")).toMatch(/self-employment.*worksheet/i);
  });

  it("keeps a self-employed record without its worksheet in needs-more-info", async () => {
    primeOrchestrator(makeApp({ employmentType: "self_employed", annualIncome: "240000" }), {
      employment: [
        {
          borrowerSequenceNumber: 1,
          employerName: "Northstar Consulting LLC",
          isSelfEmployed: true,
          selfEmploymentIncome: null,
        },
      ],
      piti: 4200,
    });

    const decision = await runInstantDecision("app-1");

    expect(decision.status).toBe("NEEDS_MORE_INFO");
    expect(decision.decision).toBeNull();
    expect(decision.missingItems.join(" ")).toMatch(/complete.*worksheet/i);
  });
});

describe("Explicit underwriting program selection", () => {
  it("keeps the fast intake by evaluating a labeled preliminary conventional candidate", async () => {
    primeOrchestrator(makeApp({ preferredLoanType: null, annualIncome: "144000" }), { piti: 2200 });

    const decision = await runInstantDecision("app-1");

    expect(decision.status).toBe("DECISION_READY");
    expect(decision.qualifier).toBe("PRELIMINARY");
    expect(decision.loanProgram).toBe("CONVENTIONAL");
    expect(decision.loanProgramSelection).toBe("preliminary_conventional_candidate");
    expect(mocks.computeDecisionPaymentProjection).toHaveBeenCalledWith("app-1", "conventional");
  });

  it("requires an application-selected program before a verified decision", async () => {
    mocks.getCurrentDecisionGrade.mockResolvedValueOnce({
      isDecisionGrade: true,
      reasons: [],
      evidence: {
        financialMemoId: "memo-1",
        incomeWorkpaperId: "income-1",
        assetWorkpaperId: "assets-1",
        liabilityWorkpaperId: "liabilities-1",
        creditPullId: "credit-1",
        creditPullIsSimulated: false,
        creditPullIsCurrent: true,
        creditPullHasProviderReference: true,
        creditPullScoreIsUsable: true,
        creditPullLiabilitiesAreUsable: true,
        creditPullHasOpenLiabilities: false,
      },
      verification: { income: true, assets: true, credit: true },
      decisionCredit: {
        pullId: "credit-1",
        representativeScore: 720,
        borrowerScores: [{ borrowerSequenceNumber: 1, experianScore: 720, equifaxScore: 710, transunionScore: 730, representativeScore: 720 }],
        tradelines: [],
        reportedMonthlyPayments: 0,
        adjustedMonthlyDebt: 0,
        fingerprint: "a".repeat(64),
      },
    });
    primeOrchestrator(makeApp({ preferredLoanType: null, annualIncome: "144000" }), { piti: 2200 });

    const decision = await runInstantDecision("app-1");

    expect(decision.status).toBe("NEEDS_MORE_INFO");
    expect(decision.qualifier).toBe("VERIFIED");
    expect(decision.loanProgram).toBeNull();
    expect(decision.loanProgramSelection).toBeNull();
    expect(decision.missingItems).toContain("Preferred loan program");
    expect(mocks.computeDecisionPaymentProjection).not.toHaveBeenCalled();
  });

  it("keeps a veteran's conventional selection on the conventional policy path", async () => {
    primeOrchestrator(
      makeApp({ isVeteran: true, preferredLoanType: "conventional", annualIncome: "144000" }),
      { piti: 2200 },
    );

    const decision = await runInstantDecision("app-1");

    expect(decision.status).toBe("DECISION_READY");
    expect(decision.loanProgram).toBe("CONVENTIONAL");
    expect(decision.loanProgramSelection).toBe("application_selected");
    expect(decision.missingItems.join(" ")).not.toMatch(/residual income|household size|square footage/i);
  });

  it.each(["fha", "usda"])(
    "routes %s to human policy review before a conventional projection can be reused",
    async (preferredLoanType) => {
      primeOrchestrator(makeApp({ preferredLoanType, annualIncome: "144000" }), { piti: 2200 });

      const decision = await runInstantDecision("app-1");

      expect(decision.status).toBe("DECISION_READY");
      expect(decision.decision).toBe("MANUAL_REVIEW");
      expect(decision.loanProgram).toBe(preferredLoanType.toUpperCase());
      expect(decision.reasons.join(" ")).toMatch(/not automated.*loan officer/i);
      expect(decision.resolvedPolicy).toBeNull();
      expect(mocks.computeDecisionPaymentProjection).not.toHaveBeenCalled();
    },
  );

  it("routes a VA selection without a positive eligibility signal to a loan officer", async () => {
    primeOrchestrator(
      makeApp({ isVeteran: false, preferredLoanType: "va", annualIncome: "144000" }),
      { piti: 2200 },
    );

    const decision = await runInstantDecision("app-1");

    expect(decision.status).toBe("DECISION_READY");
    expect(decision.decision).toBe("MANUAL_REVIEW");
    expect(decision.loanProgram).toBe("VA");
    expect(decision.reasons.join(" ")).toMatch(/confirm VA eligibility/i);
    expect(mocks.computeDecisionPaymentProjection).not.toHaveBeenCalled();
  });
});

describe("Verified bureau inputs", () => {
  it("uses the bureau score for pricing and eligibility, and routes an unreconciled debt total to review", async () => {
    mocks.getCurrentDecisionGrade.mockResolvedValueOnce({
      isDecisionGrade: true,
      reasons: [],
      evidence: {
        financialMemoId: "memo-1",
        incomeWorkpaperId: "income-1",
        assetWorkpaperId: "assets-1",
        liabilityWorkpaperId: "liabilities-1",
        creditPullId: "credit-1",
        creditPullIsSimulated: false,
        creditPullIsCurrent: true,
        creditPullHasProviderReference: true,
        creditPullScoreIsUsable: true,
        creditPullLiabilitiesAreUsable: true,
        creditPullHasOpenLiabilities: true,
      },
      verification: { income: true, assets: true, credit: true },
      decisionCredit: {
        pullId: "credit-1",
        representativeScore: 640,
        borrowerScores: [{ borrowerSequenceNumber: 1, experianScore: 640, equifaxScore: 630, transunionScore: 650, representativeScore: 640 }],
        tradelines: [{ creditor: "Bureau debt", type: "installment", balance: 20_000, monthlyPayment: 1_000 }],
        reportedMonthlyPayments: 1_000,
        adjustedMonthlyDebt: 1_000,
        fingerprint: "b".repeat(64),
      },
    });
    primeOrchestrator(makeApp({ annualIncome: "144000", creditScore: 780 }), {
      liabilities: [{ borrowerSequenceNumber: 1, monthlyPayment: "200", toBePaidOff: false }],
      piti: 2_200,
    });

    const decision = await runInstantDecision("app-1");

    expect(mocks.computeDecisionPaymentProjection).toHaveBeenCalledWith(
      "app-1",
      "conventional",
      { creditScore: 640 },
    );
    expect(decision.qualifier).toBe("VERIFIED");
    expect(decision.decision).toBe("MANUAL_REVIEW");
    expect(decision.reasons.join(" ")).toMatch(/reconcile the difference/i);
    expect(decision.metrics).toMatchObject({
      creditScore: 640,
      creditScoreSource: "bureau_report",
      monthlyDebts: 1_000,
      monthlyDebtsSource: "bureau_reconciled",
    });
  });
});

// ===========================================================================
// PERSONA 1 — "Marcus Vale": self-employed, four K-1s, negative 2025 net
// income, $2M liquid spike in 2026.
// ===========================================================================
describe("Persona 1 — Marcus Vale (K-1 losses + $2M asset spike)", () => {
  // Two profitable K-1s (+$27,700/mo) and two loss K-1s (−$21,400 rolled-up,
  // −$12,800 itemized). True net qualifying income: −$6,500/mo.
  const valeEmployment = [
    { borrowerSequenceNumber: 1, employer: "Vale Holdings I LLC (K-1)", baseIncome: "18500" },
    { borrowerSequenceNumber: 1, employer: "Vale Holdings II LLC (K-1)", baseIncome: "9200" },
    // Accounting-format negative, rolled-up total only.
    { borrowerSequenceNumber: 1, employer: "Vale RE Partners (K-1)", totalMonthlyIncome: "(21,400)" },
    { borrowerSequenceNumber: 1, employer: "Vale Restaurant Grp (K-1)", baseIncome: "-14800", bonusIncome: "2000" },
  ];
  const valeAssets = [
    // Free-text account type with no brokerage keyword: classifyAsset buckets
    // it as CHECKING_SAVINGS, so it escapes the 60% stock haircut entirely.
    { accountType: "Cash Management Sweep", cashOrMarketValue: "2050000" },
  ];

  it("FIXED(#2): K-1 losses net against income — the negative-net file no longer auto-approves on +$27,700/mo", async () => {
    primeOrchestrator(makeApp(), {
      employment: valeEmployment,
      urlaAssets: valeAssets,
      liabilities: [{ borrowerSequenceNumber: 1, monthlyPayment: "5200", toBePaidOff: false }],
      piti: 6200,
    });
    const d = await runInstantDecision("app-1");

    // Previously: the two losses vanished (NaN-parse + `> 0` guard), income read
    // $27,700 and the file APPROVED. Now net qualifying income is -$6,500/mo, so
    // the file cannot approve — it routes to a self-employed income review.
    expect(d.decision).not.toBe("APPROVED");
    expect(d.status).toBe("NEEDS_MORE_INFO");
    expect(d.missingItems.join(" ")).toMatch(/business losses/i);
  });

  it("FIXED(#2): accounting-format losses parse and net exactly, instead of being deleted", async () => {
    // One profitable K-1 of $40,000/mo plus the same two losses. Net stays
    // positive so a decision is produced and the exact figure is checkable.
    const mixed = [
      { borrowerSequenceNumber: 1, employer: "Vale Anchor LLC (K-1)", baseIncome: "40000" },
      { borrowerSequenceNumber: 1, employer: "Vale RE Partners (K-1)", totalMonthlyIncome: "(21,400)" },
      { borrowerSequenceNumber: 1, employer: "Vale Restaurant Grp (K-1)", baseIncome: "-14800", bonusIncome: "2000" },
    ];
    primeOrchestrator(makeApp(), { employment: mixed, piti: 3000 });
    const d = await runInstantDecision("app-1");

    // base 40,000 − 21,400 − 14,800 = 3,800; variable 2,000; total 5,800.
    expect(d.status).toBe("DECISION_READY");
    expect(d.metrics!.monthlyIncome).toBe(5800);
    // Strictly below the naive positive-only sum ($42,000) the old code used.
    expect(d.metrics!.monthlyIncome).toBeLessThan(42000);
  });

  it("PIN: the $2M 'Cash Management Sweep' is still counted at 100% — no reserve haircut (open finding)", async () => {
    primeOrchestrator(makeApp({ annualIncome: "600000" }), { urlaAssets: valeAssets, piti: 4000 });
    const d = await runInstantDecision("app-1");
    // classifyAsset finds no brokerage/retirement keyword -> CHECKING_SAVINGS,
    // which the engine counts at full value (a stock/retirement haircut would
    // reduce it). Unaffected by #2; belongs to a later asset-classification fix.
    expect(d.metrics!.liquidAssets).toBe(2_050_000);
  });

  it("FIXED: the $2M Plaid inflow is flagged while an outflow is ignored", () => {
    // The Plaid adapter is the normalization boundary: negative is an inflow
    // and positive is an outflow. The decision rule must not ask a borrower to
    // source money that left the account.
    const outflow = detectSignificantDeposits(
      [{ amount: 2_000_000, date: "2026-02-11", description: "WIRE PAYMENT" }],
      27700,
    );
    expect(outflow).toHaveLength(0);

    const inflow = detectSignificantDeposits(
      [{ amount: -2_000_000, date: "2026-02-11", description: "WIRE IN" }],
      27700,
    );
    expect(inflow).toHaveLength(1);
    expect(inflow[0].amount).toBe(2_000_000);
  });

  it("FIXED: instant-decision reserves are post-closing (net of down payment), same basis as pre-underwriting", async () => {
    primeOrchestrator(makeApp({ annualIncome: "600000" }), { urlaAssets: valeAssets, piti: 6200 });
    const d = await runInstantDecision("app-1");
    // (2,050,000 - 180,000) / 6,200 = 301.6 — previously the GROSS balance was
    // divided (330.6), overstating reserves by the entire down payment.
    expect(d.metrics!.monthsOfReserves).toBeCloseTo((2_050_000 - 180_000) / 6200, 1);
    // Method parity: preUnderwriting uses the same assets-minus-down-payment
    // basis (its PITI legitimately differs — pre-lock 30yr/7% estimate vs the
    // priced PITI used above).
    const preUw = computeMonthsOfReserves({
      verifiedAssetsTotal: 2_050_000,
      purchasePrice: 900_000,
      downPayment: 180_000,
    })!;
    expect(preUw).toBeCloseTo((2_050_000 - 180_000) / estimateMonthlyPITI(900_000, 180_000), 1);
  });
});

// ===========================================================================
// PERSONA 2 — "Dana Okafor": address lookup resolves a 4-unit building; the
// application is filed as a single-family primary residence.
// ===========================================================================
describe("Persona 2 — Dana Okafor (multi-unit filed as SFR primary)", () => {
  const fourPlexFinancials = {
    baseMonthlyIncome: 15000,
    existingMonthlyDebts: 1500,
    originalLoanAmount: 666_000,
    contractSalesPrice: 740_000,
    appraisalValue: 740_000,
    representativeFico: 745,
    proposedPiti: 4800,
  } as const;

  it("FIXED(#3b): a 90% LTV 4-unit investment property is REJECTED, not approved on the SFR path", async () => {
    const result = await makeEngine().evaluate(
      baseConventionalInput({ ...fourPlexFinancials, occupancyType: "investment", numberOfUnits: 4 }),
    );
    expect(result.calculatedLtv).toBe(90);
    // Agency caps a 4-unit investment at 75% LTV — 90% is ineligible.
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.join(" ")).toMatch(/4-unit investment/);
    expect(result.rejectionReasons.join(" ")).toMatch(/75% maximum/);
    // Nothing priced on the rejected file.
    expect(result.resolvedPmiMonthlyPremium).toBe(0);
  });

  it("routes a 90% LTV 3-unit primary purchase to DU review rather than falsely rejecting it", async () => {
    const result = await makeEngine().evaluate(
      baseConventionalInput({
        occupancyType: "primary_residence",
        numberOfUnits: 3,
        originalLoanAmount: 900_000,
        contractSalesPrice: 1_000_000,
        appraisalValue: 1_000_000,
      }),
    );

    expect(result.calculatedLtv).toBe(90);
    expect(result.decision).toBe("MANUAL_REVIEW");
    expect(result.rejectionReasons).toHaveLength(0);
    expect(result.reviewReasons.join(" ")).toMatch(/75% manual-underwriting ceiling/i);
    expect(result.reviewReasons.join(" ")).toMatch(/95% Desktop Underwriter.*current DU finding/i);
    expect(result.resolvedPmiMonthlyPremium).toBe(0);
  });

  it("still rejects a 3-unit primary purchase above the 95% automated ceiling", async () => {
    const result = await makeEngine().evaluate(
      baseConventionalInput({
        occupancyType: "primary_residence",
        numberOfUnits: 3,
        originalLoanAmount: 960_000,
        contractSalesPrice: 1_000_000,
        appraisalValue: 1_000_000,
      }),
    );

    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.join(" ")).toMatch(/exceeds policy ceiling of 95%/i);
  });

  it("DEFAULT: a consistent misstatement (SFR/1-unit that is really a 4-plex) still approves without the observed descriptor", async () => {
    // Same financials, nothing declared that betrays the property: defaults to
    // 1-unit primary (95% cap), so 90% approves. #3c catches INCONSISTENT
    // declarations and (when supplied) an OBSERVED mismatch; catching a fully
    // consistent lie needs the address/AVM lookup captured at intake — still to
    // be wired.
    const result = await makeEngine().evaluate(baseConventionalInput(fourPlexFinancials));
    expect(result.decision).toBe("APPROVED");
  });

  it("FIXED(#3c): a declared single_family with 4 units is internally inconsistent -> MANUAL_REVIEW", async () => {
    // Low LTV so the occupancy cap does not reject first; the reconciliation is
    // the operative signal.
    const result = await makeEngine().evaluate(
      baseConventionalInput({ propertyType: "single_family", numberOfUnits: 4, originalLoanAmount: 500_000 }),
    );
    expect(result.decision).toBe("MANUAL_REVIEW");
    expect(result.rejectionReasons).toHaveLength(0);
    expect(result.reviewReasons.join(" ")).toMatch(/inconsistent with the declared unit count/);
  });

  it("FIXED(#3c): a declared SFR/1-unit that the lookup reports as a 4-unit multi-family -> MANUAL_REVIEW", async () => {
    const result = await makeEngine().evaluate(
      baseConventionalInput({
        propertyType: "single_family",
        numberOfUnits: 1,
        observedPropertyType: "multi_family",
        observedNumberOfUnits: 4,
        originalLoanAmount: 500_000,
      }),
    );
    expect(result.decision).toBe("MANUAL_REVIEW");
    expect(result.reviewReasons.join(" ")).toMatch(/looked-up/);
  });

  it("FIXED(#3b): the orchestrator pulls occupancy/units from URLA property info and declines the mismatch", async () => {
    primeOrchestrator(makeApp({ annualIncome: "180000" }), {
      piti: 4000,
      propertyInfo: { occupancyType: "investment", numberOfUnits: 4 },
    });
    const d = await runInstantDecision("app-1");
    // loan 720k / value 900k = 80% LTV on a 4-unit investment (75% cap).
    expect(d.status).toBe("DECISION_READY");
    expect(d.decision).toBe("REJECTED");
    expect(d.reasons.join(" ")).toMatch(/4-unit investment/);
  });

  it("PIN: an unparseable appraised value silently collapses to the contract price", async () => {
    primeOrchestrator(makeApp({ propertyValue: "TBD", annualIncome: "180000" }), { piti: 4800 });
    const d = await runInstantDecision("app-1");
    // toNumber("TBD") -> NaN -> falls back to purchasePrice, so the
    // min(contract, appraisal) LTV basis is a no-op: LTV reads exactly 80.
    expect(d.status).toBe("DECISION_READY");
    expect(d.metrics!.ltv).toBe(80);
  });

  it("FIXED: lender matching enforces property type via product.propertyTypes, not the occupancy miswiring", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../server/services/lenderMatchingEngine.ts"),
      "utf-8",
    );
    // The category-error comparison (occupancy list vs property type) is gone...
    expect(src).not.toMatch(/occupancyTypes\.includes\(activeApp\.propertyType\)/);
    // ...replaced by a real property-type eligibility check.
    expect(src).toMatch(/product\.propertyTypes/);
    expect(src).toMatch(/factor:\s*["']property_type["']/);
  });
});

// ===========================================================================
// #3c — subject-property reconciliation primitive (pure function).
// ===========================================================================
describe("reconcileSubjectProperty", () => {
  it("passes consistent declarations", () => {
    expect(reconcileSubjectProperty({ propertyType: "single_family", numberOfUnits: 1 })).toHaveLength(0);
    expect(reconcileSubjectProperty({ propertyType: "condo", numberOfUnits: 1 })).toHaveLength(0);
    expect(reconcileSubjectProperty({ propertyType: "multi_family", numberOfUnits: 3 })).toHaveLength(0);
  });

  it("flags a 1-unit type declared with multiple units", () => {
    const r = reconcileSubjectProperty({ propertyType: "single_family", numberOfUnits: 4 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatch(/inconsistent with the declared unit count/);
  });

  it("flags a multi-family declared with a single unit", () => {
    expect(reconcileSubjectProperty({ propertyType: "multi_family", numberOfUnits: 1 })).toHaveLength(1);
  });

  it("does not check when the property type does not constrain units", () => {
    expect(reconcileSubjectProperty({ propertyType: "other", numberOfUnits: 4 })).toHaveLength(0);
    expect(reconcileSubjectProperty({ numberOfUnits: 4 })).toHaveLength(0);
  });

  it("flags an observed type or unit count that diverges from the declaration", () => {
    expect(
      reconcileSubjectProperty({ propertyType: "single_family", numberOfUnits: 1, observedPropertyType: "multi_family" }).join(" "),
    ).toMatch(/looked-up property type/);
    expect(
      reconcileSubjectProperty({ propertyType: "single_family", numberOfUnits: 1, observedNumberOfUnits: 4 }).join(" "),
    ).toMatch(/looked-up unit count/);
  });

  it("passes when the observed descriptor matches the declaration (a consistent file, honest or not)", () => {
    expect(
      reconcileSubjectProperty({
        propertyType: "single_family",
        numberOfUnits: 1,
        observedPropertyType: "single_family",
        observedNumberOfUnits: 1,
      }),
    ).toHaveLength(0);
  });
});

// ===========================================================================
// PERSONA 3 — "The Boundary Surgeon": engineered to sit exactly on the 2026
// conforming edges (LTV cap, DTI fences, loan-limit seams).
// ===========================================================================
describe("Persona 3 — Boundary Surgeon (exact 2026 conforming limits)", () => {
  // Basis $840k keeps these loans under the conforming limit so the LTV
  // truncation behavior is isolated from the loan-limit rule.
  const cliffInput = (loan: number) =>
    baseConventionalInput({ originalLoanAmount: loan, contractSalesPrice: 840_000, appraisalValue: 840_000 });

  it("FIXED: eligibility compares the TRUE LTV — floor-truncation can no longer smuggle a loan past the cap", async () => {
    const engine = makeEngine();
    // True LTV 95.0099% used to floor to 95.00 and PASS the 95 cap; the
    // eligibility check now runs on the un-truncated ratio, so it is REJECTED.
    // (calculatedLtv stays 2dp-truncated for display/pricing consistency.)
    const over = await engine.evaluate(cliffInput(798_083));
    expect(over.calculatedLtv).toBe(95);
    expect(over.decision).toBe("REJECTED");
    expect(over.rejectionReasons[0]).toMatch(/exceeds policy ceiling/);

    // Control: exactly 95.0000% sits ON the inclusive cap and still approves.
    const at = await engine.evaluate(cliffInput(798_000));
    expect(at.calculatedLtv).toBe(95);
    expect(at.decision).toBe("APPROVED");
  });

  it("PIN: both DTI fences are exclusive — exactly 43.00 auto-approves, exactly 50.00 avoids rejection", async () => {
    const engine = makeEngine();
    const at43 = await engine.evaluate(baseConventionalInput({ baseMonthlyIncome: 10000, proposedPiti: 4300 }));
    expect(at43.calculatedDti).toBe(43);
    expect(at43.decision).toBe("APPROVED"); // not MANUAL_REVIEW: strict `>`

    const above43 = await engine.evaluate(baseConventionalInput({ baseMonthlyIncome: 10000, proposedPiti: 4301 }));
    expect(above43.decision).toBe("MANUAL_REVIEW");

    const at50 = await engine.evaluate(baseConventionalInput({ baseMonthlyIncome: 10000, proposedPiti: 5000 }));
    expect(at50.calculatedDti).toBe(50);
    expect(at50.decision).toBe("MANUAL_REVIEW"); // not REJECTED: strict `>`
  });

  it("FIXED(#1): LTV above the cap resolves to a clean REJECTED instead of crashing the PMI lookup", async () => {
    // Previously: Step 3 queued the "exceeds ceiling" reason, then evaluation
    // continued into the PMI matrix (top band 97.00) and threw, discarding the
    // rejection. Now pricing is skipped for an over-cap loan and the rejection
    // survives.
    const result = await makeEngine().evaluate(baseConventionalInput({ originalLoanAmount: 980_000 }));
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons[0]).toMatch(/exceeds policy ceiling/);
  });

  it("FIXED(#3): a loan above the conforming limit routes to MANUAL_REVIEW, not an auto-approve", async () => {
    const result = await makeEngine().evaluate(baseConventionalInput({
      originalLoanAmount: 2_900_000, // 3.6x the 2026 one-unit limit
      contractSalesPrice: 4_000_000,
      appraisalValue: 4_000_000,
      proposedPiti: 19_000,
      baseMonthlyIncome: 90_000,
    }));
    // Not a credit decline (a jumbo product may fit) and not a conforming
    // approval it isn't — it goes to the jumbo desk.
    expect(result.decision).toBe("MANUAL_REVIEW");
    expect(result.decision).not.toBe("APPROVED");
  });

  it("FIXED(#3): the codebase agrees on ONE conforming limit (borrowerGraph no longer uses the 2024 value)", () => {
    const graphSrc = fs.readFileSync(path.resolve(__dirname, "../server/services/borrowerGraph.ts"), "utf-8");
    const seedSrc = fs.readFileSync(path.resolve(__dirname, "../server/seedMarketPricing.ts"), "utf-8");
    // Shared constant is the single source of truth, and the rate sheets agree —
    // by IMPORTING it, not by spelling the same number a second time. (This used
    // to regex a numeric literal out of the seed file, which is why re-spelling
    // the limit there read as agreement rather than as duplication.)
    expect(CONFORMING_LOAN_LIMIT_2026).toBe(806_500);
    expect(seedSrc).toMatch(/const CONFORMING_LIMIT = CONFORMING_LOAN_LIMIT_2026;/);
    expect(seedSrc).toMatch(/from "@shared\/lendingLimits"/);
    // The stale 2024 literal (766550) is gone; the borrower graph references the
    // shared constant instead.
    expect(graphSrc).not.toMatch(/766550/);
    expect(graphSrc).toMatch(/CONFORMING_LOAN_LIMIT_2026/);
  });

  // Drop `//` line comments and `/* */` block fragments so a source sweep grades
  // code, never prose. Deliberately conservative: it does not parse strings, which
  // for numeric-literal checks errs toward reporting, not toward silence.
  const stripComment = (line: string) =>
    line.replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "");

  it("no stale conforming literal survives ANYWHERE — the two-file check above could not see the funnel", () => {
    // Why this exists: the assertion above named borrowerGraph and seedMarketPricing
    // explicitly, so it enforced "one conforming limit" across exactly two files.
    // client/src/pages/lending/preApproval/AdvisoryPanel.tsx held `loanAmount > 766550`
    // for the whole life of that test and stayed green — the funnel told borrowers
    // between $766,500 and $806,500 that a CONFORMING loan was jumbo. A guard that
    // names its files can only ever be as wide as the day it was written, so this
    // one sweeps the tree instead.
    const root = path.resolve(__dirname, "..");
    const roots = ["client/src", "server", "shared"];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const src = fs.readFileSync(full, "utf-8");
        src.split("\n").forEach((line, i) => {
          // Strip comments first. A guard that matches inside a comment flags its
          // own explanation and teaches the next person to widen the allowlist —
          // this repo has already shipped that mistake once (design-token-guard).
          const code = stripComment(line);
          // Any 2024/2025-era conforming literal, however spelled.
          if (/\b766[_,]?550\b/.test(code)) {
            offenders.push(`${path.relative(root, full)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    };
    for (const r of roots) walk(path.join(root, r));

    expect(offenders, `stale conforming limit still hardcoded:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("every consumer of the conforming boundary reads the shared constant", () => {
    // The companion to the sweep above: absence of the stale number is necessary
    // but not sufficient — a file could hardcode the CURRENT limit and be wrong
    // again the day it changes. Any file that compares against the boundary must
    // import it rather than spell it.
    const root = path.resolve(__dirname, "..");
    const roots = ["client/src", "server", "shared"];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        // The constant's own home is allowed to spell it.
        if (path.relative(root, full) === "shared/lendingLimits.ts") continue;
        const src = fs.readFileSync(full, "utf-8");
        src.split("\n").forEach((line, i) => {
          const code = stripComment(line);
          if (/\b806[_,]?500\b/.test(code) && !/CONFORMING_LOAN_LIMIT_2026/.test(code)) {
            // A test asserting the constant's VALUE is legitimate; product code
            // spelling the number is not.
            offenders.push(`${path.relative(root, full)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    };
    for (const r of roots) walk(path.join(root, r));

    expect(offenders, `conforming limit hardcoded instead of imported:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("FIXED: no dead zone between conforming max and jumbo min (cent-continuous at $806,500)", () => {
    const seedSrc = fs.readFileSync(path.resolve(__dirname, "../server/seedMarketPricing.ts"), "utf-8");
    const conformingMax = CONFORMING_LOAN_LIMIT_2026;
    // Jumbo eligibility is now CONFORMING_LIMIT + one cent — "jumbo" means any
    // amount OVER the limit. The old +1 (whole dollar) left the open interval
    // (806500, 806501) unpriceable by every product in the market.
    expect(seedSrc).not.toMatch(/minLoanAmount: CONFORMING_LIMIT \+ 1\b/);
    expect(seedSrc).toMatch(/minLoanAmount: CONFORMING_LIMIT \+ 0\.01/);
    const jumboMin = conformingMax + 0.01;
    // Every cent-granular amount is covered by exactly one side of the boundary.
    for (const amount of [conformingMax, conformingMax + 0.01, conformingMax + 0.5, conformingMax + 1]) {
      const covered = amount <= conformingMax || amount >= jumboMin;
      expect(covered).toBe(true);
    }
  });
});

// ===========================================================================
// PERSONA 4 — "The Thin-File Physician": FICO 612, 10% down, high income.
// ===========================================================================
describe("Persona 4 — Thin-File Physician (FICO 612 @ 90% LTV)", () => {
  const physicianInput = baseConventionalInput({
    baseMonthlyIncome: 32_500,
    existingMonthlyDebts: 800,
    originalLoanAmount: 450_000,
    contractSalesPrice: 500_000,
    appraisalValue: 500_000,
    representativeFico: 612,
    proposedPiti: 3_000,
  });

  it("FIXED(#4): sub-620 FICO declines with a credit-score reason instead of crashing the PMI matrix", async () => {
    // The FICO-floor guard runs before any lookup, so a decline-worthy file is
    // REJECTED with a specific reason rather than missing a PMI cell.
    const result = await makeEngine().evaluate(physicianInput);
    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.join(" ")).toMatch(/credit score/i);
    // Nothing was priced on the rejected file.
    expect(result.resolvedPmiMonthlyPremium).toBe(0);
    expect(result.resolvedLlpafUpfrontFee).toBe(0);
  });

  it("FIXED(#4): the orchestrator returns a clean adverse-action-grade REJECTED, no internal leak", async () => {
    primeOrchestrator(
      makeApp({ creditScore: 612, purchasePrice: "500000", downPayment: "50000", propertyValue: "500000", annualIncome: "390000", monthlyDebts: "800" }),
      { piti: 3000 },
    );
    const d = await runInstantDecision("app-1");
    // Was NEEDS_MORE_INFO leaking "CRITICAL DECISIONING ERROR" (pre-#1), then a
    // generic MANUAL_REVIEW (post-#1). Now it is a specific credit decline.
    expect(d.status).toBe("DECISION_READY");
    expect(d.decision).toBe("REJECTED");
    expect(d.reasons.join(" ")).toMatch(/credit score/i);
    expect(JSON.stringify(d)).not.toMatch(/CRITICAL/);
  });

  it("FIXED(#1): a genuinely uncovered profile (FICO 851) routes to MANUAL_REVIEW, not a crash or a loop", async () => {
    // 851 clears the floor but exceeds the score-grid ceiling (850): a real
    // matrix gap the automated engine cannot price, so it goes to a human
    // (POLICY_OUT_OF_BAND) instead of throwing or looping for documents.
    primeOrchestrator(
      makeApp({ creditScore: 851, purchasePrice: "800000", downPayment: "50000", propertyValue: "800000", annualIncome: "600000" }),
      { piti: 4000 },
    );
    const d = await runInstantDecision("app-1");
    expect(d.status).toBe("DECISION_READY");
    expect(d.decision).toBe("MANUAL_REVIEW");
    expect(JSON.stringify(d)).not.toMatch(/CRITICAL/);
  });

  it("PIN: FICO 851 exceeds the score-grid ceiling at the engine level (out-of-band, open finding)", async () => {
    // The engine still throws for a >850 score; the orchestrator (above) turns
    // that into MANUAL_REVIEW. A dedicated FICO-range validity check is a
    // separate, later concern.
    await expect(
      makeEngine().evaluate(baseConventionalInput({ representativeFico: 851, originalLoanAmount: 750_000 })),
    ).rejects.toThrow(/CRITICAL DECISIONING ERROR/);
  });
});

// ===========================================================================
// PERSONA 5 — "The Reyes Family": VA-eligible, family of six, boundary loan.
// ===========================================================================
describe("Persona 5 — Reyes family (VA, family of 6, $79,999.50 loan)", () => {
  const reyesBase: Partial<UnderwritingInput> = {
    requestedLoanProgram: "VA",
    isVeteran: true,
    baseMonthlyIncome: 12_000,
    bonusMonthlyIncome: 0,
    existingMonthlyDebts: 500,
    originalLoanAmount: 300_000,
    contractSalesPrice: 375_000,
    appraisalValue: 375_000,
    representativeFico: 700,
    proposedPiti: 2_200,
    subjectPropertyState: "TX",
    homeSquareFootage: 2_800,
  };

  it("FIXED(#1+#3): a VA file missing residual inputs asks for them by name with borrower-safe copy", async () => {
    primeOrchestrator(makeApp({ isVeteran: true, preferredLoanType: "va", annualIncome: "144000" }), { piti: 2200 });
    const d = await runInstantDecision("app-1");
    // Fix #1 reclassified the VA-protocol throw as INPUT_INCOMPLETE (no raw
    // "CRITICAL VA PROTOCOL ERROR" leak); fix #3 plumbs family size / square
    // footage from intake, so the orchestrator now names the exact missing
    // inputs up front instead of dead-ending inside the engine.
    expect(d.status).toBe("NEEDS_MORE_INFO");
    expect(JSON.stringify(d)).not.toMatch(/CRITICAL/);
    expect(d.missingItems.join(" ")).toMatch(/household size/i);
    expect(d.missingItems.join(" ")).toMatch(/square footage/i);
  });

  it("FIXED(#3): a VA application with its intake fields collected reaches a decision end-to-end", async () => {
    // householdFamilySize / homeSquareFootage are now real intake columns
    // (schema-required for veterans), so a complete VA file flows through the
    // orchestrator to a decision instead of dead-ending.
    primeOrchestrator(
      makeApp({ isVeteran: true, preferredLoanType: "va", annualIncome: "144000", householdFamilySize: 4, homeSquareFootage: 2800 }),
      { piti: 2200 },
    );
    const d = await runInstantDecision("app-1");
    expect(d.status).toBe("DECISION_READY");
    expect(d.decision).toBe("APPROVED");
  });

  it("FIXED: family size 6 uses the size-5 baseline + $80/member (Pamphlet 26-7), not a matrix crash", async () => {
    const result = await makeEngine().evaluate(
      { ...baseConventionalInput(), ...reyesBase, householdFamilySize: 6 } as UnderwritingInput,
    );
    // SOUTH size-5 baseline 1039 + 80 for the sixth member.
    expect(result.requiredResidualIncome).toBe(1119);
    expect(result.decision).toBe("APPROVED");
    expect(result.resolvedPolicy).toMatchObject({
      vaResidualExtraMember: 80,
      vaResidualTaxRate: 0.22,
      vaUtilityRatePerSqft: 0.14,
      vaDtiCushionTriggerPct: 41,
      vaCushionMultiplier: 1.2,
      vaResidualReductionFactor: 0.95,
    });
  });

  it("FIXED: a $79,999.50 loan resolves in the low band — the $1 gap between VA loan bands is closed", async () => {
    const result = await makeEngine().evaluate({
      ...baseConventionalInput(), ...reyesBase,
      householdFamilySize: 3, originalLoanAmount: 79_999.5,
    } as UnderwritingInput);
    // Low band (< $80k), SOUTH, size 3.
    expect(result.requiredResidualIncome).toBe(772);
    expect(result.decision).toBe("APPROVED");
  });

  it("CONTROL: the same family qualifies cleanly one band edge higher ($80,000)", async () => {
    const result = await makeEngine().evaluate({
      ...baseConventionalInput(), ...reyesBase,
      householdFamilySize: 3, originalLoanAmount: 80_000,
    } as UnderwritingInput);
    expect(result.decision).toBe("APPROVED");
    expect(result.requiredResidualIncome).toBe(889); // SOUTH, size 3
  });

  it("PIN: the two VA region resolvers disagree on malformed state input", async () => {
    // The engine throws on a spelled-out state; the nuance module silently
    // defaults the same input to "south". Same fact, two behaviors.
    await expect(
      makeEngine().evaluate({
        ...baseConventionalInput(), ...reyesBase,
        householdFamilySize: 3, subjectPropertyState: "Texas",
      } as UnderwritingInput),
    ).rejects.toThrow(/CRITICAL COMPLIANCE ERROR.*Texas/);
    expect(vaRegionForState("Texas")).toBe("south");
  });
});
