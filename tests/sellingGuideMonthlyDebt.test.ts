/**
 * Fannie Mae Selling Guide B3-6-05, Monthly Debt Obligations (08/05/2026) and
 * B3-6-07, Debts Paid Off At or Prior to Closing (04/05/2023).
 *
 * These pin the DTI debt-summation rules to their published source. Quotes below are
 * verbatim from the 08-05-2026 edition, so a future edition change shows up as a diff
 * here. The Guide is not committed (public repo, copyrighted work) — regenerate it
 * locally with `python3 scripts/extract-selling-guide.py` to check a quote.
 *
 * Why this file exists: every rule below was previously either absent or written
 * against a liability-type spelling the application can never emit, so the
 * branches never executed and the suite stayed green. Assert on OUTPUT, never on
 * the branch being present.
 */
import { describe, it, expect } from "vitest";
import { assessLiabilities } from "../server/underwriting";
import { adjustLiabilities } from "../server/services/underwritingNuance";
import { derivePreUnderwritingFlags } from "../server/services/preUnderwriting";
import type { UrlaLiability } from "@shared/schema";

const liability = (over: Partial<UrlaLiability>): UrlaLiability =>
  ({
    id: "l1",
    applicationId: "a1",
    borrowerSequenceNumber: 1,
    liabilityType: "credit_card",
    creditorName: "Test",
    accountNumberEncrypted: null,
    accountNumberIv: null,
    accountNumberKeyId: null,
    accountNumberLast4: null,
    unpaidBalance: "0",
    monthlyPayment: "0",
    toBePaidOff: false,
    createdAt: new Date(),
    ...over,
  }) as UrlaLiability;

describe("B3-6-05 Revolving Charge/Lines of Credit", () => {
  // "If the credit report does not show a required minimum payment amount and
  // there is no supplemental documentation to support a payment of less than 5%,
  // the lender must use 5% of the outstanding balance ... For DU loan casefiles
  // ... the greater of $10 or 5% of the outstanding balance."
  it("imputes 5% of balance when a revolving line reports no minimum payment", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "credit_card", unpaidBalance: "8000", monthlyPayment: "0" }),
    ]);
    expect(r.totalMonthlyPayment).toBe(400); // 5% of 8,000
  });

  it("uses the $10 floor when 5% of the balance is smaller", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "credit_card", unpaidBalance: "100", monthlyPayment: "0" }),
    ]);
    expect(r.totalMonthlyPayment).toBe(10); // greater of $10 and $5
  });

  it("uses the reported minimum payment when the report carries one", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "credit_card", unpaidBalance: "8000", monthlyPayment: "125" }),
    ]);
    expect(r.totalMonthlyPayment).toBe(125);
  });

  // The regression this file was written for: a $12k card with no reported
  // minimum used to contribute $0, understating the DTI and clearing files DU
  // would decline.
  it("does not let a zero-payment revolving line vanish from the DTI", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "credit_card", unpaidBalance: "12000", monthlyPayment: "0" }),
    ]);
    expect(r.totalMonthlyPayment).toBeGreaterThan(0);
  });

  it("applies the same floor to credit-pull tradelines", () => {
    const adj = adjustLiabilities([
      { creditor: "Card", type: "revolving", balance: 8000, monthlyPayment: 0 },
    ]);
    expect(adj.revolvingImputed).toBe(400);
    expect(adj.adjustedMonthlyDebt).toBe(400);
  });
});

describe("B3-6-05 Open 30-day charge accounts", () => {
  it("excludes the monthly payment from DTI but carries the full balance to the asset gate", () => {
    const r = assessLiabilities([
      liability({
        liabilityType: "Open 30-day charge account",
        unpaidBalance: "4800",
        monthlyPayment: "4800",
      }),
    ]);
    expect(r.totalMonthlyPayment).toBe(0);
    expect(r.excludedDebts).toBe(4800);
    expect(r.openThirtyDayBalance).toBe(4800);
    expect(r.breakdown[0]).toMatchObject({ type: "open_30_day", included: false, payment: 0 });
    expect(r.breakdown[0].reason).toContain("covered by verified funds");
  });

  it("keeps leases in DTI rather than mistaking them for open charge accounts", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "Lease", unpaidBalance: "9200", monthlyPayment: "460" }),
    ]);
    expect(r.totalMonthlyPayment).toBe(460);
    expect(r.openThirtyDayBalance).toBe(0);
    expect(r.breakdown[0]).toMatchObject({ type: "lease", included: true });
  });
});

