# Running Homiquity locally (Antigravity / any terminal)

The whole app runs on your machine, database included — that is the default and
what day-to-day work should use (CLAUDE.md, *Local is the default verification
target*). A hosted Postgres is a supported fallback, not the recommendation.

## Quick start — one command *(added 2026-08-18)*

```bash
pnpm dev:up        # provisions a local Postgres, writes .env, migrates, seeds, serves :5001
```

Measured cold on a clean clone with no `.env` and no database: **15 seconds** to a healthy
server. It is idempotent — run it as often as you like — and it **never overwrites a value
already in your `.env`**, it only fills in what is missing and prints which keys it added.

```bash
pnpm dev:up down   # stop the server (the database stays up)
pnpm dev:up logs   # tail it
pnpm dev:up status # is it up?
pnpm db:local reset  # rebuild the database from migrations + seed
```

Sign in with any seeded account — `buyer@test.com`, `lo@test.com`, `admin@test.com`,
`underwriter@test.com`, `broker@test.com`, `lender@test.com`, `closer@test.com`,
`cpa@test.com` — password `test1234` (`DEV_TEST_PASSWORD`).

**Why this exists.** `pnpm dev` on a clean checkout dies with `DATABASE_URL must be set` before
it prints anything useful, and the documented fix below is a five-step manual setup. Every step
is easy; the *sequence* is what goes wrong, which is why the server felt like it "had trouble
spinning up" when it actually had trouble being set up, once, correctly. The manual path below
still works and still explains what each piece is for — read it when something breaks.

**No Docker required.** `pnpm db:local` uses whatever is available, in this order: an existing
`DATABASE_URL` → Docker → a plain `pg_ctl` cluster under `$HOME`. Never point it at the shared
dev database: it seeds, and `seedLendingGrids` **wipes and rebuilds the pricing matrices**.

## Before you push — the whole gate, locally

```bash
pnpm preflight            # all 16 checks CI's `gate` job runs — ~2m45s measured
pnpm preflight --fast     # skip build + boot + integration lane (~2 min)
```

`.githooks/pre-push` (install once: `git config core.hooksPath .githooks`) runs the cheap half
automatically on every push — typecheck and the nine guards, ~30 s. The two unit-test lanes run
in CI on every PR and are **opt-in** locally (`PREPUSH_TESTS=1 git push`). **`preflight` adds the
three that only ever ran in CI**, and they are the ones that catch a broken *deploy* rather than
a broken diff: the production build, the self-host boot of `dist/index.js`, and the 18-file
integration lane against a real HTTP server.

A stage that cannot run is reported `SKIPPED` with the reason — it never silently passes. And
green preflight is **not** a promise CI is green: it prints what it did not cover, every run.

## Seeing it — a real browser, no dependency added

```bash
node scripts/browser-probe.cjs --url http://localhost:5001/ --width 320 --out /tmp/shot.png
```

Renders in real Chromium and answers what a text scan cannot: horizontal overflow at a given
width, images that failed to load, sub-44px touch targets, controls with no accessible name.
Details and limits: [BROWSER_PROBE.md](./BROWSER_PROBE.md).

---

## The manual path, and what each piece is for

Only Postgres is a managed service if you choose Neon — the free tier costs nothing, so that is
also a $0 setup.

## 1. Prerequisites
- Node.js 24 (`node -v`) — matches the pinned `engines.node` in `package.json` (what Railway builds with)
  - ⚠️ **Keep `engines.node` an exact major (`"24"`), never an npm range like `"24.x"`.** Railway's
    builder (Railpack) resolves the toolchain with mise, which does **not** understand npm range
    syntax; on 2026-08-06 `"24.x"` made nine consecutive Railway builds fail — and because a failed
    Railway deploy leaves the *previous* container serving, the site stayed up and nothing noticed
    for ~8 commits.
- A Postgres database (see step 3)
- `git` and this repo cloned locally

## 2. Install dependencies

