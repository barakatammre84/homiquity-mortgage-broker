import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fixture-backed storage mock.
//
// validateMISMOCompleteness pulls all of its inputs from the `storage`
// singleton, which transitively imports `server/db.ts` and requires a live
// DATABASE_URL connection. Mocking the storage module entirely keeps these
// tests hermetic (no DB) and lets each test feed deterministic fixtures.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  fixtures: {
    application: null as any,
    urla: null as any,
    conditions: [] as any[],
    documents: [] as any[],
    profile: null as any,
  },
}));

vi.mock("../server/storage", () => ({
  storage: {
    getLoanApplication: async () => h.fixtures.application,
    getCompleteUrlaData: async () => h.fixtures.urla,
    getLoanConditionsByApplication: async () => h.fixtures.conditions,
    getDocumentsByApplication: async () => h.fixtures.documents,
    getBorrowerProfileByUserId: async () => h.fixtures.profile,
  },
}));

import {
  validateMISMOCompleteness,
  evaluateGseSubmissionReadiness,
} from "../server/services/mismoValidation";

// ---------------------------------------------------------------------------
// Fixture factories — each call returns a fresh, fully-complete object so
// tests can mutate freely without cross-contamination.
// ---------------------------------------------------------------------------
function baseApplication(overrides: Record<string, any> = {}) {
  return {
    id: "app-1",
    userId: "user-1",
    status: "submitted",
    creditScore: 720,
    purchasePrice: "500000",
    downPayment: "100000",
    loanPurpose: "purchase",
    preferredLoanType: "conventional",
    amortizationType: "fixed",
    propertyType: "single_family",
    propertyAddress: "123 Main St",
    propertyCity: "Austin",
    propertyState: "TX",
    propertyZip: "78701",
    ltvRatio: "80",
    dtiRatio: "36",
    ownsOtherRealEstate: false,
    // ARM fields (only relevant when amortizationType === "adjustable")
    armIndexType: null,
    armMargin: null,
    armInitialRate: null,
    armInitialCap: null,
    armPeriodicCap: null,
    armLifetimeCap: null,
    armAdjustmentFrequencyMonths: null,
    // ATR/QM
    totalPointsAndFees: "10000",
    // HMDA LAR
    hmdaActionTaken: "1", // 1 = loan originated/approved
    hmdaDenialReasons: [],
    // TRID dates
    closingDate: null,
    leIssuedDate: null,
    cdIssuedDate: null,
    createdAt: new Date("2026-01-05T00:00:00Z"),
    ...overrides,
  };
}

function completePersonalInfo(overrides: Record<string, any> = {}) {
  return {
    firstName: "Jane",
    lastName: "Borrower",
    // SSN is encrypted at rest; validation reads the masked last-4 fragment.
    ssnLast4: "6789",
    dateOfBirth: "1985-04-12",
    citizenship: "us_citizen",
    maritalStatus: "married",
    email: "jane@example.com",
    cellPhone: "555-0100",
    currentStreet: "123 Main St",
    currentCity: "Austin",
    currentState: "TX",
    currentZip: "78701",
    currentHousingType: "rent",
    ...overrides,
  };
}

function baseUrla(overrides: Record<string, any> = {}) {
  return {
    personalInfo: completePersonalInfo(),
    employmentHistory: [
      {
        employmentType: "current",
        employerName: "Acme Corp",
        positionTitle: "Engineer",
        startDate: "2018-01-01", // > 2 years => no prior employer required
        monthlyIncomeOrLoss: "8000",
        employerPhone: "555-0199",
        employerStreet: "1 Industry Way",
        isSelfEmployed: false,
        borrowerSequenceNumber: 1,
      },
    ],
    otherIncomeSources: [
      { incomeSource: "bonus", monthlyAmount: "500", borrowerSequenceNumber: 1 },
    ],
    assets: [
      {
        accountType: "checking",
        financialInstitution: "Big Bank",
        cashOrMarketValue: "50000",
        borrowerSequenceNumber: 1,
      },
    ],
    liabilities: [
      {
        liabilityType: "credit_card",
        creditorName: "Card Co",
        monthlyPayment: "150",
        unpaidBalance: "2000",
        borrowerSequenceNumber: 1,
      },
    ],
    propertyInfo: {
      propertyStreet: "123 Main St",
      propertyCity: "Austin",
      propertyState: "TX",
      propertyZip: "78701",
      occupancyType: "primary",
      numberOfUnits: 1,
    },
    declarations: {
      willOccupyAsPrimaryResidence: true,
      hasOwnershipInterestInPast3Years: false,
      isBorrowingForDownPayment: false,
      hasOutstandingJudgments: false,
      isDelinquentOnFederalDebt: false,
      isPartyToLawsuit: false,
      hasConveyedTitleInLieuOfForeclosure: false,
      hasBeenForeclosed: false,
      hasDeclaredBankruptcy: false,
      // NOT setting isUSCitizen: no client surface writes it, so a fixture that
      // supplies it describes an application the product cannot produce. That
      // fiction is exactly what hid #448 — the gate required it, every demo and
      // every test handed it over, and no real file ever could.
    },
    realEstateOwned: [],
    hmdaDemographics: [
      {
        borrowerId: "user-1",
        ethnicityNotProvided: true,
        raceNotProvided: true,
        sexNotProvided: true,
        collectionMethod: "visual",
      },
    ],
    ...overrides,
  };
}

function setFixtures(opts: {
  application?: Record<string, any>;
  urla?: Record<string, any>;
  conditions?: any[];
  documents?: any[];
  profile?: any;
} = {}) {
  h.fixtures.application = baseApplication(opts.application ?? {});
  h.fixtures.urla = opts.urla === undefined ? baseUrla() : opts.urla;
  h.fixtures.conditions = opts.conditions ?? [];
  h.fixtures.documents = opts.documents ?? [];
  h.fixtures.profile = opts.profile ?? null;
}

function sectionByNumber(result: any, number: string) {
  return result.sections.find((s: any) => s.sectionNumber === number);
}

beforeEach(() => {
  h.fixtures.application = null;
  h.fixtures.urla = null;
  h.fixtures.conditions = [];
  h.fixtures.documents = [];
  h.fixtures.profile = null;
});

