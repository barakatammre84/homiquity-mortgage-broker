-- Connect the live borrower upload row to the page-intelligence model. The
-- unique source key makes rendering idempotent across worker retries and
-- manual re-runs while preserving the original immutable upload.
ALTER TABLE "document_uploads"
  ADD COLUMN IF NOT EXISTS "source_document_id" varchar REFERENCES "documents"("id");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_document_uploads_source_document"
  ON "document_uploads" ("source_document_id")
  WHERE "source_document_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_doc_uploads_source_document"
  ON "document_uploads" ("source_document_id");
