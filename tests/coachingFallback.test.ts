import { beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";

const finalMessage = vi.fn();
const logInteraction = vi.fn();

vi.mock("../server/auditLog", () => ({ logAudit: vi.fn() }));
vi.mock("../server/services/aiInteractionLog", () => ({ logAiInteraction: (...args: unknown[]) => logInteraction(...args) }));
vi.mock("../server/services/coachingClient", () => ({
  getAnthropic: () => ({
    messages: {
      stream: () => ({ on: () => {}, abort: () => {}, finalMessage }),
    },
  }),
  isCoachConfigured: () => true,
  COACH_MODEL: "test-model",
  COACH_PROMPT_VERSION: "test-prompt",
  MAX_MODEL_CALLS_PER_TURN: 1,
  TURN_BUDGET_MS: 10_000,
  MAX_COMPLETION_TOKENS: 256,
  HISTORY_WINDOW_MESSAGES: 4,
}));

import { runCoachTurn } from "../server/services/coachingTurn";

describe("Homi provider fallback", () => {
  beforeEach(() => {
    finalMessage.mockReset();
    logInteraction.mockReset();
  });

  it("turns an invalid provider credential into labeled standard guidance", async () => {
    finalMessage.mockRejectedValue(
      new Anthropic.AuthenticationError(
        401,
        { type: "error", error: { type: "authentication_error", message: "bad key" } },
        "bad key",
        new Headers(),
      ),
    );
    const emit = vi.fn();

    const result = await runCoachTurn({
      req: {} as never,
      userId: "user-1",
      userRole: "aspiring_owner",
      conversationId: "conversation-1",
      turnId: "turn-1",
      userMessage: "What should I prepare?",
      history: [],
      verifiedContext: { hasApplication: false, completionPercentage: 0 } as never,
      emit,
    });

    expect(result.degraded).toBe(true);
    expect(result.message).toMatch(/temporarily unavailable/i);
    expect(result.message).toMatch(/has not added new information/i);
    expect(result.message).not.toMatch(/credential|environment|anthropic/i);
    expect(emit).toHaveBeenCalledWith({ type: "degraded", reason: "temporarily_unavailable" });
    expect(logInteraction).toHaveBeenCalledWith(expect.objectContaining({ isError: "true" }));
  });
});
