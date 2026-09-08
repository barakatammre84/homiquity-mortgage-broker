import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WelcomeState } from "./WelcomeState";

describe("WelcomeState", () => {
  it("introduces Homi through its real work without a robot or generic icon grid", () => {
    const { container } = render(<WelcomeState onStart={() => {}} insights={[]} />);
    expect(screen.getByTestId("text-coach-welcome").textContent).toMatch(/messy version/i);
    expect(screen.getByTestId("homi-capability-income").textContent).toMatch(/income/i);
    expect(screen.getByTestId("homi-capability-documents").textContent).toMatch(/document/i);
    expect(screen.getByTestId("homi-capability-next").textContent).toMatch(/next action/i);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("starts with a complex-income prompt in one action", async () => {
    const onStart = vi.fn();
    const user = userEvent.setup();
    render(<WelcomeState onStart={onStart} insights={[]} />);
    await user.click(screen.getByTestId("button-starter-map-income"));
    expect(onStart).toHaveBeenCalledWith(expect.stringMatching(/salary.*business.*rental/i));
  });
});
