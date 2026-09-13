// URLA section tables (personal info, employment, income, assets, liabilities, property, declarations) + the pre-approval funnel / intake Zod schemas and normalizers.
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
  date,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { stripCurrency } from "../lib/number";
import { loanApplications } from "./lendingCore";
import { users } from "./core";

export const urlaPersonalInfo = pgTable("urla_personal_info", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),

  // Co-applicant discriminator: 1 = primary borrower, 2+ = co-applicants
  borrowerSequenceNumber: integer("borrower_sequence_number").default(1),
  isPrimaryBorrower: boolean("is_primary_borrower").default(true),

  firstName: varchar("first_name", { length: 100 }),
  middleName: varchar("middle_name", { length: 100 }),
  lastName: varchar("last_name", { length: 100 }),
  suffix: varchar("suffix", { length: 20 }),
  
  // DEPRECATED plaintext SSN — writes now go to the encrypted columns below and
  // this is set to null. Kept only so the backfill script can migrate legacy
  // rows; drop the column once the backfill has run in every environment.
  ssn: varchar("ssn", { length: 11 }),
  // SSN at rest: AES-256-GCM via encryptionService (ssnVault, same scheme as
  // credit reports). Server-managed only — never accepted from the client.
  ssnEncrypted: text("ssn_encrypted"),
  ssnIv: varchar("ssn_iv", { length: 32 }),
  ssnKeyId: varchar("ssn_key_id", { length: 10 }),
  ssnLast4: varchar("ssn_last4", { length: 4 }),
  dateOfBirth: varchar("date_of_birth", { length: 10 }),
  citizenship: varchar("citizenship", { length: 50 }),
  
  alternateNames: text("alternate_names"),
  
  creditType: varchar("credit_type", { length: 50 }),
  totalBorrowers: integer("total_borrowers"),
  coBorrowerNames: text("co_borrower_names"),
  
  maritalStatus: varchar("marital_status", { length: 50 }),
  numberOfDependents: integer("number_of_dependents"),
  dependentAges: text("dependent_ages"),
  
  homePhone: varchar("home_phone", { length: 20 }),
  cellPhone: varchar("cell_phone", { length: 20 }),
  workPhone: varchar("work_phone", { length: 20 }),
  workPhoneExt: varchar("work_phone_ext", { length: 10 }),
  email: varchar("email", { length: 255 }),
  
  currentStreet: text("current_street"),
  currentUnit: varchar("current_unit", { length: 20 }),
  currentCity: varchar("current_city", { length: 100 }),
  currentState: varchar("current_state", { length: 50 }),
  currentZip: varchar("current_zip", { length: 20 }),
  currentCountry: varchar("current_country", { length: 100 }),
  currentAddressYears: integer("current_address_years"),
  currentAddressMonths: integer("current_address_months"),
  currentHousingType: varchar("current_housing_type", { length: 50 }),
  currentRentAmount: decimal("current_rent_amount", { precision: 10, scale: 2 }),
  
  formerStreet: text("former_street"),
  formerUnit: varchar("former_unit", { length: 20 }),
  formerCity: varchar("former_city", { length: 100 }),
  formerState: varchar("former_state", { length: 50 }),
  formerZip: varchar("former_zip", { length: 20 }),
  formerCountry: varchar("former_country", { length: 100 }),
  formerAddressYears: integer("former_address_years"),
  formerAddressMonths: integer("former_address_months"),
  formerHousingType: varchar("former_housing_type", { length: 50 }),
  formerRentAmount: decimal("former_rent_amount", { precision: 10, scale: 2 }),
  
  mailingDifferent: boolean("mailing_different").default(false),
  mailingStreet: text("mailing_street"),
  mailingUnit: varchar("mailing_unit", { length: 20 }),
  mailingCity: varchar("mailing_city", { length: 100 }),
  mailingState: varchar("mailing_state", { length: 50 }),
  mailingZip: varchar("mailing_zip", { length: 20 }),
  mailingCountry: varchar("mailing_country", { length: 100 }),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  // Prevent duplicate multi-borrower mapping: one row per (application, borrower sequence)
  uniqueIndex("urla_personal_info_app_seq_idx").on(
    table.applicationId,
    table.borrowerSequenceNumber,
  ),
]);

export const insertUrlaPersonalInfoSchema = createInsertSchema(urlaPersonalInfo).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  // Server-managed SSN-at-rest columns — never accepted from clients. The
  // plaintext `ssn` field stays accepted as INPUT (encrypted server-side in
  // storage.upsertUrlaPersonalInfo; masked echoes are ignored there).
  ssnEncrypted: true,
  ssnIv: true,
  ssnKeyId: true,
  ssnLast4: true,
});

export type InsertUrlaPersonalInfo = z.infer<typeof insertUrlaPersonalInfoSchema>;
export type UrlaPersonalInfo = typeof urlaPersonalInfo.$inferSelect;

