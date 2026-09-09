import { describe, it, expect } from "vitest";
import {
  deriveSubmissionStages,
  type StageDerivationInputs,
} from "../server/services/brokerSubmissionReadiness";

// ---------------------------------------------------------------------------
// Broker workflow stage derivation. Pure function — no DB. The division of
// labor under test: stages 1–3 gate the wholesale-lender submission; stage 4
// (Fannie Mae delivery edits) is informational only, because closing data
// and loan delivery belong to the wholesale lender, not the broker.
// ---------------------------------------------------------------------------

function cleanInputs(overrides: Partial<StageDerivationInputs> = {}): StageDerivationInputs {
  return {
    urla: {
      gseGatingFailed: false,
      criticalErrors: [],
      missingDocuments: [],
      qmStatus: "QM",
      pointsAndFeesCompliant: true,
      tridStatus: { leRequired: true, leDueDate: new Date("2099-01-01"), leIssued: true },
      ...(overrides.urla ?? {}),
    },
    uldd: { valid: true, errors: [], warnings: [], ...(overrides.uldd ?? {}) },
    // recommendation uses the production enum from ausSubmission.ts (persisted
    // verbatim by routes/aus.ts) — not the "Approve/Eligible" display form.
    aus: { casefileId: "CF-123", recommendation: "approve_eligible", lpaAssessed: true, ...(overrides.aus ?? {}) },
    consents: { eDisclosure: true, antiSteering: true, ...(overrides.consents ?? {}) },
    changeOfCircumstance: {
      openCount: 0,
      overdueRevisedLe: false,
      ...(overrides.changeOfCircumstance ?? {}),
    },
    deliveryEdits: {
      deliverable: true,
      fatalCount: 0,
      warningCount: 0,
      notEvaluatedCount: 0,
      ...(overrides.deliveryEdits ?? {}),
    },
    incomeAnalysis: {
      // Default: a clean wage-earner file that doesn't need the income package.
      requiresIncomePackage: false,
      hasCurrentEvaluation: false,
      openFlaggedReviewItems: 0,
      hasCurrentApprovedMemo: false,
      ...(overrides.incomeAnalysis ?? {}),
    },
    now: overrides.now,
  };
}

const stage = (r: ReturnType<typeof deriveSubmissionStages>, key: string) =>
  r.stages.find(s => s.key === key)!;

describe("a packaging-complete file", () => {
  it("is ready to submit to a wholesale lender", () => {
    const r = deriveSubmissionStages(cleanInputs());
    expect(r.readyToSubmitToLender).toBe(true);
    expect(stage(r, "intake").status).toBe("ready");
    expect(stage(r, "lenderPackage").status).toBe("ready");
    expect(r.nextActions).toEqual(["File is packaging-complete — select a wholesale lender and submit"]);
  });
});

describe("stage 1 — intake & disclosures", () => {
  it("blocks on missing URLA gating fields", () => {
    const r = deriveSubmissionStages(cleanInputs({ urla: { gseGatingFailed: true } as any }));
    expect(stage(r, "intake").status).toBe("blocked");
    expect(r.readyToSubmitToLender).toBe(false);
    expect(r.currentStage).toBe("intake");
  });

  it("blocks when the TRID LE deadline has passed without issuance", () => {
    const r = deriveSubmissionStages(cleanInputs({
      urla: { tridStatus: { leRequired: true, leDueDate: new Date("2026-01-02"), leIssued: false } } as any,
      now: new Date("2026-01-05"),
    }));
    expect(stage(r, "intake").blockers.some(b => b.includes("past its 3-business-day"))).toBe(true);
  });

  it("only warns while the LE clock is still running", () => {
    const r = deriveSubmissionStages(cleanInputs({
      urla: { tridStatus: { leRequired: true, leDueDate: new Date("2099-01-01"), leIssued: false } } as any,
    }));
    expect(stage(r, "intake").status).toBe("attention");
    expect(r.readyToSubmitToLender).toBe(true); // attention does not block
  });

  it("warns (not blocks) without ESIGN consent — paper delivery remains lawful", () => {
    const r = deriveSubmissionStages(cleanInputs({ consents: { eDisclosure: false, antiSteering: true } }));
    expect(stage(r, "intake").status).toBe("attention");
    expect(stage(r, "intake").blockers).toEqual([]);
  });

  it("blocks when an open change of circumstance is past its revised-LE deadline (Reg Z §1026.19(e)(4)(i))", () => {
    const r = deriveSubmissionStages(cleanInputs({
      changeOfCircumstance: { openCount: 1, overdueRevisedLe: true },
    }));
    expect(stage(r, "intake").status).toBe("blocked");
    expect(stage(r, "intake").blockers.some(b => b.includes("revised Loan Estimate"))).toBe(true);
    expect(r.readyToSubmitToLender).toBe(false);
  });

  it("warns (not blocks) while an open change of circumstance is within its revised-LE window", () => {
    const r = deriveSubmissionStages(cleanInputs({
      changeOfCircumstance: { openCount: 2, overdueRevisedLe: false },
    }));
    expect(stage(r, "intake").status).toBe("attention");
    expect(stage(r, "intake").blockers).toEqual([]);
    expect(stage(r, "intake").warnings.some(w => w.includes("change(s) of circumstance"))).toBe(true);
    expect(r.readyToSubmitToLender).toBe(true);
  });
});

