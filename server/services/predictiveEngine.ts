import { db } from "../db";
import { storage } from "../storage";
import {
  predictiveSnapshots,
  loanOutcomes,
  anonymizedBorrowerFacts,
  loanApplications,
  borrowerStateHistory,
  documentConfidenceScores,
  analyticsEvents,
  pickActiveLoanApplication,
} from "@shared/schema";
import { eq, and, gte, sql, desc, isNotNull, avg } from "drizzle-orm";
import { buildBorrowerGraph } from "./borrowerGraph";
import { emitEvent } from "./analyticsEventPipeline";
import { isCommittedStage } from "@shared/stageRequirements";
import { createHash } from "crypto";

interface PredictionInput {
  creditScore: number | null;
  dti: number | null;
  ltv: number | null;
  loanPurpose: string | null;
  productType: string | null;
  employmentType: string | null;
  employmentYears: number | null;
  documentsUploaded: number;
  documentsVerified: number;
  daysInPipeline: number;
  conditionsOutstanding: number;
  conditionsTotal: number;
  hasForeclosure: boolean;
  hasBankruptcy: boolean;
  isFirstTimeBuyer: boolean;
  isVeteran: boolean;
  engagementLevel: string;
  intentScore: number;
  committedStage: boolean;
  financialsVerified: boolean;
}

export function scoreFinancialPredictionSignals(input: Pick<PredictionInput,
  "financialsVerified" | "creditScore" | "dti" | "ltv" | "employmentYears" | "isVeteran"
>): { scoreDelta: number; riskFactors: string[]; positiveFactors: string[] } {
  if (!input.financialsVerified) {
    return { scoreDelta: 0, riskFactors: [], positiveFactors: [] };
  }

  let scoreDelta = 0;
  const riskFactors: string[] = [];
  const positiveFactors: string[] = [];

  if (input.creditScore) {
    if (input.creditScore >= 740) { scoreDelta += 15; positiveFactors.push("Excellent credit score"); }
    else if (input.creditScore >= 700) { scoreDelta += 10; positiveFactors.push("Good credit score"); }
    else if (input.creditScore >= 660) { scoreDelta += 3; }
    else if (input.creditScore >= 620) { scoreDelta -= 5; riskFactors.push("Below-average credit score"); }
    else { scoreDelta -= 15; riskFactors.push("Low credit score increases fallout risk"); }
  } else {
    scoreDelta -= 5;
    riskFactors.push("Credit score not yet verified");
  }

  if (input.dti !== null) {
    if (input.dti <= 36) { scoreDelta += 10; positiveFactors.push("Low debt-to-income ratio"); }
    else if (input.dti <= 43) { scoreDelta += 3; }
    else if (input.dti <= 50) { scoreDelta -= 8; riskFactors.push("High DTI may require compensating factors"); }
    else { scoreDelta -= 15; riskFactors.push("DTI exceeds standard thresholds"); }
  }

  if (input.ltv !== null) {
    if (input.ltv <= 80) { scoreDelta += 5; positiveFactors.push("20%+ down payment (no PMI)"); }
    else if (input.ltv <= 95) { scoreDelta += 1; }
    else { scoreDelta -= 5; riskFactors.push("Very high LTV increases risk"); }
  }

  if (input.employmentYears !== null) {
    if (input.employmentYears >= 2) { scoreDelta += 5; positiveFactors.push("Stable employment history"); }
    else if (input.employmentYears < 1) { scoreDelta -= 5; riskFactors.push("Less than 1 year at current employer"); }
  }

  if (input.isVeteran) { scoreDelta += 3; positiveFactors.push("VA loan eligible"); }
  return { scoreDelta, riskFactors, positiveFactors };
}

function hashInput(input: PredictionInput): string {
  return createHash("md5").update(JSON.stringify(input)).digest("hex");
}

