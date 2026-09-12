# AGENTS.md — Homiquity

The entry point for any agent or person starting work here. Read this, then
[`knowledge-base/ACTIVE_CONTEXT.md`](knowledge-base/ACTIVE_CONTEXT.md). Open nothing else until the
table in §3 says so.

[CLAUDE.md](CLAUDE.md) remains binding and is the authority on the compliance rails; this file is a
router into it, not a replacement. Where the two disagree, CLAUDE.md wins.

## 1. Canonical location

- Repository `barakatammre84/homiquity-mortgage-broker`. **This is the product.** It is deployed to
  Railway on every merge to `main` and serves `https://www.homiquity.com`.
- `barakatammre84/Homiquity-Core` is **archived**. Do not build there. Its remaining value was
  merged here on 2026-09-12 (`knowledge-base/logs/2026-09-12-one-application.md`).
- Work on a branch cut from `main`. One session, one worktree, one branch
  (TEAM_PRACTICES §4). Never commit to `main`.

## 2. Startup procedure

1. `git fetch origin && git status -sb` — if behind, dirty, or carrying changes this task did not
   create, STOP and report. Do not tidy it.
2. Read `knowledge-base/ACTIVE_CONTEXT.md`: what is deployed, what is in flight, what is blocked,
   and which settings are unverified.
3. Open only the documents §3 maps to your area.
4. State the completion promise and what is out of scope before editing.
5. Implement one bounded outcome. No drive-by refactors or renames.
6. Verify proportionately (§4), then open a PR sized to one CI cycle (TEAM_PRACTICES §4).

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
