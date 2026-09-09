# Extraction accuracy benchmark

This folder is the intake point for a versioned, human-labeled document set. Do not commit raw
borrower documents, names, account numbers, tax identifiers or unredacted model responses.

Run a score with:

```sh
pnpm benchmark:extraction ground-truth.json predictions.json
```

Every case must label exact expected fields, original source pages, business impact and logical
document boundaries. Tag the borrower situation (for example `w2_plus_business`, `multi_rental`,
`scanned`, `handwritten` or `multi_document`) so an overall average cannot hide a weak complex-file
segment. Predictions must name their model and prompt versions and match the dataset id and version.

The scorer reports value precision/recall, false fields, missing fields, page attribution, document
classification, boundary precision/recall and a business-weighted field score. It refuses to mark synthetic sets or document types
with fewer than 30 human-labeled cases as eligible for a production accuracy claim. Store approved
redacted datasets in controlled private storage and place only their manifest and aggregate report
in the repository.
