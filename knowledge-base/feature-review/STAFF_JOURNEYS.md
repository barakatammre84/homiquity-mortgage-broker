# Feature Review — Staff Journey Charters

Five staff desks, each walked **in the real browser UI** as the seeded staff seat **and** as its
counterpart. Each charter lists: the role and the one handoff it owns, the seat and the file it
creates, what arrives on the desk and what leaves it, the seams that must carry, the borrower-side
consequence of every staff action, and what the walker is forbidden to do. A
`journey-walker-staff-*` run takes ONE numbered charter as its brief. Program rules: `CHARTER.md`.
Client journeys: `JOURNEYS.md`.

> **A staff journey is a different shape from a client journey.** A client journey is one persona
> crossing many surfaces. A staff journey is **one file crossing many hands** — LO → processor →
> underwriter → closer — with the borrower on the far side of every decision. Its seam is the
> **handoff between desks**, and the **borrower-side consequence of a staff action**. Neither is
> visible to a review that holds one role: a domain reviewer reviews at one role, a workflow verifier
> holds one cookie jar, a UX reviewer grades one page at one role, and the client walkers never hold
> a staff session. That is why domain 11 ("Staff, partner & pipeline ops") has never been reviewed,
> why no workflow covers "LO invites a client," and why every open staff finding in the register
> (ux-24, F-0818-13, F-0820-20, F-0820-25/26, ux-49) was found from the borrower side or from code —
> never by someone sitting at the desk.

> **Two sessions, sequentially.** Every staff walker holds its own role's session **and** the
> counterpart's — the borrower it created, the upstream or downstream desk, or (for exactly two
> verbs) admin. The browser pane's tabs share one cookie jar, so sessions are sequential:
> `POST /api/auth/logout` → assert `GET /api/auth/user` is 401 → log in as the counterpart. A handoff
> observed from one side is `INCONCLUSIVE`, never `CLEAN`. *(Verified 2026-08-22: a cookie set
> in one pane tab was read verbatim in a second — the jar is per pane, not per tab.)*

## Why these seats exist alongside the owner fleet and the desk partition

`requireRole` and `deal_team_members` partition the product into **desks** the way
`knowledge-base/handbook/FEATURE_MAP.md` partitions it into **owners**. Both partitions are correct
— and a boundary drawn so no role oversteps is a boundary no single-role review sees across:

| Seam | Fires in | Renders in | Desks |
|---|---|---|---|
| invite → desk | `server/routes/lending/applications.ts:240-256` (`assignLoanOfficer`; **non-fatal** — "a routing failure must not lose the application") | `server/routes/underwriting/staff.ts:15-27` queue · `client/src/components/dashboard/LoanTeamCard.tsx:49-51` | borrower → LO |
| status → borrower | `server/routes/lending/statusDecisions.ts:147-292` (single writer; the condition gate on the closing track landed 2026-08-23 at `:253-282`) · `:328` (`type: "status_update"`) | `client/src/components/NotificationsPanel.tsx` · `/dashboard` | any desk → borrower |
| verify → doc state | `server/routes/documents.ts:431-464` (the only path to `verified`) | borrower `/documents`, `/tasks` — two axes, `shared/schema/underwritingTasks.ts:145-180` | processor → borrower |
| denial → notice | `statusDecisions.ts` `ensureAdverseActionForDenial` | `client/src/pages/borrower/AdverseActionNotice.tsx` (ux-24: undiscoverable) | underwriter → borrower |
| funded → homeowner | `server/pipelineEngine.ts:646-656` (`graduateClosedLoan`, **non-fatal**) | `/homeowner-dashboard` (`client/src/App.tsx:553`, no nav entry) | underwriter/admin → borrower |
| referral → stage-only | `applications.ts:240-243` ("broker and other referrers stay attribution-only") | `/agent-pipeline` · must **NOT** render `/borrower-file/:id` | borrower → broker |

Each is correct inside every desk and every owner, and broken only across them. The owners' own
hand-back format ends with `LEFT UNDONE: out-of-scope problems observed — findings, not fixes`, which
is where a cross-desk observation goes today and dies. These five walkers are that seat. They produce
findings no owner can produce; owners produce fixes no walker may attempt; and a `JS-` finding is
re-verified by the same walker after the owner ships — **no seat signs off its own work.**

**Four load-bearing files on the staff spine had no owner in `FEATURE_MAP.md`** when these
charters were written (2026-08-22): `server/routes/lending/statusDecisions.ts`,
`server/routes/borrower/dealTeam.ts`, `client/src/components/app-sidebar.tsx`,
`client/src/pages/agent-broker/ApplyInvite.tsx`. The same PR assigned **provisional** owners —
`hq-pipeline-owner` for the first two, `hq-auth-owner` for the sidebar (it already owns the gates the
sidebar renders), `hq-broker-portal-owner` for `ApplyInvite` — marked provisional in the map so a
better home can be chosen. A HANDOFF on those files names the provisional owner **and says
"provisional"**; a hand-off with a doubtful addressee is recorded as such, never silently dropped.

