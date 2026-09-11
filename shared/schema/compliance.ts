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
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users } from "./core";
import { loanApplications } from "./lending";
import { agentProfiles } from "./property";

// =============================================================================
// CREDIT & FCRA COMPLIANCE
// =============================================================================

// Credit Consents - FCRA-compliant consent capture before any credit action
export const creditConsents = pgTable("credit_consents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  
  // Consent Details
  consentType: varchar("consent_type", { length: 50 }).notNull(), // credit_pull, soft_pull, hard_pull, monitoring
  disclosureVersion: varchar("disclosure_version", { length: 50 }).notNull(), // e.g., "FCRA-2024-v1"
  disclosureText: text("disclosure_text").notNull(), // Full text of disclosure shown
  
  // Borrower Agreement
  consentGiven: boolean("consent_given").notNull(),
  consentTimestamp: timestamp("consent_timestamp").notNull(),
  
  // Identity Verification
  borrowerFullName: varchar("borrower_full_name", { length: 255 }).notNull(),
  borrowerSSNLast4: varchar("borrower_ssn_last4", { length: 4 }), // Last 4 digits for verification
  borrowerDOB: varchar("borrower_dob", { length: 10 }), // YYYY-MM-DD
  
  // Audit Trail
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  signatureType: varchar("signature_type", { length: 50 }).default("electronic"), // electronic, esignature
  
  // Status
  isActive: boolean("is_active").default(true),
  revokedAt: timestamp("revoked_at"),
  revokedReason: text("revoked_reason"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_credit_consents_application").on(table.applicationId),
  index("idx_credit_consents_user").on(table.userId),
]);

export const insertCreditConsentSchema = createInsertSchema(creditConsents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCreditConsent = z.infer<typeof insertCreditConsentSchema>;
export type CreditConsent = typeof creditConsents.$inferSelect;

// Draft Consent Progress - For save & resume functionality
export const draftConsentProgress = pgTable("draft_consent_progress", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),
  
  // Saved form data
  consentType: varchar("consent_type", { length: 50 }).default("hard_pull"),
  borrowerFullName: varchar("borrower_full_name", { length: 255 }),
  borrowerSSNLast4: varchar("borrower_ssn_last4", { length: 4 }),
  borrowerDOB: varchar("borrower_dob", { length: 10 }),
  
  // Progress tracking
  disclosureRead: boolean("disclosure_read").default(false),
  acknowledged: boolean("acknowledged").default(false),
  currentStep: integer("current_step").default(1),
  totalSteps: integer("total_steps").default(3),
  
  // State-specific tracking
  stateDisclosuresReviewed: text("state_disclosures_reviewed").array(),
  additionalAcknowledgments: jsonb("additional_acknowledgments"),
  
  // Timestamps
  lastSavedAt: timestamp("last_saved_at").defaultNow(),
  expiresAt: timestamp("expires_at"), // Drafts expire after 7 days
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_draft_consent_application").on(table.applicationId),
  index("idx_draft_consent_user").on(table.userId),
]);

export const insertDraftConsentProgressSchema = createInsertSchema(draftConsentProgress).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDraftConsentProgress = z.infer<typeof insertDraftConsentProgressSchema>;
export type DraftConsentProgress = typeof draftConsentProgress.$inferSelect;

