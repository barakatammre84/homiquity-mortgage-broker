import { motion } from "framer-motion";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { COMPANY_IDENTITY, companyNmlsDisplay } from "@shared/companyIdentity";
import { ArrowRight, Check, ChevronLeft, Clock, Home, LogIn, Shield, TrendingUp } from "lucide-react";
import { formatCurrency } from "@/lib/formatters";
import { PresalesDisclaimer } from "@/components/PresalesDisclaimer";
import type { AffordabilityEstimateResults } from "@/lib/affordabilityEstimate";
import { estimateTimeRemaining, type FunnelProgress } from "@/funnel/preApprovalMachine";

/**
 * Funnel chrome (extracted from PreApproval.tsx): the draft-restore banner
 * (#249 — adopting a saved draft is ONE explicit decision point, never a
 * silent prefill), the pre-signup affordability teaser, the pre-submit auth
 * gate, the compliance footer whose copy is regulatory surface (soft-inquiry
 * framing, not-a-commitment disclosure, broker disclosure, Equal Housing), and
 * the orientation header at the top of every question step.
 *
 * The header lives HERE rather than in its own module for a measured reason:
 * a new file would have to source its two glyphs from `@/lib/icons`, and that
 * registry is one object literal over ~45 lucide icons, so importing it drags
 * eight more preload chunks into the /apply route for two ticks. This file
 * already imports the glyphs it needs directly, as every module in this
 * directory does, so the header costs the funnel nothing to host.
 */