describe("B3-6-05 Student Loans", () => {
  // "For deferred loans or loans in forbearance, the lender may calculate a
  // payment equal to 1% of the outstanding student loan balance".
  it("imputes 1% of balance on a deferred student loan", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "student_loan", unpaidBalance: "40000", monthlyPayment: "0" }),
    ]);
    expect(r.totalMonthlyPayment).toBe(400); // 1% of 40,000
  });

  it("does not apply the revolving 5% factor to a student loan", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "student_loan", unpaidBalance: "40000", monthlyPayment: "0" }),
    ]);
    expect(r.totalMonthlyPayment).not.toBe(2000);
  });

  it("uses a documented $0 income-driven payment only after the reviewed-treatment gate", () => {
    const row = liability({
      liabilityType: "Student Loan",
      unpaidBalance: "40000",
      monthlyPayment: "0",
      studentLoanRepaymentPlan: "income_driven",
      underwritingTreatment: "documented_zero_student_loan",
      treatmentSourceDocumentId: "doc-1",
      treatmentCreditPullId: "pull-1",
      treatmentTradelineIndex: 0,
    });
    expect(assessLiabilities([row]).totalMonthlyPayment).toBe(400);
    const reviewed = assessLiabilities([row], { allowReviewedTreatments: true });
    expect(reviewed.totalMonthlyPayment).toBe(0);
    expect(reviewed.breakdown[0].reason).toContain("Documented $0 income-driven");
  });
});

describe("B3-6-05 Installment debt remaining term", () => {
  it("keeps a short-term installment in DTI until a reviewer applies the supported treatment", () => {
    const row = liability({
      liabilityType: "Installment (Auto Loan)",
      unpaidBalance: "1800",
      monthlyPayment: "450",
      remainingTermMonths: 4,
      underwritingTreatment: "exclude_short_term_installment",
      treatmentSourceDocumentId: "doc-1",
      treatmentCreditPullId: "pull-1",
      treatmentTradelineIndex: 0,
    });
    expect(assessLiabilities([row]).totalMonthlyPayment).toBe(450);
    const reviewed = assessLiabilities([row], { allowReviewedTreatments: true });
    expect(reviewed.totalMonthlyPayment).toBe(0);
    expect(reviewed.excludedDebts).toBe(450);
    expect(reviewed.breakdown[0]).toMatchObject({ included: false, remainingMonths: 4 });
  });

  it("never excludes a lease merely because ten or fewer payments remain", () => {
    const row = liability({
      liabilityType: "Lease",
      monthlyPayment: "450",
      remainingTermMonths: 4,
      underwritingTreatment: "exclude_short_term_installment",
    });
    expect(assessLiabilities([row], { allowReviewedTreatments: true }).totalMonthlyPayment).toBe(450);
  });
});

describe("B3-6-07 Debts Paid Off At or Prior to Closing", () => {
  // "If a revolving account balance is to be paid off at or prior to closing, a
  // monthly payment on the current outstanding balance does not need to be
  // included in the borrower's long-term debt."
  it("excludes a debt flagged to be paid off at closing", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "credit_card", unpaidBalance: "8000", monthlyPayment: "200", toBePaidOff: true }),
    ]);
    expect(r.totalMonthlyPayment).toBe(0);
    expect(r.excludedDebts).toBe(200);
  });

  // toBePaidOff used to be tested only inside an `installment` branch that the
  // liability vocabulary cannot produce, so it never fired for ANY type.
  it("honors the paid-off flag on installment debt, not only revolving", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "installment_loan", unpaidBalance: "9000", monthlyPayment: "310", toBePaidOff: true }),
    ]);
    expect(r.totalMonthlyPayment).toBe(0);
  });

  it("still excludes when the paid-off debt is a zero-payment revolving line", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "credit_card", unpaidBalance: "8000", monthlyPayment: "0", toBePaidOff: true }),
    ]);
    expect(r.totalMonthlyPayment).toBe(0);
  });
});

describe("B3-6-05 branch reachability", () => {
  // The defect class: rules written against type strings the app never emits.
  // These assert the guideline branches fire for the vocabulary the URLA form
  // actually writes (shared/schema/underwritingFinancials.ts LIABILITY_TYPES).
  it("reaches the revolving rule via the vocabulary's own spelling", () => {
    for (const spelling of ["credit_card", "Credit Card", "revolving"]) {
      const r = assessLiabilities([
        liability({ liabilityType: spelling, unpaidBalance: "2000", monthlyPayment: "0" }),
      ]);
      expect(r.totalMonthlyPayment, `spelling: ${spelling}`).toBe(100);
    }
  });

  it("includes installment debt at its reported payment", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "auto_loan", unpaidBalance: "15000", monthlyPayment: "420" }),
    ]);
    expect(r.totalMonthlyPayment).toBe(420);
  });
});

