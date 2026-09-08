import { describe, expect, it } from "vitest";
import {
  CANONICAL_ORDER,
  computeFlags,
  computeRoute,
  createFunnelState,
  estimateTimeRemaining,
  funnelReducer,
  PRE_APPROVAL_DEFAULTS,
  resolveRouteIndex,
  routeProgress,
  ROUTING_ANSWER_FIELDS,
  routingSignature,
  stepGate,
  type FunnelState,
} from "../client/src/funnel/preApprovalMachine";
import type { PreApprovalFormData } from "../shared/schema";

const NO_CONSENT = { softPullAcknowledged: false };
const CONSENT = { softPullAcknowledged: true };

function answers(overrides: Partial<PreApprovalFormData> = {}): PreApprovalFormData {
  return { ...PRE_APPROVAL_DEFAULTS, ...overrides };
}

/** Complete, valid answer set (passes the full zod schema). */
function completeAnswers(overrides: Partial<PreApprovalFormData> = {}): PreApprovalFormData {
  return answers({
    annualIncome: "120,000",
    employmentType: "employed",
    employmentYears: "5",
    monthlyDebts: "1,500",
    creditScore: "760",
    loanPurpose: "purchase",
    occupancyType: "primary_residence",
    propertyType: "single_family",
    purchasePrice: "500,000",
    downPayment: "100,000",
    propertyState: "CA",
    ...overrides,
  });
}

