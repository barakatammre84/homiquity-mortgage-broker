#!/usr/bin/env node
/**
 * SessionStart hook — shared instructions and pinned corpus availability.
 *
 * AGENTS.md supplies the shared task process and routes source questions. At the start of a Claude
 * Code session (local and web) it verifies the tracked fact layer is coherent and the
 * extracted content layer is materialized, materializing it when it can (~3s — the
 * PDF recovers from this repo's own git history, no network). What it prints lands in
 * the session's context, so a broken or missing corpus greets the session as a loud
 * directive instead of being discovered mid-answer.
 *
 * THE HOOK INFORMS; THE CI GATE BLOCKS. This script always exits 0 — a session that
 * cannot materialize the corpus must still be able to open, because the session that
 * fixes the corpus is such a session. The merge-blocking enforcement lives in ci.yml's
 * three corpus steps; the hook's job is that no session does Guide-governed work
 * unaware. Registered in .claude/settings.json (SessionStart only — that file
 * deliberately carries no permissions: the untracked per-machine
 * settings.local.json permission layer must keep working unshadowed).
 *
 * Budget: coherent-and-present checkout ~milliseconds; absent content with pymupdf
 * installed ~3s; missing pymupdf, one bounded install attempt (60s cap), then extract;
 * anything else prints the directive and gets out of the session's way.
 *
 * WHY --no-markdown. The corpus has two renderings (README "What lives here"): the text
 * layer, ~3s, and the markdown layer, ~2 more MINUTES, which is the one to READ because
 * it keeps the Guide's tables intact. Building markdown here would put two minutes on the
 * front of every fresh session, so the hook materializes the fast layer and NAMES the one
 * command for the other. Readiness is still defined by the text layer alone: a session
 * that can locate and quote policy is ready; markdown makes the tables legible, and its
 * absence is a line of advice, never a directive.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, "..");
const DIR = path.join(ROOT, "docs", "fannie-mae", "selling-guide");

/**
 * Does the PDF actually recover from THIS checkout's history? In a full clone it does,
 * which is what the recovery path is built on. A cloud/web session is a SHALLOW clone
 * (~87 commits), and the PDF was committed and removed in 2026-08, far outside that
 * window — so the blob is simply not there, `git cat-file` fails, and "no network
 * needed" sends the session to re-run a command that cannot work. CI already handles
 * this with `fetch-depth: 0` (ci.yml); sessions are where it was unhandled.
 */
function shallowCheckout() {
  try {
    const r = run("git", ["rev-parse", "--is-shallow-repository"], 5000);
    return r.status === 0 && (r.stdout || "").trim() === "true";
  } catch {
    return false;
  }
}

/**
 * The directive a session reads when the corpus is not ready. `reason` may be several
 * lines — the extractor's diagnosis usually is — and every line is indented into place.
 * `opts.shallow` is for tests and for callers that already know; otherwise it is asked
 * of the checkout, because the recovery step differs and the wrong one wastes a session.
 */
function directive(reason, opts) {
  const shallow =
    opts && typeof opts.shallow === "boolean" ? opts.shallow : shallowCheckout();
  const recovery = shallow
    ? [
        "   This clone is SHALLOW — the PDF is not in its history. Recover the history",
        "   first (network, ~3s), then extract:",
        "       git fetch --unshallow --no-tags origin main",
        "       pip3 install pymupdf && python3 scripts/extract-selling-guide.py",
      ]
    : [
        "       pip3 install pymupdf && python3 scripts/extract-selling-guide.py",
        "   The PDF recovers from this repo's own git history — no network needed.",
      ];
  return [
    "⛔ SELLING GUIDE CORPUS-FIRST — the corpus is not ready in this checkout.",
    ...String(reason).split("\n").map((line) => `   ${line}`),
    "   Fix before any Guide-governed work (underwriting, income, eligibility,",
    "   delivery, pricing policy):",
    ...recovery,
    "   Do NOT answer a Fannie policy question from memory in the meantime; a",
    "   missing source is an honest gap (AGENTS.md and the primary-source map).",
  ].join("\n");
}

const MAX_REASON_LINES = 12;
const MAX_REASON_CHARS = 900;

/**
 * The reason slot, filled from a failed extractor run.
 *
 * This used to be `.split("\n").pop()`. The extractor's own failures are multi-line and
 * they close with the standing "do not answer from memory" warning, so on the one failure
 * a fresh clone actually hits — no PDF — the last line diagnoses nothing and the lines
 * naming the missing blob and `git fetch --unshallow` were the ones discarded. Keep the
 * diagnosis, drop the trailing warning the directive already carries, and bound it so a
 * runaway stderr cannot flood the session's context.
 */
function failureReason(result) {
  const stderr = ((result && result.stderr) || "").trim();
  const stdout = ((result && result.stdout) || "").trim();
  const lines = (stderr || stdout)
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "");
  while (lines.length && /^do not answer/i.test(lines[lines.length - 1].trim())) lines.pop();
  if (!lines.length) return "extractor failed";
  const kept = lines.slice(0, MAX_REASON_LINES);
  if (kept.length < lines.length) {
    kept.push(`… +${lines.length - kept.length} more line(s) — re-run the command below to see them.`);
  }
  return kept.join("\n").slice(0, MAX_REASON_CHARS);
}

function run(cmd, args, timeoutMs) {
  return spawnSync(cmd, args, { cwd: ROOT, timeout: timeoutMs, encoding: "utf8" });
}

