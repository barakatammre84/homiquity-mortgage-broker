-- Observation-only ledger. No backfill or mutation of existing tasks or loan state.
DO $$ BEGIN
  CREATE TYPE "work_wait_counterparty" AS ENUM ('borrower', 'lender', 'vendor', 'title', 'internal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "work_wait_outcome" AS ENUM ('work_received', 'cancelled', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_waits" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid(),
  "application_id" varchar NOT NULL REFERENCES "loan_applications" ("id"),
  "task_id" varchar NOT NULL REFERENCES "tasks" ("id"),
  "counterparty" "work_wait_counterparty" NOT NULL,
  "start_event_id" varchar(36) NOT NULL,
  "started_at" timestamp(3) with time zone NOT NULL,
  "promised_at" timestamp(3) with time zone,
  "recorded_by" varchar NOT NULL REFERENCES "users" ("id"),
  "recorded_at" timestamp(3) with time zone NOT NULL DEFAULT now(),
  "closing_event_id" varchar(36),
  "closed_at" timestamp(3) with time zone,
  "outcome" "work_wait_outcome",
  "document_id" varchar REFERENCES "documents" ("id"),
  "closed_by" varchar REFERENCES "users" ("id"),
  "closure_recorded_at" timestamp(3) with time zone,
  CONSTRAINT "work_waits_promise_order" CHECK ("promised_at" IS NULL OR "promised_at" >= "started_at"),
  CONSTRAINT "work_waits_start_order" CHECK ("started_at" <= "recorded_at"),
  CONSTRAINT "work_waits_closure_complete" CHECK (
    ("closed_at" IS NULL AND "closing_event_id" IS NULL AND "outcome" IS NULL
      AND "document_id" IS NULL AND "closed_by" IS NULL AND "closure_recorded_at" IS NULL)
    OR ("closed_at" IS NOT NULL AND "closing_event_id" IS NOT NULL AND "outcome" IS NOT NULL
      AND "closed_by" IS NOT NULL AND "closure_recorded_at" IS NOT NULL
      AND "closed_at" >= "started_at" AND "closed_at" <= "closure_recorded_at")
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_waits_start_event" ON "work_waits" ("application_id", "start_event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "work_waits_closing_event" ON "work_waits" ("application_id", "closing_event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "work_waits_active_task_counterparty" ON "work_waits" ("task_id", "counterparty") WHERE "closed_at" IS NULL;
CREATE INDEX IF NOT EXISTS "work_waits_application_id" ON "work_waits" ("application_id", "id");