// Credit Pulls - Records of credit bureau inquiries
export const creditPulls = pgTable("credit_pulls", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  consentId: varchar("consent_id").references(() => creditConsents.id).notNull(),
  requestedBy: varchar("requested_by").references(() => users.id).notNull(),
  // AG-2: which AI agent performed the pull (e.g. "agent:<id>"); requestedBy
  // stays the borrower. Null for pulls made by humans through the app.
  agentIdentity: varchar("agent_identity", { length: 120 }),

  // Pull Type
  pullType: varchar("pull_type", { length: 50 }).notNull(), // soft, hard, tri_merge
  bureaus: text("bureaus").array(), // ['experian', 'equifax', 'transunion']
  
  // Status
  status: varchar("status", { length: 50 }).default("pending").notNull(), // pending, processing, completed, failed, expired
  
  // Credit Report Data (encrypted/tokenized in production)
  externalRequestId: varchar("external_request_id", { length: 255 }), // Credit bureau reference
  
  // Scores (when completed)
  experianScore: integer("experian_score"),
  equifaxScore: integer("equifax_score"),
  transunionScore: integer("transunion_score"),
  // For a joint file these top-level scores belong to the controlling
  // borrower (the borrower with the lowest representative score).
  representativeScore: integer("representative_score"),
  // One reproducible score set per borrower. The decision layer refuses a
  // joint file when any identified borrower is absent and uses the lowest
  // borrower representative score, matching agency delivery convention.
  borrowerScores: jsonb("borrower_scores").$type<Array<{
    borrowerSequenceNumber: number;
    experianScore: number | null;
    equifaxScore: number | null;
    transunionScore: number | null;
    representativeScore: number;
  }>>(),
  // FHFA is phasing VantageScore 4.0 into conforming underwriting alongside
  // Classic FICO; capture both when the bureau returns them.
  vantageScore4: integer("vantage_score_4"),
  
  // Report Summary
  totalTradelines: integer("total_tradelines"),
  openTradelines: integer("open_tradelines"),
  totalDebt: decimal("total_debt", { precision: 12, scale: 2 }),
  monthlyPayments: decimal("monthly_payments", { precision: 10, scale: 2 }),
  derogatoryCount: integer("derogatory_count"),
  inquiryCount30Days: integer("inquiry_count_30_days"),
  inquiryCount90Days: integer("inquiry_count_90_days"),
  
  // Report Storage (reference to secure storage, not the report itself)
  reportStorageRef: varchar("report_storage_ref", { length: 500 }),

  // Machine-readable liability ledger (creditor, type, balance, monthlyPayment,
  // deferred, openedDaysAgo) — what deterministic underwriting math reads
  // (deferred-student-loan 1% rule, new-tradeline detection) without touching
  // the encrypted blob. No SSN or account numbers are ever stored here.
  liabilities: jsonb("liabilities"),

  // Encrypted Raw Response (AES-256-GCM encrypted)
  encryptedRawResponse: text("encrypted_raw_response"), // Base64 encoded encrypted data
  encryptionKeyId: varchar("encryption_key_id", { length: 100 }), // Reference to key used
  encryptionIV: varchar("encryption_iv", { length: 48 }), // Base64 encoded IV
  
  // Vendor Response Metadata (for reconciliation)
  vendorRequestId: varchar("vendor_request_id", { length: 255 }),
  vendorResponseHash: varchar("vendor_response_hash", { length: 64 }), // SHA-256 of raw response
  vendorBillingRef: varchar("vendor_billing_ref", { length: 255 }),
  // True when the scores were fabricated (no live bureau). Surfaced so staff and
  // audit can tell a real pull from a simulated one at a glance — the flag also
  // lives inside the encrypted raw response, but this column keeps it queryable.
  isSimulated: boolean("is_simulated").default(false).notNull(),

  // Error Handling
  errorCode: varchar("error_code", { length: 50 }),
  errorMessage: text("error_message"),
  
  // Timestamps
  requestedAt: timestamp("requested_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  expiresAt: timestamp("expires_at"), // Credit reports typically valid for 120 days
  archivedAt: timestamp("archived_at"), // For FCRA retention compliance
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_credit_pulls_application").on(table.applicationId),
  index("idx_credit_pulls_consent").on(table.consentId),
  index("idx_credit_pulls_status").on(table.status),
]);

export const insertCreditPullSchema = createInsertSchema(creditPulls).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCreditPull = z.infer<typeof insertCreditPullSchema>;
export type CreditPull = typeof creditPulls.$inferSelect;

// Adverse Actions - FCRA-required notices when credit is used against applicant
export const adverseActions = pgTable("adverse_actions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  creditPullId: varchar("credit_pull_id").references(() => creditPulls.id),
  userId: varchar("user_id").references(() => users.id).notNull(),
  
  // Action Type
  actionType: varchar("action_type", { length: 50 }).notNull(), // denial, counteroffer, rate_adjustment, terms_change
  
  // Reasons (FCRA requires specific reasons)
  primaryReason: varchar("primary_reason", { length: 255 }).notNull(),
  secondaryReasons: text("secondary_reasons").array(),
  
  // Credit Information Used
  creditScoreUsed: integer("credit_score_used"),
  creditScoreSource: varchar("credit_score_source", { length: 50 }), // experian, equifax, transunion
  scoreRangeLow: integer("score_range_low"),
  scoreRangeHigh: integer("score_range_high"),
  
  // Required Disclosures
  bureauName: varchar("bureau_name", { length: 100 }),
  bureauAddress: text("bureau_address"),
  bureauPhone: varchar("bureau_phone", { length: 20 }),
  bureauWebsite: varchar("bureau_website", { length: 255 }),
  
  // Notice Details
  noticeText: text("notice_text").notNull(), // Full adverse action notice
  
  // Delivery
  deliveryMethod: varchar("delivery_method", { length: 50 }), // email, mail, both, in_app
  deliveredAt: timestamp("delivered_at"),
  deliveryConfirmation: varchar("delivery_confirmation", { length: 255 }),
  
  // FCRA Compliance
  noticeDate: timestamp("notice_date").notNull(), // Date notice was generated
  // Whether the adverse action was based in whole or in part on a consumer
  // report (15 U.S.C. §1681m(a)) — the trigger for ALL §615(a) notice content.
  // Nullable with NO default: rows written before this column existed cannot
  // have their basis reconstructed, and a backfilled guess on a compliance
  // record would be a falsified record. NULL = unknown/pre-fix; new rows always
  // carry an explicit value (server/services/creditAdverseActions.ts).
  basedOnConsumerReport: boolean("based_on_consumer_report"),
  // COMPUTED per notice by computeFcraCompliant() — asserts "this notice
  // contains every §615(a) disclosure applicable to the facts of this action".
  // Never stamped true unconditionally and never given a DB default (WF5-F2).
  fcraCompliant: boolean("fcra_compliant"),
  
  // Staff Actions
  generatedBy: varchar("generated_by").references(() => users.id),
  reviewedBy: varchar("reviewed_by").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_adverse_actions_application").on(table.applicationId),
  index("idx_adverse_actions_user").on(table.userId),
  index("idx_adverse_actions_credit_pull").on(table.creditPullId),
]);