function contentPresent(guard) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
    const want = manifest.structure && manifest.structure.leaf_sections;
    const sectionsDir = path.join(DIR, "extracted", "sections");
    if (!want || !fs.existsSync(sectionsDir)) return false;
    if (!fs.existsSync(path.join(DIR, "selling-guide-text.txt"))) return false;
    return fs.readdirSync(sectionsDir).filter((f) => f.endsWith(".txt")).length === want;
  } catch {
    return false;
  }
}

function pythonHasPymupdf() {
  const r = run("python3", ["-c", "import pymupdf"], 15000);
  return r.status === 0;
}

function extract() {
  return run(
    "python3",
    [path.join(ROOT, "scripts", "extract-selling-guide.py"), "--no-markdown"],
    180000,
  );
}

/** Is the readable (markdown) rendering built too? Advisory only — see the header. */
function markdownPresent() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
    const want = manifest.structure && manifest.structure.leaf_sections;
    const mdDir = path.join(DIR, "extracted", "markdown");
    if (!want || !fs.existsSync(mdDir)) return false;
    if (!fs.existsSync(path.join(DIR, "selling-guide.md"))) return false;
    return fs.readdirSync(mdDir).filter((f) => f.endsWith(".md")).length === want;
  } catch {
    return false;
  }
}

const MD_ADVICE =
  "  Markdown rendering not built — the text layer flattens the Guide's TABLES, where " +
  "most thresholds live.\n  Build it once (~2 min): pip3 install pymupdf4llm && " +
  "python3 scripts/extract-selling-guide.py --markdown";

function main() {
  console.log("Homiquity: read AGENTS.md and only the task-specific sources it identifies. Old charters, agent memory and routine reports are not authority. The pinned corpus must still be checked for applicable amendments.");
  const instructions = require("./source-instructions-guard.cjs").run(ROOT);
  if (instructions.errors.length) console.log("Instruction audit needs attention: " + instructions.errors.join("; "));

  let guard;
  try {
    guard = require("./selling-guide-corpus-guard.cjs");
  } catch (e) {
    console.log(directive(`corpus guard unloadable: ${e.message}`));
    return;
  }

  let checks;
  try {
    checks = guard.runChecks();
  } catch (e) {
    console.log(directive(`corpus guard threw: ${e.message}`));
    return;
  }
  if (checks.inert) {
    // Corpus not on this branch at all — nothing to verify, nothing to demand.
    console.log("selling-guide corpus: not present on this branch (guard INERT).");
    return;
  }
  if (checks.errors.length) {
    console.log(directive(`tracked fact layer incoherent: ${checks.errors[0]}` +
      (checks.errors.length > 1 ? ` (+${checks.errors.length - 1} more — run pnpm guard:corpus)` : "")));
    return;
  }

  if (contentPresent(guard)) {
    const md = markdownPresent();
    console.log(
      `selling-guide corpus: ready — edition ${checks.facts.edition}, ` +
        `${checks.facts.sections} sections extracted${md ? " in both renderings" : " (text only)"}, ` +
        `fact layer coherent. Guide-governed work starts at ` +
        `docs/fannie-mae/selling-guide/ (corpus-first` +
        (md ? "; read extracted/markdown/<ID>.md — tables intact).": ")."),
    );
    if (!md) console.log(MD_ADVICE);
    return;
  }

  // Content layer absent (fresh clone) — materialize it if this machine can.
  if (!pythonHasPymupdf()) {
    let pin = "";
    try {
      pin = guard.parseExtractorConstants(path.join(ROOT, "scripts", "extract-selling-guide.py")).PYMUPDF_PINNED;
    } catch {
      /* directive below still stands without the pin */
    }
    const spec = pin ? `pymupdf==${pin}` : "pymupdf";
    // One bounded attempt, two flag shapes: PEP 668 machines need
    // --break-system-packages for a --user install; older pips reject the flag.
    let installed = false;
    for (const args of [
      ["-m", "pip", "install", "--user", "--break-system-packages", "-q", spec],
      ["-m", "pip", "install", "--user", "-q", spec],
    ]) {
      const r = run("python3", args, 60000);
      if (r.status === 0) {
        installed = true;
        break;
      }
    }
    if (!installed || !pythonHasPymupdf()) {
      console.log(directive("extracted content absent and pymupdf could not be installed here (60s budget)"));
      return;
    }
  }

  const r = extract();
  if (r.status === 0 && contentPresent(guard)) {
    const summary = (r.stdout || "").trim().split("\n")[0] || "";
    console.log(
      `selling-guide corpus: materialized for this session — ${summary}\n` +
        `Fact layer coherent (edition ${checks.facts.edition}). Corpus-first: Guide-governed ` +
        `work starts at docs/fannie-mae/selling-guide/.`,
    );
    if (!markdownPresent()) console.log(MD_ADVICE);
  } else {
    console.log(directive(`extraction failed:\n${failureReason(r)}`));
  }
}

module.exports = { directive, failureReason, shallowCheckout };

// Exported above for tests; the session-start behavior below runs only when this file is
// the entry point, exactly as .claude/settings.json invokes it.
if (require.main === module) {
  try {
    main();
  } catch (e) {
    // Never block a session — the loudest acceptable failure is a printed directive.
    console.log(directive(`hook error: ${e.message}`));
  }
  process.exit(0);
}
