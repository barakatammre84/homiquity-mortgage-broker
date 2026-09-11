# 02 — Authentication and authorization

> **Freshness:** last verified 2026-08-23 · review every 30 days
> **Verified against** `origin/main` @ 6377727e · **Authoritative:** [app-guide 06 — Auth, Security & Secrets](../handbook/app-guide/06-auth-security-secrets.md) (it wins on conflict; the code wins over both).

## The mental model

The session says who you *claim* to be; the database says what you *are* — every authenticated
request re-reads the role from Postgres — and whether you may touch a specific loan is decided by
a storage predicate, not by which route you hit. The client's gates are a politeness.

## Explain it to a new hire

A visitor signs up at `POST /api/auth/register`, the password is hashed with scrypt into a
`hash.salt` string, and the new row gets the hard-coded default role `aspiring_owner` —
self-registration can never mint a staff role. Passport then serializes the *whole user object*
into a Postgres-backed session row whose `connect.sid` cookie is HttpOnly, SameSite=lax,
secure-in-production, and rolls a 12-hour idle window on every response. On the next API call the
`isAuthenticated` middleware checks the session **and then re-reads the user row from the
database**, overwriting the in-session role and logging out a deleted account — which is why a
demotion takes effect on the very next request rather than at session expiry. Route-level gates
(`requireRole`, `isAdmin`) run that re-read first and answer only "may this *role* touch this kind
of endpoint"; the question "may this *user* touch *this* application" is answered separately by
`getLoanApplicationWithAccess`, whose three branches are admin-sees-all, staff-and-partners-need-an-
active-deal-team-row, and borrower-owns-it-only. Everything in `client/src/lib/routeGates.ts` is
explicitly "a UX affordance, never the security boundary" — its job is to keep users off pages the
server would refuse anyway.

## Mechanism

```mermaid
sequenceDiagram
  autonumber
  actor U as Browser
  participant CSRF as CSRF origin check - app.ts:406
  participant R as POST /api/auth/register - auth.ts:71
  participant S as createUserWithPassword - integrations/auth/storage.ts:57
  participant P as passport serializeUser - session.ts:67
  participant DB as sessions table
  participant MW as isAuthenticated - auth.ts:417
  participant RR as requireRole - auth.ts:452
  participant OBJ as getLoanApplicationWithAccess - storage/applications.ts:43
  U->>CSRF: POST with Origin header
  CSRF->>R: origin hostname matches host
  R->>R: password >= 8 chars; scrypt 64 bytes + 16-byte salt
  R->>S: insert user, role defaults to aspiring_owner
  S-->>R: user row
  R->>P: req.login with the user object
  P->>DB: whole user object stored in the session row
  DB-->>U: Set-Cookie connect.sid HttpOnly SameSite=lax 12h rolling
  U->>MW: GET a protected route with the cookie
  MW->>DB: re-read the user row
  MW->>MW: logout + 401 if the row is gone; user.role = dbUser.role
  MW->>RR: next()
  RR->>RR: allowedRoles includes role, else 403
  RR->>OBJ: handler asks for the application
  OBJ->>OBJ: admin any / staff+broker+lender need an active deal-team row / else userId must match
  OBJ-->>U: application, or undefined which the handler turns into 403 or 404
```

## The facts, with receipts

- **Hashing is scrypt, 64-byte key, 16-byte random salt, stored as `hash.salt`.**
  `server/auth.ts:32-36` `hashPassword`; `grep -n "scryptAsync(password, salt, 64)" server/auth.ts` → `34`.
  `comparePasswords` (`:38-48`) is constant-time and **returns false on a malformed stored hash**
  rather than throwing a 500.
- **Seven email/password endpoints.** `grep -c 'app.post("/api/auth' server/auth.ts` → `7`:
  register `:71`, login `:144`, logout `:216`, forgot-password `:232`, reset-password `:264`,
  verify-email `:291`, resend-verification `:311`.
