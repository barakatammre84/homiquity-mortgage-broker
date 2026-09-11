# Handoff — the Feynman onboarding corpus for Homiquity

> **Freshness:** last verified 2026-08-23 · review every 60 days
> Verified against `origin/main` @ 6377727e (every chapter carries its own stamp).

This directory teaches the product to a full-stack engineer who has never seen it, and hands it
over to a team that will keep it running. It is a **layer over** the existing documentation, not
a replacement: the 12-chapter app-guide in `../handbook/app-guide/` stays the authoritative
description of each subsystem, `../handbook/FEATURE_MAP.md` stays the ownership map, and
`../governance/TEAM_PRACTICES.md` stays the house rules. Where this corpus and those disagree,
**the app-guide wins; where either disagrees with the code, the code wins** and the disagreement
becomes a row in [LEDGER.md](LEDGER.md) for the owning lane to fix.

## The Feynman contract (what every chapter owes you)

Richard Feynman's technique: explain it simply, find the gap you cannot explain, go back to the
source, then simplify again. Each chapter is built in that order and you can read it that way:

1. **The mental model** — one sentence you could repeat at a whiteboard.
2. **Explain it to a new hire** — exactly five sentences, no jargon that was not defined first.
3. **Mechanism** — one diagram of how it actually moves.
4. **The facts, with receipts** — every claim carries `path:line`, the symbol at that line, and the
   command that proves it. A count without its command does not appear in this corpus.
5. **Prove it yourself** — a block of read-only shell commands, each followed by the output it
   produced at the stamped commit. Run them; if an output differs, the code moved — add a ledger
   row, do not trust the prose.
6. **Where this breaks** — the documented traps and seams, and which test or guard would (or
   would not) catch each.
7. **What we do not know** — the gaps the authors could not close, each with what would close it.
8. **Analogy** — the simplification that survives step 7.
9. **Teach-back checkpoint** — questions you must be able to answer with a `path:line`; the
   answers live in [TEACHBACK_KEY.md](TEACHBACK_KEY.md), which you do not open until you have
   tried.
10. **Go deeper** — the app-guide chapter, runbooks, feature-map rows and owner agents for the area.

## Reading orders

**Day 1 — can I run it, and who is allowed to do what?**
[00 Product, roles and the map](00-product-roles-and-the-map.md) →
[01 Architecture and the request lifecycle](01-architecture-request-lifecycle.md) →
[02 Authentication and authorization](02-auth-and-authorization.md) →
[07 Test harness and the CI proof hierarchy](07-test-harness-and-ci-proof.md).
Then run `bash scripts/dev-up.sh` from the repo root and the Day-1 teach-backs.

