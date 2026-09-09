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

// ============================================================================
// BORROWER PROFILES (Normalized identity/residency/household)
// Fills gaps: citizenship, marital status, dependents, co-borrower linkage,
// housing payment history, language preference, military details
// ============================================================================

export const CITIZENSHIP_TYPES = [
  "us_citizen",
  "permanent_resident",
  "non_permanent_resident",
  "foreign_national",
  "undisclosed",
] as const;

export const MARITAL_STATUS_TYPES = [
  "married",
  "unmarried",
  "separated",
  "divorced",
  "widowed",
  "undisclosed",
] as const;

export const HOUSING_STATUS_TYPES = [
  "rent",
  "own",
  "living_rent_free",
  "other",
] as const;

export const MILITARY_STATUS_TYPES = [
  "active_duty",
  "veteran",
  "reserve_national_guard",
  "surviving_spouse",
  "none",
  "undisclosed",
] as const;

export const borrowerProfiles = pgTable("borrower_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull().unique(),

  citizenshipStatus: varchar("citizenship_status", { length: 50 }),
  visaType: varchar("visa_type", { length: 50 }),
  visaExpirationDate: varchar("visa_expiration_date", { length: 10 }),

  maritalStatus: varchar("marital_status", { length: 30 }),
  numberOfDependents: integer("number_of_dependents"),
  dependentAges: text("dependent_ages"),

  dateOfBirth: varchar("date_of_birth", { length: 10 }),
  languagePreference: varchar("language_preference", { length: 20 }).default("en"),

  currentHousingStatus: varchar("current_housing_status", { length: 30 }),
  currentMonthlyHousingPayment: decimal("current_monthly_housing_payment", { precision: 10, scale: 2 }),
  currentAddressMonths: integer("current_address_months"),
  previousAddressCount: integer("previous_address_count"),

  militaryStatus: varchar("military_status", { length: 50 }),
  militaryBranch: varchar("military_branch", { length: 50 }),
  militaryServiceStart: varchar("military_service_start", { length: 10 }),
  militaryServiceEnd: varchar("military_service_end", { length: 10 }),
  vaEntitlementUsed: boolean("va_entitlement_used").default(false),
  vaFundingFeeExempt: boolean("va_funding_fee_exempt").default(false),

  hasCoBorrower: boolean("has_co_borrower").default(false),
  coBorrowerUserId: varchar("co_borrower_user_id").references(() => users.id),
  coBorrowerRelationship: varchar("co_borrower_relationship", { length: 50 }),

  hasRealEstateOwned: boolean("has_real_estate_owned").default(false),
  realEstateOwnedCount: integer("real_estate_owned_count").default(0),

  hasForeclosureHistory: boolean("has_foreclosure_history").default(false),
  hasBankruptcyHistory: boolean("has_bankruptcy_history").default(false),
  foreclosureDischargeDate: varchar("foreclosure_discharge_date", { length: 10 }),
  bankruptcyDischargeDate: varchar("bankruptcy_discharge_date", { length: 10 }),

  selfReportedCreditScore: integer("self_reported_credit_score"),
  selfReportedAnnualIncome: decimal("self_reported_annual_income", { precision: 14, scale: 2 }),
  selfReportedTotalAssets: decimal("self_reported_total_assets", { precision: 14, scale: 2 }),
  selfReportedTotalDebts: decimal("self_reported_total_debts", { precision: 10, scale: 2 }),

  riskTolerance: varchar("risk_tolerance", { length: 20 }),
  communicationPreference: varchar("communication_preference", { length: 20 }),
  timezoneName: varchar("timezone_name", { length: 50 }),

  analyticsConsentGiven: boolean("analytics_consent_given").default(false),
  analyticsConsentDate: timestamp("analytics_consent_date"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_borrower_profiles_user").on(table.userId),
  index("idx_borrower_profiles_citizenship").on(table.citizenshipStatus),
  index("idx_borrower_profiles_military").on(table.militaryStatus),
]);

