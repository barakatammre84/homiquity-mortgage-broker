import { db } from "../db";
import { canonicalDocumentType } from "@shared/documentTypes";
import { storage } from "../storage";
import { getCoachIntakeSnapshots } from "./coachIntake";
import {
  readinessChecklist,
  intentEvents,
  borrowerStateHistory,
  lenderMatchResults,
  lenderProducts,
  anonymizedBorrowerFacts,
  users,
  loanApplications,
  brokerCommissions,
  wholesaleLenders,
  documents,
  pickActiveLoanApplication,
} from "@shared/schema";
import type { BorrowerState, TransitionTrigger } from "@shared/schema";
import { eq, and, sql, gte, lte, desc, lt, isNull, ne, count, avg } from "drizzle-orm";
import { updateReadinessField, getReadinessScore, initializeReadinessChecklist } from "./intentTracker";
import { transitionState, getCurrentState } from "./borrowerStateMachine";
import { buildBorrowerGraph } from "./borrowerGraph";
import { sendNotificationEmail } from "./emailService";
import crypto from "crypto";
import type { DatabaseTransaction } from "./documentLineage";

// ---------------------------------------------------------------------------
// Extraction → readiness wiring (finding F-030)
//
// WHAT WAS BROKEN. This map was indexed by VALUE name against the caller's
// `extractedFields`, which every extractor emits as a `string[]` of field NAMES
// plus lineage — never values. So `extractedFields[sourceField]` was `undefined`
// for every value-bearing row and only the three `documentPresence` entries,
// which short-circuit before the lookup, ever updated. A borrower could upload a
// pay stub and the system learned only that a pay stub existed, never their
// income — so it asked again. That is the wiring behind the busy work.
//
// It was not merely a type slip: the names were wrong too. The map looked for
// `totalIncome`, `grossPay`(ok), `payFrequency`, `totalBalance` and `accounts`,
// where the real interfaces in server/extractionCore.ts declare
// `adjustedGrossIncome`/`grossIncome`, `closingBalance` and `accountNumber`.
// `let extractedData: any` at the call site hid all of it from tsc.
//
// THE FIX. The caller now passes the extracted OBJECT, typed, and each readiness
// field carries a resolver reading real interface fields. A resolver returning
// undefined/null/"" means "this document did not yield that fact" and the field
// is skipped honestly rather than being recorded as document-extracted.
//
// `w2` and `government_id` are not in THIS map because no W-2 or ID extractor
// exists — the only caller (POST /api/documents/:id/extract) rejects those
// types outright. They are not dropped, though: both are REQUIRED readiness
// fields, and they are satisfied by DOCUMENT_PRESENCE_FIELD below, which
// credits presence on upload without needing a model to read the page. An
// earlier pass deleted them from here and stopped, which left two required
// fields with no writer at all — see that block's header.
//
// `lease_agreement` has an extractor but no honest readiness target — rental
// income is not a READINESS_FIELDS entry — so it is deliberately unmapped.
// ---------------------------------------------------------------------------

/** Reads one readiness fact out of an extraction result. */
interface ReadinessMapping {
  /** A fieldName from READINESS_FIELDS (services/intentTracker.ts). */
  fieldName: string;
  /** Recorded as lineage on the readiness row, so the source stays auditable. */
  sourceField: string;
  /**
   * The value backing this field, or undefined when the document did not
   * yield it. `null` marks a presence-only row: the document itself is the
   * fact, so no value is required.
   */
  resolve: (data: Record<string, any>) => unknown;
}

/** The document exists and extracted cleanly — that IS the fact. */
const PRESENT = () => null;

