# Client Journey Walk — rotation ledger

> **⛔ Cadence retired 2026-08-23 (founder decision), restoration recommended.** The daily 17:06 seat
> (`client-journey-walk`) was reshaped into the **Handoff Corpus Steward**
> (`.claude/skills/handoff-refresh/SKILL.md`; CHARTER §3). Journey walks have been **hand-invoked
> only** via `/journey-walk` since. A daily cadence at a new slot (~16:10 local, between Deliverable
> QA Sweep and the Handoff Corpus Steward) is now recommended in `knowledge-base/routines/CHARTER.md`
> §3 — registration in the laptop-side scheduler is a pending founder action, not yet live. The
> charters (`feature-review/JOURNEYS.md`), the five walker agents, and this rotation ledger all stay
> authoritative for both hand-invoked and (once armed) scheduled runs. This file remains the walk's
> cross-run memory; the steward never writes here.

Cross-run memory for the `client-journey-walk` seat (daily 2026-08-19 → 2026-08-23, hand-invoked
since, daily restoration recommended 2026-08-23). One persona per run, **strict rotation through
every persona `JOURNEYS.md` currently lists, in section order** — today that is 5 personas
(1 → 2 → 3 → 4 → 5 → 1); when a persona is added or retired there, the rotation updates with it
rather than this file hardcoding a count. A fresh session reads this file to know where to resume.

**Charter: `knowledge-base/feature-review/JOURNEYS.md` is ON `origin/main` and WINS.** It arrived
**2026-08-20 via #595**, not via its founding PR #607 (still open, `DIRTY` — and now partly
redundant, since the file it exists to add already landed). From the next run on, read `JOURNEYS.md`
and treat the `SKILL.md` summaries as a convenience copy. Record which source each run used.

> *(Resolved 2026-08-22: #607 merged on 2026-08-20 and the `.git/info/exclude` entries were removed;
> the agents and skill are tracked on `main`. The 2026-08-20 account amendment that #607 merged
> **without** was ported to `journey-walker-aspiring-owner.md`, `journey-walk/SKILL.md` W6 and
> `feature-review/CHARTER.md` in the staff-journey PR. Staff desks have their own lane:
> `knowledge-base/routines/staff-journey-walk/LEDGER.md`.)*

## Rotation state

| next run walks | persona | account convention |
|---|---|---|
| **→ Journey 4** | Active buyer, affluent / move-up (jumbo) | fresh `/signup`; loan amount must cross the current conforming limit |

## Run history

| date | journey | source used | server (commit) | verdict | report |
|---|---|---|---|---|---|
| 2026-09-07 | **3 — Active buyer, self-employed** | `JOURNEYS.md` on the working branch | `codex/end-to-end-journey` via a dedicated worktree on :5021 | **PASS with external gate** — two businesses and one rental survived intake, URLA, database persistence, borrower correction and the loan-officer file; preliminary and lender actions stayed evidence-gated. A real lender receiver remains unavailable, so package acceptance is not claimed. | [2026-09-07-complex-borrower-lo-loop.md](../../feature-review/journey-walks/2026-09-07-complex-borrower-lo-loop.md) |
| 2026-08-23 | **3 — Active buyer, self-employed (ATTEMPTED)** | `JOURNEYS.md` on `origin/main` | `6377727e` via the primary checkout of a cloud container on :5001 (`commit: null` + `email` key = local signature; `lsof` cwd + fresh boot verified) | **BLOCKED** — no browser tooling exists in the cloud container (`mcp__Claude_Browser__*` absent; W2 forbids reporting HTTP substitution as a walk). **Rotation does not advance: next hand-invoked run still walks Journey 3.** A separately-labeled HTTP + public-render **seam probe** ran instead: fresh `jse+0823@test.local`, promotion `aspiring_owner→active_buyer` proven, draft round-trip value-exact incl. 2 entities + 1 rental, draft consumed on submit (same id), all 4 self-employed document artifacts generated, `employmentType` carried to the URLA payload; 12 public-page probes (4 pages × 320/768/1280) zero overflow. 2 candidate findings sent to finding-verifier | [2026-08-23-handoff-steward.md](../reports/2026-08-23-handoff-steward.md) §Journey-3 attempt |
| 2026-08-20 (2nd run) | **2 — Active buyer, W-2 salaried** | **`JOURNEYS.md` on `origin/main`** — authoritative, as this ledger directed. First run to use it | `c23079b5` via a dedicated worktree on :5001; **`main` did not move during the run** (re-checked at the end) | **WARN** — the promotion and the whole client→server capture path are clean; the damage is post-submission. 12 findings (`J-0820-01`..`12`), 12 tickets. **2 candidate findings tested and withdrawn before filing** | [2026-08-20-journey-walk-j2.md](../reports/2026-08-20-journey-walk-j2.md) |
| 2026-08-20 | **1 — Aspiring owner** | `SKILL.md` summaries — JOURNEYS.md was absent from `origin/main` at 12:31Z and **arrived at 12:47Z, mid-walk**, via #595 | `b799b91d` (`origin/main` tip at start; main advanced to `8260d734` during the run) via a dedicated worktree on :5001 | **WARN** — 2 data-correctness defects, 1 surface unreachable at 320px, 11 tickets. Findings re-verified against `8260d734` after the merge; **one claim withdrawn**, one new finding (`ux-50`) found by that re-verification | [2026-08-20-journey-walk.md](../reports/2026-08-20-journey-walk.md) |