export const insertAdverseActionSchema = createInsertSchema(adverseActions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAdverseAction = z.infer<typeof insertAdverseActionSchema>;
export type AdverseAction = typeof adverseActions.$inferSelect;

// Credit Audit Log - Immutable record of every credit-related action
export const creditAuditLog = pgTable("credit_audit_log", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // References
  applicationId: varchar("application_id").references(() => loanApplications.id),
  userId: varchar("user_id").references(() => users.id),
  consentId: varchar("consent_id").references(() => creditConsents.id),
  creditPullId: varchar("credit_pull_id").references(() => creditPulls.id),
  adverseActionId: varchar("adverse_action_id").references(() => adverseActions.id),
  
  // Action Details
  action: varchar("action", { length: 100 }).notNull(), // consent_given, consent_revoked, pull_requested, pull_completed, adverse_action_generated, etc.
  actionDetails: jsonb("action_details"), // Additional context
  
  // Actor
  performedBy: varchar("performed_by").references(() => users.id),
  performedByRole: varchar("performed_by_role", { length: 50 }),
  
  // Audit Trail
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  
  // Cryptographic Integrity (append-only chain)
  entryHash: varchar("entry_hash", { length: 64 }).notNull(), // SHA-256 of this entry's content
  previousEntryHash: varchar("previous_entry_hash", { length: 64 }), // Hash of previous entry (chain)
  sequenceNumber: integer("sequence_number"), // Per-application sequence for ordering
  // Hash algorithm used for entryHash (F-046). NULL = v1, i.e. written before
  // versioning existed; v1 does NOT hash sequenceNumber, so those rows remain
  // renumberable. v2 folds sequenceNumber AND this marker into the digest, which
  // is what makes a downgrade to v1 fail verification. Never backfilled: NULL is
  // the honest statement that an entry predates the scheme.
  hashVersion: integer("hash_version"),
  
  // Timestamp (immutable)
  timestamp: timestamp("timestamp").defaultNow().notNull(),
}, (table) => [
  index("idx_credit_audit_application").on(table.applicationId),
  index("idx_credit_audit_timestamp").on(table.timestamp),
  index("idx_credit_audit_action").on(table.action),
  index("idx_credit_audit_entry_hash").on(table.entryHash),
]);

/**
 * External end-marker for each audit chain (finding F-038).
 *
 * Nothing inside a hash chain can detect the removal of its own end: delete the
 * last K entries and the remainder is perfectly self-consistent, which is
 * exactly why tail truncation is the deletion an insider would actually use.
 * Detecting it requires a record kept OUTSIDE the chain of where the chain last
 * ended. This table is that record, written in the same transaction as every
 * append.
 *
 * Honest about what it is: this lives in the same database as the log, so an
 * attacker with write access can update it too. It is not a cryptographic
 * guarantee — it turns a one-row delete into a two-table coordinated write, and
 * it catches every non-adversarial cause (a partial restore, a bad migration, a
 * dropped transaction) outright. A real guarantee needs an append-only store
 * outside this database.
 */
