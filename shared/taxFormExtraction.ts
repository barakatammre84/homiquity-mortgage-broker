import { z } from "zod";

/**
 * Tax-form extraction contract — the Situation Identification Engine's shared
 * language (UAL program P2a).
 *
 * One catalog (TAX_FORM_FIELD_CATALOG) is the single source of truth for what
 * the extractor may read off each IRS form. From it we derive:
 *   - the Zod schemas that validate untrusted model output (per-field
 *     {value, confidence} pairs; invalid values are DROPPED, never defaulted);
 *   - the persistence typing for the extracted_fields table
 *     (valueNumeric vs valueString vs valueBoolean);
 *   - the extraction prompt's field list (the `description` doubles as the
 *     instruction line shown to the model).
 *
 * Doctrine (binding, from kb/specs/UNIVERSAL_ADAPTATION_LAYER_PROGRAM.md):
 *   - AI READS documents; only deterministic, cited math QUALIFIES. Nothing in
 *     this module is an underwriting input until a human confirms it (MR-2 /
 *     L2 I1 — AI never promotes to verified).
 *   - A missing value is a missing value: no field is ever silently defaulted.
 *   - Field descriptions reference the LABEL TEXT printed on the form, not
 *     line numbers. The authoritative form/line map is a P2b deliverable
 *     (docs/irs-forms/); tie-out math may only cite lines once that lands
 *     (no citation, no implementation — L2 I2).
 *   - PII minimization: EINs are captured as last-4 only, mirroring the
 *     bank-account discipline in server/extractionService.ts.
 */

// ---------------------------------------------------------------------------
// Form taxonomy (the tax-form subset of DOCUMENT_TYPE_TAXONOMY)
// ---------------------------------------------------------------------------

export const TAX_FORM_TYPES = [
  "tax_return_1040",
  "schedule_1",
  "schedule_b",
  "schedule_c",
  "schedule_d",
  "schedule_e",
  "schedule_k1",
  "business_tax_return_1065",
  "business_tax_return_1120s",
  "business_tax_return_1120",
  "form_8825",
  "form_4562",
  "w2",
  "1099_nec",
  "1099_misc",
] as const;

export type TaxFormType = (typeof TAX_FORM_TYPES)[number];

/** K-1s come in two flavors with different boxes; the classifier tags which. */
export const K1_VARIANTS = ["1065", "1120s"] as const;
export type K1Variant = (typeof K1_VARIANTS)[number];

// ---------------------------------------------------------------------------
// Field catalog
// ---------------------------------------------------------------------------

export type TaxFieldKind =
  | "currency" // >= 0 dollars
  | "signedCurrency" // dollars, may be negative (losses)
  | "integer" // small counts (properties, partners, shareholders)
  | "percent" // 0–100
  | "text" // short free text (names, activities)
  | "naics" // 6-digit business activity code
  | "einLast4" // last 4 digits of an EIN — PII-minimized
  | "boolean";

export interface TaxFieldSpec {
  kind: TaxFieldKind;
  /** Instruction line for the model AND human-readable field meaning. Refers to label text on the form, never line numbers. */
  description: string;
}

const currency = (description: string): TaxFieldSpec => ({ kind: "currency", description });
const signed = (description: string): TaxFieldSpec => ({ kind: "signedCurrency", description });
const integer = (description: string): TaxFieldSpec => ({ kind: "integer", description });
const percent = (description: string): TaxFieldSpec => ({ kind: "percent", description });
const text = (description: string): TaxFieldSpec => ({ kind: "text", description });
const naics = (description: string): TaxFieldSpec => ({ kind: "naics", description });
const einLast4 = (description: string): TaxFieldSpec => ({ kind: "einLast4", description });
const bool = (description: string): TaxFieldSpec => ({ kind: "boolean", description });

/**
 * Schedule L balance-sheet components shared by the 1065 and 1120-S business
 * returns. Captured because the K-1 income usability test (Fannie B3-3.6-07,
 * implemented in server/services/selfEmploymentIncome.ts) needs a quick/current
 * liquidity ratio — these are its raw ingredients, offered to the borrower as
 * smart-fill drafts (P5), never used directly.
 */
