-- Preserve borrower-reported business identity independently of tax-derived
-- enrichment. A borrower can assign a P&L to their side business before tax
-- extraction, and revoking tax-document consent must not erase that fact.
ALTER TABLE "borrower_business_entities"
  ADD COLUMN IF NOT EXISTS "reported_by_borrower" boolean NOT NULL DEFAULT false;
