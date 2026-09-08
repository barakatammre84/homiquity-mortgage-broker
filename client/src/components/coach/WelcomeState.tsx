import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/Logo";
import type { CoachInsight } from "./types";

export function InsightsBanner({
  insights,
  onAction,
}: {
  insights: CoachInsight[];
  onAction: (msg: string) => void;
}) {
  if (insights.length === 0) return null;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pt-4" data-testid="insights-banner">
      {insights.slice(0, 2).map((insight) => (
        <div key={insight.type} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-card p-3" data-testid={`insight-${insight.type}`}>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{insight.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{insight.description}</p>
          </div>
          {insight.action && (
            <Button variant="outline" className="touch-target shrink-0" onClick={() => onAction(insight.action!)} data-testid={`button-insight-action-${insight.type}`}>
              Ask Homi
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

const CAPABILITIES = [
  { id: "income", title: "Income map", detail: "Separate salary, business, contract, and rental income while keeping the evidence connected." },
  { id: "documents", title: "Document plan", detail: "See what has been received, what is being reviewed, and what still needs attention." },
  { id: "next", title: "One next action", detail: "Move forward with a clear step and bring in your loan officer when human review matters." },
] as const;

const STARTERS = [
  { id: "map-income", label: "Map my income", prompt: "Help me map my salary, business, and rental income into one clear financial story." },
  { id: "document-plan", label: "Build my document plan", prompt: "Show me the documents connected to my file and what I should gather next." },
  { id: "file-status", label: "Explain where my file stands", prompt: "Explain where my mortgage file stands and give me one next action." },
  { id: "homebuyer-plan", label: "Plan from renting to buying", prompt: "I am renting now. Help me build a practical path to buying a home." },
] as const;

export function WelcomeState({ onStart, insights }: { onStart: (msg: string) => void; insights: CoachInsight[] }) {
  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-3xl py-4 sm:py-8">
        <div className="grid gap-8 lg:grid-cols-[0.82fr_1.18fr]">
          <div>
            <Logo variant="mark" tone="mono" size="lg" mark="primary" data-testid="logo-homi-welcome" />
            <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-flare-ink">Homi, your mortgage guide</p>
            <h2 className="font-display mt-3 text-4xl font-bold leading-tight text-foreground sm:text-5xl" data-testid="text-coach-welcome">
              Bring me the messy version.
            </h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Tell Homi how you earn, what you own, and what feels unclear. Homi will organize the story, connect it to your file, and show one next action.
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-5 shadow-card sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">What Homi can organize</p>
            <div className="mt-4 divide-y divide-border border-y border-border">
              {CAPABILITIES.map((capability, index) => (
                <div key={capability.id} className="grid grid-cols-[2rem_1fr] gap-3 py-4" data-testid={`homi-capability-${capability.id}`}>
                  <span className="text-xs font-semibold text-flare-ink">0{index + 1}</span>
                  <span>
                    <span className="block font-semibold text-foreground">{capability.title}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{capability.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {insights.length > 0 && (
          <div className="mt-8 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Based on your connected file</p>
            {insights.slice(0, 2).map((insight) => (
              <button key={insight.type} type="button" onClick={() => insight.action && onStart(insight.action)} disabled={!insight.action} className="touch-target w-full rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted disabled:cursor-default" data-testid={`welcome-insight-${insight.type}`}>
                <span className="block text-sm font-semibold">{insight.title}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{insight.description}</span>
              </button>
            ))}
          </div>
        )}

        <div className="mt-8">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Start with a useful result</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {STARTERS.map((starter, index) => (
              <Button key={starter.id} variant="outline" className="touch-target h-auto justify-start px-4 py-3 text-left" onClick={() => onStart(starter.prompt)} data-testid={`button-starter-${starter.id}`}>
                <span className="mr-3 text-xs font-semibold text-flare-ink">0{index + 1}</span>
                <span>{starter.label}</span>
              </Button>
            ))}
          </div>
        </div>

        <p className="mt-6 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
          Homi provides educational guidance and helps prepare information. It does not approve loans or replace your loan officer.
        </p>
      </div>
    </div>
  );
}
