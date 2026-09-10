import { createHash } from "crypto";
import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { db } from "../db";
import {
  auditLogs,
  bankStatementAnalyses,
  borrowerBusinessEntities,
  creditMemoReviews,
  creditMemoVersions,
  documentLineage,
  documents,
  employmentHistory,
  extractedFields,
  financialWorkpaperReviews,
  financialWorkpaperVersions,
  loanApplications,
  logicalDocuments,
  otherIncomeSources,
  urlaAssets,
  urlaLiabilities,
  urlaPropertyInfo,
  type Document,
  type DocumentLineage,
  type EmploymentHistory,
  type LoanApplication,
  type IncomeSourceEntry,
  type RentalPropertyEntry,
  type SelfEmploymentWorksheet,
} from "@shared/schema";
import {
  FINANCIAL_WORKPAPER_TITLES,
  type BusinessLiquidityOutput,
  type CreditMemoReference,
  type CreditMemoSection,
  type CreditMemoView,
  type FinancialReviewBlocker,
  type FinancialReviewWorkspace,
  type FinancialSourceReference,
  type FinancialVerifiedFact,
  type FinancialWorkpaperInput,
  type FinancialWorkpaperKind,
  type FinancialWorkpaperOutput,
  type FinancialWorkpaperView,
} from "@shared/financialReview";
import { FINANCIAL_VERIFICATION_ROLES, isTerminalLoanAppStatus } from "@shared/loanApplicationStatus";
import { canonicalDocumentType } from "@shared/documentTypes";
import { currentDocumentVersions, assertDocumentLineageAccess, type DatabaseTransaction } from "./documentLineage";
import {
  computeIncomePaths,
  departingResidenceInput,
  estimateSubjectPitia,
  hasMortgageTypeLiability,
  incomeEvaluationFingerprint,
  incomeInputsFingerprint,
  type IncomePathsCoreInput,
} from "./income/orchestrator";
import { BANK_STATEMENT_PERIODS, type BankStatementAnalysisInput } from "./income/paths/bankStatement";
import { computeAgencyWageIncome } from "./income/paths/agencyWage";
import { computeSelfEmploymentPath } from "./income/paths/selfEmployment";
import {
  assessBusinessLiquidity,
  computeSelfEmploymentQualifyingIncome,
} from "./selfEmploymentIncome";
import { assessLiabilities, verifyAssets } from "../underwriting";
import { withPostgresTransactionRetry } from "./transactionRetry";
import { reconcileFinancialEvidence, reconcileSelfEmploymentEvidence } from "./financialEvidenceReconciliation";

export type FinancialReviewActor = { id: string; role: string };

export class FinancialReviewError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type Candidate = {
  key: string;
  kind: FinancialWorkpaperKind;
  subjectId: string;
  subjectLabel: string;
  input: FinancialWorkpaperInput;
  output: FinancialWorkpaperOutput;
  sources: FinancialSourceReference[];
  blockers: FinancialReviewBlocker[];
  dependencyKeys: string[];
  inputFingerprint: string;
};

type Loaded = Awaited<ReturnType<typeof loadCurrentAnalysis>>;

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function financialFactLabel(fieldName: string) {
  return fieldName
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, value => value.toUpperCase());
}

