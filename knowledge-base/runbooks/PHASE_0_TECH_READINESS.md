# Phase 0 technical readiness gate

**Owner:** Founder/Security Owner + technical owner
**Evidence baseline:** production and `main` at
`958d7cf2cc15902a19f146ae23b80a8900d2cde7`, reviewed 2026-09-08
**Current verdict:** **NOT PASSED — controlled synthetic testing only**

## Purpose

Phase 0 answers one question: **can Homiquity safely hold and operate a controlled mortgage file
without losing evidence, crossing borrower or role boundaries, corrupting regulated data, hiding an
operational failure, or presenting simulated output as real?**

An implementation, a green unit test or a configured-looking screen is not enough. A gate passes
only when the current production environment and exact deployed build produce retained evidence.
Phase 0 completion does not approve a lender, state, product, marketing claim or broad public
launch. Those business and counterparty gates remain in later phases of the
[CTO roadmap](../../CTO_ROADMAP.md).

Use synthetic people and documents throughout this gate. Never commit secrets, screenshots of
secrets, raw logs containing borrower data or production evidence containing PII to this public
repository.

## Status vocabulary

| Status | Meaning |
|---|---|
| **Passed** | The current production environment and exact deployed build have retained evidence. |
| **Partial** | A control is built and some evidence exists, but the production proof is incomplete. |
| **Unproven** | Code, configuration or a procedure may exist; the required evidence does not. |
| **External** | Completion requires an account owner, vendor, licensed operator, counsel or counterparty. |

## Readiness snapshot

| Area | What the audit established | State at baseline |
|---|---|---|
| Production and release | Production reported the audited commit, answered a database health check and served database-backed and public routes. Pull requests have a strict required gate and automated migrations. Exact-commit verification exists, but its current non-blocking CI setting means a failed verifier does not fail the deployment workflow. | **Partial** |
| Database | The migration ledger has 67 entries through `0066_capture_application_real_estate`; CI checks the schema ledger and applies production migrations. The health endpoint proves only that a database answered, not its identity or restored integrity. | **Partial** |
| Documents | Production code fails closed when cloud storage is absent and implements signed create-only uploads, ownership/deal-team checks, immutable replacement and lineage. The configured bucket, retention and full production lifecycle have not been proven. | **Unproven** |
| Recovery | Code rollback and database restore procedures exist. No retained restore drill, approved recovery objectives or restored-application verification was found. | **Unproven** |
| Application security | Secure production sessions, CSRF checks, role/resource gates, field encryption, rate limits, audit logging and security headers exist. The independent source scan verified five high and five medium blockers; control-plane MFA, access review, telemetry safety and enforced CSP also need proof. | **Unproven** |
| Dependencies | The production audit found zero critical/high advisories, six moderate and one low. The moderate rows are in Express's `qs` chain and the MCP SDK's Hono chain and require reachability review or upgrade before exit. | **Partial** |
| Providers | Simulation markers and several fail-closed controls exist. Credit and AVM live adapters are not implemented, AUS remains simulated, and current production credential/mode state is not visible in one place. | **Unproven** |
| Workflow integrity | The complex borrower and loan-officer journey is internally proven and heavily tested. The exact consent, co-applicant, HMDA/MISMO, adverse-action, pricing and TRID seams need one current integrated re-verification. | **Partial** |
| Observability | `/api/health` checks database reachability and exposes release/email state. SendGrid reports configured and recent scheduled sweeps were green. Sentry, uptime alerts, cron failure alerts and safe log coverage are unverified. | **Partial** |
| Capacity and resilience | Warm public endpoints answered in about 0.19–0.35 seconds during the review; the server has graceful shutdown. No current authenticated latency, cold-start, concurrency, pool-saturation or recovery-under-load result exists. | **Unproven** |
| Governance | A security policy, access policy, incident plan and asset register exist. Policy adoption is pending, multiple MFA/device checks are open, and the policy calls an actually public repository private. | **Unproven** |

This snapshot is evidence, not a permanent claim. Re-run it when the deployed commit, production
data services, provider modes, role model or security boundary changes.

## Verified blockers at this baseline

Codex Security scan `28a40e23-6df3-4c10-b9a1-aa329cfe83ba` reviewed the repository at the exact
baseline revision and verified **five high** and **five medium** findings. Detailed source locations
remain in the security workbench rather than this public repository. The blocker themes are:

