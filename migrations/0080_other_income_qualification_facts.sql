-- Capture the tax treatment and continuance facts required to qualify URLA
-- Section 1e income under Selling Guide B3-3.1-01. Favorable gross-up remains
-- gated by approval of the current evidence-backed income workpaper.
ALTER TABLE "other_income_sources"
  ADD COLUMN IF NOT EXISTS "tax_treatment" varchar(32),
  ADD COLUMN IF NOT EXISTS "non_taxable_monthly_amount" numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "has_defined_expiration" boolean,
  ADD COLUMN IF NOT EXISTS "expiration_date" date;

DO $$ BEGIN
  ALTER TABLE "other_income_sources"
    ADD CONSTRAINT "other_income_sources_tax_treatment"
    CHECK (
      "tax_treatment" IS NULL
      OR "tax_treatment" IN ('taxable', 'fully_non_taxable', 'partially_non_taxable', 'unknown')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "other_income_sources"
    ADD CONSTRAINT "other_income_sources_non_taxable_amount"
    CHECK (
      "non_taxable_monthly_amount" IS NULL
      OR (
        "non_taxable_monthly_amount" >= 0
        AND "non_taxable_monthly_amount" <= "monthly_amount"
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "other_income_sources"
    ADD CONSTRAINT "other_income_sources_expiration_shape"
    CHECK (
      "has_defined_expiration" IS DISTINCT FROM false
      OR "expiration_date" IS NULL
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