export const insertBorrowerProfileSchema = createInsertSchema(borrowerProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBorrowerProfile = z.infer<typeof insertBorrowerProfileSchema>;
export type BorrowerProfile = typeof borrowerProfiles.$inferSelect;

// ============================================================================
// REAL ESTATE OWNED (REO) - Properties currently owned by borrower
// Critical for DTI (existing mortgages), reserves, and rental income offset
// ============================================================================

export const realEstateOwned = pgTable("real_estate_owned", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id),

  propertyAddress: text("property_address").notNull(),
  propertyCity: varchar("property_city", { length: 100 }),
  propertyState: varchar("property_state", { length: 50 }),
  propertyZip: varchar("property_zip", { length: 20 }),
  propertyType: varchar("property_type", { length: 50 }),

  marketValue: decimal("market_value", { precision: 14, scale: 2 }),
  mortgageBalance: decimal("mortgage_balance", { precision: 14, scale: 2 }),
  mortgagePayment: decimal("mortgage_payment", { precision: 10, scale: 2 }),
  monthlyRentalIncome: decimal("monthly_rental_income", { precision: 10, scale: 2 }),
  monthlyInsurance: decimal("monthly_insurance", { precision: 10, scale: 2 }),
  monthlyTaxes: decimal("monthly_taxes", { precision: 10, scale: 2 }),
  monthlyHoa: decimal("monthly_hoa", { precision: 10, scale: 2 }),

  occupancyType: varchar("occupancy_type", { length: 50 }),
  status: varchar("status", { length: 50 }).default("retained"),
  willBeSold: boolean("will_be_sold").default(false),
  willBeRented: boolean("will_be_rented").default(false),

  netEquity: decimal("net_equity", { precision: 14, scale: 2 }),
  netRentalIncome: decimal("net_rental_income", { precision: 10, scale: 2 }),

  verificationSource: varchar("verification_source", { length: 50 }),
  verifiedAt: timestamp("verified_at"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_reo_user").on(table.userId),
  index("idx_reo_application").on(table.applicationId),
]);

export const insertRealEstateOwnedSchema = createInsertSchema(realEstateOwned).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertRealEstateOwned = z.infer<typeof insertRealEstateOwnedSchema>;
export type RealEstateOwned = typeof realEstateOwned.$inferSelect;

// ============================================================================
// LENDER PRODUCTS (Eligibility constraints for matching)
// Enables automated lender-borrower matching against BorrowerGraph signals
// ============================================================================

export const lenderProducts = pgTable("lender_products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  lenderId: varchar("lender_id", { length: 100 }).notNull(),
  lenderName: varchar("lender_name", { length: 255 }).notNull(),
  productName: varchar("product_name", { length: 255 }).notNull(),
  productCode: varchar("product_code", { length: 50 }),

  productType: varchar("product_type", { length: 50 }).notNull(),
  loanPurposes: text("loan_purposes").array(),
  occupancyTypes: text("occupancy_types").array(),
  propertyTypes: text("property_types").array(),
  allowedStates: text("allowed_states").array(),
  excludedStates: text("excluded_states").array(),

  minCreditScore: integer("min_credit_score"),
  maxDti: decimal("max_dti", { precision: 5, scale: 2 }),
  maxLtv: decimal("max_ltv", { precision: 5, scale: 2 }),
  maxCltv: decimal("max_cltv", { precision: 5, scale: 2 }),

  minLoanAmount: decimal("min_loan_amount", { precision: 14, scale: 2 }),
  maxLoanAmount: decimal("max_loan_amount", { precision: 14, scale: 2 }),

  minDownPaymentPercent: decimal("min_down_payment_percent", { precision: 5, scale: 2 }),
  minReserveMonths: integer("min_reserve_months"),

  allowsSelfEmployed: boolean("allows_self_employed").default(true),
  allowsNonPermanentResident: boolean("allows_non_permanent_resident").default(false),
  allowsForeignNational: boolean("allows_foreign_national").default(false),
  requiresEscrow: boolean("requires_escrow").default(true),
  allowsGiftFunds: boolean("allows_gift_funds").default(true),
  allowsInterestOnly: boolean("allows_interest_only").default(false),

  selfEmploymentMinMonths: integer("self_employment_min_months").default(24),
  bankruptcySeasoningMonths: integer("bankruptcy_seasoning_months"),
  foreclosureSeasoningMonths: integer("foreclosure_seasoning_months"),

  pmiRequired: boolean("pmi_required").default(false),
  pmiThresholdLtv: decimal("pmi_threshold_ltv", { precision: 5, scale: 2 }),

  baseRate: decimal("base_rate", { precision: 5, scale: 3 }),
  rateAdjustments: jsonb("rate_adjustments"),
  closingCostRange: jsonb("closing_cost_range"),

  specialPrograms: text("special_programs").array(),
  firstTimeBuyerOnly: boolean("first_time_buyer_only").default(false),
  veteranOnly: boolean("veteran_only").default(false),

  isActive: boolean("is_active").default(true),
  effectiveDate: timestamp("effective_date"),
  expirationDate: timestamp("expiration_date"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_lender_products_lender").on(table.lenderId),
  index("idx_lender_products_type").on(table.productType),
  index("idx_lender_products_active").on(table.isActive),
  index("idx_lender_products_credit").on(table.minCreditScore),
]);

