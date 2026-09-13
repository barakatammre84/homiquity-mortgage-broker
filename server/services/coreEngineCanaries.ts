import type { EmploymentHistory, SelfEmploymentWorksheet } from "@shared/schema";
import {
  consolidatedUnderwritingEngine,
  UnderwritingError,
  type UnderwritingInput,
} from "../underwritingEngine";
import {
  computeIncomePaths,
  incomeEvaluationFingerprint,
  incomeInputsFingerprint,
  type IncomePathsCoreInput,
} from "./income/orchestrator";

function syntheticEmployment(
  overrides: Partial<EmploymentHistory>,
  id: string,
): EmploymentHistory {
  return {
    id,
    applicationId: "synthetic-core-canary",
    borrowerSequenceNumber: 1,
    employerName: null,
    employmentType: "salaried",
    isSelfEmployed: false,
    startDate: null,
    endDate: null,
    baseIncome: null,
    overtimeIncome: null,
    bonusIncome: null,
    commissionIncome: null,
    otherIncome: null,
    totalMonthlyIncome: null,
    paidInVirtualCurrency: false,
    hasKnownFutureIncomeReduction: false,
    selfEmploymentIncome: null,
    ...overrides,
  } as EmploymentHistory;
}

function syntheticScheduleCWorksheet(): SelfEmploymentWorksheet {
  return {
    version: 1,
    businessStructure: "sole_proprietorship",
    ownershipPercent: 100,
    yearsSelfEmployed: 5,
    scheduleC: {
      currentYear: {
        taxYear: 2025,
        netProfitOrLoss: 48_000,
        depreciation: 3_000,
        depletion: 0,
        amortizationOrCasualtyLoss: 0,
        businessUseOfHome: 1_200,
        mealsExclusion: 0,
        nonRecurringIncome: 0,
      },
      priorYear: {
        taxYear: 2024,
        netProfitOrLoss: 45_000,
        depreciation: 2_800,
        depletion: 0,
        amortizationOrCasualtyLoss: 0,
        businessUseOfHome: 1_000,
        mealsExclusion: 0,
        nonRecurringIncome: 0,
      },
    },
  };
}

