import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  decimal,
  jsonb,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./core";
import { loanApplications, documents } from "./lending";

// ============================================================================
// DOCUMENT PACKAGES (Lender-Ready Document Organization)
// ============================================================================

// Document Package Types
export const DOCUMENT_PACKAGE_TYPES = [
  "initial_submission",    // Initial lender submission
  "condition_response",    // Response to underwriting conditions
  "final_package",         // Final closing package
  "title_package",         // Title company package
  "custom",                // Custom package
] as const;

export type DocumentPackageType = typeof DOCUMENT_PACKAGE_TYPES[number];

// Document Package - organizes documents for lender delivery
export const documentPackages = pgTable("document_packages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  createdByUserId: varchar("created_by_user_id").references(() => users.id).notNull(),
  
  // Package Details
  name: varchar("name", { length: 255 }).notNull(),
  packageType: varchar("package_type", { length: 50 }).notNull(), // initial_submission, condition_response, final_package, title_package, custom
  description: text("description"),
  
  // Organization
  sections: jsonb("sections"), // Array of section names for organizing documents
  
  // Status
  status: varchar("status", { length: 50 }).default("draft").notNull(), // draft, ready, sent, acknowledged
  
  // Delivery
  recipientType: varchar("recipient_type", { length: 50 }), // lender, title, underwriter, investor
  recipientName: varchar("recipient_name", { length: 255 }),
  sentAt: timestamp("sent_at"),
  acknowledgedAt: timestamp("acknowledged_at"),
  
  // Notes
  internalNotes: text("internal_notes"),
  deliveryNotes: text("delivery_notes"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
});