// ---------------------------------------------------------------------------
// Self-employment income worksheet (Fannie Mae Form 1084 / Selling Guide
// B3-3.5 & B3-3.6). Captured per self-employed business — one worksheet hangs
// off one employment_history row. This is analysis data derived from the
// borrower's tax returns; it is re-verified from source documents downstream.
// Every field cites the section it implements; see
// docs/fannie-mae/self-employment-income-reference.md. Do NOT add a rule or
// figure that is not verified there.
// ---------------------------------------------------------------------------

/** Business structures. Sole-prop/LLC → Schedule C (B3-3.6-03); partnership/
 *  S-corp → K-1 (B3-3.6-07). C-corp ordinary income is not the borrower's
 *  qualifying income — kept for completeness, no launch math. */
export const SELF_EMPLOYMENT_BUSINESS_STRUCTURES = [
  "sole_proprietorship",
  "single_member_llc",
  "partnership",
  "s_corporation",
  "c_corporation",
] as const;
export type SelfEmploymentBusinessStructure =
  (typeof SELF_EMPLOYMENT_BUSINESS_STRUCTURES)[number];

/** One tax year of Schedule C figures (B3-3.6-03). Add-backs and subtractions
 *  are the recurring/non-recurring items the Selling Guide enumerates. */
const scheduleCYearSchema = z.object({
  taxYear: z.number().int().min(1980).max(2100).optional(),
  netProfitOrLoss: z.number(),
  // Add-backs (recurring, non-cash) — B3-3.6-03
  depreciation: z.number().min(0).default(0),
  depletion: z.number().min(0).default(0),
  amortizationOrCasualtyLoss: z.number().min(0).default(0),
  businessUseOfHome: z.number().min(0).default(0),
  // Subtractions (non-recurring / non-cash benefit) — B3-3.6-03
  mealsExclusion: z.number().min(0).default(0),
  nonRecurringIncome: z.number().min(0).default(0),
});

/** Entity-level cash-flow adjustments from the business return (Form 1065 /
 *  Form 1120-S analysis — B3-3.7-01 / B3-3.7-02, both eff. 02/07/2024;
 *  transcribed in docs/fannie-mae/self-employment-income-reference.md).
 *  Named categories only — the guide names no line numbers and neither do we.
 *  The borrower's share = ownershipPercent × the entity's net adjustment. */
const entityCashFlowAnalysisSchema = z.object({
  // Add-backs: "depreciation, depletion, amortization, casualty losses, and
  // other losses that are not consistent and recurring"
  depreciation: z.number().min(0).default(0),
  depletion: z.number().min(0).default(0),
  amortizationCasualtyOtherLosses: z.number().min(0).default(0),
  // Subtractions: "travel and meals exclusion"; "other reported income that is
  // not consistent and recurring"; "the total amount of obligations on
  // mortgages, notes, or bonds that are payable in less than one year"
  travelMealsExclusion: z.number().min(0).default(0),
  nonRecurringIncome: z.number().min(0).default(0),
  shortTermObligations: z.number().min(0).default(0),
  /** B3-3.7-01/-02 waiver: the short-term-obligation subtraction does not
   *  apply when the obligations "roll over regularly and/or the business has
   *  sufficient liquid assets to cover them." Defaults false (subtract). */
  shortTermObligationsWaived: z.boolean().default(false),
});

/** One tax year of Schedule K-1 figures (B3-3.6-07), plus the optional
 *  entity-level business-return analysis for the same year (B3-3.7). */
const k1YearSchema = z.object({
  taxYear: z.number().int().min(1980).max(2100).optional(),
  ordinaryBusinessIncome: z.number().default(0),
  netRentalRealEstateIncome: z.number().default(0),
  otherNetRentalIncome: z.number().default(0),
  guaranteedPayments: z.number().default(0),
  distributionsReceived: z.number().min(0).default(0),
  entityAnalysis: entityCashFlowAnalysisSchema.optional(),
});

/** Business liquidity (B3-3.6-07): quick ratio = (current assets − inventory) /
 *  current liabilities; current ratio = current assets / current liabilities.
 *  ≥ 1 is generally sufficient to use ordinary income beyond distributions. */
const businessLiquiditySchema = z.object({
  currentAssets: z.number().min(0),
  currentLiabilities: z.number().min(0),
  inventory: z.number().min(0).default(0),
});

