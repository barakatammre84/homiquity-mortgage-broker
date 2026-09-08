export type HomebuyerTimeline = "exploring" | "within_year" | "within_three_months";
export type HomebuyerIncomeStory = "salary" | "business" | "mixed";
export type HomebuyerBlocker = "affordability" | "savings_credit" | "income_review";
export type HomebuyerPlanningStage = "exploring" | "preparing" | "ready";

export interface HomebuyerPlanAnswers {
  timeline: HomebuyerTimeline;
  incomeStory: HomebuyerIncomeStory;
  blocker: HomebuyerBlocker;
}

export interface HomebuyerPlan {
  stage: HomebuyerPlanningStage;
  label: string;
  summary: string;
  steps: [string, string, string];
  coachPrompt: string;
}

const TIMELINE_PLAN: Record<HomebuyerTimeline, Pick<HomebuyerPlan, "stage" | "label" | "summary"> & { step: string }> = {
  exploring: {
    stage: "exploring",
    label: "Exploring",
    summary: "Start with a clear target while you still have time to make choices.",
    step: "Compare your current rent, likely budget, and lease timing before choosing a target date.",
  },
  within_year: {
    stage: "preparing",
    label: "Preparing",
    summary: "Build the financial story and evidence you will want ready before applying.",
    step: "Set a home-price target and a monthly savings rhythm you can revisit with your loan officer.",
  },
  within_three_months: {
    stage: "ready",
    label: "Ready to plan",
    summary: "Organize the file now so a loan officer can review the full picture with you.",
    step: "Choose a loan officer check-in and gather the documents connected to each income source.",
  },
};

const INCOME_STEPS: Record<HomebuyerIncomeStory, string> = {
  salary: "Keep recent pay records, W-2s, and employment details together as one income source.",
  business: "Map the business income, ownership, returns, bank statements, and profit-and-loss records you already have.",
  mixed: "Separate salary, business or contract work, and rental income so each source keeps the right evidence.",
};

const BLOCKER_STEPS: Record<HomebuyerBlocker, string> = {
  affordability: "Use a planning estimate, then review the assumptions before treating it as a working budget.",
  savings_credit: "Record your savings and credit questions, then choose one next milestone instead of guessing at qualification.",
  income_review: "Ask Homi to make an income map, then have a loan officer review anything complex or unclear.",
};

const INCOME_LABELS: Record<HomebuyerIncomeStory, string> = {
  salary: "salary income",
  business: "business income",
  mixed: "salary, business or contract, and rental income",
};

/** A public plan that organizes answers without estimating an underwriting outcome. */
export function buildHomebuyerPlan(answers: HomebuyerPlanAnswers): HomebuyerPlan {
  const timeline = TIMELINE_PLAN[answers.timeline];
  return {
    stage: timeline.stage,
    label: timeline.label,
    summary: timeline.summary,
    steps: [timeline.step, INCOME_STEPS[answers.incomeStory], BLOCKER_STEPS[answers.blocker]],
    coachPrompt: `I am currently renting and want to plan for buying a home. My timing is ${timeline.label.toLowerCase()}, my income includes ${INCOME_LABELS[answers.incomeStory]}, and I need the most help with ${answers.blocker.replace("_", " ")}. Help me organize a homebuyer plan and tell me the next information to gather.`,
  };
}
