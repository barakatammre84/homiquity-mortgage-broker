# Employment-related assets as qualifying income — Fannie Mae Selling Guide reference

Authoritative reference for the deterministic employment-related-asset income treatment
(`server/services/income/paths/employmentRelatedAssets.ts`, eligibility and evidence assembly in
`server/services/income/employmentRelatedAssetsEvidence.ts`, checklist rules in
`server/pipelineEngine.ts`). Per [CLAUDE.md](../../CLAUDE.md) and the `mortgage-calculations`
skill (**no-citation-no-implementation**): every rule applied in code must cite a section below.
**Never invent** a rule or threshold — if it is not verified here or in the primary source, stop
and flag it.

## Source

**B3-3.4-06, Employment Related Assets as Qualifying Income (03/04/2026)**, Selling Guide edition
08-05-2026, PDF pages 359–362 (Part B > Subpart B3 > Chapter B3-3 Income Assessment > Section
B3-3.4 Other Sources of Income). Verified on 2026-09-12 against the locally materialised text of
that edition (`docs/fannie-mae/selling-guide/`, gitignored because it is Fannie Mae's copyrighted
work, which is why this tracked summary exists). The Guide controls over this file; escalate
discrepancies rather than picking a side.

## What the section requires (paraphrased; thresholds verified)

**Loan parameters**

| Parameter | Requirement |
|---|---|
| Maximum LTV, CLTV and HCLTV | **70%**, or **80%** if the owner of the assets is **at least 62** at closing. If jointly owned, all owners must be borrowers on the loan and the borrower using the income must be at least 62. |
| Loan purpose | **Purchase and limited cash-out refinance only** |
| Occupancy | **Principal residence and second home only** |
| Units | As permitted by occupancy type |

If the loan does not meet these parameters, the assets may still be eligible under other income
rules (B3-3.4-08 interest and dividends, B3-3.4-03 annuity, pension or retirement income).

**Asset requirements**

- Owned individually by the borrower, or the co-owner is a co-borrower on the loan.
- Documentation complies with **B1-1-03** (allowable age of documents).
- If a penalty would apply to a complete distribution at the time of calculation, the penalty on a
  complete distribution (after transaction costs) is **subtracted**.
- A 401(k), IRA, SEP or Keogh account counts as unrestricted only if the borrower has the
  **unqualified and unlimited right** to request a distribution of all funds, regardless of tax
  withholding or penalty.
- Assets liquidated into a trust within 12 months of application are calculated the same way.
- **Ineligible:** non-employment-related assets (stock options, non-vested restricted stock,
  lawsuits, lottery winnings, sale of real estate, inheritance, divorce proceeds). Checking and
  savings balances generally do not qualify unless sourced from an eligible employment-related
  asset. **Virtual currency is not an eligible asset.**

**Documentation**

- A non-self-employed severance or lump-sum retirement distribution: distribution letter from the
  employer (Form 1099-R) and deposit to a verified asset account.
- A 401(k), IRA, SEP or Keogh account: unrestricted access; usable only if a distribution is not
  already set up, or the set-up distribution is not enough to qualify; the account and its asset
  composition documented with the most recent monthly, quarterly or annual statement.

**History and continuance.** No minimum history. Continuance need not be documented because the
income is calculated from the loan term.

**Determination of qualifying income.** Divide **net documented assets** by the **amortization
term of the loan in months**. Net documented assets = eligible assets − the penalty on a complete
distribution − funds used for down payment, closing costs and required reserves. The Guide's worked
example: $500,000 IRA − 10% penalty $50,000 − $100,000 for closing = $350,000; ÷ 360 = $972.22
per month.

## How the code applies it

- `buildEmploymentRelatedAssetsEvidence` refuses to qualify unless: the stored loan term is set;
  the note date is present; purpose is purchase or refinance; occupancy is principal residence or
  second home; LTV, CLTV and HCLTV are computable and the maximum is within 70% (80% at age 62 on
  the note date); each declared source links to exactly one retirement-type URLA asset by account
  last four; ownership is individual or joint with a co-borrower; unrestricted access is confirmed;
  the penalty and transaction-use amounts are entered (0 when none); and a reviewed retirement
  statement for that account, dated within the B1-1-03 window, carries the balance.
- `computeEmploymentRelatedAssetsPath` then divides the sum of net documented assets (balance −
  penalty − transaction funds, floored at zero) by the stored amortization term. The borrower's
  declared monthly amount is never used.

## Open readings for the founder

- **Limited cash-out.** The Guide allows purchase and *limited* cash-out refinance only. The
  application model records `refinance` without distinguishing limited from full cash-out, so the
  code accepts any refinance. A conservative fix is an explicit limited-cash-out flag before this
  path can qualify.
- **Lump-sum distributions** (severance, 1099-R) are described by the Guide but not modelled; the
  code supports retirement-account statements only, so a lump-sum case reports missing evidence.