export const insertLenderProductSchema = createInsertSchema(lenderProducts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLenderProduct = z.infer<typeof insertLenderProductSchema>;
export type LenderProduct = typeof lenderProducts.$inferSelect;

// ============================================================================
// BORROWER STATE MACHINE (Lifecycle tracking with transition history)
// Tracks the borrower through their entire journey from lead to homeowner
// ============================================================================

export const BORROWER_STATES = [
  "lead",
  "exploring",
  "profiling",
  "pre_qualification",
  "pre_approval",
  "property_search",
  "in_contract",
  "underwriting",
  "conditional_approval",
  "clear_to_close",
  "closing",
  "funded",
  "homeowner",
  "withdrawn",
  "denied",
  "expired",
] as const;

export type BorrowerState = typeof BORROWER_STATES[number];

export const TRANSITION_TRIGGERS = [
  "account_created",
  "goal_set",
  "profile_completed",
  "application_started",
  "application_submitted",
  "documents_uploaded",
  "credit_pulled",
  "pre_qual_issued",
  "pre_approval_issued",
  "property_selected",
  "offer_accepted",
  "underwriting_submitted",
  "conditions_cleared",
  "clear_to_close_issued",
  "closing_scheduled",
  "funded",
  "borrower_withdrew",
  "application_denied",
  "application_expired",
  "manual_override",
] as const;

export type TransitionTrigger = typeof TRANSITION_TRIGGERS[number];

export const borrowerStateHistory = pgTable("borrower_state_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id),

  fromState: varchar("from_state", { length: 50 }),
  toState: varchar("to_state", { length: 50 }).notNull(),

  trigger: varchar("trigger", { length: 50 }).notNull(),
  triggerMetadata: jsonb("trigger_metadata"),

  triggeredByUserId: varchar("triggered_by_user_id").references(() => users.id),
  triggeredBySystem: boolean("triggered_by_system").default(false),

  durationInPreviousStateMinutes: integer("duration_in_previous_state_minutes"),

  transitionedAt: timestamp("transitioned_at").defaultNow().notNull(),
}, (table) => [
  index("idx_state_history_user").on(table.userId),
  index("idx_state_history_app").on(table.applicationId),
  index("idx_state_history_to_state").on(table.toState),
  index("idx_state_history_trigger").on(table.trigger),
  index("idx_state_history_time").on(table.transitionedAt),
]);

export const insertBorrowerStateHistorySchema = createInsertSchema(borrowerStateHistory).omit({
  id: true,
});

export type InsertBorrowerStateHistory = z.infer<typeof insertBorrowerStateHistorySchema>;
export type BorrowerStateHistory = typeof borrowerStateHistory.$inferSelect;

// ============================================================================
// READINESS CHECKLIST (Per-field readiness tracking with verification tiers)
// Tracks which data points are collected, verified, and at what trust level
// ============================================================================

export const READINESS_CATEGORIES = [
  "identity",
  "income",
  "assets",
  "liabilities",
  "credit",
  "employment",
  "property",
  "declarations",
  "demographics",
  "documents",
  "consent",
] as const;

export type ReadinessCategory = typeof READINESS_CATEGORIES[number];

export const FIELD_VERIFICATION_STATUS = [
  "not_collected",
  "self_reported",
  "application_stated",
  "document_extracted",
  "third_party_verified",
  "manually_verified",
] as const;

