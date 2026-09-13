import type {
  Document,
  ExtractedField,
  LoanApplication,
  OtherIncomeSource,
  UrlaAsset,
  UrlaPropertyInfo,
} from "@shared/schema";
import type { FinancialEvidenceComparison } from "@shared/financialReview";
import { classifyOtherIncomeSource } from "@shared/incomeTypes";
import { parseOccupancyType } from "@shared/occupancy";
import { fourMonthsBefore } from "./capitalGainsEvidence";
import type {
  EmploymentRelatedAssetsAnalysisInput,
  EmploymentAssetEvidence,
} from "./paths/employmentRelatedAssets";

export type EmploymentAssetPersonalInfo = {
  borrowerSequenceNumber: number | null;
  dateOfBirth: string | null;
};

export type EmploymentRelatedAssetsEvidenceInput = {
  application: LoanApplication;
  documents: Document[];
  factsByDocument: Map<string, ExtractedField[]>;
  assets: UrlaAsset[];
  otherIncome: OtherIncomeSource[];
  personalInfo: EmploymentAssetPersonalInfo[];
  propertyInfo?: Pick<UrlaPropertyInfo,
    | "subordinateFinancingExists"
    | "closedEndSubordinateBalance"
    | "helocDrawnBalance"
    | "helocCreditLimit"
  > | null;
};

export type EmploymentRelatedAssetsEvidenceResult = {
  analysis: EmploymentRelatedAssetsAnalysisInput | undefined;
  missingItems: string[];
};

function parsedDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function reviewedFact(rows: ExtractedField[], name: string) {
  return rows.find(field => field.fieldName === name && field.humanVerified);
}

function reviewedNumber(field: ExtractedField | undefined) {
  if (!field?.humanVerified) return null;
  const value = Number(field.humanCorrectedValue ?? field.valueNumeric);
  return Number.isFinite(value) ? value : null;
}

function reviewedString(field: ExtractedField | undefined) {
  if (!field?.humanVerified) return null;
  return (field.humanCorrectedValue ?? field.valueString)?.trim() || null;
}

