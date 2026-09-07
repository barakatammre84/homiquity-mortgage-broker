import { AMORTIZATION_TYPES, PREFERRED_LOAN_TYPES } from "@shared/statusVocabularies";
import { URLA_LIABILITY_TYPES } from "@shared/liabilityTypes";
import type { AmortizationType, BorrowerDeclarations, EmploymentHistory, HmdaDemographics, IncomeSourceEntry, LoanApplication, OtherIncomeSource, PreferredLoanType, UrlaAsset, UrlaLiability, UrlaLoanDetails, UrlaPersonalInfo, UrlaPropertyInfo, User } from "@shared/schema";
import { OTHER_INCOME_LABELS } from "@shared/incomeTypes";
// SSN and account numbers are WRITE-ONLY virtual fields: the server encrypts
// them at rest and never returns the value — responses carry only ssnLast4 /
// accountNumberLast4, which the inputs surface via their placeholders.
// `ssn` is a column on UrlaPersonalInfo (write-only; the server encrypts it and
// returns only ssnLast4), so Partial already covers it — no override needed.
export type PersonalInfoForm = Partial<UrlaPersonalInfo>;
export type AssetForm = Partial<UrlaAsset> & { accountNumber?: string };
export type LiabilityForm = Partial<UrlaLiability> & { accountNumber?: string };

export interface DemographicsState {
  ethnicityHispanicLatino: boolean;
  ethnicityNotHispanicLatino: boolean;
  ethnicityNotProvided: boolean;
  raceAmericanIndian: boolean;
  raceAsian: boolean;
  raceBlack: boolean;
  raceNativeHawaiian: boolean;
  raceWhite: boolean;
  raceNotProvided: boolean;
  sexFemale: boolean;
  sexMale: boolean;
  sexNotProvided: boolean;
  age: string;
  ageNotProvided: boolean;
}

export interface BorrowerSlice {
  personalInfo: PersonalInfoForm;
  employmentRecords: Partial<EmploymentHistory>[];
  assets: AssetForm[];
  liabilities: LiabilityForm[];
  declarations: Partial<BorrowerDeclarations>;
  demographics: DemographicsState;
}

export interface SectionsPayload {
  personalInfo: PersonalInfoForm;
  employmentHistory: Partial<EmploymentHistory>[];
  assets: AssetForm[];
  liabilities: LiabilityForm[];
  declarations: Partial<BorrowerDeclarations>;
  demographics: Record<string, unknown>;
}

export interface UrlaSavePayload extends SectionsPayload {
  otherIncomeSources: Partial<OtherIncomeSource>[];
  propertyInfo: Partial<UrlaPropertyInfo>;
  /** Section 4a — loan type + amortization type (loan_applications columns). */
  loanDetails: UrlaLoanDetails;
  coApplicants?: SectionsPayload[];
}

/** Section 4a select options — labels over the shared MISMO-pinned vocabulary. */
export const LOAN_TYPE_OPTIONS: { value: PreferredLoanType; label: string }[] = [
  { value: "conventional", label: "Conventional" },
  { value: "fha", label: "FHA" },
  { value: "va", label: "VA" },
  { value: "usda", label: "USDA" },
];

export const AMORTIZATION_TYPE_OPTIONS: { value: AmortizationType; label: string }[] = [
  { value: "fixed", label: "Fixed Rate" },
  { value: "adjustable", label: "Adjustable Rate (ARM)" },
];

/**
 * Section 4a state from the application row, narrowed to the shared
 * vocabulary. The columns are free varchars historically written only by the
 * demo seed, so an out-of-vocabulary value falls back to the borrower-safe
 * defaults (conventional / fixed) — visible and editable in the form, never
 * silently submitted by the server.
 */
export const toLoanDetailsState = (
  app: Pick<LoanApplication, "preferredLoanType" | "amortizationType">,
): UrlaLoanDetails => ({
  preferredLoanType: (PREFERRED_LOAN_TYPES as readonly string[]).includes(app.preferredLoanType ?? "")
    ? (app.preferredLoanType as PreferredLoanType)
    : "conventional",
  amortizationType: (AMORTIZATION_TYPES as readonly string[]).includes(app.amortizationType ?? "")
    ? (app.amortizationType as AmortizationType)
    : "fixed",
});