export const selfEmploymentWorksheetSchema = z
  .object({
    version: z.literal(1).default(1),
    businessStructure: z.enum(SELF_EMPLOYMENT_BUSINESS_STRUCTURES),
    // 25%+ ownership = self-employed (B3-3.5-01)
    ownershipPercent: z.number().min(0).max(100).optional(),
    yearsSelfEmployed: z.number().min(0).max(80).optional(),
    // Sole proprietorship / single-member LLC (Schedule C):
    scheduleC: z
      .object({
        currentYear: scheduleCYearSchema,
        priorYear: scheduleCYearSchema.optional(),
      })
      .optional(),
    // Partnership (1065) / S corporation (1120S) (Schedule K-1):
    k1: z
      .object({
        currentYear: k1YearSchema,
        priorYear: k1YearSchema.optional(),
        /** Guaranteed payments received continuously for two years may be used
         *  without additional liquidity documentation (B3-3.6-07). */
        hasTwoYearGuaranteedPayments: z.boolean().default(false),
        liquidity: businessLiquiditySchema.optional(),
        /** W-2 the borrower draws from their own S-corp. Added directly to the
         *  K-1 lane's usable income (B3-3.7-02: owners "may receive income in
         *  the form of wages or dividends in addition to their proportionate
         *  share" — the agency wage path skips self-employed employment rows,
         *  so this is the only place the salary can count; no double-count). */
        w2FromBusiness: z.number().min(0).default(0),
      })
      .optional(),
    /** Set when the borrower reviews and affirms a smart-filled draft (B2). */
    confirmedByBorrowerAt: z.string().datetime().optional(),
    /** Provenance link to the tax-return insight the draft came from (B2). */
    sourceTaxInsightId: z.string().max(64).optional(),
  })
  .strict()
  .superRefine((wk, ctx) => {
    const isScheduleC =
      wk.businessStructure === "sole_proprietorship" ||
      wk.businessStructure === "single_member_llc";
    const isK1 =
      wk.businessStructure === "partnership" ||
      wk.businessStructure === "s_corporation";
    if (isScheduleC && wk.k1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Schedule C business must not carry K-1 figures",
        path: ["k1"],
      });
    }
    if (isK1 && wk.scheduleC) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "K-1 business must not carry Schedule C figures",
        path: ["scheduleC"],
      });
    }
  });

export type SelfEmploymentWorksheet = z.infer<typeof selfEmploymentWorksheetSchema>;

// Employment History (Sections 1b, 1c, 1d)
export const employmentHistory = pgTable("employment_history", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),

  // Co-applicant discriminator: 1 = primary borrower, 2+ = co-applicants
  borrowerSequenceNumber: integer("borrower_sequence_number").default(1),

  employmentType: varchar("employment_type", { length: 50 }).notNull(),
  
  employerName: varchar("employer_name", { length: 255 }),
  employerPhone: varchar("employer_phone", { length: 20 }),
  employerStreet: text("employer_street"),
  employerUnit: varchar("employer_unit", { length: 20 }),
  employerCity: varchar("employer_city", { length: 100 }),
  employerState: varchar("employer_state", { length: 50 }),
  employerZip: varchar("employer_zip", { length: 20 }),
  employerCountry: varchar("employer_country", { length: 100 }),
  
  positionTitle: varchar("position_title", { length: 255 }),
  startDate: varchar("start_date", { length: 10 }),
  endDate: varchar("end_date", { length: 10 }),
  yearsInLineOfWork: integer("years_in_line_of_work"),
  monthsInLineOfWork: integer("months_in_line_of_work"),
  
  isSelfEmployed: boolean("is_self_employed").default(false),
  // B3-3.1-01: income paid to or earned in virtual currency is ineligible.
  // Null is unanswered; false is an affirmative borrower/LO answer.
  paidInVirtualCurrency: boolean("paid_in_virtual_currency"),
  // B3-3.1-01: when the borrower or employer reports an upcoming move to a
  // lower pay structure, qualification must use the lower stable amount.
  // Null means the question has not been answered.
  hasKnownFutureIncomeReduction: boolean("has_known_future_income_reduction"),
  futureMonthlyIncome: decimal("future_monthly_income", { precision: 12, scale: 2 }),
  futureIncomeEffectiveDate: varchar("future_income_effective_date", { length: 10 }),
  futureIncomeReason: text("future_income_reason"),
  ownershipShareLessThan25: boolean("ownership_share_less_than_25"),
  ownershipShare25OrMore: boolean("ownership_share_25_or_more"),
  isEmployedByFamilyMember: boolean("is_employed_by_family_member").default(false),
  isEmployedByPropertySeller: boolean("is_employed_by_property_seller").default(false),
  
  baseIncome: decimal("base_income", { precision: 12, scale: 2 }),
  overtimeIncome: decimal("overtime_income", { precision: 12, scale: 2 }),
  bonusIncome: decimal("bonus_income", { precision: 12, scale: 2 }),
  commissionIncome: decimal("commission_income", { precision: 12, scale: 2 }),
  militaryEntitlements: decimal("military_entitlements", { precision: 12, scale: 2 }),
  otherIncome: decimal("other_income", { precision: 12, scale: 2 }),
  totalMonthlyIncome: decimal("total_monthly_income", { precision: 12, scale: 2 }),
  
  monthlyIncomeOrLoss: decimal("monthly_income_or_loss", { precision: 12, scale: 2 }),

  // Self-employment income worksheet (Form 1084 / B3-3.5 & B3-3.6). Populated
  // only for self-employed records; drives server/services/selfEmploymentIncome.ts.
  // Structured object — written via the dedicated Zod-validated endpoint, never
  // the generic pickTableFields employment save (which drops JSON by design).
  selfEmploymentIncome: jsonb("self_employment_income").$type<SelfEmploymentWorksheet>(),

  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
});

