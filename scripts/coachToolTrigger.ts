import "dotenv/config"; // standalone process: load .env like the dev server does
import Anthropic from "@anthropic-ai/sdk";
import {
  COACH_TOOLS,
  buildCoachSystemPrompt,
  COACH_MODEL,
} from "../server/services/coachingService";
import {
  TOOL_TRIGGER_SAMPLES,
  type ToolTriggerSample,
} from "../tests/fixtures/coachToolTriggerSamples";

/**
 * Does the model actually CALL the server-truth tools — and stay inside what
 * they return?
 *
 * tests/homiFileTruth.test.ts proves those tools return the right data. No
 * unit test can prove the model invokes them, and a tool the model never
 * invokes is, from the borrower's seat, identical to a tool that does not
 * exist. The failure mode is silent and confident: the assistant answers from
 * memory exactly as it did before, and sounds just as certain.
 *
 * So this runs the EXACT production prompt (buildCoachSystemPrompt) and the
 * EXACT tool set (COACH_TOOLS) against fixture turns, and scores four
 * properties — trigger, restraint, grounding, honest gap. See the fixture
 * file's header for why each one is separately necessary.
 *
 * Tool calls are CAPTURED, never executed: canned tool_result content goes
 * back in place of a real load, so the script needs no database, writes
 * nothing, and can safely run against any environment.
 *
 * Run:  pnpm coach:tools
 *       pnpm coach:tools -- --model=claude-haiku-4-5 --verbose
 *
 * Needs a live ANTHROPIC_API_KEY. It is a developer check, not a CI gate:
 * model behaviour is not deterministic, so a red result is a prompt bug to
 * investigate, not a build to block.
 */

// Imported rather than duplicated: a harness that drifts from production
// stops being evidence about production.
import { MAX_MODEL_CALLS_PER_TURN, MAX_COMPLETION_TOKENS } from "../server/services/coachingClient";
const PER_CALL_TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
};
const MODEL = flag("--model") ?? COACH_MODEL;
const VERBOSE = args.includes("--verbose");
const ONLY = flag("--only"); // run a single fixture by id while debugging
const SUPPORTS_EFFORT = !MODEL.includes("haiku"); // Haiku 4.5 400s on output_config.effort

const apiKey = process.env.ANTHROPIC_API_KEY || process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(
    "\nNo ANTHROPIC_API_KEY.\n\n" +
      "This check exists precisely because the offline path cannot exercise tool\n" +
      "calling — without a key the coach returns a canned reply and never invokes\n" +
      "a tool, so running this would prove nothing.\n\n" +
      "Add one to .env (the key already exists in Railway production) and re-run.\n",
  );
  process.exit(1);
}
const client = new Anthropic({ apiKey });

interface Outcome {
  sample: ToolTriggerSample;
  toolsCalled: string[];
  reply: string;
  failures: string[];
  error?: string;
  /** Per-call stop reasons — the first thing to look at when a reply is empty. */
  stopReasons: string[];
}

