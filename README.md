# Homiquity

> **Repository identity — read this first if you are an agent or new here.**
> This is `barakatammre84/homiquity-mortgage-broker`, and it is **the product**. It serves
> <https://www.homiquity.com> and deploys from `main` on every merge.
>
> Two sibling repositories exist and are **not** this one:
>
> | Repository | What it is |
> |---|---|
> | `barakatammre84/Homiquity-Core` | A rebuild, **retired** by founder decision 2026-09-12. Do not build there. It cannot be deployed: it binds to loopback, has no hosting configuration, and destroys uploaded documents on restart ([log](knowledge-base/logs/2026-09-12-one-application.md)) |
> | `barakatammre84/aquistionbyrealiquity` | A **separate business** in Python, becoming a Realiquity sub-product. Unrelated to the mortgage platform |
>
> Everything called "Homiquity" that is not this repository is one of those two. If a document,
> a saved project or an agent points somewhere else, it is pointing at the wrong place.
> Working here? Start at **[AGENTS.md](AGENTS.md)**.

An AI-native mortgage **brokerage** platform: borrower intake (digital 1003), document
collection, deterministic underwriting, MISMO 3.4 packaging, and delivery of complete
loan files to wholesale lenders. Deployed at <https://www.homiquity.com> (Railway — one persistent
Node process serving both the API and the static client; `www` is the canonical host).

