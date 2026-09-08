import { db } from "../db";
import { storage } from "../storage";
import {
  users,
  loanApplications,
  documents,
  documentLineage,
  employmentHistory,
  coachConversations,
  coachMessages,
  userActivities,
  homeownershipGoals,
  creditActions,
  savingsTransactions,
  journeyMilestones,
  tasks,
  borrowerProfiles,
  realEstateOwned,
  borrowerStateHistory,
  readinessChecklist,
  intentEvents,
} from "@shared/schema";
import type { User, LoanApplication, BorrowerProfile, RealEstateOwned } from "@shared/schema";
import { CONFORMING_LOAN_LIMIT_2026 } from "@shared/lendingLimits";
import { eq, desc, sql, and, gte, count, isNotNull } from "drizzle-orm";
import { computeNextAction } from "./nextAction";
import { pickActiveLoanApplication } from "@shared/schema";
import { annuityFactor, monthlyPrincipalAndInterest } from "@shared/lib/amortization";
import { currentDocumentEvidencePredicate } from "./currentDocumentEvidence";
import { isDecisionGrade, type DataProvenance } from "@shared/dataProvenance";

export interface IncomeSource {
  source: "document" | "application" | "coach" | "goal";
  trust: "tier1" | "tier2" | "tier3";
  type: string;
  amount: number;
  period: "annual" | "monthly";
  employerName?: string | null;
  documentYear?: string | null;
  confidence?: string | null;
  /** False when this record explains part of an aggregate already present in
   * the graph. It stays visible as source detail but is not summed again. */
  includedInBestIncome?: boolean;
}

export interface AssetRecord {
  source: "document" | "application" | "goal";
  trust: "tier1" | "tier2" | "tier3";
  type: string;
  balance: number;
  accountType?: string | null;
}

export interface LiabilityRecord {
  source: "application" | "coach" | "goal";
  trust: "tier2" | "tier3";
  monthlyAmount: number;
  description: string;
}

export interface DocumentStatus {
  documentType: string;
  fileName: string;
  status: string;
  hasExtractedData: boolean;
  uploadedAt: string | null;
}

export interface BehaviorSignals {
  totalPageViews: number;
  propertySearches: number;
  propertyViews: number;
  calculatorUses: number;
  coachSessions: number;
  coachMessages: number;
  formStarts: number;
  formAbandons: number;
  ctaClicks: number;
  lastActiveAt: string | null;
  topPages: Array<{ page: string; views: number }>;
  recentPropertyViews: Array<{ propertyId?: string; price?: number; viewedAt: string }>;
}

export interface ReadinessSnapshot {
  completionPercentage: number;
  tier: "ready_now" | "almost_ready" | "building" | "exploring" | "unknown";
  /** Which model answered. "checklist" is the evidence model and wins when populated. */
  source: "checklist" | "coach" | "calculated";
  completedInputs: string[];
  outstandingInputs: string[];
  estimatedTimeline: string | null;
  lastAssessedAt: string | null;
}

export interface EligibilitySignals {
  estimatedDTI: number | null;
  estimatedLTV: number | null;
  creditTier: "760_plus" | "720_759" | "680_719" | "640_679" | "below_640" | "unknown";
  creditScore: number | null;
  creditScoreSource: "document" | "application" | "goal" | "coach" | null;
  employmentStable: boolean | null;
  employmentYears: number | null;
  hasAdequateSavings: boolean | null;
  estimatedMaxPurchase: number | null;
  eligibleLoanTypes: string[];
}

export interface BorrowerProfileSnapshot {
  citizenshipStatus: string | null;
  maritalStatus: string | null;
  numberOfDependents: number | null;
  currentHousingStatus: string | null;
  currentMonthlyHousingPayment: number | null;
  militaryStatus: string | null;
  hasCoBorrower: boolean;
  hasForeclosureHistory: boolean;
  hasBankruptcyHistory: boolean;
  hasRealEstateOwned: boolean;
  riskTolerance: string | null;
  vaEligible: boolean;
}

export interface REOProperty {
  address: string;
  propertyType: string | null;
  marketValue: number | null;
  mortgageBalance: number | null;
  mortgagePayment: number | null;
  monthlyRentalIncome: number | null;
  netEquity: number | null;
  occupancyType: string | null;
  willBeSold: boolean;
}

export interface ReadinessChecklistSummary {
  totalFields: number;
  collectedFields: number;
  verifiedFields: number;
  completionByCategory: Record<string, { total: number; collected: number; verified: number }>;
  calculatedReadinessScore: number;
}

export interface BorrowerStateSummary {
  currentState: string;
  previousState: string | null;
  stateEnteredAt: string | null;
  daysInCurrentState: number | null;
  totalTransitions: number;
}

export interface GoalProfile {
  goal: string | null;
  targetHomePrice: number | null;
  targetDownPayment: number | null;
  targetCreditScore: number | null;
  targetCity: string | null;
  targetState: string | null;
  currentPhase: string | null;
  savingsProgress: number | null;
  creditScoreChange: number | null;
  journeyDay: number | null;
  milestonesAchieved: number;
}

export interface BorrowerGraph {
  userId: string;
  userName: string | null;
  email: string | null;
  role: string;
  memberSince: string | null;

  profile: BorrowerProfileSnapshot;
  state: BorrowerStateSummary;
  readinessDetail: ReadinessChecklistSummary;
  realEstateOwned: REOProperty[];

  applications: Array<{
    id: string;
    status: string;
    loanPurpose: string | null;
    preferredLoanType: string | null;
    purchasePrice: number | null;
    downPayment: number | null;
    preApprovalAmount: number | null;
    isVeteran: boolean;
    isFirstTimeBuyer: boolean;
    employmentType: string | null;
    propertyType: string | null;
    propertyState: string | null;
    propertyValue: number | null;
    createdAt: string | null;
  }>;

  activeApplicationId: string | null;

  financialVerification: {
    income: boolean;
    assets: boolean;
    credit: boolean;
    decisionGrade: boolean;
  };

  income: IncomeSource[];
  bestAnnualIncome: number | null;
  bestIncomeSource: string | null;

  assets: AssetRecord[];
  totalVerifiedAssets: number | null;

  liabilities: LiabilityRecord[];
  totalMonthlyDebts: number | null;

  documents: DocumentStatus[];
  documentsUploaded: number;
  documentsVerified: number;
  documentsMissing: string[];

  readiness: ReadinessSnapshot;
  eligibility: EligibilitySignals;
  goal: GoalProfile;
  behavior: BehaviorSignals;

