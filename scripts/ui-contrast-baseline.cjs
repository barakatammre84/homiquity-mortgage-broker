#!/usr/bin/env node
/**
 * UI contrast baseline — measure WCAG AA text contrast in a real renderer, with
 * zero dependencies, and ratchet the result.
 *
 * WHY THIS EXISTS
 * `handbook/design/DESIGN_SYSTEM.md` declares WCAG AA binding and publishes a
 * `--flare` contrast table to two decimal places. Nothing verified any of it.
 * The two tools that come closest say so in their own headers: `guard:ui` is a
 * text scan with no layout engine, and `browser-probe.cjs` states plainly that
 * "it does not measure contrast ratios, it is not an accessibility audit".
 * So a token change could silently push text below 4.5:1 on every public page
 * and every check in this repo would stay green.
 *
 * That matters right now: the 2026-09-12 design decision moves the primary
 * action colour to black and turns the sidebar and footer white. That rewrites
 * the foreground/background pair under every piece of text on a public page at
 * once, which is precisely the change no existing check here would notice.
 * This is the net under it.
 *
 * (An earlier version of this header claimed the restyle would eliminate the
 * only contrast-legal uses of `--flare` as text. That was wrong and is
 * withdrawn: prose uses `--flare-ink` #AD4000 at 15 call sites, and raw
 * `--flare` appears as text in exactly two non-prose places — the logo mark,
 * which WCAG 1.4.3 exempts, and one aria-hidden decorative SVG.)
 *
 * WHAT IT DOES NOT DO — and what you therefore may not claim from it
 * It measures **contrast only**, plus whatever the browser reports as a console
 * error or a failed request while the page loads. It is NOT an accessibility
 * audit: it does not check roles, names, focus order, keyboard operation, ARIA,
 * headings or landmarks. Those need axe-core, and AGENTS.md says to use the
 * existing dependencies unless the user authorizes a change.
 * AGENTS.md also states the standard this tool is held to: "a static guard is
 * not proof of behavior, accessibility, source meaning or legal compliance."
 * So do not say "accessibility verified" on the strength of this run. Say
 * "AA contrast measured on N public routes".
 *
 * It also sees only what renders WITHOUT SIGNING IN, and that gap has already
 * cost something real: this harness reported a clean restyle while the Homi
 * launcher's icon was invisible on every authenticated screen, because the
 * launcher only exists behind a login. A private surface is not covered here
 * and must be checked in a real signed-in browser.
 *
 * NO NEW DEPENDENCY. Chromium is already on disk (Playwright's cache, which
 * `browser-probe.cjs` already relies on) and Node ships a WebSocket client, so
 * the DevTools Protocol is reachable with `node` and nothing else. The browser
 * discovery below is deliberately duplicated from `browser-probe.cjs` rather
 * than shared: `browser-probe.cjs` is the existing browser-evidence tool other
 * routines depend on, and refactoring it to save 60 lines risks all of them.
 *
 *   pnpm ui:contrast                 # verify against the recorded baseline
 *   pnpm ui:contrast --update        # re-record after a deliberate change
 *   node scripts/ui-contrast-baseline.cjs --base http://localhost:5002
 *
 * Exit 1 on: no browser, no server, or any finding not already recorded.
 */
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const BASE = (arg("base", process.env.UI_BASELINE_BASE || "http://localhost:5001")).replace(/\/$/, "");
const UPDATE = argv.includes("--update");
const TIMEOUT_MS = Number(arg("timeout", "30000"));
const ROUTES_FILE = path.join(__dirname, "..", "tests", "ui", "contrast-routes.json");
const BASELINE_FILE = path.join(__dirname, "..", "tests", "ui", "contrast-baseline.json");