export type FieldVerificationStatus = typeof FIELD_VERIFICATION_STATUS[number];

export const readinessChecklist = pgTable("readiness_checklist", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id),

  category: varchar("category", { length: 50 }).notNull(),
  fieldName: varchar("field_name", { length: 100 }).notNull(),
  fieldLabel: varchar("field_label", { length: 255 }).notNull(),

  isRequired: boolean("is_required").default(true),
  isCollected: boolean("is_collected").default(false),
  verificationStatus: varchar("verification_status", { length: 50 }).default("not_collected"),
  trustTier: varchar("trust_tier", { length: 10 }),

  sourceTable: varchar("source_table", { length: 100 }),
  sourceField: varchar("source_field", { length: 100 }),
  sourceRecordId: varchar("source_record_id", { length: 100 }),

  collectedAt: timestamp("collected_at"),
  verifiedAt: timestamp("verified_at"),
  expiresAt: timestamp("expires_at"),

  weight: decimal("weight", { precision: 5, scale: 2 }).default("1.00"),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_readiness_user").on(table.userId),
  index("idx_readiness_app").on(table.applicationId),
  index("idx_readiness_category").on(table.category),
  index("idx_readiness_collected").on(table.isCollected),
  uniqueIndex("idx_readiness_user_field").on(table.userId, table.fieldName),
]);

export const insertReadinessChecklistSchema = createInsertSchema(readinessChecklist).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReadinessChecklist = z.infer<typeof insertReadinessChecklistSchema>;
export type ReadinessChecklist = typeof readinessChecklist.$inferSelect;

// ============================================================================
// INTENT EVENTS (Behavioral funnel tracking for predictive signals)
// Tracks high-value actions that predict conversion and readiness
// ============================================================================

export const INTENT_EVENT_TYPES = [
  "page_view",
  "calculator_use",
  "rate_quote_view",
  "property_search",
  "property_view",
  "property_save",
  "property_affordability_check",
  "pre_approval_start",
  "pre_approval_complete",
  "pre_qual_start",
  "pre_qual_complete",
  "document_upload_start",
  "document_upload_complete",
  "document_upload_abandon",
  "coach_session_start",
  "coach_session_complete",
  "coach_question_asked",
  "cta_click",
  "form_field_focus",
  "form_field_abandon",
  "lender_comparison_view",
  "loan_option_view",
  "loan_option_select",
  "letter_download",
  "letter_share",
  "referral_link_click",
  "savings_deposit",
  "credit_action_complete",
  "consent_given",
  "milestone_achieved",
  "return_visit",
  "session_start",
  "session_end",
  // Server-observed friction: a user hit a wall (blocked gate, failed upload,
  // rate limit). Category is always "friction"; targetLabel names the wall.
  // The daily guardian aggregates these to propose scenario/UX improvements.
  "friction_event",
] as const;

export type IntentEventType = typeof INTENT_EVENT_TYPES[number];

export const intentEvents = pgTable("intent_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id),
  sessionId: varchar("session_id", { length: 100 }),

  eventType: varchar("event_type", { length: 50 }).notNull(),
  eventCategory: varchar("event_category", { length: 50 }),

  targetType: varchar("target_type", { length: 50 }),
  targetId: varchar("target_id", { length: 255 }),
  targetLabel: varchar("target_label", { length: 255 }),

  metadata: jsonb("metadata"),

  pagePath: varchar("page_path", { length: 500 }),
  referrerPath: varchar("referrer_path", { length: 500 }),

  deviceType: varchar("device_type", { length: 20 }),
  durationMs: integer("duration_ms"),

  geoState: varchar("geo_state", { length: 50 }),
  geoMetro: varchar("geo_metro", { length: 100 }),

  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (table) => [
  index("idx_intent_events_user").on(table.userId),
  index("idx_intent_events_type").on(table.eventType),
  index("idx_intent_events_time").on(table.occurredAt),
  index("idx_intent_events_session").on(table.sessionId),
  index("idx_intent_events_user_type").on(table.userId, table.eventType),
]);

export const insertIntentEventSchema = createInsertSchema(intentEvents).omit({
  id: true,
});