const DOCUMENT_FIELD_MAP: Record<string, ReadinessMapping[]> = {
  tax_return: [
    {
      fieldName: "annual_income",
      sourceField: "adjustedGrossIncome|grossIncome",
      // AGI is the underwriting-preferred figure; gross income is the fallback.
      resolve: d => d.adjustedGrossIncome ?? d.grossIncome,
    },
    {
      fieldName: "income_sources",
      sourceField: "w2Wages|scheduleC|scheduleE",
      // A breakdown exists only when the return actually shows components.
      resolve: d => d.w2Wages ?? d.scheduleC?.netProfitLoss ?? d.scheduleE?.netRentalIncomeLoss,
    },
    { fieldName: "tax_returns", sourceField: "documentPresence", resolve: PRESENT },
  ],
  pay_stub: [
    // Deliberately NOT annual_income: a pay stub states period gross, and
    // annualizing it needs a pay frequency this extractor does not emit.
    // YTD gross is the honest figure a stub carries.
    { fieldName: "employer_name", sourceField: "employerName", resolve: d => d.employerName },
    { fieldName: "pay_stubs", sourceField: "documentPresence", resolve: PRESENT },
  ],
  bank_statement: [
    { fieldName: "total_assets", sourceField: "closingBalance", resolve: d => d.closingBalance },
    { fieldName: "bank_accounts", sourceField: "accountNumber", resolve: d => d.accountNumber },
    { fieldName: "down_payment_source", sourceField: "accountType", resolve: d => d.accountType },
    { fieldName: "bank_statements", sourceField: "documentPresence", resolve: PRESENT },
  ],
};

// ---------------------------------------------------------------------------
// Document presence → readiness, INDEPENDENT of extraction.
//
// Why this exists separately from the map above: `w2_forms` and `government_id`
// are seeded as REQUIRED readiness fields (weight 1.5 and 1.0), but there is no
// W-2 or ID extractor and there never was, so no automated path could ever
// satisfy them. The readiness score was permanently capped and the borrower was
// asked again for documents they had already uploaded — the busy work the
// extraction fix was meant to remove, arriving through a different door.
//
// Presence is its own fact and does not need a model to read the page. Handing
// over your driver's licence IS the completion of "government-issued ID". So
// this credits presence on upload for every canonical type with a readiness
// row, whether or not an extractor exists for it.
//
// TRUST LADDER — deliberately honest, and it only ever climbs because
// updateReadinessField upgrades by tier rank and never downgrades:
//   upload → self_reported      (tier3) "the borrower says this is their W-2"
//   extract → document_extracted (tier1) a model actually read it
//   verify → manually_verified   (tier1) a human confirmed it
// Upload does NOT claim tier 1: an unread, unverified file is the borrower's
// assertion about what they attached, nothing stronger.
// ---------------------------------------------------------------------------
const DOCUMENT_PRESENCE_FIELD: Record<string, string> = {
  pay_stub: "pay_stubs",
  w2: "w2_forms",
  tax_return: "tax_returns",
  bank_statement: "bank_statements",
  government_id: "government_id",
};

/** The readiness field a document type completes by simply existing, if any. */
export function presenceFieldFor(documentType: string): string | null {
  return DOCUMENT_PRESENCE_FIELD[canonicalDocumentType(documentType)] ?? null;
}

export async function creditDocumentPresence(
  userId: string,
  documentId: string,
  documentType: string,
  /** "uploaded" = the borrower's assertion; "verified" = a human confirmed it. */
  strength: "uploaded" | "verified",
  transaction: DatabaseTransaction | typeof db = db,
): Promise<{ fieldUpdated: string | null }> {
  // Aliases resolve first — drivers_license/passport/id all mean government_id.
  const fieldName = presenceFieldFor(documentType);
  if (!fieldName) return { fieldUpdated: null };

  await initializeReadinessChecklist(userId, undefined, transaction);
  try {
    await updateReadinessField(userId, fieldName, {
      verificationStatus: strength === "verified" ? "manually_verified" : "self_reported",
      sourceTable: "documents",
      sourceField: "documentPresence",
      sourceRecordId: documentId,
    }, transaction);
    return { fieldUpdated: fieldName };
  } catch (err) {
    console.warn(`[Readiness] presence credit failed for ${fieldName}:`, err);
    return { fieldUpdated: null };
  }
}

