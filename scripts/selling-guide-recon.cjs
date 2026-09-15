#!/usr/bin/env node
/**
 * ONE-OFF reconnaissance probe of the live Selling Guide site.
 *
 * ⚠️ THIS SCRIPT IS DISPOSABLE. It exists to answer a fixed list of questions ONCE,
 * from a network that can actually reach Fannie Mae, and then to be deleted or folded
 * into scripts/selling-guide-watch.cjs. It is not a monitor: no state, no signals, no
 * schedule, no diffing. If you are reading this months from now and it is still here,
 * that is the bug.
 *
 * WHY IT EXISTS. The corpus is a snapshot of one PDF (edition 08-05-2026) while the
 * live HTML edition is amended between editions, so the corpus can go stale silently.
 * A watcher for that already exists and is well built — and has never observed
 * anything, because the only place it runs is a Claude session in an environment whose
 * egress gateway refuses the host. Measured 2026-08-24 across four independent tools,
 * each with a working control in the same session:
 *
 *     curl                       CONNECT … 403 Forbidden      (pypi.org 200)
 *     node fetch (the watcher)   all 4 sources unreachable
 *     WebFetch                   EGRESS_BLOCKED
 *     headless Chromium          ERR_TUNNEL_CONNECTION_FAILED (pypi.org 200)
 *
 * So nobody here has ever seen this site, and every markup-dependent decision in a
 * monitoring design — is there an effective date on the page, what is the content
 * container, do the derived /sel/{id}/{slug} URLs even resolve — is a guess. This
 * script goes and looks, from a GitHub runner, before any of that is designed.
 *
 * WHAT IT WILL NOT DO:
 *   - It does not spoof a browser User-Agent. If Fannie declines automated access,
 *     that is an answer we act on, not one we evade.
 *   - It fetches robots.txt FIRST and obeys it. A disallowed path is not fetched.
 *   - It makes 8 requests, once, by hand. Nothing recurring.
 *   - It writes nothing into the repo. Guide HTML is the same copyrighted work the
 *     corpus is careful about; bodies go to a temp dir and leave as a build artifact.
 *
 * Exit codes mirror scripts/selling-guide-watch.cjs, whose conventions this borrows:
 *   0 = every target observed
 *   3 = incomplete — at least one target unreachable, denied, or robots-disallowed
 *   1 = the script itself failed
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.RECON_OUT || path.join(os.tmpdir(), "sg-recon");
const TIMEOUT_MS = 45000;
/** Serial, with a pause between requests. Eight URLs is not a crawl; keep it that way. */
const REQUEST_GAP_MS = 1500;

/**
 * Honest and identifying. A maintainer at Fannie Mae reading their access log should be
 * able to tell exactly who this is and why, and block it deliberately if they want to.
 */
const UA =
  "HomiquityCorpusRecon/1.0 (+https://github.com/barakatammre84/homiquity; " +
  "one-off Selling Guide corpus freshness probe; contact via repo issues)";

const SG = "https://selling-guide.fanniemae.com";
const SF = "https://singlefamily.fanniemae.com";

/**
 * The fixed list. Each entry says what QUESTION it answers, because an artifact nobody
 * can interpret is the same as no artifact.
 */