describe("computeRoute — deterministic dynamic routing", () => {
  it("produces the base route with no complex income", () => {
    const route = computeRoute(answers());
    expect(route).toEqual([
      "intro",
      "loanPurpose",
      "occupancyType",
      "propertyType",
      "veteranAndFirstTime",
      "purchasePrice",
      "downPayment",
      "propertyState",
      "annualIncome",
      "employmentType",
      "employmentYears",
      "hasAdditionalIncome",
      "monthlyDebts",
      "creditScore",
      "final",
    ]);
  });

  it("asks about military service before the down payment (VA zero-down ordering)", () => {
    const route = computeRoute(answers());
    expect(route.indexOf("veteranAndFirstTime")).toBeLessThan(route.indexOf("downPayment"));
  });

  it("asks occupancy before property type and only asks rental details when they apply", () => {
    const primary = computeRoute(answers({ occupancyType: "primary_residence", propertyType: "single_family" }));
    expect(primary.indexOf("occupancyType")).toBe(primary.indexOf("loanPurpose") + 1);
    expect(primary.indexOf("propertyType")).toBe(primary.indexOf("occupancyType") + 1);
    expect(primary).not.toContain("numberOfUnits");
    expect(primary).not.toContain("subjectMonthlyRentalIncome");

    const multiFamily = computeRoute(answers({ occupancyType: "primary_residence", propertyType: "multi_family" }));
    expect(multiFamily.indexOf("numberOfUnits")).toBe(multiFamily.indexOf("propertyType") + 1);
    expect(multiFamily.indexOf("subjectMonthlyRentalIncome")).toBe(multiFamily.indexOf("numberOfUnits") + 1);

    const investment = computeRoute(answers({ occupancyType: "investment", propertyType: "single_family" }));
    expect(investment).not.toContain("numberOfUnits");
    expect(investment.indexOf("subjectMonthlyRentalIncome")).toBe(investment.indexOf("propertyType") + 1);
  });

  it("injects the complex-income block when the user reports additional income", () => {
    const route = computeRoute(answers({ hasAdditionalIncome: true }));
    expect(route).toContain("incomeSources");
    expect(route.indexOf("incomeSources")).toBe(route.indexOf("hasAdditionalIncome") + 1);
  });

  it("forces the complex-income block for self-employed borrowers", () => {
    const route = computeRoute(answers({ employmentType: "self_employed", hasAdditionalIncome: false }));
    expect(route).toContain("incomeSources");
    expect(route).not.toContain("employmentType");
  });

  // The reported bug: a self-employed borrower answered "No, this is my only
  // income" and was taken to the other-income step anyway, because the block is
  // mandatory for them regardless. The fix is not to honour a "No" underwriting
  // can't accept — it is to stop asking a question whose answer is ignored.
  it("does not ask about additional income when the detail block is mandatory anyway", () => {
    const selfEmployed = computeRoute(answers({ employmentType: "self_employed" }));
    expect(selfEmployed).not.toContain("hasAdditionalIncome");
    expect(selfEmployed).toContain("incomeSources");
    expect(selfEmployed.indexOf("incomeSources")).toBe(selfEmployed.indexOf("employmentYears") + 1);
  });

  it("still asks about additional income whenever the answer can change the route", () => {
    for (const employmentType of ["employed", "retired", "other"] as const) {
      const route = computeRoute(answers({ employmentType }));
      expect(route).toContain("hasAdditionalIncome");
      expect(route).not.toContain("incomeSources");
    }
  });

  it("honours “No, this is my only income” for every borrower it is asked of", () => {
    // Answering No clears incomeSources (the choice handler in PreApproval.tsx
    // does this), so both routing inputs say no. The step must be gone.
    const route = computeRoute(answers({ hasAdditionalIncome: false, incomeSources: [] }));
    expect(route).toContain("hasAdditionalIncome");
    expect(route).not.toContain("incomeSources");
    expect(route[route.indexOf("hasAdditionalIncome") + 1]).toBe("monthlyDebts");
  });

  it("keeps the complex-income block for multi-property landlords", () => {
    const route = computeRoute(
      answers({
        hasAdditionalIncome: false,
        incomeSources: [
          {
            type: "rental",
            annualAmount: "36,000",
            rentalProperties: [
              { address: "1 Main St", monthlyRentalIncome: "1,500", monthlyDebtPayment: "" },
              { address: "2 Oak Ave", monthlyRentalIncome: "1,500", monthlyDebtPayment: "" },
            ],
          },
        ],
      }),
    );
    expect(route).toContain("incomeSources");
  });

  it("is deterministic: identical answers yield identical routes", () => {
    const a = answers({ employmentType: "self_employed" });
    expect(computeRoute(a)).toEqual(computeRoute({ ...a }));
  });

  it("injects the VA residual-income steps for veterans only", () => {
    const va = computeRoute(answers({ isVeteran: true }));
    expect(va.indexOf("householdFamilySize")).toBe(va.indexOf("propertyState") + 1);
    expect(va.indexOf("homeSquareFootage")).toBe(va.indexOf("householdFamilySize") + 1);

    const conventional = computeRoute(answers({ isVeteran: false }));
    expect(conventional).not.toContain("householdFamilySize");
    expect(conventional).not.toContain("homeSquareFootage");
  });
});

describe("computeFlags", () => {
  it("flags VA zero-down for veteran purchases only", () => {
    expect(computeFlags(answers({ isVeteran: true, loanPurpose: "purchase" })).vaZeroDown).toBe(true);
    expect(computeFlags(answers({ isVeteran: true, loanPurpose: "refinance" })).vaZeroDown).toBe(false);
    expect(computeFlags(answers({ isVeteran: false })).vaZeroDown).toBe(false);
  });

  it("suppresses PMI guidance on the VA path", () => {
    const va = computeFlags(answers({ isVeteran: true, purchasePrice: "500,000", downPayment: "0" }));
    expect(va.pmiLikely).toBe(false);
    const conventional = computeFlags(answers({ purchasePrice: "500,000", downPayment: "50,000" }));
    expect(conventional.pmiLikely).toBe(true);
  });
});

