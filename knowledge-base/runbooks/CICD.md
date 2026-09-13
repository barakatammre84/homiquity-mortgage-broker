# Deploy & Revert

> **Naming note (rebrand, 2026-08-04).** This product was formerly called
> **MortgageStream**. Ledger rows, PR links, and postmortems below that predate
> 2026-08-04 are left exactly as written — they were accurate at the time, and the
> GitHub URLs still resolve because GitHub redirects renamed repositories. Read
> `MortgageStream` / `mortgage-stream.vercel.app` in historical rows as the former
> names of Homiquity / the hosting project it was then deployed on.

> **Platform note (Railway cutover, 2026-08-06).** Hosting moved from Vercel to
> **Railway**, and the Vercel project was deleted — there is no Vercel account
> surface left to open. Everything above the ledger describes Railway. Ledger
> rows, postmortems, and the `dpl_…` deployment IDs they cite as evidence are
> left exactly as written: they record what was true on their date, when the
> platform *was* Vercel.

Homiquity ships with a deliberately simple flow: **branch → PR → the required
`gate` check goes green → merge, and Railway builds and deploys `main`. If it
breaks, revert.** No human review required — the machine gate is the only
approval. One caveat that cost eight commits of silent staleness on 2026-08-06:
**a merge is not a deploy until `/api/health` reports the merged commit** — see
the post-deploy check below.

```
  PR ──▶ gate green ──▶ merge to main ──▶ Railway builds & deploys
          │                  │                       │
          ▼                  ▼                       ▼
  typecheck · unit +   migrate-prod applies    verify-deploy polls /api/health
  client tests ·       pending migrations      until `commit` == the merged SHA
  prod-dep audit ·     to the prod DB                 │
  schema guard ·                               stale or broken?
  token ratchet ·                                     ▼
  prod build + boot                            Railway → service → Deployments
                                               → last good one → Rollback
```

