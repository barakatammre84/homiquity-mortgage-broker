import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { SkipLink } from "@/components/SkipLink";
import { Footer } from "@/components/Footer";
import { OffsetBlock } from "@/components/layout/OffsetBlock";
import { RelatedGuides } from "@/components/RelatedGuides";
import { SEOHead } from "@/components/SEOHead";
import { FramedPhoto } from "@/components/FramedPhoto";
import { ImageTextSection } from "@/components/ImageTextSection";
import { lifestyleImages } from "@/lib/lifestyleImages";
import { AdvocacyArt } from "@/components/illustrations/AdvocacyArt";
import { SelfEmployedDeskArt } from "@/components/illustrations/SelfEmployedDeskArt";
import { usePageView } from "@/hooks/useActivityTracker";
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  FileText,
  HelpCircle,
  Layers,
  ShieldCheck,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import { Logo } from "@/components/brand/Logo";

/**
 * Income-shape pre-screen: self-employed shapes route to the funnel with
 * employment type prefilled (?type=self-employed — PreApproval seeds
 * employmentType, which also routes in the income-sources step); W-2-primary
 * shapes go to the standard funnel so nobody is mislabeled.
 */
const INCOME_OPTIONS = [
  { id: "business-owner", label: "I own a business", icon: Building2, href: "/apply?type=self-employed" },
  { id: "contractor", label: "1099 contractor or freelancer", icon: Users, href: "/apply?type=self-employed" },
  { id: "w2-plus", label: "W-2 plus rental, investment, or side income", icon: Layers, href: "/apply" },
  { id: "other", label: "Something else entirely", icon: HelpCircle, href: "/apply" },
] as const;

const ALGORITHM_PAINS = [
  {
    id: "write-offs",
    title: "Your write-offs get used against you",
    body: "You run your business tax-smart, so your taxable income looks small. Automated systems read that bottom line and stop — they never see the cash flow behind it.",
  },
  {
    id: "w2-pipeline",
    title: "The pipeline is shaped like a W-2",
    body: "Upload pay stub, match employer, verify salary. Hand the same system a K-1, a Schedule C, and three income streams, and it doesn't slow down — it errors out.",
  },
  {
    id: "no-appeal",
    title: "The denial comes with nobody to talk to",
    body: "When an algorithm says no, there's no one to explain the depreciation add-back or the one-time expense to. The file closes and you start over somewhere else.",
  },
];

const OUR_APPROACH = [
  {
    id: "built-for-it",
    icon: Layers,
    title: "An application built for complex income",
    body: "Our application doesn't flinch at multiple income streams — it itemizes them. Self-employment and 1099 income, rental properties, investments, retirement income: each one is captured properly from the start, not crammed into a salary box.",
  },
  {
    id: "human-review",
    icon: UserCheck,
    title: "A human reads your file",
    body: "Real people review self-employed files and build you a custom document checklist for how you're actually paid — so you're never guessing what underwriting wants next.",
  },
  {
    id: "documentation",
    icon: FileText,
    title: "Documentation that fits how you're paid",
    body: "Tax returns, 1099s, K-1s, business financials, bank statements — we start from what your business actually produces. Your exact checklist appears right after you apply.",
  },
];

