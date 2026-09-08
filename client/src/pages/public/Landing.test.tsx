import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * The public home page, pinned on what makes it a front door rather than a
 * brochure about us.
 *
 * 1. It talks about the customer. The version this replaced led with the
 *    founder's CV and a trust row that was four facts about Homiquity — years in
 *    banking, our architecture, our compliance, our encryption. A visitor cannot
 *    use any of those, and credential copy creeps back in easily.
 * 2. It stays a front door, not a sitemap. Three mortgage goals, one trust row,
 *    and one explanation of the complex-income advantage.
 * 3. The advertising rails hold. This is a soliciting surface, so a stray rate,
 *    payment or APR figure is a Reg Z §1026.24 trigger-term problem with no
 *    disclosure attached, and approval language is a Reg N problem.
 * 4. 🚨 It never claims Homiquity lends, approves, decides, or funds. We are a
 *    mortgage broker — Footer.tsx says so in the standing disclosure — and
 *    marketing that contradicts our own footer is the real exposure here.
 */

// Keep every prop — a Link mock that drops className/data-testid silently hides
// the very elements these assertions look for.
vi.mock("wouter", () => ({
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useLocation: () => ["/", vi.fn()],
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: false }) }));
vi.mock("@/hooks/useActivityTracker", () => ({ usePageView: () => {} }));

// Chrome the page renders but this test is not about.
vi.mock("@/components/Navigation", () => ({ Navigation: () => null }));
vi.mock("@/components/Footer", () => ({ Footer: () => null }));
vi.mock("@/components/SEOHead", () => ({ SEOHead: () => null }));
vi.mock("@/components/SkipLink", () => ({ SkipLink: () => null }));

import Landing from "./Landing";

/**
 * The page's own marketing copy — excludes the estimator, which is a tool.
 *
 * 🚨 `textContent` concatenates sibling nodes with NO separator, so a link ending
 * in "…we lend" followed by a paragraph starting "We'll…" reads as "we lendWe'll".
 * That silently defeats a trailing `\b` in any pattern below — this exact copy
 * shipped past this exact assertion once. Patterns here therefore anchor only at
 * the START of a phrase, never at its end.
 */
function marketingCopy(): string {
  return [
    screen.getByTestId("section-hero"),
    screen.getByTestId("section-journeys"),
    screen.getByTestId("section-trust"),
  ]
    .map((el) => el.textContent ?? "")
    .join(" ");
}

