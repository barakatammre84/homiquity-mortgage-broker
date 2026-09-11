import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoanApplication } from "../shared/schema";
import {
  creditScoreToBand,
  mapIntakeToApplicationFields,
  normalizeMoney,
  syncCoachIntakeToApplication,
} from "../server/services/coachProfileSync";

// The wrapper's collaborators are mocked so these tests stay hermetic (the
// unit config never touches a database).
vi.mock("../server/storage", () => ({
  storage: {
    getLoanApplicationsByUser: vi.fn(),
    createLoanApplication: vi.fn(),
    updateLoanApplication: vi.fn(),
  },
}));
vi.mock("../server/auditLog", () => ({ logAudit: vi.fn() }));
vi.mock("../server/services/trid", () => ({
  evaluateTridTrigger: vi.fn().mockResolvedValue({ justTriggered: false, leDueDate: null }),
}));
vi.mock("../server/services/planningDocumentHandoff", () => ({
  attachPlanningDocumentsToApplication: vi.fn().mockResolvedValue({
    documents: 0,
    taxRuns: 0,
    businessEntities: 0,
    situationProfiles: 0,
  }),
}));

import { storage } from "../server/storage";
import { logAudit } from "../server/auditLog";
import { evaluateTridTrigger } from "../server/services/trid";

const ORIGINAL_ENV = { ...process.env };

function draftApp(overrides: Partial<LoanApplication> = {}): LoanApplication {
  return {
    id: "app-1",
    userId: "user-1",
    status: "draft",
    financialDataProvenance: "self_reported",
    incomeVerified: false,
    assetsVerified: false,
    creditVerified: false,
    annualIncome: null,
    monthlyDebts: null,
    creditScore: null,
    employmentType: null,
    employmentYears: null,
    downPayment: null,
    purchasePrice: null,
    propertyType: null,
    loanPurpose: null,
    isVeteran: null,
    isFirstTimeBuyer: null,
    ...overrides,
  } as unknown as LoanApplication;
}

const fakeReq = { user: { id: "user-1" }, headers: {}, ip: "127.0.0.1" } as never;

describe("normalizeMoney", () => {
  it("strips currency formatting", () => {
    expect(normalizeMoney("$85,000")).toBe("85000");
    expect(normalizeMoney(" 85,000.50 ")).toBe("85000.50");
  });

  it("expands k/m suffixes", () => {
    expect(normalizeMoney("85k")).toBe("85000");
    expect(normalizeMoney("$40K")).toBe("40000");
    expect(normalizeMoney("1.2m")).toBe("1200000");
  });

  it("returns null for unparseable input — never guesses", () => {
    expect(normalizeMoney("a lot")).toBeNull();
    expect(normalizeMoney("85k-ish")).toBeNull();
    expect(normalizeMoney("")).toBeNull();
  });
});

describe("creditScoreToBand (floor semantics — the band the score belongs to)", () => {
  it("maps scores to their containing band, not the nearest band", () => {
    // 745 is inside the 720–759 band; nearest-rounding would wrongly promote to 760.
    expect(creditScoreToBand("745")).toBe("720");
    expect(creditScoreToBand("760")).toBe("760");
    expect(creditScoreToBand("820")).toBe("760");
    expect(creditScoreToBand("680")).toBe("680");
    expect(creditScoreToBand("615")).toBe("600");
  });

  it("refuses to fabricate a band below 600 or outside plausible range", () => {
    expect(creditScoreToBand("590")).toBeNull();
    expect(creditScoreToBand("250")).toBeNull();
    expect(creditScoreToBand("900")).toBeNull();
    expect(creditScoreToBand("excellent")).toBeNull();
  });
});