export async function computePrediction(
  userId: string,
  applicationId?: string
): Promise<{
  likelihoodToClose: number;
  estimatedDaysToFund: number;
  riskOfFallout: number;
  conditionDelayRisk: number;
  riskFactors: string[];
  positiveFactors: string[];
  comparisonCohort: string;
  cohortAvgDaysToClose: number | null;
  cohortConversionRate: number | null;
}> {
  let graph;
  try {
    graph = await buildBorrowerGraph(userId, applicationId);
  } catch (e) {
    return getDefaultPrediction();
  }

  const activeApp = applicationId
    ? graph.applications.find(a => a.id === applicationId)
    : pickActiveLoanApplication(graph.applications);

  const conditions = activeApp ? await storage.getLoanConditionsByApplication(activeApp.id) : [];
  const conditionsOutstanding = conditions.filter(c => c.status === "outstanding").length;

  const input: PredictionInput = {
    creditScore: graph.eligibility.creditScore,
    dti: graph.eligibility.estimatedDTI,
    ltv: graph.eligibility.estimatedLTV,
    loanPurpose: activeApp?.loanPurpose || null,
    productType: activeApp?.preferredLoanType || null,
    employmentType: activeApp?.employmentType || null,
    employmentYears: graph.eligibility.employmentYears,
    documentsUploaded: graph.documentsUploaded,
    documentsVerified: graph.documentsVerified,
    daysInPipeline: activeApp?.createdAt
      ? Math.round((Date.now() - new Date(activeApp.createdAt).getTime()) / (1000 * 60 * 60 * 24))
      : 0,
    conditionsOutstanding,
    conditionsTotal: conditions.length,
    hasForeclosure: graph.profile.hasForeclosureHistory,
    hasBankruptcy: graph.profile.hasBankruptcyHistory,
    isFirstTimeBuyer: activeApp?.isFirstTimeBuyer || false,
    isVeteran: activeApp?.isVeteran || false,
    engagementLevel: graph.predictiveSignals.engagementLevel,
    intentScore: graph.predictiveSignals.intentScore,
    // Once the borrower has a pre-approval or later, engagement-based
    // "uncertainty" signals no longer apply (§4.3). Part of the input so the
    // prediction cache differentiates committed vs. pre-commitment borrowers.
    committedStage: isCommittedStage(activeApp?.status),
    financialsVerified: graph.financialVerification.decisionGrade,
  };

  const inputHash = hashInput(input);

  const cacheScope = [
    eq(predictiveSnapshots.userId, userId),
    eq(predictiveSnapshots.inputHash, inputHash),
    gte(predictiveSnapshots.expiresAt, sql`now()`),
  ];
  if (activeApp) cacheScope.push(eq(predictiveSnapshots.applicationId, activeApp.id));
  const [cached] = await db.select().from(predictiveSnapshots)
    .where(and(...cacheScope))
    .limit(1);

  if (cached) {
    return {
      likelihoodToClose: parseFloat(cached.likelihoodToClose || "0"),
      estimatedDaysToFund: cached.estimatedDaysToFund || 30,
      riskOfFallout: parseFloat(cached.riskOfFallout || "0"),
      conditionDelayRisk: parseFloat(cached.conditionDelayRisk || "0"),
      riskFactors: (cached.riskFactors as string[]) || [],
      positiveFactors: (cached.positiveFactors as string[]) || [],
      comparisonCohort: cached.comparisonCohort || "",
      cohortAvgDaysToClose: cached.cohortAvgDaysToClose,
      cohortConversionRate: cached.cohortConversionRate ? parseFloat(cached.cohortConversionRate) : null,
    };
  }

  const riskFactors: string[] = [];
  const positiveFactors: string[] = [];
  let score = 50;

  // Credit, DTI, LTV, and employment-duration labels read as qualification
  // findings. Keep them out of the close-outlook score and its borrower-facing
  // reasons until all financial dimensions are verified.
  const financialSignals = scoreFinancialPredictionSignals(input);
  score += financialSignals.scoreDelta;
  riskFactors.push(...financialSignals.riskFactors);
  positiveFactors.push(...financialSignals.positiveFactors);

  if (input.documentsUploaded >= 5) { score += 5; positiveFactors.push("Strong document submission"); }
  else if (input.documentsUploaded <= 1) { score -= 5; riskFactors.push("Few documents submitted"); }

  if (input.documentsVerified >= 3) { score += 5; positiveFactors.push("Multiple documents verified"); }

  if (input.conditionsTotal > 0) {
    const clearedPct = (input.conditionsTotal - input.conditionsOutstanding) / input.conditionsTotal;
    if (clearedPct >= 0.8) { score += 5; positiveFactors.push("Most conditions cleared"); }
    else if (input.conditionsOutstanding > 5) { score -= 5; riskFactors.push("Many outstanding conditions"); }
  }

  if (input.hasForeclosure) { score -= 10; riskFactors.push("Prior foreclosure history"); }
  if (input.hasBankruptcy) { score -= 8; riskFactors.push("Prior bankruptcy history"); }

  if (input.engagementLevel === "high") { score += 5; positiveFactors.push("High platform engagement"); }
  else if (!input.committedStage) {
    // Engagement-based uncertainty signals only apply pre-commitment. A borrower
    // at pre-approval or beyond has demonstrated intent; low recent clickstream
    // activity there means mid-process, not wavering — flagging "uncertain /
    // inactive" would contradict their status (§4.3).
    if (input.engagementLevel === "dormant") { score -= 10; riskFactors.push("Borrower appears inactive"); }
    else if (input.engagementLevel === "low") { score -= 3; riskFactors.push("Low engagement may indicate uncertainty"); }
  }

  if (input.intentScore >= 70) { score += 5; positiveFactors.push("Strong intent signals"); }

  const likelihoodToClose = Math.max(0.05, Math.min(0.95, score / 100));
  const riskOfFallout = Math.max(0.05, Math.min(0.95, 1 - likelihoodToClose));

  let conditionDelayRisk = 0.2;
  if (input.conditionsOutstanding > 5) conditionDelayRisk = 0.7;
  else if (input.conditionsOutstanding > 3) conditionDelayRisk = 0.5;
  else if (input.conditionsOutstanding > 0) conditionDelayRisk = 0.3;

  let baseDays = 30;
  if (likelihoodToClose > 0.7) baseDays = 22;
  else if (likelihoodToClose > 0.5) baseDays = 30;
  else baseDays = 42;
  if (conditionDelayRisk > 0.5) baseDays += 7;
  const estimatedDaysToFund = baseDays;

  const creditBucket = input.financialsVerified && input.creditScore ? getCreditBucketLabel(input.creditScore) : "unknown";
  const cohortKey = `${creditBucket}_${input.loanPurpose || "purchase"}`;

  const [cohortData] = await db.select({
    avgDays: sql<number>`avg(${loanOutcomes.totalDaysToClose})::int`,
    convRate: sql<number>`(count(*) filter (where ${loanOutcomes.outcome} = 'funded')::numeric / NULLIF(count(*)::numeric, 0))::numeric(5,4)`,
  }).from(loanOutcomes)
    .where(and(
      eq(loanOutcomes.creditScoreBucket, creditBucket),
      isNotNull(loanOutcomes.outcome)
    ));

  const result = {
    likelihoodToClose,
    estimatedDaysToFund,
    riskOfFallout,
    conditionDelayRisk,
    riskFactors,
    positiveFactors,
    comparisonCohort: cohortKey,
    cohortAvgDaysToClose: cohortData?.avgDays || null,
    cohortConversionRate: cohortData?.convRate || null,
  };

  await db.insert(predictiveSnapshots).values({
    userId,
    applicationId: applicationId || activeApp?.id || null,
    likelihoodToClose: likelihoodToClose.toFixed(4),
    estimatedDaysToFund,
    riskOfFallout: riskOfFallout.toFixed(4),
    conditionDelayRisk: conditionDelayRisk.toFixed(4),
    riskFactors,
    positiveFactors,
    comparisonCohort: cohortKey,
    cohortAvgDaysToClose: cohortData?.avgDays || null,
    cohortConversionRate: cohortData?.convRate?.toFixed(4) || null,
    modelVersion: "v1",
    inputHash,
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
  });

  await emitEvent("system", "prediction_computed", {
    userId,
    applicationId: applicationId || activeApp?.id,
    numericValue: likelihoodToClose,
    payload: { riskFactors: riskFactors.length, positiveFactors: positiveFactors.length },
    automationTriggered: true,
  });

  return result;
}

