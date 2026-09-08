# Core intelligence audit — Homi, documents, financial analysis and underwriting

**Evidence date:** 2026-09-08

**Code reviewed:** production `d77e356fdc76d8ebaec17fea854da421bc24034d` plus the current release candidate

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
underwriting, credit, AUS, pricing and lender delivery. It also ran 281 focused tests across 21
files. Those tests passed. The result proves strong internal behavior; it does not prove any
external provider or lender receiver.

## Verdict

Homiquity has a sound core architecture and a credible advantage for complex borrowers. AI does
not decide mortgage eligibility. The underwriting and income engines are deterministic, the file
distinguishes evidence levels, complex-income figures require workpapers and human approval, and
the lender package carries citations and hashes.

The product is not yet an end-to-end live mortgage platform. Document extraction begins as an
in-process task that can disappear during a restart. The simple-document path trusts the upload
label instead of classifying pages, records only coarse model confidence, and persists a narrow
subset of extracted facts. A rich page and field schema exists but is not connected to normal
uploads. Credit, DU, LPA, executable pricing provenance and lender delivery remain simulated or
unproven.

Better demonstrates the experience standard: one central file, tasks generated from the file,
24-hour help and a fast underwriting promise after the required evidence arrives.[1][2][3] Its
published fast-underwriting terms also exclude or condition many self-employed and rental-income
cases.[3] Homiquity should copy the continuity and speed pattern, then win on evidence-rich review
for the borrowers that a standardized fast lane handles poorly.

## Capability reality map

| Capability | What works now | Main gap | Assessment |
|---|---|---|---|
| Homi | Server-grounded tools, prompt lineage, PII input guard, bounded turns, streaming, safe offline guidance and human handoff | No production canary ledger, outcome evaluation set or proof that guidance reduces completion time | Strong assistant foundation; availability and usefulness unproven |
| Simple document extraction | Claude reads pay stubs, bank statements, leases and single tax returns; Zod validates output; low-confidence reads do not become facts | In-process fire-and-forget execution, upload-label classification, coarse whole-document confidence, no page anchors or boxes, narrow fact persistence | Functional prototype, below production document-intelligence standard |
| Tax-package intelligence | Multi-form classification, logical forms, page ranges, per-field confidence, entity resolution, tie-outs and review triage | No rasterized page pipeline or durable extraction worker; source boxes remain empty | Strongest document capability and the right model for the other types |
| Financial analysis | Self-employment worksheets, rental treatment, reconciliations, review checkpoints, cited memo and hashed lender package | Capital gains, non-taxable gross-up, continuance and asset depletion wait on governing agency references; bank-statement and DSCR math wait on lender matrices | Strong and appropriately conservative |
| Underwriting | Deterministic rules, policy fingerprints, decision snapshots, evidence gates, tested DTI/pricing calculations and simulation labels | Material input changes can leave prior AUS results looking current; no explicit out-of-scope/manual-underwrite outcome | Strong internal engine, incomplete external decision chain |
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

The problem is implementation reach: normal borrower uploads skip most of that schema.

## Verified gaps

### P0 — document work can be lost after the upload succeeds

The upload route returns the saved document, then starts extraction without a durable job claim.
A process restart or deployment can end that work. Failure becomes a server warning and no retry
owner, next attempt or staff-visible failed state is recorded. A mortgage file can therefore say
“uploaded” while the automation silently never completed.

**Build:** make one durable extraction job per document version; claim it atomically; persist
`pending / processing / completed / failed`, attempt count, last error and next retry; run work
outside the request; make retries idempotent; expose retry to authorized staff; recover abandoned
claims after restart.

### P0 — normal uploads do not classify and split packets

The borrower chooses a document type. Pay-stub, statement and lease extraction then reads the whole
file as that type. The page tables and page-classification tables are not populated by the normal
flow. A combined tax packet, mixed statement packet or mislabeled upload cannot be reliably split
into logical evidence.

**Build:** rasterize and normalize pages; classify each page; group contiguous pages into logical
documents; show uncertain boundaries to staff; route each logical document to a specialized
extractor. Preserve the original bytes and every derived page.

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

### P0 — staff cannot see a complete source-level extraction in one review

The normal staff document panel shows field names and a coarse confidence after reload. Selected
pay-stub and bank-statement facts are persisted elsewhere, while rich tax facts appear in the
financial review. The full source value, page image, bounding box, model value, correction and
verification state are not presented as one field-level review surface.

**Build:** one split-screen review workbench with the source page beside structured fields;
keyboard correction; accept/reject per field; reason for overrides; document boundary correction;
and a clear distinction between accepting the document and confirming its values.

### P0 — runtime provider truth was missing

The public health endpoint proves the database, exact commit and email configuration. It did not
show Homi, extraction, private storage, Plaid, credit, DU, LPA, pricing or lender delivery. Staff
could not distinguish a configured adapter from a simulation or a contradictory environment.

**Fixed in this release candidate:** Staff Dashboard → Intelligence → Core Systems now shows every
core capability as `live`, `simulated`, `disabled` or `configuration error`, without exposing
secrets. It refuses to mark the lifecycle ready while a critical leg is not live. It also shows
“not recorded” for last success rather than inventing proof from configuration.

**Build next:** persist redacted canary results with provider, operation, environment, timestamp,
latency and failure class. A configured adapter becomes operationally proven only after a current
canary succeeds.

### P0 — underwriting outputs can outlive changed inputs

Decision snapshots are reproducible, but the external AUS result does not yet carry a complete
dependency fingerprint and staleness tolerance for every material input. A new income review,
liability, property value or loan structure must invalidate the old answer visibly.

**Build:** define the input dependency set; hash the verified facts and casefile shape; mark results
stale on a material change; block letters, locks and delivery from stale outputs; require a rerun;
retain both result versions and why the earlier one became stale.

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

### P1 — Homi needs a mortgage-specific evaluation loop

Prompt versioning and safe fallback exist, but there is no retained scenario suite that proves
Homi gives the right next action across missing documents, changed evidence, complex-income
questions, adverse decisions and provider outages. Uploaded documents and OCR output also create
an indirect prompt-injection surface; current model guidance recommends treating those external
contents as untrusted.[14]

**Build:** a redacted scenario suite with expected facts, prohibited claims, tool calls, escalation,
latency and completion outcomes. Include malicious text inside documents. Run it on every prompt,
tool or model change. Homi may summarize verified system state; it must never follow instructions
found inside evidence or change a decision.

## Build order and exit gates

### 1. Make document work durable and observable

- Durable extraction job and recovery.
- Staff-visible failed/retry state.
- Recorded provider canaries.

**Exit:** kill the worker during extraction, restart it, and receive one complete result with no
duplicate facts or confidence rows.

### 2. Connect the page and field evidence model

- Page normalization, classification and logical-document splitting.
- Source page and bounding box for decision-bound facts.
- Unified field review and corrections.
- Versioned human-graded evaluation set.

**Exit:** a mixed 100-page complex-income packet becomes the correct logical documents; every used
value opens its source page; uncertain fields route to review; replacement and correction preserve
lineage.

### 3. Make decisions expire when evidence changes

- Verified input fingerprint for underwriting and AUS.
- Explicit `out_of_scope / manual_underwrite` result.
- Co-borrower MISMO and durable final findings.

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

### 5. Improve Homi from measured friction

- Scenario regression suite and production canary.
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
