import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { dashboardKeys, urlaKeys } from "@/lib/queryClient";
import { orderEmploymentRecords, prefillPrimaryEmployment, prefillPrimaryPersonalInfo, prefillRealEstateOwned } from "./urla/types";

// The #451 defect, for the OTHER borrower.
//
// `POST /api/urla/:id/save` is upsert-only and the client drops any row the
// database would reject (`isUrlaRowSaveable` — an asset with no `account_type`
// violates NOT NULL). #451 made that honest: `describeUnsavedRows()` names the
// dropped rows so the toast stops claiming "Everything is safely stored" over
// a row that vanished.
//
// It named `borrowerData[1]` rows only. `buildPayload()` filters slot 2 through
// the SAME predicate whenever `hasCoBorrower` is set, so a co-borrower's
// half-filled asset was: dropped from the payload, reported as a clean save,
// and then erased from the screen by the post-save refetch — no state existed
// in which the borrower could tell. Co-borrower assets and liabilities are
// qualifying data; losing them silently understates the file.
//
// These tests drive the real page: hydrate a co-borrower, switch to their tab,
// type into an asset row without an account type, save. Verified honest by
// reverting the fix — case 1 then fails with the "Application saved /
// Everything is safely stored" toast, which is exactly the bug.

const apiRequest = vi.fn();
const toast = vi.fn();

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return {
    ...actual,
    apiRequest: (...args: unknown[]) => apiRequest(...args),
  };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ isLoading: false }) }));