const SCHEDULE_L_FIELDS: Record<string, TaxFieldSpec> = {
  scheduleLCashEndOfYear: currency("Balance sheet (Schedule L): cash, end of tax year"),
  scheduleLReceivablesEndOfYear: currency(
    "Balance sheet (Schedule L): trade notes and accounts receivable (net), end of tax year",
  ),
  scheduleLInventoriesEndOfYear: currency("Balance sheet (Schedule L): inventories, end of tax year"),
  scheduleLTotalAssetsEndOfYear: currency("Balance sheet (Schedule L): total assets, end of tax year"),
  scheduleLAccountsPayableEndOfYear: currency(
    "Balance sheet (Schedule L): accounts payable, end of tax year",
  ),
  scheduleLShortTermDebtEndOfYear: currency(
    "Balance sheet (Schedule L): mortgages, notes, bonds payable in less than 1 year, end of tax year",
  ),
  scheduleLOtherCurrentLiabilitiesEndOfYear: currency(
    "Balance sheet (Schedule L): other current liabilities, end of tax year",
  ),
  scheduleLTotalLiabilitiesEndOfYear: currency(
    "Balance sheet (Schedule L): total liabilities, end of tax year",
  ),
};

/**
 * What the extractor may read from each form. Every field is optional in the
 * model response; a field the model cannot see clearly must be omitted or null
 * with low confidence — the schemas drop anything else.
 */
