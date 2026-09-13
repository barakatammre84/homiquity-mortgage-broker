-- The selected amortization term is an input to employment-related asset
-- income under Fannie Mae B3-3.4-06. Keep it on the application so the
-- evidence workpaper and later loan option use the same stated term.
ALTER TABLE "loan_applications"
  ADD COLUMN "loan_term_months" integer DEFAULT 360 NOT NULL;

ALTER TABLE "loan_applications"
  ADD CONSTRAINT "loan_applications_loan_term_months_check"
  CHECK ("loan_term_months" IN (120, 180, 240, 300, 360));
