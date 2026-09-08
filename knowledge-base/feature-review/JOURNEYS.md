# Feature Review — Client Journey Charters

Four client personas, each walked end to end **in the real browser UI**. Each charter lists: who
the persona is, the account they walk with, the ordered route, the seams that must carry, the
promises that must be kept, and what the walker is forbidden to do. A `journey-walker-*` run takes
ONE numbered charter as its brief. Program rules: `CHARTER.md`.

> **A journey is not a workflow and not a domain.** `WORKFLOWS.md` proves a *system transaction*
> over HTTP; `DOMAINS.md` proves a *subsystem* against its intended use; the UX lens grades a
> *surface*. None of the three is continuous — a domain reviewer never leaves its domain, a
> workflow verifier holds a cookie jar and never re-renders a nav, a UX reviewer audits a page at
> one role at a time. A journey is the only continuous lens, and its subject is the space
> **between** those: a value dropped crossing a boundary, a role that changes under a live session,
> a promise made on one surface with no surface that keeps it, a persona that runs out of next step.
> **A walker that files a single-surface defect has done another seat's job** (`CHARTER.md` §7) —
> it hands off and mints no id.

> **Walkability.** The prelaunch gate is **open locally and closed in production, and both are
> correct.** `.env` sets no `PRELAUNCH_GATED`, so `server/services/prelaunchGate.ts:25-31` falls
> back to `NODE_ENV === "production" && isCompanyNmlsPending()`, and
> `client/src/lib/prelaunch.ts:17-19` gates only on `PROD`. Every route below is reachable locally.
> In production the same routes are `<Gated>` (`client/src/App.tsx:255,257,258,267`), so **a
> journey that only works ungated is a launch-readiness fact, not a clean run** — the walkability
> column records which gate state each verdict was earned under.

## Why these seats exist alongside the owner fleet

`knowledge-base/handbook/FEATURE_MAP.md` partitions the codebase into 41 feature areas, each with
one `hq-*-owner` agent that **implements**. The partition is strict: 667 owned paths, zero
duplicates. Every owner's charter carries a **"Not yours"** list naming the neighbours it must not
touch — `hq-borrower-journey-owner` hands the funnel to `hq-intake-funnel-owner`, which hands the
URLA to `hq-urla-owner`, and so on.

**That partition is exactly what creates this file's subject.** A boundary drawn so no two owners
collide is also a boundary no owner can see across:

| Seam | Fires in | Renders in | Owners involved |
|---|---|---|---|
| `aspiring_owner → active_buyer` promotion | `server/routes/lending/applications.ts:134` | `app-sidebar.tsx:262-264`, `Dashboard.tsx:238-244` | intake-funnel → borrower-journey |
| `complexIncome` branch carry | `client/src/funnel/preApprovalMachine.ts:114` | `urla/EmploymentSection.tsx:286`, `pipelineEngine.ts:91-122` | intake-funnel → urla → documents |
| calculator → funnel capture | `client/src/lib/calculatorPrefill.ts` | `pages/lending/PreApproval.tsx` | calculators → intake-funnel |
| door promise → delivery | `pages/public/Landing.tsx:52-92` | the whole route, or nothing | seo-content → intake-funnel → pricing |

Each of those is **correct inside every owner's scope and broken across them**. The owners' own
hand-back format has a `LEFT UNDONE: out-of-scope problems observed — findings, not fixes` line,
which is precisely where a cross-boundary observation goes today and dies, because no seat owned
cross-boundary findings. These four walkers are that seat.

**So the two fleets are a producer/consumer pair, not competitors.** Walkers produce findings no
owner can produce; owners produce fixes no walker may attempt. A journey `HANDOFF` line names the
`hq-*-owner` that can act on it (CHARTER §7), and a `J-` finding a walker files is re-verified by
the same walker after that owner ships — **no seat signs off its own work.**

Status ledger (updated by the orchestrator after each run):