describe("mapIntakeToApplicationFields", () => {
  it("maps a full chat intake to column-typed values (fresh draft)", () => {
    const { applied, appliedFields, skipped } = mapIntakeToApplicationFields(
      {
        annualIncome: "$85,000",
        monthlyDebts: "1,200",
        creditScore: "720",
        employmentType: "Employed",
        employmentYears: "5",
        downPayment: "40k",
        purchasePrice: "350000",
        propertyType: "single_family",
        loanPurpose: "purchase",
        isVeteran: false,
        isFirstTimeBuyer: true,
      },
      null,
    );
    expect(skipped).toEqual([]);
    expect(applied.annualIncome).toBe("85000");
    expect(applied.monthlyDebts).toBe("1200");
    expect(applied.creditScore).toBe(720); // band → integer via the shared schema
    expect(applied.employmentType).toBe("employed");
    expect(applied.employmentYears).toBe(5);
    expect(applied.downPayment).toBe("40000");
    expect(applied.purchasePrice).toBe("350000");
    expect(applied.isVeteran).toBe(false);
    expect(applied.isFirstTimeBuyer).toBe(true);
    expect(appliedFields.map((f) => f.field)).toContain("creditScore");
  });

  it("skips everything on a submitted application", () => {
    const result = mapIntakeToApplicationFields(
      { annualIncome: "90000" },
      draftApp({ status: "submitted" }),
    );
    expect(result.appliedFields).toEqual([]);
    expect(result.skipped).toEqual([{ field: "annualIncome", reason: "application_submitted" }]);
  });

  it("skips everything once provenance is no longer self_reported", () => {
    const result = mapIntakeToApplicationFields(
      { annualIncome: "90000", creditScore: "700" },
      draftApp({ financialDataProvenance: "verified" }),
    );
    expect(result.appliedFields).toEqual([]);
    expect(result.skipped.every((s) => s.reason === "provenance_locked")).toBe(true);
  });

  it("locks verified dimensions individually", () => {
    const result = mapIntakeToApplicationFields(
      { annualIncome: "90000", employmentType: "employed", creditScore: "700" },
      draftApp({ incomeVerified: true }),
    );
    const skippedFields = result.skipped.map((s) => s.field).sort();
    expect(skippedFields).toEqual(["annualIncome", "employmentType"]);
    expect(result.skipped.every((s) => s.reason === "verified_locked")).toBe(true);
    expect(result.applied.creditScore).toBe(680); // 700 floors into the 680–719 band
  });

  it("skips unchanged values (numeric-aware: 85000 == '85000.00')", () => {
    const result = mapIntakeToApplicationFields(
      { annualIncome: "85,000", creditScore: "725" },
      draftApp({ annualIncome: "85000.00" as never, creditScore: 720 as never }),
    );
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { field: "annualIncome", reason: "unchanged" },
        { field: "creditScore", reason: "unchanged" }, // 725 floors to the stored 720 band
      ]),
    );
    expect(result.appliedFields).toEqual([]);
  });

  it("overwrites a differing self-reported value on a draft (newest statement wins)", () => {
    const result = mapIntakeToApplicationFields(
      { annualIncome: "95000" },
      draftApp({ annualIncome: "85000.00" as never }),
    );
    expect(result.applied.annualIncome).toBe("95000");
  });

  it("keeps decimal employment years intact (1.5 must never become 15)", () => {
    const decimal = mapIntakeToApplicationFields({ employmentYears: "1.5" }, null);
    expect(decimal.applied.employmentYears).toBe(1); // schema floors the decimal

    const wordy = mapIntakeToApplicationFields({ employmentYears: "about 5 years" }, null);
    expect(wordy.applied.employmentYears).toBe(5);

    const nonNumeric = mapIntakeToApplicationFields({ employmentYears: "five" }, null);
    expect(nonNumeric.skipped).toEqual([{ field: "employmentYears", reason: "invalid_value" }]);
  });

  it("normalizes enum synonyms and rejects unknown enum values", () => {
    const ok = mapIntakeToApplicationFields({ employmentType: "Self Employed" }, null);
    expect(ok.applied.employmentType).toBe("self_employed");

    const bad = mapIntakeToApplicationFields({ employmentType: "unemployed" }, null);
    expect(bad.appliedFields).toEqual([]);
    expect(bad.skipped).toEqual([{ field: "employmentType", reason: "invalid_value" }]);
  });

  it("records an unmappable credit band instead of clamping", () => {
    const result = mapIntakeToApplicationFields({ creditScore: "540" }, null);
    expect(result.skipped).toEqual([{ field: "creditScore", reason: "unmappable_credit_band" }]);
  });

  it("drops only the offending field on schema violations (income of $0)", () => {
    const result = mapIntakeToApplicationFields(
      { annualIncome: "0", monthlyDebts: "1200" },
      null,
    );
    expect(result.skipped).toEqual([{ field: "annualIncome", reason: "invalid_value" }]);
    expect(result.applied.monthlyDebts).toBe("1200");
  });

  it("enforces the down-payment ≤ purchase-price cross-check within the same turn", () => {
    const result = mapIntakeToApplicationFields(
      { downPayment: "400000", purchasePrice: "350000" },
      null,
    );
    expect(result.skipped).toEqual([{ field: "downPayment", reason: "invalid_value" }]);
    expect(result.applied.purchasePrice).toBe("350000");
  });

  it("borrows the stored purchase price for the cross-check without re-applying it", () => {
    const result = mapIntakeToApplicationFields(
      { downPayment: "400000" },
      draftApp({ purchasePrice: "350000.00" as never }),
    );
    expect(result.appliedFields).toEqual([]);
    expect(result.skipped).toEqual([{ field: "downPayment", reason: "invalid_value" }]);
  });
});

