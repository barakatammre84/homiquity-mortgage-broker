# Active context

> **Freshness:** last verified 2026-09-12 · review every 14 days — this file goes stale faster than
> anything else in the tree, and a stale status file is worse than none.

Where the project is **right now**. This file states facts, never rules. Rules live in the documents
[AGENTS.md](../AGENTS.md) §3 maps. Direction lives in [CTO_ROADMAP.md](../CTO_ROADMAP.md). History
lives in [logs/](logs/) and is never rewritten.

## Snapshot

- **Deployed:** Railway project `Homiquity`, production environment, service `Homiquity`, one
  replica in `us-east4`. Latest deployment SUCCESS at 2026-09-11 08:42 UTC, built from `0bf2112`,
  a docs-only commit on the audited code baseline `50b496d`. Custom domain `www.homiquity.com`.
  The apex `homiquity.com` is not on Railway.
- **Every merge to `main` builds and deploys.** A green check is not a shipped deploy; only the
  `commit` field of `/api/health` proves what is serving.
- **Company licensure:** Homiquity Mortgage Corporation, NMLS 427468, Illinois Residential Mortgage
  License 3423789. **Illinois only** — `LICENSED_STATES` rejects out-of-state property at the
  pre-approval letter.
- **One codebase.** Homiquity-Core was retired by founder decision on 2026-09-12; this repository
  is the product. Archiving Core on GitHub is pending and leaves it private. See
  [logs/2026-09-12-one-application.md](logs/2026-09-12-one-application.md).

## Readiness verdict

`runbooks/PHASE_0_TECH_READINESS.md` records **NOT PASSED — controlled synthetic testing only**,
reviewed 2026-09-08 against baseline `958d7cf2`. Five high and five medium findings are verified and
open. Zero gate rows carry retained evidence. Until that changes, mortgage-file testing stays
controlled and synthetic.

"Built" never means ready to run the business. No simulated credit, valuation, automated
underwriting, pricing or lender result may satisfy a verified decision or a lender-acceptance gate.

## ⚠️ Unverified production settings

Three Railway values could not be read from a session (only variable names are visible). Each
changes what the live site does. **Verify in the Railway dashboard before relying on any of them.**

| Variable | Why it matters |
|---|---|
| `PRELAUNCH_GATED`, `VITE_PRELAUNCH_GATED` | Since the company NMLS id stopped reading `PENDING`, the automatic licensing fail-safe no longer fires. These two strings are now the only thing holding the application funnel closed. `VITE_` is build-time: changing it needs a redeploy. |
| `CREDIT_VENDOR_MODE` | Present in production. If its value is `simulation`, production will fabricate tri-bureau scores, violating the Phase 0 simulation fence on the most consequential data element. |

`BETA_ACCESS_CODE` is **not** set, so the invite-code lock screen is a no-op and `/robots.txt` is not
suppressing indexing.

## Provider reality

| Capability | State |
|---|---|
| Email (SendGrid) | **Live** — real mail leaves the system |
| Document extraction (Anthropic) | **Live** — real documents reach a real model |
| Object storage (GCS) | **Configured** — lifecycle not yet proven in production |
| Scheduled jobs | **Configured** — `CRON_SECRET` present |
| Credit report | **Simulated**, and refuses to fabricate in production unless `CREDIT_VENDOR_MODE` permits it |
| Valuation / AVM | **Dead** — `RAPIDAPI_KEY` absent; live endpoints 503 |
| Automated underwriting (DU/LPA) | **Simulated** — a key would cause a refusal, not a call |
| Pricing / rate sheets | **Simulated** — every quote comes from a seeded demo company |
| Lender delivery | **Simulated** — `submissionReady` is false by construction |
| Plaid | **Absent** — real code, no credentials; asset and income verification is documents-only |
| SMS | **Inbound signature verification only** — no send path |
| Error monitoring (Sentry) | **Absent** — failures during a real session are invisible |
| Content Security Policy | **Report-only** — observed, not enforced |

One consequence worth knowing: because credit is simulated, the system **refuses to deny anyone**.
It correctly will not write an adverse-action notice it cannot make truthful.

## Open founder decisions

| Decision | Blocks |
|---|---|
| Which wholesale lender is the first approved receiver | Everything downstream of a file: submission, lock, closing, funding |
| Who owns the loan-officer, processing, underwriting-review and closing seats | Taking a real application; the company licence does not authorise an unlicensed individual |
| Which verification and pricing steps are contracted vs documented-manual for file one | Pre-approval accuracy and disclosure |
| Pilot borrower profile and licensed state | Scope of the controlled pilot |
| Four counsel items in `compliance/LAUNCH_COUNSEL_PACKET.md` | Opening the funnel |
| Whether to add `axe-core` as a dev dependency | Automated accessibility checking; CHARTER §6 bars new dependencies without a founder call |

## Known gaps between documents and code

- **No automated accessibility or route-reachability checking** across 119 routes and 348 page
  files, while `handbook/design/DESIGN_SYSTEM.md` declares WCAG AA binding and publishes a contrast
  table to two decimal places. `scripts/browser-probe.cjs` and `guard:ui` both say in their own
  headers that they measure no contrast and are not an accessibility audit.
- **The design direction is mid-change.** A founder decision of 2026-09-12 adopts a black primary
  action colour in place of emerald `#047857`, and removal of dark chrome. Neither has landed on
  `main`; both are in an open pull request together with a browser contrast harness.
- `governance/ASSUMPTIONS.md` rows for SendGrid, object storage and the prelaunch fail-safe were
  written before the current Railway configuration and understate what is now present.
- Phase 0 evidence table holds only its example row; no gate has retained evidence.

## Do not

- Take live borrower data, or treat a simulated provider result as real.
- Describe a capability as live, tested, deployed or launched unless this file says so.
- Flip the prelaunch flags without the Phase 0 verdict changing and counsel sign-off.
