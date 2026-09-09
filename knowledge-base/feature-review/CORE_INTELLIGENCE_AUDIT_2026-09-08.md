# Core intelligence audit — Homi, documents, financial analysis and underwriting

**Evidence date:** 2026-09-09

**Code reviewed:** production `bd6a48cd31557528fdf68873a6fa605f80663fe6` plus the current release candidate

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
focused journey tests, real local HTTP flow and database restart-recovery proof pass. The result
proves strong internal behavior; it does not prove any external provider or lender receiver.

## Verdict

Homiquity has a sound core architecture and a credible advantage for complex borrowers. AI does
not decide mortgage eligibility. The underwriting and income engines are deterministic, the file
distinguishes evidence levels, complex-income figures require workpapers and human approval, and
the lender package carries citations and hashes.

The product is not yet an end-to-end live mortgage platform. The current release candidate closes
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

The release candidate also closes the internal decision-delivery gaps: every URLA borrower becomes
a separate schema-valid MISMO party with correctly attributed employment and declarations, and the
submitted package retains hash-verifiable MISMO, income-analysis and dual-AUS findings artifacts.
Accuracy calibration, production provider evidence and a real lender receiver remain open. Credit,
DU, LPA, executable pricing provenance and lender delivery remain simulated or unproven.

Better demonstrates the experience standard: one central file, tasks generated from the file,
24-hour help and a fast underwriting promise after the required evidence arrives.[1][2][3] Its
published fast-underwriting terms also exclude or condition many self-employed and rental-income
cases.[3] Homiquity should copy the continuity and speed pattern, then win on evidence-rich review
for the borrowers that a standardized fast lane handles poorly.

## Capability reality map

| Capability | What works now | Main gap | Assessment |
|---|---|---|---|
| Homi | Server-grounded tools, prompt lineage, PII input guard, bounded turns, streaming, safe offline guidance, real staff-task handoff, outcome measures, provider canary ledger, a successful production provider proof and a mortgage regression/attack suite | The provider canary does not yet run a grounded Homi status turn; measured reduction in completion time, repeated questions and handoff latency is not yet recorded | Strong assistant foundation; production availability is proven while production usefulness remains unmeasured |
| Simple document extraction | Claude reads pay stubs, W-2s, bank statements and leases; every page is classified and normalized; mixed packets become logical documents routed to specialized extractors; low-confidence facts are blocked; durable leased jobs recover after restart; staff can review boxes, boundaries and fields beside the page; the real synthetic pay-statement path passes in production | No human-labeled production accuracy set | Safe, reviewable evidence pipeline; hands-off accuracy remains unproven |
| Tax-package intelligence | Consent-gated durable processing, serialized revocation/final persistence, multi-form classification, normalized private pages, field-level source-page evidence, logical page links, entity resolution, tie-outs, review triage and a borrower snapshot derived from the same result; the mechanical 100-page pipeline proof passes | A representative provider-classified 100-page packet, production model canary and controlled production restart are not yet recorded | Strong complex-income logic with one visual evidence model |
| Financial analysis | Self-employment worksheets, rental treatment, reconciliations, review checkpoints, cited memo and hashed lender package; the mixed W-2, Schedule C and two-rental canary is repeatable in production | Capital gains, non-taxable gross-up, continuance and asset depletion wait on governing agency references; bank-statement and DSCR math wait on lender matrices | Strong and appropriately conservative |
| Underwriting | Deterministic rules, policy/input fingerprints, decision snapshots, evidence gates, tested DTI/pricing calculations, stale AUS/letter blocking, an explicit manual-underwrite path and simulation labels; a fixed conventional file produces byte-identical results against deployed policy rows | External AUS is not live and no signed provider findings have been received | Strong internal engine, incomplete external decision chain |
| Delivery | Schema-valid multi-borrower MISMO 3.4, correctly scoped employment/declarations, immutable hashed MISMO, income and dual-AUS findings artifacts, readiness gates and condition tracking | No selected lender's receiver acceptance or correction round trip | Internally complete package builder; delivery remains externally unproven |
| External evidence | Plaid adapter and production guards exist | Production storage durability, real credit, live AUS, current lender pricing and receiver acceptance are not proven | Blocks a real live lifecycle |

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

