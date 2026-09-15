#!/usr/bin/env node
/**
 * Citation ratchet guard (zero-dep).
 *
 * Living documentation tells a reader where to look. When the code moves and the
 * prose does not, the doc keeps pointing — confidently — at nothing. The
 * 2026-08-18 sweep that produced this guard found the shape everywhere: a
 * security threat model listing `server/routes/borrower.ts` among its
 * "highest-risk code areas" months after that file became a directory, L1 and L2
 * citing each other by pre-rename filenames, and a routine skill written that
 * same day citing a design doc archived four hours earlier.
 *
 * This looks INSIDE a document: it counts backticked repo-ish paths in living docs
 * that resolve to nothing. It was the inner half of a pair — `kb-index-guard.cjs`
 * proved every KB doc was indexed and every INDEX link resolved — but that guard was
 * retired in #811 and nothing replaced it, so the outer half is now unchecked: a KB
 * doc missing from the index is invisible to CI.
 *
 *   node scripts/citation-guard.cjs          # ratchet check (CI / checkup)
 *   node scripts/citation-guard.cjs --list   # every unresolved reference, with line numbers
 *
 * ---------------------------------------------------------------------------
 * WHY A RATCHET AND NOT A HARD ZERO — this was measured, not assumed.
 *
 * The first pass flagged 53 unresolved references and the obvious move was to
 * "fix all 53". Reading them showed roughly two thirds were CORRECT as written,
 * and fixing them would have destroyed true content:
 *
 *   - `package-lock.json` in TEAM_PRACTICES — inside the rule "Never resurrect
 *     `package-lock.json`". The file must NOT exist; that is the point.
 *   - `vercel.json` in the app guide — inside "Vercel is likewise gone: …".
 *     A record of a deletion.
 *   - `PascalCase.tsx`, `useCamelCase.ts` in the playbook — naming CONVENTIONS,
 *     not files.
 *   - `migrations/NNNN_short_name.sql` — a template placeholder.
 *   - `server/services/homeLoanApplicantNotice.ts` in a spec's "Implementation
 *     sketch (build at F3)" — a proposal. The file is supposed to be absent.
 *   - `tests/loanDeliveryReadiness.test.ts` in FINDINGS — the ABSENCE is the
 *     finding.
 *
 * Two heuristics were tried to separate "go read this" from "this is gone /
 * planned / an example" — an absence-marker regex on the line, then on a
 * paragraph window. Both leaked in both directions: a long line let one
 * `was removed` clear four unrelated stale pointers beside it, and a proposal
 * whose marker sat three lines up got flagged. Precision topped out near 50–65%,
 * and a guard that cries wolf half the time is one people learn to skip —
 * `doc-staleness-guard.cjs`'s own header names that failure ("a noisy denylist
 * converts this guard into boilerplate").
 *
 * So the classification is left to the ratchet, exactly as the doc-staleness
 * guard leaves documented history to its baseline: the legitimate references sit
 * in the baseline, and any NEW unresolved reference pushes the count up and goes
 * red. Run with --list to triage; drive it down when a genuine one appears.
 * ---------------------------------------------------------------------------
 *
 * WHAT IT CANNOT SEE: prompts that live outside the repo. The CCR scheduled
 * triggers each carry paths in their prompt text, and three of them shipped
 * citing documents that did not exist. No CI job can reach those — the defence
 * there is the failsafe each routine carries ("if what you were told to read is
 * absent, say so and STOP") plus a periodic `list_triggers` audit.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BASELINE_FILE = path.join(__dirname, "citation-baseline.json");
const LIST = process.argv.includes("--list");

/**
 * Dated, immutable history — never scanned. A deleted file named in a dated
 * record is correct history, not rot (TEAM_PRACTICES §2). Same carve-out the
 * doc-staleness guard makes, for the same reason.
 */
const EXCLUDED = [
  /^knowledge-base\/archive\//,
  /^knowledge-base\/logs\//,
  /^knowledge-base\/routines\/reports\//,
  /^knowledge-base\/runbooks\/CHANGE_LEDGER\.md$/,
  /^knowledge-base\/research\/better-teardown\/better-teardown-raw-notes\.md$/,
  // Vendored third-party craft skills. Their internal references point at their
  // own bundled layouts, which we neither author nor maintain.
  /^\.agents\//,
];

/**
 * References that can never resolve through `git ls-files` and are not errors:
 * build output is gitignored by design, so `dist/index.js` is a correct citation
 * of an artifact that exists only after `pnpm build`.
 */