  actionPlan: Array<{ id: string; title: string; priority: string; category: string; completed: boolean }>;
  documentChecklist: Array<{ docType: string; label: string; priority: string }>;

  predictiveSignals: {
    likelyToApply: boolean;
    likelyToAbandon: boolean;
    engagementLevel: "high" | "medium" | "low" | "dormant";
    daysSinceLastActivity: number | null;
    suggestedNextAction: string;
    intentScore: number;
  };
}

function getCreditTier(score: number | null): EligibilitySignals["creditTier"] {
  if (!score) return "unknown";
  if (score >= 760) return "760_plus";
  if (score >= 720) return "720_759";
  if (score >= 680) return "680_719";
  if (score >= 640) return "640_679";
  return "below_640";
}

function parseNum(val: string | number | null | undefined): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === "number" ? val : parseFloat(val);
  return isNaN(n) ? null : n;
}

/**
 * Turn the fast application's one household total and its source breakdown
 * into graph records without treating the breakdown as additional income.
 * The detail remains available to the coach and staff surfaces, while exactly
 * one representation contributes to the advisory best-income figure.
 */
export function applicationReportedIncomeRecords(
  annualIncome: string | number | null | undefined,
  rawSources: unknown,
): IncomeSource[] {
  const total = parseNum(
    typeof annualIncome === "string" ? annualIncome.replace(/[,$]/g, "") : annualIncome,
  );
  const sources = Array.isArray(rawSources) ? rawSources : [];
  const records: IncomeSource[] = [];

  if (total && total > 0) {
    records.push({
      source: "application",
      trust: "tier2",
      type: "application_stated_household_total",
      amount: total,
      period: "annual",
      includedInBestIncome: true,
    });
  }

  for (const candidate of sources) {
    if (!candidate || typeof candidate !== "object") continue;
    const source = candidate as Record<string, unknown>;
    const rawAmount = source.annualAmount;
    const amount = parseNum(
      typeof rawAmount === "string" ? rawAmount.replace(/[,$]/g, "") : rawAmount as number | null | undefined,
    );
    if (!amount || amount <= 0) continue;
    records.push({
      source: "application",
      trust: "tier2",
      type: typeof source.type === "string" ? source.type : "additional_income",
      amount,
      period: "annual",
      employerName: typeof source.employerName === "string" ? source.employerName : null,
      includedInBestIncome: !(total && total > 0),
    });
  }

  return records;
}