function money(value: string | number | null | undefined) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function ageOn(dateOfBirth: string, onDate: Date) {
  const dob = parsedDate(dateOfBirth);
  if (!dob || dob > onDate) return null;
  let age = onDate.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = onDate.getUTCMonth() < dob.getUTCMonth()
    || (onDate.getUTCMonth() === dob.getUTCMonth() && onDate.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

function retirementAsset(asset: UrlaAsset) {
  return /retirement|401\s*\(?k\)?|\bira\b|\bsep\b|keogh/i.test(asset.accountType ?? "");
}

function retirementStatement(documentType: string | null | undefined) {
  return documentType === "retirement_statement"
    || documentType === "retirement_statement_401k"
    || documentType === "retirement_statement_ira";
}

export function employmentRelatedAssetsEvidenceComparisons(
  analysis: EmploymentRelatedAssetsAnalysisInput | undefined,
): FinancialEvidenceComparison[] {
  if (!analysis) return [];
  return analysis.assets.map(asset => ({
    id: `income:employment-assets:${asset.documentId}:${asset.assetId}`,
    kind: "income" as const,
    status: "match" as const,
    documentId: asset.documentId,
    verifiedFactIds: [...asset.verifiedFactIds].sort(),
    label: `Employment-related asset ${asset.assetId} net documented balance`,
    evidenceValue: asset.documentedBalance,
    calculationValue: asset.documentedBalance,
    variance: 0,
    tolerance: 0,
    detail: `The reviewed statement balance is the starting value. The workpaper then deducts the $${asset.fullDistributionPenaltyAmount.toFixed(2)} full-distribution penalty and $${asset.fundsUsedForTransaction.toFixed(2)} assigned to the transaction before amortization.`,
  }));
}

export function buildEmploymentRelatedAssetsEvidence(
  input: EmploymentRelatedAssetsEvidenceInput,
): EmploymentRelatedAssetsEvidenceResult {
  const declared = input.otherIncome.filter(source =>
    classifyOtherIncomeSource(source.incomeSource) === "employment_related_assets",
  );
  if (declared.length === 0) return { analysis: undefined, missingItems: [] };

  const missingItems: string[] = [];
  const amortizationTermMonths = input.application.loanTermMonths;
  if (!amortizationTermMonths || !Number.isInteger(amortizationTermMonths) || amortizationTermMonths <= 0) {
    missingItems.push("Select the loan term so employment-related asset income can be amortized over the actual term.");
  }
  const noteDate = parsedDate(input.application.closingDate);
  if (!noteDate) missingItems.push("Add the expected note date so borrower age and statement recency can be checked.");

  const purpose = input.application.loanPurpose === "purchase" || input.application.loanPurpose === "refinance"
    ? input.application.loanPurpose
    : null;
  if (!purpose) missingItems.push("Employment-related assets require a purchase or limited cash-out refinance; confirm the loan purpose.");
  const occupancy = parseOccupancyType(input.application.occupancyType);
  if (occupancy !== "primary_residence" && occupancy !== "second_home") {
    missingItems.push("Employment-related assets can qualify only for a principal residence or second home.");
  }

  const propertyValue = money(
    purpose === "refinance"
      ? input.application.propertyValue ?? input.application.purchasePrice
      : input.application.purchasePrice ?? input.application.propertyValue,
  );
  const downPaymentOrEquity = money(input.application.downPayment);
  const loanAmount = propertyValue !== null && downPaymentOrEquity !== null
    ? propertyValue - downPaymentOrEquity
    : null;
  const ltvPercent = propertyValue && loanAmount !== null && loanAmount >= 0
    ? Math.round((loanAmount / propertyValue) * 10_000) / 100
    : null;
  if (ltvPercent === null) missingItems.push("Add the property value and down payment or equity so LTV eligibility can be checked.");
  const subordinateAnswered = input.propertyInfo?.subordinateFinancingExists;
  if (subordinateAnswered === null || subordinateAnswered === undefined) {
    missingItems.push("Confirm whether the subject property will have a second mortgage or HELOC so CLTV and HCLTV eligibility can be checked.");
  }
  const closedEndBalance = subordinateAnswered === true
    ? money(input.propertyInfo?.closedEndSubordinateBalance)
    : 0;
  const helocDrawnBalance = subordinateAnswered === true
    ? money(input.propertyInfo?.helocDrawnBalance)
    : 0;
  const helocCreditLimit = subordinateAnswered === true
    ? money(input.propertyInfo?.helocCreditLimit)
    : 0;
  if (subordinateAnswered === true) {
    if (closedEndBalance === null || closedEndBalance < 0) missingItems.push("Add the second-mortgage balance, entering 0 when none applies.");
    if (helocDrawnBalance === null || helocDrawnBalance < 0) missingItems.push("Add the drawn HELOC balance, entering 0 when none applies.");
    if (helocCreditLimit === null || helocCreditLimit < 0) missingItems.push("Add the full HELOC credit limit, entering 0 when none applies.");
  }
  const lienRatios = propertyValue && loanAmount !== null && loanAmount >= 0
    && closedEndBalance !== null && closedEndBalance >= 0
    && helocDrawnBalance !== null && helocDrawnBalance >= 0
    && helocCreditLimit !== null && helocCreditLimit >= 0
    ? {
        ltv: Math.round((loanAmount / propertyValue) * 10_000) / 100,
        cltv: Math.round(((loanAmount + closedEndBalance + helocDrawnBalance) / propertyValue) * 10_000) / 100,
        hcltv: Math.round(((loanAmount + closedEndBalance + helocCreditLimit) / propertyValue) * 10_000) / 100,
      }
    : null;

  const verifiedDocumentIds = new Set(
    input.documents.filter(document => document.status === "verified").map(document => document.id),
  );
  const usedAssetIds = new Set<string>();
  const eligibleAssets: EmploymentAssetEvidence[] = [];

  for (const source of declared) {
    const sourceLabel = `Employment-related asset for borrower ${source.borrowerSequenceNumber ?? 1}`;
    const borrowerSequenceNumber = source.borrowerSequenceNumber ?? 1;
    const last4 = source.linkedAssetAccountLast4?.replace(/\D/g, "").slice(-4) ?? "";
    if (last4.length !== 4) {
      missingItems.push(`${sourceLabel}: select the retirement account by its account last four.`);
      continue;
    }
    const matchingAssets = input.assets.filter(asset =>
      (asset.borrowerSequenceNumber ?? 1) === borrowerSequenceNumber
      && asset.accountNumberLast4 === last4
      && retirementAsset(asset),
    );
    if (matchingAssets.length !== 1) {
      missingItems.push(`${sourceLabel}: link one eligible 401(k), IRA, SEP, Keogh, or retirement account.`);
      continue;
    }
    const asset = matchingAssets[0];
    if (usedAssetIds.has(asset.id)) {
      missingItems.push(`${sourceLabel}: the same retirement account cannot be counted twice.`);
      continue;
    }
    usedAssetIds.add(asset.id);

    if (!['individual', 'joint_with_coborrower'].includes(source.assetOwnershipType ?? "")) {
      missingItems.push(`${sourceLabel}: confirm the account is individually owned or jointly owned only with a co-borrower.`);
    }
    if (source.hasUnrestrictedAccess !== true) {
      missingItems.push(`${sourceLabel}: confirm the borrower has an unqualified and unlimited right to distribute the full account balance.`);
    }
    const penalty = money(source.fullDistributionPenaltyAmount);
    const transactionUse = money(source.fundsUsedForTransaction);
    if (penalty === null || penalty < 0) missingItems.push(`${sourceLabel}: add the full-distribution penalty amount, entering 0 when none applies.`);
    if (transactionUse === null || transactionUse < 0) missingItems.push(`${sourceLabel}: add the amount used for down payment, closing costs, and required reserves, entering 0 when none applies.`);

    const personal = input.personalInfo.find(row => (row.borrowerSequenceNumber ?? 1) === borrowerSequenceNumber);
    const borrowerAge = noteDate && personal?.dateOfBirth ? ageOn(personal.dateOfBirth, noteDate) : null;
    if (borrowerAge === null) missingItems.push(`${sourceLabel}: add the borrower's date of birth so the applicable LTV limit can be checked.`);
    if (lienRatios && borrowerAge !== null) {
      const maxLtv = borrowerAge >= 62 ? 80 : 70;
      const maximumLienRatio = Math.max(lienRatios.ltv, lienRatios.cltv, lienRatios.hcltv);
      if (maximumLienRatio > maxLtv) {
        missingItems.push(`${sourceLabel}: the maximum LTV/CLTV/HCLTV ratio of ${maximumLienRatio.toFixed(2)}% exceeds the ${maxLtv}% limit for a borrower age ${borrowerAge}.`);
      }
    }

    let evidence: EmploymentAssetEvidence | null = null;
    if (noteDate) {
      const earliest = fourMonthsBefore(noteDate);
      const candidates = input.documents
        .filter(document => verifiedDocumentIds.has(document.id) && retirementStatement(document.documentType))
        .flatMap(document => {
          const rows = input.factsByDocument.get(document.id) ?? [];
          const balanceFact = reviewedFact(rows, "closing_balance");
          const dateFact = reviewedFact(rows, "statement_period_end");
          const last4Fact = reviewedFact(rows, "account_number_last4");
          const balance = reviewedNumber(balanceFact);
          const statementEnd = parsedDate(reviewedString(dateFact));
          const documentedLast4 = reviewedString(last4Fact)?.replace(/\D/g, "").slice(-4);
          if (!balanceFact || !dateFact || !last4Fact || balance === null || !statementEnd) return [];
          if (documentedLast4 !== last4 || balance <= 0 || statementEnd > noteDate || statementEnd < earliest) return [];
          if (penalty === null || penalty < 0 || transactionUse === null || transactionUse < 0) return [];
          return [{
            assetId: asset.id,
            documentId: document.id,
            borrowerSequenceNumber,
            statementEndDate: statementEnd.toISOString().slice(0, 10),
            documentedBalance: balance,
            fullDistributionPenaltyAmount: penalty,
            fundsUsedForTransaction: transactionUse,
            netDocumentedAssets: Math.max(balance - penalty - transactionUse, 0),
            verifiedFactIds: [balanceFact.id, dateFact.id, last4Fact.id].sort(),
          }];
        })
        .sort((a, b) => b.statementEndDate.localeCompare(a.statementEndDate) || a.documentId.localeCompare(b.documentId));
      evidence = candidates[0] ?? null;
    }
    if (!evidence) {
      missingItems.push(`${sourceLabel}: add and review a current 401(k) or IRA statement tied to account ending ${last4}.`);
    } else {
      eligibleAssets.push(evidence);
    }
  }

  const uniqueMissingItems = [...new Set(missingItems)];
  if (
    uniqueMissingItems.length > 0
    || !purpose
    || !amortizationTermMonths
    || (occupancy !== "primary_residence" && occupancy !== "second_home")
    || !lienRatios
    || eligibleAssets.length !== declared.length
  ) return { analysis: undefined, missingItems: uniqueMissingItems };

  return {
    missingItems: [],
    analysis: {
      amortizationTermMonths,
      loanPurpose: purpose,
      occupancyType: occupancy,
      ltvPercent: lienRatios.ltv,
      cltvPercent: lienRatios.cltv,
      hcltvPercent: lienRatios.hcltv,
      maximumLienRatioPercent: Math.max(lienRatios.ltv, lienRatios.cltv, lienRatios.hcltv),
      assets: eligibleAssets,
      missingItems: [],
    },
  };
}
