import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { setPendingCoachQuestion } from "@/lib/pendingCoachQuestion";
import { buildHomebuyerPlan, type HomebuyerBlocker, type HomebuyerIncomeStory, type HomebuyerTimeline } from "@/lib/homebuyerPlan";

const TIMELINES: Array<{ id: HomebuyerTimeline; label: string; detail: string }> = [
  { id: "exploring", label: "Just exploring", detail: "I want to understand the path." },
  { id: "within_year", label: "Within a year", detail: "I want a practical preparation plan." },
  { id: "within_three_months", label: "Within three months", detail: "I want to organize my file now." },
];
const INCOME_STORIES: Array<{ id: HomebuyerIncomeStory; label: string; detail: string }> = [
  { id: "salary", label: "Mostly salary", detail: "W-2 employment and regular pay." },
  { id: "business", label: "Business or contract", detail: "Self-employment, 1099, or business ownership." },
  { id: "mixed", label: "A mix of sources", detail: "Salary, side work, business, or rental income." },
];
const BLOCKERS: Array<{ id: HomebuyerBlocker; label: string; detail: string }> = [
  { id: "affordability", label: "What may fit my budget", detail: "I need a clearer target." },
  { id: "savings_credit", label: "Savings or credit", detail: "I need the right milestones." },
  { id: "income_review", label: "How my income will be reviewed", detail: "My financial story feels complicated." },
];

function ChoiceList<T extends string>({ choices, onChoose, prefix }: { choices: Array<{ id: T; label: string; detail: string }>; onChoose: (choice: T) => void; prefix: string }) {
  return (
    <div className="divide-y divide-border border-y border-border">
      {choices.map((choice, index) => (
        <button key={choice.id} type="button" onClick={() => onChoose(choice.id)} className="touch-target grid w-full grid-cols-[2rem_1fr] gap-3 px-1 py-4 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-3" data-testid={`${prefix}-${choice.id}`}>
          <span className="pt-0.5 text-xs font-semibold text-muted-foreground">0{index + 1}</span>
          <span>
            <span className="block font-semibold text-foreground">{choice.label}</span>
            <span className="mt-0.5 block text-sm text-muted-foreground">{choice.detail}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function HomebuyerPlanPreview() {
  const [, navigate] = useLocation();
  const { isAuthenticated } = useAuth();
  const [timeline, setTimeline] = useState<HomebuyerTimeline | null>(null);
  const [incomeStory, setIncomeStory] = useState<HomebuyerIncomeStory | null>(null);
  const [blocker, setBlocker] = useState<HomebuyerBlocker | null>(null);
  const plan = timeline && incomeStory && blocker ? buildHomebuyerPlan({ timeline, incomeStory, blocker }) : null;
  const restart = () => { setTimeline(null); setIncomeStory(null); setBlocker(null); };
  const continueWithHomi = () => {
    if (!plan) return;
    setPendingCoachQuestion(plan.coachPrompt);
    navigate(isAuthenticated ? "/ai-coach" : "/signup");
  };

  return (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-card sm:p-7" data-testid="homebuyer-plan-preview">
      {!timeline ? (
        <div data-testid="homebuyer-plan-step">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Question 1 of 3</p>
          <h3 className="font-display mt-2 text-2xl font-bold">When would you like to buy?</h3>
          <div className="mt-5"><ChoiceList choices={TIMELINES} onChoose={setTimeline} prefix="homebuyer-timeline" /></div>
        </div>
      ) : !incomeStory ? (
        <div data-testid="homebuyer-plan-step">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Question 2 of 3</p>
          <h3 className="font-display mt-2 text-2xl font-bold">How does your household earn income?</h3>
          <div className="mt-5"><ChoiceList choices={INCOME_STORIES} onChoose={setIncomeStory} prefix="homebuyer-income" /></div>
        </div>
      ) : !blocker ? (
        <div data-testid="homebuyer-plan-step">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Question 3 of 3</p>
          <h3 className="font-display mt-2 text-2xl font-bold">What feels hardest or most unclear?</h3>
          <div className="mt-5"><ChoiceList choices={BLOCKERS} onChoose={setBlocker} prefix="homebuyer-blocker" /></div>
        </div>
      ) : plan ? (
        <div data-testid="homebuyer-plan-result">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Your planning stage</p>
              <h3 className="font-display mt-1 text-3xl font-bold">{plan.label}</h3>
            </div>
            <button type="button" onClick={restart} className="touch-target text-sm font-semibold underline underline-offset-4" data-testid="button-restart-homebuyer-plan">Start over</button>
          </div>
          <p className="mt-3 leading-relaxed text-muted-foreground">{plan.summary}</p>
          <ol className="mt-5 divide-y divide-border border-y border-border" data-testid="homebuyer-plan-actions">
            {plan.steps.map((step, index) => (
              <li key={step} className="grid grid-cols-[2rem_1fr] gap-3 py-4 text-sm leading-relaxed">
                <span className="font-semibold text-flare-ink">0{index + 1}</span><span>{step}</span>
              </li>
            ))}
          </ol>
          <Button onClick={continueWithHomi} className="mt-5 w-full sm:w-auto" data-testid="button-continue-homebuyer-plan">Continue this plan with Homi</Button>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">This is a planning stage, not a loan approval, offer, or commitment. A loan officer can help review your situation.</p>
        </div>
      ) : null}
      {!plan && timeline && <button type="button" onClick={restart} className="touch-target mt-3 text-sm font-semibold underline underline-offset-4" data-testid="button-restart-homebuyer-plan">Start over</button>}
      <p className="mt-5 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground" data-testid="text-coach-disclaimer">
        Homi organizes information and provides educational guidance. It is not a loan approval, offer, or commitment; lenders make the credit decision.
      </p>
    </div>
  );
}
