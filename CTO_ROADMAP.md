# Homiquity CTO roadmap

**Last evidence review:** 2026-09-10

**Product direction:** one Homiquity application with Core capabilities inside it

**Audited production baseline:** `2e0a098bc4d362b80adcdcb7b2f95844f5fa846d` on 2026-09-10.
Read the current build from `/api/health`; this baseline records the review, not a permanent
deployment pointer.

## The goal

**Fund one real mortgage for a complicated borrower through one approved wholesale lender, using
Homiquity from the first public application through post-close.**

The borrower should enter information once, upload each document once, understand what is
preliminary and what is verified, and always know the next action and the person responsible. The
loan officer should work from the same evidence-linked file, complete the complex-income review,
deliver an accepted lender package, manage every condition, and close without rebuilding the file
in spreadsheets or disconnected systems.

This is the shortest path from a broad software product to a proven mortgage business. It also
creates the foundation for future lenders, states, providers and borrower segments.

## Product position

Homiquity should match Better.com's speed, continuity, transparency and self-service experience.
It should win where a broker can create more value: self-employed, multi-business, 1099, rental
income and other complicated returns, combined with a choice of wholesale lenders and high-touch
human service.

Core remains part of Homiquity. A separate Core product would duplicate identity, applications and
uploads while leaving the real lender, provider and operating gaps unresolved.

## How status is reported

| Status | Meaning |
|---|---|
| **Live** | A customer or staff member can use it in production. |
| **Proven** | The behavior was walked or tested with retained evidence. |
| **Built** | The implementation exists, but the required real-world proof is still missing. |
| **External** | Completion needs an agreement, credential, operating owner or third-party decision. |
| **Deferred** | Deliberately outside the current goal. |

“Built” never means “ready to run the business.” Simulated credit, valuation, AUS, pricing or
lender results never satisfy a verified decision or lender-acceptance gate.

## What is real today

Production served the exact `main` commit above on 2026-09-10. Health and the scheduled core-proof
route returned successfully, and the service reported SendGrid email configured. The repository
has a strict required test gate, automatic production migrations and post-deploy commit
verification. On that exact build, a borrower-data-free sweep passed Homi's grounded status turn,
the real image-only pay-statement extraction path with page evidence, private object-storage
write/read/delete, mixed W-2/business/rental analysis and deterministic underwriting in 5.467 s,
9.388 s, 0.652 s, 0.006 s and 0.853 s. The Homi check uses the production prompt and context
builder, requires the real status tool schema, grounds the reply in fixed server truth and passes
outbound compliance lint without reading a borrower file.

The current build closes the most important gap between extraction and a mortgage decision.
Financial workpapers cite the exact human-reviewed numeric facts and their source pages, and a
correction to one of those facts invalidates the affected workpaper and memo. Pay-statement income,
bank balances, leases and supported tax figures are reconciled against the structured values the
calculation actually uses. A difference is visible to the reviewer and must be acknowledged with a
reason; it cannot be accepted silently. Staff can create an append-only bank-statement analysis
from reviewed deposit evidence while explicitly removing transfers, refunds, duplicates and other
ineligible deposits.

Every binding or customer-visible verified status is now recalculated from current proof. Pricing,
loan options, Homi, approval statuses and underwriting advancement require a current approved
financial memo, current approved income and asset workpapers, and a completed real bureau report
that is neither simulated, archived nor expired. Stored flags remain audit history; they cannot keep
a file verified after its supporting evidence changes. Income, asset and credit progress counts are
derived from those same current proofs so staff, the borrower and Homi receive one answer.

The intelligence release following that proof removes two large-packet bottlenecks. Tax work now
loads a source once, sends each field pass only the classifier's exact non-overlapping page range
of at most 25 pages and maps every retained field back to the original source page. A separate
serial tax worker prevents a long return from delaying ordinary borrower documents, while keeping
paid tax work bounded. Provider-pass
failures fail the durable job instead of becoming an empty “completed” analysis; incomplete
page-backed evidence requires human review. Classification and every form pass hold active consent
through the provider call, so calls already dispatched finish before revocation succeeds and no
later provider use begins after it succeeds.

