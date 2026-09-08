// Loan-application status machine + core tables: loanApplications, dealTeamMembers, applicationProperties, loanOptions, documents, dealActivities.
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
import { users } from "./core";
import { COMPENSATION_MODELS, type CompensationModel } from "../compliance/loCompensation";

// The loan-application status machine moved to shared/loanApplicationStatus.ts
// so the client can import it without dragging every Drizzle table into the
// browser bundle. Re-exported here so existing importers are unaffected.
export * from "../loanApplicationStatus";

// Loan Applications
export const loanApplications = pgTable("loan_applications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  status: varchar("status", { length: 50 }).default("draft").notNull(),
  
  // Provenance of the financial figures below (income, debts, credit, value).
  // "self_reported" (default) = borrower-entered / pre-sales estimates; must NOT
  // drive a credit decision or required disclosure. Flipped to "verified" once
  // the figures are backed by documents / a credit pull. See shared/dataProvenance.ts.
  financialDataProvenance: varchar("financial_data_provenance", { length: 30 })
    .default("self_reported")
    .notNull(),
  financialDataVerifiedAt: timestamp("financial_data_verified_at"),
  financialDataVerifiedBy: varchar("financial_data_verified_by").references(() => users.id),

  // Per-dimension verification. financialDataProvenance auto-promotes to
  // "verified" only when all three are true (see server/services/verification.ts).
  incomeVerified: boolean("income_verified").default(false).notNull(),
  assetsVerified: boolean("assets_verified").default(false).notNull(),
  creditVerified: boolean("credit_verified").default(false).notNull(),

  // AUS (Automated Underwriting System) submission — Fannie Mae DU results.
  // Written by server/routes/aus.ts; findings JSON is the DU Messages payload.
  ausCasefileId: varchar("aus_casefile_id", { length: 100 }),
  ausRecommendation: varchar("aus_recommendation", { length: 50 }), // approve_eligible, approve_ineligible, refer, refer_with_caution
  ausSubmittedAt: timestamp("aus_submitted_at"),
  ausFindings: jsonb("aus_findings"),
  d1cAssetsRelief: boolean("d1c_assets_relief").default(false).notNull(),
  d1cIncomeRelief: boolean("d1c_income_relief").default(false).notNull(),
  d1cEmploymentRelief: boolean("d1c_employment_relief").default(false).notNull(),

  // Pre-underwriting validator results — written by server/services/preUnderwriting.ts
  // at intake completion and again whenever a Plaid VOA report lands.
  // Shape: { flags: PreUwFlag[], evaluatedAt, trigger, notifiedHash }
  preUwFlags: jsonb("pre_uw_flags"),

  // Borrower Information
  annualIncome: decimal("annual_income", { precision: 12, scale: 2 }),
  monthlyDebts: decimal("monthly_debts", { precision: 10, scale: 2 }),
  creditScore: integer("credit_score"),
  employmentType: varchar("employment_type", { length: 50 }),
  employmentYears: integer("employment_years"),
  employerName: varchar("employer_name", { length: 255 }),
  
  // Property Information
  propertyAddress: text("property_address"),
  propertyCity: varchar("property_city", { length: 100 }),
  propertyState: varchar("property_state", { length: 50 }),
  propertyZip: varchar("property_zip", { length: 20 }),
  propertyType: varchar("property_type", { length: 50 }),
  // Subject-property intent captured during fast intake. NULL means unanswered;
  // pricing and letters fail closed rather than inventing a primary residence.
  occupancyType: varchar("occupancy_type", { length: 50 }),
  numberOfUnits: integer("number_of_units"),
  subjectMonthlyRentalIncome: decimal("subject_monthly_rental_income", { precision: 12, scale: 2 }),
  propertyValue: decimal("property_value", { precision: 12, scale: 2 }),
  purchasePrice: decimal("purchase_price", { precision: 12, scale: 2 }),
  downPayment: decimal("down_payment", { precision: 12, scale: 2 }),
  
  // Loan Preferences
  loanPurpose: varchar("loan_purpose", { length: 50 }),
  preferredLoanType: varchar("preferred_loan_type", { length: 50 }),
  isVeteran: boolean("is_veteran").default(false),
  isFirstTimeBuyer: boolean("is_first_time_buyer").default(false),
  // UAL P7: borrower-declared answer to "Do you require financing that avoids
  // interest?" — a product-preference ROUTING signal (SituationProfile.halalNeed),
  // never an underwriting input or a faith classification. NULL = not asked.
  avoidsInterestFinancing: boolean("avoids_interest_financing"),

  // VA residual-income inputs (38 CFR 36.4340(e): family size drives the
  // regional residual table; square footage drives the $0.14/sqft utility
  // deduction). Collected by the funnel only for VA-eligible borrowers.
  householdFamilySize: integer("household_family_size"),
  homeSquareFootage: integer("home_square_footage"),
  
  // Multi-income source tracking
  incomeSources: jsonb("income_sources"),

  // URLA section 2c. NULL means the question has not been answered; FALSE is
  // an explicit borrower/staff confirmation that this application has no
  // other real estate. Keeping the third state prevents an empty REO table
  // from being misread as a completed disclosure during lender-readiness
  // checks.
  ownsOtherRealEstate: boolean("owns_other_real_estate"),

  // S-07 (Fannie B3-3.8-01 / B3-6-06): what happens to the borrower's current
  // primary residence on this purchase. "converted_to_rental" activates the
  // departing-residence rental offset using departingResidence figures.
  // NULL = not asked / not applicable (e.g. first-time buyer, renter).
  currentPropertyDisposition: varchar("current_property_disposition", { length: 30 }),
  // { address?, estimatedMarketRent, monthlyPitia } for the departing
  // residence when it converts to a rental (departingResidenceSchema —
  // projected rent, so the offset always carries manual review until the
  // rental appraisal/lease evidence is verified).
  departingResidence: jsonb("departing_residence"),
  
  // Calculated Values (populated by AI analysis)
  dtiRatio: decimal("dti_ratio", { precision: 5, scale: 2 }),
  ltvRatio: decimal("ltv_ratio", { precision: 5, scale: 2 }),
  preApprovalAmount: decimal("pre_approval_amount", { precision: 12, scale: 2 }),
  
  // AI Analysis
  aiAnalysis: jsonb("ai_analysis"),
  aiAnalyzedAt: timestamp("ai_analyzed_at"),
  
  // Broker reference
  referringBrokerId: varchar("referring_broker_id").references(() => users.id),

  // Assigned loan officer. Drives LO/LOA object-level access to the file
  // (see access checks in borrower.ts / task-engine.ts / agent-broker.ts).
  loanOfficerId: varchar("loan_officer_id").references(() => users.id),

  // Amortization / ARM terms (Section 4 / ULDD)
  amortizationType: varchar("amortization_type", { length: 30 }), // fixed | adjustable
  armIndexType: varchar("arm_index_type", { length: 50 }),
  armMargin: decimal("arm_margin", { precision: 6, scale: 3 }),
  armInitialRate: decimal("arm_initial_rate", { precision: 6, scale: 3 }),
  armInitialCap: decimal("arm_initial_cap", { precision: 6, scale: 3 }),
  armPeriodicCap: decimal("arm_periodic_cap", { precision: 6, scale: 3 }),
  armLifetimeCap: decimal("arm_lifetime_cap", { precision: 6, scale: 3 }),
  armAdjustmentFrequencyMonths: integer("arm_adjustment_frequency_months"),

  // ATR/QM points and fees (Reg Z 1026.43). Authoritative closing-side figure;
  // absent pre-closing, which is why the pre-delivery check falls back to the
  // computed floor in shared/compliance/loCompensation.ts.
  totalPointsAndFees: decimal("total_points_and_fees", { precision: 12, scale: 2 }),

  // Loan-originator compensation elected for THIS transaction (Reg Z
  // 1026.36(d)(2)). Both columns are nullable in the database because existing
  // rows predate them, but the fee schedule and the Loan Estimate fail closed
  // when either is missing — a guessed model is the dual-compensation error
  // itself. Vocabulary: shared/compliance/loCompensation.ts COMPENSATION_MODELS.
  loCompensationModel: varchar("lo_compensation_model", { length: 20 }).$type<CompensationModel>(),
  loCompensationBps: integer("lo_compensation_bps"),

  // HMDA LAR action taken / denial reasons (Reg C)
  hmdaActionTaken: varchar("hmda_action_taken", { length: 30 }),
  hmdaDenialReasons: text("hmda_denial_reasons").array(),

  // TRID disclosure tracking (Reg Z)
  closingDate: varchar("closing_date", { length: 10 }),
  leIssuedDate: varchar("le_issued_date", { length: 10 }),
  cdIssuedDate: varchar("cd_issued_date", { length: 10 }),
  // Set the moment the 6th piece of application information (Reg Z
  // §1026.2(a)(3): name, income, SSN, property address, estimated value,
  // loan amount) is on file — this timestamp anchors the 3-business-day
  // Loan Estimate clock. Written only by server/services/trid.ts.
  tridTriggeredAt: timestamp("trid_triggered_at"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_loan_applications_user").on(table.userId),
  index("idx_loan_applications_status").on(table.status),
  index("idx_loan_applications_created").on(table.createdAt),
  index("idx_loan_applications_broker").on(table.referringBrokerId),
  index("idx_loan_applications_lo").on(table.loanOfficerId),
  index("idx_loan_applications_user_status").on(table.userId, table.status),
]);