export const insertEmploymentHistorySchema = createInsertSchema(employmentHistory).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEmploymentHistory = z.infer<typeof insertEmploymentHistorySchema>;
export type EmploymentHistory = typeof employmentHistory.$inferSelect;

// Other Income Sources (Section 1e)
export const otherIncomeSources = pgTable("other_income_sources", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  // URLA Section 1e belongs to a borrower, just like employment. Keeping the
  // sequence on the row prevents a co-borrower's pension or Social Security
  // from being exported under the primary borrower or disappearing from the
  // per-borrower income analysis. Existing rows are primary borrower rows.
  borrowerSequenceNumber: integer("borrower_sequence_number").default(1).notNull(),
  
  incomeSource: varchar("income_source", { length: 100 }).notNull(),
  monthlyAmount: decimal("monthly_amount", { precision: 12, scale: 2 }).notNull(),
  // B3-3.1-01: the favorable 25% gross-up is applied only after the current
  // income workpaper (including supporting documents) is approved. These
  // borrower answers describe the candidate treatment; approval supplies the
  // human verification boundary.
  taxTreatment: varchar("tax_treatment", { length: 32 }),
  nonTaxableMonthlyAmount: decimal("non_taxable_monthly_amount", { precision: 12, scale: 2 }),
  // B3-3.1-01: a defined expiration must reach at least three years beyond
  // the expected note date. Null means unanswered, never "continues forever."
  hasDefinedExpiration: boolean("has_defined_expiration"),
  expirationDate: date("expiration_date"),
  paidInVirtualCurrency: boolean("paid_in_virtual_currency"),

  // B3-3.4-06 employment-related assets as qualifying income. These fields
  // describe the borrower's intended use of one retirement asset; the income
  // workpaper still requires a current reviewed statement before any amount
  // can qualify. Account last-four is the PII-minimized link to urla_assets.
  linkedAssetAccountLast4: varchar("linked_asset_account_last4", { length: 4 }),
  assetOwnershipType: varchar("asset_ownership_type", { length: 40 }),
  hasUnrestrictedAccess: boolean("has_unrestricted_access"),
  fullDistributionPenaltyAmount: decimal("full_distribution_penalty_amount", { precision: 12, scale: 2 }),
  fundsUsedForTransaction: decimal("funds_used_for_transaction", { precision: 12, scale: 2 }),
  
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertOtherIncomeSourceSchema = createInsertSchema(otherIncomeSources).omit({
  id: true,
  createdAt: true,
});

export type InsertOtherIncomeSource = z.infer<typeof insertOtherIncomeSourceSchema>;
export type OtherIncomeSource = typeof otherIncomeSources.$inferSelect;

// Assets (Section 2a)
export const urlaAssets = pgTable("urla_assets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),

  // Co-applicant discriminator: 1 = primary borrower, 2+ = co-applicants
  borrowerSequenceNumber: integer("borrower_sequence_number").default(1),

  accountType: varchar("account_type", { length: 100 }).notNull(),
  financialInstitution: varchar("financial_institution", { length: 255 }),
  // Account number is encrypted at rest (piiVault); only last4 is returned to
  // clients. Legacy plaintext column handled by scripts/migrate-encrypt-pii.ts.
  accountNumberEncrypted: text("account_number_encrypted"),
  accountNumberIv: varchar("account_number_iv", { length: 32 }),
  accountNumberKeyId: varchar("account_number_key_id", { length: 20 }),
  accountNumberLast4: varchar("account_number_last4", { length: 4 }),
  cashOrMarketValue: decimal("cash_or_market_value", { precision: 12, scale: 2 }),
  
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUrlaAssetSchema = createInsertSchema(urlaAssets).omit({
  id: true,
  createdAt: true,
});

export type InsertUrlaAsset = z.infer<typeof insertUrlaAssetSchema>;
export type UrlaAsset = typeof urlaAssets.$inferSelect;

// Liabilities (Section 2)
export const urlaLiabilities = pgTable("urla_liabilities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),

  // Co-applicant discriminator: 1 = primary borrower, 2+ = co-applicants
  borrowerSequenceNumber: integer("borrower_sequence_number").default(1),

  liabilityType: varchar("liability_type", { length: 100 }).notNull(),
  creditorName: varchar("creditor_name", { length: 255 }),
  // Account number is encrypted at rest (piiVault); only last4 is returned to
  // clients. Legacy plaintext column handled by scripts/migrate-encrypt-pii.ts.
  accountNumberEncrypted: text("account_number_encrypted"),
  accountNumberIv: varchar("account_number_iv", { length: 32 }),
  accountNumberKeyId: varchar("account_number_key_id", { length: 20 }),
  accountNumberLast4: varchar("account_number_last4", { length: 4 }),
  unpaidBalance: decimal("unpaid_balance", { precision: 12, scale: 2 }),
  monthlyPayment: decimal("monthly_payment", { precision: 10, scale: 2 }),
  toBePaidOff: boolean("to_be_paid_off").default(false),

  // Facts the borrower can supply so a reviewer can apply B3-6-05 without a
  // spreadsheet. A short-term installment or documented $0 income-driven
  // student-loan payment remains conservative until the staff-only treatment
  // below is tied to both accepted source evidence and the current bureau row.
  remainingTermMonths: integer("remaining_term_months"),
  studentLoanRepaymentPlan: varchar("student_loan_repayment_plan", { length: 40 }),
  underwritingTreatment: varchar("underwriting_treatment", { length: 60 }),
  treatmentSourceDocumentId: varchar("treatment_source_document_id"),
  treatmentCreditPullId: varchar("treatment_credit_pull_id"),
  treatmentTradelineIndex: integer("treatment_tradeline_index"),
  treatmentReviewedBy: varchar("treatment_reviewed_by").references(() => users.id),
  treatmentReviewedAt: timestamp("treatment_reviewed_at"),

  // B3-6-05, Debts Paid by Others — the borrower's declaration that another
  // party makes the payments, plus the facts the exclusion turns on. The rule
  // itself is shared/liabilityExclusions.ts. The 12-month payment-history
  // documentation the Guide requires is an auto-generated loan_condition
  // (PRE_UW_THIRD_PARTY_PAID_DEBT), so staff verification is that condition's
  // own clearing workflow — deliberately NO staff-only column here, because
  // the liability routes whitelist by table column and a borrower could set
  // one on their own row.
  paidByOtherParty: boolean("paid_by_other_party").default(false),
  /** A relationship, never a name — see OTHER_PARTY_RELATIONSHIPS. */
  otherPartyRelationship: varchar("other_party_relationship", { length: 60 }),
  /** Mortgage-class only: the payer is also obligated on the loan. */
  otherPartyObligated: boolean("other_party_obligated"),
  /** The payer is an interested party to this purchase (seller, agent) — disqualifying. */
  otherPartyInterestedParty: boolean("other_party_interested_party"),
  /** Mortgage-class only: rental income from that property is used to qualify. */
  usesRentalIncomeFromProperty: boolean("uses_rental_income_from_property"),

  createdAt: timestamp("created_at").defaultNow(),
});

export const insertUrlaLiabilitySchema = createInsertSchema(urlaLiabilities).omit({
  id: true,
  createdAt: true,
});

export type InsertUrlaLiability = z.infer<typeof insertUrlaLiabilitySchema>;
export type UrlaLiability = typeof urlaLiabilities.$inferSelect;

// URLA Property Information (Section for Property and Loan details)
export const urlaPropertyInfo = pgTable("urla_property_info", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),
  
  propertyStreet: text("property_street"),
  propertyUnit: varchar("property_unit", { length: 20 }),
  propertyCity: varchar("property_city", { length: 100 }),
  propertyState: varchar("property_state", { length: 50 }),
  propertyZip: varchar("property_zip", { length: 20 }),
  propertyCounty: varchar("property_county", { length: 100 }),
  propertyCountry: varchar("property_country", { length: 100 }),
  
  numberOfUnits: integer("number_of_units"),
  propertyValue: decimal("property_value", { precision: 12, scale: 2 }),
  occupancyType: varchar("occupancy_type", { length: 50 }),
  // Gross monthly market rent for the subject property (appraisal rent
  // schedule / lease), used to qualify rental income on 2-4 unit
  // owner-occupied purchases — Fannie Mae Selling Guide B3-3.8-01 (formerly B3-3.1-08).
  estimatedMarketRent: decimal("estimated_market_rent", { precision: 12, scale: 2 }),
  // Owners' association / co-op dues for the SUBJECT property, monthly.
  // Fannie Mae Selling Guide B3-6-03 counts "any owners' association dues" and
  // "any monthly co-op corporation fee" inside the qualifying housing expense
  // (PITIA) used to compute the DTI ratio — so this is decision input, not
  // display. NULL means NOT CAPTURED, never zero: the decision path treats a
  // null on an association-bearing property type as a gap to fill rather than
  // quietly qualifying the borrower without their dues.
  monthlyAssociationDues: decimal("monthly_association_dues", { precision: 10, scale: 2 }),
  // Remaining B3-6-03 subject-property housing-expense components. A null is
  // deliberately "not answered"; the borrower enters 0 when the cost does not
  // apply so the lender-ready path never turns an unknown into a free payment.
  monthlyFloodInsurance: decimal("monthly_flood_insurance", { precision: 10, scale: 2 }),
  monthlyGroundRent: decimal("monthly_ground_rent", { precision: 10, scale: 2 }),
  monthlySpecialAssessments: decimal("monthly_special_assessments", { precision: 10, scale: 2 }),

  // Other new financing secured by the subject property (URLA 4b). Closed-end
  // UPB and the drawn HELOC balance feed CLTV; the full HELOC line feeds HCLTV.
  // The monthly payment belongs in the subject housing expense.
  subordinateFinancingExists: boolean("subordinate_financing_exists"),
  closedEndSubordinateBalance: decimal("closed_end_subordinate_balance", { precision: 12, scale: 2 }),
  helocDrawnBalance: decimal("heloc_drawn_balance", { precision: 12, scale: 2 }),
  helocCreditLimit: decimal("heloc_credit_limit", { precision: 12, scale: 2 }),
  monthlySubordinateFinancingPayment: decimal("monthly_subordinate_financing_payment", { precision: 10, scale: 2 }),
  
  isMixedUse: boolean("is_mixed_use").default(false),
  mixedUseDescription: text("mixed_use_description"),
  
  isManufacturedHome: boolean("is_manufactured_home").default(false),
  manufacturedWidth: varchar("manufactured_width", { length: 50 }),
  
  legalDescription: text("legal_description"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
});

