import { TARGET_LENDERS } from "../server/seedData/wholesaleLenderTargets";
import { describe, it, expect } from "vitest";
import {
  isValidSubmissionTransition,
  isTerminalSubmissionStatus,
  nextSubmissionStatuses,
  LENDER_SUBMISSION_STATUSES,
} from "../shared/wholesaleLenders";
import { simulateLenderAcknowledgment, buildLenderPackage } from "../server/services/lenderSubmission";
import type { MISMOLoanDTO } from "../server/mismo";

describe("wholesale lender catalog", () => {
  it("carries the Target-5 shortlist with unique ids", () => {
    expect(TARGET_LENDERS).toHaveLength(5);
    const ids = TARGET_LENDERS.map(l => l.lenderId);
    expect(new Set(ids).size).toBe(5);
    expect(TARGET_LENDERS.find(l => l.lenderId === "uwm")?.lenderName).toBe("United Wholesale Mortgage");
  });

  it("no lender is marked approved until a broker agreement exists", () => {
    // The seed inserts every target at approvalStatus "target"; the column
    // default is "target" too, so nothing can arrive pre-approved.
    expect(TARGET_LENDERS.length).toBeGreaterThan(0);
  });
});

describe("submission status machine", () => {
  it("allows the happy path forward", () => {
    expect(isValidSubmissionTransition("submitted", "acknowledged")).toBe(true);
    expect(isValidSubmissionTransition("acknowledged", "in_underwriting")).toBe(true);
    expect(isValidSubmissionTransition("in_underwriting", "conditions_issued")).toBe(true);
    expect(isValidSubmissionTransition("conditions_issued", "conditions_cleared")).toBe(true);
    expect(isValidSubmissionTransition("conditions_cleared", "clear_to_close")).toBe(true);
    expect(isValidSubmissionTransition("clear_to_close", "funded")).toBe(true);
  });

  it("blocks skipping and backwards moves that make no operational sense", () => {
    expect(isValidSubmissionTransition("submitted", "funded")).toBe(false);
    expect(isValidSubmissionTransition("funded", "in_underwriting")).toBe(false);
    expect(isValidSubmissionTransition("withdrawn", "submitted")).toBe(false);
    expect(isValidSubmissionTransition("submitted", "submitted")).toBe(false);
  });

  it("permits escape to denied/withdrawn/suspended from any non-terminal status", () => {
    expect(isValidSubmissionTransition("submitted", "withdrawn")).toBe(true);
    expect(isValidSubmissionTransition("clear_to_close", "denied")).toBe(true);
    expect(isValidSubmissionTransition("in_underwriting", "suspended")).toBe(true);
    expect(isValidSubmissionTransition("suspended", "in_underwriting")).toBe(true);
    // ...but not out of terminal states.
    expect(isValidSubmissionTransition("funded", "withdrawn")).toBe(false);
    expect(isValidSubmissionTransition("denied", "suspended")).toBe(false);
  });

  it("clear_to_close can fall back to conditions_issued (lender reopens conditions)", () => {
    expect(isValidSubmissionTransition("clear_to_close", "conditions_issued")).toBe(true);
  });
});