export const emptyDemographics = (): DemographicsState => ({
  ethnicityHispanicLatino: false,
  ethnicityNotHispanicLatino: false,
  ethnicityNotProvided: false,
  raceAmericanIndian: false,
  raceAsian: false,
  raceBlack: false,
  raceNativeHawaiian: false,
  raceWhite: false,
  raceNotProvided: false,
  sexFemale: false,
  sexMale: false,
  sexNotProvided: false,
  age: "",
  ageNotProvided: false,
});

export const emptySlice = (): BorrowerSlice => ({
  personalInfo: {},
  employmentRecords: [{}],
  assets: [{}],
  liabilities: [{}],
  declarations: {},
  demographics: emptyDemographics(),
});

/** Reuse the identity the borrower just supplied at signup. Real URLA values win. */
export function prefillPrimaryPersonalInfo(
  existing: UrlaPersonalInfo | undefined,
  user: Pick<User, "firstName" | "lastName" | "email"> | undefined,
): PersonalInfoForm {
  const savedValueOr = (value: string | null | undefined, fallback: string | null | undefined) =>
    value?.trim() ? value : fallback ?? "";
  return {
    ...existing,
    firstName: savedValueOr(existing?.firstName, user?.firstName),
    lastName: savedValueOr(existing?.lastName, user?.lastName),
    email: savedValueOr(existing?.email, user?.email),
  };
}

function monthlyFromAnnual(value: unknown): string {
  const annual = parseFloat(String(value ?? "").replace(/[,$]/g, ""));
  if (!Number.isFinite(annual) || annual <= 0) return "";
  return (annual / 12).toFixed(2).replace(/\.00$/, "");
}

/** Keep the borrower's intended job order stable across database refetches. */
export function orderEmploymentRecords(
  records: EmploymentHistory[],
): EmploymentHistory[] {
  const rank = (record: EmploymentHistory) => {
    if (record.employmentType === "current") return 0;
    if (record.employmentType === "additional") return 1;
    if (record.employmentType === "previous") return 2;
    return 3;
  };
  return [...records].sort((left, right) => rank(left) - rank(right));
}

/**
 * Bridge the short intake into URLA state. The old form rendered application
 * fallbacks inside empty inputs, so Save discarded what the borrower could see.
 * These rows are real controlled state and therefore survive the first save.
 */
export function prefillPrimaryEmployment(
  existing: EmploymentHistory[],
  app: LoanApplication,
): Partial<EmploymentHistory>[] {
  if (existing.length > 0) return orderEmploymentRecords(existing);

  const selfEmployedSources = (Array.isArray(app.incomeSources) ? app.incomeSources : [])
    .filter((source): source is IncomeSourceEntry => {
      const candidate = source as Partial<IncomeSourceEntry> | null;
      return !!candidate && candidate.type === "self_employed";
    });

  if (app.employmentType === "self_employed" && selfEmployedSources.length > 0) {
    return selfEmployedSources.map((source, index) => ({
      employmentType: index === 0 ? "current" : "additional",
      employerName: source.employerName ?? "",
      yearsInLineOfWork: source.yearsInRole ? parseInt(source.yearsInRole, 10) || 0 : null,
      isSelfEmployed: true,
      baseIncome: monthlyFromAnnual(source.annualAmount),
      borrowerSequenceNumber: 1,
    }));
  }

  return [{
    employmentType: "current",
    employerName: app.employerName ?? "",
    yearsInLineOfWork: app.employmentYears ?? null,
    isSelfEmployed: app.employmentType === "self_employed",
    baseIncome: monthlyFromAnnual(app.annualIncome),
    borrowerSequenceNumber: 1,
  }];
}