export const TAX_FORM_FIELD_CATALOG: Record<TaxFormType, Record<string, TaxFieldSpec>> = {
  tax_return_1040: {
    taxpayerName: text("Primary taxpayer name as printed at the top of the return"),
    spouseName: text("Spouse name if filing jointly"),
    signatureEvidencePresent: bool(
      "True only when the return includes visible taxpayer signature or electronic-signature evidence; otherwise false",
    ),
    filingStatus: text("Filing status checkbox: single, married_filing_jointly, married_filing_separately, head_of_household, qualifying_surviving_spouse"),
    wagesSalariesTips: currency("Total wages, salaries, tips (the W-2 wage entry on page 1)"),
    taxableInterest: currency("Taxable interest income"),
    ordinaryDividends: currency("Ordinary dividends"),
    capitalGainOrLoss: signed("Capital gain or (loss) reported on page 1"),
    additionalIncomeFromSchedule1: signed("Additional income from Schedule 1 reported on page 1"),
    totalIncome: signed("Total income"),
    adjustedGrossIncome: signed("Adjusted gross income"),
    taxableIncome: currency("Taxable income"),
  },
  schedule_1: {
    businessIncomeOrLoss: signed("Business income or (loss) — the amount carried from Schedule C"),
    rentalRealEstatePartnershipsSCorpsIncomeOrLoss: signed(
      "Rental real estate, royalties, partnerships, S corporations, trusts — the amount carried from Schedule E",
    ),
    unemploymentCompensation: currency("Unemployment compensation"),
    otherIncomeTotal: signed("Other income total"),
    additionalIncomeTotal: signed("Total additional income (Part I total)"),
    adjustmentsToIncomeTotal: currency("Total adjustments to income (Part II total)"),
  },
  schedule_b: {
    taxableInterestTotal: currency("Part I total taxable interest"),
    ordinaryDividendsTotal: currency("Part II total ordinary dividends"),
  },
  schedule_c: {
    businessName: text("Name of proprietor's business (or proprietor if no separate name)"),
    principalBusinessOrProfession: text("Principal business or profession, including product or service"),
    businessCodeNaics: naics("The 6-digit principal business activity code box"),
    grossReceipts: currency("Gross receipts or sales"),
    grossIncome: signed("Gross income (Part I total)"),
    totalExpenses: currency("Total expenses (Part II total)"),
    netProfitOrLoss: signed("Net profit or (loss) — the bottom-line figure carried to Schedule 1"),
    depreciationAndSection179: currency("Depreciation and section 179 expense deduction (Part II)"),
    depletion: currency("Depletion (Part II)"),
    deductibleMeals: currency("Deductible meals (Part II)"),
    wagesPaid: currency("Wages (less employment credits) paid to employees (Part II)"),
    mortgageInterestPaid: currency("Interest: mortgage (paid to banks, etc.) (Part II)"),
    businessUseOfHomeExpenses: currency("Expenses for business use of your home (after Part II total)"),
    otherExpensesTotal: currency("Total other expenses (Part V total carried into Part II)"),
    amortizationInOtherExpenses: currency(
      "Any line item labeled amortization inside the Part V other-expenses detail",
    ),
    casualtyLossInOtherExpenses: currency(
      "Any line item labeled casualty loss inside the Part V other-expenses detail",
    ),
  },
  schedule_d: {
    netShortTermCapitalGainOrLoss: signed("Net short-term capital gain or (loss) (Part I total)"),
    netLongTermCapitalGainOrLoss: signed("Net long-term capital gain or (loss) (Part II total)"),
    totalCapitalGainOrLoss: signed("Part III combined total capital gain or (loss)"),
  },
  schedule_e: {
    propertyCount: integer("Number of Part I property columns that contain data"),
    rentsReceivedTotal: currency("Sum of rents received across all Part I property columns"),
    totalExpensesTotal: currency("Sum of total expenses across all Part I property columns"),
    depreciationTotal: currency("Sum of depreciation expense or depletion across all Part I property columns"),
    mortgageInterestTotal: currency("Sum of mortgage interest paid to banks across all Part I property columns"),
    netRentalRealEstateIncomeOrLoss: signed(
      "Part I total rental real estate and royalty income or (loss)",
    ),
    partnershipSCorpIncomeOrLossTotal: signed(
      "Part II total partnership and S corporation income or (loss)",
    ),
  },
  schedule_k1: {
    entityName: text("Name of the partnership or S corporation issuing this K-1"),
    entityEinLast4: einLast4("LAST 4 DIGITS ONLY of the issuing entity's EIN"),
    partnerOrShareholderName: text("Name of the partner or shareholder receiving this K-1"),
    ordinaryBusinessIncomeOrLoss: signed("Box: ordinary business income (loss)"),
    netRentalRealEstateIncomeOrLoss: signed("Box: net rental real estate income (loss)"),
    otherNetRentalIncomeOrLoss: signed("Box: other net rental income (loss)"),
    guaranteedPayments: currency(
      "Box labeled 'Total guaranteed payments' (partnership K-1 only; omit for S corporation)",
    ),
    interestIncome: currency("Box: interest income"),
    ordinaryDividends: currency("Box: ordinary dividends"),
    distributionsTotal: currency("Box: distributions (cash and property) to this partner/shareholder"),
    ownershipPercentEndOfYear: percent(
      "Ending profit/capital percentage (partnership) or stock-ownership percentage (S corporation)",
    ),
  },
  business_tax_return_1065: {
    entityName: text("Partnership name as printed at the top of the return"),
    entityEinLast4: einLast4("LAST 4 DIGITS ONLY of the partnership's EIN"),
    businessCodeNaics: naics("The 6-digit principal business activity code box"),
    grossReceipts: currency("Gross receipts or sales"),
    totalIncome: signed("Total income (loss) (page 1 income total)"),
    totalDeductions: currency("Total deductions (page 1 deductions total)"),
    ordinaryBusinessIncomeOrLoss: signed("Ordinary business income (loss) (page 1 bottom line)"),
    guaranteedPaymentsToPartners: currency("Guaranteed payments to partners (deductions section)"),
    depreciationDeduction: currency("Depreciation deduction claimed on page 1 (net of amounts on other forms)"),
    numberOfSchedulesK1Attached: integer("Number of Schedules K-1 attached (Schedule B question)"),
    distributionsTotal: currency("Schedule K: total distributions of cash and property to partners"),
    ...SCHEDULE_L_FIELDS,
  },
  business_tax_return_1120s: {
    entityName: text("S corporation name as printed at the top of the return"),
    entityEinLast4: einLast4("LAST 4 DIGITS ONLY of the corporation's EIN"),
    businessCodeNaics: naics("The 6-digit principal business activity code box"),
    grossReceipts: currency("Gross receipts or sales"),
    totalIncome: signed("Total income (loss) (page 1 income total)"),
    totalDeductions: currency("Total deductions (page 1 deductions total)"),
    ordinaryBusinessIncomeOrLoss: signed("Ordinary business income (loss) (page 1 bottom line)"),
    compensationOfOfficers: currency("Compensation of officers (deductions section)"),
    depreciationDeduction: currency("Depreciation deduction claimed on page 1 (net of amounts on other forms)"),
    numberOfShareholders: integer("Number of shareholders during the tax year (Schedule B question)"),
    distributionsTotal: currency("Schedule K: total distributions (cash and property) to shareholders"),
    ...SCHEDULE_L_FIELDS,
  },
  business_tax_return_1120: {
    entityName: text("Corporation name as printed at the top of the return"),
    entityEinLast4: einLast4("LAST 4 DIGITS ONLY of the corporation's EIN"),
    grossReceipts: currency("Gross receipts or sales"),
    totalIncome: signed("Total income (page 1 income total)"),
    totalDeductions: currency("Total deductions (page 1 deductions total)"),
    taxableIncomeBeforeNolAndSpecialDeductions: signed(
      "Taxable income before net operating loss deduction and special deductions",
    ),
    depreciationDeduction: currency("Depreciation deduction claimed on page 1"),
  },
  form_8825: {
    propertyCount: integer("Number of property columns that contain data"),
    grossRentsTotal: currency("Sum of gross rents across all property columns"),
    totalExpensesTotal: currency("Sum of total expenses across all property columns"),
    depreciationTotal: currency("Sum of depreciation across all property columns"),
    mortgageInterestTotal: currency("Sum of interest expense across all property columns"),
    netIncomeOrLossTotal: signed("Net rental real estate income (loss) total for the entity"),
  },
  form_4562: {
    businessOrActivityName: text("Business or activity to which this form relates (top of form)"),
    section179Deduction: currency("Part I section 179 expense deduction"),
    totalDepreciationDeduction: currency("Part IV total depreciation (the summary total line)"),
    amortizationForThisYear: currency("Part VI amortization for this year"),
  },
  w2: {
    employerName: text("Employer's name from the employer box"),
    employeeName: text("Employee's name"),
    wagesTipsOtherComp: currency("Box 1: wages, tips, other compensation"),
  },
  "1099_nec": {
    payerName: text("Payer's name"),
    recipientName: text("Recipient's name"),
    nonemployeeCompensation: currency("Box 1: nonemployee compensation"),
  },
  "1099_misc": {
    payerName: text("Payer's name"),
    recipientName: text("Recipient's name"),
    rents: currency("Box 1: rents"),
    otherIncome: currency("Box 3: other income"),
  },
};