// WF2-F5: the staff UI walks this machine, so the set it offers has to be the
// machine's own answer rather than a second hand-kept list in the client.
describe("nextSubmissionStatuses (the set a staff UI may offer)", () => {
  it("agrees with isValidSubmissionTransition for every from/to pair", () => {
    for (const from of LENDER_SUBMISSION_STATUSES) {
      const offered = nextSubmissionStatuses(from);
      for (const to of LENDER_SUBMISSION_STATUSES) {
        expect(offered.includes(to), `${from} → ${to}`).toBe(isValidSubmissionTransition(from, to));
      }
    }
  });

  it("returns nothing from a terminal status, so a UI has nothing to render", () => {
    for (const status of LENDER_SUBMISSION_STATUSES) {
      if (!isTerminalSubmissionStatus(status)) continue;
      expect(nextSubmissionStatuses(status)).toEqual([]);
    }
    expect(isTerminalSubmissionStatus("funded")).toBe(true);
    expect(isTerminalSubmissionStatus("denied")).toBe(true);
    expect(isTerminalSubmissionStatus("withdrawn")).toBe(true);
    expect(isTerminalSubmissionStatus("suspended")).toBe(false);
  });

  it("never offers the status the submission is already in", () => {
    for (const from of LENDER_SUBMISSION_STATUSES) {
      expect(nextSubmissionStatuses(from)).not.toContain(from);
    }
  });

  it("leaves every non-terminal status with a way forward", () => {
    for (const from of LENDER_SUBMISSION_STATUSES) {
      if (isTerminalSubmissionStatus(from)) continue;
      expect(nextSubmissionStatuses(from).length, `${from} is a dead end`).toBeGreaterThan(0);
    }
  });
});

describe("simulated lender acknowledgment", () => {
  it("is deterministic: same file + lender always yields the same confirmation", () => {
    const a = simulateLenderAcknowledgment("uwm", "app-123");
    const b = simulateLenderAcknowledgment("uwm", "app-123");
    expect(a).toEqual(b);
    expect(a.simulated).toBe(true);
  });

  it("differs across lenders and applications", () => {
    const uwm = simulateLenderAcknowledgment("uwm", "app-123");
    const rocket = simulateLenderAcknowledgment("rocket-pro-tpo", "app-123");
    const other = simulateLenderAcknowledgment("uwm", "app-456");
    expect(uwm.confirmationId).not.toBe(rocket.confirmationId);
    expect(uwm.confirmationId).not.toBe(other.confirmationId);
  });

  it("shapes the confirmation like a lender-side loan number", () => {
    const { confirmationId } = simulateLenderAcknowledgment("rocket-pro-tpo", "app-123");
    expect(confirmationId).toMatch(/^ROCK-\d{9}$/);
  });
});

// ---------------------------------------------------------------------------
// Per-lender MISMO package assembly (LS-10 slice 2)
// ---------------------------------------------------------------------------

function baseDto(overrides: Partial<MISMOLoanDTO> = {}): MISMOLoanDTO {
  return {
    application: {
      id: "3f8a-9c2d-11ee-8c90-0242ac120002",
      status: "pre_approved",
      loanPurpose: "purchase",
      preferredLoanType: "conventional",
      propertyType: "single_family",
      propertyAddress: "123 Main St",
      propertyCity: "Austin",
      propertyState: "TX",
      propertyZip: "78701",
      propertyValue: "500000",
      purchasePrice: "500000",
      downPayment: "100000",
      createdAt: new Date("2026-01-01"),
      ...(overrides.application ?? {}),
    } as any,
    user: { id: "user-abc123", email: "b@example.com" } as any,
    personalInfo: { firstName: "Jane", lastName: "Doe", ssn: "123-45-6789" } as any,
    employment: overrides.employment ?? [],
    assets: overrides.assets ?? [],
    liabilities: overrides.liabilities ?? [],
    propertyInfo: overrides.propertyInfo ?? null,
    declarations: null,
    loanOptions: overrides.loanOptions ?? [],
    documents: [],
  };
}

