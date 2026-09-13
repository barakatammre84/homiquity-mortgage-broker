# Homiquity-Core is the product — 2026-09-11

Founder decision, 2026-09-11, given in session: **Homiquity-Core
(`barakatammre84/Homiquity-Core`) is the product; this repository is the legacy reference and
source library.** This reverses the direction recorded here on 2026-09-04 in
[specs/CORE_INTEGRATION.md](../specs/CORE_INTEGRATION.md) §1 ("the existing Homiquity application
remains the product host"). Nothing about the five integrations that landed here is withdrawn —
they shipped and they run. What is withdrawn is the direction that future product work continues
in this repository.

## Why this was urgent

The founder's assessment that day named the real defect: agents receive several generations of
product guidance and work from the wrong repository copy. Both repositories claimed to be the
product. Core's charter called this repo a "legacy reference" (2026-08-31); this repo's roadmap
called itself the product host in text dated 2026-09-11. Whichever an agent opened first became
its truth.

Core resolved its half first. Between 2026-09-09 and 2026-09-11 it merged five pull requests that
reset its documentation authority: `AGENTS.md` as a ~4.7 KB entry point (replacing "read the
1,426-line charter in full"), `ACTIVE_CONTEXT.md` for current state, `ROADMAP.md` for sequence,
`DESIGN_SYSTEM.md` as the sole visual authority, status headers on every document, thirty
historical records moved behind `docs/history/README.md`, and `pnpm docs:check` enforcing headers
and link integrity in CI. It also landed an environment contract (`pnpm env:setup`,
`pnpm env:health`) and the first UI verification gates. Core's standing record that this
repository is a source library is D-001, unchanged since 2026-08-31.

This log records the other half: removing the contrary direction from here.

## Changed

| File | Was | Now |
|---|---|---|
| [specs/CORE_INTEGRATION.md](../specs/CORE_INTEGRATION.md):1 | no banner | dated ⚠️ SUPERSEDED banner; body retained unchanged (TEAM_PRACTICES §2) |
| [CTO_ROADMAP.md](../../CTO_ROADMAP.md):5 | "one Homiquity application with Core capabilities inside it" | Core is the product; this repo is the legacy reference; phase gates retained until re-sequenced |
| [CTO_ROADMAP.md](../../CTO_ROADMAP.md):32-33 | "Core remains part of Homiquity. A separate Core product would duplicate…" | engines, tests and operating evidence port into Core under Core's migration rule |
| [CTO_ROADMAP.md](../../CTO_ROADMAP.md):381 | "Current evidence: [Core integration] · …" | link dropped so no reader is routed to a superseded spec |
| [README.md](../../README.md):65 | "Core integration direction and acceptance gates: …" | states the 2026-09-11 direction; marks the spec superseded |
| [knowledge-base/README.md](../README.md):24 | "founder-approved sequence for bringing Core review and evidence capabilities into the existing Homiquity app" | marked superseded; retained as a dated record |

Edits to `CTO_ROADMAP.md` are in place, per its own maintenance rule at :389-393 — remove
completed direction, do not append closure history.

## Watch out: "Core" means two things here

In [CTO_ROADMAP.md](../../CTO_ROADMAP.md):148 ("Core capability map") and :162 ("Core intelligence
build order"), and throughout
[feature-review/CORE_INTELLIGENCE_AUDIT_2026-09-08.md](../feature-review/CORE_INTELLIGENCE_AUDIT_2026-09-08.md),
"core" means *this application's own core intelligence* — not the Homiquity-Core repository. Those
were deliberately left alone. Renaming them is a follow-up, not part of this change.

## Not done here

- No code changed. `shared/core/reviewValidity.ts` still carries its port note and still runs.
- Whether this repository's own build is frozen or continues in maintenance is a founder call; the
  wording chosen ("retained until re-sequenced under Core's roadmap") assumes maintenance.
- Core's `ACTIVE_CONTEXT.md` was one merge stale when checked (it recorded `e8a1520`, PR #9, while
  `main` was `163db3b`, PR #10), and Core's `PROJECT_CHARTER.md`:1099 gives this repo's checkout as
  `…/homiquity-mortgage-broker/homiquity`, a nested directory that does not exist. Both are Core's
  to fix; flagged, not touched from here.
