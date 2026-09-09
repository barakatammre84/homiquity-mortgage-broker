// The turn runner: SSE tool-loop, error mapping, system-prompt assembly, offline fallback.
// Split from the old server/services/coachingService.ts — which re-exports it.
import type { Request } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { logAudit } from "../auditLog";
import { logAiInteraction } from "./aiInteractionLog";
import {
  getAnthropic,
  isCoachConfigured,
  COACH_MODEL,
  COACH_PROMPT_VERSION,
  MAX_MODEL_CALLS_PER_TURN,
  TURN_BUDGET_MS,
  MAX_COMPLETION_TOKENS,
  HISTORY_WINDOW_MESSAGES,
} from "./coachingClient";
import { type VerifiedUserContext, type CoachResponse, buildVerifiedContextPrompt, deriveCompletionPercentage, deriveReadinessProfile } from "./coachingContext";
import { STATIC_COACH_PROMPT } from "./coachingPrompt";
import { type CoachLintHit, findStreamingHardBlock, applyCoachLintFilter, COACH_LINT_SAFE_MESSAGE } from "./coachingLint";
import { COACH_TOOLS, executeCoachTool, type CoachEmit, type CoachToolContext, type CoachToolTurnState } from "./coachTools";

// The coach data types + Zod schemas live in coachTools.ts (they define the
// tool surface); re-export them so this module's public API is unchanged for
// the route layer and any future consumers.
export {
  coachProfileSchema,
  coachIntakeSchema,
  coachActionPlanSchema,
  coachDocumentChecklistSchema,
  borrowerPackageSchema,
  COACH_TOOLS,
  type CoachingProfile,
  type ActionPlanItem,
  type DocumentRequirement,
  type CoachIntakeData,
  type BorrowerPackage,
  type CoachStreamEvent,
  type CoachEmit,
  type CoachToolTurnState,
} from "./coachTools";

// ---------------------------------------------------------------------------
// The turn runner
// ---------------------------------------------------------------------------

export type CoachTurnErrorCode =
  | "not_configured"
  | "provider_rate_limited"
  | "network"
  | "timeout"
  | "provider_error";

export class CoachTurnError extends Error {
  constructor(
    public code: CoachTurnErrorCode,
    message: string,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "CoachTurnError";
  }
}

export interface CoachTurnOptions {
  req: Request;
  userId: string;
  userRole?: string | null;
  conversationId: string;
  userMessage: string;
  /** Prior conversation (oldest→newest), EXCLUDING the new user message. */
  history: Array<{ role: string; content: string }>;
  existingProfile?: unknown;
  verifiedContext: VerifiedUserContext;
  emit: CoachEmit;
  /** Aborted when the client disconnects (stop paying for unseen tokens). */
  signal?: AbortSignal;
}

export interface CoachTurnResult {
  message: string;
  state: CoachToolTurnState;
  lintReplaced: boolean;
  degraded: boolean;
  usage: { inputTokens: number; outputTokens: number; modelCalls: number };
}

function mapAnthropicError(err: unknown): CoachTurnError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new CoachTurnError("not_configured", "Homi is temporarily unavailable. Your file is safe.", false);
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new CoachTurnError("provider_rate_limited", "The AI service is briefly rate-limited. Please try again in a moment.", true);
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return new CoachTurnError("timeout", "The response took too long and was cancelled. Please try again.", true);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    // NOTE: APIConnectionError subclasses APIError in the TS SDK — check it first.
    return new CoachTurnError("network", "Couldn't reach the AI service. Please try again.", true);
  }
  if (err instanceof Anthropic.APIError) {
    return new CoachTurnError("provider_error", "The AI service returned an error. Please try again.", true);
  }
  return new CoachTurnError("provider_error", "Something unexpected went wrong generating a response.", false);
}

