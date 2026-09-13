# Team Working Practices

**Adopted:** 2026-07-04 · **Tier 2 doctrine** (decisions in force) · **Audience:** every
work session — human or Claude, scheduled routine or interactive — operating on this repo.
The source-of-truth ladder ("which doc do I trust") lives in the root
[README.md](../../README.md); this page covers **how we work**, not what is true.

These rules were distilled from a real failure day: on 2026-07-04 a 13-PR batch merge
staled a layer of documentation within hours, one report file sat untracked and invisible
to every worktree session, and stale UI chips reported open PRs that were already merged.
Each rule below names the failure it prevents.

## 1. No transient state in living docs

Open-PR numbers, branch names, session names and merge-queue status do not belong in living docs
(README, ASSUMPTIONS, kb doctrine, app-guide). Those state durable facts. *(Prevents: "Open PR #45 —
verify on merge" surviving in a fact register hours after the PR merged.)*

**Corrected 2026-09-12.** This rule used to send transient state to `CTO_ROADMAP.md` §0–§3,
"maintained nightly by Evening Triage". **Those sections no longer exist** — the roadmap was
restructured into product phases, and Evening Triage is not running. The rule therefore pointed at
nothing, which is worse than pointing nowhere: it read as though a home existed.

The live answers to "what is in flight", strongest first:

1. **`origin/main`** — what landed.
2. **Open pull requests** — a file with an open PR against it is claimed by that PR.
3. **[routines/REGISTER.md](../routines/REGISTER.md)** — the claim board, for intent that has not
   landed yet. Claims expire at 24 h unless an open PR stands behind them.

Do not hand-copy any of those into a document. A snapshot of open PRs is a claim about the past
wearing the clothes of the present (REGISTER.md's own words, and the reason it has no in-flight
table).

## 2. Dated reports are immutable snapshots

Files under `knowledge-base/archive/` (founder-routines, lo-audit, ux-audit),
`knowledge-base/logs/` and `knowledge-base/routines/reports/` are point-in-time
records. Never rewrite their findings. Corrections and supersessions go in a dated
**banner at the top** (`> ⚠️ SUPERSEDED …`). *(Prevents: history laundering — and readers
acting on a mid-afternoon report that the evening overtook.)*

## 3. Same-session commit rule

Any file a session generates (reports, research notes, extracted data) is **committed
before the session ends** — in the sanctioned lane for its type: a **docs-only PR merged
on green** (direct pushes to `main` are barred by doctrine — §6). An untracked file in one checkout is
invisible to every worktree and every other session. Code changes never ride along with a
report commit. *(Prevents: the 2026-07-04 lo-audit report stranding — that report now lives
at `knowledge-base/archive/lo-audit/2026-07-04-pm.md`.)*

## 4. Branch and worktree lifecycle

- One session = one isolated worktree = one branch. Never work on a branch in the shared
  primary checkout.
- **Name the branch for the agent that owns it**: `claude/<slice>` or `codex/<slice>`. Both
  prefixes have been in live use for weeks (`codex/` authored PRs #796–#800) and neither was
  written down until 2026-09-12, which left `git for-each-ref` unreadable as a record of who is
  doing what. Bot branches keep their own prefixes; `archive/` is never deleted by
  [`scripts/branch-cleanup.cjs`](../../scripts/branch-cleanup.cjs).
- Claim before building: add your row to [routines/REGISTER.md](../routines/REGISTER.md) (the
  claim board); release the claim if you abandon. Stale claims (>24 h) are reclaimable.
- Merged = deleted, same day — remote and local branch, worktree, and session archive.
- Deliberately kept-back work (standby branches) **must exist on origin**. A laptop-only
  branch is one disk failure from gone.

### PR size: one CI cycle *(added 2026-08-04)*

**If a PR cannot survive one CI cycle without going stale, it is too big for this repo's
cadence.** That is the rule, and the number comes from observation rather than taste: `main`
merges something roughly every 15 minutes at peak, and the gate takes ~3.5 minutes. A PR that
takes a day to assemble races ~30 commits.

This is not hypothetical. The 2026-08-04 financial-architecture PR was **69 files / 7,292
additions**, and in the time it took to open, `main` landed a migration at the same index —
`0038` on both sides. Caught only because the branch was merged up *before* opening the PR; had it
merged as-is, two entries would have shared `idx: 38` in the journal and the post-merge
`migrate-prod` job would have applied them in an undefined order. **On a prod database that
auto-applies migrations, a stale branch is a correctness risk, not an inconvenience.**

Practically:

- Split by seam, not by size. That PR was four: compensation, disclosure, economics, governance.
  Each would have merged inside an hour and never met a conflict.
- Land the shared reference (an audit log, a spec) as its own PR first. It is pure addition,
  merges immediately, and gives the follow-ups something to cite.
- Merge `main` **before** opening, not after CI goes green — that is when a migration collision
  is cheap to fix.
- If a PR must be large (a mechanical rename, a dependency migration), say so in the body and
  expect to re-merge `main` more than once.

### Verify locally; push on a cadence *(founder direction, 2026-08-18)*

**CI is the gate, not the build.** Run the whole suite on your own machine before pushing —
`pnpm check`, `pnpm build`, `pnpm test`, and every `guard:*` the gate runs. All of it works
offline against the checkout; none of it needs GitHub.

Then batch. A push is not free: it burns metered Actions minutes on a private repo (§ *PR size*
measures the gate at ~3.5 min against a 2,000-minute monthly allowance), and every merge to `main`
is a **Railway build and deploy of production**. Pushing after each commit spends both on work
that was not finished. Roughly one push a day is the expected rhythm — more when something is
genuinely urgent, not because a commit exists.

This does not loosen anything else: the gate still decides (§6), `verify-deploy` is still the only
proof a deploy landed (§4), and a green local run is evidence a push is *worth making*, never a
substitute for the gate. It changes when you push, not what has to be true before you merge.

The practical shape: keep working the branch locally, commit as you go, and when the batch is
coherent push once — one CI cycle, one deploy, one review.

## 5. Definition of done (every PR, no exceptions)

1. `pnpm check` clean (tsc).
2. `pnpm test` fully green — it runs the node suite **and** the client component suite. New
   server/logic test files must be added to `vitest.config.ts`'s include list; client
   component tests are colocated `client/src/**/*.test.tsx` and glob-included by
   `vitest.client.config.ts` automatically. **UI behavior gets a component test here first**
   (render/interaction against `data-testid`s, in happy-dom — no server); the §5.4 browser
   pass is for what a component test can't prove (visuals, full E2E).
3. Integration suite green against a live worktree server
   (`set -a; source .env; set +a; TEST_BASE_URL=http://localhost:5002 pnpm test:integration`).
   Boot the test server with `RATE_LIMIT_RELAXED=true` so the suite's auth and full HTTP
   traffic do not trip the 20/15-min auth or 500/15-min general API limiters; fallback if
   you can't set env: run in 3 groups with a server restart between (restarts clear the
   in-memory counters). The flag is ignored when `NODE_ENV=production`.
4. Live verification on the worktree port (5002+) when a running server proves the
   behavior — capture the evidence in the PR body. For client UI, do this *after* the
   point-2 component tests: the browser pass proves visuals and end-to-end wiring, not
   things a component test already pins.
5. Regulated math changes carry a `data/regulatory/regulatory-ledger.json` citation **in the
   same commit** — no citation, no code change. Never invent MISMO names (see
   [CLAUDE.md](../../CLAUDE.md) compliance-first rules). Selling Guide-governed logic
   (register in §10) additionally names its governing section id — resolving in
   `docs/fannie-mae/selling-guide/section-index.tsv` — in the changed lines or a
   `## Selling Guide authority` PR-body section; enforced by `pnpm guard:authority`.
6. Schema changes are **hand-authored** SQL in `migrations/` (drizzle-kit generate has
   snapshot drift). Never `pnpm db:push` from a worktree — the shared dev DB serves
   multiple branches and push drops other branches' columns. Since #251 `db:push` and
   `db:generate` are exit-1 stubs that print this doctrine, and `--force` would additionally
   drop the `sessions` table (created by the session store, not `shared/schema/`), logging out
   every user. Use targeted `ALTER TABLE … ADD COLUMN IF NOT EXISTS`. Full doctrine:
   [DB_MIGRATIONS.md](../runbooks/DB_MIGRATIONS.md) and CLAUDE.md.
7. New or changed environment variables land in `.env.example` **and** the env-var list in
   [CICD.md](../runbooks/CICD.md) in the same PR — production values live as **Railway service
   variables** (Railway → project *Homiquity* → service *Homiquity* → Variables).
   *(Prevents: a variable that exists only in someone's `.env` or the Railway dashboard,
   invisible to the next deployer.)* Say in the PR body whether the new variable is `VITE_*`:
   those are **build-time**, baked into the client bundle by `pnpm build`, so changing one
   takes effect on the next **redeploy**, not on a restart.
8. PR body contract: verification evidence (point 4), each new dependency justified in one
   line, a prod-impact note (migrations to apply / env vars to set / "none"), and an explicit
   doc-sync line — "docs updated: <files>" or "no doc update required". Silence is not a
   doc-sync statement.
9. Before implementing anything non-trivial: state your assumptions and the verifiable
   success criterion first ("write a failing test, then make it pass" beats "make it work"),
   then ship the **minimum diff** that satisfies it. Every changed line traces to the
   request; if a simpler approach exists, say so instead of building the clever one.

### Known traps index (check before fighting a known battle)

The trap doctrine lives where it lives — this is the one-stop pointer list. A newly
discovered trap gets a line here in the same PR.

- **A failed `git push` piped through `tail`/`head` reports SUCCESS.** A shell pipeline exits with
  the status of its *last* command, so `git push 2>&1 | tail -20` is `0` even when the pre-push gate
  blocked the push and nothing reached `origin`. Observed independently by two sessions on
  2026-08-20; one only noticed because a later `git ls-remote` disagreed with what it believed it
  had pushed. This mattered even more while `main` carried no required status check and the
  pre-push hook was the only gate; the required `gate` check is live again as of 2026-08-23, so a
  masked push now surfaces later as a PR that never gates rather than as a merge nobody checked —
  later, but still wrong. The hook itself is correct — verified `exit 1` against `origin/main`'s copy. Fix the
  caller: `set -o pipefail`, read `${PIPESTATUS[0]}`, or do not pipe. **Confirm a push by what is on
  the remote (`git rev-parse origin/<branch>`), never by an exit code.** Same family as every other
  entry here — an operation that did not happen while the output says it did
- **`pnpm db:push` from a worktree** drops other branches' columns on the shared dev DB, and
  `--force` also drops `sessions` (logging out every user); it is an exit-1 stub for that reason
  — [DB_MIGRATIONS.md](../runbooks/DB_MIGRATIONS.md).
- **`drizzle-kit generate` has snapshot drift** in this repo — hand-author migration SQL
  (point 6 above; [CLAUDE.md](../../CLAUDE.md) database rules).
- **Prod migrations are auto-applied by CI — never hand-apply.** The `migrate-prod` job
  applies pending `migrations/` on every merge to `main` (direct URL minted from
  `NEON_API_KEY`; the retired raw-`pg` + manual-journal-insert recipe caused the journal
  drift the dry-run pre-flight exists to reconcile). Break-glass:
  `DATABASE_URL=<direct-url> pnpm db:migrate:prod` ([DB_MIGRATIONS.md](../runbooks/DB_MIGRATIONS.md)).
- **A duplicated journal `when` silently skips a migration on prod** — the applier dedupes by
  `_journal.json` `when` as well as by hash (`scripts/migrate-prod.cjs`), so a copy-pasted
  `when` makes prod treat the new migration as already applied. Every `when` must be unique
  and strictly increasing ([DB_MIGRATIONS.md](../runbooks/DB_MIGRATIONS.md) §Adding a migration).
- **`pnpm-lock.yaml` is the only lockfile, and a stale one now fails the deploy outright** —
  the Railway build runs `pnpm install --frozen-lockfile && pnpm build` ([railway.json](../../railway.json)),
  which refuses to reconcile a lockfile that disagrees with `package.json`. After any dependency
  change run `pnpm install` and commit `pnpm-lock.yaml`. Never resurrect `package-lock.json` via
  `pnpm import` — it was deleted as proxy-poisoned (CH-1, 2026-07-08, when npm crashed mid-install
  with "Exit handler never called" on the then-host; [CICD.md](../runbooks/CICD.md)).
- **A failed Railway deploy leaves the previous container serving — the site stays up and every
  check stays green.** On 2026-08-06 nine consecutive deploys failed (`engines.node: "24.x"` is
  npm range syntax that mise, the Railpack toolchain resolver, cannot resolve) and prod sat ~8
  commits stale while `/api/health` answered 200 throughout. Neither a Railway deployment reading
  SUCCESS nor a 200 from `/api/health` is evidence your merge shipped — **only the `commit` field
  of `/api/health`** (it carries `RAILWAY_GIT_COMMIT_SHA`). CI's `verify-deploy` job polls it after
  every push to `main` and fails when prod is not serving that commit; if that job is red, treat
  prod as stale no matter what the dashboard says.
- **`/api/health` returning 200 does not mean the app is talking to the right database.** Its
  probe is a `SELECT 1`, which succeeds against *any* reachable Postgres. Also on 2026-08-06 the
  Railway service's `DATABASE_URL` was pointed at a stale Neon branch (28 of 53 migrations, no
  writes since 07-15): health stayed green while `/api/articles` and `/sitemap.xml` 500'd. After
  any DB env change, probe a **data-bearing** route as well, not just health.