pnpm is the package manager (pinned via `packageManager` in `package.json`; it's the only lockfile — `pnpm-lock.yaml` — and what Railway builds with). Activate it once with corepack, which ships with Node:
```bash
corepack enable      # one-time; activates the pinned pnpm
pnpm install
```

## 3. Database — pick one

### Option A (recommended): local Postgres — fully offline, supported out of the box
`server/db.ts` auto-detects a local database: a `localhost` / `127.0.0.1`
connection string (or `USE_LOCAL_PG=true`) uses the standard `pg` driver; any
other URL uses Neon. No code change needed.
1. Install Postgres — **Postgres.app** on Mac (what this project's machine runs;
   Docker is not installed there), or Docker if you prefer. With Docker, **use the
   script, not a raw `docker run`:**
   ```bash
   pnpm db:start
   ```
   It is `docker start homiquity-db 2>/dev/null || docker run -d --name homiquity-db …postgres:16`
   — the `docker start` fast path is what makes it safe to run again. A bare `docker run` a second
   time fails with a name conflict on `homiquity-db`, which reads like a broken setup and isn't.
2. In `.env`:
   ```
   DATABASE_URL=postgresql://postgres:pass@localhost:5432/homiquity
   ```
3. `pnpm db:migrate` then `pnpm dev`. That's it — fully offline, $0.

Prefer this one. A local database is the only setup where you can migrate, seed,
and destroy freely without touching data another branch or session depends on.

### Option B (fallback, zero code changes): free Neon database
1. Sign up at https://neon.tech (free tier, no card).
2. Create a project → copy the connection string.
3. Put it in `.env` as `DATABASE_URL` (step 4).

The app already uses Neon's driver, so this Just Works. The app still runs on
your machine — only the database is hosted. ⚠️ **A hosted dev branch is shared**:
`pnpm db:push` against it drops columns owned by other branches (which is why
that script is blocked — see CLAUDE.md, *Database*), and a destructive local
experiment is no longer local.

## 4. Create your `.env`
```bash
cp .env.example .env
```
Fill it in. Generate the three secrets:
```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)"          # see the warning below — do not skip this one
echo "CREDIT_ENCRYPTION_KEY=$(openssl rand -base64 32)"
echo "PII_HASH_SALT=$(openssl rand -hex 32)"
```
Paste those lines into `.env`, add your `DATABASE_URL`, and (optionally) a
`ANTHROPIC_API_KEY` for AI features (or `EXTRACTION_SIMULATE=true`) and a `DEV_TEST_PASSWORD` for the dev login.

> ⚠️ **Only one of those three is actually required locally, and it is the one that fails silently.**
>
> - **`SESSION_SECRET` — mandatory.** Its boot-time guard is production-only
>   ([`server/integrations/auth/session.ts`](../../server/integrations/auth/session.ts)), and the
>   value is then passed to express-session regardless. Measured on a real boot with it blank:
>   the server **starts with no error and logs `serving on port 5001`**, `GET /health` still returns
>   `{"status":"ok"}` because it is mounted above the session middleware — and **everything else,
>   the homepage included, returns 500 `secret option required for sessions`.** express-session only
>   checks per request, so there is no boot-time signal at all; the first symptom is a dead site with
>   a healthy-looking process. If you see that error, this is why.
> - **`CREDIT_ENCRYPTION_KEY` and `PII_HASH_SALT` — optional in dev.** Both fall back silently
>   outside production ([`encryptionService.ts:52`](../../server/services/encryptionService.ts) and
>   `:536`); `assertEncryptionConfig()` returns early when `NODE_ENV !== "production"`. Set them
>   anyway — they cost one command — but their absence will not break your local run.
>
> Set all three regardless: `pnpm build && pnpm start` runs in production mode, where **all three do
> throw at boot** (`SESSION_SECRET` needs ≥32 chars). That is the cheapest way to catch a prod
> config gap before a deploy rather than after one — see §8 for the one extra step it needs.

**Leave `CREDIT_VENDOR_API_KEY` unset.** It is a *provenance stamp*, not a connection setting —
setting it flips `isSimulated` to false on regulated credit records. `.env.example` says so at
length; believe it.

## 5. Create the tables
```bash
pnpm db:migrate
```
Fresh databases are built from the committed migration files in `migrations/`.
If your database was created earlier with `db:push`, adopt it once with
`pnpm db:migrate:adopt -- --apply` (records existing migrations as applied
without re-running them). Schema-change workflow: [ROLLBACK.md](./ROLLBACK.md) §3.

**This step is not optional if you want to log in.** The session store runs with
`createTableIfMissing: false`, and the `sessions` table comes from `migrations/0000_baseline.sql` —
so an unmigrated database gives you a running server that cannot hold a login.

You do **not** need `pnpm db:seed`. The server seeds itself idempotently on every boot
(`server/routes.ts`), so the seed is a warm-up, not a prerequisite. It does now read your `.env` if
you want to run it by hand.

## 6. Run it
```bash
pnpm dev
```
Open http://localhost:5001. Edits hot-reload.

**On the port:** nothing in the code defaults to 5001 — [`server/app.ts`](../../server/app.ts) falls
back to `5000`. You land on 5001 because `.env.example` ships `PORT=5001` and you copied it in step 4.
If you land on 5000, your `.env` is missing that line; either add it or run `PORT=5001 pnpm dev`.
The convention exists because macOS AirPlay squats on 5000 and answers with an HTTP 403 that looks
like a broken app. Worktree test servers use 5002+.

**Prove the wiring before you go hunting bugs:**
```bash
curl -s localhost:5001/api/health
```
`{"status":"ok",…}` means the app reached Postgres. A **503** means it didn't — that endpoint runs a
real `SELECT 1`. (`GET /health`, without the `/api`, is pure liveness and answers even when the
database is down, so it is not evidence of anything except that the process is up. `commit` is
`null` locally; Railway injects it in production.)

**If it looks like it hangs:** a throw inside `createApp()` is only *logged* by the
`unhandledRejection` handler — `server.listen()` is never reached and the process stays alive with
nothing bound to the port. It is a config error two screens up in the log, not a hang.

**One alarming-looking log line on a fresh database is expected.** During the boot seed you will see
a stack trace containing `CRITICAL COMPLIANCE ERROR: Required matrix configuration [FANNIE_LLPA] is
missing, expired, or not active`, from `syncBestExecutionRates`. It is non-fatal — the seed
continues, prints `Database seeded successfully`, and the server binds. A fresh local database has
no LLPA matrix rows, so best-execution pricing has nothing to price against. Nothing else depends on
it for a click-through.

## 6a. Beta-test it — logging in and clicking through

Set `DEV_TEST_PASSWORD=<anything>` in `.env`, then open **http://localhost:5001/test-login**, type
that password once, and click a role card. There are **eleven seeded accounts**, all `@test.com`,
sharing that one password ([`server/auth.ts`](../../server/auth.ts)):

| Staff | Partner | Borrower |
|---|---|---|
| `admin@` · `lo@` · `loa@` · `processor@` · `underwriter@` · `closer@` | `broker@` · `lender@` · `cpa@` | `renter@` (aspiring owner) · `buyer@` (active buyer) |

Login **upserts** the user, so these self-heal after a database reset — you never have to re-seed to
get back in. `DEV_TEST_PASSWORD` unset gives a **503**, not a 401; a wrong password gives the 401.
The route is registered only outside production (it returns a flat 404 in prod), and it is
rate-limited to 20 attempts per 15 minutes. Fuller notes: [TEST_ACCOUNTS.md](./TEST_ACCOUNTS.md).

**What genuinely does not work locally** — these are environment gaps, not bugs, and each will look
like a broken feature if you don't know:

| Surface | Behaviour without credentials | Workaround |
|---|---|---|
| Document upload / download | fails — object storage needs real `GCS_SERVICE_ACCOUNT_KEY` + `PRIVATE_OBJECT_DIR` | none; there is no simulation path |
| Plaid (asset/income linking) | throws `Plaid is not configured` ([`server/plaid.ts`](../../server/plaid.ts)) | none; contained to Plaid routes |
| Document extraction / AI Coach | coach degrades to labelled offline guidance | `EXTRACTION_SIMULATE=true` for a deterministic extraction path |
| Outbound email | printed to the console, and `sendEmail()` still reports success | none needed — this is the desired local behaviour |
| Maps | degrade without `GOOGLE_MAPS_SERVER_API_KEY` + `GOOGLE_MAPS_BROWSER_API_KEY`; legacy `GOOGLE_MAPS_API_KEY` works locally only | optional |

Credit, AVM and GSE vendors are deterministic simulations by design, so those paths work fully
offline — that is the architecture, not a local limitation.

## 7. Typecheck and tests before committing
```bash
pnpm check     # TypeScript
pnpm test          # unit suite (no DB or server needed)
```
Integration tests need a running server. Boot it with `RATE_LIMIT_RELAXED=true` — the
suite exceeds both the auth rate limiter (20 per 15 min) and the general API limiter
(500 per 15 min) in one pass. The flag is ignored in production builds; endpoint-specific
upload, extraction, vendor and other cost controls remain active:
```bash
RATE_LIMIT_RELAXED=true PORT=5002 pnpm dev   # in one terminal
set -a; source .env; set +a
TEST_BASE_URL=http://localhost:5002 pnpm test:integration
```

### Checking the AI assistant's tool use — the one thing `pnpm test` cannot

`pnpm test` proves the assistant's server-truth tools *return* the right data. It
cannot prove the model *calls* them, because without `ANTHROPIC_API_KEY` the coach
runs in offline mode: a canned reply, no model call, no tool invocation. That gap
matters more than it sounds. A tool the model never calls is, from the borrower's
seat, identical to a tool that does not exist — and the failure is silent and
confident, because the assistant just answers from memory the way it always did.

```bash
pnpm coach:tools
```

Runs the exact production prompt and tool set against fixture turns and scores four
properties: **trigger** (a file question calls the tool), **restraint** (a general
question does not — a wasted tool call burns the turn's single round-trip),
**grounding** (the reply repeats the tool's figures and invents no others), and
**honest gap** (when the tool reports the file is unreadable, the reply says so
instead of answering anyway).

Needs a live `ANTHROPIC_API_KEY` in `.env`. It is a developer check, **not a CI
gate** — model behaviour is not deterministic, so a red result is a prompt bug to
investigate, never a build to block. Add `--verbose` to read the replies, or
`--model=claude-haiku-4-5` to compare tiers (Haiku 4.5 rejects `output_config.effort`,
which the script handles).

### Run the gate locally — one-time setup, and what the hook is for

```bash
git config core.hooksPath .githooks
```

That arms `.githooks/pre-push`, which runs the cheap half of CI's `gate` job —
typecheck, then nine guards (schema↔migration, migration ledger, delivery-stack
freeze, design tokens, UI standard, KB index, doc staleness, query-key
convergence) — in about 30 s, and **refuses the push** if any of them fails. Skip
it once with `git push --no-verify`. The two unit-test lanes are **opt-in** here
and mandatory in CI:

```bash
PREPUSH_TESTS=1 git push       # also run both vitest lanes before pushing
```

For the whole gate including the build, the boot and the integration lane, run
`pnpm preflight` (top of this file).

The hook is an early warning, not the control — CI's `gate` job runs every check
on every PR. It ran the full unit suite too until 2026-08-22, and the reason was
money: the repo was private and Actions minutes were metered (roadmap KTLO-2;
measured 2026-08-17, ~13.6 runs/day × 4–5 min ≈ 1,850 of a 2,000-minute
allowance). The repo is public now and minutes are free, which left only what the
suite cost locally: vitest spawns one worker per core (8 on the development
laptop) and the two lanes take ~1–2 GB and every core for minutes, on every push,
docs-only PRs included — on an 8 GB machine with several sessions pushing at
once, that is what made it swap. Ordered fail-fastest-first: `tsc` is ~25 s and
catches the common break.

A checkout with no `node_modules` (every fresh worktree) gets a loud warning and
the push proceeds — CI still gates the PR. Between 2026-08-19 and 2026-08-22,
while Actions was billing-blocked and nothing stood behind this hook, it blocked
those pushes instead; that special case ended with the public flip.

The hooks live in a **tracked** `.githooks/` rather than `.git/hooks` so they
survive a reclone, apply in every worktree, and are visible to review.

`pnpm preflight` is the pre-PR sweep — it mirrors CI's `gate` exactly, adding the
production build, the bundle ratchet, the self-host boot and the integration lane.
`pnpm checkup` is the wider health sweep on top of that: the regulatory/freshness
guards and a **production** health probe, which is the one thing preflight
deliberately never touches. The hook skips all of it to stay cheap enough to leave on.

## Landing work on GitHub

`main` — direct pushes are barred by doctrine. 🚨 **verified 2026-08-22: protection exists but blocks almost nothing** — `allow_force_pushes:false` and `enforce_admins:true`, but **0 required status checks, no required review, no push restriction**. A direct push to `main` is therefore *not* blocked; only doctrine stops it, and a red `gate` cannot hold a merge. Re-arming the required check is a founder action.
The flow below is unchanged; the old `pnpm save`/`pnpm sync` one-command scripts were **removed**
(PR #251). Everything lands as a short-lived branch → PR → `gate` check green →
squash merge ([CICD.md](./CICD.md) §Shipping; verify protection is live before
trusting `--auto` — [TEAM_PRACTICES](../governance/TEAM_PRACTICES.md) §6):

```bash
git checkout -b <topic-branch>
git push -u origin <topic-branch>
gh pr create --fill          # the gate runs automatically
gh pr merge --auto --squash --delete-branch   # merges itself when green
```

Local Postgres: `pnpm db:start` starts (or first-time creates) the container.

## Reverting to a previous version

List history (every checkpoint is a commit):
```bash
git log --oneline -20
```

**Undo one bad commit (safest — keeps history):**
```bash
git revert <commit-sha>     # creates a new commit that undoes that one
# …then land it via the PR lane above (see also ROLLBACK.md §2 for prod)
```

**Restore a single file from an older commit:**
```bash
git checkout <commit-sha> -- path/to/file.tsx
git commit -m "restore file to <commit-sha>"   # …then the PR lane
```

**Roll the whole project back to an older state (history-preserving):**
```bash
git revert --no-commit <bad-sha-1> <bad-sha-2> ...   # or a range: <old-sha>..HEAD
git commit -m "revert to known-good state"           # …then the PR lane
```

**Just look around an old version (no changes):**
```bash
git checkout <commit-sha>    # detached HEAD, read-only exploration
git checkout main            # come back
```

Avoid `git reset --hard` + force-push — it rewrites shared history and will
conflict with any other clone. `git revert` gives the same outcome
with a safe, append-only history.

**Tag releases you may want to return to:**
```bash
git tag beta-1 && git push origin beta-1
# later: git revert --no-commit beta-1..HEAD && git commit -m "roll back to beta-1"
```

---

## How production runs it (and the alternatives)

The primary deploy is **Railway** — see [CICD.md](./CICD.md). Production is not a
different program: it is exactly the two commands below, run by Railway on a single
persistent Node process. One Express server serves both the API and the built client
(`express.static` + SPA catch-all) — there is no CDN, no serverless function, no edge
middleware.

**Build/run — locally and on any host:**
```bash
pnpm build          # vite build + esbuild server -> dist/index.js
pnpm start          # NODE_ENV=production node dist/index.js
```

⚠️ **`pnpm start` does not read `.env`.** Only the dev entrypoint loads it —
`server/index-dev.ts` opens with `import "./load-env"`, and `server/index-prod.ts` deliberately does
not, because Railway injects its variables from the service config. So running the production bundle
**on your own machine** dies immediately with
`Error: DATABASE_URL must be set. Did you forget to provision a database?` even when your `.env` is
perfect. Export it first, the same idiom the integration tests use:

```bash
pnpm build
set -a; . ./.env; set +a          # .env is not read by the prod entrypoint
PORT=5055 pnpm start              # a spare port, so it can run beside `pnpm dev`
curl -s localhost:5055/api/health
```

Worth doing before any deploy: production mode arms the throws dev skips (`SESSION_SECRET` ≥32
chars, `CREDIT_ENCRYPTION_KEY`, `PII_HASH_SALT`), and CSRF is enforced — `/api/test-login` answers
**403** there rather than the dev 200, which is the gate working, not a bug.
Railway runs precisely these, declared as config-as-code in
[`railway.json`](../../railway.json) (builder `RAILPACK`, build
`pnpm install --frozen-lockfile && pnpm build`, start `pnpm start`, health check
`/api/health`, restart policy `ON_FAILURE`).

Set the same env vars in the host's dashboard (`DATABASE_URL`, `CREDIT_ENCRYPTION_KEY`,
`PII_HASH_SALT`, `SESSION_SECRET`, `ANTHROPIC_API_KEY`, `PORT`). The host provides
`PORT`; the server already reads it. On Railway these live in **service variables**
(Railway → project `Homiquity` → service `Homiquity` → **Variables**). Note that
`VITE_*` variables are **build-time** — they are compiled into the client bundle, so
changing one requires a **redeploy**, not a restart.

Because the whole thing is "one Express process + Postgres", it stays portable. If
Railway ever has to be left behind, these are equivalent single-web-service hosts —
no code changes, just the same build/start pair and the same env vars:

| Option | Cost | Notes |
|--------|------|-------|
| **Neon (Postgres) + Fly.io** | ~free–$5/mo | Fly's small shared VM + Neon free tier. |
| **Neon + Render** | free tier (spins down) / $7/mo | Simplest dashboard; free tier sleeps when idle. |
| **Cheap VPS (Hetzner / DigitalOcean) + Neon** | $4–6/mo | Most control, cheapest at scale; you manage the box. |

**The app has no host-specific dependencies** — no Replit, and (since the 2026-08-06
migration) no Vercel. It runs on Railway today and can move without code changes.