function normalizedType(type: string) {
  return canonicalDocumentType(type).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function relevantDocument(kind: FinancialWorkpaperKind, documentType: string) {
  const type = normalizedType(documentType);
  const income = /(^|_)(pay_stub|paystub|w2|1099|tax_return|schedule_[cek1]+|social_security|pension)/.test(type);
  if (kind === "income_summary") return income;
  if (kind === "self_employment") return income || /profit_loss|business_tax|bank_statement_business|business_bank|balance_sheet/.test(type);
  if (kind === "business_liquidity") return /business_bank|bank_statement_business|balance_sheet|business_tax|tax_return|schedule_k1/.test(type);
  if (kind === "rental_cash_flow") return /lease|schedule_e|form_8825|mortgage_statement|rent|appraisal|tax_return/.test(type);
  if (kind === "asset_reconciliation") {
    return !/business/.test(type) && /bank_statement|retirement|401k|ira|brokerage|gift_letter|asset/.test(type);
  }
  return /credit_report|mortgage_statement|heloc|auto_loan|student_loan|credit_card|liabilit/.test(type);
}

function sourceBlockers(
  sources: FinancialSourceReference[],
  relevantCurrentDocuments: Document[],
): FinancialReviewBlocker[] {
  const blockers: FinancialReviewBlocker[] = [];
  if (!sources.length) {
    blockers.push({
      code: relevantCurrentDocuments.length ? "unverified_evidence" : "missing_evidence",
      message: relevantCurrentDocuments.length
        ? "Review and accept at least one relevant source document."
        : "Add a relevant source document before approving this workpaper.",
    });
  }
  if (sources.some(source => !source.contentFingerprint)) {
    blockers.push({
      code: "missing_byte_fingerprint",
      message: "Replace legacy source evidence with a fingerprinted version before approval.",
    });
  }
  return blockers;
}

function documentSources(
  kind: FinancialWorkpaperKind,
  currentDocuments: Document[],
  lineageByDocument: Map<string, DocumentLineage>,
  factsByDocument: Map<string, Loaded["facts"]>,
  subjectMatcher?: (documentId: string) => boolean,
) {
  const relevant = currentDocuments.filter(document =>
    relevantDocument(kind, document.documentType) && (!subjectMatcher || subjectMatcher(document.id)),
  );
  const verified = relevant.filter(document => document.status === "verified");
  const sources = verified.map((document): FinancialSourceReference => {
    const lineage = lineageByDocument.get(document.id);
    const facts = factsByDocument.get(document.id) ?? [];
    const humanReviewedFacts = facts
      .filter(fact => fact.humanVerified)
      .sort((a, b) => a.fieldName.localeCompare(b.fieldName) || a.id.localeCompare(b.id));
    const verifiedFacts: FinancialVerifiedFact[] = humanReviewedFacts
      .filter(fact => fact.valueType === "currency" || fact.valueType === "number")
      .flatMap(fact => {
        const rawValue = fact.humanCorrectedValue ?? fact.valueNumeric;
        if (rawValue === null) return [];
        const value = Number(rawValue);
        if (!Number.isFinite(value)) return [];
        return [{
          id: fact.id,
          fieldName: fact.fieldName,
          value,
          valueType: fact.valueType as "currency" | "number",
          pageNumber: fact.pageNumber,
        }];
      })
      .sort((a, b) => a.fieldName.localeCompare(b.fieldName) || a.id.localeCompare(b.id));
    return {
      documentId: document.id,
      documentName: document.fileName,
      documentType: document.documentType,
      lineageId: lineage?.lineageId ?? null,
      versionNumber: lineage?.versionNumber ?? 1,
      contentFingerprint: lineage?.contentSha256 ?? null,
      status: document.status ?? "uploaded",
      subjectType: lineage?.subjectType ?? null,
      subjectId: lineage?.subjectId ?? null,
      pages: [...new Set(facts.map(fact => fact.pageNumber).filter((page): page is number => page !== null))].sort((a, b) => a - b),
      verifiedFactIds: humanReviewedFacts.map(fact => fact.id),
      verifiedFactReviewFingerprint: sha256(humanReviewedFacts.map(fact => ({
        id: fact.id,
        fieldName: fact.fieldName,
        verifiedAt: fact.verifiedAt?.toISOString() ?? null,
        corrected: fact.humanCorrectedValue !== null,
      }))),
      verifiedFacts,
    };
  }).sort((a, b) => a.documentId.localeCompare(b.documentId));
  return { sources, relevant, blockers: sourceBlockers(sources, relevant) };
}

function safeEmployment(employment: EmploymentHistory) {
  const worksheet = employment.selfEmploymentIncome;
  return {
    id: employment.id,
    borrowerSequenceNumber: employment.borrowerSequenceNumber ?? 1,
    employmentType: employment.employmentType,
    employerName: employment.employerName,
    isSelfEmployed: employment.isSelfEmployed,
    baseIncome: employment.baseIncome,
    overtimeIncome: employment.overtimeIncome,
    bonusIncome: employment.bonusIncome,
    commissionIncome: employment.commissionIncome,
    otherIncome: employment.otherIncome,
    totalMonthlyIncome: employment.totalMonthlyIncome,
    selfEmploymentIncome: worksheet ?? null,
    updatedAt: employment.updatedAt?.toISOString() ?? null,
  };
}

function candidate(
  kind: FinancialWorkpaperKind,
  subjectId: string,
  subjectLabel: string,
  subject: Record<string, unknown>,
  output: FinancialWorkpaperOutput,
  evidence: ReturnType<typeof documentSources>,
  dependencyKeys: string[] = [],
  extraBlockers: FinancialReviewBlocker[] = [],
  evidenceComparisons: FinancialWorkpaperInput["evidenceComparisons"] = [],
): Candidate {
  const input: FinancialWorkpaperInput = {
    dataVersion: 2,
    subject,
    evidenceDocumentIds: evidence.sources.map(source => source.documentId),
    verifiedFactIds: evidence.sources.flatMap(source => source.verifiedFactIds).sort(),
    evidenceComparisons,
  };
  return {
    key: `${kind}:${subjectId}`,
    kind,
    subjectId,
    subjectLabel,
    input,
    output,
    sources: evidence.sources,
    blockers: [...evidence.blockers, ...extraBlockers],
    dependencyKeys,
    inputFingerprint: "",
  };
}

export function finalizeCandidateFingerprints(candidates: Candidate[]) {
  const fingerprints = new Map<string, string>();
  for (const item of candidates) {
    const dependencyFingerprints = item.dependencyKeys.map(key => {
      const fingerprint = fingerprints.get(key);
      if (!fingerprint) throw new FinancialReviewError(`Financial dependency ${key} was not prepared in order`, 500);
      return { key, fingerprint };
    });
    item.inputFingerprint = sha256({
      key: item.key,
      input: item.input,
      output: item.output,
      sources: item.sources,
      dependencies: dependencyFingerprints,
    });
    fingerprints.set(item.key, item.inputFingerprint);
  }
  return candidates;
}

async function buildCandidates(loaded: Loaded): Promise<Candidate[]> {
  const {
    application,
    employment,
    assets,
    liabilities,
    currentDocuments,
    lineageByDocument,
    factsByDocument,
    bankStatementAnalysis,
    propertyInfo,
  } = loaded;
  const rentalProperties = ((application.incomeSources as IncomeSourceEntry[] | null) ?? [])
    .filter(source => source.type === "rental")
    .flatMap(source => source.rentalProperties ?? []);
  const evidenceComparisons = reconcileFinancialEvidence({
    documents: currentDocuments,
    factsByDocument,
    employment,
    assets,
    rentalProperties,
  });
  const incomeInput: IncomePathsCoreInput = {
    employment,
    otherIncome: loaded.otherIncome,
    rentalProperties,
    fallbackAnnualIncome: application.annualIncome,
    bankStatementAnalysis,
    // This workspace is the review that establishes decision-grade income.
    // Calculate the candidate rental treatment that the reviewer is being
    // asked to approve; keying it off the pre-review application provenance
    // made final verification change the math and instantly stale its own memo.
    applyRentalToDti: true,
    hasMortgageLiabilityRows: hasMortgageTypeLiability(liabilities),
    subjectProperty: propertyInfo
      ? {
          numberOfUnits: propertyInfo.numberOfUnits,
          occupancyType: propertyInfo.occupancyType,
          estimatedMarketRent: propertyInfo.estimatedMarketRent,
          estimatedPitia: estimateSubjectPitia(application.purchasePrice, application.downPayment),
        }
      : null,
    departingResidence: departingResidenceInput(application),
  };
  const incomeResult = computeIncomePaths(incomeInput);
  const evaluated = {
    result: incomeResult,
    inputsFingerprint: incomeInputsFingerprint(incomeInput),
    evaluationFingerprint: incomeEvaluationFingerprint(incomeResult),
  };
  const candidates: Candidate[] = [];
  const detailedKeys: string[] = [];

  for (const row of employment.filter(item => item.isSelfEmployed && item.selfEmploymentIncome)) {
    const worksheet = row.selfEmploymentIncome as SelfEmploymentWorksheet;
    const label = row.employerName || `Self-employed borrower ${row.borrowerSequenceNumber ?? 1}`;
    const employerNameKey = normalizeBusinessName(row.employerName);
    const matchedBusiness = employerNameKey
      ? loaded.businesses.find(business => normalizeBusinessName(business.name) === employerNameKey)
      : undefined;
    const businessEvidenceMatcher = (documentId: string) => {
      const lineage = lineageByDocument.get(documentId);
      if (lineage?.subjectType === "business") {
        return !!matchedBusiness && lineage.subjectId === matchedBusiness.id;
      }
      const assignedBusinesses = loaded.businessEntityIdsByDocument.get(documentId);
      // A borrower/application-scoped document with no resolved business
      // assignment cannot support one specific business workpaper. The former
      // permissive fallback attached household pay statements and unrelated
      // tax evidence to every self-employment review, causing one correction
      // to invalidate multiple businesses and weakening source attribution.
      if (!assignedBusinesses?.size) return false;
      return !!matchedBusiness && assignedBusinesses.has(matchedBusiness.id);
    };
    let liquidityKey: string | null = null;
    if (worksheet.businessStructure === "partnership" || worksheet.businessStructure === "s_corporation") {
      const evidence = documentSources("business_liquidity", currentDocuments, lineageByDocument, factsByDocument, businessEvidenceMatcher);
      const liquidity = assessBusinessLiquidity(worksheet.k1?.liquidity);
      liquidityKey = `business_liquidity:${row.id}`;
      const blockers: FinancialReviewBlocker[] = [];
      if (!worksheet.confirmedByBorrowerAt) blockers.push({ code: "unconfirmed_worksheet", message: "The borrower must confirm the self-employment worksheet before review." });
      if (liquidity.method === "unavailable") blockers.push({ code: "missing_evidence", message: "Capture current assets and liabilities from the business balance sheet." });
      candidates.push(candidate(
        "business_liquidity",
        row.id,
        label,
        { employment: safeEmployment(row), liquidity: worksheet.k1?.liquidity ?? null },
        { kind: "business_liquidity", ...(liquidity as BusinessLiquidityOutput) },
        evidence,
        [],
        blockers,
      ));
      detailedKeys.push(liquidityKey);
    }
    const evidence = documentSources("self_employment", currentDocuments, lineageByDocument, factsByDocument, businessEvidenceMatcher);
    const blockers: FinancialReviewBlocker[] = [];
    if (!worksheet.confirmedByBorrowerAt) blockers.push({ code: "unconfirmed_worksheet", message: "The borrower must confirm the self-employment worksheet before review." });
    const selfKey = `self_employment:${row.id}`;
    const selfEmploymentComparisons = matchedBusiness ? reconcileSelfEmploymentEvidence({
      documents: currentDocuments,
      forms: loaded.forms,
      factsByDocument,
      employment: row,
      businessEntityId: matchedBusiness.id,
    }) : [];
    candidates.push(candidate(
      "self_employment",
      row.id,
      label,
      { employment: safeEmployment(row) },
      {
        kind: "self_employment",
        result: computeSelfEmploymentQualifyingIncome(worksheet),
        borrowerSequenceNumber: row.borrowerSequenceNumber ?? 1,
        businessStructure: worksheet.businessStructure,
        ownershipPercent: worksheet.ownershipPercent ?? null,
      },
      evidence,
      liquidityKey ? [liquidityKey] : [],
      blockers,
      selfEmploymentComparisons,
    ));
    detailedKeys.push(selfKey);
  }

  const rental = evaluated.result.paths.find(path => path.pathId === "rental");
  if (rental?.status === "applicable") {
    const evidence = documentSources("rental_cash_flow", currentDocuments, lineageByDocument, factsByDocument);
    const key = `rental_cash_flow:${application.id}`;
    candidates.push(candidate(
      "rental_cash_flow",
      application.id,
      "Rental properties",
      {
        rentalProperties: rentalProperties.map((property: RentalPropertyEntry) => ({
          address: property.address,
          monthlyRentalIncome: property.monthlyRentalIncome,
          monthlyDebtPayment: property.monthlyDebtPayment,
        })),
        calculationBasis: "decision_grade_review_candidate",
      },
      { kind: "rental_cash_flow", result: rental },
      evidence,
      [],
      [],
      evidenceComparisons.filter(item => item.kind === "rental"),
    ));
    detailedKeys.push(key);
  }

  if (assets.length) {
    const evidence = documentSources("asset_reconciliation", currentDocuments, lineageByDocument, factsByDocument);
    const key = `asset_reconciliation:${application.id}`;
    const result = await verifyAssets(assets);
    candidates.push(candidate(
      "asset_reconciliation",
      application.id,
      "Household assets",
      {
        assets: assets.map(asset => ({
          id: asset.id,
          borrowerSequenceNumber: asset.borrowerSequenceNumber ?? 1,
          accountType: asset.accountType,
          financialInstitution: asset.financialInstitution,
          cashOrMarketValue: asset.cashOrMarketValue,
        })),
      },
      { kind: "asset_reconciliation", result, borrowerSequences: [...new Set(assets.map(asset => asset.borrowerSequenceNumber ?? 1))].sort() },
      evidence,
      [],
      [],
      evidenceComparisons.filter(item => item.kind === "asset"),
    ));
    detailedKeys.push(key);
  }

  if (liabilities.length) {
    const evidence = documentSources("liability_reconciliation", currentDocuments, lineageByDocument, factsByDocument);
    const key = `liability_reconciliation:${application.id}`;
    const result = assessLiabilities(liabilities);
    candidates.push(candidate(
      "liability_reconciliation",
      application.id,
      "Household liabilities",
      {
        liabilities: liabilities.map(liability => ({
          id: liability.id,
          borrowerSequenceNumber: liability.borrowerSequenceNumber ?? 1,
          liabilityType: liability.liabilityType,
          creditorName: liability.creditorName,
          unpaidBalance: liability.unpaidBalance,
          monthlyPayment: liability.monthlyPayment,
          toBePaidOff: liability.toBePaidOff,
          paidByOtherParty: liability.paidByOtherParty,
          otherPartyRelationship: liability.otherPartyRelationship,
          otherPartyObligated: liability.otherPartyObligated,
          otherPartyInterestedParty: liability.otherPartyInterestedParty,
          usesRentalIncomeFromProperty: liability.usesRentalIncomeFromProperty,
        })),
      },
      { kind: "liability_reconciliation", result, borrowerSequences: [...new Set(liabilities.map(liability => liability.borrowerSequenceNumber ?? 1))].sort() },
      evidence,
    ));
    detailedKeys.push(key);
  }

  const borrowerSequences = [...new Set(employment.map(row => row.borrowerSequenceNumber ?? 1))].sort();
  const borrowerBreakdown = borrowerSequences.map(sequence => {
    const rows = employment.filter(row => (row.borrowerSequenceNumber ?? 1) === sequence);
    const wage = computeAgencyWageIncome({ employment: rows, otherIncome: [], fallbackAnnualIncome: null });
    const self = computeSelfEmploymentPath(rows);
    return { borrowerSequenceNumber: sequence, monthlyIncome: round2(wage.path.monthlyQualifyingIncome + self.path.monthlyQualifyingIncome) };
  });
  const incomeEvidence = documentSources("income_summary", currentDocuments, lineageByDocument, factsByDocument);
  candidates.push(candidate(
    "income_summary",
    application.id,
    "Household",
    {
      annualIncome: application.annualIncome,
      calculationBasis: "decision_grade_review_candidate",
      employment: employment.map(safeEmployment),
      otherIncome: loaded.otherIncome.map(row => ({ id: row.id, incomeSource: row.incomeSource, monthlyAmount: row.monthlyAmount })),
      evaluationFingerprint: evaluated.evaluationFingerprint,
      inputsFingerprint: evaluated.inputsFingerprint,
    },
    { kind: "income_summary", evaluation: evaluated.result, borrowerBreakdown },
    incomeEvidence,
    detailedKeys,
    [],
    evidenceComparisons.filter(item => item.kind === "income"),
  ));

  // Dependencies always precede their dependants; the household summary is
  // last so a change to any detailed workpaper invalidates it and the memo.
  return finalizeCandidateFingerprints(candidates);
}

async function loadCurrentAnalysis(tx: DatabaseTransaction, applicationId: string, actor?: FinancialReviewActor) {
  const application = actor
    ? (await assertDocumentLineageAccess(tx, applicationId, actor)).application
    : (await tx.select().from(loanApplications).where(eq(loanApplications.id, applicationId)).limit(1))[0];
  if (!application) throw new FinancialReviewError("Application not found", 404);
  const [allDocuments, lineageRows, employment, otherIncome, assets, liabilities, latestBankStatements, propertyRows] = await Promise.all([
    tx.select().from(documents).where(eq(documents.applicationId, applicationId)),
    tx.select().from(documentLineage).where(eq(documentLineage.applicationId, applicationId)),
    tx.select().from(employmentHistory).where(eq(employmentHistory.applicationId, applicationId)).orderBy(desc(employmentHistory.createdAt), asc(employmentHistory.id)),
    tx.select().from(otherIncomeSources).where(eq(otherIncomeSources.applicationId, applicationId)).orderBy(desc(otherIncomeSources.createdAt), asc(otherIncomeSources.id)),
    tx.select().from(urlaAssets).where(eq(urlaAssets.applicationId, applicationId)).orderBy(desc(urlaAssets.createdAt), asc(urlaAssets.id)),
    tx.select().from(urlaLiabilities).where(eq(urlaLiabilities.applicationId, applicationId)).orderBy(desc(urlaLiabilities.createdAt), asc(urlaLiabilities.id)),
    tx.select().from(bankStatementAnalyses).where(eq(bankStatementAnalyses.applicationId, applicationId)).orderBy(desc(bankStatementAnalyses.createdAt), desc(bankStatementAnalyses.id)).limit(1),
    tx.select().from(urlaPropertyInfo).where(eq(urlaPropertyInfo.applicationId, applicationId)).orderBy(desc(urlaPropertyInfo.createdAt), desc(urlaPropertyInfo.id)).limit(1),
  ]);
  const groups = currentDocumentVersions(allDocuments, lineageRows);
  const currentDocuments = groups.map(group => group.current.document);
  const currentIds = currentDocuments.map(document => document.id);
  const sourceScope = currentIds.length ? inArray(logicalDocuments.sourceDocumentId, currentIds) : undefined;
  const forms = currentIds.length ? await tx.select().from(logicalDocuments).where(and(
    or(eq(logicalDocuments.loanId, applicationId), and(isNull(logicalDocuments.loanId), sourceScope)),
    or(isNull(logicalDocuments.sourceDocumentId), sourceScope),
    ne(logicalDocuments.status, "revoked"),
  )) : [];
  const formIds = forms.map(form => form.id);
  // A current business-scoped upload remains valid evidence even before a tax
  // package has produced logical forms. Union those lineage subjects with the
  // resolved form entities; both sources are already limited to this
  // application's current document versions above.
  const businessEntityIds = [...new Set([
    ...forms.flatMap(form => form.businessEntityId ? [form.businessEntityId] : []),
    ...groups.flatMap(group =>
      group.current.lineage?.subjectType === "business" && group.current.lineage.subjectId
        ? [group.current.lineage.subjectId]
        : []
    ),
  ])];
  const businesses = businessEntityIds.length
    ? await tx.select().from(borrowerBusinessEntities).where(inArray(borrowerBusinessEntities.id, businessEntityIds))
    : [];
  const documentScope = currentIds.length ? inArray(extractedFields.documentId, currentIds) : undefined;
  const formScope = formIds.length ? inArray(extractedFields.logicalDocumentId, formIds) : undefined;
  const facts = currentIds.length || formIds.length ? await tx.select().from(extractedFields).where(and(
    or(documentScope, formScope),
    or(isNull(extractedFields.documentId), documentScope),
    or(isNull(extractedFields.logicalDocumentId), formScope),
  )) : [];
  const formDocument = new Map(forms.map(form => [form.id, form.sourceDocumentId]));
  const businessEntityIdsByDocument = new Map<string, Set<string>>();
  for (const form of forms) {
    if (!form.sourceDocumentId || !form.businessEntityId) continue;
    const ids = businessEntityIdsByDocument.get(form.sourceDocumentId) ?? new Set<string>();
    ids.add(form.businessEntityId);
    businessEntityIdsByDocument.set(form.sourceDocumentId, ids);
  }
  const factsByDocument = new Map<string, typeof facts>();
  for (const fact of facts) {
    const documentId = fact.documentId ?? (fact.logicalDocumentId ? formDocument.get(fact.logicalDocumentId) : null);
    if (!documentId) continue;
    const rows = factsByDocument.get(documentId) ?? [];
    rows.push(fact);
    factsByDocument.set(documentId, rows);
  }
  const latestBankStatement = latestBankStatements[0];
  let bankStatementAnalysis: BankStatementAnalysisInput | undefined;
  if (latestBankStatement) {
    const months = latestBankStatement.months as (typeof BANK_STATEMENT_PERIODS)[number];
    if (BANK_STATEMENT_PERIODS.includes(months)) {
      bankStatementAnalysis = {
        months,
        totalEligibleDeposits: Number(latestBankStatement.totalEligibleDeposits),
        expenseFactor: latestBankStatement.expenseFactor !== null ? Number(latestBankStatement.expenseFactor) : undefined,
        hasThirdPartyExpenseStatement: latestBankStatement.hasThirdPartyExpenseStatement,
      };
    }
  }
  return {
    application,
    allDocuments,
    currentDocuments,
    lineageByDocument: new Map(lineageRows.map(row => [row.documentId, row])),
    facts,
    factsByDocument,
    forms,
    businessEntityIdsByDocument,
    businesses,
    employment,
    otherIncome,
    assets,
    liabilities,
    bankStatementAnalysis,
    bankStatementAnalysisRecord: latestBankStatement ?? null,
    propertyInfo: propertyRows[0] ?? null,
  };
}

function normalizeBusinessName(value: string | null | undefined) {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function reviewView(review: typeof financialWorkpaperReviews.$inferSelect | typeof creditMemoReviews.$inferSelect | undefined) {
  return review ? {
    action: review.action,
    reason: review.reason,
    reviewedBy: review.reviewedBy,
    reviewedAt: review.reviewedAt.toISOString(),
  } : null;
}

function workpaperBlockers(
  candidate: Candidate,
  row: typeof financialWorkpaperVersions.$inferSelect | undefined,
  latestByKey: Map<string, typeof financialWorkpaperVersions.$inferSelect>,
  reviewsByVersion: Map<string, typeof financialWorkpaperReviews.$inferSelect>,
  candidateFingerprints: Map<string, string>,
) {
  const blockers = [...candidate.blockers];
  if (row && row.inputFingerprint !== candidate.inputFingerprint) {
    blockers.push({ code: "stale_version" as const, message: "Inputs or source evidence changed. Prepare a fresh version." });
  }
  for (const dependencyKey of candidate.dependencyKeys) {
    const dependency = latestByKey.get(dependencyKey);
    const expectedFingerprint = candidateFingerprints.get(dependencyKey);
    if (!dependency || dependency.inputFingerprint !== expectedFingerprint || reviewsByVersion.get(dependency.id)?.action !== "approve") {
      blockers.push({ code: "missing_dependency" as const, message: `${FINANCIAL_WORKPAPER_TITLES[dependencyKey.split(":")[0] as FinancialWorkpaperKind]} must be current and approved first.` });
    }
  }
  return blockers;
}

async function assembleWorkspace(tx: DatabaseTransaction, applicationId: string, actor?: FinancialReviewActor): Promise<FinancialReviewWorkspace> {
  const loaded = await loadCurrentAnalysis(tx, applicationId, actor);
  const candidates = await buildCandidates(loaded);
  const candidateFingerprints = new Map(candidates.map(item => [item.key, item.inputFingerprint]));
  const [versions, reviews, memos, memoReviews] = await Promise.all([
    tx.select().from(financialWorkpaperVersions).where(eq(financialWorkpaperVersions.applicationId, applicationId)).orderBy(desc(financialWorkpaperVersions.versionNumber)),
    tx.select().from(financialWorkpaperReviews).innerJoin(financialWorkpaperVersions, eq(financialWorkpaperReviews.workpaperVersionId, financialWorkpaperVersions.id)).where(eq(financialWorkpaperVersions.applicationId, applicationId)).then(rows => rows.map(row => row.financial_workpaper_reviews)),
    tx.select().from(creditMemoVersions).where(eq(creditMemoVersions.applicationId, applicationId)).orderBy(desc(creditMemoVersions.versionNumber)),
    tx.select().from(creditMemoReviews).innerJoin(creditMemoVersions, eq(creditMemoReviews.memoVersionId, creditMemoVersions.id)).where(eq(creditMemoVersions.applicationId, applicationId)).then(rows => rows.map(row => row.credit_memo_reviews)),
  ]);
  const latestByKey = new Map<string, typeof financialWorkpaperVersions.$inferSelect>();
  for (const version of versions) if (!latestByKey.has(version.workpaperKey)) latestByKey.set(version.workpaperKey, version);
  const reviewsByVersion = new Map(reviews.map(review => [review.workpaperVersionId, review]));
  const workpapers: FinancialWorkpaperView[] = candidates.map(item => {
    const version = latestByKey.get(item.key);
    const blockers = workpaperBlockers(item, version, latestByKey, reviewsByVersion, candidateFingerprints);
    return {
      id: version?.id ?? null,
      key: item.key,
      kind: item.kind,
      title: FINANCIAL_WORKPAPER_TITLES[item.kind],
      subjectId: item.subjectId,
      subjectLabel: item.subjectLabel,
      versionNumber: version?.versionNumber ?? 0,
      inputFingerprint: version?.inputFingerprint ?? item.inputFingerprint,
      input: version?.inputSnapshot ?? item.input,
      output: version?.outputSnapshot ?? item.output,
      sources: version?.sourceReferences ?? item.sources,
      dependencyVersionIds: version?.dependencyVersionIds ?? [],
      createdAt: version?.createdAt.toISOString() ?? "",
      isCurrent: version?.inputFingerprint === item.inputFingerprint,
      blockers,
      review: version ? reviewView(reviewsByVersion.get(version.id)) : null,
    };
  });
  const currentApproved = workpapers.filter(item => item.isCurrent && item.review?.action === "approve" && item.blockers.length === 0);
  const memo = memos[0];
  const memoReviewByVersion = new Map(memoReviews.map(review => [review.memoVersionId, review]));
  const memoFingerprint = memoInputFingerprint(loaded.application, currentApproved);
  const memoBlockers: FinancialReviewBlocker[] = [];
  if (memo && memo.inputFingerprint !== memoFingerprint) memoBlockers.push({ code: "stale_version", message: "A financial workpaper or application fact changed. Build a fresh memo." });
  const canBuildMemo = currentApproved.length === candidates.length && candidates.length > 0;
  const memoView: CreditMemoView | null = memo ? {
    id: memo.id,
    versionNumber: memo.versionNumber,
    inputFingerprint: memo.inputFingerprint,
    packageHash: memo.packageHash,
    workpaperVersionIds: memo.workpaperVersionIds,
    sections: memo.sections,
    references: memo.referenceIndex,
    createdAt: memo.createdAt.toISOString(),
    isCurrent: memo.inputFingerprint === memoFingerprint,
    blockers: memoBlockers,
    review: reviewView(memoReviewByVersion.get(memo.id)),
  } : null;
  const canPrepareRole = !!actor && FINANCIAL_VERIFICATION_ROLES.includes(actor.role);
  const prepareBlockedReason = !canPrepareRole
    ? "Your role can view financial review but cannot prepare or approve it."
    : isTerminalLoanAppStatus(loaded.application.status)
      ? "This application is closed. Financial review history remains available."
      : null;
  const bankStatementDocuments = loaded.currentDocuments.filter(document =>
    document.status === "verified" && canonicalDocumentType(document.documentType) === "bank_statement",
  );
  const reviewedDepositFacts = bankStatementDocuments.flatMap(document =>
    (loaded.factsByDocument.get(document.id) ?? []).filter(fact =>
      fact.humanVerified && fact.fieldName === "total_deposits",
    ),
  );
  const observedTotalDeposits = round2(reviewedDepositFacts.reduce((sum, fact) => {
    const value = Number(fact.humanCorrectedValue ?? fact.valueNumeric);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0));
  const latestBankStatementAnalysis = loaded.bankStatementAnalysisRecord;
  return {
    applicationId,
    requiredCount: candidates.length,
    currentApprovedCount: currentApproved.length,
    canPrepare: !prepareBlockedReason,
    prepareBlockedReason,
    workpapers,
    memo: memoView,
    canBuildMemo,
    memoBlockedReason: canBuildMemo ? null : candidates.length ? "Approve every current workpaper before building the memo." : "Add financial information before building the memo.",
    bankStatementAnalysis: latestBankStatementAnalysis ? {
      id: latestBankStatementAnalysis.id,
      months: latestBankStatementAnalysis.months as 12 | 24,
      totalEligibleDeposits: Number(latestBankStatementAnalysis.totalEligibleDeposits),
      expenseFactor: latestBankStatementAnalysis.expenseFactor === null ? null : Number(latestBankStatementAnalysis.expenseFactor),
      hasThirdPartyExpenseStatement: latestBankStatementAnalysis.hasThirdPartyExpenseStatement,
      notes: latestBankStatementAnalysis.notes,
      createdAt: latestBankStatementAnalysis.createdAt.toISOString(),
    } : null,
    bankStatementEvidence: {
      documentCount: bankStatementDocuments.length,
      reviewedDepositFactCount: reviewedDepositFacts.length,
      observedTotalDeposits,
    },
  };
}

function memoInputFingerprint(application: LoanApplication, workpapers: FinancialWorkpaperView[]) {
  return sha256({
    application: {
      id: application.id,
      loanPurpose: application.loanPurpose,
      preferredLoanType: application.preferredLoanType,
      purchasePrice: application.purchasePrice,
      downPayment: application.downPayment,
      propertyType: application.propertyType,
    },
    workpapers: workpapers.map(item => ({ id: item.id, key: item.key, fingerprint: item.inputFingerprint })).sort((a, b) => a.key.localeCompare(b.key)),
  });
}

function outputSummary(workpaper: FinancialWorkpaperView) {
  const output = workpaper.output;
  if (output.kind === "income_summary") return `${money(output.evaluation.primaryMonthlyQualifyingIncome)} monthly qualifying income; ${output.borrowerBreakdown.length} borrower income profile(s).`;
  if (output.kind === "self_employment") return `${money(output.result.monthlyQualifyingIncome)} monthly; ${output.result.trend.replaceAll("_", " ")} trend${output.result.requiresManualReview ? "; officer judgment recorded by approval" : ""}.`;
  if (output.kind === "business_liquidity") return `${output.method.replaceAll("_", " ")} ${output.method === "quick_ratio" ? output.quickRatio?.toFixed(2) : output.currentRatio?.toFixed(2) ?? "unavailable"}; ${output.explanation}`;
  if (output.kind === "rental_cash_flow") return output.result.kind === "dti_income"
    ? `${money(output.result.appliedMonthlyIncome ?? 0)} monthly income and ${money(output.result.appliedMonthlyObligation ?? 0)} monthly obligation applied.`
    : `${output.result.coverageRatio?.toFixed(2) ?? "unavailable"} coverage ratio.`;
  if (output.kind === "asset_reconciliation") return `${money(output.result.totalAssets)} recorded; ${money(output.result.liquidAssets)} available after existing valuation policy.`;
  if (output.kind === "liability_reconciliation") return `${money(output.result.totalMonthlyPayment)} monthly obligations included; ${money(output.result.excludedDebts)} excluded with recorded reasons.`;
  return "Calculation recorded.";
}

function buildMemo(application: LoanApplication, workpapers: FinancialWorkpaperView[]) {
  const references: CreditMemoReference[] = [];
  const referenceKeys: string[] = [];
  for (const workpaper of workpapers) {
    const key = `workpaper:${workpaper.id}`;
    references.push({ type: "workpaper", id: workpaper.id!, label: `${workpaper.title} · ${workpaper.subjectLabel} · v${workpaper.versionNumber}` });
    referenceKeys.push(key);
    for (const source of workpaper.sources) {
      const documentKey = `document:${source.documentId}`;
      if (!references.some(reference => `${reference.type}:${reference.id}` === documentKey)) {
        references.push({
          type: "document",
          id: source.documentId,
          label: `${source.documentName} · v${source.versionNumber}${source.pages.length ? ` · p. ${source.pages.join(", ")}` : ""}`,
          pageNumber: source.pages[0],
        });
      }
      const verifiedFacts = source.verifiedFacts ?? [];
      for (const factId of source.verifiedFactIds) {
        const factKey = `verified_fact:${factId}`;
        const fact = verifiedFacts.find(item => item.id === factId);
        if (!references.some(reference => `${reference.type}:${reference.id}` === factKey)) references.push({
          type: "verified_fact",
          id: factId,
          label: fact
            ? `${financialFactLabel(fact.fieldName)}: ${fact.valueType === "currency" ? money(fact.value) : fact.value.toLocaleString("en-US")} · ${source.documentName}${fact.pageNumber ? ` · p. ${fact.pageNumber}` : ""}`
            : `Verified extracted fact · ${source.documentName}`,
          ...(fact?.pageNumber ? { pageNumber: fact.pageNumber } : {}),
        });
      }
    }
  }
  const refsFor = (kinds: FinancialWorkpaperKind[]) => [...new Set(
    workpapers.filter(item => kinds.includes(item.kind)).flatMap(item => [
      `workpaper:${item.id}`,
      ...item.sources.flatMap(source => [
        `document:${source.documentId}`,
        ...source.verifiedFactIds.map(factId => `verified_fact:${factId}`),
      ]),
    ]),
  )];
  const byKind = (kinds: FinancialWorkpaperKind[]) => workpapers.filter(item => kinds.includes(item.kind)).map(item => `${item.subjectLabel}: ${outputSummary(item)}`).join("\n");
  const riskLines = workpapers.flatMap(item => {
    const output = item.output;
    if (output.kind === "self_employment") return output.result.notes.map(note => `${item.subjectLabel}: ${note}`);
    if (output.kind === "income_summary") return output.evaluation.paths.filter(path => path.requiresManualReview).flatMap(path => path.notes);
    if (output.kind === "rental_cash_flow") return output.result.notes;
    return [];
  });
  riskLines.push(...workpapers.flatMap(item => (item.input.evidenceComparisons ?? [])
    .filter(comparison => comparison.status !== "match")
    .map(comparison => `${item.subjectLabel}: ${comparison.label} — ${comparison.detail}`)));
  const sections: CreditMemoSection[] = [
    {
      key: "transaction",
      title: "Transaction overview",
      body: `${application.loanPurpose || "Loan"} request for ${money(Number(application.purchasePrice ?? 0))}; ${application.preferredLoanType || "program not selected"}. The financial conclusions below require the cited current workpapers and recorded approvals.`,
      referenceIds: [],
    },
    { key: "income", title: "Household income", body: byKind(["income_summary"]), referenceIds: refsFor(["income_summary"]) },
    { key: "business", title: "Self-employment and business liquidity", body: byKind(["business_liquidity", "self_employment"]) || "No self-employment workpaper is required.", referenceIds: refsFor(["business_liquidity", "self_employment"]) },
    { key: "assets", title: "Assets and available funds", body: byKind(["asset_reconciliation"]) || "No asset workpaper is required.", referenceIds: refsFor(["asset_reconciliation"]) },
    { key: "liabilities_reo", title: "Liabilities and real estate", body: byKind(["liability_reconciliation", "rental_cash_flow"]) || "No liability or rental workpaper is required.", referenceIds: refsFor(["liability_reconciliation", "rental_cash_flow"]) },
    { key: "risks", title: "Review notes and open judgment", body: riskLines.length ? [...new Set(riskLines)].map(line => `• ${line}`).join("\n") : "No manual-review note remains beyond the officer approvals recorded on the cited workpapers.", referenceIds: referenceKeys },
    { key: "conclusion", title: "Officer conclusion", body: "The cited calculations and evidence versions are approved for lender presentation. This memo records the broker's analysis and does not represent a lender credit decision.", referenceIds: referenceKeys },
  ];
  return { sections, references };
}

export async function getFinancialReview(applicationId: string, actor: FinancialReviewActor) {
  return db.transaction(tx => assembleWorkspace(tx, applicationId, actor), { isolationLevel: "repeatable read" });
}

/**
 * Trusted service-side lookup used by submission readiness and package
 * assembly. It recomputes freshness in one repeatable-read snapshot; a memo
 * approval alone is insufficient after any underlying workpaper input changes.
 */
export async function getCurrentApprovedCreditMemo(applicationId: string): Promise<CreditMemoView | null> {
  return (await getCurrentApprovedFinancialVerificationEvidence(applicationId)).memo;
}

/**
 * Decision-grade financial evidence by dimension. An approved memo is the
 * package-level review, while the named workpaper proves that the package
 * actually reviewed that dimension. This prevents an income-only memo from
 * silently verifying assets (or vice versa).
 */
export async function getCurrentApprovedFinancialVerificationEvidence(applicationId: string): Promise<{
  memo: CreditMemoView | null;
  incomeWorkpaperId: string | null;
  assetWorkpaperId: string | null;
}> {
  const workspace = await db.transaction(
    tx => assembleWorkspace(tx, applicationId),
    { isolationLevel: "repeatable read" },
  );
  if (
    workspace.requiredCount === 0
    || workspace.currentApprovedCount !== workspace.requiredCount
    || !workspace.memo?.isCurrent
    || workspace.memo.blockers.length > 0
    || workspace.memo.review?.action !== "approve"
  ) return { memo: null, incomeWorkpaperId: null, assetWorkpaperId: null };
  const approvedWorkpaper = (kind: FinancialWorkpaperKind) =>
    workspace.workpapers.find(workpaper =>
      workpaper.kind === kind
      && !!workpaper.id
      && workpaper.isCurrent
      && workpaper.blockers.length === 0
      && workpaper.review?.action === "approve",
    )?.id ?? null;
  return {
    memo: workspace.memo,
    incomeWorkpaperId: approvedWorkpaper("income_summary"),
    assetWorkpaperId: approvedWorkpaper("asset_reconciliation"),
  };
}

export async function prepareFinancialWorkpapers(applicationId: string, actor: FinancialReviewActor) {
  return withPostgresTransactionRetry(() => db.transaction(async tx => {
    const loaded = await loadCurrentAnalysis(tx, applicationId, actor);
    if (!FINANCIAL_VERIFICATION_ROLES.includes(actor.role)) throw new FinancialReviewError("Financial reviewer access required", 403);
    if (isTerminalLoanAppStatus(loaded.application.status)) throw new FinancialReviewError("This application is closed", 409);
    const candidates = await buildCandidates(loaded);
    const existing = await tx.select().from(financialWorkpaperVersions).where(eq(financialWorkpaperVersions.applicationId, applicationId)).orderBy(desc(financialWorkpaperVersions.versionNumber));
    const latestByKey = new Map<string, typeof financialWorkpaperVersions.$inferSelect>();
    for (const version of existing) if (!latestByKey.has(version.workpaperKey)) latestByKey.set(version.workpaperKey, version);
    const resolved = new Map<string, typeof financialWorkpaperVersions.$inferSelect>();
    let created = 0;
    for (const item of candidates) {
      const current = latestByKey.get(item.key);
      if (current?.inputFingerprint === item.inputFingerprint) {
        resolved.set(item.key, current);
        continue;
      }
      const dependencyVersionIds = item.dependencyKeys.map(key => {
        const dependency = resolved.get(key);
        if (!dependency) throw new FinancialReviewError(`Could not resolve dependency ${key}`, 500);
        return dependency.id;
      });
      const [saved] = await tx.insert(financialWorkpaperVersions).values({
        applicationId,
        workpaperKey: item.key,
        kind: item.kind,
        subjectId: item.subjectId,
        subjectLabel: item.subjectLabel,
        versionNumber: (current?.versionNumber ?? 0) + 1,
        inputFingerprint: item.inputFingerprint,
        inputSnapshot: item.input,
        outputSnapshot: item.output,
        sourceReferences: item.sources,
        dependencyVersionIds,
        createdBy: actor.id,
      }).returning();
      resolved.set(item.key, saved);
      created += 1;
    }
    await tx.insert(auditLogs).values({
      actorUserId: actor.id,
      action: "financial_review.workpapers_prepared",
      targetType: "loan_application",
      targetId: applicationId,
      metadata: { created, required: candidates.length, versionIds: [...resolved.values()].map(row => row.id) },
    });
    return { created, replayed: created === 0 };
  }, { isolationLevel: "serializable" }));
}

export async function reviewFinancialWorkpaper(
  applicationId: string,
  versionId: string,
  actor: FinancialReviewActor,
  input: { action: "approve" | "reject"; reason: string; expectedFingerprint: string; acknowledgedComparisonIds?: string[] },
) {
  return withPostgresTransactionRetry(() => db.transaction(async tx => {
    if (!FINANCIAL_VERIFICATION_ROLES.includes(actor.role)) throw new FinancialReviewError("Financial reviewer access required", 403);
    const workspace = await assembleWorkspace(tx, applicationId, actor);
    const workpaper = workspace.workpapers.find(item => item.id === versionId);
    if (!workpaper) throw new FinancialReviewError("Workpaper version not found", 404);
    if (!workpaper.isCurrent || workpaper.inputFingerprint !== input.expectedFingerprint) throw new FinancialReviewError("The calculation or evidence changed. Prepare and review the current version.", 409);
    const [existing] = await tx.select().from(financialWorkpaperReviews).where(eq(financialWorkpaperReviews.workpaperVersionId, versionId)).limit(1);
    if (existing) {
      if (existing.action === input.action && existing.reason === input.reason) return { replayed: true };
      throw new FinancialReviewError("This version already has a recorded review. Prepare a new version if the conclusion changes.", 409);
    }
    if (input.action === "approve" && workpaper.blockers.length) throw new FinancialReviewError(workpaper.blockers[0].message, 409);
    if (input.action === "approve") {
      const requiredAcknowledgements = (workpaper.input.evidenceComparisons ?? [])
        .filter(comparison => comparison.status !== "match")
        .map(comparison => comparison.id);
      const acknowledged = new Set(input.acknowledgedComparisonIds ?? []);
      const missing = requiredAcknowledgements.filter(id => !acknowledged.has(id));
      if (missing.length) throw new FinancialReviewError("Acknowledge every document-to-calculation variance before approval.", 409);
    }
    await tx.insert(financialWorkpaperReviews).values({ workpaperVersionId: versionId, action: input.action, reason: input.reason, reviewedBy: actor.id });
    await tx.insert(auditLogs).values({ actorUserId: actor.id, action: `financial_review.workpaper_${input.action}d`, targetType: "financial_workpaper_version", targetId: versionId, metadata: { applicationId, fingerprint: workpaper.inputFingerprint, acknowledgedComparisonIds: input.acknowledgedComparisonIds ?? [] } });
    return { replayed: false };
  }, { isolationLevel: "serializable" }));
}

export async function buildCreditMemo(applicationId: string, actor: FinancialReviewActor) {
  return withPostgresTransactionRetry(() => db.transaction(async tx => {
    if (!FINANCIAL_VERIFICATION_ROLES.includes(actor.role)) throw new FinancialReviewError("Financial reviewer access required", 403);
    const workspace = await assembleWorkspace(tx, applicationId, actor);
    if (!workspace.canBuildMemo) throw new FinancialReviewError(workspace.memoBlockedReason!, 409);
    const [application] = await tx.select().from(loanApplications).where(eq(loanApplications.id, applicationId)).limit(1);
    const current = workspace.workpapers.filter(item => item.isCurrent && item.review?.action === "approve");
    const inputFingerprint = memoInputFingerprint(application, current);
    if (workspace.memo?.inputFingerprint === inputFingerprint) return { replayed: true, id: workspace.memo.id };
    const { sections, references } = buildMemo(application, current);
    const packageHash = sha256({ inputFingerprint, sections, references });
    const [latest] = await tx.select({ versionNumber: creditMemoVersions.versionNumber }).from(creditMemoVersions).where(eq(creditMemoVersions.applicationId, applicationId)).orderBy(desc(creditMemoVersions.versionNumber)).limit(1);
    const [saved] = await tx.insert(creditMemoVersions).values({
      applicationId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      inputFingerprint,
      workpaperVersionIds: current.map(item => item.id!),
      sections,
      referenceIndex: references,
      packageHash,
      createdBy: actor.id,
    }).returning({ id: creditMemoVersions.id });
    await tx.insert(auditLogs).values({ actorUserId: actor.id, action: "financial_review.memo_built", targetType: "credit_memo_version", targetId: saved.id, metadata: { applicationId, inputFingerprint, packageHash } });
    return { replayed: false, id: saved.id };
  }, { isolationLevel: "serializable" }));
}

export async function reviewCreditMemo(
  applicationId: string,
  memoId: string,
  actor: FinancialReviewActor,
  input: { action: "approve" | "reject"; reason: string; expectedFingerprint: string },
) {
  return withPostgresTransactionRetry(() => db.transaction(async tx => {
    if (!FINANCIAL_VERIFICATION_ROLES.includes(actor.role)) throw new FinancialReviewError("Financial reviewer access required", 403);
    const workspace = await assembleWorkspace(tx, applicationId, actor);
    const memo = workspace.memo;
    if (!memo || memo.id !== memoId) throw new FinancialReviewError("Memo version not found", 404);
    if (!memo.isCurrent || memo.inputFingerprint !== input.expectedFingerprint) throw new FinancialReviewError("The financial review changed. Build and review a fresh memo.", 409);
    const [existing] = await tx.select().from(creditMemoReviews).where(eq(creditMemoReviews.memoVersionId, memoId)).limit(1);
    if (existing) {
      if (existing.action === input.action && existing.reason === input.reason) return { replayed: true };
      throw new FinancialReviewError("This memo version already has a recorded review. Build a new version if the conclusion changes.", 409);
    }
    if (input.action === "approve" && memo.blockers.length) throw new FinancialReviewError(memo.blockers[0].message, 409);
    await tx.insert(creditMemoReviews).values({ memoVersionId: memoId, action: input.action, reason: input.reason, reviewedBy: actor.id });
    await tx.insert(auditLogs).values({ actorUserId: actor.id, action: `financial_review.memo_${input.action}d`, targetType: "credit_memo_version", targetId: memoId, metadata: { applicationId, inputFingerprint: memo.inputFingerprint, packageHash: memo.packageHash } });
    return { replayed: false };
  }, { isolationLevel: "serializable" }));
}
