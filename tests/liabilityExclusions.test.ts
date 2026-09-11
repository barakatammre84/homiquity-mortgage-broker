import { beforeEach, describe, expect, it, vi } from "vitest";

// B3-6-05, Monthly Debt Obligations — "Debts Paid by Others" (Selling Guide
// 08/05/2026, a section revised in that release). The rule lives in ONE shared
// predicate that both DTI paths read; these tests pin the rule itself, the
// decision path's use of it, and the lifecycle of the documentation condition
// the Guide requires ("the most recent 12 months' canceled checks (or bank
// statements) from the other party making the payments").

const h = {
  conditions: [] as Array<Record<string, any>>,
  created: [] as Array<Record<string, any>>,
  updated: [] as Array<{ id: string; data: Record<string, any> }>,
};
vi.mock("../server/storage", () => ({
  storage: {
    getLoanConditionsByApplication: async () => h.conditions,
    createLoanCondition: async (data: Record<string, any>) => {
      h.created.push(data);
      return { id: `c-${h.created.length}`, ...data };
    },
    updateLoanCondition: async (id: string, data: Record<string, any>) => {
      h.updated.push({ id, data });
      return { id, ...data };
    },
  },
}));

import {
  assessPaidByOtherParty,
  isExcludedAsPaidByOtherParty,
  PAID_BY_OTHER_PARTY_CONDITION_RULE,
  THIRD_PARTY_PAYMENT_HISTORY_DOCUMENT_TYPE,
} from "@shared/liabilityExclusions";
import { URLA_LIABILITY_TYPES, isMortgageClassLiability, liabilityKind } from "@shared/liabilityTypes";
import { sumOpenMonthlyLiabilities } from "../server/services/decisionEngine";
import { reconcileThirdPartyPaidDebtConditions, type DeclaredLiability } from "../server/services/preUnderwriting";

describe("liabilityKind — one classifier for what the picker writes AND what importers carry", () => {
  it("maps every URLA picker label (the strings the column actually stores)", () => {
    const expected: Record<string, string> = {
      "Revolving (Credit Card)": "revolving",
      "Open 30-day charge account": "open_30_day",
      "Lease": "lease",
      "Installment (Auto Loan)": "installment",
      "Student Loan": "student_loan",
      "Mortgage": "mortgage",
      "HELOC": "heloc",
      "Alimony": "alimony",
      "Child Support": "child_support",
      "Other": "other",
    };
    for (const label of URLA_LIABILITY_TYPES) {
      expect(liabilityKind(label), label).toBe(expected[label]);
    }
  });

  it("maps the staff table's snake_case enum too", () => {
    expect(liabilityKind("credit_card")).toBe("revolving");
    expect(liabilityKind("first_mortgage")).toBe("mortgage");
    expect(liabilityKind("second_mortgage")).toBe("mortgage");
    expect(liabilityKind("auto_loan")).toBe("installment");
    expect(liabilityKind("personal_loan")).toBe("installment");
    expect(liabilityKind("installment_loan")).toBe("installment");
    expect(liabilityKind("child_support")).toBe("child_support");
  });

  it("keeps a home equity line out of the revolving bucket — B3-6-05 routes it to housing", () => {
    expect(liabilityKind("Home Equity Line of Credit")).toBe("heloc");
    expect(liabilityKind("personal line of credit")).toBe("revolving");
    expect(isMortgageClassLiability("HELOC")).toBe(true);
    expect(isMortgageClassLiability("Mortgage")).toBe(true);
    expect(isMortgageClassLiability("Revolving (Credit Card)")).toBe(false);
  });
});

const facts = (over: Record<string, unknown>) => ({
  liabilityType: "Installment (Auto Loan)",
  paidByOtherParty: true,
  otherPartyObligated: null,
  otherPartyInterestedParty: false,
  usesRentalIncomeFromProperty: null,
  ...over,
});

