import { describe, expect, it } from "vitest";
import { deriveHomebuyerPlanningStage } from "../shared/homebuyerJourney";

describe("deriveHomebuyerPlanningStage", () => {
  it("tracks someone without a saved goal as exploring", () => {
    expect(deriveHomebuyerPlanningStage(null)).toBe("exploring");
  });

  it.each(["discovery", "credit_cleanup", "saving", null])("tracks a saved %s journey as preparing", (currentPhase) => {
    expect(deriveHomebuyerPlanningStage({ currentPhase })).toBe("preparing");
  });

  it("reserves ready for the persisted ready phase", () => {
    expect(deriveHomebuyerPlanningStage({ currentPhase: "ready" })).toBe("ready");
  });
});
