import { describe, expect, it } from "vitest";
import { getChecklistStatusInfo } from "./documentChecklist";

describe("document checklist summary truth", () => {
  it("calls received-but-unverified evidence under review", () => {
    const status = getChecklistStatusInfo(true, 0, false);
    expect(status.title).toMatch(/submitted/i);
    expect(status.badgeText).toBe("Under review");
    expect(status.badgeText).not.toBe("Complete");
  });

  it("reserves complete for human-verified evidence", () => {
    const status = getChecklistStatusInfo(true, 0, true);
    expect(status.title).toMatch(/verified/i);
    expect(status.badgeText).toBe("Complete");
  });
});