The ordinary-document recovery proof now starts with pixels rather than an embedded PDF text layer.
The fixed synthetic pay statement is rendered to one PNG and embedded in a one-page PDF; a runtime
guard verifies that PDF.js can extract no text before the production provider sees it. The first
deployment on exact commit `513ab8c1a7abb67d3bb2163336006f8f8fd29313` completed the real provider
read, verified five exact financial values, page evidence, classification and model/prompt lineage,
then stopped before persisting pages, facts, confidence or readiness. Railway replaced it with
deployment `cb7a11d5-126f-4fc4-9972-fe636c93c905` on the same commit. After the lease expired, the
replacement reclaimed the job on attempt two, repeated the provider read, committed one page graph
and ten grounded facts, and removed every temporary database row and private object. This proves
the clean image-only provider path and ordinary-document recovery without duplicate evidence. It
does not measure accuracy across real scans, image degradation, handwriting or varied layouts.

The same recovery boundary is now proven for the complex path. On exact production commit
`e6ae28ae4e221caf8554d58c6e2cc3dce0fb4619`, the first deployment classified a fixed synthetic
100-page tax packet, completed four real form reads and validated eight exact grounded facts, then
stopped before filing any evidence. Railway replaced the process with deployment
`47d11a62-d8ed-43f6-a22b-bd1d81165736` on the same commit. Attempt two reclaimed the expired
lease, explicitly closed one abandoned run, repeated provider work, persisted one graph containing
100 pages, four forms and 28 grounded facts, and removed every synthetic row and private object.
This proves deployed large-packet capacity and interruption recovery. It does not prove accuracy on
a protected human-labeled set or lender acceptance.

The internal complex-borrower journey is proven. Fictional multi-business, rental and mixed W-2
plus side-business borrowers moved through the public application, full URLA, database
persistence, personalized document work, borrower corrections and the loan-officer file. Reported
household income is reconciled once, while every detailed source survives into the appropriate
workpaper. Homiquity correctly refuses to present self-reported or simulated evidence as verified
qualifying income, an approval or a lender-ready submission.

No approved wholesale lender, current lender receiver, production credit/AUS/verification suite,
real lender acceptance or funded Homiquity loan has been proven. A completed protected human-labeled
extraction evaluation, including representative real scanned returns, and the complete operating handoff between
licensed loan officer, processor, underwriter and closer also remain unproven.

## Core capability map

| Capability | State | Proof still required |
|---|---|---|
| Discover and begin | **Live** | Measure qualified start, completion and abandonment in production. |
| Guide the borrower with Homi | **Live · production canary and bounded document-evidence read proven** | Collect at least 30 server-measured turns across 10 borrowers, define the comparison cohort in advance and prove that guidance reduces incomplete work, exact repeated questions or time to a recorded staff reply. |
| Build one accurate application | **Live · Proven** | A real borrower completes without staff rekeying or contradictory figures. |
| Collect and correct evidence | **Built · ordinary raster, durable raster restart and 100-page tax recovery live** | Run pilot upload → page/box review → correction → authorized download; populate and run the protected evaluator across born-digital and real scanned documents. |
| Review complicated income | **Built · exact evidence lineage, reconciliation and production engine repeatability proven** | Populate the protected extraction benchmark; then a licensed reviewer must reproduce and approve a real client's calculation from accepted evidence and reconcile it with the pilot lender. |
| Explain options and decisions | **Built · stale and simulated evidence fails closed** | Real credit, asset, employment, property, AUS and pricing evidence supports the decision and the first lender accepts the result. |
| Operate the file | **Live · Proven internally** | Named staff complete claim, processing, underwriting, closing and handoff on a real file. |
| Deliver to a lender | **Built · XSD proven internally** | One approved lender accepts the multi-borrower MISMO, income and final AUS artifacts and completes an acknowledgement/correction exchange. |
| Close, fund and service | **Built** | One real closing, funding record, borrower update sequence and post-close handoff. |

