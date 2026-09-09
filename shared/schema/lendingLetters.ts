// Disclaimers, pre-approval/pre-qualification letters + conditions, letter generation logs, expiration policies, credit refresh decisions, lender letter formats, agent confidence views, document expirations, lender data packages.
// Split from the old shared/schema/lending.ts — ./lending re-exports all of it.
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
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { loanApplications, documents } from "./lendingCore";
import { users } from "./core";
import { underwritingDecisions, underwritingSnapshots, underwritingRulesDsl, confidenceBreakdowns, CONDITION_CATEGORIES } from "./underwriting";
import { creditConsents } from "./compliance";

export const disclaimerVersions = pgTable("disclaimer_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  version: varchar("version", { length: 20 }).notNull().unique(),
  
  disclaimerType: varchar("disclaimer_type", { length: 50 }).notNull(),
  
  text: text("text").notNull(),
  
  approvedByCounsel: boolean("approved_by_counsel").default(false),
  counselApprovalDate: timestamp("counsel_approval_date"),
  counselName: varchar("counsel_name", { length: 255 }),
  
  effectiveFrom: timestamp("effective_from").notNull(),
  effectiveTo: timestamp("effective_to"),
  
  createdAt: timestamp("created_at").defaultNow(),
  createdBy: varchar("created_by").references(() => users.id),
}, (table) => [
  index("idx_disclaimer_versions_type_version").on(table.disclaimerType, table.version),
  index("idx_disclaimer_versions_effective").on(table.effectiveFrom, table.effectiveTo),
]);

export const insertDisclaimerVersionSchema = createInsertSchema(disclaimerVersions).omit({
  id: true,
  createdAt: true,
});

export const PRE_APPROVAL_PRODUCT_TYPES = ["CONV", "FHA", "VA", "HELOC", "DSCR"] as const;
export type PreApprovalProductType = typeof PRE_APPROVAL_PRODUCT_TYPES[number];

export const PRE_APPROVAL_OCCUPANCY_TYPES = ["Primary", "Second", "Investment"] as const;
export type PreApprovalOccupancyType = typeof PRE_APPROVAL_OCCUPANCY_TYPES[number];

export type { PreApprovalLetterStatus } from "../statusVocabularies";
export { PRE_APPROVAL_LETTER_STATUS } from "../statusVocabularies";

export const preApprovalLetters = pgTable("pre_approval_letters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  letterNumber: varchar("letter_number", { length: 50 }).notNull().unique(),
  
  borrowerName: varchar("borrower_name", { length: 255 }).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  
  loanAmount: decimal("loan_amount", { precision: 14, scale: 2 }).notNull(),
  productType: varchar("product_type", { length: 20 }).notNull(),
  occupancy: varchar("occupancy", { length: 20 }).notNull(),
  loanPurpose: varchar("loan_purpose", { length: 50 }),
  
  rateLockedAt: timestamp("rate_locked_at"),
  lockedRate: decimal("locked_rate", { precision: 5, scale: 3 }),
  
  underwritingSnapshotId: varchar("underwriting_snapshot_id").references(() => underwritingDecisions.id),
  // Exact deterministic-decision state used to issue the letter. Read and
  // download paths recompute both fingerprints; a mismatch makes the letter
  // stale until a new decision and letter are issued.
  decisionInputFingerprint: varchar("decision_input_fingerprint", { length: 64 }),
  policyFingerprint: varchar("policy_fingerprint", { length: 64 }),
  
  primaryDisclaimerId: varchar("primary_disclaimer_id").references(() => disclaimerVersions.id),
  brokerRoleDisclaimerId: varchar("broker_role_disclaimer_id").references(() => disclaimerVersions.id),
  documentRelianceDisclaimerId: varchar("document_reliance_disclaimer_id").references(() => disclaimerVersions.id),
  changeInCircumstanceDisclaimerId: varchar("change_in_circumstance_disclaimer_id").references(() => disclaimerVersions.id),
  systemGeneratedDisclaimerId: varchar("system_generated_disclaimer_id").references(() => disclaimerVersions.id),
  
  expirationDate: timestamp("expiration_date").notNull(),
  
  status: varchar("status", { length: 20 }).notNull().default("issued"),
  
  generatedBySystem: boolean("generated_by_system").default(true),
  generatedAt: timestamp("generated_at").defaultNow(),
  
  companyLegalName: varchar("company_legal_name", { length: 255 }).notNull(),
  companyNmlsId: varchar("company_nmls_id", { length: 50 }).notNull(),
  companyContactInfo: text("company_contact_info"),
  
  loanOfficerId: varchar("loan_officer_id").references(() => users.id),
  loanOfficerNmlsId: varchar("loan_officer_nmls_id", { length: 50 }),
  
  pdfStorageKey: varchar("pdf_storage_key", { length: 500 }),
  pdfGeneratedAt: timestamp("pdf_generated_at"),
  watermarkApplied: boolean("watermark_applied").default(true),
  
  isLocked: boolean("is_locked").default(true),
  
  revokedAt: timestamp("revoked_at"),
  revokedBy: varchar("revoked_by").references(() => users.id),
  revocationReason: text("revocation_reason"),
  
  supersededAt: timestamp("superseded_at"),
  supersededBy: varchar("superseded_by"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_pre_approval_letters_application").on(table.applicationId),
  index("idx_pre_approval_letters_borrower").on(table.borrowerName),
  index("idx_pre_approval_letters_status").on(table.status),
  index("idx_pre_approval_letters_expiration").on(table.expirationDate),
  index("idx_pre_approval_letters_snapshot").on(table.underwritingSnapshotId),
]);

