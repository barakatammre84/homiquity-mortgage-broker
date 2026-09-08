# 05 — Data Flow: A Loan's Journey

This is the critical path — understand this and the rest of the codebase is
just supporting detail.

```
  Borrower                      System                                   Staff
  ────────                      ──────                                   ─────
  1. Affordability check   →  propertyAnalyzer + calculators
  2. Pre-approval form     →  loan_applications + URLA tables
     (conversational 1003)
  3. Coach conversation    →  coachingService (Anthropic Claude) → structured intake
  4. Document upload       →  GCS (signed URL) → extractionService
                               → Claude extraction → extraction results
                               → documentConfidence scoring
  5. Plaid link            →  verification.ts → income/employment/asset data
                                      │
                                      ▼
  6.                    BorrowerGraph (borrowerGraph.ts)
                        aggregates EVERYTHING about the borrower
                        into one queryable profile (3-tier trust:
                        self-reported < documented < verified)
                                      │
                                      ▼
  7.                    Underwriting (underwritingEngine.ts + ruleEngine.ts)
                        deterministic rules (Fannie/Freddie-aligned DSL)
                        + pricing (pricing.ts / pricingAdapter.ts: base rate
                        + LLPA + lock-term + lender adjustments)
                                      │
                          ┌───────────┴──────────┐
                          ▼                      ▼
  8a. Approved: pdfLetterGenerator    8b. Needs review: taskEngine creates
      → pre-approval letter PDF           staff tasks; loan appears in the
      → borrower dashboard                Loan Pipeline; staff work items
                          │
                          ▼
  9. MISMO 3.4 XML export (mismo.ts) → lender/GSE handoff
 10. Outcome tracking (outcomeTracker, analyticsEventPipeline)
     feeds the predictive engine and staff dashboards
```

## Stage-by-stage, with the files that own each step

### 1–2. Intake
- Public affordability tools: `client/src/pages/public/AffordabilityCheck.tsx`,
  `server/propertyAnalyzer.ts`, `server/routes/calculators.ts`.
- The pre-approval application is a conversational, step-at-a-time form
  (`client/src/pages/borrower/`); it writes `loan_applications` plus the URLA
  (Form 1003) tables in `shared/schema/lendingCore.ts`/`lendingUrla.ts` via
  `server/routes/borrower/urla.ts`.

### 3. Coach
- `server/routes/coach.ts` + the `server/services/coaching*.ts` family
  (Claude Sonnet 5; `coachingService.ts` is the re-export shim, the turn loop
  lives in `coachingTurn.ts`). Conversations are stored
  (`shared/schema/coach.ts`) and mined for structured intake data that also
  lands in the borrower profile.

### 4. Documents
- Client asks `server/routes/documents.ts` for an **upload URL** → uploads the
  file **directly to GCS** (the server never proxies bytes).
- The `server/extraction*.ts` family runs document extraction (pay stubs,
  bank statements, leases and tax returns; `extractionService.ts` is the re-export shim,
  per-doc extractors live in `extractionDocuments.ts`);
  `server/services/documentConfidence.ts` scores how trustworthy the
  extraction is. Ordinary borrower uploads launch this work in the web process;
  a durable extraction queue and restart recovery remain open.

### 5. Verification
- `server/plaid.ts` + `server/services/verification.ts`: borrower links
  accounts/payroll via Plaid Link; results upgrade data from "self-reported"
  to "verified" in the trust model.

### 6. Borrower Graph — the read layer
- `server/services/borrowerGraph.ts` is the **single most important service**:
  it aggregates applications, documents, coach data, Plaid results, and
  activity into one profile with per-fact trust tiers. Dashboards, property
  intelligence, and underwriting all read from it.
- Sibling services: `borrowerStateMachine.ts` (stage tracking),
  `intentTracker.ts`, `lenderMatchingEngine.ts`.

### 7. Decisioning
- `server/underwritingEngine.ts` + `server/services/ruleEngine.ts` evaluate a
  **deterministic rules DSL** (editable via `server/routes/underwriting-rules.ts`
  and policy-ops) — deliberately not an LLM, for Fair-Lending/ECOA reasons:
  same inputs, same answer, every time, with logged findings.
- Pricing: `server/pricing.ts` (LLPA math) + `server/services/pricingAdapter.ts`
  (compose base rate + adjustments across wholesale lenders from rate sheets).
- `server/services/decisionEngine.ts` orchestrates decision records.

### 8. Outputs
- `server/services/pdfLetterGenerator.ts` + `loanEstimate.ts` — branded PDFs.
- `server/services/taskEngine.ts` — rules-driven staff task creation
  (assignments, SLAs) surfacing in the Staff Dashboard pipeline.
- **LO handoff & claim (added #135, 2026-07-12):** a submitted application with no
  assigned LO lands in the LO Command Center's **intake pool**; an LO/LOA claims it
  via `POST /api/loan-applications/:applicationId/claim`
  (`server/routes/underwriting/pipeline.ts`), which routes through the single
  `assignLoanOfficer` chokepoint in `server/storage/pipeline.ts` (atomic claim +
  deal-team visibility). The cockpit reads `server/routes/cockpit.ts`
  (`/api/staff/signals`, `/api/staff/applications/:id/cockpit`).
- `server/services/emailService.ts` — notifications (console-logged until an
  SMTP/SendGrid provider is configured).

### 9. GSE and lender handoff
- `server/mismo.ts` exports MISMO 3.4 XML; `mismoValidation.ts` checks
  completeness/ULDD requirements (tested by `tests/mismoValidation.test.ts`).
  DU/LPA and the lender receiver are still simulations until onboarding and
  receiver acceptance are completed.

### 10. Feedback loop
- `analyticsEventPipeline.ts`, `outcomeTracker.ts`, `predictiveEngine.ts`,
  `optimizationEngine.ts` — funnels, prediction, benchmarks; surfaced via
  `server/routes/data-intelligence.ts` in the Staff Dashboard.

## Where state lives at each step

| Concern | Storage |
|---------|---------|
| Who is logged in | `sessions` table (cookie: `connect.sid`) |
| Application progress | `loan_applications` + URLA tables + `borrower_state_history` |
| Files | GCS bucket (paths in `documents` table) |
| What we believe about the borrower | Borrower graph (computed) + `borrower_profiles` etc. |
| Why we decided | Decision + findings tables (`underwriting.ts`, `decisions.ts` schemas) |
| Everything compliance-sensitive | Consent/audit tables, encrypted + hash-chained |