Fannie Mae's current Income Calculator reinforces this direction: self-employment and rental
analysis can be standardized, but user-entered data does not receive the same data-integrity relief
as approved-vendor transcript data in DU validation.[4][5] Homiquity therefore needs both correct
math and a stronger evidence chain.

### The schema anticipates the right document model

The database already models uploads, pages, page classifications, logical documents, page-to-form
links, extracted fields, confidence, source page, bounding box, correction and reviewer. That is
close to the reference architecture described by current document platforms. Google recommends a
digitize → classify/split → extract workflow with page anchors and entity confidence; its mortgage
splitter example treats human review and threshold calibration as necessary controls.[6][7][8]
AWS Analyze Lending likewise runs an asynchronous split, classify and extract job with completion
notifications and a retrievable job result.[9][10]

The release candidate now implements this reference shape for ordinary and consented tax
documents: normalize, classify/split, specialized extraction and human review all retain the
original-page lineage. Tax fields without a valid source page are discarded. The remaining proof
gap is measured performance and error on a protected labeled set.

## Verified gaps

### P0 — document work can be lost after the upload succeeds

**Fixed in this release candidate:** the document version and extraction job commit together.
Workers claim due jobs with database row locks and expiring leases, heartbeat while working, retry
transient failures with bounded backoff, record terminal outcomes and recover abandoned claims.
The Core Systems staff view reports pending, processing, retry, failed and stale-lease counts. Pay
stubs, bank statements, leases and consented multi-form tax packages use this path. A real local
database test stopped the prior claimant, expired its lease and proved that a new worker reclaimed
the same job and recorded the terminal result.

**Production proof still required:** interrupt one controlled provider-backed extraction during a
deployment, verify that the next production worker resumes it, and inspect the single resulting
fact set and confidence record.

### P0 — uploads now split, route and retain page-level evidence

**Fixed in this release candidate:** pay-stub, W-2, statement and lease extraction independently
classifies every source page from visible content in the same provider call. Validation requires
one taxonomy value for every consecutive page. The persistence gate compares the detected packet
to the borrower-selected upload type and blocks mislabeled, mixed or low-confidence packets before
their values enter readiness or the evidence graph. Staff sees the detected page ranges and the
reason for correction; the original bytes remain unchanged.

**Fixed in this release candidate:** source PDFs and images are normalized into private PNG pages;
contiguous classification ranges become logical documents; supported pay-stub, W-2, statement and
lease segments are reassembled and sent to their specialized extractors; field evidence is remapped
to the original source page; and staff can correct boundaries before accepted logical facts enter
the borrower graph. The original upload remains unchanged and every derived page retains lineage.

**Fixed in this release candidate:** the consented tax pipeline now requires a valid source page
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

**Production proof still required:** run a representative provider-classified 100-page packet,
grade its financial fields against the protected labeled set, and interrupt/restart the production
worker while retaining one result and durable cloud pages.

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

**Fixed in this release candidate:** the API and staff screen now share one contract; it reports
document reviews separately from field-graded reviews; a type with no graded fields is
`insufficient_reviews`; zero accuracy is preserved; and displayed accuracy uses the correct
percentage scale.

**Fixed in this release candidate:** a versioned benchmark scorer grades exact values, missing
fields, false fields, document boundaries, original-page attribution and higher-impact mortgage
fields. Results are segmented by document type and complex-borrower situation. It refuses to mark a
synthetic dataset or a claimed segment with fewer than 30 human-labeled cases as eligible for a
production accuracy claim. Claim eligibility now also requires a private-manifest SHA-256 shared
by the labels and predictions, a versioned protocol, two independent reviewers, adjudication,
explicit document and complex-situation scope, and pre-approved quality thresholds. A run must
meet every threshold overall and inside each claimed segment; sound evidence alone cannot turn
poor measured performance into an accuracy claim.

