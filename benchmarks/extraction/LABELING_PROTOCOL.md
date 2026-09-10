# Mortgage extraction labeling protocol

**Protocol version:** `mortgage-extraction-v1`

This protocol produces the human truth set used to measure Homiquity's document extraction. It is
designed for redacted borrower documents in a controlled private workspace. No source document,
label file, reviewer name, account number, tax identifier or model prediction belongs in this
repository.

## Roles and independence

Assign each reviewer an opaque ID such as `reviewer-a`. Keep the identity-to-ID roster in the
private workspace. Two reviewers label every case independently from the redacted source before
either reviewer sees the other's labels or the model prediction. A reviewer cannot label a case
they prepared or redacted.

After both submissions are locked, compare the field value, original page, document type and every
logical-document boundary. Mark the case `agreement` when every item matches. Mark it `adjudicated`
when any disagreement occurred, and have a qualified mortgage reviewer resolve the disagreement
against the source. The final case records both opaque reviewer IDs and the resolution. Preserve
the two original submissions and the adjudication log in private storage; the private **labels.json** contains
only the resolved truth.

## What to label

Each case must contain:

- a neutral case ID with no borrower or business name;
- the exact source page count;
- one or more complex-borrower situation tags;
- every supported field that is visibly present, with its original 1-indexed source page;
- at least one calculation-critical field marked `critical`; and
- every logical document with its exact type and inclusive source-page range.

Do not infer a value that is absent, illegible or only implied. Do not label a derived monthly
income when the source contains only a yearly value. Do not convert signs, periods or units inside
the truth set. Use JSON numbers for monetary and numeric values, ISO dates (`YYYY-MM-DD`) when the
document supplies a complete date, booleans for true/false fields and strings for identifiers or
text. Preserve a negative number as negative.

The fields the production evaluator can score are listed in
[`extractionEvaluationRunner.ts`](../../server/services/extractionEvaluationRunner.ts). The
preflight rejects any simple-document field the selected extractor cannot emit. Tax fields use
`form_type[ordinal].fieldName`, where the ordinal follows source-page order and restarts for each
form type, for example `schedule_c[1].netProfitOrLoss`.

At minimum, treat these calculation inputs as critical when present:

| Document | Critical fields |
|---|---|
| Pay statement | `grossPay`, `ytdGross`, pay-period dates |
| W-2 | `taxYear`, `wagesTipsOtherCompensation`, applicable wage boxes |
| Bank statement | statement-period dates, `openingBalance`, `closingBalance` |
| Lease | `monthlyRent`, `propertyAddress`, lease dates |
| Tax package | income/loss and adjustment fields used by the supported Schedule C, E, K-1, 1120S, 1065 and 1120 workpapers |

## Population and acceptance

Freeze the document types, situation tags and thresholds before running the candidate model. Every
claimed document type and every claimed complex-borrower tag needs at least 30 independently
reviewed cases. Include born-digital PDFs plus real redacted scans across rotation, skew, faint text,
multi-page statements, repeated tax forms, multiple businesses and multiple rentals. Do not count
the same source document twice.

Homiquity's code-enforced minimum production-claim threshold is 0.98 for value precision, value
recall, source-page attribution, document type, boundary precision, boundary recall, critical-field
accuracy and the business-weighted field score. A pre-registered dataset may require stricter
thresholds. Passing this floor supports only the named population, model and prompt version; it is
not, by itself, a comparative “best in class” claim.

## Finalization

Complete both reviews and adjudication before adding the case to the resolved label file. Verify
that every label came from the final redacted bytes. Then use the protected evaluator's
`--bind-labels` command to bind the resolved labels and manifest, followed by `--dry-run`. Do not
expose the model's output to reviewers until the labels and acceptance thresholds are immutable.
