import { describe, expect, it } from "vitest";
import {
  autopilotSourceRule,
  planFollowUpForFlag,
} from "../server/services/autopilot/followUps";
import type { PreUwFlag } from "../server/services/preUnderwriting";

function flag(partial: Partial<PreUwFlag> & Pick<PreUwFlag, "code">): PreUwFlag {
  return {
    severity: "warning",
    reason: "Reason text.",
    requiredDocs: [{ documentType: "other", description: "doc" }],
    ...partial,
  };
}

describe("planFollowUpForFlag", () => {
  it("materializes LARGE_DEPOSIT_SOURCING as an assets condition citing B3-4.2-02, not the gift section", () => {
    const plan = planFollowUpForFlag(
      flag({
        code: "LARGE_DEPOSIT_SOURCING",
        reason: "We noticed a deposit of $15,000.",
        requiredDocs: [
          { documentType: "gift_letter", description: "gift letter" },
          { documentType: "other", description: "sourcing docs" },
        ],
      }),
    );
    expect(plan).not.toBeNull();
    expect(plan!.category).toBe("assets");
    expect(plan!.priority).toBe("prior_to_docs");
    expect(plan!.sourceRule).toBe("AUTOPILOT_LARGE_DEPOSIT_SOURCING");
    // The borrower-facing reason AND the guideline citation are both present.
    expect(plan!.description).toContain("We noticed a deposit of $15,000.");
    // The sourcing rule is B3-4.2-02 ("Evaluating Large Deposits"); B3-4.3-04
    // carries only the gift letter that can resolve one, so it stays named too.
    expect(plan!.description).toContain("Fannie Mae B3-4.2-02");
    expect(plan!.description).toContain("B3-4.3-04");
    // Required docs are de-duplicated from the flag.
    expect(plan!.requiredDocumentTypes).toEqual(["gift_letter", "other"]);
  });

  it("escalates a blocking flag to prior_to_approval", () => {
    const plan = planFollowUpForFlag(flag({ code: "INCOME_SEASONING", severity: "blocking" }));
    expect(plan).not.toBeNull();
    expect(plan!.priority).toBe("prior_to_approval");
    expect(plan!.description).toContain("Fannie Mae B3-3.5-01");
  });

  it("preserves an evidence-specific condition identity", () => {
    const plan = planFollowUpForFlag(flag({
      code: "LARGE_DEPOSIT_SOURCING",
      conditionSourceRule: "AUTOPILOT_LARGE_DEPOSIT_SOURCING:abc123",
    }));
    expect(plan?.sourceRule).toBe("AUTOPILOT_LARGE_DEPOSIT_SOURCING:abc123");
  });

  it("cites B3-6-05 for VERIFIED_DEBT_DTI and B3-3.8-01 for rental offsets", () => {
    expect(planFollowUpForFlag(flag({ code: "VERIFIED_DEBT_DTI" }))!.description).toContain(
      "Fannie Mae B3-6-05",
    );
    expect(planFollowUpForFlag(flag({ code: "RENTAL_INCOME_OFFSET" }))!.description).toContain(
      "Fannie Mae B3-3.8-01",
    );
    expect(
      planFollowUpForFlag(flag({ code: "SUBJECT_PROPERTY_RENTAL_OFFSET" }))!.description,
    ).toContain("Fannie Mae B3-3.8-01");
  });

  it("does NOT materialize LOW_RESERVES (already handled) or COMPLEX_INCOME_CHECK (pipelineEngine)", () => {
    // no-citation-no-duplication: these are excluded so Autopilot never
    // double-asks or fires a rule without an in-repo Selling-Guide citation.
    expect(planFollowUpForFlag(flag({ code: "LOW_RESERVES_WARNING" }))).toBeNull();
    expect(planFollowUpForFlag(flag({ code: "COMPLEX_INCOME_CHECK", severity: "blocking" }))).toBeNull();
  });

  it("produces a stable, per-flag idempotency source rule", () => {
    expect(autopilotSourceRule("LARGE_DEPOSIT_SOURCING")).toBe("AUTOPILOT_LARGE_DEPOSIT_SOURCING");
    expect(autopilotSourceRule("VERIFIED_DEBT_DTI")).toBe("AUTOPILOT_VERIFIED_DEBT_DTI");
  });
});
