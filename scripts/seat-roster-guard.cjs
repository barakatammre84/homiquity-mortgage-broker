#!/usr/bin/env node
/**
 * seat-roster-guard — the routine roster is single-sourced, correct, and validated.
 *
 * WHY THIS EXISTS. On 2026-08-24 `CHARTER.md` §3 presented sixteen live seats;
 * `list_scheduled_tasks` returned six. Ten seats — including Evening Triage, the one that
 * reads every other seat's report — had their definitions sitting on disk with no
 * registration. `TEAM.md` marked three of them "✅ yes" registered. §11 already names this
 * exactly ("a definition on disk that is not registered in the scheduler is not a routine —
 * it is a fossil, and fossils are what produced §0") and §0 records the five weeks it cost
 * last time. The rule existed; nothing enforced it. This is the enforcement.
 *
 * The mechanical cause was RESTATEMENT: the roster was written out in twelve places inside
 * CHARTER.md alone, plus TEAM.md, the KB README, the roadmap and the skills. Every copy is an
 * independent place to go wrong, and ten went wrong. So the roster now lives in exactly one
 * machine-readable file and the tables are generated from it.
 *
 * WHAT IT CANNOT DO, stated plainly: CI cannot read either scheduler. `SEATS.tsv` is therefore
 * a SNAPSHOT, and its `Registry read` freshness line is what forces a session that CAN read
 * them to re-take it. That check is calendar-driven, so it is `--no-freshness` in the required
 * gate and full in checkup — `.github/workflows/doc-freshness.yml:10-19` is the in-repo
 * precedent for keeping calendar checks out of the required check.
 *
 * Paths are env-overridable so the tests can prove the FAILING directions; a guard only ever
 * asserted in its passing state is a guard nobody has tested (LESSONS.md 2026-08-12).
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DAY = 24 * 3600 * 1000;

const COLUMNS = [
  "seatId", "displayName", "fleet", "taskId", "cron", "fires", "cadence",
  "writesCode", "definitionPath", "status", "statusReason", "reviewBy", "produces",
];
const STATUSES = new Set(["active", "paused", "broken", "unregistered", "retired"]);
/** These must justify themselves and carry an expiry — DA-0820-09's lesson. */
const NEEDS_REASON = new Set(["paused", "broken", "unregistered", "retired"]);

const BEGIN_LOCAL = "<!-- BEGIN GENERATED seats:local — do not hand-edit; run `pnpm guard:seats --write-table` -->";
const BEGIN_CCR = "<!-- BEGIN GENERATED seats:ccr — do not hand-edit; run `pnpm guard:seats --write-table` -->";
const BEGIN_TEAM = "<!-- BEGIN GENERATED seats:team — do not hand-edit; run `pnpm guard:seats --write-table` -->";
const END = "<!-- END GENERATED -->";

const FRESHNESS = /\*\*Registry read:\*\*\s*last verified\s*(\d{4}-\d{2}-\d{2})\s*·\s*review every\s*(\d+)\s*days/;

/** Living docs that may name a scheduled task. Immutable history is excluded on purpose. */
const EXTENSION_DOCS = [
  "knowledge-base/routines/REGISTER.md",
  "knowledge-base/README.md",
  "CTO_ROADMAP.md",
];

function defaultPaths() {
  return {
    seats: process.env.SEATS_PATH || path.join(ROOT, "knowledge-base/routines/SEATS.tsv"),
    charter: process.env.SEATS_CHARTER_PATH || path.join(ROOT, "knowledge-base/routines/CHARTER.md"),
    team: process.env.SEATS_TEAM_PATH || path.join(ROOT, "knowledge-base/routines/TEAM.md"),
    root: process.env.SEATS_ROOT || ROOT,
    extensionDocs: EXTENSION_DOCS,
  };
}

const rel = (p, root) => path.relative(root, p) || p;

// ---------------------------------------------------------------- parse