describe("stage 2 — AUS", () => {
  it("blocks on critical URLA/regulatory errors", () => {
    const r = deriveSubmissionStages(cleanInputs({ urla: { criticalErrors: ["ARM: margin missing"] } as any }));
    expect(stage(r, "aus").status).toBe("blocked");
    expect(r.readyToSubmitToLender).toBe(false);
  });

  it("blocks a file that has never been run through AUS (L1: delivery gates on a clean AUS stage)", () => {
    const r = deriveSubmissionStages(cleanInputs({ aus: { casefileId: null, recommendation: null, lpaAssessed: false } }));
    expect(stage(r, "aus").status).toBe("blocked");
    expect(stage(r, "aus").blockers.some(b => b.includes("No AUS run recorded"))).toBe(true);
    expect(r.readyToSubmitToLender).toBe(false);
    expect(r.nextActions.some(a => a.includes("No AUS run recorded"))).toBe(true);
  });

  it("blocks a casefile whose recommendation was never captured", () => {
    const r = deriveSubmissionStages(cleanInputs({ aus: { casefileId: "CF-123", recommendation: null, lpaAssessed: false } }));
    expect(stage(r, "aus").status).toBe("blocked");
    expect(stage(r, "aus").blockers.some(b => b.includes("no recommendation captured"))).toBe(true);
    expect(r.readyToSubmitToLender).toBe(false);
  });

  it("blocks a recorded casefile after its decision inputs change", () => {
    const r = deriveSubmissionStages(cleanInputs({
      aus: {
        casefileId: "CF-123",
        recommendation: "approve_eligible",
        lpaAssessed: true,
        inputsCurrent: false,
        staleReason: "income evidence changed.",
      },
    }));
    expect(stage(r, "aus").status).toBe("blocked");
    expect(stage(r, "aus").blockers.some(b => b.includes("stale"))).toBe(true);
    expect(r.readyToSubmitToLender).toBe(false);
  });

  it("surfaces the manual-underwrite path without disguising it as a clean automated result", () => {
    const r = deriveSubmissionStages(cleanInputs({
      aus: {
        casefileId: "CF-123",
        recommendation: "refer_with_caution",
        lpaAssessed: true,
        inputsCurrent: true,
        decisionPath: "manual_underwrite",
      },
    }));
    expect(stage(r, "aus").warnings.some(w => w.includes("manual underwriting"))).toBe(true);
  });

  it("warns — never blocks — on refer / ineligible recommendations (manual broker placement stays open)", () => {
    for (const rec of ["refer", "refer_with_caution", "approve_ineligible"]) {
      const r = deriveSubmissionStages(cleanInputs({ aus: { casefileId: "CF-123", recommendation: rec, lpaAssessed: true } }));
      expect(stage(r, "aus").status).toBe("attention");
      expect(stage(r, "aus").blockers).toEqual([]);
      expect(stage(r, "aus").warnings.some(w => w.includes("manual broker decision"))).toBe(true);
      expect(r.readyToSubmitToLender).toBe(true);
    }
  });

  it("flags DU-only casefiles until the LPA leg has run (dual-AUS doctrine)", () => {
    const duOnly = deriveSubmissionStages(cleanInputs({
      aus: { casefileId: "CF-123", recommendation: "approve_eligible", lpaAssessed: false },
    }));
    expect(stage(duOnly, "aus").warnings.some(w => w.includes("LPA leg has not run"))).toBe(true);
    expect(stage(duOnly, "aus").status).toBe("attention");

    const dual = deriveSubmissionStages(cleanInputs());
    expect(stage(dual, "aus").warnings).toEqual([]);
    expect(stage(dual, "aus").status).toBe("ready");
  });
});

describe("stage 3 — wholesale lender package", () => {
  it("blocks when the MISMO file is invalid", () => {
    const r = deriveSubmissionStages(cleanInputs({
      uldd: { valid: false, errors: ["NoteAmount is required and must be greater than 0"], warnings: [] },
    }));
    expect(stage(r, "lenderPackage").status).toBe("blocked");
    expect(stage(r, "lenderPackage").blockers[0]).toContain("NoteAmount");
  });

  it("blocks on outstanding required documents", () => {
    const r = deriveSubmissionStages(cleanInputs({ urla: { missingDocuments: ["paystub", "w2"] } as any }));
    expect(stage(r, "lenderPackage").blockers.some(b => b.includes("2 required document(s)"))).toBe(true);
  });

  it("blocks when points and fees fail the QM pre-flight", () => {
    const r = deriveSubmissionStages(cleanInputs({
      urla: { qmStatus: "Non-QM", pointsAndFeesCompliant: false } as any,
    }));
    expect(stage(r, "lenderPackage").blockers.some(b => b.includes("QM pre-flight"))).toBe(true);
  });

  it("blocks without the anti-steering disclosure (Reg Z §1026.36(e)(3))", () => {
    const r = deriveSubmissionStages(cleanInputs({ consents: { eDisclosure: true, antiSteering: false } }));
    expect(stage(r, "lenderPackage").blockers.some(b => b.includes("Anti-steering"))).toBe(true);
    expect(r.readyToSubmitToLender).toBe(false);
  });
});

describe("stage 4 — delivery pre-flight is informational only", () => {
  it("never blocks the broker submission, even with fatal delivery edits", () => {
    const r = deriveSubmissionStages(cleanInputs({
      deliveryEdits: { deliverable: false, fatalCount: 7, warningCount: 2, notEvaluatedCount: 5 },
    }));
    expect(stage(r, "deliveryPreflight").status).toBe("attention");
    expect(stage(r, "deliveryPreflight").blockers).toEqual([]);
    expect(r.readyToSubmitToLender).toBe(true);
    expect(stage(r, "deliveryPreflight").warnings.some(w => w.includes("7 Loan Delivery/UCD edit(s)"))).toBe(true);
  });
});