- external partner mutation authority over regulated borrower/application facts;
- simulated KYC, AUS and lender-delivery evidence reaching operationally real states;
- KYC decision scope that is not consistently bound to an assigned application;
- task status and document verification operations that are not fully bound to the authorized
  task, document and application; and
- account-recovery session revocation and trusted reset-link origin.

The architecture review also left production-only proof gaps around database identity, enforced
deployment verification, object-store retention and restore, audit/telemetry safety, privileged
script targets, temporary preview data, provider mode and control-plane configuration. These are
gates below, not accepted exceptions.

## Execution sequence

Run the substages in order. A later substage may reveal work for an earlier one; reopen that gate,
fix it, and repeat its proof before continuing. Do not mark a row passed from a prior environment or
a different commit.

### 0A — establish production truth and control

**Outcome:** an operator can see what production is running, which real systems it uses, and which
capabilities are live, simulated, disabled or broken without reading secrets.

| ID | Required proof | Pass condition |
|---|---|---|
| 0A-1 | Exact release | `/api/health` commit equals protected `main`; one database-backed route and one static/public route succeed; the CI run linking merge, migration and deploy verification is retained; a failed exact-commit verifier blocks release acceptance. |
| 0A-2 | Database identity | A non-secret production fingerprint identifies the intended Neon project/branch and migration head. The application cannot silently point at a stale or preview branch while health stays green. |
| 0A-3 | Configuration inventory | Record every required variable by name, owner, purpose, present/absent state, operating mode and last verification. Never record values. Contradictory or unsafe combinations fail boot. |
| 0A-4 | Provider truth | One authenticated operational view reports each provider as `live`, `simulated`, `disabled` or `configuration_error`, plus the last successful verification and affected capability. |
| 0A-5 | Dependency posture | Production audit has no critical/high finding. Every moderate finding is upgraded, source-reachability rejected with evidence, or time-boxed with an owner and compensating control. |
| 0A-6 | Source and release control | Branch protection, secret scanning, push protection, exact required checks, deploy source and production host are reverified. Any lack of independent review for sensitive changes has an explicit owner decision. |
| 0A-7 | Documentation truth | Current operational documents agree with code and production. Remove dynamic counts and status claims that become false after the next deploy. Archive replaced procedures instead of allowing two current authorities. |

**Current gaps:** the public health response exposes only commit, database reachability and email
state; Railway variables were not available to this audit; the database identity is indirect;
provider state is fragmented; exact-commit verification is non-blocking; dependency advisories
remain; and some living security documents contradict the current public repository posture.

### 0B — prove data durability and recovery

**Outcome:** a borrower document and application survive replacement, restart, deploy and
point-in-time recovery while access and lineage remain correct.

| ID | Required proof | Pass condition |
|---|---|---|
| 0B-1 | Object-store configuration | Production requests a signed upload URL for an allowed synthetic PDF. An absent or invalid bucket stays fail-closed and produces an actionable operator alert. |
| 0B-2 | Complete document lifecycle | Upload → register → extract/review → download → deploy/restart → byte-identical download → replacement. The prior version remains immutable and the current version is the only actionable evidence. |
| 0B-3 | Storage access matrix | Owner, assigned staff and admin receive the intended access. Another borrower, unassigned staff, logged-out user, expired signed URL and object-path guess are denied without metadata leakage. |
| 0B-4 | Storage constraints | Size, MIME, magic bytes, create-only generation, signed content type and expiry are enforced. Bucket public access is disabled and lifecycle/retention rules match the record policy. |
| 0B-5 | Database restore drill | Restore production to an isolated branch from a recorded point in time. Verify migration head, row counts/checksums for selected tables, encrypted-field shape, document metadata and application boot against the restored copy. |
| 0B-6 | Recovery objectives | Security Owner adopts a recovery-point objective and recovery-time objective supported by the actual vendor plans. The measured restore meets both or the gap has a blocking owner. |
| 0B-7 | Deletion and retention | Synthetic file deletion/retention behavior agrees across database, object store, audit trail and backup policy. Legal holds and regulated retention exceptions fail safely. |

Do not run the database drill against the live branch and do not reuse an actual borrower document.
The recovery copy must remain isolated and be deleted after the evidence is retained.

