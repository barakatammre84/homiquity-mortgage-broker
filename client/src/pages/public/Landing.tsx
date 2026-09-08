import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Navigation } from "@/components/Navigation";
import { SkipLink } from "@/components/SkipLink";
import { Footer } from "@/components/Footer";
import { SEOHead } from "@/components/SEOHead";
import { BuyingPowerEstimator } from "@/components/BuyingPowerEstimator";
import { HomiFinancialStory } from "@/components/HomiFinancialStory";
import { HomebuyerPlanPreview } from "@/components/HomebuyerPlanPreview";
import { lifestyleImages } from "@/lib/lifestyleImages";
import { usePageView } from "@/hooks/useActivityTracker";
import { lenderAdvocacyLine } from "@shared/lenderPanel";

const GOALS = [
  { id: "buy", number: "01", title: "Buy a home", description: "Build your buying picture and start an application.", href: "/apply" },
  { id: "refinance", number: "02", title: "Refinance my mortgage", description: "Review your current loan and what you want to change.", href: "/apply?type=refinance" },
  { id: "equity", number: "03", title: "Use my home equity", description: "Start a cash-out refinance review.", href: "/apply?type=cashout" },
] as const;

const COMPLEX_INCOME = [
  { id: "work", number: "01", title: "Jobs and variable pay", description: "Keep salary, bonus, overtime, commission, and side work as separate sources." },
  { id: "business", number: "02", title: "Businesses and contract work", description: "Connect ownership, K-1s, business returns, bank statements, and profit-and-loss records." },
  { id: "rental", number: "03", title: "Rental property income", description: "Link Schedule E, leases, property income, and property obligations to the same rental." },
] as const;

const TRUST_POINTS = [
  { id: "connected", title: "One connected file", label: "Keep every income source, document, and next step together." },
  { id: "income", title: "Built for the way you earn", label: "Salary, business, contract, rental income — or a mix of all four." },
  { id: "guidance", title: "Human guidance when you need it", label: "Work with a mortgage broker while Homi keeps the details organized." },
] as const;

