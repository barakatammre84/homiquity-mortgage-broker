# Feature Review — Domain Team Charters

Thirteen domain teams + one cross-cutting UX lens. Each charter lists: subsystems + primary
files, client surfaces, intended-use source docs, and owned tests. A `feature-reviewer` run
takes ONE numbered charter as its brief; the UX lens runs `ux-reviewer` across all surfaces.
Program rules: `CHARTER.md`.

> **Not to be confused with `knowledge-base/handbook/FEATURE_MAP.md`.** That file partitions the same
> code into **41 owner areas**, each with an implementing `hq-*-owner` agent. These 13 domains are the
> *review* partition — a `feature-reviewer` reads one of them and reports findings, never fixes. The
> two are refinements of each other, so a file that appears in one and not the other means one of them
> has drifted, and it is worth finding out which.

> **Census (verified this session, supersedes the old "37 subsystems / 40 surfaces / 7
> workflows"):** ~**95 backend subsystems** · **88 routed client pages** (95 routes across 13
> nested `client/src/pages/` dirs) · ~**14 end-to-end workflows** (8 fully wired / 4 partial / 2
> broken-from-UI at the 07-08 audit — **both broken flows are wired as of 2026-07-12**, see the
> WORKFLOWS.md ledger). The prior 9-domain taxonomy left ~⅓ of the code unowned — the added domains
> (3 AI Coach/extraction, 4 Verification & credit, 9 Compliance analytics, 10 Borrower graph &
> data intelligence, 12 Property/listings/homeowner) close that gap.

Status ledger (updated by the orchestrator after each run):

