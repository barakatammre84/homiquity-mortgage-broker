import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// VA residual income: the LIVE engine must agree with the CITED reference.
//
// Why this file exists (F-014). `tests/complianceInvariants.test.ts` guards the
// VA residual math by reading source text: it asserts the engine mentions
// RESIDUAL_TAX_RATE / VA_RESIDUAL_REDUCTION_FACTOR / VA_EXTRA_MEMBER_FAMILY_CAP
// and does not contain `* 0.18` or `* 0.95`. That is a ban-list, and a ban-list
// only bans the literals someone already thought of. It demonstrably missed
// three others that were live in the engine until 2026-08-12:
//
//     input.homeSquareFootage * 0.14        (should be VA_UTILITY_RATE_PER_SQFT)
//     requiredResidualIncome * 1.2          (should be VA_CUSHION_MULTIPLIER)
//     calculatedDti > 41.0                  (should be VA_DTI_CUSHION_TRIGGER)
//
// The source-grep guard was green the whole time. This is the F-014 thesis in
// one concrete case: a compliance test that passes on wrong logic.
//
// The structural fix is not a longer ban-list — it is to stop asserting about
// TEXT and start asserting about RESULTS. `underwritingNuance.computeVaResidualIncome`
// is the cited reference implementation (VA Pamphlet 26-7 Ch. 4), covered by 27
// behavioral tests in underwritingNuance.test.ts against the handbook's own
// worked examples. The engine reimplements the same arithmetic inline because it
// resolves its baseline from the policy grid rather than the in-module table.
// Two implementations of one regulated calculation is a standing drift risk —
// the 2026-07-04 incident recorded in complianceInvariants.test.ts was exactly
// that, and it recurred. So: run both over a scenario matrix and require them to
// agree on the numbers a borrower is judged by.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. The resolver is stubbed to serve the
// reference module's own table, so this pins FORMULA parity — operator order,
// which figure the cushion multiplies, the family-size clamp, the deductions.
// It deliberately cannot prove the seeded production VA_RESIDUAL grid matches
// VA_RESIDUAL_MATRIX; that is a data question against a live database, and
// asserting it here against a stub would be theatre. Named in FINDINGS.md as the
// residual gap rather than papered over.
// ---------------------------------------------------------------------------

import {
  VA_CUSHION_MULTIPLIER,
  VA_EXTRA_MEMBER_ADDITION,
  VA_RESIDUAL_MATRIX,
  VA_RESIDUAL_REDUCTION_FACTOR,
  VA_UTILITY_RATE_PER_SQFT,
  computeVaResidualIncome,
  vaRegionForState,
  type VaRegion,
} from "../server/services/underwritingNuance";

// The engine asks the policy grid for the family-size baseline. Serve it the
// reference module's table so any disagreement is FORMULA drift, never a
// different input. Percent-denominated conventional scalars mirror
// underwritingEdgeCases.test.ts so the non-VA guards stay out of the way.
vi.mock("../server/services/lookupResolver", () => ({
  lookupResolver: {
    getPolicyScalar: async (code: string) => {
      const scalars: Record<string, number> = {
        CONVENTIONAL_DTI_CAP: 43,
        CONVENTIONAL_STRETCH_DTI: 50,
        CONVENTIONAL_LTV_CAP: 97,
        CONVENTIONAL_FICO_FLOOR: 620,
        CONFORMING_LOAN_LIMIT: 806500,
        VA_RESIDUAL_EXTRA_MEMBER: VA_EXTRA_MEMBER_ADDITION,
      };
      return scalars[code];
    },
    resolveMatrixValue: async (query: { matrixCode?: string; dim1Value?: number; dim3Identifier?: string }) => {
      if (query?.matrixCode === "VA_RESIDUAL") {
        // The engine names regions in UPPER case, the reference module in lower —
        // they are two separate state→region maps (see the parity test below).
        const region = String(query.dim3Identifier ?? "south").toLowerCase() as VaRegion;
        const size = Math.min(Math.max(1, Number(query.dim1Value ?? 1)), 5);
        return VA_RESIDUAL_MATRIX[region][size];
      }
      if (query?.matrixCode === "CONVENTIONAL_MAX_LTV") return 97;
      return 0;
    },
  },
}));

import { ConsolidatedUnderwritingEngine, type UnderwritingInput } from "../server/underwritingEngine";