**Week 1 — how does a loan move through it?**
[03 Data model and schema](03-data-model-and-schema.md) →
[04 Data flow: a loan's journey](04-data-flow-loan-journey.md) →
[05 Backend patterns, engines and adapters](05-backend-patterns-engines-adapters.md) →
[06 Frontend patterns](06-frontend-patterns.md) →
[10 Deploy, environments and migrations](10-deploy-environments-migrations.md).

**Month 1 — what must never change, and how we build without breaking it?**
[08 Compliance rails](08-compliance-rails.md) →
[13 The Selling Guide as the foundation](13-selling-guide-as-the-foundation.md) →
[09 Prompting and automation: the second codebase](09-prompting-and-automation.md) →
[11 Patterns and repetition](11-patterns-and-repetition.md) →
[12 The loop-safe build playbook](12-loop-safe-build-playbook.md) and its
[prompts/](prompts/) (rails, report format, eight templates, how to invoke).

## Day 1 — bring it up

Derived from `scripts/dev-up.sh` read in full and the files it calls; every quoted line is the
script's own stdout, cited to the line that prints it.

**1. One command.** `bash scripts/dev-up.sh` (= `pnpm dev:up`, `package.json:53`) from the repo
root. It is idempotent and "NEVER overwrites a value you already have in .env — it only fills in
what is missing, and says which keys it added" (`scripts/dev-up.sh:22-23`). In order:

| step | what it prints | where |
|---|---|---|
| deps | `installing dependencies (pnpm install --frozen-lockfile)…` — only when `node_modules/.bin/tsx` is absent | `scripts/dev-up.sh:100-103` |
| database | `no DATABASE_URL yet — bringing up a local one…` then `  database: <url>` — `scripts/local-db.sh up` gives you a private cluster on **5433** (`scripts/local-db.sh:31` `PORT="${LOCAL_DB_PORT:-5433}"`), never the shared dev DB: it seeds, and `seedLendingGrids` wipes the pricing matrices (`:23-27`) | `scripts/dev-up.sh:110-116` |
| `.env` | `creating .env` on a fresh clone (`:130-138`), then `  added to .env: DATABASE_URL NODE_ENV PORT SESSION_SECRET PII_HASH_SALT CREDIT_ENCRYPTION_KEY DEV_TEST_PASSWORD EXTRACTION_SIMULATE` — the three secrets come from `crypto.randomBytes`, never a template (`:119-121`, `:142-144`); `DEV_TEST_PASSWORD` is `test1234` (`:145`); `EXTRACTION_SIMULATE=true` keeps document extraction on the simulated path (`:146-150`) | `scripts/dev-up.sh:139-151` |
| migrate | silent when it works; `db:migrate failed — see /tmp/dev-up-migrate.log` when it does not | `:153-157` |
| serve | `starting the dev server on port 5001…` (`PORT="${PORT:-5001}"`, `:27`); polls `/api/health` up to 60 × 1 s, and on a miss prints `the server did not become healthy. Last 30 lines:` | `:159-183` |
| banner | `http://localhost:5001   ← the app` · `sign in with any seeded account, password: test1234` · eight addresses · `logs:` `stop:` `look:` `gate:` | `:185-198` |

**2. Is it up, and which build is it?** `bash scripts/dev-up.sh status` prints `running  pid <n>  port
5001` and the first 400 bytes of `/api/health` (`:78-81`). The handler (`server/routes.ts:76-92`)
answers `{"status":"ok","timestamp":…,"commit":…,"email":{"configured":…,"providers":[…]}}`
after a `SELECT 1` (`:78`), or 503 `"Database is not reachable"` when that fails (`:85-92`).
`commit` is `process.env.RAILWAY_GIT_COMMIT_SHA ?? null` (`:82`) — "absent locally and in any
non-Railway run, hence `?? null` rather than a fake value" (`:59-60`) — so **`commit: null` is the
local-dev signature, not a defect**; the same field is the only proof a merge shipped (fact 2
below). `email` is booleans and provider names only (`server/services/emailService.ts:66-71`).
*(Shape read from the handler; no server was booted for this section — the worktree it was
written in has no `node_modules`.)*

**3. Sign in.** Open `http://localhost:5001/test-login`, type the password once, click a role card
(`knowledge-base/runbooks/LOCAL_DEV.md:212-213`). The route is `POST /api/test-login`
(`server/auth.ts:343`) and the accounts are a literal map (`:358-368`): `grep -c "@test.com"
server/auth.ts` → `11` — staff `admin@` `lo@` `loa@` `processor@` `underwriter@` `closer@`;
partner `broker@` `lender@` `cpa@`; borrower `renter@` (`aspiring_owner`) and `buyer@`
(`active_buyer`); **`realtor` is the one role with no account**. Login upserts the user (`:375-382`),
so the accounts survive a database reset. The three answers the route can give: `DEV_TEST_PASSWORD`
unset → **503** `Dev test login is not configured` (`:350-355`); unknown email or wrong password →
**401** (`:371-373`); `NODE_ENV=production` → a flat **404**: the real handler is never registered and a
stub that answers 404 takes its path (`:60-64`). `authLimiter` rate-limits it (`server/app.ts:332`).

**4. What will look broken and is not.** Uploads, Plaid, the assistant, outbound mail and maps all
degrade without keys — the table at `knowledge-base/runbooks/LOCAL_DEV.md:226-237` says how each
fails and what to set; credit, AVM and GSE are deterministic simulations and work fully offline.

Two things this walk found are ledger rows, not prose: the pre-push gate is armed only by
`dev-up.sh status`, never by `up` (HO-0823-01), and the banner lists eight of the eleven accounts
(HO-0823-02). Then read the Day-1 chapters above and try their teach-backs.

## The registers

- [FACTS.md](FACTS.md) — every count the corpus uses, as `id | fact | command | value @ SHA`.
  Chapters cite `F-nn`; the numbers are re-derived, never edited by hand.
- [LEDGER.md](LEDGER.md) — drift found in *other* docs and in session memories, the
  uncertainties the authors could not resolve, and the refresh run log.
- [TEACHBACK_KEY.md](TEACHBACK_KEY.md) — the answer key.

## How this corpus stays true

Three layers, weakest to strongest:

1. **Freshness lines.** Every file carries `> **Freshness:** last verified YYYY-MM-DD · review
   every N days`. The repo's `scripts/doc-freshness-guard.cjs` enforces only the docs named in
   its own `REQUIRED` list, so these lines are a contract with the reader and with the refresh
   skill, not with the weekly workflow — a date here is bumped only after a real re-read.
2. **Command-derived facts.** A refresh re-runs every command in [FACTS.md](FACTS.md) and every
   chapter's prove-it block at the new `origin/main` tip, and re-stamps the SHA. A number that
   changed is a prose edit plus, if another doc carried the old number, a ledger row.
3. **A steward, on a clock.** Since 2026-08-23 the daily 17:06 seat (**Handoff Corpus Steward**,
   `.claude/skills/handoff-refresh/SKILL.md`; CHARTER §3 — it took over the laptop `taskId`
   `client-journey-walk` when the daily walk retired to hand-invocation) runs layer 2 end to end
   every day: detect moved paths with `git diff --stat <FACTS SHA>..origin/main`, re-run the
   commands, rewrite the generated block, **age the open `HO-` rows** (a fix-now row older than
   7 days becomes a ⛔ line naming its lane), log the run. Its clocks: `--check`/`--cite` daily ·
   FACTS fully re-derived every ≤14 days · every chapter re-read in rotation every ≤30 days — so
   the numbers are never fresher than the prose that interprets them. The doc-accuracy routine
   still sweeps the rest of `knowledge-base/**` and consumes `HO-` rows as its own findings; since
   2026-08-23 it never edits `handoff/**` itself (CHARTER §6 — one writer per truth); every
   fourteenth tick it also runs the corpus's fresh-hire teach-back (a read-only subagent, key
   forbidden) and reports the misses to this seat as proposed `HO-` rows.

