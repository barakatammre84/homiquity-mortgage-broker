-- Record product intent as first-class decision lineage. Unsupported programs
-- intentionally have no resolved_policy JSON, so a hash alone cannot tell a
-- reviewer which product reached manual review.
ALTER TABLE "decision_snapshots"
  ADD COLUMN IF NOT EXISTS "loan_program" varchar(30),
  ADD COLUMN IF NOT EXISTS "loan_program_selection" varchar(50);

ALTER TABLE "decision_snapshots"
  DROP CONSTRAINT IF EXISTS "decision_snapshots_loan_program_values";
ALTER TABLE "decision_snapshots"
  ADD CONSTRAINT "decision_snapshots_loan_program_values"
  CHECK (
    "loan_program" IS NULL OR "loan_program" IN
      ('CONVENTIONAL', 'FHA', 'VA', 'USDA', 'JUMBO', 'ARM', 'HELOC', 'OTHER')
  );

ALTER TABLE "decision_snapshots"
  DROP CONSTRAINT IF EXISTS "decision_snapshots_loan_program_selection_values";
ALTER TABLE "decision_snapshots"
  ADD CONSTRAINT "decision_snapshots_loan_program_selection_values"
  CHECK (
    "loan_program_selection" IS NULL OR "loan_program_selection" IN
      ('application_selected', 'preliminary_conventional_candidate')
  );