## Core intelligence build order

1. **Prove durable evidence ingestion in production:** database-backed extraction jobs, leased
   restart recovery and staff-visible failures are built for ordinary documents and consented
   multi-form tax packages. Document status, confidence, extracted facts and readiness commit
   atomically, demonstration extraction fails closed in production, and tax-consent cleanup
   preserves unrelated work. The canary ledger is live; Homi, the real pay-statement pipeline,
   private storage, mixed-income analysis and underwriting remain operable across a controlled
   process replacement. A provider-backed ordinary-document job now survives interruption before
   persistence and produces one evidence set after reclaim. Large tax work now runs independently
   from ordinary documents, and each field pass receives no more than 25 non-overlapping classified
   form pages. Every tax-provider handoff also holds the borrower's active consent through the call,
   so completed revocation blocks any later external use. A two-deployment production proof now
   recovers the provider-classified 100-page tax path on attempt two with one exact evidence graph
   and complete cleanup. The ordinary proof also starts from a verified text-free raster PDF,
   survives a same-commit process replacement and preserves exact values, evidence and lineage.
   Keep both proofs current and move the internal focus to measured accuracy across representative
   real scans before changing inference settings.
2. **Calibrate page-level evidence:** ordinary and consented tax uploads normalize pages, split or
   link logical documents, retain field-level source pages and support field and boundary review.
   A representative 100-page packet completes both the local page pipeline and the live
   provider/restart path inside the current capacity envelope, and a clean text-free one-page raster
   pay statement completes the live provider/restart path. The protected evaluator now runs the exact
   production adapters outside the product database, verifies private source/label hashes, reserves
   a bounded provider-call budget before each call, resumes from private checkpoints and blocks a
   claim when any case, lineage or threshold is incomplete. Populate its independently reviewed set
   across born-digital and varied real scanned/raster documents, run it, then set review thresholds
   from measured errors before treating extraction as hands-off.
3. **Prove decision delivery:** underwriting, AUS and pre-approval letters carry input/policy
   fingerprints; stale output is blocked; out-of-scope files take a manual-underwrite path; and the
   multi-borrower MISMO plus final dual-AUS artifact passes the committed XSD. Retain provider-native
   findings and reproduce the package through the live path before receiver certification. The
   scheduled core proof now checks mixed W-2, Schedule C and rental analysis plus repeatable
   underwriting against deployed policy rows. Current workpapers cite the reviewed numeric facts,
   reconcile them to the calculation inputs, and invalidate downstream decisions when evidence
   changes. Pricing, options, approval and stage advancement independently re-resolve that proof.
   This does not replace a live credit report, AUS result, rate sheet or lender acknowledgement.
4. **Activate one live stack:** production storage, real credit and verification, current approved
   pricing, required AUS, and one lender receiver.
5. **Prove Homi's value:** production response canaries pass and the mortgage scenario and
   prompt-attack regression suite is built. Homi now refreshes the readiness panel from the saved
   server file after a successful chat capture and records completed and failed turns, exact-repeat
   detection, server-truth reads, actual saved fields and staff secure-message response after a
   handoff. Its document-evidence tool now reads a bounded allowlist of server-written OCR and tax
   facts, separates machine-read values from individually human-verified fields, reports only a
   current fully approved workpaper package as approved, and excludes raw OCR, filenames, account
   identifiers, borrower notes and staff review notes. Low confidence routes to staff review and
   does not create a borrower re-upload request unless the real checklist says the document was
   rejected. Evidence and shared file reads are bounded and reused within a turn, and a file with
   more documents than the response window is labeled as a bounded view so Homi cannot mistake an
   omitted older return, statement or lease for an absent document. The staff report separates
   legacy turns, measurement coverage and operational
   exceptions and refuses a reduced-friction claim without at least 30 measured turns across 10
   borrowers and a comparison cohort defined in advance. Collect that cohort; change guidance only
   when the measured journey shows less borrower or loan-officer effort.

