import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMessage, StreamingMessage, TypingIndicator } from "./ChatMessage";
import type { CoachMessage } from "./types";

const assistantMessage: CoachMessage = {
  id: "assistant-1",
  role: "assistant",
  content: "I can organize that income story.",
  createdAt: "2026-09-08T12:00:00.000Z",
};

describe("Homi message identity", () => {
  it("uses the Homiquity mark for saved, streaming, and pending assistant replies", () => {
    const { container } = render(
      <>
        <ChatMessage message={assistantMessage} />
        <StreamingMessage text="Mapping the file" />
        <TypingIndicator />
      </>,
    );

    expect(screen.getByTestId("logo-homi-message")).toBeTruthy();
    expect(screen.getByTestId("logo-homi-streaming")).toBeTruthy();
    expect(screen.getByTestId("logo-homi-typing")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });
});