export const insertPreApprovalLetterSchema = createInsertSchema(preApprovalLetters).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const PRE_APPROVAL_CONDITION_CATEGORIES = [
  ...CONDITION_CATEGORIES,
  "lender_underwriting",
  "appraisal",
  "verification",
  "documentation",
] as const;
export type PreApprovalConditionCategory = typeof PRE_APPROVAL_CONDITION_CATEGORIES[number];

export const preApprovalConditions = pgTable("pre_approval_conditions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  letterId: varchar("letter_id").references(() => preApprovalLetters.id).notNull(),
  
  category: varchar("category", { length: 50 }).notNull(),
  conditionText: text("condition_text").notNull(),
  
  autoGenerated: boolean("auto_generated").default(true),
  sourceRuleId: varchar("source_rule_id").references(() => underwritingRulesDsl.id),
  
  isStandardCondition: boolean("is_standard_condition").default(false),
  
  displayOrder: integer("display_order").default(0),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_pre_approval_conditions_letter").on(table.letterId),
  index("idx_pre_approval_conditions_category").on(table.category),
]);

export const insertPreApprovalConditionSchema = createInsertSchema(preApprovalConditions).omit({
  id: true,
  createdAt: true,
});

// Pre-Qualification Letters
export const preQualificationLetters = pgTable("pre_qualification_letters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  letterNumber: varchar("letter_number", { length: 50 }).notNull().unique(),
  borrowerName: varchar("borrower_name", { length: 255 }).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),

  estimatedAmount: decimal("estimated_amount", { precision: 14, scale: 2 }).notNull(),
  productType: varchar("product_type", { length: 20 }).notNull(),
  occupancy: varchar("occupancy", { length: 20 }).notNull(),
  loanPurpose: varchar("loan_purpose", { length: 50 }),

  annualIncome: decimal("annual_income", { precision: 12, scale: 2 }),
  creditScoreRange: varchar("credit_score_range", { length: 50 }),
  employmentType: varchar("employment_type", { length: 50 }),
  estimatedDti: decimal("estimated_dti", { precision: 5, scale: 2 }),
  downPaymentPercent: decimal("down_payment_percent", { precision: 5, scale: 2 }),

  expirationDate: timestamp("expiration_date").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("issued"),

  generatedAt: timestamp("generated_at").defaultNow(),
  companyLegalName: varchar("company_legal_name", { length: 255 }).notNull(),
  companyNmlsId: varchar("company_nmls_id", { length: 50 }).notNull(),
  companyContactInfo: text("company_contact_info"),

  loanOfficerId: varchar("loan_officer_id").references(() => users.id),
  loanOfficerNmlsId: varchar("loan_officer_nmls_id", { length: 50 }),

  pdfStorageKey: varchar("pdf_storage_key", { length: 500 }),
  pdfGeneratedAt: timestamp("pdf_generated_at"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_pre_qual_letters_application").on(table.applicationId),
  index("idx_pre_qual_letters_status").on(table.status),
]);