function parseSeats(text) {
  const lines = text.split("\n");
  const rows = [];
  let header = null;
  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;
    const cells = line.split("\t");
    if (!header) {
      header = cells.map((c) => c.trim());
      continue;
    }
    const row = {};
    header.forEach((h, i) => { row[h] = (cells[i] ?? "").trim(); });
    row.__raw = line;
    rows.push(row);
  }
  return { header, rows };
}

// ---------------------------------------------------------------- render

/** Daily before weekly before monthly, then day-of-week, then clock. */
function cronKey(cron) {
  const p = (cron || "").trim().split(/\s+/);
  if (p.length !== 5) return [9, 9, 9999];
  const [m, h, dom, , dow] = p;
  const rank = dom !== "*" ? 2 : dow !== "*" ? 1 : 0;
  const dowN = dow === "*" ? 0 : parseInt(dow, 10) || 0;
  const mins = (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0);
  return [rank, dowN, mins];
}

function bySchedule(a, b) {
  const ka = cronKey(a.cron), kb = cronKey(b.cron);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return a.seatId.localeCompare(b.seatId);
}

const REGISTERED_CELL = {
  active: "✅ **enabled**",
  paused: "⏸️ registered, **paused**",
  broken: "⚠️ registered and enabled — **NOT DISPATCHING**",
  unregistered: "⛔ **NO** — definition on disk, not in the scheduler (§11)",
  retired: "— retired",
};

function renderGroup(rows, firesHeader) {
  const out = [];
  out.push(`| ${firesHeader} | Cron | Routine (\`taskId\`) | Cadence | Writes code? | Registered? | Produces |`);
  out.push("|---|---|---|---|---|---|---|");
  for (const r of rows.slice().sort(bySchedule)) {
    out.push(
      `| ${r.fires || "—"} | ${r.cron ? "`" + r.cron + "`" : "—"} | **${r.displayName}** (\`${r.taskId}\`) | ` +
      `${r.cadence || "—"} | ${r.writesCode || "—"} | ${REGISTERED_CELL[r.status] || r.status} | ${r.produces || "—"} |`
    );
  }
  return out.join("\n");
}

function renderFleet(rows, fleet, firesHeader) {
  const mine = rows.filter((r) => r.fleet === fleet || (fleet === "local" && r.fleet === "hand"));
  const live = mine.filter((r) => r.status === "active");
  const stopped = mine.filter((r) => r.status === "paused" || r.status === "broken");
  const fossil = mine.filter((r) => r.status === "unregistered");
  const retired = mine.filter((r) => r.status === "retired");

  const out = [];
  if (live.length) {
    out.push("**Registered and running.**\n");
    out.push(renderGroup(live, firesHeader));
  } else {
    out.push("**Registered and running:** *(none)*");
  }
  if (stopped.length) {
    out.push("");
    out.push(
      "**Registered but not running.** A paused seat is a decision; a `NOT DISPATCHING` seat is a " +
      "fault — its slot advances and no session is created, which looks identical to a healthy seat " +
      "from the outside. Neither is a control.\n"
    );
    out.push(renderGroup(stopped, firesHeader));
  }
  if (fossil.length) {
    out.push("");
    out.push(
      `**Not registered — ${fossil.length} definition(s) on disk with no scheduler entry.** §11: ` +
      "*\"a definition on disk that is not registered in the scheduler is not a routine — it is a " +
      "fossil, and fossils are what produced §0.\"* These do **not** run. Nothing may plan around them.\n"
    );
    out.push(renderGroup(fossil, firesHeader));
  }
  if (retired.length) {
    out.push("");
    out.push("**Retired.** Kept as a record; their definitions belong in `_archive/` only.\n");
    out.push(renderGroup(retired, firesHeader));
  }
  return out.join("\n");
}