describe("stepGate — validation gates", () => {
  it("blocks a $0 down payment on the conventional path", () => {
    const gate = stepGate("downPayment", answers({ purchasePrice: "500,000", downPayment: "0" }), NO_CONSENT);
    expect(gate.ok).toBe(false);
    expect(gate.errors[0]).toMatch(/VA/i);
  });

  it("allows a $0 down payment for VA-eligible veterans", () => {
    const gate = stepGate(
      "downPayment",
      answers({ isVeteran: true, loanPurpose: "purchase", purchasePrice: "500,000", downPayment: "0" }),
      NO_CONSENT,
    );
    expect(gate.ok).toBe(true);
  });

  it("blocks a down payment above the purchase price", () => {
    const gate = stepGate("downPayment", answers({ purchasePrice: "300,000", downPayment: "400,000" }), NO_CONSENT);
    expect(gate.ok).toBe(false);
  });

  // On a refinance the step asks for EQUITY, not a down payment. The gate's
  // messages have to speak the same language the borrower was shown — telling
  // someone who already owns the home to "enter your planned down payment" is
  // the funnel talking to the wrong person.
  it("words the down-payment gate as equity on a refinance", () => {
    for (const loanPurpose of ["refinance", "cash_out"] as const) {
      const blank = stepGate("downPayment", answers({ loanPurpose, purchasePrice: "500,000" }), NO_CONSENT);
      expect(blank.ok).toBe(false);
      expect(blank.errors[0]).toMatch(/equity/i);
      expect(blank.errors[0]).not.toMatch(/down payment/i);

      const zero = stepGate(
        "downPayment",
        answers({ loanPurpose, purchasePrice: "500,000", downPayment: "0" }),
        NO_CONSENT,
      );
      expect(zero.ok).toBe(false);
      expect(zero.errors[0]).not.toMatch(/down payment/i);

      const tooMuch = stepGate(
        "downPayment",
        answers({ loanPurpose, purchasePrice: "300,000", downPayment: "400,000" }),
        NO_CONSENT,
      );
      expect(tooMuch.ok).toBe(false);
      expect(tooMuch.errors[0]).toMatch(/equity/i);
    }
  });

  it("keeps purchase wording on the purchase path", () => {
    const gate = stepGate("downPayment", answers({ loanPurpose: "purchase", purchasePrice: "500,000" }), NO_CONSENT);
    expect(gate.errors[0]).toMatch(/down payment/i);
  });

  it("requires self-employed borrowers to detail their income", () => {
    const gate = stepGate(
      "incomeSources",
      answers({ employmentType: "self_employed", hasAdditionalIncome: false, incomeSources: [] }),
      NO_CONSENT,
    );
    expect(gate.ok).toBe(false);
    expect(gate.errors[0]).toMatch(/self-employment/i);
  });

  it("requires the business facts needed for the correct income review path", () => {
    const gate = stepGate(
      "incomeSources",
      answers({
        annualIncome: "170,000",
        hasAdditionalIncome: true,
        incomeSources: [{
          type: "self_employed",
          annualAmount: "45,000",
          employerName: "Harbor Studio LLC",
          yearsInRole: "4",
        }],
      }),
      NO_CONSENT,
    );
    expect(gate.ok).toBe(false);
    expect(gate.errors[0]).toMatch(/business type.*ownership/i);
  });

  it("blocks a source breakdown above the reported household total", () => {
    const gate = stepGate(
      "incomeSources",
      answers({
        annualIncome: "40,000",
        hasAdditionalIncome: true,
        incomeSources: [{ type: "investment", annualAmount: "50,000" }],
      }),
      NO_CONSENT,
    );
    expect(gate.ok).toBe(false);
    expect(gate.errors[0]).toMatch(/higher than your household total/i);
  });

  it("requires rental sources to have complete property details", () => {
    const gate = stepGate(
      "incomeSources",
      answers({
        hasAdditionalIncome: true,
        incomeSources: [
          { type: "rental", annualAmount: "", rentalProperties: [{ address: "", monthlyRentalIncome: "", monthlyDebtPayment: "" }] },
        ],
      }),
      NO_CONSENT,
    );
    expect(gate.ok).toBe(false);
  });

  it("blocks final submission without the FCRA soft-pull acknowledgement", () => {
    const gate = stepGate("final", completeAnswers(), NO_CONSENT);
    expect(gate.ok).toBe(false);
    expect(gate.errors[0]).toMatch(/soft credit/i);
  });

  it("passes final submission with consent and complete answers", () => {
    const gate = stepGate("final", completeAnswers(), CONSENT);
    expect(gate.ok).toBe(true);
  });

  it("requires the VA residual-income inputs for veterans at the final gate", () => {
    const missing = stepGate(
      "final",
      completeAnswers({ isVeteran: true, downPayment: "0" }),
      CONSENT,
    );
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(" ")).toMatch(/household size/i);

    const complete = stepGate(
      "final",
      completeAnswers({
        isVeteran: true,
        downPayment: "0",
        householdFamilySize: "3",
        homeSquareFootage: "2000",
      }),
      CONSENT,
    );
    expect(complete.ok).toBe(true);
  });

  it("reports schema violations at the final gate", () => {
    const gate = stepGate("final", completeAnswers({ annualIncome: "" }), CONSENT);
    expect(gate.ok).toBe(false);
    expect(gate.errors.length).toBeGreaterThan(0);
  });
});