export const creditAuditChainTips = pgTable("credit_audit_chain_tips", {
  /** applicationId, or the NULL_SCOPE sentinel for entries with no application. */
  scopeKey: varchar("scope_key").primaryKey(),
  /** entryHash of the last entry appended to this scope. */
  tipEntryHash: varchar("tip_entry_hash", { length: 64 }).notNull(),
  /** sequenceNumber of that entry. */
  tipSequenceNumber: integer("tip_sequence_number").notNull(),
  /**
   * The sequence number at which tip tracking began for this scope.
   *
   * Chains that already existed when this table shipped get a tip on their next
   * append, not a backfill — a backfilled tip would bless whatever the chain
   * happened to contain at that moment as authoritative, which is the
   * falsified-provenance problem this whole mechanism exists to prevent.
   * Verification reports entries before this point as not tail-anchored rather
   * than claiming a coverage it does not have.
   */
  trackingStartedAtSequence: integer("tracking_started_at_sequence").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type CreditAuditChainTip = typeof creditAuditChainTips.$inferSelect;

export const insertCreditAuditLogSchema = createInsertSchema(creditAuditLog).omit({
  id: true,
});

export type InsertCreditAuditLog = z.infer<typeof insertCreditAuditLogSchema>;
export type CreditAuditLog = typeof creditAuditLog.$inferSelect;

// ===== ASPIRING OWNER JOURNEY =====

// Homeownership Goals - Main tracking for aspiring owner journey
export const homeownershipGoals = pgTable("homeownership_goals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull().unique(),
  
  // Current Financial Status (entered by user or pulled from Plaid)
  currentCreditScore: integer("current_credit_score"),
  currentMonthlySavings: decimal("current_monthly_savings", { precision: 10, scale: 2 }),
  currentSavingsBalance: decimal("current_savings_balance", { precision: 12, scale: 2 }).default("0"),
  monthlyIncome: decimal("monthly_income", { precision: 10, scale: 2 }),
  monthlyDebts: decimal("monthly_debts", { precision: 10, scale: 2 }),
  currentRent: decimal("current_rent", { precision: 10, scale: 2 }),
  
  // Target Goals
  targetCreditScore: integer("target_credit_score").default(640),
  targetDownPayment: decimal("target_down_payment", { precision: 12, scale: 2 }),
  targetHomePrice: decimal("target_home_price", { precision: 12, scale: 2 }),
  targetMonthlyPayment: decimal("target_monthly_payment", { precision: 10, scale: 2 }),
  
  // Journey Status
  journeyStartDate: timestamp("journey_start_date").defaultNow(),
  currentPhase: varchar("current_phase", { length: 50 }).default("discovery"), // discovery, credit_cleanup, saving, ready
  journeyDay: integer("journey_day").default(1),
  
  // Progress Tracking
  creditScoreChange: integer("credit_score_change").default(0), // cumulative change since start
  savingsProgress: decimal("savings_progress", { precision: 12, scale: 2 }).default("0"), // total saved toward goal
  
  // Preferred location
  targetCity: varchar("target_city", { length: 100 }),
  targetState: varchar("target_state", { length: 50 }),
  targetZipCode: varchar("target_zip_code", { length: 20 }),
  
  // Linked agent (if referred)
  referringAgentId: varchar("referring_agent_id").references(() => agentProfiles.id),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_homeownership_goals_user").on(table.userId),
  index("idx_homeownership_goals_phase").on(table.currentPhase),
]);

export const insertHomeownershipGoalSchema = createInsertSchema(homeownershipGoals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertHomeownershipGoal = z.infer<typeof insertHomeownershipGoalSchema>;
export type HomeownershipGoal = typeof homeownershipGoals.$inferSelect;

// Credit Actions - Track credit improvement actions
export const creditActions = pgTable("credit_actions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: varchar("goal_id").references(() => homeownershipGoals.id).notNull(),
  
  // Action Details
  actionType: varchar("action_type", { length: 50 }).notNull(), // pay_down_card, dispute_error, authorized_user, secured_card, on_time_payment
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  
  // Impact
  estimatedPointsGain: integer("estimated_points_gain"),
  actualPointsGain: integer("actual_points_gain"),
  priority: varchar("priority", { length: 20 }).default("medium"), // high, medium, low
  
  // Status
  status: varchar("status", { length: 50 }).default("pending"), // pending, in_progress, completed, skipped
  completedAt: timestamp("completed_at"),
  
  // Related account info (if applicable)
  creditorName: varchar("creditor_name", { length: 255 }),
  accountBalance: decimal("account_balance", { precision: 10, scale: 2 }),
  recommendedPayment: decimal("recommended_payment", { precision: 10, scale: 2 }),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_credit_actions_goal").on(table.goalId),
  index("idx_credit_actions_status").on(table.status),
]);

export const insertCreditActionSchema = createInsertSchema(creditActions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCreditAction = z.infer<typeof insertCreditActionSchema>;
export type CreditAction = typeof creditActions.$inferSelect;

// Savings Transactions - Track savings deposits and round-ups
export const savingsTransactions = pgTable("savings_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: varchar("goal_id").references(() => homeownershipGoals.id).notNull(),
  
  // Transaction Details
  transactionType: varchar("transaction_type", { length: 50 }).notNull(), // manual_deposit, round_up, recurring, bonus
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  description: varchar("description", { length: 255 }),
  
  // Running Total
  runningBalance: decimal("running_balance", { precision: 12, scale: 2 }).notNull(),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_savings_transactions_goal").on(table.goalId),
]);

export const insertSavingsTransactionSchema = createInsertSchema(savingsTransactions).omit({
  id: true,
  createdAt: true,
});

export type InsertSavingsTransaction = z.infer<typeof insertSavingsTransactionSchema>;
export type SavingsTransaction = typeof savingsTransactions.$inferSelect;

// Journey Milestones - Track achieved milestones
export const journeyMilestones = pgTable("journey_milestones", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  goalId: varchar("goal_id").references(() => homeownershipGoals.id).notNull(),
  
  // Milestone Details
  milestoneType: varchar("milestone_type", { length: 50 }).notNull(), 
  // Types: first_deposit, credit_score_up_10, credit_score_up_25, savings_500, savings_1000, 
  // savings_2500, savings_5000, day_7, day_14, day_30, target_credit_reached, target_savings_reached
  
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  celebrationMessage: text("celebration_message"),
  
  // Achievement
  achievedAt: timestamp("achieved_at").defaultNow(),
  pointsAwarded: integer("points_awarded").default(0),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_journey_milestones_goal").on(table.goalId),
  index("idx_journey_milestones_type").on(table.milestoneType),
]);

