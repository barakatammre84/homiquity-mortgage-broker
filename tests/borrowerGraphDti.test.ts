import { describe, expect, it } from "vitest";
import { usableApplicationDti } from "../server/services/borrowerGraph";

describe("borrower graph DTI publication", () => {
  it("treats the application default as uncalculated", () => {
    expect(usableApplicationDti("0.00")).toBeNull();
    expect(usableApplicationDti(0)).toBeNull();
  });

  it("publishes a real calculated ratio", () => {
    expect(usableApplicationDti("37.42")).toBe(37.42);
  });
});
