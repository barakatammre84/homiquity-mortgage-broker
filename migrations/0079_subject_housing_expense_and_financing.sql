-- Capture every borrower-specific B3-6-03 subject housing-expense component
-- and the balances needed for B2-1.2-02 / B2-1.2-03 CLTV and HCLTV.
ALTER TABLE "urla_property_info"
  ADD COLUMN IF NOT EXISTS "monthly_flood_insurance" numeric(10, 2),
  ADD COLUMN IF NOT EXISTS "monthly_ground_rent" numeric(10, 2),
  ADD COLUMN IF NOT EXISTS "monthly_special_assessments" numeric(10, 2),
  ADD COLUMN IF NOT EXISTS "subordinate_financing_exists" boolean,
  ADD COLUMN IF NOT EXISTS "closed_end_subordinate_balance" numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "heloc_drawn_balance" numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "heloc_credit_limit" numeric(12, 2),
  ADD COLUMN IF NOT EXISTS "monthly_subordinate_financing_payment" numeric(10, 2);

DO $$ BEGIN
  ALTER TABLE "urla_property_info"
    ADD CONSTRAINT "urla_property_info_subject_costs_nonnegative"
    CHECK (
      ("monthly_flood_insurance" IS NULL OR "monthly_flood_insurance" >= 0)
      AND ("monthly_ground_rent" IS NULL OR "monthly_ground_rent" >= 0)
      AND ("monthly_special_assessments" IS NULL OR "monthly_special_assessments" >= 0)
      AND ("closed_end_subordinate_balance" IS NULL OR "closed_end_subordinate_balance" >= 0)
      AND ("heloc_drawn_balance" IS NULL OR "heloc_drawn_balance" >= 0)
      AND ("heloc_credit_limit" IS NULL OR "heloc_credit_limit" >= 0)
      AND ("monthly_subordinate_financing_payment" IS NULL OR "monthly_subordinate_financing_payment" >= 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "urla_property_info"
    ADD CONSTRAINT "urla_property_info_heloc_limit_covers_drawn"
    CHECK (
      "heloc_drawn_balance" IS NULL
      OR "heloc_credit_limit" IS NULL
      OR "heloc_credit_limit" >= "heloc_drawn_balance"
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "urla_property_info"
    ADD CONSTRAINT "urla_property_info_subordinate_financing_shape"
    CHECK (
      "subordinate_financing_exists" IS DISTINCT FROM false
      OR (
        COALESCE("closed_end_subordinate_balance", 0) = 0
        AND COALESCE("heloc_drawn_balance", 0) = 0
        AND COALESCE("heloc_credit_limit", 0) = 0
        AND COALESCE("monthly_subordinate_financing_payment", 0) = 0
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