export const insertPreQualificationLetterSchema = createInsertSchema(preQualificationLetters).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPreQualificationLetter = z.infer<typeof insertPreQualificationLetterSchema>;
export type PreQualificationLetter = typeof preQualificationLetters.$inferSelect;

// Letter Generation Log
export const LETTER_GENERATION_EVENTS = [
  "generation_started",
  "validation_passed",
  "validation_failed",
  "pdf_generated",
  "pdf_failed",
  "letter_issued",
  "letter_revoked",
  "letter_superseded",
  "letter_expired",
  "reanalysis_triggered",
] as const;
export type LetterGenerationEvent = typeof LETTER_GENERATION_EVENTS[number];

export const letterGenerationLogs = pgTable("letter_generation_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  letterId: varchar("letter_id").references(() => preApprovalLetters.id),
  
  eventType: varchar("event_type", { length: 50 }).notNull(),
  eventDetails: jsonb("event_details"),
  
  triggerConditions: jsonb("trigger_conditions"),
  conditionsMet: boolean("conditions_met"),
  failedConditions: jsonb("failed_conditions"),
  
  reanalysisReason: varchar("reanalysis_reason", { length: 100 }),
  previousSnapshotId: varchar("previous_snapshot_id").references(() => underwritingDecisions.id),
  newSnapshotId: varchar("new_snapshot_id").references(() => underwritingDecisions.id),
  
  triggeredBy: varchar("triggered_by").references(() => users.id),
  triggeredBySystem: boolean("triggered_by_system").default(false),
  
  eventAt: timestamp("event_at").defaultNow(),
  processingTimeMs: integer("processing_time_ms"),
  
  errorMessage: text("error_message"),
  errorStack: text("error_stack"),
}, (table) => [
  index("idx_letter_generation_logs_application").on(table.applicationId),
  index("idx_letter_generation_logs_letter").on(table.letterId),
  index("idx_letter_generation_logs_event").on(table.eventType),
  index("idx_letter_generation_logs_time").on(table.eventAt),
]);

export const insertLetterGenerationLogSchema = createInsertSchema(letterGenerationLogs).omit({
  id: true,
});

export const STANDARD_PRE_APPROVAL_CONDITIONS = [
  { category: "lender_underwriting", text: "Final lender underwriting approval", order: 1 },
  { category: "appraisal", text: "Satisfactory appraisal of the subject property", order: 2 },
  { category: "verification", text: "Verification of unchanged financial condition prior to closing", order: 3 },
  { category: "documentation", text: "Receipt of any additional documentation as requested by the lender", order: 4 },
  { category: "title", text: "Clear and marketable title to the subject property", order: 5 },
  { category: "insurance", text: "Proof of adequate homeowner's insurance", order: 6 },
] as const;

export type InsertDisclaimerVersion = z.infer<typeof insertDisclaimerVersionSchema>;
export type DisclaimerVersion = typeof disclaimerVersions.$inferSelect;
export type InsertPreApprovalLetter = z.infer<typeof insertPreApprovalLetterSchema>;
export type PreApprovalLetter = typeof preApprovalLetters.$inferSelect;
export type InsertPreApprovalCondition = z.infer<typeof insertPreApprovalConditionSchema>;
export type PreApprovalCondition = typeof preApprovalConditions.$inferSelect;
export type InsertLetterGenerationLog = z.infer<typeof insertLetterGenerationLogSchema>;
export type LetterGenerationLog = typeof letterGenerationLogs.$inferSelect;

// ============================================================================
// INSTITUTIONAL PLATFORM FEATURES
// ============================================================================

export const expirationPolicies = pgTable("expiration_policies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  policyName: varchar("policy_name", { length: 100 }).notNull(),
  productType: varchar("product_type", { length: 20 }).notNull(),
  
  preApprovalValidityDays: integer("pre_approval_validity_days").default(90).notNull(),
  creditValidityDays: integer("credit_validity_days").default(120).notNull(),
  incomeDocValidityDays: integer("income_doc_validity_days").default(60).notNull(),
  assetDocValidityDays: integer("asset_doc_validity_days").default(60).notNull(),
  employmentVerificationValidityDays: integer("employment_verification_validity_days").default(30),
  
  preApprovalWarningDays: integer("pre_approval_warning_days").default(14),
  creditWarningDays: integer("credit_warning_days").default(21),
  incomeDocWarningDays: integer("income_doc_warning_days").default(10),
  assetDocWarningDays: integer("asset_doc_warning_days").default(10),
  
  isActive: boolean("is_active").default(true),
  effectiveFrom: timestamp("effective_from").notNull(),
  effectiveTo: timestamp("effective_to"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_expiration_policies_product").on(table.productType),
  index("idx_expiration_policies_active").on(table.isActive),
]);

