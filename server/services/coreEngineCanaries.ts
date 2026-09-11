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
      syntheticEmployment({ baseIncome: "6000", bonusIncome: "500" }, "synthetic-w2"),
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
      createdAt: null,
      incomeSource: "other",
      monthlyAmount: "400",
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
    "rental",
    "bank_statement",
    "dscr",
  ] as const;

  return firstFingerprint === secondFingerprint &&
    /^[0-9a-f]{64}$/.test(firstFingerprint) &&
    /^[0-9a-f]{64}$/.test(inputFingerprint) &&
    first.incomeBasis === "urla_line_items" &&
    first.primaryBreakdown.agencyBase === 6_000 &&
    first.primaryBreakdown.agencyVariable === 900 &&
    first.primaryBreakdown.selfEmployment > 0 &&
    first.primaryBreakdown.rentalIncomeApplied === 350 &&
    first.primaryBreakdown.rentalLiabilityApplied === 450 &&
    first.primaryMonthlyQualifyingIncome ===
      first.primaryBreakdown.agencyBase +
      first.primaryBreakdown.agencyVariable +
      first.primaryBreakdown.selfEmployment +
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