### 0C — close security, privacy and access gaps

**Outcome:** internet, borrower, staff, provider and operator boundaries fail closed, and sensitive
data does not escape through storage, responses, logs, analytics or monitoring.

| ID | Required proof | Pass condition |
|---|---|---|
| 0C-1 | Independent security review | A current whole-repository scan covers auth, authorization, PII, documents, providers, lender delivery and operations. No verified critical/high finding remains; every lower finding has a disposition and owner. |
| 0C-2 | Authentication lifecycle | Registration/verification, login, logout, session expiry, password reset, token single use, lockout and production test-login denial pass. Cookies remain secure, HttpOnly and appropriately same-site. |
| 0C-3 | Authorization matrix | Borrower, LO, LOA, processor, underwriter, closer, external broker/lender and admin are tested on read and mutation paths. Application ownership and active deal-team membership are checked at the resource, not only the page. |
| 0C-4 | Encryption and keys | A database spot check proves restricted values are ciphertext; a controlled decrypt/re-encrypt succeeds; missing or invalid key configuration blocks boot; rotation and recovery are practiced without exposing a key. |
| 0C-5 | PII egress | Review representative success/error logs, audit rows, emails, analytics and a test Sentry event. No raw SSN, account number, document body, access token, password/token secret or unnecessary borrower content leaves its approved boundary. |
| 0C-6 | Browser policy | CSP Report-Only violations are reviewed and cleared, then enforcement is enabled and the public, auth, Plaid and document flows pass. Other security headers remain present. |
| 0C-7 | Control-plane access | MFA and named-user access are verified for GitHub, Railway, Neon, Google Cloud, email, DNS and enabled vendors. Remove stale seats and shared credentials; record a dated access review. |
| 0C-8 | Repository posture | Resolve the public/private policy contradiction. The recommended default before real borrower data is a private repository with required checks preserved; a different choice requires a dated Security Owner risk decision and corrected policy language. |
| 0C-9 | Incident secrets test | A synthetic leaked credential triggers detection, rotation, session revocation and evidence preservation without placing a real secret in Git history. |

The current scan fails 0C-1. Remediate and independently re-scan all ten verified findings; the five
high findings block real borrower data, approval-grade evidence and lender submission. The medium
findings require an owner and verified disposition before Phase 0 exit.

### 0D — re-prove regulated workflow and data integrity

**Outcome:** the same synthetic complex file stays internally consistent from capture through lender
package, including a co-applicant, and every consequential figure and state change is reproducible.

| ID | Required proof | Pass condition |
|---|---|---|
| 0D-1 | One canonical case | Run one self-employed primary borrower, co-applicant, multiple businesses, rental, liabilities and changed document through public intake, URLA, staff review, decision and package generation. No staff rekeys a platform answer. |
| 0D-2 | Consent semantics | Consent text/version, purpose, pull type, applicants, timestamp, revocation and downstream use remain scoped and reproducible. Cached or repeated actions cannot bypass current consent. |
| 0D-3 | Applicant separation | Primary and co-applicant identity, income, assets, liabilities and declarations stay separate in UI, database, HMDA and MISMO. Swapping one person's values must fail a golden-file comparison. |
| 0D-4 | Application clock | The completed-application timestamp begins only from the defined complete state, survives edits and drives one owned, visible deadline without duplicate clocks. |
| 0D-5 | Decisions and notices | Approval/denial state transitions are idempotent. A denial produces exactly one applicable notice; simulated credit cannot create a false consumer-report claim; delivery and acknowledgement are auditable. |
| 0D-6 | Pricing and disclosures | Public estimates, staff pricing, LLPA/APR/cost math and generated disclosures reconcile from the same inputs and clearly distinguish estimate, verified fact and locked term. |
| 0D-7 | TRID ownership | The disclosure clock, next action, named owner, escalation and delivery proof agree across borrower and staff views. Concurrent or retried actions cannot issue duplicates or erase history. |
| 0D-8 | Evidence lineage | Every approval-grade income, asset, liability and property figure traces to the accepted physical document/version, extraction lineage and human review. Rejected or replaced evidence cannot remain actionable. |
| 0D-9 | Package reproducibility | Rebuilding MISMO/HMDA/lender-package artifacts from the accepted snapshot produces the same material contents, schema validation and audit references. No simulated source is promoted to lender-ready. |