vi.mock("@/hooks/useActivityTracker", () => ({
  useTrackActivity: () => vi.fn(),
  useTrackFormStart: () => vi.fn(),
}));
vi.mock("wouter", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

import URLAForm, { isEmploymentSectionComplete } from "./URLAForm";

const APP_ID = "app-1";

const application = {
  id: APP_ID,
  status: "documents_pending",
  propertyAddress: "1 Main St",
  purchasePrice: "400000",
  preferredLoanType: "conventional",
  amortizationType: "fixed",
  ownsOtherRealEstate: false,
};

describe("URLA intake handoff", () => {
  it("turns every captured self-employed entity into editable URLA state", () => {
    const records = prefillPrimaryEmployment([], {
      ...application,
      employmentType: "self_employed",
      employmentYears: 6,
      annualIncome: "240000",
      incomeSources: [
        { type: "self_employed", annualAmount: "140000", employerName: "Northstar Consulting LLC", yearsInRole: "6" },
        { type: "rental", annualAmount: "36000" },
        { type: "self_employed", annualAmount: "70000", employerName: "Lakeview Design LLC", yearsInRole: "3" },
      ],
    } as never);

    expect(records).toEqual([
      expect.objectContaining({ employerName: "Northstar Consulting LLC", baseIncome: "11666.67", isSelfEmployed: true, employmentType: "current" }),
      expect.objectContaining({ employerName: "Lakeview Design LLC", baseIncome: "5833.33", isSelfEmployed: true, employmentType: "additional" }),
    ]);
  });

  it("keeps current and additional businesses in the borrower's intended order after refetch", () => {
    const records = orderEmploymentRecords([
      { id: "newer", employmentType: "additional", employerName: "Lakeview Design LLC" },
      { id: "older", employmentType: "current", employerName: "Northstar Consulting LLC" },
      { id: "oldest", employmentType: "previous", employerName: "Prior Studio" },
    ] as never);

    expect(records.map((record) => record.employerName)).toEqual([
      "Northstar Consulting LLC",
      "Lakeview Design LLC",
      "Prior Studio",
    ]);
  });

  it("reuses signup identity until the borrower has saved URLA identity", () => {
    expect(prefillPrimaryPersonalInfo(undefined, {
      firstName: "Jordan",
      lastName: "Audit",
      email: "jse@test.local",
    } as never)).toEqual({
      firstName: "Jordan",
      lastName: "Audit",
      email: "jse@test.local",
    });
  });

  it("carries rental address, rent, and payment into editable URLA property state", () => {
    const properties = prefillRealEstateOwned([], {
      ...application,
      ownsOtherRealEstate: null,
      incomeSources: [{
        type: "rental",
        annualAmount: "36000",
        rentalProperties: [{
          address: "233 South Wacker Drive",
          city: "Chicago",
          state: "IL",
          monthlyRentalIncome: "3000",
          monthlyDebtPayment: "1450",
        }],
      }],
    } as never);

    expect(properties).toEqual([expect.objectContaining({
      propertyAddress: "233 South Wacker Drive",
      propertyCity: "Chicago",
      propertyState: "IL",
      monthlyRentalIncome: "3000",
      mortgagePayment: "1450",
      occupancyType: "investment",
      verificationSource: "borrower_intake",
    })]);
  });

  it("keeps saved URLA property details instead of overwriting them from intake", () => {
    const saved = [{ id: "reo-1", propertyAddress: "Corrected address", marketValue: "525000" }];
    expect(prefillRealEstateOwned(saved as never, {
      ...application,
      incomeSources: [{
        type: "rental",
        annualAmount: "12000",
        rentalProperties: [{ address: "Old intake address", monthlyRentalIncome: "1000" }],
      }],
    } as never)).toBe(saved);
  });

  it("falls back through blank values from a partial URLA row", () => {
    expect(prefillPrimaryPersonalInfo({
      firstName: "Casey",
      lastName: "",
      email: "",
    } as never, {
      firstName: "Signup",
      lastName: "Complex",
      email: "casey@example.test",
    } as never)).toMatchObject({
      firstName: "Casey",
      lastName: "Complex",
      email: "casey@example.test",
    });
  });

  it("does not mark self-employed work complete before the income worksheet and ownership are captured", () => {
    expect(isEmploymentSectionComplete([
      { employerName: "Northstar Consulting LLC", isSelfEmployed: true },
    ])).toBe(false);

    expect(isEmploymentSectionComplete([
      {
        employerName: "Northstar Consulting LLC",
        isSelfEmployed: true,
        selfEmploymentIncome: {
          version: 1,
          businessStructure: "single_member_llc",
          ownershipPercent: 100,
          yearsSelfEmployed: 6,
          scheduleC: {
            currentYear: {
              netProfitOrLoss: 0,
              depreciation: 0,
              depletion: 0,
              amortizationOrCasualtyLoss: 0,
              businessUseOfHome: 0,
              mealsExclusion: 0,
              nonRecurringIncome: 0,
            },
          },
        },
      },
    ])).toBe(false);

    expect(isEmploymentSectionComplete([
      {
        employerName: "Northstar Consulting LLC",
        isSelfEmployed: true,
        selfEmploymentIncome: {
          version: 1,
          businessStructure: "single_member_llc",
          ownershipPercent: 100,
          yearsSelfEmployed: 6,
          scheduleC: {
            currentYear: {
              netProfitOrLoss: 140000,
              depreciation: 0,
              depletion: 0,
              amortizationOrCasualtyLoss: 0,
              businessUseOfHome: 0,
              mealsExclusion: 0,
              nonRecurringIncome: 0,
            },
          },
        },
      },
    ])).toBe(true);

    expect(isEmploymentSectionComplete([
      {
        employerName: "Northstar Consulting LLC",
        isSelfEmployed: true,
        selfEmploymentIncome: {
          version: 1,
          businessStructure: "single_member_llc",
          ownershipPercent: 100,
          yearsSelfEmployed: 6,
          scheduleC: { currentYear: { netProfitOrLoss: 140000, depreciation: 0, depletion: 0, amortizationOrCasualtyLoss: 0, businessUseOfHome: 0, mealsExclusion: 0, nonRecurringIncome: 0 } },
        },
      },
      { employerName: "Lakeview Design LLC", isSelfEmployed: true },
    ])).toBe(false);
  });
});

/**
 * Seeds a file that already has a co-borrower, so `hasCoBorrower` latches from
 * hydration rather than from a click. Nothing here is incomplete — the
 * incomplete row is what the test types in, because the server cannot hold one
 * (that is the whole point of the NOT NULL filter).
 */
function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: () => new Promise(() => {}),
      },
      mutations: { retry: false },
    },
  });
  client.setQueryData(dashboardKeys.root(), { applications: [application] });
  client.setQueryData(urlaKeys.detail(APP_ID), {
    application,
    allPersonalInfo: [
      { borrowerSequenceNumber: 1, firstName: "Ada", lastName: "Primary" },
      { borrowerSequenceNumber: 2, firstName: "Cleo", lastName: "Coborrower" },
    ],
    employmentHistory: [],
    assets: [],
    liabilities: [],
    allDeclarations: [],
    hmdaDemographics: [],
    otherIncomeSources: [],
    propertyInfo: {},
    realEstateOwned: [],
  });

  return render(
    <QueryClientProvider client={client}>
      <URLAForm />
    </QueryClientProvider>,
  );
}