function renderTeam(rows) {
  const out = [];
  out.push("| Seat | Routine (`taskId`) | Cadence | Writes code? | Registered? (generated from `SEATS.tsv`) |");
  out.push("|---|---|---|---|---|");
  for (const r of rows.slice().sort(bySchedule)) {
    out.push(
      `| **${r.displayName}** | \`${r.taskId}\` | ${r.cadence || "—"} | ${r.writesCode || "—"} | ` +
      `${REGISTERED_CELL[r.status] || r.status} |`
    );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- block IO

function spliceBlock(doc, begin, table) {
  const a = doc.indexOf(begin), b = doc.indexOf(END, a === -1 ? 0 : a);
  if (a === -1 || b === -1) return null;
  return doc.slice(0, a + begin.length) + "\n\n" + table + "\n\n" + doc.slice(b);
}

function blockBody(doc, begin) {
  const a = doc.indexOf(begin);
  if (a === -1) return null;
  const b = doc.indexOf(END, a);
  if (b === -1) return null;
  return doc.slice(a + begin.length, b);
}

// ---------------------------------------------------------------- the run

function runRoster(now = Date.now(), paths = defaultPaths(), opts = {}) {
  const failures = [];
  const warnings = [];

  if (!fs.existsSync(paths.seats)) {
    failures.push(
      `${rel(paths.seats, paths.root)} does not exist. The roster is the registration record; ` +
      "without it nothing here can be checked and every seat table in the repo is unverifiable."
    );
    return { failures, warnings, summary: "no manifest", rows: [] };
  }

  const text = fs.readFileSync(paths.seats, "utf8");
  const { header, rows } = parseSeats(text);

  // 1. Parses, non-empty, shaped. Absence is never silence.
  if (!header) {
    failures.push(`parsed no header from ${rel(paths.seats, paths.root)} — the file shape changed.`);
    return { failures, warnings, summary: "unparseable", rows: [] };
  }
  const missingCols = COLUMNS.filter((c) => !header.includes(c));
  if (missingCols.length) {
    failures.push(
      `${rel(paths.seats, paths.root)} is missing column(s): ${missingCols.join(", ")}. ` +
      "Fix the manifest or the parser — do not lower the bar."
    );
    return { failures, warnings, summary: "bad columns", rows: [] };
  }
  if (!rows.length) {
    failures.push(
      `parsed 0 seats from ${rel(paths.seats, paths.root)} — the table shape changed. ` +
      "Fix the parser, do not lower the bar. A roster that reports zero seats and passes is the " +
      "exact silent-green failure this guard exists to prevent."
    );
    return { failures, warnings, summary: "0 rows", rows };
  }

  const seen = new Set();
  for (const r of rows) {
    if (!r.seatId) { failures.push(`a row has no seatId: ${r.__raw.slice(0, 80)}`); continue; }
    if (seen.has(r.seatId)) failures.push(`duplicate seatId \`${r.seatId}\``);
    seen.add(r.seatId);
    if (!STATUSES.has(r.status)) {
      failures.push(`\`${r.seatId}\`: status "${r.status}" is not one of ${[...STATUSES].join(" | ")}.`);
    }
    if (NEEDS_REASON.has(r.status)) {
      if (!r.statusReason) {
        failures.push(
          `\`${r.seatId}\` is \`${r.status}\` with no statusReason. A seat that is not running must say ` +
          "why, or nobody can tell a decision from an accident."
        );
      }
      if (!r.reviewBy) {
        failures.push(
          `\`${r.seatId}\` is \`${r.status}\` with no reviewBy. A pause with no expiry is DA-0820-09: ` +
          "a control paused because of a premise dies the moment the premise changes, and nothing re-checks it."
        );
      } else {
        const due = new Date(`${r.reviewBy}T00:00:00Z`).getTime();
        if (isNaN(due)) failures.push(`\`${r.seatId}\`: unparseable reviewBy "${r.reviewBy}" (want YYYY-MM-DD).`);
        else if (now > due) {
          warnings.push(
            `\`${r.seatId}\`: reviewBy ${r.reviewBy} has passed (${Math.floor((now - due) / DAY)}d ago) and it is ` +
            `still \`${r.status}\`.\n      → decide: register it, or retire it and archive the definition.`
          );
        }
      }
    }
  }

  // 2. The snapshot is fresh. Calendar-driven — skipped in the required gate.
  if (!opts.noFreshness) {
    const m = text.match(FRESHNESS);
    if (!m) {
      failures.push(
        `${rel(paths.seats, paths.root)} has no registry-read line. Add:\n` +
        "      > **Registry read:** last verified YYYY-MM-DD · review every N days"
      );
    } else {
      const verified = new Date(`${m[1]}T00:00:00Z`).getTime();
      const interval = Number(m[2]);
      if (isNaN(verified) || !Number.isFinite(interval) || interval <= 0) {
        failures.push(`${rel(paths.seats, paths.root)}: unparseable registry-read line ("${m[0]}").`);
      } else {
        const overdueBy = Math.floor((now - verified) / DAY) - interval;
        if (overdueBy > 0) {
          failures.push(
            `${rel(paths.seats, paths.root)}: the registry snapshot is OVERDUE ${overdueBy}d ` +
            `(last read ${m[1]}, review every ${interval}d).\n` +
            "      → re-read `list_scheduled_tasks` and `RemoteTrigger action:list` (cron rows only), " +
            "correct the roster, bump the date. A roster nobody re-measures is how ten seats came to look staffed."
          );
        }
      }
    }
  }

  // 3. The generated blocks agree with the roster.
  const blocks = [
    { file: paths.charter, begin: BEGIN_LOCAL, table: renderFleet(rows, "local", "Fires"), label: "CHARTER §3 (local fleet)" },
    { file: paths.charter, begin: BEGIN_CCR, table: renderFleet(rows, "ccr", "Fires (UTC)"), label: "CHARTER §3a (CCR fleet)" },
    { file: paths.team, begin: BEGIN_TEAM, table: renderTeam(rows), label: "TEAM.md seating chart" },
  ];
  for (const blk of blocks) {
    if (!fs.existsSync(blk.file)) { failures.push(`${rel(blk.file, paths.root)} does not exist.`); continue; }
    const body = blockBody(fs.readFileSync(blk.file, "utf8"), blk.begin);
    if (body === null) {
      failures.push(
        `${blk.label}: no generated block in ${rel(blk.file, paths.root)}. Add, on their own lines:\n` +
        `      ${blk.begin}\n      ${END}`
      );
    } else if (body.trim() !== blk.table.trim()) {
      failures.push(
        `${blk.label} is STALE — it disagrees with \`SEATS.tsv\`.\n` +
        "      That table is GENERATED from the roster; it is not prose to keep in sync by hand.\n" +
        "      → run `pnpm guard:seats --write-table` and commit the result in this PR."
      );
    }
  }

  // 4. Definitions exist. A registration without a definition is §11's mirror-image fossil.
  let unverifiable = 0;
  for (const r of rows) {
    if (r.status === "retired" || !r.definitionPath) continue;
    if (r.definitionPath.startsWith("~/")) { unverifiable += 1; continue; } // laptop-only; not visible to CI
    const abs = path.join(paths.root, r.definitionPath);
    if (!fs.existsSync(abs)) {
      failures.push(
        `\`${r.seatId}\`: definitionPath \`${r.definitionPath}\` does not exist. ` +
        "A seat registered against a definition that is not there schedules a silent no-op (CHARTER §11, lesson 1)."
      );
    }
  }

  // 5. No living doc names a scheduled task the roster does not know.
  const knownTasks = new Set(rows.map((r) => r.taskId).filter(Boolean));
  for (const docRel of paths.extensionDocs) {
    const abs = path.join(paths.root, docRel);
    if (!fs.existsSync(abs)) continue;
    const doc = fs.readFileSync(abs, "utf8");
    const re = /~\/\.claude\/scheduled-tasks\/([A-Za-z0-9._-]+)/g;
    let m;
    const orphans = new Set();
    while ((m = re.exec(doc))) {
      if (m[1] === "_archive") continue;
      if (!knownTasks.has(m[1])) orphans.add(m[1]);
    }
    for (const o of orphans) {
      failures.push(
        `${docRel} names scheduled task \`${o}\`, which is absent from \`SEATS.tsv\`. ` +
        "Every seat a living doc mentions is in the roster or it is not a seat."
      );
    }
  }

  // 6. A retired definition still sitting in the live task dir — §11 forbids it.
  for (const r of rows) {
    if (r.status !== "retired" || !r.definitionPath.startsWith("~/")) continue;
    const live = path.join(process.env.HOME || "", r.definitionPath.slice(2));
    if (fs.existsSync(live)) {
      warnings.push(
        `\`${r.seatId}\` is retired but its definition is still in the LIVE task dir ` +
        `(\`${r.definitionPath}\`).\n      → §11: retired definitions are archived under ` +
        "`_archive/`, never left registered-looking. Delete the live copy."
      );
    }
  }

  const n = (s) => rows.filter((r) => r.status === s).length;
  const summary =
    `${rows.length} seats — ${n("active")} active · ${n("paused")} paused · ` +
    `${n("unregistered")} UNREGISTERED · ${n("retired")} retired` +
    (unverifiable ? ` (${unverifiable} definition path(s) laptop-only, not visible here)` : "");

  return { failures, warnings, summary, rows };
}

// ---------------------------------------------------------------- main

function writeTables(paths) {
  const { rows } = parseSeats(fs.readFileSync(paths.seats, "utf8"));
  if (!rows.length) {
    console.log("seat-roster-guard: refusing to write — parsed 0 seats. Fix the parser, do not lower the bar.");
    process.exit(1);
  }
  const jobs = [
    { file: paths.charter, begin: BEGIN_LOCAL, table: renderFleet(rows, "local", "Fires") },
    { file: paths.charter, begin: BEGIN_CCR, table: renderFleet(rows, "ccr", "Fires (UTC)") },
    { file: paths.team, begin: BEGIN_TEAM, table: renderTeam(rows) },
  ];
  for (const j of jobs) {
    const doc = fs.readFileSync(j.file, "utf8");
    const next = spliceBlock(doc, j.begin, j.table);
    if (next === null) {
      console.log(
        `seat-roster-guard: ${rel(j.file, paths.root)} has no generated block. Add:\n${j.begin}\n${END}`
      );
      process.exit(1);
    }
    fs.writeFileSync(j.file, next);
  }
  console.log("seat-roster-guard: wrote the seat tables into CHARTER.md and TEAM.md. Commit them.");
  process.exit(0);
}

// THIS FILE IS NO LONGER A GUARD. It is a library of recovery helpers for historical
// SEATS.tsv snapshots, kept because tests/seatRoster.test.ts proves they still parse and
// render. Nothing in CI, checkup or preflight invokes it.
//
// Until 2026-09-15 `main()` delegated to source-instructions-guard.cjs and printed a seat
// sentence over the top of it. Three npm aliases and seven call sites did the same thing, so
// `pnpm checkup` reported the ONE guard as THREE passing checks under three names, and the
// gate reported it as two. That is config-key-matches-nothing — the highest-scoring defect
// class in this repo's own audit — which is why running this file now refuses loudly instead
// of quietly succeeding. A no-op that exits 0 is the failure mode, not the fix.
function main() {
  console.error(
    "seat-roster-guard is not a guard. Its checks were retired in #811 (CHARTER.md and TEAM.md\n" +
    "no longer exist, so there is nothing to generate into). The document-register check that\n" +
    "replaced it is:\n\n" +
    "    pnpm guard:sources\n\n" +
    "Scheduler registrations cannot be proved from disk; read them from the application.",
  );
  process.exitCode = 1;
}

module.exports = {
  runRoster, parseSeats, defaultPaths, renderFleet, renderTeam, cronKey,
  BEGIN_LOCAL, BEGIN_CCR, BEGIN_TEAM, END, COLUMNS,
};

if (require.main === module) main();