| # | Domain | Last reviewed | Result |
|---|---|---|---|
| 1 | Public funnel, acquisition & education | 2026-08-08 | public-funnel-01/02 (P2) fixed `cef2890` + 1 refuted (ApprovalStrength SEO half). **2026-08-08 UX/SEO pass:** public-funnel-05/06 (P3, both finding-verifier CONFIRMED) — article↔persona content-to-conversion linking is one-directional (persona→article exists via `RelatedGuides`, article→persona missing) and inconsistently applied across sibling persona pages. **CLEAN, verified this pass:** `FAQ.tsx`/`Glossary.tsx` JSON-LD wired correctly; `Landing.tsx` trust signals present (`VeteranFoundedBadge`, licensing/security trust-card row); `PreApproval.tsx` funnel chrome (progress bar, step/ETA, autosave, resume-from-login) well-instrumented, no new friction found. Two unverified P3 candidates not yet run through finding-verifier: `TermTooltip` jargon-assist not applied to public pre-login surfaces (`AffordabilityCheck.tsx`, `pages/rates/*`); no HowTo/WebApplication schema on interactive-tool pages (`AffordabilityCheck.tsx`, `ApprovalStrength.tsx`) — see FINDINGS.md |
| 2 | Application & intake | 2026-08-05 | **intake-01 (P0, TRID) fixed `c27b01e`** + intake-03 same commit + intake-02 fixed `eafdb47` + intake-04 fixed `69104f9`. All Domain 2 findings closed except ux-11 (HMDA/Reg C, blocked on U-8 — regulatory source access). See FINDINGS.md |
| 3 | AI Coach, documents & extraction | 2026-08-05 | **F-027 P1** (borrower text parsed as trusted extraction → forged tier-1 provenance + prompt injection; §9 security review required) + F-028/029/030 P2 + F-031 P3, all open. Doc-drift F-032/F-033 **fixed** (`e5ab91a`, `0934e9c`); a 2nd F-013 instance fixed (`aca9377`). 2 refuted, 1 confirmed-but-deliberate. Escalations **U-9** (is prod traffic reaching Anthropic — decides AG-3 status) and **U-10** (LL-2026-04 cite provenance). **CLEAN, verified:** the "AI never decides" gate is real — `coachProfileSync` is provenance/draft/status-fenced, and no automated decision path reads `notes` or the borrower graph. See FINDINGS.md |
| 4 | Verification & credit | 2026-08-05 | **F-034 + F-035 (P0, FCRA)** — the consent ledger stores a disclosure the borrower never saw, and that record is the mechanism that *hides* a soft-consent-gating-a-hard-pull scope gap. **F-036 (P1)** production pull rows assert a real inquiry that never happened (found by compliance-auditor; missed by reviewer *and* verifier). Plus F-037 (P1\*), F-038–F-043 (P2), ux-19 (P1), ux-20–23. None fixed. Escalations **U-11** (no FCRA/ESIGN source locally — third instance of one structural gap) and **U-12** (consent→pull coverage map is a legal reading). **CLEAN:** the consent gate's *existence* is real and unbypassable on every entrance; AG-1/AG-2 still hold; no plaintext credit-response leak; F-027 does not reach this domain. See FINDINGS.md |
| 5 | Underwriting & decisioning | 2026-08-12 | **First run.** Static + executed-probe only — **no dev server** (the :5002 listener is a 7-day-old orphan from a deleted worktree; nothing was sent to it). **F-058 (P1, ECOA flagged)** — the funnel never asks tenure for rental/investment/other income, so `INCOME_SEASONING` fires at "0 months of history" on 100% of those files and that sentence is **emailed to the borrower**; the seven income kinds with no funnel option (disability, child support, alimony, public assistance, foster care, VA benefits, unemployment) all land in the governed bucket. Plus **ux-24 (P1)** the adverse-action notice is undiscoverable in-app after a staff denial. P2: F-059 (rejected files show a payment with PMI silently removed — executed, $270/mo), F-060 (front-end ratio labelled DTI), F-061, F-062, F-063 (wrong Selling Guide section ×6 sites), F-064, F-065, F-066, F-067, ux-25, ux-26, ux-27. P3: F-070…F-075, ux-28, ux-29, D-009. **1 REFUTED** (the flat-0.5% PMI claim — filed independently by two agents and wrong on both grounds). **CLEAN, verified:** never-auto-deny holds end to end (`IntakeAnalysisResult.outcome` makes `"denied"` unrepresentable; both deny seams are human-gated and chokepointed); no AI, no `Math.random`, no outcome-bearing `new Date()`, no vendor call in the engines; **no prohibited basis is a decision input** (9 terms grepped across all scope files → zero); age proxies captured but not decisioned on; other-income counted at 100% with no type haircut; typed-error→human routing exhaustive; `POLICY_OUT_OF_BAND` → a human, never a loop; system faults never masquerade as borrower "missing info"; `buildResolvedPolicy`'s fingerprint is order-stable; four-eyes on the rule lifecycle is real; client↔server role gates match. **Determinism, stated plainly:** "same inputs ⇒ same outcome" is *not* true as written — it is "same inputs + same matrix state + same wall-clock instant" (`lookupResolver.ts:121` selects effective-dated rows by wall clock). Lawful under ECOA *only if the applied policy is recoverable per decision*, which is exactly what F-064 breaks. See FINDINGS.md |
| 6 | Pricing, rates & disclosures | 2026-08-17 | **First run.** Static + executed-test only — **no dev server** (the :5002 listener is a 12-day-old orphan from a deleted worktree; nothing was sent to it). **Four P1s, three of them found independently by two agents that never saw each other's work.** **F-076** the APR on every borrower Loan Option card is a flat `rate + 0.25` spread, not the Appendix J solver — understates 0.45–0.94pp whenever MI is in force, and a $3,600 discount point moves it **0.000pp**. **F-077** the LE's disclosed MI *and the DTI the engine decides on* come from a hardcoded card **1.42–2.2× the `CONVENTIONAL_PMI` matrix in all 32 cells** (2.38 DTI points on the worked example), while the same payload shows the borrower the matrix figure. **F-078** `totalLLPA` is converted three ways across five sites; the two `/100` sites are ~25× too small — **reproduced against production**: 0.025pp of rate spread across the entire 620→790 FICO range. **F-079** no queue or alert is ranked by the TRID LE clock and no non-admin staffer can elect compensation on an unassigned organic file. Plus **ux-30 (P1)** no borrower-reachable UI renders the Loan Estimate, so the sole `leIssuedDate` writer is dead in product and TRID-triggered files become permanently unadvanceable. Then F-081/082/083/087/088/089/090 + ux-32/33/34 (P2), F-091..F-095 + ux-31/35/36/37 (P3), **D-013** (three false `DEVELOPER_PLAYBOOK` §2.4 claims + a stale Reality-Map entry). **6 refutations recorded.** Escalations **U-26** (Reg Z sources are reachable — CLAUDE.md's premise is stale), **U-27**, **U-28**. **CLEAN, verified:** the Appendix J solver itself (read line-by-line + executed, 86 assertions), QM note-date selection and every tier boundary against the 2026 job aid, business-day definition at all four general-rule sites, `tridTriggeredAt` single-writer + set-once, all 21 `resolveMatrixValue` decisioning call sites, role gates client↔server across the domain, borrower-facing error paths, and determinism (no `Math.random`, no vendor call in the pricing path). See FINDINGS.md |
| 7 | AUS & lender submission | 2026-08-18 | **First run.** Static + executed-probe only — **no dev server** (the :5002 listener is a **13-day-old orphan** from the deleted `launch-hygiene` worktree — PID 20814, `ps` START Aug 5; its `/api/health` returns only `{status,timestamp}` while current code at `server/routes.ts:79-84` returns `commit`+`email`. **It was not contacted.**). Owned tests green: 5 files / **88 passed**. **The headline is that acceptance question A fails on four independent counts, three of them permanent.** **F-0818-09 (P2 now / 🚨 P1 on first lender approval)** — the only submission UI posts the lender's **uuid PK** where the server resolves the business `lender_id` (`getWholesaleLenderByLenderId` = `WHERE lender_id = $1`, no fallback), so every submission 422s and the picker drops every name; regression dated to `c188c6da` (#417), which moved the catalog to the table across 29 files and never touched the client. Masked in prod **only** because every lender is still `target`/`isDemo` — **the first real submission in company history will 422.** Plus **F-0818-11** (the DU/LPA casefile DTI omits proposed PITI and never reads URLA liabilities — engine 37.5% vs casefile 7.5% on the worked example; the "already PITI-inclusive" defence refuted by two independent writers), **F-0818-12** (LTV unconditionally overwrites the credit/DTI verdict, collapsing two axes the sibling LPA simulator keeps separate — while the messages array still contradicts the headline), **F-0818-13** (a `closer` is offered "Run DU / LPA" and 403s — **fix the button, not the gate**: the server list is byte-identical to `FINANCIAL_VERIFICATION_ROLES` and `routeGateDrift.test.ts:190-207` says drift is fixed by narrowing the client), **F-0818-14** (raw JSON error bodies in toasts — and `friendlyApiError`, the obvious fix, would *cause* information loss), **F-0818-15** (the immutable submission snapshot omits the AUS simulation qualifier), **F-0818-07** (readiness calls the LE late a full day before `trid.ts` does), **F-0818-10** (P2 coverage-gap: the terminal money-path surface has **no test**, which is why F-0818-09 survived 13 days; `submitToDU` has none either), and **ux-0818-01/02** (a dead primary "Generate LE" button; errored queries render a *skeleton*, so an outage reads as "slow"). **1 REFUTED, 1 MERGED**: the proposed "TRID makes submission permanently impossible" P1 is real but is **ux-30's root cause** — merged there rather than re-minted (D-012 discipline), carrying two new facts (a **second independent consumer** of the overdue test, which corrects F-079's "exactly one consumer"; and that ux-30's "173/176 null" figure is a **dev-DB fixture artifact**, not evidence the TRID trigger is rare — it has 7 wired call sites, 4 pinned by tests). **CLEAN, verified:** the four-stage gate's semantics are exactly as documented (5 executed cases — "attention" means warnings-only, and delivery pre-flight really is informational); `submitToWholesaleLender` **cannot** be reached with stages 1–3 dirty (server re-runs readiness independent of the client's `disabled` prop); **no compensation input anywhere in lender selection** (`lenderMatchingEngine` scored purely on eligibility; comp is application-level and lender-independent); every endpoint the UI calls exists and is mounted; the status machine is a single source of truth honored on both sides; funding is unfakeable; `toCounterparty` fails closed; `mismoPackageXml` is stripped from both list and create responses; the XSD badge checks `skipped` first so a missing `xmllint` never reads as a pass; **no auto-submission path exists**; determinism holds and both GSE legs throw on a real key by design; and **F-051's fix re-verified live**. See FINDINGS.md |
| 8 | GSE delivery & compliance export | 2026-08-12 (rescued) · 2026-08-17 (workflow 3 pass) | **Reviewed 2026-08-12 — that pass's register never reached `main` and was rescued 2026-08-17 (this row was still "not yet run" while nine of its findings existed).** **F-051 (P0, Fannie ULDD)** the delivered package reports the AUS recommendation as the compile-time literal `"Approve"` — **re-verified live on `main` @ `d1ef64e`** (`server/mismo.ts:860`); `ausRecommendation` exists at `shared/schema/lendingCore.ts:50` but the MISMO DTO carries no recommendation field at all. F-052/053/054/055/056/057 (P1) + F-068/069 (P2), all re-dated and still live (`mismo.ts:812` `"Fixed"`, `:185`/`:173` positive-value defaults, `:219`/`:149` enum drift). **Added 2026-08-17 by the workflow 3 run: F-080 (P1)** — the co-borrower is dropped from the delivered package and their employer attributed to the primary borrower (probe: one PARTY, one SSN, both employers; `xmllint` validates) — **becomes P0 the moment F-052/F-053 are fixed**. Plus F-084/085/086 (P2), F-091/092 (P3), and **D-014 (P1)**: the Workflow 3 script is structurally blind to this domain's defect class. Escalations U-22..U-25. **CLEAN, verified:** role gating on all four full-SSN surfaces, SSN containment (exactly one occurrence at the one legal home), the XSD harness design (both schemas, `skipped` not `valid` when `xmllint` is absent), declaration-block conformance, phone normalization, the SFC catalog + `validateSfcSet` logic, and channel honesty. See FINDINGS.md **CURRENT DISPOSITION:** F-080 CLOSED 2026-09-09 with multi-PARTY borrower-scoped export and clean official-XSD regression proof. |
| 9 | Compliance analytics & adverse action | 2026-08-19 | **First run.** Static + executed-test + unauthenticated live probes — **no authenticated dev-server session** (the `:5002` listener is the **14-day-old orphan** from the deleted `launch-hygiene` worktree, PID 20814, whose `/api/health` omits the `commit`/`email` fields current code returns at `server/routes.ts:79-84` — **it was not contacted**; `:5001` is the primary checkout on a peer's branch, used for gate probes only. The UX leg booted its **own** server on `:5003` from the clean worktree and drove real Chromium). Owned tests green: **10 files / 111 passed**. **Two P1s, and the register's own accuracy is the third headline.** **F-0819-01** — the denial chokepoint **fails open**: `ensureAdverseActionForDenial` de-dupes on *any* `adverse_actions` row with no `actionType` predicate (`creditAdverseActions.ts:556-561` → `:360-366`), so a staff-created counteroffer satisfies it and a file reaches `denied` with **zero** denial notices and **no audit entry** (the write sits inside `if (aa.created)`) — and `tests/adverseActionFcraChokepoint.test.ts:225-233` **pins it green** with a fixture that omits `actionType` entirely (D-012's fixture-bounded-gate class, third occurrence). **F-0819-02** — the standalone HMDA route is **sequence-blind** (`compliance.ts:1310-1312,1348-1350`, `LIMIT 1` with no `ORDER BY`), proven to flip from the primary's row to the co-applicant's the moment a URLA re-save updates seq 1; the dashboard cache (`staleTime` 5 min on a key the URLA save never invalidates) keeps the link live exactly then, and `dashboard.ts:118-121`'s presence-only completeness means **the co-borrower is never prompted at all**. P2: F-0819-04 (every notice names the **CFPB** where Appendix A item 9 assigns the **FTC** — cites open counsel Ask 2), F-0819-05 (the ECOA 30-day clock anchored at notice generation **at two sites**, incl. `taskEventEmitter.ts:143-151`, with **no completed-application timestamp in the schema** — do not backfill), F-0819-06, F-0819-07, F-0819-11, ux-0819-01/02/03/04. P3: F-0819-12 (quiet-hours fail-safe omits `Pacific/Guam` **1,460 h/yr at local 04:00–07:00** and `America/Puerto_Rico` — **three independent executions converged**), F-0819-13, F-0819-17, F-0819-18, F-0819-20, ux-0819-05..12, D-0819-01/03. **6 REFUTED** (recorded so they are not re-found): the rule-DSL prohibited-basis denylist (unshipped surface, caller-supplied context), the notice's recovery-card ordering (a **documented 2026-08-04 adjudication pinned by a test**, measured against a fixture 78% longer than any real record), the "three staff surfaces contradict" claim (three different events), hand-rolled zero-states (a **documented §8 backlog**), "no per-notice ECOA deadline exists" (it does — `adverseActionDelivery.ts:148-166`), and the breach-alarm P1 premise (an always-on staff KPI reads the same data). **ux-11 RULED and unblocked** — its notice half is governed by **Reg B §1002.13(c)**, not Reg C, and is a defect; **U-8 NARROWED** (sources reachable; the subcategory half stays open, and Reg C does not bind until 25 closed-end originations in two consecutive years — a launch-checklist trigger). **ux-24 re-confirmed** with its compliance flag **ruled down** (postal delivery discharges Reg B) but its **P1 held**, because the automatic denial path emits nothing carrying §1002.9(a)(2) content. **WF5-F2 verified FIXED** (`011fa9b8`/#397) clause-by-clause against retrieved §1681m. **CLEAN, verified:** the adverse-action **cron is genuinely scheduled in production** (`cron-jobs.yml` `0 14 * * *`, pinned by `tests/cronSchedules.test.ts:34`; `isCronRequest` returns false when `CRON_SECRET` is unset so it degrades to admin-only, not open) — "dark locally" is by design, **not** unscheduled; the simulated-pull refusal runs **before** the existing-notice no-op, so a pre-generated ECOA-only notice cannot bypass the FCRA block; reasons are specific and mapped, and a denial with no mappable reason **422s**; §1002.13 collects all four monitoring items with the regulation's exact three marital-status categories and a decline path on every one; **prohibited-basis data is walled off from all three live decisioning modules** (exhaustive grep, zero hits); the disparate-impact math is correct and aggregate-only (its *inputs* are F-0819-20); `fairLendingAnalysis.ts:19-24`'s effects-test note verified correct against current §1002.6(a); retention has **no `delete(adverseActions)` anywhere**; the SMS webhook verifies signatures on both legs and fails closed in production, logging rejections **without** phone or body; role gating uses `isInternalStaffRole` (so `broker`/`lender` cannot reach a borrower's notice) and matches client↔server; the PDF renders `notice_text` **verbatim**, streams only, and audit-logs every download; determinism holds across the domain (no `Math.random`, no vendor call, injectable `now`); and `AdverseActionNotice.tsx` handles `isError` properly. ⚠️ **`hmdaIngestService` is NOT dead surface** — it is competitor-benchmark ingest of public CFPB LAR data driven by `server/scripts/ingestHmdaCompetitors.ts` and read by `competitorRateService.ts:64-77`; the name invites confusion with Homiquity's own Reg C reporting. See FINDINGS.md |
| 10 | Borrower graph & data intelligence | 2026-08-20 | **First run — and the first domain review in this program's history with a REAL LIVE DEV SERVER.** A worktree server was started on `:5002` from `origin/main` @ `fed1458e` and its identity proved before use (PID 83460, `lsof -a -p 83460 -d cwd` → the review worktree, `ps` START 15:11:39, `/api/health` carrying the `commit`+`email` keys current code returns). The 13-day orphan listener that forced Domains 5/6/7/8 and Workflows 3/6 into static-only passes **is gone**; every finding below is backed by executed HTTP, SQL, or a rendered component. **Two P1s, both crashes, both found independently by agents that could not see each other.** **F-0820-20** — the staff Intelligence tab types `GET /api/outcomes/funnel` as an array while the server has returned a flat **object** since the initial commit (2026-06-01), so `.map()` throws and the **entire routed app** unmounts (the only boundary wraps `<Router/>`); found by *three* agents, then downgraded P0→P1 by finding-verifier on the P0 definition. **F-0820-21** — `numeric` comes back from node-postgres as a **string**, so `cohortData?.convRate?.toFixed(4)` throws: `/api/predictions/*` returns **200 while a credit bucket is empty and 500 the moment it has one resolved outcome**, and there is no `GROUP BY`, so six resolved outcomes break 100% of borrowers. The borrower's insights card then vanishes silently (`if (!prediction) return null`, `retry:false`). P2: F-0820-22 (the adverse-action AI invariant reads a 14-line re-export **shim**, not the 662-line module that holds the code — proven by a green control run), F-0820-23 (four more client↔server contract breaks rendering `NaN%`, a blank column and a ×100), F-0820-24 (the empty-state guard's residual is ~28, not its reported 8), F-0820-25/26 (a 403 rendered as a confident all-zero platform; "All clear — no files need attention" as the error state, **permanently** for broker/lender since a 403 is a role verdict), F-0820-27 (`anonymized_borrower_facts` empty by construction from three causes, incl. a cron selecting `users.role = "borrower"` — a role in **no** role list and on **0 of 482** users — while reporting `ok:true` weekly), F-0820-28 (Tell #8: five `loan_outcomes` columns read everywhere, written nowhere, because the stamp fires 137 lines before the values are computed), F-0820-29 (a cohort key round-trip that `split("_")` mangles, landing specifically on `below_640` and `cash_out`), F-0820-30 (`intentScore` structurally 0 platform-wide), F-0820-31, F-0820-32, F-0820-33, ux-0820-20/21/22. P3: F-0820-34..41, D-0820-01/02. **5 REFUTED, 3 MERGED** (into F-014, F-055, F-0820-25) — recorded so they are not re-found. 🚨 **CLEAN, and it is the headline: the Reg B firewall is REAL, verified two ways by two agents independently.** No output of `predictiveEngine`/`optimizationEngine`/`borrowerGraph`/`signalEngine`/`intentTracker`/`outcomeTracker` reaches a credit-decision path — checked on **both** axes (module imports **and** direct table/field references) across all eleven decision-path files, all returning zero; `loanAnalysis.ts:437,448,468` are the only edges and they run **outbound**. 45 prohibited-basis terms censused across seven service files: **zero hits** for race/ethnicity/color/religion/national-origin/sex/gender/public-assistance/disability/**zip**/surname/language/neighborhood/age. `citizenship` **is** a decision input at `lenderMatchingEngine.ts:175-191` and is **expressly permitted** by 12 CFR §1002.6(b)(7) (retrieved verbatim, body-grepped). `"the model said so"` is **structurally impossible** in an adverse-action notice — `creditAdverseActions.ts:28-30` accepts only enumerated reason keys, free text cannot enter (§1002.9(b)(2) retrieved). Also CLEAN: every server role gate on every data-intelligence endpoint (401 anonymous / 403 borrower / 403 partner, probed per role); the two-step IDOR guard on `GET /api/predictions/staff/:userId`; `sql.raw` day-window interpolation (`parseInt`-fenced, injection probed); the **staff attention feed's ranking inputs** — objective file state only, no predictive score, no engagement tier, so it creates no disparate-service risk; `signalEngine`'s deal-team scoping fails closed; `frictionLog` is fire-and-forget with a catch and nothing reads friction back into behaviour; `activitySummary`; the write half of the analytics loop (F-002 stays closed, re-verified); and `PredictionInsights`' UDAAP cut (the odds-% and single funding date are deliberately suppressed in favour of a qualitative label and a week band, disclaimer rendered as a bordered callout — **recorded so a future session does not "restore" the numbers**). **Escalations:** whether the credit-consent text covers internal portfolio analytics (`aggregateAnonymizedData` reads every borrower's bureau-derived score to build cohorts); and `MODEL_RISK_GOVERNANCE.md` has sat **DRAFT since 2026-07-03** while the root README cites it as authority — which makes any "gap against MRG" a judgement call. See FINDINGS.md |
| 11 | Staff, partner & pipeline ops | 2026-08-20 | **First run — second bite of the same day, on a live dev server whose identity was proved before use** (PID 69268, `lsof -a -p … -d cwd` → the review worktree @ `d8316ec1`, `find server shared -newermt <start>` empty so the frozen server half is current with HEAD). **12 roles probed, one cookie jar each** — the seeded 11 plus a self-registered `realtor`, which **has no `test-login` seat** despite being the DB's second-largest role (130 accounts) — see F-0820-51's coverage rider. Owned tests: **9 files / 139 passed**, plus the integration suite **1 file / 5 passed**. 🚨 **F-0820-50 (P0, GLBA/PII) — the program's only open P0.** Four client-consumed endpoints serialize the whole `users` row and ship `passwordHash` (scrypt digest **and salt**) into the browser, **two of them to non-employee third-party companies**, paired in one object with `email`, `failedLoginAttempts` and `lockoutUntil`. Live 200s captured. A dev-seed artifact nearly hid the worst leg — all 8 staff accounts here have a NULL hash while **473 of 485 users overall have one** — so the borrower→staff-team leg returns the key with a null value; **the null proves the field is shipped, not that it is safe**. Not a reopen of F-007 (verified still working); the story is that a 2026-07-12 point-fix was never swept and the repo has since written the same three-line strip a **second** time, in the same directory as one of the leaks. **Three P1s besides:** **F-0820-51** the only task-creation route any client calls produces **no SLA clock** (1,663/1,723 rows null, still accruing today, all rendering **green**) — **two independent faults**, and the single-fault fix first proposed would have shipped a green PR that changed nothing; **F-0820-53** Deal Rescue and Strategy Sessions are **one-way** (`admin → 0` against a 29-row table) while the UI counts down an SLA badge; **F-0820-54** any authenticated user, including an external `lender`, can write an **arbitrary free-text string** into the borrower-journey provenance table via a `manual_override` trigger that short-circuits the transition matrix; **F-0820-59** the partner Deal Desk is write-only and toasts *"sent to the loan team"* (four roles 403'd live, `loUserId` written nowhere). P2: F-0820-52 (escalation is four `console.log` stubs over an empty table — 41 escalated, **0 notifications**), F-0820-55 (queue not deduped; two of three siblings dedupe, one with a test), F-0820-56, F-0820-57, F-0820-58, F-0820-60 (**0 of 197** rows carry five fields the client renders; KPI reads **"$0 volume"** over 197 loans), F-0820-61, F-0820-62 + F-0820-63 + F-0820-64 (one vocabulary bypass, three consequences — and commit `c69d4103` fixed the identical idiom in `client/src` while missing this file), F-0820-65. P3: F-0820-66, ux-0820-30/31/32, D-0820-10/11. **F-013 re-confirmed at 47 days unrun** — and the sharpest evidence is the repo's own `vitest.config.ts:128-131`, which names F-0820-13's class while adding a sibling and not this file. **5 REFUTED or partially refuted, 5 MERGED** rather than re-minted (into F-0820-24 ×5, F-013, ux-36, ux-37) — and **two of this run's own earlier rows were corrected**: F-0820-25's audience half was struck and F-0820-26 was re-escalated after my own downgrade proved too aggressive. **CLEAN, verified live rather than read:** the **role-gate matrix, 11 roles × 20 endpoints**, probed and byte-matched to `INTERNAL_STAFF_ROLES` / `ROUTE_GATES` — including checking **response bodies, not just status codes**, on the four routes that are 200-for-everyone and correctly self-scoped; **team-scoped access fails CLOSED** end to end (`lo` gets 40 signals across 27 applications, **0 outside its 66-file queue**; zero-membership roles get 0/0/0; `buildStaffSignals` returns `[]` without touching the DB on an empty scope); cross-role queue enumeration denied; **all seven cron expressions map to a mounted route** with a dual `CRON_SECRET`-or-admin trigger that degrades to manual, never open; the two-axis task status vocabulary holds at the boundary (a phantom `?status=` 400s rather than silently matching nothing) and the DB carries no legacy values; **tasks are never hard-deleted** (`DELETE` → audited `cancelTask` → `EXPIRED`, exercised live); the staff-invite flow end to end incl. a redacted audit entry; a **571-route × 175-call-site client↔server contract census** finding zero calls to a non-existent route; and `StaffDashboard`'s wide `ROUTE_GATES.staff` **is correct, not drift** — a partner early-return precedes every internal query. ⚠️ **Dev-DB residue disclosed:** 4 probe tasks (cancelled), 3 `borrower_state_history` rows carrying forged states (`closed` ×2, `FV3_ARBITRARY_NOT_A_STATE`), and 1 all-null `borrower_profiles` row — none removable without hand-DELETE on a shared DB. **`runLifecycleSweep` was deliberately NOT fired** (it writes to every homeowner profile with no scope filter; pre-count 9 recorded for whoever does). See FINDINGS.md |
| 12 | Property, listings & homeowner | — | not yet run |
| 13 | Security, PII & platform cross-cutting | — | not yet run |
| UX | UI/UX & friction (all surfaces) | 2026-08-05 (scoped: Domains 1–2 surfaces) | Domain 1: ux-06 (P2) fixed `ba7706a` + 1 unverified P3 candidate (LearningCenter no-CTA) + 1 refuted (FAQ dead-end). Domain 2: ux-07/08/09 (P2) fixed + ux-10/12 (P3) fixed — all four commits `b577553`/`73cf877`/`d2ed7dc`/`eb164ef`. Only ux-11 (P2, HMDA/Reg C) still open, blocked on U-8. Domain 3: ux-13/14/15/16 (P2) + ux-17/18 (P3) confirmed, none fixed (ux-18's pixel magnitude unmeasured — no screenshot tooling). **ux-01 status update:** its `Documents.tsx:163` evidence is resolved, but `AICoach.tsx:94-112` has four queries with no `isError` — residual, not a new finding. The `AuthGateOverlay` raw-`<a>` candidate remains unverified — see FINDINGS.md; remaining domains 4–13 surfaces not yet run |

---

## 1. Public funnel, acquisition & education

- **Server**: `server/routes/leads.ts`, `server/services/leadNotifications.ts`,
  `server/routes/calculators.ts`, rates via `server/services/rateService.ts`, education content.
- **Client**: `pages/public/*` (Landing, persona LPs, Waitlist, AffordabilityCheck, legal),
  `pages/rates/*`, `pages/calculators/*`, `pages/education/*`, prelaunch gate
  `client/src/lib/prelaunch.ts`, referral landings (`pages/agent-broker/{ReferralLanding,PartnerLanding,ApplyInvite}.tsx`).
- **Intended use**: persona-siloed conversion pages feeding the funnel; prelaunch/waitlist
  gating of soliciting routes; calculators as lead tools.
- **Source docs**: `knowledge-base/research/gtm/` battlecards + landing-page conversion research, borrower-acquisition
  playbook, `L1_VISION_AND_SCOPE.md` (was PRODUCT_SPINE), `knowledge-base/handbook/app-guide/01-start-here.md`.
- **Owned tests**: `tests/leads*`, calculator/APR-adjacent units. **Reg Z trigger-term risk** on
  any rate/payment displayed → compliance flag.
- **Wiring note (audit):** #61 Approval Strength + #63 Buying Power/SEO land here (MVP).

## 2. Application & intake

- **Server**: intake portions of `server/routes/lending/` (applications, statusDecisions) + `server/routes/borrower/`
  (URLA save), `server/services/trid.ts` (six-piece trigger, sole writer of `tridTriggeredAt`),
  `server/consentGate.ts`, `server/services/preUnderwriting.ts`, `shared/stageRequirements.ts`,
  `server/services/nextAction.ts`.
- **Client**: `pages/lending/PreApproval.tsx` + `client/src/funnel/*` (preApprovalMachine,
  autosave), `pages/borrower/URLAForm.tsx` + `pages/borrower/urla/*`, consent pages
  (`CreditConsent`, `EConsent`, `HmdaDemographics`), `OnboardingJourney.tsx`.
- **Intended use**: guided pre-approval intake with autosave; URLA completeness; consents gate
  electronic delivery and credit pulls; TRID clock starts exactly at six pieces. **Decisioning
  runs as a server cascade on `POST /api/loan-applications`** (N-002) — assert on the cascade
  outputs, not the dead `instant-decision`/`calculate-*`/`advance-stage` endpoints.
- **Source docs**: `knowledge-base/handbook/app-guide/05-data-flow.md`, `DEVELOPER_PLAYBOOK.md` §2.1–2.2,
  `L1_VISION_AND_SCOPE.md` (was PRODUCT_SPINE), `docs/fannie-mae/` URLA documents.
- **Owned tests**: `tests/preApprovalMachine*`, `tests/trid*`, `tests/intakeSchema*`,
  `tests/stageRequirements*`. **Coverage gap (F-015):** `loanAnalysis.finalizeIntake` (the ECOA
  decision locus) is grep-only, never executed.

## 3. AI Coach, documents & extraction

- **Server**: `server/routes/coach.ts` + `server/services/coachIntake.ts`; the coach engine is
  `server/services/coaching{Client,Context,Lint,Prompt,Turn}.ts` (`coachingService.ts` is a
  re-export shim only). Extraction is `server/extraction{Core,Validation,Documents,TaxIntel}.ts`
  (`extractionService.ts` is likewise a shim — split 2026-07-17). Plus
  `server/services/documentConfidence.ts`, `server/routes/documents.ts`,
  `server/integrations/object_storage/*`.
- **AI vendor is Anthropic, not Gemini** (migrated 2026-07-17, migrations `0030`/`0031`):
  `extractionCore.ts` pins `claude-sonnet-5` (single-doc) / `claude-opus-4-8` (tax package) behind
  `AI_INTEGRATIONS_ANTHROPIC_API_KEY`. There is no Gemini code path and no `GEMINI_API_KEY` — the
  only `gemini` strings left are legacy DB enum values. *(Governance docs still say Gemini — see
  the open doc-drift finding in `FINDINGS.md`; don't take them as current.)*
- **Client**: `pages/education/AICoach.tsx` + `components/coach/*`, `Documents.tsx` +
  `UploadDocumentDialog`.
- **Intended use**: conversational homebuyer coaching + document extraction feeding
  qualification; uploads via presigned GCS URLs only; **AI never decides** (P1 of
  `AI_GOVERNANCE_POLICY`) — extracted values must pass a human/confidence gate before they
  influence a regulated outcome; sensitive extracted values encrypted; an unconfigured Anthropic
  key is a safe no-op (`confidence: "low"` + warnings, never a guessed value).
- **Source docs**: `knowledge-base/governance/AI_GOVERNANCE_POLICY.md`, `knowledge-base/governance/MODEL_RISK_GOVERNANCE.md`, tax-insight
  pipeline docs (§7216), `knowledge-base/handbook/app-guide/08-services.md`.
- **Owned tests**: `tests/uploadsPresignedOnly*`, `tests/taxInsight*`, plus `tests/extractionService`,
  `documentConfidence`, `coachProfileSync`, `coachTools`, `coachSse`, `coachLintFilter` — all in
  `vitest.config.ts` and executing (**72 tests**; the old "zero tests" line here was wrong and
  primed reviewers to re-file a phantom coverage gap). **Real gap:** `coachIntake.ts` is the one
  module with no direct test. Note `tests/taxInsightRoutes.test.ts` is integration-config only.
- **Compliance**: AI-in-decision-path invariant, IRC §7216 (tax info), RESPA §8 (no steering),
  prompt-injection via uploaded documents.

## 4. Verification & credit

- **Server**: `server/plaid.ts` + `server/services/verification.ts` + `server/routes/webhooks.ts`
  (VOA/VOIE), `server/services/creditService.ts` + `server/routes/compliance.ts` (FCRA consent,
  pulls, hash-chained credit audit log), `server/mcp/*` credit tools, `server/consentGate.ts`.
- **Client**: `Verification.tsx`, `IdentityVerification.tsx`, `CreditConsent.tsx`.
- **Intended use**: Day-1-Certainty provenance promotion (three dimensions → VERIFIED →
  decision recalc); FCRA consent required before any pull; credit sim refuses in prod unless
  `CREDIT_VENDOR_MODE=simulation`; raw responses encrypted, never in a response.
- **Source docs**: `DEVELOPER_PLAYBOOK.md` §2.1, `knowledge-base/handbook/app-guide/09-integrations.md`,
  `docs/fannie-mae/` (D1C), FCRA references.
- **Owned tests**: `tests/adverseActionNotice*`, `tests/mcpAudit*`, integration `authRecovery`.
  **Note (D-008):** `creditService.ts:666` uses `Math.random` — violates the deterministic-sim
  ground rule.
- **Compliance**: FCRA, GLBA-style PII.

## 5. Underwriting & decisioning

- **Server**: `server/services/decisionEngine.ts` + `server/underwritingEngine.ts` (**the LIVE
  decision path**), `server/services/ruleEngine.ts` + `server/routes/underwriting-rules.ts`,
  `underwritingNuance.ts`, `preUnderwriting.ts`, `scenarioCatalog.ts`, `loanAnalysis.ts`,
  `shared/dataProvenance.ts`, `shared/stageRequirements.ts`.
  **Trap (audit):** `server/underwriting.ts` *looks* like the engine (its header says so) but is
  a superseded helper — audit `decisionEngine.ts → underwritingEngine.ts`, not it.
- **Client**: `pages/realtor-engine/ScenarioDesk.tsx`, staff `PolicyOps.tsx`, decision surfaces
  in `ApplicationSummary`.
- **Intended use**: deterministic, AI-free decisioning; typed error → human routing; PRELIMINARY
  vs VERIFIED provenance gating; every nuance rule cites its guideline; never auto-deny.
- **Source docs**: `knowledge-base/compliance/UNDERWRITING_SCENARIOS.md`, scenario-engine invariants,
  `DEVELOPER_PLAYBOOK.md` §2.3.
- **Owned tests**: `tests/underwriting*`, `tests/scenarioCatalog*`, `tests/complianceInvariants*`
  (**F-014: this is grep-only, executes nothing — false confidence**), integration
  `pricingUnderwriting`. **Zero-coverage:** `ruleEngine.ts`.
- **Compliance**: Fannie Selling Guide, ECOA/Reg B. Determinism is itself an invariant (any
  nondeterminism/vendor call inside the engine = P0).

## 6. Pricing, rates & disclosures

- **Server**: `server/pricing.ts` (LLPA/PMI), `server/services/pricingAdapter.ts`, `rateService.ts`,
  `loanEstimate.ts`, `apr.ts` (Appendix J solver — the ONLY allowed APR source), `trid.ts` +
  `businessDays.ts`, `server/routes/{rate-sheets,market-data}.ts`, `marketDataParsers.ts`,
  `lookupResolver.ts` + `server/routes/lookup-matrix.ts`, `shared/fannieMae/qmThresholds.ts`.
- **Client**: `pages/lending/{LoanEstimate,LoanOptions,BorrowerDealComparison}.tsx`,
  `pages/staff/PricingMatrices.tsx`.
- **Intended use**: versioned policy matrices (no hardcoded rate cards); APR from the solver
  only; LE within the TRID clock; QM thresholds by note-date.
- **Source docs**: `DEVELOPER_PLAYBOOK.md` §2.4, `docs/fannie-mae/` QM job aid.
- **Owned tests**: `tests/apr*`, `tests/qmThresholds*`, `tests/lookupResolver*`, integration
  `pricingUnderwriting`, `lookupMatrix*`. **✓ verified correct (N-003):** QM P&F + APR-APOR
  tables 2024–26. **F-026:** APR solver omits Appendix J odd-first-period (fine for estimates).
- **Compliance**: TILA/Reg Z §1026.22 + Appendix J, TRID.

## 7. AUS & lender submission

- **Server/shared**: `server/services/ausSubmission.ts` + `server/routes/aus.ts` (DU + LPA,
  env-gated sims that intentionally throw on a real key), `brokerSubmissionReadiness.ts`
  (4-stage), `lenderSubmission.ts` + `shared/wholesaleLenders.ts`, `lenderMatchingEngine.ts`.
  ⚠️ **`shared/wholesaleLenders.ts` no longer holds a "Target-5" catalog** (corrected 2026-08-18,
  F-0818-11): `:10-13` records that the hardcoded array *"was a second source of truth"* and was
  deleted — lenders live in the `wholesale_lenders` table, and the module holds only the RULES
  (may we submit; what does a status transition mean). `CLAUDE.md:53` still says "Target-5 catalog"
  and is the same drift, unfixed here because `CLAUDE.md` is outside this routine's territory.
- **Client**: **exactly one mount** — `SubmissionReadinessDialog.tsx`, mounted only at
  `pages/staff/loCommandCenter/ActionsRail.tsx:62`. ⚠️ **`BorrowerFile.tsx` and
  `LoanPipeline.tsx` contain NO submission surface** (corrected 2026-08-18, F-0818-11 —
  `grep -c 'lender-submission\|SubmissionReadiness\|submission-readiness'` returns **0** in both;
  `LoanPipeline.tsx` is a borrower-facing view). The old wording sent reviewers to the wrong two
  files in a domain whose one live surface is broken.
- **Intended use**: broker flow — intake/AUS/lenderPackage/deliveryPreflight gates → submission
  blocked until stages 1–3 clean; one adapter seam per lender; sims flagged.
- **Wiring note:** ~~F-003 — AUS DU/LPA submission has no UI trigger~~ **fixed in #135**
  (`SubmissionReadinessDialog.tsx` → `POST /api/underwrite/submit-gse`; Run-DU/LPA verified in
  the 07-12 walkthrough). Still open: confirm with Target-5 lenders whether a DU casefile is
  required at submission.
- **Source docs**: broker/MISMO/PPE strategy docs, `DEVELOPER_PLAYBOOK.md` §2.3.
- **Owned tests**: `tests/lenderSubmission*` (**F-005: determinism flake is a real product bug —
  `mismo.ts:1034` ms timestamp in hashed XML; = PRs #64/#65**), `tests/brokerSubmissionReadiness*`.
- **Compliance**: Reg Z anti-steering §1026.36, TRID, Fannie DU.

## 8. GSE delivery & compliance export — *compliance-auditor mandatory on every finding*

- **Server/shared**: `server/mismo.ts` (ULDD Phase 5 XML), `shared/mismo.ts` (types/enums),
  `mismoValidation.ts`, `loanDeliveryReadiness.ts`, `shared/fannieMae/{loanDeliveryEdits,specialFeatureCodes,ucdFeeEnumerations}.ts`,
  `shared/schema/delivery.ts`.
- **Client**: MISMO export only — `LoCommandCenter.tsx:77` and `BorrowerFile.tsx:126`. **There is no
  delivery-readiness UI** (corrected 2026-08-17, D-011): `grep client/src` for `delivery-readiness`,
  `delivery-data`, `readyForDelivery` or `specialFeatureCodes` returns **0 hits**. Readiness and
  delivery-data capture are staff-API-only, a deliberate cut recorded in
  `scripts/delivery-stack-freeze-guard.cjs:1-14`. Do not review the readiness report as a UI feature.
- **Intended use**: valid ULDD Phase 5 MISMO 3.4 XML; single delivery-readiness report; SSN
  decrypted only at the delivery seam.
- **Status (2026-07-12):** the two audit P0s are **fixed** — F-018 container nesting
  (`723cc7d`) and F-019 `LoanPurposeType` enums (`21c4a4b`); F-025's asked-for XSD gate exists
  (baseline test + non-blocking conformance recording at submission, #135). **Still open here:**
  F-020/021/022 enum corrections, F-023 URLA §5 names, and the L6-fix baseline remediation.
  Escalations **U-1…U-7** need founder source confirmation.
- **Source docs**: `docs/fannie-mae/` (spec PDFs + XSDs + golden samples — validate against the
  XSDs), Loan Delivery job aid, `CLAUDE.md` compliance section.
- **Owned tests**: `tests/mismo*`, `tests/loanDeliveryEdits*`, `tests/specialFeatureCodes*`,
  integration `mismoExportAccess`. **F-015:** `loanDeliveryReadiness` (the caller of the tested
  edit engines) has zero tests.

## 9. Compliance analytics & adverse action

- **Server**: `server/services/fairLendingAnalysis.ts`, `hmdaIngestService.ts`,
  `adverseActionDelivery.ts` + `pdfLetterGenerator.ts` + `server/routes/jobs.ts` (30-day
  watchdog cron), `smsCompliance.ts` + `quietHours.ts`, `server/routes/compliance.ts` (HMDA,
  disparate-impact).
- **Client**: `AdverseActionNotice.tsx`, `HmdaDemographics.tsx`.
- **Intended use**: adverse-action sweep meets ECOA 30-day; STOP/quiet-hours gate all outbound
  SMS; fair-lending/HMDA analytics.
- **Launch-critical:** ~~F-004 — adverse-action generation has no UI trigger~~ **closed
  2026-07-12** — generation is a blocking chokepoint on the deny seam
  (`ensureAdverseActionForDenial`; a denial cannot proceed without a compliant notice) plus the
  #123 staff delivery card. **F-008 closed** 2026-08-06 — the SMS webhook verifies
  `X-Twilio-Signature` and fails closed in production; **F-050\*** carries the residual
  (no replay protection — blocker only if SMS is live, TCPA).
- **Source docs**: `docs/nmls/`, `knowledge-base/governance/TEAM_PRACTICES.md` §9, FCRA/ECOA/TCPA references.
- **Owned tests**: `tests/adverseAction*`, `tests/fairLendingAnalysis*`, `tests/smsCompliance*`,
  `tests/quietHours*`.
- **Compliance**: ECOA/Reg B, FCRA, TCPA, HMDA, fair lending.

## 10. Borrower graph & data intelligence

- **Server**: `server/services/borrowerGraph.ts` (docs call it the single most important
  service), `signalEngine.ts`, `intentTracker.ts`, `activitySummary.ts`, `analyticsEventPipeline.ts`,
  `outcomeTracker.ts`, `predictiveEngine.ts`, `optimizationEngine.ts`, `frictionLog.ts`,
  `server/routes/{data-intelligence,intelligence,optimizations}.ts`.
- **Client**: `pages/staff/IntelligenceTab.tsx`, `PredictionInsights` surfaces.
- **Intended use**: unified 3-tier-trust borrower profile; staff attention-priority feed;
  closed-loop outcomes → predictions/optimizations.
- **Wiring note:** ~~F-002 — `loanOutcomes` writers never called~~ **fixed in #136** (writers
  wired from `pipelineEngine`/`lending`/`underwriting`/`data-intelligence`/`loanAnalysis`).
  Still true (re-verified 2026-07-12): most of `intelligence.ts` (35+
  endpoints) are dead (no client caller) — decide wire/defer/delete per the dead-surface map.
  *(`optimizations.ts` carried the same finding and has since been **deleted** — see CHANGE_LEDGER;
  the "decide" for that half resolved to delete.)*
  the wired client surface (`IntelligenceTab.tsx`) reads `data-intelligence.ts` endpoints.
- **Source docs**: `knowledge-base/handbook/app-guide/08-services.md`, `MODEL_RISK_GOVERNANCE.md`.
- **Owned tests**: **zero** across this cluster (QA priority).

## 11. Staff, partner & pipeline ops

- **Server**: `server/pipelineEngine.ts` (status ladder, conditions, file health),
  `server/services/taskEngine.ts` + `server/routes/task-engine.ts` (SLA, escalation,
  role-scoped access), `borrowerStateMachine.ts`, `lifecycleEngine.ts`, `server/routes/jobs.ts`
  (lifecycle sweeps), CPA-channel routes, admin/staff-invite routes, `emailService.ts` +
  `server/routes/notifications.ts`.
- **Client**: `pages/staff/*`, `pages/agent-broker/*`, `pages/admin/*`,
  `pages/realtor-engine/*`, `pages/borrower/{Tasks,TaskDetail,Messages}.tsx`, deal-team components.
- **Intended use**: LO start-of-day prioritization; pipeline transitions validated with
  materialized conditions; SLA tasks escalate; two staff scoping models (internal-unrestricted
  vs team-scoped); **client gates must match server gates** (`isInternalStaffRole` vs
  `isStaffRole` — D-002 closed 2026-07-08; #119 enforced the separation app-wide).
- **Source docs**: `knowledge-base/handbook/app-guide/08-services.md`, `knowledge-base/logs/lo-audit/*`, access-control notes,
  `knowledge-base/runbooks/support-playbooks/`.
- **Owned tests**: integration `loCommandCenter`, `tests/borrowerStateMachine*`,
  `tests/lifecycleEngine*`, `tests/statusVocabulary*`, `tests/accessControl*`. **F-013:**
  `maintenanceMode.test.ts` runs in neither config. **Coverage:** `pipelineEngine.updatePipelineStage`
  is grep-only.

## 12. Property, listings & homeowner

- **Server**: `server/propertyAnalyzer.ts`, `server/services/valueEstimate.ts` (AVM parse),
  `server/routes/{property,listings,geocode}.ts`, refi/equity in `lifecycleEngine.ts`,
  `shared/schema/property.ts`.
- **Client**: `pages/property/*` (Properties, PropertyDetail, LivePropertyDetail, PropertyForm),
  `pages/borrower/BuyerProperties.tsx`, `pages/homeowner/HomeownerDashboard.tsx`,
  `pages/realtor-engine/*`.
- **Intended use**: property search/affordability; AVM via the `RAPIDAPI_KEY` realty-us adapter
  (unset → simulated/no live value locally); closed-loan graduation → Homeowner Hub with equity
  snapshot + refi alerts (TCPA-gated).
- **Source docs**: property-data-vendor notes, lifecycle-architecture (Incubator/Engine/Portfolio
  separation), `knowledge-base/handbook/app-guide/09-integrations.md`.
- **Owned tests**: `tests/valueEstimate*`, `tests/marketDataParsers*`. **Zero-coverage:**
  `propertyAnalyzer.ts`, property routes.

## 13. Security, PII & platform cross-cutting

- **Server**: `server/services/encryptionService.ts` (KMS envelope, rotation, fails closed),
  `ssnVault.ts` + `piiVault.ts`, `server/auditLog.ts`, `server/auth.ts` + `server/integrations/auth/*`
  + `socialAuth.ts`, `loginLockout.ts` + `accountRecovery.ts`, `rateLimitPolicy.ts`,
  `maintenanceMode.ts` + `prelaunchGate.ts`, `server/services/errorMonitoring.ts` +
  `server/routes/monitoring.ts`, `server/storage/` (split from a single 5,723-line file into 22 domain modules in #182 —
  still the sole PII write path, so the concentration risk is unchanged), `server/mcp/*` (AG-1 audit chain, AG-2 identity), `shared/roles.ts`.
- **Client**: auth pages, role-gated layout wrappers (`PrivateLayout` requiredRoles vs server gates).
- **Intended use**: SSNs/accounts ciphertext + last4 only, decryption only at MISMO/AUS seams +
  audited staff reveal; sessions rolling; lockout; consent gate 403s unconsented delivery; MCP
  fails closed in prod; **never add a self-registerable role to STAFF_ROLES** (HIGH escalation,
  commit ae06fd4).
- **Posture (audit): STRONG — no P0, no IDOR, PII-at-rest sound (N-001).** Hardening: **F-006**
  SSN delivery reads are purpose-gated and audited (F-057 closed 2026-09-09); **F-007** `/api/admin/users` returns `passwordHash`; **F-009**
  legacy plaintext `ssn` not stripped (verify prod backfill); **F-010** presigned upload trusts
  client type/size; **F-011** Plaid webhook static secret.
- **Source docs**: `knowledge-base/governance/TEAM_PRACTICES.md` §9, `knowledge-base/governance/AI_GOVERNANCE_POLICY.md`,
  `knowledge-base/handbook/app-guide/06-auth-security-secrets.md`.
- **Owned tests**: `tests/accessControl*`, `tests/ssnVault*`, `tests/encryptionRotation*`,
  `tests/loginLockout*`, `tests/adversarialPersonas*`, `tests/mcp*`, integration `authRecovery`.
  **Zero-coverage:** `piiVault.ts`, `auditLog.ts` (general), `socialAuth.ts`.
- **Compliance**: GLBA-style PII, FCRA, ECOA/Reg B.

## UX. UI/UX & friction — cross-cutting, ALL client surfaces (`ux-reviewer`)

Runs over every surface from teams 1–12, on three axes:

- **Uniformity**: design-system conformance (tokens in `client/src/index.css` /
  `tailwind.config.ts`; guard `scripts/design-token-guard.cjs` — anything it flags is a finding),
  consistent shadcn/ui usage, nav/shell coherence, spacing/type drift, responsive
  (375px/tablet/desktop). The live design system is **"Mint & Flare"** (2026-08-20 rebuild,
  `3cba2dae` — superseded Royal Blue Emerald). ~~Guard blind spot: 157 white/black literals bypass the regex~~ — fixed: the guard now
  ratchets a `whiteBlackLiterals` metric (#112, baseline 97; ux-02 narrowed to the no-CI leg).
- **Friction & psychology**: funnel drop-off, CTA clarity, **loading/empty/error states —
  ux-01, partially addressed** (QueryBoundary error+retry #93/#95 batch 1 + PageShell #131;
  residual count unmeasured — re-count on the next UX run), trust signals near sensitive asks,
  reassurance at anxiety moments, dashboard speed-to-value.
  `PageShell` adoption: 32 pages converged (#131, ux-03 closed); deliberate exceptions in
  `app-guide/07-frontend.md`.
- **Compliance rails on copy**: Reg Z trigger terms (flag to compliance-auditor), no consent
  dark patterns (**audit: consent UX is exemplary — 0 pre-checked boxes**), Reg B denial tone.
- **Builds on the standing system**: score every surface against the four-question gate in
  `knowledge-base/handbook/design/DESIGN_SYSTEM.md` §13. The old `ux-audit` corpus is **archived**
  (`knowledge-base/archive/ux-audit/`) — quarantined, not a live checklist; its `design-tokens.json`
  describes the retired Obsidian Indigo palette. Cross-reference its ids for history only.
- **Source docs**: `knowledge-base/handbook/design/DESIGN_SYSTEM.md` (binding), landing-page research,
  design skills under `.agents/skills/`.
- **Owned checks**: `node scripts/design-token-guard.cjs` and `node scripts/ui-standard-guard.cjs`
  (both via `pnpm checkup`), preview
  screenshots/inspects per surface group. **A11y:** 12/14 property `<img>` lack `alt`.
