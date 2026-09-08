import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Navigation } from "@/components/Navigation";
import { SkipLink } from "@/components/SkipLink";
import { Footer } from "@/components/Footer";
import { SEOHead } from "@/components/SEOHead";
import { CoachPromptBar } from "@/components/CoachPromptBar";
import { BuyingPowerEstimator } from "@/components/BuyingPowerEstimator";
import { lifestyleImages } from "@/lib/lifestyleImages";
import { usePageView } from "@/hooks/useActivityTracker";
import { Icons, iconSize } from "@/lib/icons";
import { SpotArt } from "@/components/SpotArt";
import { GuidanceMark, IncomeMark, AdvocacyMark, LicensingMark } from "@/components/illustrations/trustMarks";
import { lenderAdvocacyLine } from "@shared/lenderPanel";

/**
 * Better's strongest public-entry pattern is an immediate choice between the
 * visitor's three goals. Homiquity keeps that low-friction shape, then earns its
 * own identity by explaining what happens to mixed income after the click.
 *
 * Advertising rails:
 * - Homiquity is a broker, so this page never claims to lend, approve, decide,
 *   fund, or shop a live panel that does not yet exist.
 * - Rate/payment/term figures stay on disclosed rate and calculator surfaces.
 * - The application paths below map to entry types the funnel actually reads.
 */
const GOALS = [
  {
    id: "buy",
    icon: Icons.home,
    title: "Buy a home",
    description: "Build your buying picture and start an application.",
    href: "/apply",
  },
  {
    id: "refinance",
    icon: Icons.rerun,
    title: "Refinance my mortgage",
    description: "Review your current loan and what you want to change.",
    href: "/apply?type=refinance",
  },
  {
    id: "equity",
    icon: Icons.assets,
    title: "Get cash from my home",
    description: "Start a cash-out refinance review.",
    href: "/apply?type=cashout",
  },
] as const;

const COMPLEX_INCOME = [
  {
    id: "work",
    icon: Icons.person,
    title: "Jobs and variable pay",
    description: "Keep salary, bonus, overtime, commission, and side work as separate sources.",
  },
  {
    id: "business",
    icon: Icons.lender,
    title: "Businesses and contract work",
    description: "Connect ownership, K-1s, business returns, bank statements, and profit-and-loss records.",
  },
  {
    id: "rental",
    icon: Icons.home,
    title: "Rental property income",
    description: "Link Schedule E, leases, property income, and property obligations to the same rental.",
  },
] as const;

