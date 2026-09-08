import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Navigation } from "@/components/Navigation";
import { SkipLink } from "@/components/SkipLink";
import { Footer } from "@/components/Footer";
import { SEOHead } from "@/components/SEOHead";
import { CoachPromptBar } from "@/components/CoachPromptBar";
import { Reveal, Stagger, StaggerItem, ScenePauseButton } from "@/components/motion";
import { Scene } from "@/components/motion/Scene";
import { getScene, sceneAssets, type SceneId } from "@/lib/sceneAssets";
import { BuyingPowerEstimator } from "@/components/BuyingPowerEstimator";
import { lifestyleImages } from "@/lib/lifestyleImages";
import { usePageView } from "@/hooks/useActivityTracker";
import { Icons, iconSize } from "@/lib/icons";
import { SpotArt } from "@/components/SpotArt";
import { GuidanceMark, IncomeMark, AdvocacyMark, LicensingMark } from "@/components/illustrations/trustMarks";
import { lenderAdvocacyClause, lenderAdvocacyLine } from "@shared/lenderPanel";

/**
 * The public home page.
 *
 * WHO THIS PAGE IS ABOUT. The previous version talked about Homiquity: the hero
 * eyebrow was the founder's CV and all four trust points were about us — years in
 * banking, our architecture ("rules-based decisions, not a black box"), our
 * compliance, our encryption. It promised a MECHANISM ("ask anything") rather than
 * an outcome, and never named a customer problem. Every line here is now about
 * what the visitor can do.
 *
 * THE PROMISE: "see what you have the power to do". Deliberately audience-agnostic
 * — the same sentence works for a renter who does not know if they can start, a
 * business owner whose returns understate them, an owner weighing a refinance, and
 * a move-up buyer carrying equity and a jumbo balance. One promise, four doors.
 * That is what keeps this from collapsing back into the six-persona sitemap the
 * old page was.
 *
 * 🚨 WE ARE A BROKER, AND THE COPY MUST SAY SO. Homiquity arranges financing with
 * third-party wholesale lenders; it does not make credit decisions or fund loans
 * (the standing disclosure in Footer.tsx). Marketing that implies we approve,
 * decide, or lend contradicts our own footer and is the Reg N / UDAAP exposure.
 * Being a broker is not fine print — it is the reason we can act for the customer
 * instead of selling them a house product. The advocacy line comes from
 * `shared/lenderPanel.ts` so its tense tracks whether a counterparty is actually
 * signed.
 *
 * Accessibility: the journey CTAs are default-size <Button> (h-11 = 44px). The
 * three inline links carry `.touch-target` — a phone-only floor from index.css —
 * because PR #602 raised this page from 26 sub-44px targets to 2, and a rewrite
 * that silently dropped that would undo an accessibility fix rather than a style.
 *
 * Advertising rails: no rate, APR, payment or term figure in this page's own copy
 * (Reg Z §1026.24 — rates live at /rates with their disclosures); nothing framed
 * as an approval, offer, or commitment (Reg N); no wholesale-lender names or count
 * (borrower-transparency doctrine); no asset-depletion claim until that path
 * module ships. All pinned by Landing.test.tsx.
 */

/**
 * Four doors on one promise. Each is a SITUATION, not a product name, so nobody
 * has to know mortgage vocabulary to pick one. 2×2 on desktop, stacked on mobile.
 */
const JOURNEYS = [
  {
    id: "renting",
    icon: Icons.home,
    title: "You're renting now",
    // 🚨 This said "…and what your rent already proves about you", which reads as
    // "your rent is building your credit file". Nothing downstream furnishes rent:
    // /first-time-buyer never mentions a bureau, and MyLease.tsx:160 states flatly
    // that "Saving a lease does not report anything to the credit bureaus." A promise
    // the product disclaims one surface away is a Reg N / MAP Rule §1014.3
    // misrepresentation, not a copy nit. What the destination DOES deliver is a
    // rent-to-price calculator, so that is what this now promises.
    description:
      "See what you'd need to buy — and what the rent you already pay could buy instead.",
    cta: "See where you stand",
    href: "/first-time-buyer",
  },
  {
    id: "self-employed",
    icon: Icons.person,
    title: "Your income is your own",
    // 🚨 This said "1099s, K-1s, write-offs, rentals. We work out every way your
    // income can count." A journey walk proved every part of that false in the
    // running product: adding Rental Income dead-ends the funnel (the address
    // never commits, so Continue silently refuses), the funnel's self-employment
    // entry is never read by the income orchestrator — which books the whole
    // amount as AGENCY WAGE and reports "Employment income" as the only source —
    // and a second business entity cannot be entered at all. What IS built and
    // verified: the dedicated self-employed funnel branch, the URLA K-1 worksheet
    // (payload round-trips), and the self-employed document set. Promise those.
    description:
      "1099s, K-1s, business returns. Your application is built for how you actually get paid.",
    cta: "See how it works",
    href: "/self-employed",
  },
  {
    id: "owner",
    icon: Icons.trend,
    title: "You already own",
    description:
      "Worth refinancing? Worth tapping your equity? Get a straight answer before you commit.",
    cta: "Weigh your options",
    href: "/refinance",
  },
  {
    id: "moving-up",
    // Jumbo is a real, supported product (shared/loanProducts.ts, lendingLimits.ts),
    // so naming it is substantiated. Qualifying on ASSETS is not — that path module
    // is unbuilt, so this card must never imply asset depletion.
    icon: Icons.lender,
    title: "You're moving up",
    description:
      "A bigger home, a bigger balance, more moving parts — jumbo included. We'll map the whole picture.",
    cta: "Start your file",
    href: "/apply",
  },
] as const;