describe("B3-6-05 imputation must be explained, not just counted", () => {
  // adjustedMonthlyDebt now includes the revolving imputation, so it can push a
  // file over the DTI ceiling on its own. If the flag's cause list does not
  // recognise it, the borrower is held over the ceiling with no explanation —
  // the silent-success class this codebase keeps re-learning.
  const base = {
    annualIncome: "90,000",
    purchasePrice: "500,000",
    downPayment: "100,000",
    employmentType: "employed",
    verifiedAssetsTotal: 400_000,
  };

  it("flags and names the revolving imputation when it alone breaches the ceiling", () => {
    const flags = derivePreUnderwritingFlags({
      ...base,
      tradelines: [
        // No deferred student loan, no newly opened line — the imputation is the
        // only thing pushing this file over 43%.
        { creditor: "Big Card", type: "revolving", balance: 30_000, monthlyPayment: 0 },
      ],
    } as Parameters<typeof derivePreUnderwritingFlags>[0]);

    const dtiFlag = flags.find((f) => f.code === "VERIFIED_DEBT_DTI");
    expect(dtiFlag, "revolving imputation breached the ceiling but raised no flag").toBeDefined();
    expect(dtiFlag!.reason).toContain("revolving lines that report no minimum payment");
    expect(dtiFlag!.metrics?.revolvingImputed).toBe(1500); // 5% of 30,000
  });

  it("does not flag when the revolving line reports its own minimum", () => {
    const flags = derivePreUnderwritingFlags({
      ...base,
      tradelines: [
        { creditor: "Big Card", type: "revolving", balance: 30_000, monthlyPayment: 150 },
      ],
    } as Parameters<typeof derivePreUnderwritingFlags>[0]);
    expect(flags.find((f) => f.code === "VERIFIED_DEBT_DTI")).toBeUndefined();
  });
});

describe("B3-4.1-01 Determining Required Minimum Reserves", () => {
  // "Two months' reserves for a second home transaction. Six months' reserves
  // for the following: a two- to four-unit principal residence transaction, an
  // investment property transaction, and a cash-out refinance transaction with
  // a DTI ratio greater than 45%."
  const base = {
    annualIncome: "200,000",
    purchasePrice: "500,000",
    downPayment: "100,000",
    employmentType: "employed",
  };

  // ~$3.2k PITI. $110k verified − $100k down = $10k ≈ 3.1 months: clears a
  // 2-month bar, fails a 6-month one.
  const threeMonthsOfReserves = { ...base, verifiedAssetsTotal: 110_000 };

  it("requires six months on a 2-4 unit principal residence", () => {
    const flags = derivePreUnderwritingFlags({
      ...threeMonthsOfReserves,
      subjectProperty: { numberOfUnits: 3, occupancyType: "primary_residence", estimatedMarketRent: null },
    } as Parameters<typeof derivePreUnderwritingFlags>[0]);
    const flag = flags.find((f) => f.code === "LOW_RESERVES_WARNING");
    expect(flag, "three months of reserves on a 3-unit primary should breach B3-4.1-01's six").toBeDefined();
    expect(flag!.reason).toContain("6-month");
    expect(flag!.reason).toContain("B3-4.1-01");
  });

  it("requires six months on an investment property", () => {
    const flags = derivePreUnderwritingFlags({
      ...threeMonthsOfReserves,
      subjectProperty: { numberOfUnits: 1, occupancyType: "investment", estimatedMarketRent: null },
    } as Parameters<typeof derivePreUnderwritingFlags>[0]);
    expect(flags.find((f) => f.code === "LOW_RESERVES_WARNING")).toBeDefined();
  });

  it("requires only two months on a second home", () => {
    const flags = derivePreUnderwritingFlags({
      ...threeMonthsOfReserves,
      subjectProperty: { numberOfUnits: 1, occupancyType: "second_home", estimatedMarketRent: null },
    } as Parameters<typeof derivePreUnderwritingFlags>[0]);
    expect(flags.find((f) => f.code === "LOW_RESERVES_WARNING")).toBeUndefined();
  });

  // Fannie states no fixed DU minimum for a one-unit principal residence, so our
  // two-month bar there must not be dressed up as an agency requirement.
  it("labels the one-unit primary threshold as ours, not Fannie's", () => {
    const flags = derivePreUnderwritingFlags({
      ...base,
      verifiedAssetsTotal: 101_000,
      subjectProperty: { numberOfUnits: 1, occupancyType: "primary_residence", estimatedMarketRent: null },
    } as Parameters<typeof derivePreUnderwritingFlags>[0]);
    const flag = flags.find((f) => f.code === "LOW_RESERVES_WARNING");
    expect(flag).toBeDefined();
    expect(flag!.reason).toContain("our own readiness guideline");
    expect(flag!.reason).not.toContain("B3-4.1-01");
  });
});