describe("assessPaidByOtherParty — the Guide's conditions, affirmatively", () => {
  it("is not a claim until the borrower makes one", () => {
    expect(assessPaidByOtherParty(facts({ paidByOtherParty: false })).status).toBe("not_claimed");
    expect(assessPaidByOtherParty(facts({ paidByOtherParty: null })).status).toBe("not_claimed");
  });

  it("excludes a non-mortgage debt whether or not the payer is obligated on it", () => {
    expect(assessPaidByOtherParty(facts({ otherPartyObligated: null }))).toEqual({ status: "excludable", mortgageClass: false });
    expect(assessPaidByOtherParty(facts({ otherPartyObligated: false }))).toEqual({ status: "excludable", mortgageClass: false });
    expect(assessPaidByOtherParty(facts({ otherPartyObligated: true }))).toEqual({ status: "excludable", mortgageClass: false });
  });

  it("never excludes when the payer is an interested party to the transaction", () => {
    expect(assessPaidByOtherParty(facts({ otherPartyInterestedParty: true }))).toEqual({ status: "ineligible", reason: "interested_party" });
    expect(assessPaidByOtherParty(facts({ liabilityType: "Mortgage", otherPartyInterestedParty: true, otherPartyObligated: true, usesRentalIncomeFromProperty: false })))
      .toEqual({ status: "ineligible", reason: "interested_party" });
  });

  it("treats an unanswered question as a condition not yet met — the debt stays in", () => {
    expect(assessPaidByOtherParty(facts({ otherPartyInterestedParty: null }))).toEqual({ status: "ineligible", reason: "answers_incomplete" });
    expect(assessPaidByOtherParty(facts({ liabilityType: "Mortgage", otherPartyObligated: null, usesRentalIncomeFromProperty: false })))
      .toEqual({ status: "ineligible", reason: "answers_incomplete" });
    expect(assessPaidByOtherParty(facts({ liabilityType: "Mortgage", otherPartyObligated: true, usesRentalIncomeFromProperty: null })))
      .toEqual({ status: "ineligible", reason: "answers_incomplete" });
  });

  it("mortgage debt: the payer must be obligated, and no rental income from that property", () => {
    const mortgage = (o: Record<string, unknown>) => assessPaidByOtherParty(facts({ liabilityType: "Mortgage", ...o }));
    expect(mortgage({ otherPartyObligated: false, usesRentalIncomeFromProperty: false })).toEqual({ status: "ineligible", reason: "mortgage_payer_not_obligated" });
    expect(mortgage({ otherPartyObligated: true, usesRentalIncomeFromProperty: true })).toEqual({ status: "ineligible", reason: "mortgage_rental_income_used" });
    expect(mortgage({ otherPartyObligated: true, usesRentalIncomeFromProperty: false })).toEqual({ status: "excludable", mortgageClass: true });
    // A HELOC is secured by real estate: same three conditions.
    expect(assessPaidByOtherParty(facts({ liabilityType: "HELOC", otherPartyObligated: false, usesRentalIncomeFromProperty: false })))
      .toEqual({ status: "ineligible", reason: "mortgage_payer_not_obligated" });
  });
});

describe("the instant decision's debt sum reads the same predicate", () => {
  const row = (over: Record<string, unknown>) => ({
    toBePaidOff: false,
    monthlyPayment: "300",
    liabilityType: "Student Loan",
    paidByOtherParty: false,
    otherPartyObligated: null,
    otherPartyInterestedParty: null,
    usesRentalIncomeFromProperty: null,
    ...over,
  });

  it("leaves an excludable payment out of the sum", () => {
    const rows = [row({ monthlyPayment: "450" }), row({ paidByOtherParty: true, otherPartyInterestedParty: false })];
    expect(sumOpenMonthlyLiabilities(rows, "999")).toBe(450);
  });

  it("keeps an ineligible claim in the sum — a claim is not an exclusion", () => {
    const rows = [
      row({ paidByOtherParty: true, otherPartyInterestedParty: true }), // seller pays
      row({ paidByOtherParty: true, otherPartyInterestedParty: null }), // not answered
      row({ liabilityType: "Mortgage", monthlyPayment: "1800", paidByOtherParty: true, otherPartyInterestedParty: false, otherPartyObligated: false, usesRentalIncomeFromProperty: false }),
    ];
    expect(sumOpenMonthlyLiabilities(rows, "0")).toBe(2400);
  });

  it("still honours paid-off-at-closing and the no-rows fallback", () => {
    expect(sumOpenMonthlyLiabilities([row({ toBePaidOff: true })], "0")).toBe(0);
    expect(sumOpenMonthlyLiabilities([], "725")).toBe(725);
  });

  it("rows without the new columns (older callers, fixtures) are simply included", () => {
    expect(sumOpenMonthlyLiabilities([{ toBePaidOff: false, monthlyPayment: "120" }], "0")).toBe(120);
    expect(isExcludedAsPaidByOtherParty({ liabilityType: "x", paidByOtherParty: undefined, otherPartyObligated: undefined, otherPartyInterestedParty: undefined, usesRentalIncomeFromProperty: undefined })).toBe(false);
  });
});