const TARGETS = [
  {
    id: "robots-selling-guide",
    url: `${SG}/robots.txt`,
    kind: "robots",
    why: "Q2 — does the HTML edition permit what we intend? Fetched first; governs the rest.",
  },
  {
    id: "robots-singlefamily",
    url: `${SF}/robots.txt`,
    kind: "robots",
    why: "Q2 — same, for the announcements/PDF host.",
  },
  {
    id: "landing",
    probe: /selling\s+guide/i,
    url: `${SG}/`,
    kind: "page",
    why: "Q5/Q7 — page shape and whether the shell is server-rendered.",
  },
  {
    id: "part-b",
    probe: /origination\s+through\s+closing/i,
    url: `${SG}/sel/b/origination-through-closing`,
    kind: "page",
    why: "Q3 — the Part-level URL the existing watcher already targets.",
  },
  {
    id: "section-b3-6-05",
    probe: /monthly\s+debt\s+obligations/i,
    url: `${SG}/sel/b3-6-05/monthly-debt-obligations`,
    kind: "page",
    why:
      "Q3/Q4/Q5 — THE key probe. links.json DERIVES this URL from the section id and slug " +
      "and has never verified it resolves. Also where we find out whether a section page " +
      "carries its effective date (the corpus says 08/05/2026 for this one).",
  },
  {
    id: "section-b2-2-03",
    probe: /financed\s+propert/i,
    url: `${SG}/sel/b2-2-03/multiple-financed-properties-for-the-same-borrower`,
    kind: "page",
    why:
      "Q5 — deliberately the borderless financed-property limits table, the case the text " +
      "rendering destroyed and the markdown one restored. How does the HTML express it?",
  },
  {
    id: "announcements",
    probe: /announcement\s+sel-\d{4}-\d{2}/i,
    url: `${SF}/selling-servicing-guide-communications`,
    kind: "page",
    why: "Q4 — announcements index; the most stable amendment signal if it is parseable.",
  },
  {
    id: "pdf-endpoint",
    url: `${SF}/media/document/pdf/selling-guide`,
    kind: "pdf",
    why: "Q8 — has the published PDF already moved past our pinned edition?",
  },
];

/**
 * A COMPLETED FETCH IS NOT AN OBSERVATION. Borrowed verbatim from the sibling watcher,
 * and re-earned the hard way: the first draft of this script reported `OK … HTTP 403`
 * for all six URLs, exited 0 ("every target observed"), and — worse — hashed a
 * 114-byte proxy denial page against the pinned edition sha and announced "DIFFERENT —
 * a new edition or amendment is published". A wrong answer delivered confidently is
 * the failure mode this whole corpus exists to avoid, so classification is by status
 * and body, never by "the promise resolved".
 */
const DENIED_STATUSES = new Set([401, 403, 429, 451]);
const MISSING_STATUSES = new Set([404, 410]);

function classify(status) {
  if (status >= 200 && status < 300) return "observed";
  if (DENIED_STATUSES.has(status)) return "denied";
  if (MISSING_STATUSES.has(status)) return "missing";
  return "unusable";
}

/** Response headers worth capturing. ETag/Last-Modified are the point — see Q6. */
const HEADERS_OF_INTEREST = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "cache-control",
  "date",
  "server",
  "x-robots-tag",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Minimal robots.txt evaluation: longest matching rule wins, Allow beats Disallow at
 * equal length (the de-facto standard). Deliberately conservative — an unparseable
 * robots.txt is treated as "do not fetch", never as "no rules found, go ahead".
 */
function parseRobots(text) {
  const groups = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && current) {
      current.rules.push({ allow: field === "allow", path: value });
    }
  }
  return groups;
}