// Document Package Items - links documents to packages with organization
export const documentPackageItems = pgTable("document_package_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  packageId: varchar("package_id").references(() => documentPackages.id).notNull(),
  documentId: varchar("document_id").references(() => documents.id).notNull(),
  
  // Organization within package
  sectionName: varchar("section_name", { length: 100 }), // e.g., "Income Documents", "Asset Documents"
  displayOrder: integer("display_order").default(0),
  customLabel: varchar("custom_label", { length: 255 }), // Override default document name
  
  // Notes
  notes: text("notes"),
  
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertDocumentPackageSchema = createInsertSchema(documentPackages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertDocumentPackageItemSchema = createInsertSchema(documentPackageItems).omit({
  id: true,
  createdAt: true,
});

export type InsertDocumentPackage = z.infer<typeof insertDocumentPackageSchema>;
export type DocumentPackage = typeof documentPackages.$inferSelect;
export type InsertDocumentPackageItem = z.infer<typeof insertDocumentPackageItemSchema>;
export type DocumentPackageItem = typeof documentPackageItems.$inferSelect;

// ============================================================================
// DOCUMENT INTELLIGENCE ENGINE (Underwriting-Aware OCR + Classification)
// ============================================================================
// This is the backbone of automated document processing. 
// Rule #1: Build ENGINES, not features.
// Everything operates at PAGE level, not file level.

// A. Document Taxonomy - All mortgage document types the classifier recognizes
export const DOCUMENT_TYPE_TAXONOMY = [
  // Identity / Compliance
  "drivers_license",
  "passport",
  "green_card",
  "ssn_card",
  "itin_letter",
  // Income - W2/Employment
  "paystub",
  "w2",
  "1099_misc",
  "1099_nec",
  // Income - Tax Returns
  "tax_return_1040",
  "schedule_1",
  "schedule_b",
  "schedule_c",
  "schedule_d",
  "schedule_e",
  "schedule_k1",
  "business_tax_return_1120",
  "business_tax_return_1120s",
  "business_tax_return_1065",
  "form_8825",
  "form_4562",
  // Income - Self-Employed
  "profit_loss_statement",
  "social_security_award_letter",
  // Assets
  "bank_statement_checking",
  "bank_statement_savings",
  "business_bank_statement",
  "retirement_statement_401k",
  "retirement_statement_ira",
  "brokerage_statement",
  "gift_letter",
  // Liabilities
  "mortgage_statement",
  "heloc_statement",
  "auto_loan_statement",
  "student_loan_statement",
  "credit_card_statement",
  // Property / Transaction
  "purchase_contract",
  "lease_agreement",
  "hoa_statement",
  "homeowners_insurance_binder",
  "earnest_money_receipt",
  "appraisal_report",
  "title_commitment",
  // Other
  "letter_of_explanation",
  "divorce_decree",
  "bankruptcy_discharge",
  "unknown",
] as const;

export type DocumentTypeTaxonomy = typeof DOCUMENT_TYPE_TAXONOMY[number];

// B. Raw Document Upload (Immutable - Never mutate for audit + fraud)
export const documentUploads = pgTable("document_uploads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  loanId: varchar("loan_id").references(() => loanApplications.id),
  borrowerId: varchar("borrower_id").references(() => users.id).notNull(),
  // Bridge the legacy/live `documents` upload row to the page-intelligence
  // model. One immutable source document owns at most one normalized page set;
  // retries reuse it instead of producing competing page boundaries.
  sourceDocumentId: varchar("source_document_id").references(() => documents.id),
  
  // Original file metadata
  originalFileName: varchar("original_file_name", { length: 500 }).notNull(),
  mimeType: varchar("mime_type", { length: 100 }).notNull(),
  fileSizeBytes: integer("file_size_bytes"),
  
  // Upload source tracking
  uploadSource: varchar("upload_source", { length: 50 }).notNull(), // web, mobile, api, email
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  
  // Storage references (never modify after creation)
  rawFileUri: text("raw_file_uri").notNull(),  // Original file in object storage
  checksum: varchar("checksum", { length: 128 }).notNull(), // SHA-256 for integrity
  
  // Processing status
  processingStatus: varchar("processing_status", { length: 50 }).default("pending").notNull(), // pending, processing, completed, failed
  processingStartedAt: timestamp("processing_started_at"),
  processingCompletedAt: timestamp("processing_completed_at"),
  processingError: text("processing_error"),
  
  // Metadata
  pageCount: integer("page_count"),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_doc_uploads_loan").on(table.loanId),
  index("idx_doc_uploads_borrower").on(table.borrowerId),
  index("idx_doc_uploads_status").on(table.processingStatus),
  uniqueIndex("uq_document_uploads_source_document")
    .on(table.sourceDocumentId)
    .where(sql`${table.sourceDocumentId} IS NOT NULL`),
  index("idx_doc_uploads_source_document").on(table.sourceDocumentId),
]);

// Durable background work for the borrower upload path. The document row and
// this job are inserted in one transaction, so an acknowledged upload cannot
// lose its extraction when the web process restarts. Workers claim rows with a
// bounded lease; an expired lease is eligible for another worker to resume.
export const documentExtractionJobs = pgTable("document_extraction_jobs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").references(() => documents.id).notNull(),
  requestedByUserId: varchar("requested_by_user_id").references(() => users.id).notNull(),
  mode: varchar("mode", { length: 20 }).notNull(), // standard, autopilot, tax_package
  status: varchar("status", { length: 20 }).default("pending").notNull(), // pending, processing, completed, failed, cancelled
  attemptCount: integer("attempt_count").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  availableAt: timestamp("available_at").defaultNow().notNull(),
  claimedAt: timestamp("claimed_at"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  claimedBy: varchar("claimed_by", { length: 100 }),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  lastErrorAt: timestamp("last_error_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()).notNull(),
}, (table) => [
  uniqueIndex("idx_document_extraction_jobs_document_mode").on(table.documentId, table.mode),
  index("idx_document_extraction_jobs_claim").on(table.status, table.availableAt),
  index("idx_document_extraction_jobs_lease").on(table.status, table.leaseExpiresAt),
]);

export type DocumentExtractionJob = typeof documentExtractionJobs.$inferSelect;

// C. Document Page Entity (CRITICAL - All intelligence happens at page level)
export const documentPages = pgTable("document_pages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  uploadId: varchar("upload_id").references(() => documentUploads.id).notNull(),
  
  // Page identification
  pageNumber: integer("page_number").notNull(), // 1-indexed
  
  // Processed image storage
  imageUri: text("image_uri").notNull(), // Cleaned/normalized page image
  thumbnailUri: text("thumbnail_uri"), // Smaller preview
  
  // Image dimensions (for layout analysis)
  width: integer("width"),
  height: integer("height"),
  
  // Raw OCR text (before field extraction)
  rawOcrText: text("raw_ocr_text"),
  ocrConfidence: decimal("ocr_confidence", { precision: 5, scale: 4 }), // 0.0-1.0
  ocrEngine: varchar("ocr_engine", { length: 50 }), // claude, gemini (legacy rows), tesseract, etc.
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_doc_pages_upload").on(table.uploadId),
]);

