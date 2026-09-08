-- A replacement document receives its own DOC_REVIEW task. Retire any active
-- review task whose source document is no longer the current lineage version,
-- so processors are never asked to review superseded evidence.
UPDATE tasks AS task
SET
  status = 'EXPIRED',
  auto_resolved = true,
  auto_resolve_condition = 'DOCUMENT_REPLACED',
  resolution_notes = CASE
    WHEN task.resolution_notes IS NULL OR task.resolution_notes = ''
      THEN 'Superseded by a newer document version'
    ELSE task.resolution_notes || E'\nSuperseded by a newer document version'
  END,
  updated_at = NOW()
WHERE task.task_type_code = 'DOC_REVIEW'
  AND task.status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')
  AND EXISTS (
    SELECT 1
    FROM document_lineage AS reviewed_version
    JOIN document_lineage AS newer_version
      ON newer_version.application_id = reviewed_version.application_id
      AND newer_version.lineage_id = reviewed_version.lineage_id
      AND newer_version.version_number > reviewed_version.version_number
    WHERE reviewed_version.document_id = task.trigger_metadata->>'documentId'
  );
