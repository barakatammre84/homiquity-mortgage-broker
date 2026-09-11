import { describe, it, expect } from "vitest";
import {
  computeIncomePaths,
  incomeInputsFingerprint,
  incomeEvaluationFingerprint,
  type IncomePathsCoreInput,
} from "../server/services/income/orchestrator";
import { computeAgencyWageIncome } from "../server/services/income/paths/agencyWage";
import { computeSelfEmploymentPath } from "../server/services/income/paths/selfEmployment";
import { computeRentalPath } from "../server/services/income/paths/rental";
import { incomePathsSchema, sumAppliedIncome } from "../shared/incomePaths";
import type { EmploymentHistory, OtherIncomeSource, SelfEmploymentWorksheet } from "@shared/schema";

/**
 * Unit tests for the multi-path income orchestrator (UAL P3): the pure path
 * modules, the ranking/primary-income core, and the reproducibility
 * fingerprints. Pure in-process — no HTTP server, no database.
 *
 * The CUTOVER PARITY guarantee — that wage-only decisions are unchanged by the
 * orchestrator — is proven in incomeCutoverParity.test.ts against a frozen
 * copy of the legacy aggregation logic.
 */

// Minimal EmploymentHistory factory (only the fields the paths read).
function emp(over: Partial<EmploymentHistory>): EmploymentHistory {
  return {
    id: "e", applicationId: "a", borrowerSequenceNumber: 1, employerName: null,
    employmentType: "salaried", isSelfEmployed: false, startDate: null, endDate: null,
    paidInVirtualCurrency: false,
    baseIncome: null, overtimeIncome: null, bonusIncome: null, commissionIncome: null,
    otherIncome: null, totalMonthlyIncome: null, selfEmploymentIncome: null,
    ...over,
  } as unknown as EmploymentHistory;
}
function other(monthlyAmount: number | string, incomeSource = "rental"): OtherIncomeSource {
  return {
    id: "o",
    applicationId: "a",
    incomeSource,
    monthlyAmount,
    taxTreatment: "taxable",
    nonTaxableMonthlyAmount: null,
    hasDefinedExpiration: false,
    expirationDate: null,
    paidInVirtualCurrency: false,
  } as unknown as OtherIncomeSource;
}

const scheduleCWorksheet = (net: number, prior: number): SelfEmploymentWorksheet =>
  ({
    businessStructure: "sole_proprietorship",
    ownershipPercent: 100,
    yearsSelfEmployed: 5,
    scheduleC: {
      currentYear: { year: 2025, netProfitOrLoss: net, depreciation: 3000, depletion: 0, amortizationOrCasualtyLoss: 0, businessUseOfHome: 1200, mealsExclusion: 0, nonRecurringIncome: 0 },
      priorYear: { year: 2024, netProfitOrLoss: prior, depreciation: 2800, depletion: 0, amortizationOrCasualtyLoss: 0, businessUseOfHome: 1000, mealsExclusion: 0, nonRecurringIncome: 0 },
    },
  }) as unknown as SelfEmploymentWorksheet;

