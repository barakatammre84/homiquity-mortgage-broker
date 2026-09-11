-- Capture the facts needed to count financed properties and calculate the
-- additional reserve requirement for mortgages and HELOCs (B2-2-03 / B3-4.1-01).
ALTER TABLE "real_estate_owned"
  ADD COLUMN IF NOT EXISTS "heloc_balance" numeric(14, 2),
  ADD COLUMN IF NOT EXISTS "heloc_payment" numeric(10, 2),
  ADD COLUMN IF NOT EXISTS "personally_obligated" boolean;