/**
 * Walk to the Assets step the way a borrower does — the page's own Continue
 * button. Radix `TabsTrigger` does not activate under `fireEvent.click` in
 * happy-dom, and driving the real control is the more faithful path anyway.
 * Each Continue fires a SILENT save (no toast), which is why the assertions
 * below read the LAST toast/request rather than the first.
 */
async function continueToAssets() {
  for (const _ of ["borrower", "employment"]) {
    fireEvent.click(await screen.findByTestId("button-urla-continue"));
  }
  return screen.findByTestId("input-institution-0");
}

/** The save toast's description, whichever variant fired. */
function lastToastDescription(): string {
  const call = toast.mock.calls.at(-1);
  return String(call?.[0]?.description ?? "");
}

describe("URLAForm — rows the save drops are reported for BOTH borrowers", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ json: async () => ({ ok: true }) });
    toast.mockReset();
    window.sessionStorage.clear();
  });

  it("names the co-borrower's incomplete asset row instead of claiming a clean save", async () => {
    renderPage();

    // Switch to the co-borrower, then to their Assets section.
    fireEvent.click(await screen.findByTestId("button-borrower-co"));

    // A bank with no account type — the exact shape `isUrlaRowSaveable`
    // filters out, because `urla_assets.account_type` is NOT NULL.
    fireEvent.change(await continueToAssets(), {
      target: { value: "Second National" },
    });

    fireEvent.click(screen.getByTestId("button-save-urla-top"));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(lastToastDescription()).toContain("co-borrower asset row still needs an account type");
    expect(lastToastDescription()).not.toContain("Everything is safely stored");
  });

  it("still drops the row from the payload — the fix is the telling, not the sending", async () => {
    renderPage();

    fireEvent.click(await screen.findByTestId("button-borrower-co"));
    fireEvent.change(await continueToAssets(), {
      target: { value: "Second National" },
    });
    apiRequest.mockClear(); // drop the two silent step saves
    fireEvent.click(screen.getByTestId("button-save-urla-top"));

    await waitFor(() => expect(apiRequest).toHaveBeenCalled());
    const [, url, payload] = apiRequest.mock.calls[0] as [string, string, Record<string, any>];
    expect(url).toBe(`/api/urla/${APP_ID}/save`);
    expect(payload.coApplicants?.[0]?.assets ?? []).toHaveLength(0);
  });

  it("names whose rows they are once a second borrower exists", async () => {
    renderPage();

    // Primary's own asset row, same incomplete shape.
    fireEvent.change(await continueToAssets(), {
      target: { value: "First National" },
    });
    fireEvent.click(screen.getByTestId("button-save-urla-top"));

    await waitFor(() => expect(toast).toHaveBeenCalled());
    // "an asset row" would be ambiguous with two borrowers on the file.
    expect(lastToastDescription()).toContain("your asset row still needs an account type");
  });
});


/**
 * The step rail's mobile contract. It shipped as `overflow-x-auto`, a horizontally
 * scrolling rail whose seven `shrink-0` triggers put steps 4–7 off-screen at 320px
 * with no affordance that they existed — DESIGN_SYSTEM.md §12.3 forbids horizontal
 * scrolling on a capture screen.
 *
 * happy-dom has no layout engine, so none of this measures a rendered viewport. It
 * pins the CONTRACT that makes the steps reachable: no width-gated scroller, every
 * step present, and — because the labels are visually hidden below lg — each tab
 * keeps its accessible name and the active step's name is rendered in the panel.
 */
describe("URLAForm — the step rail is reachable on a phone", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ json: async () => ({ ok: true }) });
    toast.mockReset();
    window.sessionStorage.clear();
  });

  const STEP_IDS = [
    "borrower",
    "employment",
    "assets",
    "liabilities",
    "property",
    "declarations",
    "demographics",
  ];

  it("never re-introduces a horizontally scrolling rail", async () => {
    renderPage();
    const list = await screen.findByRole("tablist");
    expect(list.className.split(/\s+/)).not.toContain("overflow-x-auto");
    expect(list.className).toContain("flex-wrap");
  });

  it("renders all seven steps, each keeping its accessible name", async () => {
    renderPage();
    await screen.findByTestId("tab-borrower");
    for (const id of STEP_IDS) {
      expect(screen.getByTestId(`tab-${id}`)).toBeTruthy();
    }
    // Labels are sr-only below lg, so they must still be in the DOM — a tab whose
    // name is only a number is unusable with a screen reader.
    expect(screen.getByTestId("tab-borrower").textContent).toContain("About you");
    expect(screen.getByTestId("tab-demographics").textContent).toContain("Demographics");
  });

  it("names the active step in the panel, where the phone can see it", async () => {
    renderPage();
    expect((await screen.findByTestId("text-urla-step-label")).textContent).toBe("About you");
  });
});