**Build next:** assemble the protected redacted dataset, run the production model and calibrate
review thresholds from observed error and business impact. Never advertise an accuracy percentage
until the sample, model/prompt version and grading method are visible.

### P0 — source-level review now includes rendered evidence and boundary controls

**Fixed in this release candidate:** ordinary extractors persist field values with confidence,
source page and normalized bounding box when available. The staff document panel opens the source
beside the fields, jumps to the cited page, records accept/reject/correction per field and keeps
document acceptance distinct from value verification. Human-reviewed facts survive re-extraction;
a low-confidence reread clears stale machine facts without overwriting reviewed values.

**Fixed in this release candidate:** the staff viewer renders the exact normalized page and source
box, follows field selection to its page, and exposes page classification and boundary correction.
Rejected historical logical boundaries no longer leak facts into review or underwriting.

**Build next:** measure reviewer time and error on the labeled set, then add keyboard shortcuts only
where the observed review workflow shows repeated pointer work.

### P0 — runtime provider truth was missing

The public health endpoint proves the database, exact commit and email configuration. It did not
show Homi, extraction, private storage, Plaid, credit, DU, LPA, pricing or lender delivery. Staff
could not distinguish a configured adapter from a simulation or a contradictory environment.

**Fixed in this release candidate:** Staff Dashboard → Intelligence → Core Systems now shows every
core capability as `live`, `simulated`, `disabled` or `configuration error`, without exposing
secrets. It refuses to mark the lifecycle ready while a critical leg is not live. It also shows
“not recorded” for last success rather than inventing proof from configuration. Production
demonstration extraction is an explicit configuration error and fails before any sample value can
enter a borrower file; the durable queue classifies it as permanent instead of wasting retries.

**Fixed in this release candidate:** redacted Homi, extraction and object-storage canaries persist
provider, operation, environment, deployment SHA, timestamp, latency, outcome and failure class.
Core Systems treats configuration and a current successful canary as different facts and refuses a
ready lifecycle when required production proof is absent.

**Production proof completed 2026-09-09:** workflow run `34417872946` executed against exact build
`bd6a48cd31557528fdf68873a6fa605f80663fe6`. All five checks passed and retained redacted rows:
Homi provider response in 1.303 s, the real synthetic pay-statement extraction path in 10.790 s,
private storage write/read/delete in 0.588 s, mixed-income repeatability in 0.006 s and deterministic
underwriting repeatability in 0.749 s. The Homi check in that build is provider availability, not a
grounded application turn; the current candidate closes that distinction.

### P0 — decision freshness and final findings delivery are enforced internally

**Fixed in this release candidate:** the deterministic decision, verified facts, current document
versions, verification reports, loan shape and resolved policy produce a canonical AUS input
fingerprint. Material change marks recorded AUS output stale and blocks packaging until rerun.
Pre-approval letters retain the decision and policy fingerprints and become unavailable when that
decision is no longer current. Out-of-scope cases take an explicit manual-underwrite path.

**Fixed in this release candidate:** lender submission freezes the full current DU and LPA findings
as canonical JSON, hashes it independently, prevents package fields from later mutation and verifies
the digest before staff downloads it. A package cannot be created without both AUS legs and current
input lineage.

**Production proof still required:** retain the signed/provider-native findings and receiver
lineage, then prove invalidation and reproduction against the live path selected by the pilot lender.

### P0 — lender package completeness is internally built; receiver acceptance is not proven

The release candidate builds a separate MISMO PARTY for every stored URLA borrower, uses the schema's
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