/** S-07: what happens to the borrower's current primary residence. */
export const CURRENT_PROPERTY_DISPOSITIONS = [
  "retained_as_primary",
  "sold",
  "converted_to_rental",
] as const;
export type CurrentPropertyDisposition = (typeof CURRENT_PROPERTY_DISPOSITIONS)[number];

/** Departing-residence figures for a "converted_to_rental" disposition
 *  (S-07, B3-3.8-01): projected market rent + the retained property's PITIA.
 *  Projected — the offset stays manual-review until appraisal/lease evidence
 *  verifies it. */
export const departingResidenceSchema = z.object({
  address: z.string().max(500).optional(),
  estimatedMarketRent: z.coerce.number().positive(),
  monthlyPitia: z.coerce.number().min(0),
});
export type DepartingResidence = z.infer<typeof departingResidenceSchema>;

// PREFERRED_LOAN_TYPES / AMORTIZATION_TYPES moved to shared/statusVocabularies.ts
// (table-free) so client imports do not drag every Drizzle table into the bundle.
import { AMORTIZATION_TYPES, PREFERRED_LOAN_TYPES } from "../statusVocabularies";
export { AMORTIZATION_TYPES, PREFERRED_LOAN_TYPES };
export type { AmortizationType, PreferredLoanType } from "../statusVocabularies";

