# Core intelligence audit — Homi, documents, financial analysis and underwriting

**Evidence date:** 2026-09-09

**Code reviewed:** production `d7bf9f7d876d50bff37bb577a914e68c781a7ded` plus the current release candidate

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
feeds the borrower snapshot from that one result. Ordinary pay-stub, bank-statement and lease
uploads now classify every page independently, refuse to credit fields from mislabeled, mixed or
low-confidence packets, retain page/box evidence and expose field correction beside the source.
Document state, confidence, facts and readiness now commit in one database transaction, so a
failed write is retried without exposing a half-updated file. Demonstration extraction refuses to
run in production even when its environment flag is set, and the capability screen reports that
combination as a configuration error.
Automatic physical splitting and accuracy calibration remain open. Credit, DU, LPA, executable
pricing provenance and lender delivery remain simulated or unproven.

Better demonstrates the experience standard: one central file, tasks generated from the file,
24-hour help and a fast underwriting promise after the required evidence arrives.[1][2][3] Its
published fast-underwriting terms also exclude or condition many self-employed and rental-income
cases.[3] Homiquity should copy the continuity and speed pattern, then win on evidence-rich review
for the borrowers that a standardized fast lane handles poorly.

## Capability reality map

| Capability | What works now | Main gap | Assessment |
|---|---|---|---|
| Homi | Server-grounded tools, prompt lineage, PII input guard, bounded turns, streaming, safe offline guidance, human handoff and a mortgage-specific regression/attack suite | No production canary ledger or proof that guidance reduces completion time | Strong assistant foundation; production usefulness remains unproven |
| Simple document extraction | Claude reads pay stubs, bank statements and leases; Zod validates values and exhaustive per-page type classification; mislabeled/mixed/uncertain packets cannot create trusted facts; durable leased jobs recover after restart; staff can review fields beside page evidence | No automatic physical packet split or calibrated accuracy set; boxes depend on provider output and need rendered overlay proof | Safe evidence foundation; hands-off accuracy remains unproven |
| Tax-package intelligence | Consent-gated durable processing, serialized revocation/final persistence, multi-form classification, logical forms, page ranges, per-field confidence, entity resolution, tie-outs, review triage and a borrower snapshot derived from the same result | No rasterized page pipeline; source boxes remain empty; production model canary not yet recorded | Strongest document capability and the right model for the other types |
| Financial analysis | Self-employment worksheets, rental treatment, reconciliations, review checkpoints, cited memo and hashed lender package | Capital gains, non-taxable gross-up, continuance and asset depletion wait on governing agency references; bank-statement and DSCR math wait on lender matrices | Strong and appropriately conservative |
| Underwriting | Deterministic rules, policy/input fingerprints, decision snapshots, evidence gates, tested DTI/pricing calculations, stale AUS/letter blocking, an explicit manual-underwrite path and simulation labels | Co-borrower delivery and durable final AUS findings remain open; external AUS is not live | Strong internal engine, incomplete external decision chain |
| Delivery | MISMO 3.4 package, structural checks, income package, immutable hashes, readiness gates, condition tracking | Co-borrower is absent from delivered MISMO; final DU findings are not a durable document; no real receiver acceptance | Package builder exists; delivery is not proven |
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

The remaining implementation gap is page materialization: the current upload path records page
classification and field coordinates, but it does not yet rasterize pages, split mixed packets or
render the cited box directly over a normalized page image.

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

### P0 — normal uploads classify pages but do not yet split packets automatically

**Fixed in this release candidate:** pay-stub, statement and lease extraction independently
classifies every source page from visible content in the same provider call. Validation requires
one taxonomy value for every consecutive page. The persistence gate compares the detected packet
to the borrower-selected upload type and blocks mislabeled, mixed or low-confidence packets before
their values enter readiness or the evidence graph. Staff sees the detected page ranges and the
reason for correction; the original bytes remain unchanged.

**Build next:** rasterize and normalize pages; turn the recorded contiguous ranges into separate
logical documents; let staff correct uncertain boundaries; route each accepted logical document
to its specialized extractor. Preserve every derived page and its link to the original upload.

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

**Build next:** create a representative, versioned evaluation set by document type and borrower
situation. Grade exact values, missing fields, false fields, document boundaries and page
attribution. Calibrate review thresholds from observed error and business impact. Never advertise
an accuracy percentage until the sample and grading method are visible.

### P0 — source-level review is connected but needs rendered boundary controls

**Fixed in this release candidate:** ordinary extractors persist field values with confidence,
source page and normalized bounding box when available. The staff document panel opens the source
beside the fields, jumps to the cited page, records accept/reject/correction per field and keeps
document acceptance distinct from value verification. Human-reviewed facts survive re-extraction;
a low-confidence reread clears stale machine facts without overwriting reviewed values.

**Build next:** render the bounding box directly over normalized page images, add keyboard-first
review and allow staff to correct packet boundaries before logical-document extraction.

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

**Build next:** persist redacted canary results with provider, operation, environment, timestamp,
latency and failure class. A configured adapter becomes operationally proven only after a current
canary succeeds.

### P0 — decision freshness is enforced; final findings still need durable delivery

**Fixed in this release candidate:** the deterministic decision, verified facts, current document
versions, verification reports, loan shape and resolved policy produce a canonical AUS input
fingerprint. Material change marks recorded AUS output stale and blocks packaging until rerun.
Pre-approval letters retain the decision and policy fingerprints and become unavailable when that
decision is no longer current. Out-of-scope cases take an explicit manual-underwrite path.

**Build next:** retain the final signed/provider findings document and its receiver lineage, then
prove invalidation and reproduction against the live AUS path selected by the pilot lender.

### P0 — lender package completeness is not proven

The delivered MISMO model builds one borrower party. A co-borrower and their correctly attributed
employment do not reach the package. DU/LPA findings persist as structured application data but not
as the final, immutable findings artifact expected in a complete application package. Structural
validation also does not substitute for one lender's receiver rules.

**Build:** add co-borrower parties and role links using verified MISMO authority; retain the final
findings report; run the current XSD and lender-specific edits; send one synthetic complex file to
the chosen lender's test receiver; record acknowledgement, corrections and the accepted package
hash. Fannie publishes current DU integration and testing resources, but access and acceptance
still require the relevant onboarding path.[13]

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

**Build next:** retain redacted production canaries and connect Homi interventions to completion,
repeat-question, handoff and response-time measures. A regression pass proves safety behavior; it
does not prove that borrowers finish faster.

## Build order and exit gates

### 1. Make document work durable and observable

- Deploy the durable extraction job and recovery path.
- Run the controlled production restart proof for an ordinary document and a multi-form tax package.
- Record provider canaries with latency and failure class.

**Exit:** kill the worker during extraction, restart it, and receive one complete result with no
duplicate facts or confidence rows.

### 2. Finish the page and field evidence model

- Convert safe classification segments into normalized pages and logical documents.
- Render source bounding boxes and let staff correct boundaries.
- Versioned human-graded evaluation set.

**Exit:** a mixed 100-page complex-income packet becomes the correct logical documents; every used
value opens its source page; uncertain fields route to review; replacement and correction preserve
lineage.

### 3. Finish decision delivery

- Co-borrower MISMO and durable final findings.
- Live-path invalidation and reproducibility proof.

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