// D. Page Classification Output (Never trust file names - classify each page)
export const pageClassifications = pgTable("page_classifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  pageId: varchar("page_id").references(() => documentPages.id).notNull(),
  
  // Classification result
  documentType: varchar("document_type", { length: 100 }).notNull(), // From DOCUMENT_TYPE_TAXONOMY
  confidence: decimal("confidence", { precision: 5, scale: 4 }).notNull(), // 0.0-1.0
  
  // Alternative classifications (top 3)
  alternativeTypes: jsonb("alternative_types"), // [{type, confidence}, ...]
  
  // Classification method tracking
  modelVersion: varchar("model_version", { length: 100 }).notNull(),
  classificationMethod: varchar("classification_method", { length: 50 }).notNull(), // rule_based, ml_classifier, hybrid
  
  // Human review status
  humanReviewed: boolean("human_reviewed").default(false),
  humanCorrectedType: varchar("human_corrected_type", { length: 100 }),
  reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  
  classifiedAt: timestamp("classified_at").defaultNow().notNull(),
}, (table) => [
  index("idx_page_class_page").on(table.pageId),
  index("idx_page_class_type").on(table.documentType),
  index("idx_page_class_confidence").on(table.confidence),
]);

// E. Logical Document (Reassembled from classified pages)
export const logicalDocuments = pgTable("logical_documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  loanId: varchar("loan_id").references(() => loanApplications.id),
  borrowerId: varchar("borrower_id").references(() => users.id).notNull(),
  
  // Document identification
  documentType: varchar("document_type", { length: 100 }).notNull(), // From DOCUMENT_TYPE_TAXONOMY
  
  // Aggregated confidence (average of page confidences)
  aggregatedConfidence: decimal("aggregated_confidence", { precision: 5, scale: 4 }).notNull(),
  
  // Status workflow
  status: varchar("status", { length: 50 }).default("needs_review").notNull(), // accepted, needs_review, rejected
  
  // Document period (for statements/returns)
  periodStart: timestamp("period_start"),
  periodEnd: timestamp("period_end"),
  taxYear: integer("tax_year"),
  
  // Institution/employer info (extracted). For tax forms, institution_name
  // holds the business-entity name read off the form (P2b entity resolution
  // resolves it against borrower_business_entities).
  institutionName: varchar("institution_name", { length: 255 }),
  accountNumberMasked: varchar("account_number_masked", { length: 50 }),

  // --- Bridge to the live upload flow (UAL P2a) ------------------------------
  // source_document_id + extraction_run_id tie a logical form to the original
  // immutable borrower upload and the exact extraction run. Normalized pages
  // are joined through logical_document_pages.
  sourceDocumentId: varchar("source_document_id").references(() => documents.id),
  extractionRunId: varchar("extraction_run_id").references(() => taxExtractionRuns.id),
  // Resolved business entity this form belongs to (P2b entity resolution).
  businessEntityId: varchar("business_entity_id").references(() => borrowerBusinessEntities.id),
  // Page attribution from the classification pass (1-indexed, inclusive).
  pageStart: integer("page_start"),
  pageEnd: integer("page_end"),
  // K-1 flavor when documentType = schedule_k1 ("1065" | "1120s").
  k1Variant: varchar("k1_variant", { length: 10 }),

  // Extraction lineage for THIS form instance (mirrors documents.extraction_*):
  // model/prompt ids plus the encrypted raw model response of the per-form
  // extraction call, so an auditor can tie every stored field to exact output.
  modelId: varchar("model_id", { length: 100 }),
  promptVersion: varchar("prompt_version", { length: 50 }),
  rawResponseHash: varchar("raw_response_hash", { length: 64 }),
  rawResponseEncrypted: text("raw_response_encrypted"),
  rawResponseIv: varchar("raw_response_iv", { length: 32 }),
  rawResponseKeyId: varchar("raw_response_key_id", { length: 20 }),


  // Completeness
  expectedPageCount: integer("expected_page_count"),
  actualPageCount: integer("actual_page_count"),
  isComplete: boolean("is_complete").default(false),
  
  // Human review
  verifiedByUserId: varchar("verified_by_user_id").references(() => users.id),
  verifiedAt: timestamp("verified_at"),
  verificationNotes: text("verification_notes"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_logical_docs_loan").on(table.loanId),
  index("idx_logical_docs_borrower").on(table.borrowerId),
  index("idx_logical_docs_type").on(table.documentType),
  index("idx_logical_docs_status").on(table.status),
  index("idx_logical_docs_source_doc").on(table.sourceDocumentId),
  index("idx_logical_docs_run").on(table.extractionRunId),
  index("idx_logical_docs_entity").on(table.businessEntityId),
]);

