import { describe, it, expect } from "vitest";

import { resolveStepCopy, getDynamicTitle } from "./AdvisoryPanel";
import { QUESTIONS_BY_ID } from "./questions";
import { PRE_APPROVAL_DEFAULTS } from "@/funnel/preApprovalMachine";
import type { PreApprovalFormData } from "@shared/schema";

// Step copy resolved against the borrower's own answers. The rule this exists
// to hold: title, subtext and "why we ask" move TOGETHER. A step whose heading
// adapts to a refinance while its supporting copy still describes a purchase is
// worse than one that never adapted, because it reads as a bug rather than as
// generic wording.

function answers(overrides: Partial<PreApprovalFormData> = {}): PreApprovalFormData {
  return { ...PRE_APPROVAL_DEFAULTS, ...overrides };
}

const copyFor = (stepId: string, overrides: Partial<PreApprovalFormData> = {}) =>
  resolveStepCopy(QUESTIONS_BY_ID[stepId], answers(overrides));

/** Every string a step puts on screen, for "does any of this still say X" checks. */
const allText = (stepId: string, overrides: Partial<PreApprovalFormData> = {}) => {
  const c = copyFor(stepId, overrides);
  return [c.title, c.subtext ?? "", c.why ?? ""].join(" ");
};

describe("pre-approval entry promise", () => {
  it("does not call an unverified three-minute result a verified letter", () => {
    expect(QUESTIONS_BY_ID.intro.subtitle).toMatch(/preliminary answer/i);
    expect(QUESTIONS_BY_ID.intro.subtitle).not.toMatch(/verified pre-approval/i);
  });
});

describe("resolveStepCopy — purchase path", () => {
  it("keeps the purchase wording by default", () => {
    expect(copyFor("purchasePrice").title).toBe("What is the estimated purchase price?");
    expect(copyFor("downPayment").title).toBe("How much are you planning to put down?");
  });

  it("folds the entered price into the down-payment question", () => {
    expect(copyFor("downPayment", { purchasePrice: "500,000" }).title).toBe(
      "On a $500,000 home, how much can you put down?",
    );
  });

  it("falls back to the catalog copy when nothing is dynamic", () => {
    const q = QUESTIONS_BY_ID.propertyType;
    expect(resolveStepCopy(q, answers())).toEqual({ title: q.question, subtext: q.subtext, why: q.why });
  });
});

describe("resolveStepCopy — refinance path", () => {
  // The fields are unchanged: the machine still computes the loan amount as
  // price − down. Only the words change, which is exactly why the reworded
  // down-payment step asks for EQUITY rather than the loan balance — asking for
  // the balance and storing it in `downPayment` would invert the math.
  for (const loanPurpose of ["refinance", "cash_out"] as const) {
    it(`never asks a ${loanPurpose} borrower about a purchase price`, () => {
      const text = allText("purchasePrice", { loanPurpose });
      expect(text).not.toMatch(/purchase price/i);
      expect(copyFor("purchasePrice", { loanPurpose }).title).toBe("What's your home worth today?");
    });

    it(`asks a ${loanPurpose} borrower for equity, not a down payment`, () => {
      const copy = copyFor("downPayment", { loanPurpose, purchasePrice: "500,000" });
      // The ASK — heading and supporting line — must be equity end to end. The
      // "why we ask" line may still reach for a down payment as an analogy;
      // that explains the field rather than misnaming it.
      const ask = `${copy.title} ${copy.subtext}`;
      expect(ask).toMatch(/equity/i);
      expect(ask).not.toMatch(/down payment/i);
      expect(ask).not.toMatch(/put down/i);
      expect(allText("downPayment", { loanPurpose })).not.toMatch(/purchase price/i);
    });

    it(`does not ask a ${loanPurpose} borrower which state they're buying in`, () => {
      expect(copyFor("propertyState", { loanPurpose }).title).toBe("Which state is the property in?");
    });
  }

  it("distinguishes cash-out from a rate-and-term refinance", () => {
    const cashOut = copyFor("downPayment", { loanPurpose: "cash_out" });
    const rateTerm = copyFor("downPayment", { loanPurpose: "refinance" });
    expect(cashOut.title).not.toBe(rateTerm.title);
    expect(cashOut.title).toMatch(/cash out/i);
  });
});

describe("resolveStepCopy — self-employed income detail", () => {
  // The machine skips the "any additional income?" question for self-employed
  // borrowers because the detail step is mandatory for them either way. That
  // makes this heading the first thing they see — so it must not open by asking
  // about "other" income they were never asked to have.
  it("asks a self-employed borrower to detail their own income, not 'other' income", () => {
    const copy = copyFor("incomeSources", { employmentType: "self_employed" });
    expect(copy.title).toBe("Let's detail your self-employment income");
    expect(copy.title).not.toMatch(/other income/i);
    expect(copy.subtext).toMatch(/1099|business/i);
  });

  it("labels the first self-employed income number as a rough total before detail", () => {
    const copy = copyFor("annualIncome", { employmentType: "self_employed" });
    expect(copy.title).toMatch(/about how much/i);
    expect(copy.subtext).toMatch(/rough total/i);
    expect(copy.subtext).toMatch(/business|1099/i);
  });

  it("keeps the other-income wording for everyone else", () => {
    for (const employmentType of ["employed", "retired", "other"] as const) {
      expect(copyFor("incomeSources", { employmentType }).title).toBe("What other income do you receive?");
    }
  });

  it("adapts the tenure question to how the borrower earns", () => {
    expect(copyFor("employmentYears", { employmentType: "self_employed" }).title).toMatch(/self-employed/i);
    expect(copyFor("employmentYears", { employmentType: "retired" }).title).toMatch(/retired/i);
    expect(copyFor("employmentYears", { employmentType: "employed" }).title).toMatch(/current job/i);
  });
});

describe("getDynamicTitle", () => {
  it("stays a thin view over resolveStepCopy", () => {
    for (const stepId of Object.keys(QUESTIONS_BY_ID)) {
      const values = answers({ loanPurpose: "refinance", employmentType: "self_employed" });
      expect(getDynamicTitle(QUESTIONS_BY_ID[stepId], values)).toBe(
        resolveStepCopy(QUESTIONS_BY_ID[stepId], values).title,
      );
    }
  });
});