export const insertJourneyMilestoneSchema = createInsertSchema(journeyMilestones).omit({
  id: true,
  createdAt: true,
});

export type InsertJourneyMilestone = z.infer<typeof insertJourneyMilestoneSchema>;
export type JourneyMilestone = typeof journeyMilestones.$inferSelect;

// ===== ECONSENT SYSTEM =====

// Consent Types - Define available consent types
export const CONSENT_TYPES = [
  "credit_authorization",    // Authorize credit pull
  "econsent",               // Electronic signature consent  
  "privacy_policy",         // Privacy policy acknowledgment
  "terms_of_service",       // Terms acceptance
  "disclosure",             // General disclosures
  "appraisal_waiver",       // Waive right to appraisal copy timing
  "title_acknowledgment",   // Title company selection acknowledgment
  "rate_lock_agreement",    // Rate lock terms
  "intent_to_proceed",      // TRID intent to proceed
  "loan_estimate_receipt",  // Acknowledge loan estimate receipt
  "tax_document_use",       // Use of a self-uploaded tax return for readiness insights
] as const;

export type ConsentType = typeof CONSENT_TYPES[number];

// Consent Templates - Define consent content per type/state
export const consentTemplates = pgTable("consent_templates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Type and Version
  consentType: varchar("consent_type", { length: 50 }).notNull(),
  version: varchar("version", { length: 20 }).notNull(), // e.g., "1.0.0"
  
  // State-specific (null = federal/all states)
  state: varchar("state", { length: 2 }),
  
  // Content
  title: varchar("title", { length: 255 }).notNull(),
  shortDescription: text("short_description"),
  fullText: text("full_text").notNull(), // Full legal text
  
  // Regulatory
  regulatoryReference: varchar("regulatory_reference", { length: 255 }), // e.g., "TRID Section 4", "FCRA 604"
  requiredForLoanTypes: text("required_for_loan_types").array(), // ['conventional', 'fha', 'va']
  
  // Status
  isActive: boolean("is_active").default(true).notNull(),
  effectiveDate: timestamp("effective_date").notNull(),
  expirationDate: timestamp("expiration_date"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_consent_templates_type").on(table.consentType),
  index("idx_consent_templates_state").on(table.state),
  index("idx_consent_templates_active").on(table.isActive),
]);

export const insertConsentTemplateSchema = createInsertSchema(consentTemplates).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertConsentTemplate = z.infer<typeof insertConsentTemplateSchema>;
export type ConsentTemplate = typeof consentTemplates.$inferSelect;

// Borrower Consents - Audit trail of all consents given
export const borrowerConsents = pgTable("borrower_consents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  
  // Links
  userId: varchar("user_id").references(() => users.id).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id),
  templateId: varchar("template_id").references(() => consentTemplates.id),
  
  // Consent Details
  consentType: varchar("consent_type", { length: 50 }).notNull(),
  templateVersion: varchar("template_version", { length: 20 }),
  
  // Consent Capture
  consentGiven: boolean("consent_given").notNull(),
  consentMethod: varchar("consent_method", { length: 50 }).notNull(), // 'click', 'signature', 'verbal', 'paper'
  
  // Digital Signature (if applicable)
  signatureData: text("signature_data"), // Base64 signature image or typed name
  signatureType: varchar("signature_type", { length: 20 }), // 'drawn', 'typed', 'none'
  
  // Audit Trail - Immutable
  ipAddress: varchar("ip_address", { length: 45 }),
  userAgent: text("user_agent"),
  browserFingerprint: varchar("browser_fingerprint", { length: 64 }),
  
  // Timing
  consentedAt: timestamp("consented_at").defaultNow().notNull(),
  
  // Revocation (if applicable)
  isRevoked: boolean("is_revoked").default(false),
  revokedAt: timestamp("revoked_at"),
  revocationReason: text("revocation_reason"),
  
  // Hash for tamper evidence
  contentHash: varchar("content_hash", { length: 64 }), // SHA-256 of consent content at time of signing
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_borrower_consents_user").on(table.userId),
  index("idx_borrower_consents_application").on(table.applicationId),
  index("idx_borrower_consents_type").on(table.consentType),
]);

export const insertBorrowerConsentSchema = createInsertSchema(borrowerConsents).omit({
  id: true,
  createdAt: true,
});