export const insertUrlaPropertyInfoSchema = createInsertSchema(urlaPropertyInfo).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUrlaPropertyInfo = z.infer<typeof insertUrlaPropertyInfoSchema>;
export type UrlaPropertyInfo = typeof urlaPropertyInfo.$inferSelect;

// Borrower Declarations (URLA Section 5 / MISMO 3.4 Declarations)
export const borrowerDeclarations = pgTable("borrower_declarations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),

  // Co-applicant discriminator: 1 = primary borrower, 2+ = co-applicants
  borrowerSequenceNumber: integer("borrower_sequence_number").default(1),

  willOccupyAsPrimaryResidence: boolean("will_occupy_as_primary_residence"),
  hasOwnershipInterestInPast3Years: boolean("has_ownership_interest_in_past_3_years"),
  priorPropertyType: varchar("prior_property_type", { length: 50 }),
  priorPropertyTitle: varchar("prior_property_title", { length: 50 }),
  
  hasRelationshipWithSeller: boolean("has_relationship_with_seller"),
  isBorrowingForDownPayment: boolean("is_borrowing_for_down_payment"),
  borrowedAmount: decimal("borrowed_amount", { precision: 12, scale: 2 }),
  
  hasAppliedForMortgageOnOtherProperty: boolean("has_applied_for_mortgage_on_other_property"),
  hasCreditForMortgageOnOtherProperty: boolean("has_credit_for_mortgage_on_other_property"),
  hasPriorityLienOnSubjectProperty: boolean("has_priority_lien_on_subject_property"),
  
  hasCoMakerEndorser: boolean("has_co_maker_endorser"),
  hasOutstandingJudgments: boolean("has_outstanding_judgments"),
  isDelinquentOnFederalDebt: boolean("is_delinquent_on_federal_debt"),
  isPartyToLawsuit: boolean("is_party_to_lawsuit"),
  hasConveyedTitleInLieuOfForeclosure: boolean("has_conveyed_title_in_lieu_of_foreclosure"),
  hasCompletedShortSale: boolean("has_completed_short_sale"),
  hasBeenForeclosed: boolean("has_been_foreclosed"),
  hasDeclaredBankruptcy: boolean("has_declared_bankruptcy"),
  bankruptcyTypes: text("bankruptcy_types"),
  
  hasUndisclosedDebt: boolean("has_undisclosed_debt"),
  undisclosedDebtAmount: decimal("undisclosed_debt_amount", { precision: 12, scale: 2 }),
  hasAppliedForNewCredit: boolean("has_applied_for_new_credit"),
  hasPriorityLienToBePaidOff: boolean("has_priority_lien_to_be_paid_off"),
  
  isUSCitizen: boolean("is_us_citizen"),
  isPermanentResidentAlien: boolean("is_permanent_resident_alien"),
  
  declarationsCompletedAt: timestamp("declarations_completed_at"),
  declarationsVerifiedAt: timestamp("declarations_verified_at"),
  declarationsVerifiedBy: varchar("declarations_verified_by").references(() => users.id),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow().$onUpdate(() => new Date()),
});

