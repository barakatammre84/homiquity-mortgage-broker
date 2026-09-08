-- Fast intake now captures the subject property's occupancy, unit count, and
-- expected rent. Keep these on the application so pricing cannot silently
-- assume primary-residence terms before the full URLA is complete.
ALTER TABLE loan_applications
  ADD COLUMN IF NOT EXISTS "occupancy_type" varchar(50),
  ADD COLUMN IF NOT EXISTS "number_of_units" integer,
  ADD COLUMN IF NOT EXISTS "subject_monthly_rental_income" numeric(12, 2);