describe("Landing", () => {
  it("opens the three mortgage goals in the correct funnel mode", () => {
    render(<Landing />);
    expect(screen.getByTestId("goal-buy").getAttribute("href")).toBe("/apply");
    expect(screen.getByTestId("goal-refinance").getAttribute("href")).toBe("/apply?type=refinance");
    expect(screen.getByTestId("goal-equity").getAttribute("href")).toBe("/apply?type=cashout");
  });

  it("puts the goal choice before the calculator and keeps Homi available later", () => {
    render(<Landing />);

    const hero = screen.getByTestId("section-hero");
    expect(hero.contains(screen.getByTestId("hero-goal-picker"))).toBe(true);
    expect(hero.contains(screen.getByTestId("coach-prompt-bar"))).toBe(false);
    const estimator = screen.getByTestId("section-estimator");
    const journeys = screen.getByTestId("section-journeys");
    expect(hero.compareDocumentPosition(estimator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(estimator.compareDocumentPosition(journeys) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(journeys.contains(screen.getByTestId("coach-prompt-bar"))).toBe(true);
  });

  it("makes mixed income concrete instead of flattening it into a wage claim", () => {
    render(<Landing />);

    expect(screen.getAllByTestId(/^income-path-/)).toHaveLength(3);
    for (const id of ["work", "business", "rental"]) {
      expect(screen.getByTestId(`income-path-${id}`)).toBeTruthy();
    }
    expect(screen.getByTestId("income-path-rental").textContent).toMatch(/Schedule E/i);
    expect(screen.getByTestId("income-path-business").textContent).toMatch(/K-1s/i);
  });

  it("says nothing about the founder's credentials", () => {
    render(<Landing />);
    const copy = marketingCopy();

    // These were the hero eyebrow and the first trust point. They are about us,
    // not about the visitor, and they belong on /about.
    expect(copy).not.toMatch(/veteran/i);
    expect(copy).not.toMatch(/\b15\+?\s*years?\b/i);
    expect(copy).not.toMatch(/banking/i);
  });

  it("never claims Homiquity lends, approves, decides, or funds", () => {
    render(<Landing />);
    const copy = marketingCopy();

    // Footer.tsx: "Homiquity does not make credit decisions or fund loans."
    // Marketing that contradicts the standing disclosure is the Reg N/UDAAP risk.
    expect(copy).not.toMatch(/\bdirect lender\b/i);
    // No trailing \b — see the note on marketingCopy().
    expect(copy).not.toMatch(/\bwe (?:lend|fund|approve|underwrite)/i);
    expect(copy).not.toMatch(/\bour loans?/i);
    // And it must positively say who decides.
    expect(screen.getByTestId("text-coach-disclaimer").textContent).toMatch(
      /lenders make the credit decision/i,
    );
  });

  it("never names or counts our wholesale lending partners", () => {
    render(<Landing />);
    const copy = marketingCopy();

    // Borrower-transparency doctrine (shared/borrowerActivityView.ts): lender
    // identity is masked from borrowers everywhere. "Our lending partners" is the
    // only permitted phrasing.
    for (const name of ["UWM", "United Wholesale", "Rocket Pro", "Plaza", "Angel Oak", "Newrez"]) {
      expect(copy).not.toContain(name);
    }
    expect(copy).not.toMatch(/\b\d+\+?\s+(?:lenders|lending partners)\b/i);
  });

  it("does not imply rent history reaches a credit file", () => {
    render(<Landing />);
    // The renting door used to promise "what your rent already proves about you".
    // Nothing downstream furnishes rent — MyLease.tsx states outright that saving a
    // lease reports nothing to the bureaus — so that phrasing promised a benefit the
    // product disclaims one surface away (Reg N / MAP Rule §1014.3).
    const copy = marketingCopy();
    expect(copy).not.toMatch(/credit (file|bureau|report)/i);
    expect(copy).not.toMatch(/rent (?:history|already) (?:proves|builds|counts)/i);
  });

  it("does not claim a way to qualify that isn't built", () => {
    render(<Landing />);
    // Jumbo is a real supported product, so naming it is fine. Asset depletion
    // has no path module yet (non-W2 plan §4.2) — claiming it would advertise a
    // capability the engine cannot perform.
    expect(marketingCopy()).not.toMatch(/asset[- ]depletion|qualify on your assets/i);
  });

  it("points at the live licensing list rather than naming states in copy", () => {
    render(<Landing />);

    // A hardcoded state list goes stale the day a license is issued; the
    // /disclosures card renders from LICENSED_STATE_DETAILS.
    expect(screen.getByTestId("link-trust-licensing").getAttribute("href")).toBe(
      "/disclosures#licensing",
    );
    expect(screen.getByTestId("link-footprint-licensing").getAttribute("href")).toBe(
      "/disclosures#licensing",
    );
    expect(screen.getByTestId("text-footprint").textContent).toMatch(
      /tell you up front if we can't arrange financing/i,
    );
  });

  it("keeps a no-account route to buying power, pointing at the band on this page", () => {
    render(<Landing />);
    expect(screen.getByTestId("link-hero-afford").getAttribute("href")).toBe("#buying-power");
    expect(screen.getByTestId("section-estimator").id).toBe("buying-power");
  });

  it("gives the estimator its own band — the only surface here that answers without an account", () => {
    render(<Landing />);
    const estimator = screen.getByTestId("section-estimator");
    expect(estimator.contains(screen.getByTestId("card-buying-power-estimator"))).toBe(true);
  });

  it("stays short — no re-added marketing bands", () => {
    render(<Landing />);
    expect(screen.getByTestId("section-trust")).toBeTruthy();
    // The bands that made the old page a sitemap. If one comes back it belongs on
    // its own route. (The estimator is deliberately not listed — it is a working
    // tool, not another block of copy.)
    expect(screen.queryByTestId("section-rates-teaser")).toBeNull();
    expect(screen.queryByTestId("section-audience-paths")).toBeNull();
    expect(screen.queryByTestId("card-founder-note")).toBeNull();
  });

  it("carries no Reg Z trigger term in the page's own marketing copy", () => {
    render(<Landing />);

    // Scoped to what the PAGE asserts, not to the estimator, which is an
    // interactive tool rendering figures the visitor chose. §1026.24(d) trigger
    // terms are a down-payment amount/percentage, a number of payments, a
    // repayment period, a payment amount, or a finance-charge amount.
    const copy = marketingCopy();
    expect(copy).not.toMatch(/\d+(\.\d+)?\s*%/); // a rate or APR
    expect(copy).not.toMatch(/\$\s?[\d,]+/); // a payment or dollar amount
    expect(copy).not.toMatch(/\b(30|20|15|10)[-\s]year\b/i); // a repayment term
    expect(copy).not.toMatch(/as low as/i);
  });

  it("opens the estimator with no figure on screen and no ask for contact details", () => {
    render(<Landing />);
    const band = screen.getByTestId("section-estimator").textContent ?? "";

    expect(screen.queryByTestId("text-estimator-result")).toBeNull();
    expect(band).toMatch(/no credit check/i);
    expect(band).toMatch(/no sign-up/i);
  });

  it("never presents anything on the page as an approval or a commitment", () => {
    const { container } = render(<Landing />);
    const copy = container.textContent ?? "";

    expect(copy).not.toMatch(/you(?:'re| are) (?:pre-?)?approved/i);
    expect(copy).not.toMatch(/guaranteed (?:approval|rate)/i);
    expect(screen.getByTestId("text-coach-disclaimer").textContent).toMatch(
      /not a loan approval, offer, or commitment/i,
    );
  });
});
