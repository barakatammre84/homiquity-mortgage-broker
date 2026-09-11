-- Selling Guide B3-3.1-01 makes income paid to or earned in virtual currency
-- ineligible. Capture an explicit answer per employment and other-income row;
-- NULL remains unknown and routes the income path to review.
ALTER TABLE "employment_history"
  ADD COLUMN IF NOT EXISTS "paid_in_virtual_currency" boolean;

ALTER TABLE "other_income_sources"
  ADD COLUMN IF NOT EXISTS "paid_in_virtual_currency" boolean;