/**
 * Trust, stated as what the customer gets — not as our credentials. The old row
 * was four facts about Homiquity; a visitor cannot use any of those.
 */
const TRUST_POINTS = [
  {
    id: "guidance",
    icon: Icons.coach,
    /** SpotArt keys uploaded art off this concept; the mark is the interim. */
    spot: "coach" as const,
    mark: <GuidanceMark />,
    label: "Homi answers your questions any hour, in plain English",
  },
  {
    id: "income",
    icon: Icons.done,
    /** SpotArt keys uploaded art off this concept; the mark is the interim. */
    spot: "done" as const,
    mark: <IncomeMark />,
    // Was "We work out every way your income can count — not just the obvious
    // one". The multi-path engine exists (shared/incomePaths.ts) but the funnel
    // does not feed self-employment into it, so the claim is false at the only
    // place a borrower would test it. This states the part that is delivered.
    label: "Business returns and K-1s get their own worksheet, not a wage box",
  },
  {
    id: "advocacy",
    icon: Icons.people,
    /** SpotArt keys uploaded art off this concept; the mark is the interim. */
    spot: "people" as const,
    mark: <AdvocacyMark />,
    label: `We work for you. ${lenderAdvocacyLine()}`,
  },
  {
    id: "licensing",
    icon: Icons.security,
    /** SpotArt keys uploaded art off this concept; the mark is the interim. */
    spot: "security" as const,
    mark: <LicensingMark />,
    label: "Licensed, regulated, and straight with you",
    href: "/disclosures#licensing",
    linkLabel: "See where we're licensed",
  },
] as const;

