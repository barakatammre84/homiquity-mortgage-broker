import { describe, it, expect, vi } from "vitest";

const policyScalarCalls = vi.hoisted(() => [] as string[]);

// ---------------------------------------------------------------------------
// The DTI helper and the deterministic engine both resolve policy scalars from
// LookupResolverService, which transitively needs a live Postgres connection.
// Mock the resolver so these edge-case tests are hermetic. Values mirror the
// seeded conventional grid (percent-denominated scalars).
// ---------------------------------------------------------------------------
vi.mock("../server/services/lookupResolver", () => ({
  lookupResolver: {
    getPolicyScalar: async (code: string) => {
      policyScalarCalls.push(code);
      const scalars: Record<string, number> = {
        CONVENTIONAL_DTI_CAP: 43,
        CONVENTIONAL_STRETCH_DTI: 50,
        CONVENTIONAL_LTV_CAP: 97,
        CONVENTIONAL_FICO_FLOOR: 620,
        CONFORMING_LOAN_LIMIT: 806500,
        HAIRCUT_STOCK_INVESTMENT: 70,
        HAIRCUT_RETIREMENT: 60,
      };
      return scalars[code];
    },
    // Occupancy max-LTV mirrors the cap above; PMI/LLPA rates are 0 so pricing
    // does not affect the value-guard assertions.
    resolveMatrixValue: async (query: { matrixCode?: string }) => {
      if (query?.matrixCode === "CONVENTIONAL_MAX_LTV") return 97;
      if (query?.matrixCode === "CONVENTIONAL_PMI") return 0.9;
      if (query?.matrixCode === "FANNIE_LLPA") return 0.5;
      return 0;
    },
  },
}));

import { calculateDTI } from "../server/underwriting";
import { ConsolidatedUnderwritingEngine, UnderwritingError, type UnderwritingInput } from "../server/underwritingEngine";

describe("calculateDTI edge cases", () => {
  it("fails on zero qualifying income (no silent 0% pass)", async () => {
    const result = await calculateDTI(0, 1500, 500);
    expect(result.status).toBe("fail");
  });

  it("fails on negative qualifying income", async () => {
    const result = await calculateDTI(-5000, 1500, 500);
    expect(result.status).toBe("fail");
  });

  it("passes a comfortable ratio", async () => {
    const result = await calculateDTI(10000, 2000, 500);
    expect(result.backEndRatio).toBe(25);
    expect(result.status).toBe("pass");
  });

  it("fails an over-cap ratio", async () => {
    const result = await calculateDTI(3000, 2000, 500);
    expect(result.status).toBe("fail");
  });
});

