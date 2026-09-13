ALTER TABLE "other_income_sources"
  ADD COLUMN "linked_asset_account_last4" varchar(4),
  ADD COLUMN "asset_ownership_type" varchar(40),
  ADD COLUMN "has_unrestricted_access" boolean,
  ADD COLUMN "full_distribution_penalty_amount" numeric(12, 2),
  ADD COLUMN "funds_used_for_transaction" numeric(12, 2);