/**
 * URLA Section 4a save body (WF2-F4). Both fields are required together: no
 * HTTP surface wrote either loan_applications column, so section-4 gating
 * (server/services/mismoValidation.ts) was unsatisfiable for every
 * product-created file — and accepting one field alone would recreate that
 * half-set state. The borrower states section 4; the server validates it —
 * never silently defaults it.
 */
export const urlaLoanDetailsSchema = z.object({
  preferredLoanType: z.enum(PREFERRED_LOAN_TYPES),
  amortizationType: z.enum(AMORTIZATION_TYPES),
});
export type UrlaLoanDetails = z.infer<typeof urlaLoanDetailsSchema>;

export const insertLoanApplicationSchema = createInsertSchema(loanApplications)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    currentPropertyDisposition: z.enum(CURRENT_PROPERTY_DISPOSITIONS).nullish(),
    departingResidence: departingResidenceSchema.nullish(),
    loCompensationModel: z.enum(COMPENSATION_MODELS).nullish(),
  });

export type InsertLoanApplication = z.infer<typeof insertLoanApplicationSchema>;
export type LoanApplication = typeof loanApplications.$inferSelect;

// Deal Team Members - tracks all professionals working on a loan application
export const dealTeamRoles = [
  "loan_officer",
  "loan_processor", 
  "underwriter",
  "closer",
  "real_estate_agent",
  "title_agent",
  "appraiser",
  "insurance_agent",
  "attorney",
  "escrow_officer",
] as const;

