import { Link } from "wouter";
import { Phone, Mail } from "lucide-react";
import { COMPANY_IDENTITY, companyNmlsDisplay, contactPhoneTel } from "@shared/companyIdentity";
import { VeteranFoundedBadge } from "@/components/VeteranFoundedBadge";
import { PRELAUNCH_GATED } from "@/lib/prelaunch";
import { Logo } from "@/components/brand/Logo";

export function Footer() {
  // Deep Ink container in both modes (bg-primary would invert badly in dark
  // mode, where primary becomes Paper) — the footer shares the sidebar's
  // "navigation container" stop on the ramp.
  return (
    <footer className="border-t border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
        <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <Link href="/" className="touch-target flex items-center gap-2">
              <Logo size="md" tone="brand" data-testid="logo-footer" />
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-sidebar-foreground/70">
              Clarity for every stage of homeownership. Pre-approval, property search, and AI guidance from Homi — all in one place.
            </p>
            <div className="mt-5">
              <VeteranFoundedBadge variant="compact" className="text-sidebar-foreground/85" data-testid="badge-footer-veteran" />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-sidebar-foreground">Contact Us</h3>
            <ul className="mt-4 space-y-1 text-sm text-sidebar-foreground/70">
              <li>
                <a href={`mailto:${COMPANY_IDENTITY.contactEmail}`} className="touch-target flex items-center gap-2 rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-email">
                  <Mail className="h-4 w-4 shrink-0" />
                  {COMPANY_IDENTITY.contactEmail}
                </a>
              </li>
              <li>
                <a href={contactPhoneTel()} className="touch-target flex items-center gap-2 rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-phone">
                  <Phone className="h-4 w-4 shrink-0" />
                  {COMPANY_IDENTITY.contactPhone}
                </a>
              </li>
              <li><Link href="/faq" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-faq">FAQ</Link></li>
              <li><Link href="/resources" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-resources">Resources</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-sidebar-foreground">Legal</h3>
            <ul className="mt-4 space-y-1 text-sm text-sidebar-foreground/70">
              <li><a href="https://www.nmlsconsumeraccess.org" target="_blank" rel="noopener noreferrer" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-nmls">NMLS Consumer Access</a></li>
              <li><Link href="/privacy" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-privacy">Privacy Policy</Link></li>
              <li><Link href="/terms" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-terms">Terms of Use</Link></li>
              <li><Link href="/disclosures" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-disclosures">Disclosures & Licensing</Link></li>
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-sidebar-foreground">Products</h3>
            <ul className="mt-4 space-y-1 text-sm text-sidebar-foreground/70">
              {/* This link was the one funnel entry point the prelaunch gating
                  never reached: Navigation hides its /apply CTA and
                  ConversionCTA relabels to the waitlist, while the footer —
                  mounted on every public page — kept pointing into the closed
                  funnel. Inert today (prod runs with the gate open), but a
                  re-armed gate must leave no chrome advertising a funnel it
                  redirects away from. Relabel rather than hide: a product-list
                  item silently vanishing would itself read as a regression. */}
              <li>
                <Link href={PRELAUNCH_GATED ? "/" : "/apply"} className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-lend">
                  {PRELAUNCH_GATED ? "Join the Waitlist" : "Homiquity Lend"}
                </Link>
              </li>
              <li><Link href="/ai-coach" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-coach">Homi</Link></li>
              <li><Link href="/rent-reporting" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-rent-reporting">Rent Reporting</Link></li>
              <li><Link href="/rates" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-rates">Rates</Link></li>
              <li><Link href="/resources" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-resources-2">Resources</Link></li>
              <li><Link href="/partners" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-partners">Partner with us</Link></li>
              <li><Link href="/for-cpas" className="touch-target flex items-center rounded-md px-2 py-2 -mx-2 hover:text-sidebar-foreground transition-colors" data-testid="link-footer-for-cpas">For CPAs</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-12 border-t border-sidebar-border pt-8">
          {/* Broker-accurate legal copy (roadmap #33): Homiquity is a mortgage
              broker, not a direct lender — claiming "direct loans" would be a
              Reg N / UDAAP misrepresentation. The NMLS unique identifier
              renders only once licensing assigns a real ID (SAFE Act / Reg H;
              companyNmlsDisplay() returns null while PENDING — never show a
              placeholder). */}
          <p className="text-xs text-sidebar-foreground/60 leading-relaxed" data-testid="text-footer-legal">
            &copy; {new Date().getFullYear()} {COMPANY_IDENTITY.legalName}.
            {companyNmlsDisplay() ? ` ${companyNmlsDisplay()}.` : ""} Equal Housing Opportunity.
          </p>
          <p className="mt-4 text-xs text-sidebar-foreground/60 leading-relaxed" data-testid="text-footer-disclosure">
            {COMPANY_IDENTITY.legalName} is a mortgage broker. Loans are arranged with third-party
            wholesale lending partners and are subject to credit approval; {COMPANY_IDENTITY.shortName} does
            not make credit decisions or fund loans. Licensing pursuant to applicable state law.
            Not available in all states. Verify our licensing at{" "}
            <a href="https://www.nmlsconsumeraccess.org" target="_blank" rel="noopener noreferrer" className="underline hover:text-sidebar-foreground transition-colors">
              NMLS Consumer Access
            </a>.
          </p>
        </div>
      </div>
    </footer>
  );
}
