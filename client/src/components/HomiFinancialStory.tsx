const INCOME_SOURCES = [
  { id: "employment", title: "W-2 employment", evidence: "Pay records and employment details", state: "Income mapped" },
  { id: "business", title: "Consulting business", evidence: "Returns and profit-and-loss records", state: "Evidence to gather" },
  { id: "rental", title: "Rental properties", evidence: "Schedule E, leases, and obligations", state: "Properties connected" },
] as const;

/** A product demonstration made from text and relationships, not decorative icons. */
export function HomiFinancialStory() {
  return (
    <div className="rounded-2xl bg-precision-950 p-3 text-primary-foreground shadow-card-lg sm:p-5" data-testid="homi-financial-story">
      <div className="rounded-xl border border-primary-foreground/15 bg-background p-4 text-foreground sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-4">
          <h2 className="font-display text-2xl font-bold tracking-tight">Homi Financial Story</h2>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Your information, organized</p>
        </div>
        <p className="my-4 rounded-lg bg-muted px-4 py-3 font-medium" data-testid="homi-story-prompt">
          “I have a salary, consulting income, and two rentals.”
        </p>
        <div className="grid gap-4 lg:grid-cols-[1fr_0.62fr]">
          <div className="space-y-2">
            {INCOME_SOURCES.map((source) => (
              <div key={source.id} className="grid gap-1 rounded-lg border border-border px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center" data-testid={`homi-story-${source.id}`}>
                <span>
                  <span className="block font-semibold">{source.title}</span>
                  <span className="block text-xs leading-relaxed text-muted-foreground">{source.evidence}</span>
                </span>
                <span className="text-xs font-semibold text-flare-ink">{source.state}</span>
              </div>
            ))}
          </div>
          <div className="flex items-center border-l-2 border-flare pl-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">One connected file</p>
              <p className="font-display mt-2 text-2xl font-bold leading-tight">A clearer story for lender review.</p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Every source keeps its facts, documents, and next action together.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
