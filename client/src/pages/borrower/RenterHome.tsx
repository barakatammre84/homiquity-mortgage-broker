import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { homeownershipGoalKeys } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { PageShell } from "@/components/PageShell";
import { HomeReadinessPassport } from "@/components/HomeReadinessPassport";
import { TaxReturnInsightCard } from "@/components/TaxReturnInsightCard";
import { PartnerSharingCard } from "@/components/PartnerSharingCard";
import { formatCurrency } from "@/lib/formatters";
import type { HomebuyerPlanningStage } from "@shared/homebuyerJourney";

interface HomeownershipGoalRecord {
  currentSavingsBalance: string | null;
  currentMonthlySavings: string | null;
  currentRent: string | null;
  monthlyIncome: string | null;
  targetDownPayment: string | null;
  targetHomePrice: string | null;
  currentPhase: string | null;
  journeyDay: number | null;
}

interface JourneyMilestoneRecord {
  id: string;
  title: string;
  description: string | null;
}

interface GoalResponse {
  goal: HomeownershipGoalRecord | null;
  planningStage?: HomebuyerPlanningStage;
  milestones?: JourneyMilestoneRecord[];
}

const STAGES: Record<HomebuyerPlanningStage, { label: string; description: string }> = {
  exploring: { label: "Exploring", description: "Choose a target and understand the path before you apply." },
  preparing: { label: "Preparing", description: "Keep your income, savings, and supporting information current." },
  ready: { label: "Ready to plan", description: "Review the connected file with a loan officer and choose the next step." },
};

const TOOLKIT = [
  { href: "/gap-calculator", title: "Update my homebuyer plan", description: "Rent, income, debts, savings, and target.", testId: "renter-tool-plan" },
  { href: "/calculators/rent-vs-buy", title: "Compare renting and buying", description: "Explore the tradeoffs for your situation.", testId: "renter-tool-rent-vs-buy" },
  { href: "/my-lease", title: "Keep my lease record", description: "Store lease details and your own rent-payment record.", testId: "renter-tool-my-lease" },
  { href: "/calculators/affordability", title: "Explore buying power", description: "Build a planning estimate without applying.", testId: "renter-tool-affordability" },
] as const;