// ---------------------------------------------------------------------------
// The vocabulary the URLA picker ACTUALLY writes. The "branch reachability"
// block above tests "credit_card" / "Credit Card" / "revolving" — none of which
// the picker emits: it stores its own label, "Revolving (Credit Card)", and the
// previous normaliser turned that into `revolving_(credit_card)`, so the
// revolving rule never fired for a real row while this file stayed green.
// `liabilityKind` (shared/liabilityTypes.ts) is now the one classifier the
// picker, the engine and the export read; these feed it the picker's list.
// ---------------------------------------------------------------------------
import { URLA_LIABILITY_TYPES } from "@shared/liabilityTypes";

describe("B3-6-05 reachability with the picker's OWN labels", () => {
  it("imputes 5% for a 'Revolving (Credit Card)' row with no minimum payment", () => {
    const r = assessLiabilities([
      liability({ liabilityType: "Revolving (Credit Card)", unpaidBalance: "2000", monthlyPayment: "0" }),
    ]);
    expect(r.totalMonthlyPayment).toBe(100);
  });

  it("imputes 1% for a 'Student Loan' row with no payment, and includes 'Installment (Auto Loan)' at its payment", () => {
    expect(
      assessLiabilities([liability({ liabilityType: "Student Loan", unpaidBalance: "40000", monthlyPayment: "0" })]).totalMonthlyPayment,
    ).toBe(400);
    expect(
      assessLiabilities([liability({ liabilityType: "Installment (Auto Loan)", unpaidBalance: "15000", monthlyPayment: "420" })]).totalMonthlyPayment,
    ).toBe(420);
  });

  it("a HELOC with no minimum payment is NOT imputed as revolving — it is secured by real estate", () => {
    const r = assessLiabilities([liability({ liabilityType: "HELOC", unpaidBalance: "20000", monthlyPayment: "0" })]);
    expect(r.totalMonthlyPayment).toBe(0);
    expect(r.breakdown[0].reason).not.toContain("revolving");
  });

  it("every picker label classifies to something the engine has a branch for", () => {
    for (const label of URLA_LIABILITY_TYPES) {
      const r = assessLiabilities([liability({ liabilityType: label, unpaidBalance: "1000", monthlyPayment: "50" })]);
      expect(r.breakdown[0].type, label).not.toContain("(");
    }
  });
});