export type InsertBorrowerConsent = z.infer<typeof insertBorrowerConsentSchema>;
export type BorrowerConsent = typeof borrowerConsents.$inferSelect;

// ===== HMDA DEMOGRAPHICS =====

export const hmdaDemographics = pgTable("hmda_demographics", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  borrowerId: varchar("borrower_id").references(() => users.id).notNull(),
  borrowerSequenceNumber: integer("borrower_sequence_number").default(1),

  ethnicityHispanicLatino: boolean("ethnicity_hispanic_latino"),
  ethnicityMexican: boolean("ethnicity_mexican").default(false),
  ethnicityCuban: boolean("ethnicity_cuban").default(false),
  ethnicityPuertoRican: boolean("ethnicity_puerto_rican").default(false),
  ethnicityOtherHispanicLatino: boolean("ethnicity_other_hispanic_latino").default(false),
  ethnicityOtherText: varchar("ethnicity_other_text", { length: 255 }),
  ethnicityNotHispanicLatino: boolean("ethnicity_not_hispanic_latino"),
  ethnicityNotProvided: boolean("ethnicity_not_provided").default(false),

  raceAmericanIndian: boolean("race_american_indian").default(false),
  raceAmericanIndianTribe: varchar("race_american_indian_tribe", { length: 255 }),
  raceAsian: boolean("race_asian").default(false),
  raceAsianIndian: boolean("race_asian_indian").default(false),
  raceChinese: boolean("race_chinese").default(false),
  raceFilipino: boolean("race_filipino").default(false),
  raceJapanese: boolean("race_japanese").default(false),
  raceKorean: boolean("race_korean").default(false),
  raceVietnamese: boolean("race_vietnamese").default(false),
  raceOtherAsian: boolean("race_other_asian").default(false),
  raceOtherAsianText: varchar("race_other_asian_text", { length: 255 }),
  raceBlack: boolean("race_black").default(false),
  raceNativeHawaiian: boolean("race_native_hawaiian").default(false),
  raceGuamanian: boolean("race_guamanian").default(false),
  raceSamoan: boolean("race_samoan").default(false),
  raceOtherPacificIslander: boolean("race_other_pacific_islander").default(false),
  raceOtherPacificIslanderText: varchar("race_other_pacific_islander_text", { length: 255 }),
  raceWhite: boolean("race_white").default(false),
  raceNotProvided: boolean("race_not_provided").default(false),

  sexFemale: boolean("sex_female"),
  sexMale: boolean("sex_male"),
  sexNotProvided: boolean("sex_not_provided").default(false),

  age: integer("age"),
  ageNotProvided: boolean("age_not_provided").default(false),

  collectionMethod: varchar("collection_method", { length: 30 }).notNull().default("borrower"),
  observedByVisual: boolean("observed_by_visual").default(false),
  observedBySurname: boolean("observed_by_surname").default(false),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_hmda_application").on(table.applicationId),
  index("idx_hmda_borrower").on(table.borrowerId),
]);

export const insertHmdaDemographicsSchema = createInsertSchema(hmdaDemographics).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertHmdaDemographics = z.infer<typeof insertHmdaDemographicsSchema>;
export type HmdaDemographics = typeof hmdaDemographics.$inferSelect;

/**
 * Third-party asset/income/employment verification reports (Plaid, Truv,
 * Argyle). The GSE report identifiers (voaReportId / voieReportId / audit
 * copy token) are what Fannie DU "Day 1 Certainty" and Freddie AIM consume —
 * store them verbatim so casefile submissions can reference validated data.
 */
export const verificationReports = pgTable("verification_reports", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  userId: varchar("user_id").references(() => users.id).notNull(),

  provider: varchar("provider", { length: 30 }).notNull(), // plaid, truv, argyle
  reportType: varchar("report_type", { length: 30 }).notNull(), // voa, voi, voe, voie, transactions

  // GSE-compliant identifiers for AUS submission (Day 1 Certainty / AIM)
  voaReportId: varchar("voa_report_id", { length: 255 }),
  voieReportId: varchar("voie_report_id", { length: 255 }),
  auditCopyToken: varchar("audit_copy_token", { length: 255 }),
  providerRequestId: varchar("provider_request_id", { length: 255 }), // e.g. Plaid asset_report_id

  status: varchar("status", { length: 30 }).default("pending").notNull(), // pending, completed, failed, expired
  daysRequested: integer("days_requested"),
  gseEligible: boolean("gse_eligible").default(false).notNull(),

  // Summary metadata only — full report payloads live in object storage
  institutionCount: integer("institution_count"),
  accountCount: integer("account_count"),
  totalBalance: decimal("total_balance", { precision: 14, scale: 2 }),
  payloadStorageRef: varchar("payload_storage_ref", { length: 500 }),
  // Raw provider payload snapshot (audit trace: anomalies map back to source).
  // Depository transactions here also feed the large-deposit sourcing check.
  rawPayload: jsonb("raw_payload"),

  requestedAt: timestamp("requested_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_verification_reports_application").on(table.applicationId),
  index("idx_verification_reports_user").on(table.userId),
  index("idx_verification_reports_status").on(table.status),
  index("idx_verification_reports_provider_type").on(table.provider, table.reportType),
  index("idx_verification_reports_voa").on(table.voaReportId),
  index("idx_verification_reports_voie").on(table.voieReportId),
]);