> **Seeded seats, and why they are right here when journey 1 retired its own.** Every staff role has
> a `/test-login` seat (`server/auth.ts:357-369`) whose role is **rewritten on every login**
> (`:380-382`). Journey 1 retired `renter@test.com` because its central surface keys on the
> account's own rows, and accumulated applications changed what the persona saw. A staff desk's
> central surfaces key on **the file under test, which the walker creates fresh every run** — the
> seat's other rows are residue, not subject. What residue *does* cost: the seats' **empty states**
> (the no-invites `InviteEmptyState`, the no-files dashboard) are **unwalkable on the seeded seat**
> and the walkability column says so; their only walk is S1's optional fresh-LO-via-redeem leg.
> Record the queue count `N` at login; assertions are "appears", never "is empty".

Status ledger (updated by the orchestrator after each run; the run's PR updates this table **and**
`knowledge-base/routines/staff-journey-walk/LEDGER.md` together — the client lane's two ledgers
already drift):

| # | Journey | Walkability (seat · counterpart · unwalkable) | Last walked | Verdict |
|---|---|---|---|---|
| S1 | Loan officer — receives the file | `lo@test.com` · a fresh complex borrower file · **invite/pool variants remain separate regression legs** | **2026-09-07** (`codex/end-to-end-journey`, dedicated local server on :5021) | **WARN — core path passes, charter remains incomplete.** Searchable queue, file open, property/income provenance, correction state and every approval-grade gate were walked in the browser. Invite attribution, the second pool file and retire-to-`N` were not repeated, so S1 stays next in rotation. The real receiver and lender acknowledgement remain external. [report](journey-walks/2026-09-07-complex-borrower-lo-loop.md) |
| S2 | Processor — the document crosses two vocabularies | `processor@test.com` · borrower (fresh) · admin for one team-add · **no product verb puts a file on this desk** | — | not yet run |
| S3 | Underwriter — the decision, both directions | `underwriter@test.com` · borrower ×2 (one denied, one pre-approved) · admin for team-add | — | not yet run |
| S4 | Closer — the desk with no verb | `closer@test.com` · underwriter/admin funds · borrower for graduation · **expected `DEAD-ENDED (by design)`** | — (attempted 2026-08-23: **BLOCKED**, no browser tooling; the HTTP census in [journey-walks/2026-08-23-lo-submission-review.md](journey-walks/2026-08-23-lo-submission-review.md) confirms the expected dead-end at API level) | not yet run |
| S5 | Broker — sees the stage, must not see the file | `broker@test.com` · borrower (fresh, via `/ref/:code`) · **no admin, ever** | — | not yet run |

---

## S1. Loan officer — the desk that receives the file

- **Persona**: the first human hand. `shared/roles.ts` `"lo"` — *"Sales & lead qualification,
  client relationships"*. Home `/staff-dashboard` (`client/src/lib/roleRoutes.ts:19`); nav
  `staffNavigation` (`client/src/components/app-sidebar.tsx:135-162`) including *Invite Clients*
  gated `ROUTE_GATES.loTeam` (admin/lo/loa).
- **Account**: `lo@test.com` via `/test-login` (`server/auth.ts:359`). Borrower: fresh `/signup`
  as `jst+<MMDD>lo@test.local`, created **through the LO's own invite link**; a second,
  `jst+<MMDD>lo2@test.local`, for the pool leg via cold `/apply`. **Optional onboarding leg** (the
  only way to walk the LO empty states and the live role flip): as admin at `/admin/users` mint one
  `lo` code (`POST /api/staff-invites`, `server/routes/staff-invites.ts:11`, `validRoles` `:16`); a
  fresh `jlo+<MMDD>@test.local` redeems at `/redeem-invite/:code` **inside its live session** — the
  role is rewritten server-side (`:109`) and `RedeemInvite.tsx:135` sends every redeemer to
  `/staff-dashboard`: screenshot nav and home before, after without reload, after reload. The staff
  analogue of journey 2's promotion seam.
- **File under test**: created in route step 3 through the invite; must be `submitted` with the
  invite `applied` before step 5.
- **Handoff IN**: none — this desk is the origin. Two product entrances: the invite
  (`/invite-clients` → `POST /api/application-invites`, `server/routes/agent-broker/invites.ts:30-84`;
  the link is `${baseUrl}/apply/${token}` at `:74`) and the intake pool
  (`GET /api/pipeline/unassigned`, `server/routes/underwriting/pipeline.ts:482`, admin/lo/loa;
  `POST /api/loan-applications/:id/claim` `:499`, lo/loa only, 409 if owned; UI
  `client/src/pages/staff/loCommandCenter/IntakeInboxCard.tsx:17-22`). **A file with no deal-team
  row is invisible to every non-admin** (`staff.ts:15-27`) until claimed.
- **Handoff OUT**: the LO sets `doc_collection`/`processing` via
  `client/src/pages/staff/borrowerFile/StatusUpdateDialog.tsx` → `PATCH /api/loan-applications/:id/status`
  (`statusDecisions.ts:147`). **What the product does not have**: a verb that assigns a processor.
  The Team tab mounts `DealTeamManagement` for every staff role (`BorrowerFile.tsx:610`) and the
  server answers 403 to all but admin (`server/routes/borrower/dealTeam.ts:45,209`). Assert who
  learns of `processing`: the borrower (notification `status_update`, `statusDecisions.ts:328`) —
  and no processor at all.
