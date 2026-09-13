# 04 — API Surface

All API endpoints live under `/api/*`, return JSON, and (where protected) use
**session-cookie auth** — there are no API keys or JWTs for first-party calls.
Unknown `/api/*` paths hit a JSON 404 catch-all; everything else falls through
to the SPA.

## System endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Liveness + DB connectivity (200 ok / 503 if DB unreachable). Use this for uptime checks and post-deploy smoke tests. |
| `POST /api/test-login` | Dev-only login as seeded test accounts (404s in production). |
| `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/user`, logout | Email/password + session (see doc 06). |
| `/api/auth/<provider>/…` | Social OAuth (Google, LinkedIn, Apple) via Passport. |

## Route domains

Each file in [`server/routes/`](../../../server/routes/) registers one domain in
`registerRoutes()` ([`server/routes.ts`](../../../server/routes.ts)). The four
largest domains are **directories** of sub-registrars (split 2026-07-17,
#193/#202/#207/#217): their `index.ts` calls the group registrars **in the
original registration order** — Express matches in registration order, so that
sequence is a correctness invariant. Add a route to the matching group file.
Endpoint counts give you a sense of surface area (counts are approximate —
grep a file to confirm):

| File | ~Endpoints | Domain |
|------|-----------:|--------|
| `borrower/` (14 groups) | 121 | The borrower portal: applications, URLA form sections, dashboard data, pre-approvals, invites, Plaid verification, partner orders |
| `agent-broker/` (6 groups) | 47 | Agent/broker portal: referrals, invites, deal visibility, revenue tools |
| `admin.ts` | 36 | Admin panel: users/roles, config, audit, automation |
| `admin/pricingPolicy.ts` | 5 | Platform fee schedule (append-only, versioned) + wholesale comp bands — the two halves of one Reg Z points-and-fees budget, editable without a deploy |
| `compliance.ts` | 33 | Consents, credit pulls, adverse action, data retention, disclosures |
| `lending/` (8 groups) | 33 | Loan pipeline operations, letters, MISMO export, intake + status machine |
| `task-engine.ts` | 23 | Staff task engine: rules-driven task creation/assignment |
| `intelligence.ts` | 23 | Borrower graph, state machine, lender matching, readiness |
| `rate-sheets.ts` | 20 | Wholesale rate sheets & pricing adjustments |
| `policy-ops.ts` | 19 | Underwriting policy operations/admin |
| `underwriting/` (7 groups) | 35 | Run underwriting, decisions, pipeline/conditions, lender submissions, LE delivery |
| `data-intelligence.ts` | 16 | Analytics events, funnels, outcomes, predictions, benchmarks |
| `property.ts` | 12 | Properties CRUD, affordability analysis |
| `underwriting-rules.ts` | 10 | Rules DSL CRUD/testing |
| `partners.ts` | 10 | PartnerHub (PH-1/PH-2): realtor registration + admin approval queue, unified attribution, masked partner pipeline behind borrower consent |
| `coach.ts` | 8 | AI coach conversations |
| `taxIntelligence.ts` | 8 | UAL income engine (P2–P6): situation profile, income-path evaluations, review workbench, income analysis package |
| `aus.ts` | 2 | GSE/AUS orchestration: Plaid asset webhook -> verification_reports; DU casefile submit -> Day 1 Certainty + commitment letter |
| `documents.ts` | 7 | Upload URL issuance, document metadata, extraction triggers |
| `lookup-matrix.ts` | 6 | Lookup grid management |
| `geocode.ts` | 4 | Google Maps proxy: autocomplete, details, validation |
| `staff-invites.ts` | 4 | Staff invitation flow |
| `notifications.ts` | 4 | User notifications |
| `listings.ts` | 3 | External property listings search (Redfin/RapidAPI) |
| `calculators.ts` | 2 | Mortgage calculators |
| `jobs.ts` | 6 | Scheduled lifecycle jobs: refi/equity scans, adverse-action delivery, closed-loan graduation |
| `cpaPartners.ts` | 6 | CPA partner portal: self-registration, referral-code validate/apply, partner self-view (inviter-only) |
| `leads.ts` | 4 | Public lead intake (`POST /api/leads`, TrustedForm-gated + rate-limited) + staff list/detail + admin delete |
| `market-data.ts` | 3 | Market-data moat: competitor benchmark, undercut quote, risk profile |
| `seo.ts` | 3 | SEO engine: DB-driven sitemap, bot head-injection/meta, JSON-LD (#91) |
| `taxInsights.ts` | 2 | Tax Return Insight pipeline: consumer-direct upload → readiness signals |
| `cockpit.ts` | 2 | LO Command Center (LO-1): `/api/staff/signals` feed + per-application cockpit hydration |
| `webhooks.ts` | 1 | Inbound provider webhooks (SMS STOP/opt-out; provider-agnostic) |
| `monitoring.ts` | 1 | Client error intake (`/api/client-errors`) → server-side Sentry reporter |
| `shell.ts` | 1 | Consolidated badge counts for the authenticated app shell |
| `scenarios.ts` | 1 | LO-2 What-If Scenario Simulator: deterministic scenario runs (`scenario_runs`) |
| `comms.ts` | 1 | LO-5 comms compliance lint (deterministic Reg Z/Reg N lexicon) |

To enumerate a domain's exact endpoints, grep it (use `-r` on the split
directories):

```bash
grep -rnE 'app\.(get|post|put|patch|delete)\(' server/routes/borrower/ | less
```

## Authorization pattern

Handlers protect themselves with middleware from [`server/auth.ts`](../../../server/auth.ts):

- `isAuthenticated` — any logged-in user; also refreshes `req.user.role` from
  the DB so role changes take effect without re-login.
- `isAdmin` — admin only.
- `requireRole("staff", "admin", …)` — allow-list of roles.

Rule of thumb when adding endpoints: **public data → no middleware; anything
borrower-specific → `isAuthenticated` + verify the resource belongs to
`req.user.id`; staff/admin operations → `requireRole`.** Several existing
handlers also do per-resource ownership checks inline — copy that pattern, and
never trust a client-supplied user id.

## Conventions

- Validate request bodies with Zod schemas (often `createInsertSchema` from
  the shared Drizzle schema).
- Errors: `res.status(4xx).json({ error: "..." })`; unexpected errors bubble to
  the central error handler.
- Rate limits: auth endpoints and uploads have stricter limiters (see doc 02).
- Response-body logging is **allow-list only**: only explicitly PII-free paths log their
  bodies, everything else logs status/duration only
  (`server/app.ts` → `RESPONSE_BODY_LOG_ALLOWLIST`; matches doc 06).

## Work-wait observations (coordination Phase A)

The task-linked wait ledger records explicitly observed waits. It is an internal API;
there is no recording UI, automatic task backfill, or event/scheduler wiring in Phase A.
An empty ledger means **no observations recorded**, not that the file has no outstanding work.
`BLOCKED` is never interpreted as borrower responsibility.

| Method | Endpoint | Result |
|---|---|---|
| GET | `/api/loan-applications/:id/work-waits` | `{ asOf, waits, nextCursor }`; each wait includes `elapsedMs` |
| POST | `/api/loan-applications/:id/work-waits` | `{ replayed, wait }`; 201 on creation, 200 on an identical retry |
| POST | `/api/loan-applications/:id/work-waits/:waitId/close` | `{ replayed, wait }`; 200 for closure or an identical retry |

All three routes require an internal staff role and either the application's assigned
loan-officer pointer or active deal-team membership; admin has explicit global access.
Inactive/unrelated staff receive 404. Borrowers and external partners receive 403, even
when on the deal team. Application access is checked on every read, write, and retry.
All responses are private and non-cacheable. Reads are audited; writes and their audit
entries commit in the same transaction.

**Record a wait:** supply `taskId`, `counterparty` (`borrower|lender|vendor|title|internal`),
`startEventId` (UUID), `startedAt` (ISO timestamp with timezone), and optional `promisedAt`
(timestamp or null). The task must belong to the exact application. Its reference identifies
what is outstanding; its existing ownership remains authoritative. The counterparty names a
category, not an individually identified vendor or person. Separate deliverables need separate
tasks. An omitted promise stays unknown; it is never inferred from an SLA or legal clock.
Start time cannot be in the future. A promise may already be overdue when a wait starts;
the ledger preserves it as observed. Both the observation's effective
start and server recording time/actor are retained. Historical observations are allowed on
existing tasks, including terminal tasks, without changing their status.

**Close a wait:** supply `closingEventId` (UUID), `closedAt`, and `outcome`
(`work_received|cancelled|superseded`). Optional `documentId` must belong to the same application.
Closure cannot precede the start or exceed the recording time. The ledger retains effective
closure time, server recording time, actor, outcome, and optional document reference. A closure
is a staff observation; `work_received` does not mark evidence verified, resolve the task,
approve a loan, or assert that a lender accepted it. Without a document reference, the
structured staff observation is the only closing evidence recorded here.

**Retries and history:** the caller generates one stable event UUID per recording/closing
observation and reuses it with the same payload after a timeout. These are ledger observation
identifiers, not foreign keys into `task_events`. Start-event and closing-event UUIDs have
separate application-scoped namespaces. Reusing a key with different values returns 409.
At most one wait can be open per task/counterparty. The next cycle needs a new start UUID and
must start at or after the previous closure; overlapping cycles return 409. Different
counterparties may wait concurrently. Closed observations cannot be edited or reopened; a new
cycle preserves the prior history. There is no correction/deletion endpoint in this phase.

**Time and reading:** `elapsedMs` is derived from start to closure, or to the GET response's
single `asOf` instant while open. It is actual elapsed wall-clock time, not working hours,
a legal deadline calculation, or proof of time spent actively working. Overlapping waits must
not be summed as total loan duration. GET accepts `limit` (1–100, default 50) and `afterId`
(the prior `nextCursor`); follow cursors until null. Pages sort by immutable row ID, not time.
Pagination is not a cross-request snapshot: restart a scan to include concurrent inserts.

Storage is additive `work_waits` (migration `migrations/0086_work_waits.sql`). Only references, structured
categories, and timestamps are duplicated. The ledger neither sends messages nor changes loan,
task, evidence, vendor-order, or decision state. Automated observation capture, chase behavior,
`tasks.waitingOn`, and order tracking remain separate later phases.
