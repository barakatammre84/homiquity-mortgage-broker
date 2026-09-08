import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const navigate = vi.fn();

vi.mock("wouter", () => ({ useLocation: () => ["/", navigate] }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: false }) }));

import { HomebuyerPlanPreview } from "./HomebuyerPlanPreview";
import { PENDING_COACH_QUESTION_KEY } from "@/lib/pendingCoachQuestion";

describe("HomebuyerPlanPreview", () => {
  beforeEach(() => {
    navigate.mockReset();
    localStorage.clear();
  });

  it("asks one decision at a time and produces a useful plan before signup", async () => {
    const user = userEvent.setup();
    render(<HomebuyerPlanPreview />);

    expect(screen.getByTestId("homebuyer-plan-step").textContent).toMatch(/when/i);
    expect(screen.queryByTestId("homebuyer-plan-result")).toBeNull();

    await user.click(screen.getByTestId("homebuyer-timeline-within_year"));
    expect(screen.getByTestId("homebuyer-plan-step").textContent).toMatch(/income/i);
    await user.click(screen.getByTestId("homebuyer-income-mixed"));
    expect(screen.getByTestId("homebuyer-plan-step").textContent).toMatch(/unclear|hardest/i);
    await user.click(screen.getByTestId("homebuyer-blocker-income_review"));

    expect(screen.getByTestId("homebuyer-plan-result").textContent).toMatch(/Preparing/i);
    expect(screen.getByTestId("homebuyer-plan-actions").children).toHaveLength(3);
    expect(screen.getByTestId("homebuyer-plan-result").textContent).toMatch(/planning stage, not a loan approval/i);
  });

  it("carries the plan into Homi across signup", async () => {
    const user = userEvent.setup();
    render(<HomebuyerPlanPreview />);

    await user.click(screen.getByTestId("homebuyer-timeline-within_three_months"));
    await user.click(screen.getByTestId("homebuyer-income-business"));
    await user.click(screen.getByTestId("homebuyer-blocker-savings_credit"));
    await user.click(screen.getByTestId("button-continue-homebuyer-plan"));

    expect(navigate).toHaveBeenCalledWith("/signup");
    expect(localStorage.getItem(PENDING_COACH_QUESTION_KEY)).toMatch(/business income/i);
  });
});