export const insertVerificationReportSchema = createInsertSchema(verificationReports).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertVerificationReport = z.infer<typeof insertVerificationReportSchema>;
export type VerificationReport = typeof verificationReports.$inferSelect;

// =============================================================================
// TRID CHANGE OF CIRCUMSTANCE (Reg Z §1026.19(e)(3)(iv) / §1026.19(e)(4))
//
// One row per recorded changed circumstance / revision event on a file. The
// revised Loan Estimate must be provided within 3 business days of receiving
// the information establishing the change (§1026.19(e)(4)(i)); the due date
// is computed by server/services/changeOfCircumstance.ts and an overdue open
// row blocks wholesale submission (broker readiness stage 1). Delivery is
// stamped when the borrower next retrieves the (regenerated) LE — the same
// ESIGN electronic-delivery mechanism as the original leIssuedDate stamp.
// Reason ids come from shared/compliance/changeOfCircumstance.ts.
// =============================================================================

export const changeOfCircumstances = pgTable(
  "change_of_circumstances",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
    /** One of COC_REASON_TYPES (§1026.19(e)(3)(iv)(A)–(F)). */
    reasonType: varchar("reason_type", { length: 50 }).notNull(),
    description: text("description").notNull(),
    /** When the creditor received information sufficient to establish the change. */
    informationReceivedAt: timestamp("information_received_at").notNull(),
    /** informationReceivedAt + 3 business days (§1026.19(e)(4)(i)). */
    revisedLeDueDate: timestamp("revised_le_due_date").notNull(),
    /** Stamped on the borrower's first LE retrieval after the record was opened. */
    revisedLeDeliveredAt: timestamp("revised_le_delivered_at"),
    /**
     * The disclosure charge ids this circumstance actually affects (audit
     * FA-21). §1026.19(e)(3)(iv) resets good faith only for the charges the
     * circumstance affected — not for every line on the file. Ids match
     * DisclosureSnapshot fee ids (shared/compliance/feeTolerance.ts).
     *
     * NULL = unscoped, which preserves the historical behaviour (the record
     * authorises any increase except the platform's own fixed fees, which no
     * changed circumstance can move). Populating it per reason type is a
     * regulatory reading and is a counsel item — see the module header in
     * shared/compliance/changeOfCircumstance.ts.
     */
    affectedChargeIds: jsonb("affected_charge_ids").$type<string[] | null>(),
    /** open | redisclosed | voided (COC_STATUSES). */
    status: varchar("status", { length: 20 }).notNull().default("open"),
    createdByUserId: varchar("created_by_user_id").references(() => users.id).notNull(),
    voidReason: text("void_reason"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [index("change_of_circumstances_app_idx").on(table.applicationId, table.status)],
);

export const insertChangeOfCircumstanceSchema = createInsertSchema(changeOfCircumstances)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  // createInsertSchema widens jsonb to Json; the column is a typed id list.
  .extend({
    affectedChargeIds: z.array(z.string()).nullable().optional(),
  });
export type InsertChangeOfCircumstance = z.infer<typeof insertChangeOfCircumstanceSchema>;
export type ChangeOfCircumstance = typeof changeOfCircumstances.$inferSelect;

// =============================================================================
// ISSUED LOAN ESTIMATE DISCLOSURES (Reg Z §1026.19(e)(3) tolerance baseline)
// =============================================================================
// The Loan Estimate is generated from live file data, so without this table
// there is no record of what was actually disclosed — the numbers a borrower
// saw on day one silently become different numbers on day ten, and no
// good-faith tolerance comparison is possible because the baseline is gone.
//
// One row per ISSUED disclosure (version 1 = the original LE; each valid
// redisclosure appends). `snapshot` is the tolerance-bucketed fee set from
// shared/compliance/feeTolerance.ts. A row is immutable once written — it is
// the evidentiary record of a disclosure, not a cache.
//
// `cocId` links a revised disclosure to the §1026.19(e)(3)(iv) record that
// authorized resetting the baseline. Version 1 has none; any later version
// without one is a redisclosure that reset nothing and whose increases are a
// cure (services/leDisclosureBaseline.ts enforces this).
export const loanEstimateDisclosures = pgTable(
  "loan_estimate_disclosures",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
    /** 1 = original LE; increments on each valid redisclosure. */
    version: integer("version").notNull(),
    issuedAt: timestamp("issued_at").defaultNow().notNull(),
    /** Tolerance-bucketed fee set + loan terms (DisclosureSnapshot). */
    snapshot: jsonb("snapshot").notNull(),
    /** The change of circumstance that authorized this baseline, when any. */
    cocId: varchar("coc_id").references(() => changeOfCircumstances.id),
    /** ToleranceEvaluation against the previous version; null on version 1. */
    toleranceEvaluation: jsonb("tolerance_evaluation"),
    /**
     * The platform fee schedule this file is PINNED to (audit FA-20).
     *
     * Fees are admin-editable at runtime (routes/admin/pricingPolicy.ts) and
     * four of the lines they set are ZERO-tolerance. Resolving the schedule
     * late — on every recompute — meant publishing raised those lines on every
     * file already in flight; since a creditor re-pricing itself is not a
     * §1026.19(e)(3)(iv) changed circumstance, each of those files became a
     * dollar-for-dollar cure nobody had decided to incur.
     *
     * Pinning at first issuance makes a publish what an admin already believes
     * it is: a change that affects NEW files only.
     *
     * Tri-state, deliberately:
     *   NULL → not pinned. Rows issued before this column existed. An honest
     *          gap: those files fall back to the active schedule, exactly as
     *          they behaved before. Never backfilled with a guess.
     *   0    → pinned to the compiled-in DEFAULT_PLATFORM_FEE_SCHEDULE, i.e.
     *          issued while nothing was published. Published versions start at
     *          1, so 0 can never collide with one.
     *   N>0  → pinned to platform_fee_schedules.version = N.
     */
    feeScheduleVersion: integer("fee_schedule_version"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("loan_estimate_disclosures_app_idx").on(table.applicationId, table.version),
    uniqueIndex("loan_estimate_disclosures_app_version_key").on(table.applicationId, table.version),
  ],
);

export const insertLoanEstimateDisclosureSchema = createInsertSchema(loanEstimateDisclosures)
  .omit({
    id: true,
    createdAt: true,
  })
  // Nullable and omittable: a disclosure written before pinning existed simply
  // has no pin, and that gap is honest rather than backfilled with a guess.
  .extend({
    feeScheduleVersion: z.number().int().nullable().optional(),
  });
export type InsertLoanEstimateDisclosure = z.infer<typeof insertLoanEstimateDisclosureSchema>;
export type LoanEstimateDisclosure = typeof loanEstimateDisclosures.$inferSelect;

// =============================================================================
// LOAN COST LEDGER (unit economics — cost per file, cost per funded loan)
// =============================================================================
// The platform had a revenue side (lender_submissions compensation columns)
// and no cost side at all: no cost-per-file, no vendor invoice tracking, no LO
// commission. Gross margin per loan was uncomputable, and the one recurring
// hard cost the platform actually triggers — credit pulls, which the task
// engine deliberately re-runs via CRD_EXPIRED — was unmetered.
//
// The metric that matters is not cost per LOAN but cost per FUNDED loan: costs
// are incurred on every file, revenue arrives only on the ones that close, so
// the denominator is the funded count, not the application count.
//
// One row per cost incurred against a file. Immutable — a correction is a new
// row (a reversal), never an edit, so the ledger stays auditable.
import { LOAN_COST_CATEGORIES, type LoanCostCategory } from "../statusVocabularies";
// Moved to shared/statusVocabularies.ts (table-free) so client cost reporting
// does not drag every Drizzle table into the browser bundle.
export { LOAN_COST_CATEGORIES };
export type { LoanCostCategory };

export const loanCostEntries = pgTable(
  "loan_cost_entries",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
    /** One of LOAN_COST_CATEGORIES. */
    category: varchar("category", { length: 30 }).$type<LoanCostCategory>().notNull(),
    /** Who we paid — the vendor/adapter name. */
    vendor: varchar("vendor", { length: 100 }),
    /** Dollars. Negative is permitted for an explicit reversal/refund row. */
    amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
    incurredAt: timestamp("incurred_at").defaultNow().notNull(),
    /**
     * True when the platform booked this automatically at the moment it
     * triggered the cost (e.g. a credit pull), false when staff keyed an
     * invoice. Distinguishes a metered cost from a recalled one.
     */
    automatic: boolean("automatic").notNull().default(false),
    /**
     * True while the underlying vendor leg is a deterministic simulation, so
     * simulated spend never masquerades as real spend in a margin figure.
     */
    simulated: boolean("simulated").notNull().default(false),
    description: text("description"),
    recordedBy: varchar("recorded_by").references(() => users.id),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [index("loan_cost_entries_app_idx").on(table.applicationId, table.incurredAt)],
);

export const insertLoanCostEntrySchema = createInsertSchema(loanCostEntries)
  .omit({
    id: true,
    createdAt: true,
  })
  .extend({
    category: z.enum(LOAN_COST_CATEGORIES),
  });
export type InsertLoanCostEntry = z.infer<typeof insertLoanCostEntrySchema>;
export type LoanCostEntry = typeof loanCostEntries.$inferSelect;
