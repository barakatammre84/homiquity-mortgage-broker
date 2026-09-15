#!/usr/bin/env node
/**
 * Fixture pages for scripts/ui-contrast-baseline.cjs.
 *
 * WHY THIS EXISTS
 * The harness measures a live renderer, so its own defects only show up against
 * a page built to expose them. Two shipped defects were found this way (Codex
 * review of b242ed16, 2026-09-13) and both are reproduced here so the fix stays
 * checkable:
 *
 *   opacity       A 16px black paragraph at `opacity: 0.1` on white. The audit
 *                 skipped only `opacity: 0`, never folding a partial value into
 *                 the rendered colour, so near-invisible text scored 21:1 and
 *                 PASSED. It now scores ~1.25:1 and FAILS. The backdrop is
 *                 outside the faded group here, so this case is exactly
 *                 measurable and must stay a finding, not become "unmeasured".
 *   faded-own-bg  A faded paragraph painting its own background. Unmeasurable.
 *   faded-parent  A faded DIV painting black, with unfaded white child text.
 *                 Renders ~4.0:1 — a FAIL — but the child's own background is
 *                 transparent, so an own-background-only check missed it and the
 *                 audit composited against the parent's UNFADED black for 21:1.
 *                 Now counted as unmeasurable. (Second Codex review, 0956da9a.)
 *   http-error    The page fetches an endpoint answering HTTP 500. The harness
 *                 listened only to `Network.loadingFailed`, which covers
 *                 transport failure — a 500 is a *successful* transport — so it
 *                 printed PASS while claiming to measure "failed requests".
 *   public-403    A PUBLIC endpoint answering 403. The first fix exempted every
 *                 401/403 by status alone, which swallowed this real defect.
 *                 Must be a finding.
 *   auth-401      `/api/auth/user` answering 401 — the signed-out probe the app
 *                 makes on every page. Must NOT be a finding.
 *   opaque        Control. #eeeeee on white: a real failure the audit always
 *                 caught. Proves a run measured something rather than nothing.
 *   clean         Control. Opaque black on white, no bad requests. Must PASS —
 *                 proves the fixes above do not fire spuriously.
 *
 * Every path returns the same page, so the harness can drive all the routes in
 * tests/ui/contrast-routes.json against it.
 *
 *   node tests/ui/fixtures/contrast-harness-fixture.cjs opacity 5025 &
 *   node scripts/ui-contrast-baseline.cjs --base http://localhost:5025 --timeout 4000
 *
 * Expect new findings (non-zero exit) for `opacity`, `opaque`, `http-error` and
 * `public-403`; expect PASS for `clean` and `auth-401`; expect PASS with a
 * non-zero `unmeasurable` count for `faded-own-bg` and `faded-parent`. Run
 * without `--update` — these fixtures must never reach the real baseline.
 *
 * There is deliberately no vitest wrapper: this needs a real browser, and this
 * repository has no browser test lane. Adding one is a separate change.
 */
const http = require("http");

const MODE = process.argv[2];
const PORT = Number(process.argv[3] || 5025);
const PLAIN = '<p style="color:black">Readable test text</p>';
const MODES = {
  opacity: '<p style="color:black;opacity:0.1">Readable test text</p>',
  "faded-own-bg": '<p style="color:white;background:black;opacity:0.5">Readable test text</p>',
  "faded-parent": '<div style="opacity:0.5;background:black;padding:30px">'
    + '<p style="color:white">Readable test text</p></div>',
  opaque: '<p style="color:#eeeeee">Readable test text</p>',
  "http-error": PLAIN,
  "public-403": PLAIN,
  "auth-401": PLAIN,
  clean: PLAIN,
};

// Endpoint each mode's page fetches, and the status the server answers with.
const FETCHES = {
  "http-error": { path: "/failed-data", status: 500 },
  "public-403": { path: "/api/faqs", status: 403 },
  "auth-401": { path: "/api/auth/user", status: 401 },
};

const sample = MODES[MODE];
if (!sample) {
  console.error(`usage: ${process.argv[1]} <${Object.keys(MODES).join("|")}> [port]`);
  process.exit(1);
}

// `--primary` must resolve and a stylesheet must be attached, or the harness
// refuses to measure the page at all (its own false-clean guard).
const page = `<!doctype html><html><head><style>
  :root { --primary: 165 45% 8%; }
  body { background:#fff; color:#000; font-size:16px; }
</style></head><body>
${Array.from({ length: 12 }, (_, i) => `<p style="color:black">Opaque paragraph ${i + 1}</p>`).join("\n")}
${sample}
${FETCHES[MODE] ? `<script>fetch('${FETCHES[MODE].path}').then((r) => r.text())</script>` : ""}
</body></html>`;

const FETCH = FETCHES[MODE];
http.createServer((req, res) => {
  if (FETCH && req.url === FETCH.path) {
    res.writeHead(FETCH.status, { "Content-Type": "text/plain" });
    return res.end("fixture");
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(page);
}).listen(PORT, () => console.error(`contrast fixture [${MODE}] on http://localhost:${PORT}`));