export async function wireExtractionToReadiness(
  userId: string,
  documentId: string,
  documentType: string,
  /** The extraction RESULT (values + lineage), not its list of field names. */
  extracted: Record<string, any>,
  confidence: string,
  transaction: DatabaseTransaction | typeof db = db,
): Promise<{ fieldsUpdated: string[]; skipped: string[] }> {
  if (confidence === "low") {
    return { fieldsUpdated: [], skipped: ["all - low confidence"] };
  }

  await initializeReadinessChecklist(userId, undefined, transaction);

  const mappings = DOCUMENT_FIELD_MAP[documentType];
  if (!mappings) {
    return { fieldsUpdated: [], skipped: [`no readiness mapping for document type: ${documentType}`] };
  }

  const fieldsUpdated: string[] = [];
  const skipped: string[] = [];

  for (const { fieldName, sourceField, resolve } of mappings) {
    const value = resolve(extracted);
    const isPresenceRow = value === null;
    const hasData = isPresenceRow || (value !== undefined && value !== "");

    if (!hasData) {
      skipped.push(`${fieldName}: not present in the extracted ${documentType}`);
      continue;
    }

    try {
      await updateReadinessField(userId, fieldName, {
        verificationStatus: "document_extracted",
        sourceTable: "documents",
        sourceField,
        sourceRecordId: documentId,
      }, transaction);
      fieldsUpdated.push(fieldName);
    } catch (err) {
      skipped.push(`${fieldName}: update failed`);
    }
  }

  return { fieldsUpdated, skipped };
}

// Full pipeline coverage — previously only the pre-approval-and-terminal
// subset was mapped, so the borrower journey state machine froze at
// pre-qualification for any loan that progressed. Called from
// updatePipelineStage on every status change; this map is the single
// translation between pipeline status and journey state.
const APP_STATUS_TO_STATE_MAP: Record<string, { state: BorrowerState; trigger: TransitionTrigger }> = {
  submitted: { state: "profiling", trigger: "application_started" },
  analyzing: { state: "pre_qualification", trigger: "application_submitted" },
  under_review: { state: "pre_qualification", trigger: "application_submitted" },
  pre_approved: { state: "pre_approval", trigger: "pre_approval_issued" },
  doc_collection: { state: "pre_approval", trigger: "documents_uploaded" },
  processing: { state: "in_contract", trigger: "offer_accepted" },
  underwriting: { state: "underwriting", trigger: "underwriting_submitted" },
  conditional: { state: "conditional_approval", trigger: "conditions_cleared" },
  clear_to_close: { state: "clear_to_close", trigger: "clear_to_close_issued" },
  closing: { state: "closing", trigger: "closing_scheduled" },
  denied: { state: "denied", trigger: "application_denied" },
  funded: { state: "funded", trigger: "funded" },
  withdrawn: { state: "withdrawn", trigger: "borrower_withdrew" },
  expired: { state: "expired", trigger: "application_expired" },
};

export async function syncApplicationStatusToStateMachine(
  userId: string,
  applicationId: string,
  newApplicationStatus: string
): Promise<{ synced: boolean; fromState: string; toState: string; error?: string }> {
  const mapping = APP_STATUS_TO_STATE_MAP[newApplicationStatus];
  if (!mapping) {
    return { synced: false, fromState: "", toState: "", error: `No state mapping for status: ${newApplicationStatus}` };
  }

  const currentState = await getCurrentState(userId);

  if (currentState === mapping.state) {
    return { synced: true, fromState: currentState, toState: mapping.state };
  }

  const result = await transitionState(userId, mapping.state, mapping.trigger, {
    applicationId,
    metadata: { source: "application_status_sync", applicationStatus: newApplicationStatus },
  });

  return {
    synced: result.success,
    fromState: result.fromState,
    toState: result.toState,
    error: result.error,
  };
}