- **Lockout runs before the password compare and answers byte-identically to a wrong password.**
  `server/auth.ts:167-169` `isLockedOut`; policy in `server/services/loginLockout.ts:31-47`: 5
  consecutive failures → 15 min, doubling, capped at 24 h, with a 7-day failure window that *must*
  exceed the cap (`:38-41` — "Sitting out the maximum penalty must not be a way to buy back the
  ladder"). A successful social login clears the counter atomically inside the upsert
  (`server/integrations/auth/storage.ts:100`).
- **`/forgot-password` always returns the same generic success, even on an internal throw.**
  `server/auth.ts:248-258`; `grep -c "a reset link is on its way." server/auth.ts` → `2`. No
  enumeration oracle. `/resend-verification` *does* report a real 502 (`:328-333`) because the caller
  owns the address.
- **Tokens are single-use and consumed atomically.** `server/integrations/auth/storage.ts:146-160`
  `consumeAuthToken` is one `UPDATE … WHERE hash AND type AND usedAt IS NULL AND expiresAt > now()
  RETURNING`. Only the SHA-256 is stored; TTLs 30 min (reset) / 48 h (verify)
  (`server/services/accountRecovery.ts:9-14`).
- **The session store.** `server/integrations/auth/session.ts:29-34` connect-pg-simple on the
  `sessions` table (`createTableIfMissing: false` — migration-owned); `:40-49` `rolling: true`,
  `httpOnly: true`, `secure: NODE_ENV === "production"`, `sameSite: "lax"`, `maxAge` 12 h. Production
  refuses a `SESSION_SECRET` under 32 chars (`:20-26`).
- **Serializers are identity functions — hence the re-read.** `session.ts:65-68`: "The whole user
  object lives in the session row … role is re-verified from the DB in the isAuthenticated
  middleware." `server/auth.ts:430-435` `user.role = dbUser.role;` after `authStorage.getUser`.
- **`GET /api/auth/user` is the "me" endpoint** and strips `passwordHash`
  (`server/integrations/auth/routes.ts:14-18`). The client keys it as `["/api/auth/user"]`.
- **The three gates, and the counts.** `isAuthenticated` `server/auth.ts:417` — `grep -rn "isAuthenticated" server --include='*.ts' | wc -l` → `349`;
  `isAdmin` `:443`; `requireRole(...roles)` `:452` — 42 files, 242 call sites; `requireStaff` → `0`
  (there is none — handlers use the `shared/roles.ts` predicates:
  `grep -rnE "is(Staff|InternalStaff|Client|Partner)Role" server --include='*.ts' | wc -l` → 141).
- **Object-level access has two helpers with different reach.** `server/storage/applications.ts:43`
  `getLoanApplicationWithAccess` (114 references): admin unrestricted (`:45`); internal staff **or**
  `broker`/`lender` need an active `deal_team_members` row (`:57-77`); everyone else is scoped to
  `loanApplications.userId` (`:80-88`). `server/routes/borrower/access.ts:12`
  `verifyInternalStaffApplicationAccess` (11 references): admin; internal staff on
  `loanOfficerId === userId` **or** deal-team membership; external partners **never** (`:35`).
  The `:23-28` comment records why the second widened: lo/loa used to 403 on files in their own
  queue.
- **External partners see masked PII.** `server/routes/borrower/access.ts:42-52`
  `maskUrlaPersonalInfo` reduces SSN to `•••-••-1234` and nulls DOB; applied at
  `server/routes/borrower/urla.ts:56-60` when the requester is staff-typed but not internal. The
  full-SSN reveal endpoint allows `["admin","underwriter","processor"]` (`server/routes/borrower/urla.ts:95`) and audits
  `urla.ssn_reveal` (`:89`).
- **Promotion happens once, guarded, audited, best-effort.** `server/routes/lending/applications.ts:129-145`:
  `aspiring_owner` → `active_buyer` on first application; the comment states both are
  `CLIENT_ROLES` with identical server authorization, so this changes "navigation cohort + admin
  stats, never privileges".
- **The only self-service path to a staff role is a staff invite.** `server/routes/staff-invites.ts:11`
  create (`requireRole("admin")`), `:16` `validRoles` = 7 roles — **`admin` is not mintable by
  invite**; `:81` redeem (`isAuthenticated`; code exists, unused, unexpired, email matches) →
  `updateUserRole` `:109` + audit `:110`.
- **Three OAuth providers, hand-rolled.** `server/socialAuth.ts:56,73,87` google / linkedin / apple;
  Apple's client secret is a per-request ES256 JWT (`:27-53`); the OAuth `state` is stored in the
  session **and** an `oauth_state` cookie with `sameSite: "none"` because Apple's `form_post`
  callback is cross-site (`:194-208`); the cookie encodes `provider:state` so provider substitution
  is caught independently (`:249-267`); a social user is created `emailVerifiedAt: now`
  (`integrations/auth/storage.ts:84-85`). Post-login redirect: admin → `/admin`, staff →
  `/staff-dashboard`, else `/dashboard` (`:351-355`).
- **Dev test login.** `server/auth.ts:342-415`: 11 `<role>@test.com` accounts
  (`grep -c "@test.com" server/auth.ts` → `11`), one shared password from the env var
  `DEV_TEST_PASSWORD` (503 when unset, `:350-354`), hard 404 in production (`:62-64`). Accounts in
  `knowledge-base/runbooks/TEST_ACCOUNTS.md:11-23`.
- **Invite and referral landings are public.** `/apply/:token` and `/ref/:code`
  (`client/src/App.tsx:263-268`) back onto unauthenticated validators
  (`server/routes/agent-broker/invites.ts:122`, `referralsCoBrand.ts:113`); the invite token is
  redacted from logged paths (`server/app.ts:471-473`).
- **CSRF** is the Origin/Referer check from chapter 01 (`server/app.ts:406-469`), with the OAuth
  callback and `/api/webhooks/` carve-outs and the full dev bypass (`:458-460`).
- **Other gates.** Beta gate (`server/middleware/betaGate.ts`, never on `/api/*`); prelaunch gate
  fails safe — unset env means gated in production while the company NMLS id is pending
  (`server/services/prelaunchGate.ts:25-31`) and blocks with 404 `PRELAUNCH_GATED`; the client
  mirror `client/src/lib/prelaunch.ts:17-19` is gated by default in a production build.
- **The client side.** `client/src/hooks/useAuth.ts:33-36` `shouldRetryAuth` (a 401 is definitive,
  anything else retries twice), `:60` `networkMode: "always"`, `:72` `isLoading = status === "pending"`,
  `:80` `isError` excludes 401. `client/src/hooks/useAuthGuard.ts:6-11` five statuses; `degraded`
  navigates nowhere (`:65`) — "a 502 must not sign a user out mid-form". `client/src/lib/routeGates.ts:29-31`
  "Client gates are a UX affordance, never the security boundary"; 10 gates
  (`grep -oE "^  [a-zA-Z]+:" client/src/lib/routeGates.ts | wc -l` → `10`); `partnerHub` is a
  deliberate literal `["realtor","admin"]` because RESPA §8(a) bars referral compensation to CPAs
  (`:90-105`). `client/src/lib/roleRoutes.ts:14-21` `getRoleHomeRoute` is total over roles, so the
  forbidden → home hop cannot loop.
- **Integration tests log in over HTTP** with `X-Forwarded-Proto: https` + `Origin` on every
  request (`tests/roleSeparation.test.ts:31,38`) — and `knowledge-base/runbooks/TEST_ACCOUNTS.md:45-51`
  notes the proto header is unnecessary against a `pnpm dev` server (the cookie is not secure-only
  there); roughly ten files send it anyway.
- **Who reaches which surface, as a grid.** Twelve roles (`shared/roles.ts:14-43`: eight
  `STAFF_ROLES`, two `CLIENT_ROLES`, two self-registering `PARTNER_ROLES` that are deliberately
  *not* staff, `:31-39`) against the ten gates of `client/src/lib/routeGates.ts:33-109`, read off
  the object itself (`sed -n '33,109p' client/src/lib/routeGates.ts | grep -vE '^\s*(/\*\*|\*|\*/)'`, in the prove-it block):

  | gate | admin | lo | loa | processor | underwriter | closer | broker | lender | cpa | realtor | aspiring_owner | active_buyer | App.tsx wrapper · routes |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|---|
  | `borrower` = `CLIENT_ROLES` | · | · | · | · | · | · | · | · | · | · | ✓ | ✓ | `BorrowerPage` · 17 |
  | `staff` = `STAFF_ROLES` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · | `StaffPage` · 13 |
  | `internalStaff` = `INTERNAL_STAFF_ROLES` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | · | `InternalStaffPage` · 2 |
  | `underwriterOps` | ✓ | · | · | · | ✓ | · | · | · | · | · | · | · | `UnderwriterOpsPage` · 3 |
  | `disclosure` = clients + staff | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | ✓ | ✓ | inlined `PrivateLayout` · 1 (`App.tsx:475-485`) |
  | `marketData` | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · | · | · | `MarketDataPage` · 1 |
  | `loTeam` | ✓ | ✓ | ✓ | · | · | · | · | · | · | · | · | · | `LoTeamPage` · 1 |
  | `cpaPortal` | ✓ | · | · | · | · | · | · | · | ✓ | · | · | · | `CpaPage` · 1 |
  | `partnerHub` | ✓ | · | · | · | · | · | · | · | · | ✓ | · | · | `PartnerPage` · 1 |
  | `adminOnly` | ✓ | · | · | · | · | · | · | · | · | · | · | · | `AdminPage` · 12 |
  | *(any signed-in role)* | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | `AnyAuthPage` · 8 |
  | *(no session)* | | | | | | | | | | | | | `PublicPage` · 27, plus bare/`BareLayout` routes |

  Route counts are `for w in PublicPage BorrowerPage StaffPage InternalStaffPage UnderwriterOpsPage MarketDataPage LoTeamPage CpaPage PartnerPage AdminPage AnyAuthPage; do printf '%s %s\n' $w $(grep -c "<$w>" client/src/App.tsx); done`
  → `27 17 13 2 3 1 1 1 1 12 8` of `grep -c "<Route" client/src/App.tsx` → `121` (the rest are
  `BareLayout` pages, redirects and the 404). Each wrapper is one line, `App.tsx:189-223`, and the
  sidebar reads the same object. The test accounts (`server/auth.ts:358-368`) cover eleven of the
  twelve columns — `realtor` has none. And the header of the gate file says what this grid is:
  "Client gates are a UX affordance, never the security boundary. The server's own role checks are
  what actually protect the data; these only keep users out of pages that would fail for them
  anyway" (`client/src/lib/routeGates.ts:29-31`) — the boundary is `requireRole(`/`isAuthenticated`
  on the route (`grep -rn "requireRole(" server --include='*.ts' | wc -l` → `242`;
  `isAuthenticated` → `349`).
- **The cookie, end to end — and why there is no CSRF token.** (1) Login calls `req.login`
  (`server/auth.ts:107,185,389`); Passport's serializer is the identity function, so the whole user
  object — role included — is the session row in Postgres (`server/integrations/auth/session.ts:65-68`,
  store `:28-34`, table `sessions`). (2) The cookie is `httpOnly`, `secure` only under
  `NODE_ENV=production` ("Local dev runs plain http; a secure-only cookie would never be stored"),
  `sameSite: "lax"` (OAuth redirects must carry it back), 12-hour `maxAge` and **rolling**, so an
  active user never expires and an abandoned session does (`:9-14`, `:40-49`). (3) The client sends
  it with `credentials: "include"` on every `apiRequest` and every default `queryFn`
  (`client/src/lib/queryClient.ts:84`, `:167`) and deliberately **not** on `getPublicQueryFn`
  (`:150-156` — "these endpoints are public, so there is no reason to attach the session cookie").
  (4) On every gated request the role is re-read from `users`, so a demotion or deletion takes
  effect on the next request, not at expiry (`server/auth.ts:427-439`). (5) Every state-changing
  `/api` request must carry an `Origin` or `Referer` whose hostname is the request's own `Host`
  (`server/app.ts:404-469`); the carve-outs are OAuth callbacks (`:416-422`, protected by `state`)
  and `/api/webhooks/` (`:424-429`, signature-checked per route); anything else is **403**
  `CSRF validation failed` (`:462-468`) — except in `development`, where the check is skipped
  outright (`:457-459`). (6) `secure` and `req.protocol` resolve through one hop count,
  `trustProxyHops()` (`server/app.ts:37`, re-set at `session.ts:60`; `server/trustProxy.ts:22-27`,
  default 1, `TRUST_PROXY_HOPS` overrides) — get it wrong and production never sets the cookie.
  Put together: `sameSite=lax` withholds the cookie from a cross-site POST, and a same-site forged
  request cannot forge the browser-set `Origin`, so **the Origin check is the CSRF control** and the
  client carries no token code at all — `grep -rin csrf client/src | wc -l` → `0`. That is also why
  the integration lane sends `X-Forwarded-Proto: https` (so a production-mode server will set the
  secure cookie) and `Origin: <BASE_URL>` (so the check passes) on every request
  (`tests/roleSeparation.test.ts:24-31`).

## Prove it yourself

```bash
cd /Users/ammrebarakat/Developer/Homiquity-handoff && git rev-parse --short HEAD
# → 12d7cbec @ 12d7cbec
grep -n "scryptAsync(password, salt, 64)" server/auth.ts
# → 34:  const buf = (await scryptAsync(password, salt, 64)) as Buffer; @ 12d7cbec
grep -c 'app.post("/api/auth' server/auth.ts
# → 7 @ 12d7cbec
grep -n "rolling\|maxAge\|httpOnly\|sameSite\|secure:" server/integrations/auth/session.ts
# → 40 rolling: true / 42 httpOnly: true / 46 secure: NODE_ENV === "production" / 47 sameSite: "lax" / 48 maxAge: sessionTtl @ 12d7cbec
grep -n "user.role = dbUser.role" server/auth.ts
# → 435:    user.role = dbUser.role; @ 12d7cbec
grep -c "@test.com" server/auth.ts ; grep -n "process.env.DEV_TEST_PASSWORD" server/auth.ts
# → 11 / 350 @ 12d7cbec
grep -n "role: userData.role ?? " server/integrations/auth/storage.ts
# → 68:        role: userData.role ?? "aspiring_owner", @ 12d7cbec
grep -rn "isAuthenticated" server --include='*.ts' | wc -l ; grep -rl "requireRole(" server --include='*.ts' | wc -l ; grep -rn "requireStaff" server | wc -l
# → 347 / 40 / 0 @ 12d7cbec
grep -rn "getLoanApplicationWithAccess(" server | wc -l ; grep -rn "verifyInternalStaffApplicationAccess(" server | wc -l
# → 114 / 11 @ 12d7cbec
sed -n '16p' server/routes/staff-invites.ts
# → const validRoles = ["lo", "loa", "processor", "underwriter", "closer", "broker", "lender"]; @ 12d7cbec
grep -oE "^  [a-zA-Z]+:" client/src/lib/routeGates.ts | wc -l
# → 10 @ 12d7cbec
grep -rn "maskUrlaPersonalInfo" server --include='*.ts' | wc -l
# → 4   (definition, import, two call sites — all in two files) @ 12d7cbec
sed -n '33,109p' client/src/lib/routeGates.ts | grep -vE '^\s*(/\*\*|\*|\*/)' | grep -v '^\s*$' | sed -E 's/^ +//' | tr '\n' ' '
# → export const ROUTE_GATES = { borrower: CLIENT_ROLES, staff: STAFF_ROLES, internalStaff: INTERNAL_STAFF_ROLES, underwriterOps: ["admin", "underwriter"], disclosure: [...CLIENT_ROLES, ...STAFF_ROLES], marketData: ["admin", "lo", "loa", "processor", "underwriter"], loTeam: ["admin", "lo", "loa"], cpaPortal: ["cpa", "admin"], partnerHub: ["realtor", "admin"], adminOnly: ["admin"], } as const satisfies Record<string, readonly UserRole[]>; @ 6377727e
for w in PublicPage BorrowerPage StaffPage InternalStaffPage UnderwriterOpsPage MarketDataPage LoTeamPage CpaPage PartnerPage AdminPage AnyAuthPage; do printf '%s %s\n' $w $(grep -c "<$w>" client/src/App.tsx); done | tr '\n' ' ' ; grep -c "<Route" client/src/App.tsx
# → PublicPage 27 BorrowerPage 17 StaffPage 13 InternalStaffPage 2 UnderwriterOpsPage 3 MarketDataPage 1 LoTeamPage 1 CpaPage 1 PartnerPage 1 AdminPage 12 AnyAuthPage 8 / 121 @ 6377727e
grep -rin csrf client/src | wc -l ; grep -rhoE 'process\.env\.TWILIO[A-Z_]*' server | sort -u | tr '\n' ' '
# → 0 / process.env.TWILIO_AUTH_TOKEN process.env.TWILIO_STATUS_CALLBACK_URL process.env.TWILIO_WEBHOOK_URL @ 6377727e
```

## Where this breaks

| Trap | Where | Caught by |
|---|---|---|
| `isStaffRole()` includes `broker` and `lender`; gating a borrower-data endpoint on it alone admits two external partner roles. | `shared/roles.ts:102-104` vs `:110-112` | Partly — `tests/routeGates.test.ts:67` pins the subset relationship, `tests/roleSeparation.test.ts:118` covers a fixed endpoint list; a **new** endpoint gated on `isStaffRole` ships green. |
| `requireRole` compares raw strings — `requireRole("underwritter")` compiles and admits nobody, silently. | `server/auth.ts:452-462` | Nothing on the server (the client side is typed via `satisfies Record<string, readonly UserRole[]>`). |
| `isAuthenticated` returns 500 on any DB error — a users-table blip becomes a 500 on every authenticated route; the client treats non-401 as `degraded` and does not log out, so only the client half is guarded. | `server/auth.ts:436-439` | Not directly. |
| CSRF is bypassed in development, including when both headers are absent — so the integration lane (which runs against a dev server) cannot see a CSRF regression. | `server/app.ts:458-460` | `tests/complianceInvariants.test.ts:423` pins only the webhook carve-out shape. |
| Two access models: `getLoanApplicationWithAccess` admits broker/lender via deal team; `verifyInternalStaffApplicationAccess` refuses them and adds the `loanOfficerId` pointer. Picking the wrong one silently widens or narrows access. | `server/storage/applications.ts:43` vs `server/routes/borrower/access.ts:12` | No drift test compares them. |
| `maskUrlaPersonalInfo` is applied on exactly one route; any other route returning URLA personal info to a broker/lender leaks SSN and DOB. | `server/routes/borrower/urla.ts:56-60` | No source-text invariant pins it. |
| The SSN reveal's audit write cannot fail the request — `logAudit` swallows its own errors, so a dead `audit_logs` table still returns plaintext. | `server/routes/borrower/urla.ts:105-109`; `server/auditLog.ts:23-25` | Nothing (L2 names the adjacent gap F-006). |
| The staff-invite email match is exact string equality with no case normalization, while login lowercases. | `server/routes/staff-invites.ts:100` vs `server/auth.ts:152` | No test found. |
| The `oauth_state` cookie is `secure: true` unconditionally while the session cookie is secure only in production — on plain-http local dev the state cookie is never stored; GET callbacks fall back to the session copy, Apple's cross-site POST would not. | `server/socialAuth.ts:202-208` vs `session.ts:46` | `tests/socialAuthProviders.test.ts` exists; whether it covers this asymmetry is unverified. |
| Apple's `parseUserInfo` returns `{ email: "" }`; the real email comes from decoding the id_token in the callback branch. Refactoring Apple onto the generic path kills every Apple login with `?error=no_email`. The id_token is decoded, not signature-verified (defensible: it arrived over TLS from Apple's token endpoint, but unstated). | `server/socialAuth.ts:96-101`, `:172-181`, `:301-309` | No test. |
| The `aspiring_owner → active_buyer` promotion is best-effort; a failure leaves a renter with a live application — the exact state `TEST_ACCOUNTS.md:22` warns `renter@test.com` has carried before. | `server/routes/lending/applications.ts:142-144` | No guard; documented symptom. |
| `/apply/:token` validation is an unauthenticated GET that **mutates** state (marks the invite `clicked`); the token rides in the URL. | `server/routes/agent-broker/invites.ts:122,150` | Logs are redacted; prefetch-triggered state change is not prevented. |