| # | Journey | Walkability (gate state) | Last walked | Verdict |
|---|---|---|---|---|
| 1 | Aspiring owner — renter, sandbox, never applies | OPEN locally · survives PRELAUNCH (no `<Gated>` surface on the route; the sandbox's own "Get Pre-Approved" link points *into* the gate) | **2026-08-20** (`b799b91d`, pre-#595 Landing) | **WARN** — sandbox has a real floor; 2 data-correctness defects (`F-0820-01` rent-as-liability, `F-0820-02` PMI), 1 surface unreachable at 320px, `ux-43..49`. [report](../routines/reports/2026-08-20-journey-walk.md) |
| 2 | Active buyer — W-2 salaried | OPEN locally · **route dies under PRELAUNCH** (`/apply` is `<Gated>`, `App.tsx:267`) | — | not yet run |
| 3 | Active buyer — self-employed / business owner | OPEN locally and on the public production route | **2026-09-07** (`codex/end-to-end-journey`, dedicated local server on :5021) | **PASS with external gate** — two businesses + one rental carried from fast intake into editable URLA and the loan-officer file; evidence, letter, AUS, export and lender submission gates stayed honest. Real lender acceptance remains unproven. [report](journey-walks/2026-09-07-complex-borrower-lo-loop.md) |
| 4 | Active buyer — affluent / move-up (jumbo) | OPEN locally · **route dies under PRELAUNCH at the first click** (the door links straight to `<Gated>` `/apply`) | — | not yet run |
| 5 | Active buyer — condo / project-eligibility | OPEN locally · **route dies under PRELAUNCH** (`/apply` is `<Gated>`) · ⚠️ **charter cites the Selling Guide, which is not on `main`** — see the entry | — | not yet run |

---

## 1. Aspiring owner — renter, sandbox, never applies

- **Persona**: a renter exploring whether homeownership is reachable. Enters through the
  *"You're renting now"* door (`client/src/pages/public/Landing.tsx:58-73`). Signup always creates
  this role (`client/src/pages/public/Signup.tsx`), so **every user in the product is this persona
  first** — which makes the sandbox the highest-traffic authenticated surface set there is.
- **Account — take a FRESH SIGNUP, not the seeded seat.** Sign up as `jr+<MMDD>@test.local` through
  the real `/signup` form. Starts `aspiring_owner` and **must still be `aspiring_owner` at the end**
  — assert both, and assert `applicationCount === 0`.

  Fresh signup is the primary for three reasons, in order: it is the only state that **guarantees
  the incubator gate fires** (below); it is what a real new user actually experiences; and it
  exercises seam 2 (`/signup` → `postAuthRoute`) for free, which the seeded seat skips entirely.

  🚨 **The seeded `renter@test.com` seat cannot be trusted to show `RenterHome`, and on the founder's
  laptop it does not.** `/test-login` (`server/auth.ts:362`) re-writes the *role* on every login
  (`server/auth.ts:381`), so a polluted role self-heals — but **application rows do not**, and the
  incubator gate keys on the file, not the role: `Dashboard.tsx:238-244` swaps in `RenterHome` only
  when there is **no workable file and no funded loan**. On 2026-08-20 that seat carried a
  `self_employed` application in `processing`, created **2026-07-02**, so `/dashboard` rendered the
  full borrower dashboard and **journey 1's core surface was unreachable on the account this charter
  used to name for it.**

  **It is dev-database drift, not a repo fixture — which is why it will happen again.** `server/seed.ts`
  creates content, properties, pricing and templates and **no users and no applications**; the local
  Postgres simply accumulated one (188 applications across many users at last count). Any run that
  submits on that seat pollutes it permanently for every later run. That is the standing hazard this
  charter already named — it had simply already fired.

  **If you want the seeded seat anyway** (for accumulated state — an existing lease, goal or coach
  history a fresh account cannot have; login is `renter@test.com` at `DEV_TEST_PASSWORD` via
  `/test-login`, and the seat is **shared** with every other run), **probe first and say which you
  used**:

  ```
  GET /api/loan-applications   →   [] ⇒ RenterHome will render.   Non-empty ⇒ it will NOT.
  ```

  `TEST_ACCOUNTS.md:22` documents `renter@test.com` as the *"Incubator surface (RenterHome)"*
  account. When the probe contradicts that, the account is wrong, not the runbook — record it and
  fall back to a fresh signup rather than reporting `RenterHome` unwalked.
- **Route**:
  1. `/` (Landing) → take the renting door → `/first-time-buyer`.
  2. `/learn`, `/resources`, `/calculators/*` → explore, tune numbers.
  3. `/signup` → become a user. Land wherever `client/src/lib/postAuthRoute.ts` sends you.
  4. `/dashboard` → the incubator gate swaps in `RenterHome` when there is no workable file and no
     funded loan (`client/src/pages/borrower/Dashboard.tsx:238-244`).
  5. Then **every remaining item the sandbox nav offers**, each to its own terminus — `/ai-coach`,
     `/profile`, `/messages`, `/onboarding`, `/gap-calculator`, `/my-lease`,
     `/down-payment-wizard` (`client/src/components/app-sidebar.tsx:90-110`).
- **Seams**:
  1. calculator figures : `/calculators/*` → `/apply`, via `client/src/lib/calculatorPrefill.ts`
     (sessionStorage, **read-and-consumed** — `removeItem` at `:83`). Assert the *write* only; do
     not follow it across, because crossing means applying.
  2. anonymous intent : pre-auth surface → `/signup` → post-auth landing
     (`client/src/lib/pendingAttribution.ts`, `postAuthRoute.ts`).
  3. lease data : `/my-lease` → `/dashboard` and `/gap-calculator` — does anything downstream use
     what the rent ledger captured, or does it terminate in itself?
  4. **hero question : Landing's "Ask Homi" bar → `/ai-coach`, across the auth gate.** Written to
     `localStorage` as `PENDING_COACH_QUESTION_KEY`
     (`client/src/lib/pendingCoachQuestion.ts`) and read by
     `client/src/lib/postAuthRoute.ts:37` to redirect there after signup. This persona is the one
     most likely to ask a question before having an account — assert the question survives the
     round trip and is actually *asked*, not merely landed on.
  5. **estimator scenario : the Landing buying-power band → `/afford` and `/apply`.**
     `client/src/components/BuyingPowerEstimator.tsx:102-110` (`seedAndGo`) saves goal, income,
     debt band and down payment, then navigates. Assert the *write* and the `/afford` crossing;
     do not take the `/apply` exit.
- **Promises** (re-verified against `main` @ `8260d734`, 2026-08-20 — #595 moved every one of these):
  - `Landing.tsx:69-70` — *"See what you'd need to buy — and what the rent you already pay could buy
    instead."* → `/first-time-buyer`'s rent-to-price calculator is what must deliver it.
    ⚠️ **Do not go looking for the old second half.** This card used to read *"…and what your rent
    already proves about you"*, and this charter used to send the walker to check the qualification
    on it. **#595 retracted that clause** as a Reg N / MAP Rule §1014.3 misrepresentation — nothing
    downstream furnishes rent, and `MyLease.tsx:160` says so flatly. The retraction is the fix;
    **its absence is not a finding.** What is still worth checking is the standing rule underneath:
    `/my-lease` furnishes nothing to any bureau and `/rent-reporting` is an email-only waitlist, so
    any *new* copy implying a credit benefit is a finding.
  - `Landing.tsx:123` — *"Homi answers your questions any hour, in plain English"* — now a
    `TRUST_POINTS` entry, **not** a door. `/ai-coach` must be reachable and answering from every
    point on this route.
- **Dead-end watch**: `RenterHome` itself (does it name a next step, or is it a lobby?);
  `/my-lease` after saving a lease; `/gap-calculator` after producing a gap; `/onboarding` for a
  persona with no application. **The question only this seat answers:** after exhausting every
  offered step *without applying*, what is left?
- **Gate collisions**: the sandbox nav's own *"Get Pre-Approved" → `/apply`*
  (`app-sidebar.tsx:103`) is `<Gated>` in production — under PRELAUNCH the sandbox's only exit
  redirects to the waitlist. Record that; it is the gate working. Role gates: every route here is
  `ROUTE_GATES.borrower`, which both client roles satisfy.
- **Forbidden**: **never submit an application** — it promotes the shared seat
  (`server/routes/lending/applications.ts:134`) and takes the sandbox away from the next run. Never
  touch a row you did not create; no destructive SQL; never `pnpm db:push`; never `curl` in place
  of a click; never the deployed site.
- **Crosses domains**: 1 (public funnel & education), 3 (AI Coach), 10 (borrower graph),
  12 (property/homeowner), UX lens.

---

## 2. Active buyer — W-2 salaried

- **Persona**: salaried, one employer, one W-2. The product's assumed default case — and **the one
  persona with no door of its own**: `Landing.tsx:57-113` offers renting, self-employed, owner and
  moving-up, none of which is "I have a normal job." Walk both plausible entrances (the renting
  door, and a cold `/apply`); the second is the real one.
- **Account**: fresh registration at `/signup` as `jw2+<MMDD>@test.local`, fake-PII per the `tests/`
  convention. Starts `aspiring_owner`, **must end `active_buyer`**. **Not `buyer@test.com`** — that
  seat is pinned to `active_buyer` by `server/auth.ts:363` and structurally cannot cross the seam
  this journey exists to test.
- **Route**:
  1. `/` → find the door a salaried buyer would take.
  2. `/calculators/affordability` → tune income, debts, down payment, credit → "Start Pre-Approval".
  3. `/apply` (`client/src/pages/lending/PreApproval.tsx` + `client/src/funnel/*`) → complete it.
  4. **submit** → `POST /api/loan-applications` → the promotion fires.
  5. `/dashboard` → see the file exists and learn what happens next.
  6. `/urla-form` → complete the URLA.
  7. `/e-consent`, `/credit-consent/:id` → consents.
  8. `/verification` → income / assets / credit.
  9. `/application-summary`, `/loan-options/:id`, `/loan-estimate/:id` → the outcome.
- **Seams**:
  1. `annualIncome`, `monthlyDebts`, `downPayment`, `creditScore`, `purchasePrice` : calculator →
     funnel. Rides `calculatorPrefill.ts` — **read-and-consumed** (`:83`), so it survives exactly
     one crossing and is unobservable afterwards. `creditScore` crosses as a **raw score**; mapping
     to the funnel's band vocabulary is deliberately the reader's job, and the module's own header
     (`:14-21`) records that this is where a field "came to be handed over in a vocabulary the
     funnel does not accept."
  2. **estimator scenario : the Landing buying-power band → `/apply`.**
     `client/src/components/BuyingPowerEstimator.tsx:286` seeds goal, income, debt band and down
     payment via `seedAndGo` (`:102-110`) and navigates straight into the funnel — **a second,
     newer capture channel alongside `calculatorPrefill`, with its own storage and its own
     vocabulary.** Two independent channels feeding one funnel is exactly the shape that produced
     the credit-score vocabulary defect; assert each field arrives with the meaning it left with.
  3. **hero question : Landing's "Ask Homi" bar → `/ai-coach` across the auth gate**
     (`PENDING_COACH_QUESTION_KEY`, redirected by `client/src/lib/postAuthRoute.ts:37`). A buyer who
     asks before signing up must find the question asked, not just the page opened.
  4. every funnel answer : funnel → application record → `/dashboard`, `/application-summary`.
  5. income + employment : funnel → URLA section 1a. **A field the funnel already collected and the
     URLA asks again is a seam finding** even though both surfaces are individually correct.
  6. consent state : `/e-consent` → the surfaces it unlocks (`server/consentGate.ts`).
  7. verified provenance : `/verification` → decision recalc → the number rendered on
     `/application-summary`.
- **Promises**:
  - `Landing.tsx:123` — *"Homi answers your questions any hour, in plain English"* (a `TRUST_POINTS`
    entry, not a door).
  - `Landing.tsx:67` — *"We work out every way your income can count."* For a single-W-2 buyer,
    check this does not read as an offer the product then declines to make.
  - The funnel's own progress/ETA chrome — the step count it promises must be the step count it
    delivers, including any branch the answers open.
- **Dead-end watch**: `/dashboard` immediately post-promotion (does it name the next step, or show a
  file with nothing to do?); the decision surface on any outcome that is not a clean approval;
  `/loan-estimate/:id` — **ux-30 records that no borrower-reachable UI rendered the LE**, so treat
  the disclosure leg as suspect and re-date that claim before re-reporting it.
  ⚠️ **That claim is being fixed in flight** (#596, `fix/ux-30-le-reachable-v2`, touching
  `App.tsx`, `routeGates.ts`, `borrowerDashboard/LoanDetails.tsx`). **Check whether it has landed
  before reporting anything here** — a walker who re-files ux-30 after the fix has filed a false
  positive, and one who assumes the fix landed has skipped the only surface TRID delivery depends
  on. Verify by walking to it, not by reading this line.
- **Gate collisions**: `<Gated>` on `/apply` (`App.tsx:267`) and `prelaunchGate` on
  `POST /api/loan-applications` — under PRELAUNCH the journey terminates at the waitlist, which is
  correct. `ConsentGate` blocks the disclosure leg until e-consent. Role gates: every borrower
  surface is `ROUTE_GATES.borrower`, so **both sides of the promotion pass** — which is exactly why
  a silent promotion failure is invisible to a gate check and visible only from the nav.
- **Forbidden**: never `buyer@test.com`; never a row you did not create; no destructive SQL; never
  `pnpm db:push`; never `curl` in place of a click; never the deployed site.
- **Crosses domains**: 1, 2 (application & intake), 4 (verification & credit), 5 (underwriting &
  decisioning), 6 (pricing, rates & disclosures), 13 (security/PII), UX lens.

---

## 3. Active buyer — self-employed / business owner

- **Persona**: 1099s, K-1s, write-offs, a second entity, maybe a rental. Enters through the
  *"Your income is your own"* door (`Landing.tsx:74-91`) — the only persona whose door lands on a
  real explainer that pre-screens income shape and deep-links the answer.
- **Account**: fresh `/signup` as `jse+<MMDD>@test.local`; starts `aspiring_owner`, ends
  `active_buyer`. **Your answers must actually be complex**: `employmentType: "self_employed"`,
  ownership ≥ 25%, two entities, one rental property. A walker who answers like a W-2 employee has
  walked journey 2 under a different filename.
- **Route**: `/` → `/self-employed` → its income-shape pre-screen → `/apply?type=self-employed`
  (honored at `client/src/pages/lending/PreApproval.tsx:125`) → complete the branched funnel →
  **submit / promotion** → `/dashboard` → `/urla-form` (employment + self-employment worksheet) →
  `/documents` (the generated request set) → `/verification` → `/application-summary`.
- **Seams**:
  1. income shape : `/self-employed` pre-screen → `/apply` URL param → funnel default
     (`PreApproval.tsx:125`).
  2. **`complexIncome` : funnel flag → everything downstream.** Set at
     `client/src/funnel/preApprovalMachine.ts:114` from
     `employmentType === "self_employed" || multipleProperties`, consumed for routing at `:186-189`
     and `:265`. This is the journey's whole subject — see Dead-end watch.
  3. self-employment : funnel → URLA. The worksheet is rendered only behind
     `emp.isSelfEmployed || (activeSeq === 1 && app.employmentType === "self_employed")`
     (`client/src/pages/borrower/urla/EmploymentSection.tsx:286`, same gate defaults the checkbox at
     `:196`) — **so the funnel answer is what makes an entire URLA surface exist.** If it did not
     carry, the borrower is silently given the W-2 form.
  4. employment type → document request set. `server/pipelineEngine.ts:91-122` asks a self-employed
     borrower for 2-year returns, a YTD P&L, a business license and 3 months of business bank
     statements; a W-2 borrower gets W-2s and one year of returns (`:73-90`). Assert the borrower is
     shown the four, not the two.
  5. business income : documents/verification → the income figure and the decision explanation
     rendered back to the borrower.
- **Promises**:
  - `Landing.tsx:67` — *"1099s, K-1s, write-offs, rentals. We work out every way your income can
    count."* Name the surface that keeps it, per income kind you entered.
  - `/self-employed`'s own claims — a custom document checklist, and human review. Quote them with
    `file:line` and find where each is kept.
- **Dead-end watch**: **a branch that is taken and then forgotten renders identically to a product
  that never branched.** Taking the branch is easy to observe; carrying it is the seam. Also: the
  self-employed onboarding cards in `client/src/pages/borrower/OnboardingJourney.tsx` are
  **hardcoded client-side** and keyed on a server-derived `borrowerType`, independent of the
  pipeline conditions — so the card and the actual condition can disagree about how many months of
  bank statements are wanted. If they do, that is a two-surface finding.
- **Gate collisions**: `<Gated>` on both `/self-employed` (`App.tsx:257`) and `/apply` — under
  PRELAUNCH this journey has no first step at all.
- **Forbidden**: as journey 2.
- **Crosses domains**: 1, 2, 3 (documents & extraction), 4, 5, 6, UX lens.

---

## 4. Active buyer — affluent / move-up (jumbo)

> **Scope note, deliberate.** There is no affluent segment in this product: no `whiteGlove`,
> `concierge`, `VIP`, `serviceTier` or `highNetWorth` anywhere in `client/`, `server/`, `shared/`
> or `tests/`; no asset-depletion math (`shared/incomePaths.ts` has no such path — `asset_depletion`
> exists only as a doc-method *vocabulary* entry in `shared/loanProducts.ts`); and
> `server/services/coachingContext.ts:52`'s `UserType: "affluent_borrower"` is an **LLM tone flag
> that fires on complex income, not wealth** (derived at `:121` from
> `hasMultipleIncomes || hasBusinessIncome`). **Scoped as "journey 2 with bigger numbers," this seat
> would be headcount, not a control** (`knowledge-base/routines/TEAM.md`). It is scoped instead to
> the two real, currently-unowned things underneath: **the door with no explainer**, and
> **promise-versus-reachability across the jumbo threshold.**

- **Persona**: equity in hand, a balance above the conforming limit, more moving parts. Enters
  through *"You're moving up"* (`Landing.tsx:101-112`) — **the only one of the four doors that skips
  the explainer and links straight to `/apply`**, carrying the promise *"A bigger home, a bigger
  balance, more moving parts — jumbo included. We'll map the whole picture."*
- **Account**: fresh `/signup` as `jaf+<MMDD>@test.local`; starts `aspiring_owner`, ends
  `active_buyer`. **Figures must cross `CONFORMING_LOAN_LIMIT_2026 = 806_500`**
  (`shared/lendingLimits.ts:16`) — the surfaces that only exist above that line are the point of
  the seat.
- **Route**: `/` → *"You're moving up"* → `/apply` **directly, with no explainer in between** →
  complete the funnel with an above-conforming balance → **submit / promotion** → `/dashboard` →
  `/urla-form` → `/loan-options/:id` → `/loan-estimate/:id` → `/application-summary`.
- **Seams**:
  1. the door's promise : `Landing.tsx:88` → every surface on the route. Nothing on this route is
     an explainer, so the promise has to be kept by the funnel itself or not at all.
  2. **the jumbo threshold : funnel → product list → decision → disclosures → document requests.**
     `client/src/pages/lending/preApproval/AdvisoryPanel.tsx:76` tells the borrower the loan *"enters
     'Jumbo' territory, which may require a higher credit score and larger down payment."* Find
     whether **anything downstream ever agrees with that sentence** — or whether it is the only
     place jumbo is mentioned again.
  3. loan amount : funnel → `server/services/borrowerGraph.ts` eligibility (it pushes `jumbo`
     into `eligibleLoanTypes` above the limit) → the products actually offered.
- **Promises**:
  - `Landing.tsx:108-109` — *"We'll map the whole picture."* Name the surface that maps it.
  - `AdvisoryPanel.tsx:76` — the credit/down-payment warning. If nothing downstream applies a
    different standard, the warning is either unkept or untrue; either way it is a two-surface
    finding.
- **Dead-end watch**: **promise versus reachability.** Every high-touch surface in this product is
  behind a staff or admin gate — `/strategy-sessions`, `/scenario-desk`, `/deal-rescue` and
  `/partner-services` are `StaffPage`; `/closing-guarantee` is `AdminPage` (`client/src/App.tsx`).
  **No borrower reaches any of them.** If a public surface implies an advisor, a strategy session, a
  concierge or a guarantee, quote it and name the borrower-reachable surface that delivers it — or
  record that none exists. This is the one journey where the promise and its delivery sit on
  opposite sides of a role gate.
- **Gate collisions**: the door's own target `/apply` is `<Gated>` (`App.tsx:267`) — under PRELAUNCH
  this persona hits the waitlist on the **first click**, having been shown a specific product
  promise and no explanation. Record it as a launch-readiness fact.
- **Forbidden**: as journey 2.
- **Crosses domains**: 1, 2, 5, 6, 11 (staff/partner ops — for reachability only, never to review
  the staff surfaces themselves), UX lens.

> **Known, already-confirmed defect on this route** — file it through `finding-verifier` like any
> other, do not assume it: `AdvisoryPanel.tsx:73` gates the jumbo advisory on a hardcoded
> `stats.loanAmount > 766550`, a stale 2024 limit contradicting `CONFORMING_LOAN_LIMIT_2026 =
> 806_500` (`shared/lendingLimits.ts:16`). `tests/adversarialPersonas.test.ts` asserts one-limit
> consistency but checks only `server/seedMarketPricing.ts` and `server/services/borrowerGraph.ts`, never the funnel
> advisory — so between $766,550 and $806,500 the funnel calls a conforming loan "Jumbo."

---


---

## 5. Active buyer — condo / project-eligibility

> **Why this seat exists, and why it is not an income journey.** Journeys 2–4 are shaped by *how the
> borrower earns*. This one is shaped by *what they are buying* — the axis on which a perfectly
> qualified borrower is declined. The funnel offers `condo` as one of four property types
> (`shared/preApprovalForm.ts` — `single_family | condo | townhouse | multi_family`), and that
> answer is then **consulted by almost nothing the borrower ever sees**: a unit-count regex in
> `server/underwritingEngine.ts`, a pass-through field on `server/services/pricingAdapter.ts`, one
> condition in `server/services/borrowerGraph.ts`, and — on the delivery side only — Special
> Feature Code 588 for a detached condo unit
> The genuine zeros, verified 2026-08-22 across `client/src`, `server` and `shared`: **`leasehold`
> returns zero files**; so do *project review method*, *limited review*, *waiver of project review*,
> *PERS*, and *condo questionnaire*; and **HOA appears in none of the four decision files**
> (`underwritingEngine.ts`, `decisionEngine.ts`, `ruleEngine.ts`, `preUnderwriting.ts`). The funnel
> enum has **no PUD and no co-op option at all**.
>
> **But it is not a clean absence, and the three exceptions are the best leads on this route.
> Verify each before reporting it — these are leads, not findings:**
>
> 1. **The product already knows condos need project review — in the wrong path.**
>    `server/propertyAnalyzer.ts` pushes the risk flag
>    `"Condo - verify HOA, reserves, warrantability"`. Its only callers are `server/pricing.ts` and
>    `server/routes/calculators.ts` — **the calculator path, not the application path.** The
>    awareness exists where it costs nothing and is absent where the borrower relies on it. Find out
>    whether that flag is ever rendered to anyone.
> 2. **`isCooperative` is derived from a value the product cannot produce.**
>    `server/services/loanDeliveryReadiness.ts` sets
>    `isCooperative: propertyType.includes("co-op") || propertyType.includes("coop")`, while the
>    intake enum is exactly `single_family | condo | townhouse | multi_family`. Nothing writes
>    `co-op`, so the flag is permanently unset — yet `shared/fannieMae/loanDeliveryEdits.ts` carries
>    EarlyCheck edits **6158** and **6159** governing cooperatives. **Delivery-side rules for a
>    property type intake cannot represent** is a two-surface seam (intake → delivery), squarely the
>    *silent success* class.
> 3. **The education surface teaches what the funnel never asks.**
>    `client/src/pages/education/glossaryData.ts` explains **HO-6** condo insurance and
>    **Cooperative/co-op**. Both are concepts the intake has no field for. Explaining a thing and
>    then never asking about it is a promise made on one surface and declined on another — this
>    seat's subject, not a glossary complaint.
>
> **This is not a claim that the product is wrong** — a broker may reasonably defer project review
> to the lender. It is a claim that the borrower is never told, and that is a two-surface finding
> by construction: the property type is captured on one surface and its consequences appear on none.

- **Persona**: buying an attached unit in a condo project. Enters through any door — there is no
  condo door and no condo explainer — and picks `condo` at the property-type step. Their income may
  be immaculate and their loan still impossible, for reasons no surface on their route mentions.
- **Account**: fresh `/signup` as `jcd+<MMDD>@test.local`; starts `aspiring_owner`, ends
  `active_buyer`. Select `propertyType: "condo"` at the funnel step and **change nothing else from
  a clean W-2 profile** — the whole point is to isolate the property axis from the income axis. Walk
  a `single_family` control pass and diff the two routes.
- **Route**: `/` → `/apply` (choose `condo`) → complete the funnel → **submit / promotion** →
  `/dashboard` → `/urla-form` (property section) → `/documents` (the generated request set) →
  `/application-summary`, `/loan-options/:id`.
- **Seams**:
  1. **`propertyType` : funnel → every downstream surface.** The load-bearing assertion of this
     journey. Read what the borrower is shown at each stop and record, per surface, whether the
     answer `condo` changed **anything at all** versus the `single_family` control. A field captured
     and never reflected is the capture-path defect class in its purest form.
  2. property type → the document request set (`server/pipelineEngine.ts`). A condo file needs
     project documentation a detached file does not. Assert whether the generated list differs.
  3. property type → the decision explanation and any conditions shown to the borrower.
  4. property type → the offers/pricing surface — `pricingAdapter` carries the field; find whether
     anything the borrower sees is priced differently, or whether the field is inert.
- **Promises**: the Landing doors promise to *"map the whole picture"* and to tell the borrower
  *"what's actually within reach"* (`client/src/pages/public/Landing.tsx`). For a condo buyer,
  reachability depends on the **project**, not only on them. Quote what they were promised and name
  the surface that addresses it, or record that none does.
- **Dead-end watch**: the pre-approval or decision surface — does it disclose that a condo is
  subject to project review at all? An approval that is silent about the project is the outcome to
  look hardest at, and it is a **compliance-risk flag**, not merely a UX gap: it shapes what the
  borrower believes they can buy.
- **Gate collisions**: `<Gated>` on `/apply` under PRELAUNCH, as journeys 2–4.
- **Forbidden**: as journey 2. **And specifically: do not implement, propose, or assert project
  policy.** You are recording what the product does and does not tell a condo buyer. Whether
  Homiquity should model project review is a founder/product decision (see *Authority* below).
- **Crosses domains**: 1 (public funnel), 2 (application & intake), 5 (underwriting & decisioning),
  6 (pricing & disclosures), 8 (GSE delivery), 12 (property), UX lens.
- **Owners crossed** (`knowledge-base/handbook/FEATURE_MAP.md`): `hq-intake-funnel-owner`,
  `hq-property-owner`, `hq-underwriting-owner`, `hq-pricing-owner`, `hq-documents-owner`,
  `hq-gse-delivery-owner`. Route every single-surface hand-off to one of these by name (CHARTER §7).

> **Authority, and an honest gap.** The founder's highlighted Selling Guide (08-05-2026) marks the
> project-eligibility cluster more heavily than anything else in the document — **B4-2.1-01**
> (project types · review methods · waiver · delivery requirements · review expiration),
> **B4-2.1-02** (waiver of project review), **B4-2.1-03** (ineligible projects), **B4-2.2-01**
> (full review), **B4-2.2-04** (PERS), **B4-2.3-01** (PUD units) — alongside project insurance
> (**B7-3-03**, **B7-3-04**, **B7-4-01/02**) and leasehold estates (**B2-3-03**).
>
> ⚠️ **Those sections are not citable from `main`.** `docs/fannie-mae/selling-guide/` is **empty on
> `main`**; the captured corpus lives on PR **#650** and on a local-only branch (see
> `knowledge-base/compliance/` once either lands). Until one merges, a walker **must not assert a
> project-eligibility requirement** — it records what the product tells the borrower, flags the
> finding `compliance-risk: yes (Fannie B4-2)`, and defers the requirement itself to
> `compliance-auditor`. No captured source, no assertion.

## Baseline

A journey walk does not replace the domain or workflow passes and does not run their tests. Its
regression baseline is **the previous walk's `CLEAN` block**: a seam recorded as asserted-and-
carrying must be re-asserted, not carried forward. `CHARTER.md` rule 4 applies verbatim —
"inspected, works" ≠ "not inspected."