## Standing notes for the next walker

- **🚨 THE BIG ONE — the browser pane is `visibilityState: "hidden"` and `requestAnimationFrame`
  NEVER FIRES** (measured: `rafFired: 0` over 655 ms). The funnel step card is inside
  `AnimatePresence mode="wait"`, which mounts the next step only after an rAF-driven exit — so
  **the header advances to step N+1 while the step-N question stays frozen on screen.** I watched
  it go 1 → 2 → 3 with the question never changing and was one step from filing *"the funnel is
  unusable — you can only ever answer question one."* **It is a documented artifact, not a defect:**
  `client/src/pages/lending/PreApproval.tsx:788-803` describes this exact desync, verified
  2026-07-17, and records that a real user cannot reach it. ✅ **Workaround that works: take a
  `computer{action:"screenshot"}` after every click** — it forces a frame and the card resyncs.
  Injecting an rAF shim *after* page load does **not** work (framer-motion already captured the
  reference). **Read PreApproval.tsx:788-803 before walking any funnel.**
- **`element.click()` does not operate the funnel's toggle controls.** `toggle-isFirstTimeBuyer`
  stayed `false` in the draft through scripted `.click()`, and I nearly filed *"the first-time-buyer
  toggle silently drops its answer."* A **real coordinate click** set it on the first try — the
  difference is a trusted pointer sequence. This is the second consecutive run to hit the
  dead-control trap this ledger warns about; it is now two-for-two, so treat it as the default
  assumption: **confirm every dead-control claim with a real click.**
- **Screenshots only render at scroll origin.** At `scrollY > 0` the capture returns blank white
  while the DOM is demonstrably populated. `scrollIntoView({block:'start'})` first, then capture.
  Also: the key name `Right` does nothing; use `ArrowRight`.
- **Clear `localStorage`/`sessionStorage` before starting.** The pane arrived carrying a prior
  run's `homiquity_preapproval_draft` (income 137000, downPayment 400000 on a 434892 home).
- **Two findings were withdrawn by testing them — budget time for this, it is the job.**
  (1) *"`/loan-options` says Under Review while the dashboard says pre-approved"* — false;
  `LoanOptions.tsx:129-131` excludes `pre_approved` from `awaitingDecision`, so the banner was
  correct at that instant and a reload showed agreement. (2) *"the consent action item can never
  clear"* — the dashboard's item **did** clear; only `/loan-options` keeps demanding 3. Both
  survived as much smaller, true rows (`J-0820-12`, `J-0820-02`).
- **Finding ids: this run minted the first `J-<MMDD>-<NN>` rows** (`J-0820-01`..`12`), per the
  FINDINGS.md id convention for client-journey seams. Journey 1's same-day run used `ux-44`..`ux-50`
  and `F-0820-01/02`, which predate that convention — **do not renumber them**, and do not assume
  `J-0820-` is free on a future 08-20.
