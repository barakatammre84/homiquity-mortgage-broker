// The pre-approval funnel's "Live Analysis" math, extracted from
// AdvisoryPanel.tsx per the house rule that calculator math lives in a pure
// client/src/lib module with a colocated test (see mortgage-calculations
// skill; affordabilityEstimate.ts is the shape).
//
// This is an ILLUSTRATIVE borrower-facing estimate, not underwriting: it sums
// the amounts the borrower typed, at the advertised rate, with the platform's
// standard tax/insurance and PMI illustration figures. Underwriting treatment
// of income (e.g. rental vacancy factors) belongs to the server engines and
// requires a guideline citation — never add such a factor here.
import { monthlyPrincipalAndInterest } from "@shared/lib/amortization";
import { type PreApprovalFormData } from "@shared/schema";
import type { IncomeSourceEntry } from "@shared/preApprovalForm";

// 1.25%/yr of price is the platform-standard taxes+insurance estimate
// (server/services/preUnderwriting.ts TAX_INSURANCE_ANNUAL_PCT — server-only
// module, so the value is mirrored here). It never included PMI.
const TAX_INSURANCE_ANNUAL_PCT = 0.0125;

// Illustrative conventional PMI, same 0.5%/yr-of-loan figure as ScenarioDesk's
// conventional branch.
const PMI_ANNUAL_PCT = 0.005;

/** The advertised-rate fallback when /api/mortgage-rates hasn't answered —
 * labeled "illustrative" in the panel's disclaimer. */
export const ILLUSTRATIVE_RATE_PCT = 6.5;

/** Parse a comma/dollar-masked currency string ("2,500", "$450,000") to a
 * number; anything unparseable is 0. Same tolerance the panel always used. */
export function parseMaskedAmount(raw: string | undefined | null): number {
  return parseFloat(String(raw || "").replace(/[^0-9.]/g, "")) || 0;
}

/** Total annual amount across additional income sources. Rental entries carry
 * their annualAmount derived from monthly rents (IncomeSourcesStep's
 * withDerivedRentalAmount), so summing annualAmount covers every type. */
export function sumIncomeSourcesAnnual(sources: IncomeSourceEntry[] | undefined): number {
  if (!sources || sources.length === 0) return 0;
  let total = 0;
  for (const src of sources) {
    total += parseMaskedAmount(src.annualAmount);
  }
  return total;
}

/** Total monthly debt service the borrower reported on rental properties.
 * These are real recurring obligations and belong on the debt side of DTI
 * alongside monthlyDebts. */
export function sumRentalMonthlyDebts(sources: IncomeSourceEntry[] | undefined): number {
  if (!sources || sources.length === 0) return 0;
  let total = 0;
  for (const src of sources) {
    for (const property of src.rentalProperties ?? []) {
      total += parseMaskedAmount(property.monthlyDebtPayment);
    }
  }
  return total;
}

export interface PreApprovalAnalysis {
  /** Base annual income + every additional source's annual amount. */
  qualifyingAnnualIncome: number;
  /** Monthly obligations used in the DTI numerator (excl. est. mortgage). */
  monthlyDebts: number;
  /** Whether the borrower has answered the monthlyDebts question yet — while
   * false the DTI is housing-heavy and the panel says so. */
  includesMonthlyDebts: boolean;
  dti: number;
  estMortgage: number;
  pmiMonthly: number;
  vaNoPmi: boolean;
  loanAmount: number;
  ltv: number;
  downPaymentPercent: number;
  estRatePct: number;
}

export function computePreApprovalAnalysis(
  formValues: PreApprovalFormData,
  advertised30YrRate: number | null,
): PreApprovalAnalysis {
  const detailedSelfEmployment =
    formValues.employmentType === "self_employed" &&
    (formValues.incomeSources ?? []).some(
      (source) => source.type === "self_employed" && parseMaskedAmount(source.annualAmount) > 0,
    );
  // `annualIncome` is the borrower's initial estimate. Self-employed borrowers
  // then break that estimate into business/1099 entries so the file can retain
  // every entity. Once that detail exists it replaces the rough estimate;
  // adding both is the optimistic double-count the detailed step is meant to
  // prevent. W-2/retired borrowers use annualIncome as their primary source
  // and the line items remain genuinely additional income.
  const income =
    (detailedSelfEmployment ? 0 : parseMaskedAmount(formValues.annualIncome)) +
    sumIncomeSourcesAnnual(formValues.incomeSources);
  // Rental debt service typed on the income-sources step is a recurring
  // obligation the borrower just told us about — it belongs in DTI the moment
  // it is entered, same as monthlyDebts.
  const debts =
    parseMaskedAmount(formValues.monthlyDebts) + sumRentalMonthlyDebts(formValues.incomeSources);
  const includesMonthlyDebts = String(formValues.monthlyDebts || "").trim() !== "";
  const price = parseMaskedAmount(formValues.purchasePrice);
  const down = parseMaskedAmount(formValues.downPayment);

  const loanAmount = price - down;
  const estRatePct = advertised30YrRate ?? ILLUSTRATIVE_RATE_PCT;
  const monthlyRate = estRatePct / 100 / 12;

  const ltv = price > 0 ? ((price - down) / price) * 100 : 0;
  // VA purchase loans carry no PMI at any LTV — the same branch the advisory
  // copy keys on. Everyone else gets PMI in the estimate when LTV > 80, so
  // "20% down avoids PMI" is true in the number, not just the copy.
  const vaNoPmi = !!formValues.isVeteran && formValues.loanPurpose === "purchase";

  let estMortgage = 0;
  let pmiMonthly = 0;
  if (loanAmount > 0 && monthlyRate > 0) {
    estMortgage = monthlyPrincipalAndInterest(loanAmount, estRatePct, 360);
    estMortgage += (price * TAX_INSURANCE_ANNUAL_PCT) / 12;
    if (!vaNoPmi && ltv > 80) {
      pmiMonthly = (loanAmount * PMI_ANNUAL_PCT) / 12;
      estMortgage += pmiMonthly;
    }
  }

  const monthlyIncome = income / 12;
  const totalMonthlyObligation = debts + estMortgage;

  const dti = monthlyIncome > 0 ? (totalMonthlyObligation / monthlyIncome) * 100 : 0;
  const downPaymentPercent = price > 0 ? (down / price) * 100 : 0;

  return {
    qualifyingAnnualIncome: income,
    monthlyDebts: debts,
    includesMonthlyDebts,
    dti,
    estMortgage,
    pmiMonthly,
    vaNoPmi,
    loanAmount,
    ltv,
    downPaymentPercent,
    estRatePct,
  };
}