export const dealTeamRoleLabels: Record<typeof dealTeamRoles[number], string> = {
  loan_officer: "Loan Officer",
  loan_processor: "Loan Processor",
  underwriter: "Underwriter",
  closer: "Closer/Funder",
  real_estate_agent: "Real Estate Agent",
  title_agent: "Title Agent",
  appraiser: "Appraiser",
  insurance_agent: "Insurance Agent",
  attorney: "Attorney",
  escrow_officer: "Escrow Officer",
};

export const dealTeamMembers = pgTable("deal_team_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  
  userId: varchar("user_id").references(() => users.id),
  
  teamRole: varchar("team_role", { length: 50 }).notNull(),
  
  externalName: varchar("external_name", { length: 255 }),
  externalEmail: varchar("external_email", { length: 255 }),
  externalPhone: varchar("external_phone", { length: 50 }),
  externalCompany: varchar("external_company", { length: 255 }),
  
  isPrimary: boolean("is_primary").default(false),
  isActive: boolean("is_active").default(true).notNull(),
  
  assignedBy: varchar("assigned_by").references(() => users.id),
  assignedAt: timestamp("assigned_at").defaultNow(),
  
  notes: text("notes"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_deal_team_application").on(table.applicationId),
  index("idx_deal_team_user").on(table.userId),
  index("idx_deal_team_role").on(table.teamRole),
]);

export const insertDealTeamMemberSchema = createInsertSchema(dealTeamMembers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDealTeamMember = z.infer<typeof insertDealTeamMemberSchema>;
export type DealTeamMember = typeof dealTeamMembers.$inferSelect;

// Application Properties - supports multiple properties per application
export const applicationProperties = pgTable("application_properties", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  
  address: text("address").notNull(),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 50 }),
  zipCode: varchar("zip_code", { length: 20 }),
  propertyType: varchar("property_type", { length: 50 }),
  
  purchasePrice: decimal("purchase_price", { precision: 12, scale: 2 }).notNull(),
  downPayment: decimal("down_payment", { precision: 12, scale: 2 }),
  
  status: varchar("status", { length: 50 }).default("active").notNull(),
  isCurrentProperty: boolean("is_current_property").default(true).notNull(),
  
  offerAmount: decimal("offer_amount", { precision: 12, scale: 2 }),
  offerDate: timestamp("offer_date"),
  offerStatus: varchar("offer_status", { length: 50 }),
  
  notes: text("notes"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
});

export const insertApplicationPropertySchema = createInsertSchema(applicationProperties).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertApplicationProperty = z.infer<typeof insertApplicationPropertySchema>;
export type ApplicationProperty = typeof applicationProperties.$inferSelect;

// Loan Options (generated scenarios)
export const loanOptions = pgTable("loan_options", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  
  loanType: varchar("loan_type", { length: 50 }).notNull(),
  loanTerm: integer("loan_term").notNull(),
  
  interestRate: decimal("interest_rate", { precision: 5, scale: 3 }).notNull(),
  apr: decimal("apr", { precision: 5, scale: 3 }).notNull(),
  
  points: decimal("points", { precision: 5, scale: 3 }).default("0"),
  pointsCost: decimal("points_cost", { precision: 10, scale: 2 }).default("0"),
  
  monthlyPayment: decimal("monthly_payment", { precision: 10, scale: 2 }).notNull(),
  principalAndInterest: decimal("principal_and_interest", { precision: 10, scale: 2 }).notNull(),
  propertyTax: decimal("property_tax", { precision: 10, scale: 2 }),
  homeInsurance: decimal("home_insurance", { precision: 10, scale: 2 }),
  pmi: decimal("pmi", { precision: 10, scale: 2 }),
  hoaFees: decimal("hoa_fees", { precision: 10, scale: 2 }),
  
  loanAmount: decimal("loan_amount", { precision: 12, scale: 2 }).notNull(),
  closingCosts: decimal("closing_costs", { precision: 10, scale: 2 }),
  cashToClose: decimal("cash_to_close", { precision: 12, scale: 2 }),
  totalInterestPaid: decimal("total_interest_paid", { precision: 12, scale: 2 }),
  
  downPaymentAmount: decimal("down_payment_amount", { precision: 12, scale: 2 }),
  downPaymentPercent: decimal("down_payment_percent", { precision: 5, scale: 2 }),
  
  isRecommended: boolean("is_recommended").default(false),
  isLocked: boolean("is_locked").default(false),
  lockedAt: timestamp("locked_at"),
  lockExpiresAt: timestamp("lock_expires_at"),

  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_loan_options_application").on(table.applicationId),
]);