describe("agency wage path", () => {
  it("uses itemized fields when present (base vs variable split)", () => {
    const r = computeAgencyWageIncome({
      employment: [emp({ baseIncome: 5000, overtimeIncome: 500, bonusIncome: 300 })],
      otherIncome: [],
    });
    expect(r.baseMonthlyIncome).toBe(5000);
    expect(r.variableMonthlyIncome).toBe(800);
    expect(r.path.monthlyQualifyingIncome).toBe(5800);
    expect(r.path.status).toBe("applicable");
  });

  it("falls back to rolled-up total when no itemized field is present", () => {
    const r = computeAgencyWageIncome({ employment: [emp({ totalMonthlyIncome: 4200 })], otherIncome: [] });
    expect(r.baseMonthlyIncome).toBe(4200);
    expect(r.variableMonthlyIncome).toBe(0);
  });

  it("skips self-employed records (they belong to the SE path)", () => {
    const r = computeAgencyWageIncome({
      employment: [emp({ isSelfEmployed: true, totalMonthlyIncome: 9000 })],
      otherIncome: [],
    });
    expect(r.path.monthlyQualifyingIncome).toBe(0);
    expect(r.usedLineItems).toBe(false);
  });

  it("never stacks the rough annual-income fallback onto self-employment", () => {
    const r = computeAgencyWageIncome({
      employment: [emp({ isSelfEmployed: true, selfEmploymentIncome: scheduleCWorksheet(60000, 54000) })],
      otherIncome: [],
      fallbackAnnualIncome: 240000,
    });
    expect(r.path.monthlyQualifyingIncome).toBe(0);
    expect(r.path.status).toBe("not_indicated");
    expect(r.path.notes.join(" ")).toMatch(/excluded.*self-employment/i);
  });

  it("preserves a net-loss itemized total (no > 0 guard deleting losses)", () => {
    const r = computeAgencyWageIncome({ employment: [emp({ baseIncome: -1500 })], otherIncome: [] });
    expect(r.baseMonthlyIncome).toBe(-1500);
    expect(r.usedLineItems).toBe(true);
  });

  it("falls back to the application-summary annual income only when nothing else exists", () => {
    const r = computeAgencyWageIncome({ employment: [], otherIncome: [], fallbackAnnualIncome: 96000 });
    expect(r.baseMonthlyIncome).toBe(8000);
    expect(r.usedLineItems).toBe(false);
  });

  it("carries other-income treatment facts and the approval gate in its fingerprint", () => {
    const source = other("1500", "Social Security");
    const base: IncomePathsCoreInput = { employment: [], otherIncome: [source], rentalProperties: [] };
    const treated = {
      ...source,
      taxTreatment: "fully_non_taxable",
      hasDefinedExpiration: false,
    } as OtherIncomeSource;
    expect(incomeInputsFingerprint({ ...base, otherIncome: [treated] })).not.toBe(incomeInputsFingerprint(base));
    expect(incomeInputsFingerprint({
      ...base,
      otherIncome: [treated],
      applyVerifiedOtherIncomeAdjustments: true,
    })).not.toBe(incomeInputsFingerprint({ ...base, otherIncome: [treated] }));
  });
});

describe("self-employment path", () => {
  it("routes SE jobs through the Form 1084 calculator and aggregates", () => {
    const r = computeSelfEmploymentPath([
      emp({ isSelfEmployed: true, selfEmploymentIncome: scheduleCWorksheet(60000, 54000) }),
    ]);
    expect(r.path.status).toBe("applicable");
    expect(r.path.monthlyQualifyingIncome).toBeGreaterThan(0);
    expect(r.path.citations[0].section).toMatch(/1084/);
  });

  it("contributes $0 and returns a missing item for an SE job with no worksheet", () => {
    const r = computeSelfEmploymentPath([emp({ isSelfEmployed: true })]);
    expect(r.path.monthlyQualifyingIncome).toBe(0);
    expect(r.path.requiresManualReview).toBe(false);
    expect(r.path.missingItems).toEqual([expect.stringMatching(/complete.*worksheet/i)]);
    expect(r.path.notes.some((n) => /no completed income worksheet/i.test(n))).toBe(true);
  });

  it("excludes a self-employed business paid in virtual currency", () => {
    const r = computeSelfEmploymentPath([
      emp({
        isSelfEmployed: true,
        employerName: "Token Consulting",
        paidInVirtualCurrency: true,
        selfEmploymentIncome: scheduleCWorksheet(60000, 54000),
      }),
    ]);
    expect(r.path.monthlyQualifyingIncome).toBe(0);
    expect(r.path.notes.join(" ")).toMatch(/excluded.*virtual currency/i);
  });

  it("does not count one business while another listed business has no completed worksheet", () => {
    const r = computeSelfEmploymentPath([
      emp({ employerName: "Complete LLC", isSelfEmployed: true, selfEmploymentIncome: scheduleCWorksheet(60000, 54000) }),
      emp({ employerName: "Missing LLC", isSelfEmployed: true }),
    ]);
    expect(r.path.monthlyQualifyingIncome).toBeGreaterThan(0);
    expect(r.path.missingItems).toEqual([expect.stringMatching(/Missing LLC/)]);
  });
});

