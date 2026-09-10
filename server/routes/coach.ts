import type { Express, Request, Response } from "express";
import { isAuthenticated } from "../auth";
import { storage } from "../storage";
import { runCoachTurn, CoachTurnError, isCoachConfigured, type CoachTurnResult, type CoachEmit, type VerifiedUserContext, type CoachIntakeData, deriveUserType, deriveReadinessState, deriveCompletionPercentage, deriveCompletedSteps, coachIntakeSchema, coachActionPlanSchema, coachDocumentChecklistSchema, coachProfileSchema } from "../services/coachingService";
import { buildBorrowerGraph } from "../services/borrowerGraph";
import { getCoachIntakeSnapshots } from "../services/coachIntake";
import { loadFileTruth, EMPTY_LOAN_STATUS } from "../services/coachFileTruth";
import { deriveReadinessProfile } from "../services/coachingContext";
import { beginSse, writeSse } from "../sse";
import {
  detectSensitiveInput,
  SENSITIVE_INPUT_MESSAGES,
  SENSITIVE_INPUT_REDACTED_PLACEHOLDER,
} from "../services/sensitiveInputGuard";
import { scanForEscalationTriggers } from "@shared/compliance/complaintEscalation";
import { escalateFlaggedMessage } from "../services/complaintEscalation";
import { logAudit } from "../auditLog";
import { pickActiveLoanApplication, pickWorkableLoanApplication } from "@shared/schema";
import type { CoachConversation, User } from "@shared/schema";
import { z } from "zod";
import { emitEvent } from "../services/analyticsEventPipeline";
import {
  buildHomiTurnFailurePayload,
  buildHomiTurnOutcomePayload,
} from "../services/homiOutcomeEvaluation";

/**
 * The only values `documents.notes.confidence` may take. Anything a legacy row
 * carries that is not on this list is discarded rather than passed through to
 * the coach prompt — see the read site below (F-027 follow-up).
 */
const EXTRACTION_CONFIDENCE_LEVELS: readonly string[] = ["high", "medium", "low"];
import { routeParam } from "../http/routeParams";

const messageSchema = z.object({
  message: z.string().min(1).max(5000),
  conversationId: z.string().optional(),
  propertyPrice: z.number().optional(),
  propertyAddress: z.string().optional(),
});