/**
 * The progress bar describes the APPLICATION, and says so — `aria-label`
 * "Application progress", visible text "N of M sections complete". It was
 * computed from the ACTIVE borrower's slice alone, so on a file with a
 * co-borrower it described a person while claiming to describe the file:
 *
 *   - open on the primary, whose sections are done → "5 of 7 sections
 *     complete", a nearly full bar, with the co-borrower's six sections empty;
 *   - click Co-Borrower and the same bar reads "1 of 7" — finished work
 *     rendering as less progress (DESIGN_SYSTEM §13 Agreement: no two elements
 *     disagree about the same fact).
 *
 * The higher reading is the harmful one: URLA is what the ULDD/URLA package is
 * built from, and a borrower told their application is nearly done has no
 * reason to open the other tab.
 *
 * The fix counts every per-borrower section once per borrower and the shared
 * property/loan section once — so the number cannot change with the tab, and
 * the numerator only ever rises. Verified honest by reverting to
 * `STEPS.filter((s) => s.isComplete(stepContext)).length`: the first two
 * assertions below then read "5 of 7" and "1 of 7", which is the bug.
 */
describe("URLAForm — the progress bar counts the application, not the open tab", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    apiRequest.mockResolvedValue({ json: async () => ({ ok: true }) });
    toast.mockReset();
    window.sessionStorage.clear();
  });

  /** Primary finished through Liabilities; the property/loan section is shared. */
  const PRIMARY_DONE = {
    application,
    allPersonalInfo: [
      {
        borrowerSequenceNumber: 1,
        firstName: "Ada",
        lastName: "Primary",
        dateOfBirth: "1985-04-02",
        ssnLast4: "1234",
      },
    ],
    employmentHistory: [{ borrowerSequenceNumber: 1, employerName: "Acme" }],
    assets: [{ borrowerSequenceNumber: 1, accountType: "checking" }],
    liabilities: [{ borrowerSequenceNumber: 1, liabilityType: "auto_loan" }],
    allDeclarations: [],
    hmdaDemographics: [],
    otherIncomeSources: [],
    propertyInfo: { propertyStreet: "1 Main St", propertyValue: "400000" },
    realEstateOwned: [],
  };

  /** Same file, plus a co-borrower with nothing but a name. */
  const WITH_COBORROWER = {
    ...PRIMARY_DONE,
    allPersonalInfo: [
      ...PRIMARY_DONE.allPersonalInfo,
      { borrowerSequenceNumber: 2, firstName: "Cleo", lastName: "Coborrower" },
    ],
  };

  function renderWith(urla: Record<string, unknown>) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, queryFn: () => new Promise(() => {}) },
        mutations: { retry: false },
      },
    });
    client.setQueryData(dashboardKeys.root(), { applications: [application] });
    client.setQueryData(urlaKeys.detail(APP_ID), urla);
    return render(
      <QueryClientProvider client={client}>
        <URLAForm />
      </QueryClientProvider>,
    );
  }

  it("counts the co-borrower's unfinished sections instead of reporting the file nearly done", async () => {
    renderWith(WITH_COBORROWER);

    // 4 primary sections + 2 shared, out of 6 per-borrower × 2 + 2 shared.
    const progress = await screen.findByTestId("text-urla-progress");
    expect(progress.textContent).toContain("6 of 14 sections complete");
  });

  it("does not change when the borrower switches tabs — one file, one number", async () => {
    renderWith(WITH_COBORROWER);

    fireEvent.click(await screen.findByTestId("button-borrower-co"));

    const progress = await screen.findByTestId("text-urla-progress");
    expect(progress.textContent).toContain("6 of 14 sections complete");
  });

  it("stays at eight sections on a single-borrower file", async () => {
    renderWith(PRIMARY_DONE);

    const progress = await screen.findByTestId("text-urla-progress");
    expect(progress.textContent).toContain("6 of 8 sections complete");
    expect(progress.textContent).not.toContain("co-borrower");
  });
});
