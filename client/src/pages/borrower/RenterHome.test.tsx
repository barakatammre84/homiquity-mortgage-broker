import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { homeownershipGoalKeys } from "@/lib/queryClient";

vi.mock("wouter", () => ({ Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock("@/components/HomeReadinessPassport", () => ({ HomeReadinessPassport: () => <div data-testid="mock-passport" /> }));
vi.mock("@/components/TaxReturnInsightCard", () => ({ TaxReturnInsightCard: () => <div data-testid="mock-tax-insight" /> }));
vi.mock("@/components/PartnerSharingCard", () => ({ PartnerSharingCard: () => null }));

import { RenterHome } from "./RenterHome";

describe("RenterHome", () => {
  it("turns the saved goal into one homebuyer plan with milestones and human help", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(homeownershipGoalKeys.all(), {
      planningStage: "preparing",
      goal: {
        currentSavingsBalance: "7500",
        currentMonthlySavings: "500",
        currentRent: "1800",
        monthlyIncome: "8500",
        targetDownPayment: "20000",
        targetHomePrice: "450000",
        currentPhase: "saving",
        journeyDay: 42,
      },
      milestones: [{ id: "m1", title: "Journey Started", description: "Your plan was created." }],
    });
    client.setQueryData(["/api/borrower-graph"], { readiness: { score: 72 } });

    render(<QueryClientProvider client={client}><RenterHome userName="Alex" /></QueryClientProvider>);

    expect(screen.getByTestId("renter-planning-stage").textContent).toMatch(/preparing/i);
    expect(screen.getByTestId("renter-next-action").textContent).toMatch(/savings|income|plan/i);
    expect(screen.getByTestId("renter-milestones").textContent).toContain("Journey Started");
    expect(screen.getByTestId("link-renter-message-team").getAttribute("href")).toBe("/messages");
    expect(screen.getByTestId("link-renter-ask-homi").getAttribute("href")).toBe("/ai-coach");
  });
});