- **Counterpart session(s)**: the borrower (verbs: sign up, apply via the link, read `/dashboard`
  and `/documents`, withdraw). Admin **only** on the optional leg (one verb: mint one code).
- **Route** (⇄ = session switch, logout + 401 asserted):
  1. `/test-login` → `lo@test.com` → `/staff-dashboard` (`GET /api/staff/applications`,
     `GET /api/pipeline/queue`). Record `N`.
  2. `/invite-clients` → create an invite for `jst+<MMDD>lo@test.local` **with a message** → copy
     the link. Locally `PUBLIC_BASE_URL` is unset, so the minted link is
     `https://localhost:<port>/apply/<token>` (`invites.ts:74`) — rewrite to `http://` when
     following it and say so; an env fact, not a finding.
  3. ⇄ anonymous: open the link (`client/src/pages/agent-broker/ApplyInvite.tsx:74` validates,
     `:95` `setPendingInviteId` → localStorage, then `/apply`) → complete the funnel → sign up at
     the auth gate → submit. **Quote the LO's message as rendered to the borrower.**
  4. Borrower `/dashboard`: `LoanTeamCard` (`client/src/components/dashboard/LoanTeamCard.tsx:49-51`
     picks `isPrimary && teamRole === "loan_officer"`) must name the LO seat. The sidebar's "Your
     Team" (`GET /api/team-members`, `server/routes/borrower/messaging.ts:33-38`) will show the
     whole roster — **ux-49, cite and extend, do not re-mint.** Record both renderings.
  5. ⇄ LO: `/staff-dashboard` shows `N+1` with your file; `/invite-clients` *Applied* tab shows the
     invite `applied` with a stage; `/lo-command-center` → your file → `/borrower-file/:id`.
  6. Set `processing` in the status dialog; record the toast verbatim (F-0818-14 class if it is raw
     JSON). Open the **Team** tab: record what is offered and what 403s (J10(a)).
  7. ⇄ borrower `/dashboard`: is the status change rendered? is a next step named? does the bell
     show it (the ux-24 mechanism — `status_update` vs the panel's branches)?
  8. **Pool leg**: ⇄ anonymous cold `/apply` as `jst+<MMDD>lo2` → submit → ⇄ LO:
     `/staff-dashboard` must **NOT** list it (not on the team); `IntakeInboxCard` **must**; claim;
     it now appears in both; ⇄ borrower: `LoanTeamCard` names you.
  9. **loa variant**: ⇄ `loa@test.com` → repeat 1–2 and 8 (claim is permitted for loa); open your
     file's Conditions tab and record the GATES census. *(Corrected 2026-08-23: the tab now renders
     each verdict button only for roles in `CONDITION_VERDICT_ROLES` — `shared/statusVocabularies.ts`,
     the same constant the route enforces — so `loa` and `lo` see NO verdict buttons; the walk
     asserts offered == permitted rather than the old offered-vs-refused seam, which was lived as a
     403 in [journey-walks/2026-08-23-lo-submission-review.md](journey-walks/2026-08-23-lo-submission-review.md).)*
  10. **Retire** (J11): ⇄ each borrower withdraws from the UI; ⇄ LO: queue back to `N`.