**Current status (2026-08-06): company NMLS licensure is real — NMLS #427468, Illinois
(IL Residential Mortgage License #3423789 — `shared/companyIdentity.ts`, #154/#201/#419) — and the site remains in pre-launch gated mode
pending the founder go-live flips.** The public site is live in production behind the
**pre-launch gate** (`server/services/prelaunchGate.ts` — flag-driven, with a fail-safe
that re-gates production if the NMLS id ever reads `PENDING`), so a stranger reaches
educational content and a waitlist, never a mortgage-solicitation surface. The full
commercial machine — intake, deterministic pre-approval, LO claim/handoff, dual-AUS run,
MISMO packaging, wholesale delivery — is **built and verified end-to-end behind the gate
against simulated vendors** (2026-07-12 founder walkthrough, PRs #135–#139; see
[BETA_GO_LIVE_READINESS.md](knowledge-base/runbooks/BETA_GO_LIVE_READINESS.md)), one config
flip from go-live (`VITE_PRELAUNCH_GATED` + beta access code — founder-only; both are Railway
service variables, and the `VITE_*` one is baked into the client bundle at build time, so flipping
it takes a **redeploy**, not a restart). Nothing
commercial is legally real until that flip — see
[ASSUMPTIONS.md](knowledge-base/governance/ASSUMPTIONS.md) for what is real, simulated, or
pending, and [CTO_ROADMAP.md](CTO_ROADMAP.md) for the live work queue.

## Quick start

```bash
corepack enable            # one-time: activates the pinned pnpm (ships with Node)
pnpm install && pnpm dev   # port 5001 comes from .env (PORT=5001) — full setup in LOCAL_DEV.md
pnpm check                 # typecheck
pnpm test                  # unit tests
```

Dev logins: see [TEST_ACCOUNTS.md](knowledge-base/runbooks/TEST_ACCOUNTS.md) (requires `DEV_TEST_PASSWORD` in `.env`).

## Which document do I trust?

**All documentation lives in [`knowledge-base/`](knowledge-base/)** (see its
[index](knowledge-base/README.md)). Three *living* docs stay at the repo root: this **README.md**
(landing), **[CLAUDE.md](CLAUDE.md)** (Claude Code auto-loads it here), and
**[CTO_ROADMAP.md](CTO_ROADMAP.md)** (the live work queue). A fourth root file,
**[PRODUCT_SPINE.md](PRODUCT_SPINE.md)**, is a one-line pointer stub kept only so old links
resolve — its content moved to [L1](knowledge-base/L1_VISION_AND_SCOPE.md); do not add to it.
Regulatory source binaries stay in **[`docs/`](docs/)**; app-data (not docs) in
`data/regulatory/`.

**Starting work?** Read [AGENTS.md](AGENTS.md), then
[knowledge-base/ACTIVE_CONTEXT.md](knowledge-base/ACTIVE_CONTEXT.md) — the short entry point and
the current state of the system. Everything below is what they route into.

Two axes of authority:

- **Precedence** (which doc wins on intent): **L1 → L2 → L3** —
  L1 Vision & Scope (scope/cut-line) → L2 Compliance & Logic (guardrails override features) →
  L3 feature specs (cite L1 + L2). See the [KB index](knowledge-base/README.md) for their status.
- **Freshness** (which doc is current): the tiers below. **When a document disagrees with the
  code, the code is the truth and the document is a bug** — fix or flag it.

### Tier 1 — Live sources of truth (kept current, trust these)

| Document | What it governs |
|---|---|
| [CTO_ROADMAP.md](CTO_ROADMAP.md) | **The work queue.** The ordered §0–§5 queue. Updated in the same commit that completes an item. |
| [CLAUDE.md](CLAUDE.md) | Non-negotiable session rules: compliance-first doctrine, architecture ground rules, DB rules. |
| [handbook/DEVELOPER_PLAYBOOK.md](knowledge-base/handbook/DEVELOPER_PLAYBOOK.md) | The deep engineering map — layers, engines, conventions. |
| [handbook/app-guide/](knowledge-base/handbook/app-guide/) | The 12-chapter subsystem handbook. Start at [01-start-here](knowledge-base/handbook/app-guide/01-start-here.md). |
| [governance/ASSUMPTIONS.md](knowledge-base/governance/ASSUMPTIONS.md) | The fact/assumption register: what is simulated, pending, or verified-when. |

Core integration direction and acceptance gates: [Core capabilities inside Homiquity](knowledge-base/specs/CORE_INTEGRATION.md). Confirmed 2026-09-12: this repository is the product; the Homiquity-Core repository is being archived and its remaining value merged here.

### Tier 2 — Doctrine (decisions; change deliberately, never casually)

| Document | What it decides |
|---|---|
| [L1 — Vision & Scope](knowledge-base/L1_VISION_AND_SCOPE.md) *(supersedes `PRODUCT_SPINE.md`)* | Product modules, roles, the core loop, AI boundaries (AI never decides lending outcomes). |
| [governance/TEAM_PRACTICES.md](knowledge-base/governance/TEAM_PRACTICES.md) | How every session works: doc-staleness rules, branch/worktree lifecycle, definition of done, push policy. |
| [compliance/UNDERWRITING_SCENARIOS.md](knowledge-base/compliance/UNDERWRITING_SCENARIOS.md) | Living scenario registry — the "no citation → not implemented" contract. |
| [governance/AI_GOVERNANCE_POLICY.md](knowledge-base/governance/AI_GOVERNANCE_POLICY.md) · [governance/MODEL_RISK_GOVERNANCE.md](knowledge-base/governance/MODEL_RISK_GOVERNANCE.md) | Adopted AI governance policy + model inventory under it. |
| [compliance/REGULATORY_MONITORING.md](knowledge-base/compliance/REGULATORY_MONITORING.md) | How statutory constants stay verifiably aligned with official sources. |
| [compliance/SCENARIO_ARCHITECT.md](knowledge-base/compliance/SCENARIO_ARCHITECT.md) | Operating instructions for scenario/guardian work. |
| [compliance/SAFE_MLO_COMPLIANCE_MAP.md](knowledge-base/compliance/SAFE_MLO_COMPLIANCE_MAP.md) · [compliance/COMPLIANCE_COUNSEL_REVIEW.md](knowledge-base/compliance/COMPLIANCE_COUNSEL_REVIEW.md) | SAFE Act / MLO advertising crosswalk + the standing compliance-counsel review. |
| [runbooks/PRE_PRODUCTION_OPS_ROUTINES.md](knowledge-base/runbooks/PRE_PRODUCTION_OPS_ROUTINES.md) | The founder's 2026-07-04 pre-launch operating doctrine. **Its 5-routine launch suite is not the live suite** — that suite stopped running on 2026-07-04 and stayed dormant five weeks ([routines/CHARTER.md](knowledge-base/routines/CHARTER.md) §0). The live cadence is CHARTER §3/§3a; read this file for the doctrine behind the routines, never for what runs today. |
| [docs/fannie-mae/](docs/fannie-mae/) · [docs/nmls/](docs/nmls/) · [docs/nmls-safe/](docs/nmls-safe/) | Official GSE + NMLS reference documents — never work from memory on ULDD/UCD/URLA/MISMO or NMLS licensing. |
| [handbook/design/DESIGN_SYSTEM.md](knowledge-base/handbook/design/DESIGN_SYSTEM.md) | The design system — tokens, type scale, layout, capture-flow standard, four-question gate. |
| [compliance/security/threat_model.md](knowledge-base/compliance/security/threat_model.md) | Security threat model. |

### Tier 3 — Runbooks (operational how-to)

[runbooks/LOCAL_DEV.md](knowledge-base/runbooks/LOCAL_DEV.md) · [runbooks/CICD.md](knowledge-base/runbooks/CICD.md) · [runbooks/ROLLBACK.md](knowledge-base/runbooks/ROLLBACK.md) · [runbooks/TEST_ACCOUNTS.md](knowledge-base/runbooks/TEST_ACCOUNTS.md)

### Tier 4 — Dated snapshots (true as of their date only)

Everything under [knowledge-base/logs/](knowledge-base/logs/) — currently the dated
adjudication logs — external-pitch verdicts, postmortems, financial audits. The dead UX-audit
routine was archived 2026-08-06 to [archive/ux-audit/](knowledge-base/archive/ux-audit/). The
launch-era operational logs (founder-routines, lo-audit) and one-time platform assessments
(2026-07-02 → 07-06) were quarantined 2026-07-08 to
[knowledge-base/archive/](knowledge-base/archive/) (banner-marked; never act on them).
The [governance/ARMED_LAUNCH_CHARTER_2026-07-07.md](knowledge-base/governance/ARMED_LAUNCH_CHARTER_2026-07-07.md)
is filed under `governance/` for its locked launch *decisions*, but its execution log is a dated
snapshot — read its status banner, not it, for the current launch state.

**Snapshot rule:** these are never silently edited to look current. When reality moves on,
they get a dated **superseded/status banner** at the top pointing to the live source.
Verify any "X is missing" claim against the code before acting on it.

### Tier 5 — Archive

[knowledge-base/archive/](knowledge-base/archive/) — factually obsolete documents retained for
history. Never act on these.

## Repository ground rules (summary — full rules in CLAUDE.md)

- `main` is production, and Railway still builds and deploys every merge (`railway.json`) —
  observed 2026-08-20: prod `/api/health` served `d8316ec1`, the `origin/main` tip.
  ⚠️ **CI stopped proving that for two days.** PR #608 (2026-08-20) paused both prod jobs for
  local-only development (`verify-deploy` `if: false`, `migrate-prod` `workflow_dispatch`-only); PR #669
  (`76c96751`, 2026-08-22) re-armed them — `migrate-prod` applies on every push to `main`
  ([`ci.yml`](.github/workflows/ci.yml) `:681`) and `verify-deploy` polls `/api/health` after each
  (`:754`) — but `verify-deploy` is `continue-on-error: true` (`:770`), deliberately, so its red blocks
  nothing. The rule that survived the pause is still the rule: a green check is not proof the merge
  shipped — a failed Railway build leaves the previous container serving — so only the `commit`
  field of `/api/health` proves prod is on your code. Read that job's result; never assume it.
  ⚠️ **Re-measure branch protection before trusting the `gate` check.** It read **empty** on
  2026-08-20 (`gh api repos/barakatammre84/Homiquity/branches/main/protection` → `contexts: []`,
  `enforce_admins: true` over zero checks) and was re-armed by 2026-08-23: `contexts` = the `gate`
  check, `strict: true` — a PR must be green *and* current with `main` to merge. The measurement
  is the truth on the day you run it; land work via short-lived PR branches through the `gate`
  check regardless. Rollback: [runbooks/ROLLBACK.md](knowledge-base/runbooks/ROLLBACK.md).
- `client/` and `server/` never import from each other; both import from `shared/`.
- Vendor integrations are deterministic simulations behind adapters until real contracts exist.
- Borrower PII goes through `server/services/encryptionService.ts` / `ssnVault.ts` + audit log.
- Migrations are hand-authored SQL in `migrations/` (`pnpm db:migrate`). Never `db:push`
  from a worktree against the shared dev database.