function syntheticFinancialAnalysisInput(): IncomePathsCoreInput {
  return {
    employment: [
      syntheticEmployment({
        employerName: "Synthetic Employer",
        baseIncome: "6000",
        bonusIncome: "500",
        hasKnownFutureIncomeReduction: true,
        futureMonthlyIncome: "6000",
        futureIncomeEffectiveDate: "2026-12-01",
        futureIncomeReason: "Moving to a lower pay structure",
      }, "synthetic-w2"),
      syntheticEmployment({
        employerName: "Synthetic Side Business",
        employmentType: "self_employed",
        isSelfEmployed: true,
        selfEmploymentIncome: syntheticScheduleCWorksheet(),
      }, "synthetic-business"),
    ],
    otherIncome: [{
      id: "synthetic-other-income",
      applicationId: "synthetic-core-canary",
      borrowerSequenceNumber: 1,
      createdAt: null,
      incomeSource: "other",
      monthlyAmount: "400",
      taxTreatment: "taxable",
      nonTaxableMonthlyAmount: null,
      hasDefinedExpiration: false,
      expirationDate: null,
      paidInVirtualCurrency: false,
      linkedAssetAccountLast4: null,
      assetOwnershipType: null,
      hasUnrestrictedAccess: null,
      fullDistributionPenaltyAmount: null,
      fundsUsedForTransaction: null,
    }, {
      id: "synthetic-capital-gains",
      applicationId: "synthetic-core-canary",
      borrowerSequenceNumber: 1,
      createdAt: null,
      incomeSource: "Capital Gains",
      monthlyAmount: "0",
      taxTreatment: "taxable",
      nonTaxableMonthlyAmount: null,
      hasDefinedExpiration: false,
      expirationDate: null,
      paidInVirtualCurrency: false,
      linkedAssetAccountLast4: null,
      assetOwnershipType: null,
      hasUnrestrictedAccess: null,
      fullDistributionPenaltyAmount: null,
      fundsUsedForTransaction: null,
    }, {
      id: "synthetic-employment-assets",
      applicationId: "synthetic-core-canary",
      borrowerSequenceNumber: 1,
      createdAt: null,
      incomeSource: "Employment-Related Assets as Income",
      monthlyAmount: "0",
      taxTreatment: "taxable",
      nonTaxableMonthlyAmount: null,
      hasDefinedExpiration: false,
      expirationDate: null,
      paidInVirtualCurrency: false,
      linkedAssetAccountLast4: "5678",
      assetOwnershipType: "individual",
      hasUnrestrictedAccess: true,
      fullDistributionPenaltyAmount: "12000",
      fundsUsedForTransaction: "18000",
    }],
    rentalProperties: [
      {
        address: "Synthetic positive rental",
        monthlyRentalIncome: "1800",
        monthlyDebtPayment: "1000",
      },
      {
        address: "Synthetic rental loss",
        monthlyRentalIncome: "1000",
        monthlyDebtPayment: "1200",
      },
    ],
    applyRentalToDti: true,
    capitalGainsAnalysis: {
      borrowerSequenceNumber: 1,
      expectedTaxYears: [2025, 2024],
      years: [
        {
          taxYear: 2025,
          annualCapitalGainOrLoss: 120_000,
          form1040DocumentId: "synthetic-1040-2025",
          scheduleDDocumentId: "synthetic-schedule-d-2025",
          verifiedFactId: "synthetic-capital-fact-2025",
          signatureVerifiedFactId: "synthetic-signature-fact-2025",
        },
        {
          taxYear: 2024,
          annualCapitalGainOrLoss: 96_000,
          form1040DocumentId: "synthetic-1040-2024",
          scheduleDDocumentId: "synthetic-schedule-d-2024",
          verifiedFactId: "synthetic-capital-fact-2024",
          signatureVerifiedFactId: "synthetic-signature-fact-2024",
        },
      ],
      portfolio: {
        documentId: "synthetic-brokerage-statement",
        assetId: "synthetic-brokerage-asset",
        statementEndDate: "2026-08-31",
        currentMarketValue: 250_000,
        verifiedFactIds: ["synthetic-balance", "synthetic-date", "synthetic-last4"],
      },
      missingItems: [],
    },
    employmentRelatedAssetsAnalysis: {
      amortizationTermMonths: 360,
      loanPurpose: "purchase",
      occupancyType: "primary_residence",
      ltvPercent: 80,
      cltvPercent: 80,
      hcltvPercent: 80,
      maximumLienRatioPercent: 80,
      assets: [{
        assetId: "synthetic-retirement-asset",
        documentId: "synthetic-retirement-statement",
        borrowerSequenceNumber: 1,
        statementEndDate: "2026-08-31",
        documentedBalance: 120_000,
        fullDistributionPenaltyAmount: 12_000,
        fundsUsedForTransaction: 18_000,
        netDocumentedAssets: 90_000,
        verifiedFactIds: ["synthetic-retirement-balance", "synthetic-retirement-date", "synthetic-retirement-last4"],
      }],
      missingItems: [],
    },
  };
}

/**
 * Exercise the complete pure income orchestrator with the niche Homiquity is
 * designed for: W-2 wages, a Schedule C side business, and rentals with both a
 * positive offset and a loss. No result or synthetic value leaves this process.
 */