**Refresh protocol:** invoke the `handoff-refresh` skill, or do it by hand — fresh worktree of
`origin/main` → `pnpm handoff:facts --check` and `--cite` to find drift mechanically, plus
`git log <FACTS-stamp>..origin/main` to find the drift no tool can see (a count can be unchanged
while the *reason* for it changed) → `pnpm handoff:facts --write` → fix the prose the numbers
belong to → `pnpm guard:kb && pnpm guard:staleness && pnpm guard:citations && pnpm guard:ui` →
add `HO-` rows, bump stamps only for files actually re-read → append a line to the ledger's run
log → PR with `git add knowledge-base/handoff/...` explicitly.

**Two rows measure `HEAD`, not `main`** — F-31 (commits) and the SHA stamp — which is why
`--write` refuses to run from a branch ahead of `origin/main`. And F-21 counts this corpus
itself, so it rises the moment `handoff/` merges.

## What changes when you build

Nothing here replaces how you already work. It changes what is *available* when you ask, and it
names the four things a session cannot do for you.

### An ordinary session — the default, and the right choice for most work

`CLAUDE.md` loads automatically, plus a router skill when the work matches its domain. That is
already true today. What this directory adds is a place to point:

- **"Read handoff chapter NN first"** for territory you have not worked in. Cheaper than letting a
  session re-derive the architecture from greps, and the chapter's claims carry commands you can
  re-run rather than assertions you have to trust.
- **"Follow `prompts/_RAILS.md`"** for anything with a testable outcome. That single sentence buys
  the territory discipline (a declared WRITE list, checked against `git diff --name-only`) and the
  tier evidence (T0–T3 lines copied from logs, not recalled) — with no loop machinery at all.