function robotsVerdict(groups, pathname) {
  // Only the '*' group applies to us: our UA is unique and will not be named.
  const group = groups.find((g) => g.agents.includes("*"));
  if (!group) return { allowed: true, rule: "(no * group — no rules apply)" };
  let best = null;
  for (const rule of group.rules) {
    if (rule.path === "") continue; // empty Disallow means "allow everything"
    if (!pathname.startsWith(rule.path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) {
      best = rule;
    }
  }
  if (!best) return { allowed: true, rule: "(no matching rule)" };
  return { allowed: best.allow, rule: `${best.allow ? "Allow" : "Disallow"}: ${best.path}` };
}

async function fetchTarget(target, fetchImpl) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(target.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": UA, accept: "*/*" },
    });
    const body = Buffer.from(await res.arrayBuffer());
    const headers = {};
    for (const h of HEADERS_OF_INTEREST) {
      const v = res.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    return {
      ok: true,
      outcome: classify(res.status),
      status: res.status,
      finalUrl: res.url,
      redirected: res.url !== target.url,
      headers,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      elapsedMs: Date.now() - started,
      body,
    };
  } catch (err) {
    return {
      ok: false,
      outcome: "unreachable",
      error: `${err.name}: ${err.message}`,
      cause: err.cause ? String(err.cause.code || err.cause.message || err.cause) : undefined,
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The pinned edition sha, DERIVED from the extractor — never a second hand-held copy. */
function pinnedPdfSha() {
  try {
    const { parseExtractorConstants } = require("./selling-guide-corpus-guard.cjs");
    return parseExtractorConstants(path.join(ROOT, "scripts/extract-selling-guide.py")).PDF_SHA256;
  } catch (e) {
    return null;
  }
}

function extension(kind, headers) {
  if (kind === "robots") return "txt";
  if (kind === "pdf") return "pdf";
  const ct = (headers && headers["content-type"]) || "";
  if (ct.includes("json")) return "json";
  return "html";
}

async function runRecon({
  fetchImpl = fetch,
  out = OUT,
  targets = TARGETS,
  log = console.log,
  // Politeness pacing for the LIVE run. Tests pass 0: the delay is courtesy to
  // Fannie's servers, not part of the logic, and 1.5s × 8 targets × every test
  // case put 78 seconds into a suite the merge gate runs.
  gapMs = REQUEST_GAP_MS,
} = {}) {
  fs.mkdirSync(out, { recursive: true });
  const report = {
    $comment:
      "One-off Selling Guide site recon. Bodies live beside this file. Not a monitor, " +
      "not state — see scripts/selling-guide-recon.cjs.",
    ranAt: new Date().toISOString(),
    userAgent: UA,
    runner: `${os.platform()} ${os.arch()} node ${process.version}`,
    pinnedPdfSha256: pinnedPdfSha(),
    robots: {},
    targets: [],
  };

  // --- robots.txt first, and it governs everything after it ----------------------
  // `incomplete` is declared HERE, not after this loop: a robots.txt we could not read
  // is itself an incomplete observation. Deriving it only from the page targets that
  // get skipped downstream would report a clean run for a probe that never got past
  // the front door.
  let incomplete = false;
  const robotsByHost = {};
  for (const target of targets.filter((t) => t.kind === "robots")) {
    const res = await fetchTarget(target, fetchImpl);
    const host = new URL(target.url).host;
    const entry = { url: target.url, why: target.why, ...res };
    if (res.ok && res.outcome === "observed") {
      const text = res.body.toString("utf8");
      entry.text = text;
      robotsByHost[host] = parseRobots(text);
      fs.writeFileSync(path.join(out, `${target.id}.txt`), text);
      log(`\n----- robots.txt @ ${host} (HTTP ${res.status}, ${res.bytes} bytes) -----`);
      log(text.length > 4000 ? `${text.slice(0, 4000)}\n…truncated…` : text);
    } else {
      // A robots.txt we could not READ is not permission to crawl — and a 403 body is
      // an error page, not a ruleset. Parsing one yields no rules, which the evaluator
      // would read as "nothing disallowed, go ahead": the exact inversion to avoid.
      // Host closed for this run.
      robotsByHost[host] = null;
      incomplete = true;
      const reason = res.ok ? `HTTP ${res.status} (${res.outcome})` : res.error;
      if (res.ok) {
        fs.writeFileSync(
          path.join(out, `${target.id}.NOT-ROBOTS.${res.status}.txt`),
          res.body.toString("utf8"),
        );
      }
      log(`\n----- robots.txt @ ${host}: NOT READ — ${reason} -----`);
    }
    delete entry.body;
    report.robots[host] = entry;
    report.targets.push({ id: target.id, kind: "robots", ...entry });
    await sleep(gapMs);
  }

  // --- the rest, each gated on robots --------------------------------------------
  for (const target of targets.filter((t) => t.kind !== "robots")) {
    const { host, pathname } = new URL(target.url);
    const groups = robotsByHost[host];
    const row = { id: target.id, kind: target.kind, url: target.url, why: target.why };

    if (groups === undefined || groups === null) {
      row.outcome = "skipped";
      row.skipped = "robots.txt for this host could not be read — not fetching";
      incomplete = true;
      report.targets.push(row);
      log(`SKIP  ${target.id.padEnd(20)} ${row.skipped}`);
      continue;
    }
    const verdict = robotsVerdict(groups, pathname);
    row.robots = verdict;
    if (!verdict.allowed) {
      row.outcome = "skipped";
      row.skipped = `robots.txt disallows this path (${verdict.rule})`;
      incomplete = true;
      report.targets.push(row);
      log(`SKIP  ${target.id.padEnd(20)} ${row.skipped}`);
      continue;
    }

    const res = await fetchTarget(target, fetchImpl);
    Object.assign(row, res);

    if (!res.ok) {
      incomplete = true;
      log(`UNREACH ${target.id.padEnd(18)} ${res.error}${res.cause ? ` (${res.cause})` : ""}`);
    } else if (res.outcome !== "observed") {
      // Saved under a name nobody can mistake for site content: a denial body is an
      // error page from whatever refused us, and reading it as Guide HTML is how a
      // proxy notice becomes "a new edition is published".
      incomplete = true;
      const file = `${target.id}.NOT-CONTENT.${res.status}.txt`;
      fs.writeFileSync(path.join(out, file), res.body);
      row.savedAs = file;
      log(
        `${res.outcome.toUpperCase().padEnd(7)} ${target.id.padEnd(18)} HTTP ${res.status} ` +
          `${String(res.bytes).padStart(9)}B — not content, not hashed`,
      );
    } else {
      const file = `${target.id}.${extension(target.kind, res.headers)}`;
      fs.writeFileSync(path.join(out, file), res.body);
      row.savedAs = file;

      // Body-shape check. A 2xx is still not evidence on its own (CLAUDE.md's govinfo
      // lesson: 200 with 44 KB of "Page Not Found"), so each target says what it must
      // contain to count.
      const probe = target.probe;
      if (probe) {
        const head = res.body.subarray(0, 2 << 20).toString("utf8");
        row.probeMatched = probe.test(head);
        if (!row.probeMatched) {
          row.outcome = "unusable";
          incomplete = true;
        }
      }

      if (target.kind === "pdf") {
        // Only compare against the pinned edition when this really is a PDF. The first
        // draft hashed a 114-byte denial page and announced a new edition.
        row.looksLikePdf = res.body.subarray(0, 5).toString("latin1") === "%PDF-";
        if (row.looksLikePdf && report.pinnedPdfSha256) {
          row.matchesPinnedEdition = res.sha256 === report.pinnedPdfSha256;
        } else if (!row.looksLikePdf) {
          row.outcome = "unusable";
          row.note = "response is not a PDF — no edition comparison made";
          incomplete = true;
        }
      }

      log(
        `${(row.outcome === "observed" ? "OK" : row.outcome.toUpperCase()).padEnd(7)} ` +
          `${target.id.padEnd(18)} HTTP ${res.status} ${String(res.bytes).padStart(9)}B` +
          `${row.probeMatched === false ? " — body did not match the expected content" : ""}` +
          `${res.redirected ? ` → ${res.finalUrl}` : ""}`,
      );
    }
    delete row.body;
    report.targets.push(row);
    await sleep(gapMs);
  }

  fs.writeFileSync(path.join(out, "recon-report.json"), `${JSON.stringify(report, null, 1)}\n`);

  log(`\nartifact dir: ${out}`);
  log(`files: ${fs.readdirSync(out).sort().join(", ")}`);
  if (report.pinnedPdfSha256) {
    const pdf = report.targets.find((t) => t.kind === "pdf");
    if (pdf && pdf.looksLikePdf && pdf.sha256) {
      log(
        `\nPDF endpoint sha256 ${pdf.sha256.slice(0, 16)}… vs pinned ${report.pinnedPdfSha256.slice(0, 16)}… ` +
          `→ ${pdf.matchesPinnedEdition ? "SAME edition" : "DIFFERENT — a new edition or amendment is published"}`,
      );
    } else if (pdf) {
      log(
        `\nPDF endpoint: no edition comparison — ${pdf.skipped || pdf.note || pdf.error || `HTTP ${pdf.status} (${pdf.outcome})`}`,
      );
    }
  }
  return { report, incomplete };
}

async function main() {
  const { incomplete } = await runRecon();
  process.exit(incomplete ? 3 : 0);
}

module.exports = { runRecon, parseRobots, robotsVerdict, classify, TARGETS, UA };

if (require.main === module) {
  main().catch((err) => {
    console.error(`recon failed: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