function getCreditBucketLabel(score: number): string {
  if (score >= 760) return "760+";
  if (score >= 720) return "720-759";
  if (score >= 680) return "680-719";
  if (score >= 640) return "640-679";
  return "below_640";
}

function getDefaultPrediction() {
  return {
    likelihoodToClose: 0.5,
    estimatedDaysToFund: 30,
    riskOfFallout: 0.5,
    conditionDelayRisk: 0.3,
    riskFactors: ["Insufficient data for detailed prediction"],
    positiveFactors: [],
    comparisonCohort: "unknown",
    cohortAvgDaysToClose: null,
    cohortConversionRate: null,
  };
}

export async function getBorrowerBenchmark(
  userId: string
): Promise<{
  yourMetrics: {
    creditScore: number | null;
    dti: number | null;
    ltv: number | null;
    documentsSubmitted: number;
    daysInProcess: number | null;
  };
  cohortMetrics: {
    avgCreditScore: number | null;
    avgDti: number | null;
    avgLtv: number | null;
    avgDaysToClose: number | null;
    conversionRate: number | null;
    totalBorrowers: number;
  };
  percentiles: {
    creditScorePercentile: number | null;
    dtiPercentile: number | null;
    speedPercentile: number | null;
  };
  insights: string[];
}> {
  let graph;
  try {
    graph = await buildBorrowerGraph(userId);
  } catch (e) {
    return getDefaultBenchmark();
  }

  const activeApp = pickActiveLoanApplication(graph.applications);
  const financialsVerified = graph.financialVerification.decisionGrade;
  const creditBucket = financialsVerified && graph.eligibility.creditScore
    ? getCreditBucketLabel(graph.eligibility.creditScore)
    : null;
  const daysInProcess = activeApp?.createdAt
    ? Math.round((Date.now() - new Date(activeApp.createdAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const yourMetrics = {
    creditScore: financialsVerified ? graph.eligibility.creditScore : null,
    dti: financialsVerified ? graph.eligibility.estimatedDTI : null,
    ltv: financialsVerified ? graph.eligibility.estimatedLTV : null,
    documentsSubmitted: graph.documentsUploaded,
    daysInProcess,
  };

  const cohortConditions = [];
  if (creditBucket) cohortConditions.push(eq(anonymizedBorrowerFacts.creditScoreBucket, creditBucket));
  if (activeApp?.loanPurpose) cohortConditions.push(eq(anonymizedBorrowerFacts.loanPurpose, activeApp.loanPurpose));

  const [cohort] = await db.select({
    avgDti: sql<number>`avg(${anonymizedBorrowerFacts.avgDti}::numeric)::numeric(5,2)`,
    avgLtv: sql<number>`avg(${anonymizedBorrowerFacts.avgLtv}::numeric)::numeric(5,2)`,
    avgDays: sql<number>`avg(${anonymizedBorrowerFacts.avgTimeToCloseDays}::numeric)::numeric(5,1)`,
    convRate: sql<number>`avg(${anonymizedBorrowerFacts.conversionRate}::numeric)::numeric(5,4)`,
    totalBorrowers: sql<number>`sum(${anonymizedBorrowerFacts.borrowerCount})::int`,
    medianCredit: sql<number>`avg(${anonymizedBorrowerFacts.medianCreditScore})::int`,
  }).from(anonymizedBorrowerFacts)
    .where(cohortConditions.length > 0 ? and(...cohortConditions) : undefined);

  const cohortMetrics = {
    avgCreditScore: cohort?.medianCredit || null,
    avgDti: cohort?.avgDti || null,
    avgLtv: cohort?.avgLtv || null,
    avgDaysToClose: cohort?.avgDays || null,
    conversionRate: cohort?.convRate || null,
    totalBorrowers: cohort?.totalBorrowers || 0,
  };

  const insights: string[] = [];
  if (yourMetrics.creditScore && cohortMetrics.avgCreditScore) {
    if (yourMetrics.creditScore > cohortMetrics.avgCreditScore + 20) {
      insights.push("Your credit score is above average for similar borrowers");
    } else if (yourMetrics.creditScore < cohortMetrics.avgCreditScore - 20) {
      insights.push("Improving your credit score could help you get better rates");
    }
  }
  if (yourMetrics.dti !== null && cohortMetrics.avgDti !== null) {
    if (yourMetrics.dti < cohortMetrics.avgDti - 3) {
      insights.push("Your debt-to-income ratio is better than most similar borrowers");
    } else if (yourMetrics.dti > cohortMetrics.avgDti + 5) {
      insights.push("Reducing monthly debts could strengthen your application");
    }
  }
  if (daysInProcess !== null && cohortMetrics.avgDaysToClose !== null) {
    if (daysInProcess < cohortMetrics.avgDaysToClose * 0.7) {
      insights.push("Your loan is progressing faster than average");
    }
  }
  if (graph.documentsUploaded >= 5) {
    insights.push("Strong document submission helps speed up processing");
  }

  let creditPercentile: number | null = null;
  if (yourMetrics.creditScore) {
    if (yourMetrics.creditScore >= 760) creditPercentile = 90;
    else if (yourMetrics.creditScore >= 720) creditPercentile = 75;
    else if (yourMetrics.creditScore >= 680) creditPercentile = 55;
    else if (yourMetrics.creditScore >= 640) creditPercentile = 35;
    else creditPercentile = 15;
  }

  let dtiPercentile: number | null = null;
  if (yourMetrics.dti !== null) {
    if (yourMetrics.dti <= 28) dtiPercentile = 90;
    else if (yourMetrics.dti <= 36) dtiPercentile = 70;
    else if (yourMetrics.dti <= 43) dtiPercentile = 45;
    else dtiPercentile = 20;
  }

  let speedPercentile: number | null = null;
  if (daysInProcess !== null && cohortMetrics.avgDaysToClose) {
    const ratio = daysInProcess / cohortMetrics.avgDaysToClose;
    if (ratio <= 0.5) speedPercentile = 90;
    else if (ratio <= 0.8) speedPercentile = 70;
    else if (ratio <= 1.0) speedPercentile = 50;
    else speedPercentile = 25;
  }

  return {
    yourMetrics,
    cohortMetrics,
    percentiles: {
      creditScorePercentile: creditPercentile,
      dtiPercentile,
      speedPercentile,
    },
    insights,
  };
}

function getDefaultBenchmark() {
  return {
    yourMetrics: {
      creditScore: null,
      dti: null,
      ltv: null,
      documentsSubmitted: 0,
      daysInProcess: null,
    },
    cohortMetrics: {
      avgCreditScore: null,
      avgDti: null,
      avgLtv: null,
      avgDaysToClose: null,
      conversionRate: null,
      totalBorrowers: 0,
    },
    percentiles: {
      creditScorePercentile: null,
      dtiPercentile: null,
      speedPercentile: null,
    },
    insights: ["Complete your application to see how you compare to similar borrowers"],
  };
}
