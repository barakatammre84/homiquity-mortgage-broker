import { describe, expect, it } from "vitest";
import { buildHomebuyerPlan } from "./homebuyerPlan";

describe("buildHomebuyerPlan", () => {
  it("keeps a long-horizon renter in an exploring planning stage", () => {
    const plan = buildHomebuyerPlan({
      timeline: "exploring",
      incomeStory: "salary",
      blocker: "affordability",
    });

    expect(plan.stage).toBe("exploring");
    expect(plan.steps.join(" ")).toMatch(/budget|rent|lease/i);
  });

  it("creates a complex-income preparation plan without implying approval", () => {
    const plan = buildHomebuyerPlan({
      timeline: "within_year",
      incomeStory: "mixed",
      blocker: "income_review",
    });

    expect(plan.stage).toBe("preparing");
    expect(plan.steps.join(" ")).toMatch(/income|business|rental/i);
    expect(`${plan.label} ${plan.summary} ${plan.steps.join(" ")}`).not.toMatch(/pre-?approved|guaranteed/i);
  });

  it("uses ready as a planning stage and names human review", () => {
    const plan = buildHomebuyerPlan({
      timeline: "within_three_months",
      incomeStory: "business",
      blocker: "savings_credit",
    });

    expect(plan.stage).toBe("ready");
    expect(plan.steps.join(" ")).toMatch(/loan officer/i);
    expect(plan.coachPrompt).toMatch(/business income/i);
  });
});