- **Seams**:
  1. **invite id, seven hops**: `/invite-clients` (LO) → `/apply/:token` (anon) → localStorage
     (`client/src/lib/pendingAttribution.ts` — its header at `:26` records this seam breaking once:
     *"THIS WAS sessionStorage, AND THAT WAS THE BUG"*) → `/apply` → `/signup` →
     `POST /api/loan-applications` → `referringBrokerId` folded in for lo/loa only and only if unset
     (`applications.ts:220-231`) → `assignLoanOfficer` (`:240-256`;
     `server/storage/pipeline.ts:359-409` writes **`loan_applications.loanOfficerId` AND the
     `deal_team_members {teamRole:"loan_officer", isPrimary:true}` row** — the second is what
     authorizes visibility) → the LO's rendered queue (LO) → `LoanTeamCard` (borrower). **Three
     destinations, all three asserted by name.** A file with the pointer and no team row is credited
     to the LO and invisible to them — the silent-success class, and the server is non-fatal at
     exactly this point.
  2. `processing` : status dialog (LO) → `/dashboard` + bell (borrower).
  3. claim : `IntakeInboxCard` (LO) → `LoanTeamCard` (borrower).
  4. withdrawal : `ApplicationSwitcher` (borrower, `client/src/components/ApplicationSwitcher.tsx:133`)
     → queue (LO). *(Lead, verify: `dealTeam.ts:151` records the actor as
     `user.role === "borrower" ? "borrower" : "staff"` — no role named `borrower` exists, so a
     borrower's withdrawal is logged as staff. Single-surface → HANDOFF.)*
- **Borrower-side consequence**: assignment → `LoanTeamCard`; `processing` → dashboard status +
  bell; claim → `LoanTeamCard`.
- **Promises**: `shared/roles.ts` *"Sales & lead qualification, client relationships"* — name the
  cockpit surface that keeps "lead qualification"; `InviteGenerator.tsx` *"Copy the link to send to
  your client"* — the product does not send it; `TEST_ACCOUNTS.md` "Loan officer".
- **Dead-end watch**: the LO after submit — what does the cockpit tell the desk to do next; the
  borrower after `processing`; the Team tab after its 403 (is the handoff to processing reachable by
  anyone but admin?); `InviteEmptyState` (unwalkable on the seeded seat).
- **Gate collisions**: `/apply/:token` is `<Gated>` (`App.tsx:263-265`) — under PRELAUNCH the LO's
  own invite lands on the waitlist: a launch-readiness fact. `/invite-clients` is `LoTeamPage`;
  `/lo-command-center` is `InternalStaffPage`. Team tab → J10(a). **Never click the Intelligence
  tab** (F-0820-20 unmounts the whole staff app).
- **Forbidden**: J9 in full. Never act on the `N` residue files; never change `lo@test.com`'s role;
  never `force`.
- **Leave-as-found**: both borrowers withdraw; the `applied` invites remain (acceptable residue,
  recorded).
- **Crosses domains**: 2 (intake), 10, 11 (staff ops), 13 (scoping), UX. **Owners crossed**:
  `hq-broker-portal-owner` (`invites.ts`, `InviteGenerator`), `hq-partners-owner`
  (`pendingAttribution.ts`, `RedeemInvite`, `staff-invites.ts`), `hq-pipeline-owner`
  (`StaffDashboard`, `BorrowerFile`, `borrowerFile/`, `loCommandCenter/`), `hq-intake-funnel-owner`
  (`applications.ts`), `hq-messaging-owner` (`NotificationsPanel.tsx`), `hq-borrower-journey-owner`
  (`Dashboard.tsx`). **Provisionally owned on this route** (say so in the HANDOFF): `statusDecisions.ts`, `dealTeam.ts` →
  `hq-pipeline-owner`; `app-sidebar.tsx` → `hq-auth-owner`; `ApplyInvite.tsx` → `hq-broker-portal-owner`.

---

## S2. Processor — one document, two roles, two vocabularies

- **Persona**: `shared/roles.ts` `"processor"` — *"File bundling, pre-underwriting, condition
  management"*. Home `/staff-dashboard`, default tab `my-queue`
  (`client/src/pages/staff/staffDashboard/model.ts`). Nav `staffNavigation`.
- **Account**: `processor@test.com` (`server/auth.ts:361`). Borrower: fresh `jst+<MMDD>pr@test.local`
  via cold `/apply`, who then uploads **at least two documents** at `/documents`. Admin for exactly
  one verb: add `processor@test.com` to the file's deal team (`dealTeam.ts:45`), recorded in
  `ADMIN-ACTIONS:`.
- **File under test**: `submitted`, with ≥2 uploads and the automation-generated conditions present
  (`server/pipelineEngine.ts` `initializeLoanPipeline` → `generateConditionsFromRequirements`).
- **Handoff IN**: **admin-by-hand.** There is no product verb that puts a file on a processor's
  desk — the Team tab is offered to every staff role and 403s for all but admin. Record that as the
  desk's inbound: `performed by: admin-by-hand`.
- **Handoff OUT**: "Mark Financials Verified" (`BorrowerFile.tsx` → `POST …/verify-financials`,
  `FINANCIAL_VERIFICATION_ROLES`) and/or status → `underwriting`. Who learns — the borrower via
  `status_update`; the underwriter via nothing (no assignment verb).
- **Counterpart session(s)**: the borrower (upload, read `/documents` and `/tasks`, withdraw);
  admin (one verb).
- **Route**: (pr) login, record `N` · ⇄ borrower: signup → `/apply` → submit → `/documents` →
  upload 2 docs · ⇄ admin: add the processor seat to the team · ⇄ pr: `/staff-dashboard` shows the
  file → `/borrower-file/:id` → Documents tab → **verify one, reject one**
  (`client/src/components/staff/DocumentReviewPanel.tsx` → `POST /api/documents/:id/verify`,
  `documents.ts:431-464`) · ⇄ borrower: `/tasks` and `/documents` · ⇄ pr: Conditions tab → clear
  the condition the verified doc satisfies (`PATCH /api/conditions/:id`, clear permitted for
  processor `pipeline.ts:195-198`) · ⇄ borrower again · ⇄ pr: status → `underwriting` · ⇄ borrower
  · retire.
- **Seams**:
  1. **one document, three renderings**: the wire (`status` vs `verificationStatus`) → the
     processor's Documents tab → the borrower's `/tasks` (`client/src/pages/borrower/Tasks.tsx:41-50`:
     *"a rejection outranks the lifecycle bucket"*) and `/documents` checklist. The two-axis
     vocabulary (`underwritingTasks.ts:168-174`) is where the borrower dashboard once *"counted
     engine-COMPLETED tasks as open items."*
  2. condition cleared (pr) → borrower `/tasks` / `/documents` (does anything tell them?).
  3. `underwriting` status (pr) → borrower dashboard + bell.
  4. the processor's **own** `my-queue` tab: does the file appear there after the admin team-add,
     without reload?
- **Borrower-side consequence**: verify → `/documents` state; reject → `/tasks` rejected badge
  (named surface); clear → ?; `underwriting` → status + bell.
- **Promises**: *"File bundling, pre-underwriting, condition management"* — condition management
  exists (settle **and create**: the submission dialog's Log-lender-conditions form —
  `client/src/components/SubmissionReadinessDialog.tsx` → `POST …/lender-submissions/:sid/conditions`
  — creates `loan_conditions` rows. *This line originally said "no staff UI creates a condition";
  that was wrong at birth — the transcription UI landed 2026-08-20 in #625, two days before this
  charter was written. Corrected 2026-08-23, PF-4.*);
  pre-underwriting is `server/services/preUnderwriting.ts`, a server cascade — name the surface
  the processor sees it on.
- **Dead-end watch**: a rejected document — what is the borrower offered next; the processor after
  clearing the last condition — what is offered; `DOC-STATE DIFF` disagreements.
- **Gate collisions**: Conditions tab buttons for `loa` (S1 step 9 covers it) — J10(a). Document
  verify gate excludes `closer` (`DOCUMENT_REVIEW_ROLES`) — correct gate. Intelligence tab — never.
- **Forbidden**: J9. Seat-specific: never create a condition by any non-UI means — the ONE UI
  writer is the submission dialog's lender-conditions form (see Promises above; the previous "none
  exists" premise was wrong at birth, corrected 2026-08-23).
- **Leave-as-found**: borrower withdraws; the team-add row remains (recorded).
- **Crosses domains**: 3 (documents & extraction), 11, UX. **Owners**: `hq-documents-owner`
  (`DocumentReviewPanel`, `documents.ts`), `hq-task-engine-owner` (`Tasks.tsx`,
  `underwritingTasks.ts`), `hq-pipeline-owner` (conditions, `BorrowerFile`), `hq-underwriting-owner`
  (`preUnderwriting.ts`); provisional: `statusDecisions.ts`, `dealTeam.ts` → `hq-pipeline-owner`.

---

## S3. Underwriter — the decision, both directions, as the borrower sees it

- **Persona**: `shared/roles.ts` `"underwriter"` — *"Final loan approval/denial, risk assessment"*.
  Home `/staff-dashboard`, default tab `conditions`. Exclusive surfaces `/task-operations`,
  `/policy-ops`, `/pricing-matrices` (`underwriterOps`); waive conditions; the whole
  `CREDIT_DECISION_ROLES` surface (`shared/loanApplicationStatus.ts:301` — admin, underwriter).
- **Account**: `underwriter@test.com` (`server/auth.ts:362`). **Two** borrowers: `jst+<MMDD>uw`
  (to be denied) and `jst+<MMDD>uw2` (to be pre-approved) — the control pass. Admin for one team-add
  per file.
- **File under test**: both walked to `under_review` (the cascade's MANUAL_REVIEW route; **the
  product never auto-denies** — `tests/intakeNeverDenies.test.ts`).
- **Handoff IN**: admin-by-hand (team-add) — record it. Financials `verified` only via the
  one-click `verify-financials` override (**F-0818-01**, P1, open: "requires no evidence
  whatsoever") — record that you used it, on `uw2` only.
- **Handoff OUT**: `pre_approved` (approval outcome) or `denied` (terminal). Both protected statuses;
  both go through the ten chokepoints in order (`statusDecisions.ts:147-292`; the condition gate on clear_to_close/closing/funded was added 2026-08-23 — Selling Guide B3-2-05): role → HMDA ≥2
  reasons → `CREDIT_DECISION_ROLES` 403 → deal-team → `assertVerifiedForDecisioning` 422 →
  `assertStageRequirements` 422 → TRID hard stop 422 → `ensureAdverseActionForDenial` 422 →
  `updatePipelineStage`. **Which 422 fires first on an unverified file, and what text reaches the
  underwriter's screen** (`StatusUpdateDialog.tsx` pre-warns; F-0818-14 class if raw).
- **Counterpart session(s)**: the borrower (read `/dashboard`, the bell, `/adverse-action/:id`
  **without typing a URL**; the pre-approval letter on `uw2`); admin (team-add only).
- **Route**: (uw) login, `N` · ⇄ borrowers ×2: signup → `/apply` → submit · ⇄ admin: team-add ×2 ·
  ⇄ uw on `uw`: attempt `pre_approved` **unverified** → expect 422 → record the rendered reason ·
  then `denied` with ≥2 HMDA reasons → toast · ⇄ borrower `uw`: from `/dashboard`, **find the
  notice** — bell, dashboard, any link — record every click (ux-24 live re-verification) · ⇄ uw on
  `uw2`: `verify-financials` override → `pre_approved` · ⇄ borrower `uw2`: where is the letter /
  the status shown, and what is offered next · retire (`uw` is terminal; `uw2` withdraws).
- **Seams**:
  1. **denial → notice → borrower's bell**: `ensureAdverseActionForDenial` creates the record;
     the status route emits `type: "status_update"` (`statusDecisions.ts:276`); the panel's
     branches (`NotificationsPanel.tsx`) — does any match? ux-24 says no: **undiscoverable, not
     unreachable.** Cite, re-date, extend with the click-path.
  2. the 422 chain (uw) → the dialog's rendered reason (uw) — same desk, two surfaces (server
     contract ↔ rendered copy).
  3. `pre_approved` (uw) → borrower dashboard / letter (`hq-letters-owner` surfaces).
  4. `verified` via override (uw) → the `self_reported`/`verified` provenance shown anywhere to
     the borrower (F-0818-02: three booleans TRUE while the file stays `self_reported`).
- **Borrower-side consequence**: denial → notice discoverable? (`VISIBLE / INVISIBLE / MISLEADING`);
  approval → letter/status; the override → nothing visible (record as such).
- **Promises**: *"Final loan approval/denial, risk assessment"* — risk assessment is
  `RiskBriefPanel` (`hq-underwriting-owner`); name where the underwriter sees it before deciding.
- **Dead-end watch**: the borrower after denial (ux-24); the underwriter after a 422 — is the fix
  path named; the underwriter after `pre_approved` — what next.
- **Gate collisions**: `funded`/`clear_to_close` available to this role (correct); `force` is
  admin-only (`statusDecisions.ts` — never use it). Intelligence tab — never.
- **Forbidden**: J9, J12. Seat-specific: **never mark the notice delivered or touch `deliveredAt`**
  (F-0819-06); never `force`; never run the adverse-action watchdog sweep.
- **Leave-as-found**: `uw` terminal (denied) — recorded as `retired: terminal`; `uw2` withdraws.
- **Crosses domains**: 5 (underwriting & decisioning), 9 (adverse action), 4 (provenance), 11, UX.
  **Owners**: `hq-underwriting-owner`, `hq-credit-fcra-owner` (`CreditTab`, adverse action),
  `hq-letters-owner`, `hq-messaging-owner` (`NotificationsPanel`), `hq-pipeline-owner`
  (`StatusUpdateDialog`); provisional: `statusDecisions.ts`, `dealTeam.ts` → `hq-pipeline-owner`.

---

## S4. Closer — the desk with no verb

> **Scope note, deliberate.** Scoped as "a closer walk" this seat is six generic nav links and a
> handful of 403s — headcount. It is scoped instead to the two things nothing else owns: **promise
> versus reachability** for a role the product names and gives no verb, and **`funded`'s
> borrower-side consequence**. The closer's own session is the *control* proving the desk is empty;
> the underwriter/admin session funds. No closing workflow exists; no `hq-*-owner` owns closing;
> `/closing-guarantee` is `AdminPage` and unlinked; zero closer-conditional UI exists in
> `client/src`. Expected verdict: **`DEAD-ENDED (by design)`**, finding type `roadmap`, minted once
> and cited on every later walk.

- **Persona**: `shared/roles.ts:20,68` `"closer"` — *"Closer/Funder — wire management, final
  document sign-off"*. Home `/staff-dashboard`; nav: **six generic links** (`app-sidebar.tsx`),
  none closing-specific; excluded from `marketData`, `FINANCIAL_VERIFICATION_ROLES`,
  `DOCUMENT_REVIEW_ROLES`, `loTeam`, `underwriterOps`, and AUS.
- **Account**: `closer@test.com` (`server/auth.ts:363`). Borrower `jst+<MMDD>cl`. Counterparts:
  **underwriter** (sets `clear_to_close`, then `funded`) and admin (team-add of the closer).
- **File under test**: driven to `clear_to_close` by the underwriter counterpart before the closer
  session begins — the closer cannot get it there.
- **Handoff IN**: `clear_to_close` set upstream; team-add by admin. Record both as performed by
  the counterpart, not by the product.
- **Handoff OUT**: **none possible from this desk.** `closing` is not protected and is settable;
  `funded` is a `PROTECTED_CREDIT_DECISION_STATUS` (`loanApplicationStatus.ts:294-299`) → the status
  dialog greys it *"(underwriter/admin only)"* (`StatusUpdateDialog.tsx:92`) and the server 403s
  (`statusDecisions.ts:174-176`, whose comment at `:171-173` tells the role to *"use the
  underwriting advance-stage endpoint"*). That endpoint's `STAGE_TRANSITION_ROLES` permits
  `funded: ["admin","closer"]` (`pipeline.ts:43`) — and has **zero client callers** (N-002). The
  server points the closer at a door the UI never built.
- **Counterpart session(s)**: underwriter (verbs: `clear_to_close`, `funded`); admin (team-add);
  borrower (read `/dashboard`, nav, reach `/homeowner-dashboard`).
- **Route**: ⇄ borrower: signup → `/apply` → submit · ⇄ admin: team-add closer · ⇄ uw: verify
  override → `pre_approved` → `clear_to_close` · ⇄ **closer**: login, `N`; `/staff-dashboard` —
  what does the default tab show this role; `/borrower-file/:id` — exercise **every** control:
  status select (record what is greyed and the exact copy), `closing` (set it — permitted),
  conditions (clear permitted `pipeline.ts:195`), Documents tab verify (excluded — offered?), Team
  tab (403 — offered?), `/lo-command-center` right rail *Submit to lender* (`ActionsRail.tsx:62` mounts the
  submission dialog; the *Run DU / LPA* verb lives INSIDE it and renders unconditionally →
  **F-0818-13**, cite — label precision corrected 2026-08-23, the rail trigger was never the DU verb), `/pricing-intelligence` (excluded — offered in
  nav?) · ⇄ uw: `funded` · ⇄ borrower: nav before/after, `/dashboard`, is `/homeowner-dashboard`
  reachable without a URL (`App.tsx:553`, no nav entry; graduation is non-fatal
  `pipelineEngine.ts:646-656`) · retire (terminal).
- **Seams**:
  1. **role promise → verb**: `ROLE_DESCRIPTIONS` "funder" → the transition table says closer may
     fund → no surface offers it → the reachable path 403s → the permitted path has no caller.
     Four facts, one dead end. `DEAD-END` under J10(b), `roadmap`.
  2. `funded` (uw) → borrower: nav cohort, dashboard, homeowner surface reachability.
  3. every control offered to the closer vs permitted (`OFFERED vs PERMITTED:` census) — each a
     J10(a) HANDOFF, never an id.
- **Borrower-side consequence**: `funded` → does the borrower learn they are a homeowner, and from
  where.
- **Promises**: *"Wire management, final document sign-off"* — name any surface that keeps either
  half, or record that none exists.
- **Dead-end watch**: the entire seat. Also: a deal team whose only staff member is a closer cannot
  progress the file (F-0818-13's P2 rationale — stage 2 hard-blocks submission without an AUS run).
- **Gate collisions**: all of the exclusions above — each `CORRECT-GATE` if not offered,
  `CORRECT-GATE → HANDOFF` if offered. Intelligence tab — never (F-0820-25 renders its 403 as
  all-zero for this role; cite).
- **Forbidden**: J9. Seat-specific: **never call `advance-stage` over HTTP "to prove the closer
  path"** — that is `workflow-verifier`'s job and the endpoint is dead in product (Reality Map
  N-002); a journey proves what a person can reach.
- **Leave-as-found**: terminal (`funded`) — `retired: terminal`. Note the residue: this seat adds a
  funded file to `lo@test.com`'s all-statuses list (`staff.ts:15` does not filter terminal).
- **Cadence note**: strict rotation, but the walk may be **short** when `git log` since the last
  S4 walk shows no change under `closer`, `funded`, `closing*`, `advance-stage` — say so and cite
  the prior `JS-` id rather than re-walking an unchanged absence.
- **Crosses domains**: 11, 7 (AUS), 12 (homeowner), UX. **Owners**: `hq-pipeline-owner`,
  `hq-aus-autopilot-owner` (`ActionsRail` AUS button), `hq-homeowner-owner`, `hq-realtor-engine-owner`
  (`/closing-guarantee`); provisional: `statusDecisions.ts` → `hq-pipeline-owner`, `app-sidebar.tsx` → `hq-auth-owner`.

---

## S5. Broker — sees the stage, must not see the file

> **Scope note, deliberate.** The broker has nothing exclusive: every broker surface is also in
> staff nav, and the commission `PATCH` is the only broker-only write. **"Broker and other referrers
> stay attribution-only"** (`applications.ts:240-243`) is a product decision, so the broker's
> blindness is **by design, not a dead end**. This seat's central assertion is therefore a
> **negative** — the only walker in either fleet whose headline is *must not carry*: the referred
> file's **stage** must reach the broker, and its **contents** must not. A leak is **P0** and is
> invisible to every lens that holds one jar at one role.

- **Persona**: `shared/roles.ts` `"broker"` — *"Loan origination, lender relationships, deal
  management"*. Home `/broker-dashboard` (`roleRoutes.ts:16`); nav `partnerNavigation`
  (`app-sidebar.tsx:168-178`, shared with `lender`). Excluded from `internalStaff`, `loTeam`.
- **Account**: `broker@test.com` (`server/auth.ts:364`). Borrower `jst+<MMDD>br` via the broker's
  **`/ref/<code>`** referral link (`pendingReferralCode`, `client/src/lib/pendingAttribution.ts`).
  **No admin session, ever** — the broker must never be on the deal team; that absence is the
  subject.
- **File under test**: `submitted` with `referringBrokerId` = the broker seat.
- **Handoff IN**: the borrower's submit with attribution (`applications.ts:57-59,85` seeds
  `referringBrokerId` from `user.referredByUserId`). The file never joins the broker's deal team.
- **Handoff OUT**: **none** — the file never leaves "stage-only" for this desk.
- **Counterpart session(s)**: the borrower only (signup via `/ref/<code>`, apply, upload one
  document, send one message to "Your Team", withdraw).
- **Route**: (br) login, `N`; `/broker-dashboard` (`GET /api/broker/stats`, `/referrals`) — record
  the referral code / link · ⇄ anonymous: open `/ref/<code>` → signup → `/apply` → submit → upload
  one doc → `/messages` → send one message · ⇄ br: `/broker-dashboard` referrals + stats count it?
  `/agent-pipeline` (`GET /api/agent-pipeline`, `dealDesk.ts:148` — all 8 staff roles) lists it with
  a **stage**? · type `/borrower-file/<id>` directly — the client gate (`StaffPage`) passes; the
  server must 403 (`getLoanApplicationWithAccess`, `server/storage/applications.ts:67-73`) and the
  page must **not** render a data shell · `/messages` — does the borrower's message, or the borrower,
  appear to the broker? (`messaging.ts:33-38` returns the **whole staff directory** to any staff
  role) · `/co-branding`, `/partner-services` · `/staff-dashboard` — record F-0820-25/26's
  all-zero/"All clear" renders for this role, cite · retire.
- **Seams**:
  1. **stage carries**: `referringBrokerId` → `/agent-pipeline` row with stage → YES/NO.
  2. **contents must NOT carry** — per datum: name, income, price, SSN last-4, documents, status
     notes, messages → visible on `/agent-pipeline`, `/broker-dashboard`, `/messages`, a direct
     `/borrower-file/<id>` → **NO** / **YES (P0)**.
  3. two channels, one field: `/ref/:code` → `pendingReferralCode` vs invite → `referringBrokerId`
     (`applications.ts:220-231`, "a real /ref attribution wins") — assert which one the file carries
     when both could apply.
  4. the borrower's "Your Team" after a broker referral — does it name the broker (it should not
     be on the team), and does the broker appear in the directory the borrower can message?
