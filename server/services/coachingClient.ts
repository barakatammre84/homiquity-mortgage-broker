// The lazily-built Anthropic client singleton + configuration gate + model constants. LEAF module: no coaching sibling imports.
// Split from the old server/services/coachingService.ts — which re-exports it.
import Anthropic from "@anthropic-ai/sdk";

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

// Lazily constructed: the SDK client is built on first use, and this module is
// imported by the route registry — an eager client here would make boot depend
// on AI credentials. (The old OpenAI client THREW at construction with no key
// and took down every API route in production; the Anthropic SDK defers key
// validation to the first request, but we keep the lazy pattern and the
// isCoachConfigured() gate so the coach degrades to labeled offline guidance
// instead of erroring per-request.)
let anthropicClient: Anthropic | null = null;
export function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 15_000, // ms — per model call; the turn has its own 25s wall-clock budget
      maxRetries: 1,
    });
  }
  return anthropicClient;
}

export function isCoachConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export const COACH_MODEL = "claude-sonnet-5";
/**
 * Versioned prompt marker (AI_GOVERNANCE_POLICY §5.5). Stored on every
 * ai_interactions row instead of the full prompt text — the exact prompt is
 * reconstructable from git at this version. Bump on ANY prompt/tool change.
 */
export const COACH_PROMPT_VERSION = "homi-2.7.0";

/**
 * Raised 2 → 4 on 2026-08-19, when the server-truth read tools landed.
 *
 * 2 was sized for a coach with no read tools. With them, a "where does my
 * application stand?" turn genuinely needs more, and the sequence is stable
 * across trials:
 *
 *     get_loan_status → get_document_checklist → suggest_next_steps → (text)
 *
 * — four calls, because the prompt asks for suggest_next_steps on EVERY turn
 * and a tool call cannot share a message with the closing prose.
 *
 * At 2 the turn ended mid-chain with tools executed and no reply, and the
 * empty-reply guard served "I didn't finish composing a reply" to a borrower
 * asking where their loan stood. Measured, not guessed: at 2 calls the model
 * emitted zero text in 12/12 trials across effort low/medium/high; at 4 it
 * answered every time, grounded in the tool figures (962-1236 chars).
 *
 * `tool_choice: {type:"none"}` on the final call was tried first and rejected
 * — it returns an EMPTY message rather than forcing prose (4/4 empty at effort
 * low, still 2/4 at high). Blocking the model mid-plan makes it give up, not
 * summarize. The budget was the real constraint.
 *
 * Cost is bounded by the cache: the ~19.6k-token tools+system prefix is a
 * cache READ on every call after the first (0.1x), so extra calls cost output
 * tokens, not a re-read of the prompt.
 */
export const MAX_MODEL_CALLS_PER_TURN = 4;
// Product turn budget, not a platform ceiling (the persistent host has none):
// bounds a runaway multi-tool turn so a wedged upstream stream cannot pin a
// coach turn open indefinitely, while leaving room for every model call plus
// tool round-trips to finish instead of truncating mid-answer. At 4 calls with
// a 15s per-call ceiling the worst case is 60s, inside this budget.
export const TURN_BUDGET_MS = 90_000;
export const MAX_COMPLETION_TOKENS = 2_048;
export const HISTORY_WINDOW_MESSAGES = 24; // ≈12 exchanges resent per turn
