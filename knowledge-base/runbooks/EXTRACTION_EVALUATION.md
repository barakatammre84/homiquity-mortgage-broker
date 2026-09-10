# Protected extraction evaluation

Use this runbook to measure Homiquity's real document extractors against independently reviewed
labels. The runner covers pay stubs, W-2s, bank statements, leases and the multi-form tax-package
path. It calls the same provider adapters, models, prompts, validation and bounded tax excerpts as
the application, but it never imports the product database or persists a borrower document.

This is the execution half of the benchmark in
[the core intelligence audit](../feature-review/CORE_INTELLIGENCE_AUDIT_2026-09-08.md). A successful
run proves only the measured population, model and prompt recorded in its report. Synthetic cases,
an incomplete run, a provider/lineage failure, fewer than 30 independently reviewed cases in a
claimed segment, an unreviewed case, a critical field missing from truth, or a missed pre-approved
threshold cannot support an accuracy claim. Production thresholds cannot be below Homiquity's
code-enforced 0.98 operating floor.

## Private workspace

Create a directory outside this public repository on an encrypted, access-controlled volume. The
manifest, labels and every source must be a regular file accessible only to the current user; the
output directory must also be private.

Copy the repository's blank
[`manifest.template.json`](../../benchmarks/extraction/manifest.template.json) and
[`labels.template.json`](../../benchmarks/extraction/labels.template.json) into that directory.
Use [`mortgage-extraction-v1`](../../benchmarks/extraction/LABELING_PROTOCOL.md) for the independent
review and adjudication. The templates contain placeholders, not a usable dataset.

```text
/private/homiquity-extraction-eval/
  manifest.json
  labels.json
  sources/
    pay-001.pdf
    tax-001.pdf
  output/
```

Apply `chmod 700` to the directories and `chmod 600` to every file. The runner rejects repository
paths, symlink escapes, group/world-readable files, files above the product's 10 MB upload limit,
MIME declarations that disagree with the file signature, source-hash changes and label/source page
count disagreement before provider use.

Never place real borrower identifiers in a case ID, filename or situation tag. Redact SSNs and full
account numbers before the two reviewers label the documents. The predictions necessarily contain
the values being graded, so the private **output/checkpoint.json** file is private data even though
it contains no raw provider response.

## Manifest

Paths may be absolute or relative to `manifest.json`. A simple-document case reserves exactly one
provider call. A tax-package case reserves one classification call plus the maximum number of form
instances the reviewers expect the classifier to return. The runner refuses a tax result that
would exceed that case limit and refuses a manifest whose total reservation exceeds its declared
budget.

```json
{
  "schemaVersion": "1",
  "dataset": {
    "datasetId": "complex-borrower-redacted-v1",
    "version": "1",
    "path": "labels.json",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  },
  "providerCallBudget": 52,
  "cases": [
    {
      "caseId": "pay-001",
      "sourcePath": "sources/pay-001.pdf",
      "sourceSha256": "<64 lowercase hex characters>",
      "mimeType": "application/pdf",
      "extractor": "pay_stub",
      "maxProviderCalls": 1
    },
    {
      "caseId": "tax-001",
      "sourcePath": "sources/tax-001.pdf",
      "sourceSha256": "<64 lowercase hex characters>",
      "mimeType": "application/pdf",
      "extractor": "tax_package",
      "maxProviderCalls": 8
    }
  ]
}
```

Allowed extractors are `pay_stub`, `w2`, `bank_statement`, `lease_agreement` and `tax_package`.
Allowed MIME types are PDF, JPEG and PNG. Compute every source digest from the final redacted bytes;
any later edit deliberately breaks the run. On macOS or Linux, `shasum -a 256 <source>` prints the
digest. The preflight rejects a field key that the selected production extractor can never emit.

## Labels and the two-way hash binding

The private **labels.json** file uses `ExtractionBenchmarkDataset` from
[`extractionBenchmark.ts`](../../server/services/extractionBenchmark.ts). Each case needs an exact
document type, situation tags, source page count, evidence-backed field values and logical-document
boundaries. Every production case also records the two opaque reviewer IDs and whether they agreed
or required adjudication. It must contain at least one critical field, one logical document and one
situation tag. Set `impact` to `critical` under the approved labeling protocol; critical-field
accuracy is scored separately so a large number of easy fields cannot conceal a mortgage-impacting
error.