// Link table: Logical Document to Pages
export const logicalDocumentPages = pgTable("logical_document_pages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  logicalDocumentId: varchar("logical_document_id").references(() => logicalDocuments.id).notNull(),
  pageId: varchar("page_id").references(() => documentPages.id).notNull(),
  pageOrder: integer("page_order").notNull(), // Order within the logical document
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_logical_doc_pages_doc").on(table.logicalDocumentId),
  index("idx_logical_doc_pages_page").on(table.pageId),
]);

// ============================================================================
// OCR & FIELD EXTRACTION SCHEMAS
// ============================================================================

// F. Extracted Field (NON-NEGOTIABLE STRUCTURE)
// Rule: If a value has no confidence or no source page → it does not exist
export const extractedFields = pgTable("extracted_fields", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  logicalDocumentId: varchar("logical_document_id").references(() => logicalDocuments.id),
  // Nullable for historical and failed-review rows. Current standard and tax
  // extraction links every retained field to its normalized source page.
  pageId: varchar("page_id").references(() => documentPages.id),
  pageNumber: integer("page_number"), // 1-indexed page attribution from classification

  /**
   * The simple-upload document these fields came from (finding F-028).
   *
   * Two document pipelines exist. The UAL tax pipeline builds
   * document_uploads → document_pages → logical_documents and attributes fields
   * by logicalDocumentId. The borrower upload flow writes plain `documents`
   * rows and extracts straight off them — and until now it had nowhere to put
   * the VALUES it read, so pay-stub income and bank-statement assets were
   * extracted and then dropped. Tax returns escaped that only because
   * tax_insights exists for them specifically.
   *
   * Nullable, like logicalDocumentId and pageId: a row is attributed to
   * whichever pipeline produced it, never both.
   */
  documentId: varchar("document_id").references(() => documents.id),

  // Field identification
  fieldName: varchar("field_name", { length: 255 }).notNull(), // e.g., "grossMonthlyIncome", "employerName"
  fieldCategory: varchar("field_category", { length: 100 }), // income, asset, liability, identity, property
  
  // Extracted value (polymorphic - store as string, parse based on type)
  valueString: text("value_string"),
  valueNumeric: decimal("value_numeric", { precision: 18, scale: 4 }),
  valueDate: timestamp("value_date"),
  valueBoolean: boolean("value_boolean"),
  valueType: varchar("value_type", { length: 50 }).notNull(), // string, number, date, boolean, currency
  
  // Confidence & source (REQUIRED - no field exists without these)
  confidence: decimal("confidence", { precision: 5, scale: 4 }).notNull(), // 0.0-1.0
  boundingBox: jsonb("bounding_box"), // {x, y, width, height} on source page
  
  // MISMO Mapping (Everything maps to MISMO or fails)
  mismoPath: varchar("mismo_path", { length: 500 }), // e.g., "MISMO.Income.EmploymentIncome.GrossMonthlyIncome"
  
  // Extraction metadata
  extractionMethod: varchar("extraction_method", { length: 50 }).notNull(), // regex, ml_extraction, template_match, claude, gemini (legacy rows)
  modelVersion: varchar("model_version", { length: 100 }),
  
  // Human verification
  humanVerified: boolean("human_verified").default(false),
  humanCorrectedValue: text("human_corrected_value"),
  verifiedByUserId: varchar("verified_by_user_id").references(() => users.id),
  verifiedAt: timestamp("verified_at"),
  
  extractedAt: timestamp("extracted_at").defaultNow().notNull(),
}, (table) => [
  index("idx_extracted_fields_doc").on(table.logicalDocumentId),
  index("idx_extracted_fields_source_doc").on(table.documentId),
  index("idx_extracted_fields_page").on(table.pageId),
  index("idx_extracted_fields_name").on(table.fieldName),
  index("idx_extracted_fields_mismo").on(table.mismoPath),
  index("idx_extracted_fields_confidence").on(table.confidence),
]);

