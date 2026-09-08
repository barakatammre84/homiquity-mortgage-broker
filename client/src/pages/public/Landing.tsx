import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { EditorialNavigation } from "@/components/EditorialNavigation";
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
  { id: "buy", title: "Buy a home", href: "/apply" },
  { id: "refinance", title: "Refinance", href: "/apply?type=refinance" },
  { id: "equity", title: "Use my equity", href: "/apply?type=cashout" },
] as const;

const COMPLEX_INCOME = [
  { id: "work", number: "01", title: "Jobs and variable pay", description: "Keep salary, bonus, overtime, commission, and side work as separate sources." },
  { id: "business", number: "02", title: "Businesses and contract work", description: "Connect ownership, K-1s, business returns, bank statements, and profit-and-loss records." },
  { id: "rental", number: "03", title: "Rental property income", description: "Link Schedule E, leases, property income, and property obligations to the same rental." },
] as const;

const TRUST_POINTS = [
  { id: "connected", title: "One connected file", label: "From complex to clear" },
  { id: "income", title: "Built for salary + business + rental income", label: "More ways you earn. A brokerage that gets it." },
  { id: "guidance", title: "Human guidance when you need it", label: "Experts in complex. People at heart." },
] as const;

const PATHWAYS = [
  {
    id: "homi",
    label: "Homi Pathway",
    title: "Turn a complicated financial life into one clear mortgage story.",
    description: "Tell Homi how you earn. It organizes the income sources, documents, and questions that need a loan officer's review.",
    steps: ["Map every income source", "Build the right document plan", "Bring one connected file to your loan officer"],
    href: "/ai-coach",
    action: "Start with Homi",
  },
  {
    id: "renter",
    label: "Renter Pathway",
    title: "Build a practical path to homeownership before you apply.",
    description: "Choose your timing, income picture, and biggest unknown. Get a useful starting plan without creating an account.",
    steps: ["Choose a realistic buying horizon", "Set preparation milestones", "Carry your plan into Homi when you are ready"],
    href: "#homebuyer-plan",
    action: "Build my homebuyer path",
  },
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
      <EditorialNavigation />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        <section id="mortgage-pathways" className="scroll-mt-24 px-5 pb-10 pt-9 sm:px-8 sm:pb-14 sm:pt-12 lg:px-12 lg:pb-0 lg:pt-0 2xl:px-20" data-testid="section-hero">
          <div className="mx-auto grid max-w-screen-2xl items-stretch gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:gap-12">
            <div className="flex max-w-3xl flex-col justify-center py-2 lg:py-16 xl:py-20">
              <p className="text-xs font-semibold uppercase tracking-widest text-precision-500">Complex people. A clearer path.</p>
              <h1 className="mt-7 text-balance font-display text-5xl font-bold leading-none tracking-tighter text-foreground sm:text-6xl lg:text-7xl 2xl:text-8xl" data-testid="text-hero-title">
                Complex income.<br />A simpler mortgage.
              </h1>
              <p className="mt-7 max-w-2xl font-display text-lg leading-relaxed text-foreground/75 sm:text-xl lg:text-2xl" data-testid="text-hero-subtitle">
                We organize your salary, business income, and rental properties into one clear mortgage plan, so you can move forward with confidence.
              </p>

              <div className="mt-8 space-y-3" data-testid="hero-goal-picker">
                {GOALS.map((goal) => (
                  <Link key={goal.id} href={goal.href} className="touch-target flex min-h-16 items-center justify-between rounded-xl border border-precision-300 bg-card/40 px-5 font-display text-xl font-bold transition-colors hover:border-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid={`goal-${goal.id}`}>
                    <span>{goal.title}</span>
                    <span aria-hidden="true" className="font-sans text-3xl font-light">›</span>
                  </Link>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap gap-x-6 gap-y-1">
                <a href="#pathways" className="touch-target inline-flex items-center text-sm font-semibold underline decoration-flare-ink decoration-2 underline-offset-4" data-testid="goal-plan">See the Homi and renter pathways</a>
                <a href="#buying-power" className="touch-target inline-flex items-center text-sm font-medium text-foreground/65 underline underline-offset-4" data-testid="link-hero-afford">Check my buying power</a>
              </div>
              <p className="mt-7 text-xs font-semibold uppercase tracking-widest text-precision-500">More complex income. A more capable brokerage.</p>
            </div>

            <div className="-mx-5 flex items-center bg-precision-700 px-5 py-8 sm:-mx-8 sm:px-8 lg:mx-0 lg:rounded-3xl lg:px-8 lg:py-10 2xl:px-12">
              <HomiFinancialStory />
            </div>
          </div>
        </section>

        <section className="bg-precision-700 px-5 py-9 text-primary-foreground sm:px-8 lg:px-12 2xl:px-20" data-testid="section-trust">
          <ul className="mx-auto grid max-w-screen-2xl gap-7 md:grid-cols-3 md:gap-0">
            {TRUST_POINTS.map((point, index) => (
              <li key={point.id} className={`py-1 md:px-10 ${index > 0 ? "border-t border-primary-foreground/25 pt-7 md:border-l md:border-t-0 md:pt-1" : ""}`} data-testid={`item-trust-${point.id}`}>
                <p className="font-display text-xl font-bold leading-snug sm:text-2xl">{point.title}</p>
                <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-primary-foreground/65">{point.label}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="pathways" className="scroll-mt-24 bg-card px-5 py-16 sm:px-8 lg:px-12 lg:py-24 2xl:px-20" data-testid="section-entry-pathways">
          <div className="mx-auto max-w-screen-2xl">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-widest text-precision-500">Start where you are</p>
              <h2 className="mt-4 font-display text-4xl font-bold leading-tight tracking-tight sm:text-5xl">Choose the path that fits where you are.</h2>
              <p className="mt-5 text-lg leading-relaxed text-precision-500">Prepare for a mortgage now, or build toward one over time. Your work stays connected as your goals change.</p>
            </div>

            <div className="mt-10 grid border-y border-precision-100 lg:grid-cols-2">
              {PATHWAYS.map((pathway, pathwayIndex) => (
                <article key={pathway.id} className={`py-9 lg:p-10 xl:p-14 ${pathwayIndex > 0 ? "border-t border-precision-100 lg:border-l lg:border-t-0" : ""}`} data-testid={`pathway-${pathway.id}`}>
                  <p className="text-sm font-semibold text-flare-ink">{pathway.label}</p>
                  <h3 className="mt-4 max-w-xl font-display text-3xl font-bold leading-tight tracking-tight">{pathway.title}</h3>
                  <p className="mt-4 max-w-xl leading-relaxed text-precision-500">{pathway.description}</p>
                  <ol className="mt-7 space-y-3 border-t border-precision-100 pt-6">
                    {pathway.steps.map((step, index) => (
                      <li key={step} className="grid grid-cols-[2rem_1fr] gap-3 text-sm leading-relaxed">
                        <span className="font-semibold text-flare-ink">0{index + 1}</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                  <Link href={pathway.href} className="touch-target mt-8 inline-flex min-h-12 items-center justify-center rounded-full bg-precision-700 px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-precision-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" data-testid={`pathway-${pathway.id}-action`}>
                    {pathway.action}
                  </Link>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="homebuyer-plan" className="scroll-mt-24 bg-surface px-5 py-16 sm:px-8 lg:px-12 lg:py-24 2xl:px-20" data-testid="section-homebuyer-plan">
          <div className="mx-auto grid max-w-7xl items-start gap-10 lg:grid-cols-[0.76fr_1.24fr] lg:gap-20">
            <div className="lg:sticky lg:top-28">
              <p className="text-sm font-semibold text-flare-ink">Renter Pathway</p>
              <h2 className="mt-3 font-display text-4xl font-bold leading-tight tracking-tight sm:text-5xl">See your path before you apply.</h2>
              <p className="mt-5 text-lg leading-relaxed text-precision-500">Three choices give you a practical starting plan. No account, credit check, or contact details required.</p>
            </div>
            <HomebuyerPlanPreview />
          </div>
        </section>

        <section id="buying-power" className="scroll-mt-24 bg-background px-5 py-16 sm:px-8 lg:px-12 lg:py-24 2xl:px-20" data-testid="section-estimator">
          <div className="mx-auto grid max-w-7xl items-center gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
            <div>
              <p className="text-sm font-semibold text-flare-ink">Explore before you apply</p>
              <h2 className="mt-3 font-display text-4xl font-bold leading-tight tracking-tight">See what may fit your budget.</h2>
              <p className="mt-5 text-lg leading-relaxed text-precision-500">Pick a few ranges and get a planning estimate. No sign-up, no credit check, and nothing leaves your device until you decide to continue.</p>
            </div>
            <BuyingPowerEstimator />
          </div>
        </section>

        <section className="border-t border-precision-100 bg-card px-5 py-16 sm:px-8 lg:px-12 lg:py-24 2xl:px-20" data-testid="section-journeys">
          <div className="mx-auto max-w-7xl">
            <div className="grid gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:gap-20">
              <div>
                <p className="text-sm font-semibold text-flare-ink">The whole financial story</p>
                <h2 className="mt-3 font-display text-4xl font-bold leading-tight tracking-tight">Keep each income source clear.</h2>
                <p className="mt-5 text-lg leading-relaxed text-precision-500">Homiquity keeps each source and its evidence separate, then brings the picture together for review.</p>
                <Button asChild variant="outline" className="mt-7" data-testid="button-self-employed-learn"><Link href="/self-employed">See the self-employed process</Link></Button>
              </div>

              <ul className="divide-y divide-precision-100 border-y border-precision-100">
                {COMPLEX_INCOME.map((item) => (
                  <li key={item.id} className="grid grid-cols-[2.5rem_1fr] gap-3 py-5" data-testid={`income-path-${item.id}`}>
                    <span className="pt-1 text-xs font-semibold text-flare-ink">{item.number}</span>
                    <span><span className="block font-display text-lg font-bold">{item.title}</span><span className="mt-1 block leading-relaxed text-precision-500">{item.description}</span></span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="mt-12 text-center text-sm leading-relaxed text-precision-500" data-testid="text-footprint">
              We'll tell you up front if we can't arrange financing where you're buying.{" "}
              <Link href="/disclosures#licensing" className="touch-target inline-flex items-center font-medium text-foreground underline underline-offset-4 hover:no-underline" data-testid="link-trust-licensing">See the states we're licensed in</Link>
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