export async function getCoachPreFillData(userId: string): Promise<{
  preFillFields: Record<string, { value: any; source: string; confidence: string }>;
  completionHint: string;
}> {
  const preFillFields: Record<string, { value: any; source: string; confidence: string }> = {};

  try {
    // One conversations query + one batched messages query (was an N+1 loop).
    const { snapshots } = await getCoachIntakeSnapshots(userId);

    const PREFILL_FIELDS = [
      "annualIncome", "monthlyDebts", "creditScore", "purchasePrice", "downPayment",
      "propertyType", "employmentType", "employmentYears", "isFirstTimeBuyer",
      "isVeteran", "loanPurpose",
    ] as const;

    for (const intake of snapshots) {
      for (const field of PREFILL_FIELDS) {
        if ((intake as any)[field] && !(field in preFillFields)) {
          preFillFields[field] = {
            value: (intake as any)[field],
            source: "coach_conversation",
            confidence: "tier3",
          };
        }
      }
    }
  } catch (err) {
    console.warn("[PreFill] Coach data retrieval failed:", err);
  }

  try {
    const applications = await storage.getLoanApplicationsByUser(userId);
    // Pre-fill source: the in-flight file if one exists, else the most recent
    // file of any status — old figures are still the borrower's figures.
    const activeApp = pickActiveLoanApplication(applications) || applications[0];

    if (activeApp) {
      const appFieldMap: Record<string, { value: any; key: string }> = {
        annualIncome: { value: activeApp.annualIncome, key: "annualIncome" },
        monthlyDebts: { value: activeApp.monthlyDebts, key: "monthlyDebts" },
        purchasePrice: { value: activeApp.purchasePrice, key: "purchasePrice" },
        downPayment: { value: activeApp.downPayment, key: "downPayment" },
        propertyType: { value: activeApp.propertyType, key: "propertyType" },
      };

      for (const [_, { value, key }] of Object.entries(appFieldMap)) {
        if (value && !(key in preFillFields)) {
          preFillFields[key] = {
            value,
            source: "existing_application",
            confidence: "tier2",
          };
        }
      }
    }
  } catch (err) {
    console.warn("[PreFill] Application data retrieval failed:", err);
  }

  const fieldCount = Object.keys(preFillFields).length;
  const completionHint = fieldCount > 5
    ? "We've pre-filled most of your application from previous conversations"
    : fieldCount > 0
      ? `We've pre-filled ${fieldCount} fields from your previous data`
      : "Start your application from scratch";

  return { preFillFields, completionHint };
}

export async function detectStaleApplications(): Promise<Array<{
  userId: string;
  email: string | null;
  userName: string;
  applicationId: string;
  currentState: string;
  readinessScore: number;
  daysSinceLastActivity: number;
  nextMissingField: string | null;
}>> {
  const staleDays = 3;
  const minReadiness = 30;
  const cutoffDate = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);

  const activeApps = await db.select({
    userId: loanApplications.userId,
    applicationId: loanApplications.id,
    status: loanApplications.status,
    updatedAt: loanApplications.updatedAt,
  })
    .from(loanApplications)
    .where(and(
      sql`${loanApplications.status} IN ('draft', 'submitted', 'analyzing')`,
      lte(loanApplications.updatedAt, cutoffDate),
    ));

  const staleResults: Array<{
    userId: string;
    email: string | null;
    userName: string;
    applicationId: string;
    currentState: string;
    readinessScore: number;
    daysSinceLastActivity: number;
    nextMissingField: string | null;
  }> = [];

  // Batch-load users once rather than one getUser per application in the loop.
  const reengageUsers = await storage.getUsersByIds([...new Set(activeApps.map((a) => a.userId))]);
  const reengageUserById = new Map(reengageUsers.map((u) => [u.id, u]));

  for (const app of activeApps) {
    try {
      const readiness = await getReadinessScore(app.userId);
      if (readiness.overallScore < minReadiness) continue;

      const user = reengageUserById.get(app.userId);
      if (!user?.email) continue;

      const currentState = await getCurrentState(app.userId);
      const terminalStates: BorrowerState[] = ["withdrawn", "denied", "expired", "funded", "homeowner"];
      if (terminalStates.includes(currentState)) continue;

      const daysSinceLastActivity = Math.floor(
        (Date.now() - new Date(app.updatedAt || 0).getTime()) / (24 * 60 * 60 * 1000)
      );

      staleResults.push({
        userId: app.userId,
        email: user.email,
        userName: user.firstName || user.email?.split("@")[0] || "Borrower",
        applicationId: app.applicationId,
        currentState,
        readinessScore: readiness.overallScore,
        daysSinceLastActivity,
        nextMissingField: readiness.missingRequired[0] || null,
      });
    } catch (err) {
      console.warn(`[ReEngagement] Error processing user ${app.userId}:`, err);
    }
  }

  return staleResults;
}

