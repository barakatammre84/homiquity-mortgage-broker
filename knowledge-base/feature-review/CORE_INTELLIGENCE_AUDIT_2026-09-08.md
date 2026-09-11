# Core intelligence audit — Homi, documents, financial analysis and underwriting

**Evidence date:** 2026-09-11

**Code reviewed:** production commit `50b496ddbc5c118bc260cbb93f26e51445f7b6a1`, including the
underwriting product-integrity release

**Decision:** keep the existing architecture; harden the document-to-evidence path before adding more borrower-facing intelligence

## Question and standard

Can Homiquity take a complicated borrower from uploaded evidence to a lender-ready, reproducible
file with less borrower effort and less loan-officer rework than the market?

“Best in class” means more than a plausible model answer:

1. Every important fact traces to the document, page, field, extraction version and reviewer.
2. A stopped worker resumes safely without losing or duplicating work.
3. The system measures field accuracy from human corrections rather than model confidence.
4. Deterministic mortgage math consumes only permitted evidence and becomes stale when its inputs
   change.
5. Staff and borrowers can distinguish reported, documented, verified, simulated and live data.
6. A real lender accepts the resulting package and every correction returns to the same file.

The audit traced the user action, route, service, database record, calculation, evidence gate and
staff output for Homi, ordinary document extraction, tax-package intelligence, financial review,
underwriting, credit, AUS, pricing and lender delivery. The complete server and client suites,
focused journey tests, real local HTTP flow and database restart-recovery proof pass. Exact-build
production canaries also prove the Anthropic-backed Homi and pay-statement paths plus private cloud
storage, mixed-income analysis and deterministic underwriting. Controlled production proofs now
show both a provider-backed pay statement and a provider-classified 100-page tax packet recovering
after interruption before persistence. The result does not prove measured model accuracy, live
mortgage-decision providers or a lender receiver.

## Verdict

Homiquity has a sound core architecture and a credible advantage for complex borrowers. AI does
not decide mortgage eligibility. The underwriting and income engines are deterministic, the file
distinguishes evidence levels, complex-income figures require workpapers and human approval, and
the lender package carries citations and hashes.

The product is not yet an end-to-end live mortgage platform. The current production build closes
the lost-work gap with database-backed extraction jobs, leased claims, bounded retries and restart
recovery. It also moves the consent-gated tax experience onto the richer multi-form analyzer and
feeds the borrower snapshot from that one result. Ordinary pay-stub, W-2, bank-statement and lease
uploads now classify and normalize every page, create contiguous logical documents, route each
supported segment to its specialized extractor and preserve original-page/box evidence. Staff can
see the cited box on the page, correct document boundaries and grade or correct individual fields.
Document state, confidence, facts and readiness commit in one database transaction, so a failed
write is retried without exposing a half-updated file. Demonstration extraction refuses to run in
production even when its environment flag is set, and the capability screen reports that
combination as a configuration error.

The current production build also closes the internal decision-delivery gaps: every URLA borrower becomes
a separate schema-valid MISMO party with correctly attributed employment and declarations, and the
submitted package retains hash-verifiable MISMO, income-analysis and dual-AUS findings artifacts.
Accuracy calibration across born-digital and scanned documents and a real lender receiver remain
open. Credit, DU, LPA, executable pricing provenance and lender delivery remain simulated or
unproven.

Better demonstrates the experience standard: one central file, tasks generated from the file,
24-hour help and a fast underwriting promise after the required evidence arrives.[1][2][3] Its
published fast-underwriting terms also exclude or condition many self-employed and rental-income
cases.[3] Homiquity should copy the continuity and speed pattern, then win on evidence-rich review
for the borrowers that a standardized fast lane handles poorly.

## Capability reality map

| Capability | What works now | Main gap | Assessment |
|---|---|---|---|
| Homi | Server-grounded status, checklist, task and bounded document-evidence tools; prompt lineage; PII input guard; bounded turns; streaming; safe offline guidance; real staff-task handoff; current server-snapshot outcome measures; provider canary ledger; a successful grounded production status-turn proof; and a mortgage regression/attack suite | Complete the 30-turn/10-eligible-borrower instrumentation pilot, decide the proactive-invitation treatment, then register and power the comparison study before enrollment; explicitly account for phone/off-platform work | Strong assistant foundation; Homi can distinguish machine-read, human-verified and fully approved financial evidence without receiving raw OCR or private identifiers, while production usefulness remains unproven |
| Simple document extraction | Claude reads pay stubs, W-2s, bank statements and leases; every page is classified and normalized; mixed packets become logical documents routed to specialized extractors; low-confidence facts are blocked; durable leased jobs recover after restart; staff can review boxes, boundaries and fields beside the page; a verified text-free raster pay statement and its provider-before-persist restart recovery pass in production | No completed protected human-labeled accuracy run spanning representative born-digital and scanned/raster inputs | Safe, reviewable evidence pipeline; hands-off accuracy remains unproven |
| Tax-package intelligence | Consent-gated durable processing, provider-use/revocation ordering, serialized final persistence, multi-form classification, non-overlapping excerpts capped at 25 pages, original-page evidence remapping, an independent serial tax worker, entity resolution, tie-outs, review triage and a borrower snapshot derived from the same result; a real provider-classified 100-page packet recovers across two production deployments and persists one exact grounded graph | Protected labeled accuracy across representative born-digital and scanned returns is not yet recorded | Strong complex-income logic with deployed capacity, recovery and one visual evidence model |
| Financial analysis | Borrower-specific self-employment and other-income review, evidence-gated non-taxable and continuance treatment, rental analysis, asset/liability review, append-only workpapers, cited memo and hashed lender package; reviewed pay, bank, lease, Schedule C, K-1 and Schedule L figures are frozen into the version and compared with the exact calculation input; mismatches require an officer explanation; 12/24-month bank-statement work requires a complete consecutive dated evidence period; the mixed W-2, Schedule C and two-rental canary is repeatable in production | Capital gains, asset depletion and known future income reduction remain manual; bank-statement eligibility and DSCR rules still require the selected lender's matrices; measured review accuracy on real files is absent | Strong controlled analysis with visible judgment; not yet a measured hands-off result |
| Underwriting | Deterministic rules, complete resolved-policy/input fingerprints, decision snapshots, tested DTI/pricing calculations, stale AUS/letter blocking, explicit program selection and manual-underwrite routing; fast intake uses a labeled preliminary conventional candidate while verified decisions require the URLA selection; conventional and VA paths are automated and product choice remains intact through options and letters | FHA, USDA and portfolio policy are not automated; external AUS and real credit are not live; no signed provider findings or lender acceptance has been received | Strong product-aware internal engine with current-evidence gates; incomplete program coverage and external decision chain |
| Delivery | Schema-valid multi-borrower MISMO 3.4, correctly scoped employment/declarations, immutable hashed MISMO, income and dual-AUS findings artifacts, readiness gates and condition tracking | No selected lender's receiver acceptance or correction round trip | Internally complete package builder; delivery remains externally unproven |
| External evidence | Plaid adapter and production guards exist; private object-storage read/write/delete and survival across a same-build process replacement are proven in production | Real credit, live AUS, current lender pricing and receiver acceptance are not proven | Blocks a real live lifecycle |

