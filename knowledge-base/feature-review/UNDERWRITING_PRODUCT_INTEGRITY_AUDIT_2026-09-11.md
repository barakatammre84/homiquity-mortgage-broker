# Underwriting Product-Integrity Audit — 2026-09-11

## Decision question

Can the current build evaluate a borrower's selected mortgage program without changing the product,
borrowing another program's rules, losing payment components, or producing a result that cannot be
reconstructed?

**Audited production base:** `5f3c086b61d5ad61f80f511367e888c13a9a2e5c`  
**Release candidate:** `codex/underwriting-product-intent`

The answer after this pass is **yes for the internally automated conventional fixed purchase and
selected VA paths, with explicit limits**. FHA, USDA, jumbo, ARM, HELOC and other portfolio families
remain human-review paths. Live bureau data, AUS findings, market pricing and lender acceptance are
still external dependencies, so this is not evidence of an issued lender approval.

## What the audit found

| Seam | Previous behavior | Consequence |
|---|---|---|
| Application to engine | Veteran status selected VA; everyone else became conventional | A stored FHA/USDA choice could be evaluated with conventional rules, while a veteran's conventional choice became VA |
| Payment projection | Veteran status changed pricing to VA | The displayed payment could describe a different product from the application |
| Offer qualification | Results were cached by rounded PITI only | Equal-payment offers from different programs could share one underwriting result |
| Preapproval letters | Product label came from veteran status | A letter could name VA when the approved policy result was conventional |
| Rejected conventional payment | Any rejection skipped PMI and LLPA resolution | A high-DTI rejection could show an artificially low payment with mortgage insurance removed |
| Policy snapshot | Several eligibility thresholds and VA constants were absent | The decision fingerprint could not reconstruct all rules actually used |
| Maximum purchase | Policy failure silently substituted 43%; VA used conventional sizing | A borrower-facing amount could depend on an absent rule or the wrong program's math |
| Credit strengths | Any positive score was a strength and the copy hardcoded 620 | A score below the resolved floor could appear as both a strength and rejection reason |

## Implemented decision contract

The product family is now a required underwriting input. Veteran status is an eligibility signal and
never selects a mortgage product. The application selection, evaluated program and selection basis
are included in the decision-input fingerprint. Offer qualification uses a program-and-payment cache
key, and letter product labels come from the resolved underwriting result.

The fast application still avoids asking a novice borrower to choose a product. When no selection is
stored, a preliminary decision may evaluate a clearly labeled conventional candidate. A verified
result requires the application selection. Unsupported product families reach a typed manual-review
outcome before an unrelated policy matrix is queried.

A rejected but priceable conventional loan retains resolved PMI and LLPA. Product/FICO/LTV
coordinates that have no valid matrix cell still fail safely. The resolved-policy fingerprint now
captures the eligibility and residual-income values used by the result, and the maximum-purchase
path refuses a missing or implausible DTI policy value.

## Current support boundary

| Product/state | Current behavior | Honest next gate |
|---|---|---|
| No product selected, preliminary file | Labeled conventional candidate | Obtain the borrower's actual selection before decision-grade use |
| Conventional, fixed purchase | Deterministic internal evaluation | Live bureau report, current AUS findings, licensed review and lender acceptance |
| VA selected with eligibility signal and residual inputs | Deterministic evaluation of the requested amount | Verify entitlement, current VA/AUS findings and lender overlays |
| VA selected without eligibility signal | Human review | Confirm eligibility; do not switch the product |
| FHA or USDA | Human review before automated underwriting | Implement from current governing handbook, AUS requirements and selected lender overlays |
| Jumbo, ARM, HELOC or other portfolio product | Human review | Capture the full product terms and selected lender matrix before automation |

## Proof completed in this release

Focused automated validation covers explicit program selection, a veteran remaining conventional,
verified files requiring a selected product, unsupported product routing, VA eligibility conflicts,
same-payment cross-program offers, product-aware veteran pricing, rejected-file PMI, policy-store
failure, invalid DTI policy, VA amount sizing, resolved-floor credit language, letter integrity and
production-canary behavior. TypeScript and the focused 192-test underwriting lane pass.

The production canary has also been strengthened. Its underwriting operation must now prove explicit
conventional selection, a veteran's conventional selection remaining conventional, deterministic
repeatability and typed rejection of unsupported FHA automation. That strengthened proof becomes
valid only after the exact release commit is deployed and the live canary passes.

## Remaining best-in-class gaps

1. The application currently carries an application-level credit score. A representative score based
   on a current multi-borrower bureau report is not yet available because the live credit provider is
   not connected.
2. Rate and payment estimates are internal deterministic estimates, not current lender pricing. A
   selected lender rate sheet, lock policy and price-adjustment lineage must replace the planning
   rate card before the product can claim live best execution.
3. Conventional and VA policy coverage is still narrower than an AUS and lender overlay. The engine
   must remain advisory until current DU/LPA or VA findings and human review are retained.
4. FHA and USDA need their own cited input models, conditions and golden cases. Reusing conventional
   thresholds would create false approvals.
5. The external finish line remains one redacted representative complex-borrower file whose document
   evidence, income workpapers, credit, AUS findings, conditions and lender-ready package are reviewed
   and accepted by a real receiver.

## Governing sources

- [Fannie Mae — Mortgage eligibility](https://selling-guide.fanniemae.com/sel/b2-1/mortgage-eligibility)
- [HUD — FHA Single Family Housing Policy Handbook 4000.1](https://www.hud.gov/hud-partners/single-family-handbook-4000-1)
- [U.S. Department of Veterans Affairs — VA Lenders Handbook, Pamphlet 26-7](https://www.benefits.va.gov/WARMS/docs/admin26/m26-07/Lender_Handbook_VA_Pamphlet_Complete.pdf)
- [USDA Rural Development — HB-1-3555, Guaranteed Loan Program](https://www.rd.usda.gov/media/file/download/hb-1-3555-consolidated.pdf)