// Endpoint + status pairs that are correct behaviour on a signed-out public
// page, so they must not be reported as failures. Exact paths only: an
// unexpected 401/403 anywhere else is a finding.
//
//   /api/auth/user 401 — the client asks this on every page to find out whether
//   anyone is signed in (client/src/hooks/useAuth.ts). 401 IS the answer when
//   nobody is. This harness never signs in, so it happens on every load.
const EXPECTED_RESPONSES = [
  { path: "/api/auth/user", status: 401 },
];

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

// ------------------------------------------------------------ find chrome ---
function findChrome() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.platform === "darwin" && path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ].filter(Boolean);
  const rels = [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
    "chrome-headless-shell-linux64/chrome-headless-shell",
    "chrome-linux/headless_shell",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-linux/chrome",
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith("chromium")).sort().reverse();
    for (const rel of rels) for (const dir of dirs) {
      const p = path.join(root, dir, rel);
      if (fs.existsSync(p)) return p;
    }
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      const p = execSync(`command -v ${name}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (p) return p;
    } catch { /* not installed */ }
  }
  for (const app of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]) if (fs.existsSync(app)) return app;
  return null;
}

const CHROME = findChrome();
if (!CHROME) {
  // Absence is an error, never a silent pass — a run that found no browser has
  // verified nothing and must not be reported as green.
  console.error(
    "ui-contrast-baseline: no Chromium found. Looked at $CHROMIUM_PATH, $PLAYWRIGHT_BROWSERS_PATH,\n" +
    "  the default Playwright caches, PATH, and the macOS app bundles.\n" +
    "  Run where a browser already exists. Do NOT install one: AGENTS.md says to use\n" +
    "  the existing dependencies unless the user authorizes a change."
  );
  process.exit(1);
}

// -------------------------------------------------------------------- CDP ---
function launch() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-contrast-"));
  const child = spawn(CHROME, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`,
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--hide-scrollbars",
    "--no-first-run", "--disable-extensions", "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`browser did not report a DevTools endpoint in 15s:\n${stderr}`)), 15000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const m = /ws:\/\/[^\s]+/.exec(stderr);
      if (m) { clearTimeout(timer); resolve({ child, wsUrl: m[0], userDataDir }); }
    });
    child.on("exit", (code) => reject(new Error(`browser exited early (${code}):\n${stderr}`)));
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      // In flattened target mode CDP puts sessionId at the TOP level of the
      // message, not inside params. Dropping it here silently broke every
      // per-session check downstream: load events never matched, so each page
      // burned the full navigation timeout, and console errors and failed
      // requests were attributed to nothing and never recorded at all.
      const params = msg.sessionId ? { ...msg.params, sessionId: msg.sessionId } : msg.params;
      for (const fn of listeners.get(msg.method) || []) fn(params);
    }
  });
  return {
    ready: new Promise((res, rej) => {
      ws.addEventListener("open", () => res());
      ws.addEventListener("error", () => rej(new Error("could not open the DevTools WebSocket")));
    }),
    send(method, params = {}, sessionId) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    close: () => ws.close(),
  };
}

// ------------------------------------------------- in-page contrast audit ---
/**
 * Runs inside the page as one expression. Walks every element holding its own
 * visible text, resolves the effective background by climbing ancestors through
 * transparent layers, and applies the WCAG 2.1 relative-luminance formula.
 *
 * Threshold per WCAG 1.4.3: 3:1 for large text (>=24px, or >=18.66px bold),
 * 4.5:1 otherwise. Elements are grouped by the colour pair and the CSS selector
 * so one bad token reports once per surface, not once per node.
 */