## What is structurally right

### Homi is kept outside the credit-decision path

Homi can read server-derived loan status, document work and next steps. It cannot turn a chat claim
into verified income or make an approval decision. Model failures fall back to labeled standard
guidance. This is the right role: help the borrower finish the file, explain what is happening and
route ambiguity to a person.

Better uses the same broad experience idea: its assistant reads the application and supports a
handoff to the loan team, while its underlying platform centralizes data and turns work into
tasks.[1][2] Homiquity should measure Homi on completed borrower work, fewer repeated questions and
faster human escalation rather than on message volume.

### Mortgage math is deterministic and evidence-gated

The underwriting engine, decision engine, rule engine, income paths and pricing calculations are
ordinary code with reproducible inputs. Decision snapshots include resolved policy. Complex-income
packages require an approved workpaper and memo, preserve document manifests and carry citations.
Simulated credit and AUS results are labeled and cannot quietly become verified evidence.

The latest audit found that the application-level verified flags could remain true after an OCR
fact or financial input changed. Binding routes now re-resolve the approved memo, income and asset
workpapers, and real credit evidence before using the VERIFIED qualifier. Expired, archived or
simulated credit does not qualify. Offers, borrower income, approval statuses, stage advancement,
Homi's borrower graph and the loan-officer decision controls use that same current-evidence answer.

Financial workpapers now fingerprint human review revisions and the effective numeric values, so
correcting an existing fact ID invalidates the old workpaper and memo. Human-reviewed pay-statement
income, bank balances, lease rent and supported Schedule C/K-1 figures are reconciled to the exact
structured value used by the calculation. A match is visible; a variance or unlinked document must
be acknowledged and explained by the reviewer. The system never silently replaces an application
or worksheet value with OCR output.

The current production build closes three additional evidence shortcuts. Business liquidity must match
reviewed Schedule L assets, liabilities and inventory. Every current/prior self-employment year in
the worksheet must match reviewed Schedule C net profit or K-1 ordinary income. Bank-statement
analysis requires reviewed deposit totals and start/end dates covering the complete selected 12 or
24 consecutive months before it can be saved or approved.

Fannie Mae's current Income Calculator reinforces this direction: self-employment and rental
analysis can be standardized, but user-entered data does not receive the same data-integrity relief
as approved-vendor transcript data in DU validation.[4][5] Homiquity therefore needs both correct
math and a stronger evidence chain.

### Program intent now survives the full internal decision chain

The application already stores conventional, FHA, VA or USDA as a separate answer from veteran
status. The previous engine ignored that answer: it selected VA for every veteran and conventional
for everyone else. The payment projection, same-payment offer cache and two preapproval-letter
fields repeated the inference. This could qualify an FHA offer on conventional rules or label a
veteran's conventional approval as VA.

The current release makes the evaluated program an explicit required engine input and includes the
selected value and selection basis in the decision fingerprint. A new fast application still gets
a preliminary conventional candidate because the short funnel deliberately does not ask a novice
borrower to choose a program. That candidate is labeled and cannot become a verified decision,
AUS submission, persisted loan option, pre-approval status/message or outward preapproval letter
until current evidence is verified and URLA contains the actual selection. Veteran
status is an eligibility signal only. Each loan-option offer is qualified and cached by both program
and payment, and the letter product comes from the approved policy result.

Only conventional purchase/fixed and a selected VA fixed-purchase residual screen are automated today. The engine rejects FHA,
USDA, jumbo, ARM, HELOC and unknown families from the automated path before resolving an unrelated
matrix. This follows the current policy-authority boundary: Fannie Mae publishes a separate
conventional eligibility structure, HUD identifies Handbook 4000.1 as its consolidated FHA source,
VA publishes Pamphlet 26-7 for VA underwriting, and USDA publishes HB-1-3555 for the guaranteed
program.[17][18][19][20] A policy family is not implemented by changing a label on conventional
math.

The same pass closed four adjacent integrity gaps. A rejected but otherwise priceable high-DTI
conventional file retains its PMI instead of showing a lower payment with MI removed. The policy
snapshot now captures the FICO floor, conforming limit, occupancy LTV cell, VA extra-member value
and code-level VA residual constants actually used. The maximum-purchase calculator no longer
reads mutable policy a second time or falls back to a hidden 43% DTI cap, and it does not extrapolate a VA maximum
with the conventional DTI formula. A below-floor score is no longer described as a borrower
strength. The evaluated program and its application-selected or preliminary-candidate basis are now
stored directly on each immutable decision snapshot, including unsupported-product reviews with no
resolved-policy object. VA runs do not load conventional DTI/LTV rules, and VA refinance or ARM
requests route to review before fixed-purchase pricing.

### The schema anticipates the right document model

The database already models uploads, pages, page classifications, logical documents, page-to-form
links, extracted fields, confidence, source page, bounding box, correction and reviewer. That is
close to the reference architecture described by current document platforms. Google recommends a
digitize → classify/split → extract workflow with page anchors and entity confidence; its mortgage
splitter example treats human review and threshold calibration as necessary controls.[6][7][8]
AWS Analyze Lending likewise runs an asynchronous split, classify and extract job with completion
notifications and a retrievable job result.[9][10]

The current production build implements this reference shape for ordinary and consented tax
documents: normalize, classify/split, specialized extraction and human review all retain the
original-page lineage. Tax fields without a valid source page are discarded. The remaining proof
gap is measured performance and error on a protected labeled set.

## Verified gaps

### P0 — in-flight production extraction recovery is proven for an ordinary document

**Built in the current production build:** the document version and extraction job commit together.
Workers claim due jobs with database row locks and expiring leases, heartbeat while working, retry
transient failures with bounded backoff, record terminal outcomes and recover abandoned claims.
The Core Systems staff view reports pending, processing, retry, failed and stale-lease counts. Pay
stubs, bank statements, leases and consented multi-form tax packages use this path. A real local
database test stopped the prior claimant, expired its lease and proved that a new worker reclaimed
the same job and recorded the terminal result.