The named seams above are a current re-verification set, not a resurrection of the old findings
backlog. If a seam passes, retain the proof and close it. If it fails, fix the root control and run
the full canonical case again before moving on.

### 0E — make providers and background work operationally honest

**Outcome:** a loan officer knows which external evidence is trustworthy, which step is manual, and
when a provider or scheduled process has failed.

| ID | Required proof | Pass condition |
|---|---|---|
| 0E-1 | Provider registry | Credit, assets, employment/income, tax, AUS, property/AVM, pricing, email, AI/extraction and lender delivery appear in the 0A operational view with source, mode, last success and owner. |
| 0E-2 | Simulation fence | Production refuses unapproved simulation. Every persisted external result carries provenance and simulation state, and readiness/decision/delivery checks reject simulated approval-grade evidence. |
| 0E-3 | Webhook trust | Each enabled webhook verifies signature, timestamp/replay window, event identity and application/provider binding before mutation. Missing secrets fail closed and alert. |
| 0E-4 | Retry and idempotency | Provider timeouts, duplicate callbacks, retries, late results and partial writes do not create duplicate orders, conditions, notices, costs or state transitions. |
| 0E-5 | Manual evidence path | For any Phase 1 provider completed outside Homiquity, define the authorized actor, required source artifact, review, provenance, audit entry and state transition. A typed note alone never becomes verified evidence. |
| 0E-6 | Email proof | Verification, recovery, document-request, application and adverse-action messages are tested for delivery, links, expiry, recipient scope and failure visibility. |

Live credit, AUS, valuation or lender contracts are not required to finish Phase 0. Their production
state must be visibly disabled until Phase 1 selects and proves the path; configuration must never
turn an unfinished adapter into a real result.

### 0F — measure reliability, performance and incident response

**Outcome:** the controlled pilot has an explicit service envelope, failures wake an owner, and the
team has practiced recovery.

| ID | Required proof | Pass condition |
|---|---|---|
| 0F-1 | Monitoring chain | External uptime, stale-commit and data-route checks alert a named person. Sentry receives a synthetic error tagged with the deployed commit. Alert receipt and acknowledgement are timed. |
| 0F-2 | Scheduled-work chain | Manually run every production sweep, verify its authenticated result and affected audit/metric row, then trigger one controlled failure and prove the owner is notified. Green history alone is insufficient. |
| 0F-3 | Performance budget | Measure public mobile loading, authenticated core reads/writes, autosave, dashboard, upload, extraction and package build at warm and cold start. Ratify targets before the capacity run. |
| 0F-4 | Pilot capacity | Run the canonical case at the intended pilot concurrency, including concurrent uploads and staff activity. Record p50/p95/p99, error rate, memory/CPU and database connections; zero cross-file or lost-write defect is allowed. |
| 0F-5 | Database safeguards | Set and test pool, connection, statement/query and transaction timeout behavior appropriate to measured load. Saturation produces bounded errors and recovery rather than an indefinite queue. |
| 0F-6 | Restart resilience | During representative read, write, upload and background work, restart/deploy once. Graceful shutdown completes or rolls back each unit; a retry remains idempotent. |
| 0F-7 | Incident exercise | Run a tabletop for stale deployment, database outage, object-store failure, leaked secret and unauthorized access. Identify incident commander, customer/compliance escalation, evidence, recovery step and status channel. |

Proposed pilot targets to ratify before 0F-4: public mobile LCP at or below 2.5 seconds at the 75th
percentile; internal API reads below 750 ms p95 and writes below 1.5 seconds p95 excluding declared
provider time; fewer than 1% technical errors; and ten concurrent pilot users with three concurrent
document uploads. Any target may change from measurement, but the owner and accepted threshold
must be recorded before the test so the result cannot be graded after the fact.

### 0G — run exact-build production acceptance

**Outcome:** one exact deployed build passes the complete technical gate and the evidence can be
reviewed without trusting memory.