async function runSample(sample: ToolTriggerSample): Promise<Outcome> {
  const system = buildCoachSystemPrompt(sample.verifiedContext);
  const messages: Anthropic.MessageParam[] = (sample.history ?? []).map((m) => ({
    role: m.role === "user" ? ("user" as const) : ("assistant" as const),
    content: m.content,
  }));
  messages.push({ role: "user", content: sample.userMessage });

  const toolsCalled: string[] = [];
  const stopReasons: string[] = [];
  let reply = "";

  try {
    for (let call = 1; call <= MAX_MODEL_CALLS_PER_TURN; call++) {
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: MODEL,
        max_tokens: MAX_COMPLETION_TOKENS,
        system,
        tools: COACH_TOOLS,
        messages,
      };
      if (SUPPORTS_EFFORT) params.output_config = { effort: "low" };

      const message = await client.messages.create(params, { timeout: PER_CALL_TIMEOUT_MS });
      stopReasons.push(message.stop_reason ?? "null");

      for (const block of message.content) {
        if (block.type === "text") reply += block.text;
      }
      const toolUses = message.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      toolsCalled.push(...toolUses.map((t) => t.name));

      if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

      // Capture-only. Read tools get the fixture's canned result (or a neutral
      // stand-in); write tools get a plausible success so the loop continues
      // naturally without any side effect.
      messages.push({ role: "assistant", content: message.content });
      messages.push({
        role: "user",
        content: toolUses.map((t): Anthropic.ToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: t.id,
          content:
            sample.toolResult && sample.expectTools?.includes(t.name)
              ? sample.toolResult
              : JSON.stringify({ ok: true }),
        })),
      });
    }
  } catch (err) {
    return {
      sample,
      toolsCalled,
      reply,
      failures: [],
      stopReasons,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const failures: string[] = [];
  const lower = reply.toLowerCase();

  for (const tool of sample.expectTools ?? []) {
    if (!toolsCalled.includes(tool)) failures.push(`never called ${tool}`);
  }
  for (const tool of sample.forbidTools ?? []) {
    if (toolsCalled.includes(tool)) failures.push(`called ${tool} on a general question`);
  }
  for (const needle of sample.mustMention ?? []) {
    if (!lower.includes(needle.toLowerCase())) failures.push(`reply omits "${needle}" from the tool result`);
  }
  for (const needle of sample.mustNotMention ?? []) {
    if (lower.includes(needle.toLowerCase())) failures.push(`reply contains "${needle}"`);
  }
  if (sample.mustAdmit && !sample.mustAdmit.some((a) => lower.includes(a.toLowerCase()))) {
    failures.push("reply does not admit the file was unreadable — it answered anyway");
  }

  return { sample, toolsCalled, reply, failures, stopReasons };
}

async function main() {
  console.log(`\ncoach tool-trigger check — model ${MODEL}${ONLY ? ` — only ${ONLY}` : `, ${TOOL_TRIGGER_SAMPLES.length} turns`}\n`);

  const outcomes: Outcome[] = [];
  const selected = ONLY
    ? TOOL_TRIGGER_SAMPLES.filter((s) => s.id === ONLY)
    : TOOL_TRIGGER_SAMPLES;
  for (const sample of selected) {
    const outcome = await runSample(sample);
    outcomes.push(outcome);
    const mark = outcome.error ? "ERR " : outcome.failures.length === 0 ? "PASS" : "FAIL";
    console.log(
      `  ${mark}  [${sample.property}] ${sample.id}` +
        (outcome.toolsCalled.length ? `  → ${outcome.toolsCalled.join(", ")}` : "  → (no tools)"),
    );
    for (const f of outcome.failures) console.log(`         · ${f}`);
    if (outcome.error) console.log(`         · ${outcome.error}`);
    if (VERBOSE) {
      console.log(`         stop_reasons: ${outcome.stopReasons.join(" → ") || "(none)"}`);
      console.log(
        `         reply (${outcome.reply.length} chars): ${
          outcome.reply.replace(/\s+/g, " ").slice(0, 1_200) || "(EMPTY)"
        }`,
      );
    }
  }

  console.log("\n  by property");
  for (const property of ["trigger", "restraint", "grounding", "honest_gap", "prompt_injection"] as const) {
    const group = outcomes.filter((o) => o.sample.property === property);
    if (group.length === 0) continue;
    const passed = group.filter((o) => !o.error && o.failures.length === 0).length;
    console.log(`    ${property.padEnd(12)} ${passed}/${group.length}`);
  }

  const failed = outcomes.filter((o) => o.error || o.failures.length > 0);
  console.log(`\n  ${outcomes.length - failed.length}/${outcomes.length} turns clean\n`);
  // Non-zero on failure so it is usable in a script chain, while staying out of
  // CI (model behaviour is not deterministic enough to gate a build on).
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