export const hmdaToState = (h: HmdaDemographics): DemographicsState => ({
  ethnicityHispanicLatino: !!h.ethnicityHispanicLatino,
  ethnicityNotHispanicLatino: !!h.ethnicityNotHispanicLatino,
  ethnicityNotProvided: !!h.ethnicityNotProvided,
  raceAmericanIndian: !!h.raceAmericanIndian,
  raceAsian: !!h.raceAsian,
  raceBlack: !!h.raceBlack,
  raceNativeHawaiian: !!h.raceNativeHawaiian,
  raceWhite: !!h.raceWhite,
  raceNotProvided: !!h.raceNotProvided,
  sexFemale: !!h.sexFemale,
  sexMale: !!h.sexMale,
  sexNotProvided: !!h.sexNotProvided,
  age: h.age != null ? String(h.age) : "",
  ageNotProvided: !!h.ageNotProvided,
});

export const demographicsToPayload = (d: DemographicsState): Record<string, unknown> => ({
  ethnicityHispanicLatino: d.ethnicityHispanicLatino,
  ethnicityNotHispanicLatino: d.ethnicityNotHispanicLatino,
  ethnicityNotProvided: d.ethnicityNotProvided,
  raceAmericanIndian: d.raceAmericanIndian,
  raceAsian: d.raceAsian,
  raceBlack: d.raceBlack,
  raceNativeHawaiian: d.raceNativeHawaiian,
  raceWhite: d.raceWhite,
  raceNotProvided: d.raceNotProvided,
  sexFemale: d.sexFemale,
  sexMale: d.sexMale,
  sexNotProvided: d.sexNotProvided,
  age: d.ageNotProvided ? null : (d.age ? parseInt(d.age) : null),
  ageNotProvided: d.ageNotProvided,
});

export const DECLARATION_QUESTIONS: { key: keyof BorrowerDeclarations; label: string }[] = [
  { key: "willOccupyAsPrimaryResidence", label: "A. Will you occupy the property as your primary residence?" },
  { key: "hasOwnershipInterestInPast3Years", label: "B. Have you had an ownership interest in another property in the last three years?" },
  { key: "isBorrowingForDownPayment", label: "C. Is any part of the down payment borrowed?" },
  { key: "hasCoMakerEndorser", label: "D. Are you a co-maker or endorser on a note?" },
  { key: "hasOutstandingJudgments", label: "E. Are there any outstanding judgments against you?" },
  { key: "isDelinquentOnFederalDebt", label: "F. Are you currently delinquent or in default on a federal debt?" },
  { key: "isPartyToLawsuit", label: "G. Are you a party to a lawsuit in which you may have liability?" },
  { key: "hasConveyedTitleInLieuOfForeclosure", label: "H. Have you conveyed title in lieu of foreclosure in the past 7 years?" },
  { key: "hasCompletedShortSale", label: "I. Have you completed a pre-foreclosure sale or short sale in the past 7 years?" },
  { key: "hasBeenForeclosed", label: "J. Have you had property foreclosed upon in the past 7 years?" },
  { key: "hasDeclaredBankruptcy", label: "K. Have you declared bankruptcy in the past 7 years?" },
];

export const ACCOUNT_TYPES = [
  "Checking", "Savings", "Money Market", "Certificate of Deposit",
  "Mutual Fund", "Stocks", "Stock Options", "Bonds",
  "Retirement (e.g., 401k, IRA)", "Bridge Loan Proceeds",
  "Individual Development Account", "Trust Account",
  "Cash Value of Life Insurance"
];

// The picker's labels moved to `shared/liabilityTypes.ts` so the server can
// READ what this picker writes (the column is free text): the engine's
// B3-6-05 branches were matching a vocabulary this list never produced.
// Re-exported under the original name; the strings are byte-identical.
export const LIABILITY_TYPES: readonly string[] = URLA_LIABILITY_TYPES;

// Section 1e income sources. The list itself moved to `shared/incomeTypes.ts`
// so the server can READ what this picker writes: the column behind it is a
// free-text varchar, and until the catalog existed nothing downstream could
// tell Social Security from Child Support — so the engine summed every source
// at face value. Re-exported under the original name; the strings are byte-
// identical, so no stored row changes meaning.
export const INCOME_SOURCES = OTHER_INCOME_LABELS;