describe("ConsolidatedUnderwritingEngine value guards", () => {
  const engine = new ConsolidatedUnderwritingEngine();

  const baseInput: UnderwritingInput = {
    requestedLoanProgram: "CONVENTIONAL",
    isVeteran: false,
    baseMonthlyIncome: 10000,
    bonusMonthlyIncome: 0,
    existingMonthlyDebts: 500,
    originalLoanAmount: 320000,
    contractSalesPrice: 400000,
    appraisalValue: 400000,
    representativeFico: 740,
    proposedPiti: 2000,
    assets: [],
  };

  it("throws a typed INPUT_INVALID when the loan amount is zero (down payment >= price)", async () => {
    // Must be an UnderwritingError, not a bare Error: the orchestrator's
    // engine-catch rethrows untyped errors as system faults (500), so a raw
    // throw here would turn a borrower input problem into a server error for
    // any direct engine caller.
    const err = await engine.evaluate({ ...baseInput, originalLoanAmount: 0 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnderwritingError);
    expect((err as UnderwritingError).kind).toBe("INPUT_INVALID");
    expect((err as UnderwritingError).message).toMatch(/Loan amount must be greater than zero/i);
    expect((err as UnderwritingError).publicMessage).toMatch(/down payment must be less than the purchase price/i);
  });

  it("throws a typed INPUT_INVALID when the loan amount is negative", async () => {
    const err = await engine.evaluate({ ...baseInput, originalLoanAmount: -100 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnderwritingError);
    expect((err as UnderwritingError).kind).toBe("INPUT_INVALID");
    expect((err as UnderwritingError).message).toMatch(/Loan amount must be greater than zero/i);
  });

  it("still approves a well-qualified conventional file", async () => {
    const result = await engine.evaluate(baseInput);
    expect(result.decision).toBe("APPROVED");
    expect(result.loanType).toBe("CONVENTIONAL");
    expect(result.calculatedLtv).toBe(80);
    expect(result.resolvedPolicy).toMatchObject({
      conventionalFicoFloor: 620,
      conformingLoanLimit: 806500,
      conventionalOccupancyMaxLtvPct: 97,
    });
    expect(result.resolvedPolicy.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not switch a veteran's requested conventional loan to VA", async () => {
    const result = await engine.evaluate({ ...baseInput, isVeteran: true });
    expect(result.decision).toBe("APPROVED");
    expect(result.loanType).toBe("CONVENTIONAL");
    expect(result.actualResidualIncome).toBeUndefined();
  });

  it("keeps PMI in the payment facts when DTI rejects an otherwise priceable file", async () => {
    const result = await engine.evaluate({
      ...baseInput,
      originalLoanAmount: 360000,
      proposedPiti: 5500,
    });

    expect(result.decision).toBe("REJECTED");
    expect(result.rejectionReasons.join(" ")).toMatch(/Debt-to-Income/i);
    expect(result.resolvedPmiMonthlyPremium).toBeCloseTo(270, 8);
    expect(result.resolvedPolicy.pmiRatePct).toBe(0.9);
  });

  it.each(["FHA", "USDA", "JUMBO", "ARM"] as const)(
    "refuses to apply conventional policy to an unsupported %s program",
    async (requestedLoanProgram) => {
      const err = await engine.evaluate({ ...baseInput, requestedLoanProgram }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UnderwritingError);
      expect((err as UnderwritingError).kind).toBe("POLICY_UNSUPPORTED");
      expect((err as UnderwritingError).publicMessage).toMatch(/not automated.*loan officer/i);
    },
  );

  it("requires a human eligibility check when VA is selected without a veteran signal", async () => {
    const err = await engine.evaluate({ ...baseInput, requestedLoanProgram: "VA" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnderwritingError);
    expect((err as UnderwritingError).kind).toBe("POLICY_OUT_OF_BAND");
    expect((err as UnderwritingError).publicMessage).toMatch(/confirm VA eligibility/i);
  });

  it("evaluates VA without reading unrelated conventional policy rows", async () => {
    const callStart = policyScalarCalls.length;
    const result = await engine.evaluate({
      ...baseInput,
      requestedLoanProgram: "VA",
      isVeteran: true,
      subjectPropertyState: "IL",
      householdFamilySize: 2,
      homeSquareFootage: 1600,
    });
    const calls = policyScalarCalls.slice(callStart);

    expect(calls).toEqual([
      "HAIRCUT_STOCK_INVESTMENT",
      "HAIRCUT_RETIREMENT",
    ]);
    expect(result.resolvedPolicy.conventionalDtiCapPct).toBeUndefined();
    expect(result.resolvedPolicy.conventionalStretchDtiPct).toBeUndefined();
    expect(result.resolvedPolicy.conventionalLtvCapPct).toBeUndefined();
  });

  it.each([
    ["refinance", { loanPurpose: "refinance" }],
    ["adjustable", { amortizationType: "adjustable" }],
  ] as const)("routes a VA %s outside the automated purchase/fixed scope", async (_label, overrides) => {
    const result = await engine.evaluate({
      ...baseInput,
      ...overrides,
      requestedLoanProgram: "VA",
      isVeteran: true,
      subjectPropertyState: "IL",
      householdFamilySize: 2,
      homeSquareFootage: 1600,
    });

    expect(result.decision).toBe("MANUAL_REVIEW");
    expect(result.reviewReasons.join(" ")).toMatch(/review|not automated/i);
  });
});
