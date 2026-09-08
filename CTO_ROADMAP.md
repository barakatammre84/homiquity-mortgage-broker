# Homiquity — product and launch roadmap

## Current direction — 2026-09-07

**Continue building Homiquity; do not pivot away from Core.** The existing Homiquity web app is
the product shell. Core's review, evidence-lineage, workpaper, memo and correction controls now
run inside it with the same accounts, applications and uploads. A second Core application would
add duplicate identity and data flows without removing a borrower or loan-officer bottleneck.

The product benchmark is Better.com's fast, transparent online experience: immediate start,
personalized requests, 24/7 document/status access, clear pricing and human help through closing.
Homiquity should match that ease and win where a broker can: complex self-employed, multi-business,
1099 and rental-income borrowers receive a deeper, evidence-linked review and a choice across
wholesale lenders. Benchmark sources checked 2026-09-07:
[mortgage experience](https://better.com/mortgage),
[document personalization](https://better.com/content/what-documents-will-i-need-for-my-mortgage),
and [approval stages](https://better.com/content/how-to-get-a-mortgage-approval).

### Product outcome

A borrower can discover Homiquity, estimate options, begin a public application in minutes, carry
every answer into the full application, upload each document once, understand what is preliminary
versus verified, correct a returned item without starting over, and always see the next useful
action or a person who owns it. A loan officer can receive the same file, see its provenance,
review complex income, request and accept corrections, price, run AUS, lock, assemble the lender
package, manage conditions and carry the file through closing without a spreadsheet side channel.

### Capability map

| Core capability | Current state | Definition of complete |
|---|---|---|
| Public acquisition and application | **Built** — landing primary action enters `/apply`; purchase/refinance and complex-income branches are live | Production conversion and abandonment telemetry show where qualified borrowers stop |
| Fast, accurate intake | **Built and browser-proven** — multiple businesses, 1099/rental sources and typed addresses persist; rough analysis is labeled preliminary | Real pilot files complete without rekeying or contradictory figures |
| Full borrower application | **Built and browser-proven** — identity, businesses and URLA 2c properties carry into editable state and refresh from the database | Pilot borrower completes all required sections with no staff repair |
| Personalized evidence collection | **Built internally** — employment-specific requests, upload/task/condition agreement, immutable replacements and exact correction copy | Production upload survives restart and every required evidence type is accepted on a pilot file |
| Complex-income review | **Built internally** — Form 1084-aligned worksheets, evidence lineage, reviewed workpapers and cited memo | Licensed reviewer reproduces the calculation from a real client's accepted evidence |
| Honest decision and letter | **Built internally** — preliminary output is distinct; verified actions require income, asset and real-credit evidence | Real provider reports plus licensed review produce the first usable letter |
| Loan-officer cockpit | **Built and browser-proven** — bounded/searchable intake, full file, property/income provenance, attention queue and truthful action gates | Invite, pool claim, processing, underwriting, closing and retirement variants pass against pilot users |
| Pricing, AUS and rate lock | **Workflow built; providers external** — simulations are labeled and cannot satisfy evidence gates; lender confirmation is required for a lock | Contracted production pricing/AUS/credit/property services pass certification and reconciliation |
| Lender package and conditions | **Internally built; receiver unproven** — readiness-gated export, package snapshot, submission/condition state machine and correction loop exist | One approved lender accepts the package and one full correction exchange under its current instructions |
| Closing, funding and service | **State machine built; live operations unproven** | Named operating owners complete a real closing/funding, borrower updates and post-close handoff |

### Execution sequence

1. ✅ **Integrated foundation:** one Homiquity identity/application/upload system with Core review
   checkpoints, document lineage, workpapers, cited memo, correction loop and retired overlap.
2. ✅ **Complex-borrower friction loop:** multi-business/rental intake, URLA carry-over, correct
   document requirements, evidence-gated decisions, borrower/task consistency, loan-officer
   property view and honest letter/AUS/export/lock/submission controls. Browser and database report:
   [2026-09-07 complex borrower and loan-officer loop](knowledge-base/feature-review/journey-walks/2026-09-07-complex-borrower-lo-loop.md).
3. **Production foundation:** prove durable object storage through upload → restart → download →
   replace; certify monitoring, email and each data-backed route against the exact deployed commit.
4. **Real data providers:** contract and certify credit, VOA/VOIE, AUS, AVM/appraisal and live
   wholesale pricing; preserve the current rule that simulations cannot become verified facts.
5. **Licensed operating model:** confirm licensed-MLO/state routing, counsel decisions, borrower
   support ownership, processor/underwriter/closer handoffs and service-level targets.
6. **Lender acceptance:** choose one approved wholesale lender, obtain current receiver/sandbox
   instructions, submit the complex reference package, process every response and correction, and
   reconcile lender acknowledgement back into Homiquity.
7. **Controlled pilot:** take a small cohort from public application through letter, accepted
   offer, underwriting, conditions, close and funding; measure time, repeat questions/uploads,
   response time, fallout reason and borrower/officer effort at every handoff.
8. **Scale:** add lender adapters, automated staff assignment, proactive service alerts and
   portfolio/retention journeys only after the pilot proves the base process.

### Immediate release state

- GitHub repository: public; `main` has a strict required
  `gate (typecheck · tests · schema guard)` check with administrator enforcement.
- Production: Railway and `www.homiquity.com` both served exact `main` commit
  `24ee390aabb67b5a445ee88611d6f6ddc9fc4d68` when checked on 2026-09-07.
- Post-merge operations: the workflow applies pending production migrations and then verifies that
  Railway serves the merged commit.
- External blocker: no approved wholesale lender or current receiver/test instructions are
  available yet. Internal simulation is not lender acceptance.
- Configuration to prove: production object-storage credentials are not observable from source;
  run the real persistence acceptance test before accepting borrower documents.

The older queue below contains still-useful compliance and engineering tickets, but its dated
August operational status statements are superseded by this measured snapshot. Re-verify an item
before acting on it; the findings register remains authoritative for unresolved defects.

**What this is:** every piece of work still open, one line each, in the order it should be done.
It is not a history. On 2026-08-06 this file was **96 KB** and ~71% of its bytes were narratives
about finished work, which made the 32 open items unfindable. The whole prior file — all 79 closed
items with their closure reasoning — moved verbatim to
[archive/roadmap/CTO_ROADMAP_2026-08-06.md](knowledge-base/archive/roadmap/CTO_ROADMAP_2026-08-06.md).

**Where things actually stand:** the internal commercial workflow is broad and the complex
borrower-to-officer path is proven. Production uploads, contracted provider results, licensed-state
routing and a real lender receiver still separate that software from an operating mortgage
business.

**Maintenance rules — binding. They are why this file is small.**

1. **One line per open item.** No closure narratives, no "slice 2 of 3" essays, no progress logs.
2. **Done = deleted here and appended to the archive ledger, in the same PR.** *How* it shipped
   belongs in the change ledger ([CICD.md](knowledge-base/runbooks/CICD.md)) and the PR — not here.
3. **No frozen status boxes.** A correction **edits the item**; it is never appended underneath one.
   The two boxes deleted on 2026-08-06 had been superseded three times and still labelled LS-2
   "Vercel env/ops" — with the correction eleven lines below, where a skimmer never reads it.
4. **Deploy, ops and compliance facts live in the runbooks.** Link; never restate.
5. **Verify before you check a box.** Six items in the old file were `[ ]` with bodies saying the
   work had landed, and two more asserted things the code contradicted.

**Detail lives elsewhere:** [ASSUMPTIONS.md](knowledge-base/governance/ASSUMPTIONS.md) (real vs
simulated vs pending) · [feature-review/FINDINGS.md](knowledge-base/feature-review/FINDINGS.md)
(verified defect register) · [CICD.md](knowledge-base/runbooks/CICD.md) (what shipped, when) ·
[BETA_GO_LIVE_READINESS.md](knowledge-base/runbooks/BETA_GO_LIVE_READINESS.md) (beta scope).

---

## §0 Keep-the-lights-on — time-bound; prod stops if these lapse

These outrank every engineering item below. They are not features; they are the condition for
anything else in this file being true.

- [ ] **KTLO-1. Railway — being decommissioned, not paid for.** Founder direction 2026-08-19:
  development is local-only until the app is fully built and debugged; the production service is
  to be taken down deliberately rather than left to lapse unattended. CI's `migrate-prod` and
  `verify-deploy` jobs are paused accordingly (see `.github/workflows/ci.yml`, both carry restore
  instructions). **Blocked on one thing first:** a read-only census of the production database, so
  the decision is made against row counts rather than a guess — and that census runs through CI,
  which is currently dead (KTLO-2). Do not take the service down until the census answers.
  **Founder-held.** Superseded text follows for provenance:
- [ ] ~~**KTLO-1. Railway billing — add a payment method; the risk is the expiring trial credit, not
  consumption.** Re-measured 2026-08-17 (#536): 7-day usage ≈ **$3.20/month** (CPU avg 0.0002 vCPU,
  mem 0.32 GB — the container is idle), so this is the $5 Hobby plan plus a trial credit last read
  "~30 days / ~$4.97" on **2026-08-06** and unreadable by any session since (no MCP billing
  endpoint; the local `RAILWAY_API_TOKEN` is dead — #536 E8). When the credit lapses **production
  stops serving.** Railway → project `Homiquity` → Settings → Billing. Coupled: image retention is
  **72 h on Hobby** — the 2026-08-18 merge round (#539/#537/#514/#536/#543) refreshed the rollback
  window, which now relapses **~2026-08-21** without another deploy
  ([ROLLBACK.md](knowledge-base/runbooks/ROLLBACK.md) §1).~~
- [ ] 🚨 **KTLO-2. GitHub Actions billing has FAILED — every merge is blocked.** Escalated
  2026-08-19. The repo was flipped **public** on 2026-08-18, which made Actions free and *masked*
  an underlying payment failure. It was flipped back to **private** on 2026-08-19 (founder
  direction — the security pack and the open-findings register were world-readable), and the
  failure immediately reasserted: every run since 14:18 UTC dies in ~2 s with `steps: []` and the
  annotation *"The job was not started because recent account payments have failed or your
  spending limit needs to be increased."* Runs up to 14:16 succeeded.
  **Consequence, precisely:** `gate` is a required status check on `main` with
  `enforce_admins: true`, so no new PR can merge — the check never runs, the PR sits
  "Expected — Waiting for status", and nobody can bypass it. PRs whose gate went green before the
  flip keep their recorded pass and remain mergeable. The read-only prod census (KTLO-1) is
  blocked on this too.
  **DECISION 2026-08-19 — the required check was REMOVED rather than the bill paid.** Development
  is local-only and not launching, so the gate moved from GitHub to the laptop: `main`'s
  `required_status_checks.contexts` is now `[]`. Force-push and deletion protection and
  `enforce_admins` are untouched. This is safe *only because* the local gate was hardened the same
  day — `.githooks/pre-push` now BLOCKS instead of skipping when it cannot check anything, and
  `scripts/hooks-installed-guard.cjs` fails when a clone has `core.hooksPath` unset, which is how a
  fresh clone used to start ungated. Run `pnpm preflight` before opening a PR; it is the same 16
  checks CI ran.
  🚨 **RESTORE THIS BEFORE ANY RETURN TO LAUNCH.** One command — the separators are U+00B7 MIDDLE
  DOTs, not periods, and the string must match verbatim or every PR deadlocks on a check that never
  arrives:
  ```bash
  echo '{"strict":false,"contexts":["gate (typecheck · tests · schema guard)"]}' | gh api -X PATCH repos/barakatammre84/Homiquity/branches/main/protection/required_status_checks --input -
  ```
  **Fix:** GitHub → Settings → Billing & plans — resolve the failed payment and/or raise the
  Actions spending limit. The alternative is re-publishing the repo, which re-exposes
  `knowledge-base/feature-review/FINDINGS.md` and `governance/security/`. **Founder-held, and it
  now outranks everything else in this file.** Prior measurement for context:
- [ ] ~~**KTLO-2. GitHub Actions minutes — this is the platform bill, not Railway.** Measured
  2026-08-17 (#536 E9): ~13.6 CI runs/day × ~4–5 billable min ≈ **1,850 of the private repo's
  2,000 free min/month (~92%)**; overage $0.008/min. The 2026-08-06 queueing symptom is stale —
  Actions was healthy all day today (launch-gate 2026-08-17). Mitigations landed 2026-08-17: the
  local pre-push gate (#529) and superseded-run cancellation (#535). Decide: set an Actions
  spending limit **knowing a hard cap that halts `gate` also halts every merge and `migrate-prod`**,
  or accept overage. Settings → Billing → Actions.~~
- [ ] **KTLO-3. Neon production compute is unpinned — cold starts measured at 5.5–7.4 s.** The first
  request after autosuspend pays that, on the borrower funnel. Decide alongside KTLO-1 (same billing
  conversation): pin the compute / disable autosuspend on the production branch, or accept it and
  record the number in [ASSUMPTIONS.md](knowledge-base/governance/ASSUMPTIONS.md). Still unverified
  2026-08-17: the GitHub cron sweeps (every ~20–40 min) keep the compute warm and mask the cold
  start; the first borrower after a real idle window still pays it (#526 E6). **Founder-held.**
- [ ] 🚨 **KTLO-4. `main` has no gate and still auto-deploys to production. Both halves verified
  tonight, 2026-08-20T02:19Z.** (a) Branch protection on `main` now reads
  `required_status_checks.contexts: []` — the `gate` check was deliberately removed today so work
  could continue through the Actions billing failure (rationale and the restore command are in
  KTLO-2 as rewritten by [#608](https://github.com/barakatammre84/Homiquity/pull/608), unmerged).
  (b) The Railway service is **still connected**: `get-service-config` returns
  `source: {repo: barakatammre84/Homiquity, branch: main, checkSuites: false}`, custom domain
  `www.homiquity.com` attached, and prod is currently serving `b799b91d` — equal to `origin/main`.
  `checkSuites: false` means Railway does not wait for CI at all. **Composed, those two facts mean
  any merge tonight ships straight to a live public site with zero automated verification** — a
  state neither change created alone and neither PR describes. Close it by doing **one** of:
  disconnect the Railway GitHub source (the action #608 itself names as the one that actually stops
  deploys, and the one that matches the local-only direction); or restore the required check once
  billing is resolved. Until one of them is done, **treat every merge as a production deploy of
  unverified code** and run `pnpm preflight` locally first. **Founder-held.**

---

## §1 Founder-held — blocks go-live

> **Framing note, 2026-08-19 (evening-triage).** Founder direction that day: **development is
> local-only until the app is fully built and debugged; there is no live launch.** So "blocks
> go-live" in this section's title now describes a *deferred* event, not this week's deadline —
> the items are still real, their urgency is not. Ranking below therefore follows CHARTER §1
> (lender package / borrower experience) rather than proximity to a flip date. §0 still outranks
> everything: the site is still up and still auto-deploying (KTLO-4).

- [ ] **1.1 Confirm the go-live flip that live probes say already happened.** Prod has served
  ungated public pages since 2026-08-06; re-probed 2026-08-17: `/` and `/api/rates` 200 with no
  prelaunch/waitlist markers (launch-gate report). `PRELAUNCH_GATED` and `VITE_PRELAUNCH_GATED`
  still exist as **names** in Railway variables and values are unreadable from any session — open
  the panel, confirm both are `false`/removed, then archive this line. `BETA_ACCESS_CODE` is a
  separate front-door switch (currently unset — #526 E2).
- [ ] **1.2 Railway service variables — live read 2026-08-17 (#526 E2): 19 non-injected names set;
  launch-critical still unset:** `GCS_SERVICE_ACCOUNT_KEY` + `PRIVATE_OBJECT_DIR` (+
  `PUBLIC_OBJECT_SEARCH_PATHS`) — durable uploads; `request-url` 503s `UPLOADS_UNCONFIGURED` until
  they land; `SENTRY_DSN` + an uptime monitor on `/api/health` (a prod crash between CI
  `verify-deploy` runs is invisible); `GOOGLE_MAPS_API_KEY` — `server/routes/geocode.ts:34` 503s
  without it, so **every production address lookup fails today**; `RAPIDAPI_KEY` (or record staying
  on the simulated rate survey in ASSUMPTIONS.md). Also delete the stray lowercase `fromemail`
  sitting beside the real `FROM_EMAIL`. Verified done and dropped from this line 2026-08-17:
  SendGrid key + `FROM_*` set; `CRON_SECRET` matches (sweeps 200 — #526 E6); `DATABASE_URL` on a
  populated branch (data-backed routes 200). ~45 min.
- [ ] **1.3 Wholesale-lender outreach — UNBLOCKED since 2026-07-13; still unworked five weeks later
  (2026-08-17).** F1 cleared with NMLS #427468, but the shortlist still gated five actions on "once F1
  clears". Live now: the UWM AE / Director-hotline call (sandbox process + whether BOLT exposes a
  PPE-consumable feed); the Newrez Brigade contact for the sandbox path; Angel Oak / Newrez
  approval-checklist requests; a manual read of Plaza's wholesale-broker guide PDF for
  net-worth/bond minimums; and **re-verifying all five are still broker-friendly and NMLS-active**
  (the file is a 2026-07-04 snapshot). Detail:
  [wholesale-lender-shortlist](knowledge-base/research/my-research/wholesale-lender-shortlist-2026-07-04.md).
- [ ] **1.4 Start the F3 (credit vendor) and F6 (DU/LPA) applications now** — vendor paperwork lead
  time runs *in parallel* with everything else, not after it. Starting the paperwork is not the same
  as building against it. No application opened as of 2026-08-17 (#526). Ask in the same first
  email: SOC 2 Type II + signed DPA + permissible-purpose / FCRA end-user certification package
  (F3); both the DU **and** LPA legs (F6).
- [ ] **1.5 Production reseed for #24** — grids rerun + BRC-J30 jumbo min `806500.01`.
  `seedMarketPricing` is skip-if-exists, so this is a **destructive wipe-and-reseed**.
  Founder-supervised.
- [ ] **1.6 Status-vocabulary data migration on prod.** Dry-run
  `npx tsx scripts/migrate-status-vocabulary.ts`, confirm whether it already ran, apply with
  `--apply` if not. Founder-supervised (production data write).
- [ ] **1.7 Counsel gates, aggregated** (detail:
  [BETA_GO_LIVE_READINESS.md](knowledge-base/runbooks/BETA_GO_LIVE_READINESS.md) §5): BUILD-1
  pre-license calculator deviation · PH-2 consent copy · the Reg N cite confirmations from #138 ·
  the UAL §5 halal-lane review · **an ad-imagery / Fair Housing marketing policy — none exists**
  (flagged by `attached_assets/lifestyle/CREDITS.md`) · ratification of
  [MODEL_RISK_GOVERNANCE.md](knowledge-base/governance/MODEL_RISK_GOVERNANCE.md), which both READMEs
  cite as an authority while it is still marked DRAFT. **Added 2026-08-19 (qa-sweep F-0819-04,
  counsel Ask 2 — the half a session cannot close):** in a *brokered* transaction, is Homiquity the
  **creditor** whose federal administering agency belongs on an adverse-action notice
  (§1002.9(g))? The mechanical half is settled and is a §3 ticket — every notice we generate today
  names the **CFPB**, while Reg B Appendix A item 9 assigns the **FTC** to a non-depository
  originator — but which entity is named turns on the creditor question, so the fix is written
  against your answer, not ahead of it.
- [ ] **1.8 Regulatory subscriptions + Fannie Developer Portal** (~30 min): Fannie Selling Guide
  notifications (**email is the only Fannie channel** — their page is bot-protected), Freddie Guide
  bulletins, FHA INFO, VA lender news; register for the Developer Portal (public APIs free,
  business-partner APIs unlock with F6). See
  [REGULATORY_MONITORING.md](knowledge-base/compliance/REGULATORY_MONITORING.md). Urgency doubled
  2026-08-17: the automated Tier-2 watcher (`reg:watch`) has been dark since 2026-07-04 (§3.15) —
  right now **no channel, automated or human, reports a guideline change**.
- [ ] **1.9 Delete the dead `GEMINI_API_KEY` from local `.env`** — all AI is Anthropic; prod
  verified clean 2026-08-17 (absent from the live variable list, #526 E2). The same local `.env`
  also carries a dead `RAILWAY_API_TOKEN` and a dead `OPENAI_API_KEY` (#536 E8) — delete all three
  together.
- [ ] **1.10 Counsel: is the referral-commission payout permitted?** Two questions, both opened by
  the [2026-08-08 financial re-audit](knowledge-base/logs/2026-08-08-financial-architecture-reaudit-commission-payouts.md)
  (F-21) and recorded in the regulatory ledger under `regz-1026-36d1-referral-commission-payout` on a
  **14-day** interval so `pnpm checkup` goes loud. (a) **Reg Z §1026.36(d)(1)** — a *fixed* percentage
  of the amount of credit extended is permitted; `POST /api/broker/commissions` takes a percentage
  chosen **per file** by an admin, and `calculateAgentCommission` would pay 25% of a lender comp
  figure that varies by lender and product. (b) **RESPA §8** — the partner tables were built with no
  fee/commission columns *by design* (charter §5-C1), and `broker_commissions` is that column set on
  the same referral edge. Today only the staff `broker` role can reach it (the `agent` role in the
  gate does not exist), so nothing is exposed — but §3.7 schedules wiring it up. **No commission may
  be paid on a live file until this is answered.**
- [ ] **1.11 Set the four email-auth DNS records at Squarespace — the 2026-08-17 vendor FAIL
  (#526 E1).** SPF TXT on the apex, DMARC TXT at `_dmarc`, and SendGrid's `s1`/`s2` DKIM CNAMEs
  **on the apex** (the existing `s1._domainkey.www` is scoped to the wrong host and never queried).
  Until then every password reset, verification and waitlist email leaves unauthenticated and lands
  in spam while `/api/health` reports email fine. MX (Google Workspace) intact — inbound
  unaffected. Recovery values: the DNS zone notes. ~20 min.
- [ ] **1.12 Authorize a Reg Z / FCRA / CROA capture pass into `docs/reg-z/`** (compliance-watch
  2026-08-17 ⛔5 + qa-sweep U-26; procedure in `docs/reg-z/README.md`): 12 CFR 1026.36(d)(1)-(2),
  1026.32(b)(1), 1026.19(e)(3), FCRA 1681s-2, CROA 1679b. **Corrected 2026-08-17 evening — the
  premise this item and `CLAUDE.md` both rest on is stale:** two qa-sweep agents independently got
  **200** from `consumerfinance.gov/rules-policy/regulations/1026/…`, the eCFR *versioner API*, and
  `law.cornell.edu`; only eCFR **HTML** is blocked. So this is no longer "only the founder can
  fetch it" — it is that nothing is *captured and versioned*, so a reading is unrepeatable. The
  founder decision is narrower and cheaper than it was: **authorize a session to capture those
  texts into `docs/reg-z/` and amend the `CLAUDE.md` "every authoritative source is blocked"
  clause** (it is a binding project rule, so a session may not amend it unasked). **The first of
  five ledger entries reaches its review date TODAY (2026-08-18); the remaining four follow through
  2026-08-23** — past this point `pnpm checkup` is reporting on stale verification, and two P1s
  (F-076, F-079) stay held below their evidence until a Reg Z reading may be asserted.
- [ ] **1.13 One NMLS login session, four outcomes** (compliance-watch 2026-08-17 ⛔1–4 +
  [STATE_LADDER.md](knowledge-base/compliance-watch/STATE_LADDER.md)): (a) **does an IL-licensed
  MLO with an approved sponsorship exist?** — if not, nobody can originate the first Illinois loan
  and this becomes the top item in this section; (b) pull Consumer Access / MU1 / surety bond /
  financial-statement records; (c) download the IL checklists from the NMLS Resource Center
  (unreachable from sessions) and hand them to a session for `docs/nmls/`; (d) confirm the first
  MCR due date (computed: Q3-2026 RMLA due **2026-11-14**; prep draft ready in
  `knowledge-base/compliance-watch/drafts/`) and calendar it. ~1 h.
- [ ] **1.14 Decide F-040's scope: the stored FCRA disclosure promises 120-day consent validity,
  but `credit_consents` has no expiry column and no gate checks age.** Does 120 days bind funnel
  soft-pull consents too, or only `/credit-consent` hard pulls? Strictest defensible reading (bind
  everything, force re-consent past 120 d) is the default absent an answer. The mechanism (expiry
  column + age gate, expand-only migration) is a routine engineering item once decided (PE-006).
- [ ] **1.15 Counsel: is the borrower Loan Options page a §1026.18 disclosure?** (qa-sweep 2026-08-17
  ⛔3, F-076.) If it is, the §1026.22(a)(2) 1/8% APR tolerance is exceeded **4–7×** and F-076
  escalates P1 → P0. Fetching the regulation does not settle it — it is a characterization
  question. It gates how *fast* §3.18 must move, not whether it moves, so it does not block that
  work starting.

---

## §2 Engineering — launch-blocking, ordered

- [ ] **2.2 Fix uploads end-to-end**, then run the acceptance test. The code half is done
  (memory storage, honest failure copy in #444); it is `GCS_SERVICE_ACCOUNT_KEY` +
  `PRIVATE_OBJECT_DIR` from §1.2 that makes it real (names confirmed still unset in the 2026-08-17
  live read — #526 E2). Uploads silently vanishing is the single worst borrower-facing failure
  available to us.
- [ ] **2.3 Run [PROD_ACCEPTANCE_TEST.md](knowledge-base/runbooks/PROD_ACCEPTANCE_TEST.md) end to
  end** once §1.1 and §1.2 land. See §5.
- [ ] **2.5 F-080 — the delivered package drops the co-borrower.** One `PARTY` is emitted for a
  two-borrower file while **both** employers and both incomes are emitted under it, so the package
  misstates who earns the income, under the wrong SSN — and it validates clean (`xmllint` passes,
  `validateULDDCompliance {"valid":true}`), which is why no gate catches it. Authority is in-repo:
  `docs/fannie-mae/uldd-implementation-guide.pdf` p.14 — the PARTY container repeats for multiple
  borrowers. Fix: one PARTY per `borrowerSequenceNumber`, employment filtered by sequence.
  **Sequencing constraint (qa-sweep ⛔4): ship this with or before F-052/F-053** — those two
  currently block organic files from the transmission path, and fixing them alone would promote a
  materially false file into an immutable SHA-256-hashed lender submission.

---

## §3 Engineering — post-flip, ordered

- [ ] **3.1 ULAD field-mapping audit + escalations E-1…E-4.** The MISMO **structural** work is
  finished — #430 closed the last defect classes and the XSD gate now validates through a wrapper
  importing both `MISMO_3_0.xsd` and `ULDD_Phase_5_Extension.xsd` with a negative control. What
  remains is L6's untouched second half: audit `shared/mismo.ts` against
  `docs/fannie-mae/schemas/ulad-mapping-document.xlsx`, and resolve **E-1…E-4** (registered
  **U-14…U-17** in [FINDINGS.md](knowledge-base/feature-review/FINDINGS.md)) — the MISMO 3.0-vs-3.4
  authority conflict, the URLA 5b-J/5b-L foreclosure-family ambiguity, whether the eight orphan
  concepts belong in a ULDD delivery at all, and the unproven `OTHER` wrapper convention. **F-023/U-4
  stays open on the ULAD leg** — #430 pinned base-model names, not ULAD v1.8 ones.
- [ ] **3.3 Internal data-lineage view for masked lender identity.** Borrower surfaces mask the
  wholesale lender by doctrine (`shared/borrowerOfferView.ts`); compliance and staff need the
  unmasked lineage somewhere.
- [ ] **3.4 Bind `/api/leads` to something — or delete it.** It has no caller anywhere in
  `client/src`. Needs a product decision first (headless partner-embed vs. a Homiquity-hosted form);
  PartnerHub prompt **PH-6** is chartered to resolve exactly this.
- [ ] **3.5 NMLS state-routing gate** — the assignment engine must refuse to route an application in
  a regulated state to an unlicensed LO. Buildable now that F1 has cleared.
- [ ] **3.6 Close the advisory-vs-binding gap.** S-05/S-06/S-07 rental offsets now reach
  `UnderwritingInput`, but `preUwFlags` is still read by neither `decisionEngine.ts` nor
  `underwritingEngine.ts` — so **S-01 income seasoning, S-03 sleeper debt and S-04 large deposits
  remain advisory-only**, and a `"blocking"` flag can fire on income the decision counts at full
  face value. `scenarioCatalog.ts` marking them `implemented` overstates it. Founder call between:
  (a) fold adjusted figures into `aggregateBorrowerFinancials` with explicit PRELIMINARY provenance,
  or (b) keep the engine on raw figures and make every `"blocking"` flag a real CTC-gating condition
  — verifying `checkPipelineProgress` actually enforces it.
- [ ] **3.7 Optimization-engine dispositions:** wire `matchAndPriceBorrower` / `getCoachPreFillData`
  to a surface **or delete them**; fire `calculateAgentCommission` from the funded-loan transition
  (near `graduateClosedLoan`) rather than a schedule. **Blocked on §1.10** — wiring this fires a
  payout whose Reg Z / RESPA posture is unanswered. When it is unblocked, the wiring must write
  through `evaluateCommissionPayout` (`shared/commissionPayout.ts`) the way
  `POST /api/broker/commissions` does: this path inserts straight into `broker_commissions` and so
  is bounded by nothing and audited nowhere. Its own two defects — the dead `"agent"` role check and
  the 275 bps fallback that assumed the top of the seeded range — are already fixed (audit F-21).
- [ ] **3.8 Tag agent-sourced inbound leads.** `leads.source` has no value for an agent-referred
  borrower, so the playbook's 30%-agent-sourced gate is **structurally unmeasurable**. Needs a
  business decision on the intake mechanism (referral link / agent portal / manual code) before any
  engineering.
- [ ] **3.9 VA funnel.** The engine already routes `isVeteran` → VA products (580 FICO / 100% LTV
  seeded). Missing: COE check, funding-fee calculation incl. exemptions, residual-income table,
  IRRRL flow.
- [ ] **3.10 Real-time messaging transport** — presence dots are decorative (no WebSocket). Wire it
  to something real or remove it. Low priority; removing it is a legitimate answer.
- [ ] **3.11 LO/staff assignment engine** — respects 3.5. Build when there are humans to route to.
- [ ] **3.12 Program next-prompts** (charters in [`specs/`](knowledge-base/specs/)): **UAL P7**
  halal-lane channel gates (two founder calls + the spec-§5 counsel review; funder-agnostic math only
  until then) · **LO-3** client-facing Advisor Report (its LO-2 dependency merged) · **PH-3**
  partner-asset compliance guard + co-branded education engine.

- [ ] **3.14 Recognize platform fee income** (audit F-22) — **unblocked 2026-08-08: recognize ON
  RECEIPT.** That settles the basis with it — you recognize what arrived, and the amount *charged*
  becomes the expected side for variance, mirroring the compensation lifecycle F-6 built. The charged
  snapshot is therefore the **actually charged** figure (the trimmed post-F-17 amount the LE
  disclosed), not the standard schedule. The revenue line today counts only the lender remittance,
  while the $500 application + $1,500 underwriting fees are our own charges levied under **both**
  compensation models and recognized nowhere — combined with F-20 that meant both sides of the margin
  were wrong in opposite directions. Build: snapshot the schedule charged at LE issuance, record
  collection at settlement beside `compensation_received_at`, and surface the charged-vs-collected
  variance the same way lender short-pay is surfaced.

- [ ] **3.15 Register `reg:watch:save` on a schedule — or delete it and declare Tier 2 human-only**
  (#526 E5). `data/regulatory/regulatory-watch-state.json` last ran **2026-07-04** while
  `REGULATORY_MONITORING.md` still calls the tier "automated, live" — the CHARTER §0 fossil
  pattern. Cheapest honest fix: a weekly CI step + a `lastRun` age assertion in `pnpm checkup`.
- [ ] **3.16 Un-red `pnpm checkup`: record an accepted-risk its dependency check can read**
  (launch-gate LG-3, 2026-08-17). 1 low + 4 moderate advisories, all in
  `@modelcontextprotocol/sdk`'s HTTP transport, which `server/mcp/index.ts` never loads (stdio
  only). Bump the SDK when upstream patches; **no `pnpm.overrides`**. A permanently-red check is a
  dead check.
- [ ] **3.17 Adjudicate the 13-commit orphan `claude/lucid-edison-br5hsb`** (2026-08-12; no PR
  until rescue-draft [#542](https://github.com/barakatammre84/Homiquity/pull/542)): +1,543/−72
  including five compliance behavior-test suites (FCRA consent order, ECOA intake-never-denies,
  invite-validate PII audit, VA residual parity / F-051) and server fixes. Its F-042 slice is
  superseded by #537; the rest may still be live value. **#537 merged 2026-08-18T12:27Z, so the
  precondition is met and this is actionable now:** rebase, drop the superseded slice, land what's
  green — or close explicitly. Five days of invisibility already cost one duplicate rebuild
  (#537 vs `15c1f19`).
- [ ] **3.18 The borrower-facing APR is not an APR** (qa-sweep F-076, P1). `loanAnalysis.ts:138`
  computes `apr: rate + (loanType === "fha" ? 0.5 : 0.25)` — a flat spread. It understates by
  **0.45–0.94pp** whenever MI is in force, and the specimen that needs no legal ruling is this: on
  the `points: 1` scenario the borrower pays a **$3,600 discount point and the displayed APR moves
  0.000pp**. The repo asserts the correct invariant in four places (`apr.ts:6-8`, invariant I5, the
  app-guide, a spec) and the *marketing* surface already does it right — only the borrower surface
  contradicts them. Fix: route through `calculateMortgageAPR`, and pin it with a test asserting
  `loan_options.apr` came from the solver (F-090 shows the current test cannot). Severity depends
  on §1.15.
- [ ] **3.19 One loan, three different MI figures** (qa-sweep F-077 + F-087, P1). The MI the LE
  discloses and the DTI the engine decides on both come from a hardcoded card that exceeds the
  `CONVENTIONAL_PMI` matrix in **all 32 swept cells (1.42–2.17×)**;
  `underwritingEngine.ts:319-320` computes `calculatedDti` *before* the matrix lookup at
  `:400-411`, and `resolvedPmiMonthlyPremium` is grep-proven never read in any comparison — so one
  borrower can see **$239.20, $184.00 and $429.33** for the same loan. Fix: delete `calculatePMI`,
  use the `pmiAnnualRate` `derivePricing` already resolves, and correct the false docstring at
  `loanCosts.ts:594-599`.
- [ ] **3.20 The public credit-tier calculator is flat** (qa-sweep F-078, P1 — **live in production
  today**). Reproduced against prod: `GET /api/calculators/credit-tiers` returns exceptional (790)
  **6.376** … building (620) **6.401** — **0.025pp across the entire FICO range**, where the
  intended spread is 0.625pp. Two `/100` conversion sites, both dating to the initial commit and
  never touched. Fix: one points→rate conversion helper, both sites. Borrower-adverse and on a
  public surface, which is why it outranks the rest of §3's new rows.
- [ ] **3.21 TRID is computed into the void, and the badge lies in the safe direction**
  (qa-sweep F-079 + ux-30, P1). `mismoValidation.ts:766-820` computes `tridStatus{leDueDate,
  leIssued}` and **nothing in `client/src` reads it**; seven cron sweeps exist and none touches
  TRID. The verified consequence is the inverse of the original claim: **173 of 176 files render an
  affirmative green "TRID Compliant" badge derived from a null due date** (exactly one renders red,
  truthfully). Fix: give the borrower a gated route to their own LE (the server already
  distinguishes `isBorrower`), split the badge into "delivered on X" vs "within window", and rank
  the intake pool by `leDueDate`. **The badge half is in flight 2026-08-18 as
  [#546](https://github.com/barakatammre84/Homiquity/pull/546)** — makes
  `withinThreeBusinessDays` three-valued (`true`/`false`/`null`) so an unopened TRID window stops
  writing an unearned `true` into the immutable `trid.loan_estimate_delivered` audit record
  (`server/routes/underwriting/delivery.ts:110`). ⚠️ **#546 went `CONFLICTING` when #514/#536
  landed** — it needs a rebase before its green gate means anything. The borrower LE route and the
  `leDueDate` ranking remain open after it.
- [ ] **3.22 Workflow 3's QA script cannot see the defect class it exists to catch** (qa-sweep
  D-014, P1). Run exactly as scripted it catches **3 of 9** registered Domain 8 findings and
  **misses the P0** — every step-3 assertion is a schema assertion, and every one of these defects
  is a schema-valid falsehood (`refer → Approve`, `approve_ineligible → Approve`,
  `amortizationType=adjustable → "Fixed"` all pass `xmllint`). Add an **"emitted == stored"** leg
  to the script *before* re-running it, or the next sweep re-certifies the same package.
- [ ] **3.23 ~~Kill the orphan dev server on port 5002~~ — DONE 2026-08-19 — and make health
  honest** (qa-sweep ⛔6, named in three consecutive reports and closed by none of them).
  PID **20814** answered `/api/health` `200` from code dated **2026-08-05**, out of worktree
  `.claude/worktrees/launch-hygiene` which no longer exists, and **its payload carried no `commit`
  field** — so it could not be dated from the outside and any routine probing 5002 verified
  15-day-old code and reported a live pass. Evening triage re-probed it
  (`ps` START `Wed Aug 5 16:08:46 2026`, `--import …/launch-hygiene/node_modules/…`), **killed it,
  and confirmed the port refuses connections** (`curl` exit 7). Nothing else on 5001/5002 was
  touched. *Deviation noted: this is ops, not a file edit, so it is outside CHARTER §6's "never
  edits code paths" rather than against it — recorded here because acting is more honest than
  re-flagging a defect a fourth time.* **What remains is the durable half:** decide whether a
  `/api/health` without `commit` should be a startup error, since the deploy rail's entire proof is
  that field — an orphan that cannot be dated from the outside is what made this cost three runs.
- [ ] **3.24 A routine can fire and leave no artifact, and the suite reads that as "did not run"**
  (evening-triage 2026-08-18, **recurred twice on 2026-08-19 — this is now a pattern, not an
  incident**). Scheduler state is read directly each run; every registered routine carries a
  recurring `cronExpression`, no `fireAt` one-shots, and every `nextRunAt` matches its cron. So the
  defect is not registration, it is evidence: on 2026-08-19 **`primary-engineer` (`lastRunAt`
  10:21:58Z) and `launch-gate`/Trunk Health (`lastRunAt` 10:48:50Z) were both dispatched and left
  no report on any branch** — `git ls-tree` over all 60 remote refs finds only the wiring-audit and
  qa-sweep reports for that date, and no worktree holds an uncommitted one. Same shape as
  `lender-delivery-gate` on 2026-08-17. Three dispatches, three silent losses, and the day's two
  build lanes are the ones that vanished. Fix (unchanged, now with a third data point behind it):
  have each routine write a `STATUS: STARTED` stub to `reports/` at orient time so a crash leaves
  evidence, and have triage compare `lastRunAt` against the report set rather than reading the
  report set alone — **triage already does the second half; only the stub is missing.** It is the
  §0 lesson ("a routine that cannot be shown to have run is not a control") one level deeper.
- [ ] **3.25 The denial chokepoint fails open, and a green test pins it that way** (qa-sweep
  F-0819-01, P1 — **the control ECOA compliance on the denial path rests on**).
  `ensureAdverseActionForDenial` (`server/routes/underwriting/creditAdverseActions.ts:556-561`)
  de-dupes through `getAdverseActionsByApplication` (`:360-366`), whose entire predicate is
  `eq(adverseActions.applicationId, applicationId)` — **no `actionType`**. Any pre-existing notice
  of any type satisfies it, and staff can create a `counteroffer` one (`compliance.ts:861,878`
  accepts that enum behind `isInternalStaffRole` + deal-team). A file then reaches `denied` with
  **zero denial notices and no audit entry** — the audit write sits inside `if (aa.created)`, so
  the bypass is traceless. Fix: scope the de-dup by `actionType`, and **re-fixture
  `tests/adverseActionFcraChokepoint.test.ts:225-233`**, which today fixtures
  `[{ id: "aa-preexisting" }]` with no `actionType` and asserts `{ok:true, created:false}` — 12/12
  green over the bug. Owner: Backend Data Engineer (§6b).
- [ ] **3.26 A co-applicant's protected-class record can be overwritten with the primary's answers,
  and the co-borrower is never asked at all** (qa-sweep F-0819-02, P1 — question A *and* the
  fair-lending join). `server/routes/underwriting/compliance.ts:1310-1312` and `:1348-1350` both
  `LIMIT 1` with **no `ORDER BY`** and no `borrowerSequenceNumber` key; nondeterminism was
  reproduced empirically on a same-shape temp table (`after insert → seq=1`; after re-saving seq 1
  → `seq=2`). Separately `server/routes/dashboard.ts:118-121` measures HMDA completeness by row
  *presence*, so a two-borrower file reads complete after one answer and the co-borrower is never
  prompted. Fix: key GET+POST by `borrowerSequenceNumber`, make the completeness check
  per-borrower, add the missing unique constraint (expand-only, same-PR migration). This is the
  same single-row-per-application trap that `mismo-coapplicant-model` already documents — **never
  match by array position.** Owner: Backend Data Engineer (§6b).
- [ ] **3.27 The §1002.9(a)(1)(i) 30-day clock is not computable — there is no completed-application
  timestamp** (qa-sweep F-0819-05, P1). Two sites anchor the deadline on the wrong event
  (`server/services/adverseActionDelivery.ts:148-166`, `server/services/taskEventEmitter.ts:143-151`);
  the (a)(1)(**ii**) incomplete-application branch is correctly anchored and is *not* the bug. The
  platform records no "application became complete" moment at all, so the fix needs a column, not a
  formula. 🚨 **Do not backfill a guessed value onto a compliance/provenance column** — a NULL is an
  honest gap, a wrong value is a falsified record; if existing rows cannot be anchored truthfully,
  leave them NULL and report the coverage. Owner: Backend Data Engineer (§6b).
- [ ] **3.28 Every write on the Homeowner Hub returns 500** (qa-sweep F-0819-03, P1 — the Hub's
  entire write half). `server/routes/guaranteesHomeowner.ts:134-145` / `:230-243` / `:178-190`;
  nine live probes: dates-filled → 500, dates-blank → 500, keys-omitted → 201; equity snapshot 500s
  with `snapshotDate` as both a string and an epoch; refi-alerts with both rates → 201.
  `DashboardView.tsx:50-51` mounts the two broken sections for **every** profile. Fix: validate
  `POST /api/homeowner/profile` through `insertHomeownerProfileSchema` and supply `snapshotDate`
  plus the two rates server-side.
- [ ] **3.29 The funnel's autosave silently drops three captured answers, and the restore path reads
  one of them back off a column nothing writes** (wiring-audit 2026-08-19, Break 2). The client
  sends them, `loanApplicationIntakeUpdateSchema` **validates** them, then the
  `UPDATABLE_COLUMNS` whitelist in `server/routes/lending/statusDecisions.ts:78-84` discards them —
  no 400, no log. Two are the VA residual-income inputs; the third,
  `avoidsInterestFinancing`, is read back by `draftToFormValues`, so the two sides of that wire
  provably disagree. Fix (patch already written out in the wiring-audit report, with its `parseInt`
  note): add the three columns, plus a route test that PATCHes all three and reads them back. Then
  restore the two VA fields in `draftToFormValues` — **or, if the whitelist addition is rejected,
  delete the `avoidsInterestFinancing` read**, because a line that reads a column nothing writes is
  worse than an absent one: it makes the round-trip look closed. Owner: Backend Data Engineer
  (§6b); the client half is the wiring audit's.
- [ ] **3.30 Adverse-action notices name the wrong federal agency** (qa-sweep F-0819-04, P2 —
  mechanical half of §1.7's new counsel question). Every notice we generate names the **CFPB**;
  Reg B Appendix A item 9 assigns the **FTC** to a non-depository originator, and the Appendix
  forecloses the supervisory-authority defence in its own words. Derive the agency from
  `shared/companyIdentity.ts` rather than hardcoding it, so the answer moves with the entity —
  **but the entity to name is counsel's call (§1.7), so build the derivation and leave the value
  configurable.** Downgraded from P1 in verification: the reasons, the creditor identity and the
  FCRA attribution are all still correct, and the misdirection is toward an agency that does take
  mortgage complaints.
- [ ] **3.31 `feature-review/FINDINGS.md` overstates its own backlog, and every coverage read is
  distorted by it** (qa-sweep D-0819-04). Ten rows whose status cells say `**FIXED**` sit under
  `## Open findings`; the visible consequence is that **open P0 read 3 when it is 0**, and three
  P1 rows still read `open` while their fixes merged 2026-08-18. Move them to `## Closed` in one
  pass. Pure hygiene — but CHARTER §1 names exactly this hazard, and it cost this run a
  re-verification to catch. Owner: QA Sweep (it owns that register).

---

## §4 Blocked on a contract or a document — do NOT start

One line, one unblocking trigger. Every adapter already exists as a deterministic simulation, so
each of these is a small, well-defined ticket the day its trigger fires.

- [ ] **F3 — credit vendor** (CRS One / iSoftpull). *Trigger: signed contract.* Then the real adapter
  in `server/mcp/vendors.ts` (it throws today if a key is set). **The medical-collections work ships
  with it**: FHA 4000.1's 5%-of-balance rule above $2,000 aggregate with medical excluded, plus the
  Fannie B3-5.3-09 payoff carve-out. No collections→DTI path exists today so nothing computes wrongly
  yet; the day real reports arrive, FHA files compute DTI wrong in both directions without it. *(The
  "2026 federal Medical Debt DTI exclusion" **does not exist** — verified 2026-07-04; the CFPB Reg V
  rule was vacated 2025-07-11.)*
- [ ] **F4 — Plaid production keys.** *Trigger: keys issued.* Real Link + asset reports through the
  existing webhook.
- [ ] **F5 — Truv contract.** *Trigger: signed contract.* Real VOIE into `verification_reports`.
- [ ] **F6 — GSE AUS access (Fannie DU + Freddie LPA).** *Trigger: credentials.* Submit to both
  engines at once (decided 2026-07-04) for best fit and rep-and-warranty relief.
- [ ] **F7 — AVM contract** (HouseCanary or other). *Trigger: signed contract.* Real valuations via
  `retrieve_property_valuation`.
- [ ] **F11 — Pricing engine (Lender Price and/or Mortech).** *Trigger: signed contract.* Build the
  MISMO transfer middleware; the internal rate-sheet + LLPA engine becomes the clearly-marked
  simulation behind the same interface. Optimal Blue / LoanSifter evaluated and passed on.
- [ ] **F12 — IRS IVES transcript access (4506-C → A2A).** *Trigger: founder IRS e-Services + IVES
  enrolment **and** counsel sign-off on the consent flow and FTI handling.* No schema, code, or env
  var before both.
- [ ] **F13 — Down Payment Resource feed.** *Trigger: a founder decision to pursue it at all*, then
  SOC 2 + a signed DPA + permissible-purpose review. Table-fed import only, scoped to
  `LICENSED_STATES`; borrower income/ZIP must never egress.
- [ ] **F14 — Fannie authority corpus for rent-history underwriting.** *Trigger: the Selling Guide
  section on positive rent history, the DU Release Notes, and the asset-verification-report spec land
  in `docs/fannie-mae/`.* Until then rent-history-to-DU cannot even be adjudicated.
- [ ] **F15 — Freddie Mac corpus.** *Trigger: founder decision + Form 91 lands in a new
  `docs/freddie-mac/`.* No such directory exists, so every "Freddie program" claim is locally
  unverifiable and LPA stays a simulation leg.
- [ ] **LS-10 slice 3 — real per-lender portal hand-off.** *Trigger: a signed broker–lender
  agreement.* Slices 1 and 2 shipped (status machine; MISMO package assembly + immutable snapshot +
  sha256). `submitToLenderPortal` stays a deterministic simulation.
- [ ] **OPT-2 — stale-application re-engagement email.** *Trigger: an email consent + unsubscribe
  path, plus a §9 security review.* Note the original blockers **have cleared** — quiet hours (#24)
  and the SMS STOP/opt-out ledger (#25) both shipped. What `sendReEngagementEmails` still lacks is
  consent and unsubscribe on the **email** leg. Do not schedule it until both exist.

---

## §5 Flip day

Do not improvise it. The checklist is
**[runbooks/PROD_ACCEPTANCE_TEST.md](knowledge-base/runbooks/PROD_ACCEPTANCE_TEST.md)** — run it top
to bottom against `https://www.homiquity.com` (the `www` is load-bearing; the apex is a Squarespace
forward), check every ⛔ BLOCKER, and paste the result into the change ledger.

Its §0 preconditions are the ones people skip, and both have burned us: prove the deploy is current
**by `commit`, not by a green check** — a failed Railway build leaves the previous container serving
— and prove the app is talking to the **right database** by hitting a data-backed route, because
`/api/health` returns 200 from the wrong one.


## Core integration into the existing Homiquity app

Founder-directed on 2026-09-04. [Integration sequence and acceptance gates](knowledge-base/specs/CORE_INTEGRATION.md). Existing Homiquity remains the product host; reuse Core capabilities without duplicating accounts, applications or uploads.

- ✅ Officer review checkpoints: the existing Borrower File records application/evidence checkpoints, detects later changes and links into the current review tools.
- ✅ Document lineage and ownership: current evidence keeps immutable byte fingerprints, source attribution, borrower/business/property and period mapping, replacement history, focused checkpoint invalidation and consistent borrower/staff projections.
- ✅ Financial workpapers and cited memo: reviewed calculations, exact evidence references, dependency versions and a current approved memo now travel with the existing lender package.
- ✅ Borrower correction loop: one secure request carries upload, exact rejection, immutable replacement, condition re-arming and human acceptance without repeat application questions.
- ✅ Proven overlap retired: the obsolete message-level request mutation and unused asynchronous condition writer are gone; legacy rows reconcile, transient review contention is retried safely, the full correction journey passes and the prior build remains rollback-compatible.
- Next external gate: validate a real package and correction exchange against a lender's current receiver instructions once a lender relationship and submission workflow are available. Internal simulation does not close lender acceptance.
