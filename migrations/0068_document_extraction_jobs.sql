-- Durable document extraction queue. Upload registration and queue insertion
-- share one transaction; leases let another process resume work after a crash.
CREATE TABLE IF NOT EXISTS "document_extraction_jobs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" varchar NOT NULL REFERENCES "documents"("id"),
  "requested_by_user_id" varchar NOT NULL REFERENCES "users"("id"),
  "mode" varchar(20) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "available_at" timestamp NOT NULL DEFAULT now(),
  "claimed_at" timestamp,
  "lease_expires_at" timestamp,
  "claimed_by" varchar(100),
  "last_error_code" varchar(100),
  "last_error_at" timestamp,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "document_extraction_jobs_mode_check"
    CHECK ("mode" IN ('standard', 'autopilot', 'tax_package')),
  CONSTRAINT "document_extraction_jobs_status_check"
    CHECK ("status" IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "document_extraction_jobs_attempts_check"
    CHECK ("attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 10)
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_document_extraction_jobs_document_mode"
  ON "document_extraction_jobs" ("document_id", "mode");
CREATE INDEX IF NOT EXISTS "idx_document_extraction_jobs_claim"
  ON "document_extraction_jobs" ("status", "available_at");
CREATE INDEX IF NOT EXISTS "idx_document_extraction_jobs_lease"
  ON "document_extraction_jobs" ("status", "lease_expires_at");