interface Scenario {
  name: string;
  state: string;
  familySize: number;
  sqft: number;
  baseMonthlyIncome: number;
  existingMonthlyDebts: number;
  proposedPiti: number;
  isActiveDuty?: boolean;
  hasExchangeAccess?: boolean;
}

// Chosen to exercise every branch that differs between the two code paths:
// both sides of the DTI cushion, the Item 43 reduction via each of its two
// disjunctive triggers, the family-of-5 boundary, and the family-of-7 clamp.
const SCENARIOS: Scenario[] = [
  { name: "south, family 4, comfortable, low DTI", state: "TX", familySize: 4, sqft: 2000, baseMonthlyIncome: 9000, existingMonthlyDebts: 300, proposedPiti: 1800 },
  { name: "south, family 4, high DTI → cushion applies", state: "TX", familySize: 4, sqft: 2500, baseMonthlyIncome: 6000, existingMonthlyDebts: 900, proposedPiti: 1900 },
  { name: "northeast, family 1, thin margin", state: "NY", familySize: 1, sqft: 1100, baseMonthlyIncome: 4200, existingMonthlyDebts: 250, proposedPiti: 1300 },
  { name: "west, family 5 — the table boundary", state: "CA", familySize: 5, sqft: 2200, baseMonthlyIncome: 11000, existingMonthlyDebts: 600, proposedPiti: 2600 },
  { name: "midwest, family 6 — one extra member", state: "IL", familySize: 6, sqft: 2400, baseMonthlyIncome: 9500, existingMonthlyDebts: 500, proposedPiti: 2100 },
  { name: "midwest, family 9 — clamped at seven", state: "OH", familySize: 9, sqft: 3000, baseMonthlyIncome: 12000, existingMonthlyDebts: 700, proposedPiti: 2400 },
  { name: "Item 43 reduction via active duty", state: "GA", familySize: 3, sqft: 1800, baseMonthlyIncome: 7000, existingMonthlyDebts: 400, proposedPiti: 1750, isActiveDuty: true },
  { name: "Item 43 reduction via facility benefits (disjunctive)", state: "GA", familySize: 3, sqft: 1800, baseMonthlyIncome: 7000, existingMonthlyDebts: 400, proposedPiti: 1750, hasExchangeAccess: true },
  { name: "reduction AND cushion stacked", state: "VA", familySize: 4, sqft: 2600, baseMonthlyIncome: 5800, existingMonthlyDebts: 950, proposedPiti: 1850, isActiveDuty: true },

  // The two below are CUSHION-DECISIVE, and they exist because mutation testing
  // proved the scenarios above were not enough. The engine reports
  // requiredResidualIncome PRE-cushion, so mutating the cushion trigger or the
  // multiplier leaves that number untouched — the change is only observable when
  // the cushion alone decides pass/fail. Both sit in the narrow band where it
  // does; without them, a 1.2→1.3 multiplier and a 41%→45% trigger both passed
  // the whole suite. Figures are tight (residual within ~2% of the boundary), so
  // do not "tidy" these numbers.
  //
  // south/family-3 guideline is $889. Cushioned requirement is $1,066.80.
  // residual $908: clears the bare guideline, fails the cushioned one — so a
  // trigger that stops firing at 42% DTI flips this file to a pass.
  { name: "cushion TRIGGER decisive — 42% DTI, residual between guideline and cushion", state: "TX", familySize: 3, sqft: 1600, baseMonthlyIncome: 3150, existingMonthlyDebts: 100, proposedPiti: 1225 },
  // residual $1,084: clears 1.2× ($1,066.80) but not 1.3× ($1,155.70) — so any
  // upward drift in the multiplier flips this file to a fail.
  { name: "cushion MULTIPLIER decisive — residual just above the 1.2x requirement", state: "TX", familySize: 3, sqft: 1600, baseMonthlyIncome: 3600, existingMonthlyDebts: 100, proposedPiti: 1400 },

  // The BOUNDARY case, added with the 2026-08-20 de-fork: DTI of exactly
  // 41.00% does NOT trigger the cushion — the handbook's rule is "greater
  // than 41%". The engine's trigger is now the shared FRACTION constant ×100
  // (0.41 × 100 === 41 exactly in IEEE 754, so the unit conversion cannot move
  // the boundary), and this scenario is what proves that: obligations
  // ($100 + $1,130) / $3,000 income is 41.00% on the nose, and residual $900
  // sits between the bare guideline ($889) and the cushioned one ($1,066.80).
  // An engine that fires the cushion AT the boundary (>= drift, or a
  // conversion that lands the threshold a hair low) fails this file while the
  // reference passes it. Figures are exact — do not "tidy" them.
  { name: "cushion boundary — exactly 41.00% DTI stays uncushioned", state: "TX", familySize: 3, sqft: 1500, baseMonthlyIncome: 3000, existingMonthlyDebts: 100, proposedPiti: 1130 },
];

