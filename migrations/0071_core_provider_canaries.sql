-- Redacted, append-only proof that a configured core provider completed a
-- harmless synthetic round trip in the deployed environment. Request and
-- response bodies are deliberately excluded so canaries cannot become a PII
-- side channel.
CREATE TABLE IF NOT EXISTS "core_provider_canary_runs" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "capability_id" varchar(50) NOT NULL,
  "provider" varchar(100) NOT NULL,
  "operation" varchar(100) NOT NULL,
  "environment" varchar(30) NOT NULL,
  "status" varchar(30) NOT NULL,
  "latency_ms" integer NOT NULL,
  "failure_class" varchar(50),
  "commit_sha" varchar(64),
  "triggered_by_user_id" varchar REFERENCES "users"("id"),
  "completed_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "core_provider_canary_status_check"
    CHECK ("status" IN ('success', 'failure', 'configuration_error')),
  CONSTRAINT "core_provider_canary_latency_check" CHECK ("latency_ms" >= 0),
  CONSTRAINT "core_provider_canary_failure_check" CHECK (
    ("status" = 'success' AND "failure_class" IS NULL) OR
    ("status" <> 'success' AND "failure_class" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "idx_core_canary_capability_time"
  ON "core_provider_canary_runs" ("capability_id", "completed_at");
CREATE INDEX IF NOT EXISTS "idx_core_canary_status_time"
  ON "core_provider_canary_runs" ("status", "completed_at");