export const insertExpirationPolicySchema = createInsertSchema(expirationPolicies).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CREDIT_REFRESH_TYPES = ["SOFT", "HARD"] as const;
export type CreditRefreshType = typeof CREDIT_REFRESH_TYPES[number];

export const CREDIT_REFRESH_REASONS = [
  "credit_expiring",
  "liability_change_detected",
  "aus_submission",
  "lender_selection",
  "borrower_request",
  "rate_lock_required",
  "compliance_requirement",
] as const;
export type CreditRefreshReason = typeof CREDIT_REFRESH_REASONS[number];

export const creditRefreshDecisions = pgTable("credit_refresh_decisions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  borrowerId: varchar("borrower_id").references(() => users.id).notNull(),
  
  refreshType: varchar("refresh_type", { length: 10 }).notNull(),
  reason: varchar("reason", { length: 50 }).notNull(),
  reasonDetails: text("reason_details"),
  
  consentId: varchar("consent_id").references(() => creditConsents.id),
  consentObtained: boolean("consent_obtained").default(false),
  consentObtainedAt: timestamp("consent_obtained_at"),
  
  previousCreditReportId: varchar("previous_credit_report_id"),
  previousCreditScore: integer("previous_credit_score"),
  previousExpirationDate: timestamp("previous_expiration_date"),
  
  newCreditReportId: varchar("new_credit_report_id"),
  newCreditScore: integer("new_credit_score"),
  newExpirationDate: timestamp("new_expiration_date"),
  
  scoreChange: integer("score_change"),
  significantChange: boolean("significant_change").default(false),
  
  previousSnapshotId: varchar("previous_snapshot_id").references(() => underwritingDecisions.id),
  newSnapshotId: varchar("new_snapshot_id").references(() => underwritingDecisions.id),
  previousLetterId: varchar("previous_letter_id").references(() => preApprovalLetters.id),
  newLetterId: varchar("new_letter_id").references(() => preApprovalLetters.id),
  
  decisionMadeBy: varchar("decision_made_by").references(() => users.id),
  decisionMadeBySystem: boolean("decision_made_by_system").default(false),
  decisionAt: timestamp("decision_at").defaultNow(),
  
  executedAt: timestamp("executed_at"),
  executionStatus: varchar("execution_status", { length: 20 }),
  executionError: text("execution_error"),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_credit_refresh_decisions_application").on(table.applicationId),
  index("idx_credit_refresh_decisions_borrower").on(table.borrowerId),
  index("idx_credit_refresh_decisions_type").on(table.refreshType),
  index("idx_credit_refresh_decisions_decision_at").on(table.decisionAt),
]);

export const insertCreditRefreshDecisionSchema = createInsertSchema(creditRefreshDecisions).omit({
  id: true,
  createdAt: true,
});

