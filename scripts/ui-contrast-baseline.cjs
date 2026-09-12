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
 * action colour to black and removes dark chrome. Removing dark grounds
 * eliminates the only two contrast-legal uses of `--flare` as text (5.65:1 on
 * #0B1E19 and 4.59:1 on the sidebar #17302A); on white it is 3.06:1, a fail.
 * This is the net that catches that.
 *
 * WHAT IT DOES NOT DO — and what you therefore may not claim from it
 * It measures **contrast only**, plus whatever the browser reports as a console
 * error or a failed request while the page loads. It is NOT an accessibility
 * audit: it does not check roles, names, focus order, keyboard operation, ARIA,
 * headings or landmarks. Those need axe-core, which is a dependency, and
 * `routines/CHARTER.md` §6 bars new dependencies without a founder decision.
 * Saying "accessibility verified" on the strength of this is the exact kind of
 * claim §10 forbids. Say "AA contrast measured on N public routes".
 *
 * It also sees only what renders without signing in. Authenticated staff
 * screens are not covered.
 *
 * NO NEW DEPENDENCY. Chromium is already on disk (Playwright's cache, which
 * `browser-probe.cjs` already relies on) and Node ships a WebSocket client, so
 * the DevTools Protocol is reachable with `node` and nothing else. The browser
 * discovery below is deliberately duplicated from `browser-probe.cjs` rather
 * than shared: that file is named in CHARTER §10 as the evidence standard, and
 * refactoring it to save 60 lines risks the one tool routines depend on.
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
    "  Run where a browser already exists. Do NOT install one — CHARTER §6."
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
      for (const fn of listeners.get(msg.method) || []) fn(msg.params);
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
  const bgOf = (el) => {
    let node = el, acc = null;
    while (node && node !== document.documentElement.parentNode) {
      const s = getComputedStyle(node);
      const c = parse(s.backgroundColor);
      // A background image can be anything; refuse to guess rather than pass it.
      if (s.backgroundImage && s.backgroundImage !== "none") return { colour: null, image: true };
      if (c && c.a > 0) { acc = acc ? over(acc, c) : c; if (acc.a >= 0.999) return { colour: acc, image: false }; }
      node = node.parentElement;
    }
    return { colour: acc || { r: 255, g: 255, b: 255, a: 1 }, image: false };
  };
  const selector = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean).slice(0, 3).map((c) => "." + c).join("");
    return (el.tagName.toLowerCase() + id + cls).slice(0, 80);
  };
  const out = new Map();
  for (const el of document.querySelectorAll("body *")) {
    const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(" ").trim();
    if (!text) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || +s.opacity === 0) continue;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const fg = parse(s.color);
    if (!fg || fg.a === 0) continue;
    const bg = bgOf(el);
    if (bg.image || !bg.colour) continue;
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
  return Array.from(out.values());
})()`;

/**
 * Poll until the page has actually painted text. A fixed sleep is the wrong
 * tool: when it under-waits the audit measures an empty document, finds
 * nothing, and the ratchet reports every previously-recorded finding on that
 * page as FIXED — silently deleting coverage on the next --update.
 */
async function waitForPaint(cdp, sessionId, deadlineMs = 15000) {
  const started = Date.now();
  let stable = 0, lastCount = -1;
  while (Date.now() - started < deadlineMs) {
    const res = await cdp.send("Runtime.evaluate", {
      expression: "document.readyState + '|' + document.querySelectorAll('body *').length",
      returnByValue: true,
    }, sessionId).catch(() => null);
    const [state, countRaw] = String(res?.result?.value ?? "|0").split("|");
    const count = Number(countRaw) || 0;
    if (state === "complete" && count > 0) {
      // Two consecutive equal counts means the client has settled.
      if (count === lastCount && ++stable >= 2) return true;
      if (count !== lastCount) stable = 0;
      lastCount = count;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return lastCount > 0;
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
  cdp.on("Network.loadingFailed", (p) => {
    if (!cursor || p.sessionId !== cursor.sessionId || p.canceled) return;
    add({ route: cursor.route, viewport: cursor.viewport, kind: "request", id: p.type || "request", detail: `${p.type}: ${p.errorText}` });
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
        const painted = await waitForPaint(cdp, sessionId);
        if (!painted) throw new Error(`${route.path} (${viewport.name}) rendered no body content within ${TIMEOUT_MS}ms`);

        const res = await cdp.send("Runtime.evaluate", {
          expression: CONTRAST_AUDIT, returnByValue: true, awaitPromise: false,
        }, sessionId);
        if (res.exceptionDetails) throw new Error(`${route.path}: ${res.exceptionDetails.text}`);
        for (const v of res.result.value || []) {
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
      findings,
    }, null, 2) + "\n");
    console.log(`Recorded ${findings.length} finding(s) from ${checked} page load(s) to tests/ui/contrast-baseline.json`);
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
  console.log(`PASS  ${routes.length} route(s) x ${VIEWPORTS.length} viewport(s) = ${checked} load(s); ${findings.length} recorded finding(s), 0 new.`);
  console.log("Measured: AA text contrast, console errors, failed requests. NOT an accessibility audit (no axe).");
})().catch((error) => {
  console.error(`ui-contrast-baseline: ${error.message}`);
  process.exit(1);
});
