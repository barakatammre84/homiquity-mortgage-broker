import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { occupancyLabel, parseOccupancyType } from "../shared/occupancy";

describe("subject-property occupancy", () => {
  it("uses the borrower's stated occupancy in customer-facing language", () => {
    expect(occupancyLabel("primary_residence")).toBe("Primary residence");
    expect(occupancyLabel("second_home")).toBe("Second home");
    expect(occupancyLabel("investment")).toBe("Investment property");
  });

  it("fails closed for absent or unknown values instead of assuming primary residence", () => {
    expect(parseOccupancyType(null)).toBeNull();
    expect(parseOccupancyType("something_new")).toBeNull();
    expect(occupancyLabel(null)).toBe("Occupancy not provided");
  });

  it("normalizes the legacy URLA primary value", () => {
    expect(parseOccupancyType("primary")).toBe("primary_residence");
  });

  it("does not hardcode primary-residence pricing or letter output", () => {
    const pricingRoute = readFileSync("server/routes/lending/pricing.ts", "utf8");
    const letterRoute = readFileSync("server/routes/lending/letters.ts", "utf8");

    expect(pricingRoute).not.toContain('occupancyType: "primary_residence"');
    expect(letterRoute).not.toContain('occupancy: "Primary"');
    expect(pricingRoute).toContain("parseOccupancyType(application.occupancyType)");
    expect(letterRoute).toContain("occupancyLetterLabel(occupancyType)");
  });
});