export const lenderPreApprovalFormats = pgTable("lender_pre_approval_formats", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  lenderId: varchar("lender_id", { length: 100 }).notNull().unique(),
  lenderName: varchar("lender_name", { length: 255 }).notNull(),
  lenderLogo: varchar("lender_logo", { length: 500 }),
  
  showLoanAmount: boolean("show_loan_amount").default(true),
  showDti: boolean("show_dti").default(false),
  showCreditScore: boolean("show_credit_score").default(false),
  showAssetReserves: boolean("show_asset_reserves").default(false),
  showIncomeDetails: boolean("show_income_details").default(false),
  showLtv: boolean("show_ltv").default(false),
  showProductType: boolean("show_product_type").default(true),
  showOccupancy: boolean("show_occupancy").default(true),
  showPropertyAddress: boolean("show_property_address").default(true),
  
  requiredFields: jsonb("required_fields").$type<string[]>().default([]),
  
  disclaimerOverrides: jsonb("disclaimer_overrides").$type<{
    primary?: string;
    brokerRole?: string;
    documentReliance?: string;
    changeInCircumstance?: string;
    systemGenerated?: string;
    lenderSpecific?: string;
  }>(),
  
  brandingRules: jsonb("branding_rules").$type<{
    primaryColor?: string;
    secondaryColor?: string;
    fontFamily?: string;
    headerStyle?: string;
    footerText?: string;
    customWatermark?: string;
  }>(),
  
  letterFormat: varchar("letter_format", { length: 20 }).default("standard"),
  includeConditions: boolean("include_conditions").default(true),
  maxConditionsToShow: integer("max_conditions_to_show"),
  
  fieldOrdering: jsonb("field_ordering").$type<string[]>(),
  
  templateId: varchar("template_id", { length: 100 }),
  templateVersion: varchar("template_version", { length: 20 }),
  
  isActive: boolean("is_active").default(true),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_lender_pre_approval_formats_lender").on(table.lenderId),
  index("idx_lender_pre_approval_formats_active").on(table.isActive),
]);

export const insertLenderPreApprovalFormatSchema = createInsertSchema(lenderPreApprovalFormats).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CONFIDENCE_LEVELS = ["strong", "solid", "fragile"] as const;
export type ConfidenceLevel = typeof CONFIDENCE_LEVELS[number];

export const agentConfidenceViews = pgTable("agent_confidence_views", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  confidenceBreakdownId: varchar("confidence_breakdown_id").references(() => confidenceBreakdowns.id).notNull(),
  
  overallScore: decimal("overall_score", { precision: 4, scale: 2 }).notNull(),
  
  incomeScore: decimal("income_score", { precision: 4, scale: 2 }),
  assetsScore: decimal("assets_score", { precision: 4, scale: 2 }),
  creditScore: decimal("credit_score", { precision: 4, scale: 2 }),
  documentationScore: decimal("documentation_score", { precision: 4, scale: 2 }),
  stabilityScore: decimal("stability_score", { precision: 4, scale: 2 }),
  
  confidenceLevel: varchar("confidence_level", { length: 20 }).notNull(),
  
  riskFlags: jsonb("risk_flags").$type<string[]>().default([]),
  
  tooltipText: text("tooltip_text").default("Confidence score reflects the strength and completeness of the loan file based on preliminary analysis. It is not a lender decision."),
  
  visibleToAgents: boolean("visible_to_agents").default(true),
  visibleToBorrower: boolean("visible_to_borrower").default(false),
  visibleToLO: boolean("visible_to_lo").default(true),
  visibleToProcessor: boolean("visible_to_processor").default(true),
  visibleToUnderwriter: boolean("visible_to_underwriter").default(true),
  
  underwritingSnapshotId: varchar("underwriting_snapshot_id").references(() => underwritingDecisions.id),
  
  computedAt: timestamp("computed_at").defaultNow(),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_agent_confidence_views_application").on(table.applicationId),
  index("idx_agent_confidence_views_level").on(table.confidenceLevel),
  index("idx_agent_confidence_views_computed").on(table.computedAt),
]);

export const insertAgentConfidenceViewSchema = createInsertSchema(agentConfidenceViews).omit({
  id: true,
  createdAt: true,
});

export const documentExpirations = pgTable("document_expirations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  documentId: varchar("document_id").references(() => documents.id).notNull(),
  
  documentType: varchar("document_type", { length: 50 }).notNull(),
  
  documentDate: timestamp("document_date").notNull(),
  expirationDate: timestamp("expiration_date").notNull(),
  warningDate: timestamp("warning_date"),
  
  policyId: varchar("policy_id").references(() => expirationPolicies.id),
  
  status: varchar("status", { length: 20 }).default("valid"),
  
  warningNotifiedAt: timestamp("warning_notified_at"),
  expirationNotifiedAt: timestamp("expiration_notified_at"),
  notifiedBorrower: boolean("notified_borrower").default(false),
  notifiedLO: boolean("notified_lo").default(false),
  notifiedAgent: boolean("notified_agent").default(false),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_document_expirations_application").on(table.applicationId),
  index("idx_document_expirations_document").on(table.documentId),
  index("idx_document_expirations_status").on(table.status),
  index("idx_document_expirations_expiration").on(table.expirationDate),
]);