describe("funnelReducer — transitions", () => {
  function advance(state: FunnelState, a: PreApprovalFormData): FunnelState {
    return funnelReducer(state, { type: "NEXT", answers: a });
  }

  it("walks the base route forward and backward symmetrically", () => {
    const a = completeAnswers();
    let state = createFunnelState(a);
    state = advance(state, a); // intro -> loanPurpose
    state = advance(state, a); // loanPurpose -> occupancyType
    state = advance(state, a); // occupancyType -> propertyType
    expect(state.stepId).toBe("propertyType");
    state = funnelReducer(state, { type: "BACK" });
    expect(state.stepId).toBe("occupancyType");
    expect(state.direction).toBe(-1);
  });

  it("skips the complex-income block when routing says it doesn't exist", () => {
    const a = completeAnswers({ hasAdditionalIncome: false });
    let state = createFunnelState(a);
    state = funnelReducer(state, { type: "GO_TO", stepId: "hasAdditionalIncome" });
    state = advance(state, a);
    expect(state.stepId).toBe("monthlyDebts");
  });

  it("enters the complex-income block when injected", () => {
    const a = completeAnswers({ hasAdditionalIncome: true });
    let state = createFunnelState(a);
    state = funnelReducer(state, { type: "GO_TO", stepId: "hasAdditionalIncome" });
    state = advance(state, a);
    expect(state.stepId).toBe("incomeSources");
  });

  it("records a blocked gate instead of advancing", () => {
    const a = completeAnswers({ downPayment: "0" }); // non-VA zero down
    let state = createFunnelState(a);
    state = funnelReducer(state, { type: "GO_TO", stepId: "downPayment" });
    state = advance(state, a);
    expect(state.stepId).toBe("downPayment");
    expect(state.blockedGate?.ok).toBe(false);
  });

  it("hydrates to a saved step with saved answers", () => {
    const a = completeAnswers({ hasAdditionalIncome: true });
    let state = createFunnelState();
    state = funnelReducer(state, { type: "HYDRATE", stepId: "incomeSources", answers: a });
    expect(state.stepId).toBe("incomeSources");
    expect(state.answers.hasAdditionalIncome).toBe(true);
  });

  it("recovers deterministically when the current step is routed away", () => {
    // User is on incomeSources, then answers change so it no longer exists.
    const withIncome = completeAnswers({ hasAdditionalIncome: true });
    let state = createFunnelState(withIncome);
    state = funnelReducer(state, { type: "GO_TO", stepId: "incomeSources" });
    const withoutIncome = completeAnswers({ hasAdditionalIncome: false, incomeSources: [] });
    state = funnelReducer(state, { type: "NEXT", answers: withoutIncome });
    // Falls back to the nearest surviving predecessor, then advances.
    expect(state.stepId).toBe("monthlyDebts");
  });
});