export const insertLoanOptionSchema = createInsertSchema(loanOptions).omit({
  id: true,
  createdAt: true,
});

export type InsertLoanOption = z.infer<typeof insertLoanOptionSchema>;
export type LoanOption = typeof loanOptions.$inferSelect;

// Documents
export const documents = pgTable("documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id),
  userId: varchar("user_id").references(() => users.id).notNull(),
  
  documentType: varchar("document_type", { length: 50 }).notNull(),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  fileSize: integer("file_size"),
  mimeType: varchar("mime_type", { length: 100 }),
  storagePath: text("storage_path").notNull(),
  
  status: varchar("status", { length: 50 }).default("uploaded"),

  // SERVER-WRITTEN AI-extraction lineage ONLY (JSON: extractedAt,
  // extractedFields, confidence, warnings, modelId, promptVersion,
  // responseHash). Consumers are entitled to treat this as trusted machine
  // output, which is exactly why nothing borrower-controlled may be written
  // here — see borrowerDescription below and migration 0046 (finding F-027).
  notes: text("notes"),

  // Borrower-authored free text from the upload dialog ("What is it?").
  // UNTRUSTED INPUT — never parse as extraction output, never promote to a
  // provenance/trust tier. Split out of `notes` by migration 0046 after a
  // borrower-supplied string in `notes` was parsed as document-verified
  // extraction by borrowerGraph and Homi (F-027).
  borrowerDescription: text("borrower_description"),

  // Human review decision (POST /api/documents/:id/verify — the only writer).
  // rejectionReason is borrower-visible copy explaining what to re-upload;
  // `notes` stays reserved for AI-extraction lineage — never overload it.
  // Naming mirrors loanConditions.clearedByUserId/clearedAt.
  rejectionReason: text("rejection_reason"),
  reviewedByUserId: varchar("reviewed_by_user_id").references(() => users.id),
  reviewedAt: timestamp("reviewed_at"),

  // AI-extraction lineage (mirrors the credit-pull vendor-response pattern):
  // a SHA-256 of the raw model output, and that raw output encrypted at rest
  // (it can carry PII). Lets an auditor confirm the stored fields came from a
  // specific model response, and re-examine it for drift/dispute review.
  extractionResponseHash: varchar("extraction_response_hash", { length: 64 }),
  extractionRawEncrypted: text("extraction_raw_encrypted"),
  extractionRawIv: varchar("extraction_raw_iv", { length: 32 }),
  extractionRawKeyId: varchar("extraction_raw_key_id", { length: 20 }),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_documents_application").on(table.applicationId),
  index("idx_documents_user").on(table.userId),
  index("idx_documents_status").on(table.status),
  index("idx_documents_user_status").on(table.userId, table.status),
]);

export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documents.$inferSelect;

// Deal Activities (for tracking loan progress)
export const dealActivities = pgTable("deal_activities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  
  activityType: varchar("activity_type", { length: 50 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  metadata: jsonb("metadata"),
  
  performedBy: varchar("performed_by").references(() => users.id),
  visibleToRoles: text("visible_to_roles").array(),
  
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_deal_activities_application").on(table.applicationId),
  index("idx_deal_activities_created").on(table.createdAt),
]);

export const insertDealActivitySchema = createInsertSchema(dealActivities).omit({
  id: true,
  createdAt: true,
});

export type InsertDealActivity = z.infer<typeof insertDealActivitySchema>;
export type DealActivity = typeof dealActivities.$inferSelect;

// URLA Personal Information (Section 1a)