**CI status (corrected 2026-07-17; token ratchet gated 2026-07-19): the gate is
live and blocking.** [`ci.yml`](../../.github/workflows/ci.yml) runs a required
**`gate`** job on every PR to `main` — `pnpm check`, `pnpm test` (node unit +
client component suites), a **blocking** `pnpm audit --prod --audit-level=high`,
`pnpm guard:schema` (a schema change without a same-PR migration goes RED and
cannot merge), `pnpm guard:tokens` (the design-token ratchet — a raw palette
class or bare white/black literal over baseline goes RED), and a production
build whose artifact is then **booted** against a disposable Postgres until
`/api/health` answers 200 (the full step list lives in the workflow). Branch protection
requires that check with `enforce_admins` ON — nobody direct-pushes `main`,
founder included; force-push and deletion of `main` are blocked. No required
reviews: the author merges their own PR once the gate is green
([TEAM_PRACTICES](../governance/TEAM_PRACTICES.md) §6).
**⚠️ Enforcement follows plan/visibility — verify it, don't assume it**
*(2026-07-19)*: protection only exists here because the repo is **public** on the
Free plan. When the repo went private for ~2½ hours that day, GitHub silently
**deleted** the rule (API 404, not a suspension) and **#252–#259 merged
pre-green** — with nothing required, `gh pr merge --auto` cannot arm and merges
instantly, gate still running. The repo was made public again (founder: "for
now, pro later") and the rule re-applied from the config recorded in
[DB_MIGRATIONS.md](./DB_MIGRATIONS.md) §One-time setup, verified by probe PR
#262. **Before relying on `--auto`, confirm
`gh api repos/…/branches/main/protection` lists the `gate` context; on 403/404,
use watch-then-merge and flag the founder** (TEAM_PRACTICES §6). On merge, the
same workflow's **`migrate-prod`** job auto-applies any pending `migrations/` to
the production DB over a Neon DIRECT URL minted at run time from `NEON_API_KEY`
— no prod DB password is stored in GitHub; full flow and its limits (a manual
`dry_run` reconciles the journal only, it never executes migration SQL) in
[DB_MIGRATIONS.md](./DB_MIGRATIONS.md). A third job, **`verify-deploy`**, then
polls `https://www.homiquity.com/api/health` until its `commit` field equals the
pushed SHA and **fails the run** if it never does — the automated form of the
post-deploy check below, added after the 2026-08-06 stale-prod incident. It is
not a required check (it runs on push, after the merge), so a red `verify-deploy`
is a page-the-founder signal, not a merge blocker. ⚠️ The required-check string is matched
**verbatim** (`gate (typecheck · tests · schema guard)`, U+00B7 middle dots) —
never rename the job without re-pointing branch protection in the same change
(procedure in the workflow's comments).

## Shipping

```bash
git checkout -b <topic-branch>         # never commit on main — direct pushes are blocked + barred
git push -u origin <topic-branch>
gh pr create --fill                    # the gate runs automatically
gh pr checks --watch --fail-fast       # wait for green…
gh pr merge --squash --delete-branch   # …then merge your own PR (no reviews required)
# `--auto` only after verifying protection is live (gh api …/branches/main/protection
# lists the gate as required). If that 403s/404s, --auto merges IMMEDIATELY with the
# gate still running — the 2026-07-19 #252–#259 gap. Watch-then-merge is always safe.
```

Every merge to `main` triggers a production build + deploy on Railway (then run
the post-deploy health check below — a green build is not a shipped deploy, and
a 200 is not the right commit). **PR branches are not deployed**: the Railway
service is wired to the `main` branch of `barakatammre84/Homiquity` only, so
there are no preview URLs — verify a branch against a local worktree server
([LOCAL_DEV.md](./LOCAL_DEV.md)). One branch per isolated worktree,
merged = deleted same day ([TEAM_PRACTICES](../governance/TEAM_PRACTICES.md)
§4). The old `npm run save` / `npm run sync` scripts direct-pushed `main` and
were removed in PR #251 — direct pushes are blocked by branch protection while
it is live, and barred by doctrine always ([TEAM_PRACTICES](../governance/TEAM_PRACTICES.md) §6).

## Reverting

Full detail in [ROLLBACK.md](./ROLLBACK.md). Short version:

- **Prod is broken right now** → Railway dashboard → project **Homiquity** →
  service **Homiquity** → **Deployments** → the last good deployment → `⋯` →
  **Rollback**. That restores the built image *and the variables it was
  deployed with*, with no rebuild. Two things it is not: `railway redeploy`
  rebuilds the latest (i.e. broken) commit, and `railway restart` just restarts
  the current image. Image retention is limited (72h on Hobby) — an old-enough
  deployment has no image to roll back to, and the fallback is a `git revert`
  through the PR lane.
- **Undo the bad code** → `git revert <sha>` on a branch, landed through the
  normal PR lane — direct pushes to `main` are blocked and barred, and the PR
  lane runs the gate (never `reset --hard` + force-push; break-glass per
  [ROLLBACK.md](./ROLLBACK.md) §2).
- **Database** → schema changes ship as **hand-authored** versioned migration
  files in `migrations/`, applied with `pnpm db:migrate` (**never `db:push`**,
  **never `drizzle-kit generate`** — see [ROLLBACK.md](./ROLLBACK.md) §3 and
  [app-guide/03-database.md](../handbook/app-guide/03-database.md)). Still snapshot/branch
  in Neon before destructive schema changes; migrations have no automatic "down".

## How the Railway deploy works

- **One persistent Node process — no CDN, no serverless function, no edge
  middleware.** `pnpm build` = `vite build` (static client → `dist/public`)
  **plus** an esbuild bundle of `server/index-prod.ts` → `dist/index.js`;
  `pnpm start` runs that single file. The same Express app answers `/api/*`,
  serves `dist/public` through `express.static`, and falls back to the SPA
  `index.html` — in one process, listening on `$PORT`. Everything that used to
  be a platform feature is now in-process: bot prerender is
  `server/prerender.ts`, the private beta gate is
  `server/middleware/betaGate.ts` (both mounted ahead of the static layer), and
  scheduled work is a GitHub Actions workflow (see below).
- **`railway.json` is the config as code** — it lives in the repo, is reviewed
  in the PR, and the fields it sets take precedence over the dashboard's:
  builder **Railpack**, build `pnpm install --frozen-lockfile && pnpm build`,
  start `pnpm start`, healthcheck `/api/health` (300s), restart policy
  `ON_FAILURE` (max 10 retries). The service builds from GitHub — branch `main`
  of `barakatammre84/Homiquity` — and answers on the generated
  `*.up.railway.app` host plus the custom domain `www.homiquity.com`.
- **`www.homiquity.com` is the canonical host; the apex is not on Railway.** DNS
  is at Squarespace: `CNAME www → <service>.up.railway.app`. The apex
  `homiquity.com` cannot point at Railway because that needs CNAME flattening /
  ALIAS records, which Squarespace does not offer — it currently serves a
  Squarespace parked page. So use the `www.` URL everywhere (probes, canonical
  tags, invite links); an apex URL is not the app.
- **`engines.node` must be an exact version, never an npm range** *(2026-08-06,
  nine failed deploys)*. `"24.x"` is npm range syntax; Railpack resolves the
  Node version through `mise`, which cannot parse it, so every build failed at
  the version-resolution step. Nothing went red where anyone was looking — a
  failed Railway build leaves the **previous container serving**, so the site
  stayed up and prod sat ~8 commits stale. `package.json` now pins
  `"engines": { "node": "24" }`; the same trap applies to `^24` and `>=24`.
  `.npmrc` disables audit/fund noise.
- **The server ships as a bundle, not as the raw TS graph.** Server code uses
  the `@shared/*` tsconfig alias, which a plain Node runtime cannot resolve;
  esbuild resolves it at build time into `dist/index.js`. Two rules learned the
  hard way still bind, and bite harder on a persistent host: never construct
  SDK clients at module load (learned when the since-removed OpenAI client threw
  without a key — build them lazily), and never rely on writing to the
  filesystem (the container filesystem is ephemeral — it is discarded on every
  deploy and restart; documents go through the object-storage layer). A throw at
  import time is no longer one dead request: the process never becomes healthy,
  the healthcheck fails, the deploy is rejected, and the stale container keeps
  serving — which is why the gate **boots** `dist/index.js` against a real
  Postgres and requires a 200 from `/api/health`, not just a green build.
- **Why pnpm (do not switch back to npm casually):** npm crashed mid-install on
  the old build image with "Exit handler never called" on Node 20, 22 AND 24
  (reproduced four deploys in a row) while the identical install worked locally;
  pnpm sidesteps npm entirely. The Vercel-era install also needed `--prod=false`
  because that platform set `NODE_ENV=production` at build time, which makes
  pnpm skip devDependencies — and `vite` is a devDependency. Railway's build
  command does not need the flag today, so if a build ever dies with
  `vite: not found`, that is the failure mode to check first.
- **One lockfile: pnpm-only** *(updated 2026-07-08, CH-1 `1661c95` — supersedes
  the old "two lockfiles" note)*. `package-lock.json` was deleted (it resolved 53
  packages against the dead `package-firewall.replit.local` proxy); `pnpm-lock.yaml`
  is the single lockfile for local dev AND the production build. Local dev uses
  pnpm via corepack (`corepack enable`; version pinned by `packageManager` in
  `package.json`).
  **After any dependency change, run `pnpm install` and commit `pnpm-lock.yaml`.**
- **`pnpm.overrides` rules (2026-07-17 outage,
  [postmortem](../logs/2026-07-17-prod-api-outage-uuid-esm-postmortem.md)):** never write a
  version **floor** (`>=`) — floors auto-upgrade across majors as the registry moves and can pull
  an ESM-only major onto a CJS `require` path (the build uses `--packages=external`, so externals
  load from `node_modules` at runtime and a `require(esm)` mismatch is a real crash on Node too).
  Pin exactly or cap within a major (`^`), record next to the
  override why it exists, and when an override *activates* (as in #219), diff the lockfile for
  major-version jumps — then boot the built server, not just the build.
- Env vars live in **Railway service variables** (Railway → project *Homiquity*
  → service *Homiquity* → **Variables**): `DATABASE_URL` (Neon,
  non-localhost), `SESSION_SECRET`, `CREDIT_ENCRYPTION_KEY`, `PII_HASH_SALT`,
  `NODE_ENV=production`, `CRON_SECRET` (must match the GitHub **repository
  secret** of the same name — see the scheduler below), plus optional
  `ANTHROPIC_API_KEY` (all AI surfaces —
  coach, extraction; `AI_INTEGRATIONS_ANTHROPIC_API_KEY` overrides it for
  extraction — the Gemini/OpenAI keys are retired), `GOOGLE_MAPS_SERVER_API_KEY`,
  `GOOGLE_MAPS_BROWSER_API_KEY`,
  `RAPIDAPI_KEY` (property data), and for document storage
  `GCS_SERVICE_ACCOUNT_KEY`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS`.
  The full contract is `.env.example` — a var that isn't there doesn't exist.
  - **`VITE_*` vars are BUILD-time, everything else is run-time.** A `VITE_*`
    value is baked into the client bundle by `vite build`, so changing one takes
    a **redeploy** (rebuild), not a restart. Server-side vars are read by the
    running process, so a change there takes effect when the service restarts
    with the new variables.
  - **Point `DATABASE_URL` at the right Neon branch and verify it.** On
    2026-08-06 it held a stale branch (28 of 53 migrations, no writes since
    07-15): `/api/articles` and `/sitemap.xml` 500'd while `/api/health` stayed
    **200**, because its `SELECT 1` succeeded — against the wrong database. A
    health probe proves reachability, not identity; after any DB var change,
    hit a route that reads real rows.

## Post-deploy health check (binding) — a green deploy is not a shipped deploy

Two independent failures taught this, and the check has to survive both:

- **2026-07-17 — the build succeeded and the server was dead** *(Vercel era, but
  the rule survives the platform)*. A READY, aliased deployment served a working
  front end while every `/api/*` route returned a boot error for ~16 minutes
  ([postmortem](../logs/2026-07-17-prod-api-outage-uuid-esm-postmortem.md)).
  Build state says nothing about runtime state.
- **2026-08-06 — the deploy failed and nothing noticed.** Nine consecutive
  Railway builds failed (`engines.node: "24.x"`); a failed deploy leaves the
  **previous container serving**, so the site stayed up, `/api/health` kept
  answering 200, every check stayed green — and prod sat ~8 commits stale.
  "SUCCESS" in a dashboard and a 200 from the health endpoint are **not**
  evidence that your merge shipped. Only the `commit` field is.

Therefore, after **every** production deploy (yours or one you're verifying),
compare the commit prod is serving against the commit you merged:

```bash
curl -s https://www.homiquity.com/api/health          # {"status":"ok","timestamp":…,"commit":…}
git rev-parse origin/main                             # must equal that `commit`
```

- `commit` is `RAILWAY_GIT_COMMIT_SHA`, injected by Railway for GitHub-sourced
  deploys (it is `null` locally — that is honest, not a fault). CI does this for
  you: the `verify-deploy` job polls the endpoint after every push to `main` and
  fails the run if prod never reports that SHA.
- A ledger row's validation column is **incomplete** without this probe (or an equivalent live API
  hit) for any change that can affect the server at runtime — which includes *dependency-only*
  changes (lockfile, overrides): the dependency graph IS runtime behavior under
  `--packages=external`.
- `status: "ok"` alone only proves the process is alive and *some* database
  answered `SELECT 1`. For anything data-shaped, also hit a route that reads
  real rows (`/api/articles`, `/sitemap.xml`) — the 2026-08-06 wrong-branch
  lesson above.
- If the commit is stale or the probe fails: Railway → project **Homiquity** →
  service **Homiquity** → **Deployments**, and read the **build logs of the
  failed deploy** — that is where the real error is; the serving container's
  logs look perfectly healthy because it is the old one. Then fix forward or
  roll back per [ROLLBACK.md](./ROLLBACK.md); do not wait for a monitoring
  system that does not exist yet.

## Scheduled jobs (GitHub Actions, not the platform)

[`.github/workflows/cron-jobs.yml`](../../.github/workflows/cron-jobs.yml) is
**the** scheduler — the platform cron block it once mirrored was deleted at the
Railway cutover, so there is no twin and nothing else will notice a sweep that
stops running. It curls `/api/jobs/<name>` with
`Authorization: Bearer $CRON_SECRET`.

- The secret has two halves that must match: the GitHub **repository secret**
  `CRON_SECRET` (Settings → Secrets and variables → Actions) and the **Railway
  service variable** `CRON_SECRET`. Mismatch = every run fails loudly, which is
  the wanted posture.
- GitHub reports only *which* cron expression fired, so one workflow carries all
  the expressions and a `case` maps each back to its job path. **Editing a
  schedule without its case arm fails the run** rather than silently curling
  nothing; `tests/letterIntegrity.test.ts` and `tests/taskEngineSlaSeed.test.ts`
  pin both halves for letter-expiry and task-escalation.
- `workflow_dispatch` (choose the job) is the manual lever: it proves
  `CRON_SECRET` end-to-end without waiting for a schedule and re-fires a sweep
  missed during an outage. Scheduled workflows run against the default branch
  only.

## Private beta gate (invite-link access)

`server/middleware/betaGate.ts` is an **Express middleware**, mounted in
`server/app.ts` ahead of the whole route surface, that locks the whole site
(every route except `/api/*`) behind invite links while the `BETA_ACCESS_CODE`
variable is set. It is the Express port of the Edge Middleware this used to be —
the semantics are deliberately identical (same codes, same cookie digest), since
a gate that admits here but not there is an incident-containment control failing
open. Tests live in `tests/betaGate.test.ts`.

- **Turn on:** Railway → project *Homiquity* → service *Homiquity* →
  **Variables** → add `BETA_ACCESS_CODE` with one or more comma-separated codes,
  e.g. `hq-beta-7f3k2m`. The value is read **per request**, so it takes effect
  as soon as the service is running with the new variable — no rebuild and no
  code change. Generate codes with `openssl rand -hex 4`
  or pick memorable phrases; avoid guessable words.
- **Invite testers:** send `https://<host>/?beta=<code>`. Opening it sets a
  90-day HttpOnly cookie (the SHA-256 of the code, so the raw code never sits
  in the browser) and redirects to a clean URL. Visitors without a code get a
  401 lock screen with a code-entry form.
- **Revoke a group:** remove that group's code from the variable — its cookies
  stop validating as soon as the service is running with the new value.
- **Turn off (public launch):** delete `BETA_ACCESS_CODE`. Unset or blank is a
  total no-op; nothing else to remove.
- **SEO while gated:** `/robots.txt` answers `Disallow: /` and every gate
  response carries `X-Robots-Tag: noindex`, so the beta never gets indexed.
  When the gate is off, the static `client/public/robots.txt` (allow-all)
  serves instead.
- **Why `/api/*` is exempt:** the GitHub Actions cron invocations and inbound
  webhooks carry no browser cookie (they authenticate via `CRON_SECRET` /
  webhook secrets), and API routes already sit behind app auth. The gate is a
  privacy screen for the beta, not a security boundary — real access control
  stays in the app.
- Because it is ordinary Express middleware in `server/app.ts`, it now runs
  **everywhere the app runs** — `pnpm dev` and a local prod build included, if
  `BETA_ACCESS_CODE` is set in that environment. That is a feature: the gate is
  testable locally instead of only in production.

## Checks — what the gate enforces, and what stays manual

The required `gate` check runs these on every PR (same commands locally):

```bash
pnpm check                             # typecheck
pnpm test                              # BOTH unit lanes, behind the collected-count floor
                                       #   (scripts/test-collection-guard.cjs): node suite
                                       #   (vitest.config.ts include list) + client component
                                       #   suite (vitest.client.config.ts, happy-dom, glob:
                                       #   client/src/**/*.test.{ts,tsx}), then a check that
                                       #   vitest actually RAN every file on disk
pnpm test:raw                          # the same two lanes, unguarded — debugging only
pnpm audit --prod --audit-level=high   # blocking prod-dependency scan (high+)
pnpm guard:schema                      # schema ↔ migration drift guard
pnpm guard:tokens                      # design-token ratchet (raw palette / bare white-black
                                       #   counts vs scripts/design-token-baseline.json;
                                       #   gated 2026-07-19 — counts may only go down)
```

(Plus the repo's other `guard:*` steps, and — since the Railway cutover — a
**production build** followed by a **boot** of `dist/index.js` against a
disposable Postgres, requiring a 200 from `/api/health`. That last step exists
because the artifact Railway runs is a long-lived process: a bundle that builds
but dies at import would otherwise only be discovered by a failed deploy, and a
failed deploy is invisible from the outside. Read
[`ci.yml`](../../.github/workflows/ci.yml) for the authoritative step list.)

The token ratchet's residual is the `strict: false` racing-merge window
(TEAM_PRACTICES §5 traps): two individually-green PRs can still combine into a
red `main`, which the **next** PR's gate surfaces — fix forward in that PR by
retokening or ratcheting the baseline (the #112 class, now caught in CI instead
of lingering).

Still **manual — CI never runs these**:

```bash
TEST_BASE_URL=http://127.0.0.1:5001 pnpm test:integration   # needs a running dev server
pnpm checkup                          # daily umbrella: the gate's checks + build, orphan scan,
                                      # token/kb guards, prod health — deliberately no integration
```

The integration suite (`vitest.integration.config.ts`) **never runs in CI**: a
green gate proves the change typechecks, breaks no unit or component test, and
produces a bundle that boots and answers `/api/health` — nothing more. (The
gate's disposable Postgres exists for that boot probe only; it is not an
integration environment, and no integration test is pointed at it.) If a
change is only exercised by an integration test, run it by hand against a live
worktree server and record that in the PR
([TEAM_PRACTICES](../governance/TEAM_PRACTICES.md) §5).

### A test that does not run still reports success

Two ways a file goes unrun while the gate stays green. Both are now gated by
`pnpm test` via [`scripts/test-collection-guard.cjs`](../../scripts/test-collection-guard.cjs);
neither was before 2026-08-22.

**Permanently** — a **server/logic** test file listed in neither the unit nor the
integration config's include list is never run at all. `tests/maintenanceMode.test.ts`
sat that way from the commit that introduced it until 2026-08-22: the INTAKE_PAUSED
kill switch, the control that stops all new business, with five assertions that had
never once executed. The guard's orphan floor is **zero** and needs no baseline.

**Intermittently** — and this is the one that reads as impossible. It was written
here that client component tests "are glob-included and cannot be stranded". They
can. Vitest discovers files through `tinyglobby` → `fdir`, which defaults to
`suppressErrors: true` and hands the caller `entries = []` for a directory whose
`readdir` FAILED — so an unreadable directory is indistinguishable from an empty
one. Three times on 2026-08-20/21, under load (load average 25–50, ~46 MB free,
dozens of concurrent `vitest` processes against a `kern.maxfiles` of 30720),
`pnpm test` collected **111 of 118**, then **214 of 215**, then **113 of 119**
files — and exited **0** each time. Injecting one `EMFILE` into a single `readdir`
under `client/src` reproduces it exactly: 118 files become 82, the glob resolves
normally, and nothing is logged. A glob protects against a file being *forgotten*,
not against the crawl being *truncated*.

So the floor compares what vitest reports collecting against what is on disk, and
fails on any shortfall. Its own enumeration uses plain `fs.readdirSync` with **no
error suppression**, on purpose: a guard that counted with the same fragile glob
would shrink alongside the bug and pass.

## Production change ledger

Moved to **[CHANGE_LEDGER.md](./CHANGE_LEDGER.md)** on 2026-08-06 — it was ~60% of
this file. Every push to `main` (it deploys) and every action against the production
database or its env vars still gets a row there **in the same session**, newest first
([TEAM_PRACTICES](../governance/TEAM_PRACTICES.md) §6). Never rewrite or delete rows;
corrections get a new row.
