# Mixed-income analysis loop — 2026-09-08

## Verdict

**PASS for a truthful fast estimate and an internally complete handoff into detailed review.** A
fictional W-2 borrower with a side business moved through the real application, document plan and
full URLA. The same $170,000 household total remained intact throughout: $125,000 of primary W-2
income and $45,000 from Harbor Studio LLC. The intake no longer adds the business income twice,
drops it on the way to URLA, or describes a self-reported amount as mortgage qualifying income.

This is still not a lender-approved income result. A licensed reviewer must use accepted tax and
business evidence, approve the current workpapers and retain the resulting memo before Homiquity
can mark income verified.

## Benchmark and authority

Better.com's public flow is the speed benchmark. Better asks for a stated household total and says
its online pre-approval can be completed in as little as three minutes. Its own guidance also says
that a W-2 borrower with substantial freelance income may require self-employment analysis, and
that business write-offs can make qualifying income materially lower than reported cash inflow.

Fannie Mae provides the decision-grade standard. Each simultaneous income source must meet its own
requirements. A borrower with at least 25% business ownership is self-employed. The analysis must
consider history, stability, continuance, business viability, distributions and liquidity; each
business is evaluated separately; and a written cash-flow analysis or Income Calculator findings
must remain in the loan file. Rental income has its own Schedule E, lease and property analysis.

Sources reviewed:

- [Better: fast mortgage pre-approval](https://better.com/content/how-to-get-pre-approved-for-a-mortgage)
- [Better: self-employed and gig-worker mortgages](https://better.com/content/mortgage-for-self-employed-gig-workers)
- [Better: mortgage tax-return review](https://better.com/content/what-do-mortgage-lenders-look-for-on-your-tax-returns)
- [Fannie Mae B3-3.2-02: employment-related income](https://selling-guide.fanniemae.com/sel/b3-3.2-02/standards-employment-related-income)
- [Fannie Mae B3-3.5-01: self-employed borrowers](https://selling-guide.fanniemae.com/sel/b3-3.5-01/underwriting-factors-and-documentation-self-employed-borrower)
- [Fannie Mae Income Calculator](https://singlefamily.fanniemae.com/applications-technology/income-calculator)
- [Fannie Mae B3-3.8-01: rental income](https://selling-guide.fanniemae.com/sel/b3-3.8-01/rental-income)

## The correct analysis model

Homiquity needs two clearly separated layers:

1. **Fast planning estimate.** Ask once for the household total, let the borrower explain what is
   inside it, reconcile the breakdown, estimate DTI from the total once, and label every result as
   self-reported and preliminary. Complex income changes the document plan and review path; it
   cannot create a green eligibility claim.
2. **Decision-grade qualifying income.** Build a source-by-source workpaper from accepted evidence.
   Verify W-2 and variable income separately; calculate each Schedule C, K-1/S-corporation,
   partnership and rental source under its own rules; assess trends, ownership, distributions and
   liquidity; include negative income and business obligations; record source pages and versions;
   require licensed human approval; and make the approved memo the only evidence that can promote
   the income dimension to verified.

The loan officer should be able to compare reported and calculated amounts, see why each adjustment
was made, identify the exact missing document or judgment, and test lender/program alternatives
without changing the borrower's original facts.

## Gaps found and fixed

- The live panel treated the detailed source rows as extra income, so a $170,000 household total
  plus a $45,000 side business could appear as $215,000. It now uses the household total once and
  shows the detailed sum and unexplained remainder.
- The panel used the label “qualifying income” before any evidence existed and could show a green
  “manageable” signal for complex income. It now says “reported household income,” labels the ratio
  as an estimate and explains that the loan team will recalculate it from documents.
- The fast application did not capture the side business's structure or ownership. It now captures
  business name, history, structure and ownership, and blocks an incomplete business source.
- The borrower graph used the detailed source as a replacement for the total in some paths and as
  an addition in others. It now retains source detail for explanation while using one aggregate
  amount for the preliminary DTI.
- URLA dropped a side business after a W-2 answer. It now creates separate current W-2 and
  additional self-employment records and preloads the correct worksheet type, ownership and
  history without pretending zero-filled tax fields are complete.
- Additional W-2, pension, Social Security, investment and other income can now survive the handoff
  into the appropriate URLA employment or other-income section. A generic investment answer stays
  generic until the detailed review classifies it; the handoff no longer guesses that it is
  dividends. Rental stays in its property workpaper so it is not duplicated.
- The browser blocked a breakdown above the household total, but a direct partial draft update
  could change only one side and bypass that comparison. The server now reconciles partial updates
  against the stored counterpart and rejects the same contradiction before it reaches the file.
- The initial results page could show a partial action list because rate scenarios appeared before
  the document plan finished. It now keeps refreshing until intake finalization is complete and
  selects the newly submitted file for every shell surface.

## Real rerun

The final local journey used application `db8774ea-f01b-4fc3-8aa4-1356f1e9f91c`: purchase,
primary single-family home, $650,000 price, $130,000 down, Illinois, $170,000 household income,
$125,000 implicit W-2 income, Harbor Studio LLC at $45,000, four years, single-member LLC and 100%
ownership, $800 monthly debt and a 720–759 stated credit range.

An intentional $180,000 business entry was stopped because it exceeded the $170,000 household
total. After correction, the live estimate showed $170,000 and an estimated 33% DTI with the
complex-income verification warning. Submission produced one nine-item action plan on both the
results page and sidebar, including two years of W-2s, applicable personal/business returns and
K-1s, business bank statements and a current P&L. URLA showed $10,416.67 monthly W-2 income plus
$3,750 monthly side-business income and carried the business metadata into the Schedule C
worksheet.

Focused client and server checks passed after the rerun. The repository-wide release gate remains
the final requirement before merge.

## Remaining proof

- Run the same workflow with current accepted evidence from a real pilot borrower and have the
  licensed reviewer reproduce and approve the result.
- Compare the approved Homiquity result with the selected lender's calculation/findings and resolve
  every difference before submission.
- Prove the approved lender accepts the resulting package and its evidence references.
- Measure time to verified income, borrower clarification requests, document re-uploads and loan
  officer touches. Those results determine the next automation; the synthetic walk cannot set the
  operating baseline.