// G. Completeness Check (Eliminate huge processor time)
export const completenessChecks = pgTable("completeness_checks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  logicalDocumentId: varchar("logical_document_id").references(() => logicalDocuments.id).notNull(),
  
  // Check result
  documentType: varchar("document_type", { length: 100 }).notNull(),
  status: varchar("status", { length: 50 }).notNull(), // complete, incomplete, unable_to_determine
  
  // Missing items (what's wrong)
  missingItems: jsonb("missing_items").notNull(), // [{item: "page 2 of 3", severity: "high"}, ...]
  
  // Expected vs actual
  expectedPages: integer("expected_pages"),
  foundPages: integer("found_pages"),
  
  // Required fields check
  requiredFieldsFound: jsonb("required_fields_found"), // [{field, found: boolean}, ...]
  requiredFieldsMissing: text("required_fields_missing").array(),
  
  // Continuity checks (for statements)
  balanceContinuityValid: boolean("balance_continuity_valid"),
  dateRangeContinuous: boolean("date_range_continuous"),
  
  checkedAt: timestamp("checked_at").defaultNow().notNull(),
}, (table) => [
  index("idx_completeness_doc").on(table.logicalDocumentId),
  index("idx_completeness_status").on(table.status),
]);

// H. Tax Extraction Run (UAL P2a — Situation Identification Engine)
// One row per full multi-form extraction of an uploaded tax document:
// classification pass + N per-form extraction passes. Append-only — a re-run
// inserts a new row and produces fresh logical_documents; readers use the
// latest completed run for a source document. The classification pass's raw
// model response is kept encrypted here (per-form raw responses live on their
// logical_documents rows).
export const taxExtractionRuns = pgTable("tax_extraction_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  documentId: varchar("document_id").references(() => documents.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id),

  status: varchar("status", { length: 20 }).default("running").notNull(), // running, completed, failed
  // I10: simulated output must be unmistakable wherever it lands.
  simulated: boolean("simulated").default(false).notNull(),
  error: text("error"),

  // Lineage for the classification pass
  modelId: varchar("model_id", { length: 100 }),
  promptVersion: varchar("prompt_version", { length: 50 }),
  classificationResponseHash: varchar("classification_response_hash", { length: 64 }),
  classificationRawEncrypted: text("classification_raw_encrypted"),
  classificationRawIv: varchar("classification_raw_iv", { length: 32 }),
  classificationRawKeyId: varchar("classification_raw_key_id", { length: 20 }),

  // Run shape
  pageCount: integer("page_count"),
  formCount: integer("form_count"),
  // Conservative aggregate of per-field confidences (bottom-half mean; see
  // shared/taxFormExtraction.ts aggregateFieldConfidence).
  overallConfidence: decimal("overall_confidence", { precision: 5, scale: 4 }),

  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("idx_tax_extraction_runs_document").on(table.documentId),
  index("idx_tax_extraction_runs_user").on(table.userId),
  index("idx_tax_extraction_runs_status").on(table.status),
]);

// I. Borrower Business Entities (UAL P2b — entity resolution)
// One row per distinct business entity resolved from a borrower's extracted
// tax forms. identity_key is deterministic ('ein:<last4>' when an EIN was
// read, else 'name:<normalized>'); auto-resolved rows refresh by upsert on
// (user_id, identity_key); a human-confirmed row (auto_resolved=false, set by
// the P5 workbench) is never overwritten by re-resolution.
export const BUSINESS_ENTITY_TYPES = [
  "sole_proprietorship",
  "single_member_llc",
  "partnership",
  "s_corporation",
  "c_corporation",
] as const;
export type BusinessEntityType = (typeof BUSINESS_ENTITY_TYPES)[number];

export const borrowerBusinessEntities = pgTable("borrower_business_entities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id),

  identityKey: varchar("identity_key", { length: 300 }).notNull(),
  entityType: varchar("entity_type", { length: 30 }).notNull(), // BUSINESS_ENTITY_TYPES
  name: varchar("name", { length: 255 }),
  // Last-4 only, PII-minimized at the extraction schema — a full EIN never
  // reaches this table.
  einLast4: varchar("ein_last4", { length: 4 }),
  ownershipPercent: decimal("ownership_percent", { precision: 5, scale: 2 }),

  firstTaxYear: integer("first_tax_year"),
  lastTaxYear: integer("last_tax_year"),
  sourceFormCount: integer("source_form_count").default(0).notNull(),
  resolutionNotes: text("resolution_notes"),

  autoResolved: boolean("auto_resolved").default(true).notNull(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  unique("uq_borrower_entities_user_identity").on(table.userId, table.identityKey),
  index("idx_borrower_entities_user").on(table.userId),
]);