The dated [core intelligence audit](knowledge-base/feature-review/CORE_INTELLIGENCE_AUDIT_2026-09-08.md)
contains the evidence and acceptance tests. This order is part of Phase 0 and Phase 1; it does not
create another product or a parallel roadmap.

## Phase 0 — establish a safe operating floor

**Outcome:** Homiquity can accept a controlled real file without losing evidence, corrupting a
regulated record or presenting simulated output as real.

Run the full [Phase 0 technical readiness gate](knowledge-base/runbooks/PHASE_0_TECH_READINESS.md):

1. **0A — production truth:** exact build, database, configuration, dependencies, providers and
   release controls are visible and current.
2. **0B — durability and recovery:** document lifecycle, access matrix, retention and an isolated
   database point-in-time restore are proven.
3. **0C — security and privacy:** independent review, auth, role/resource access, encryption, PII
   egress, CSP, MFA and control-plane access pass.
4. **0D — regulated data integrity:** one complex primary/co-applicant case re-proves consent,
   application clock, HMDA/MISMO, decisions/notices, pricing, TRID, evidence lineage and package
   reproducibility.
5. **0E — provider and background truth:** every external leg and scheduled process is visibly
   live, simulated, disabled or failed; document extraction survives restart; retry, idempotency
   and manual-evidence paths are proven.
6. **0F — reliability and capacity:** alerts, scheduled jobs, service targets, pilot load, database
   safeguards, graceful restart and incident response are measured.
7. **0G — exact-build acceptance:** repeat the complete synthetic journey and failure set in
   production, clean up, index the evidence and obtain technical, security and licensed/compliance
   sign-off.

**Exit gate:** every 0A–0G row passes on one current production architecture; database restore,
document lifecycle, cross-account denial, rollback and alerting have been exercised; no verified
critical/high security finding or launch-critical data-integrity defect remains; and no simulated or
unknown provider result can satisfy an approval, disclosure, lock or lender-readiness gate.

## Phase 1 — establish one lender and one operating team

**Outcome:** Homiquity has a legal and operational path to deliver a mortgage file.

- Select one wholesale lender suited to the target complicated-borrower profile and execute the
  broker agreement.
- Obtain its current product, eligibility, submission, acknowledgement, correction, lock and
  closing instructions, including a test receiver when available.
- Choose the first-file path for credit, asset, employment, tax, AUS, property valuation and live
  pricing. Use a controlled manual step when permitted and record its result in Homiquity; build an
  integration only where it removes measured friction or is required by the lender.
- Name the licensed loan officer, processor, underwriting reviewer and closer for the pilot, with
  service hours, handoff ownership and escalation rules.
- Confirm the licensed-state intake boundary and obtain counsel or compliance sign-off on the
  pilot process and borrower communications.

**Exit gate:** the lender and operating owners approve the same end-to-end test package, and the
receiver returns an acknowledgement or correction that Homiquity records against the file.

## Phase 2 — fund the first complicated mortgage

**Outcome:** one real borrower reaches funding with a complete, reproducible audit trail.

- Enroll one qualified borrower in the approved state and set expectations for a closely supported
  pilot.
- Carry the application into URLA without rekeying; collect and accept the required evidence once.
- Complete licensed review of income, assets, liabilities and properties, including the cited
  complex-income workpapers and credit memo.
- Produce the verified decision or letter from real evidence, select an eligible product, obtain
  AUS findings and record a lender-confirmed lock.
- Deliver the package, reconcile lender edits, manage conditions and borrower corrections, and
  keep both borrower and staff views in agreement.
- Record approval, closing, funding, borrower communications and post-close handoff in Homiquity.

**Exit gate:** the lender funds the mortgage; every approval-grade figure traces to accepted
evidence and human review; every material status change and external response is recorded; and any
off-platform work is documented as a measured gap.

## Phase 3 — make the process repeatable and easier

**Outcome:** a small controlled cohort confirms the process is faster, clearer and less laborious
for borrowers and loan officers.

- Run a small cohort through the same operating model and review the metrics after every file.
- Fix the largest borrower wait, repeated question, duplicate upload, staff rekey and unclear-status
  causes in that order.
