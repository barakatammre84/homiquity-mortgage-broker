import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiabilitiesSection } from "./LiabilitiesSection";
import type { LiabilityForm } from "./types";
import { PAID_BY_OTHER_PARTY_INELIGIBLE_COPY } from "@shared/liabilityExclusions";

// B3-6-05, Debts Paid by Others, as the borrower meets it: one checkbox, the
// questions the rule turns on, and a status line that tells the truth about
// whether the payment left their ratio. The status is computed by the SAME
// predicate the decision engine reads, so the form can never promise an
// exclusion the decision will not apply.

const row = (over: Partial<LiabilityForm>): LiabilityForm => ({
  liabilityType: "Student Loan",
  creditorName: "Navient",
  unpaidBalance: "30000",
  monthlyPayment: "350",
  toBePaidOff: false,
  ...over,
});

describe("LiabilitiesSection — someone else pays this debt", () => {
  it("captures the remaining term and student-loan plan needed for a documented review", () => {
    render(<LiabilitiesSection liabilities={[row({ monthlyPayment: "0", remainingTermMonths: 18, studentLoanRepaymentPlan: "income_driven" })]} onChange={vi.fn()} />);
    expect((screen.getByTestId("input-remaining-payments-0") as HTMLInputElement).value).toBe("18");
    expect(screen.getByTestId("select-student-plan-0").textContent).toContain("Income-driven repayment");
    expect(screen.getByText(/upload the latest student-loan statement/i)).toBeTruthy();
  });

  it("keeps vehicle leases outside the short-term installment exception", () => {
    render(<LiabilitiesSection liabilities={[row({ liabilityType: "Lease", remainingTermMonths: 4 })]} onChange={vi.fn()} />);
    expect(screen.queryByTestId("input-remaining-payments-0")).toBeNull();
  });

  it("offers the declaration on every liability and reports it through onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LiabilitiesSection liabilities={[row({})]} onChange={onChange} />);
    expect(screen.queryByTestId("panel-paid-by-other-0")).toBeNull();
    await user.click(screen.getByTestId("checkbox-paid-by-other-0"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0][0]).toMatchObject({ creditorName: "Navient", paidByOtherParty: true });
  });

  it("once claimed, asks who pays and the interested-party question, and explains the 12-month history", () => {
    render(<LiabilitiesSection liabilities={[row({ paidByOtherParty: true })]} onChange={vi.fn()} />);
    const panel = screen.getByTestId("panel-paid-by-other-0");
    expect(panel.textContent).toContain("12 months");
    expect(screen.getByTestId("select-other-party-relationship-0")).toBeTruthy();
    expect(screen.getByTestId("select-other-party-interested-0")).toBeTruthy();
    // Not a mortgage: the mortgage-only questions stay out of the way.
    expect(screen.queryByTestId("select-other-party-obligated-0")).toBeNull();
    expect(screen.queryByTestId("select-uses-rental-income-0")).toBeNull();
    // Unanswered: the rule says "not yet", and so does the form.
    expect(screen.getByTestId("text-paid-by-other-status-0").textContent).toBe(
      PAID_BY_OTHER_PARTY_INELIGIBLE_COPY.answers_incomplete,
    );
  });

  it("says the payment is left out once the answers satisfy the rule", () => {
    render(
      <LiabilitiesSection
        liabilities={[row({ paidByOtherParty: true, otherPartyRelationship: "family_member", otherPartyInterestedParty: false })]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("text-paid-by-other-status-0").textContent).toContain("left out of your debt ratio");
  });

  it("tells the borrower plainly when the payer is an interested party", () => {
    render(
      <LiabilitiesSection
        liabilities={[row({ paidByOtherParty: true, otherPartyInterestedParty: true })]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("text-paid-by-other-status-0").textContent).toBe(
      PAID_BY_OTHER_PARTY_INELIGIBLE_COPY.interested_party,
    );
  });

  it("a mortgage asks the two extra questions, and a payer not on the loan keeps the payment in", () => {
    render(
      <LiabilitiesSection
        liabilities={[
          row({
            liabilityType: "Mortgage",
            creditorName: "Chase",
            monthlyPayment: "1900",
            paidByOtherParty: true,
            otherPartyInterestedParty: false,
            otherPartyObligated: false,
            usesRentalIncomeFromProperty: false,
          }),
        ]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("select-other-party-obligated-0")).toBeTruthy();
    expect(screen.getByTestId("select-uses-rental-income-0")).toBeTruthy();
    expect(screen.getByTestId("text-paid-by-other-status-0").textContent).toBe(
      PAID_BY_OTHER_PARTY_INELIGIBLE_COPY.mortgage_payer_not_obligated,
    );
  });
});
