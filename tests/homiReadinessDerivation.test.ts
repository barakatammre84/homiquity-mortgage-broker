import { describe, expect, it } from "vitest";
import { deriveReadinessProfile } from "../server/services/coachingContext";
import type { VerifiedUserContext } from "../server/services/coachingContext";

/**
 * The readiness panel used to be authored by the model through
 * `update_readiness`. Two tests covered that tool: one pinned a placeholder
 * completionPercentage the server overwrote afterwards, the other pinned that
 * an invented tier ("definitely_approved") was coerced to a safe default.
 *
 * Both were guarding against the model — which is the tell that the model
 * should never have been holding the pen. The tool is gone; these cover the
 * server derivation that replaced it, and the same two hazards cannot arise
 * because no model input reaches this function at all.
 */

const base = (over: Partial<VerifiedUserContext> = {}): VerifiedUserContext => ({
  hasApplication: true,
  applicationStatus: "under_review",
  ...over,
});

describe("deriveReadinessProfile", () => {
  it("prefers the borrower graph's figures — the model no longer restates them", () => {
    const profile = deriveReadinessProfile(base({
      readinessTier: "almost_ready",
      completionPercentage: 72,
      completedInputs: ["annual_income", "credit_score"],
      outstandingInputs: ["bank_statements"],
    }));
    expect(profile.readinessTier).toBe("almost_ready");
    expect(profile.completionPercentage).toBe(72);
    expect(profile.completedInputs).toEqual(["annual_income", "credit_score"]);
    expect(profile.outstandingInputs).toEqual(["bank_statements"]);
  });

  it("rejects a tier the graph never produces, rather than coercing quietly", () => {
    // The old tool needed a .catch() because the MODEL supplied this value and
    // could invent "definitely_approved". Nothing can now — but the guard stays
    // so a future caller passing a stray string cannot put an unknown tier on
    // a borrower-facing panel.
    const profile = deriveReadinessProfile(base({
      readinessTier: "definitely_approved",
      completionPercentage: 30,
    }));
    expect(profile.readinessTier).toBe("building");
  });

  it("never states a duration — a timeline is a forward-looking claim", () => {
    for (const pct of [0, 30, 70, 95]) {
      const profile = deriveReadinessProfile(base({ completionPercentage: pct }));
      // No "weeks", "months", "days" — where they ARE, not how long until.
      expect(profile.estimatedTimeline).not.toMatch(/day|week|month|year/i);
      expect(profile.estimatedTimeline.length).toBeGreaterThan(0);
    }
  });

  it("is pure — same context in, same profile out", () => {
    const ctx = base({ readinessTier: "building", completionPercentage: 40 });
    expect(deriveReadinessProfile(ctx)).toEqual(deriveReadinessProfile(ctx));
  });

  it("says plainly that nothing is on file when there is no application", () => {
    const profile = deriveReadinessProfile({ hasApplication: false });
    expect(profile.completionPercentage).toBe(0);
    expect(profile.readinessTier).toBe("exploring");
    expect(profile.statusNote).toMatch(/haven't started/i);
  });

  it("derives a tier from completion when the graph supplied none", () => {
    expect(deriveReadinessProfile(base({ completionPercentage: 95 })).readinessTier).toBe("ready_now");
    expect(deriveReadinessProfile(base({ completionPercentage: 70 })).readinessTier).toBe("almost_ready");
    expect(deriveReadinessProfile(base({ completionPercentage: 30 })).readinessTier).toBe("building");
    expect(deriveReadinessProfile(base({ completionPercentage: 5 })).readinessTier).toBe("exploring");
  });

  it("does not call verified documents package-ready without an approved financial review", () => {
    const profile = deriveReadinessProfile(base({
      annualIncome: "120000",
      creditScore: "740",
      monthlyDebts: "900",
      employmentType: "employed",
      documentsUploaded: 3,
      documentsVerified: 3,
      documentsMissing: [],
      financialPackageApproved: false,
      completionPercentage: 100,
    }));
    expect(profile.statusNote).toMatch(/financial and underwriting review remain separate/i);
    expect(profile.statusNote).not.toMatch(/package preparation|package ready/i);
  });
});
