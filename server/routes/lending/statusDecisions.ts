// Lending routes: Application PATCH (TRID trigger on update), staff status machine with the ECOA denial chokepoint, verification routes, latest draft.
// One registrar in the original registration order — see ./index.ts.
import type { Express } from "express";
import { isAdmin } from "@shared/roles";
import type { IStorage } from "../../storage";
import { isAuthenticated, requireRole } from "../../auth";
import { insertBorrowerDeclarationsSchema, loanApplicationIntakeUpdateSchema, STAFF_SETTABLE_STATUSES, CREDIT_DECISION_ROLES, FINANCIAL_VERIFICATION_ROLES, isProtectedCreditDecisionStatus, isApprovalOutcomeStatus, type User } from "@shared/schema";
import { updatePipelineStage, checkPipelineProgress, PipelineTransitionError } from "../../pipelineEngine";
import { unlicensedStateRejection } from "@shared/companyIdentity";
import { z } from "zod";
import { logAudit } from "../../auditLog";
import * as creditService from "../../services/creditService";
import { sendNotificationEmail } from "../../services/emailService";
import { assertVerifiedForDecisioning, type DataProvenance } from "@shared/dataProvenance";
import { assertStageRequirements } from "@shared/stageRequirements";
import { evaluateTridTrigger, tridHardStopError } from "../../services/trid";
import { routeParams } from "../../http/routeParams";

const declarationsValidationSchema = insertBorrowerDeclarationsSchema.partial().extend({
  applicationId: z.string().optional(),
});

export type FinancialVerificationEvidence = {
  approvedMemoId: string | null;
  approvedIncomeWorkpaperId: string | null;
  approvedAssetWorkpaperId: string | null;
  creditPullId: string | null;
  creditPullIsSimulated: boolean;
};

/** The proof required before a staff attestation may become decision-grade. */
export function financialVerificationEvidenceError(
  dimension: "income" | "assets" | "credit",
  evidence: FinancialVerificationEvidence,
): string | null {
  if (dimension === "credit") {
    return !evidence.creditPullId || evidence.creditPullIsSimulated
      ? "A completed real bureau credit report is required; simulated credit cannot be marked verified."
      : null;
  }
  if (!evidence.approvedMemoId) {
    return "Approve the current financial workpapers and credit memo before verifying income or assets.";
  }
  if (dimension === "income" && !evidence.approvedIncomeWorkpaperId) {
    return "The approved memo does not contain a current approved household income workpaper.";
  }
  if (dimension === "assets" && !evidence.approvedAssetWorkpaperId) {
    return "The approved memo does not contain a current approved asset reconciliation workpaper.";
  }
  return null;
}

// Intake validation lives in shared/schema/lending.ts (loanApplicationIntakeSchema),
// derived from the same base schema the funnel validates with client-side — the
// server rejects exactly what the client rejects, and "not_sure" credit maps to
// the named CREDIT_SCORE_UNKNOWN_DEFAULT instead of a silent clamp.