export async function sendReEngagementEmails(): Promise<{ sent: number; errors: number }> {
  const staleApps = await detectStaleApplications();
  let sent = 0;
  let errors = 0;

  for (const app of staleApps) {
    try {
      if (!app.email) continue;

      sendNotificationEmail({
        type: "status_update",
        recipientEmail: app.email,
        data: {
          borrowerName: app.userName,
          statusLabel: `You're ${app.readinessScore}% ready! ${app.nextMissingField ? `Next step: provide your ${app.nextMissingField}` : "Continue your application to get pre-approved."}`,
          applicationId: app.applicationId,
        },
      });

      await db.insert(intentEvents).values({
        userId: app.userId,
        eventType: "return_visit",
        eventCategory: "engagement",
        metadata: {
          source: "re_engagement_email",
          readinessScore: app.readinessScore,
          daysSinceLastActivity: app.daysSinceLastActivity,
        },
      });

      sent++;
    } catch (err) {
      errors++;
      console.error(`[ReEngagement] Email send error for ${app.userId}:`, err);
    }
  }

  return { sent, errors };
}

export async function matchAndPriceBorrower(
  userId: string,
  options?: { lockTermDays?: number; productTypes?: string[] }
): Promise<{
  matches: Array<{
    lenderProductId: string;
    lenderName: string;
    productName: string;
    matchScore: number;
    matchStatus: string;
    offers: Array<{
      productId: string;
      productName: string;
      adjustedRate: number;
      estimatedMonthlyTotal: number;
      lenderFees: any;
    }>;
  }>;
  totalEligible: number;
  totalOffers: number;
}> {
  const { matchBorrowerToLenders } = await import("./lenderMatchingEngine");
  const { computeOffers } = await import("./pricingAdapter");

  const matchResults = await matchBorrowerToLenders(userId, { forceRefresh: true });
  const eligibleMatches = matchResults.filter(m => m.status === "eligible" || m.status === "conditionally_eligible");

  const graph = await buildBorrowerGraph(userId);
  const activeApp = graph.applications.find(a => a.id === graph.activeApplicationId);

  if (!activeApp || !activeApp.purchasePrice || !activeApp.downPayment) {
    return {
      matches: eligibleMatches.map(m => ({
        lenderProductId: m.product.id,
        lenderName: m.product.lenderName,
        productName: m.product.productName,
        matchScore: m.score,
        matchStatus: m.status,
        offers: [],
      })),
      totalEligible: eligibleMatches.length,
      totalOffers: 0,
    };
  }

  const loanAmount = activeApp.purchasePrice - activeApp.downPayment;

  const lenderIdSet = new Set<string>();
  for (const match of eligibleMatches) {
    if (match.product.lenderId) {
      lenderIdSet.add(match.product.lenderId);
    }
  }

  let offers: any[] = [];
  try {
    const lenderIds = Array.from(lenderIdSet);

    const wholesaleLendersList = await storage.getWholesaleLenders({ status: "ACTIVE" });
    const matchedWholesaleIds = wholesaleLendersList
      .filter(wl => lenderIds.some(lid => 
        wl.lenderId === lid || wl.lenderName.toLowerCase().includes(lid.toLowerCase())
      ))
      .map(wl => wl.id);

    if (matchedWholesaleIds.length > 0) {
      offers = await computeOffers(storage as any, {
        creditScore: graph.eligibility.creditScore || 700,
        loanAmount,
        propertyValue: activeApp.purchasePrice,
        propertyType: (activeApp.propertyType as any) || "single_family",
        occupancyType: "primary_residence",
        loanPurpose: (activeApp.loanPurpose as any) || "purchase",
        isFirstTimeHomeBuyer: activeApp.isFirstTimeBuyer || false,
        borrowerIncome: graph.bestAnnualIncome || 0,
        lockTermDays: options?.lockTermDays || 30,
        lenderIds: matchedWholesaleIds,
        productTypes: options?.productTypes,
      });
    }
  } catch (err) {
    console.warn("[MatchAndPrice] Offer computation failed:", err);
  }

  const combined = eligibleMatches.map(match => {
    const matchOffers = offers.filter(o =>
      o.lenderName.toLowerCase() === match.product.lenderName.toLowerCase()
    );

    return {
      lenderProductId: match.product.id,
      lenderName: match.product.lenderName,
      productName: match.product.productName,
      matchScore: match.score,
      matchStatus: match.status,
      offers: matchOffers.map(o => ({
        productId: o.productId,
        productName: o.productName,
        adjustedRate: o.adjustedRate,
        estimatedMonthlyTotal: o.estimatedMonthlyTotal,
        lenderFees: o.lenderFees,
      })),
    };
  });

  return {
    matches: combined,
    totalEligible: eligibleMatches.length,
    totalOffers: offers.length,
  };
}