- **Racing merges can land a tree the gate never tested** — the gate runs on the PR branch
  as pushed, so a PR that merges while other PRs land is combined with `main` untested
  (discovered 2026-07-17). The control is `strict: true` on `main`'s required status checks
  ("require branches to be up to date before merging"): a PR must be rebuilt on current
  `main` before it can merge, so a green gate can no longer be green against a base that has
  moved. **Verify it, don't assume it** (§6, §8) —
  `gh api repos/OWNER/REPO/branches/main/protection/required_status_checks --jq .strict`
  must print `true`. Whenever it is `false`, the hazard is live and the fallback is manual:
  after a squash merge amid other merges, diff the squash commit against your tested branch
  head before trusting green. Two costs to know going in: on a busy `main` every open PR
  must update before merging, so merges serialise; and the PATCH that sets `strict` must
  re-send `contexts[]` **verbatim** — the separators in
  `gate (typecheck · tests · schema guard)` are U+00B7 MIDDLE DOTs, and a mismatch deadlocks
  every future PR on "Expected — Waiting for status" with no admin bypass
  ([ci.yml](../../.github/workflows/ci.yml) carries the rename/recovery procedure).
- **The integration suite trips the auth rate limiter** — boot the test server with
  `RATE_LIMIT_RELAXED=true` (point 3 above).

