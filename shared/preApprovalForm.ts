// Pre-approval funnel form schema — the Zod contract the intake form and the
// server both validate against, plus the small value vocabularies it needs.
//
// WHY THIS IS NOT IN shared/schema/lendingUrla.ts ANY MORE
//
// `preApprovalFormSchema` is a RUNTIME import in the client (PreApproval.tsx,
// preApprovalMachine.ts). While it sat in a module that also declares
// pgTable(...) and createInsertSchema(...), importing it pulled all 174 Drizzle
// table definitions into the public browser bundle — pgTable() is side-effecting,
// so tree-shaking could not drop them.
//
// Nothing here is table-derived: preApprovalFormBaseSchema is a plain z.object,
// not createInsertSchema(loanApplications). That is what makes the split safe —
// keep it true. This module must import nothing but zod.
//
// lendingUrla.ts imports what it still uses and re-exports the rest, so
// `@shared/schema` consumers and all server imports are unchanged.

import { z } from "zod";

const VALID_US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC"
] as const;

export type USStateCode = typeof VALID_US_STATES[number];
export { VALID_US_STATES };

const currencyString = (fieldLabel: string) =>
  z.string()
    .min(1, `${fieldLabel} is required`)
    .refine(
      (v) => {
        const num = parseFloat(v.replace(/[,$]/g, ""));
        return !isNaN(num) && num >= 0;
      },
      { message: `${fieldLabel} must be a valid dollar amount` }
    );

const positiveCurrencyString = (fieldLabel: string) =>
  z.string()
    .min(1, `${fieldLabel} is required`)
    .refine(
      (v) => {
        const num = parseFloat(v.replace(/[,$]/g, ""));
        return !isNaN(num) && num > 0;
      },
      { message: `${fieldLabel} must be greater than $0` }
    )
    .refine(
      (v) => {
        const num = parseFloat(v.replace(/[,$]/g, ""));
        return num <= 100_000_000;
      },
      { message: `${fieldLabel} exceeds the maximum allowed value` }
    );

export const rentalPropertyEntrySchema = z.object({
  address: z.string()
    .min(1, "Property address is required")
    .max(500, "Address is too long"),
  city: z.string().max(100, "City name is too long").optional(),
  state: z.string()
    .refine((v) => !v || VALID_US_STATES.includes(v as any), { message: "Please select a valid US state" })
    .optional(),
  monthlyRentalIncome: z.string()
    .min(1, "Monthly rental income is required")
    .refine(
      (v) => { const n = parseFloat(v.replace(/[,$]/g, "")); return !isNaN(n) && n > 0; },
      { message: "Rental income must be a valid amount greater than $0" }
    )
    .refine(
      (v) => { const n = parseFloat(v.replace(/[,$]/g, "")); return n <= 1_000_000; },
      { message: "Monthly rental income exceeds the maximum allowed value" }
    ),
  monthlyDebtPayment: z.string()
    .refine(
      (v) => { if (!v) return true; const n = parseFloat(v.replace(/[,$]/g, "")); return !isNaN(n) && n >= 0; },
      { message: "Debt payment must be a valid dollar amount" }
    )
    .optional(),
});

export type RentalPropertyEntry = z.infer<typeof rentalPropertyEntrySchema>;

export const incomeSourceEntrySchema = z.object({
  type: z.enum(
    ["w2", "self_employed", "rental", "social_security", "pension", "investment", "other"],
    { error: () => "Please select a valid income type" }
  ),
  annualAmount: z.string()
    .min(1, "Income amount is required")
    .refine(
      (v) => { const n = parseFloat(v.replace(/[,$]/g, "")); return !isNaN(n) && n > 0; },
      { message: "Income amount must be greater than $0" }
    )
    .refine(
      (v) => { const n = parseFloat(v.replace(/[,$]/g, "")); return n <= 100_000_000; },
      { message: "Income amount exceeds the maximum allowed value" }
    ),
  employerName: z.string().max(200, "Employer name is too long").optional(),
  yearsInRole: z.string()
    .refine(
      (v) => { if (!v) return true; const n = parseInt(v); return !isNaN(n) && n >= 0 && n <= 80; },
      { message: "Years in role must be between 0 and 80" }
    )
    .optional(),
  businessStructure: z.enum([
    "sole_proprietorship",
    "single_member_llc",
    "partnership",
    "s_corporation",
    "c_corporation",
    "other",
  ]).optional(),
  ownershipPercent: z.string()
    .refine(
      (v) => {
        if (!v) return true;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 && n <= 100;
      },
      { message: "Ownership must be between 0% and 100%" },
    )
    .optional(),
  rentalProperties: z.array(rentalPropertyEntrySchema).optional(),
});

export type IncomeSourceEntry = z.infer<typeof incomeSourceEntrySchema>;

