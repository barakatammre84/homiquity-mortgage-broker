ALTER TABLE "decision_snapshots"
  ADD COLUMN IF NOT EXISTS "input_fingerprint" varchar(64);

ALTER TABLE "decision_snapshots"
  DROP CONSTRAINT IF EXISTS "decision_snapshots_input_fingerprint_shape";

ALTER TABLE "decision_snapshots"
  ADD CONSTRAINT "decision_snapshots_input_fingerprint_shape"
  CHECK ("input_fingerprint" IS NULL OR "input_fingerprint" ~ '^[a-f0-9]{64}$');