const CONTRAST_AUDIT = `(() => {
  const parse = (c) => {
    const m = /rgba?\\(([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,\\s/]+([\\d.]+))?\\)/.exec(c);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  // Resolves the backdrop by climbing until something opaque is found, and
  // reports whether a partial \`opacity\` sits anywhere between the text and that
  // backdrop — because if one does, the number here is not what renders.
  //
  // Why this is refused rather than computed. Opacity fades a group AS A UNIT,
  // so text and any background painted INSIDE the same group fade together and
  // then blend with whatever is outside it. For
  // \`<div style="opacity:.5;background:black"><p style="color:white">\` on a white
  // body, the text pixel stays 255 (white over black, then half-blended with
  // white) while the backdrop becomes 127.5 — about 4.0:1, a FAIL. Reading the
  // parent's black at full strength scores it 21:1 and passes.
  //
  // The tempting fix — multiply each background layer's alpha by the opacity
  // product above it — is WRONG, and worth naming so nobody re-derives it: it
  // fades the text against the already-composited backdrop and returns 191 for
  // a pixel that renders 255. Getting this exactly right means compositing each
  // opacity group internally and recursing outward. A measurement tool that
  // reports a plausible wrong number is worse than one that admits a gap, so
  // these are counted as unmeasured and excluded from the clean result.
  // A faded group is only unmeasurable when a background is painted INSIDE it.
  // Fading with the backdrop OUTSIDE the group is exact: the text alpha carries
  // the opacity and composites over an unfaded colour, which is how a bare
  // \`<p style="opacity:.1">\` on a white body correctly scores 1.25:1.
  //
  // Climbing from the text upward, a node's opacity fades that node and
  // everything already passed (its subtree). So the measurement is refused when
  // a node with opacity < 1 either paints a background itself, or sits above a
  // background already accumulated from its descendants.
  const bgOf = (el) => {
    let node = el, acc = null;
    while (node && node !== document.documentElement.parentNode) {
      const s = getComputedStyle(node);
      const o = parseFloat(s.opacity);
      const c = parse(s.backgroundColor);
      const contributes = !!(c && c.a > 0);
      if (!Number.isNaN(o) && o < 1 && (contributes || acc)) {
        return { colour: null, image: false, faded: true };
      }
      // A background image can be anything; refuse to guess rather than pass it.
      if (s.backgroundImage && s.backgroundImage !== "none") return { colour: null, image: true, faded: false };
      if (contributes) { acc = acc ? over(acc, c) : c; if (acc.a >= 0.999) return { colour: acc, image: false, faded: false }; }
      node = node.parentElement;
    }
    return { colour: acc || { r: 255, g: 255, b: 255, a: 1 }, image: false, faded: false };
  };
  // CSS \`opacity\` fades an element and its whole subtree against what is behind
  // it, and it COMPOUNDS down the ancestor chain. Reading only the element's own
  // colour therefore measures a value the user never sees: black text at
  // opacity 0.1 on white renders as near-white and was scored 21:1 — a clean
  // pass on text nobody can read. Only \`opacity: 0\` was skipped; every partial
  // value was treated as fully opaque.
  const effectiveOpacity = (el) => {
    let node = el, acc = 1;
    while (node && node.nodeType === 1) {
      const o = parseFloat(getComputedStyle(node).opacity);
      if (!Number.isNaN(o)) acc *= o;
      if (acc === 0) return 0;
      node = node.parentElement;
    }
    return acc;
  };
  const selector = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean).slice(0, 3).map((c) => "." + c).join("");
    return (el.tagName.toLowerCase() + id + cls).slice(0, 80);
  };
  const out = new Map();
  let examined = 0;
  let unmeasured = 0;
  for (const el of document.querySelectorAll("body *")) {
    const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    if (!text) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const op = effectiveOpacity(el);
    if (op === 0) continue;
    const fg0 = parse(s.color);
    if (!fg0 || fg0.a === 0) continue;
    // Fold the cumulative opacity into the text's alpha so the ratio is computed
    // from what actually reaches the screen.
    const fg = { ...fg0, a: fg0.a * op };
    if (fg.a === 0) continue;
    const bg = bgOf(el);
    // Checked BEFORE the null-colour guard below: a faded group returns no
    // colour, so testing it second would drop these on the floor uncounted.
    if (bg.faded) { unmeasured += 1; continue; }
    if (bg.image || !bg.colour) continue;
    examined += 1;
    const size = parseFloat(s.fontSize);
    const weight = parseInt(s.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(over(fg, bg.colour), bg.colour);
    if (got >= need) continue;
    const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    const key = selector(el) + "|" + hex(fg) + "|" + hex(bg.colour) + "|" + Math.round(size);
    if (out.has(key)) { out.get(key).nodes += 1; continue; }
    out.set(key, {
      selector: selector(el), fg: hex(fg), bg: hex(bg.colour),
      size: Math.round(size * 10) / 10, weight, large,
      ratio: Math.round(got * 100) / 100, need, nodes: 1,
      sample: text.slice(0, 40),
    });
  }
  return { examined, unmeasured, findings: Array.from(out.values()) };
})()`;