export default function SelfEmployed() {
  usePageView("/self-employed");
  const [, navigate] = useLocation();

  const softPullNote = (
    <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
      <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0" />
      Soft credit check only — checking your options won't affect your credit score.
    </p>
  );

  return (
    <div className="min-h-screen bg-background">
      <SEOHead
        title="Self-Employed Mortgages - Built for 1099 & Business Income | Homiquity"
        description="Self-employed, 1099, or juggling multiple income streams? Our application captures complex income source by source and routes it for human review without forcing it into a W-2-only workflow."
        ogImage={lifestyleImages.selfEmployed.src}
      />
      <SkipLink />

      <main id="main" tabIndex={-1} className="focus:outline-none">
        {/* Hero — dedicated conversion page: wordmark only, no global nav */}
        <section className="bg-muted px-4 pb-16 pt-6 sm:px-6 lg:px-8 lg:pb-20">
          <div className="mx-auto max-w-6xl">
            <div className="flex items-center justify-between">
              <Link href="/" className="touch-target inline-flex items-center" data-testid="link-se-home">
                <Logo size="md" tone="mono" />
              </Link>
              <span className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex">
                <ShieldCheck aria-hidden="true" className="h-4 w-4 text-primary" />
                No hard credit check
              </span>
            </div>

            <div className="mt-10 grid items-center gap-12 lg:mt-14 lg:grid-cols-2 lg:gap-16">
              <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
                <div className="mb-6 inline-flex items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm text-muted-foreground shadow-sm">
                  <UserCheck aria-hidden="true" className="h-4 w-4 text-primary" />
                  Humans read your file — not just software
                </div>
                <h1 className="font-display text-4xl font-bold leading-none tracking-tight sm:text-5xl lg:text-6xl" data-testid="text-se-hero-title">
                  You built a business. It should count for you, not against you.
                </h1>
                <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
                  1099s, K-1s, write-offs, multiple income streams — our application was built
                  for income like yours, and people who understand business returns review it.
                  We collect each source on its own terms instead of forcing everything into a wage box.
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground lg:justify-start">
                  <span className="flex items-center gap-2">
                    <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-primary" />
                    Human review for complicated returns
                  </span>
                  <span className="flex items-center gap-2">
                    <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-primary" />
                    No hard credit check
                  </span>
                  <span className="flex items-center gap-2">
                    <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-primary" />
                    Free — no obligation
                  </span>
                </div>
              </div>

              {/* Replaces a posed stock photograph — the most generic thing on
                  the page, and part of no system.

                  🚨 NOT wired to `Scene`/`getScene`, deliberately. Doing that
                  costs 106 EAGER bytes for every visitor of every page: those
                  modules were imported by Landing alone, and a module shared by
                  a second lazy route gets hoisted into the common eager entry.
                  `guard:bundle` caught it and removing the import returned the
                  build to the baseline exactly. 106 bytes forever is a bad
                  trade for saving one future five-line edit.

                  When the illustrator delivers `self-employed_poster.png`, the
                  Landing journey card picks it up automatically (same id); wire
                  this hero to `Scene` in that same change and move the baseline
                  then, when the bytes actually buy something. */}
              <SelfEmployedDeskArt
                className="mx-auto w-full max-w-lg lg:max-w-none"
                data-testid="img-hero-se"
              />
            </div>
          </div>
        </section>

        {/* Pre-screen — income shape first, per the progressive-profiling doctrine */}
        <section aria-labelledby="se-prescreen-heading" className="px-4 py-16 sm:px-6 lg:px-8 lg:py-20">
          <div className="mx-auto max-w-2xl">
            <Card>
              <CardHeader>
                <CardTitle id="se-prescreen-heading" className="text-2xl">
                  What does your income look like?
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  One tap — the application adapts to how you're actually paid.
                </p>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-3">
                  {INCOME_OPTIONS.map((opt) => (
                    <Button
                      key={opt.id}
                      variant="outline"
                      size="lg"
                      className="h-auto justify-start gap-3 whitespace-normal py-4 text-left"
                      onClick={() => navigate(opt.href)}
                      data-testid={`button-se-income-${opt.id}`}
                    >
                      <opt.icon aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
                      <span className="font-medium">{opt.label}</span>
                      <ArrowRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0 text-muted-foreground" />
                    </Button>
                  ))}
                </div>
                <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                  Every path leads to the same focused first check — your answer sets up the
                  right questions so you only see what applies to you.
                </p>
                <div className="mt-4 border-t border-card-border pt-4">{softPullNote}</div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* The pain — why algorithmic lenders fail this borrower */}
        <ImageTextSection
          testId="section-se-story"
          eyebrow="Built for complex income"
          title="Your tax return tells a story. We read the whole thing."
          illustration={<AdvocacyArt />}
          className="bg-muted"
        >
          <p>
            1099s, K-1s, depreciation, multiple entities — automated systems choke on income
            like yours. Homiquity's application is built for it, and people who actually
            understand business returns review your file.
          </p>
          <p>
            You get a real answer based on how you truly earn — not a one-size-fits-all
            algorithm's guess.
          </p>
        </ImageTextSection>

        <section aria-labelledby="se-pain-heading" className="px-4 py-16 sm:px-6 lg:px-8">
          <OffsetBlock side="left" className="max-w-5xl" data-testid="offset-se-pain">
            <h2 id="se-pain-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl lg:text-left">
              Why online lenders keep telling you no
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-3 sm:gap-6">
              {ALGORITHM_PAINS.map((pain) => (
                <Card key={pain.id} data-testid={`card-se-pain-${pain.id}`}>
                  <CardContent className="pt-6">
                    <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-destructive-subtle">
                      <X aria-hidden="true" className="h-5 w-5 text-destructive" />
                    </div>
                    <h3 className="font-semibold">{pain.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{pain.body}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </OffsetBlock>
        </section>

        {/* The counter — what we actually do differently (all claims code-true) */}
        <section aria-labelledby="se-approach-heading" className="bg-muted px-4 py-16 sm:px-6 lg:px-8">
          <OffsetBlock side="right" className="max-w-5xl" data-testid="offset-se-approach">
            <h2 id="se-approach-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl lg:text-left">
              How we handle income like yours
            </h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-3 sm:gap-6">
              {OUR_APPROACH.map((item) => (
                <Card key={item.id} data-testid={`card-se-approach-${item.id}`}>
                  <CardContent className="pt-6">
                    <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <item.icon aria-hidden="true" className="h-5 w-5 text-primary" />
                    </div>
                    <h3 className="font-semibold">{item.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </OffsetBlock>
        </section>

        {/* FAQ — objection handling via progressive disclosure */}
        <section aria-labelledby="se-faq-heading" className="px-4 py-16 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-3xl">
            <h2 id="se-faq-heading" className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">
              Common questions
            </h2>
            <Accordion type="single" collapsible className="mt-8">
              <AccordionItem value="write-offs">
                <AccordionTrigger data-testid="accordion-se-writeoffs">
                  Will my tax write-offs hurt my qualification?
                </AccordionTrigger>
                <AccordionContent>
                  Lenders do start from the net income on your returns — but that's exactly
                  why a human review matters. Certain deductions, like depreciation, can
                  often be added back when income is calculated properly. An algorithm reads
                  one number; a person reads the whole return.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="years">
                <AccordionTrigger data-testid="accordion-se-years">
                  How long do I need to have been self-employed?
                </AccordionTrigger>
                <AccordionContent>
                  Two years of self-employment history is the standard most programs look
                  for. Less than that isn't an automatic no — a shorter run can work in some
                  cases, especially when you stayed in the same field you used to work in as
                  an employee. The honest answer is "it depends on the whole file," which is
                  why ours gets read by a person.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="documents">
                <AccordionTrigger data-testid="accordion-se-documents">
                  What documents will I need?
                </AccordionTrigger>
                <AccordionContent>
                  It depends on how you're paid — that's the point. Typically personal and
                  business tax returns, 1099s or K-1s where they apply, and business bank
                  statements. After you apply, you get a custom document checklist built for
                  your specific income, so you gather things once instead of drip-feeding
                  paperwork for weeks.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="denied">
                <AccordionTrigger data-testid="accordion-se-denied">
                  An online lender already denied me. Is it even worth trying?
                </AccordionTrigger>
                <AccordionContent>
                  A denial from an automated system tells you about that system, not
                  necessarily about your file. Different programs weigh self-employment
                  income differently, and a proper human calculation of your income can
                  reach a different answer than a form-parser did. Checking here is free and
                  won't touch your credit score — you'll know where you actually stand.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="credit">
                <AccordionTrigger data-testid="accordion-se-credit">
                  Will checking my options hurt my credit score?
                </AccordionTrigger>
                <AccordionContent>
                  No. Seeing your options uses a soft credit check, which doesn't affect
                  your score. A hard credit pull only happens later in the process, and only
                  after you explicitly authorize it.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </section>

        {/* Final CTA */}
        <section className="bg-gradient-to-br from-precision-950 via-precision-900 to-precision-700 px-4 py-16 sm:px-6 lg:px-8">
          <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              Three minutes. No W-2 required.
            </h2>
            <p className="mt-3 max-w-xl text-white/80">
              Answer a few questions about your business and see where you stand — before
              any hard credit pull, and before you gather a single document.
            </p>
            <Button asChild size="lg" className="mt-8 max-w-md sm:max-w-none w-full gap-2 font-semibold shadow-lg sm:w-auto" data-testid="button-se-apply-footer">
              <Link href="/apply?type=self-employed">
                Check My Options
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </Link>
            </Button>
            <p className="mt-4 flex items-center gap-2 text-sm text-white/70">
              <ShieldCheck aria-hidden="true" className="h-4 w-4 text-precision-300" />
              Soft credit check only — your score is safe.
            </p>
          </div>
        </section>
      </main>

      <RelatedGuides families={["non_qm"]} heading="Self-employed borrower guides" />

      <Footer />
    </div>
  );
}