export const insertBorrowerDeclarationsSchema = createInsertSchema(borrowerDeclarations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBorrowerDeclarations = z.infer<typeof insertBorrowerDeclarationsSchema>;
export type BorrowerDeclarations = typeof borrowerDeclarations.$inferSelect;

// The pre-approval form schema moved to shared/preApprovalForm.ts so the client
// can import it without dragging every Drizzle table into the browser bundle.
//
// Re-exported by NAME, not `export *`, on purpose: preApprovalFormBaseSchema and
// downPaymentWithinPurchasePrice were module-private before the move and are
// exported now only so this file can still derive from them. Widening the
// barrel with them would change the public Zod surface, which
// tests/zodSchemaSemantics.test.ts correctly treats as a data-admission change.
export {
  VALID_US_STATES,
  rentalPropertyEntrySchema,
  incomeSourceEntrySchema,
  preApprovalFormSchema,
  CREDIT_SCORE_BAND_VALUES,
  CREDIT_SCORE_UNKNOWN_DEFAULT,
} from "../preApprovalForm";
export { CLEARABLE_INTAKE_FIELDS, isClearableIntakeField } from "../intakeClearable";
export type { ClearableIntakeField } from "../intakeClearable";
export type {
  USStateCode,
  RentalPropertyEntry,
  IncomeSourceEntry,
  PreApprovalFormData,
} from "../preApprovalForm";
import {
  CREDIT_SCORE_UNKNOWN_DEFAULT,
  complexIncomeDetailsPresent,
  downPaymentWithinPurchasePrice,
  incomeBreakdownWithinHouseholdTotal,
  preApprovalFormBaseSchema,
  preApprovalFormSchema,
  type PreApprovalFormData,
} from "../preApprovalForm";
/**
 * JSON callers (staff tools, tests, future API consumers) may send numbers
 * where the form sends strings; normalize scalars to the string form the
 * field validators expect BEFORE validation so the rules stay identical.
 */
function stringifyIntakeScalars(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const key of ["annualIncome", "monthlyDebts", "purchasePrice", "downPayment", "employmentYears", "creditScore", "householdFamilySize", "homeSquareFootage", "numberOfUnits", "subjectMonthlyRentalIncome"]) {
    if (typeof out[key] === "number") out[key] = String(out[key]);
  }
  if (Array.isArray(out.incomeSources)) {
    out.incomeSources = out.incomeSources.map((source) => {
      if (source === null || typeof source !== "object") return source;
      const s: Record<string, unknown> = { ...(source as Record<string, unknown>) };
      for (const key of ["annualAmount", "yearsInRole", "ownershipPercent"]) {
        if (typeof s[key] === "number") s[key] = String(s[key]);
      }
      if (Array.isArray(s.rentalProperties)) {
        s.rentalProperties = s.rentalProperties.map((prop) => {
          if (prop === null || typeof prop !== "object") return prop;
          const p: Record<string, unknown> = { ...(prop as Record<string, unknown>) };
          for (const key of ["monthlyRentalIncome", "monthlyDebtPayment"]) {
            if (typeof p[key] === "number") p[key] = String(p[key]);
          }
          return p;
        });
      }
      return s;
    });
  }
  return out;
}

