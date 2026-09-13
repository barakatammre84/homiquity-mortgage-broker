-- Selling Guide B3-3.1-01 requires the lower stable amount when the borrower
-- is known to be moving to a lower pay structure (for example retirement or a
-- new job). Capture the disclosure and its calculation inputs explicitly.
ALTER TABLE "employment_history"
  ADD COLUMN "has_known_future_income_reduction" boolean,
  ADD COLUMN "future_monthly_income" numeric(12, 2),
  ADD COLUMN "future_income_effective_date" varchar(10),
  ADD COLUMN "future_income_reason" text;