export async function wirePlaidToReadiness(
  userId: string,
  verificationType: "identity" | "income" | "employment" | "assets",
  verifiedData: Record<string, any>
): Promise<{ fieldsUpdated: string[] }> {
  await initializeReadinessChecklist(userId);

  const fieldsUpdated: string[] = [];

  const plaidFieldMap: Record<string, string[]> = {
    identity: ["full_name", "date_of_birth"],
    income: ["annual_income", "income_sources"],
    employment: ["employer_name", "employment_type", "employment_duration"],
    assets: ["total_assets", "bank_accounts", "down_payment_source"],
  };

  const fields = plaidFieldMap[verificationType] || [];

  for (const fieldName of fields) {
    try {
      await updateReadinessField(userId, fieldName, {
        verificationStatus: "third_party_verified",
        sourceTable: "plaid_verification",
        sourceField: verificationType,
        sourceRecordId: verifiedData.itemId || undefined,
      });
      fieldsUpdated.push(fieldName);
    } catch (err) {
      console.warn(`[Plaid] Failed to update readiness field ${fieldName}:`, err);
    }
  }

  return { fieldsUpdated };
}

function bucketize(value: number, ranges: Array<{ min: number; max: number; label: string }>): string {
  for (const range of ranges) {
    if (value >= range.min && value < range.max) return range.label;
  }
  return "unknown";
}