export function registerStatusDecisionRoutes(
  app: Express,
  storage: IStorage,
) {
  app.patch("/api/loan-applications/:id", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user!.id;
      const { id } = routeParams(req);
      
      const application = await storage.getLoanApplication(id);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      if (application.userId !== userId) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      // Borrower field edits apply to drafts only. Previously this endpoint
      // force-reset ANY application to "draft" — a borrower editing figures
      // mid-underwriting would silently pull the file out of the pipeline
      // (and could rewrite verified financials). Submitted files change
      // through staff channels.
      if (application.status !== "draft") {
        return res.status(409).json({
          error: "This application has been submitted and can no longer be edited directly. Contact your loan team to update it.",
          code: "not_editable",
        });
      }

      // Shared-derived schema: same field rules the funnel enforces client-side,
      // no silent clamps, values normalized (commas stripped, credit band →
      // number) by the schema itself. Present-and-valid fields pass through;
      // absent fields are left untouched — never defaulted to "0".
      const parsed = loanApplicationIntakeUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors });
      }

      const formData = parsed.data;

      // Licensed-state gate (roadmap A5): a draft edit can supply the property
      // state — same footprint rule as intake creation.
      const stateRejection = unlicensedStateRejection(formData.propertyState);
      if (stateRejection) {
        return res.status(422).json(stateRejection);
      }

      // Only real loan_applications columns — the funnel schema also carries
      // UI-only helpers (hasAdditionalIncome) that must not reach the DB.
      const UPDATABLE_COLUMNS = [
        "annualIncome", "monthlyDebts", "creditScore", "employmentType",
        "employmentYears", "propertyType", "purchasePrice", "downPayment",
        "loanPurpose", "isVeteran", "isFirstTimeBuyer", "propertyState",
        "employerName", "propertyAddress", "propertyCity", "propertyZip",
        "incomeSources",
        // The three answers the funnel captures AFTER the #202 registrar split
        // and this list never learned about. Every autosave validated them,
        // returned 200, and wrote nothing — the two VA residual-income inputs
        // (38 CFR 36.4340(e)) were re-asked on every resume, and the UAL
        // routing opt-in came back as a silent "no" beside two checkboxes that
        // restored correctly (2026-08-19 wiring audit, break 2).
        "householdFamilySize", "homeSquareFootage", "avoidsInterestFinancing",
      ] as const;
      const updateData: Record<string, unknown> = {};
      for (const key of UPDATABLE_COLUMNS) {
        const value = (formData as Record<string, unknown>)[key];
        if (value !== undefined) updateData[key] = value;
      }
      // The two VA inputs are INTEGER columns, but the update schema hands them
      // over as digit strings (stringifyIntakeScalars normalises numbers to
      // strings for the shared validators) — the same parseInt the intake POST
      // applies in applications.ts. Copying the string straight through would
      // put a string into an integer column. The validator lets "" through as
      // "not answered", so an empty string is treated as absent rather than
      // written as NaN; neither field is clearable, so null never arrives.
      for (const key of ["householdFamilySize", "homeSquareFootage"] as const) {
        if (typeof updateData[key] !== "string") continue;
        const n = parseInt(updateData[key] as string, 10);
        if (Number.isFinite(n)) updateData[key] = n;
        else delete updateData[key];
      }

      const updated = await storage.updateLoanApplication(id, updateData);

      // TRID §1026.2(a)(3): this PATCH can supply the property address or
      // another of the six items — evaluate the Loan Estimate trigger.
      try {
        const trid = await evaluateTridTrigger(id);
        if (trid.justTriggered) {
          logAudit(req, "trid.application_triggered", "loan_application", id, {
            leDueDate: trid.leDueDate?.toISOString(),
          });
        }
      } catch (tridErr) {
        console.error("[TRID] Trigger evaluation failed (non-fatal):", tridErr);
      }

      res.json(updated);
    } catch (error) {
      console.error("Update application error:", error);
      res.status(500).json({ error: "Failed to update application" });
    }
  });

  // STAFF_SETTABLE_STATUSES / PROTECTED_CREDIT_DECISION_STATUSES /
  // APPROVAL_OUTCOME_STATUSES live in shared/schema/lendingCore.ts so the staff
  // status pickers (client/src/pages/staff/BorrowerFile.tsx) offer exactly what
  // this schema accepts and grey out exactly what the gates below reject. HMDA
  // codes and milestones are stamped inside updatePipelineStage — one writer.
  const staffStatusSchema = z.object({
    status: z.enum(STAFF_SETTABLE_STATUSES),
    notes: z.string().max(2000).optional(),
    // HMDA requires at least 2 denial reasons when an application is denied.
    denialReasons: z.array(z.string().min(1)).optional(),
    // Admin-only: bypass the transition table (side effects still run).
    force: z.boolean().optional(),
  });

  app.patch("/api/loan-applications/:id/status", requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"), async (req, res) => {
    try {
      const user = req.user as User;

      const { id } = routeParams(req);
      const parsed = staffStatusSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid status", details: parsed.error.issues });
      }

      const application = await storage.getLoanApplication(id);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const { status, notes, denialReasons, force } = parsed.data;

      // HMDA LAR requires at least 2 denial reasons when an application is denied.
      if (status === "denied" && (!denialReasons || denialReasons.length < 2)) {
        return res.status(400).json({
          error: "At least 2 denial reasons are required to deny an application (HMDA LAR)",
        });
      }

      // Enforce that only admin or underwriter can set final credit-decision statuses.
      // All other roles (including assigned deal-team members) must use the
      // underwriting advance-stage endpoint which enforces the full transition policy.
      if (isProtectedCreditDecisionStatus(status) && !CREDIT_DECISION_ROLES.includes(user.role)) {
        return res.status(403).json({ error: "Only underwriters or admins may set approval or denial outcomes" });
      }

      // Admins may update any application; all other roles must be on the deal team.
      if (!isAdmin(user)) {
        const teamMembers = await storage.getDealTeamMembers(id);
        const isOnTeam = teamMembers.some(m => m.userId === user.id);
        if (!isOnTeam) {
          return res.status(403).json({ error: "You are not assigned to this application" });
        }
      }

      // Approval outcomes may not be set on self-reported/estimated data — a
      // favorable credit determination requires verified figures. (Denial is not
      // gated: an application can be denied for unverifiable or incomplete info.)
      if (isApprovalOutcomeStatus(status)) {
        try {
          assertVerifiedForDecisioning(
            application.financialDataProvenance as DataProvenance,
            `setting status to '${status}'`,
          );
        } catch (guardErr) {
          return res.status(422).json({
            error: guardErr instanceof Error ? guardErr.message : "Financial data must be verified",
          });
        }
      }

      // Every amount-bearing status must carry a coherent loan amount — a
      // pre-approval/approval/underwriting file with no amount is an impossible
      // state. Self-filters to a no-op for pre-decision statuses (#7).
      try {
        assertStageRequirements(
          {
            status,
            preApprovalAmount: application.preApprovalAmount,
            purchasePrice: application.purchasePrice,
          },
          `setting status to '${status}'`,
        );
      } catch (guardErr) {
        return res.status(422).json({
          error: guardErr instanceof Error ? guardErr.message : "A loan amount is required at this stage",
        });
      }

      // TRID hard stop (Reg Z §1026.19(e)(1)(iii)): once the six pieces of
      // application information are on file, the file may not move forward
      // past the Loan Estimate due date until the LE is issued. Exit
      // dispositions (denied/withdrawn/suspended) are never blocked.
      const tridBlock = tridHardStopError(application, status);
      if (tridBlock) {
        return res.status(422).json({ error: tridBlock });
      }

      // ECOA/Reg B §1002.9 + FCRA §615: a denial must carry an adverse-action
      // notice. The shared chokepoint generates it BEFORE the status flips —
      // if it can't, the denial does not proceed. (Same guard runs on the
      // underwriting advance-stage denial path.)
      if (status === "denied") {
        const aa = await creditService.ensureAdverseActionForDenial({
          applicationId: id,
          userId: application.userId,
          denialReasons,
          creditScoreUsed: application.creditScore,
          generatedBy: user.id,
        });
        if (!aa.ok) {
          return res.status(422).json({ error: aa.error });
        }
        if (aa.created) {
          logAudit(req, "adverse_action.generated", "loan_application", id, {
            adverseActionId: aa.adverseActionId,
            trigger: "status_denied",
          });
        }
      }

      // Selling Guide B3-2-05: an Approve/Eligible file is eligible for sale
      // only "if all approval conditions have been met" (with B3-2-01's duty to
      // comply with every findings-report condition, and D1-3-02's post-closing
      // QC verifying exactly that at the wholesale lender). Moving into the
      // closing track with conditions un-settled is a defect the lender kicks
      // back — so the stage-exit condition check gates entry to these statuses.
      // Current-stage semantics (same as advance-stage): approval/docs-priority
      // conditions gate entry to clear_to_close, all conditions gate entry to
      // closing, and the engine's closing branch stops funding on anything
      // un-settled — which is where prior_to_funding bites, matching the
      // priority's meaning (a funding condition may stay open at CTC). Exit
      // dispositions (denied/withdrawn/suspended) are never gated. Admin
      // force bypasses with an audit entry, mirroring the transition-table
      // force below.
      if (status === "clear_to_close" || status === "closing" || status === "funded") {
        const progress = await checkPipelineProgress(id);
        if (!progress.readyForNextStage) {
          if (force === true && isAdmin(user)) {
            logAudit(req, "pipeline.condition_gate_forced", "loan_application", id, {
              toStatus: status,
              blockers: progress.blockers,
            });
          } else {
            return res.status(422).json({
              error: `Cannot set status to '${status.replace(/_/g, " ")}': ${progress.blockers.join("; ")}. Clear, waive, or mark the conditions not applicable first.`,
              code: "conditions_outstanding",
              blockers: progress.blockers,
            });
          }
        }
      }

      const previousStatus = application.status;

      // Single writer: milestones, HMDA LAR codes, task-engine events, state-
      // machine sync, and funded→homeowner graduation all happen inside
      // updatePipelineStage. Invalid transitions come back as 409 with the
      // allowed set so staff UIs can grey out impossible moves.
      try {
        await updatePipelineStage(id, status, {
          denialReasons,
          force: force === true && isAdmin(user),
        });
      } catch (stageErr) {
        if (stageErr instanceof PipelineTransitionError) {
          return res.status(409).json({
            error: stageErr.message,
            code: "invalid_transition",
            fromStatus: stageErr.fromStage,
            toStatus: stageErr.toStage,
            allowedStatuses: stageErr.allowed,
          });
        }
        throw stageErr;
      }

      const updated = await storage.getLoanApplication(id);

      await storage.createDealActivity({
        applicationId: id,
        activityType: "status_change",
        title: `Status Updated to ${status.replace(/_/g, " ").toUpperCase()}`,
        // Derived copy only — the description is shared display for every
        // role. Staff decision notes ride metadata, which the borrower
        // activity view embargoes (shared/borrowerActivityView.ts).
        description: `Application status changed from ${previousStatus} to ${status}`,
        performedBy: user.id,
        ...(notes ? { metadata: { notes } } : {}),
      });

      const borrower = await storage.getUser(application.userId);
      if (borrower) {
        const statusLabel = status.replace(/_/g, " ");
        await storage.createNotification({
          userId: borrower.id,
          type: "status_update",
          title: "Application Status Updated",
          body: `Your application status has been updated to: ${statusLabel}`,
          entityType: "loan_application",
          entityId: id,
          status: "unread",
        });

        if (borrower.email) {
          const borrowerName = borrower.firstName || "Borrower";
          if (status === "pre_approved" || status === "clear_to_close") {
            sendNotificationEmail({
              type: "application_pre_approved",
              recipientEmail: borrower.email,
              data: {
                borrowerName,
                amount: (parseFloat(application.preApprovalAmount || "0") || 0).toLocaleString(),
                applicationId: id,
              },
            });
          } else if (status === "denied") {
            sendNotificationEmail({
              type: "application_denied",
              recipientEmail: borrower.email,
              data: { borrowerName },
            });
          } else {
            sendNotificationEmail({
              type: "status_update",
              recipientEmail: borrower.email,
              data: { borrowerName, statusLabel, applicationId: id },
            });
          }
        }
      }

      logAudit(req, "loan_application.status_changed", "loan_application", id, {
        previousStatus,
        newStatus: status,
        changedBy: user.id,
        ...(updated?.hmdaActionTaken && { hmdaActionTaken: updated.hmdaActionTaken }),
        ...(updated?.hmdaDenialReasons?.length && { hmdaDenialReasons: updated.hmdaDenialReasons }),
      });

      res.json(updated);
    } catch (error) {
      console.error("Staff status update error:", error);
      res.status(500).json({ error: "Failed to update application status" });
    }
  });

  // Compatibility endpoint for the former all-or-nothing control. It may only
  // promote a file after the same evidence gates as the granular workflow:
  // a current approved financial memo and a completed real bureau pull.
  app.post(
    "/api/loan-applications/:id/verify-financials",
    requireRole(...FINANCIAL_VERIFICATION_ROLES),
    async (req, res) => {
      try {
        const user = req.user as User;
        const { id } = routeParams(req);

        const application = await storage.getLoanApplication(id);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }

        // Non-admin staff must be on the deal team.
        if (!isAdmin(user)) {
          const teamMembers = await storage.getDealTeamMembers(id);
          if (!teamMembers.some((m) => m.userId === user.id)) {
            return res.status(403).json({ error: "You are not assigned to this application" });
          }
        }

        const [{ getCurrentApprovedFinancialVerificationEvidence }, { getLatestCreditPull }, { markDimensionVerified }] = await Promise.all([
          import("../../services/financialReview"),
          import("../../services/creditService"),
          import("../../services/verification"),
        ]);
        const [financialEvidence, creditPull] = await Promise.all([
          getCurrentApprovedFinancialVerificationEvidence(id),
          getLatestCreditPull(id),
        ]);
        const evidence: FinancialVerificationEvidence = {
          approvedMemoId: financialEvidence.memo?.id ?? null,
          approvedIncomeWorkpaperId: financialEvidence.incomeWorkpaperId,
          approvedAssetWorkpaperId: financialEvidence.assetWorkpaperId,
          creditPullId: creditPull?.id ?? null,
          creditPullIsSimulated: creditPull?.isSimulated ?? false,
        };
        const blockers = [
          financialVerificationEvidenceError("income", evidence),
          financialVerificationEvidenceError("assets", evidence),
          financialVerificationEvidenceError("credit", evidence),
        ].filter((message): message is string => !!message);
        if (blockers.length > 0) {
          return res.status(422).json({ error: "Financial verification is incomplete", blockers });
        }

        await markDimensionVerified(id, "income", user.id);
        await markDimensionVerified(id, "assets", user.id);
        await markDimensionVerified(id, "credit", user.id);
        const updated = await storage.getLoanApplication(id);

        logAudit(req, "loan_application.financials_verified", "loan_application", id, {
          verifiedBy: user.id,
          financialMemoId: financialEvidence.memo!.id,
          incomeWorkpaperId: financialEvidence.incomeWorkpaperId,
          assetWorkpaperId: financialEvidence.assetWorkpaperId,
          creditPullId: creditPull!.id,
        });

        res.json(updated);
      } catch (error) {
        console.error("Verify financials error:", error);
        res.status(500).json({ error: "Failed to verify financials" });
      }
    },
  );

  // Verify a single dimension (income | assets | credit). Rolls up to a fully
  // VERIFIED application once all three are done. Granular verification means
  // staff confirm each source as it's reviewed instead of one all-or-nothing toggle.
  app.post(
    "/api/loan-applications/:id/verify/:dimension",
    requireRole(...FINANCIAL_VERIFICATION_ROLES),
    async (req, res) => {
      try {
        const user = req.user as User;
        const { id, dimension } = routeParams(req);
        if (!["income", "assets", "credit"].includes(dimension)) {
          return res.status(400).json({ error: "dimension must be income, assets, or credit" });
        }
        const verifiedDimension = dimension as "income" | "assets" | "credit";

        const application = await storage.getLoanApplication(id);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }
        if (!isAdmin(user)) {
          const teamMembers = await storage.getDealTeamMembers(id);
          if (!teamMembers.some((m) => m.userId === user.id)) {
            return res.status(403).json({ error: "You are not assigned to this application" });
          }
        }

        let evidenceId: string;
        if (dimension === "credit") {
          const { getLatestCreditPull } = await import("../../services/creditService");
          const creditPull = await getLatestCreditPull(id);
          const evidenceError = financialVerificationEvidenceError("credit", {
            approvedMemoId: null,
            approvedIncomeWorkpaperId: null,
            approvedAssetWorkpaperId: null,
            creditPullId: creditPull?.id ?? null,
            creditPullIsSimulated: creditPull?.isSimulated ?? false,
          });
          if (evidenceError) {
            return res.status(422).json({ error: evidenceError });
          }
          evidenceId = creditPull!.id;
        } else {
          const { getCurrentApprovedFinancialVerificationEvidence } = await import("../../services/financialReview");
          const financialEvidence = await getCurrentApprovedFinancialVerificationEvidence(id);
          const evidenceError = financialVerificationEvidenceError(verifiedDimension, {
            approvedMemoId: financialEvidence.memo?.id ?? null,
            approvedIncomeWorkpaperId: financialEvidence.incomeWorkpaperId,
            approvedAssetWorkpaperId: financialEvidence.assetWorkpaperId,
            creditPullId: null,
            creditPullIsSimulated: false,
          });
          if (evidenceError) {
            return res.status(422).json({ error: evidenceError });
          }
          evidenceId = dimension === "income"
            ? financialEvidence.incomeWorkpaperId!
            : financialEvidence.assetWorkpaperId!;
        }

        const { markDimensionVerified } = await import("../../services/verification");
        await markDimensionVerified(id, verifiedDimension, user.id);

        logAudit(req, "loan_application.dimension_verified", "loan_application", id, {
          dimension,
          verifiedBy: user.id,
          evidenceId,
        });

        const updated = await storage.getLoanApplication(id);
        res.json(updated);
      } catch (error) {
        console.error("Verify dimension error:", error);
        res.status(500).json({ error: "Failed to verify dimension" });
      }
    },
  );

  app.get("/api/loan-applications/draft/latest", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user!.id;
      const applications = await storage.getLoanApplicationsByUser(userId);
      
      const draft = applications.find(app => app.status === "draft");
      if (draft) {
        return res.json(draft);
      }
      
      res.json(null);
    } catch (error) {
      console.error("Get draft application error:", error);
      res.status(500).json({ error: "Failed to get draft application" });
    }
  });

}