## What we do not know

| Question | What resolves it |
|---|---|
| Are `sessions` rows ever pruned? The table is migration-owned (`createTableIfMissing: false`); the store's prune interval was not verified. | `grep -rn "pruneSessionInterval" server/`; the migration that created `sessions`. |
| Does `auth_tokens.tokenHash` have a unique index (the atomicity argument assumes a selective WHERE)? | `grep -n "tokenHash\|token_hash" shared/schema/core.ts migrations/*.sql`. |
| Is `POST /api/cpa-partners/register` rate-limited and prelaunch-gated? | `grep -rn "cpa-partners/register" server`. |
| Are `broker@test.com` / `lender@test.com` ever seeded onto a deal team — i.e. is the middle branch of `getLoanApplicationWithAccess` exercised by any integration test? | `grep -rn "dealTeamMembers" server/seed.ts tests/*.test.ts`. |

## Analogy

The office badge and the room list. Your session cookie is the badge — it proves the front desk
let you in this morning. But the badge does not encode which rooms you may enter: every door
reader phones HR fresh (`server/auth.ts:430`) to ask what your job title is *right now*, so a
demotion locks you out of the underwriter's office before you have walked down the hall. And the
badge never opens a *specific* filing cabinet — for that, your name has to be on the folder's own
routing slip (`deal_team_members`). The menu on the wall (`routeGates.ts`) just hides the dishes
the kitchen would refuse to cook.