export function financialAnalysisCanaryPasses(): boolean {
  const input = syntheticFinancialAnalysisInput();
  const first = computeIncomePaths(input);
  const second = computeIncomePaths(input);
  const firstFingerprint = incomeEvaluationFingerprint(first);
  const secondFingerprint = incomeEvaluationFingerprint(second);
  const inputFingerprint = incomeInputsFingerprint(input);
  const paths = new Set(first.paths.map((path) => path.pathId));
  const expectedPathIds = [
    "agency_wage",
    "self_employment",
    "capital_gains",
    "employment_related_assets",
    "rental",
    "bank_statement",
    "dscr",
  ] as const;

  return firstFingerprint === secondFingerprint &&
    /^[0-9a-f]{64}$/.test(firstFingerprint) &&
    /^[0-9a-f]{64}$/.test(inputFingerprint) &&
    first.incomeBasis === "urla_line_items" &&
    first.primaryBreakdown.agencyBase === 6_000 &&
    first.primaryBreakdown.agencyVariable === 400 &&
    first.primaryBreakdown.selfEmployment > 0 &&
    first.primaryBreakdown.capitalGains === 9_000 &&
    first.primaryBreakdown.employmentRelatedAssets === 250 &&
    first.primaryBreakdown.rentalIncomeApplied === 350 &&
    first.primaryBreakdown.rentalLiabilityApplied === 450 &&
    first.primaryMonthlyQualifyingIncome ===
      first.primaryBreakdown.agencyBase +
      first.primaryBreakdown.agencyVariable +
      first.primaryBreakdown.selfEmployment +
      (first.primaryBreakdown.capitalGains ?? 0) +
      (first.primaryBreakdown.employmentRelatedAssets ?? 0) +
      first.primaryBreakdown.rentalIncomeApplied &&
    expectedPathIds.every((pathId) => paths.has(pathId));
}

const SYNTHETIC_UNDERWRITING_INPUT: UnderwritingInput = {
  requestedLoanProgram: "CONVENTIONAL",
  isVeteran: false,
  baseMonthlyIncome: 10_000,
  bonusMonthlyIncome: 0,
  existingMonthlyDebts: 500,
  originalLoanAmount: 320_000,
  contractSalesPrice: 400_000,
  appraisalValue: 400_000,
  representativeFico: 740,
  proposedPiti: 2_000,
  assets: [{ type: "CHECKING_SAVINGS", balance: 50_000 }],
  occupancyType: "primary_residence",
  numberOfUnits: 1,
  propertyType: "single_family",
  loanPurpose: "purchase",
  amortizationType: "fixed",
};

/**
 * Resolve deployed policy rows twice for a conservative synthetic conventional
 * file and require byte-identical, fingerprinted decisions. This catches a
 * missing matrix, malformed policy row, or nondeterministic engine output.
 */
export async function underwritingCanaryPasses(): Promise<boolean> {
  const first = await consolidatedUnderwritingEngine.evaluate(SYNTHETIC_UNDERWRITING_INPUT);
  const second = await consolidatedUnderwritingEngine.evaluate(SYNTHETIC_UNDERWRITING_INPUT);
  const veteranChoosingConventional = await consolidatedUnderwritingEngine.evaluate({
    ...SYNTHETIC_UNDERWRITING_INPUT,
    isVeteran: true,
  });
  const unsupported = await consolidatedUnderwritingEngine.evaluate({
    ...SYNTHETIC_UNDERWRITING_INPUT,
    requestedLoanProgram: "FHA",
  }).then(
    () => null,
    (error: unknown) => error,
  );
  return first.decision === "APPROVED" &&
    first.loanType === "CONVENTIONAL" &&
    first.calculatedLtv === 80 &&
    first.calculatedDti === 25 &&
    first.rejectionReasons.length === 0 &&
    first.reviewReasons.length === 0 &&
    veteranChoosingConventional.loanType === "CONVENTIONAL" &&
    veteranChoosingConventional.actualResidualIncome === undefined &&
    unsupported instanceof UnderwritingError &&
    unsupported.kind === "POLICY_UNSUPPORTED" &&
    /^[0-9a-f]{64}$/.test(first.resolvedPolicy.fingerprint) &&
    JSON.stringify(first) === JSON.stringify(second);
}
