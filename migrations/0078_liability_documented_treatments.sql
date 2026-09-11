-- Let the borrower disclose remaining term and student-loan plan, while
-- keeping borrower-favorable DTI treatment behind an evidence-linked staff
-- review tied to the current bureau tradeline (Fannie B3-6-05).
ALTER TABLE "urla_liabilities"
  ADD COLUMN IF NOT EXISTS "remaining_term_months" integer,
  ADD COLUMN IF NOT EXISTS "student_loan_repayment_plan" varchar(40),
  ADD COLUMN IF NOT EXISTS "underwriting_treatment" varchar(60),
  ADD COLUMN IF NOT EXISTS "treatment_source_document_id" varchar,
  ADD COLUMN IF NOT EXISTS "treatment_credit_pull_id" varchar,
  ADD COLUMN IF NOT EXISTS "treatment_tradeline_index" integer,
  ADD COLUMN IF NOT EXISTS "treatment_reviewed_by" varchar,
  ADD COLUMN IF NOT EXISTS "treatment_reviewed_at" timestamp;

DO $$ BEGIN
  ALTER TABLE "urla_liabilities"
    ADD CONSTRAINT "urla_liabilities_treatment_source_document_id_documents_id_fk"
    FOREIGN KEY ("treatment_source_document_id") REFERENCES "documents"("id")
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "urla_liabilities"
    ADD CONSTRAINT "urla_liabilities_treatment_credit_pull_id_credit_pulls_id_fk"
    FOREIGN KEY ("treatment_credit_pull_id") REFERENCES "credit_pulls"("id")
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "urla_liabilities"
    ADD CONSTRAINT "urla_liabilities_treatment_reviewed_by_users_id_fk"
    FOREIGN KEY ("treatment_reviewed_by") REFERENCES "users"("id")
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "urla_liabilities"
    ADD CONSTRAINT "urla_liabilities_remaining_term_nonnegative"
    CHECK ("remaining_term_months" IS NULL OR "remaining_term_months" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "urla_liabilities"
    ADD CONSTRAINT "urla_liabilities_treatment_complete"
    CHECK (
      ("underwriting_treatment" IS NULL
        AND "treatment_source_document_id" IS NULL
        AND "treatment_credit_pull_id" IS NULL
        AND "treatment_tradeline_index" IS NULL
        AND "treatment_reviewed_by" IS NULL
        AND "treatment_reviewed_at" IS NULL)
      OR
      ("underwriting_treatment" IN ('exclude_short_term_installment', 'documented_zero_student_loan')
        AND "treatment_source_document_id" IS NOT NULL
        AND "treatment_credit_pull_id" IS NOT NULL
        AND "treatment_tradeline_index" IS NOT NULL
        AND "treatment_reviewed_by" IS NOT NULL
        AND "treatment_reviewed_at" IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