export function RenterHome({ userName }: { userName?: string }) {
  const { data: goalData } = useQuery<GoalResponse>({ queryKey: homeownershipGoalKeys.all() });
  const goal = goalData?.goal ?? null;
  const stage = goalData?.planningStage ?? (goal ? "preparing" : "exploring");
  const stageMeta = STAGES[stage];
  const milestones = goalData?.milestones ?? [];

  const target = goal?.targetDownPayment ? Number(goal.targetDownPayment) : null;
  const saved = goal?.currentSavingsBalance ? Number(goal.currentSavingsBalance) : 0;
  const remaining = target !== null ? Math.max(0, target - saved) : null;
  const savingsProgress = target && target > 0 ? Math.min((saved / target) * 100, 100) : 0;

  const planFacts = [
    { label: "Current rent", value: goal?.currentRent ? formatCurrency(Number(goal.currentRent)) : "Add to plan" },
    { label: "Household income", value: goal?.monthlyIncome ? "Self-reported" : "Add to plan" },
    { label: "Savings target", value: target ? formatCurrency(target) : "Add to plan" },
  ];

  return (
    <PageShell width="wide" className="space-y-8" data-testid="page-renter-home">
      <header className="grid gap-5 border-b border-border pb-8 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-flare-ink">Homi Homebuyer Plan</p>
          <h1 className="font-display mt-2 text-3xl font-bold tracking-tight sm:text-4xl" data-testid="text-renter-greeting">
            {userName ? `${userName}, your path starts here.` : "Your path to homeownership starts here."}
          </h1>
          <p className="mt-3 max-w-2xl leading-relaxed text-muted-foreground">Keep the plan useful before an application exists, then carry the same information into your mortgage file when you are ready.</p>
        </div>
        <div className="border-l-2 border-flare pl-4" data-testid="renter-planning-stage">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Planning stage</p>
          <p className="font-display mt-1 text-2xl font-bold">{stageMeta.label}</p>
          <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">{stageMeta.description}</p>
        </div>
      </header>

      <PartnerSharingCard />

      <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <Card data-testid="renter-next-action">
            <CardContent className="p-6">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">One next action</p>
              <h2 className="font-display mt-2 text-2xl font-bold">{goal ? "Keep your plan current" : "Build your starting plan"}</h2>
              <p className="mt-2 leading-relaxed text-muted-foreground">
                {goal
                  ? remaining !== null && remaining > 0
                    ? `Your savings plan has ${formatCurrency(remaining)} remaining. Review the target, income, and monthly savings before your next check-in.`
                    : "Your saved target is in place. Review the connected information with a loan officer before starting an application."
                  : "Add your rent, income, debts, savings, and target so Homi can keep the next milestone in one place."}
              </p>
              <Button asChild className="mt-4" data-testid="button-renter-plan">
                <Link href="/gap-calculator">{goal ? "Review My Plan" : "Build My Plan"}</Link>
              </Button>
            </CardContent>
          </Card>

          {goal && target ? (
            <Card data-testid="card-renter-goal">
              <CardContent className="space-y-3 p-6">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Down payment savings</p>
                    <p className="mt-1 font-semibold">{formatCurrency(saved)} of {formatCurrency(target)}</p>
                  </div>
                  <Link href="/gap-calculator" className="touch-target inline-flex items-center text-sm font-semibold underline underline-offset-4">Adjust</Link>
                </div>
                <Progress value={savingsProgress} aria-label={`${Math.round(savingsProgress)} percent of down payment savings target`} />
                {goal.currentMonthlySavings && (
                  <p className="text-xs text-muted-foreground">Current monthly savings plan: {formatCurrency(Number(goal.currentMonthlySavings))}.</p>
                )}
              </CardContent>
            </Card>
          ) : null}

          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Connected plan</p>
            <div className="divide-y divide-border border-y border-border">
              {planFacts.map((fact, index) => (
                <div key={fact.label} className="grid grid-cols-[2rem_1fr_auto] items-center gap-3 py-4" data-testid={`renter-plan-fact-${index}`}>
                  <span className="text-xs font-semibold text-flare-ink">0{index + 1}</span>
                  <span className="font-medium">{fact.label}</span>
                  <span className="text-sm text-muted-foreground">{fact.value}</span>
                </div>
              ))}
            </div>
          </div>

          <HomeReadinessPassport compact />
          <TaxReturnInsightCard />
        </div>

        <div className="space-y-6">
          <Card data-testid="renter-human-checkin">
            <CardContent className="p-6">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Human check-in</p>
              <h2 className="font-display mt-2 text-2xl font-bold">Bring in your mortgage team.</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Ask Homi to organize the question, or message your team when personal review matters.</p>
              <div className="mt-4 grid gap-2">
                <Button asChild data-testid="button-renter-ask-homi"><Link href="/ai-coach" data-testid="link-renter-ask-homi">Ask Homi</Link></Button>
                <Button asChild variant="outline" data-testid="button-renter-message-team"><Link href="/messages" data-testid="link-renter-message-team">Message My Mortgage Team</Link></Button>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="renter-milestones">
            <CardContent className="p-6">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Milestones</p>
              {milestones.length > 0 ? (
                <div className="mt-3 divide-y divide-border border-y border-border">
                  {milestones.slice(-3).reverse().map((milestone) => (
                    <div key={milestone.id} className="py-3">
                      <p className="text-sm font-semibold">{milestone.title}</p>
                      {milestone.description && <p className="mt-1 text-xs text-muted-foreground">{milestone.description}</p>}
                    </div>
                  ))}
                </div>
              ) : <p className="mt-2 text-sm text-muted-foreground">Your first milestone appears after you save a homebuyer goal.</p>}
            </CardContent>
          </Card>

          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Planning tools</p>
            <div className="divide-y divide-border border-y border-border">
              {TOOLKIT.map((tool, index) => (
                <Link key={tool.href} href={tool.href} className="touch-target grid grid-cols-[2rem_1fr] gap-3 py-4 transition-colors hover:bg-muted" data-testid={tool.testId}>
                  <span className="text-xs font-semibold text-flare-ink">0{index + 1}</span>
                  <span>
                    <span className="block text-sm font-semibold">{tool.title}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{tool.description}</span>
                  </span>
                </Link>
              ))}
            </div>
          </div>

          <Card className="border-transparent bg-sidebar text-sidebar-foreground" data-testid="card-renter-cta">
            <CardContent className="p-6">
              <p className="font-display text-xl font-bold">Ready to begin a mortgage application?</p>
              <p className="mt-2 text-sm leading-relaxed text-sidebar-foreground/75">Your saved planning information can help you start with a clearer picture.</p>
              <Button asChild className="mt-4" data-testid="button-renter-preapproval"><Link href="/apply">Start My Application</Link></Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">Planning stages and estimates are educational. They are not a loan approval, offer, or commitment.</p>
    </PageShell>
  );
}