- **Borrower-side consequence**: none expected — and that is asserted: the borrower must see no
  trace of the broker beyond attribution copy, if any.
- **Promises**: *"Loan origination, lender relationships, deal management"* vs attribution-only —
  name the surface that keeps "deal management" for a file the broker cannot open, or record the
  gap as a product decision (cite `applications.ts:240-243`), not a defect.
- **Dead-end watch**: `/broker-dashboard` with a referral and nothing to do; `/agent-pipeline` row
  with no next step.
- **Gate collisions**: `/borrower-file/:id` client-passes, server-refuses → `CORRECT-GATE`
  (J10(a)) — and if the page renders a shell around the 403, that is F-0820-25's class. Conditions
  tab if reachable → offered-and-refused. `/invite-clients` → `loTeam`, broker excluded — confirm not
  offered in `partnerNavigation`.
- **Forbidden**: J9. Seat-specific: **never accept or request a team add for the broker, even if
  offered** — the assertion is the absence.
- **Leave-as-found**: borrower withdraws.
- **Cadence note**: lowest — the attribution surface moves slowly; a clean `MUST-NOT-CARRY` census
  is the expected outcome and is reported in `CLEAN` by datum.
- **Crosses domains**: 11, 1 (referral landing), 13 (scoping/PII), UX. **Owners**:
  `hq-broker-portal-owner` (`BrokerDashboard`, `AgentPipeline`, `dealDesk.ts`, `profileBroker.ts`),
  `hq-partners-owner` (`/ref`, `pendingAttribution.ts`), `hq-pipeline-owner` (`BorrowerFile` — the
  403 shell), `hq-messaging-owner`, `hq-pii-vault-owner` (if any datum leaks); provisional:
  `app-sidebar.tsx` → `hq-auth-owner`.