/**
 * Post-validation normalization: DB-ready values, no silent invention.
 *
 * Guards are `!= null`, not `!== undefined`: an explicit `null` is the wire
 * representation of "clear this field" (CLEARABLE_INTAKE_FIELDS,
 * ../preApprovalForm.ts) and
 * must reach the column untouched. Skipping the spread leaves the `null` that
 * `...d` already carried — running `stripCurrency(null)` or `parseInt(null)`
 * over it would throw or produce `NaN`.
 */
function normalizeIntakeValues<T extends Record<string, any>>(d: T) {
  const normalized = {
    ...d,
    ...(d.annualIncome != null && { annualIncome: stripCurrency(d.annualIncome) }),
    ...(d.monthlyDebts != null && { monthlyDebts: stripCurrency(d.monthlyDebts) }),
    ...(d.purchasePrice != null && { purchasePrice: stripCurrency(d.purchasePrice) }),
    ...(d.downPayment != null && { downPayment: stripCurrency(d.downPayment) }),
    ...(d.subjectMonthlyRentalIncome != null && {
      subjectMonthlyRentalIncome: stripCurrency(d.subjectMonthlyRentalIncome),
    }),
    ...(d.numberOfUnits != null && { numberOfUnits: parseInt(d.numberOfUnits) }),
    ...(d.employmentYears != null && { employmentYears: parseInt(d.employmentYears) }),
    ...(d.creditScore != null && {
      creditScore: d.creditScore === "not_sure" ? CREDIT_SCORE_UNKNOWN_DEFAULT : parseInt(d.creditScore),
    }),
    ...(d.incomeSources != null && {
      incomeSources: d.incomeSources?.map((s: any) => ({
        ...s,
        annualAmount: stripCurrency(s.annualAmount),
        rentalProperties: s.rentalProperties?.map((p: any) => ({
          ...p,
          monthlyRentalIncome: stripCurrency(p.monthlyRentalIncome),
          ...(p.monthlyDebtPayment !== undefined && { monthlyDebtPayment: stripCurrency(p.monthlyDebtPayment) }),
        })),
      })),
    }),
  };
  // Conditional funnel fields stay as empty strings until their step is
  // routed in. Empty means "not applicable/unanswered", not numeric zero and
  // certainly not NaN (which Postgres rejects for integer columns).
  if (d.numberOfUnits === "") delete normalized.numberOfUnits;
  if (d.subjectMonthlyRentalIncome === "") delete normalized.subjectMonthlyRentalIncome;
  // The funnel can route a conditional answer out after the borrower goes
  // back and changes the property. Do not let a prior three-unit/rent answer
  // survive on a primary one-unit home simply because the hidden form value
  // is still present in an autosave or final submission.
  if (d.propertyType && d.propertyType !== "multi_family") {
    normalized.numberOfUnits = 1;
  }
  if (
    d.propertyType &&
    d.occupancyType &&
    d.propertyType !== "multi_family" &&
    d.occupancyType !== "investment"
  ) {
    (normalized as Record<string, unknown>).subjectMonthlyRentalIncome = null;
  }
  return normalized;
}