function engineInput(s: Scenario): UnderwritingInput {
  return {
    requestedLoanProgram: "VA",
    isVeteran: true,
    isActiveDuty: s.isActiveDuty ?? false,
    hasExchangeAccess: s.hasExchangeAccess ?? false,
    baseMonthlyIncome: s.baseMonthlyIncome,
    bonusMonthlyIncome: 0,
    existingMonthlyDebts: s.existingMonthlyDebts,
    originalLoanAmount: 320000,
    contractSalesPrice: 400000,
    appraisalValue: 400000,
    representativeFico: 740,
    proposedPiti: s.proposedPiti,
    assets: [],
    homeSquareFootage: s.sqft,
    subjectPropertyState: s.state,
    householdFamilySize: s.familySize,
  };
}

function reference(s: Scenario) {
  const gross = s.baseMonthlyIncome;
  // The engine's DTI is a percentage; the reference takes a fraction.
  const dtiFraction = (s.existingMonthlyDebts + s.proposedPiti) / gross;
  return computeVaResidualIncome({
    grossMonthlyIncome: gross,
    proposedPiti: s.proposedPiti,
    monthlyDebts: s.existingMonthlyDebts,
    homeSquareFeet: s.sqft,
    state: s.state,
    familySize: s.familySize,
    dti: dtiFraction,
    qualifiesForResidualReduction: Boolean(s.isActiveDuty || s.hasExchangeAccess),
  });
}

// The engine exposes the figures structurally, so nothing here parses prose.
//
// ONE SEMANTIC DIFFERENCE, made explicit rather than hidden in a fudge factor:
// the engine's `requiredResidualIncome` is the guideline AFTER the Item 43
// reduction but BEFORE the >41%-DTI cushion (it applies the cushion inline when
// it compares). The reference module folds the cushion into `requiredResidual`.
// Comparing the two raw would fail on every high-DTI file for a reason that is
// not drift, so the cushion is applied here to bring them to the same meaning.
function engineRequiredComparable(
  requiredResidualIncome: number,
  cushionApplied: boolean,
): number {
  return cushionApplied ? requiredResidualIncome * VA_CUSHION_MULTIPLIER : requiredResidualIncome;
}

const engine = new ConsolidatedUnderwritingEngine();