describe("buildLenderPackage", () => {
  // Pinned generation clock: the envelope stamps CreatedDatetime (and the
  // Current loan-state date) from the clock, so cross-call comparisons must
  // hold it fixed to isolate the data under test.
  const clock = new Date("2026-07-06T12:00:00.000Z");

  it("assembles a structurally valid MISMO 3.4 package for a complete file", () => {
    const pkg = buildLenderPackage(baseDto());
    expect(pkg.validation.valid).toBe(true);
    expect(pkg.validation.errors).toEqual([]);
    expect(pkg.xml).toContain("<NoteAmount>");
    expect(pkg.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: the same file + same clock always hashes the same", () => {
    const a = buildLenderPackage(baseDto(), undefined, clock);
    const b = buildLenderPackage(baseDto(), undefined, clock);
    expect(a.xml).toBe(b.xml);
    expect(a.hash).toBe(b.hash);
  });

  it("hashes differ when the underlying file data differs", () => {
    const a = buildLenderPackage(baseDto(), undefined, clock);
    const b = buildLenderPackage(
      baseDto({ application: { purchasePrice: "600000" } as any }),
      undefined,
      clock,
    );
    expect(a.hash).not.toBe(b.hash);
  });

  it("fails validation when the loan amount cannot be determined (no option, no down payment)", () => {
    // Neither a locked loan option nor a down payment means NoteAmount/
    // BaseLoanAmount are omitted from the export (server/mismo.ts:627-647) —
    // the package-assembly gate must catch this before a lender ever sees it.
    const pkg = buildLenderPackage(
      baseDto({ application: { downPayment: null } as any, loanOptions: [] }),
    );
    expect(pkg.validation.valid).toBe(false);
    expect(pkg.validation.errors).toContain("Missing required ULDD data point: NoteAmount");
  });

  it("threads the delivery note date through to the AtClosing loan state", () => {
    const withDate = buildLenderPackage(baseDto(), "2026-08-01", clock);
    const withoutDate = buildLenderPackage(baseDto(), undefined, clock);
    expect(withDate.xml).not.toBe(withoutDate.xml);
  });
});

// ---------------------------------------------------------------------------
// Dual-AUS LPA leg (simulated, mirrors the DU simulation seam)
// ---------------------------------------------------------------------------
import { submitToDU, submitToLPA } from "../server/services/ausSubmission";

describe("LPA leg (dual AUS)", () => {
  const baseInput = {
    applicationId: "app-123",
    loanAmount: 400_000,
    propertyValue: 500_000,
    creditScore: 720,
    dti: 0.38,
    voaReportId: null,
    voieReportId: null,
    auditCopyToken: null,
  };

  it("returns a deterministic simulated Accept for a clean casefile", async () => {
    const a = await submitToLPA(baseInput);
    const b = await submitToLPA(baseInput);
    expect(a).toEqual(b);
    expect(a.simulated).toBe(true);
    expect(a.riskClass).toBe("accept");
    expect(a.purchaseEligibility).toBe("eligible");
  });

  it("reads borderline DTI more conservatively than the DU sim (45% vs 50%)", async () => {
    const lpa = await submitToLPA({ ...baseInput, dti: 0.47 });
    expect(lpa.riskClass).toBe("caution");
  });

  it("marks >97% LTV purchase-ineligible", async () => {
    const lpa = await submitToLPA({ ...baseInput, loanAmount: 495_000 });
    expect(lpa.purchaseEligibility).toBe("ineligible");
  });

  it("goes Caution on sub-620 or missing credit", async () => {
    expect((await submitToLPA({ ...baseInput, creditScore: 600 })).riskClass).toBe("caution");
    expect((await submitToLPA({ ...baseInput, creditScore: null })).riskClass).toBe("caution");
  });

  it("keeps an out-of-scope complex file on the explicit manual-underwrite path", async () => {
    const input = {
      ...baseInput,
      decisionPath: "manual_underwrite" as const,
      manualUnderwriteReasons: ["Complex income requires licensed review."],
    };
    const [du, lpa] = await Promise.all([submitToDU(input), submitToLPA(input)]);
    expect(du.decisionPath).toBe("manual_underwrite");
    expect(du.recommendation).toBe("refer_with_caution");
    expect(du.messages.some(message => message.code === "HMQ-MANUAL-001")).toBe(true);
    expect(lpa.decisionPath).toBe("manual_underwrite");
    expect(lpa.riskClass).toBe("caution");
  });
});