export default function Landing() {
  usePageView("/");

  return (
    <div className="min-h-screen bg-background">
      <SEOHead
        title="Homiquity — a simpler mortgage process for complex income"
        description="Start a home purchase, refinance, or home-equity application with a mortgage process built for salary, business, contract, rental, and mixed income."
        ogType="website"
        ogImage={lifestyleImages.landingHero.src}
      />
      <SkipLink />
      <Navigation />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        <section className="px-4 py-10 sm:px-6 sm:py-14 lg:px-8 lg:py-20" data-testid="section-hero">
          <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:gap-14">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-widest text-flare-ink">Complex people. A clearer path.</p>
              <h1 className="font-display mt-4 text-balance text-5xl font-bold leading-none tracking-tight sm:text-6xl lg:text-7xl" data-testid="text-hero-title">
                Complex income. A simpler mortgage.
              </h1>
              <p className="mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground" data-testid="text-hero-subtitle">
                We organize salary, business income, contract work, and rental properties into one clear mortgage story, so you can move forward with confidence.
              </p>

              <div className="mt-8" data-testid="hero-goal-picker">
                <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted-foreground">Choose your goal</p>
                <div className="divide-y divide-border border-y border-border">
                  {GOALS.map((goal) => (
                    <Link
                      key={goal.id}
                      href={goal.href}
                      className="touch-target grid grid-cols-[2.25rem_1fr] gap-3 py-4 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-2"
                      data-testid={`goal-${goal.id}`}
                    >
                      <span className="pt-0.5 text-xs font-semibold text-muted-foreground">{goal.number}</span>
                      <span>
                        <span className="block font-semibold">{goal.title}</span>
                        <span className="mt-0.5 block text-sm leading-snug text-muted-foreground">{goal.description}</span>
                      </span>
                    </Link>
                  ))}
                </div>
                <a href="#homebuyer-plan" className="touch-target mt-3 inline-flex items-center font-semibold text-foreground underline decoration-flare decoration-2 underline-offset-4" data-testid="goal-plan">
                  Renting today? Build my path to homeownership
                </a>
                <a href="#buying-power" className="touch-target mt-1 flex w-fit items-center text-sm font-medium text-muted-foreground underline underline-offset-4" data-testid="link-hero-afford">
                  Or check my buying power
                </a>
              </div>
            </div>

            <HomiFinancialStory />
          </div>
        </section>

        <section className="bg-precision-950 px-4 py-8 text-primary-foreground sm:px-6 lg:px-8" data-testid="section-trust">
          <ul className="mx-auto grid max-w-7xl gap-6 sm:grid-cols-3">
            {TRUST_POINTS.map((point) => (
              <li key={point.id} className="border-l border-primary-foreground/25 pl-4" data-testid={`item-trust-${point.id}`}>
                <p className="font-display text-xl font-semibold">{point.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-primary-foreground/70">{point.label}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="homebuyer-plan" className="scroll-mt-20 bg-surface px-4 py-16 sm:px-6 lg:px-8 lg:py-20" data-testid="section-homebuyer-plan">
          <div className="mx-auto grid max-w-6xl items-start gap-10 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
            <div className="lg:sticky lg:top-24">
              <p className="text-xs font-semibold uppercase tracking-widest text-flare-ink">Renting today</p>
              <h2 className="font-display mt-3 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">See your path before you apply.</h2>
              <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
                Three choices give you a practical starting plan. No account, credit check, or contact details required.
              </p>
            </div>
            <HomebuyerPlanPreview />
          </div>
        </section>

        <section id="buying-power" className="scroll-mt-20 bg-background px-4 py-16 sm:px-6 lg:px-8 lg:py-20" data-testid="section-estimator">
          <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-flare-ink">Explore before you apply</p>
              <h2 className="font-display mt-3 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">See what may fit your budget.</h2>
              <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
                Pick a few ranges and get a planning estimate. No sign-up, no credit check, and nothing leaves your device until you decide to continue.
              </p>
            </div>
            <BuyingPowerEstimator />
          </div>
        </section>

        <section className="border-t border-border bg-background px-4 py-16 sm:px-6 lg:px-8 lg:py-20" data-testid="section-journeys">
          <div className="mx-auto max-w-6xl">
            <div className="grid gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:gap-16">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-flare-ink">The whole financial story</p>
                <h2 className="font-display mt-3 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">Keep each income source clear.</h2>
                <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
                  Homiquity keeps each source and its evidence separate, then brings the picture together for review.
                </p>
                <Button asChild variant="outline" className="mt-6" data-testid="button-self-employed-learn">
                  <Link href="/self-employed">See the self-employed process</Link>
                </Button>
              </div>

              <ul className="divide-y divide-border border-y border-border">
                {COMPLEX_INCOME.map((item) => (
                  <li key={item.id} className="grid grid-cols-[2.5rem_1fr] gap-3 py-5" data-testid={`income-path-${item.id}`}>
                    <span className="pt-1 text-xs font-semibold text-flare-ink">{item.number}</span>
                    <span>
                      <span className="block font-semibold">{item.title}</span>
                      <span className="mt-1 block leading-relaxed text-muted-foreground">{item.description}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="mt-10 text-center text-sm text-muted-foreground" data-testid="text-footprint">
              We'll tell you up front if we can't arrange financing where you're buying.{" "}
              <Link href="/disclosures#licensing" className="touch-target inline-flex items-center font-medium text-foreground underline underline-offset-4 hover:no-underline" data-testid="link-trust-licensing">
                See the states we're licensed in
              </Link>
              . We explain and prepare; lenders make the credit decision. {lenderAdvocacyLine()}
            </p>
            <Link href="/disclosures#licensing" className="sr-only" data-testid="link-footprint-licensing">Licensing details</Link>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