export type InsertIntentEvent = z.infer<typeof insertIntentEventSchema>;
export type IntentEvent = typeof intentEvents.$inferSelect;

// ============================================================================
// LENDER MATCH RESULTS (Cached borrower-to-lender matching output)
// Stores the result of matching a borrower's profile against lender products
// ============================================================================

export const MATCH_STATUS = [
  "eligible",
  "conditionally_eligible",
  "ineligible",
  "needs_review",
] as const;

export type MatchStatus = typeof MATCH_STATUS[number];

export const lenderMatchResults = pgTable("lender_match_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").references(() => users.id).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id),
  lenderProductId: varchar("lender_product_id").references(() => lenderProducts.id).notNull(),

  matchStatus: varchar("match_status", { length: 30 }).notNull(),
  matchScore: decimal("match_score", { precision: 5, scale: 2 }),

  eligibilityDetails: jsonb("eligibility_details"),
  disqualifyingFactors: jsonb("disqualifying_factors"),
  conditionalFactors: jsonb("conditional_factors"),

  estimatedRate: decimal("estimated_rate", { precision: 5, scale: 3 }),
  estimatedMonthlyPayment: decimal("estimated_monthly_payment", { precision: 10, scale: 2 }),
  estimatedClosingCosts: decimal("estimated_closing_costs", { precision: 10, scale: 2 }),

  borrowerSnapshotHash: varchar("borrower_snapshot_hash", { length: 64 }),

  matchedAt: timestamp("matched_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("idx_lender_match_user").on(table.userId),
  index("idx_lender_match_app").on(table.applicationId),
  index("idx_lender_match_product").on(table.lenderProductId),
  index("idx_lender_match_status").on(table.matchStatus),
  index("idx_lender_match_score").on(table.matchScore),
]);

export const insertLenderMatchResultSchema = createInsertSchema(lenderMatchResults).omit({
  id: true,
});

export type InsertLenderMatchResult = z.infer<typeof insertLenderMatchResultSchema>;
export type LenderMatchResult = typeof lenderMatchResults.$inferSelect;

// ============================================================================
// ANONYMIZED INSIGHTS (P2 - Future data monetization foundation)
// Cohort-based aggregates with privacy-preserving tags
// ============================================================================

export const anonymizedBorrowerFacts = pgTable("anonymized_borrower_facts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  cohortDate: timestamp("cohort_date").notNull(),
  geoStateBucket: varchar("geo_state_bucket", { length: 50 }),
  geoMetroBucket: varchar("geo_metro_bucket", { length: 100 }),

  creditScoreBucket: varchar("credit_score_bucket", { length: 20 }),
  incomeBucket: varchar("income_bucket", { length: 20 }),
  ageBucket: varchar("age_bucket", { length: 20 }),
  loanPurpose: varchar("loan_purpose", { length: 50 }),
  productType: varchar("product_type", { length: 50 }),
  propertyType: varchar("property_type", { length: 50 }),

  avgDti: decimal("avg_dti", { precision: 5, scale: 2 }),
  avgLtv: decimal("avg_ltv", { precision: 5, scale: 2 }),
  avgLoanAmount: decimal("avg_loan_amount", { precision: 14, scale: 2 }),
  avgDownPaymentPercent: decimal("avg_down_payment_percent", { precision: 5, scale: 2 }),
  medianCreditScore: integer("median_credit_score"),
  medianIncome: decimal("median_income", { precision: 14, scale: 2 }),

  avgTimeToPreApprovalDays: decimal("avg_time_to_pre_approval_days", { precision: 5, scale: 1 }),
  avgTimeToCloseDays: decimal("avg_time_to_close_days", { precision: 5, scale: 1 }),
  conversionRate: decimal("conversion_rate", { precision: 5, scale: 4 }),
  falloutRate: decimal("fallout_rate", { precision: 5, scale: 4 }),
  falloutReasons: jsonb("fallout_reasons"),

  borrowerCount: integer("borrower_count").notNull(),

  readinessDistribution: jsonb("readiness_distribution"),
  topBarriers: jsonb("top_barriers"),
  topLoanTypes: jsonb("top_loan_types"),

  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_anon_facts_date").on(table.cohortDate),
  index("idx_anon_facts_geo").on(table.geoStateBucket),
  index("idx_anon_facts_credit").on(table.creditScoreBucket),
  index("idx_anon_facts_purpose").on(table.loanPurpose),
]);