Simple-document field keys are the production field paths. Examples include `grossPay`,
`wagesTipsOtherCompensation`, `closingBalance`, `statementPeriod.end` and `monthlyRent`. The expected
document type is the page classifier's taxonomy value such as `paystub`, `w2`,
`bank_statement_checking`, `bank_statement_savings` or `lease_agreement`.

Tax-package fields use source-order ordinals so entity names never appear in keys. For example, the
first and second Schedule C bottom lines are `schedule_c[1].netProfitOrLoss` and
`schedule_c[2].netProfitOrLoss`. Ordinals restart for each form type and follow ascending source
page. A successfully classified tax case has document type `tax_package`; its logical documents use
the form types and exact page ranges returned by the classifier.

Create the binding in this order:

1. Finish the manifest's case list, source hashes and call budget. Leave `dataset.sha256` as 64
   zeroes.
2. Complete the resolved **labels.json**, including its dataset identity, reviewer roster,
   case-level review records, claim scope, thresholds and cases. Leave `labeling.manifestSha256` as
   64 zeroes. Do not show model output to either reviewer before this file is frozen.
3. Bind both files with private atomic file replacements:

   ```bash
   pnpm benchmark:extraction:run --manifest /private/homiquity-extraction-eval/manifest.json --bind-labels
   ```

The command requires the manifest's label digest placeholder to still be 64 zeroes, verifies the
dataset and manifest identities and case lists, writes the canonical manifest identity into the
labels, then writes the final label-file digest into the manifest. It refuses to overwrite an
already-bound pair; make a private copy and restore the two zero placeholders before deliberately
rebinding changed labels. `--print-manifest-sha` remains available for an independent digest check.
The canonical manifest identity excludes only the label-file digest, avoiding a circular hash while
the final pair still binds in both directions.

Changing the case list, sources, paths, MIME types, extractor choice or call limits changes the
manifest identity. Changing any label changes the dataset digest. A resume works only when both
digests still match its checkpoint.

## Validate, run and resume

First validate every permission, hash, signature, ID and page count without loading a provider
credential or making a paid call:

```bash
pnpm benchmark:extraction:run --manifest /private/homiquity-extraction-eval/manifest.json --dry-run
```

The output includes document/extractor counts, planned calls, production-claim readiness and every
preflight blocker. A production-redacted live run refuses to load a provider credential, create an
output directory or make a provider call until this preflight could support a claim assuming the
candidate extraction meets the frozen thresholds. Synthetic runs remain available for engineering
checks and are always claim-ineligible.

For a live run, supply the managed Anthropic credential to the local process and keep
`EXTRACTION_SIMULATE` unset. The runner refuses production-service execution and simulation. Start
with a bounded tranche when validating a new dataset:

```bash
pnpm benchmark:extraction:run \
  --manifest /private/homiquity-extraction-eval/manifest.json \
  --output /private/homiquity-extraction-eval/output \
  --max-cases 5
```

Each provider-call reservation, including its case ID, is written atomically before the call. The
per-case count survives an interruption, so a restart cannot reset a case limit or erase a paid
attempt. Each finished case is then written to the private **output/checkpoint.json** file with
source, model, prompt and raw-response hashes, extracted predictions and fixed failure codes. It
does not retain raw response text, ciphertext, document
bytes, provider warnings or source paths. Continue the same immutable run with:

```bash
pnpm benchmark:extraction:run \
  --manifest /private/homiquity-extraction-eval/manifest.json \
  --output /private/homiquity-extraction-eval/output \
  --resume \
  --max-cases 5
```

Completed cases are not called again. A failed or interrupted case can continue only while both its
per-case limit and the original manifest budget have room. Earlier failures and provider calls with
missing response lineage remain in the checkpoint and keep that run ineligible for an accuracy
claim. Use a new output directory for a clean rerun, a new manifest, a model/prompt revision or an
adjudicated label set. One process holds the output-directory lock at a time. If the process is
forcibly terminated, verify that no evaluation still uses that directory, then remove the private
**.extraction-evaluation.lock** file before resuming. A fresh run refuses to overwrite either an
existing checkpoint or report.

The generated private **output/report.json** file contains aggregate metrics, run completeness,
failure counts, provider-call use, model/prompt lineage and the benchmark's claim blockers. It
contains no field predictions.
Only this aggregate report may be copied into a repository evidence record, after checking it for
small-segment disclosure. Keep the checkpoint and all inputs in the private workspace.