## 6. Push and merge policy *(rewritten 2026-07-19: platform enforcement follows plan/visibility — verify it, don't assume it)*

- **Nobody direct-pushes `main`, founder included, and no PR merges before its `gate` is
  green.** Work lands as a short-lived branch → PR → gate green → **squash merge**. No
  required reviews: the author merges their own green PR. Recipe:
  [CICD.md](../runbooks/CICD.md) §Shipping.
  ✅ **Enforced again — measured 2026-08-23.** The `gate` check is a required status check on
  `main` once more, and `strict` is on with it. This bullet has now been wrong in **both**
  directions: it asserted enforcement from 2026-07-19 (#261, `65b17793`) through the weeks
  after protection was removed on 2026-08-19, then asserted the absence from 2026-08-22 into
  a day when it was live again. **Date the claim, or probe it.**
  The probe that cannot go stale is behavioural, because
  `gh api repos/barakatammre84/Homiquity/branches/main/protection` answers **403 "Resource
  not accessible by integration"** to any non-admin token — a session literally cannot read
  the contexts list, which is how both stale claims survived. What was observed instead:
  merging #708 and #647 through the API returned `405 Required status check "gate (typecheck ·
  tests · schema guard)" is expected`, and #647 went `behind` when `main` moved and merged only
  after being brought current. `…/branches/main --jq .protected` → `true`;
  `…/rules/branches/main --jq 'length'` → `0`, so it is classic protection, not a ruleset.
  **Practical consequence: a red or stale PR cannot be merged by anyone**, `--auto` is usable
  again, and renaming the `gate` job would deadlock every open PR.
