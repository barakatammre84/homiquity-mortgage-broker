ALTER TABLE "pre_approval_letters"
  ADD COLUMN IF NOT EXISTS "decision_input_fingerprint" varchar(64),
  ADD COLUMN IF NOT EXISTS "policy_fingerprint" varchar(64);

ALTER TABLE "pre_approval_letters"
  DROP CONSTRAINT IF EXISTS "pre_approval_letters_decision_fingerprint_shape";
ALTER TABLE "pre_approval_letters"
  ADD CONSTRAINT "pre_approval_letters_decision_fingerprint_shape"
  CHECK (
    ("decision_input_fingerprint" IS NULL OR "decision_input_fingerprint" ~ '^[a-f0-9]{64}$')
    AND ("policy_fingerprint" IS NULL OR "policy_fingerprint" ~ '^[a-f0-9]{64}$')
  );
