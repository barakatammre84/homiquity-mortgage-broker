-- Preserve the score set for every borrower on a joint credit report. The
-- existing top-level scores remain the controlling borrower's values for
-- backward compatibility and adverse-action reporting.
ALTER TABLE "credit_pulls"
  ADD COLUMN IF NOT EXISTS "borrower_scores" jsonb;