- **⚠️ The 2026-07-19 lesson: GitHub enforces branch protection only while plan/visibility
  allow it, and a flip can silently *drop the rule entirely*.** The repo went private
  ~17:20Z that day (Free plan ⇒ no protection on private repos) — the rule wasn't merely
  suspended, it was **deleted** (API 404) — and **#252–#259 merged pre-green** because
  `gh pr merge --auto` cannot arm with nothing required: it merges instantly, gate still
  running (all eight gates passed post-hoc). The repo was made public again ~19:45Z
  (founder: "for now, pro later") and the rule re-applied from the documented config in
  [DB_MIGRATIONS.md](../runbooks/DB_MIGRATIONS.md) §One-time setup. So the standing habit:
  **before relying on `--auto`, verify enforcement is live** —
  `gh api repos/barakatammre84/Homiquity/branches/main/protection` must list the
  `gate` context as required. If it 403s/404s or lists no checks, enforcement is OFF:
  fall back to **watch-then-merge** (`gh pr checks <n> --watch --fail-fast` → green →
  `gh pr merge <n> --squash`), flag it to the founder, and never merge red/pending.
  Direct pushes and force-pushes to `main` stay barred by doctrine regardless of what the
  platform currently blocks. *(Break-glass for a genuine emergency: a deliberate,
  ledgered founder action — the `enforce_admins` toggle while protection is live, a
  knowing direct push only when it is not. Never autonomous, never silent —
  [ROLLBACK.md](../runbooks/ROLLBACK.md) §2.)*