export const loanApplicationIntakeSchema = z.preprocess(
  stringifyIntakeScalars,
  preApprovalFormBaseSchema
    .extend({
      // FCRA soft-pull authorization acknowledged on the funnel's final step.
      softPullConsentAccepted: z.boolean().optional(),
      // The funnel always asks these; API callers may omit them. Defaulting a
      // boolean eligibility flag to false is safe — unlike financial figures,
      // it can't fabricate data (it just doesn't claim VA/FTHB benefits).
      isVeteran: z.boolean().optional().default(false),
      isFirstTimeBuyer: z.boolean().optional().default(false),
      // UAL P7 routing preference. Deliberately NOT defaulted: omitting the
      // question is "not asked" (null), which must stay distinct from an
      // explicit "no" — defaulting would fabricate an answer.
      avoidsInterestFinancing: z.boolean().optional(),
    })
    .superRefine((data, ctx) => {
      downPaymentWithinPurchasePrice(data, ctx);
      incomeBreakdownWithinHouseholdTotal(data, ctx);
      complexIncomeDetailsPresent(data, ctx);
    })
    .transform(normalizeIntakeValues),
);
export type LoanApplicationIntake = z.infer<typeof loanApplicationIntakeSchema>;

// CLEARABLE_INTAKE_FIELDS / isClearableIntakeField live in ../intakeClearable
// (re-exported above), in a module of their own: /profile is the only client
// that reads the predicate and it is lazily routed, so keeping the catalog out
// of preApprovalForm keeps its bytes out of the eager entry chunk. See that
// file's header for the measurement.

// The four fields this PATCH accepts that the funnel form does not carry.
// Named so the clearable variants below reuse the SAME validator rather than
// restate it — a second spelling is how a rule and its clear drift apart.
const employerNameField = z.string().max(200, "Employer name is too long");
const propertyAddressField = z.string().max(500, "Address is too long");
const propertyCityField = z.string().max(100, "City name is too long");
const propertyZipField = z.string().refine(
  (v) => !v || /^\d{5}(-\d{4})?$/.test(v),
  { message: "ZIP code must be 5 digits (e.g., 90210) or ZIP+4 (e.g., 90210-1234)" },
);

const partialIntakeShape = preApprovalFormBaseSchema.partial().shape;

/** Partial variant for draft field updates (borrower PATCH while in "draft"). */
export const loanApplicationIntakeUpdateSchema = z.preprocess(
  stringifyIntakeScalars,
  preApprovalFormBaseSchema
    .partial()
    .extend({
      // Every clearable field keeps its own validator and only ADDS null, by
      // wrapping the existing schema rather than restating it. A bad value is
      // still a 400 — `annualIncome: "abc"` does not become acceptable just
      // because `annualIncome: null` now is.
      annualIncome: partialIntakeShape.annualIncome.nullable(),
      monthlyDebts: partialIntakeShape.monthlyDebts.nullable(),
      employmentYears: partialIntakeShape.employmentYears.nullable(),
      purchasePrice: partialIntakeShape.purchasePrice.nullable(),
      downPayment: partialIntakeShape.downPayment.nullable(),
      propertyState: partialIntakeShape.propertyState.nullable(),
      employerName: employerNameField.nullable().optional(),
      propertyAddress: propertyAddressField.nullable().optional(),
      propertyCity: propertyCityField.nullable().optional(),
      propertyZip: propertyZipField.nullable().optional(),
    })
    .superRefine((data, ctx) => {
      downPaymentWithinPurchasePrice(data, ctx);
      incomeBreakdownWithinHouseholdTotal(data, ctx);
      complexIncomeDetailsPresent(data, ctx);
    })
    .transform(normalizeIntakeValues),
);
export type LoanApplicationIntakeUpdate = z.infer<typeof loanApplicationIntakeUpdateSchema>;

// =============================================================================
// MORTGAGE RATES
// =============================================================================