function normalizedQuestion(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isRepeatedQuestion(
  message: string,
  history: Array<{ role: string; content: string }>,
): boolean {
  const normalized = normalizedQuestion(message);
  if (normalized.length < 8) return false;
  return history.some((item) =>
    item.role === "user" && normalizedQuestion(item.content) === normalized
  );
}

async function recordHomiOutcome(input: {
  userId: string;
  userRole: string;
  applicationId: string | null;
  conversationId: string;
  repeatedQuestion: boolean;
  completionBefore: number | null;
  completionAfter: number | null;
  startedAt: number;
  result: CoachTurnResult;
}) {
  const responseMs = Date.now() - input.startedAt;
  await emitEvent("borrower", "homi_turn_completed", {
    applicationId: input.result.state.syncedApplicationId ?? input.applicationId ?? undefined,
    userId: input.userId,
    actorId: input.userId,
    actorRole: input.userRole,
    entityType: "coach_conversation",
    entityId: input.conversationId,
    numericValue: responseMs,
    source: "homi",
    payload: buildHomiTurnOutcomePayload({
      repeatedQuestion: input.repeatedQuestion,
      completionBefore: input.completionBefore,
      completionAfter: input.completionAfter,
      degraded: input.result.degraded,
      lintReplaced: input.result.lintReplaced,
      modelCalls: input.result.usage.modelCalls,
      toolCalls: input.result.toolCalls,
      captureOutcome: input.result.state.captureOutcome,
      humanHelpRequest: input.result.state.humanHelpRequest,
    }),
  });
}

async function recordHomiFailure(input: {
  userId: string;
  userRole: string;
  applicationId: string | null;
  conversationId: string;
  startedAt: number;
  code: string;
  streamOpened: boolean;
}) {
  await emitEvent("borrower", "homi_turn_failed", {
    applicationId: input.applicationId ?? undefined,
    userId: input.userId,
    actorId: input.userId,
    actorRole: input.userRole,
    entityType: "coach_conversation",
    entityId: input.conversationId,
    numericValue: Date.now() - input.startedAt,
    source: "homi",
    payload: buildHomiTurnFailurePayload({
      code: input.code,
      streamOpened: input.streamOpened,
    }),
  });
}

async function refreshReadinessAfterCapture(input: {
  userId: string;
  verifiedContext: VerifiedUserContext;
  result: CoachTurnResult;
  emit: CoachEmit;
}): Promise<number | null> {
  const before = input.verifiedContext.completionPercentage ?? null;
  if ((input.result.state.captureOutcome?.appliedFields.length ?? 0) === 0) return before;

  try {
    const graph = await buildBorrowerGraph(
      input.userId,
      input.result.state.syncedApplicationId ?? undefined,
    );
    if (!graph) return null;
    const refreshedContext: VerifiedUserContext = {
      ...input.verifiedContext,
      completionPercentage: graph.readiness.completionPercentage,
      readinessTier: graph.readiness.tier,
      completedInputs: graph.readiness.completedInputs,
      outstandingInputs: graph.readiness.outstandingInputs,
      documentsMissing: graph.documentsMissing,
      documentsUploaded: graph.documentsUploaded,
      documentsVerified: graph.documentsVerified,
    };
    const profile = deriveReadinessProfile(refreshedContext);
    input.result.state.profile = profile;
    input.emit({ type: "panel", profile, source: "file" });
    return graph.readiness.completionPercentage;
  } catch (error) {
    console.error("[HomiOutcome] Failed to refresh the post-turn server snapshot:", error);
    return null;
  }
}

async function buildVerifiedContext(userId: string, user: User, propertyContext?: { price: number; address: string } | null): Promise<VerifiedUserContext> {
  try {
    const applications = await storage.getLoanApplicationsByUser(userId);
    // Coach context: the in-flight file first; else the funded one (post-close
    // coaching still needs the closed loan's facts); else the most recent file
    // of any status so the coach is never blind to history.
    const activeApp = pickActiveLoanApplication(applications)
      ?? applications.find(a => a.status === "funded")
      ?? applications[0];

    // TWO resolutions on purpose, and they are not interchangeable.
    //
    // `activeApp` above is deliberately wide — it falls back to the most recent
    // file of ANY status so the narrative context is never blind to history.
    // That is right for prose ("your last application was withdrawn") and wrong
    // for a tool that tells a borrower which documents to upload: the `??
    // applications[0]` tail silently resurrects denied/withdrawn/funded files,
    // which is how uploads once landed on a closed loan (see
    // pickWorkableLoanApplication's docblock). The server-truth tools target
    // the workable file or nothing at all.
    const workableApp = pickWorkableLoanApplication(applications);

    if (!activeApp) {
      return {
        hasApplication: false,
        userName: user.firstName && user.lastName
          ? `${user.firstName} ${user.lastName}`
          : (user.email?.split("@")[0] || undefined),
      };
    }

    let employmentHistory: VerifiedUserContext["employmentHistory"] = [];
    try {
      const { db: database } = await import("../db");
      const { employmentHistory: empTable } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const empRecords = await database.select().from(empTable)
        .where(eq(empTable.applicationId, activeApp.id));
      employmentHistory = empRecords.map(e => ({
        employerName: e.employerName,
        positionTitle: e.positionTitle,
        isSelfEmployed: e.isSelfEmployed || false,
        startDate: e.startDate,
        totalMonthlyIncome: e.totalMonthlyIncome,
      }));
    } catch (e) {
      console.warn("[Coach] Could not fetch employment history:", e);
    }

    let uploadedDocuments: VerifiedUserContext["uploadedDocuments"] = [];
    try {
      const docs = await storage.getDocumentsByApplication(activeApp.id);
      uploadedDocuments = docs.map(d => {
        let extractionConfidence: "high" | "medium" | "low" | null = null;

        // Only `confidence` is read here, and only because it is one of the
        // keys the extraction writers actually emit. The other reads that used
        // to live here — employeeName, employerName, issues, and the
        // payPeriodEnd/statementEndDate/statementDate/documentYear date keys —
        // are written by NO extractor in this repo, so they could only ever be
        // populated by a borrower typing JSON into the upload description box,
        // which landed verbatim in this column. `issues` was the worst of them:
        // coachingContext interpolates it UNESCAPED into a prompt block headed
        // "DOCUMENT-VERIFIED DATA (HIGHEST TRUST) … overrides EVERYTHING else",
        // in a request that carries live tool access — a clean prompt-injection
        // primitive (F-027). Deleted, not sanitized: there is no legitimate
        // producer to sanitize for (F-028).
        if (d.notes) {
          try {
            const lineage = JSON.parse(d.notes as string);
            // Validate against the enum, do NOT trust the parsed value. JSON.parse
            // returns `any`, so the declared "high" | "medium" | "low" type above is
            // not enforced at runtime — and coachingContext interpolates this string
            // VERBATIM into a prompt that carries live tool access. Checking only
            // that the *key* exists (as the first cut of this fix did) leaves the
            // *value* attacker-controlled on any pre-0046 row, where borrower text
            // could still be sitting in `notes`. Anything off-enum is dropped.
            if (EXTRACTION_CONFIDENCE_LEVELS.includes(lineage.confidence)) {
              extractionConfidence = lineage.confidence;
            }
          } catch {
            // notes is not valid JSON, skip
          }
        }

        return {
          documentType: d.documentType,
          status: d.status || "uploaded",
          uploadDate: d.createdAt ? new Date(d.createdAt).toISOString().split("T")[0] : null,
          extractionConfidence,
        };
      });
    } catch (e) {
      console.warn("[Coach] Could not fetch documents:", e);
    }

    const context: VerifiedUserContext = {
      hasApplication: true,
      workableApplicationId: workableApp?.id ?? null,
      applicationStatus: activeApp.status,
      annualIncome: activeApp.annualIncome,
      monthlyDebts: activeApp.monthlyDebts,
      creditScore: activeApp.creditScore,
      employmentType: activeApp.employmentType,
      employmentYears: activeApp.employmentYears,
      employerName: activeApp.employerName,
      isVeteran: activeApp.isVeteran || false,
      isFirstTimeBuyer: activeApp.isFirstTimeBuyer || false,
      dtiRatio: activeApp.dtiRatio,
      ltvRatio: activeApp.ltvRatio,
      preApprovalAmount: activeApp.preApprovalAmount,
      purchasePrice: activeApp.purchasePrice,
      downPayment: activeApp.downPayment,
      preferredLoanType: activeApp.preferredLoanType,
      propertyType: activeApp.propertyType,
      loanPurpose: activeApp.loanPurpose,
      employmentHistory,
      uploadedDocuments,
      userName: user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : (user.email?.split("@")[0] || undefined),
    };

    try {
      const graph = await buildBorrowerGraph(userId);
      if (graph) {
        context.completionPercentage = graph.readiness.completionPercentage;
        context.readinessTier = graph.readiness.tier;
        context.outstandingInputs = graph.readiness.outstandingInputs;
        context.completedInputs = graph.readiness.completedInputs;
        context.documentsMissing = graph.documentsMissing;
        context.documentsUploaded = graph.documentsUploaded;
        context.documentsVerified = graph.documentsVerified;
        context.daysSinceLastActivity = graph.predictiveSignals.daysSinceLastActivity;
        context.engagementLevel = graph.predictiveSignals.engagementLevel;
        context.suggestedNextAction = graph.predictiveSignals.suggestedNextAction;

        const selfEmployed = employmentHistory?.some(e => e.isSelfEmployed);
        const multipleIncomes = (employmentHistory?.length || 0) > 1;
        context.hasMultipleIncomes = multipleIncomes;
        context.hasBusinessIncome = selfEmployed || false;

        const investmentPropertyTypes = ["investment", "investment_property", "rental", "multi_family"];
        const propertyTypeVal = (activeApp?.propertyType || "").toLowerCase();
        const loanPurposeVal = (activeApp?.loanPurpose || "").toLowerCase();
        const occupancyVal = ((activeApp as any)?.occupancyType || (activeApp as any)?.occupancy || "").toLowerCase();
        context.hasInvestmentProperties = investmentPropertyTypes.includes(propertyTypeVal)
          || loanPurposeVal.includes("investment")
          || loanPurposeVal.includes("rental")
          || occupancyVal === "investment"
          || occupancyVal === "non_owner_occupied"
          || occupancyVal === "investor";
      }
    } catch (e) {
      console.warn("[Coach] Could not enrich context from Borrower Graph:", e);
    }

    if (propertyContext) {
      context.propertyContext = propertyContext;
    }

    context.userType = deriveUserType(context);
    context.readinessState = deriveReadinessState(context);
    context.completionPercentage = deriveCompletionPercentage(context);
    context.completedSteps = deriveCompletedSteps(context);

    return context;
  } catch (error) {
    console.error("[Coach] Error building verified context:", error);
    return { hasApplication: false };
  }
}

function getLatestIntakeFromConversation(
  conversation: any,
  latestResponse?: { intake?: CoachIntakeData }
): CoachIntakeData | null {
  const intake: CoachIntakeData = {};
  
  const existingProfile = conversation.financialProfile as any;
  if (existingProfile) {
    if (existingProfile.annualIncome) intake.annualIncome = String(existingProfile.annualIncome);
    if (existingProfile.creditScore) intake.creditScore = String(existingProfile.creditScore);
  }

  if (latestResponse?.intake) {
    Object.assign(intake, latestResponse.intake);
  }

  return Object.keys(intake).length > 0 ? intake : null;
}

export function registerCoachRoutes(app: Express) {
  app.get("/api/coach/conversations", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const conversations = await storage.getCoachConversationsByUser(user.id);
      res.json(conversations);
    } catch (error) {
      console.error("Get coach conversations error:", error);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  app.get("/api/coach/intake/latest", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      // One conversations query + one batched messages query (was an N+1 loop).
      const { snapshots, conversations: sorted } = await getCoachIntakeSnapshots(user.id);

      if (sorted.length === 0) {
        return res.json(null);
      }

      const intake: CoachIntakeData = {};

      for (const snapshot of snapshots) {
        const msgIntakeParsed = coachIntakeSchema.safeParse(snapshot);
        if (msgIntakeParsed.success) {
          for (const [key, val] of Object.entries(msgIntakeParsed.data)) {
            if (val !== null && val !== undefined && val !== "" && !(key in intake)) {
              (intake as any)[key] = val;
            }
          }
        }
      }

      const latestConv = sorted[0];
      const rawProfile = latestConv.financialProfile as any;
      const readinessTier = latestConv.readinessTier;
      const completionPercentage = latestConv.completionPercentage;

      const validatedIntake = Object.keys(intake).length > 0
        ? coachIntakeSchema.safeParse(intake)
        : null;
      const validatedProfile = rawProfile
        ? coachProfileSchema.safeParse(rawProfile)
        : null;
      const validatedActionPlan = latestConv.actionPlan
        ? coachActionPlanSchema.safeParse(latestConv.actionPlan)
        : null;
      const validatedChecklist = latestConv.documentChecklist
        ? coachDocumentChecklistSchema.safeParse(latestConv.documentChecklist)
        : null;

      res.json({
        intake: validatedIntake?.success ? validatedIntake.data : null,
        readinessTier,
        completionPercentage,
        profile: validatedProfile?.success ? validatedProfile.data : null,
        actionPlan: validatedActionPlan?.success ? validatedActionPlan.data : null,
        documentChecklist: validatedChecklist?.success ? validatedChecklist.data : null,
        updatedAt: latestConv.updatedAt,
      });
    } catch (error) {
      console.error("Get coach intake error:", error);
      res.status(500).json({ error: "Failed to fetch coach intake" });
    }
  });

  app.get("/api/coach/conversations/:id", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const conversation = await storage.getCoachConversation(routeParam(req, "id"));
      if (!conversation || conversation.userId !== user.id) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      const messages = await storage.getCoachMessages(conversation.id);
      res.json({ conversation, messages });
    } catch (error) {
      console.error("Get coach conversation error:", error);
      res.status(500).json({ error: "Failed to fetch conversation" });
    }
  });

  const DAILY_COACH_MESSAGE_LIMIT = 30;

  interface PreparedCoachTurn {
    user: User;
    message: string;
    conversation: CoachConversation;
    history: Array<{ role: string; content: string }>;
    userMessageId: string;
    remaining: number;
    verifiedContext: VerifiedUserContext;
    repeatedQuestion: boolean;
  }

  // Shared pre-flight for both message endpoints: validate, enforce the daily
  // cap, resolve/create the conversation, snapshot history BEFORE persisting
  // the new user message (the old flow inserted first and re-fetched, so the
  // model saw the user's message twice), then persist it and build context.
  // Writes the error response itself and returns null when the turn must not run.
  //
  // `scanText` is the message as the borrower actually typed it, BEFORE the
  // sensitive-input guard swaps in its placeholder. Only the CS2 complaint
  // scan reads it, and that scan is pure — it returns categories and keeps
  // nothing. Passing the redacted placeholder instead would silently lose a
  // discrimination allegation that happened to share a message with an SSN.
  async function prepareCoachTurn(
    req: Request,
    res: Response,
    scanText?: string,
  ): Promise<PreparedCoachTurn | null> {
    const user = req.user as User;
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid message", details: parsed.error.issues });
      return null;
    }

    const { message, conversationId, propertyPrice, propertyAddress } = parsed.data;
    const propertyCtx = propertyPrice && propertyAddress
      ? { price: propertyPrice, address: propertyAddress }
      : null;

    const todayCount = await storage.countUserCoachMessagesToday(user.id);
    if (todayCount >= DAILY_COACH_MESSAGE_LIMIT) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      res.status(429).json({
        error: "Daily message limit reached",
        remaining: 0,
        dailyLimit: DAILY_COACH_MESSAGE_LIMIT,
        resetsAt: new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      });
      return null;
    }

    let conversation: CoachConversation | undefined;
    if (conversationId) {
      conversation = await storage.getCoachConversation(conversationId);
      if (!conversation || conversation.userId !== user.id) {
        res.status(404).json({ error: "Conversation not found" });
        return null;
      }
    } else {
      conversation = await storage.createCoachConversation({
        userId: user.id,
        title: message.substring(0, 100),
        status: "active",
      });
    }

    const existingMessages = await storage.getCoachMessages(conversation.id);
    const history = existingMessages.map(m => ({
      role: m.role,
      content: m.content,
    }));
    const repeatedQuestion = isRepeatedQuestion(message, history);

    const userMsg = await storage.createCoachMessage({
      conversationId: conversation.id,
      role: "user",
      content: message,
    });

    // CS2: the same escalation scan the Messages surface runs, on the same
    // vocabulary, with the same fire-and-forget posture — it NEVER blocks,
    // alters, or delays the turn, and the borrower sees no tip-off. Without
    // this, a borrower could allege discrimination or a credit-reporting
    // error to the assistant and nobody would ever be told, while the same
    // words typed into Messages escalate to the founder immediately.
    const complaintScan = scanForEscalationTriggers(scanText ?? message);
    if (complaintScan.flagged) {
      logAudit(req, "complaint.flagged", "coach_message", userMsg.id, {
        categories: complaintScan.categories,
        conversationId: conversation.id,
        senderId: user.id,
      });
      escalateFlaggedMessage(storage, {
        messageId: userMsg.id,
        surface: "coach_message",
        userId: user.id,
        applicationId: null,
        categories: complaintScan.categories,
      }).catch((e) => console.error("[complaints] founder escalation failed:", e));
    }

    const verifiedContext = await buildVerifiedContext(user.id, user, propertyCtx);

    if (conversation.readinessTier) {
      verifiedContext.previousReadinessTier = conversation.readinessTier as string;
    }
    if (conversation.financialProfile && typeof conversation.financialProfile === "object") {
      const prevProfile = conversation.financialProfile as any;
      if (prevProfile.completionPercentage !== undefined && prevProfile.completionPercentage !== null) {
        verifiedContext.previousCompletionPercentage = prevProfile.completionPercentage;
      }
    }

    return {
      user,
      message,
      conversation,
      history,
      userMessageId: userMsg.id,
      remaining: Math.max(0, DAILY_COACH_MESSAGE_LIMIT - todayCount - 1),
      verifiedContext,
      repeatedQuestion,
    };
  }

  // Persist the assistant turn. coach_messages.structuredData keeps EXACTLY
  // the legacy shape (borrowerGraph readiness, GET /api/coach/intake/latest,
  // and the Pre-Approval prefill all read it), and the conversation-level
  // jsonb merge mirrors the pre-rebuild logic — with one deliberate change:
  // completionPercentage is now ALWAYS the server-derived figure (runCoachTurn
  // stamps it on state.profile); the model never controls it.
  async function persistAssistantTurn(
    conversation: CoachConversation,
    verifiedContext: VerifiedUserContext,
    result: CoachTurnResult,
  ) {
    const state = result.state;
    const hasStructuredData = !!(
      state.profile || state.intake || state.actionPlan || state.documentChecklist || state.borrowerPackage
    );

    const assistantMsg = await storage.createCoachMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: result.message,
      structuredData: hasStructuredData
        ? {
            profile: state.profile || null,
            intake: state.intake || null,
            actionPlan: state.actionPlan || null,
            documentChecklist: state.documentChecklist || null,
            borrowerPackage: state.borrowerPackage || null,
          }
        : null,
    });

    const updateData: Record<string, any> = {};

    if (verifiedContext.readinessTier) {
      updateData.readinessTier = verifiedContext.readinessTier;
    }

    if (state.profile) {
      updateData.financialProfile = state.profile;
      if (state.profile.readinessTier) {
        updateData.readinessTier = state.profile.readinessTier;
      }
      updateData.completionPercentage = state.profile.completionPercentage;
    } else if (verifiedContext.completionPercentage !== undefined) {
      // The model did not call set_readiness this turn, so there is no profile
      // to write — only a server-derived percentage. That belongs in the
      // dedicated `completionPercentage` COLUMN, which is what the branch above
      // also writes.
      //
      // This used to spread the percentage into `financialProfile` instead, and
      // on a conversation's first turn `existingProfile` is `{}` — so the column
      // the client reads as a whole CoachProfile got `{completionPercentage: 88}`
      // and nothing else. `ReadinessPanel` then dereferenced
      // `profile.completedInputs.length` on an absent array and took the entire
      // /ai-coach page down through the error boundary. Rows in that shape
      // already exist, which is why the client defends itself too.
      updateData.completionPercentage = verifiedContext.completionPercentage;
      if (conversation.financialProfile && typeof conversation.financialProfile === "object") {
        updateData.financialProfile = {
          ...(conversation.financialProfile as Record<string, unknown>),
          completionPercentage: verifiedContext.completionPercentage,
        };
      }
    }
    if (state.actionPlan) {
      updateData.actionPlan = state.actionPlan;
    }
    if (state.documentChecklist) {
      updateData.documentChecklist = state.documentChecklist;
    }

    if (Object.keys(updateData).length > 0) {
      await storage.updateCoachConversation(conversation.id, updateData);
    }

    return assistantMsg;
  }

  // Streaming variant. SSE protocol (one JSON object per frame):
  //   meta  {conversationId, userMessageId, remaining, degraded?}
  //   text  {delta}
  //   captured {applicationId, created, applied[], skipped[]}
  //   panel {profile? | actionPlan? | documentChecklist? | borrowerPackage? | suggestions?}
  //   lint_replaced {categories, citations}
  //   done  {messageId, usage, remaining}
  //   error {code, message, retryable}
  app.post("/api/coach/message/stream", isAuthenticated, async (req, res) => {
    let streaming = false;
    let outcomeIdentity: {
      userId: string;
      userRole: string;
      applicationId: string | null;
      conversationId: string;
    } | null = null;
    const turnStartedAt = Date.now();
    try {
      // Input-side sensitive-data guard: runs BEFORE prepareCoachTurn so a
      // pasted SSN/DOB is never persisted, never enters model context, and
      // never lands in a log. The stored user message becomes the redacted
      // placeholder; the reply is canned (no model call, no ai_interactions
      // row — nothing was invoked).
      const rawMessage = typeof req.body?.message === "string" ? req.body.message : "";
      const guardHit = detectSensitiveInput(rawMessage);
      if (guardHit) {
        req.body.message = SENSITIVE_INPUT_REDACTED_PLACEHOLDER;
      }

      const prep = await prepareCoachTurn(req, res, rawMessage);
      if (!prep) return;
      outcomeIdentity = {
        userId: prep.user.id,
        userRole: prep.user.role,
        applicationId: prep.verifiedContext.workableApplicationId ?? null,
        conversationId: prep.conversation.id,
      };

      if (guardHit) {
        const guardMessage = SENSITIVE_INPUT_MESSAGES[guardHit.kind];
        const assistantMsg = await storage.createCoachMessage({
          conversationId: prep.conversation.id,
          role: "assistant",
          content: guardMessage,
        });
        console.error(
          `[coach-guard] blocked ${guardHit.kind}-shaped input (conversation ${prep.conversation.id})`,
        );
        beginSse(res);
        streaming = true;
        writeSse(res, "meta", {
          conversationId: prep.conversation.id,
          userMessageId: prep.userMessageId,
          remaining: prep.remaining,
        });
        writeSse(res, "text", { delta: guardMessage });
        writeSse(res, "done", { messageId: assistantMsg.id, usage: null, remaining: prep.remaining });
        res.end();
        return;
      }

      beginSse(res);
      streaming = true;

      // Client gone → stop paying for tokens nobody sees. (Side effects the
      // turn already applied — user message, intake sync — stay applied.)
      const abortController = new AbortController();
      req.on("close", () => abortController.abort());

      writeSse(res, "meta", {
        conversationId: prep.conversation.id,
        turnId: prep.userMessageId,
        userMessageId: prep.userMessageId,
        remaining: prep.remaining,
        ...(isCoachConfigured() ? {} : { degraded: true }),
      });

      const emit: CoachEmit = (event) => {
        const { type, ...data } = event;
        writeSse(res, type, data);
      };

      const result = await runCoachTurn({
        req,
        userId: prep.user.id,
        userRole: prep.user.role,
        conversationId: prep.conversation.id,
        turnId: prep.userMessageId,
        userMessage: prep.message,
        history: prep.history,
        existingProfile: prep.conversation.financialProfile ?? undefined,
        verifiedContext: prep.verifiedContext,
        emit,
        signal: abortController.signal,
      });

      const completionAfter = await refreshReadinessAfterCapture({
        userId: prep.user.id,
        verifiedContext: prep.verifiedContext,
        result,
        emit,
      });
      const assistantMsg = await persistAssistantTurn(prep.conversation, prep.verifiedContext, result);

      await recordHomiOutcome({
        userId: prep.user.id,
        userRole: prep.user.role,
        applicationId: prep.verifiedContext.workableApplicationId ?? null,
        conversationId: prep.conversation.id,
        repeatedQuestion: prep.repeatedQuestion,
        completionBefore: prep.verifiedContext.completionPercentage ?? null,
        completionAfter,
        startedAt: turnStartedAt,
        result,
      });

      writeSse(res, "done", {
        messageId: assistantMsg.id,
        usage: result.usage,
        remaining: prep.remaining,
      });
      res.end();
    } catch (error) {
      console.error("Coach stream error:", error);
      const payload = error instanceof CoachTurnError
        ? { code: error.code, message: error.message, retryable: error.retryable }
        : { code: "internal", message: "Failed to process message", retryable: true };
      if (outcomeIdentity) {
        await recordHomiFailure({
          ...outcomeIdentity,
          startedAt: turnStartedAt,
          code: payload.code,
          streamOpened: streaming,
        });
      }
      // Once the stream is open the global error handler can't fire
      // (headersSent) — errors must be emitted in-stream. No assistant
      // message is persisted on error: the client shows a retry affordance.
      if (streaming) {
        writeSse(res, "error", payload);
        res.end();
      } else if (!res.headersSent) {
        res.status(502).json({ error: payload.message, ...payload });
      }
    }
  });

  // Non-streaming variant — same core turn, buffered. The response keeps the
  // pre-rebuild JSON contract (plus additive captured/suggestions/degraded)
  // so older clients keep working and the new client can fall back to it when
  // an intermediary buffers SSE.
  app.post("/api/coach/message", isAuthenticated, async (req, res) => {
    const turnStartedAt = Date.now();
    let outcomeIdentity: {
      userId: string;
      userRole: string;
      applicationId: string | null;
      conversationId: string;
    } | null = null;
    try {
      // Same input-side sensitive-data guard as the streaming variant.
      const rawMessage = typeof req.body?.message === "string" ? req.body.message : "";
      const guardHit = detectSensitiveInput(rawMessage);
      if (guardHit) {
        req.body.message = SENSITIVE_INPUT_REDACTED_PLACEHOLDER;
      }

      const prep = await prepareCoachTurn(req, res, rawMessage);
      if (!prep) return;
      outcomeIdentity = {
        userId: prep.user.id,
        userRole: prep.user.role,
        applicationId: prep.verifiedContext.workableApplicationId ?? null,
        conversationId: prep.conversation.id,
      };

      if (guardHit) {
        const guardMessage = SENSITIVE_INPUT_MESSAGES[guardHit.kind];
        const assistantMsg = await storage.createCoachMessage({
          conversationId: prep.conversation.id,
          role: "assistant",
          content: guardMessage,
        });
        console.error(
          `[coach-guard] blocked ${guardHit.kind}-shaped input (conversation ${prep.conversation.id})`,
        );
        return res.json({
          conversationId: prep.conversation.id,
          message: assistantMsg,
          profile: prep.conversation.financialProfile || null,
          intake: getLatestIntakeFromConversation(prep.conversation),
          actionPlan: prep.conversation.actionPlan || null,
          documentChecklist: prep.conversation.documentChecklist || null,
          borrowerPackage: null,
          captured: null,
          suggestions: null,
        });
      }

      let lastCaptured: Record<string, unknown> | null = null;
      const emit: CoachEmit = (event) => {
        if (event.type === "captured") {
          const { type, ...data } = event;
          lastCaptured = data;
        }
      };

      const abortController = new AbortController();
      req.on("close", () => abortController.abort());

      const result = await runCoachTurn({
        req,
        userId: prep.user.id,
        userRole: prep.user.role,
        conversationId: prep.conversation.id,
        turnId: prep.userMessageId,
        userMessage: prep.message,
        history: prep.history,
        existingProfile: prep.conversation.financialProfile ?? undefined,
        verifiedContext: prep.verifiedContext,
        emit,
        signal: abortController.signal,
      });

      const completionAfter = await refreshReadinessAfterCapture({
        userId: prep.user.id,
        verifiedContext: prep.verifiedContext,
        result,
        emit,
      });
      const assistantMsg = await persistAssistantTurn(prep.conversation, prep.verifiedContext, result);
      await recordHomiOutcome({
        userId: prep.user.id,
        userRole: prep.user.role,
        applicationId: prep.verifiedContext.workableApplicationId ?? null,
        conversationId: prep.conversation.id,
        repeatedQuestion: prep.repeatedQuestion,
        completionBefore: prep.verifiedContext.completionPercentage ?? null,
        completionAfter,
        startedAt: turnStartedAt,
        result,
      });
      const state = result.state;
      const existingIntake = getLatestIntakeFromConversation(prep.conversation, { intake: state.intake });

      res.json({
        conversationId: prep.conversation.id,
        message: assistantMsg,
        profile: state.profile || prep.conversation.financialProfile || null,
        intake: existingIntake,
        actionPlan: state.actionPlan || prep.conversation.actionPlan || null,
        documentChecklist: state.documentChecklist || prep.conversation.documentChecklist || null,
        borrowerPackage: state.borrowerPackage || null,
        captured: lastCaptured,
        suggestions: state.suggestions || null,
        ...(result.degraded ? { degraded: true } : {}),
      });
    } catch (error) {
      console.error("Coach message error:", error);
      if (res.headersSent) return;
      if (outcomeIdentity) {
        await recordHomiFailure({
          ...outcomeIdentity,
          startedAt: turnStartedAt,
          code: error instanceof CoachTurnError ? error.code : "internal",
          streamOpened: false,
        });
      }
      if (error instanceof CoachTurnError) {
        res.status(502).json({ error: error.message, code: error.code, retryable: error.retryable });
      } else {
        res.status(500).json({ error: "Failed to process message" });
      }
    }
  });

  app.patch("/api/coach/conversations/:id/action-plan/:itemId", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const conversation = await storage.getCoachConversation(routeParam(req, "id"));
      if (!conversation || conversation.userId !== user.id) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const plan = (conversation.actionPlan as any[]) || [];
      const itemIndex = plan.findIndex((item: any) => item.id === routeParam(req, "itemId"));
      if (itemIndex === -1) {
        return res.status(404).json({ error: "Action item not found" });
      }

      plan[itemIndex].completed = !plan[itemIndex].completed;
      await storage.updateCoachConversation(conversation.id, { actionPlan: plan });

      res.json({ actionPlan: plan, toggled: plan[itemIndex] });
    } catch (error) {
      console.error("Toggle action item error:", error);
      res.status(500).json({ error: "Failed to toggle action item" });
    }
  });

  app.get("/api/coach/usage", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const dailyLimit = 30;
      const todayCount = await storage.countUserCoachMessagesToday(user.id);

      res.json({
        todayCount,
        dailyLimit,
        remaining: Math.max(0, dailyLimit - todayCount),
        isLimited: todayCount >= dailyLimit,
      });
    } catch (error) {
      console.error("Coach usage error:", error);
      res.status(500).json({ error: "Failed to fetch usage" });
    }
  });

  app.get("/api/coach/insights", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const verifiedContext = await buildVerifiedContext(user.id, user);
      const conversations = await storage.getCoachConversationsByUser(user.id);
      const hasAssessment = conversations.some(c => c.financialProfile);
      const totalConversations = conversations.length;

      const insights: Array<{ type: string; title: string; description: string; action?: string }> = [];

      if (verifiedContext.hasApplication && !hasAssessment) {
        insights.push({
          type: "organize_file",
          title: "Organize Your Connected File",
          description: "Your application is connected. Ask Homi to map the income story and identify one useful next action.",
          action: "Map the income and evidence already connected to my file",
        });
      }

      if (verifiedContext.hasApplication && verifiedContext.uploadedDocuments) {
        const uploaded = verifiedContext.uploadedDocuments.length;
        if (uploaded === 0) {
          insights.push({
            type: "missing_docs",
            title: "Build Your Document Plan",
            description: "Nothing has been received yet. Ask Homi which documents fit the income sources on your application.",
            action: "What documents do I need to upload?",
          });
        }
      }

      if (verifiedContext.hasApplication && verifiedContext.creditScore && verifiedContext.creditScore < 680) {
        insights.push({
          type: "credit_improvement",
          title: "Credit Score Tips",
          description: `Your credit score is ${verifiedContext.creditScore}. Homi can help you create a plan to improve it.`,
          action: "How can I improve my credit score for a better mortgage rate?",
        });
      }

      if (verifiedContext.hasApplication && verifiedContext.dtiRatio && parseFloat(verifiedContext.dtiRatio) > 43) {
        insights.push({
          type: "dti_high",
          title: "DTI Ratio Guidance",
          description: `Your debt-to-income ratio is ${verifiedContext.dtiRatio}%. Homi can help you strategize to lower it.`,
          action: "My DTI is high. What can I do to bring it down?",
        });
      }

      if (!verifiedContext.hasApplication && totalConversations === 0) {
        insights.push({
          type: "get_started",
          title: "Build Your Homebuyer Plan",
          description: "Tell Homi how you earn, what you own, and what feels unclear to get one useful next step.",
        });
      }

      res.json({ insights, hasApplication: verifiedContext.hasApplication, hasAssessment });
    } catch (error) {
      console.error("Coach insights error:", error);
      res.status(500).json({ error: "Failed to fetch insights" });
    }
  });

  /**
   * The borrower's file, as the assistant sees it — status, the real document
   * checklist, open tasks, readiness. Exactly the payloads the read tools emit,
   * from exactly the same functions.
   *
   * It exists so the panels render on page load. Before this, a returning
   * borrower saw whatever the LAST turn happened to leave in the conversation
   * row until they sent another message — which for a file that had moved
   * meant stale figures presented as current.
   *
   * No model call, so the aiCoachLimiter (mounted on /api/coach/message only)
   * correctly does not apply; the general limiter does.
   */
  app.get("/api/coach/context", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const verifiedContext = await buildVerifiedContext(user.id, user);
      const readiness = deriveReadinessProfile(verifiedContext);

      if (!verifiedContext.workableApplicationId) {
        return res.json({
          hasApplication: false,
          loanStatus: EMPTY_LOAN_STATUS,
          documentChecklist: [],
          checklistStats: null,
          tasks: [],
          readiness,
        });
      }

      const truth = await loadFileTruth(verifiedContext.workableApplicationId, user);
      if (!truth) {
        // The access check refused. Say so rather than serving an empty file,
        // which would read to the borrower as "you have nothing outstanding".
        return res.status(403).json({ error: "Access denied" });
      }

      res.json({
        hasApplication: true,
        loanStatus: truth.status,
        documentChecklist: truth.checklist.documents,
        checklistStats: truth.checklist.stats,
        tasks: truth.tasks,
        readiness,
      });
    } catch (error) {
      console.error("Get coach context error:", error);
      res.status(500).json({ error: "Failed to load your file" });
    }
  });

  app.get("/api/coach/profile", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const conversations = await storage.getCoachConversationsByUser(user.id);
      const activeConv = conversations.find(c => c.financialProfile);
      if (!activeConv) {
        return res.json({ profile: null, actionPlan: null, documentChecklist: null });
      }
      res.json({
        profile: activeConv.financialProfile,
        actionPlan: activeConv.actionPlan,
        documentChecklist: activeConv.documentChecklist,
        readinessTier: activeConv.readinessTier,
        completionPercentage: activeConv.completionPercentage,
        conversationId: activeConv.id,
      });
    } catch (error) {
      console.error("Get coach profile error:", error);
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  });
}