// Exported for shared/schema/lendingUrla.ts, which derives further schemas from
// it. Not part of the public form contract — prefer preApprovalFormSchema.
export const preApprovalFormBaseSchema = z.object({
  annualIncome: positiveCurrencyString("Annual income"),
  employmentType: z.enum(
    ["employed", "self_employed", "retired", "other"],
    { error: () => "Please select your employment status" }
  ),
  employmentYears: z.string()
    .min(1, "Years at current job is required")
    .refine(
      (v) => { const n = parseInt(v); return !isNaN(n) && n >= 0; },
      { message: "Please enter a valid number of years" }
    )
    .refine(
      (v) => { const n = parseInt(v); return n <= 80; },
      { message: "Years at current job cannot exceed 80" }
    ),

  hasAdditionalIncome: z.boolean().optional(),
  incomeSources: z.array(incomeSourceEntrySchema).optional(),

  monthlyDebts: currencyString("Monthly debts")
    .refine(
      (v) => { const n = parseFloat(v.replace(/[,$]/g, "")); return n <= 1_000_000; },
      { message: "Monthly debts exceeds the maximum allowed value" }
    ),
  creditScore: z.string()
    .min(1, "Credit score range is required")
    .refine(
      (v) => ["760", "720", "680", "640", "600", "not_sure"].includes(v),
      { message: "Please select a valid credit score range" }
    ),

  loanPurpose: z.enum(
    ["purchase", "refinance", "cash_out"],
    { error: () => "Please select what you're looking to do" }
  ),
  propertyType: z.enum(
    ["single_family", "condo", "townhouse", "multi_family"],
    { error: () => "Please select a property type" }
  ),
  // Optional in the base so older API clients can still create a file without
  // fabricating a primary residence. The borrower funnel requires it below.
  occupancyType: z.enum(["primary_residence", "second_home", "investment"]).optional(),
  numberOfUnits: z.string()
    .refine((v) => !v || /^[1-4]$/.test(v), { message: "Number of units must be between 1 and 4" })
    .optional(),
  subjectMonthlyRentalIncome: z.string()
    .refine(
      (v) => {
        if (!v) return true;
        const amount = parseFloat(v.replace(/[,$]/g, ""));
        return !isNaN(amount) && amount >= 0 && amount <= 1_000_000;
      },
      { message: "Expected monthly rent must be a valid dollar amount" },
    )
    .optional(),
  purchasePrice: positiveCurrencyString("Purchase price"),
  downPayment: currencyString("Down payment"),

  isVeteran: z.boolean(),
  isFirstTimeBuyer: z.boolean(),
  // UAL P7 routing preference ("financing that avoids interest"). Optional in
  // the form base so non-funnel callers are unaffected; the funnel supplies it.
  avoidsInterestFinancing: z.boolean().optional(),
  propertyState: z.string()
    .min(1, "Property state is required")
    .refine(
      (v) => VALID_US_STATES.includes(v as any),
      { message: "Please select a valid US state" }
    ),

  // VA residual-income inputs — required for veterans (enforced in the
  // superRefine below); routed into the funnel only on the VA path.
  householdFamilySize: z.string()
    .refine(
      (v) => { if (!v) return true; const n = parseInt(v); return !isNaN(n) && n >= 1 && n <= 20; },
      { message: "Household size must be between 1 and 20" }
    )
    .optional(),
  homeSquareFootage: z.string()
    .refine(
      (v) => { if (!v) return true; const n = parseInt(v); return !isNaN(n) && n >= 100 && n <= 50000; },
      { message: "Home square footage must be between 100 and 50,000" }
    )
    .optional(),
});

export type PreApprovalFormData = z.infer<typeof preApprovalFormBaseSchema>;

// Exported for the derived schemas in shared/schema/lendingUrla.ts (see above).
export const downPaymentWithinPurchasePrice = (
  // `null` is admitted because the draft-update schema lets a borrower CLEAR
  // either figure (CLEARABLE_INTAKE_FIELDS, shared/intakeClearable.ts).
  // The falsy guard below already handled it; only the type was too narrow,
  // and widening it here is what keeps that check honest rather than casting
  // at the call site.
  data: { downPayment?: string | null; purchasePrice?: string | null },
  ctx: z.RefinementCtx,
) => {
  // A cleared figure has nothing to compare against — the pair is only
  // meaningful when both are present, exactly as when neither was answered yet.
  if (!data.downPayment || !data.purchasePrice) return;
  const dp = parseFloat(data.downPayment.replace(/[,$]/g, ""));
  const pp = parseFloat(data.purchasePrice.replace(/[,$]/g, ""));
  if (!isNaN(dp) && !isNaN(pp) && dp > pp) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Down payment cannot be more than the purchase price",
      path: ["downPayment"],
    });
  }
};

/**
 * `annualIncome` is the borrower's one household total. `incomeSources` is a
 * breakdown of amounts already inside that total, not extra income to add to
 * it. Rejecting a breakdown above the total prevents an internally
 * contradictory file and keeps downstream estimates aligned.
 */
