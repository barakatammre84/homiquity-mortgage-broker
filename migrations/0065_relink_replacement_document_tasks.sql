-- Borrower document tasks created before replacement-aware synchronization may
-- still point only at a superseded accepted version. Retire that link, attach
-- the current lineage version, and reopen the request when the replacement is
-- still pending or was returned for correction.
UPDATE task_documents AS link
SET
  is_verified = false,
  verification_notes = 'Superseded by a newer document version'
WHERE EXISTS (
  SELECT 1
  FROM document_lineage AS old_version
  JOIN document_lineage AS newer_version
    ON newer_version.application_id = old_version.application_id
    AND newer_version.lineage_id = old_version.lineage_id
    AND newer_version.version_number > old_version.version_number
  WHERE old_version.document_id = link.document_id
);

INSERT INTO task_documents (task_id, document_id, is_verified, verification_notes)
SELECT DISTINCT
  link.task_id,
  current_version.document_id,
  current_document.status = 'verified',
  CASE
    WHEN current_document.status = 'verified' THEN 'Document accepted'
    WHEN current_document.status = 'rejected' THEN COALESCE(current_document.rejection_reason, 'Document returned for correction')
    ELSE NULL
  END
FROM task_documents AS link
JOIN tasks AS task ON task.id = link.task_id
JOIN document_lineage AS old_version ON old_version.document_id = link.document_id
JOIN LATERAL (
  SELECT latest.document_id
  FROM document_lineage AS latest
  WHERE latest.application_id = old_version.application_id
    AND latest.lineage_id = old_version.lineage_id
  ORDER BY latest.version_number DESC
  LIMIT 1
) AS current_version ON current_version.document_id <> old_version.document_id
JOIN documents AS current_document ON current_document.id = current_version.document_id
WHERE task.task_type = 'document_request'
  AND task.owner_role = 'BORROWER'
  AND task.status <> 'EXPIRED'
  AND NOT EXISTS (
    SELECT 1
    FROM task_documents AS existing_current
    WHERE existing_current.task_id = link.task_id
      AND existing_current.document_id = current_version.document_id
  );

UPDATE tasks AS task
SET
  status = CASE
    WHEN EXISTS (
      SELECT 1 FROM task_documents AS pending_link
      JOIN documents AS pending_document ON pending_document.id = pending_link.document_id
      WHERE pending_link.task_id = task.id
        AND pending_document.status IN ('uploaded', 'verifying')
    ) THEN 'IN_PROGRESS'
    ELSE 'OPEN'
  END,
  completed_at = NULL,
  verification_status = CASE
    WHEN EXISTS (
      SELECT 1 FROM task_documents AS pending_link
      JOIN documents AS pending_document ON pending_document.id = pending_link.document_id
      WHERE pending_link.task_id = task.id
        AND pending_document.status IN ('uploaded', 'verifying')
    ) THEN 'pending'
    ELSE 'rejected'
  END,
  verified_by_user_id = NULL,
  verified_at = NULL,
  verification_notes = (
    SELECT COALESCE(current_document.rejection_reason, 'Document returned for correction')
    FROM task_documents AS current_link
    JOIN documents AS current_document ON current_document.id = current_link.document_id
    WHERE current_link.task_id = task.id
      AND current_document.status = 'rejected'
    ORDER BY current_document.reviewed_at DESC NULLS LAST, current_document.created_at DESC NULLS LAST
    LIMIT 1
  ),
  document_instructions = (
    SELECT COALESCE(current_document.rejection_reason, 'Document returned for correction')
    FROM task_documents AS current_link
    JOIN documents AS current_document ON current_document.id = current_link.document_id
    WHERE current_link.task_id = task.id
      AND current_document.status = 'rejected'
    ORDER BY current_document.reviewed_at DESC NULLS LAST, current_document.created_at DESC NULLS LAST
    LIMIT 1
  ),
  updated_at = NOW()
WHERE task.task_type = 'document_request'
  AND task.owner_role = 'BORROWER'
  AND task.status <> 'EXPIRED'
  AND EXISTS (
    SELECT 1
    FROM task_documents AS old_link
    JOIN document_lineage AS old_version ON old_version.document_id = old_link.document_id
    JOIN document_lineage AS newer_version
      ON newer_version.application_id = old_version.application_id
      AND newer_version.lineage_id = old_version.lineage_id
      AND newer_version.version_number > old_version.version_number
    WHERE old_link.task_id = task.id
  )
  AND EXISTS (
    -- A task can legitimately contain more than one accepted document (for
    -- example, two years of returns). Another accepted link must not conceal
    -- the fact that this particular lineage's current replacement still needs
    -- review.
    SELECT 1
    FROM task_documents AS old_link
    JOIN document_lineage AS old_version ON old_version.document_id = old_link.document_id
    JOIN LATERAL (
      SELECT latest.document_id
      FROM document_lineage AS latest
      WHERE latest.application_id = old_version.application_id
        AND latest.lineage_id = old_version.lineage_id
      ORDER BY latest.version_number DESC
      LIMIT 1
    ) AS current_version ON current_version.document_id <> old_version.document_id
    JOIN documents AS current_document ON current_document.id = current_version.document_id
    WHERE old_link.task_id = task.id
      AND current_document.status <> 'verified'
  );