describe("resolveRouteIndex / routeProgress", () => {
  it("resolves a missing step to its nearest surviving predecessor", () => {
    const route = computeRoute(answers({ hasAdditionalIncome: false }));
    expect(resolveRouteIndex(route, "incomeSources")).toBe(route.indexOf("hasAdditionalIncome"));
  });

  it("reports progress within the active route", () => {
    const route = computeRoute(answers());
    const p = routeProgress(route, "final");
    expect(p.index).toBe(route.length - 1);
    expect(p.percent).toBe(100);
    expect(p.remaining).toBe(0);
  });

  it("counts the steps still ahead", () => {
    const route = computeRoute(answers());
    const p = routeProgress(route, "annualIncome");
    expect(p.remaining).toBe(route.length - 1 - route.indexOf("annualIncome"));
    expect(p.index + p.remaining).toBe(p.total);
  });
});

/**
 * The chapter rail is the funnel's primary orientation surface, so its shape is
 * a contract, not a rendering detail: always four chapters, always in order,
 * monotonic fill, and every routed step accounted for. A step added to
 * CANONICAL_ORDER without a STEP_SECTION entry fails to compile; a step that
 * routes but lands in no chapter's step count fails here.
 */
describe("routeProgress — chapter rail", () => {
  it("always reports the four chapters in order", () => {
    for (const stepId of CANONICAL_ORDER) {
      const route = computeRoute(answers({ isVeteran: true, hasAdditionalIncome: true }));
      const p = routeProgress(route, stepId);
      expect(p.sections.map((s) => s.id)).toEqual(["goal", "property", "finances", "finish"]);
      expect(p.sections.map((s) => s.number)).toEqual([1, 2, 3, 4]);
    }
  });

  it("accounts for every routed question exactly once", () => {
    for (const a of [answers(), answers({ isVeteran: true }), answers({ employmentType: "self_employed" })]) {
      const route = computeRoute(a);
      const p = routeProgress(route, "final");
      const counted = p.sections.reduce((sum, s) => sum + s.stepCount, 0);
      // route.length - 1: the intro is chrome, not a counted question.
      expect(counted).toBe(route.length - 1);
    }
  });

  it("marks exactly one chapter current, with earlier ones done and later ones upcoming", () => {
    const route = computeRoute(answers());
    const p = routeProgress(route, "annualIncome");
    expect(p.sectionId).toBe("finances");
    expect(p.sections.map((s) => s.status)).toEqual(["done", "done", "current", "upcoming"]);
    expect(p.sections[0].percent).toBe(100);
    expect(p.sections[3].percent).toBe(0);
    // First question of the chapter, so one of its steps is reached.
    expect(p.sections[2].stepsReached).toBe(1);
    expect(p.sections[2].percent).toBeGreaterThan(0);
    expect(p.sections[2].percent).toBeLessThan(100);
  });

  it("fills the last chapter once the borrower is on the final step", () => {
    const route = computeRoute(answers());
    const p = routeProgress(route, "final");
    expect(p.sectionId).toBe("finish");
    expect(p.sections[3]).toMatchObject({ status: "current", stepCount: 1, stepsReached: 1, percent: 100 });
  });

  it("leaves the rail empty on the intro", () => {
    const p = routeProgress(computeRoute(answers()), "intro");
    expect(p.index).toBe(0);
    expect(p.percent).toBe(0);
    expect(p.sections.every((s) => s.percent === 0)).toBe(true);
  });

  it("never fills a chapter backwards as the borrower advances", () => {
    const route = computeRoute(answers({ isVeteran: true }));
    let previous = route.map(() => 0);
    for (const stepId of route) {
      const fills = routeProgress(route, stepId).sections.map((s) => s.percent);
      fills.forEach((fill, i) => expect(fill).toBeGreaterThanOrEqual(previous[i] ?? 0));
      previous = fills;
    }
  });

  it("grows the property chapter when VA residual-income steps are injected", () => {
    const base = routeProgress(computeRoute(answers()), "purchasePrice");
    const va = routeProgress(computeRoute(answers({ isVeteran: true })), "purchasePrice");
    expect(va.sections[1].stepCount).toBe(base.sections[1].stepCount + 2);
  });
});

