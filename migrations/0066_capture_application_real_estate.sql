-- An empty real_estate_owned table previously meant both "borrower confirmed
-- none" and "we never asked." Preserve that distinction on the application so
-- lender-readiness cannot silently treat missing intake as a zero-property
-- answer. Existing rows prove ownership; all other legacy files remain NULL
-- and are correctly routed to review until someone answers.
ALTER TABLE loan_applications
  ADD COLUMN IF NOT EXISTS "owns_other_real_estate" boolean;

UPDATE loan_applications AS application
SET owns_other_real_estate = true
WHERE application.owns_other_real_estate IS NULL
  AND EXISTS (
    SELECT 1
    FROM real_estate_owned AS property
    WHERE property.application_id = application.id
  );