// ---------------------------------------------------------------------------
describe("complete application baseline", () => {
  it("passes gating, has no critical errors, and is QM", async () => {
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");

    expect(result.gseGatingFailed).toBe(false);
    expect(result.criticalErrors).toEqual([]);
    expect(result.qmStatus).toBe("QM");
    expect(result.pointsAndFeesCompliant).toBe(true);
    expect(result.armValidation.applicable).toBe(false);
    expect(result.overallScore).toBeGreaterThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
describe("scoreSection weighting", () => {
  it("scores 0 when every required field in a section is missing", async () => {
    // Empty personal info => all of section 1a's required fields are missing.
    setFixtures({ urla: baseUrla({ personalInfo: undefined }) });
    const result = await validateMISMOCompleteness("app-1");

    const personal = sectionByNumber(result, "1a");
    expect(personal.completeness).toBe(0);
    expect(personal.completedFields).toBe(0);
    expect(personal.missingFields.length).toBe(personal.requiredFields);
  });

  it("scores 80 when all required present but optional missing (0.8 weight)", async () => {
    // Personal info has 2 optional fields (email, cell phone). Filling all
    // required but neither optional => 0.8 required weight only => 80.
    setFixtures({
      urla: baseUrla({
        personalInfo: completePersonalInfo({ email: null, cellPhone: null }),
      }),
    });
    const result = await validateMISMOCompleteness("app-1");

    const personal = sectionByNumber(result, "1a");
    expect(personal.completeness).toBe(80);
    expect(personal.missingFields).toEqual([]); // optional fields aren't "missing"
    expect(personal.warnings.length).toBe(2);
  });

  it("scores 100 when all required and optional fields are present", async () => {
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");
    const personal = sectionByNumber(result, "1a");
    expect(personal.completeness).toBe(100);
  });
});

// ---------------------------------------------------------------------------
describe("GSE gating (hard-fail on sections 1a, 4, 5)", () => {
  it("does not fail gating when 1a, 4, and 5 are complete", async () => {
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");
    expect(result.gseGatingFailed).toBe(false);
  });

  it("hard-fails when section 1a (personal info) has a missing required field", async () => {
    setFixtures({
      urla: baseUrla({ personalInfo: completePersonalInfo({ ssnLast4: null }) }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.gseGatingFailed).toBe(true);
    expect(result.gseReady).toBe(false);
    expect(sectionByNumber(result, "1a").gating).toBe(true);
  });

  it("hard-fails when section 4 (loan details) has a missing required field", async () => {
    setFixtures({ application: { purchasePrice: null } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.gseGatingFailed).toBe(true);
    expect(sectionByNumber(result, "4").gating).toBe(true);
  });

  it("hard-fails when section 5 (declarations) has a missing required field", async () => {
    setFixtures({
      urla: baseUrla({
        declarations: {
          willOccupyAsPrimaryResidence: true,
          hasOwnershipInterestInPast3Years: false,
          isBorrowingForDownPayment: false,
          hasOutstandingJudgments: false,
          isDelinquentOnFederalDebt: false,
          isPartyToLawsuit: false,
          hasConveyedTitleInLieuOfForeclosure: false,
          hasBeenForeclosed: false,
          hasDeclaredBankruptcy: null, // missing required declaration (5b-K)
        },
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.gseGatingFailed).toBe(true);
    expect(sectionByNumber(result, "5").gating).toBe(true);
  });

  // ------------------------------------------------------------------------
  // Regression: section 5 must NOT require a citizenship declaration.
  //
  // `declarations.isUSCitizen` was a required section-5 field that NO client
  // surface has ever written, and section 5 is a gating section — so every real
  // application was permanently blocked from GSE delivery readiness (#448).
  //
  // It survived because every SYNTHETIC path supplied the value the product
  // could not: this file's own fixture set `isUSCitizen: true` (see baseUrla),
  // and server/scripts/seedDemoFile.ts sets `citizenship: "us_citizen"`. Demo
  // files and 2,600 tests passed a gate no genuine file could reach.
  //
  // On the URLA, citizenship is Section 1a, not a Section 5 declaration —
  // section 5 is exactly the eleven questions A–K. The fact is still required,
  // by 1a, which is also gating. These two tests pin both halves so the
  // duplicate cannot come back and the real requirement cannot be dropped.
  // ------------------------------------------------------------------------
  it("does not hard-fail when the eleven declarations are answered but no citizenship declaration exists", async () => {
    setFixtures({
      urla: baseUrla({
        declarations: {
          willOccupyAsPrimaryResidence: true,
          hasOwnershipInterestInPast3Years: false,
          isBorrowingForDownPayment: false,
          hasOutstandingJudgments: false,
          isDelinquentOnFederalDebt: false,
          isPartyToLawsuit: false,
          hasConveyedTitleInLieuOfForeclosure: false,
          hasBeenForeclosed: false,
          hasDeclaredBankruptcy: false,
          // isUSCitizen deliberately absent — this is the shape of EVERY real
          // application, because nothing writes that column.
        },
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(sectionByNumber(result, "5").missingFields).not.toContain("US Citizen Status");
    expect(result.gseGatingFailed).toBe(false);
  });

  it("still hard-fails when section 1a has no citizenship — the requirement moved, it did not vanish", async () => {
    setFixtures({
      urla: baseUrla({ personalInfo: completePersonalInfo({ citizenship: null }) }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(sectionByNumber(result, "1a").missingFields).toContain("Citizenship Status");
    expect(result.gseGatingFailed).toBe(true);
  });

  it("does not hard-fail for a missing field in a non-gating section", async () => {
    // Section 3 (property) is not in the gating set.
    setFixtures({
      application: {
        propertyType: null,
        propertyAddress: null,
        propertyCity: null,
        propertyState: null,
        propertyZip: null,
      },
      urla: baseUrla({ propertyInfo: undefined }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(sectionByNumber(result, "3").missingFields.length).toBeGreaterThan(0);
    expect(result.gseGatingFailed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("TRID business-day math (weekends + federal holidays)", () => {
  it("LE due date skips a weekend and Presidents Day", async () => {
    // Presidents Day 2026 = Mon Feb 16. Six pieces received Thu Feb 12.
    // +1 Fri 13 (1), Sat 14/Sun 15 skip, Mon 16 holiday skip,
    // Tue 17 (2), Wed 18 (3) => LE due Wed Feb 18, 2026.
    setFixtures({ application: { tridTriggeredAt: new Date("2026-02-12T00:00:00Z") } });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.tridStatus.leDueDate).not.toBeNull();
    expect(result.tridStatus.leDueDate!.toISOString().slice(0, 10)).toBe(
      "2026-02-18"
    );
  });

  it("CD due date counts back over a weekend and Juneteenth", async () => {
    // Juneteenth 2026 = Fri Jun 19. Closing Wed Jun 24, CD due 3 business
    // days prior: Tue 23 (1), Mon 22 (2), Sun 21/Sat 20 skip,
    // Fri 19 holiday skip, Thu 18 (3) => CD due Thu Jun 18, 2026.
    setFixtures({ application: { closingDate: "2026-06-24" } });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.tridStatus.cdDueDate).not.toBeNull();
    expect(result.tridStatus.cdDueDate!.toISOString().slice(0, 10)).toBe(
      "2026-06-18"
    );
  });

  it("LE due date over a plain mid-week window skips only the weekend", async () => {
    // Six pieces received Mon Mar 2, 2026 (no holidays that week): +1 Tue (1),
    // Wed (2), Thu (3) => LE due Thu Mar 5, 2026.
    setFixtures({ application: { tridTriggeredAt: new Date("2026-03-02T00:00:00Z") } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.tridStatus.leDueDate!.toISOString().slice(0, 10)).toBe(
      "2026-03-05"
    );
  });

  it("leaves CD due date null when no closing date is set", async () => {
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");
    expect(result.tridStatus.cdDueDate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("ATR/QM points-and-fees 3% cap", () => {
  // loanAmount = 500000 - 100000 = 400000.
  //
  // The cap is 3% of the Regulation Z TOTAL LOAN AMOUNT, not of the note
  // amount (§1026.32(b)(4)) — the note amount less the financed points and
  // fees. With no compensation elected the platform's known prepaid finance
  // charges are $500 app + $1,500 underwriting + $100 tax service = $2,100, so
  // the basis is $397,900 and the cap is $11,937 — NOT the $12,000 the old
  // note-amount stand-in produced (audit F-12: that stand-in was permissive,
  // never conservative).
  const QM_CAP = 11_937;

  it("is QM exactly at the 3% cap (boundary inclusive)", async () => {
    setFixtures({ application: { totalPointsAndFees: String(QM_CAP) } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.qmStatus).toBe("QM");
    expect(result.pointsAndFeesCompliant).toBe(true);
  });

  it("is tighter than the old note-amount cap (F-12)", async () => {
    // $11,950 fit under the discarded $12,000 note-amount cap and does not fit
    // under the real one. This is the file the old check waved through.
    setFixtures({ application: { totalPointsAndFees: "11950" } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.qmStatus).toBe("Non-QM");
    expect(result.pointsAndFeesCompliant).toBe(false);
  });

  it("is Non-QM just over the 3% cap", async () => {
    setFixtures({ application: { totalPointsAndFees: String(QM_CAP + 0.01) } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.qmStatus).toBe("Non-QM");
    expect(result.pointsAndFeesCompliant).toBe(false);
    expect(result.gseReady).toBe(false);
  });

  it("is Unknown when points-and-fees is not provided", async () => {
    setFixtures({ application: { totalPointsAndFees: null } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.qmStatus).toBe("Unknown");
    expect(result.pointsAndFeesCompliant).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Fallback to the computed floor when the closing-side figure is absent.
  // `totalPointsAndFees` is never written by any product code path, so this
  // fallback is the check that actually runs on a live file.
  // -------------------------------------------------------------------------

  it("warns rather than silently passing when no figure and no comp election exist", async () => {
    setFixtures({
      application: { totalPointsAndFees: null, loCompensationModel: null, loCompensationBps: null },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.qmStatus).toBe("Unknown");
    expect(result.warnings.some(w => /no loan originator compensation elected/i.test(w))).toBe(true);
  });

  it("blocks on the computed floor when comp pushes the file over the cap", async () => {
    // 400k loan, 3% cap = 12,000. Compensation ALONE has to breach it: since
    // the F-17 fee fit trims the platform's own charges to fit, a rate that
    // merely crowds them out no longer blocks — it just costs us fee revenue.
    // 320 bps = 12,800, above the entire cap, so no fee decision rescues it.
    setFixtures({
      application: {
        totalPointsAndFees: null,
        loCompensationModel: "lender_paid",
        loCompensationBps: 320,
      },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.qmStatus).toBe("Non-QM");
    expect(result.pointsAndFeesCompliant).toBe(false);
    expect(result.gseReady).toBe(false);
    expect(result.criticalErrors.some(e => /exceed the QM cap/i.test(e))).toBe(true);
  });

  it("warns — never passes clean — when the floor fits under the cap", async () => {
    setFixtures({
      application: {
        totalPointsAndFees: null,
        loCompensationModel: "lender_paid",
        loCompensationBps: 200,
      },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.qmStatus).toBe("Unknown");
    expect(result.criticalErrors.some(e => /ATR\/QM/.test(e))).toBe(false);
    expect(result.warnings.some(w => /lower bound/i.test(w))).toBe(true);
  });

  it("prefers the authoritative figure over the floor when both are available", async () => {
    setFixtures({
      application: {
        totalPointsAndFees: "11900", // under the $11,937 Reg Z cap
        loCompensationModel: "lender_paid",
        loCompensationBps: 275, // floor would be over the cap; the real figure is not
      },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.qmStatus).toBe("QM");
    expect(result.pointsAndFeesCompliant).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("ARM required-field validation", () => {
  const ARM_FIELDS = {
    armIndexType: "SOFR",
    armMargin: "2.75",
    armInitialRate: "5.5",
    armInitialCap: "2",
    armPeriodicCap: "1",
    armLifetimeCap: "5",
    armAdjustmentFrequencyMonths: 12,
  };

  it("is not applicable for fixed-rate loans", async () => {
    setFixtures({ application: { amortizationType: "fixed" } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.armValidation.applicable).toBe(false);
    expect(result.armValidation.valid).toBe(true);
    expect(result.armValidation.issues).toEqual([]);
  });

  it("flags every missing ARM field on an adjustable-rate loan", async () => {
    setFixtures({ application: { amortizationType: "adjustable" } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.armValidation.applicable).toBe(true);
    expect(result.armValidation.valid).toBe(false);
    expect(result.armValidation.issues.length).toBe(7);
  });

  it("is valid when all ARM fields are provided", async () => {
    setFixtures({
      application: { amortizationType: "adjustable", ...ARM_FIELDS },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.armValidation.applicable).toBe(true);
    expect(result.armValidation.valid).toBe(true);
    expect(result.armValidation.issues).toEqual([]);
  });

  it("flags only the single missing ARM field", async () => {
    const partial = { ...ARM_FIELDS, armMargin: null };
    setFixtures({
      application: { amortizationType: "adjustable", ...partial },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.armValidation.valid).toBe(false);
    expect(result.armValidation.issues.length).toBe(1);
    expect(result.armValidation.issues[0]).toMatch(/margin/i);
  });
});

// ---------------------------------------------------------------------------
describe("HMDA LAR denial-reason rules", () => {
  it("requires action-taken to be provided", async () => {
    setFixtures({ application: { hmdaActionTaken: null } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.hmdaLar.actionTakenProvided).toBe(false);
    expect(result.hmdaLar.issues.join(" ")).toMatch(/action-taken/i);
  });

  it("does not require denial reasons when the loan is approved", async () => {
    setFixtures({ application: { hmdaActionTaken: "1", hmdaDenialReasons: [] } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.hmdaLar.denialReasonsValid).toBe(true);
  });

  it("is invalid when denied with fewer than 2 denial reasons", async () => {
    setFixtures({
      application: { hmdaActionTaken: "3", hmdaDenialReasons: ["dti"] },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.hmdaLar.denialReasonsValid).toBe(false);
    expect(result.hmdaLar.issues.join(" ")).toMatch(/2 denial reasons/i);
  });

  it("is valid when denied with at least 2 denial reasons", async () => {
    setFixtures({
      application: {
        hmdaActionTaken: "3",
        hmdaDenialReasons: ["dti", "credit_history"],
      },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.hmdaLar.denialReasonsValid).toBe(true);
  });

  it("detects denial via the textual action-taken value", async () => {
    setFixtures({
      application: {
        hmdaActionTaken: "Application Denied",
        hmdaDenialReasons: ["dti"],
      },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.hmdaLar.denialReasonsValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Additional section-scorer fixtures (employment, military, demographics,
// and the conditional asset/liability/REO detail rules).
// ---------------------------------------------------------------------------
function currentJob(startDate: string, overrides: Record<string, any> = {}) {
  return {
    employmentType: "current",
    employerName: "Acme Corp",
    positionTitle: "Engineer",
    startDate,
    monthlyIncomeOrLoss: "8000",
    employerPhone: "555-0199",
    employerStreet: "1 Industry Way",
    isSelfEmployed: false,
    borrowerSequenceNumber: 1,
    ...overrides,
  };
}

function priorJob(overrides: Record<string, any> = {}) {
  return {
    employmentType: "previous",
    employerName: "Old Co",
    positionTitle: "Analyst",
    startDate: "2015-01-01",
    endDate: "2017-12-31",
    monthlyIncomeOrLoss: "6000",
    borrowerSequenceNumber: 1,
    ...overrides,
  };
}

function militaryProfile(overrides: Record<string, any> = {}) {
  return {
    militaryStatus: "veteran",
    militaryBranch: "army",
    militaryServiceStart: "2005-01-01",
    vaEntitlementUsed: false,
    vaFundingFeeExempt: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe("employment 2-year-history rule (section 1b-1e)", () => {
  it("does not require a prior employer when the current job exceeds 2 years", async () => {
    setFixtures({ urla: baseUrla({ employmentHistory: [currentJob("2020-01-01")] }) });
    const result = await validateMISMOCompleteness("app-1");
    const emp = sectionByNumber(result, "1b-1e");
    expect(emp.missingFields).toEqual([]);
  });

  it("requires prior-employer fields when the current job is under 2 years old", async () => {
    setFixtures({ urla: baseUrla({ employmentHistory: [currentJob("2025-06-01")] }) });
    const result = await validateMISMOCompleteness("app-1");
    const emp = sectionByNumber(result, "1b-1e");
    expect(emp.missingFields).toEqual(
      expect.arrayContaining([
        "Prior Employer Name (2-year history required)",
        "Prior Employer Start Date",
        "Prior Employer End Date",
      ])
    );
  });

  it("is satisfied when a short current job is paired with a complete prior employer", async () => {
    setFixtures({
      urla: baseUrla({ employmentHistory: [currentJob("2025-06-01"), priorJob()] }),
    });
    const result = await validateMISMOCompleteness("app-1");
    const emp = sectionByNumber(result, "1b-1e");
    expect(emp.missingFields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("VA-loan military-service requirement (section 6)", () => {
  it("does not require military fields for a non-VA loan", async () => {
    // conventional loan + no profile => section 6 fields are optional.
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");
    const military = sectionByNumber(result, "6");
    expect(military.missingFields).toEqual([]);
  });

  it("requires military fields when the loan type is VA but no profile exists", async () => {
    setFixtures({ application: { preferredLoanType: "va" }, profile: null });
    const result = await validateMISMOCompleteness("app-1");
    const military = sectionByNumber(result, "6");
    expect(military.missingFields).toEqual(
      expect.arrayContaining([
        "Military Service Status",
        "Service Branch",
        "VA Entitlement / Funding Fee Status",
      ])
    );
  });

  it("is satisfied for a VA loan once the military profile is complete", async () => {
    setFixtures({ application: { preferredLoanType: "va" }, profile: militaryProfile() });
    const result = await validateMISMOCompleteness("app-1");
    const military = sectionByNumber(result, "6");
    expect(military.missingFields).toEqual([]);
  });

  it("treats VA detection as case-insensitive", async () => {
    setFixtures({ application: { preferredLoanType: "VA" }, profile: null });
    const result = await validateMISMOCompleteness("app-1");
    const military = sectionByNumber(result, "6");
    expect(military.missingFields.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("demographics refusal-recorded logic (section 7 / Reg C)", () => {
  it("counts recorded refusals (not-provided flags) as collected", async () => {
    // baseline uses ethnicity/race/sex not-provided flags.
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");
    const demo = sectionByNumber(result, "7");
    expect(demo.missingFields).toEqual([]);
  });

  it("counts affirmatively selected values as collected", async () => {
    setFixtures({
      urla: baseUrla({
        hmdaDemographics: [
          {
            borrowerId: "user-1",
            ethnicityHispanicLatino: true,
            raceWhite: true,
            sexFemale: true,
            collectionMethod: "visual",
          },
        ],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    const demo = sectionByNumber(result, "7");
    expect(demo.missingFields).toEqual([]);
  });

  it("flags ethnicity/race/sex as missing when nothing is recorded", async () => {
    setFixtures({
      urla: baseUrla({
        hmdaDemographics: [{ borrowerId: "user-1", collectionMethod: "visual" }],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    const demo = sectionByNumber(result, "7");
    expect(demo.missingFields).toEqual(
      expect.arrayContaining([
        "Ethnicity collected (or refusal recorded)",
        "Race collected (or refusal recorded)",
        "Sex collected (or refusal recorded)",
      ])
    );
  });

  it("flags collection method as missing when no demographic row exists", async () => {
    setFixtures({ urla: baseUrla({ hmdaDemographics: [] }) });
    const result = await validateMISMOCompleteness("app-1");
    const demo = sectionByNumber(result, "7");
    expect(demo.missingFields).toContain("Collection Method");
  });
});

// ---------------------------------------------------------------------------
describe("conditional asset detail requirements (section 2a)", () => {
  it("flags the no-asset state when no asset rows are present", async () => {
    setFixtures({ urla: baseUrla({ assets: [] }) });
    const result = await validateMISMOCompleteness("app-1");
    const assets = sectionByNumber(result, "2a");
    expect(assets.missingFields).toEqual(
      expect.arrayContaining(["At least one asset account", "Total Assets > $0"])
    );
  });

  it("requires detail fields once an asset row is present", async () => {
    setFixtures({
      urla: baseUrla({
        assets: [
          {
            accountType: null,
            financialInstitution: "Big Bank",
            cashOrMarketValue: "50000",
            borrowerSequenceNumber: 1,
          },
        ],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    const assets = sectionByNumber(result, "2a");
    expect(assets.missingFields).toContain("Account Type");
  });
});

// ---------------------------------------------------------------------------
describe("conditional liability detail requirements (section 2b)", () => {
  it("is satisfied with no liabilities reported", async () => {
    setFixtures({ urla: baseUrla({ liabilities: [] }) });
    const result = await validateMISMOCompleteness("app-1");
    const liabilities = sectionByNumber(result, "2b");
    expect(liabilities.missingFields).toEqual([]);
  });

  it("requires type and monthly payment once a liability row is present", async () => {
    setFixtures({
      urla: baseUrla({
        liabilities: [
          {
            liabilityType: null,
            creditorName: "Card Co",
            monthlyPayment: null,
            unpaidBalance: "2000",
            borrowerSequenceNumber: 1,
          },
        ],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    const liabilities = sectionByNumber(result, "2b");
    expect(liabilities.missingFields).toEqual(
      expect.arrayContaining(["Liability Type", "Monthly Payment"])
    );
  });

  it("does not require the optional creditor name / unpaid balance", async () => {
    setFixtures({
      urla: baseUrla({
        liabilities: [
          {
            liabilityType: "credit_card",
            creditorName: null,
            monthlyPayment: "150",
            unpaidBalance: null,
            borrowerSequenceNumber: 1,
          },
        ],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    const liabilities = sectionByNumber(result, "2b");
    expect(liabilities.missingFields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("conditional real-estate-owned detail requirements (section 2c)", () => {
  it("is satisfied when no property is owned", async () => {
    setFixtures({ urla: baseUrla({ realEstateOwned: [] }) });
    const result = await validateMISMOCompleteness("app-1");
    const reo = sectionByNumber(result, "2c");
    expect(reo.missingFields).toEqual([]);
  });

  it("does not treat an unanswered ownership question as a completed disclosure", async () => {
    setFixtures({
      application: { ownsOtherRealEstate: null },
      urla: baseUrla({ realEstateOwned: [] }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(sectionByNumber(result, "2c").missingFields).toContain("Real estate ownership reviewed");
  });

  it("requires every REO detail field once a property is listed", async () => {
    setFixtures({
      application: { ownsOtherRealEstate: true },
      urla: baseUrla({
        realEstateOwned: [
          {
            propertyAddress: "456 Rental Rd",
            marketValue: null,
            mortgageBalance: null,
            status: null,
            occupancyType: null,
          },
        ],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    const reo = sectionByNumber(result, "2c");
    expect(reo.missingFields).toEqual(
      expect.arrayContaining([
        "REO #1 Market Value",
        "REO #1 Mortgage Balance",
        "REO #1 Occupancy/Status",
      ])
    );
  });
});

// ---------------------------------------------------------------------------
// Co-applicant scoring (borrowerSequenceNumber > 1) and the
// coApplicantLimitation note.
// ---------------------------------------------------------------------------
function coEmployment(overrides: Record<string, any> = {}) {
  return {
    employmentType: "current",
    employerName: "Co Corp",
    positionTitle: "Manager",
    startDate: "2017-01-01", // > 2 years => no prior employer required
    monthlyIncomeOrLoss: "7000",
    employerPhone: "555-0200",
    employerStreet: "2 Commerce Blvd",
    isSelfEmployed: false,
    borrowerSequenceNumber: 2,
    ...overrides,
  };
}

function coAsset(overrides: Record<string, any> = {}) {
  return {
    accountType: "savings",
    financialInstitution: "Co Bank",
    cashOrMarketValue: "30000",
    borrowerSequenceNumber: 2,
    ...overrides,
  };
}

function coLiability(overrides: Record<string, any> = {}) {
  return {
    liabilityType: "auto_loan",
    creditorName: "Auto Co",
    monthlyPayment: "300",
    unpaidBalance: "10000",
    borrowerSequenceNumber: 2,
    ...overrides,
  };
}

function coDemographic(overrides: Record<string, any> = {}) {
  // Demographic rows are stored with the application owner's borrowerId for
  // every borrower; the per-person discriminator is borrowerSequenceNumber.
  return {
    borrowerId: "user-1",
    borrowerSequenceNumber: 2,
    ethnicityNotProvided: true,
    raceNotProvided: true,
    sexNotProvided: true,
    collectionMethod: "visual",
    ...overrides,
  };
}

// Builds a URLA fixture that includes a complete primary borrower plus an
// optional set of co-applicant (seq > 1) rows, layered onto the baseline.
function urlaWithCoApplicant(co: {
  employment?: any[];
  assets?: any[];
  liabilities?: any[];
  hmda?: any[];
  personalInfo?: Record<string, any>;
} = {}) {
  const base = baseUrla();
  return baseUrla({
    personalInfo: completePersonalInfo(co.personalInfo ?? {}),
    employmentHistory: [...base.employmentHistory, ...(co.employment ?? [coEmployment()])],
    assets: [...base.assets, ...(co.assets ?? [coAsset()])],
    liabilities: [...base.liabilities, ...(co.liabilities ?? [coLiability()])],
    hmdaDemographics: [...base.hmdaDemographics, ...(co.hmda ?? [coDemographic()])],
  });
}

describe("co-applicant scoring (borrowerSequenceNumber > 1)", () => {
  it("creates a coApplicants entry with its own section scores", async () => {
    setFixtures({ urla: urlaWithCoApplicant() });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.coApplicants.length).toBe(1);
    const co = result.coApplicants[0];
    expect(co.borrowerSequenceNumber).toBe(2);
    // Independently scored sections: employment, assets, liabilities, demographics.
    expect(co.sections.map((s: any) => s.sectionNumber)).toEqual([
      "1b-1e",
      "2a",
      "2b",
      "7",
    ]);
    // No required fields are missing in any co-applicant section.
    co.sections.forEach((s: any) => {
      expect(s.missingFields).toEqual([]);
      expect(s.completeness).toBeGreaterThanOrEqual(90);
    });
    // Assets, liabilities, and demographics have no optional gaps => 100.
    expect(
      co.sections.find((s: any) => s.sectionNumber === "2a").completeness
    ).toBe(100);
  });

  it("scores the co-applicant's sections independently of the primary borrower", async () => {
    // Primary borrower stays complete; only the co-applicant employment is broken.
    setFixtures({
      urla: urlaWithCoApplicant({
        employment: [coEmployment({ employerName: null, positionTitle: null })],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");

    // Primary employment is untouched and complete.
    const primaryEmp = sectionByNumber(result, "1b-1e");
    expect(primaryEmp.missingFields).toEqual([]);

    // The co-applicant's employment section reflects the missing fields.
    const coEmp = result.coApplicants[0].sections.find(
      (s: any) => s.sectionNumber === "1b-1e"
    );
    expect(coEmp.missingFields).toEqual(
      expect.arrayContaining(["Employer Name", "Position/Title"])
    );
    expect(coEmp.completeness).toBeLessThan(100);
  });

  it("detects a co-applicant from any single seq>1 row type (assets only)", async () => {
    const base = baseUrla();
    setFixtures({
      urla: baseUrla({
        assets: [...base.assets, coAsset()],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.coApplicants.length).toBe(1);
    expect(result.coApplicants[0].borrowerSequenceNumber).toBe(2);
  });

  it("scores multiple co-applicants, sorted by sequence number", async () => {
    const base = baseUrla();
    setFixtures({
      urla: baseUrla({
        employmentHistory: [
          ...base.employmentHistory,
          coEmployment({ borrowerSequenceNumber: 3 }),
          coEmployment({ borrowerSequenceNumber: 2 }),
        ],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.coApplicants.map((c: any) => c.borrowerSequenceNumber)).toEqual([
      2, 3,
    ]);
  });
});

describe("co-applicant demographics match by sequence (sparse / out-of-order)", () => {
  // A bare demographic row with only a collection method recorded — no
  // ethnicity / race / sex — so its section is provably incomplete.
  function incompleteDemographic(seq: number) {
    return {
      borrowerId: "user-1",
      borrowerSequenceNumber: seq,
      collectionMethod: "visual",
    };
  }

  it("matches a sparse co-borrower (#3 only) to its own demographic row", async () => {
    // Only co-borrower #3 exists (no #2). Positional matching (coHmda[seq-2])
    // would read coHmda[1] === undefined and mis-score the section as empty;
    // sequence matching must find the seq-3 row.
    const base = baseUrla();
    setFixtures({
      urla: baseUrla({
        hmdaDemographics: [
          ...base.hmdaDemographics, // primary, seq 1
          coDemographic({ borrowerSequenceNumber: 3 }), // complete, seq 3
        ],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.coApplicants.map((c: any) => c.borrowerSequenceNumber)).toEqual([
      3,
    ]);
    const demo = result.coApplicants[0].sections.find(
      (s: any) => s.sectionNumber === "7"
    );
    expect(demo.missingFields).toEqual([]);
    expect(demo.completeness).toBe(100);
  });

  it("matches out-of-order demographic rows to the right co-borrower, not by array position", async () => {
    // Demographic rows are listed seq 3 BEFORE seq 2, and the two people have
    // different completeness: #3 is complete, #2 is incomplete. Positional
    // matching would swap them (read coHmda[0] for #2 and coHmda[1] for #3);
    // sequence matching must attribute each row to the right person.
    const base = baseUrla();
    setFixtures({
      urla: baseUrla({
        hmdaDemographics: [
          ...base.hmdaDemographics, // primary, seq 1
          coDemographic({ borrowerSequenceNumber: 3 }), // complete, listed first
          incompleteDemographic(2), // incomplete, listed second
        ],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");

    const co2 = result.coApplicants.find((c: any) => c.borrowerSequenceNumber === 2);
    const co3 = result.coApplicants.find((c: any) => c.borrowerSequenceNumber === 3);
    const demo2 = co2.sections.find((s: any) => s.sectionNumber === "7");
    const demo3 = co3.sections.find((s: any) => s.sectionNumber === "7");

    // #2's row is incomplete, #3's row is complete — proving each person's
    // demographics are read by sequence number rather than list order.
    expect(demo2.missingFields).toEqual(
      expect.arrayContaining([
        "Ethnicity collected (or refusal recorded)",
        "Race collected (or refusal recorded)",
        "Sex collected (or refusal recorded)",
      ])
    );
    expect(demo3.missingFields).toEqual([]);
  });
});

describe("co-applicant missing fields surface into criticalErrors", () => {
  it("prefixes co-applicant errors with 'Co-applicant #N <section>'", async () => {
    setFixtures({
      urla: urlaWithCoApplicant({
        employment: [coEmployment({ employerName: null })],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.criticalErrors).toContain(
      "Co-applicant #2 Employment & Income: Employer Name is required"
    );
  });

  it("does not emit co-applicant errors when the co-applicant is complete", async () => {
    setFixtures({ urla: urlaWithCoApplicant() });
    const result = await validateMISMOCompleteness("app-1");

    expect(
      result.criticalErrors.filter((e: string) => e.startsWith("Co-applicant #"))
    ).toEqual([]);
  });

  it("uses the co-applicant's own sequence number in the prefix", async () => {
    const base = baseUrla();
    setFixtures({
      urla: baseUrla({
        assets: [
          ...base.assets,
          coAsset({ borrowerSequenceNumber: 3, accountType: null }),
        ],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.criticalErrors).toContain(
      "Co-applicant #3 Assets & Accounts: Account Type is required"
    );
  });
});

describe("co-applicant name resolution", () => {
  it("populates the co-applicant name from allPersonalInfo by sequence number", async () => {
    const fixture = urlaWithCoApplicant();
    fixture.allPersonalInfo = [
      completePersonalInfo({ borrowerSequenceNumber: 1 }),
      completePersonalInfo({
        firstName: "Sam",
        lastName: "Cobright",
        borrowerSequenceNumber: 2,
      }),
    ];
    setFixtures({ urla: fixture });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.coApplicants.length).toBe(1);
    expect(result.coApplicants[0].name).toBe("Sam Cobright");
  });

  it("includes the co-applicant name in critical-error prefixes when known", async () => {
    const fixture = urlaWithCoApplicant({
      employment: [coEmployment({ employerName: null })],
    });
    fixture.allPersonalInfo = [
      completePersonalInfo({ borrowerSequenceNumber: 1 }),
      completePersonalInfo({
        firstName: "Sam",
        lastName: "Cobright",
        borrowerSequenceNumber: 2,
      }),
    ];
    setFixtures({ urla: fixture });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.criticalErrors).toContain(
      "Co-applicant #2 (Sam Cobright) Employment & Income: Employer Name is required"
    );
  });

  it("falls back to a bare label when no co-applicant name is stored", async () => {
    setFixtures({
      urla: urlaWithCoApplicant({
        employment: [coEmployment({ employerName: null })],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");

    expect(result.coApplicants[0].name).toBeNull();
    expect(result.criticalErrors).toContain(
      "Co-applicant #2 Employment & Income: Employer Name is required"
    );
  });
});

describe("coApplicantLimitation note", () => {
  it("is null when no co-borrower is declared and no co-applicant rows exist", async () => {
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");
    expect(result.coApplicantLimitation).toBeNull();
  });

  it("is set when profile.hasCoBorrower is true but no co-applicant rows exist", async () => {
    setFixtures({ profile: { hasCoBorrower: true } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.coApplicantLimitation).not.toBeNull();
    expect(result.coApplicantLimitation).toMatch(/co-borrower is indicated/i);
  });

  it("is set when personalInfo.coBorrowerNames is present but no co-applicant rows exist", async () => {
    setFixtures({
      urla: baseUrla({
        personalInfo: completePersonalInfo({ coBorrowerNames: "John Co-Borrower" }),
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.coApplicantLimitation).not.toBeNull();
  });

  it("is set when personalInfo.totalBorrowers > 1 but no co-applicant rows exist", async () => {
    setFixtures({
      urla: baseUrla({
        personalInfo: completePersonalInfo({ totalBorrowers: 2 }),
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.coApplicantLimitation).not.toBeNull();
  });

  it("stays null when a co-borrower is declared AND co-applicant rows exist", async () => {
    setFixtures({
      profile: { hasCoBorrower: true },
      urla: urlaWithCoApplicant({
        personalInfo: { totalBorrowers: 2, coBorrowerNames: "John Co-Borrower" },
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.coApplicants.length).toBe(1);
    expect(result.coApplicantLimitation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Top-level readiness assembly: missingDocuments, gseReady, ulddCompliant,
// and the TRID leRequired/cdRequired status flags.
// ---------------------------------------------------------------------------

// A fully-complete VA application with a complete military profile scores 97
// (>= 90), passes gating, has no critical errors, is QM, and has a valid
// (not-applicable) ARM check -- i.e. the only fixture that satisfies every
// gseReady precondition out of the box. Toggling any single input flips it.
function gseReadyOpts(extra: Record<string, any> = {}) {
  return {
    application: { preferredLoanType: "va", ...(extra.application ?? {}) },
    profile: extra.profile ?? militaryProfile(),
    urla: extra.urla,
    conditions: extra.conditions,
    documents: extra.documents,
  };
}

describe("missingDocuments derivation (outstanding conditions vs uploads)", () => {
  it("has no missing documents when there are no conditions", async () => {
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");
    expect(result.missingDocuments).toEqual([]);
  });

  it("lists required doc types from an outstanding condition with nothing uploaded", async () => {
    setFixtures({
      conditions: [
        { status: "outstanding", requiredDocumentTypes: ["paystub", "w2"] },
      ],
      documents: [],
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.missingDocuments).toEqual(
      expect.arrayContaining(["paystub", "w2"])
    );
    expect(result.missingDocuments.length).toBe(2);
  });

  it("clears a required doc type once a matching document is uploaded", async () => {
    setFixtures({
      conditions: [
        { status: "outstanding", requiredDocumentTypes: ["paystub", "w2"] },
      ],
      documents: [{ documentType: "paystub" }, { documentType: "w2" }],
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.missingDocuments).toEqual([]);
  });

  it("returns only the types that are still un-uploaded", async () => {
    setFixtures({
      conditions: [
        { status: "outstanding", requiredDocumentTypes: ["paystub", "w2", "bank_statement"] },
      ],
      documents: [{ documentType: "paystub" }],
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.missingDocuments).toEqual(
      expect.arrayContaining(["w2", "bank_statement"])
    );
    expect(result.missingDocuments).not.toContain("paystub");
  });

  it("ignores doc types required by non-outstanding (e.g. cleared) conditions", async () => {
    setFixtures({
      conditions: [
        { status: "cleared", requiredDocumentTypes: ["appraisal"] },
        { status: "waived", requiredDocumentTypes: ["gift_letter"] },
      ],
      documents: [],
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.missingDocuments).toEqual([]);
  });

  it("de-duplicates a doc type required by multiple outstanding conditions", async () => {
    setFixtures({
      conditions: [
        { status: "outstanding", requiredDocumentTypes: ["paystub"] },
        { status: "outstanding", requiredDocumentTypes: ["paystub", "w2"] },
      ],
      documents: [],
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.missingDocuments.filter(d => d === "paystub").length).toBe(1);
    expect(result.missingDocuments).toEqual(
      expect.arrayContaining(["paystub", "w2"])
    );
    expect(result.missingDocuments.length).toBe(2);
  });

  it("treats a condition with no requiredDocumentTypes as contributing nothing", async () => {
    setFixtures({
      conditions: [{ status: "outstanding", requiredDocumentTypes: null }],
      documents: [],
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.missingDocuments).toEqual([]);
  });
});

describe("gseReady (every precondition must hold)", () => {
  it("is true when score >= 90, gating passes, no errors, no missing docs, ARM valid, and QM", async () => {
    setFixtures(gseReadyOpts());
    const result = await validateMISMOCompleteness("app-1");
    expect(result.overallScore).toBeGreaterThanOrEqual(90);
    expect(result.gseGatingFailed).toBe(false);
    expect(result.criticalErrors).toEqual([]);
    expect(result.missingDocuments).toEqual([]);
    expect(result.armValidation.valid).toBe(true);
    expect(result.pointsAndFeesCompliant).toBe(true);
    expect(result.gseReady).toBe(true);
  });

  it("is false when the score is below 90 even if everything else passes", async () => {
    // Baseline conventional app scores 88: no gating fail, no critical errors,
    // no missing docs, QM, ARM not applicable -- the score gate alone blocks it.
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");
    expect(result.overallScore).toBeLessThan(90);
    expect(result.gseGatingFailed).toBe(false);
    expect(result.criticalErrors).toEqual([]);
    expect(result.missingDocuments).toEqual([]);
    expect(result.gseReady).toBe(false);
  });

  it("is false when an outstanding condition leaves a document missing", async () => {
    setFixtures(
      gseReadyOpts({
        conditions: [{ status: "outstanding", requiredDocumentTypes: ["paystub"] }],
        documents: [],
      })
    );
    const result = await validateMISMOCompleteness("app-1");
    expect(result.overallScore).toBeGreaterThanOrEqual(90);
    expect(result.missingDocuments).toEqual(["paystub"]);
    expect(result.gseReady).toBe(false);
  });

  it("is false when a critical error exists despite passing gating and score", async () => {
    // A null account type in section 2a (non-gating) raises a critical error
    // without failing gating; score stays >= 90 via the VA fixture.
    setFixtures(
      gseReadyOpts({
        urla: baseUrla({
          assets: [
            {
              accountType: null,
              financialInstitution: "Big Bank",
              cashOrMarketValue: "50000",
              borrowerSequenceNumber: 1,
            },
          ],
          hmdaDemographics: [
            {
              borrowerId: "user-1",
              ethnicityNotProvided: true,
              raceNotProvided: true,
              sexNotProvided: true,
              collectionMethod: "visual",
            },
          ],
        }),
      })
    );
    const result = await validateMISMOCompleteness("app-1");
    expect(result.overallScore).toBeGreaterThanOrEqual(90);
    expect(result.gseGatingFailed).toBe(false);
    expect(result.criticalErrors.length).toBeGreaterThan(0);
    expect(result.gseReady).toBe(false);
  });

  it("is false when the loan is ARM but required ARM fields are missing", async () => {
    setFixtures(gseReadyOpts({ application: { amortizationType: "adjustable" } }));
    const result = await validateMISMOCompleteness("app-1");
    expect(result.armValidation.applicable).toBe(true);
    expect(result.armValidation.valid).toBe(false);
    expect(result.gseReady).toBe(false);
  });

  it("is false when points-and-fees push the loan to Non-QM", async () => {
    setFixtures(gseReadyOpts({ application: { totalPointsAndFees: "99999" } }));
    const result = await validateMISMOCompleteness("app-1");
    expect(result.pointsAndFeesCompliant).toBe(false);
    expect(result.gseReady).toBe(false);
  });
});

describe("ulddCompliant thresholds", () => {
  it("is true at the baseline (score >= 80, no gating, 1a >= 90, loan >= 90)", async () => {
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");
    expect(result.overallScore).toBeGreaterThanOrEqual(80);
    expect(result.gseGatingFailed).toBe(false);
    expect(sectionByNumber(result, "1a").completeness).toBeGreaterThanOrEqual(90);
    expect(sectionByNumber(result, "4").completeness).toBeGreaterThanOrEqual(90);
    expect(result.ulddCompliant).toBe(true);
  });

  it("is false when gating fails", async () => {
    setFixtures({ urla: baseUrla({ personalInfo: completePersonalInfo({ ssnLast4: null }) }) });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.gseGatingFailed).toBe(true);
    expect(result.ulddCompliant).toBe(false);
  });

  it("is false when personal info (1a) drops below 90 via missing optional fields", async () => {
    // Dropping both optional personal fields leaves 1a at 80 without failing
    // gating (required fields are still present) -- isolates the 1a >= 90 gate.
    setFixtures({
      urla: baseUrla({ personalInfo: completePersonalInfo({ email: null, cellPhone: null }) }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.gseGatingFailed).toBe(false);
    expect(sectionByNumber(result, "1a").completeness).toBeLessThan(90);
    expect(result.overallScore).toBeGreaterThanOrEqual(80);
    expect(result.ulddCompliant).toBe(false);
  });

  it("is false when loan details (4) drop below 90 via missing optional fields", async () => {
    // LTV and DTI are the two optional loan fields; dropping both leaves
    // section 4 at 80 without failing gating -- isolates the loan >= 90 gate.
    setFixtures({ application: { ltvRatio: null, dtiRatio: null } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.gseGatingFailed).toBe(false);
    expect(sectionByNumber(result, "4").completeness).toBeLessThan(90);
    expect(result.overallScore).toBeGreaterThanOrEqual(80);
    expect(result.ulddCompliant).toBe(false);
  });

  it("is false when the overall score falls below 80", async () => {
    // Strip several non-gating sections (employment, other income, assets,
    // liabilities) to pull the average under 80 while keeping 1a/4/5 intact.
    setFixtures({
      urla: baseUrla({
        employmentHistory: [],
        otherIncomeSources: [],
        assets: [],
        liabilities: [],
        hmdaDemographics: [],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.overallScore).toBeLessThan(80);
    expect(result.ulddCompliant).toBe(false);
  });
});

describe("TRID leRequired / cdRequired status flags", () => {
  it("requires neither LE nor CD before the six-piece trigger fires", async () => {
    // Status alone never starts the LE clock — only the §1026.2(a)(3)
    // trigger (tridTriggeredAt, written by services/trid.ts) does.
    setFixtures({ application: { status: "submitted", tridTriggeredAt: null } });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.tridStatus.leRequired).toBe(false);
    expect(result.tridStatus.leDueDate).toBeNull();
    expect(result.tridStatus.cdRequired).toBe(false);
  });

  it("requires the LE once the six-piece trigger has fired", async () => {
    setFixtures({
      application: { status: "submitted", tridTriggeredAt: new Date("2026-03-02T00:00:00Z") },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.tridStatus.leRequired).toBe(true);
    expect(result.tridStatus.cdRequired).toBe(false);
  });

  it("requires both the LE and the CD at clear-to-close", async () => {
    setFixtures({
      application: { status: "clear_to_close", tridTriggeredAt: new Date("2026-03-02T00:00:00Z") },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.tridStatus.leRequired).toBe(true);
    expect(result.tridStatus.cdRequired).toBe(true);
  });

  it("reflects leIssued / cdIssued from the application's issued dates", async () => {
    setFixtures({
      application: {
        status: "clear_to_close",
        leIssuedDate: new Date("2026-01-08T00:00:00Z"),
        cdIssuedDate: null,
      },
    });
    const result = await validateMISMOCompleteness("app-1");
    expect(result.tridStatus.leIssued).toBe(true);
    expect(result.tridStatus.cdIssued).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// submit-gse 422 gate (server/routes/aus.ts): evaluateGseSubmissionReadiness
// is the pure decision the route calls before handing a casefile to Fannie DU.
// Driven through the real validator here so these double as regression tests
// for "an incomplete URLA must not reach the GSE."
// ---------------------------------------------------------------------------
describe("evaluateGseSubmissionReadiness — submit-gse 422 gate", () => {
  it("blocks a gating-section gap (missing SSN) and lists the field", async () => {
    setFixtures({
      // SSN presence is decided by the vault's ssnLast4 marker (plaintext ssn
      // is never stored post-encryption), so "missing SSN" means clearing it.
      urla: baseUrla({ personalInfo: completePersonalInfo({ ssn: null, ssnLast4: null }) }),
    });
    const gate = evaluateGseSubmissionReadiness(await validateMISMOCompleteness("app-1"));

    expect(gate.blocked).toBe(true);
    expect(gate.status).toBe(422);
    expect(gate.body.gseGatingFailed).toBe(true);
    expect(gate.body.gseReady).toBe(false);
    // missingFields uses "<Section name>: <Field>"; criticalErrors add "is required".
    expect(gate.body.missingFields).toContain("Personal Information: SSN");
    expect(gate.body.criticalErrors).toContain("Personal Information: SSN is required");
    expect(gate.body.error).toMatch(/missing required URLA fields/i);
  });

  it("blocks a critical error in a non-gating section even when gating passes", async () => {
    // Null account type (section 2a, non-gating) raises a critical error
    // without failing gating; the VA fixture keeps the score >= 90.
    setFixtures(
      gseReadyOpts({
        urla: baseUrla({
          assets: [
            {
              accountType: null,
              financialInstitution: "Big Bank",
              cashOrMarketValue: "50000",
              borrowerSequenceNumber: 1,
            },
          ],
        }),
      })
    );
    const result = await validateMISMOCompleteness("app-1");
    const gate = evaluateGseSubmissionReadiness(result);

    expect(result.gseGatingFailed).toBe(false);
    expect(result.overallScore).toBeGreaterThanOrEqual(90);
    expect(gate.blocked).toBe(true); // via criticalErrors, not gating
    expect(gate.body.missingFields).toContain("Assets & Accounts: Account Type");
  });

  it("blocks an ARM loan missing required ARM fields (surfaced via criticalErrors)", async () => {
    setFixtures(gseReadyOpts({ application: { amortizationType: "adjustable" } }));
    const gate = evaluateGseSubmissionReadiness(await validateMISMOCompleteness("app-1"));

    expect(gate.blocked).toBe(true);
    expect(gate.body.criticalErrors.some(e => /^ARM:/.test(e))).toBe(true);
  });

  it("blocks a co-applicant-only gap via criticalErrors (gating stays clean)", async () => {
    setFixtures({
      urla: urlaWithCoApplicant({
        employment: [coEmployment({ employerName: null })],
      }),
    });
    const result = await validateMISMOCompleteness("app-1");
    const gate = evaluateGseSubmissionReadiness(result);

    expect(result.gseGatingFailed).toBe(false); // gating scores the primary only
    expect(gate.blocked).toBe(true);
    expect(gate.body.criticalErrors).toContain(
      "Co-applicant #2 Employment & Income: Employer Name is required"
    );
  });

  it("does NOT block a required-complete application that merely scores below 90", async () => {
    // The key design choice: the baseline conventional app has every required
    // field present (no gating fail, no critical errors) but scores 88, so
    // gseReady is false. The gate must let it through rather than emit an
    // empty, unactionable 422.
    setFixtures();
    const result = await validateMISMOCompleteness("app-1");
    const gate = evaluateGseSubmissionReadiness(result);

    expect(result.overallScore).toBeLessThan(90);
    expect(result.gseReady).toBe(false);
    expect(result.gseGatingFailed).toBe(false);
    expect(result.criticalErrors).toEqual([]);
    expect(gate.blocked).toBe(false);
  });

  it("does NOT block a fully GSE-ready application", async () => {
    setFixtures(gseReadyOpts());
    const result = await validateMISMOCompleteness("app-1");
    const gate = evaluateGseSubmissionReadiness(result);

    expect(result.gseReady).toBe(true);
    expect(gate.blocked).toBe(false);
    expect(gate.body.gseReady).toBe(true);
    expect(gate.body.missingFields).toEqual([]);
    expect(gate.body.coApplicantLimitation).toBeNull();
  });

  it("blocks a declared co-borrower with zero URLA records, even when everything else is GSE-ready (LO-M11)", async () => {
    // Pre-fix, this exact application sailed through: per-field co-borrower
    // gaps fold into criticalErrors, but a co-borrower missing from the
    // casefile ENTIRELY produced only the advisory coApplicantLimitation note,
    // which the gate never read — a joint application could reach DU with one
    // borrower absent.
    setFixtures(gseReadyOpts({ profile: { ...militaryProfile(), hasCoBorrower: true } }));
    const result = await validateMISMOCompleteness("app-1");
    const gate = evaluateGseSubmissionReadiness(result);

    expect(result.gseGatingFailed).toBe(false);
    expect(result.criticalErrors).toEqual([]);
    expect(result.coApplicantLimitation).not.toBeNull();
    expect(gate.blocked).toBe(true);
    expect(gate.status).toBe(422);
    expect(gate.body.coApplicantLimitation).toMatch(/co-borrower is indicated/i);
  });
});