describe("estimateTimeRemaining", () => {
  it("derives the estimate from steps left, not from a fixed step index", () => {
    // 13 questions at ~5/min is the funnel's own "about 3 minutes" promise.
    expect(estimateTimeRemaining(13)).toBe("~3 min left");
    expect(estimateTimeRemaining(8)).toBe("~2 min left");
    expect(estimateTimeRemaining(3)).toBe("~1 min left");
  });

  it("switches to reassurance at the tail", () => {
    expect(estimateTimeRemaining(2)).toBe("Almost done");
    expect(estimateTimeRemaining(1)).toBe("Almost done");
    expect(estimateTimeRemaining(0)).toBe("Last step");
    expect(estimateTimeRemaining(-1)).toBe("Last step");
  });
});

/**
 * ROUTING_ANSWER_FIELDS is what lets the React binding skip an ANSWERS_CHANGED
 * dispatch — and therefore a second full render of the funnel — when a keystroke
 * cannot move the route or the flags.
 *
 * The whole optimisation rests on that list being COMPLETE. If someone adds a
 * field to computeFlags or computeRoute and forgets to list it, the funnel
 * silently stops re-routing on that answer: the step that should appear never
 * does, and nothing errors. So rather than trust the list, derive the check —
 * mutate every field that is NOT listed and prove neither output moves.
 */
describe("ROUTING_ANSWER_FIELDS completeness", () => {
  // A distinct, schema-plausible value per field, so "no change" is a real
  // result and not an accidental no-op assignment.
  const PROBE: Partial<Record<keyof PreApprovalFormData, unknown>> = {
    annualIncome: "999,999",
    employmentYears: "42",
    monthlyDebts: "7,777",
    creditScore: "excellent",
    propertyType: "condo",
    occupancyType: "second_home",
    numberOfUnits: "4",
    subjectMonthlyRentalIncome: "3200",
    propertyState: "IL",
    isFirstTimeBuyer: true,
    householdFamilySize: "9",
    homeSquareFootage: "4200",
    avoidsInterestFinancing: true,
  };

  const base = completeAnswers({ isVeteran: true, hasAdditionalIncome: true });
  const nonRouting = (Object.keys(base) as (keyof PreApprovalFormData)[]).filter(
    (field) => !ROUTING_ANSWER_FIELDS.includes(field),
  );

  it("covers every field the machine actually derives from", () => {
    for (const field of nonRouting) {
      const probe = PROBE[field];
      // A field with no probe value is a gap in THIS test, not in the source.
      expect(probe, `no probe value for non-routing field "${field}"`).toBeDefined();

      const mutated = { ...base, [field]: probe } as PreApprovalFormData;
      expect(computeRoute(mutated), `route moved on "${field}"`).toEqual(computeRoute(base));
      expect(computeFlags(mutated), `flags moved on "${field}"`).toEqual(computeFlags(base));
    }
  });

  it("changing a non-routing answer leaves the signature identical", () => {
    const mutated = completeAnswers({
      isVeteran: true,
      hasAdditionalIncome: true,
      annualIncome: "1",
      monthlyDebts: "2",
      creditScore: "fair",
    });
    expect(routingSignature(mutated)).toBe(routingSignature(base));
  });

  it("changing a routing answer DOES move the signature", () => {
    for (const field of ROUTING_ANSWER_FIELDS) {
      const flipped =
        typeof base[field] === "boolean"
          ? !base[field]
          : Array.isArray(base[field])
            ? [{ type: "rental", annualAmount: "1" }]
            : "___changed___";
      const mutated = { ...base, [field]: flipped } as PreApprovalFormData;
      expect(routingSignature(mutated), `signature ignored "${field}"`).not.toBe(
        routingSignature(base),
      );
    }
  });
});