const TRUST_POINTS = [
  {
    id: "guidance",
    spot: "coach" as const,
    mark: <GuidanceMark />,
    label: "Get plain-English guidance at every step",
  },
  {
    id: "income",
    spot: "done" as const,
    mark: <IncomeMark />,
    label: "Enter each income source once and keep its evidence connected",
  },
  {
    id: "advocacy",
    spot: "people" as const,
    mark: <AdvocacyMark />,
    label: `Work with a mortgage broker on your side. ${lenderAdvocacyLine()}`,
  },
  {
    id: "licensing",
    spot: "security" as const,
    mark: <LicensingMark />,
    label: "Licensed, regulated, and clear about what happens next",
    href: "/disclosures#licensing",
    linkLabel: "See where we're licensed",
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
      <Navigation />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        <section
          className="bg-precision-950 px-4 py-10 text-primary-foreground sm:px-6 sm:py-14 lg:px-8 lg:py-20"
          data-testid="section-hero"
        >
          <div className="mx-auto grid max-w-7xl items-center gap-7 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold text-flare">
                Mortgage guidance built for your whole financial picture
              </p>
              <h1
                className="font-display mt-4 text-balance text-4xl font-extrabold leading-none tracking-tight sm:text-5xl lg:text-6xl"
                data-testid="text-hero-title"
              >
                Complex income. A simpler mortgage.
              </h1>
              <p
                className="mt-5 max-w-2xl text-pretty text-lg leading-relaxed text-primary-foreground/75"
                data-testid="text-hero-subtitle"
              >
                Salary, a side business, contract work, rental property — or all of it.
                Enter each detail once and keep the same file connected through lender submission.
              </p>
            </div>

            <div
              className="overflow-hidden rounded-3xl bg-background text-foreground shadow-card-lg"
              data-testid="hero-goal-picker"
            >
              <div className="px-5 pb-3 pt-5 sm:px-6 sm:pt-6">
                <h2 className="text-xl font-bold">What do you want to do?</h2>
                <p className="mt-1 text-sm text-muted-foreground">Choose one to start in the right place.</p>
              </div>
              <div className="divide-y divide-border border-y border-border">
                {GOALS.map((goal) => {
                  const Icon = goal.icon;
                  return (
                    <Link
                      key={goal.id}
                      href={goal.href}
                      className="group flex min-h-16 items-center gap-4 px-5 py-3 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-20 sm:px-6"
                      data-testid={`goal-${goal.id}`}
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Icon className={iconSize.emphasis} aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">{goal.title}</span>
                        <span className="mt-0.5 hidden text-sm leading-snug text-muted-foreground sm:block">
                          {goal.description}
                        </span>
                      </span>
                      <Icons.navNext className="h-5 w-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
                    </Link>
                  );
                })}
              </div>
              <div className="px-5 py-3 sm:px-6">
                <a
                  href="#buying-power"
                  className="touch-target inline-flex items-center font-semibold text-primary underline underline-offset-4 hover:no-underline"
                  data-testid="link-hero-afford"
                >
                  Not ready to apply? Check your buying power
                </a>
              </div>
            </div>
          </div>
        </section>

        <section
          className="border-b border-border bg-background px-4 py-8 sm:px-6 lg:px-8"
          data-testid="section-trust"
        >
          <div className="mx-auto max-w-7xl">
            <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {TRUST_POINTS.map((point) => (
                <li key={point.id} className="flex items-start gap-3" data-testid={`item-trust-${point.id}`}>
                  <SpotArt
                    name={point.spot}
                    size="empty"
                    fallback={point.mark}
                    className="shrink-0 text-primary"
                  />
                  <span className="text-sm leading-relaxed text-muted-foreground">
                    {point.label}
                    {"href" in point && point.href ? (
                      <>
                        {" "}
                        <Link
                          href={point.href}
                          className="touch-target inline-flex items-center font-medium text-foreground underline underline-offset-4 hover:no-underline"
                          data-testid="link-trust-licensing"
                        >
                          {point.linkLabel}
                        </Link>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section
          id="buying-power"
          className="scroll-mt-20 bg-muted px-4 py-16 sm:px-6 lg:px-8 lg:py-20"
          data-testid="section-estimator"
        >
          <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <div>
              <p className="text-sm font-semibold text-primary">Explore before you apply</p>
              <h2 className="font-display mt-3 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
                See what may fit your budget.
              </h2>
              <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
                Pick a few ranges and get a planning estimate. No sign-up, no credit
                check, and nothing leaves your device until you decide to continue.
              </p>
            </div>
            <BuyingPowerEstimator />
          </div>
        </section>

        <section
          className="bg-background px-4 py-16 sm:px-6 lg:px-8 lg:py-20"
          data-testid="section-journeys"
        >
          <div className="mx-auto max-w-6xl">
            <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
              <div>
                <p className="text-sm font-semibold text-primary">Complex income belongs in the main flow</p>
                <h2 className="font-display mt-3 text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
                  Show the full story behind your income.
                </h2>
                <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
                  Most mortgage applications force every borrower through the same wage-income box.
                  Homiquity keeps each source and its evidence separate, then brings the picture together for review.
                </p>
                <Button asChild variant="outline" className="mt-6" data-testid="button-self-employed-learn">
                  <Link href="/self-employed">See the self-employed process</Link>
                </Button>
              </div>

              <ul className="divide-y divide-border border-y border-border">
                {COMPLEX_INCOME.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.id} className="flex gap-4 py-5" data-testid={`income-path-${item.id}`}>
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary">
                        <Icon className={iconSize.emphasis} aria-hidden="true" />
                      </span>
                      <span>
                        <span className="block font-semibold">{item.title}</span>
                        <span className="mt-1 block leading-relaxed text-muted-foreground">{item.description}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="mt-14 border-t border-border pt-10">
              <div className="mx-auto max-w-3xl text-center">
                <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                  Have a question before you start?
                </h2>
                <p className="mt-2 text-muted-foreground">
                  Ask Homi about the application, documents, or what happens next.
                </p>
              </div>
              <div className="mx-auto mt-6 max-w-3xl">
                <CoachPromptBar />
              </div>
            </div>

            <p className="mt-10 text-center text-sm text-muted-foreground" data-testid="text-footprint">
              We'll tell you up front if we can't arrange financing where you're buying.{" "}
              <Link
                href="/disclosures#licensing"
                className="touch-target inline-flex items-center font-medium text-foreground underline underline-offset-4 hover:no-underline"
                data-testid="link-footprint-licensing"
              >
                See the states we're licensed in
              </Link>
              . We explain and prepare; lenders make the credit decision. {lenderAdvocacyLine()}
            </p>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
