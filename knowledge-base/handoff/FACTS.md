# FACTS — every count the corpus uses, derived by command

> **Freshness:** last verified 2026-09-11 · review every 14 days
> **Verified against** `origin/main` @ **5f3c086b** (full `5f3c086b61d5ad61f80f511367e888c13a9a2e5c`).

The chapters cite rows here by id (`F-07`). Every value below was produced by running the
command in the same row, in a clean worktree of the stamped commit, with the output pasted —
never typed. A refresh re-runs every row and re-stamps the SHA; a number that changed is a prose
edit in the chapter that cites it and, if another document carried the old number, a row in
[LEDGER.md](LEDGER.md). The block between the markers is rewritten by a generator:

```bash
pnpm handoff:facts --check     # every checkable row vs its live command; exits 1 on disagreement
pnpm handoff:facts --cite      # every `path:line` in handoff/** resolves AND lands inside the file
pnpm handoff:facts --write     # rewrite the block and re-stamp the SHA (refuses to run off a branch)
```

**FACTS records `main`, never your branch.** Three rows count things a PR can move —
F-18 (skills), F-21 (knowledge-base docs, which includes this corpus) and F-31 (commits) — and a
branch that adds a skill or a doc will disagree with them *correctly*. Do **not** pre-write those
values on the branch that moves them: a number stamped at a commit that does not exist yet is a
confident lie, and the next `--check` after the merge catches it in seconds. (This is the opposite
of the `guard:ui` §0 rule, and for a good reason — that table is a *gate* that fails the build, so
it must move with its PR; this file is a *record*, so it must follow `main`.)

**41 of the 48 rows are machine-checkable** — the other 7 print prose rather than an integer, and
`--check` names them rather than passing them silently (F-04, F-06, F-16, F-23, F-30, F-43, F-44).
F-39 joined the checkable set on 2026-08-24: its old command used `<(...)` process substitution,
which the generator's `/bin/sh` rejects outright, so it had never run — an errored command and a
prose answer are indistinguishable in the "not machine-comparable" bucket, and it sat there
reading as verified. The POSIX rewrite returns `0` and was proved fail-closed by deleting one
entry from the integration list (`0` → `1`).
The "re-derive by hand" recipe at the bottom is what the generator automates, and remains the
fallback if it is ever deleted — nothing depends on it.

Three portability rules, all learned the hard way during the first derivation and the first
fresh-hire read-through: quote
`--include='*.ts'` (unquoted, zsh expands the glob and the pipeline reports a **silent false
zero**), and prefer `git ls-tree -r --name-only HEAD -- <dir>` over a `**` glob (the glob
silently drops the top-level files of the directory — 196 vs 200 for the knowledge base), and
use `grep -F` for a literal pattern containing `$` (BSD grep on macOS mis-parses it mid-pattern
and returns nothing — a false "the file changed").

<!-- BEGIN GENERATED — do not hand-edit; re-derive with the recipe below and paste -->