describe("rental path (B3-3.8-01 applied)", () => {
  const oneRental = [
    { address: "1 Main", monthlyRentalIncome: 2000, monthlyDebtPayment: 1200 } as never,
  ];
  const noRisk = { applyPositiveToDti: false, hasMortgageLiabilityRows: false };

  it("withholds a POSITIVE offset until the provenance gate opens (platform asymmetry)", () => {
    const r = computeRentalPath(oneRental, noRisk);
    expect(r.status).toBe("applicable");
    expect(r.appliedToDti).toBe(false);
    // 75% of 2000 = 1500, net of 1200 PITIA = 300
    expect(r.monthlyQualifyingIncome).toBe(300);
  });

  it("applies a POSITIVE offset on decision-grade provenance", () => {
    const r = computeRentalPath(oneRental, { ...noRisk, applyPositiveToDti: true });
    expect(r.appliedToDti).toBe(true);
    expect(r.monthlyQualifyingIncome).toBe(300);
    expect(r.requiresManualReview).toBe(false);
  });

  it("applies a NEGATIVE offset (rental loss) even without the provenance gate", () => {
    const r = computeRentalPath(
      [{ address: "1 Main", monthlyRentalIncome: 1000, monthlyDebtPayment: 1200 } as never],
      noRisk,
    );
    // 75% of 1000 = 750, net of 1200 = −450: a loss always counts.
    expect(r.appliedToDti).toBe(true);
    expect(r.monthlyQualifyingIncome).toBe(-450);
    expect(r.requiresManualReview).toBe(true);
  });

  it("flags manual review when an applied offset coexists with mortgage-type liabilities", () => {
    const r = computeRentalPath(oneRental, {
      applyPositiveToDti: true,
      hasMortgageLiabilityRows: true,
    });
    expect(r.appliedToDti).toBe(true);
    expect(r.requiresManualReview).toBe(true);
    expect(r.notes.some((n) => n.includes("counted both"))).toBe(true);
  });
});