export async function aggregateAnonymizedData(): Promise<{
  factsCreated: number;
  borrowersProcessed: number;
}> {
  const PII_SALT = process.env.PII_HASH_SALT || "default-salt";
  const cohortDate = new Date();
  cohortDate.setHours(0, 0, 0, 0);

  const allUsers = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.role, "borrower"));

  const cohortMap = new Map<string, {
    dtis: number[];
    ltvs: number[];
    loanAmounts: number[];
    downPaymentPercents: number[];
    creditScores: number[];
    incomes: number[];
    count: number;
    geoState: string;
    creditBucket: string;
    incomeBucket: string;
    loanPurpose: string;
    propertyType: string;
  }>();

  let borrowersProcessed = 0;

  for (const user of allUsers) {
    try {
      const graph = await buildBorrowerGraph(user.id);
      if (!graph.eligibility.creditScore && !graph.bestAnnualIncome) continue;

      const activeApp = graph.applications.find(a => a.id === graph.activeApplicationId);

      const creditScore = graph.eligibility.creditScore || 0;
      const income = graph.bestAnnualIncome || 0;
      const loanPurpose = activeApp?.loanPurpose || "unknown";
      const propertyType = activeApp?.propertyType || "unknown";
      const dti = graph.eligibility.estimatedDTI || 0;

      const creditBucket = bucketize(creditScore, [
        { min: 0, max: 580, label: "below_580" },
        { min: 580, max: 620, label: "580_619" },
        { min: 620, max: 660, label: "620_659" },
        { min: 660, max: 700, label: "660_699" },
        { min: 700, max: 740, label: "700_739" },
        { min: 740, max: 780, label: "740_779" },
        { min: 780, max: 10000, label: "780_plus" },
      ]);

      const incomeBucket = bucketize(income, [
        { min: 0, max: 30000, label: "below_30k" },
        { min: 30000, max: 50000, label: "30k_50k" },
        { min: 50000, max: 75000, label: "50k_75k" },
        { min: 75000, max: 100000, label: "75k_100k" },
        { min: 100000, max: 150000, label: "100k_150k" },
        { min: 150000, max: 250000, label: "150k_250k" },
        { min: 250000, max: 10000000, label: "250k_plus" },
      ]);

      const cohortKey = `${creditBucket}|${incomeBucket}|${loanPurpose}|${propertyType}`;

      if (!cohortMap.has(cohortKey)) {
        cohortMap.set(cohortKey, {
          dtis: [],
          ltvs: [],
          loanAmounts: [],
          downPaymentPercents: [],
          creditScores: [],
          incomes: [],
          count: 0,
          geoState: "national",
          creditBucket,
          incomeBucket,
          loanPurpose,
          propertyType,
        });
      }

      const cohort = cohortMap.get(cohortKey)!;
      cohort.count++;
      if (dti > 0) cohort.dtis.push(dti);
      if (creditScore > 0) cohort.creditScores.push(creditScore);
      if (income > 0) cohort.incomes.push(income);

      if (activeApp?.purchasePrice && activeApp?.downPayment) {
        const loanAmount = activeApp.purchasePrice - activeApp.downPayment;
        const ltv = (loanAmount / activeApp.purchasePrice) * 100;
        const downPct = (activeApp.downPayment / activeApp.purchasePrice) * 100;
        cohort.loanAmounts.push(loanAmount);
        cohort.ltvs.push(ltv);
        cohort.downPaymentPercents.push(downPct);
      }

      borrowersProcessed++;
    } catch (err) {
      continue;
    }
  }

  let factsCreated = 0;

  const cohortEntries = Array.from(cohortMap.entries());
  for (const [_, cohort] of cohortEntries) {
    if (cohort.count < 5) continue;

    const median = (arr: number[]) => {
      if (arr.length === 0) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const average = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    await db.insert(anonymizedBorrowerFacts).values({
      cohortDate,
      geoStateBucket: cohort.geoState,
      creditScoreBucket: cohort.creditBucket,
      incomeBucket: cohort.incomeBucket,
      loanPurpose: cohort.loanPurpose,
      propertyType: cohort.propertyType,
      avgDti: average(cohort.dtis)?.toFixed(2) ?? undefined,
      avgLtv: average(cohort.ltvs)?.toFixed(2) ?? undefined,
      avgLoanAmount: average(cohort.loanAmounts)?.toFixed(2) ?? undefined,
      avgDownPaymentPercent: average(cohort.downPaymentPercents)?.toFixed(2) ?? undefined,
      medianCreditScore: median(cohort.creditScores) ? Math.round(median(cohort.creditScores)!) : undefined,
      medianIncome: median(cohort.incomes)?.toFixed(2) ?? undefined,
      borrowerCount: cohort.count,
    });
    factsCreated++;
  }

  return { factsCreated, borrowersProcessed };
}

/**
 * Compute (and record) the referral payout on a funded loan.
 *
 * UNCALLED TODAY, and blocked from being called: roadmap 3.7 schedules wiring
 * it to the funded-loan transition, and roadmap 1.10 holds that behind the open
 * Reg Z §1026.36(d)(1) / RESPA §8 questions (ledger
 * `regz-1026-36d1-referral-commission-payout`). When it IS wired, it must write
 * through `evaluateCommissionPayout` (shared/commissionPayout.ts) the way
 * `POST /api/broker/commissions` does, so that both paths bound the payout by
 * the same rule and audit it the same way — this one inserts straight into the
 * table and does neither.
 */
