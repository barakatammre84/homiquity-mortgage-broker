# One application: the Core reversal — 2026-09-12

Founder decision, 2026-09-12: **this repository is the product.** Homiquity-Core will be archived
and the little it holds that is not already here will be merged in. This reverses the decision of
2026-09-11 recorded in
[2026-09-11-core-is-the-product.md](2026-09-11-core-is-the-product.md), which stands unedited as
history (TEAM_PRACTICES §2).

## Why it reversed in a day

The 2026-09-11 decision was made without knowing whether Core could be deployed. It cannot, and not
for want of configuration. Core is built to refuse to run in public, in several independent places:

- It binds to `127.0.0.1`. A hosted container would answer nothing.
- No Dockerfile, no host configuration, no deploy workflow exists. There is nothing to push.
- Uploaded documents are written to local disk with no object store. On an ordinary host every
  borrower document is destroyed on the next restart while the database still lists the file.
- Nothing ever marks an upload clean of malware, and downloads refuse anything else, so no reviewer
  could open a document even if it survived.
- The public request form switches itself off unless the host is loopback, and its API rejects any
  submission not flagged as fictional.
- There are no outbound vendor calls at all: no credit, valuation, automated underwriting, pricing,
  email, or identity checks. Its readiness code hard-codes submission-ready to false.

Its own status file states the rule plainly: no live borrower data, no hosted environment, no public
capture mode. Core sits at phase 3 of 6, and the missing phase is production operations.

Meanwhile every artifact required to originate and submit a loan exists **only here**: pricing,
pre-approval letters, the underwriting engine, automated underwriting submission, MISMO export,
the TRID disclosure clock, adverse-action notices, and FCRA credit consent. Making Core the product
would mean rebuilding and re-auditing all of it. That lengthens the path to the first funded loan
rather than shortening it.

## What comes across before Core is archived

A full comparison found Core holds very little this repository lacks; its five valuable patterns
already landed here in early September, and its two most-cited modules are 33 and 41 lines against
production-hardened equivalents here. Four items are worth taking:

| Item | Why |
|---|---|
| Browser accessibility and performance baseline | This repository has **no** automated accessibility checking across 119 routes and 348 page files, while its design system declares WCAG AA binding |
| Route manifest and static link checker | Nothing today proves a route renders or an internal link resolves |
| `AGENTS.md` | A compact agent entry point; `CLAUDE.md` is 285 lines and opens on Selling Guide procedure |
| `ACTIVE_CONTEXT.md` | A single "where we are right now" file; status is currently spread across three documents |

Core's design direction is adopted separately (black primary action, no dark chrome) and tracked in
the design system, not imported as a document set.

## Sites corrected in this change

`CTO_ROADMAP.md` lines 5 and 32-33 and its evidence list; `README.md` line 65;
`knowledge-base/README.md` line 24; and the banner on
[specs/CORE_INTEGRATION.md](../specs/CORE_INTEGRATION.md), which is current again.

## The lesson worth keeping

Both reversals came from deciding before checking. The 2026-09-11 decision rested on an assessment
of which local folder was authoritative; nobody had asked whether the newer codebase could be
deployed at all. The reversal came thirty minutes after somebody read its server startup code.

Core is to be archived with its **current private visibility**; archiving makes it read-only and
does not change who can see it. The reuse record in `specs/CORE_INTEGRATION.md` carries two
permalinks into it; they keep resolving for anyone with access to that repository. Copying the two
referenced files into this repository's docs is the follow-up that makes the record self-contained.
