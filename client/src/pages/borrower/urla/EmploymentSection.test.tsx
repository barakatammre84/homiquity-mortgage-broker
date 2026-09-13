import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmploymentSection } from "./EmploymentSection";

describe("EmploymentSection income journey", () => {
  it("asks for evidence instead of an unsupported monthly estimate", () => {
    render(
      <EmploymentSection
        employmentRecords={[]}
        onChange={() => undefined}
        otherIncomes={[{ incomeSource: "Capital Gains", monthlyAmount: "0" }]}
        onOtherIncomesChange={() => undefined}
        assets={[]}
      />,
    );

    expect(screen.getByText(/No estimate needed/i)).toBeTruthy();
    expect(screen.getByText(/two most recent Schedule D forms/i)).toBeTruthy();
    expect(screen.queryByTestId("input-income-amount-0")).toBeNull();
    expect(screen.queryByTestId("select-income-tax-treatment-0")).toBeNull();
  });

  it("keeps the monthly amount fields for recurring other income", () => {
    render(
      <EmploymentSection
        employmentRecords={[]}
        onChange={() => undefined}
        otherIncomes={[{ incomeSource: "Pension", monthlyAmount: "2500" }]}
        onOtherIncomesChange={() => undefined}
        assets={[]}
      />,
    );

    expect(screen.getByTestId("input-income-amount-0")).toBeTruthy();
    expect(screen.getByTestId("select-income-tax-treatment-0")).toBeTruthy();
  });

  it("links employment-related asset income to a retirement account without asking for a monthly estimate", () => {
    render(
      <EmploymentSection
        employmentRecords={[]}
        onChange={() => undefined}
        otherIncomes={[{
          incomeSource: "Employment-Related Assets as Income",
          monthlyAmount: "0",
          linkedAssetAccountLast4: "4321",
        }]}
        onOtherIncomesChange={() => undefined}
        assets={[{
          accountType: "Retirement (e.g., 401k, IRA)",
          financialInstitution: "Fictional Retirement",
          accountNumberLast4: "4321",
        }]}
      />,
    );

    expect(screen.getByTestId("select-employment-asset-0")).toBeTruthy();
    expect(screen.getByTestId("input-employment-asset-penalty-0")).toBeTruthy();
    expect(screen.getByTestId("input-employment-asset-transaction-use-0")).toBeTruthy();
    expect(screen.queryByTestId("input-income-amount-0")).toBeNull();
  });

  it("shows the lower-pay details when a borrower reports a known future decrease", () => {
    render(
      <EmploymentSection
        employmentRecords={[{
          employerName: "Acme",
          isSelfEmployed: false,
          hasKnownFutureIncomeReduction: true,
        }]}
        onChange={() => undefined}
        otherIncomes={[]}
        onOtherIncomesChange={() => undefined}
        assets={[]}
      />,
    );

    expect(screen.getByTestId("select-future-income-reduction-0")).toBeTruthy();
    expect(screen.getByTestId("input-future-monthly-income-0")).toBeTruthy();
    expect(screen.getByTestId("input-future-income-date-0")).toBeTruthy();
    expect(screen.getByTestId("input-future-income-reason-0")).toBeTruthy();
  });
});
