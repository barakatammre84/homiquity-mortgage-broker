# Complex borrower and loan-officer loop — 2026-09-07

## Verdict

**PASS for the internal broker workflow; external acceptance remains open.** A fictional
self-employed borrower completed the fast application with two businesses and one rental, saw
those answers carried into the full application, corrected an uploaded document, and reached an
honestly blocked lender-readiness screen. The assigned loan officer could claim and search the
file, review the same income and property records, see the correction state, and understand the
specific work remaining before a letter, AUS run, package export, rate lock, or lender submission.

This proves the application-to-broker operating loop. It does not prove that a wholesale lender
will accept the package. Homiquity does not yet have an approved lender relationship or that
lender's current receiver instructions/test workflow.

## Benchmark used

Better.com's public experience was used as the friction benchmark: begin online immediately,
finish an initial pre-approval flow in minutes, personalize document requests to how the borrower
earns income, keep the process available online, show current status and remaining documents, and
make human help reachable. Homiquity's differentiator is deeper handling of multi-business,
self-employed, 1099 and rental-income files, with every approval-grade action tied to reviewed
evidence.

The benchmark is a product standard, not a claim that Homiquity is a direct lender. Homiquity's
broker role requires an additional lender handoff and acceptance gate.

## Walk setup

- Branch: `codex/end-to-end-journey`
- Local server: dedicated checkout on port 5021, after migrations 0063–0066
- Borrower: fictional Casey Complex
- Application: `2e1fbc8d-66e0-48b8-b6d8-1786e8fccb01`
- Income: two self-employed businesses and one rental property
- Loan-officer seat: `lo@test.com`
- No Social Security number was entered or stored during the walk.

## Borrower walk

1. The public primary action opened `/apply` directly. The self-employed route stopped promising
   an approval or verified letter before financial review.
2. The fast application represented two separate businesses plus one rental property, retained a
   typed rental address when geocoding was unavailable, and calculated the rough total once.
3. Submission created one application, promoted the account into the active-buyer journey in the
   current session, and generated income-specific requests. The self-employed file did not receive
   a pay-stub request, and property/closing documents stayed deferred until a property address
   exists.
4. The full URLA opened with eight steps. Name and email, both businesses, their separate income
   figures, ownership and history, and the rental property were already editable form state rather
   than display-only placeholders.
5. URLA section 2c showed the rental address, monthly rent and mortgage payment with a “Carried
   over from your application” label. The borrower added value, balance, taxes and insurance,
   saved, refreshed, and saw the same values.
6. The application summary and dashboard described the calculation as preliminary and withheld
   unverified rental income from approval-grade figures.
7. A document uploaded outside the task page advanced the matching condition and task together.
   When an accepted document was replaced, the old task-document link became superseded, the
   current version became reviewable, and the borrower task reopened until the replacement was
   accepted.

## Loan-officer walk

1. The command center found the file through a bounded, searchable queue and opened the actual
   borrower file.
2. The file displayed two self-employed income sources, the rental record, preliminary figures,
   and six applicable open conditions. It did not ask the officer to chase a pay stub the borrower
   cannot produce.
3. The new Properties Owned card showed the same address and use plus the borrower-reported value,
   mortgage balance, payment and rent. It identified the figures as borrower reported.
4. Financial verification was unavailable without current approved income and asset workpapers,
   an approved cited memo and a real credit result. A simulated credit result could not promote the
   file. Concurrent dimension updates converged on the correct verified state.
5. The preliminary letter action was disabled until the same evidence gate used by the server
   passed. The rate-lock dialog separated indicative pricing from a lender-confirmed lock and
   required the lender confirmation fields the backend stores.
6. The lender-submission dialog remained disabled and named the blockers by stage: incomplete URLA
   sections and e-sign consent; no AUS run; missing identity, subject-property and evidence items;
   incomplete financial/property review; inconclusive QM analysis; and unresolved delivery edits.
   Manual MISMO download was held behind the same readiness result and could not emit a package
   first and write its audit record later.

## Backend and database trace

The fast application stores structured `income_sources`. Rental-property intake is now copied into
application-scoped `real_estate_owned` rows. URLA 2c replaces those rows transactionally and saves
an explicit tri-state `owns_other_real_estate`: null means unanswered, false means the borrower
confirmed none, and true requires at least one property. The live database contained exactly one
current row for the fictional rental with value `500000.00`, balance `250000.00`, payment
`1800.00`, rent `3000.00`, and `borrower_stated` provenance.

Delivery readiness now counts financed properties only when the ownership disclosure and each
listed property's financing state are known. An unanswered question produces a visible
`notEvaluated` result for EarlyCheck edit 6439 instead of silently passing as zero. The six-property
threshold remains unchanged pending the current authoritative EarlyCheck publication.

Document registration, condition matching, borrower-task state and replacement lineage now move
together. Migration 0065 repairs prior task links that still point at superseded document versions;
migration 0066 introduces the ownership answer without converting unanswered legacy files into a
false “none” response.

## Re-audit findings and fixes

The first repeat walk exposed a stale development server: the updated browser rendered section 2c
while the old backend ignored its payload. Restarting the dedicated server made the save durable,
and refresh plus a direct database read proved it. This is a local hot-reload limitation, not a
production path.

The second code re-audit found two additional edges before release. Rental intake had put the word
`investment` into the physical property-type field; a new file could therefore fail its next URLA
save. It now uses the neutral `single_family` default and keeps `investment` only as occupancy. The
legacy repair also now reopens a task when the current version of one document lineage needs review,
even if a different document attached to the same task is already accepted.

## Remaining gates

1. Establish one approved wholesale-lender relationship and obtain its current submission,
   correction and acknowledgement instructions or sandbox.
2. Prove production object storage through a real upload, restart, download, replacement and
   access-control test. Source code cannot reveal whether the required production credentials are
   currently present.
3. Connect and certify the production credit, asset, employment, AUS, property-valuation and
   pricing providers. Simulations remain clearly labeled and cannot satisfy evidence gates.
4. Confirm licensed-MLO/state routing, counsel decisions and operating ownership for each live
   state before accepting applications there.
5. Run one lender package and one correction exchange through the selected lender, reconcile every
   returned condition, then demonstrate closing/funding and borrower communication on that same
   file.

The product direction remains **Homiquity as the existing application with Core controls embedded
inside it**. Rebuilding a second shell would reintroduce duplicate accounts, applications and
uploads without resolving any remaining gate.
