import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MessageList } from "./MessageList";
import type { CoachTurnState } from "./useCoachStream";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

Element.prototype.scrollIntoView = vi.fn();

const failedTurn: CoachTurnState = {
  status: "error",
  pendingUserMessage: "Where does my file stand?",
  streamingText: "",
  captured: [],
  panel: {},
  lintReplaced: false,
  degraded: false,
  error: {
    code: "not_configured",
    message: "Homi's credentials are invalid on this environment.",
    retryable: false,
  },
};

describe("MessageList error recovery", () => {
  it("hides provider details and keeps the borrower moving with human help", () => {
    render(<MessageList messages={[]} turn={failedTurn} onRetry={() => {}} onDismissError={() => {}} />);

    const error = screen.getByTestId("chat-turn-error");
    expect(error.textContent).toMatch(/temporarily unavailable/i);
    expect(error.textContent).toMatch(/your file is safe/i);
    expect(error.textContent).not.toMatch(/credential|environment|anthropic|provider/i);
    expect(screen.getByTestId("link-error-application").getAttribute("href")).toBe("/apply");
    expect(screen.getByTestId("link-error-documents").getAttribute("href")).toBe("/documents");
    expect(screen.getByTestId("link-error-loan-officer").getAttribute("href")).toBe("/messages");
  });
});