Capital gains are detected but do not produce qualifying income. Non-taxable gross-up, continuance
tests and asset depletion are absent. DSCR and bank-statement paths refuse to qualify without the
selected lender's matrices. These are real product gaps, but implementing the formulas from model
memory or marketing pages would make the system less trustworthy.

**Build after authority arrives:** procure the current agency chapters and the pilot lender's
program matrices; add a citation-ledger entry; capture any missing dates or history; implement one
path at a time; prove it with golden cases and a licensed review.

### P1 — Homi has a mortgage regression loop; production outcomes remain unmeasured

**Fixed in this release candidate:** a redacted mortgage-specific scenario suite covers missing
documents, changed evidence, mixed income, human escalation, stale conversation memory and
prohibited claims. Prompt-attack tests treat borrower chat and document-derived text as untrusted.
Homi uses current server state in preference to conversation memory, cannot invent application
status, document requests, qualifying income, timelines or score improvements, and cannot change a
decision. The 2026-09-09 live-model run passed all 12 scenarios: tool triggering 5/5, restraint
2/2, grounding 3/3, honest-gap handling 1/1 and prompt-injection resistance 1/1.

**Fixed in this release candidate:** Homi records grounded turns, repeated questions, completion
movement, model latency, degraded/lint-replaced turns and human-help requests. `request_human_help`
creates or reuses a real loan-officer task and will not claim success until that write succeeds.

**Production proof still required:** run redacted canaries and compare completion, repeat-question,
handoff and response-time measures. A regression pass proves safety behavior; it does not prove that
borrowers finish faster.

## Build order and exit gates

### 1. Make document work durable and observable

- Deploy the durable extraction job and recovery path.
- Run the controlled production restart proof for an ordinary document and a multi-form tax package.
- Record provider canaries with latency and failure class.

**Exit:** kill the worker during extraction, restart it, and receive one complete result with no
duplicate facts or confidence rows.

### 2. Calibrate the page and field evidence model

- Ordinary document normalization, logical routing, box review and boundary correction are built.
- Bring consented tax forms onto the same rendered evidence model.
- Populate and run the versioned human-graded evaluation set.

**Exit:** a mixed 100-page complex-income packet becomes the correct logical documents; every used
value opens its source page; uncertain fields route to review; replacement and correction preserve
lineage.

### 3. Prove decision delivery against a live path

- Multi-borrower MISMO and durable final findings are built and XSD-tested.
- Run live-path invalidation, provider-artifact retention and reproducibility proof.

**Exit:** change a material fact and watch the prior decision, letter and package become unusable
until rerun; restore the fact and reproduce the same policy fingerprint and output.

### 4. Activate one real lender stack

- Production storage acceptance.
- Real credit and selected verification paths.
- Current approved rate sheet with provenance.
- DU/LPA path required by the pilot lender.
- Real receiver acceptance.

**Exit:** the chosen lender accepts one synthetic complex package, then funds one controlled real
file with no off-platform rekeying left undocumented.

### 5. Prove Homi from measured friction

- Production canary ledger.
- Measure question repetition, completion, handoff and response latency.
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
37. In the current candidate, replaced Homi's availability-only token check with a fixed synthetic
    status turn through the real prompt/context builder, server-truth tool schema, grounded reply
    and outbound lint rail; no tool executor or borrower record is touched.
38. Rejected a proposed low-effort ordinary-document optimization after the four-type check caught
    missing required W-2 and bank-statement source evidence. The validation layer failed both reads
    closed and the production inference settings remain unchanged. Extraction speed work now waits
    for the protected multi-document evaluation set so latency cannot be bought with silent accuracy
    or traceability loss.
39. In the current candidate, added a controlled private-storage restart proof: one fixed private
    synthetic marker must be read by a different Railway deployment running the same commit within
    one hour, then is deleted. A same-process check, changed commit, stale marker, malformed marker
    or missing runtime identity fails closed and cannot be reported as durability evidence.

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
