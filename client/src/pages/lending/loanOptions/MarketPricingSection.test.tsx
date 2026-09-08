import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarketPricingSection, type MarketOffersResponse } from "./MarketPricingSection";

afterEach(cleanup);

const unavailableMarket = (
  overrides: Partial<MarketOffersResponse> = {},
): MarketOffersResponse => ({
  status: "NO_ACTIVE_RATE_SHEETS",
  qualifier: "PRELIMINARY",
  indicative: true,
  pricedAt: "2026-09-08T12:00:00.000Z",
  lockTermDays: 30,
  lenderCount: 0,
  assumptions: [],
  missingItems: [],
  offers: [],
  ...overrides,
});

describe("MarketPricingSection unavailable states", () => {
  it("explains when a profile has no matching live wholesale pricing", () => {
    render(<MarketPricingSection market={unavailableMarket()} />);

    const notice = screen.getByTestId("section-market-pricing-status");
    expect(notice.textContent).toContain("Live lender pricing needs review");
    expect(notice.textContent).toContain("planning estimates");
    expect(notice.textContent).toContain("compare current lender pricing");
  });

  it("shows the missing profile details needed before live pricing", () => {
    render(
      <MarketPricingSection
        market={unavailableMarket({
          status: "INSUFFICIENT_PROFILE",
          missingItems: ["Occupancy", "Credit score"],
        })}
      />,
    );

    const notice = screen.getByTestId("section-market-pricing-status");
    expect(notice.textContent).toContain("More details are needed for live pricing");
    expect(notice.textContent).toContain("Occupancy");
    expect(notice.textContent).toContain("Credit score");
  });
});