export function RestoreDraftBanner({
  onRestore,
  onDismiss,
}: {
  onRestore: () => void;
  onDismiss: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed top-2 left-1/2 -translate-x-1/2 z-50 w-full max-w-md px-4"
      data-testid="banner-restore-draft"
    >
      <div className="bg-card border shadow-lg rounded-xl p-4 flex items-center gap-3">
        <div className="bg-primary/10 rounded-lg p-2 shrink-0">
          <Clock className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">You have unsaved progress</p>
          <p className="text-xs text-muted-foreground">Pick up where you left off?</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" className="touch-target" variant="ghost" onClick={onDismiss} data-testid="button-dismiss-restore">
            No
          </Button>
          <Button size="sm" className="touch-target" onClick={onRestore} data-testid="button-restore-draft">
            Restore
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * Shown once the funnel's final gate passes but before the auth wall — gives
 * an unauthenticated borrower a payoff (a rough range, from their own
 * answers) before asking them to create an account, instead of the auth gate
 * being the first thing they see after 3 minutes of typing. Estimate-only:
 * same math as the public affordability calculator (`calculateAffordabilityEstimate`),
 * not the underwriting engine, so it carries the same PresalesDisclaimer.
 */
export function AffordabilityTeaserOverlay({
  estimate,
  targetPrice,
  onContinue,
  onDismiss,
}: {
  estimate: AffordabilityEstimateResults;
  targetPrice: number | null;
  onContinue: () => void;
  onDismiss: () => void;
}) {
  const withinRange = targetPrice != null && targetPrice <= estimate.maxHomePrice;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
      data-testid="affordability-teaser-overlay"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-card border rounded-xl shadow-lg p-8 max-w-md w-full text-center"
      >
        <div className="mx-auto mb-6 h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center">
          <TrendingUp className="h-8 w-8 text-primary" />
        </div>
        <h3 className="text-2xl font-bold text-foreground mb-1" data-testid="text-teaser-title">
          You're likely in range
        </h3>
        <p className="text-sm text-muted-foreground mb-4">Based on what you shared</p>
        <p className="text-3xl font-bold text-primary mb-1" data-testid="text-teaser-range">
          {formatCurrency(estimate.comfortablePrice)} &ndash; {formatCurrency(estimate.maxHomePrice)}
        </p>
        <p className="text-sm text-muted-foreground mb-4">
          Est. {formatCurrency(estimate.monthlyPITI)}/mo
        </p>
        {targetPrice != null && (
          <p className="text-sm text-muted-foreground mb-6" data-testid="text-teaser-target-comparison">
            Your target of {formatCurrency(targetPrice)} is{" "}
            <span className="font-medium text-foreground">
              {withinRange ? "within this range" : "above this estimate"}
            </span>
            .
          </p>
        )}
        <PresalesDisclaimer className="mb-6 text-left" />
        <div className="space-y-3">
          <Button
            size="lg"
            className="w-full"
            onClick={onContinue}
            data-testid="button-teaser-continue"
          >
            Continue to my application
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm" className="touch-target"
            onClick={onDismiss}
            data-testid="button-teaser-dismiss"
          >
            Go back to form
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}

export function AuthGateOverlay({ onDismiss }: { onDismiss: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
      data-testid="auth-gate-overlay"
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-card border rounded-xl shadow-lg p-8 max-w-md w-full text-center"
      >
        <div className="mx-auto mb-6 h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center">
          <LogIn className="h-8 w-8 text-primary" />
        </div>
        <h3 className="text-2xl font-bold text-foreground mb-3" data-testid="text-auth-gate-title">
          One last step
        </h3>
        <p className="text-muted-foreground mb-6">
          Create an account (or sign in) to see your personalized result and next steps. Your answers are already saved.
        </p>
        <div className="space-y-3">
          <Button asChild size="lg" className="w-full" data-testid="button-auth-gate-signup">
            <a href="/signup">
              Create account
              <ArrowRight className="ml-2 h-4 w-4" />
            </a>
          </Button>
          <Button asChild size="lg" variant="outline" className="w-full" data-testid="button-auth-gate-login">
            <a href="/login">
              Sign In
            </a>
          </Button>
          <Button
            variant="ghost"
            size="sm" className="touch-target"
            onClick={onDismiss}
            data-testid="button-auth-gate-dismiss"
          >
            Go back to form
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-4 flex items-center justify-center gap-1">
          <Shield className="h-3 w-3" />
          Your data is encrypted and never shared
        </p>
      </motion.div>
    </motion.div>
  );
}

export function FunnelFooter() {
  return (
    <footer className="border-t border-muted bg-muted/30 mt-auto" data-testid="footer-compliance">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 space-y-6">
        <div className="text-xs text-muted-foreground leading-relaxed space-y-4">
          <p>
            <sup>1</sup> Homiquity&apos;s pre-approval process uses self-reported information and a soft credit inquiry to provide an initial determination. A soft credit check will not affect your credit score. Final loan approval is subject to full underwriting review, including verification of income, assets, employment, and property appraisal. Pre-approval is not a commitment to lend and does not guarantee final approval. All loans are subject to credit and property approval. Terms and conditions apply.
          </p>
        </div>

        <div className="border-t border-muted pt-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-sm">
            <div>
              <p className="font-semibold text-foreground text-base mb-3">Homiquity</p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Homiquity Mortgage Corporation is a mortgage broker. Loans are arranged with third-party wholesale lending partners; Homiquity does not make credit decisions or fund loans.
              </p>
            </div>
            <div>
              <p className="font-medium text-foreground mb-2">Contact Us</p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>{COMPANY_IDENTITY.contactEmail}</p>
                <p>{COMPANY_IDENTITY.contactPhone}</p>
              </div>
              <div className="mt-3 space-y-1">
                <p className="font-medium text-foreground text-xs">Resources</p>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <Link href="/faq" className="block hover:text-foreground transition-colors" data-testid="link-funnel-footer-faq">
                    FAQ
                  </Link>
                  <Link href="/privacy" className="block hover:text-foreground transition-colors" data-testid="link-funnel-footer-privacy">
                    Privacy Policy
                  </Link>
                  <Link href="/terms" className="block hover:text-foreground transition-colors" data-testid="link-funnel-footer-terms">
                    Terms of Use
                  </Link>
                </div>
              </div>
            </div>
            <div>
              <p className="font-medium text-foreground mb-2">Legal</p>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <a
                  href="https://www.nmlsconsumeraccess.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block hover:text-foreground transition-colors"
                  data-testid="link-funnel-footer-nmls"
                >
                  NMLS Consumer Access
                </a>
                <Link href="/disclosures" className="block hover:text-foreground transition-colors" data-testid="link-funnel-footer-disclosures">
                  Disclosures &amp; Licensing
                </Link>
                <p>Equal Housing Opportunity</p>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-muted pt-4 text-xs text-muted-foreground leading-relaxed space-y-3">
          {/* The company NMLS unique identifier renders inline on the funnel's
              own chrome — the page where the borrower is actively submitting
              income/debt/consent data — not just one click away on /disclosures
              (SAFE Act / Reg H unique-identifier display convention). Same
              contract as Footer.tsx: companyNmlsDisplay() is null while the id
              is PENDING — never show a placeholder. */}
          <p>
            &copy; {new Date().getFullYear()} Homiquity Mortgage Corporation. All rights reserved.{companyNmlsDisplay() ? ` ${companyNmlsDisplay()}.` : ""} Homiquity is a family of companies serving the homeownership ecosystem including mortgage brokerage, property search, and AI-powered guidance.
          </p>
          <p>
            Mortgage loans arranged by Homiquity Mortgage Corporation through third-party wholesale lending partners. Not available in all states. Equal Housing Opportunity. NMLS Consumer Access.
          </p>
          <div className="flex items-center justify-center gap-4 pt-2">
            <div className="flex items-center gap-1">
              <Shield className="h-3.5 w-3.5" />
              <span>Soft credit check only</span>
            </div>
            <div className="flex items-center gap-1">
              <Home className="h-3.5 w-3.5" />
              <span>Equal Housing Opportunity</span>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}

/**
 * The pre-approval funnel's orientation chrome.
 *
 * What this replaces, and why: the funnel used to show a 1px hairline pinned to
 * the very top edge of the viewport plus a 14px muted "Step 3 of 13". On a
 * 13-to-16-step form that is close to no orientation at all — the hairline is
 * below the threshold of notice, the counter gives a number with no sense of
 * how much work each remaining step is, and there was no percentage anywhere.
 *
 * Three things carry the borrower now:
 *
 *  1. A CHAPTER RAIL. Four fixed chapters (Your goal / The home / Your
 *     finances / Finish) each own a segment of the bar. The chapter list never
 *     reflows — only the fill inside it moves — so the rail stays a stable
 *     landmark even though the step list is dynamic (a self-employed veteran
 *     answers 16 steps, a W-2 buyer 13).
 *  2. A step counter and a PERCENTAGE, both legible rather than incidental.
 *  3. A time-to-finish derived from the steps actually left on this borrower's
 *     route (`estimateTimeRemaining`), not from a hardcoded index threshold.
 *
 * The percentage is honest, which means it can dip by a few points when an
 * answer adds steps (saying yes to military service injects the two VA
 * residual-income questions). That is the truth about an adaptive form, and
 * the chapter rail is what absorbs it: the borrower sees "still in The home",
 * not a bar that lurched backwards with no explanation.
 */
export function FunnelProgressHeader({
  progress,
  onBack,
  canGoBack,
  showSaved,
}: {
  progress: FunnelProgress;
  onBack: () => void;
  canGoBack: boolean;
  showSaved: boolean;
}) {
  const percent = Math.round(progress.percent);
  const currentSection = progress.sections.find((s) => s.status === "current");

  return (
    <div className="fixed top-0 w-full z-40 bg-background/90 backdrop-blur-sm border-b">
      <div className="w-full max-w-5xl mx-auto px-4 sm:px-6 pt-3 pb-2.5 sm:pt-4 sm:pb-3">
        {/* Row 1 — back, counter + percentage, autosave */}
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={onBack}
            disabled={!canGoBack}
            aria-label="Go back to the previous question"
            className={`-ml-2 p-2 rounded-full hover:bg-muted transition-all ${
              canGoBack ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
            data-testid="button-back"
          >
            <ChevronLeft className="w-5 h-5 text-muted-foreground" />
          </button>

          <div
            className="flex flex-1 min-w-0 items-baseline justify-center gap-x-2 gap-y-0 flex-wrap"
            data-testid="text-step-counter"
          >
            <span className="text-sm font-semibold text-foreground whitespace-nowrap">
              Step {progress.index} of {progress.total}
            </span>
            <span className="text-sm text-muted-foreground/50" aria-hidden="true">
              ·
            </span>
            <span
              className="text-sm font-semibold text-primary whitespace-nowrap"
              data-testid="text-progress-percent"
            >
              {percent}% complete
            </span>
          </div>

          {/* Fixed-width so the counter above stays optically centred whether or
              not the autosave chip is showing. */}
          <div className="flex w-16 shrink-0 items-center justify-end">
            {showSaved && (
              <span
                className="text-xs text-muted-foreground/60 flex items-center gap-1"
                data-testid="text-autosave-indicator"
              >
                <Check className="h-3.5 w-3.5" /> Saved
              </span>
            )}
          </div>
        </div>

        {/* Row 2 — the chapter rail. One segment per chapter, filled by how far
            through that chapter the borrower is. `role="progressbar"` carries
            the overall figure for assistive tech; the segments themselves are
            decorative, so the whole strip is a single labelled control rather
            than four unlabelled ones. */}
        <div
          className="mt-2.5 flex items-stretch gap-1.5"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`Step ${progress.index} of ${progress.total}, ${percent} percent complete`}
          data-testid="progress-section-rail"
        >
          {progress.sections.map((section) => (
            <div key={section.id} className="flex-1 min-w-0" data-testid={`progress-section-${section.id}`}>
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-primary"
                  initial={false}
                  animate={{ width: `${section.percent}%` }}
                  transition={{ duration: 0.35, ease: "easeOut" }}
                />
              </div>
              {/* Labels are the point of the rail, so they render at every
                  width. Truncation beats hiding: a phone still shows "Your
                  goal / The home / Your fin… / Finish" and the current chapter
                  is emphasised. */}
              <div className="mt-1.5 flex items-center gap-1">
                {section.status === "done" && (
                  <Check
                    className="h-3.5 w-3.5 shrink-0 text-primary"
                    data-testid={`icon-section-done-${section.id}`}
                  />
                )}
                <span
                  className={`block truncate text-xs leading-tight ${
                    section.status === "current"
                      ? "font-semibold text-foreground"
                      : section.status === "done"
                        ? "text-muted-foreground"
                        : "text-muted-foreground/50"
                  }`}
                >
                  {section.label}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Row 3 — where you are inside the current chapter, and how long is
            left. Both derived; nothing here is a fixed string. The chapter is
            named once, in the rail above — repeating it here read as a bug. */}
        {currentSection && (
          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span data-testid="text-section-position">
              {currentSection.stepsReached} of {currentSection.stepCount} in this section
            </span>
            <span data-testid="text-time-remaining">{estimateTimeRemaining(progress.remaining)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