export default function Landing() {
  usePageView("/");

  // WCAG 2.2.2: any page whose motion starts on its own and runs past five
  // seconds owes the visitor a way to stop it, and a loop never ends. One control
  // governs every scene; it only exists once artwork does.
  const [scenesPaused, setScenesPaused] = useState(false);
  const hasScenes = Object.keys(sceneAssets).length > 0;

  return (
    <div className="min-h-screen bg-background">
      <SEOHead
        title="Homiquity — a mortgage broker that works for you"
        description="See what you have the power to do. Homi, our AI assistant, walks you through buying, refinancing, or using your equity — and we take your file to our lending partners. Guidance and estimates, not a loan approval."
        ogType="website"
        ogImage={lifestyleImages.landingHero.src}
      />
      <SkipLink />
      <Navigation />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* Hero — the whole page's centre of gravity. */}
        <section
          className="bg-muted px-4 py-20 sm:px-6 lg:px-8 lg:py-28"
          data-testid="section-hero"
        >
          <div className="mx-auto max-w-4xl text-center">
            <p
              className="text-sm font-semibold uppercase tracking-widest text-flare-ink"
              data-testid="text-hero-eyebrow"
            >
              Renting, self-employed, refinancing, or moving up — start anywhere
            </p>

            <h1
              className="font-display mt-5 text-balance text-4xl font-extrabold leading-none tracking-tight text-foreground sm:text-5xl lg:text-6xl"
              data-testid="text-hero-title"
            >
              See what you have the power to do.
            </h1>

            <p
              className="mx-auto mt-6 max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground"
              data-testid="text-hero-subtitle"
            >
              Buying a home is stressful because nobody tells you where you stand until
              it's too late. Homi walks you through it, connects what you tell us with
              what we verify, and shows you what's actually within reach —{" "}
              {lenderAdvocacyClause()}.
            </p>

            <Button asChild size="lg" className="mt-8" data-testid="button-hero-apply">
              <Link href="/apply">Start your mortgage application</Link>
            </Button>

            <div className="mx-auto mt-10 max-w-3xl text-left">
              {/* A personality line for the mechanism directly below it, not a
                  second headline. The H1 above stays outcome-first ("see what
                  you have the power to do") per Landing.test.tsx and the note
                  at the top of this file — a mechanism-first hero ("ask Homi
                  anything…") was tried before and deliberately reverted. This
                  caption sits where the mechanism itself already lives
                  (CoachPromptBar's own placeholder is "Ask Homi anything…"),
                  so it reinforces rather than duplicates the H1's promise. Kept
                  to soft, unquantified puffery — no scope claim beyond what
                  Homi's system prompt (server/services/coachingPrompt.ts)
                  actually covers: intake, documents, and next steps, not
                  property search or closing execution. */}
              <p
                className="mb-3 text-sm font-semibold text-foreground"
                data-testid="text-hero-coach-intro"
              >
                Have a question first? Buying a home is simpler with a Homi in your corner.
              </p>
              <CoachPromptBar />
            </div>

            {/* The escape hatch for visitors who will not hand over an email yet.
                It points at the band below rather than off to /afford — the
                no-signup answer is on this page, so sending them to another
                route to find it was a needless step. */}
            <p className="mt-8 text-sm text-muted-foreground">
              Rather not sign up yet?{" "}
              <a
                href="#buying-power"
                className="touch-target inline-flex items-center font-semibold text-foreground underline underline-offset-4 hover:no-underline"
                data-testid="link-hero-afford"
              >
                See your buying power
              </a>{" "}
              — no account, no credit check.
            </p>
          </div>
        </section>

        {/* Buying power — the one thing on this page that answers a visitor
            without an account. Its own band directly under the hero, because it
            is the alternative to Homi, not a footnote to it. */}
        <section
          id="buying-power"
          className="scroll-mt-20 bg-background px-4 py-20 sm:px-6 lg:px-8"
          data-testid="section-estimator"
        >
          <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wide text-primary">
                No account needed
              </p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
                Find out what you could afford — in about a minute
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
                Pick a few ranges and get a realistic estimate. No sign-up, no credit
                check, and nothing leaves your device until you decide to continue.
              </p>
            </div>
            <BuyingPowerEstimator />
          </div>
        </section>

        {/* Four doors. */}
        <section className="bg-muted px-4 py-20 sm:px-6 lg:px-8" data-testid="section-journeys">
          <div className="mx-auto max-w-6xl">
            <Reveal>
              <h2 className="text-center text-3xl font-extrabold tracking-tight sm:text-4xl">
                Wherever you're starting from
              </h2>
            </Reveal>
            {hasScenes ? (
              <div className="mt-6 flex justify-center">
                <ScenePauseButton
                  paused={scenesPaused}
                  onToggle={() => setScenesPaused((p) => !p)}
                />
              </div>
            ) : null}

            <Stagger className="mt-12 grid gap-6 sm:grid-cols-2">
              {JOURNEYS.map((journey) => {
                const Icon = journey.icon;
                return (
                  <StaggerItem key={journey.id}>
                  <Card
                    className="h-full rounded-3xl border-0 bg-card hover-elevate"
                    data-testid={`card-journey-${journey.id}`}
                  >
                    <CardContent className="p-6">
                      {(() => {
                        // Auto-discovered from attached_assets/scenes/. Absent
                        // until the illustrator delivers, so the icon tile is the
                        // real state today rather than a placeholder box.
                        const scene = getScene(journey.id as SceneId);
                        return scene ? (
                          <Scene
                            poster={scene.poster}
                            video={scene.video}
                            alt={scene.alt}
                            paused={scenesPaused}
                            className="mb-5 w-full"
                          />
                        ) : (
                          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <Icon className={iconSize.feature} aria-hidden="true" />
                          </div>
                        );
                      })()}
                      <h3
                        className="mt-5 text-xl font-semibold"
                        data-testid={`text-journey-title-${journey.id}`}
                      >
                        {journey.title}
                      </h3>
                      <p className="mt-2 leading-relaxed text-muted-foreground">
                        {journey.description}
                      </p>
                      <Button
                        asChild
                        variant="ghost"
                        className="-ml-2 mt-4 gap-1.5"
                        data-testid={`button-journey-${journey.id}`}
                      >
                        <Link href={journey.href}>
                          {journey.cta}
                          <Icons.next className={iconSize.dense} aria-hidden="true" />
                        </Link>
                      </Button>
                    </CardContent>
                  </Card>
                  </StaggerItem>
                );
              })}
            </Stagger>
          </div>
        </section>

        {/* One trust row — what the customer gets, not who we are. */}
        <section
          className="bg-background px-4 py-14 sm:px-6 lg:px-8"
          data-testid="section-trust"
        >
          <div className="mx-auto max-w-6xl">
            <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {TRUST_POINTS.map((point) => {
                return (
                  <li
                    key={point.id}
                    className="flex items-start gap-3"
                    data-testid={`item-trust-${point.id}`}
                  >
                    {/* `empty` is 40px — inside the 36-48px band the brief
                        specifies for a spot mark. At the 24px this started on, a
                        bespoke drawing is indistinguishable from the Lucide glyph
                        it replaced, so the work bought nothing. */}
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
                          {" — "}
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
                );
              })}
            </ul>

            {/* Audience-led means national traffic. An out-of-state visitor used
                to discover the footprint only at StateStep, deep in the funnel —
                after signing up. Say it here instead, and link to the live list
                rather than naming states in copy that would go stale. */}
            <p
              className="mt-10 border-t pt-8 text-center text-sm text-muted-foreground"
              data-testid="text-footprint"
            >
              We'll tell you up front if we can't arrange financing where you're buying.{" "}
              <Link
                href="/disclosures#licensing"
                className="touch-target inline-flex items-center font-medium text-foreground underline underline-offset-4 hover:no-underline"
                data-testid="link-footprint-licensing"
              >
                See the states we're licensed in
              </Link>
              .
            </p>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