describe("syncCoachIntakeToApplication (mocked persistence)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PRELAUNCH_GATED;
  });
  afterEach(() => {
    process.env.PRELAUNCH_GATED = ORIGINAL_ENV.PRELAUNCH_GATED;
    process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
  });

  it("updates the existing draft with only the applied whitelist", async () => {
    const draft = draftApp();
    vi.mocked(storage.getLoanApplicationsByUser).mockResolvedValue([draft]);
    vi.mocked(storage.updateLoanApplication).mockResolvedValue(draft);

    const result = await syncCoachIntakeToApplication(fakeReq, "user-1", { annualIncome: "85000" }, "conv-1");

    expect(result.applicationId).toBe("app-1");
    expect(result.created).toBe(false);
    expect(result.applied).toEqual([{ field: "annualIncome", value: "85000" }]);
    expect(storage.updateLoanApplication).toHaveBeenCalledWith("app-1", { annualIncome: "85000" });
    expect(evaluateTridTrigger).toHaveBeenCalledWith("app-1");
    expect(logAudit).toHaveBeenCalledWith(
      fakeReq,
      "coach.intake_synced",
      "loan_application",
      "app-1",
      expect.objectContaining({ fields: ["annualIncome"], conversationId: "conv-1" }),
    );
  });

  it("creates a fresh draft when the user has no application", async () => {
    vi.mocked(storage.getLoanApplicationsByUser).mockResolvedValue([]);
    vi.mocked(storage.createLoanApplication).mockResolvedValue(draftApp({ id: "app-new" }));

    const result = await syncCoachIntakeToApplication(fakeReq, "user-1", { creditScore: "720" }, "conv-1");

    expect(result.created).toBe(true);
    expect(result.applicationId).toBe("app-new");
    expect(storage.createLoanApplication).toHaveBeenCalledWith(
      { userId: "user-1", status: "draft" },
    );
    expect(storage.updateLoanApplication).toHaveBeenCalledWith("app-new", { creditScore: 720 });
  });

  it("refuses to fork a file when a submitted application exists and no draft", async () => {
    vi.mocked(storage.getLoanApplicationsByUser).mockResolvedValue([
      draftApp({ id: "app-live", status: "submitted" }),
    ]);

    const result = await syncCoachIntakeToApplication(fakeReq, "user-1", { annualIncome: "85000" }, "conv-1");

    expect(result.applicationId).toBeNull();
    expect(result.skipped).toEqual([{ field: "annualIncome", reason: "application_submitted" }]);
    expect(storage.createLoanApplication).not.toHaveBeenCalled();
    expect(storage.updateLoanApplication).not.toHaveBeenCalled();
  });

  it("allows a fresh draft after an all-denied history", async () => {
    vi.mocked(storage.getLoanApplicationsByUser).mockResolvedValue([
      draftApp({ id: "app-old", status: "denied" }),
    ]);
    vi.mocked(storage.createLoanApplication).mockResolvedValue(draftApp({ id: "app-new" }));

    const result = await syncCoachIntakeToApplication(fakeReq, "user-1", { annualIncome: "85000" }, "conv-1");
    expect(result.created).toBe(true);
  });

  it.each(["withdrawn", "expired", "funded"] as const)(
    "allows a fresh draft after a %s history (terminal = closed, nothing forks)",
    async (status) => {
      vi.mocked(storage.getLoanApplicationsByUser).mockResolvedValue([
        draftApp({ id: "app-old", status }),
      ]);
      vi.mocked(storage.createLoanApplication).mockResolvedValue(draftApp({ id: "app-new" }));

      const result = await syncCoachIntakeToApplication(fakeReq, "user-1", { annualIncome: "85000" }, "conv-1");
      expect(result.created).toBe(true);
      expect(result.applicationId).toBe("app-new");
    },
  );

  it("refuses to fork while a suspended file exists (paused, not closed)", async () => {
    vi.mocked(storage.getLoanApplicationsByUser).mockResolvedValue([
      draftApp({ id: "app-held", status: "suspended" }),
    ]);

    const result = await syncCoachIntakeToApplication(fakeReq, "user-1", { annualIncome: "85000" }, "conv-1");

    expect(result.applicationId).toBeNull();
    expect(result.skipped).toEqual([{ field: "annualIncome", reason: "application_submitted" }]);
    expect(storage.createLoanApplication).not.toHaveBeenCalled();
  });

  it("never creates an intake surface while prelaunch-gated", async () => {
    process.env.PRELAUNCH_GATED = "true";
    vi.mocked(storage.getLoanApplicationsByUser).mockResolvedValue([]);

    const result = await syncCoachIntakeToApplication(fakeReq, "user-1", { annualIncome: "85000" }, "conv-1");

    expect(result.applicationId).toBeNull();
    expect(result.skipped).toEqual([{ field: "annualIncome", reason: "prelaunch_gated" }]);
    expect(storage.createLoanApplication).not.toHaveBeenCalled();
  });

  it("still updates an EXISTING draft while prelaunch-gated (gate blocks creation only)", async () => {
    process.env.PRELAUNCH_GATED = "true";
    const draft = draftApp();
    vi.mocked(storage.getLoanApplicationsByUser).mockResolvedValue([draft]);
    vi.mocked(storage.updateLoanApplication).mockResolvedValue(draft);

    const result = await syncCoachIntakeToApplication(fakeReq, "user-1", { annualIncome: "85000" }, "conv-1");
    expect(result.applied.length).toBe(1);
  });

  it("returns empty for an empty intake without touching storage", async () => {
    const result = await syncCoachIntakeToApplication(fakeReq, "user-1", {}, "conv-1");
    expect(result).toEqual({ applicationId: null, created: false, applied: [], skipped: [] });
    expect(storage.getLoanApplicationsByUser).not.toHaveBeenCalled();
  });
});
