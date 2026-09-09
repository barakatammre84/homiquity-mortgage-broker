import { describe, expect, it } from "vitest";
import { fingerprintAusSubmissionInputs } from "../server/services/ausDecisionIntegrity";

describe("AUS input fingerprint", () => {
  it("is stable across object key order", () => {
    expect(fingerprintAusSubmissionInputs({ b: 2, a: { d: 4, c: 3 } })).toBe(
      fingerprintAusSubmissionInputs({ a: { c: 3, d: 4 }, b: 2 }),
    );
  });

  it("changes for a material borrower or evidence input", () => {
    const original = fingerprintAusSubmissionInputs({
      dti: 0.38,
      creditScore: 740,
      evidenceFingerprint: "old",
    });
    expect(fingerprintAusSubmissionInputs({
      dti: 0.41,
      creditScore: 740,
      evidenceFingerprint: "old",
    })).not.toBe(original);
    expect(fingerprintAusSubmissionInputs({
      dti: 0.38,
      creditScore: 740,
      evidenceFingerprint: "new",
    })).not.toBe(original);
  });
});