export const insertDocumentExpirationSchema = createInsertSchema(documentExpirations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertExpirationPolicy = z.infer<typeof insertExpirationPolicySchema>;
export type ExpirationPolicy = typeof expirationPolicies.$inferSelect;
export type InsertCreditRefreshDecision = z.infer<typeof insertCreditRefreshDecisionSchema>;
export type CreditRefreshDecision = typeof creditRefreshDecisions.$inferSelect;
export type InsertLenderPreApprovalFormat = z.infer<typeof insertLenderPreApprovalFormatSchema>;
export type LenderPreApprovalFormat = typeof lenderPreApprovalFormats.$inferSelect;
export type InsertAgentConfidenceView = z.infer<typeof insertAgentConfidenceViewSchema>;
export type AgentConfidenceView = typeof agentConfidenceViews.$inferSelect;
export type InsertDocumentExpiration = z.infer<typeof insertDocumentExpirationSchema>;
export type DocumentExpiration = typeof documentExpirations.$inferSelect;

// =============================================================================
// LENDER DATA PACKAGES
// =============================================================================

export const lenderDataPackages = pgTable("lender_data_packages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  packageId: varchar("package_id", { length: 100 }).notNull().unique(),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  snapshotId: varchar("snapshot_id").references(() => underwritingSnapshots.id).notNull(),
  
  lenderId: varchar("lender_id", { length: 100 }).notNull(),
  lenderName: varchar("lender_name", { length: 255 }).notNull(),
  lenderFormatId: varchar("lender_format_id").references(() => lenderPreApprovalFormats.id),
  
  status: varchar("status", { length: 30 }).default("DRAFT"),
  
  borrowerSummary: jsonb("borrower_summary").$type<{
    borrowerType: string;
    occupancy: string;
    loanPurpose: string;
    productType: string;
    confidenceScore?: number;
    preApprovalAmount: number;
    expirationDate: string;
  }>(),
  
  underwritingMetrics: jsonb("underwriting_metrics").$type<{
    DTI: {
      frontEnd: number;
      backEnd: number;
      calculationMethod: string;
      confidence?: number;
    };
    DSCR?: {
      applicable: boolean;
      value?: number;
      method?: string;
      confidence?: number;
    };
    LTV: number;
    CLTV: number;
    creditScore?: number;
    reserves?: number;
  }>(),
  
  decisionSnapshot: jsonb("decision_snapshot").$type<{
    decisionType: string;
    snapshotId: string;
    policyAuthority: string;
    policyVersion: string;
    issuedAt: string;
    expiresAt: string;
    decisionStatus: string;
  }>(),
  
  documentIndex: jsonb("document_index").$type<{
    documents: {
      documentId: string;
      type: string;
      borrower: string;
      dateRange?: string;
      confidence: number;
      pages: number;
    }[];
    extractedData: {
      income: Record<string, number>;
      assets: Record<string, number | boolean>;
    };
  }>(),
  
  cocStatus: jsonb("coc_status").$type<{
    monitoringActive: boolean;
    lastChecked: string;
    materialChangesDetected: boolean;
    rulesetVersion: string;
    events?: {
      dimension: string;
      event: string;
      severity: string;
      actionTaken: string;
      timestamp: string;
    }[];
  }>(),
  
  explanations: jsonb("explanations").$type<{
    metric: string;
    method: string;
    inputs: string[];
    reasoning: string;
  }[]>(),
  
  submittedAt: timestamp("submitted_at"),
  submittedBy: varchar("submitted_by"),
  responseReceivedAt: timestamp("response_received_at"),
  lenderResponse: jsonb("lender_response").$type<{
    status: string;
    conditions?: string[];
    notes?: string;
    respondedBy?: string;
  }>(),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_lender_data_packages_application").on(table.applicationId),
  index("idx_lender_data_packages_snapshot").on(table.snapshotId),
  index("idx_lender_data_packages_lender").on(table.lenderId),
  index("idx_lender_data_packages_status").on(table.status),
]);

export const insertLenderDataPackageSchema = createInsertSchema(lenderDataPackages).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLenderDataPackage = z.infer<typeof insertLenderDataPackageSchema>;
export type LenderDataPackage = typeof lenderDataPackages.$inferSelect;

// =============================================================================
// OFFER BRIDGE ARCHITECTURE
// =============================================================================