export const insertAnonymizedBorrowerFactSchema = createInsertSchema(anonymizedBorrowerFacts).omit({
  id: true,
  createdAt: true,
});

export type InsertAnonymizedBorrowerFact = z.infer<typeof insertAnonymizedBorrowerFactSchema>;
export type AnonymizedBorrowerFact = typeof anonymizedBorrowerFacts.$inferSelect;

// ============================================================================
// ANALYTICS EVENTS (Structured platform-wide event pipeline)
// Captures every meaningful action across the platform for intelligence
// ============================================================================

export const ANALYTICS_DOMAINS = [
  "underwriting",
  "document",
  "compliance",
  "pipeline",
  "borrower",
  "staff",
  "pricing",
  "property",
  "system",
] as const;

export type AnalyticsDomain = typeof ANALYTICS_DOMAINS[number];

export const analyticsEvents = pgTable("analytics_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  domain: varchar("domain", { length: 30 }).notNull(),
  eventName: varchar("event_name", { length: 100 }).notNull(),

  applicationId: varchar("application_id").references(() => loanApplications.id),
  userId: varchar("user_id").references(() => users.id),
  actorId: varchar("actor_id").references(() => users.id),
  actorRole: varchar("actor_role", { length: 30 }),

  entityType: varchar("entity_type", { length: 50 }),
  entityId: varchar("entity_id", { length: 255 }),

  payload: jsonb("payload"),
  numericValue: decimal("numeric_value", { precision: 14, scale: 4 }),
  textValue: varchar("text_value", { length: 500 }),

  previousValue: jsonb("previous_value"),
  newValue: jsonb("new_value"),

  source: varchar("source", { length: 30 }).default("system"),
  automationTriggered: boolean("automation_triggered").default(false),

  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (table) => [
  index("idx_analytics_domain").on(table.domain),
  index("idx_analytics_event_name").on(table.eventName),
  index("idx_analytics_app").on(table.applicationId),
  index("idx_analytics_user").on(table.userId),
  index("idx_analytics_time").on(table.occurredAt),
  index("idx_analytics_domain_event").on(table.domain, table.eventName),
  index("idx_analytics_entity").on(table.entityType, table.entityId),
]);

export const insertAnalyticsEventSchema = createInsertSchema(analyticsEvents).omit({
  id: true,
});

export type InsertAnalyticsEvent = z.infer<typeof insertAnalyticsEventSchema>;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;

// ============================================================================
// LOAN OUTCOME TRACKING (Closed-loop feedback for rule refinement)
// Links decisions to outcomes to measure accuracy and improve over time
// ============================================================================