/**
 * Deterministic entity-name normalization used by P2b entity resolution and
 * cross-document dedupe: lowercase, strip punctuation, collapse whitespace.
 * Deliberately does NOT strip legal suffixes ("LP" vs "LLC" are different
 * entities).
 */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Forms that describe a distinct business entity (drive P2b entity resolution). */
export const ENTITY_BEARING_FORM_TYPES: readonly TaxFormType[] = [
  "schedule_c",
  "schedule_k1",
  "business_tax_return_1065",
  "business_tax_return_1120s",
  "business_tax_return_1120",
] as const;

// ---------------------------------------------------------------------------
// Untrusted-model-output validation (mirrors server/extractionService.ts:
// per-field .catch() drops, sane clamps; a bad field disappears, it never
// poisons the record)
// ---------------------------------------------------------------------------

export const TAX_EXTRACTION_MAX_MONEY = 100_000_000;
const MAX_PAGES = 500;
/** Upper bound on form instances a single classification may claim — a runaway/adversarial response is truncated, not trusted. */
export const MAX_FORM_INSTANCES = 60;

function coerceNumeric(v: unknown): unknown {
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return v ?? undefined;
}

/** Model-reported per-field confidence, clamped to [0,1]; garbage → 0 (never trusted upward). */
const confidence01 = z.preprocess(coerceNumeric, z.number().min(0).max(1)).catch(0);

