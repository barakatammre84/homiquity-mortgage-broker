# 06 — Auth, Security & Secrets

## Authentication

Two login paths, all managed by Passport + express-session
([`server/auth.ts`](../../../server/auth.ts), `server/socialAuth.ts`,
`server/integrations/auth/`):

1. **Email/password** — `POST /api/auth/register` / `POST /api/auth/login`;
   scrypt hashing (`comparePasswords`/`hashPassword`).
2. **Social OAuth** — Google, LinkedIn, Apple (`server/socialAuth.ts`).

Session + Passport middleware is installed **unconditionally** in
`setupSessionAuth()` (`server/integrations/auth/session.ts`) — this is what
makes `req.isAuthenticated` / `req.login` / `req.user` exist on every host.
Sessions are stored **in Postgres** (`sessions` table, `connect-pg-simple`) and
identified by the `connect.sid` cookie (12h rolling idle timeout; `secure` in
production only, so local http logins work). No in-memory session state — which
is why a deploy, restart, or rollback never logs everyone out, and why adding a
second replica would not break auth.

> History note: Replit OIDC login was removed 2026-07-02 along with all other
> Replit coupling. Before that, session/Passport only initialized on Replit,
> which broke auth everywhere else (`req.isAuthenticated is not a function`).

### Dev logins
`POST /api/test-login` (dev only; guarded by `NODE_ENV` and requires
`DEV_TEST_PASSWORD`) logs you in as seeded role accounts —
see [TEST_ACCOUNTS.md](../../runbooks/TEST_ACCOUNTS.md).

## Authorization (RBAC)

`users.role` is defined in [`shared/roles.ts`](../../../shared/roles.ts) — the single source of
truth, importable by the client without dragging in the ORM:

- **Internal staff** (`INTERNAL_STAFF_ROLES`): `admin`, `lo`, `loa`, `processor`, `underwriter`,
  `closer` — platform-wide staff.
