import { Link } from "wouter";

const INCOME_SOURCES = [
  { id: "employment", title: "W-2 employment", evidence: "Pay stubs, W-2s, employment letter", state: "Income confirmed", stateClass: "text-success-subtle-foreground" },
  { id: "business", title: "Consulting business", evidence: "Business returns, 1099s, bank statements", state: "Returns needed", stateClass: "text-flare-ink" },
  { id: "rental", title: "Rental properties", evidence: "Schedule E, leases, property details", state: "Schedule E linked", stateClass: "text-success-subtle-foreground" },
] as const;

/** A product demonstration made from text and relationships, not decorative icons. */
export function HomiFinancialStory() {
  return (
    <div className="rounded-3xl bg-precision-700 p-3 text-primary-foreground shadow-card-lg sm:p-5 lg:p-8" data-testid="homi-financial-story">
      <div className="rounded-2xl border border-primary-foreground/15 bg-background p-4 text-foreground sm:p-6 lg:p-8">
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-precision-100 pb-5">
          <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Homi Financial Story</h2>
          <p className="text-xs font-semibold uppercase tracking-widest text-precision-500">Your information. One clear story.</p>
        </div>
        <div className="my-5 grid grid-cols-[1fr_auto] items-center gap-4 rounded-xl border border-precision-100 bg-muted px-4 py-4 sm:px-5" data-testid="homi-story-prompt">
          <p className="font-display text-lg leading-snug sm:text-xl">I have a salary, consulting income, and two rentals.</p>
          <span className="text-xs font-semibold uppercase tracking-widest text-precision-500">You</span>
        </div>
        <div className="relative grid gap-5 lg:grid-cols-[1.35fr_0.82fr] lg:gap-16">
          <div className="space-y-3">
            {INCOME_SOURCES.map((source) => (
              <div key={source.id} className="grid gap-2 rounded-xl border border-precision-100 bg-card px-4 py-3.5 sm:grid-cols-[1fr_auto] sm:items-center" data-testid={`homi-story-${source.id}`}>
                <span>
                  <span className="block font-display text-base font-bold leading-tight sm:text-lg">{source.title}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-precision-500">{source.evidence}</span>
                </span>
                <span className={`text-xs font-semibold ${source.stateClass}`}>{source.state}</span>
              </div>
            ))}
          </div>

          <svg aria-hidden="true" className="pointer-events-none absolute left-1/2 top-0 hidden h-full w-1/4 -translate-x-1/2 text-flare lg:block" viewBox="0 0 120 180" preserveAspectRatio="none">
            <path d="M0 28 H44 C66 28 62 90 92 90 H120" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M0 90 H120" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M0 152 H44 C66 152 62 90 92 90 H120" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>

          <div className="flex items-center rounded-2xl border border-precision-100 bg-precision-50 p-5 text-center lg:p-6">
            <div className="w-full">
              <p className="text-xs font-semibold uppercase tracking-widest text-precision-500">Connected file</p>
              <p className="mt-3 font-display text-2xl font-bold leading-tight tracking-tight">One connected mortgage file</p>
              <p className="mt-3 text-sm leading-relaxed text-precision-500">Your income. Your properties. One complete story.</p>
              <Link href="/ai-coach" className="touch-target mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-full bg-flare-ink px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-flare-ink/90" data-testid="homi-story-continue">
                Continue my plan
              </Link>
            </div>
          </div>
        </div>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-precision-100 pt-4 text-xs font-semibold uppercase tracking-widest text-precision-500">
          <span>Real income. Real people. Real possibilities.</span>
          <span>Homiquity</span>
        </div>
      </div>
    </div>
  );
}
