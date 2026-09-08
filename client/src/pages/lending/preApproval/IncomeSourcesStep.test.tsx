import { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IncomeSourcesStep } from "./IncomeSourcesStep";
import type { RentalPropertyEntry, IncomeSourceEntry, PreApprovalFormData } from "@shared/schema";

// The complex-income step is CONTROLLED on ONE value — form.incomeSources —
// and derives its selected types, per-type details and rental rows from it.
// This harness hosts that single array exactly like PreApproval's form does,
// and captures every payload the step reports upward.

function Harness({
  employmentType = "employed",
  householdAnnualIncome = "100,000",
  initialEntries = [],
  onEntries,
}: {
  employmentType?: PreApprovalFormData["employmentType"];
  householdAnnualIncome?: string;
  initialEntries?: IncomeSourceEntry[];
  onEntries: (entries: IncomeSourceEntry[]) => void;
}) {
  const [entries, setEntries] = useState<IncomeSourceEntry[]>(initialEntries);
  return (
    <IncomeSourcesStep
      employmentType={employmentType}
      householdAnnualIncome={householdAnnualIncome}
      value={entries}
      onChange={(next) => {
        setEntries(next);
        onEntries(next);
      }}
    />
  );
}

describe("IncomeSourcesStep", () => {
  it("excludes the borrower's primary income type from the additional-sources list", () => {
    render(<Harness onEntries={vi.fn()} />); // employed ⇒ primary is w2
    expect(screen.queryByTestId("toggle-income-w2")).toBeNull();
    expect(screen.getByTestId("toggle-income-rental")).toBeTruthy();
  });

  it("keeps self-employment in the list for self-employed borrowers (1099 detailing)", () => {
    render(<Harness employmentType="self_employed" onEntries={vi.fn()} />);
    expect(screen.getByTestId("toggle-income-self_employed")).toBeTruthy();
    expect(screen.getByTestId("toggle-income-w2")).toBeTruthy();
  });

  it("toggling a type opens its detail card and reports the entry upward", async () => {
    const user = userEvent.setup();
    const onEntries = vi.fn();
    render(<Harness onEntries={onEntries} />);
    await user.click(screen.getByTestId("toggle-income-investment"));
    expect(screen.getByTestId("card-income-investment")).toBeTruthy();
    expect(onEntries).toHaveBeenLastCalledWith([
      expect.objectContaining({ type: "investment", annualAmount: "" }),
    ]);
    expect(screen.getByTestId("button-toggle-income-source-chooser").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("toggle-income-investment").getAttribute("aria-pressed")).toBe("true");
  });

  it("derives rental annualAmount from Σ monthly rents × 12 — never typed directly", async () => {
    const user = userEvent.setup();
    const onEntries = vi.fn();
    render(<Harness onEntries={onEntries} />);
    await user.click(screen.getByTestId("toggle-income-rental"));
    await user.type(screen.getByTestId("input-rental-income-0"), "2000");
    const last = onEntries.mock.calls.at(-1)![0] as Array<IncomeSourceEntry & { rentalProperties?: RentalPropertyEntry[] }>;
    const rental = last.find((e) => e.type === "rental")!;
    expect(rental.annualAmount).toBe("24,000");
    expect(rental.rentalProperties?.[0]?.monthlyRentalIncome).toBe("2,000");
  });

  it("add/remove rental property rows update the reported entries", async () => {
    const user = userEvent.setup();
    const onEntries = vi.fn();
    render(<Harness onEntries={onEntries} />);
    await user.click(screen.getByTestId("toggle-income-rental"));
    await user.click(screen.getByTestId("button-add-rental-property"));
    expect(screen.getByTestId("rental-property-1")).toBeTruthy();
    await user.click(screen.getByTestId("button-remove-rental-1"));
    expect(screen.queryByTestId("rental-property-1")).toBeNull();
  });

  it("keeps a fully typed rental address when lookup is unavailable", async () => {
    const user = userEvent.setup();
    const onEntries = vi.fn();
    render(<Harness onEntries={onEntries} />);

    await user.click(screen.getByTestId("toggle-income-rental"));
    await user.type(screen.getByTestId("input-address-autocomplete"), "233 South Wacker Drive, Chicago, IL");

    const reported = onEntries.mock.calls.at(-1)![0] as Array<
      IncomeSourceEntry & { rentalProperties?: RentalPropertyEntry[] }
    >;
    expect(reported.find((entry) => entry.type === "rental")?.rentalProperties?.[0]?.address)
      .toBe("233 South Wacker Drive, Chicago, IL");
  });

  it("captures separate income details for more than one business entity", async () => {
    const user = userEvent.setup();
    const onEntries = vi.fn();
    render(<Harness employmentType="self_employed" onEntries={onEntries} />);

    await user.click(screen.getByTestId("toggle-income-self_employed"));
    await user.type(screen.getByTestId("input-income-amount-self_employed-0"), "140000");
    await user.type(screen.getByTestId("input-income-employer-self_employed-0"), "Northstar Consulting LLC");
    await user.type(screen.getByTestId("input-income-years-self_employed-0"), "6");
    await user.selectOptions(screen.getByTestId("select-business-structure-self_employed-0"), "s_corporation");
    await user.type(screen.getByTestId("input-ownership-self_employed-0"), "100");
    await user.click(screen.getByTestId("button-add-self-employed-source"));
    await user.type(screen.getByTestId("input-income-amount-self_employed-1"), "70000");
    await user.type(screen.getByTestId("input-income-employer-self_employed-1"), "Lakeview Design LLC");
    await user.type(screen.getByTestId("input-income-years-self_employed-1"), "3");
    await user.selectOptions(screen.getByTestId("select-business-structure-self_employed-1"), "single_member_llc");
    await user.type(screen.getByTestId("input-ownership-self_employed-1"), "100");

    const reported = onEntries.mock.calls.at(-1)![0] as IncomeSourceEntry[];
    expect(reported.filter((entry) => entry.type === "self_employed")).toEqual([
      expect.objectContaining({ annualAmount: "140,000", employerName: "Northstar Consulting LLC" }),
      expect.objectContaining({ annualAmount: "70,000", employerName: "Lakeview Design LLC" }),
    ]);
  });

  it("reconciles source details to the household total and flags an overage", async () => {
    const user = userEvent.setup();
    render(<Harness householdAnnualIncome="50,000" onEntries={vi.fn()} />);

    await user.click(screen.getByTestId("toggle-income-investment"));
    await user.type(screen.getByTestId("input-income-amount-investment"), "60000");

    expect(screen.getByTestId("income-breakdown-check").textContent).toContain("Above your household total");
    expect(screen.getByTestId("income-breakdown-remainder").textContent).toBe("$10,000/yr");
    expect(screen.getByText(/do not count income twice/i)).toBeTruthy();
  });

  it("collects the ownership and structure needed to route business-income review", async () => {
    const user = userEvent.setup();
    const onEntries = vi.fn();
    render(<Harness onEntries={onEntries} />);

    await user.click(screen.getByTestId("toggle-income-self_employed"));
    await user.selectOptions(screen.getByTestId("select-business-structure-self_employed-0"), "sole_proprietorship");
    await user.type(screen.getByTestId("input-ownership-self_employed-0"), "100");

    expect(onEntries.mock.calls.at(-1)![0]).toEqual([
      expect.objectContaining({
        type: "self_employed",
        businessStructure: "sole_proprietorship",
        ownershipPercent: "100",
      }),
    ]);
    expect(screen.getByTestId("complex-income-verification-note").textContent).toMatch(/tax-return cash flow/i);
  });
});