- **Journey 2 leftovers for whoever walks it next.** `/verification` and `/credit-consent/:id` were
  **not walked**; **seam 1 (`/calculators/affordability` → funnel via `calculatorPrefill`) was not
  walked** — I entered via the Landing estimator (seam 2), and since `calculatorPrefill` is
  read-and-consumed only one funnel entry can be in flight. **The documented raw-score-vs-band
  credit vocabulary question is therefore still untested.** Enter via the calculator next time.
- **I did not enter an SSN and neither should you.** Entering government identifiers is prohibited
  regardless of the DB being local and the value fake, so URLA §1a was never submitted and
  sections 3–7 were not exercised. Say so plainly rather than implying the URLA was walked.
- **Reachability of the seeded seats is not the only drift.** Signing consents through `/e-consent`
  now writes `applicationId: null` rows (`J-0820-01`); if you sign again from a gate card you will
  create a **duplicate** consent row. Be deliberate about which you use, and say which.

- **Do not use `preview_start {name}`.** It boots the *primary checkout*, which is routinely on a
  peer's feature branch with uncommitted files. Add a worktree at `origin/main`, `pnpm install`,
  copy `.env`, run `pnpm dev`, and verify the process with `lsof -a -p <pid> -d cwd`.
- **The browser pane may arrive with a stale session cookie.** `POST /api/auth/logout` before any
  anonymous leg, and assert `/api/auth/user` returns 401. (The user endpoint is `/api/auth/user`;
  `/api/auth/me` is a 404.)
- **`mcp__Claude_Browser__computer left_click` by `ref` did not deliver clicks** on this page set —
  the button was topmost per `elementFromPoint` and nothing fired. Confirm any "dead control" by
  invoking the handler before filing it; I nearly filed a false one.
- **⚠️ Journey 1 now takes a FRESH SIGNUP (`jr+<MMDD>@test.local`), not `renter@test.com`.**
  **Amended 2026-08-20** in `JOURNEYS.md` §1, the local `client-journey-walk/SKILL.md`, the in-repo
  `journey-walk` skill (W6) and the `journey-walker-aspiring-owner` agent. Reason: the incubator
  gate keys on the **file**, not the role — that seat carried a `self_employed` application in
  `processing` from **2026-07-02**, so `RenterHome` was unreachable on the very account the charter
  named for it. `/test-login` re-writes the role but not application rows, and `server/seed.ts`
  creates none, so it is dev-DB drift that any submitting run recreates. If you take the seeded seat
  anyway, probe `GET /api/loan-applications` first (`[]` ⇒ `RenterHome` renders) and say which.
- **🚨 `main` can move under you mid-run — it did, by fifteen minutes.** #595 merged at
  **2026-08-20T12:47Z** while a walk started at 12:32Z was in flight. That run reported
  "`origin/main` has no renting door" — true of the commit it walked (`b799b91d`), false by the time
  it was written, and the recommendation it produced had to be withdrawn. **So: `git fetch` and
  re-check `origin/main` at the END of the walk, not only the start, then re-verify every finding's
  file and line refs against the new tip before writing them down.** Doing exactly that is what
  caught **ux-50**.
- **The charter's Landing route is CORRECT** (four doors: renting, self-employed, owner, moving-up).
  Its `Landing.tsx` line refs were stale after #595 and were corrected the same day — renting
  `:58-73`, self-employed `:74-91`, owner `:92-100`, moving-up `:101-112`; the "Homi answers your
  questions" line is a `TRUST_POINTS` entry at `:123`, **not** a door.
- **Two promises the charter used to send you after have been RETRACTED — do not re-file their
  absence.** #595 removed *"…and what your rent already proves about you"* (a Reg N / MAP Rule
  §1014.3 misrepresentation — nothing downstream furnishes rent) and *"We work out every way your
  income can count"* (the funnel never feeds self-employment into the multi-path engine). The
  retractions are the fix. New copy that re-implies either **is** a finding.
- **Before filing any 320px or touch-target finding, check open PRs.** #587 (public calculator
  overflow) and #605 (touch targets, 232 → 0) were both open on 2026-08-20 and already covered
  findings this walk would otherwise have re-reported.