- Every merge to `main` deploys production — Railway builds from GitHub and rolls a new
  container. **Ledger scope — rescoped 2026-08-18** *(founder-approved. The per-merge row rule
  dates to the pre-`verify-deploy` era; practice diverged for a month of merges after
  2026-07-19, and a rule nobody keeps trains readers to skip rules. Per-merge currency is now
  proven mechanically — the CI `verify-deploy` job reads `/api/health`'s `commit` field after
  every push to `main` — so the ledger binds where the PR record and `verify-deploy` cannot
  see)*: a row in the **production change ledger**
  ([CHANGE_LEDGER.md](../runbooks/CHANGE_LEDGER.md), split out of CICD.md 2026-08-06) is
  required, same session, for **(a)** any hand action against the prod DB or env — reseeds,
  variable flips, credential rotations, break-glass migrations; **(b)** incidents and their
  forward fixes; **(c)** deploys that tripped a §9 security trigger; **(d)** anything with a
  special rollback shape — contract migrations, destructive data changes, dependency majors.
  Ordinary green PR merges are recorded by the PR itself plus `verify-deploy` and need no row.
  Where a row IS written, validation **must include the binding post-deploy health probe** —
  `curl https://www.homiquity.com/api/health` — read by the **`commit`** field, not the status
  code: a build status attests the build, not the runtime, and a *failed* Railway deploy leaves
  the previous container serving, so a healthy 200 can be the old code answering (2026-08-06:
  nine failed deploys, prod ~8 commits stale, every check green). *(Prevents: an unledgered
  prod-touching action invisible to the next incident responder — and the 2026-07-17 class of
  outage, where a deploy marked READY served a dead API.)*
- Scheduled routines publish **docs-only, through the same PR lane** (docs-only branch →
  gate watched to green → merge; the routine inspects every commit's paths before opening
  the PR). A routine never carries code.
- **Immediately after a merge**: delete the merged branch (remote and local) and its worktree,
  and archive the finished session — stale session chips claiming "open PR" cost the team a
  confused audit. *(Prevents: the post-batch "2 active sessions and 8 pull requests"
  ghost state.)*