describe("reconcileThirdPartyPaidDebtConditions — the 12-month history follows the claim", () => {
  const prefix = `${PAID_BY_OTHER_PARTY_CONDITION_RULE}:`;
  const declared = (over: Partial<DeclaredLiability>): DeclaredLiability => ({
    id: "liab-1",
    creditorName: "Navient",
    liabilityType: "Student Loan",
    monthlyPayment: "300",
    paidByOtherParty: true,
    otherPartyRelationship: "family_member",
    otherPartyObligated: null,
    otherPartyInterestedParty: false,
    usesRentalIncomeFromProperty: null,
    ...over,
  });

  beforeEach(() => {
    h.conditions = [];
    h.created = [];
    h.updated = [];
  });

  it("creates one outstanding condition per excludable debt, keyed by liability id", async () => {
    await reconcileThirdPartyPaidDebtConditions("app-1", [declared({}), declared({ id: "liab-2", creditorName: "Ally" })]);
    expect(h.created).toHaveLength(2);
    expect(h.created.map((c) => c.sourceRule).sort()).toEqual([`${prefix}liab-1`, `${prefix}liab-2`]);
    expect(h.created[0]).toMatchObject({
      applicationId: "app-1",
      category: "credit",
      status: "outstanding",
      isAutoGenerated: true,
      requiredDocumentTypes: [THIRD_PARTY_PAYMENT_HISTORY_DOCUMENT_TYPE],
    });
    expect(h.created[0].title).toContain("Navient");
    expect(h.created[0].description).toContain("12 months");
    expect(h.created[0].description).toContain("B3-6-05");
  });

  it("does nothing for a claim the rule rejects — no paperwork for a debt still in the ratio", async () => {
    await reconcileThirdPartyPaidDebtConditions("app-1", [declared({ otherPartyInterestedParty: true })]);
    expect(h.created).toHaveLength(0);
  });

  it("is idempotent: a live condition is never duplicated", async () => {
    h.conditions = [{ id: "c-old", sourceRule: `${prefix}liab-1`, status: "outstanding" }];
    await reconcileThirdPartyPaidDebtConditions("app-1", [declared({})]);
    expect(h.created).toHaveLength(0);
    expect(h.updated).toHaveLength(0);
  });

  it("retires an open condition when the borrower withdraws the claim", async () => {
    h.conditions = [{ id: "c-old", sourceRule: `${prefix}liab-1`, status: "outstanding" }];
    await reconcileThirdPartyPaidDebtConditions("app-1", [declared({ paidByOtherParty: false })]);
    expect(h.updated).toEqual([
      { id: "c-old", data: expect.objectContaining({ status: "not_applicable" }) },
    ]);
    expect(h.created).toHaveLength(0);
  });

  it("retires it when the liability is gone entirely", async () => {
    h.conditions = [{ id: "c-old", sourceRule: `${prefix}liab-1`, status: "submitted" }];
    await reconcileThirdPartyPaidDebtConditions("app-1", []);
    expect(h.updated[0]?.data.status).toBe("not_applicable");
  });

  it("re-opens a retired condition if the claim comes back — no duplicate row", async () => {
    h.conditions = [{ id: "c-old", sourceRule: `${prefix}liab-1`, status: "not_applicable" }];
    await reconcileThirdPartyPaidDebtConditions("app-1", [declared({})]);
    expect(h.updated).toEqual([{ id: "c-old", data: { status: "outstanding", clearanceNotes: null } }]);
    expect(h.created).toHaveLength(0);
  });

  it("leaves a CLEARED condition alone either way — it is history", async () => {
    h.conditions = [{ id: "c-old", sourceRule: `${prefix}liab-1`, status: "cleared" }];
    await reconcileThirdPartyPaidDebtConditions("app-1", [declared({ paidByOtherParty: false })]);
    expect(h.updated).toHaveLength(0);
    await reconcileThirdPartyPaidDebtConditions("app-1", [declared({})]);
    expect(h.updated).toHaveLength(0);
    expect(h.created).toHaveLength(0);
  });

  it("ignores conditions that are not its own", async () => {
    h.conditions = [{ id: "c-res", sourceRule: "PRE_UW_LOW_RESERVES", status: "outstanding" }];
    await reconcileThirdPartyPaidDebtConditions("app-1", []);
    expect(h.updated).toHaveLength(0);
  });
});