Still binding, unchanged by any of this: work in a worktree off `origin/main`, never the primary
checkout. The pre-push hook is the only gate that runs on its own, and since #660 it is the
**cheap half** — typecheck plus eight guards, ~25 s, and **no unit tests** unless you set
`PREPUSH_TESTS=1`. `knowledge-base/governance/TEAM_PRACTICES.md` §5 is the definition of done.

### A loop — for bounded work, not as an upgrade

Use `prompts/INVOKE.md`. A loop is worth its overhead when the task is one layer, one WRITE list,
and has a test that can go red before it goes green — a characterisation test, a contained bug
fix, a migration. It is the wrong tool for anything exploratory, because a loop cannot decide that
the task was the wrong task.

Four mechanics that cost a real acceptance run to learn: headless `claude -p` does **not** expand
the slash command (run the plugin's setup script first, and blank the `session_id` it inherits);
the completion promise must be the **last line** of the final message, after any prose; fresh
worktree with `pnpm install --frozen-lockfile`, port 5002, and a scratch directory **outside** the
repo; and a loop that adds a client test will be told to regenerate the design-system table, which
is sanctioned and belongs in its own commit.

A loop ends in `DONE` with T0–T3 lines copied from its logs, or `STOPPED(<reason>)` with a
hand-back naming the line, the change and the owner. **It never merges.**

### What never moves to a loop, or to a session running unattended

Merging · the T5 `/api/health` commit check · §9 security reviews · contract migrations · anything
in a hand-back file (auth, the decision engines, the PII vaults) · regulated math without a ledger
citation · CHARTER §1b rows L3 and L4.

### The five facts that bite hardest, and where each is proved

| | fact | proof |
|---|---|---|
| 1 | `main` uses classic branch protection with the named PR gate required and strict; the session token cannot read the context list, so merge behaviour is the proof. | FACTS F-44; chapter 07 |
| 2 | A merge is a deploy, and a **failed** Railway build leaves the previous container serving — so the site stays up and every check stays green while prod goes stale. Only `/api/health`'s `commit` proves a ship. | chapter 10 |
| 3 | The node lane **globs** since #725 (`387a3518`, 2026-08-24): `include: ["tests/**/*.test.{ts,tsx}"]` minus a 30-entry `exclude` for the integration files (`vitest.config.ts:71,77-95`). It was a hand-typed ~230-path allowlist until that day — the repo's most-churned file, 222 commits, two PRs dead on one contended line. The floor is what makes either design safe: since #670 (`fd4a22c5`, 2026-08-23) `pnpm test` IS `scripts/test-collection-guard.cjs`, which enumerates the disk itself and fails any lane that collected fewer files than exist, any test file no lane includes, and (new with the glob) any file claimed by two lanes — naming the files, with no baseline to bump. The discipline is now just: write the file and read the guard's own last line. `pnpm test:raw` is the old unguarded pair. | FACTS F-13, F-39; chapter 07 |
| 4 | Adding a colocated client test reddens `guard:ui` until you run `pnpm guard:ui --write-table`, because the generated table's denominator counts test files. This has already merged red to `main` once. | LEDGER HO-0822-25, HO-0822-26 |
| 5 | The dominant defect class here is an operation that **does not happen while the UI says it did** — a 200 for a write that was silently dropped. Chapter 04's draft round-trip is the worked example, and its fix did not close the class. | chapter 04 |

### If something you were told here is wrong

That is expected, and it has a route: it becomes an `HO-<MMDD>-<NN>` row in
[LEDGER.md](LEDGER.md), never a silent edit to a sibling doc. The precedence rule at the top of
every chapter is the first defence — **the app-guide wins on conflict, and the code wins over
both.** You are meant to distrust this directory and check.

## Conventions these files obey (and the guards that check them)

- Links are relative to the linking file (`TEAM_PRACTICES.md` §7).
- A backticked `path.ext` must exist in the repo (`scripts/citation-guard.cjs`); a file that is
  deliberately absent is named in prose.
- `pnpm` is the only package manager named; retired vocabulary never appears
  (`scripts/doc-staleness-guard.cjs`).
- Every file under `knowledge-base/` is reachable from `../README.md`
  (`scripts/kb-index-guard.cjs`) — this directory is indexed by one line there.
- No transient state (open PR numbers, branch names) in chapters; the ledger's run log is the
  only place a PR number belongs.