// Insert schemas
export const insertDocumentUploadSchema = createInsertSchema(documentUploads).omit({
  id: true,
  createdAt: true,
});
export const insertDocumentPageSchema = createInsertSchema(documentPages).omit({
  id: true,
  createdAt: true,
});
export const insertPageClassificationSchema = createInsertSchema(pageClassifications).omit({
  id: true,
});
export const insertLogicalDocumentSchema = createInsertSchema(logicalDocuments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertLogicalDocumentPageSchema = createInsertSchema(logicalDocumentPages).omit({
  id: true,
  createdAt: true,
});
export const insertExtractedFieldSchema = createInsertSchema(extractedFields).omit({
  id: true,
});
export const insertCompletenessCheckSchema = createInsertSchema(completenessChecks).omit({
  id: true,
});

// Type exports
export type InsertDocumentUpload = z.infer<typeof insertDocumentUploadSchema>;
export type DocumentUpload = typeof documentUploads.$inferSelect;
export type InsertDocumentPage = z.infer<typeof insertDocumentPageSchema>;
export type DocumentPage = typeof documentPages.$inferSelect;
export type InsertPageClassification = z.infer<typeof insertPageClassificationSchema>;
export type PageClassification = typeof pageClassifications.$inferSelect;
export type InsertLogicalDocument = z.infer<typeof insertLogicalDocumentSchema>;
export type LogicalDocument = typeof logicalDocuments.$inferSelect;
export type InsertLogicalDocumentPage = z.infer<typeof insertLogicalDocumentPageSchema>;
export type LogicalDocumentPage = typeof logicalDocumentPages.$inferSelect;
export type InsertExtractedField = z.infer<typeof insertExtractedFieldSchema>;
export type ExtractedField = typeof extractedFields.$inferSelect;
export type InsertCompletenessCheck = z.infer<typeof insertCompletenessCheckSchema>;
export type CompletenessCheck = typeof completenessChecks.$inferSelect;

export const insertTaxExtractionRunSchema = createInsertSchema(taxExtractionRuns).omit({
  id: true,
  startedAt: true,
});
export type InsertTaxExtractionRun = z.infer<typeof insertTaxExtractionRunSchema>;
export type TaxExtractionRun = typeof taxExtractionRuns.$inferSelect;

export const insertBorrowerBusinessEntitySchema = createInsertSchema(borrowerBusinessEntities).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBorrowerBusinessEntity = z.infer<typeof insertBorrowerBusinessEntitySchema>;
export type BorrowerBusinessEntity = typeof borrowerBusinessEntities.$inferSelect;

// J. Situation Profiles (UAL P2c — Situation Identification Engine output)
// Append-only; latest row per user wins; inputs_fingerprint dedupes no-op
// re-classifications. The profile jsonb is Zod-typed in
// shared/situationProfile.ts; the flag columns exist for staff-feed queries.
export const situationProfiles = pgTable("situation_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id),

  profile: jsonb("profile").notNull(),
  inputsFingerprint: varchar("inputs_fingerprint", { length: 64 }).notNull(),

  entityCount: integer("entity_count").default(0).notNull(),
  selfEmployed: boolean("self_employed").default(false).notNull(),
  multiEntity: boolean("multi_entity").default(false).notNull(),
  rentalPresent: boolean("rental_present").default(false).notNull(),
  k1Present: boolean("k1_present").default(false).notNull(),
  varianceCount: integer("variance_count").default(0).notNull(),
  documentRequestCount: integer("document_request_count").default(0).notNull(),

  generatedAt: timestamp("generated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_situation_profiles_user").on(table.userId, table.generatedAt),
  index("idx_situation_profiles_flags").on(table.selfEmployed, table.rentalPresent, table.generatedAt),
]);

export const insertSituationProfileSchema = createInsertSchema(situationProfiles).omit({
  id: true,
  generatedAt: true,
});
export type InsertSituationProfile = z.infer<typeof insertSituationProfileSchema>;
export type SituationProfileRow = typeof situationProfiles.$inferSelect;