/**
 * The point of deriving instead of mirroring: rendering restored entries is now
 * the WHOLE restore. Previously the page kept three parallel useState stores,
 * and a restore that only reset the form left this step blank — which is why
 * `applyIncomeSources` existed and had to be threaded through useDraftRestore.
 */
describe("IncomeSourcesStep — restored entries render with no extra wiring", () => {
  const RESTORED: IncomeSourceEntry[] = [
    { type: "investment", annualAmount: "12,000", employerName: "Brokerage", yearsInRole: "" },
    {
      type: "rental",
      annualAmount: "24,000",
      rentalProperties: [
        { address: "1 Main St", monthlyRentalIncome: "2,000", monthlyDebtPayment: "800" },
      ],
    } as IncomeSourceEntry,
  ];

  it("shows restored sources one editable card at a time", async () => {
    const user = userEvent.setup();
    render(<Harness initialEntries={RESTORED} onEntries={vi.fn()} />);

    expect(screen.getByTestId("card-income-investment")).toBeTruthy();
    expect(screen.queryByTestId("card-income-rental")).toBeNull();
    expect(
      (screen.getByTestId("input-income-amount-investment") as HTMLInputElement).value,
    ).toBe("12,000");
    await user.click(screen.getByTestId("button-edit-income-source-1"));
    expect(screen.queryByTestId("card-income-investment")).toBeNull();
    expect(screen.getByTestId("card-income-rental")).toBeTruthy();
    expect(
      (screen.getByTestId("input-rental-income-0") as HTMLInputElement).value,
    ).toBe("2,000");
    expect((screen.getByTestId("input-rental-debt-0") as HTMLInputElement).value).toBe("800");
  });

  it("connects every visible complex-income label to its control", async () => {
    const user = userEvent.setup();
    render(<Harness employmentType="self_employed" onEntries={vi.fn()} />);
    await user.click(screen.getByTestId("toggle-income-self_employed"));

    expect(screen.getByLabelText("Annual Amount")).toBeTruthy();
    expect(screen.getByLabelText("Business or payer name")).toBeTruthy();
    expect(screen.getByLabelText("Years receiving this income")).toBeTruthy();
    expect(screen.getByLabelText("Business or income type")).toBeTruthy();
    expect(screen.getByLabelText("Your ownership")).toBeTruthy();
  });

  it("reports the rental rows on the very first toggle, not only after typing", async () => {
    const user = userEvent.setup();
    const onEntries = vi.fn();
    render(<Harness onEntries={onEntries} />);

    await user.click(screen.getByTestId("toggle-income-rental"));

    // The card renders one blank property row, and the reported entry carries
    // it. The old double-write passed the PREVIOUS (empty) rental array here,
    // so the form said "no properties" while the screen showed one.
    expect(screen.getByTestId("rental-property-0")).toBeTruthy();
    const reported = onEntries.mock.calls.at(-1)![0] as Array<
      IncomeSourceEntry & { rentalProperties?: RentalPropertyEntry[] }
    >;
    expect(reported.find((e) => e.type === "rental")?.rentalProperties).toHaveLength(1);
  });

  it("deselecting a type drops its details entirely", async () => {
    const user = userEvent.setup();
    const onEntries = vi.fn();
    render(<Harness initialEntries={RESTORED} onEntries={onEntries} />);

    await user.click(screen.getByTestId("toggle-income-investment"));

    expect(screen.queryByTestId("card-income-investment")).toBeNull();
    const reported = onEntries.mock.calls.at(-1)![0] as IncomeSourceEntry[];
    expect(reported.map((e) => e.type)).toEqual(["rental"]);
  });
});
