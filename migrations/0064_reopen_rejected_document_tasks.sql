-- Align legacy borrower upload tasks with the current document-review verdict.
-- New reviews update these rows in application code; this migration repairs
-- files reviewed before that synchronization existed.
UPDATE task_documents AS link
SET
  is_verified = false,
  verification_notes = COALESCE(document.rejection_reason, 'Document returned for correction')
FROM documents AS document
WHERE link.document_id = document.id
  AND document.status = 'rejected';

UPDATE tasks AS task
SET
  status = 'OPEN',
  completed_at = NULL,
  verification_status = 'rejected',
  verification_notes = COALESCE((
    SELECT document.rejection_reason
    FROM task_documents AS rejected_link
    JOIN documents AS document ON document.id = rejected_link.document_id
    WHERE rejected_link.task_id = task.id
      AND document.status = 'rejected'
    ORDER BY document.reviewed_at DESC NULLS LAST, document.created_at DESC NULLS LAST
    LIMIT 1
  ), 'Document returned for correction'),
  document_instructions = COALESCE((
    SELECT document.rejection_reason
    FROM task_documents AS rejected_link
    JOIN documents AS document ON document.id = rejected_link.document_id
    WHERE rejected_link.task_id = task.id
      AND document.status = 'rejected'
    ORDER BY document.reviewed_at DESC NULLS LAST, document.created_at DESC NULLS LAST
    LIMIT 1
  ), 'Document returned for correction'),
  updated_at = NOW()
WHERE task.task_type = 'document_request'
  AND task.owner_role = 'BORROWER'
  AND task.status <> 'EXPIRED'
  AND EXISTS (
    SELECT 1
    FROM task_documents AS rejected_link
    JOIN documents AS rejected_document ON rejected_document.id = rejected_link.document_id
    WHERE rejected_link.task_id = task.id
      AND rejected_document.status = 'rejected'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM task_documents AS accepted_link
    JOIN documents AS accepted_document ON accepted_document.id = accepted_link.document_id
    WHERE accepted_link.task_id = task.id
      AND accepted_document.status = 'verified'
  );
