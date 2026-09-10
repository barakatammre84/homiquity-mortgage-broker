# Extraction accuracy benchmark

This folder defines the contract for a versioned, human-labeled document set. Do not commit raw
borrower documents, completed labels, names, account numbers, tax identifiers or unredacted model
responses. Copy [`manifest.template.json`](manifest.template.json) and
[`labels.template.json`](labels.template.json) into the protected workspace, then follow the
[`mortgage-extraction-v1` labeling protocol](LABELING_PROTOCOL.md) and the
[protected evaluation runbook](../../knowledge-base/runbooks/EXTRACTION_EVALUATION.md).

Run a score with:

```sh
pnpm benchmark:extraction ground-truth.json predictions.json
```

Every case must label exact expected fields, original source pages, business impact and logical
document boundaries. Tag the borrower situation (for example `w2_plus_business`, `multi_rental`,
`scanned`, `handwritten` or `multi_document`) so an overall average cannot hide a weak complex-file
segment.

A production-redacted dataset also declares:

- a versioned labeling protocol, an opaque reviewer roster, two independent reviewers recorded on
  every case and completed adjudication;
- the SHA-256 of its controlled private source manifest;
- the exact document types and complex-situation tags covered by the proposed claim; and
- acceptance thresholds approved before the candidate run is scored.

Predictions must name their model and prompt versions, match the dataset id and version, and carry
the same private-manifest SHA-256. The hash binds a prediction file to the exact labeled population
without putting borrower documents or identifiers in the repository.

The scorer reports value precision/recall, false fields, missing fields, page attribution, document
classification, boundary precision/recall, critical-field accuracy and a business-weighted field score. It reports evidence
eligibility separately from threshold performance. A production claim passes only when the set is
manifest-bound and independently adjudicated, every claimed document type and situation has at
least 30 human-labeled cases, and the overall result plus every claimed segment meets every
pre-approved threshold. Production thresholds cannot be lower than the code-enforced 0.98 operating
floor. The live runner refuses provider use when a production-redacted dataset cannot pass these
preflight evidence checks. Store approved redacted datasets in controlled private storage and
place only their manifest digest and aggregate report in the repository.
