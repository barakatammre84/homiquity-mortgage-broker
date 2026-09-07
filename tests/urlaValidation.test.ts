import { describe, expect, it } from "vitest";
import { sanitizePersonalInfoBody } from "../server/routes/urlaValidation";

describe("URLA personal-info edit round trip", () => {
  it("treats nullable unanswered identity fields as absent", () => {
    expect(sanitizePersonalInfoBody({
      firstName: "Jordan",
      lastName: "Audit",
      dateOfBirth: null,
      email: null,
    })).toEqual({
      ok: true,
      data: {
        firstName: "Jordan",
        lastName: "Audit",
        dateOfBirth: undefined,
        email: undefined,
      },
    });
  });

  it("continues to reject a malformed non-empty date", () => {
    expect(sanitizePersonalInfoBody({ dateOfBirth: "09/07/1985" })).toEqual({
      ok: false,
      error: "dateOfBirth: Date of birth must be YYYY-MM-DD",
    });
  });
});
