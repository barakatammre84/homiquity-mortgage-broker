# AGENTS.md — Homiquity

The entry point for any agent or person starting work here. Read this, then
[`knowledge-base/ACTIVE_CONTEXT.md`](knowledge-base/ACTIVE_CONTEXT.md). Open nothing else until the
table in §3 says so.

[CLAUDE.md](CLAUDE.md) remains binding and is the authority on the compliance rails; this file is a
router into it, not a replacement. Where the two disagree, CLAUDE.md wins.

## 1. Canonical location

- Repository `barakatammre84/homiquity-mortgage-broker`. **This is the product.** It is deployed to
  Railway on every merge to `main` and serves `https://www.homiquity.com`.
- `barakatammre84/Homiquity-Core` is **retired — do not build there** (founder decision
  2026-09-12, `knowledge-base/logs/2026-09-12-one-application.md`). It is not yet archived on
  GitHub and is still writable, so "nobody can commit there" is not a protection you have.
  Taking its remaining value across is in progress, not done.
- `barakatammre84/homiquity-acquisitions` is a **separate business** in Python, becoming a
  Realiquity sub-product. Despite the name it has nothing to do with the mortgage platform.
- Work on a branch cut from `main`. One session, one worktree, one branch
  (TEAM_PRACTICES §4). Never commit to `main`.
- **Name the branch for the agent that owns it**: `claude/<slice>` or `codex/<slice>`. Both are in
  live use and neither was written down until now, which made `git for-each-ref` unreadable as a
  record of who is doing what. Bots keep their own prefixes (`dependabot/`); `archive/` is never
  deleted by the cleanup script.

## 2. Startup procedure

**You are not the only agent in this repository.** Claude and Codex both work here, and they cannot
see each other's editors. Steps 3 and 4 are what stop two agents building the same thing twice —
which has already happened, and cost a day.

1. `git fetch origin && git status -sb` — if behind, dirty, or carrying changes this task did not
   create, STOP and report. Do not tidy it.
2. `git config core.hooksPath .githooks` — arms this clone's pre-push gate. That setting lives in
   `.git/config`, which is per-clone and untracked, so **a fresh clone or a new worktree starts
   with the gate silently off**. `node scripts/hooks-installed-guard.cjs` checks it; `pnpm checkup`
   and `pnpm preflight` both run that check.
3. **Find out who else is working, strongest signal first:**
   1. `origin/main` — what already landed.
   2. **Open pull requests.** A file with an open PR against it is claimed by that PR whether or not
      anyone wrote a row. This outranks the board.
   3. [`knowledge-base/routines/REGISTER.md`](knowledge-base/routines/REGISTER.md) — the claim
      board, for intent that has not landed yet. Claims go stale at 24 hours unless an open PR
      stands behind them.
4. **Claim before you write.** Add a row to that board naming your target files, branch and intent,
   and commit it on your branch. Then respect what you find:
   - **No overlap** → proceed.
   - **Adjacent** (same area, different files) → proceed, name the adjacency in your row, and keep
     your diff inside the files you listed.
   - **Direct overlap** (same files) → do **not** race. Take different work, or coordinate.

   Release the row when you finish, in the same pull request as the work — shipped, abandoned or
   failed. A board nobody clears becomes a board nobody reads.
5. Read `knowledge-base/ACTIVE_CONTEXT.md`: what is deployed, what is blocked, which providers are
   real versus simulated, and which settings are unverified. It states facts, never rules, and it
   deliberately does **not** list in-flight work — step 3 is where that lives, because a hand-copied
   snapshot of open pull requests is a claim about the past dressed as the present.
6. Open only the documents §3 maps to your area.
7. State the completion promise and what is out of scope before editing.
8. Implement one bounded outcome. No drive-by refactors or renames.
9. Verify proportionately (§4), then open a PR sized to one CI cycle (TEAM_PRACTICES §4).

## 3. Which documents to open

| Working on | Open |
|---|---|
| Anything | `knowledge-base/ACTIVE_CONTEXT.md` |
| Backend endpoints, routes, validation | the `api-routes` skill, `knowledge-base/handbook/app-guide/` |
| UI, styling, components | the `ui-components` skill, `knowledge-base/handbook/design/DESIGN_SYSTEM.md` |
| Mortgage math, pricing, underwriting | the `mortgage-calculations` skill |
| Public marketing and SEO surfaces | the `seo-content` skill |
| Fannie Mae delivery, ULDD, UCD, MISMO | CLAUDE.md "Compliance first", `docs/fannie-mae/` |
| NMLS licensing | `docs/nmls/` — never from memory |
| Regulation Z, QM, TRID tolerances | `docs/reg-z/` — never from memory |
| Database schema or migrations | CLAUDE.md "Database", `knowledge-base/runbooks/DB_MIGRATIONS.md` |
| What to build next, and why | `CTO_ROADMAP.md` |
| How we work: branches, PR size, done | `knowledge-base/governance/TEAM_PRACTICES.md` |
| Who else is writing which files right now | `knowledge-base/routines/REGISTER.md` (the claim board — humans and agents both) |
| Local setup, ports, seeded logins | `knowledge-base/runbooks/LOCAL_DEV.md` |
| Onboarding from zero | `knowledge-base/handoff/` |

Everything is indexed in [`knowledge-base/README.md`](knowledge-base/README.md). An unindexed doc is
an unread doc, and `pnpm guard:kb` enforces it.

## 4. Verification

`pnpm check` always. `pnpm test` for logic. `pnpm test:integration` against a worktree server on
5002 for endpoint behaviour. `pnpm checkup` before opening a PR — it runs the guards CI runs plus
the ones CI structurally cannot. Full definition of done: TEAM_PRACTICES §5.

Never claim a UI change was verified in a browser unless you ran `scripts/browser-probe.cjs` and
pasted its output (routines/CHARTER.md §10).

## 5. Rules that bind every session

- **No new dependencies.** `package.json` and `pnpm-lock.yaml` are off limits (CHARTER §6). Adding
  one is a founder decision, not an implementation detail.
- **Simulated is not real.** Credit, valuation, automated underwriting, pricing and lender delivery
  are deterministic simulations. No simulated result may satisfy an approval, disclosure, lock or
  lender-readiness gate. Never describe a capability as live unless `ACTIVE_CONTEXT.md` says it is.
- **No source, no regulated rule.** A threshold that decides money or eligibility is verified
  against the captured source this run, cited by locating detail, or it is flagged and not asserted.
- **Dated records are immutable.** `knowledge-base/logs/`, `archive/` and routine reports are never
  rewritten; supersession is a dated banner at the top (TEAM_PRACTICES §2).
- **Decisions update the document they change.** Add the record where it belongs; never create a
  new summary or plan file to hold a decision.
- **Security-sensitive changes need review before merge.** The binding trigger list is
  TEAM_PRACTICES §9.

## 6. Finishing

Report what changed, which checks ran and what they printed, what remains, and whether
`ACTIVE_CONTEXT.md` or `CTO_ROADMAP.md` needs updating. Do not merge or deploy unless the task says
so.
