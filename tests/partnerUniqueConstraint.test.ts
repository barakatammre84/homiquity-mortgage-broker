import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "../server/routes/partners";

describe("partner registration unique-constraint handling", () => {
  it("recognizes direct and Drizzle-wrapped PostgreSQL unique violations", () => {
    expect(isUniqueConstraintError({ code: "23505" })).toBe(true);
    expect(isUniqueConstraintError({ cause: { code: "23505" } })).toBe(true);
  });

  it("does not retry unrelated database failures", () => {
    expect(isUniqueConstraintError({ cause: { code: "23503" } })).toBe(false);
    expect(isUniqueConstraintError(new Error("connection lost"))).toBe(false);
  });
});