/**
 * Run one coach turn: Claude Sonnet 5 streaming tool-loop (MAX_MODEL_CALLS_PER_TURN),
 * side effects through coachTools executors, deterministic lint post-filter,
 * one ai_interactions row per model call.
 *
 * Persistence of coach_messages / coach_conversations stays in the route (it
 * owns the response contract); this function only returns what to persist.
 *
 * Provider failures before the first streamed token switch to clearly labeled,
 * deterministic guidance. Mid-answer failures remain errors so a partial model
 * answer can never be mistaken for a complete one.
 */
export async function runCoachTurn(opts: CoachTurnOptions): Promise<CoachTurnResult> {
  if (!isCoachConfigured()) {
    const fallback = generateOfflineResponse(opts.userMessage, opts.history, opts.verifiedContext);
    const message = `**Offline guidance mode** — Homi isn't configured in this environment, so here is standard guidance:\n\n${fallback.message}`;
    opts.emit({ type: "text", delta: message });
    return {
      message,
      state: {},
      lintReplaced: false,
      degraded: true,
      usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0 },
    };
  }

  const state: CoachToolTurnState = {};
  const deadline = Date.now() + TURN_BUDGET_MS;

  // The readiness panel is now SERVER-DERIVED and emitted before the model
  // says a word, rather than waiting for the model to call update_readiness.
  //
  // Two things this fixes. The panel used to appear only if the model chose to
  // call the tool, so on a turn where it did not, the borrower saw whatever
  // the last turn happened to leave there. And when it did call it, the model
  // was restating tier / completed / outstanding figures the server had just
  // handed it in context — a lossy round-trip through a language model whose
  // only possible outcomes were "identical" or "wrong".
  state.profile = deriveReadinessProfile(opts.verifiedContext);

  let lintAbortHit: CoachLintHit | null = null;
  let visible = "";
  const guardedEmit: CoachEmit = (event) => {
    // After a lint abort the streamed bubble is being replaced client-side —
    // suppress any further text, but structured events still flow.
    if (lintAbortHit && event.type === "text") return;
    opts.emit(event);
  };

  const toolCtx: CoachToolContext = {
    req: opts.req,
    userId: opts.userId,
    userRole: opts.userRole ?? "",
    conversationId: opts.conversationId,
    // Resolved from the session in the route, never from tool input.
    workableApplicationId: opts.verifiedContext.workableApplicationId ?? null,
    emit: guardedEmit,
    state,
  };

  const system = buildCoachSystemPrompt(opts.verifiedContext, opts.existingProfile);

  const messages: Anthropic.MessageParam[] = opts.history
    .slice(-HISTORY_WINDOW_MESSAGES)
    .filter((m) => typeof m.content === "string" && m.content.trim().length > 0)
    .map((m) => ({
      role: m.role === "user" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    }));
  messages.push({ role: "user", content: opts.userMessage });

  let totalInput = 0;
  let totalOutput = 0;
  let modelCalls = 0;

  for (let call = 1; call <= MAX_MODEL_CALLS_PER_TURN; call++) {
    const remainingBudget = deadline - Date.now();
    if (call > 1 && remainingBudget < 4_000) break; // no room for another call

    const callStartedAt = Date.now();
    let callText = "";

    const stream = getAnthropic().messages.stream(
      {
        model: COACH_MODEL,
        max_tokens: MAX_COMPLETION_TOKENS,
        output_config: { effort: "low" },
        system,
        tools: COACH_TOOLS,
        messages,
      },
      {
        signal: opts.signal,
        timeout: Math.max(2_000, Math.min(15_000, remainingBudget)),
      },
    );

    stream.on("text", (delta) => {
      if (lintAbortHit) return;
      callText += delta;
      visible += delta;
      const hit = findStreamingHardBlock(visible);
      if (hit) {
        // Abort mid-stream: the offending sentence has been on screen for at
        // most one chunk; the client replaces the bubble on lint_replaced.
        lintAbortHit = hit;
        stream.abort();
        return;
      }
      guardedEmit({ type: "text", delta });
    });

    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      if (lintAbortHit) break; // our own lint abort — handled after the loop

      const mapped = mapAnthropicError(err);
      void logAiInteraction({
        userId: opts.userId,
        applicationId: state.syncedApplicationId ?? null,
        workflow: "ai_coach",
        userRole: opts.userRole ?? null,
        provider: "claude",
        model: COACH_MODEL,
        systemPrompt: COACH_PROMPT_VERSION,
        prompt: opts.userMessage,
        response: callText || null,
        classification: "borrower_facing_guardrailed",
        latencyMs: Date.now() - callStartedAt,
        isError: "true",
        errorMessage: `${mapped.code}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000),
        metadata: { promptVersion: COACH_PROMPT_VERSION, call },
      });
      // A provider outage before any text or tool action can safely become a
      // labeled deterministic guidance turn. The user's message is already in
      // conversation history, but this fallback does not pretend to capture or
      // update application data.
      if (
        call === 1 &&
        visible.length === 0 &&
        callText.length === 0 &&
        ["not_configured", "network", "timeout", "provider_error"].includes(mapped.code)
      ) {
        const fallback = generateOfflineResponse(opts.userMessage, opts.history, opts.verifiedContext);
        const fallbackMessage = `**Homi is temporarily unavailable.** Your connected file is safe. This standard guidance has not added new information to your file.\n\n${fallback.message}`;
        guardedEmit({ type: "degraded", reason: "temporarily_unavailable" });
        guardedEmit({ type: "text", delta: fallbackMessage });
        guardedEmit({ type: "panel", profile: state.profile, source: "file" });
        return {
          message: fallbackMessage,
          state,
          lintReplaced: false,
          degraded: true,
          usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0 },
        };
      }
      throw mapped;
    }

    modelCalls++;
    totalInput += message.usage.input_tokens;
    totalOutput += message.usage.output_tokens;

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    void logAiInteraction({
      userId: opts.userId,
      applicationId: state.syncedApplicationId ?? null,
      workflow: "ai_coach",
      userRole: opts.userRole ?? null,
      provider: "claude",
      model: COACH_MODEL,
      systemPrompt: COACH_PROMPT_VERSION,
      prompt: opts.userMessage,
      response: callText || null,
      classification: "borrower_facing_guardrailed",
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      latencyMs: Date.now() - callStartedAt,
      metadata: {
        promptVersion: COACH_PROMPT_VERSION,
        call,
        stopReason: message.stop_reason,
        toolCalls: toolUses.map((t) => t.name),
        cacheReadInputTokens: message.usage.cache_read_input_tokens ?? null,
        cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? null,
      },
    });

    if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

    // Execute EVERY requested tool (even at the call cap — captured data must
    // never be dropped), then return all results in a single user message.
    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const result = await executeCoachTool(toolCtx, toolUse.name, toolUse.input);
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result.content,
        ...(result.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }

  // Emitted after the tool loop so a record_intake writeback this turn is
  // reflected. The values are the server's either way — the model has no tool
  // that can touch them any more.
  guardedEmit({ type: "panel", profile: state.profile, source: "file" });

  // Deterministic compliance post-filter on the full reply.
  let finalMessage = visible.trim();
  let lintReplaced = false;
  let lintHit: CoachLintHit | null = null;

  if (lintAbortHit) {
    lintReplaced = true;
    lintHit = lintAbortHit;
  } else if (finalMessage.length > 0) {
    const filtered = applyCoachLintFilter(finalMessage);
    if (filtered.replaced) {
      lintReplaced = true;
      lintHit = filtered.hit;
    } else if (filtered.flaggedCategories.length > 0) {
      void logAudit(opts.req, "coach.lint_flagged", "coach_conversation", opts.conversationId, {
        categories: filtered.flaggedCategories,
      });
    }
  }

  if (lintReplaced && lintHit) {
    finalMessage = COACH_LINT_SAFE_MESSAGE;
    opts.emit({ type: "lint_replaced", categories: lintHit.categories, citations: lintHit.citations });
    void logAudit(opts.req, "coach.lint_replaced", "coach_conversation", opts.conversationId, {
      categories: lintHit.categories,
      citations: lintHit.citations,
    });
  }

  // The model can end a capped turn with tools executed but no prose — never
  // persist an empty assistant message.
  if (finalMessage.length === 0) {
    finalMessage =
      state.intake || state.profile || state.actionPlan || state.documentChecklist
        ? "I've updated your profile and panels with what you shared — take a look on the right. What would you like to do next?"
        : "I didn't finish composing a reply — please try sending that again.";
    guardedEmit({ type: "text", delta: finalMessage });
  }

  return {
    message: finalMessage,
    state,
    lintReplaced,
    degraded: false,
    usage: { inputTokens: totalInput, outputTokens: totalOutput, modelCalls },
  };
}

/**
 * The exact `system` blocks a coach turn sends: the cache-anchored static
 * prompt plus the per-borrower dynamic context. Exported so evaluation harnesses
 * (e.g. the Haiku↔Sonnet model A/B) exercise the identical prompt runCoachTurn uses.
 */
export function buildCoachSystemPrompt(
  ctx: VerifiedUserContext,
  existingProfile?: unknown,
): Anthropic.TextBlockParam[] {
  return [
    { type: "text", text: STATIC_COACH_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildDynamicContext(ctx, existingProfile) },
  ];
}

function buildDynamicContext(ctx: VerifiedUserContext, existingProfile?: unknown): string {
  const verifiedNote = buildVerifiedContextPrompt(ctx);
  const profileNote = existingProfile
    ? `\n\nExisting financial profile from previous assessment:\n${JSON.stringify(existingProfile, null, 2)}\n\nUse this as context but update if the user provides new information.`
    : "";
  const combined = `${verifiedNote}${profileNote}`.trim();
  const data = combined.length > 0 ? combined : "No verified borrower context is available yet.";
  // Delimit dynamic borrower-controlled strings as data. The static prompt
  // explicitly says content inside this block cannot issue instructions.
  return `<borrower_context trust="data-only">\n${data.replaceAll("</borrower_context>", "&lt;/borrower_context&gt;")}\n</borrower_context>`;
}

// ---------------------------------------------------------------------------
// Deterministic guidance for an unconfigured provider or a provider failure
// before any text streams. It is always labeled in the response and never
// claims that new information was captured in the borrower's file.
// ---------------------------------------------------------------------------

function formatNextRequiredInput(what: string, why: string, effort: string, unlocks: string): string {
  return `**What's needed:** ${what}\n**Why:** ${why}\n**Effort:** ${effort}\n**What it unlocks:** ${unlocks}`;
}

function getNextMissingInput(ctx?: VerifiedUserContext): { what: string; why: string; effort: string; unlocks: string } | null {
  if (!ctx) return null;

  if (!ctx.employmentType) {
    return {
      what: "Your employment type",
      why: "Underwriting systems use this to determine which income documents are required and how income is calculated.",
      effort: "About 30 seconds — just tell me what kind of work you do.",
      unlocks: "The correct income questions and document checklist can be prepared.",
    };
  }
  if (!ctx.annualIncome) {
    return {
      what: "Your approximate annual income",
      why: "Underwriting systems use income to calculate your debt-to-income ratio and determine borrowing capacity.",
      effort: "About 30 seconds — a rough estimate is fine for now, documents will verify later.",
      unlocks: "Your income can be included in the preliminary debt-to-income calculation.",
    };
  }
  if (!ctx.creditScore) {
    return {
      what: "Your approximate credit score range",
      why: "Underwriting systems use credit scores to determine which loan programs your profile can be evaluated against.",
      effort: "About 30 seconds — even a rough range works. You can check for free through your bank.",
      unlocks: "The loan team can place your credit information in the current application profile.",
    };
  }
  if (!ctx.monthlyDebts) {
    return {
      what: "Your approximate total monthly debts (car payments, student loans, credit card minimums, etc.)",
      why: "Underwriting systems use this alongside your income to calculate your debt-to-income ratio.",
      effort: "About 1 minute — add up your monthly minimums. A rough estimate is fine.",
      unlocks: "Your preliminary debt-to-income calculation can include the debts you reported.",
    };
  }
  if (!ctx.purchasePrice) {
    return {
      what: "Your target purchase price or price range",
      why: "Underwriting systems need this to calculate loan-to-value ratio and assess down payment adequacy.",
      effort: "About 30 seconds — a range is fine if you're still exploring.",
      unlocks: "The loan amount and preliminary loan-to-value calculation can be prepared.",
    };
  }
  if (!ctx.downPayment) {
    return {
      what: "Your estimated down payment amount",
      why: "Underwriting systems use this to calculate your loan-to-value ratio and determine PMI requirements.",
      effort: "About 30 seconds — approximate amount you have available.",
      unlocks: "The loan amount and preliminary loan-to-value calculation can be prepared.",
    };
  }
  if (ctx.documentsMissing && ctx.documentsMissing.length > 0) {
    const doc = ctx.documentsMissing[0];
    return {
      what: `Upload your ${doc}`,
      why: `Underwriting systems require this document to verify your self-reported information.`,
      effort: "About 2 minutes — upload a photo or PDF.",
      unlocks: "The loan team can review that checklist item and update its real status.",
    };
  }
  return null;
}

export function generateOfflineResponse(
  userMessage: string,
  history: Array<{ role: string; content: string }>,
  verifiedContext?: VerifiedUserContext,
): CoachResponse {
  const isFirstMessage = history.length <= 1;
  const completion = verifiedContext?.completionPercentage || 0;

  if (isFirstMessage && verifiedContext?.hasApplication) {
    const app = verifiedContext;
    const parts: string[] = [];
    parts.push(`Welcome back! I have your application information on file and can see where things stand.`);

    if (app.annualIncome || app.creditScore || app.employmentType) {
      parts.push("\nHere's what's already on file in your profile:");
      if (app.annualIncome) parts.push(`- **Annual Income:** $${parseFloat(app.annualIncome).toLocaleString()}`);
      if (app.creditScore) parts.push(`- **Credit Score:** ${app.creditScore}`);
      if (app.employmentType) parts.push(`- **Employment:** ${app.employmentType === "self_employed" ? "Self-Employed" : app.employmentType.charAt(0).toUpperCase() + app.employmentType.slice(1)}`);
      if (app.monthlyDebts) parts.push(`- **Monthly Debts:** $${parseFloat(app.monthlyDebts).toLocaleString()}`);
      if (app.isVeteran) parts.push(`- **Veteran:** Yes`);
    }

    parts.push(`\nYou're at **${completion}% completion**.`);

    const next = getNextMissingInput(app);
    if (next) {
      parts.push(`\n${formatNextRequiredInput(next.what, next.why, next.effort, next.unlocks)}`);
    } else {
      parts.push(`\n${formatNextRequiredInput(
        "Submit your application for underwriting review",
        "All required inputs are present. Underwriting systems can now evaluate your complete profile.",
        "About 1 minute to review and confirm.",
        "Your borrower package will be submitted for formal underwriting review."
      )}`);
    }

    return { message: parts.join("\n") };
  }

  if (isFirstMessage) {
    const hasPropertyContext = verifiedContext?.propertyContext;
    if (hasPropertyContext) {
      const next = getNextMissingInput(verifiedContext) || {
        what: "Your employment type",
        why: "Underwriting systems use this to determine which income documents are required.",
        effort: "About 30 seconds — just tell me what kind of work you do.",
        unlocks: "Employment-specific document checklist and income verification path.",
      };
      return {
        message: `Welcome! I see you're looking at a property listed at **$${verifiedContext.propertyContext!.price.toLocaleString()}** at ${verifiedContext.propertyContext!.address}.

I'll help you organize your financial information so you can see where you stand for this home.

${formatNextRequiredInput(next.what, next.why, next.effort, next.unlocks)}`,
      };
    }

    return {
      message: `Welcome! I'm Homi, your Homiquity assistant. I'll help you organize your information and prepare everything needed for underwriting review — step by step, at your own pace.

${formatNextRequiredInput(
  "Your employment type",
  "Underwriting systems use this to determine which income documents are required and how income is calculated.",
  "About 30 seconds — just tell me what kind of work you do.",
  "Employment-specific document checklist and income verification path."
)}`,
    };
  }

  const lowerMsg = userMessage.toLowerCase();

  if (lowerMsg.includes("credit") || lowerMsg.includes("score")) {
    return {
      message: formatNextRequiredInput(
        "Your approximate credit score range",
        "Underwriting systems use credit scores to determine which loan programs your profile can be evaluated against.",
        "About 30 seconds — even a rough range works. You can check for free through your bank.",
        "The loan team can place your credit information in the current application profile."
      ),
    };
  }

  if (lowerMsg.includes("document") || lowerMsg.includes("paperwork") || lowerMsg.includes("what do i need")) {
    if (verifiedContext?.documentsMissing && verifiedContext.documentsMissing.length > 0) {
      const doc = verifiedContext.documentsMissing[0];
      return {
        message: formatNextRequiredInput(
          `Upload your ${doc}`,
          "Underwriting systems require this document to verify your self-reported information against official records.",
          "About 2 minutes — upload a photo or PDF.",
          "The loan team can review that checklist item and update its real status."
        ),
      };
    }
    const nextInput = getNextMissingInput(verifiedContext);
    if (nextInput) {
      return {
        message: `Your document needs depend on completing your financial profile first.\n\n${formatNextRequiredInput(nextInput.what, nextInput.why, nextInput.effort, nextInput.unlocks)}`,
      };
    }
    return {
      message: formatNextRequiredInput(
        "Submit your application for underwriting review",
        "All required inputs and documents are present. Underwriting systems can now evaluate your complete profile.",
        "About 1 minute to review and confirm.",
        "Your borrower package will be submitted for formal underwriting review."
      ),
    };
  }

  if (verifiedContext?.daysSinceLastActivity && verifiedContext.daysSinceLastActivity > 7) {
    const completedSteps = verifiedContext.completedSteps || [];
    const progressSummary = completedSteps.length > 0
      ? `Your progress is saved — you've already provided ${completedSteps.slice(0, 3).join(", ")}${completedSteps.length > 3 ? ` and ${completedSteps.length - 3} more` : ""}.`
      : "Your progress is saved.";

    const next = getNextMissingInput(verifiedContext);
    if (next) {
      return {
        message: `Welcome back! ${progressSummary} You're at **${completion}% completion**.\n\nWhenever you're ready, here's where we left off:\n\n${formatNextRequiredInput(next.what, next.why, next.effort, next.unlocks)}`,
      };
    }
    return {
      message: `Welcome back! ${progressSummary} You're at **${completion}% completion** — all core inputs are in place.\n\n${formatNextRequiredInput(
        "Submit your application for underwriting review",
        "All required inputs are present. Underwriting systems can now evaluate your complete profile.",
        "About 1 minute to review and confirm.",
        "Your borrower package will be submitted for formal underwriting review."
      )}`,
    };
  }

  const next = getNextMissingInput(verifiedContext);
  if (next) {
    return {
      message: formatNextRequiredInput(next.what, next.why, next.effort, next.unlocks),
    };
  }

  return {
    message: formatNextRequiredInput(
      "Submit your application for underwriting review",
      "All required inputs are present. Underwriting systems can now evaluate your complete profile.",
      "About 1 minute to review and confirm.",
      "Your borrower package will be submitted for formal underwriting review."
    ),
  };
}