const valueSchemaForKind: Record<TaxFieldKind, z.ZodTypeAny> = {
  currency: z.preprocess(coerceNumeric, z.number().finite().min(0).max(TAX_EXTRACTION_MAX_MONEY)),
  signedCurrency: z.preprocess(
    coerceNumeric,
    z.number().finite().min(-TAX_EXTRACTION_MAX_MONEY).max(TAX_EXTRACTION_MAX_MONEY),
  ),
  integer: z.preprocess(coerceNumeric, z.number().int().min(0).max(10_000)),
  percent: z.preprocess(coerceNumeric, z.number().min(0).max(100)),
  text: z.string().trim().min(1).max(200),
  naics: z
    .string()
    .trim()
    .transform((s) => s.replace(/\D/g, ""))
    .pipe(z.string().regex(/^\d{6}$/)),
  // PII minimization: whatever the model returns, only the last 4 digits survive.
  einLast4: z
    .string()
    .trim()
    .max(50)
    .transform((s) => s.replace(/\D/g, "").slice(-4))
    .pipe(z.string().regex(/^\d{4}$/)),
  boolean: z.boolean(),
};

/**
 * One extracted field: the value plus the model's own confidence in it.
 * An unparseable value drops the whole field (absent ≠ zero).
 */
function fieldValueSchema(kind: TaxFieldKind) {
  return z
    .object({
      value: valueSchemaForKind[kind].nullable(),
      confidence: confidence01,
      // A tax value without a source page is not reviewable evidence. Catching
      // at the field boundary drops only the unsupported value, never the form.
      pageNumber: z.preprocess(coerceNumeric, z.number().int().min(1).max(MAX_PAGES)),
      boundingBox: z.object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
        width: z.number().finite().min(0).max(1),
        height: z.number().finite().min(0).max(1),
      }).refine(
        (box) => box.x + box.width <= 1.001 && box.y + box.height <= 1.001,
        "Bounding box must stay within the page",
      ).optional().catch(undefined),
    })
    .optional()
    .catch(undefined);
}

export interface ExtractedFieldValue {
  value: number | string | boolean | null;
  confidence: number;
  /** 1-indexed page in the original uploaded packet. */
  pageNumber?: number;
  /** Normalized coordinates in the rendered source page when available. */
  boundingBox?: { x: number; y: number; width: number; height: number };
}

const formFieldsSchemaCache = new Map<TaxFormType, z.ZodTypeAny>();

/** Zod schema for the `fields` object of one form type (built once, cached). */
export function buildFormFieldsSchema(formType: TaxFormType): z.ZodTypeAny {
  let schema = formFieldsSchemaCache.get(formType);
  if (!schema) {
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [fieldName, spec] of Object.entries(TAX_FORM_FIELD_CATALOG[formType])) {
      shape[fieldName] = fieldValueSchema(spec.kind);
    }
    schema = z.object(shape);
    formFieldsSchemaCache.set(formType, schema);
  }
  return schema;
}

const taxYearSchema = z
  .preprocess(coerceNumeric, z.number().int().min(1990).max(2100))
  .nullable()
  .optional()
  .catch(undefined);

const pageNumberSchema = z
  .preprocess(coerceNumeric, z.number().int().min(1).max(MAX_PAGES))
  .nullable()
  .optional()
  .catch(undefined);

const warningsSchema = z.array(z.string().max(500)).max(20).optional().catch(undefined);

/**
 * Classification-pass response: which forms live where in the upload.
 * Instances the schema can't make sense of are dropped individually.
 */