**Production proof completed 2026-09-10:** workflow run
[`34427653700`](https://github.com/barakatammre84/homiquity-mortgage-broker/actions/runs/34427653700)
seeded the fixed borrower-free pay-statement job on exact build
`9267ad963e48853fce8a4259b13faef8960bb29a`. Attempt one completed the real provider read, validated
the expected values and page evidence, and entered `provider_read_complete` before any page, fact,
confidence or readiness persistence. Railway then replaced the process with deployment
`cef8b877-29f1-4683-944f-82caec441c2b` on the same exact commit. After the 30-second lease expired,
workflow run
[`34427794818`](https://github.com/barakatammre84/homiquity-mortgage-broker/actions/runs/34427794818)
caused the new process to reclaim the same job on attempt two, repeat the provider read and finish
through the normal persistence path. Verification found one page graph, one confidence row and ten
unique grounded facts, including the five required monetary facts. It then deleted every temporary
database row plus the source and derived private objects; the redacted recovery ledger remains.

The first implementation review found that a deliberate ten-minute hold could occupy the single
ordinary borrower worker. The released design excludes the fixed proof job from that worker and
uses a dedicated proof claimant that can select only the fixed job, so the canary cannot delay
borrower documents. This closes ordinary-document provider recovery. The two-deployment 100-page proof described
below closes tax-package capacity and interruption recovery; measured accuracy still waits on the
protected labeled evaluation path.

### P0 — uploads now split, route and retain page-level evidence

**Built in the current production build:** pay-stub, W-2, statement and lease extraction independently
classifies every source page from visible content in the same provider call. Validation requires
one taxonomy value for every consecutive page. The persistence gate compares the detected packet
to the borrower-selected upload type and blocks mislabeled, mixed or low-confidence packets before
their values enter readiness or the evidence graph. Staff sees the detected page ranges and the
reason for correction; the original bytes remain unchanged.

**Built in the current production build:** source PDFs and images are normalized into private PNG pages;
contiguous classification ranges become logical documents; supported pay-stub, W-2, statement and
lease segments are reassembled and sent to their specialized extractors; field evidence is remapped
to the original source page; and staff can correct boundaries before accepted logical facts enter
the borrower graph. The original upload remains unchanged and every derived page retains lineage.

**Built in the current production build:** the consented tax pipeline now requires a valid source page
for every retained field, normalizes the packet into private page images, links each logical tax
form to its exact page range and links each field to its cited page. Queue retries reuse the page
layer and links without duplicating logical documents.

**Mechanical capacity proof completed 2026-09-09:**
`DATABASE_URL="$(bash scripts/local-db.sh url)" pnpm tsx scripts/page-pipeline-benchmark.ts`
ran the application page pipeline over a synthetic 100-page tax packet. The final implementation
produced 100 readable private PNG pages and four exact 25-page logical documents in three repeated
runs of 6.8–7.2 seconds. Peak process RSS was 549–567 MB; the final run attributed 245.5 MB of that
increase to the page-processing interval. The original SHA-256 was unchanged, repeat calls reused
the result in 1 ms, and final cleanup removed every test row and object. Page and classification
rows plus logical-document links now persist in transactional batches instead of more than 200
sequential database round trips. The harness supplies ground-truth classifications, so this proves
normalization, persistence, segmentation, source immutability and idempotency only. Production
capacity still needs confirmation against the deployed container memory limit.

**Provider-input capacity proof completed 2026-09-10:**
`pnpm tsx scripts/tax-packet-excerpt-benchmark.ts` loaded one synthetic 100-page packet and emitted
four exact 25-page provider excerpts. The field-extraction page workload fell from 400 pages (the
whole source repeated for every form) to 100 pages. Original-page offsets were 0, 25, 50 and 75;
the source SHA-256 remained unchanged; the four excerpts were 3.17–3.26 MB; and the final run
completed in 36.6 seconds with 535.1 MB peak process RSS and a 375.2 MB increase during the excerpt
stage; the earlier warm run completed in 14.3 seconds at 517.6 MB peak RSS. Rendering is serial
while up to three provider calls may be in flight, so memory-heavy page
work remains bounded. Tax jobs also use a separate serial database lane, preventing a large return
from blocking pay stubs, W-2s, bank statements, leases or Autopilot. Provider-pass errors now fail
the durable job, and a valid response with missing or unreadable page evidence cannot receive a
hands-off confidence result. A security re-audit then found that model-selected overlapping or
oversized ranges could repeat raster work; every form excerpt is now limited to 25 pages and the
manifest must use non-overlapping source ranges before any field pass begins. This synthetic
Security review also found that revocation blocked final persistence without preventing a later
provider handoff from a job already in progress. Classification and each form extraction now hold
a shared borrower-consent fence for the full external call. Calls already dispatched finish before
revocation succeeds; after it succeeds, no later provider callback runs. This bounded protection
uses at most three database connections during concurrent form reads. This synthetic harness does
not measure provider accuracy, provider
latency, production memory or production cost.

**Exact-build release proof completed 2026-09-10:** PR #786 merged as
`0b3683911fcb243520c88fe4411148a212c35b70`; the main migration and deploy-verification workflow
passed and an independent public health request returned that exact commit. Codex Security scan
`138ee0b4-b861-4cce-97c6-281c23a36739` found two medium issues in the frozen pre-fix diff: consent
could be revoked between provider calls, and model-selected ranges could amplify raster work. The
release adds the shared consent-use fence, 25-page form cap and non-overlap validation; 48 focused
tests, 7 PostgreSQL consent/queue tests and the full release preflight passed. The post-deploy
borrower-data-free sweep passed Homi, pay-statement extraction, private storage, mixed-income
analysis and underwriting in 6.278 s, 11.060 s, 0.635 s, 0.009 s and 0.802 s on the exact build.

**Provider-classified production recovery proof completed 2026-09-10:** seed run
[`34501055138`](https://github.com/barakatammre84/homiquity-mortgage-broker/actions/runs/34501055138)
reached the deliberate provider-before-persist boundary on attempt one after 30 seconds. Railway
then replaced the process with deployment `47d11a62-d8ed-43f6-a22b-bd1d81165736` on the same exact
commit. Verify run
[`34501554301`](https://github.com/barakatammre84/homiquity-mortgage-broker/actions/runs/34501554301)
reclaimed attempt two, closed exactly one abandoned run, repeated the real provider reads, and
validated one graph with 100 pages, four non-overlapping forms, 28 facts, all 28 grounded and all
eight expected facts exact. Verification took 116.676 seconds and deleted every synthetic row and
private object. Remaining proof: grade representative born-digital and scanned/raster financial
fields against the protected human-labeled set.

Claude's PDF pipeline itself converts PDFs page by page and warns that dense or large files may
need splitting and normalization.[11] Citations can identify PDF page ranges when text is
extractable, but scanned image PDFs do not provide the same text-citation behavior.[12] Homiquity
must store its own page and image provenance rather than assuming the model response supplies it.

### P0 — confidence is not measured accuracy

The simple extractors return `high / medium / low`. Homiquity maps those labels to fixed numeric
values for every extracted field. That is a review-routing heuristic, not a calibrated probability.
Before this audit, one-click document approvals counted as “reviewed” in the accuracy threshold
even though no fields were graded. The staff screen also expected different response property
names and multiplied an already-percent value by 100.

**Built in the current production build:** the API and staff screen now share one contract; it reports
document reviews separately from field-graded reviews; a type with no graded fields is
`insufficient_reviews`; zero accuracy is preserved; and displayed accuracy uses the correct
percentage scale.

**Built in the current production build:** a versioned benchmark scorer grades exact values, missing
fields, false fields, document boundaries, original-page attribution and higher-impact mortgage
fields. Results are segmented by document type and complex-borrower situation. It refuses to mark a
synthetic dataset or a claimed segment with fewer than 30 human-labeled cases as eligible for a
production accuracy claim. Claim eligibility now also requires a private-manifest SHA-256 shared
by the labels and predictions, a versioned protocol, a unique opaque reviewer roster, two
independent reviewers recorded on every case, adjudication, non-empty critical truth, explicit
document and complex-situation scope, and pre-approved quality thresholds. Critical-field accuracy
is measured directly instead of being diluted inside an average, and production claim thresholds
cannot be set below Homiquity's 0.98 operating floor. A run must
meet every threshold overall and inside each claimed segment; sound evidence alone cannot turn
poor measured performance into an accuracy claim.

**Built:** the scorer now has an execution path. A local-only runner reads a
private manifest outside the public repository, checks user-only permissions, MIME signatures,
unique source and adjudicated-label hashes, source page counts and exact case identity before provider use.
It sends in-memory bytes through the production pay-stub, W-2, bank, lease and bounded multi-form
tax adapters without importing the product database. Provider calls and their case IDs are reserved
atomically before use, each case checkpoints privately, completed cases resume without another call,
restart cannot reset a per-case limit, concurrent runs cannot share one output directory, and the report
is claim-ineligible when the run, provider result or model/prompt/response-hash lineage is incomplete.
Raw provider responses, encrypted response payloads, document bytes, warnings and source paths are
never serialized by the runner. A strict preflight now rejects unknown label structure and fields the
selected extractor cannot emit, exposes all claim blockers, binds label and manifest hashes without
manual circular edits, and refuses provider use for a production-redacted dataset that could not
support a claim even with perfect predictions.

**Build next:** assemble the protected redacted dataset under the committed two-reviewer protocol,
freeze its acceptance targets, run the production adapters and calibrate product review-routing
thresholds from observed error and business impact. Never advertise an accuracy percentage
until the sample, model/prompt version and grading method are visible.

### P0 — source-level review now includes rendered evidence and boundary controls

**Built in the current production build:** ordinary extractors persist field values with confidence,
source page and normalized bounding box when available. The staff document panel opens the source
beside the fields, jumps to the cited page, records accept/reject/correction per field and keeps
document acceptance distinct from value verification. Human-reviewed facts survive re-extraction;
a low-confidence reread clears stale machine facts without overwriting reviewed values.

**Built in the current production build:** the staff viewer renders the exact normalized page and source
box, follows field selection to its page, and exposes page classification and boundary correction.
Rejected historical logical boundaries no longer leak facts into review or underwriting.

**Build next:** measure reviewer time and error on the labeled set, then add keyboard shortcuts only
where the observed review workflow shows repeated pointer work.

### P0 — runtime provider truth was missing

The public health endpoint proves the database, exact commit and email configuration. It did not
show Homi, extraction, private storage, Plaid, credit, DU, LPA, pricing or lender delivery. Staff
could not distinguish a configured adapter from a simulation or a contradictory environment.

**Built in the current production build:** Staff Dashboard → Intelligence → Core Systems now shows every
core capability as `live`, `simulated`, `disabled` or `configuration error`, without exposing
secrets. It refuses to mark the lifecycle ready while a critical leg is not live. It also shows
“not recorded” for last success rather than inventing proof from configuration. Production
demonstration extraction is an explicit configuration error and fails before any sample value can
enter a borrower file; the durable queue classifies it as permanent instead of wasting retries.

**Built in the current production build:** redacted Homi, extraction and object-storage canaries persist
provider, operation, environment, deployment SHA, timestamp, latency, outcome and failure class.
Core Systems treats configuration and a current successful canary as different facts and refuses a
ready lifecycle when required production proof is absent.

**Production proof completed 2026-09-09:** workflow run `34417872946` executed against exact build
`bd6a48cd31557528fdf68873a6fa605f80663fe6`. All five checks passed and retained redacted rows:
Homi provider response in 1.303 s, the real synthetic pay-statement extraction path in 10.790 s,
private storage write/read/delete in 0.588 s, mixed-income repeatability in 0.006 s and deterministic
underwriting repeatability in 0.749 s. The Homi check in that build is provider availability, not a
grounded application turn.

**Strengthened production proof completed 2026-09-10:** workflow run
[`34420267104`](https://github.com/barakatammre84/homiquity-mortgage-broker/actions/runs/34420267104)
passed all five checks against exact build `f84adce7ab153ca0c1a7426c9744bae0ceaa4aa9`:
grounded Homi status turn in 4.104 s, real synthetic pay-statement extraction in 10.112 s, private
storage write/read/delete in 0.591 s, mixed-income repeatability in 0.006 s and underwriting
repeatability in 0.787 s. The grounded turn uses the production prompt/context builder and real
status-tool schema, requires fixed server truth in the answer and passes outbound compliance lint.
It does not execute a tool or read a borrower record.

Workflow run
[`34420317049`](https://github.com/barakatammre84/homiquity-mortgage-broker/actions/runs/34420317049)
seeded a CRC-protected private marker. Railway replaced the running process with deployment
`599e3605-8694-4d64-a21d-796b51850dc5` on the same commit. Workflow run
[`34420451894`](https://github.com/barakatammre84/homiquity-mortgage-broker/actions/runs/34420451894)
then read, validated and deleted that marker from the new deployment 109.370 seconds after seed;
the storage operation took 0.382 s. A same deployment, changed commit, stale or malformed marker,
missing runtime identity or missing bytes fails closed. The post-restart sweep
[`34420484805`](https://github.com/barakatammre84/homiquity-mortgage-broker/actions/runs/34420484805)
again passed all five checks on the same commit in 4.079 s, 9.645 s, 0.483 s, 0.004 s and 0.552 s.
That `f84adce7` result closed generic private-object survival across process replacement. At that
point it did not show that an in-flight provider-backed extraction resumes or that a full 100-page
packet fits the production container; the next proof closes the ordinary-document recovery half.

**Provider-backed restart proof completed 2026-09-10:** the seed and verification runs above proved
that exact build `9267ad963e48853fce8a4259b13faef8960bb29a` can lose its process after a real
pay-statement provider result but before evidence persistence, then have a different deployment on
the same commit reclaim the expired job and commit one result. Verification completed in 23.019 s
after the lease became recoverable, found attempt count two, one page graph, one confidence row and
ten unique facts, and removed all temporary rows and private objects. Post-restart sweep
[`34427874922`](https://github.com/barakatammre84/homiquity-mortgage-broker/actions/runs/34427874922)
then passed all five core checks on the same commit: grounded Homi in 5.069 s, pay-statement
extraction in 11.393 s, private storage in 0.451 s, mixed-income repeatability in 0.005 s and
underwriting repeatability in 0.743 s. This closes interrupted ordinary-document recovery. The
provider-classified 100-page proof above closes the corresponding tax recovery gap; measured
extraction accuracy and external decision and lender paths remain open.

### P0 — decision freshness and final findings delivery are enforced internally

**Built in the current production build:** the deterministic decision, verified facts, current document
versions, verification reports, loan shape and resolved policy produce a canonical AUS input
fingerprint. Material change marks recorded AUS output stale and blocks packaging until rerun.
Pre-approval letters retain the decision and policy fingerprints and become unavailable when that
decision is no longer current. Out-of-scope cases take an explicit manual-underwrite path.

**Built in the current production build:** lender submission freezes the full current DU and LPA findings
as canonical JSON, hashes it independently, prevents package fields from later mutation and verifies
the digest before staff downloads it. A package cannot be created without both AUS legs and current
input lineage.

**Production proof still required:** retain the signed/provider-native findings and receiver
lineage, then prove invalidation and reproduction against the live path selected by the pilot lender.

### P0 — lender package completeness is internally built; receiver acceptance is not proven

The current production build creates a separate MISMO PARTY for every stored URLA borrower, uses the schema's
verified `Primary` and `Secondary` classifications, filters employment and declarations by borrower
sequence and includes each borrower's audited taxpayer identifier. The official committed XSD passes
for both underwriting and loan-delivery shapes with multiple borrowers. The lender-submission row
freezes and hashes MISMO XML, income analysis and final dual-AUS findings; all three are reviewable.
Structural validation still does not substitute for one lender's receiver rules.

**External proof required:** select the pilot lender, run its current edits, send one synthetic
complex file to its test receiver and record acknowledgement, corrections and the accepted hashes.
Fannie publishes current DU integration and testing resources, but access and acceptance still
require the relevant onboarding path.[13]

### P1 — complex-income coverage has correctly blocked holes

Capital gains are detected but do not produce qualifying income. Evidence-gated non-taxable
treatment and continuance tests are implemented. Asset depletion and known future income reduction
remain manual. DSCR and bank-statement eligibility still require the selected lender's matrices;
the system can calculate a cited bank-statement method but always requires human review. These are
real product gaps, and the remaining formulas must come from governing policy and the selected
lender rather than model memory or marketing pages.

**Build after authority arrives:** procure the current agency chapters and the pilot lender's
program matrices; add a citation-ledger entry; capture any missing dates or history; implement one
path at a time; prove it with golden cases and a licensed review.

### P1 — Homi has a mortgage regression loop; production outcomes remain unmeasured

**Built in the current production build:** a redacted mortgage-specific scenario suite covers missing
documents, changed evidence, mixed income, human escalation, stale conversation memory and
prohibited claims. Prompt-attack tests treat borrower chat and document-derived text as untrusted.
Homi uses current server state in preference to conversation memory, cannot invent application
status, document requests, qualifying income, timelines or score improvements, and cannot change a
decision. The 2026-09-09 live-model run passed all 12 scenarios: tool triggering 5/5, restraint
2/2, grounding 3/3, honest-gap handling 1/1 and prompt-injection resistance 1/1.

**Built in this release:** Homi refreshes the borrower-visible readiness panel after a successful
chat capture from a second server file snapshot, then records that exact before/after state. It
separates server-truth reads from assistant-only tools, records actual saved-field counts, failed
turns, exact repeated wording, bounded response latency and degraded/lint-replaced turns.
`request_human_help` creates or reuses a real loan-officer task and will not claim success until
that write succeeds. The staff report measures the first secure staff message to the same borrower
and file while the request is open; task completion is no longer mislabeled as a human response.

**Corrected in the 2026-09-10 re-audit:** failed-turn users could previously pad the 10-borrower
floor, the shared authenticated Homi launcher allowed staff turns into the borrower report, legacy
rows could enter the current exact-repeat rate and one later staff message could count against
multiple historical handoffs. The borrower floor now counts only client-role people with a current
turn and two valid server snapshots; staff and unknown-role attempts are excluded and reported
separately. Staff messages are consumed one-to-one, and messages after task completion do not
retroactively become evidence of a response. The staff UI calls the metric a post-request message
because timing does not prove that its content answered the Homi request.

**Built in this release:** `get_document_evidence` re-authorizes the current workable application,
then reads only current, non-rejected documents and a bounded allowlist of server-persisted numeric
facts. It includes Schedule C, Schedule E, W-2/pay-stub, bank and lease evidence while excluding raw
OCR, filenames, account identifiers, taxpayer identifiers, borrower descriptions, reviewer notes
and reviewer identities. Document acceptance and field verification remain separate states; only
an individually confirmed or corrected field is called human verified, and only a current approved
financial memo/workpaper set is called approved for lender presentation. A live Sonnet trigger and
grounding run called the new tool, repeated the synthetic mixed-income figures with their exact
review labels, avoided an unnecessary application-status call after prompt refinement, and routed
medium-confidence evidence to staff review without asking the borrower to upload the document
again.

The first security review found that the response cap was applied after the extracted-field read
and that repeated model tool calls reloaded the same file. The corrected path selects at most the
12 newest current documents before querying their facts, reuses document evidence and shared file
truth within the turn, and invalidates affected caches after a successful write. The exact
post-fix diff security review found no reportable issue. A second product pass found that the tool
did not tell the model when older documents fell outside the bounded window; the response now
states the omitted count and forbids treating an unlisted document as absent. Receipt questions
route to the real checklist. The post-fix live Sonnet grounding run again called the evidence tool
and repeated all four synthetic mixed-income figures with the correct review labels and no
approval claim.

**Production proof still required:** collect at least 30 current-format turns across 10 eligible
borrowers as an instrumentation pilot. Then approve the treatment, register the assignment and
analysis before enrollment, calculate the sample from the baseline and run the comparison described
in the [Homi outcome protocol](HOMI_OUTCOME_STUDY_2026-09-10.md). Phone calls and work outside secure
Messages need an explicit disposition because the current report cannot see them. A regression
pass, the 30/10 pilot and an observational dashboard prove operability; none proves that borrowers
finish faster. NIST calls for documented evaluation under deployment-like conditions, uncertainty,
benchmark comparison and human oversight.[15] Controlled-experiment literature also treats power
and sample size as inputs to the study design.[16]

## Build order and exit gates

### 1. Make document work durable and observable

- Keep the deployed durable extraction jobs, independent ordinary/tax lanes, lease recovery and
  failure queue under observation.
- Keep both completed interruption proofs current: the ordinary pay statement and the
  provider-classified 100-page multi-form tax package.
- Keep the exact-build provider and storage canaries current with latency and failure class.

**Durability exit met 2026-09-10:** both the ordinary pay-statement path and the provider-classified
100-page multi-form tax path reached validated provider output before persistence, lost the process,
then produced one complete evidence result on attempt two with no duplicate facts, runs, confidence
or page rows. The tax proof also removed every synthetic object and row.

### 2. Calibrate the page and field evidence model

- Ordinary document normalization, logical routing, box review and boundary correction are built.
- Bring consented tax forms onto the same rendered evidence model.
- Populate and run the versioned human-graded evaluation set through the protected evaluator.

**Exit:** a mixed 100-page complex-income packet becomes the correct logical documents; every used
value opens its source page; uncertain fields route to review; replacement and correction preserve
lineage.

### 3. Prove decision delivery against a live path

- Multi-borrower MISMO and durable final findings are built and XSD-tested.
- Run live-path invalidation, provider-artifact retention and reproducibility proof.

**Exit:** change a material fact and watch the prior decision, letter and package become unusable
until rerun; restore the fact and reproduce the same policy fingerprint and output.

### 4. Activate one real lender stack

- Keep the proven production private-storage restart check current.
- Real credit and selected verification paths.
- Current approved rate sheet with provenance.
- DU/LPA path required by the pilot lender.
- Real receiver acceptance.

**Exit:** the chosen lender accepts one synthetic complex package, then funds one controlled real
file with no off-platform rekeying left undocumented.

### 5. Prove Homi from measured friction

- Keep the grounded production canary ledger current.
- Collect at least 30 server-measured turns across 10 borrowers and define the comparison cohort in
  advance. Treat exact repeated wording as a narrow signal, not semantic question resolution.
- Measure persisted completion movement, failed turns, handoff work and the first recorded staff
  message after a request; disposition phone and off-platform work explicitly.
- Add guidance only where a journey metric shows a problem.

**Exit:** Homi materially reduces borrower or staff effort without increasing incorrect claims,
missed escalation or time to a useful human response.

## Changes made during this audit

1. Corrected the extraction-accuracy API and staff-screen contract.
2. Separated document approvals from field-graded accuracy evidence.
3. Prevented ungraded document reviews from producing a false green drift status.
4. Added an authenticated Core Systems view for live, simulated, disabled and invalid provider
   states.
5. Corrected stale handbook references to the former OpenAI/Gemini architecture.
6. Reordered the CTO roadmap around durable evidence, decision freshness and one accepted lender
   package.
7. Added atomic extraction jobs with leased claims, retry policy, restart recovery and staff queue
   health.
8. Replaced the duplicate quick tax read with the consent-gated multi-form package analyzer; the
   borrower snapshot, entity resolution and situation profile now derive from the same persisted
   form-level result.
9. Serialized tax-consent revocation with final persistence so a background worker cannot recreate
   a derived signal after the borrower revokes permission; kept bank-statement analysis outside
   that unrelated tax-consent gate.
10. Added independent per-page classification for ordinary documents and blocked mislabeled,
    mixed or uncertain packets from creating facts or readiness credit.
11. Added page/box evidence and a staff field-review workbench that preserves reviewed facts across
    re-extraction.
12. Fingerprinted decision, evidence and policy inputs; blocked stale AUS packages and letters; and
    added an explicit manual-underwrite path.
13. Added mortgage-specific Homi regression and prompt-attack cases with current server state as
    the only authority for file status and next work.
14. Made document status, confidence, field facts and readiness one atomic persistence unit, with a
    real-database commit and rollback proof.
15. Blocked deterministic extraction simulation in production and surfaced the invalid setting in
    Core Systems and durable-job outcomes.
16. Removed Homi wording that described machine-read uploads as verified or highest-quality
    evidence; qualifying figures now point to human-reviewed workpapers.
17. Limited tax-consent revocation cleanup to tax-derived review tasks, preserving independent
    business-income, rental and bank-statement work.
18. Removed the hidden 500-file cap from the admin “all applications” query so platform oversight
    cannot omit an older active file that remains visible to its assigned loan officer.
19. Added an append-only provider-canary ledger and a Core Systems view that separates configured
    capability from current operational proof.
20. Normalized source pages into private PNGs, created logical documents with original-upload
    lineage, rendered exact field boxes and added staff boundary correction.
21. Added privacy-bounded W-2 extraction with source evidence and consistency validation; W-2 Box 1
    remains document evidence and never becomes qualifying income by itself.
22. Routed mixed pay-stub, W-2, statement and lease packet segments to specialized extractors and
    remapped their evidence to original source pages.
23. Connected Homi's human-help tool to real loan-officer tasks and added completion, repetition,
    handoff and response-time outcome measures.
24. Delivered every URLA borrower as a separate schema-valid MISMO party with borrower-scoped
    employment, declarations and taxpayer identifiers.
25. Added immutable, canonical and hash-verifiable final DU/LPA findings to each lender package,
    with verified staff download.
26. Added a versioned extraction benchmark for value precision/recall, omissions, false fields,
    source pages, boundaries and complex-borrower segments, with honest claim-eligibility gates.
27. Removed the unused browser endpoint that returned a decrypted taxpayer identifier; readiness
    now assembles masked/presence data, while full taxpayer and account identifiers exist only in
    the purpose-bound lender-delivery path after a blocking audit write.
28. Bounded provider canaries at 30 seconds and record timeout as an operational failure instead of
    leaving the staff control surface waiting indefinitely.
29. Made MISMO and final underwriting-artifact access logs fail closed, so sensitive package bytes
    are never released when the audit store cannot record who accessed them.
30. Bound extraction accuracy claims to an immutable private dataset manifest, independently
    reviewed and adjudicated labels, explicit complex-borrower scope, sufficient segment coverage
    and pre-approved thresholds that the measured run must actually pass.
31. Added and passed a repeatable 100-page application-pipeline proof for normalization, private
    derived pages, logical boundaries, immutable source bytes, idempotent retry and cleanup, while
    explicitly excluding model accuracy and cloud durability from that result.
32. Linked financial workpapers and credit-memo document references directly to the existing
    evidence viewer, including the first cited normalized page, so an officer can inspect the
    source without leaving the review and searching the document list.
33. Replaced the large-packet persistence loop's per-page database calls with transactional batch
    writes for pages, classifications, logical documents and page links; repeated 100-page runs
    retained exact counts and boundaries while completing in 6.8–7.2 seconds.
34. Added one scheduled and manually dispatchable borrower-data-free sweep for Homi, document
    extraction, private object storage, mixed-income analysis and deterministic underwriting. It
    runs all five bounded canaries, preserves each
    redacted result even when a sibling fails, binds rows to the deployed commit and returns a
    failing HTTP status whenever production proof is incomplete so the scheduler cannot show
    green for an unhealthy core capability.
35. Made failed scheduled canaries print only their safe per-capability status, latency, failure
    class and commit before the workflow fails. The state-changing POST runs once without curl
    retries, so an ambiguous timeout cannot duplicate provider calls or ledger rows and a red run
    now identifies the capability that needs repair without exposing its prompt or response.
36. Proved all five canaries on production build `bd6a48cd` and retained their exact-build status,
    operation and latency without storing prompts, model output, extracted values or policy inputs.
37. In the current production build, replaced Homi's availability-only token check with a fixed synthetic
    status turn through the real prompt/context builder, server-truth tool schema, grounded reply
    and outbound lint rail; no tool executor or borrower record is touched.
38. Rejected a proposed low-effort ordinary-document optimization after the four-type check caught
    missing required W-2 and bank-statement source evidence. The validation layer failed both reads
    closed and the production inference settings remain unchanged. Extraction speed work now waits
    for the protected multi-document evaluation set so latency cannot be bought with silent accuracy
    or traceability loss.
39. In the current production build, added a controlled private-storage restart proof: one fixed private
    synthetic marker must be read by a different Railway deployment running the same commit within
    one hour, then is deleted. A same-process check, changed commit, stale marker, malformed marker
    or missing runtime identity fails closed and cannot be reported as durability evidence.
40. Proved the strengthened five-capability sweep on exact production build `f84adce7`: all five
    checks passed before and after a controlled same-build Railway process replacement. The
    two-phase private marker was CRC-validated by the new deployment after 109.370 seconds and then
    deleted. That result closed generic private-object restart durability; at that point it left
    in-flight extraction recovery, production large-packet capacity, measured extraction accuracy
    and external mortgage provider/lender acceptance open.
41. Proved in-flight provider recovery on exact production build `9267ad96`: attempt one completed
    the real synthetic pay-statement provider read and stopped before persistence; a different
    Railway deployment on the same commit reclaimed the expired job on attempt two and persisted
    exactly one page graph, one confidence row and ten unique grounded facts. The proof then deleted
    every temporary database row and private object. A dedicated fixed-job claimant and explicit
    exclusion from the borrower worker removed the ten-minute canary hold as a borrower-throughput
    bottleneck. The post-restart five-capability sweep passed; tax-package capacity, labeled model
    accuracy and external mortgage provider/lender acceptance remain open.
42. Loaded each tax source once and replaced repeated full-packet field calls with exact classified
    non-overlapping page excerpts of at most 25 pages, preserving original-page evidence while reducing the synthetic 100-page
    field-pass workload from 400 pages to 100.
43. Separated tax-package and ordinary extraction workers so a complex return cannot delay normal
    borrower documents; proved both lane selectors against Postgres while keeping each paid lane
    serial.
44. Made per-form provider failures fail the durable tax job and forced incomplete page-backed
    evidence into human review instead of allowing an empty analysis to look complete.
45. Closed the tax-consent provider race with a shared borrower fence around classification and
    every form extraction. Revocation waits for already-dispatched calls, then prevents every later
    external use as well as final persistence.
46. Released the bounded tax-packet architecture as production commit `0b368391`; exact health,
    the main deploy gate and all five core capability canaries passed on that build. The remaining
    tax claim is protected human-labeled accuracy across representative born-digital
    and scanned/raster returns.

47. Added a two-deployment production proof for the full 100-page tax path. Attempt one completes
    real classification and four form reads, validates eight exact grounded facts and stops before
    evidence persistence; a same-commit replacement deployment must reclaim attempt two, close one
    abandoned run, persist one exact evidence graph and clean the fixed private synthetic fixture.
48. Hardened verification after adversarial review: the seed deployment is rejected before a worker
    can start or cleanup can run, and the one-hour proof age is measured after completion polling.
    Exact production commit `e6ae28ae` passed the proof with 100 pages, four forms and 28 grounded
    facts, followed by a 5/5 core-capability sweep.
49. Replaced the ordinary canary's embedded-text fixture with a verified one-page raster PDF. A
    Linux font-rendering defect was exposed by three failed production sweeps, fixed with versioned
    font assets and pre-provider pixel guards, then proven by a 5/5 live sweep and a same-commit
    restart that persisted one page and ten grounded facts before complete cleanup.
50. Added the missing protected-evaluation runner around the production extractors: private paths
    and permissions, source/label/manifest hashes, MIME and page-count checks, bounded call budgets,
    atomic pre-call reservations, resumable strict checkpoints, explicit production lineage and an
    aggregate-only report. Building this execution rail does not supply the independently reviewed
    document population or establish an accuracy result.
51. Replaced Homi's optimistic outcome counters with evidence-bounded measures. Successful chat
    capture now refreshes the visible readiness panel from the saved server file; completion deltas
    use the same before/after snapshots, failed turns are counted, assistant-only tools no longer
    count as grounded file use, and a human response means a later staff message to the same
    borrower and file rather than task completion. The staff view shows coverage, sample floors and
    the comparison-cohort blocker, so it cannot present observed activity as proof that Homi caused
    less friction.
52. Connected Homi to bounded server-written document evidence. The tool re-authorizes the workable
    file, exposes only allowlisted numeric OCR/tax facts, distinguishes machine-read values from
    human-verified fields and current approved workpapers, excludes raw text and identifiers, and
    prevents OCR uncertainty from becoming an unnecessary borrower re-upload request. A follow-up
    audit bounded fact reads before the query, cached read-only snapshots within one turn, invalidated
    them after writes and made omitted documents explicit so Homi cannot confuse a bounded response
    with a complete file inventory.
53. Made financial-review versions depend on effective human-reviewed numeric facts and every fact's
    review revision. A correction on the same extracted-field row now invalidates the workpaper and
    credit memo instead of leaving approved dollars current.
54. Added document-to-calculation checks for pay-statement income, bank balances, lease rent and
    supported Schedule C/K-1 worksheet fields. Variances and ambiguous links require an explicit
    officer acknowledgment and explanation, enforced by the server. Added the missing staff surface
    for append-only bank-statement deposit screening without treating OCR deposit totals as eligible
    income.
54a. Required business liquidity to match reviewed Schedule L current assets, liabilities and
    inventory; required every self-employment year to match reviewed Schedule C or K-1 income; and
    required a complete reviewed, dated, consecutive 12/24-month statement period before bank
    analysis can be saved or approved.
55. Replaced sticky VERIFIED decisions with a current-evidence proof across underwriting, offers,
    borrower income, approval transitions, pipeline advancement, the borrower graph, loan options
    and loan-officer controls. The proof requires current approved financial artifacts and a
    completed, unexpired, unarchived, non-simulated bureau report.
56. Re-audited every remaining verification display and income-loader seam. Borrower, staff and
    Homi income/asset/credit states now use the same current-evidence dimensions, stale profile
    evidence is labeled for refresh, and the generic income loader cannot apply positive rental
    income unless its caller explicitly opts in after resolving decision-grade proof.
57. Re-audited the protected extraction evaluator before collecting borrower data. Closed the
    vacuous-pass path where empty labels scored as perfect, added a separate critical-field metric
    and a 0.98 production-claim floor, required an opaque reviewer roster plus two reviewers on every
    case, rejected truth the selected extractor cannot emit, exposed claim blockers in dry-run and
    stopped provider spend when a production dataset is not claim-ready. Added a versioned labeling
    protocol, private-workspace templates and a guarded command that binds labels to the manifest
    without error-prone circular hash edits. The remaining evidence gap is still external: populate
    the protected corpus with representative reviewed documents and run it.
58. Re-audited Homi's outcome measurement before treating its first production cohort as evidence.
    Failed or legacy-only users no longer satisfy the eligible-borrower floor, staff and unknown-role
    turns are excluded from borrower evidence, legacy repeat flags no longer enter the current repeat
    rate, and each secure staff message can match at most one still-open Homi handoff. The staff
    screen now distinguishes a timed post-request message from a proven answer and states that 30
    turns/10 borrowers validates instrumentation rather than a treatment effect. The comparison
    study remains deliberately unregistered until the founder approves the exact proactive-invitation
    experience; the operating protocol freezes the required population, assignment, outcomes, power
    analysis and stop rules before enrollment.
59. Re-audited underwriting program integrity from application selection through payment projection,
    scenario qualification, decision snapshots and preapproval letters. Removed the veteran-status
    program override, keyed offer qualification by program plus payment, failed unsupported programs
    to human review, completed the policy fingerprint values used by the engine and removed the
    hidden DTI-policy fallback. A rejected but priceable conventional file now retains its PMI, and
    VA approvals are no longer extrapolated through conventional maximum-purchase math. Internal
    tests prove these paths; live provider findings and lender acceptance remain external gates.
60. Repeated the underwriting audit against the borrower-visible state and adjacent product seams.
    A self-reported preliminary candidate can no longer set `pre_approved`, persist issued options or
    send pre-approval messages; it produces a clearly labeled preliminary plan and evidence checklist.
    Changed facts remove stale approval amounts/options and return the file to review without an
    automated denial. Decision history now stores program and selection basis directly. VA policy is
    isolated from conventional scalars, VA refinance/ARM routes before fixed-purchase pricing, a
    non-veteran VA-only filter remains empty instead of becoming all products, and conventional-only
    veteran scenarios no longer ask for VA residual fields. Non-rate-locked pre-approval letters
    omit a payment estimate that could use a different amount basis, and Loan Estimates name the
    product whose payment was priced.

## Sources

1. [Better — Betsy AI mortgage assistant](https://better.com/betsy)
2. [Better — AI in mortgage lending and the Tinman platform](https://better.com/content/ai-mortgage-lending)
3. [Better — One Day Mortgage terms and evidence conditions](https://better.com/with/one-day-mortgage-terms)
4. [Fannie Mae — Income Calculator](https://singlefamily.fanniemae.com/applications-technology/income-calculator)
5. [Fannie Mae — Income Calculator frequently asked questions](https://singlefamily.fanniemae.com/media/45221/display)
6. [Google Cloud — Document AI overview](https://docs.cloud.google.com/document-ai/docs/overview)
7. [Google Cloud — Splitters](https://docs.cloud.google.com/document-ai/docs/splitters?hl=en)
8. [Google Cloud — Custom splitter](https://docs.cloud.google.com/document-ai/docs/custom-splitter)
9. [AWS — Lending document classification and extraction](https://docs.aws.amazon.com/textract/latest/dg/lending-document-classification-extraction.html)
10. [AWS — Asynchronous Analyze Lending workflow](https://docs.aws.amazon.com/textract/latest/dg/async-using-lending.html)
11. [Anthropic — PDF support](https://docs.anthropic.com/en/docs/build-with-claude/pdf-support)
12. [Anthropic — Citations](https://docs.anthropic.com/en/docs/build-with-claude/citations)
13. [Fannie Mae — Technology integration resources](https://singlefamily.fanniemae.com/technology-integration/technology-integration-resources)
14. [Anthropic — Mitigate jailbreaks and prompt injections](https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)
15. [NIST — AI Risk Management Framework core](https://airc.nist.gov/airmf-resources/airmf/5-sec-core/)
16. [Kohavi et al. — Controlled experiments on the web](https://link.springer.com/article/10.1007/s10618-008-0114-1)
17. [Fannie Mae — Mortgage eligibility](https://selling-guide.fanniemae.com/sel/b2-1/mortgage-eligibility)
18. [HUD — FHA Single Family Housing Policy Handbook 4000.1](https://www.hud.gov/hud-partners/single-family-handbook-4000-1)
19. [U.S. Department of Veterans Affairs — VA Lenders Handbook, Pamphlet 26-7](https://www.benefits.va.gov/WARMS/docs/admin26/m26-07/Lender_Handbook_VA_Pamphlet_Complete.pdf)
20. [USDA Rural Development — HB-1-3555, Guaranteed Loan Program](https://www.rd.usda.gov/media/file/download/hb-1-3555-consolidated.pdf)
