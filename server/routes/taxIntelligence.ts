import type { Express } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import { isAuthenticated } from "../auth";
import { db } from "../db";
import {
  bankStatementAnalyses,
  bankStatementAnalysisInputSchema,
  reviewItems,
  type User,
} from "@shared/schema";
import { isAdmin, isInternalStaffRole } from "@shared/roles";
import { and, eq } from "drizzle-orm";
import { hasUserConsent } from "../consentGate";
import { getLatestTaxIntelligence } from "../services/taxDocumentIntelligence";
import { buildTaxReconciliation } from "../services/taxReconciliation";
import {
  classifyAndPersistSituation,
  getLatestSituationProfile,
} from "../services/situationClassifier";
import { buildSeWorksheetDrafts } from "../services/worksheetPrefill";
import { syncReviewItems, resolveReviewItem } from "../services/income/reviewTriage";
import { recalculateDecision } from "../services/decisionEngine";
import { logAudit } from "../auditLog";
import { logFriction } from "../services/frictionLog";
import { firstQueryValue } from "./queryParams";
import { routeParam } from "../http/routeParams";
import { getDocumentProcessingBlockReason } from "../services/documentLineage";
import {
  enqueueTaxPackageExtraction,
  getTaxPackageExtractionJob,
  kickDocumentExtractionWorker,
} from "../services/documentExtractionJobs";
import { resolveDocumentBorrowerUserId } from "../services/documentBorrower";
import { isTaxReturnDocumentType } from "@shared/documentTypes";
import { getFinancialReview } from "../services/financialReview";

/**
 * Tax Document Intelligence routes (UAL P2a — Situation Identification Engine).
 *
 * POST runs are consumer-direct and OWNER-ONLY (no staff/admin override), for
 * the same reason as /api/tax-insights/process: the tax_document_use consent
 * that gates them is granted by the borrower for their own data, and keeping
 * the flow consumer-direct is what keeps IRC §7216 preparer-disclosure rules
 * from attaching.
 *
 * Staff READS (a use named in the consent text) follow the per-file
 * assignment model, mirroring /api/predictions/staff/:userId: admin has
 * blanket access; every other internal-staff role must be an active
 * deal-team member on an application owned by the target borrower. Bare
 * isInternalStaffRole is reserved for aggregate feeds — never a specific
 * borrower's financial records. Every staff read is audited.
 *
 * Output is PROVISIONAL extraction — readiness/processing signal, never an
 * underwriting input (MR-2 / L2 I1: a human confirms values before they count).
 */

/**
 * Per-file assignment gate for non-owner reads: admin passes; any other
 * internal-staff caller must name an application they are an active
 * deal-team member of, and the target borrower must own that application.
 */
async function staffCanAccessBorrower(
  caller: User,
  borrowerUserId: string,
  applicationId: string | undefined,
  storage: IStorage,
  options: { requireTaxDocumentConsent?: boolean } = {},
): Promise<{ allowed: boolean; reason?: string }> {
  if (!isInternalStaffRole(caller.role)) return { allowed: false, reason: "Unauthorized" };
  if (!isAdmin(caller) && !applicationId) {
    return {
      allowed: false,
      reason: "An applicationId is required for non-admin staff access",
    };
  }
  if (!isAdmin(caller)) {
    const teamMembers = await storage.getDealTeamMembers(applicationId!);
    if (!teamMembers.some((m) => m.userId === caller.id)) {
      return { allowed: false, reason: "Access denied" };
    }
    const application = await storage.getLoanApplication(applicationId!);
    if (!application || application.userId !== borrowerUserId) {
      return { allowed: false, reason: "Access denied" };
    }
  }
  if (
    options.requireTaxDocumentConsent !== false &&
    !(await hasUserConsent("tax_document_use", borrowerUserId))
  ) {
    return { allowed: false, reason: "Tax document authorization is no longer active" };
  }
  return { allowed: true };
}