| id | fact | command (run from the worktree root) | value @ 5f3c086b |
|---|---|---|---|
| F-01 | Drizzle tables | `grep -c "pgTable(" shared/schema/*.ts \| awk -F: '{s+=$2} END{print s}'` | 196 |
| F-02 | schema files | `ls shared/schema/*.ts \| wc -l` | 37 |
| F-03 | `pgEnum` declarations | `grep -o "pgEnum(" shared/schema/*.ts \| wc -l` | 1 |
| F-04 | migrations · latest | `ls migrations/*.sql \| wc -l ; ls -1 migrations/*.sql \| tail -1` | 74 · `0073_final_aus_findings_artifact` |
| F-05 | route registrar calls | `grep -cE "^\s*(await )?register[A-Za-z]+Routes\(app" server/routes.ts` | 42 |
| F-06 | route directories · sub-registrars with an `index.ts` | `ls -d server/routes/*/ ; ls server/routes/*/index.ts \| wc -l` | 5 dirs (`admin agent-broker borrower lending underwriting`) · 4 |
| F-07 | endpoint registrations under `server/routes` | `grep -rnE 'app\.(get\|post\|put\|patch\|delete)\(' server/routes --include='*.ts' \| wc -l` | 582 |
| F-08 | `isAuthenticated` references | `grep -rn "isAuthenticated" server --include='*.ts' \| wc -l` | 349 |
| F-09 | files using `requireRole(` | `grep -rl "requireRole(" server --include='*.ts' \| wc -l` | 42 |
| F-10 | role-group declarations (line numbers: STAFF, CLIENT, PARTNER, ALL, INTERNAL_STAFF) | `grep -nE "^export const (STAFF_ROLES\|CLIENT_ROLES\|PARTNER_ROLES\|INTERNAL_STAFF_ROLES\|ALL_ROLES)" shared/roles.ts \| cut -d: -f1` | 14 26 36 42 80 (8 + 2 + 2 = 12 roles; 6 internal) |
| F-11 | `inArray(` call sites | `grep -rn "inArray(" server --include='*.ts' \| wc -l` | 84 |
| F-12 | `.transaction(` call sites | `grep -rn "\.transaction(" server --include='*.ts' \| wc -l` | 39 |
| F-13 | test files on disk · integration files the node lane excludes | `git ls-files 'tests/*.test.ts' \| wc -l ; grep -cE '^\s*"tests/' vitest.config.ts` | 307 · 30 |
| F-14 | integration-lane includes | `grep -cE '^\s*"tests/' vitest.integration.config.ts` | 30 |
| F-15 | client test files (glob lane) | `git ls-files 'client/src/**/*.test.ts' 'client/src/**/*.test.tsx' \| wc -l` | 148 |
| F-16 | guards in the CI gate | `grep -oE "pnpm guard:[a-z]+" .github/workflows/ci.yml \| sort -u` | authority bundle channel citations conformance corpus coverage gating kb migrations querykeys schema seats security staleness tokens ui vocab (18; `guard:docs` deliberately absent) |
| F-17 | pre-push steps · preflight steps · checkup checks | `grep -c '^step ' .githooks/pre-push ; grep -c 'step "' scripts/preflight.sh ; grep -c '^check "' scripts/checkup.sh` | 17 · 29 · 26 (was 10 — `e49aab6d`/#660 made the unit lanes opt-in behind `PREPUSH_TESTS=1`; +the Selling Guide corpus/coverage/watch lines, 2026-08-23) |
| F-18 | skills · of which anti-autoload | `ls -d .claude/skills/*/ \| wc -l ; grep -l 'NEVER auto-load' .claude/skills/*/SKILL.md \| wc -l` | 27 · 21 |
| F-19 | agents · of which owners | `ls .claude/agents/*.md \| wc -l ; ls .claude/agents/hq-*-owner.md \| wc -l` | 59 · 41 |
| F-20 | app-guide chapters | `ls knowledge-base/handbook/app-guide/*.md \| wc -l` | 12 |
| F-21 | knowledge-base markdown files (committed) | `git ls-tree -r --name-only HEAD -- knowledge-base \| grep -c '\.md$'` | 249 — the one self-referential row: it counts this corpus too, so it rises by the size of `handoff/` the moment that merges |
| F-22 | client routes · lazy routes | `grep -c "<Route" client/src/App.tsx ; grep -c "lazy(" client/src/App.tsx` | 121 · 113 |
| F-23 | coach model calls per turn · coach tools | `grep -n "MAX_MODEL_CALLS_PER_TURN\s*=" server/services/coachingClient.ts ; grep -c 'name: "' server/services/coachTools.ts` | 4 · 10 |
| F-24 | server files mentioning Anthropic · SDK import lines | `grep -rln "anthropic" server --include='*.ts' \| wc -l ; grep -rn "@anthropic-ai/sdk" server --include='*.ts' \| wc -l` | 9 · 6 (none in `DECISION_PATH_MODULES`) |
| F-25 | loan-application statuses | `awk '/^export const LOAN_APP_STATUSES/,/\] as const/' shared/loanApplicationStatus.ts \| grep -cE '^\s*"[a-z_]+"'` | 16 (4 terminal) |
| F-26 | client route gates | `grep -oE '^  [a-zA-Z]+:' client/src/lib/routeGates.ts \| wc -l` | 10 |
| F-27 | rate-limit mounts in `app.ts` | `grep -c "rateLimit(" server/app.ts` | 11 (9 named + 2 inline) |
| F-28 | encrypted-at-rest column sites | `grep -rn "_encrypted" shared/schema/*.ts \| wc -l` | 8 (+ `credit_pulls.encryptedRawResponse`, named differently) |
| F-29 | production cron sweeps | `grep -c "cron:" .github/workflows/cron-jobs.yml` | 8 |
| F-30 | lines of TypeScript per area | `for d in server shared client/src tests; do printf '%s=' $d; find $d -name '*.ts' -o -name '*.tsx' \| xargs wc -l \| tail -1 \| awk '{print $1}'; done` | server 100,125 · shared 24,303 · client/src 114,341 · tests 60,207 |
| F-31 | commits on `main` | `git rev-list --count HEAD` | 1,252 — `HEAD`, so run it on `main`; on a branch it counts the branch |
| F-32 | storage modules | `ls server/storage/*.ts \| wc -l` | 26 files: `UsersStorage` + 23 classes that each extend the previous (23 links) + `DatabaseStorage` + two helper modules (`batchGroup.ts`, `urlaBatch.ts`) |
| F-33 | `logAudit(` call sites | `grep -rn "logAudit(" server --include='*.ts' \| wc -l` | 155 |
| F-34 | source-text tests (read a file as text) | `grep -lE 'readFileSync\(' tests/*.test.ts \| wc -l` | 70 |
| F-35 | query-key factories | `grep -cE '^export const [a-zA-Z]+Keys' client/src/lib/queryClient.ts` | 17 |
| F-36 | guard scripts · baseline files | `ls scripts/*-guard.cjs \| wc -l ; ls scripts/*baseline*.json \| wc -l` | 20 · 9 |
| F-37 | foreign keys to `loan_applications` · to `users` | `grep -rn "references(() => loanApplications.id)" shared/schema/*.ts \| wc -l ; grep -rn "references(() => users.id)" shared/schema/*.ts \| wc -l` | 95 · 138 |
| F-38 | `app.use(` mounts · server `.ts` files | `grep -c "app.use(" server/app.ts ; find server -name '*.ts' \| wc -l` | 39 · 326 |
| F-39 | test files in neither vitest lane (symmetric difference: the node lane's exclude list vs the integration lane's include list) | `{ grep -ohE '"tests/[^"]+\.test\.ts"' vitest.config.ts \| tr -d '"' \| sort -u; grep -ohE '"tests/[^"]+\.test\.ts"' vitest.integration.config.ts \| tr -d '"' \| sort -u; } \| sort \| uniq -u \| wc -l` | 0 |
| F-40 | `updatePipelineStage(` references · `recalculateDecision(` references | `grep -rn "updatePipelineStage(" server --include='*.ts' \| wc -l ; grep -rn "recalculateDecision(" server --include='*.ts' \| wc -l` | 5 · 8 |
| F-41 | regulatory-ledger entries · still carrying a blocked-network note | `python3 -c "import json;e=json.load(open('data/regulatory/regulatory-ledger.json'))['entries'];print(len(e), len([x for x in e if 'block' in (x.get('notes','') or '').lower()]))"` | 59 · 9 |
| F-42 | `complianceInvariants` describes · its | `grep -c "^describe(" tests/complianceInvariants.test.ts ; grep -c "  it(" tests/complianceInvariants.test.ts` | 16 · 55 |
| F-43 | the two deploy-job conditions, and the one that cannot fail | `sed -n '820p;893p;909p' .github/workflows/ci.yml` | `if: … == 'push' \|\| … == 'workflow_dispatch'` · `if: … == 'push'` · `continue-on-error: true` — both remain armed; `verify-deploy` reddens without failing the workflow, by design |
| F-44 | `main` protected · ruleset rules | `gh api repos/barakatammre84/homiquity-mortgage-broker/branches/main --jq .protected ; gh api repos/barakatammre84/homiquity-mortgage-broker/rules/branches/main --jq 'length'` | true · 0 — classic branch protection, not a ruleset (measured 2026-09-11; a repo setting, not a property of the commit). ⚠️ **The contexts list is unreadable from a session:** `…/branches/main/protection` answers `403 "Resource not accessible by integration"` to a non-admin token. Enforcement is proved by behaviour: merging #708/#647 returned `405 Required status check "gate (typecheck · tests · schema guard)" is expected`, and #647 merged only once brought current with `main`, so `strict` is on too. |
| F-45 | Selling Guide leaf sections · TOC entries | `cut -f3 docs/fannie-mae/selling-guide/section-index.tsv \| grep -Ec '^[A-E][0-9]?(-[0-9]+(\.[0-9]+)?)*-[0-9]{2}, ' ; tail -n +2 docs/fannie-mae/selling-guide/section-index.tsv \| wc -l` | 423 · 554 |
| F-46 | Guide link inventory: unique URLs · probeable ok · xref edges | `python3 -c "import json;s=json.load(open('docs/fannie-mae/selling-guide/links.json'))['summary'];print(s['unique_urls'],s['ok_urls'],s['xref_edges'])"` | 319 · 295 · 989 |
| F-47 | Selling Guide gate steps in ci.yml (authority guard + corpus coherence + coverage map + conformance register + extraction proof — all always-run) | `grep -cE '^      - name: Selling Guide' .github/workflows/ci.yml` | 5 |
| F-48 | acknowledged blocked sources+hosts in the Guide watch state (the procurement ratchet) | `python3 -c "import json;print(len(json.load(open('data/regulatory/selling-guide-watch-state.json'))['acknowledgedBlocked']))"` | 25 |

<!-- END GENERATED -->

## Facts the loop playbook depends on (chapter 12 cites these by id)

F-13, F-14, F-15, F-39 (the T1 collection sanity check) · F-16, F-17 (which lane runs which
guard) · F-43, F-44 (what is paused and what is required) · F-05, F-06 (where a route goes) ·
F-03, F-01 (the vocabulary rule) · F-40 (the single status writer) · F-36 (the ratchet fleet).

## Re-derive by hand

```bash
WT=/Users/ammrebarakat/Developer/Homiquity-handoff   # any clean worktree of origin/main
cd "$WT" && git fetch origin && git rev-parse --short HEAD     # the new stamp
# `pnpm handoff:facts --write` does all of the below; this is the fallback if it is gone.
# then run each command in the table above, in order, and paste the outputs.
# Rules: quote --include='*.ts'; never retype a number; if a value moved, grep the chapters for
# the old value (grep -rn "<old>" knowledge-base/handoff/*.md) and fix the prose in the same commit.
```

A value here is a **floor**, never a total: every grep counts a literal shape (a call site, a
declaration, a line) and is blind to the same thing built another way. That is the right
reading for a doc: it tells you where to look, not how many things exist.