export const incomeBreakdownWithinHouseholdTotal = (
  data: { annualIncome?: string | null; incomeSources?: Array<{ annualAmount?: string | null }> | null },
  ctx: z.RefinementCtx,
) => {
  if (!data.annualIncome || !data.incomeSources?.length) return;
  if (incomeBreakdownExceedsHouseholdTotal(data.annualIncome, data.incomeSources)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Your income breakdown is higher than your household total. Update one of the amounts so income is not counted twice.",
      path: ["incomeSources"],
    });
  }
};

/** Pure companion used when a draft PATCH carries only one side of the
 * household-total/breakdown relationship. The route can compare that update
 * with the value already stored without manufacturing a full application. */
export function incomeBreakdownExceedsHouseholdTotal(
  annualIncome: string | number | null | undefined,
  incomeSources: Array<{ annualAmount?: string | number | null }> | null | undefined,
): boolean {
  if (annualIncome === null || annualIncome === undefined || !incomeSources?.length) return false;
  const total = parseFloat(String(annualIncome).replace(/[,$]/g, ""));
  const detailed = incomeSources.reduce((sum, source) => {
    const amount = parseFloat(String(source.annualAmount ?? "").replace(/[,$]/g, ""));
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  return Number.isFinite(total) && total > 0 && detailed > total;
}

export const complexIncomeDetailsPresent = (
  data: { incomeSources?: Array<{ type?: string; employerName?: string; yearsInRole?: string; businessStructure?: string; ownershipPercent?: string }> | null },
  ctx: z.RefinementCtx,
) => {
  for (const [index, source] of (data.incomeSources ?? []).entries()) {
    if (source.type !== "self_employed") continue;
    if (!source.employerName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter the business or payer name",
        path: ["incomeSources", index, "employerName"],
      });
    }
    if (!source.yearsInRole?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter how many years you have received income from this business or payer",
        path: ["incomeSources", index, "yearsInRole"],
      });
    }
    if (!source.businessStructure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select the business or income type",
        path: ["incomeSources", index, "businessStructure"],
      });
    }
    if (!source.ownershipPercent?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter your ownership percentage, or 0 for a 1099 payer you do not own",
        path: ["incomeSources", index, "ownershipPercent"],
      });
    }
  }
};

// The VA residual-income evaluation (underwritingEngine) cannot run without
// household size and square footage — require both for veterans.
const vaResidualInputsPresent = (
  data: { isVeteran?: boolean; householdFamilySize?: unknown; homeSquareFootage?: unknown },
  ctx: z.RefinementCtx,
) => {
  if (!data.isVeteran) return;
  if (!data.householdFamilySize) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Household size is required for VA loan eligibility",
      path: ["householdFamilySize"],
    });
  }
  if (!data.homeSquareFootage) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Home square footage is required for VA loan eligibility",
      path: ["homeSquareFootage"],
    });
  }
};

export const preApprovalFormSchema = preApprovalFormBaseSchema.superRefine(
  (data, ctx) => {
    downPaymentWithinPurchasePrice(data, ctx);
    incomeBreakdownWithinHouseholdTotal(data, ctx);
    complexIncomeDetailsPresent(data, ctx);
    vaResidualInputsPresent(data, ctx);
    if (!data.occupancyType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Please tell us how you will use this home",
        path: ["occupancyType"],
      });
    }
    if (data.propertyType === "multi_family") {
      const units = parseInt(data.numberOfUnits ?? "", 10);
      if (!Number.isFinite(units) || units < 2 || units > 4) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Please enter the number of units (2 to 4)",
          path: ["numberOfUnits"],
        });
      }
    }
    if (
      (data.propertyType === "multi_family" || data.occupancyType === "investment") &&
      !data.subjectMonthlyRentalIncome
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Please enter the expected monthly rent, or 0 if none is expected",
        path: ["subjectMonthlyRentalIncome"],
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Wire-format intake schema — the SERVER-side validation for the same payload
// the funnel validates client-side. Derived from preApprovalFormBaseSchema so
// the two can never drift: the server rejects exactly what the client
// rejects. (The old server-local schema silently clamped out-of-range values
// — credit score 900 became 850, employmentYears NaN became 0 — turning
// validation errors into fabricated data.)
// ---------------------------------------------------------------------------

/** The credit bands the funnel collects; "not_sure" maps to the named default. */
export const CREDIT_SCORE_BAND_VALUES = ["760", "720", "680", "640", "600", "not_sure"] as const;
/**
 * Midpoint used when the borrower doesn't know their score. Explicit and
 * named — not a silent clamp. The figure stays `self_reported` provenance
 * until a real credit pull replaces it (see shared/dataProvenance.ts).
 */
export const CREDIT_SCORE_UNKNOWN_DEFAULT = 680;