export async function calculateAgentCommission(
  applicationId: string,
  fundedAmount: number
): Promise<{
  commissionAmount: number;
  commissionRate: number;
  lenderCompensation: any;
  breakdown: Record<string, any>;
} | null> {
  const app = await storage.getLoanApplication(applicationId);
  if (!app) return null;

  const user = await storage.getUser(app.userId);
  if (!user?.referredByUserId) return null;

  const referrer = await storage.getUser(user.referredByUserId);
  // Audit F-21: this gate previously also tested for a role string "agent",
  // which is not in shared/roles.ts ALL_ROLES and so could never match. It is
  // removed rather than "fixed" by adding a role: the self-registering realtor
  // and cpa partner personas are referral sources, and whether a referral
  // source may be paid a share of compensation at all is the open RESPA §8
  // question in ledger entry `regz-1026-36d1-referral-commission-payout`.
  // Widening this gate is that question's answer, not a typo fix.
  if (!referrer || referrer.role !== "broker") return null;

  let lenderCompensation: any = null;
  // NOT a default — a sentinel. Audit F-21: this was 275, the TOP of the seeded
  // comp range (100–275, default 200), so an unresolvable comp plan paid 25% of
  // a basis 37.5% higher than the real one. A fallback inside a payout
  // calculation must err low or refuse; this one refuses.
  let brokerCompBps: number | null = null;

  try {
    const matchResults = await db.select()
      .from(lenderMatchResults)
      .where(and(
        eq(lenderMatchResults.userId, app.userId),
        eq(lenderMatchResults.applicationId, applicationId),
      ))
      .orderBy(desc(lenderMatchResults.matchScore))
      .limit(1);

    if (matchResults.length > 0) {
      const product = await db.select().from(lenderProducts)
        .where(eq(lenderProducts.id, matchResults[0].lenderProductId))
        .limit(1);

      if (product.length > 0) {
        const wholesaleLendersList = await storage.getWholesaleLenders({ status: "ACTIVE" });
        const matchedWholesale = wholesaleLendersList.find(wl =>
          wl.lenderId === product[0].lenderId || wl.lenderName === product[0].lenderName
        );

        if (matchedWholesale?.brokerCompensation) {
          lenderCompensation = matchedWholesale.brokerCompensation;
          const comp = matchedWholesale.brokerCompensation as any;
          if (comp.defaultBps) brokerCompBps = comp.defaultBps;
        }
      }
    }
  } catch (err) {
    console.warn("[Commission] Failed to lookup lender compensation:", err);
  }

  // No resolvable comp plan means the revenue this payout is a share of is
  // unknown, and an unknown must never be treated as "assume the richest".
  // Refusing costs a recoverable delay; guessing high costs cash.
  if (brokerCompBps === null) {
    console.warn(
      `[Commission] No lender compensation plan resolved for application ${applicationId} — ` +
        `refusing to compute a payout rather than assuming one.`,
    );
    return null;
  }

  const totalBrokerRevenue = (fundedAmount * brokerCompBps) / 10000;

  const AGENT_SHARE_PERCENT = 25;
  const agentCommission = (totalBrokerRevenue * AGENT_SHARE_PERCENT) / 100;
  const effectiveRate = (agentCommission / fundedAmount) * 10000;

  try {
    await db.insert(brokerCommissions).values({
      brokerId: referrer.id,
      applicationId,
      loanAmount: fundedAmount.toFixed(2),
      commissionRate: (effectiveRate / 10000).toFixed(4),
      commissionAmount: agentCommission.toFixed(2),
      status: "pending",
      notes: JSON.stringify({
        brokerCompBps,
        totalBrokerRevenue: totalBrokerRevenue.toFixed(2),
        agentSharePercent: AGENT_SHARE_PERCENT,
        lenderCompensation,
        calculatedAt: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.warn("[Commission] Failed to create commission record:", err);
  }

  return {
    commissionAmount: agentCommission,
    commissionRate: effectiveRate,
    lenderCompensation,
    breakdown: {
      fundedAmount,
      brokerCompBps,
      totalBrokerRevenue,
      agentSharePercent: AGENT_SHARE_PERCENT,
      agentCommission,
    },
  };
}