// ---------------------------------------------------------------------------
// B3-6-05 — "Debts Paid by Others" (revised in the 08/05/2026 edition).
// "When a borrower is obligated on a non-mortgage debt - but is not the party
// who is actually repaying the debt - the lender may exclude the monthly
// payment from the borrower's recurring monthly obligations. This policy
// applies whether or not the other party is obligated on the debt, but is not
// applicable if the other party is an interested party to the subject
// transaction (such as the seller or real estate agent)." ... "When a borrower
// is obligated on a mortgage debt ... the lender may exclude the full monthly
// housing expense (PITIA) ... if the party making the payments is obligated on
// the mortgage debt, there are no delinquencies in the most recent 12 months,
// and the borrower is not using rental income from the applicable property to
// qualify." ... "the lender must obtain the most recent 12 months' canceled
// checks (or bank statements) from the other party making the payments".
// ---------------------------------------------------------------------------
describe("B3-6-05 Debts Paid by Others — staff calculations engine", () => {
  const paidByFamily = (over: Partial<UrlaLiability>) =>
    liability({
      liabilityType: "Student Loan",
      unpaidBalance: "30000",
      monthlyPayment: "350",
      paidByOtherParty: true,
      otherPartyRelationship: "family_member",
      otherPartyInterestedParty: false,
      ...over,
    } as Partial<UrlaLiability>);

  it("excludes a non-mortgage payment a third party makes, and says so in the breakdown", () => {
    const r = assessLiabilities([paidByFamily({}), liability({ liabilityType: "Installment (Auto Loan)", monthlyPayment: "400" })]);
    expect(r.totalMonthlyPayment).toBe(400);
    expect(r.excludedDebts).toBe(350);
    expect(r.breakdown[0]).toMatchObject({ included: false });
    expect(r.breakdown[0].reason).toContain("Debts Paid by Others");
  });

  it("keeps the payment in when the payer is the seller or an agent", () => {
    const r = assessLiabilities([paidByFamily({ otherPartyInterestedParty: true })]);
    expect(r.totalMonthlyPayment).toBe(350);
    expect(r.excludedDebts).toBe(0);
  });

  it("keeps the payment in until the borrower has answered the interested-party question", () => {
    const r = assessLiabilities([paidByFamily({ otherPartyInterestedParty: null })]);
    expect(r.totalMonthlyPayment).toBe(350);
  });

  it("mortgage debt: excluded only with the payer on the loan and no rental income from the property", () => {
    const mortgage = (o: Partial<UrlaLiability>) =>
      assessLiabilities([paidByFamily({ liabilityType: "Mortgage", monthlyPayment: "1900", unpaidBalance: "250000", ...o } as Partial<UrlaLiability>)]);
    expect(mortgage({ otherPartyObligated: false, usesRentalIncomeFromProperty: false }).totalMonthlyPayment).toBe(1900);
    expect(mortgage({ otherPartyObligated: true, usesRentalIncomeFromProperty: true }).totalMonthlyPayment).toBe(1900);
    const ok = mortgage({ otherPartyObligated: true, usesRentalIncomeFromProperty: false });
    expect(ok.totalMonthlyPayment).toBe(0);
    expect(ok.excludedDebts).toBe(1900);
    expect(ok.breakdown[0].reason).toContain("Housing expense paid by an obligated third party");
  });

  it("a paid-off-at-closing row is reported under B3-6-07, not B3-6-05 — the first rule wins", () => {
    const r = assessLiabilities([paidByFamily({ toBePaidOff: true })]);
    expect(r.breakdown[0].reason).toContain("B3-6-07");
  });
});

describe("B3-6-05 Debts Paid by Others — the pre-underwriting flag names the checks to gather", () => {
  const base = {
    annualIncome: "90000",
    purchasePrice: "400000",
    downPayment: "80000",
    employmentType: "employed",
    verifiedAssetsTotal: 60000,
  };
  const declared = (over: Record<string, unknown>) => ({
    id: "liab-1",
    creditorName: "Navient",
    liabilityType: "Student Loan",
    monthlyPayment: "350",
    paidByOtherParty: true,
    otherPartyRelationship: "family_member",
    otherPartyObligated: null,
    otherPartyInterestedParty: false,
    usesRentalIncomeFromProperty: null,
    ...over,
  });

  it("raises THIRD_PARTY_PAID_DEBT with one document line per excluded debt", () => {
    const flags = derivePreUnderwritingFlags({
      ...base,
      declaredLiabilities: [declared({}), declared({ id: "liab-2", creditorName: "Ally Auto", liabilityType: "Installment (Auto Loan)", monthlyPayment: "420", otherPartyRelationship: "employer" })],
    });
    const flag = flags.find((f) => f.code === "THIRD_PARTY_PAID_DEBT");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.reason).toContain("Navient");
    expect(flag!.reason).toContain("Ally Auto");
    expect(flag!.reason).toContain("$770/month");
    expect(flag!.reason).toContain("12 months");
    expect(flag!.requiredDocs).toHaveLength(2);
    expect(flag!.requiredDocs.every((d) => d.documentType === "third_party_payment_history")).toBe(true);
    expect(flag!.requiredDocs[0].description).toContain("family member");
    expect(flag!.requiredDocs[1].description).toContain("employer");
    expect(flag!.metrics).toMatchObject({ thirdPartyPaidDebts: 2, monthlyExcluded: 770 });
  });

  it("raises nothing for a claim the rule rejects, and nothing when no claim is made", () => {
    expect(
      derivePreUnderwritingFlags({ ...base, declaredLiabilities: [declared({ otherPartyInterestedParty: true })] })
        .some((f) => f.code === "THIRD_PARTY_PAID_DEBT"),
    ).toBe(false);
    expect(
      derivePreUnderwritingFlags({ ...base, declaredLiabilities: [declared({ paidByOtherParty: false })] })
        .some((f) => f.code === "THIRD_PARTY_PAID_DEBT"),
    ).toBe(false);
    expect(derivePreUnderwritingFlags({ ...base }).some((f) => f.code === "THIRD_PARTY_PAID_DEBT")).toBe(false);
  });
});