describe("VA residual: live engine agrees with the cited reference module", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    "%s — engine and reference reach the same pass/fail",
    async (_name, scenario) => {
      const ref = reference(scenario);
      const result = await engine.evaluate(engineInput(scenario));
      const residualReasons = result.rejectionReasons.filter((r) => /residual/i.test(r));

      if (ref.passes) {
        expect(
          residualReasons,
          `reference says residual PASSES (actual $${ref.residualIncome} >= required $${ref.requiredResidual}) ` +
            `but the engine raised a residual objection — the two implementations have drifted`,
        ).toEqual([]);
      } else {
        expect(
          residualReasons.length,
          `reference says residual FAILS (actual $${ref.residualIncome} < required $${ref.requiredResidual}) ` +
            `but the engine raised no residual objection — a borrower short on residual would pass`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    "%s — engine and reference compute the same residual figures",
    async (_name, scenario) => {
      const ref = reference(scenario);
      const result = await engine.evaluate(engineInput(scenario));

      expect(result.actualResidualIncome, "engine reported no residual figure on a VA file").toBeDefined();
      expect(result.requiredResidualIncome, "engine reported no required residual on a VA file").toBeDefined();

      expect(
        result.actualResidualIncome!,
        "actual residual income diverged from the cited reference",
      ).toBeCloseTo(ref.residualIncome, 2);

      expect(
        engineRequiredComparable(result.requiredResidualIncome!, ref.cushionApplied),
        "required residual diverged from the cited reference",
      ).toBeCloseTo(ref.requiredResidual, 2);
    },
  );
});

describe("VA residual: the constants are genuinely shared, proven by behavior", () => {
  // These replace the ban-list greps. Each perturbs ONE input and requires the
  // engine's own reported figures to move by the amount the shared constant
  // dictates. A forked literal that happens to equal the constant today passes
  // here, but diverges the moment the constant is changed in one place — which
  // is exactly the property a text search could never provide.

  const figures = async (s: Scenario) => {
    const r = await engine.evaluate(engineInput(s));
    return { actual: r.actualResidualIncome, required: r.requiredResidualIncome };
  };

  it("utility deduction tracks VA_UTILITY_RATE_PER_SQFT — not a local 0.14", async () => {
    const small = { ...SCENARIOS[1], sqft: 2000 };
    const large = { ...SCENARIOS[1], sqft: 3000 };
    const refDelta = reference(small).residualIncome - reference(large).residualIncome;

    const [a, b] = await Promise.all([figures(small), figures(large)]);
    expect(a.actual).toBeDefined();
    expect(b.actual).toBeDefined();
    // 1000 extra sqft must cost exactly 1000 x the shared rate.
    expect(a.actual! - b.actual!).toBeCloseTo(refDelta, 2);
    expect(a.actual! - b.actual!).toBeCloseTo(1000 * VA_UTILITY_RATE_PER_SQFT, 2);
  });

  it("the Item 43 reduction is disjunctive — either trigger alone lowers the requirement", async () => {
    const neither = { ...SCENARIOS[8], isActiveDuty: false, hasExchangeAccess: false };
    const dutyOnly = { ...SCENARIOS[8], isActiveDuty: true, hasExchangeAccess: false };
    const exchangeOnly = { ...SCENARIOS[8], isActiveDuty: false, hasExchangeAccess: true };

    const [base, duty, exchange] = await Promise.all([
      figures(neither), figures(dutyOnly), figures(exchangeOnly),
    ]);

    expect(base.required).toBeDefined();
    // Each trigger ALONE must reduce the requirement, and both must reduce it
    // identically — an && gate (the bug fixed 2026-07-04) leaves these at base.
    expect(duty.required!).toBeLessThan(base.required!);
    expect(exchange.required!).toBeLessThan(base.required!);
    expect(duty.required!).toBeCloseTo(exchange.required!, 2);
    // And the reduction is exactly the shared factor, not some other discount.
    expect(duty.required!).toBeCloseTo(base.required! * VA_RESIDUAL_REDUCTION_FACTOR, 2);
  });

  it("members beyond a family of seven do not raise the requirement (26-7 Ch.4 Item 43 clamp)", async () => {
    const req = async (familySize: number) =>
      (await figures({ ...SCENARIOS[5], familySize })).required;

    const [six, seven, nine] = await Promise.all([req(6), req(7), req(9)]);
    expect(seven).toBeDefined();
    expect(nine).toBeCloseTo(seven!, 2);
    // The clamp is real, not "every family size is equal": six must be lower,
    // by exactly one member's addition.
    expect(six!).toBeLessThan(seven!);
    expect(seven! - six!).toBeCloseTo(VA_EXTRA_MEMBER_ADDITION, 2);
  });
});

describe("VA residual: the two state to region maps agree", () => {
  // The engine carries its OWN state to region lists, separate from
  // STATE_TO_VA_REGION in the reference module — a third parallel
  // implementation of the same regulated lookup. Two hand-maintained state
  // lists drift silently: add a state to one and the same borrower gets a
  // different residual baseline depending on which path evaluates them.
  const STATES = [
    "CT","MA","ME","NH","NJ","NY","PA","RI","VT",
    "IL","IN","IA","KS","MI","MN","MO","NE","ND","OH","SD","WI",
    "AL","AR","DE","DC","FL","GA","KY","LA","MD","MS","NC","OK","SC","TN","TX","VA","WV",
    "AK","AZ","CA","CO","HI","ID","MT","NV","NM","OR","UT","WA","WY",
  ];

  it.each(STATES)("%s resolves to the same VA region on both paths", async (state) => {
    // The engine does not expose its mapping, so infer it: hold every other
    // input fixed and read back the baseline it resolved. Equal baselines for
    // a family size that differs across all four regions implies equal regions.
    const scenario: Scenario = {
      name: state, state, familySize: 1, sqft: 1500,
      baseMonthlyIncome: 3000, existingMonthlyDebts: 400, proposedPiti: 1500,
    };
    const r = await engine.evaluate(engineInput(scenario));
    const expected = VA_RESIDUAL_MATRIX[vaRegionForState(state)][1];
    expect(
      r.requiredResidualIncome,
      `${state}: engine resolved a different regional baseline than vaRegionForState`,
    ).toBeCloseTo(expected, 2);
  });
});