---

## Not seated, and why — so the question is not reopened

- **`admin`** — bypasses every scoping gate (`isAdmin` → all files `staff.ts:19-20`; in
  `CREDIT_DECISION_ROLES`; deal-team check skipped `statusDecisions.ts`). An admin walk can see no
  seam that gates create — it would represent someone. Admin is the **counterpart** with exactly
  two verbs (J9). Provisioning (`/admin/users` → `POST /api/staff-invites` → `/redeem-invite` →
  role upgrade) is HTTP-provable → proposed as a `WORKFLOWS.md` row for `workflow-verifier`; its one
  browser-only seam (the live role flip) rides S1's optional leg.
- **`loa`** — every difference from `lo` is a subtraction that renders as a 403 on an offered
  control: the route-gate-drift class, single-surface by definition. S1 step 9 is its variant pass.
- **`lender`** — deferred by written policy (`roleRoutes.ts:10-11`; FEATURE_MAP §26: never build a
  lender-facing surface without asking). `/staff-dashboard` renders a "Partner workspace is being
  set up" card with no escape button (`StaffDashboard.tsx:186-206`). A walk would re-confirm
  F-0820-25/26 and nothing else.

## Baseline

As `JOURNEYS.md`: the regression baseline is **the previous walk's `CLEAN` block**, re-asserted,
never carried forward. Two additions for staff: the `RESIDUE:` line (queue `N` at login → `N′` at
end) is compared across runs, and an unexplained delta is attributed to a concurrent run, not to
the product; and a `GATES:` row that was `CORRECT-GATE` last time and is now `DEFECT` is a P0
before it is anything else.