- Turn recurring manual lender and provider steps into integrations only after the cohort shows
  their volume, error rate and time cost.
- Standardize the complicated-borrower playbook, service recovery, file review and lender package
  quality checks.

**Exit gate:** the cohort meets the agreed service and quality thresholds, package corrections due
to Homiquity are rare and visible, and the operating team can handle the next file without founder
intervention.

## Phase 4 — scale what the pilot proved

**Outcome:** grow volume without lowering file quality or service.

- Add lenders by borrower need and measured fallout, then certify each receiver independently.
- Add states only after licensing, disclosures, routing, staffing and monitoring are ready.
- Add provider automation where it reduces verified cycle time or error rate.
- Increase public acquisition and partner channels after conversion, capacity and service levels
  are visible.
- Expand retention and homeowner journeys after closing data is reliable.

**Exit gate:** capacity, quality, borrower service and unit economics remain inside target as lender,
state and file volume increase.

## Measures that decide what to build

| Measure | Desired direction |
|---|---|
| Qualified application start → submitted application | Faster; abandonment explained by step. |
| Questions re-entered by borrower or staff | Zero platform-caused repetition. |
| Documents uploaded again | Zero unless replacing a changed or rejected document. |
| First useful human response | Faster and inside the published service standard. |
| Submitted application → verified complicated income | Faster with 100% evidence traceability. |
| Verified file → lender-ready package | Faster; every blocker has one owner and next action. |
| Packages accepted without platform-caused correction | Higher. |
| Conditions reopened because systems disagree | Zero. |
| Application → clear to close → funded | Faster, with delays attributed to an owner or dependency. |
| Loan-officer touches and active minutes per file | Lower without reducing review quality. |
| Borrower effort and satisfaction | Better after each file. |

Baseline these measures on the first real file. Set numeric targets with the operating team after
the baseline; do not invent targets from simulated journeys.

## Founder decisions required next

The recommended direction is a controlled complicated-borrower pilot in one licensed state, with
one approved lender and one named operating team. Keep the public experience available, but do not
spend materially on growth until Phase 2 proves a funded file.

The next decisions are:

1. Which wholesale lender will be the first approved receiver?
2. Who owns the loan-officer, processing, underwriting-review and closing seats for the first file?
3. Which verification and pricing steps must be contracted for file one, and which may use a
   controlled documented manual process?
4. What borrower profile and licensed state define the pilot boundary?

## Intentionally deferred

- Broad multi-state expansion.
- Multiple automated lender receivers.
- Paid growth and large partner acquisition.
- Realtor, homebuyer accelerator, homeowner, refinance-alert and retention expansion.
- AI coaching and adjacent financial products that do not shorten the funded-mortgage path.
- Automation justified by hypothetical scale instead of measured file friction.

## Evidence and maintenance

Current evidence: [Core integration](knowledge-base/specs/CORE_INTEGRATION.md) ·
[core intelligence audit](knowledge-base/feature-review/CORE_INTELLIGENCE_AUDIT_2026-09-08.md) ·
[complex borrower and loan-officer walk](knowledge-base/feature-review/journey-walks/2026-09-07-complex-borrower-lo-loop.md) ·
[mixed-income analysis walk](knowledge-base/feature-review/journey-walks/2026-09-08-mixed-income-analysis-loop.md) ·
[production acceptance test](knowledge-base/runbooks/PROD_ACCEPTANCE_TEST.md) ·
[fact and assumption register](knowledge-base/governance/ASSUMPTIONS.md) ·
[verified findings](knowledge-base/feature-review/FINDINGS.md).

This file holds product direction and phase gates. Defect detail belongs in the findings register;
deployment procedure belongs in runbooks; completed work belongs in Git and dated evidence. Remove
completed steps instead of adding closure history. Do not add branch names, pull-request numbers,
incident timelines or duplicate ticket backlogs. Recheck this roadmap after every phase exit and at
least monthly against production, the database, the current lender process and actual file metrics.