export function registerTaxIntelligenceRoutes(app: Express, storage: IStorage) {
  app.post("/api/documents/:id/tax-intelligence", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const document = await storage.getDocument(routeParam(req, "id"));
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }
      const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
      if (borrowerUserId !== user.id) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      if (!isTaxReturnDocumentType(document.documentType)) {
        return res.status(400).json({ error: "Document is not a tax return" });
      }

      if (!(await hasUserConsent("tax_document_use", borrowerUserId))) {
        logFriction("consent_gate_blocked", {
          userId: user.id,
          detail: "tax_document_use",
          metadata: { path: req.path },
        });
        return res.status(403).json({
          error: "Please review and accept the tax document authorization first.",
          code: "CONSENT_REQUIRED",
          consentType: "tax_document_use",
        });
      }

      const preflightBlock = await getDocumentProcessingBlockReason(document.id);
      if (preflightBlock) {
        return res.status(409).json({
          error:
            preflightBlock === "replaced"
              ? "This tax return has been replaced. Process the current version instead."
              : "This tax return already has a final human review.",
          code:
            preflightBlock === "replaced"
              ? "DOCUMENT_VERSION_REPLACED"
              : "DOCUMENT_ALREADY_REVIEWED",
        });
      }

      const job = await enqueueTaxPackageExtraction(document.id, user.id);
      kickDocumentExtractionWorker();

      logAudit(req, "tax_intelligence.run", "document", document.id, {
        jobId: job.id,
        status: job.status,
      });

      res.status(202).json({
        documentId: document.id,
        jobId: job.id,
        status: job.status === "processing" ? "running" : job.status,
      });
    } catch (error) {
      console.error("Tax intelligence run error:", error);
      res.status(500).json({ error: "Failed to process tax document" });
    }
  });

  app.get("/api/documents/:id/tax-intelligence", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const document = await storage.getDocument(routeParam(req, "id"));
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }
      const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
      const isOwner = borrowerUserId === user.id;
      if (isOwner && !(await hasUserConsent("tax_document_use", borrowerUserId))) {
        return res.status(403).json({
          error: "Tax document authorization is no longer active",
          code: "CONSENT_REQUIRED",
          consentType: "tax_document_use",
        });
      }
      if (!isOwner) {
        const access = await staffCanAccessBorrower(
          user,
          borrowerUserId,
          document.applicationId ?? firstQueryValue(req.query.applicationId),
          storage,
        );
        if (!access.allowed) {
          return res.status(403).json({ error: access.reason ?? "Unauthorized" });
        }
      }

      const [summary, job] = await Promise.all([
        getLatestTaxIntelligence(document.id),
        getTaxPackageExtractionJob(document.id),
      ]);
      if (job && job.status !== "completed") {
        return res.json({
          documentId: document.id,
          jobId: job.id,
          status: job.status === "pending" ? "queued" : job.status === "processing" ? "running" : job.status,
          error: job.status === "failed" ? "We couldn't read this tax package automatically." : undefined,
        });
      }
      if (!summary) {
        return res.status(404).json({ error: "No extraction has been run for this document" });
      }

      if (!isOwner) {
        // Staff reading a borrower's extracted tax data is a PII-adjacent
        // access — leave a trail.
        logAudit(req, "tax_intelligence.viewed", "document", document.id, {
          runId: summary.runId,
          borrowerId: borrowerUserId,
        });
      }

      res.json(summary);
    } catch (error) {
      console.error("Tax intelligence fetch error:", error);
      res.status(500).json({ error: "Failed to load tax intelligence" });
    }
  });

  /**
   * P2b: the cross-document reconciliation report — resolved business
   * entities + deterministic tie-out checks over the user's latest
   * extractions. Owner reads their own; internal staff may read any
   * borrower's (audited).
   */
  app.get("/api/tax-intelligence/reconciliation", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const requestedUserId =
        typeof req.query.userId === "string" && req.query.userId ? req.query.userId : user.id;
      const applicationId = firstQueryValue(req.query.applicationId);
      const isOwner = requestedUserId === user.id;
      if (isOwner && !(await hasUserConsent("tax_document_use", requestedUserId))) {
        return res.status(403).json({ error: "Tax document authorization is no longer active" });
      } else if (!isOwner) {
        const access = await staffCanAccessBorrower(
          user,
          requestedUserId,
          applicationId,
          storage,
        );
        if (!access.allowed) {
          return res.status(403).json({ error: access.reason ?? "Unauthorized" });
        }
      }

      const report = await buildTaxReconciliation(
        requestedUserId,
        isOwner ? undefined : applicationId,
      );

      if (!isOwner) {
        logAudit(req, "tax_intelligence.reconciliation_viewed", "user", requestedUserId, {
          formCount: report.formCount,
          variances: report.summary.variance,
        });
      }

      res.json(report);
    } catch (error) {
      console.error("Tax reconciliation error:", error);
      res.status(500).json({ error: "Failed to build tax reconciliation" });
    }
  });

  /**
   * P2c: the SituationProfile — what kind of borrower this is, which income
   * paths the file indicates, and which documents to request. Owner reads
   * their own; internal staff may read any borrower's (audited). Computed
   * fresh if nothing is persisted yet (deterministic either way).
   */
  app.get("/api/tax-intelligence/situation", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const requestedUserId =
        typeof req.query.userId === "string" && req.query.userId ? req.query.userId : user.id;
      const applicationId = firstQueryValue(req.query.applicationId);
      const isOwner = requestedUserId === user.id;
      if (isOwner && !(await hasUserConsent("tax_document_use", requestedUserId))) {
        return res.status(403).json({ error: "Tax document authorization is no longer active" });
      } else if (!isOwner) {
        const access = await staffCanAccessBorrower(
          user,
          requestedUserId,
          applicationId,
          storage,
        );
        if (!access.allowed) {
          return res.status(403).json({ error: access.reason ?? "Unauthorized" });
        }
      }

      const situationApplicationId = isOwner ? undefined : applicationId;
      let row = await getLatestSituationProfile(requestedUserId, situationApplicationId);
      if (!row) {
        row = await classifyAndPersistSituation(requestedUserId, situationApplicationId);
      }

      if (!isOwner) {
        logAudit(req, "tax_intelligence.situation_viewed", "user", requestedUserId, {
          situationProfileId: row.id,
        });
      }

      res.json({
        id: row.id,
        userId: row.userId,
        generatedAt: row.generatedAt.toISOString(),
        inputsFingerprint: row.inputsFingerprint,
        profile: row.profile,
      });
    } catch (error) {
      console.error("Situation profile error:", error);
      res.status(500).json({ error: "Failed to load situation profile" });
    }
  });

  /**
   * P5 smart-fill: DRAFT self-employment worksheets built from the borrower's
   * validated document extractions, one per resolved SE-type entity, with
   * per-field provenance. OWNER-ONLY + consent-gated (same consumer-direct
   * doctrine as the extraction run). Drafts are never persisted — the borrower
   * reviews them in the URLA worksheet and saves through the Zod PUT.
   */
  app.get("/api/tax-intelligence/se-worksheet-drafts", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      if (!(await hasUserConsent("tax_document_use", user.id))) {
        logFriction("consent_gate_blocked", {
          userId: user.id,
          detail: "tax_document_use",
          metadata: { path: req.path },
        });
        return res.status(403).json({
          error: "Please review and accept the tax document authorization first.",
          code: "CONSENT_REQUIRED",
          consentType: "tax_document_use",
        });
      }
      const drafts = await buildSeWorksheetDrafts(user.id);
      res.json({ drafts });
    } catch (error) {
      console.error("SE worksheet draft error:", error);
      res.status(500).json({ error: "Failed to build worksheet drafts" });
    }
  });

  /**
   * P5 workbench: the actionable review items (one_click / flagged tiers).
   * Sync-on-read is idempotent (insert-only on natural keys). Owner reads
   * their own; staff follow the deal-team model.
   */
  app.get("/api/tax-intelligence/review-items", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const requestedUserId =
        typeof req.query.userId === "string" && req.query.userId ? req.query.userId : user.id;
      const applicationId =
        typeof req.query.applicationId === "string" && req.query.applicationId
          ? req.query.applicationId
          : undefined;
      const isOwner = requestedUserId === user.id;
      if (isOwner && !(await hasUserConsent("tax_document_use", requestedUserId))) {
        return res.status(403).json({ error: "Tax document authorization is no longer active" });
      } else if (!isOwner) {
        const access = await staffCanAccessBorrower(user, requestedUserId, applicationId, storage);
        if (!access.allowed) {
          return res.status(403).json({ error: access.reason ?? "Unauthorized" });
        }
      }

      const items = await syncReviewItems(requestedUserId, applicationId ?? null);
      if (!isOwner) {
        logAudit(req, "tax_intelligence.review_items_viewed", "user", requestedUserId, {
          openCount: items.length,
          applicationId,
        });
      }
      res.json({ items });
    } catch (error) {
      console.error("Review items error:", error);
      res.status(500).json({ error: "Failed to load review items" });
    }
  });

  const resolveBodySchema = z
    .object({
      action: z.enum(["confirmed", "overridden", "dismissed"]),
      correctedValue: z.string().max(500).optional(),
      note: z.string().max(2000).optional(),
    })
    .strict();

  /**
   * P5 workbench: resolve one item. STAFF-ONLY (the workbench is a staff
   * surface; borrower confirmations flow through the worksheet confirm), and
   * deal-team scoped to the item's borrower/application. Confirm/override on
   * an extracted field stamps it human-verified — the accuracy loop's ground
   * truth — and triggers a decision recalc.
   */
  app.post("/api/tax-intelligence/review-items/:id/resolve", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const parsed = resolveBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid resolution", details: parsed.error.flatten() });
      }
      const [item] = await db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.id, routeParam(req, "id")))
        .limit(1);
      if (!item) {
        return res.status(404).json({ error: "Review item not found" });
      }
      if (!item.applicationId) {
        return res.status(409).json({
          error: "Open this review item from a loan application before resolving it",
        });
      }
      const access = await staffCanAccessBorrower(
        user,
        item.userId,
        item.applicationId,
        storage,
      );
      if (!access.allowed) {
        return res.status(403).json({ error: access.reason ?? "Unauthorized" });
      }

      const resolved = await resolveReviewItem({
        itemId: item.id,
        applicationId: item.applicationId,
        actorId: user.id,
        action: parsed.data.action,
        correctedValue: parsed.data.correctedValue,
        note: parsed.data.note,
      });
      if (!resolved) {
        return res.status(409).json({ error: "Item is not open" });
      }

      logAudit(req, "tax_intelligence.review_item_resolved", "review_item", item.id, {
        borrowerId: item.userId,
        applicationId: item.applicationId,
        itemType: item.itemType,
        action: parsed.data.action,
        corrected: parsed.data.correctedValue !== undefined,
      });
      res.json(resolved);
    } catch (error) {
      console.error("Review item resolve error:", error);
      res.status(500).json({ error: "Failed to resolve review item" });
    }
  });

  /**
   * P5: capture surface for the cited Angel Oak bank-statement analysis (the
   * P4 gap). STAFF-ONLY + deal-team scoped: the eligible-deposit total attests
   * AE deposit-eligibility screening, which is a staff act. Append-only; the
   * latest row feeds the income orchestrator, so a recalc follows.
   */
  app.post("/api/applications/:id/bank-statement-analysis", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const application = await storage.getLoanApplication(routeParam(req, "id"));
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      const access = await staffCanAccessBorrower(
        user,
        application.userId,
        application.id,
        storage,
        { requireTaxDocumentConsent: false },
      );
      if (!access.allowed) {
        return res.status(403).json({ error: access.reason ?? "Unauthorized" });
      }
      const parsed = bankStatementAnalysisInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid analysis", details: parsed.error.flatten() });
      }
      const evidence = (await getFinancialReview(application.id, user)).bankStatementEvidence;
      if (
        evidence.reviewedDepositFactCount < parsed.data.months
        || evidence.consecutiveMonthCoverage < parsed.data.months
      ) {
        return res.status(409).json({
          error: `Review deposit totals and statement dates for ${parsed.data.months} consecutive months before recording this analysis. Current evidence covers ${evidence.consecutiveMonthCoverage} consecutive month${evidence.consecutiveMonthCoverage === 1 ? "" : "s"}.`,
          evidence,
        });
      }

      const [row] = await db
        .insert(bankStatementAnalyses)
        .values({
          applicationId: application.id,
          months: parsed.data.months,
          totalEligibleDeposits: parsed.data.totalEligibleDeposits.toFixed(2),
          expenseFactor: parsed.data.expenseFactor?.toFixed(4) ?? null,
          hasThirdPartyExpenseStatement: parsed.data.hasThirdPartyExpenseStatement,
          notes: parsed.data.notes ?? null,
          enteredBy: user.id,
        })
        .returning();

      logAudit(req, "tax_intelligence.bank_statement_analysis_recorded", "application", application.id, {
        analysisId: row.id,
        months: parsed.data.months,
        hasThirdPartyExpenseStatement: parsed.data.hasThirdPartyExpenseStatement,
      });

      // The analysis changes the income evaluation — recalc (never throws upward).
      const decision = await recalculateDecision(application.id, "bank_statement_analysis_recorded");
      res.status(201).json({ analysis: row, decisionStatus: decision?.status ?? null });
    } catch (error) {
      console.error("Bank statement analysis error:", error);
      res.status(500).json({ error: "Failed to record bank statement analysis" });
    }
  });
}