- **External partners**: `broker` and `lender` (staff-typed but deal-team-scoped), plus the
  `PARTNER_ROLES` pair `cpa` and `realtor` (added by PartnerHub PH-1, #121) — self-registering,
  inviter-only, deliberately **not** in `STAFF_ROLES`, so they can't reach any
  `isStaffRole()`-gated surface; access only via exact-role checks.
- **Clients** (`CLIENT_ROLES`): `aspiring_owner` (sandbox) and `active_buyer` (applying).

Middleware in `server/auth.ts`: `isAuthenticated`, `isAdmin`, `requireRole(...roles)`; the role
is re-read from the DB on every authenticated request, so demotions apply immediately.
**The authorization distinction that matters:** `isStaffRole()` *includes* the external partners
`broker`/`lender`, so for object-level access to borrower data use **`isInternalStaffRole()`** —
`broker`/`lender` must be explicit deal-team members, and `cpa` reaches only its own
exact-role-gated surfaces. Per-resource ownership checks (does this application belong to
`req.user.id`?) are done inline in handlers — always add them for borrower data.

## Platform security controls (`server/app.ts`)

| Control | Detail |
|---------|--------|
| Helmet + CSP | Security headers. Production ships a Content-Security-Policy (PCI DSS 6.4.3 script control): **Report-Only by default**, flip to enforcing with `CSP_ENFORCE=true`. Violations POST to `/api/csp-report` (logged). Authorized third-party script origins (maps.googleapis.com, cdn.plaid.com, fonts) are the CSP's script inventory — see the comment in `server/app.ts`. Dev is exempt (Vite HMR needs inline scripts). |
| Rate limiting | 500/15min general on `/api`; 20/15min auth; 50/15min uploads; 15/15min AI extraction; per-minute tracking |
| CSRF | Origin/Referer allow-list on state-changing `/api` requests (OAuth callbacks exempt — protected by OAuth `state`) |
| Log hygiene | Response-body logging is **allowlist-only** (`RESPONSE_BODY_LOG_ALLOWLIST` in `server/app.ts`): only explicitly PII-free paths log bodies; everything else logs status/duration. Invite tokens redacted from logged paths. |
| Central error handler | No stack traces leak to clients |

## Data protection

- **Field encryption**: credit-related PII is encrypted at rest with
  AES-256-GCM (`server/services/encryptionService.ts`). Ciphertext is tagged with
  a `keyId` that resolves to a key in an in-memory registry, so multiple key
  versions coexist — new writes use the *active* key, historical rows keep
  decrypting under whatever key wrote them. This is the **rotation path**.
  - *App-level keys* (`v1`, `v2`, …) come from `CREDIT_ENCRYPTION_KEY` /
    `CREDIT_ENCRYPTION_KEY_V2` …; `v1` is the original single key (every legacy
    row is tagged `v1`). Rotate by adding `CREDIT_ENCRYPTION_KEY_V2` and setting
    `ENCRYPTION_ACTIVE_KEY_ID=v2`.
  - *Cloud KMS envelope encryption* (`kms-1`, …) is the production-grade option:
    Data Encryption Keys are stored **wrapped** by a Cloud KMS key (the KEK,
    which never leaves KMS / HSM) and unwrapped once at boot (`initEncryption`,
    awaited in `registerRoutes`). Field ops stay synchronous because the unwrap
    is a one-time startup cost. Enable with `PII_KMS_KEY_NAME` +
    `PII_KMS_WRAPPED_DEKS`; boot **fails closed** if KMS is configured but
    unreachable or the `@google-cloud/kms` dep is missing.
  - **Rotation runbook**: `PII_KMS_KEY_NAME=… npx tsx scripts/kms-wrap-dek.ts kms-2`
    prints a new wrapped DEK → append it (last) to the `PII_KMS_WRAPPED_DEKS`
    JSON array → redeploy. New writes use `kms-2`; old rows still decrypt under
    `kms-1`, which stays in the array. Tests: `tests/encryptionRotation.test.ts`
    (the live KMS unwrap needs a real keyring and is verified in a KMS-enabled
    environment, not in CI).
- **PII vault (direct identifiers)**: SSNs and bank account numbers are stored
  **only** as AES-256-GCM ciphertext + a last-4 fragment
  (`server/services/piiVault.ts`). They are **write-only** through the API:
  clients submit plaintext (`ssn` / `accountNumber` virtual fields), the storage
  layer encrypts them, and responses expose only `ssnLast4` /
  `accountNumberLast4` (`stripEncryptedFields` scrubs ciphertext/IV/key columns
  before serialization). Full-value decryption happens in exactly one place —
  `storage.getMISMOLoanData()` for GSE loan delivery. Plaid access tokens use the
  same vault via an `encryptToken`/`decryptToken` envelope
  (`encv1:keyId:iv:ciphertext`) in the existing text column. Backfill/rotate
  legacy rows with `scripts/migrate-encrypt-pii.ts` (idempotent, guarded DDL —
  do **not** use `drizzle-kit push --force` — it would drop the `sessions` table and log out every user; see [DB_MIGRATIONS.md](../../runbooks/DB_MIGRATIONS.md)).
- **Input whitelisting**: URLA write endpoints route every body through
  `pickTableFields` (`server/routes/urlaValidation.ts`) — unknown keys, server-
  managed keys, and encrypted-column names are dropped (mass-assignment defense);
  SSN/DOB/email get format validation.
- **Hashing**: PII lookups/anonymization use `PII_HASH_SALT`.
- **Tamper-evidence**: the credit audit log is hash-chained
  (`computeAuditEntryHash`, `verifyHashChain`).
- **Boot guard**: `assertEncryptionConfig()` stops the server from starting
  without the two keys above — you cannot accidentally run unencrypted.
- **FCRA flow**: consent capture (versioned disclosure text) → credit pull
  (soft/hard recorded) → adverse action records — all in
  the `server/services/credit*.ts` family (`creditService.ts` is the re-export
  shim; the hash-chain writer is `creditAuditChain.ts`) + `shared/schema/compliance.ts`.

Deeper reading: [threat_model.md](../../compliance/security/threat_model.md).

## Pre-flight checklist — PII or auth changes

Before merging anything in this chapter's territory:

1. New/changed PII fields go through `encryptionService.ts` (direct identifiers
   through the PII vault) — never a plaintext column; responses expose only
   last-4 fragments.
2. The action emits an audit-log entry (`server/auditLog.ts`; credit-chain
   events use the hash-chained credit audit log).
3. Logging stays PII-free — response-body logging is allowlist-only; do not
   widen `RESPONSE_BODY_LOG_ALLOWLIST` near PII routes.
4. Write endpoints handling borrower data route bodies through `pickTableFields`
   (mass-assignment defense) and carry per-resource ownership checks.
5. This is a **security-review trigger**: run `/security-review` before merge
   ([TEAM_PRACTICES](../../governance/TEAM_PRACTICES.md) §9); unresolved CRITICAL findings
   block.

## Secrets inventory (complete)

Everything the code reads from `process.env`, grouped. **Required** means the
app won't boot or a core feature dies without it.

### Required
| Variable | Used for |
|----------|----------|
| `DATABASE_URL` | Postgres. localhost → `pg` driver; anything else → Neon serverless driver |
| `SESSION_SECRET` | Session cookie signing |
| `CREDIT_ENCRYPTION_KEY` | Field encryption (boot-guarded) |
| `PII_HASH_SALT` | PII hashing (boot-guarded) |

### Feature-gated (optional; feature off/degraded without it)
| Variable | Feature |
|----------|---------|
| `ANTHROPIC_API_KEY` | Document AI extraction (Claude) + AI Coach (Claude Sonnet 5; coach degrades to labeled offline-guidance mode without it) |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | Optional — read first by document extraction; falls back to `ANTHROPIC_API_KEY` |
| `EXTRACTION_SIMULATE` | Set `true` to run deterministic simulated extraction with no Anthropic key (dev/test) |
| `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` | Income/employment/asset verification |
| `GCS_SERVICE_ACCOUNT_KEY`, `PRIVATE_OBJECT_DIR`, `PUBLIC_OBJECT_SEARCH_PATHS` | Document storage (GCS) |
| `GOOGLE_MAPS_SERVER_API_KEY` | Server-side Places, Geocoding, and Address Validation calls; IP/API restricted |
| `GOOGLE_MAPS_BROWSER_API_KEY` | Browser Maps JavaScript and Street View; HTTP-referrer/API restricted |
| `GOOGLE_MAPS_API_KEY` | Local-development compatibility only; ignored in production |
| `RAPIDAPI_KEY` | Property listings + live rate lookups |
| `SMTP_HOST/PORT/USER/PASS`, `SENDGRID_API_KEY`, `FROM_EMAIL`, `FROM_NAME` | Outbound email (console-logged if unset) |
| `APPLE_CLIENT_ID/KEY_ID/TEAM_ID/PRIVATE_KEY` | Apple Sign-In |
| `PUBLIC_BASE_URL` | Absolute URLs in invites/emails (falls back to request host) |

### Dev / platform
| Variable | Purpose |
|----------|---------|
| `NODE_ENV`, `PORT` | Runtime mode; local dev uses PORT=5001 |
| `DEV_TEST_PASSWORD` | Enables `/api/test-login` (never set in prod) |
| `USE_LOCAL_PG` | Force the `pg` driver |
| `LOOKUP_MATRIX_STAMP_WINDOW_MS` | Lookup-matrix tuning |
| `CSP_ENFORCE` | `true` switches the production CSP from Report-Only to blocking. Leave unset for a Report-Only soak first. |
| `CREDIT_VENDOR_MODE` | Bureau vendors are simulated until contracts land. Production **refuses** to fabricate credit scores unless this is `simulation` (staging only). |
| `CREDIT_ENCRYPTION_KEY_V2…V9`, `ENCRYPTION_ACTIVE_KEY_ID` | App-level PII key rotation (add a new key, then pin it active). |
| `PII_KMS_KEY_NAME`, `PII_KMS_WRAPPED_DEKS` | Cloud KMS envelope encryption — the KEK resource name and the wrapped Data Encryption Keys (JSON). Needs `npm i @google-cloud/kms` (optional dep, not in package.json) + GCP creds. |
| `CRON_SECRET` | Shared bearer secret for `/api/jobs/*` (`server/routes/jobs.ts`). **It must be identical in two places** — the Railway service variable *and* the GitHub **repository secret** used by `.github/workflows/cron-jobs.yml`, which is the only scheduler. Unset ⇒ the job routes degrade to admin-session-only and every scheduled run fails loudly (the wanted posture). |
| `BETA_ACCESS_CODE` | Arms the private-beta gate (`server/middleware/betaGate.ts`, an Express middleware — it replaced a platform edge middleware). Comma-separated list; blank/unset is a total no-op. Read **per request**, so arming/disarming is a runtime change, not a rebuild. |
| `VITE_PRELAUNCH_GATED` | ⚠️ **Build-time.** Vite bakes `VITE_*` values into the client bundle, so this must be set *before* the build and changing it needs a **redeploy**, not a restart. |
| `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_REPLICA_REGION` | Injected by Railway (not set by us). The first is what `/api/health` reports as `commit` and what Sentry uses as the release; the second tags the Sentry `server_name`. |

### Where secrets live
- **Local**: `.env` (gitignored; template in `.env.example`). **No production
  credential lives locally** — prod migrations auto-apply in CI from
  `NEON_API_KEY`, and prod data checks run through CI
  ([DB_MIGRATIONS.md](../../runbooks/DB_MIGRATIONS.md)); the old
  `PROD_DATABASE_URL` stash is retired.
- **Production**: **Railway service variables** — Railway → project `Homiquity`
  → service `Homiquity` → **Variables**. There is no separate per-environment
  matrix to reason about the way the old host had: this service *is* production.
  Two consequences worth internalising:
  - Runtime variables take effect on restart; **`VITE_*` variables are baked into
    the client bundle at build time and need a redeploy.**
  - A Railway **Rollback** restores the previous image *together with the
    variables it was deployed with* — so rolling back can also silently roll back
    a secret you just rotated. Re-apply it after
    ([ROLLBACK.md](../../runbooks/ROLLBACK.md) §1).
- **Duplicated in GitHub, deliberately**: `CRON_SECRET` (repository secret, for
  the cron workflow) and `NEON_API_KEY` (write-only, for `migrate-prod`). Rotating
  `CRON_SECRET` in one place and not the other silently kills every scheduled
  sweep — change both in the same sitting.
- **Never in git.** `.gitignore` covers `.env*`; keep it that way. If a secret
  ever lands in a commit or a chat transcript, rotate it.