export const taxDocumentClassificationSchema = z.object({
  pageCount: z.preprocess(coerceNumeric, z.number().int().min(1).max(MAX_PAGES)).nullable().optional().catch(undefined),
  forms: z
    .preprocess(
      // A runaway/adversarial response claiming hundreds of forms is truncated
      // to the cap, not discarded wholesale — the first N instances are still
      // the model's best-ordered findings.
      (v) => (Array.isArray(v) ? v.slice(0, MAX_FORM_INSTANCES) : v),
      z.array(
        z
          .object({
            formType: z.enum(TAX_FORM_TYPES),
            taxYear: taxYearSchema,
            entityName: z.string().trim().min(1).max(255).nullable().optional().catch(undefined),
            k1Variant: z.enum(K1_VARIANTS).nullable().optional().catch(undefined),
            pageStart: pageNumberSchema,
            pageEnd: pageNumberSchema,
            confidence: confidence01,
          })
          .optional()
          .catch(undefined),
      ),
    )
    .catch([])
    .transform((forms) => forms.filter((f): f is NonNullable<typeof f> => f !== undefined)),
  warnings: warningsSchema,
});

export type TaxDocumentClassification = z.infer<typeof taxDocumentClassificationSchema>;
export type ClassifiedFormInstance = TaxDocumentClassification["forms"][number];

/** Extraction-pass response for one classified form instance. */
export function buildFormExtractionResponseSchema(formType: TaxFormType) {
  return z.object({
    taxYear: taxYearSchema,
    entityName: z.string().trim().min(1).max(255).nullable().optional().catch(undefined),
    fields: buildFormFieldsSchema(formType).catch({}),
    warnings: warningsSchema,
  });
}

// ---------------------------------------------------------------------------
// The validated, persisted shape (what the API returns and P2b consumes)
// ---------------------------------------------------------------------------

export interface TaxFormInstance {
  formType: TaxFormType;
  taxYear: number | null;
  /** Business or person the form belongs to, as read off the form. */
  entityName: string | null;
  k1Variant: K1Variant | null;
  pageStart: number | null;
  pageEnd: number | null;
  /** Classifier's confidence that this form instance exists where claimed (0–1). */
  classificationConfidence: number;
  /** Validated fields; a field absent here was not readable — never assume 0. */
  fields: Record<string, ExtractedFieldValue>;
  warnings: string[];
}

/** Persistence typing bridge for extracted_fields.value_* columns. */
export function fieldValueColumn(kind: TaxFieldKind): "numeric" | "string" | "boolean" {
  switch (kind) {
    case "currency":
    case "signedCurrency":
    case "integer":
    case "percent":
      return "numeric";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

/** extracted_fields.value_type vocabulary (string, number, boolean, currency). */
export function taxFieldValueType(kind: TaxFieldKind): "currency" | "number" | "string" | "boolean" {
  switch (kind) {
    case "currency":
    case "signedCurrency":
      return "currency";
    case "integer":
    case "percent":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

/** extracted_fields.field_category bucket for a tax field. */
export function taxFieldCategory(
  fieldName: string,
  kind: TaxFieldKind,
): "income" | "asset" | "liability" | "identity" {
  if (/^scheduleL(Cash|Receivables|Inventories|TotalAssets)/.test(fieldName)) return "asset";
  if (/^scheduleL(AccountsPayable|ShortTermDebt|OtherCurrentLiabilities|TotalLiabilities)/.test(fieldName)) {
    return "liability";
  }
  if (kind === "text" || kind === "einLast4" || kind === "naics") return "identity";
  return "income";
}

/**
 * Aggregate per-field confidences into the run-level score fed to the
 * document-confidence quality gate. Deliberately conservative: the aggregate
 * is dragged down by weak fields (mean of the bottom half), because a run
 * with half its fields unreadable must not look "high confidence" on average.
 */
export function aggregateFieldConfidence(instances: TaxFormInstance[]): number {
  const all: number[] = [];
  for (const inst of instances) {
    all.push(inst.classificationConfidence);
    for (const f of Object.values(inst.fields)) all.push(f.confidence);
  }
  if (all.length === 0) return 0;
  all.sort((a, b) => a - b);
  const bottomHalf = all.slice(0, Math.max(1, Math.ceil(all.length / 2)));
  return bottomHalf.reduce((s, c) => s + c, 0) / bottomHalf.length;
}