/** A zero on the application row is the schema default, not a calculated DTI. */
export function usableApplicationDti(
  value: string | number | null | undefined,
): number | null {
  const parsed = parseNum(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export async function buildBorrowerGraph(
  userId: string,
  applicationId?: string,
): Promise<BorrowerGraph> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("User not found");

  const documentScope = [eq(documents.userId, userId)];
  if (applicationId) documentScope.push(eq(documents.applicationId, applicationId));
  const reoScope = [eq(realEstateOwned.userId, userId)];
  if (applicationId) reoScope.push(eq(realEstateOwned.applicationId, applicationId));

  const [
    allApps,
    docs,
    currentEvidenceDocs,
    coachConvs,
    goalRows,
    recentActivities,
    activityCounts,
    profileRows,
    reoRows,
    stateRows,
    checklistRows,
    intentCounts,
  ] = await Promise.all([
    storage.getLoanApplicationsByUser(userId),
    db.select().from(documents).where(and(...documentScope)).orderBy(desc(documents.createdAt)),
    db.select({ id: documents.id })
      .from(documents)
      .leftJoin(documentLineage, eq(documentLineage.documentId, documents.id))
      .where(and(
        ...documentScope,
        currentDocumentEvidencePredicate(),
      )),
    db.select().from(coachConversations).where(eq(coachConversations.userId, userId)).orderBy(desc(coachConversations.updatedAt)),
    db.select().from(homeownershipGoals).where(eq(homeownershipGoals.userId, userId)).limit(1),
    db.select({
      activityType: userActivities.activityType,
      count: sql<number>`count(*)::int`,
      lastSeen: sql<string>`max(${userActivities.createdAt})`,
    }).from(userActivities)
      .where(and(
        eq(userActivities.userId, userId),
        gte(userActivities.createdAt, sql`now() - interval '30 days'`)
      ))
      .groupBy(userActivities.activityType),
    db.select({
      page: userActivities.page,
      views: sql<number>`count(*)::int`,
    }).from(userActivities)
      .where(and(
        eq(userActivities.userId, userId),
        eq(userActivities.activityType, "page_view"),
        gte(userActivities.createdAt, sql`now() - interval '30 days'`)
      ))
      .groupBy(userActivities.page)
      .orderBy(sql`count(*) desc`)
      .limit(10),
    db.select().from(borrowerProfiles).where(eq(borrowerProfiles.userId, userId)).limit(1),
    db.select().from(realEstateOwned).where(and(...reoScope)),
    db.select().from(borrowerStateHistory)
      .where(eq(borrowerStateHistory.userId, userId))
      .orderBy(desc(borrowerStateHistory.transitionedAt)),
    db.select().from(readinessChecklist).where(eq(readinessChecklist.userId, userId)),
    db.select({
      eventType: intentEvents.eventType,
      count: sql<number>`count(*)::int`,
    }).from(intentEvents)
      .where(and(
        eq(intentEvents.userId, userId),
        gte(intentEvents.occurredAt, sql`now() - interval '30 days'`)
      ))
      .groupBy(intentEvents.eventType),
  ]);

  const apps = applicationId
    ? allApps.filter((application) => application.id === applicationId)
    : allApps;
  if (applicationId && apps.length === 0) {
    throw new Error("Application does not belong to borrower");
  }
  const currentEvidenceIds = new Set(
    currentEvidenceDocs.map((document) => document.id),
  );
  const eligibleDocs = docs.filter((document) => currentEvidenceIds.has(document.id));

  const activeApp = pickActiveLoanApplication(apps) || apps[0] || null;

  // Second parallel wave — everything that depends on wave-1 results. These
  // were previously scattered sequential awaits (employment history, coach
  // messages, property views, milestone count), which added four extra
  // round-trips of latency to the dashboard's hero section.
  const wave2GoalData = goalRows[0] || null;
  const [empHistoryResult, coachMsgsResult, propActivitiesResult, milestoneCountResult] =
    await Promise.allSettled([
      activeApp
        ? db.select().from(employmentHistory).where(eq(employmentHistory.applicationId, activeApp.id))
        : Promise.resolve([]),
      coachConvs.length > 0
        ? db.select().from(coachMessages)
            .where(eq(coachMessages.conversationId, coachConvs[0].id))
            .orderBy(desc(coachMessages.createdAt))
        : Promise.resolve([]),
      db.select({
        metadata: userActivities.metadata,
        createdAt: userActivities.createdAt,
      }).from(userActivities)
        .where(and(
          eq(userActivities.userId, userId),
          eq(userActivities.activityType, "property_click"),
          gte(userActivities.createdAt, sql`now() - interval '30 days'`)
        ))
        .orderBy(desc(userActivities.createdAt))
        .limit(10),
      wave2GoalData
        ? db.select({ cnt: sql<number>`count(*)::int` })
            .from(journeyMilestones)
            .where(eq(journeyMilestones.goalId, wave2GoalData.id))
        : Promise.resolve([]),
    ]);

  let empHistory: any[] = [];
  if (empHistoryResult.status === "fulfilled") {
    empHistory = empHistoryResult.value;
  } else {
    console.warn("[BorrowerGraph] Failed to fetch employment history:", empHistoryResult.reason);
  }

  const incomeSources: IncomeSource[] = [];
  const assetRecords: AssetRecord[] = [];
  const liabilityRecords: LiabilityRecord[] = [];
  const extractedDocs: DocumentStatus[] = [];
  const docsMissing: string[] = [];

  for (const doc of eligibleDocs) {
    const docStatus: DocumentStatus = {
      documentType: doc.documentType,
      fileName: doc.fileName,
      status: doc.status || "uploaded",
      hasExtractedData: false,
      uploadedAt: doc.createdAt?.toISOString() || null,
    };

    // `notes` is server-written extraction LINEAGE only (field names, confidence,
    // model/prompt ids) — it has never carried extracted VALUES from any writer
    // in this repo's history. The value-reading branches that used to live here
    // (grossIncome / adjustedGrossIncome / grossPay / closingBalance → tier-1
    // income and assets) were therefore unreachable for legitimate data and
    // reachable only by a borrower typing JSON into the upload description box,
    // which landed verbatim in this column. That forged a `trust: "tier1",
    // source: "document"` record, which short-circuits the income cascade over
    // real application data and is the sole contributor to totalVerifiedAssets
    // (F-027; the never-populated contract is F-028).
    //
    // Deleted rather than schema-validated: there is nothing legitimate to
    // validate. Real tax-return income still reaches tier 1 through the
    // tax_insights fallback below, which is where extraction actually persists
    // values. Pay-stub income and bank-statement assets have no tier-1 path
    // today — they never did; that gap is F-028, not a regression from here.
    if (doc.notes) {
      try {
        const lineage = JSON.parse(doc.notes as string);
        // Enum-validated for the same reason as the coach read site: JSON.parse
        // yields `any`, and a pre-0046 row may still hold borrower text here.
        if (lineage.confidence === "high" || lineage.confidence === "medium") {
          docStatus.hasExtractedData = true;
        }
      } catch (err) {
        console.warn("[BorrowerGraph] Failed to parse document notes:", doc.fileName, err);
      }
    }

    extractedDocs.push(docStatus);
  }

  // Derived tax insights (tax_insights table) — this is where the extraction
  // route actually persists income VALUES, and since F-027 removed the
  // notes-parsing branches above it is the ONLY tier-1 document income path.
  // The guard below is now vacuously true (nothing else produces a tax-return
  // source); kept as a cheap double-count guard should another producer land.
  if (!incomeSources.some((s) => s.type === "tax_return_agi" || s.type === "tax_return_gross")) {
    try {
      const insights = await storage.getTaxInsightsByUser(userId);
      const latest = insights.find(
        (insight) =>
          !!insight.documentId &&
          currentEvidenceIds.has(insight.documentId) &&
          insight.confidence !== "low",
      );
      if (latest) {
        const annual = parseNum(latest.adjustedGrossIncome) || parseNum(latest.grossIncome) || 0;
        if (annual > 0) {
          incomeSources.push({
            source: "document",
            trust: "tier1",
            type: "tax_return_agi",
            amount: annual,
            period: "annual",
            documentYear: String(latest.taxYear),
            confidence: latest.confidence,
          });
        }
      }
    } catch (err) {
      console.warn("[BorrowerGraph] Failed to fetch tax insights:", err);
    }
  }

  // Pay-stub income and bank-statement assets (F-028). These are the values a
  // model actually read off the borrower's own documents, persisted to
  // extracted_fields by the extraction route — a SERVER-written table, which is
  // the whole difference from the notes-parsing branches F-027 deleted. Those
  // read a column the borrower could write; nothing here is borrower-reachable.
  //
  // Tier 1 on extraction alone, matching the tax_insights path directly above:
  // a machine read the document. A staff verify is recorded on the row
  // (humanVerified) and strengthens it further, but is not required for the
  // graph, which is advisory — it feeds coaching, prediction, lender matching
  // and scenarios, never the binding decision path.
  try {
    const { getFactsForDocuments } = await import("./documentFacts");
    const facts = await getFactsForDocuments(currentEvidenceDocs.map((document) => document.id));

    const employerByDoc = new Map<string, string>();
    for (const f of facts) {
      if (f.fieldName === "employer_name" && f.valueString) {
        employerByDoc.set(f.documentId, f.valueString);
      }
    }
    const accountTypeByDoc = new Map<string, string>();
    for (const f of facts) {
      if (f.fieldName === "account_type" && f.valueString) {
        accountTypeByDoc.set(f.documentId, f.valueString);
      }
    }

    for (const f of facts) {
      if (f.fieldName === "monthly_income_ytd_avg" && f.valueNumeric && f.valueNumeric > 0) {
        incomeSources.push({
          source: "document",
          trust: "tier1",
          type: "pay_stub_ytd_average",
          amount: f.valueNumeric,
          period: "monthly",
          employerName: employerByDoc.get(f.documentId) ?? null,
          confidence: f.humanVerified ? "verified" : "high",
        });
      }
      if (f.fieldName === "closing_balance" && f.valueNumeric && f.valueNumeric > 0) {
        assetRecords.push({
          source: "document",
          trust: "tier1",
          type: "bank_statement_balance",
          balance: f.valueNumeric,
          accountType: accountTypeByDoc.get(f.documentId) ?? null,
        });
      }
    }
  } catch (err) {
    console.warn("[BorrowerGraph] Failed to fetch document facts:", err);
  }

  const applicationHouseholdTotal = parseNum(activeApp?.annualIncome) ?? 0;
  const applicationIncomeBreakdown = Array.isArray(activeApp?.incomeSources)
    ? activeApp.incomeSources
    : [];
  const hasLineItemIncome = applicationIncomeBreakdown.length > 0;
  const hasApplicationRentalBreakdown = applicationIncomeBreakdown.some((source) =>
    !!source && typeof source === "object" && "type" in source && source.type === "rental",
  );

  if (activeApp) {
    incomeSources.push(...applicationReportedIncomeRecords(activeApp.annualIncome, activeApp.incomeSources));

    if (activeApp.monthlyDebts) {
      liabilityRecords.push({
        source: "application",
        trust: "tier2",
        monthlyAmount: parseNum(activeApp.monthlyDebts) || 0,
        description: "Total monthly debts (application)",
      });
    }

    if (activeApp.aiAnalysis) {
      try {
        const ai = activeApp.aiAnalysis as any;
        if (ai.estimatedIncome && !activeApp.annualIncome && !hasLineItemIncome) {
          incomeSources.push({
            source: "application",
            trust: "tier2",
            type: "ai_extracted",
            amount: parseNum(ai.estimatedIncome) || 0,
            period: "annual",
          });
        }
        if (ai.estimatedAssets) {
          assetRecords.push({
            source: "application",
            trust: "tier2",
            type: "ai_extracted_assets",
            balance: parseNum(ai.estimatedAssets) || 0,
          });
        }
      } catch (err) {
        console.warn("[BorrowerGraph] Failed to parse aiAnalysis:", err);
      }
    }
  }

  for (const emp of empHistory) {
    if (emp.totalMonthlyIncome) {
      incomeSources.push({
        source: "application",
        trust: "tier2",
        type: "employment_record",
        amount: parseNum(emp.totalMonthlyIncome) || 0,
        period: "monthly",
        employerName: emp.employerName || null,
        includedInBestIncome: applicationHouseholdTotal <= 0 && !hasLineItemIncome,
      });
    }
  }

  const goalData = goalRows[0] || null;
  if (goalData) {
    if (goalData.monthlyIncome) {
      incomeSources.push({
        source: "goal",
        trust: "tier3",
        type: "goal_stated",
        amount: parseNum(goalData.monthlyIncome) || 0,
        period: "monthly",
      });
    }
    if (goalData.currentSavingsBalance) {
      assetRecords.push({
        source: "goal",
        trust: "tier3",
        type: "savings_goal",
        balance: parseNum(goalData.currentSavingsBalance) || 0,
      });
    }
    if (goalData.currentMonthlySavings) {
      const monthlySavings = parseNum(goalData.currentMonthlySavings) || 0;
      if (monthlySavings > 0) {
        assetRecords.push({
          source: "goal",
          trust: "tier3",
          type: "monthly_savings_capacity",
          balance: monthlySavings,
        });
      }
    }
    if (goalData.monthlyDebts) {
      liabilityRecords.push({
        source: "goal",
        trust: "tier3",
        monthlyAmount: parseNum(goalData.monthlyDebts) || 0,
        description: "Monthly debts (goal tracker)",
      });
    }
    if (goalData.currentRent) {
      const rent = parseNum(goalData.currentRent) || 0;
      if (rent > 0) {
        liabilityRecords.push({
          source: "goal",
          trust: "tier3",
          monthlyAmount: rent,
          description: "Current rent payment (goal tracker)",
        });
      }
    }
  }

  const coachConvWithProfile = coachConvs.find(c => c.financialProfile);
  let coachIntake: any = null;
  if (coachMsgsResult.status === "fulfilled") {
    for (const msg of coachMsgsResult.value) {
      if (msg.role === "assistant" && msg.structuredData) {
        const sd = msg.structuredData as any;
        if (sd?.intake) {
          coachIntake = sd.intake;
          break;
        }
      }
    }
  } else {
    console.warn("[BorrowerGraph] Failed to fetch coach intake:", coachMsgsResult.reason);
  }

  if (coachIntake?.annualIncome) {
    incomeSources.push({
      source: "coach",
      trust: "tier3",
      type: "coach_stated",
      amount: parseNum(coachIntake.annualIncome) || 0,
      period: "annual",
    });
  }
  if (coachIntake?.monthlyDebts) {
    liabilityRecords.push({
      source: "coach",
      trust: "tier3",
      monthlyAmount: parseNum(coachIntake.monthlyDebts) || 0,
      description: "Monthly debts (coach conversation)",
    });
  }

  for (const reo of reoRows) {
    if (reo.mortgagePayment) {
      const payment = parseNum(reo.mortgagePayment) || 0;
      const taxes = parseNum(reo.monthlyTaxes) || 0;
      const ins = parseNum(reo.monthlyInsurance) || 0;
      const hoa = parseNum(reo.monthlyHoa) || 0;
      if (payment + taxes + ins + hoa > 0) {
        liabilityRecords.push({
          source: "application",
          trust: "tier2",
          monthlyAmount: payment + taxes + ins + hoa,
          description: `REO mortgage: ${reo.propertyAddress}`,
        });
      }
    }
    if (reo.monthlyRentalIncome) {
      const rentalIncome = parseNum(reo.monthlyRentalIncome) || 0;
      if (rentalIncome > 0) {
        incomeSources.push({
          source: "application",
          trust: "tier2",
          type: "rental_income",
          amount: rentalIncome * 0.75,
          period: "monthly",
          employerName: null,
          includedInBestIncome: applicationHouseholdTotal <= 0 && !hasApplicationRentalBreakdown,
        });
      }
    }
    if (reo.netEquity || reo.marketValue) {
      const equity = parseNum(reo.netEquity) || (parseNum(reo.marketValue) || 0) - (parseNum(reo.mortgageBalance) || 0);
      if (equity > 0) {
        assetRecords.push({
          source: "application",
          trust: "tier2",
          type: "real_estate_equity",
          balance: equity,
        });
      }
    }
  }

  const tier1Income = incomeSources.filter(i => i.trust === "tier1" && i.period === "annual" && i.includedInBestIncome !== false);
  const tier2Income = incomeSources.filter(i => i.trust === "tier2" && i.period === "annual" && i.includedInBestIncome !== false);
  const tier1Monthly = incomeSources.filter(i => i.trust === "tier1" && i.period === "monthly" && i.includedInBestIncome !== false);
  const tier2Monthly = incomeSources.filter(i => i.trust === "tier2" && i.period === "monthly" && i.includedInBestIncome !== false);

  const sumAnnual = (items: IncomeSource[]) => items.reduce((sum, i) => sum + i.amount, 0);
  const sumMonthlyToAnnual = (items: IncomeSource[]) => items.reduce((sum, i) => sum + i.amount * 12, 0);

  let bestAnnualIncome: number | null = null;
  let bestIncomeSource: string | null = null;

  if (tier1Income.length > 0 || tier1Monthly.length > 0) {
    bestAnnualIncome = sumAnnual(tier1Income) + sumMonthlyToAnnual(tier1Monthly);
    bestIncomeSource = "document";
  } else if (tier2Income.length > 0 || tier2Monthly.length > 0) {
    bestAnnualIncome = sumAnnual(tier2Income) + sumMonthlyToAnnual(tier2Monthly);
    bestIncomeSource = "application";
  } else {
    const allIncome = incomeSources.filter(i => i.amount > 0);
    if (allIncome.length > 0) {
      bestAnnualIncome = allIncome.reduce((sum, i) => sum + (i.period === "monthly" ? i.amount * 12 : i.amount), 0);
      bestIncomeSource = allIncome[0].source;
    }
  }

  const totalVerifiedAssets = assetRecords
    .filter(a => a.trust === "tier1")
    .reduce((sum, a) => sum + a.balance, 0) || null;

  const totalMonthlyDebts = (() => {
    if (liabilityRecords.length === 0) return null;
    const tier2Liabilities = liabilityRecords.filter(l => l.trust === "tier2");
    const tier3Liabilities = liabilityRecords.filter(l => l.trust === "tier3");
    if (tier2Liabilities.length > 0) {
      return tier2Liabilities.reduce((sum, l) => sum + l.monthlyAmount, 0);
    }
    return tier3Liabilities.reduce((sum, l) => sum + l.monthlyAmount, 0);
  })();

  let creditScore: number | null = null;
  let creditScoreSource: EligibilitySignals["creditScoreSource"] = null;

  if (activeApp?.creditScore) {
    creditScore = activeApp.creditScore;
    creditScoreSource = "application";
  }
  if (goalData?.currentCreditScore) {
    if (!creditScore) {
      creditScore = goalData.currentCreditScore;
      creditScoreSource = "goal";
    }
  }
  if (coachIntake?.creditScore) {
    if (!creditScore) {
      creditScore = parseNum(coachIntake.creditScore);
      creditScoreSource = "coach";
    }
  }

  let estimatedDTI: number | null = null;
  if (activeApp) {
    // Intake rows default to 0.00 before the decision engine has enough facts
    // to calculate proposed-housing DTI. Treating that sentinel as a real 0%
    // made the borrower dashboard and prediction model call an incomplete
    // self-employed file "low DTI." Only publish a positive engine result.
    estimatedDTI = usableApplicationDti(activeApp.dtiRatio);
  } else if (bestAnnualIncome && totalMonthlyDebts) {
    const monthlyIncome = bestAnnualIncome / 12;
    estimatedDTI = monthlyIncome > 0 ? Math.round((totalMonthlyDebts / monthlyIncome) * 10000) / 100 : null;
  }

  let estimatedLTV: number | null = null;
  if (activeApp?.ltvRatio) {
    estimatedLTV = parseNum(activeApp.ltvRatio);
  } else if (activeApp?.purchasePrice && activeApp?.downPayment) {
    const pp = parseNum(activeApp.purchasePrice) || 0;
    const dp = parseNum(activeApp.downPayment) || 0;
    if (pp > 0) estimatedLTV = Math.round(((pp - dp) / pp) * 10000) / 100;
  }

  const employmentYears = activeApp?.employmentYears || (empHistory.length > 0 ? empHistory[0]?.yearsOnJob : null);
  const appEmploymentType = activeApp?.employmentType || null;
  const employmentStable = employmentYears != null
    ? (appEmploymentType === "self_employed" ? employmentYears >= 2 : employmentYears >= 1)
    : null;

  const hasAdequateSavings = (() => {
    const pp = parseNum(activeApp?.purchasePrice) || parseNum(activeApp?.propertyValue) || 0;
    if (pp <= 0) return null;
    const neededDown = pp * 0.035;
    const neededClosing = pp * 0.03;
    const total = neededDown + neededClosing;
    const available = totalVerifiedAssets || (goalData?.currentSavingsBalance ? parseNum(goalData.currentSavingsBalance) : null);
    if (!available) return null;
    return available >= total;
  })();

  let estimatedMaxPurchase: number | null = null;
  if (bestAnnualIncome && totalMonthlyDebts !== null) {
    const monthlyIncome = bestAnnualIncome / 12;
    const maxHousingPayment = monthlyIncome * 0.43 - (totalMonthlyDebts || 0);
    if (maxHousingPayment > 0) {
      // 6.5% assumed rate, expressed as a percent for the shared helper.
      const factor = annuityFactor(6.5, 360);
      estimatedMaxPurchase = Math.round(maxHousingPayment * factor * 0.85);
    }
  }

  const eligibleLoanTypes: string[] = [];
  const appIsVeteran = activeApp?.isVeteran || false;
  const appIsFirstTime = activeApp?.isFirstTimeBuyer || false;
  const appPropertyType = activeApp?.propertyType || null;
  const downPaymentPct = (() => {
    if (!activeApp?.purchasePrice || !activeApp?.downPayment) return null;
    const pp = parseNum(activeApp.purchasePrice) || 0;
    const dp = parseNum(activeApp.downPayment) || 0;
    return pp > 0 ? (dp / pp) * 100 : null;
  })();

  if (appIsVeteran) {
    eligibleLoanTypes.push("va");
  }
  if (creditScore !== null && creditScore >= 580 && (downPaymentPct === null || downPaymentPct >= 3.5)) {
    eligibleLoanTypes.push("fha");
  }
  if (creditScore !== null && creditScore >= 620 && (downPaymentPct === null || downPaymentPct >= 5)) {
    eligibleLoanTypes.push("conventional");
  }
  const loanAmount = (() => {
    if (!activeApp?.purchasePrice || !activeApp?.downPayment) return null;
    const pp = parseNum(activeApp.purchasePrice) || 0;
    const dp = parseNum(activeApp.downPayment) || 0;
    return pp - dp;
  })();
  if (loanAmount !== null && loanAmount > CONFORMING_LOAN_LIMIT_2026) {
    eligibleLoanTypes.push("jumbo");
  }
  if (activeApp?.loanPurpose === "purchase" && (appPropertyType === "single_family" || appPropertyType === "condo") &&
      activeApp?.propertyState && !["AK", "HI", "GU", "VI", "AS"].includes(activeApp.propertyState)) {
    if (creditScore === null || creditScore >= 640) {
      eligibleLoanTypes.push("usda");
    }
  }
  if (eligibleLoanTypes.length === 0 && activeApp?.preferredLoanType) {
    eligibleLoanTypes.push(activeApp.preferredLoanType);
  }

  const requiredDocs = ["pay_stub", "w2", "tax_return", "bank_statement", "government_id"];
  const uploadedTypes = new Set(eligibleDocs.map(d => d.documentType));
  const documentsMissing = requiredDocs.filter(t => !uploadedTypes.has(t));

  const readiness: ReadinessSnapshot = {
    completionPercentage: 0,
    tier: "unknown",
    source: "calculated",
    completedInputs: [],
    outstandingInputs: [],
    estimatedTimeline: null,
    lastAssessedAt: null,
  };

  // ONE readiness number, derived from the checklist that actually holds the
  // evidence. Three models used to answer "how ready are you": this checklist
  // (25 weighted fields with trust tiers), the coach's conversational
  // percentage, and an ad-hoc status-plus-bonuses calculation below. Only the
  // coach's ever reached a borrower, and the three could disagree freely.
  //
  // The checklist wins when it has data because it is the only one that knows
  // WHAT is missing rather than just how far along the file is — `missingRequired`
  // is a list of field labels, which is the answer a borrower actually wants.
  // It is fed by the application (tier 2) and upgraded by documents (tier 1),
  // so it no longer starts empty; before that feed existed it would have
  // reported 0% for an advanced file, which is why it could not be primary.
  //
  // The coach and calculated paths remain as fallbacks, in that order, for a
  // borrower with no checklist rows yet (pure-coach users, pre-application).
  const checklistScore = checklistRows.length > 0
    ? (() => {
        let totalWeight = 0;
        let collectedWeight = 0;
        const collected: string[] = [];
        const outstanding: string[] = [];
        for (const row of checklistRows) {
          const weight = parseFloat(row.weight || "1");
          totalWeight += weight;
          if (row.isCollected) {
            collectedWeight += weight;
            collected.push(row.fieldLabel);
          } else if (row.isRequired) {
            outstanding.push(row.fieldLabel);
          }
        }
        return {
          percentage: totalWeight > 0 ? Math.round((collectedWeight / totalWeight) * 100) : 0,
          collected,
          outstanding,
        };
      })()
    : null;

  if (checklistScore) {
    readiness.source = "checklist";
    readiness.completionPercentage = checklistScore.percentage;
    readiness.completedInputs = checklistScore.collected;
    readiness.outstandingInputs = checklistScore.outstanding;
    readiness.tier =
      checklistScore.percentage >= 80 ? "ready_now"
      : checklistScore.percentage >= 60 ? "almost_ready"
      : checklistScore.percentage >= 35 ? "building"
      : "exploring";
    readiness.estimatedTimeline = coachConvWithProfile
      ? ((coachConvWithProfile.financialProfile as any)?.estimatedTimeline ?? null)
      : null;
    readiness.lastAssessedAt = new Date().toISOString();
  } else if (coachConvWithProfile) {
    const fp = coachConvWithProfile.financialProfile as any;
    readiness.source = "coach";
    readiness.completionPercentage = coachConvWithProfile.completionPercentage || fp?.completionPercentage || fp?.readinessScore || 0;
    readiness.tier = (coachConvWithProfile.readinessTier || fp?.readinessTier || "unknown") as any;
    readiness.completedInputs = fp?.completedInputs || fp?.strengths || [];
    readiness.outstandingInputs = fp?.outstandingInputs || fp?.gaps || [];
    readiness.estimatedTimeline = fp?.estimatedTimeline || null;
    readiness.lastAssessedAt = coachConvWithProfile.updatedAt?.toISOString() || null;
  } else {
    let calcScore = 10;
    if (activeApp) {
      const statusScores: Record<string, number> = {
        draft: 20, submitted: 35, analyzing: 40, pre_approved: 60,
        doc_collection: 55, processing: 65, underwriting: 75,
        conditional: 85, clear_to_close: 95, closing: 98, closed: 100,
      };
      calcScore = statusScores[activeApp.status] || 30;
    }
    if (creditScore) { calcScore += 5; readiness.completedInputs.push("Credit score provided"); }
    if (employmentYears !== null) { calcScore += 3; readiness.completedInputs.push("Employment duration provided"); }
    if (appEmploymentType) { calcScore += 2; readiness.completedInputs.push("Employment type provided"); }
    if (activeApp?.propertyState) { calcScore += 2; readiness.completedInputs.push("Property location provided"); }
    if (activeApp?.propertyType) { calcScore += 2; readiness.completedInputs.push("Property type provided"); }
    if (hasAdequateSavings) { calcScore += 5; readiness.completedInputs.push("Savings documented"); }
    if (estimatedDTI) { calcScore += 5; readiness.completedInputs.push("DTI calculated"); }

    if (documentsMissing.length > 2) readiness.outstandingInputs.push("Missing required documents");
    if (!creditScore) readiness.outstandingInputs.push("Credit score not provided");
    if (employmentYears === null) readiness.outstandingInputs.push("Employment duration not provided");
    if (!activeApp?.propertyState) readiness.outstandingInputs.push("Property location not provided");

    readiness.completionPercentage = Math.min(calcScore, 100);
    readiness.tier = calcScore >= 80 ? "ready_now" : calcScore >= 60 ? "almost_ready" : calcScore >= 35 ? "building" : "exploring";
  }

  const activityMap = new Map(recentActivities.map(a => [a.activityType, { count: a.count, lastSeen: a.lastSeen }]));
  const getCount = (type: string) => activityMap.get(type)?.count || 0;
  const totalPageViews = getCount("page_view");
  const propertySearches = getCount("property_search");
  const propertyViews = getCount("property_click") + getCount("property_view");
  const calculatorUses = getCount("calculator_use");
  const coachSessionCount = getCount("coach_session_start");
  const coachMessageCount = getCount("coach_message_sent");
  const formStarts = getCount("form_start");
  const formAbandons = getCount("form_abandon");
  const ctaClicks = getCount("cta_click");

  const allLastSeen = recentActivities.map(a => a.lastSeen).filter(Boolean);
  const lastActiveAt = allLastSeen.length > 0
    ? allLastSeen.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
    : user.lastActiveAt?.toISOString() || null;

  const daysSinceLastActivity = lastActiveAt
    ? Math.floor((Date.now() - new Date(lastActiveAt).getTime()) / 86400000)
    : null;

  let recentPropertyViews: BehaviorSignals["recentPropertyViews"] = [];
  if (propActivitiesResult.status === "fulfilled") {
    recentPropertyViews = propActivitiesResult.value.map(a => ({
      propertyId: (a.metadata as any)?.propertyId || (a.metadata as any)?.property_id,
      price: parseNum((a.metadata as any)?.price) || undefined,
      viewedAt: a.createdAt?.toISOString() || "",
    }));
  } else {
    console.warn("[BorrowerGraph] Failed to fetch property views:", propActivitiesResult.reason);
  }

  const engagementLevel: "high" | "medium" | "low" | "dormant" =
    daysSinceLastActivity !== null && daysSinceLastActivity > 14 ? "dormant" :
    totalPageViews >= 20 || coachSessionCount >= 2 || propertySearches >= 3 ? "high" :
    totalPageViews >= 5 || coachSessionCount >= 1 || propertySearches >= 1 ? "medium" : "low";

  const likelyToApply = !activeApp && (
    (propertySearches >= 2 && calculatorUses >= 1) ||
    (coachSessionCount >= 1 && formStarts >= 1) ||
    ctaClicks >= 3
  );

  const likelyToAbandon = activeApp?.status === "draft" && (
    daysSinceLastActivity !== null && daysSinceLastActivity > 7
  );

  let suggestedNextAction = "Start your pre-approval application";
  if (activeApp) {
    // Same source of truth as the dashboard's dominant action — the status-
    // driven mapping lives in ONE place (server/services/nextAction.ts).
    suggestedNextAction = computeNextAction({
      application: activeApp,
      pendingTasks: { total: 0, documents: 0 },
      pendingDocuments: 0,
      unreadMessages: 0,
      activitySummary: null,
    }).title;
  } else if (engagementLevel === "dormant") {
    suggestedNextAction = "Welcome back — check out new listings or chat with the Coach";
  } else if (propertySearches > 0 && !activeApp) {
    suggestedNextAction = "Get pre-approved to make offers on homes you've been viewing";
  } else if (coachSessionCount > 0 && !activeApp) {
    suggestedNextAction = "Ready to apply? Your Coach data will pre-fill the application";
  }

  let actionPlan: BorrowerGraph["actionPlan"] = [];
  let documentChecklist: BorrowerGraph["documentChecklist"] = [];

  if (coachConvWithProfile) {
    const ap = coachConvWithProfile.actionPlan as any[];
    if (ap && Array.isArray(ap)) {
      actionPlan = ap.map(item => ({
        id: item.id,
        title: item.title,
        priority: item.priority,
        category: item.category,
        completed: item.completed || false,
      }));
    }
    const dc = coachConvWithProfile.documentChecklist as any[];
    if (dc && Array.isArray(dc)) {
      documentChecklist = dc.map(item => ({
        docType: item.docType,
        label: item.label,
        priority: item.priority,
      }));
    }
  }

  let milestonesAchieved = 0;
  if (milestoneCountResult.status === "fulfilled") {
    milestonesAchieved = milestoneCountResult.value[0]?.cnt || 0;
  } else {
    console.warn("[BorrowerGraph] Failed to fetch milestones:", milestoneCountResult.reason);
  }

  const bProfile = profileRows[0] || null;
  const profileSnapshot: BorrowerProfileSnapshot = {
    citizenshipStatus: bProfile?.citizenshipStatus || null,
    maritalStatus: bProfile?.maritalStatus || null,
    numberOfDependents: bProfile?.numberOfDependents || null,
    currentHousingStatus: bProfile?.currentHousingStatus || null,
    currentMonthlyHousingPayment: parseNum(bProfile?.currentMonthlyHousingPayment) || null,
    militaryStatus: bProfile?.militaryStatus || null,
    hasCoBorrower: bProfile?.hasCoBorrower || false,
    hasForeclosureHistory: bProfile?.hasForeclosureHistory || false,
    hasBankruptcyHistory: bProfile?.hasBankruptcyHistory || false,
    hasRealEstateOwned: bProfile?.hasRealEstateOwned || reoRows.length > 0,
    riskTolerance: bProfile?.riskTolerance || null,
    vaEligible: (bProfile?.militaryStatus === "veteran" || bProfile?.militaryStatus === "active_duty" ||
      bProfile?.militaryStatus === "reserve_national_guard" || bProfile?.militaryStatus === "surviving_spouse") ||
      (activeApp?.isVeteran || false),
  };

  const latestState = stateRows[0] || null;
  const stateSummary: BorrowerStateSummary = {
    currentState: latestState?.toState || "lead",
    previousState: latestState?.fromState || null,
    stateEnteredAt: latestState?.transitionedAt?.toISOString() || null,
    daysInCurrentState: latestState?.transitionedAt
      ? Math.floor((Date.now() - new Date(latestState.transitionedAt).getTime()) / 86400000)
      : null,
    totalTransitions: stateRows.length,
  };

  const checklistSummary: ReadinessChecklistSummary = (() => {
    const totalFields = checklistRows.length;
    const collectedFields = checklistRows.filter(r => r.isCollected).length;
    const verifiedFields = checklistRows.filter(r =>
      r.verificationStatus === "document_extracted" ||
      r.verificationStatus === "third_party_verified" ||
      r.verificationStatus === "manually_verified"
    ).length;

    const categoryMap: Record<string, { total: number; collected: number; verified: number }> = {};
    for (const row of checklistRows) {
      const cat = row.category;
      if (!categoryMap[cat]) categoryMap[cat] = { total: 0, collected: 0, verified: 0 };
      categoryMap[cat].total++;
      if (row.isCollected) categoryMap[cat].collected++;
      if (row.verificationStatus === "document_extracted" ||
        row.verificationStatus === "third_party_verified" ||
        row.verificationStatus === "manually_verified") {
        categoryMap[cat].verified++;
      }
    }

    const calculatedReadinessScore = totalFields > 0
      ? Math.round((collectedFields / totalFields) * 100)
      : 0;

    return { totalFields, collectedFields, verifiedFields, completionByCategory: categoryMap, calculatedReadinessScore };
  })();

  const reoMapped: REOProperty[] = reoRows.map(r => ({
    address: r.propertyAddress,
    propertyType: r.propertyType || null,
    marketValue: parseNum(r.marketValue),
    mortgageBalance: parseNum(r.mortgageBalance),
    mortgagePayment: parseNum(r.mortgagePayment),
    monthlyRentalIncome: parseNum(r.monthlyRentalIncome),
    netEquity: parseNum(r.netEquity) || ((parseNum(r.marketValue) || 0) - (parseNum(r.mortgageBalance) || 0)) || null,
    occupancyType: r.occupancyType || null,
    willBeSold: r.willBeSold || false,
  }));

  const intentMap = new Map(intentCounts.map(e => [e.eventType, e.count]));
  const getIntentCount = (type: string) => intentMap.get(type) || 0;
  const intentScore = Math.min(100,
    getIntentCount("pre_approval_start") * 20 +
    getIntentCount("pre_approval_complete") * 30 +
    getIntentCount("document_upload_complete") * 10 +
    getIntentCount("property_affordability_check") * 8 +
    getIntentCount("calculator_use") * 5 +
    getIntentCount("coach_session_complete") * 8 +
    getIntentCount("lender_comparison_view") * 6 +
    getIntentCount("property_save") * 4 +
    getIntentCount("cta_click") * 3 +
    getIntentCount("return_visit") * 2
  );

  return {
    userId,
    userName: user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.email?.split("@")[0] || null,
    email: user.email || null,
    role: user.role,
    memberSince: user.createdAt?.toISOString() || null,

    profile: profileSnapshot,
    state: stateSummary,
    readinessDetail: checklistSummary,
    realEstateOwned: reoMapped,

    applications: apps.map(a => ({
      id: a.id,
      status: a.status,
      loanPurpose: a.loanPurpose || null,
      preferredLoanType: a.preferredLoanType || null,
      purchasePrice: parseNum(a.purchasePrice),
      downPayment: parseNum(a.downPayment),
      preApprovalAmount: parseNum(a.preApprovalAmount),
      isVeteran: a.isVeteran || false,
      isFirstTimeBuyer: a.isFirstTimeBuyer || false,
      employmentType: a.employmentType || null,
      propertyType: a.propertyType || null,
      propertyState: a.propertyState || null,
      propertyValue: parseNum(a.propertyValue),
      createdAt: a.createdAt?.toISOString() || null,
    })),

    activeApplicationId: activeApp?.id || null,

    financialVerification: {
      income: activeApp?.incomeVerified === true,
      assets: activeApp?.assetsVerified === true,
      credit: activeApp?.creditVerified === true,
      decisionGrade: isDecisionGrade(activeApp?.financialDataProvenance as DataProvenance | undefined),
    },

    income: incomeSources,
    bestAnnualIncome,
    bestIncomeSource,

    assets: assetRecords,
    totalVerifiedAssets,

    liabilities: liabilityRecords,
    totalMonthlyDebts,

    documents: extractedDocs,
    documentsUploaded: eligibleDocs.length,
    documentsVerified: eligibleDocs.filter(d => d.status === "verified").length,
    documentsMissing,

    readiness,
    eligibility: {
      estimatedDTI,
      estimatedLTV,
      creditTier: getCreditTier(creditScore),
      creditScore,
      creditScoreSource,
      employmentStable,
      employmentYears: employmentYears || null,
      hasAdequateSavings,
      estimatedMaxPurchase,
      eligibleLoanTypes,
    },

    goal: {
      goal: goalData?.currentPhase || null,
      targetHomePrice: parseNum(goalData?.targetHomePrice),
      targetDownPayment: parseNum(goalData?.targetDownPayment),
      targetCreditScore: goalData?.targetCreditScore || null,
      targetCity: goalData?.targetCity || null,
      targetState: goalData?.targetState || null,
      currentPhase: goalData?.currentPhase || null,
      savingsProgress: parseNum(goalData?.savingsProgress),
      creditScoreChange: goalData?.creditScoreChange || null,
      journeyDay: goalData?.journeyDay || null,
      milestonesAchieved,
    },

    behavior: {
      totalPageViews,
      propertySearches,
      propertyViews,
      calculatorUses,
      coachSessions: coachSessionCount,
      coachMessages: coachMessageCount,
      formStarts,
      formAbandons,
      ctaClicks,
      lastActiveAt,
      topPages: activityCounts.map(a => ({ page: a.page || "", views: a.views })),
      recentPropertyViews,
    },

    actionPlan,
    documentChecklist,

    predictiveSignals: {
      likelyToApply,
      likelyToAbandon,
      engagementLevel,
      daysSinceLastActivity,
      suggestedNextAction,
      intentScore,
    },
  };
}

export async function getPropertyAffordability(
  userId: string,
  propertyPrice: number,
): Promise<{
  meetsGuidelines: boolean;
  estimatedDTI: number | null;
  estimatedMonthlyPayment: number | null;
  additionalSavingsNeeded: number | null;
  estimatedDownPayment: number;
  eligibleLoanTypes: string[];
  message: string;
}> {
  const graph = await buildBorrowerGraph(userId);

  const downPaymentPercent = 0.05;
  const estimatedDownPayment = Math.round(propertyPrice * downPaymentPercent);
  const loanAmount = propertyPrice - estimatedDownPayment;

  // 6.5% assumed rate, expressed as a percent for the shared helper.
  const term = 360;
  const monthlyPI = monthlyPrincipalAndInterest(loanAmount, 6.5, term);
  const monthlyTaxIns = propertyPrice * 0.015 / 12;
  const estimatedMonthlyPayment = Math.round(monthlyPI + monthlyTaxIns);

  const monthlyIncome = graph.bestAnnualIncome ? graph.bestAnnualIncome / 12 : null;
  const currentDebts = graph.totalMonthlyDebts || 0;
  const estimatedDTI = monthlyIncome ? Math.round(((estimatedMonthlyPayment + currentDebts) / monthlyIncome) * 10000) / 100 : null;

  const totalNeeded = estimatedDownPayment + Math.round(propertyPrice * 0.03);
  const available = graph.totalVerifiedAssets || (graph.assets.length > 0 ? graph.assets[0].balance : 0);
  const additionalSavingsNeeded = available < totalNeeded ? Math.round(totalNeeded - available) : null;

  const meetsGuidelines = (estimatedDTI !== null && estimatedDTI <= 50) && !additionalSavingsNeeded;

  let message: string;
  if (estimatedDTI !== null && additionalSavingsNeeded === null) {
    message = `Based on your current information, the estimated DTI for this property would be ${estimatedDTI}%. Estimated monthly payment: $${estimatedMonthlyPayment?.toLocaleString() || "N/A"}. Final eligibility is determined during underwriting review.`;
  } else if (additionalSavingsNeeded) {
    message = `Based on your current information, an estimated additional $${additionalSavingsNeeded.toLocaleString()} in documented savings may be needed for the down payment and closing costs. Final requirements are determined during underwriting review.`;
  } else {
    message = `Additional financial information is needed to estimate affordability for this property. Complete your application or provide details through Homi.`;
  }

  return {
    meetsGuidelines,
    estimatedDTI,
    estimatedMonthlyPayment,
    additionalSavingsNeeded,
    estimatedDownPayment,
    eligibleLoanTypes: graph.eligibility.eligibleLoanTypes,
    message,
  };
}