| ID | Required proof | Pass condition |
|---|---|---|
| 0G-1 | Frozen candidate | Record release SHA, migration head, production service/database/storage identifiers, configuration modes and evidence start time. No untracked change is introduced during acceptance. |
| 0G-2 | Full journey | Run 0D's canonical case in production with synthetic identities and documents through borrower and every staff role. Capture inputs, expected results and redacted outputs. |
| 0G-3 | Failure cases | Repeat cross-account denial, invalid document, replaced evidence, simulated provider, duplicate submission, provider timeout, stale callback, session expiry and service restart. All fail safely. |
| 0G-4 | Recovery proof | Link the current object lifecycle test, isolated database restore, application rollback and alert/incident exercises. A written procedure without a dated execution is not accepted. |
| 0G-5 | Cleanup | Delete or mark all synthetic production records according to policy, verify object cleanup/retention, revoke temporary access and close temporary configuration. |
| 0G-6 | Sign-off | Technical owner, Security Owner and licensed/compliance reviewer sign the same evidence index. Every exception has owner, impact, mitigation and expiry; no blocker is excepted silently. |

## Evidence record

Keep the redacted index in this document or another living runbook. Store sensitive screenshots,
logs and console exports in the approved protected company drive and link them by restricted URL.
One row can satisfy several gates only when it proves every stated condition.

| Gate | Result | Environment | Git SHA | Checked at | Owner | Evidence | Notes / exception expiry |
|---|---|---|---|---|---|---|---|
| _Example: 0B-5_ | _Passed / Failed_ | _isolated restore_ | _SHA_ | _UTC time_ | _name_ | _restricted link_ | _no PII in repo_ |

## Phase 0 exit rule

Phase 0 is complete only when all of the following are true:

- Every 0A–0G row is **Passed** or explicitly not applicable with evidence.
- No verified critical/high security finding remains. Every medium/low finding has an owner,
  disposition and due date consistent with the pilot risk.
- The canonical complex case has no unresolved defect that can mix applicants, lose/replace
  evidence incorrectly, misstate consent, decision, notice, disclosure, price, deadline or package.
- Database restore, document lifecycle, cross-account denial, rollback, alerting and scheduled work
  have been executed against the current production architecture.
- Every production provider is visibly live, disabled or simulated; no simulated or unknown result
  can satisfy an approval, disclosure, lock or lender-readiness gate.
- Recovery and service objectives are approved and met by measurement.
- The evidence index is signed by the technical owner, Security Owner and licensed/compliance
  reviewer.

Until then, public education and lead capture may continue inside the approved licensed-state and
privacy boundaries, but mortgage-file testing remains controlled and synthetic. Do not increase
paid acquisition or accept uncontrolled document volume on the strength of code-only readiness.

## Decisions and recommendations

1. **Repository:** move it to private before controlled real borrower data, while preserving branch
   protection and secret scanning. If it remains public, correct the policy and record the accepted
   source-exposure risk.
2. **Recovery:** adopt a pilot default of at most 15 minutes of data loss and four hours to restored
   service unless the vendor plan or restore drill proves a different explicit target.
3. **Launch posture:** keep provider simulations disabled in production and keep real mortgage-file
   intake controlled until 0G is signed.
4. **CSP:** finish a clean Report-Only soak, enforce it during Phase 0, and test Plaid, maps,
   documents and public conversion flows under enforcement.
5. **Build order:** establish production truth and immediately close the five high security
   findings, then prove durability, close the remaining security gate, re-prove workflow integrity,
   provider/background honesty, reliability and exact-build acceptance. Do not buy or build broad
   provider automation until Phase 1 selects the first lender and its actual requirements.

These decisions keep Phase 0 deep without turning it into indefinite platform work. Multi-region,
large-volume scaling, many lenders, broad provider automation and adjacent homeowner products stay
outside this gate.

## Existing procedures used by this gate

- [Production acceptance test](PROD_ACCEPTANCE_TEST.md) — detailed production mechanics; this Phase
  0 runbook controls current status and exit scope.
- [Database migrations](DB_MIGRATIONS.md) — migration and production application procedure.
- [Rollback](ROLLBACK.md) — code and database recovery procedure.
- [Information Security Policy](../governance/security/INFORMATION_SECURITY_POLICY.md),
  [Access Control Policy](../governance/security/ACCESS_CONTROL_POLICY.md),
  [Asset Register](../governance/security/ASSET_REGISTER.md) and
  [Incident Response Plan](../governance/security/INCIDENT_RESPONSE_PLAN.md) — controls whose
  adoption and operational evidence are part of Phase 0.