/**
 * Poll until the page is genuinely ready to be measured.
 *
 * "Has content" is not enough. An early version settled on a stable element
 * count and measured a document holding two elements — the toast container,
 * mounted before the app. Every page came back with zero contrast findings and
 * the run reported clean. A contrast harness that measures an unstyled document
 * does not under-report; it reports the opposite of the truth.
 *
 * So readiness is defined by the design tokens being live: a stylesheet
 * attached, `--primary` resolving on the root, and a body with real content.
 * If those never arrive we throw, because a page we could not style is a page
 * we did not measure.
 */
async function waitForReady(cdp, sessionId, deadlineMs) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < deadlineMs) {
    const res = await cdp.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        sheets: document.styleSheets.length,
        token: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
        nodes: document.querySelectorAll('body *').length,
        state: document.readyState
      })`,
      returnByValue: true,
    }, sessionId).catch(() => null);
    try { last = JSON.parse(res?.result?.value ?? "{}"); } catch { last = null; }
    if (last && last.state === "complete" && last.sheets > 0 && last.token && last.nodes > 10) {
      // Let late layout settle now that the tokens are demonstrably applied.
      await new Promise((r) => setTimeout(r, 600));
      return last;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const seen = last ? `stylesheets=${last.sheets} --primary="${last.token}" bodyNodes=${last.nodes} readyState=${last.state}` : "no response from the page";
  throw new Error(`not ready to measure after ${deadlineMs}ms — ${seen}. ` +
    `A page whose design tokens never loaded cannot be measured for contrast; refusing to record a false clean.`);
}

// ------------------------------------------------------------------- run ---
(async () => {
  const routes = JSON.parse(fs.readFileSync(ROUTES_FILE, "utf8")).routes;
  const findings = [];
  const add = (f) => {
    const k = (x) => `${x.viewport}|${x.kind}|${x.route}|${x.id}`;
    if (!findings.some((x) => k(x) === k(f))) findings.push(f);
  };

  const { child, wsUrl, userDataDir } = await launch();
  const cdp = connect(wsUrl);
  await cdp.ready;
  let checked = 0;
  let examinedTotal = 0;
  let unmeasuredTotal = 0;

  // One listener each, dispatching through a mutable cursor. Registering inside
  // the per-route loop leaked a handler per page and made attribution depend on
  // listener order.
  let cursor = null;
  const loadWaiters = new Map();
  cdp.on("Page.loadEventFired", (p) => {
    const w = loadWaiters.get(p.sessionId);
    if (w) { loadWaiters.delete(p.sessionId); w(); }
  });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (!cursor || p.sessionId !== cursor.sessionId || p.type !== "error") return;
    const text = (p.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 120);
    if (text) add({ route: cursor.route, viewport: cursor.viewport, kind: "console", id: text.slice(0, 80), detail: text });
  });
  // Third-party hosts are deliberately excluded. A blocked CDN or font host is
  // a property of wherever this runs — it differs between a laptop, this
  // container and CI — so recording it makes the baseline drift for reasons
  // that have nothing to do with the product. We record failures of our own
  // origin, which is the only thing a change here can break.
  const requestUrls = new Map();
  cdp.on("Network.requestWillBeSent", (p) => {
    if (p.requestId && p.request && p.request.url) requestUrls.set(p.requestId, p.request.url);
  });
  cdp.on("Network.loadingFailed", (p) => {
    if (!cursor || p.sessionId !== cursor.sessionId || p.canceled) return;
    const url = requestUrls.get(p.requestId) || "";
    if (url && !url.startsWith(BASE)) return;
    const where = url ? new URL(url).pathname : (p.type || "request");
    add({ route: cursor.route, viewport: cursor.viewport, kind: "request", id: `${p.type || "request"} ${where}`, detail: `${p.type}: ${p.errorText} (${where})` });
  });
  // `Network.loadingFailed` fires only when the TRANSPORT fails — DNS, refused
  // connection, abort. An HTTP 500 is a perfectly successful transport, so the
  // page could fetch a route that answered 500 on every load and this harness
  // printed PASS while its own summary line claimed it measured "failed
  // requests". A successful transport is not a successful response.
  cdp.on("Network.responseReceived", (p) => {
    if (!cursor || p.sessionId !== cursor.sessionId || !p.response) return;
    const url = p.response.url || "";
    if (!url.startsWith(BASE)) return;          // same-origin only, as above
    const status = p.response.status;
    if (!status || status < 400) return;
    const where = new URL(url).pathname;
    // EXPECTED, by exact endpoint AND status — never by status alone.
    //
    // A blanket 401/403 exemption was the first attempt, justified by the
    // signed-out auth probe. It also silently swallowed a 403 on any PUBLIC
    // endpoint, which is a real defect this tool exists to surface. Scope the
    // exemption to the request that actually expects the status.
    //
    // A 404 on a Document is the app's own not-found route: a product decision.
    //
    // Everything else counts. A 5xx is always a finding: a page that renders
    // beautifully while its data call returns 500 is broken, and the transport
    // succeeded so `Network.loadingFailed` never fires.
    if (EXPECTED_RESPONSES.some((e) => e.path === where && e.status === status)) return;
    if (p.type === "Document" && status === 404) return;
    add({
      route: cursor.route, viewport: cursor.viewport, kind: "request",
      id: `HTTP ${status} ${where}`,
      detail: `HTTP ${status} ${p.response.statusText || ""} on ${p.type || "request"} ${where}`.trim(),
    });
  });
  const waitForLoad = (sessionId) => new Promise((resolve) => {
    const t = setTimeout(() => { loadWaiters.delete(sessionId); resolve(); }, TIMEOUT_MS);
    loadWaiters.set(sessionId, () => { clearTimeout(t); resolve(); });
  });

  try {
    for (const viewport of VIEWPORTS) {
      for (const route of routes) {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Network.enable", {}, sessionId);
        await cdp.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.width, height: viewport.height, deviceScaleFactor: 1,
          mobile: viewport.width <= 480,
        }, sessionId);

        cursor = { route: route.path, viewport: viewport.name, sessionId };
        await cdp.send("Page.navigate", { url: `${BASE}${route.path}` }, sessionId);
        await waitForLoad(sessionId);
        // The client renders after load. Poll for real content rather than
        // sleeping a fixed interval: a fixed sleep measured an empty document
        // on a slow load and then reported every finding on that page as FIXED,
        // which is the one failure mode a ratchet must never have.
        try {
          await waitForReady(cdp, sessionId, TIMEOUT_MS);
        } catch (e) {
          throw new Error(`${route.path} (${viewport.name}): ${e.message}`);
        }

        const res = await cdp.send("Runtime.evaluate", {
          expression: CONTRAST_AUDIT, returnByValue: true, awaitPromise: false,
        }, sessionId);
        if (res.exceptionDetails) throw new Error(`${route.path}: ${res.exceptionDetails.text}`);
        const audit = res.result.value || { examined: 0, unmeasured: 0, findings: [] };
        // Coverage is reported alongside the verdict, always. "0 findings" and
        // "looked at nothing" are indistinguishable without it, and this
        // harness has already produced the second while reporting the first.
        if (audit.examined === 0) throw new Error(`${route.path} (${viewport.name}): the audit examined 0 text elements — refusing to record a clean result from an empty measurement`);
        examinedTotal += audit.examined;
        unmeasuredTotal += audit.unmeasured || 0;
        for (const v of audit.findings) {
          add({
            route: route.path, viewport: viewport.name, kind: "contrast",
            id: `${v.selector}|${v.fg}on${v.bg}`,
            detail: `${v.ratio}:1 needs ${v.need}:1 — ${v.fg} on ${v.bg} at ${v.size}px/${v.weight}${v.large ? " (large)" : ""}; ${v.nodes} node${v.nodes === 1 ? "" : "s"}; "${v.sample}"`,
          });
        }
        checked += 1;
        await cdp.send("Target.closeTarget", { targetId });
      }
    }
  } finally {
    cdp.close();
    child.kill();
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  const key = (f) => `${f.viewport}|${f.kind}|${f.route}|${f.id}`;
  findings.sort((a, b) => key(a).localeCompare(key(b)));

  if (UPDATE) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({
      $comment: "Recorded UI contrast findings. A finding here does not fail the run; a new one does. " +
        "Each needs an owner and a target before it counts as accepted — recording is not fixing. " +
        "Re-record with pnpm ui:contrast --update after a deliberate change, and delete entries as they are fixed.",
      recorded: new Date().toISOString().slice(0, 10),
      base: BASE,
      routes: routes.length,
      textElementsExamined: examinedTotal,
      textElementsUnmeasured: unmeasuredTotal,
      findings,
    }, null, 2) + "\n");
    console.log(`Recorded ${findings.length} finding(s) from ${checked} page load(s), ${examinedTotal} text element(s) examined` + (unmeasuredTotal ? `, ${unmeasuredTotal} skipped as unmeasurable (faded element with its own background).` : "."));
    return;
  }

  if (!fs.existsSync(BASELINE_FILE)) {
    console.error("ui-contrast-baseline: no baseline recorded. Create one with: pnpm ui:contrast --update");
    process.exitCode = 1;
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  const recorded = new Set(baseline.findings.map(key));
  const current = new Set(findings.map(key));
  const added = findings.filter((f) => !recorded.has(key(f)));
  const fixed = baseline.findings.filter((f) => !current.has(key(f)));

  for (const f of fixed) console.log(`FIXED  ${f.viewport} ${f.route} [${f.kind}] ${f.id} — remove it with pnpm ui:contrast --update`);
  if (added.length) {
    console.error(`\nui:contrast FAILED with ${added.length} new finding(s):`);
    for (const f of added) console.error(`  ${f.viewport} ${f.route} [${f.kind}] ${f.detail}`);
    console.error("\nFix them, or record them deliberately with pnpm ui:contrast --update.");
    process.exitCode = 1;
    return;
  }
  console.log(`PASS  ${routes.length} route(s) x ${VIEWPORTS.length} viewport(s) = ${checked} load(s); ${examinedTotal} text element(s) examined` + (unmeasuredTotal ? `, ${unmeasuredTotal} unmeasurable` : "") + `; ${findings.length} recorded finding(s), 0 new.`);
  console.log("Measured: AA text contrast (opacity composited), console errors, failed requests and HTTP >=400 responses, same-origin only.");
  console.log("NOT measured: roles, names, focus order, keyboard, ARIA, landmarks — and nothing behind a login. Not an accessibility audit.");
})().catch((error) => {
  console.error(`ui-contrast-baseline: ${error.message}`);
  process.exit(1);
});