const NOT_TRACKED_BY_DESIGN = [
  /^dist\//,
  /^node_modules\//,
  /^\.git\//,
  // The Selling Guide's generated content layer: gitignored by design (public
  // repo, copyrighted work — see docs/fannie-mae/selling-guide/README.md), so a
  // citation of extracted/ or linked/ artifacts is correct the way dist/ is:
  // it names something `python3 scripts/extract-selling-guide.py` materializes.
  /^(?:docs\/fannie-mae\/selling-guide\/)?(?:extracted|linked)\//,
  // …and its two whole-book streams, for the same reason. Named EXACTLY, never as a
  // glob over that directory: README.md and INDEX.md live there too and are tracked,
  // so a wildcard would stop catching real dead links in the corpus's own front door.
  // (selling-guide-text.txt escapes this list only because PATHISH does not know .txt.)
  /^(?:docs\/fannie-mae\/selling-guide\/)?selling-guide\.md$/,
];

/** Backticked tokens that look like a repo path: a known code/doc extension. */
const PATHISH = /`([A-Za-z0-9_@.\-/]+\.(?:ts|tsx|js|jsx|cjs|mjs|json|md|css|sql|sh|yml|yaml))`/g;

/**
 * Documents the register marks `history`: immutable dated records, excluded from ordinary
 * searches by design. Their pointers are statements about a past state, so a reference to a
 * document retired or deleted later is correct history, not rot — exactly the carve-out EXCLUDED
 * above makes by hand, driven off the register instead of a path list that has to be maintained.
 * Editing these to satisfy a link checker would falsify the record they exist to preserve.
 */
const REGISTER_FILE = path.join(ROOT, "knowledge-base/document-register.json");
const HISTORY = new Set(
  fs.existsSync(REGISTER_FILE)
    ? (JSON.parse(fs.readFileSync(REGISTER_FILE, "utf8")).documents || [])
        .filter((r) => r.disposition === "history")
        .map((r) => r.path)
    : [],
);

const files = execSync("git ls-files '*.md'", { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !EXCLUDED.some((re) => re.test(f)))
  .filter((f) => !HISTORY.has(f));

/** Every basename in the repo, so a doc may name `emailService.ts` without a path. */
const basenames = new Set(
  execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((f) => path.basename(f)),
);
const tracked = new Set(execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));

function resolves(ref, fromFile) {
  if (NOT_TRACKED_BY_DESIGN.some((re) => re.test(ref))) return true;
  if (tracked.has(ref)) return true;
  const rel = path.posix.join(path.posix.dirname(fromFile), ref);
  if (tracked.has(path.posix.normalize(rel))) return true;
  if (basenames.has(path.basename(ref))) return true;
  return fs.existsSync(path.join(ROOT, ref));
}

const hits = [];
for (const file of files) {
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(PATHISH)) {
      if (!resolves(m[1], file)) hits.push({ file, line: i + 1, ref: m[1], text: line.trim().slice(0, 120) });
    }
  });
}

if (LIST) {
  const byRef = new Map();
  for (const h of hits) {
    if (!byRef.has(h.ref)) byRef.set(h.ref, []);
    byRef.get(h.ref).push(h);
  }
  for (const [ref, list] of [...byRef.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n== ${ref}  (${list.length}) ==`);
    for (const h of list) console.log(`   ${h.file}:${h.line}\n     ${h.text}`);
  }
  console.log(`\n${hits.length} unresolved reference(s) across ${byRef.size} distinct target(s).`);
  process.exit(0);
}

const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) : {};
const base = typeof baseline.unresolvedCitations === "number" ? baseline.unresolvedCitations : null;

if (base === null) {
  fs.writeFileSync(
    BASELINE_FILE,
    JSON.stringify({ unresolvedCitations: hits.length, updated: new Date().toISOString().slice(0, 10) }, null, 2) + "\n",
  );
  console.log(`citation-guard: bootstrapped baseline at ${hits.length}.`);
  process.exit(0);
}

if (hits.length > base) {
  console.error(`\nFAIL  citation-guard: unresolved references rose ${base} -> ${hits.length} (+${hits.length - base}).`);
  console.error("      A living doc points at a path that does not exist. Either fix the pointer,");
  console.error("      or — if the file is deliberately absent (deleted, planned, an example) — say so");
  console.error("      in the sentence, which is what makes it readable rather than merely tolerated.");
  console.error("      Run `node scripts/citation-guard.cjs --list` for every reference and its line.\n");
  const byFile = new Map();
  for (const h of hits) byFile.set(h.file, (byFile.get(h.file) || 0) + 1);
  for (const [f, n] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.error(`        ${String(n).padStart(3)}  ${f}`);
  }
  process.exit(1);
}

if (hits.length < base) {
  fs.writeFileSync(
    BASELINE_FILE,
    JSON.stringify({ unresolvedCitations: hits.length, updated: new Date().toISOString().slice(0, 10) }, null, 2) + "\n",
  );
  console.log(`citation-guard: ratcheted down ${base} -> ${hits.length}. Baseline tightened (commit it). ✅`);
  process.exit(0);
}

console.log(`citation-guard: ${hits.length} unresolved reference(s) (at baseline, no regression). ✅`);
