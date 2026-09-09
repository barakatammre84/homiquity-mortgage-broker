-- Preserve the exact dual-AUS findings sent with each lender package. The
-- application row is the live working copy; these submission columns are the
-- immutable, hash-verifiable package-of-record.
ALTER TABLE "lender_submissions"
  ADD COLUMN IF NOT EXISTS "aus_findings_json" jsonb,
  ADD COLUMN IF NOT EXISTS "aus_findings_hash" varchar(64),
  ADD COLUMN IF NOT EXISTS "aus_findings_generated_at" timestamp;

ALTER TABLE "lender_submissions"
  DROP CONSTRAINT IF EXISTS "lender_submissions_package_hash_shape";
ALTER TABLE "lender_submissions"
  ADD CONSTRAINT "lender_submissions_package_hash_shape"
  CHECK (
    ("mismo_package_hash" IS NULL OR "mismo_package_hash" ~ '^[a-f0-9]{64}$')
    AND ("income_package_hash" IS NULL OR "income_package_hash" ~ '^[a-f0-9]{64}$')
    AND ("aus_findings_hash" IS NULL OR "aus_findings_hash" ~ '^[a-f0-9]{64}$')
  );

CREATE OR REPLACE FUNCTION prevent_lender_submission_package_mutation()
RETURNS trigger AS $$
BEGIN
  IF NEW."readiness_snapshot" IS DISTINCT FROM OLD."readiness_snapshot"
    OR NEW."mismo_package_xml" IS DISTINCT FROM OLD."mismo_package_xml"
    OR NEW."mismo_package_hash" IS DISTINCT FROM OLD."mismo_package_hash"
    OR NEW."mismo_package_generated_at" IS DISTINCT FROM OLD."mismo_package_generated_at"
    OR NEW."income_package_json" IS DISTINCT FROM OLD."income_package_json"
    OR NEW."income_package_hash" IS DISTINCT FROM OLD."income_package_hash"
    OR NEW."income_package_generated_at" IS DISTINCT FROM OLD."income_package_generated_at"
    OR NEW."aus_findings_json" IS DISTINCT FROM OLD."aus_findings_json"
    OR NEW."aus_findings_hash" IS DISTINCT FROM OLD."aus_findings_hash"
    OR NEW."aus_findings_generated_at" IS DISTINCT FROM OLD."aus_findings_generated_at"
  THEN
    RAISE EXCEPTION 'lender submission package artifacts are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lender_submission_package_immutable ON "lender_submissions";
CREATE TRIGGER lender_submission_package_immutable
BEFORE UPDATE ON "lender_submissions"
FOR EACH ROW EXECUTE FUNCTION prevent_lender_submission_package_mutation();