- Destructive production actions (grid reseed, env flips, credential rotation, any contract
  migration's data decision) are founder-supervised, never autonomous. Routines emit the exact
  runbook line instead. The one automated prod-DB writer is the `migrate-prod` CI job; what
  keeps it safe is the author-side discipline in [CLAUDE.md](../../CLAUDE.md) §Database
  (same-PR migration, expand/contract, read-only prod probe before any contract step).

## 7. Documentation link and file rules

- Markdown links in `knowledge-base/` subdirectory docs use paths **relative to the linking file**
  (`../../server/...` from `knowledge-base/governance/`) — a bare `server/...` link only works
  from the repo root and breaks in every viewer.
- Official reference binaries keep their **original filenames** (spaces included) for
  provenance; always quote paths in shell. Reading recipes live in each `docs/*/README.md`
  (PDF → Read tool/pypdf; XLSX → openpyxl).
- Every new doc gets a home in the tier map (root README) and one index line — an
  unindexed doc is an unread doc.
- **A citation that resolves to nothing is a lie the reader cannot detect.** Living docs are
  Claude's memory and a new engineer's map, so a path written in one is an instruction to go
  look. When the code moves and the prose does not, the doc keeps pointing — confidently — at
  nothing. `scripts/citation-guard.cjs` (`pnpm guard:citations`, in the gate) counts backticked
  repo paths that resolve to nothing and fails on any new one. *(Prevents: the 2026-08-18 sweep's
  finds — a security threat model listing the borrower routes among its highest-risk areas by a
  filename, months after they became the directory `server/routes/borrower/`, and L1/L2 citing
  each other by pre-rename filenames. This very clause was caught by the guard on its first run,
  for naming the dead path as an example; it now names the live one.)* If a file is deliberately absent — deleted, planned, an example, or the subject of
  a finding — **say so in the same sentence**. That is what makes the reference readable rather
  than merely tolerated, and it is why the guard is a **ratchet**: two thirds of the first 56 it
  found were correct as written, and "fix them all" would have deleted the record of a deletion.

## 8. Verification before assertion

Grep before claiming "missing"; read the code before repeating a doc's claim; check
`gh pr list` / `git log` before describing PR or branch state. The source-of-truth rule
applies to our own tickets and reports, not just external research. *(Prevents: ticket
#34 — a TRID clock "gap" that had been fully implemented on main all along.)*

## 9. Security-review triggers (binding)

Any PR touching one of the areas below runs `/security-review` (or an equivalent structured
security pass) **before merge**, and unresolved CRITICAL findings block the merge — the same
contract as the regulated-math rule in §5.5: no review, no merge. Record the outcome in the
PR body (part of the §5.8 contract).

- **PII vault / field encryption:** `server/services/ssnVault.ts`,
  `server/services/piiVault.ts`, `server/services/encryptionService.ts`, or any
  `shared/schema/` column holding PII.
- **Auth & sessions:** `server/auth.ts`, `server/socialAuth.ts`, `server/integrations/auth/`,
  `server/services/accountRecovery.ts` (mints password-reset tokens),
  `server/services/loginLockout.ts` (per-account brute-force control).
  *(loginLockout.ts added 2026-08-19. Same shape as the two gaps above — auth-critical
  code that lives in `services/` rather than on one of the three paths §9 originally
  named, so `detectTriggers(["server/services/loginLockout.ts"])` returned `[]`. It is
  §9 for what depends on it, the way `clientIp.ts` is: `authLimiter` in `server/app.ts`
  caps a **single IP** at 20 auth requests / 15 min, so against a **distributed**
  credential-stuffing attacker rotating source IPs, `LOCKOUT_THRESHOLD` and the
  exponential backoff window in this file are the **only** control still applying. A PR
  raising the threshold or shortening the window touches nothing else, so it would have
  merged with no security review. The trigger enumerates the two `services/` files by
  name and must stay that way — `server/services/` as a prefix would fire on most
  backend PRs, and a guard that over-fires teaches the next author to route around it.)*
- **Role/permission gates** (`isAdmin`, `requireRole`, staff scoping) and per-resource
  ownership checks on borrower data.
- **Uploads / object storage:** `server/integrations/object_storage/`, `shared/uploads.ts`.
- **Outbound messaging:** `server/services/emailService.ts`,
  `server/services/smsCompliance.ts`.
- **Webhook receivers and the code that authenticates them:** receivers under
  `/api/webhooks/*`, **and** `server/services/twilioSignature.ts` /
  `server/services/twilioMessageStatus.ts`. *(Added 2026-08-06: coverage was inverted —
  the route was a trigger but the service it delegates to was not, so the signature check
  that IS the auth boundary could be weakened without tripping the gate. #433 was that bug:
  the inbound SMS webhook trusted anyone who found the URL. **A path trigger must cover the
  delegate, not just the caller.**)*
- **Request identity & trust boundary:** `server/clientIp.ts`, `server/trustProxy.ts`.
  *(Added 2026-08-06. These exist only because Railway's edge sends `X-Real-IP`, not
  `X-Forwarded-For`, leaving `req.ip` as a shared internal address (#436). They are §9 not
  for what they are but for what consumes them: `rateLimitKey` (abuse control) and
  `clientIpForRecord`, which is written to every audit row **and** to `consentIp` in
  `server/routes/leads.ts` — the TCPA consent provenance. A wrong change here bypasses rate
  limiting and falsifies legal consent evidence.)*
- **Rate-limit policy:** `server/services/rateLimitPolicy.ts`.
- **PII encryption call sites:** any code under `server/` or `shared/` that calls
  `encryptSensitiveData` / `decryptSensitiveData` / `encryptPiiField` / `decryptPiiField` /
  `encryptSsnToColumns` / `decryptSsnFromRow`. *(Added 2026-08-12. The three vault **files**
  were already triggers, but their **callers** were not — so a PR that encrypted a landlord
  email and a property address in a new module produced zero triggers. Same shape as the
  2026-08-06 webhook gap, inverted: there the route was covered and the delegate was not;
  here the vault is covered and the caller is not. The caller is where a plaintext write, a
  dropped `keyId`, or a decrypt swallowed to `null` actually happens. Narrow by
  construction — six files in the repo call these, three already triggers.)*
- **Consumer-data furnishing (CRA):** `server/services/rentFurnishing.ts`,
  `shared/lib/metro2/`. *(Added 2026-08-08 with the rent-reporting program. Every other
  credit path in this repo makes us a consumer-report **user** — permissible purpose,
  adverse action, retention. Furnishing inverts that: we **write** to a consumer's file at
  a third party. A wrong change here does not surface as a failed request; it lands
  inaccurate derogatory information on a real person's credit report, and the only remedy
  is a dispute they must file. §9 named no CRA or furnisher trigger at all before this.)*
- **Money movement / payment processing:** adding or activating a payment-processor
  dependency (in `package.json` or anywhere under `server/`). *(Added 2026-08-08. This one
  is a **content** trigger, not a path: the file that will carry it does not exist yet, and
  a speculative path would be a trigger that can never fire. The dependency is the stable
  signal — money cannot move without a processor SDK, so the review is owed the moment one
  lands, before any route is written. The gap this closes is independent of rent: the repo
  has no ledger and no trust/operating account separation, so the first funds-touching PR
  would arrive with none of the invariants that make it reviewable after the fact.)*
- **Logging near PII:** any widening of `RESPONSE_BODY_LOG_ALLOWLIST` in `server/app.ts`.
**Partly enforced by the gate.** `pnpm guard:security`
([`scripts/security-review-guard.cjs`](../../scripts/security-review-guard.cjs)) fails the PR
when it touches a trigger below and the PR body carries no heading containing
`Security review`. Two things it deliberately is not: it proves the review was *written
down*, never that it was *correct* — with a single collaborator no automation can do the
latter, which is also why CODEOWNERS cannot be used here (GitHub forbids self-approval, so
requiring code-owner review would deadlock every §9 PR). And its coverage of the two
judgement-based triggers is partial at best:

- **`shared/schema/` PII columns — detected, but only by name.** The guard fires on a
  newly added column or table whose name carries identity/contact/consent vocabulary
  (`ssn`, `dob`, `*_phone`, `email`, `ip`, `address`, `consent_*`, `account_number`,
  `first/last/full_name`, …). It deliberately does **not** fire on a column that already
  existed and is merely being edited or relocated, and it deliberately leaves income,
  credit scores and balances out of the vocabulary — they are the bulk of an underwriting
  schema, and including them would burn the signal. So a PII column named outside that
  vocabulary (`applicant_identifier`, `contact_detail`) still passes silently. **The
  trigger is a floor, not a ceiling.** *(Closed a real blind spot: before this, no trigger
  covered `shared/schema/**` at all, and a `user_phones` table carrying a phone number plus
  TCPA consent provenance produced zero triggers.)*
- **New PII sub-processor — not detected at all.** Knowing a new vendor is a processor is
  human judgement, and nothing in a diff carries it.

**A green gate is not evidence that §9 is satisfied on either.** The rule binds whether or
not the script fires.

**Keep the triggers narrow.** Every path above is named because a wrong change to *that
file* has a specific, statable cost. Do not widen them into globs (`server/services/*`):
the gate proves a review was written down, so a trigger that fires on everything converts
the review section into pasted boilerplate and makes the artifact worth less than it is
now. **Audit coverage by running `detectTriggers()` against the security-critical files
that actually exist — not by re-reading this list**, which is how the two 2026-08-06 gaps
were found after the Railway cutover created them.

- **New PII sub-processor:** any PR that introduces or activates an external service
  receiving borrower PII (storage, OCR/extraction, income/asset verification, transcript
  retrieval, messaging providers). The review covers the egress path end-to-end, and a
  vendor-diligence note lands in `governance/security/` in the same program (pattern: the
  Plaid clearance pack). *(Added by the
  [2026-08-04 sovereign-stack adjudication](../logs/2026-08-04-sovereign-underwriting-stack-pitch-adjudication.md)
  §3.4 — every external pitch in that series proposed an unreviewed new PII processor.)*

---

## 10. Selling Guide authority triggers (binding)

The Fannie Mae *Selling Guide* (edition 08-05-2026, materialized at
`docs/fannie-mae/selling-guide/` by one command — the copyrighted text is gitignored because
this repo is public) is the policy authority for eligibility, underwriting, income, credit,
property and delivery. It controls over every job aid in `docs/fannie-mae/`, and over anything
in this repo.

**And over decisions taken before any of this applies.** This section binds PRs; the founder's
direction of 2026-08-24 is that the Guide is the core document *every seat* refers to when
making a decision, the CEO's included — a product promise or a pricing move settled in
conversation reaches a PR already committed, where a guard can only argue with it. That rule,
written for a reader who will never run one, is
[compliance/SELLING_GUIDE_DECISION_RULE.md](../compliance/SELLING_GUIDE_DECISION_RULE.md); it
also says which of the two renderings to read (markdown — the text one flattens the Guide's
tables, where most thresholds live).

**Why this is a gate and not a preference.** Homiquity is a broker — in the Guide's own
vocabulary a **third-party originator** (A3-3-01). A wholesale lender selling our files to
Fannie "must satisfy itself that the third-party originator is capable of producing quality
loans," and its QC is required to pull "a post-closing stratified random sample of third-party
originations" for full-file review "on at least a monthly basis" (D1-1-01). The Guide is
therefore the standard every counterparty we want is contractually obliged to measure us
against — not a reference shelf. A3-4-02 is the keystone: data must be "complete and
accurate," all DU data "verifiable," and the lender must keep "adequate procedures in place to
validate the integrity of specific data for each underwriting recommendation." Liability for
inaccuracy runs **life-of-loan** (A2-2-07).

Part D binds the *lender*, not us. Adopting its shape for our own quality program is a
deliberate business choice, recorded as such — never described as a compliance obligation we
are already under.

### The two rules

1. **Cite the governing section.** A PR changing logic under a trigger path below names the
   Selling Guide section that governs it, either in the changed lines (a comment or a citation
   object beside the rule) or in a `## Selling Guide authority` section of the PR body.
2. **An unresolvable id fails anywhere in the diff** — including docs, including files no
   trigger covers. The Guide renumbers between editions, and a stale cite does not announce
   itself: when self-employment income moved off B3-3.2 on 2026-03-04, six sites kept citing
   the old chapter because the URL still returned HTTP 200 and silently served the renumbered
   page. Deliberate historical references stay writable — put `formerly` (or
   `renumbered`/`superseded`/`historical`) on the same line.

**The refactor exit is an attestation, not a waiver.** A diff that touches a governed file
without asserting policy writes the exact sentence `No Selling Guide policy asserted or
altered` in that PR-body section, plus a line of why. It is recorded in the PR with an author's
name on it — the same logic as §9's: for a solo owner the enforceable thing is the artifact,
not a second approver.

### Trigger paths

Mirrored in `PATH_TRIGGERS` in `scripts/selling-guide-authority-guard.cjs`. **This register and
that array are edited in the same PR** — the §9 pairing, for the same reason.

| Group | Paths |
|---|---|
| underwriting & decision engines | `server/underwritingEngine.ts`, `server/underwriting.ts`, `server/services/decisionEngine.ts`, `server/services/ruleEngine.ts`, `server/services/preUnderwriting.ts`, `server/services/underwritingNuance.ts` |
| income policy | `server/services/selfEmploymentIncome.ts`, `server/services/income/`, `server/services/worksheetPrefill.ts`, `shared/incomePaths.ts`, `shared/taxFormExtraction.ts`, `shared/borrowerIncomeView.ts` |
| scenario & classification | `server/services/scenarioCatalog.ts`, `server/services/situationClassifier.ts`, `server/services/loanAnalysis.ts` |
| AUS / DU | `server/services/ausSubmission.ts`, `server/routes/aus.ts` |
| delivery & submission readiness | `server/services/loanDeliveryReadiness.ts`, `server/services/brokerSubmissionReadiness.ts`, `server/services/lenderSubmission.ts`, `server/services/mismoValidation.ts`, `server/mismo.ts`, `shared/mismo.ts` |
| policy data & schema | `server/scripts/seedLendingGrids.ts`, `shared/schema/lendingUrla.ts` |
| borrower-facing policy surfaces | `server/services/autopilot/followUps.ts` |

**Deliberately excluded — do not add without reading why.** `shared/fannieMae/` is job-aid
sourced: it carries delivery *formats* (ULDD/UCD enumerations, edit codes, SFCs) whose
authority is the job aids plus the §5.5 ledger rule, and dual-gating it would teach people to
paste Guide ids onto job-aid data, which is worse than no citation. `server/pricing.ts` is
excluded because LLPA authority is the LLPA Matrix, which is **not procured** — a trigger
nobody can satisfy honestly trains route-arounds. Add it when the Matrix lands.

### What a green gate does and does not mean

It proves a citation was **written down** and that the id **exists**. It cannot prove the cited
section says what the code claims — a resolving id is a pointer, not a verification. And a
value read out of a **table** is not verified at all until it is checked against the PDF page:
the text extraction flattens tables, ruled ones survive and borderless ones do not (B2-2-03's
financed-property limits table is the known case). Prose may be trusted from the text; a
threshold, matrix cell or eligibility limit may not.

### The corpus itself is gated (added 2026-08-23)

The authority guard only works while the corpus it resolves against is trustworthy, so the
corpus carries its own enforcement, wired the same same-PR way as this register:

- **In the gate, always-run (never behind the scope step — corpus PRs classify as inert
  docs):** `pnpm guard:corpus` (the fact layer agrees with itself and with the extractor's
  pinned identity — the pins are *parsed out of* `scripts/extract-selling-guide.py`, and the
  guard's anchors, the extractor's constants, `manifest.json` and the regenerated fact layer
  move **in the same PR** or the gate is red); `pnpm guard:coverage` (the 423-row map current);
  and the full extraction proof (recover the PDF from git history, re-extract at the pinned
  pymupdf, `--check`). `tests/ciTriggers.test.ts` pins all three steps present and
  unconditioned.
- **Per session:** the SessionStart hook (`.claude/settings.json` →
  `scripts/selling-guide-session-hook.cjs`) verifies/materializes the corpus at session start
  and prints a corpus-first directive when it cannot. The hook informs; the gate blocks.
- **Per day:** the **Selling Guide Steward** routine (CHARTER §3a, 05:30 UTC) re-proves the
  whole chain from a clean worktree, probes for editions/amendments, sweeps the Guide's own
  link inventory (`docs/fannie-mae/selling-guide/links.json`), and reports — draft PRs only.
  Edition cutover is a founder runbook
  ([docs/fannie-mae/selling-guide/README.md](../../docs/fannie-mae/selling-guide/README.md)
  "When the next edition lands"), never an automated act.

Program map and the founder-gated end-state criteria:
[knowledge-base/compliance/SELLING_GUIDE_PERMANENCE.md](../compliance/SELLING_GUIDE_PERMANENCE.md).