## Teach-back checkpoint

1. A user is demoted from `underwriter` to `processor` while logged in. When does it take effect, and why?
2. Why does `/api/auth/forgot-password` return success even when the request throws?
3. A `broker` is an active deal-team member on application X. Can they read the borrower's full SSN?
4. Why is `cpa` in `PARTNER_ROLES` and not `STAFF_ROLES`?
5. What exactly makes `consumeAuthToken` safe against a replayed reset link?
6. The session probe gets a 502 mid-form. What does the client do, and what did it used to do?
7. How does a normal user become a `processor`?
8. Why is `sameSite: "lax"` on the session cookie but `sameSite: "none"` on `oauth_state`?

## Go deeper

- [app-guide 06](../handbook/app-guide/06-auth-security-secrets.md) — `## Authentication`, `## Authorization (RBAC)`
  (especially "The authorization distinction that matters"), `## Pre-flight checklist — PII or auth
  changes`, `## Secrets inventory`. `knowledge-base/runbooks/TEST_ACCOUNTS.md` (the 11-row table; the
  `renter@test.com` caveat; the corrected `X-Forwarded-Proto` guidance).
- Feature-map row 33 (authentication, sessions and account security — owner `hq-auth-owner`,
  freshness *never*) and row 34 (PII protection — `hq-pii-vault-owner`). The invariant at
  `FEATURE_MAP.md:531`: "Role gates mirror exactly between `shared/roles.ts`, the server
  `requireRole` and the client route gate. A client-only gate is not a gate."
- Owner agent `.claude/agents/hq-auth-owner.md`: yours-to-write = the public auth pages,
  `useAuth.ts`, `useAuthGuard.ts`, `roleRoutes.ts`, `routeGates.ts`, `logout.ts`, the sidebar, and
  eight auth tests; **hand-back only** = `server/auth.ts`, `server/socialAuth.ts`,
  `server/integrations/auth/`, `accountRecovery.ts`, `loginLockout.ts`, `clientIp.ts`,
  `trustProxy.ts` ("This area is almost entirely hand-back", `:42`). `_OWNER_RAILS.md:31` puts auth
  and session code on the always-off-limits list for every owner.
- Tests worth reading first: `tests/roleSeparation.test.ts`, `tests/accessControl.test.ts`,
  `tests/routeGates.test.ts`, `tests/routeGateDrift.test.ts`, `tests/loginLockout.test.ts`,
  `tests/authRecovery.test.ts`, `tests/adminPredicate.test.ts`.