describe("orchestrator core", () => {
  const input: IncomePathsCoreInput = {
    employment: [
      emp({ baseIncome: 6000, bonusIncome: 500 }),
      emp({ isSelfEmployed: true, selfEmploymentIncome: scheduleCWorksheet(48000, 45000) }),
    ],
    otherIncome: [other(400)],
    rentalProperties: [{ address: "2 Oak", monthlyRentalIncome: 1800, monthlyDebtPayment: 1000 } as never],
  };

  it("stacks agency + SE into the primary DTI income; ungated positive rental stays out", () => {
    const r = computeIncomePaths(input);
    const agency = r.primaryBreakdown.agencyBase + r.primaryBreakdown.agencyVariable;
    expect(agency).toBe(6900); // 6000 base + (500 bonus + 400 other)
    expect(r.primaryBreakdown.selfEmployment).toBeGreaterThan(0);
    expect(r.primaryMonthlyQualifyingIncome).toBe(agency + r.primaryBreakdown.selfEmployment);
    // rental offset computed (75% × 1800 − 1000 = 350) but not applied ungated
    expect(r.primaryBreakdown.rental).toBe(350);
    expect(r.primaryBreakdown.rentalIncomeApplied).toBe(0);
    expect(r.primaryBreakdown.rentalLiabilityApplied).toBe(0);
    expect(r.paths.find((p) => p.pathId === "rental")!.status).toBe("applicable");
  });

  it("non-QM paths carry program authority (P4): DSCR ratio computed, bank-statement capture gap named", () => {
    const r = computeIncomePaths(input);
    const dscr = r.paths.find((p) => p.pathId === "dscr")!;
    const bank = r.paths.find((p) => p.pathId === "bank_statement")!;
    // DSCR: rentals declared → cited Rent-Divided-PITIA ratio, always review
    // (no in-repo qualifying threshold).
    expect(dscr.status).toBe("applicable");
    expect(dscr.kind).toBe("coverage_ratio");
    if (dscr.kind === "coverage_ratio") {
      // 75%-free program ratio: 1800 rent ÷ 1000 PITIA = 1.8
      expect(dscr.coverageRatio).toBe(1.8);
    }
    expect(dscr.requiresManualReview).toBe(true);
    // Bank statement: program enabled but no deposit analysis captured yet.
    expect(bank.status).toBe("not_indicated");
    expect(bank.notes[0]).toMatch(/no bank-statement deposit analysis/i);
    // No enabled alternative produced a HIGHER dti_income figure, so no
    // recommendation overrides full-doc.
    expect(r.recommendedPathId).toBeNull();
  });

  it("emits a schema-valid path set", () => {
    const r = computeIncomePaths(input);
    expect(() => incomePathsSchema.parse(r.paths)).not.toThrow();
  });

  it("is deterministic: same inputs → same fingerprints", () => {
    const a = computeIncomePaths(input);
    const b = computeIncomePaths(input);
    expect(incomeEvaluationFingerprint(a)).toBe(incomeEvaluationFingerprint(b));
    expect(incomeInputsFingerprint(input)).toBe(incomeInputsFingerprint(input));
    expect(incomeInputsFingerprint(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the inputs fingerprint when an income figure changes", () => {
    const base = incomeInputsFingerprint(input);
    const mutated: IncomePathsCoreInput = {
      ...input,
      employment: [emp({ baseIncome: 6001 }), input.employment[1]],
    };
    expect(incomeInputsFingerprint(mutated)).not.toBe(base);
  });

  it("reports application_summary basis only on the annual-income fallback", () => {
    expect(computeIncomePaths({ employment: [], otherIncome: [], rentalProperties: [], fallbackAnnualIncome: 60000 }).incomeBasis).toBe("application_summary");
    expect(computeIncomePaths(input).incomeBasis).toBe("urla_line_items");
  });

  it("uses only Form 1084 income when a self-employed intake also has a rough annual total", () => {
    const r = computeIncomePaths({
      employment: [emp({ isSelfEmployed: true, selfEmploymentIncome: scheduleCWorksheet(60000, 54000) })],
      otherIncome: [],
      rentalProperties: [],
      fallbackAnnualIncome: 240000,
    });
    expect(r.primaryBreakdown.agencyBase).toBe(0);
    expect(r.primaryMonthlyQualifyingIncome).toBe(r.primaryBreakdown.selfEmployment);
    expect(r.incomeBasis).toBe("urla_line_items");
  });
});

describe("rental DTI application (B3-3.8-01 wiring)", () => {
  const wage = [emp({ baseIncome: 6000 })];

  it("adds a positive net offset to the primary income at decision-grade provenance", () => {
    const r = computeIncomePaths({
      employment: wage,
      otherIncome: [],
      rentalProperties: [{ address: "2 Oak", monthlyRentalIncome: 1800, monthlyDebtPayment: 1000 } as never],
      applyRentalToDti: true,
    });
    expect(r.primaryBreakdown.rentalIncomeApplied).toBe(350);
    expect(r.primaryBreakdown.rentalLiabilityApplied).toBe(0);
    expect(r.primaryMonthlyQualifyingIncome).toBe(6000 + 350);
  });

  it("surfaces a rental LOSS as a liability (never negative income), gate or no gate", () => {
    for (const applyRentalToDti of [false, true]) {
      const r = computeIncomePaths({
        employment: wage,
        otherIncome: [],
        rentalProperties: [{ address: "2 Oak", monthlyRentalIncome: 1000, monthlyDebtPayment: 1200 } as never],
        applyRentalToDti,
      });
      expect(r.primaryBreakdown.rentalLiabilityApplied).toBe(450);
      expect(r.primaryBreakdown.rentalIncomeApplied).toBe(0);
      // The loss reduces DTI through obligations, not by shrinking income.
      expect(r.primaryMonthlyQualifyingIncome).toBe(6000);
    }
  });

  it("adds subject-property qualifying rent income-side for a gated 2–4 unit owner-occupied file", () => {
    const subject = { numberOfUnits: 3, occupancyType: "primary_residence", estimatedMarketRent: 3000 };
    const gated = computeIncomePaths({
      employment: wage, otherIncome: [], rentalProperties: [],
      applyRentalToDti: true, subjectProperty: subject,
    });
    expect(gated.primaryBreakdown.subjectRentalIncomeApplied).toBe(2250); // 75% × 3000
    expect(gated.primaryMonthlyQualifyingIncome).toBe(6000 + 2250);

    const ungated = computeIncomePaths({
      employment: wage, otherIncome: [], rentalProperties: [], subjectProperty: subject,
    });
    expect(ungated.primaryBreakdown.subjectRentalIncomeApplied).toBe(0);
    expect(ungated.primaryMonthlyQualifyingIncome).toBe(6000);
  });

  it("ignores subject-property rent outside the 2–4 unit owner-occupied rule", () => {
    for (const subject of [
      { numberOfUnits: 1, occupancyType: "primary_residence", estimatedMarketRent: 3000 },
      { numberOfUnits: 3, occupancyType: "investment", estimatedMarketRent: 3000 },
    ]) {
      const r = computeIncomePaths({
        employment: wage, otherIncome: [], rentalProperties: [],
        applyRentalToDti: true, subjectProperty: subject,
      });
      expect(r.primaryBreakdown.subjectRentalIncomeApplied).toBe(0);
    }
  });

  it("the provenance gate and subject facts are part of the inputs fingerprint", () => {
    const base: IncomePathsCoreInput = {
      employment: wage, otherIncome: [],
      rentalProperties: [{ address: "2 Oak", monthlyRentalIncome: 1800, monthlyDebtPayment: 1000 } as never],
    };
    const gatedFp = incomeInputsFingerprint({ ...base, applyRentalToDti: true });
    expect(gatedFp).not.toBe(incomeInputsFingerprint(base));
    const withSubject = incomeInputsFingerprint({
      ...base,
      subjectProperty: { numberOfUnits: 3, occupancyType: "primary_residence", estimatedMarketRent: 3000 },
    });
    expect(withSubject).not.toBe(incomeInputsFingerprint(base));
  });
});

describe("S-07 departing residence + per-property split + subject DSCR (PR-B)", () => {
  const wage = [emp({ baseIncome: 6000 })];

  it("splits offsets PER PROPERTY: gains to income (gated), losses to obligations — never netted", () => {
    const mixed = [
      { address: "A", monthlyRentalIncome: 1800, monthlyDebtPayment: 1000 } as never, // +350
      { address: "B", monthlyRentalIncome: 1000, monthlyDebtPayment: 1200 } as never, // −450
    ];
    const gated = computeIncomePaths({
      employment: wage, otherIncome: [], rentalProperties: mixed, applyRentalToDti: true,
    });
    expect(gated.primaryBreakdown.rentalIncomeApplied).toBe(350);
    expect(gated.primaryBreakdown.rentalLiabilityApplied).toBe(450);
    expect(gated.primaryMonthlyQualifyingIncome).toBe(6350);

    const ungated = computeIncomePaths({
      employment: wage, otherIncome: [], rentalProperties: mixed,
    });
    expect(ungated.primaryBreakdown.rentalIncomeApplied).toBe(0);
    expect(ungated.primaryBreakdown.rentalLiabilityApplied).toBe(450); // loss still counts
    expect(ungated.primaryMonthlyQualifyingIncome).toBe(6000);
  });

  it("folds a converting departing residence into the offsets with always-review", () => {
    const r = computeIncomePaths({
      employment: wage, otherIncome: [], rentalProperties: [],
      departingResidence: { estimatedMarketRent: 2000, monthlyPitia: 1800 },
    });
    // 75% × 2000 − 1800 = −300 loss: applied to obligations even ungated
    expect(r.primaryBreakdown.rentalLiabilityApplied).toBe(300);
    const rental = r.paths.find((p) => p.pathId === "rental")!;
    expect(rental.requiresManualReview).toBe(true);
    expect(rental.notes.some((n) => n.includes("departing residence"))).toBe(true);
  });

  it("applies a positive departing-residence offset only at decision-grade provenance", () => {
    const departingResidence = { estimatedMarketRent: 2000, monthlyPitia: 1000 }; // +500
    const gated = computeIncomePaths({
      employment: wage, otherIncome: [], rentalProperties: [],
      applyRentalToDti: true, departingResidence,
    });
    expect(gated.primaryBreakdown.rentalIncomeApplied).toBe(500);
    expect(gated.primaryMonthlyQualifyingIncome).toBe(6500);
    // still review — projected rent
    expect(gated.paths.find((p) => p.pathId === "rental")!.requiresManualReview).toBe(true);

    const ungated = computeIncomePaths({
      employment: wage, otherIncome: [], rentalProperties: [], departingResidence,
    });
    expect(ungated.primaryBreakdown.rentalIncomeApplied).toBe(0);
  });

  it("computes the subject-property DSCR for an investment purchase from URLA market rent", () => {
    const r = computeIncomePaths({
      employment: wage, otherIncome: [], rentalProperties: [],
      subjectProperty: {
        numberOfUnits: 1, occupancyType: "investment",
        estimatedMarketRent: 3000, estimatedPitia: 2400,
      },
    });
    const dscr = r.paths.find((p) => p.pathId === "dscr")!;
    expect(dscr.status).toBe("applicable");
    expect(dscr.kind === "coverage_ratio" && dscr.coverageRatio).toBe(1.25);
    expect(dscr.requiresManualReview).toBe(true); // matrix still portal-gated
    expect(dscr.notes.some((n) => n.includes("Subject property"))).toBe(true);
    // owner-occupied subject never computes a DSCR
    const oo = computeIncomePaths({
      employment: wage, otherIncome: [], rentalProperties: [],
      subjectProperty: {
        numberOfUnits: 1, occupancyType: "primary_residence",
        estimatedMarketRent: 3000, estimatedPitia: 2400,
      },
    });
    expect(oo.paths.find((p) => p.pathId === "dscr")!.status).toBe("not_indicated");
  });

  it("departing figures and subject PITIA are part of the inputs fingerprint", () => {
    const base: IncomePathsCoreInput = { employment: wage, otherIncome: [], rentalProperties: [] };
    expect(
      incomeInputsFingerprint({
        ...base,
        departingResidence: { estimatedMarketRent: 2000, monthlyPitia: 1800 },
      }),
    ).not.toBe(incomeInputsFingerprint(base));
    const s1 = incomeInputsFingerprint({
      ...base,
      subjectProperty: { numberOfUnits: 1, occupancyType: "investment", estimatedMarketRent: 3000, estimatedPitia: 2400 },
    });
    const s2 = incomeInputsFingerprint({
      ...base,
      subjectProperty: { numberOfUnits: 1, occupancyType: "investment", estimatedMarketRent: 3000, estimatedPitia: 2500 },
    });
    expect(s1).not.toBe(s2);
  });
});

/**
 * The itemisation invariant (2026-08-23).
 *
 * A path result recorded what a path was WORTH and never what it CONTRIBUTED,
 * and the subject property's 2–4-unit qualifying rent contributed without being
 * a path at all. Every surface that itemises the qualifying total inherited the
 * gap: the borrower's "How your qualifying income was calculated" card and the
 * LO cockpit both rendered rows that did not sum to the number above them.
 *
 * Measured on the pre-fix code, all three with $6,000 of wages:
 *   - rentals of +1,250 and −750 → rows 6,500, total 7,250 (750 unexplained);
 *   - owner-occupied duplex, 1,500 market rent → rows 6,000, total 7,125;
 *   - a single rental at a loss → a −750 row badged "Counted", absent from the
 *     total (the loss is a monthly DEBT, never negative income).
 *
 * So the rule, not the instances: Σ contributed === the primary total, always.
 */
describe("applied amounts reconcile to the qualifying total", () => {
  const wage = [emp({ baseIncome: 6000 })];
  const rentalEntry = (rent: number, debt: number) =>
    ({ address: "r", monthlyRentalIncome: rent, monthlyDebtPayment: debt }) as never;

  const cases: Array<[string, IncomePathsCoreInput]> = [
    ["wage only", { employment: wage, otherIncome: [], rentalProperties: [] }],
    [
      "mixed rental portfolio (positives to income, losses to obligations)",
      {
        employment: wage,
        otherIncome: [],
        rentalProperties: [rentalEntry(3000, 1000), rentalEntry(1000, 1500)],
        applyRentalToDti: true,
      },
    ],
    [
      "rental loss only, provenance not yet decision-grade",
      {
        employment: wage,
        otherIncome: [],
        rentalProperties: [rentalEntry(1000, 1500)],
        applyRentalToDti: false,
      },
    ],
    [
      "owner-occupied duplex — subject unit rent has no path of its own",
      {
        employment: wage,
        otherIncome: [],
        rentalProperties: [],
        applyRentalToDti: true,
        subjectProperty: {
          numberOfUnits: 2,
          occupancyType: "primary_residence",
          estimatedMarketRent: 1500,
          estimatedPitia: 2500,
        },
      },
    ],
    [
      "duplex AND a losing rental — both corrections at once",
      {
        employment: wage,
        otherIncome: [],
        rentalProperties: [rentalEntry(1000, 1500)],
        applyRentalToDti: true,
        subjectProperty: {
          numberOfUnits: 3,
          occupancyType: "primary_residence",
          estimatedMarketRent: 2000,
          estimatedPitia: 3000,
        },
      },
    ],
  ];

  it.each(cases)("%s", (_name, input) => {
    const r = computeIncomePaths(input);
    expect(sumAppliedIncome(r.paths)).toBe(r.primaryMonthlyQualifyingIncome);
  });

  it("the subject property's qualifying rent rides on the rental row it belongs to", () => {
    const r = computeIncomePaths({
      employment: wage,
      otherIncome: [],
      rentalProperties: [],
      applyRentalToDti: true,
      subjectProperty: {
        numberOfUnits: 2,
        occupancyType: "primary_residence",
        estimatedMarketRent: 1500,
        estimatedPitia: 2500,
      },
    });
    const rental = r.paths.find((p) => p.pathId === "rental")!;
    // 75% of 1,500 — the cited B3-3.8-01 treatment, unchanged.
    expect(r.primaryBreakdown.subjectRentalIncomeApplied).toBe(1125);
    // "no other properties" is not "no rental income": the row must exist.
    expect(rental.status).toBe("applicable");
    expect(rental.kind === "dti_income" && rental.appliedMonthlyIncome).toBe(1125);
    expect(rental.notes.some((n) => n.includes("Subject property"))).toBe(true);
  });

  it("a rental loss is an obligation, never negative applied income", () => {
    const r = computeIncomePaths({
      employment: wage,
      otherIncome: [],
      rentalProperties: [rentalEntry(1000, 1500)],
      applyRentalToDti: true,
    });
    const rental = r.paths.find((p) => p.pathId === "rental")!;
    expect(rental.kind === "dti_income" && rental.monthlyQualifyingIncome).toBe(-750);
    expect(rental.kind === "dti_income" && rental.appliedMonthlyIncome).toBe(0);
    expect(rental.kind === "dti_income" && rental.appliedMonthlyObligation).toBe(750);
    expect(r.primaryBreakdown.rentalLiabilityApplied).toBe(750);
  });

  it("an alternative METHOD contributes nothing to the full-doc total", () => {
    const r = computeIncomePaths({ employment: wage, otherIncome: [], rentalProperties: [] });
    const bank = r.paths.find((p) => p.pathId === "bank_statement")!;
    expect(bank.role).toBe("alternative");
    expect(bank.kind === "dti_income" && bank.appliedMonthlyIncome).toBe(0);
  });

  it("sumAppliedIncome refuses a legacy row rather than reading it as zero", () => {
    const r = computeIncomePaths({
      employment: wage,
      otherIncome: [],
      rentalProperties: [rentalEntry(3000, 1000)],
      applyRentalToDti: true,
    });
    const legacy = r.paths.map((p) =>
      p.kind === "dti_income"
        ? { ...p, appliedMonthlyIncome: undefined, appliedMonthlyObligation: undefined }
        : p,
    );
    expect(sumAppliedIncome(legacy)).toBeNull();
  });
});