export const loanOutcomes = pgTable("loan_outcomes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull().unique(),

  preApprovalAmount: decimal("pre_approval_amount", { precision: 14, scale: 2 }),
  finalLoanAmount: decimal("final_loan_amount", { precision: 14, scale: 2 }),
  amountAccuracyPct: decimal("amount_accuracy_pct", { precision: 5, scale: 2 }),

  estimatedRate: decimal("estimated_rate", { precision: 5, scale: 3 }),
  finalRate: decimal("final_rate", { precision: 5, scale: 3 }),
  rateAccuracyBps: decimal("rate_accuracy_bps", { precision: 6, scale: 2 }),

  estimatedClosingCosts: decimal("estimated_closing_costs", { precision: 10, scale: 2 }),
  actualClosingCosts: decimal("actual_closing_costs", { precision: 10, scale: 2 }),

  estimatedDti: decimal("estimated_dti", { precision: 5, scale: 2 }),
  finalDti: decimal("final_dti", { precision: 5, scale: 2 }),
  estimatedLtv: decimal("estimated_ltv", { precision: 5, scale: 2 }),
  finalLtv: decimal("final_ltv", { precision: 5, scale: 2 }),

  submittedAt: timestamp("submitted_at"),
  preApprovedAt: timestamp("pre_approved_at"),
  conditionalAt: timestamp("conditional_at"),
  clearToCloseAt: timestamp("clear_to_close_at"),
  fundedAt: timestamp("funded_at"),
  deniedAt: timestamp("denied_at"),
  withdrawnAt: timestamp("withdrawn_at"),

  daysSubmittedToPreApproval: integer("days_submitted_to_pre_approval"),
  daysPreApprovalToConditional: integer("days_pre_approval_to_conditional"),
  daysConditionalToCtc: integer("days_conditional_to_ctc"),
  daysCtcToFunded: integer("days_ctc_to_funded"),
  totalDaysToClose: integer("total_days_to_close"),

  outcome: varchar("outcome", { length: 30 }),
  falloutReason: varchar("fallout_reason", { length: 100 }),
  falloutStage: varchar("fallout_stage", { length: 50 }),

  conditionsIssuedCount: integer("conditions_issued_count").default(0),
  conditionsClearedCount: integer("conditions_cleared_count").default(0),
  conditionsWaivedCount: integer("conditions_waived_count").default(0),
  avgConditionClearanceDays: decimal("avg_condition_clearance_days", { precision: 5, scale: 1 }),

  uwDecisionOverridden: boolean("uw_decision_overridden").default(false),
  uwOverrideReason: varchar("uw_override_reason", { length: 255 }),

  documentResubmissionCount: integer("document_resubmission_count").default(0),
  automatedStepsCount: integer("automated_steps_count").default(0),
  manualStepsCount: integer("manual_steps_count").default(0),

  loanPurpose: varchar("loan_purpose", { length: 50 }),
  productType: varchar("product_type", { length: 50 }),
  propertyType: varchar("property_type", { length: 50 }),
  propertyState: varchar("property_state", { length: 50 }),
  creditScoreBucket: varchar("credit_score_bucket", { length: 20 }),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("idx_outcomes_app").on(table.applicationId),
  index("idx_outcomes_outcome").on(table.outcome),
  index("idx_outcomes_purpose").on(table.loanPurpose),
  index("idx_outcomes_credit").on(table.creditScoreBucket),
  index("idx_outcomes_funded").on(table.fundedAt),
]);

export const insertLoanOutcomeSchema = createInsertSchema(loanOutcomes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLoanOutcome = z.infer<typeof insertLoanOutcomeSchema>;
export type LoanOutcome = typeof loanOutcomes.$inferSelect;

// ============================================================================
// DOCUMENT INTELLIGENCE CONFIDENCE (Extraction accuracy tracking)
// Tracks per-extraction confidence and accuracy over time by doc type
// ============================================================================

export const documentConfidenceScores = pgTable("document_confidence_scores", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  documentId: varchar("document_id").notNull(),
  documentType: varchar("document_type", { length: 50 }).notNull(),
  applicationId: varchar("application_id").references(() => loanApplications.id),

  // No default (0030) + required (0031): the engine is AI-audit provenance, so the
  // writer must name it. A default silently stamps an omitting writer with a guess —
  // which is how this column outlived the retired "gemini" (#146) — and nullable only
  // downgraded that to an unexplained gap. Required, so a new insert path that forgets
  // the engine fails to compile instead of quietly filing an unattributable extraction.
  extractionEngine: varchar("extraction_engine", { length: 30 }).notNull(),
  extractionVersion: varchar("extraction_version", { length: 20 }),

  overallConfidence: decimal("overall_confidence", { precision: 5, scale: 4 }).notNull(),

  fieldConfidences: jsonb("field_confidences"),

  humanReviewRequired: boolean("human_review_required").default(false),
  humanReviewCompleted: boolean("human_review_completed").default(false),
  humanReviewedBy: varchar("human_reviewed_by").references(() => users.id),
  humanReviewedAt: timestamp("human_reviewed_at"),

  fieldsExtracted: integer("fields_extracted").default(0),
  fieldsCorrect: integer("fields_correct"),
  fieldsCorrected: integer("fields_corrected"),
  fieldsMissed: integer("fields_missed"),
  fieldAccuracyPct: decimal("field_accuracy_pct", { precision: 5, scale: 2 }),

  processingTimeMs: integer("processing_time_ms"),
  fileSize: integer("file_size"),
  pageCount: integer("page_count"),

  extractedAt: timestamp("extracted_at").defaultNow().notNull(),
}, (table) => [
  index("idx_doc_conf_document").on(table.documentId),
  index("idx_doc_conf_type").on(table.documentType),
  index("idx_doc_conf_app").on(table.applicationId),
  index("idx_doc_conf_confidence").on(table.overallConfidence),
  index("idx_doc_conf_review").on(table.humanReviewRequired, table.humanReviewCompleted),
  index("idx_doc_conf_time").on(table.extractedAt),
]);

export const insertDocumentConfidenceSchema = createInsertSchema(documentConfidenceScores).omit({
  id: true,
});

export type InsertDocumentConfidence = z.infer<typeof insertDocumentConfidenceSchema>;
export type DocumentConfidence = typeof documentConfidenceScores.$inferSelect;

// ============================================================================
// CORE PROVIDER CANARIES (redacted operational proof)
//
// Configuration answers whether an adapter could run. These append-only rows
// answer whether a harmless, synthetic round trip actually succeeded in the
// deployed environment. No request/response body or borrower identifier is
// stored here; the ledger is intentionally safe to display to operations.
// ============================================================================

export const coreProviderCanaryRuns = pgTable("core_provider_canary_runs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  capabilityId: varchar("capability_id", { length: 50 }).notNull(),
  provider: varchar("provider", { length: 100 }).notNull(),
  operation: varchar("operation", { length: 100 }).notNull(),
  environment: varchar("environment", { length: 30 }).notNull(),
  status: varchar("status", { length: 30 }).notNull(),
  latencyMs: integer("latency_ms").notNull(),
  failureClass: varchar("failure_class", { length: 50 }),
  commitSha: varchar("commit_sha", { length: 64 }),
  triggeredByUserId: varchar("triggered_by_user_id").references(() => users.id),
  completedAt: timestamp("completed_at").defaultNow().notNull(),
}, (table) => [
  index("idx_core_canary_capability_time").on(table.capabilityId, table.completedAt),
  index("idx_core_canary_status_time").on(table.status, table.completedAt),
]);

export const insertCoreProviderCanaryRunSchema = createInsertSchema(coreProviderCanaryRuns).omit({
  id: true,
  completedAt: true,
});

export type InsertCoreProviderCanaryRun = z.infer<typeof insertCoreProviderCanaryRunSchema>;
export type CoreProviderCanaryRun = typeof coreProviderCanaryRuns.$inferSelect;

// ============================================================================
// PREDICTIVE MODEL SNAPSHOTS (Stores computed predictions per borrower)
// Refreshed periodically, consumed by dashboards and coaching
// ============================================================================

export const predictiveSnapshots = pgTable("predictive_snapshots", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  applicationId: varchar("application_id").references(() => loanApplications.id),
  userId: varchar("user_id").references(() => users.id).notNull(),

  likelihoodToClose: decimal("likelihood_to_close", { precision: 5, scale: 4 }),
  estimatedDaysToFund: integer("estimated_days_to_fund"),
  riskOfFallout: decimal("risk_of_fallout", { precision: 5, scale: 4 }),
  conditionDelayRisk: decimal("condition_delay_risk", { precision: 5, scale: 4 }),

  riskFactors: jsonb("risk_factors"),
  positiveFactors: jsonb("positive_factors"),

  comparisonCohort: varchar("comparison_cohort", { length: 100 }),
  cohortAvgDaysToClose: integer("cohort_avg_days_to_close"),
  cohortConversionRate: decimal("cohort_conversion_rate", { precision: 5, scale: 4 }),

  modelVersion: varchar("model_version", { length: 20 }).default("v1"),
  inputHash: varchar("input_hash", { length: 64 }),

  computedAt: timestamp("computed_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("idx_predict_app").on(table.applicationId),
  index("idx_predict_user").on(table.userId),
  index("idx_predict_likelihood").on(table.likelihoodToClose),
  index("idx_predict_time").on(table.computedAt),
]);

export const insertPredictiveSnapshotSchema = createInsertSchema(predictiveSnapshots).omit({
  id: true,
});

export type InsertPredictiveSnapshot = z.infer<typeof insertPredictiveSnapshotSchema>;
export type PredictiveSnapshot = typeof predictiveSnapshots.$inferSelect;
