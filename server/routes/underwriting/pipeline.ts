// Underwriting routes: Pipeline view, conditions, milestones, advance-stage (ECOA denial chokepoint + TRID hard stop), queue/pool/claim.
// One registrar in the original registration order — see ./index.ts.
import type { Express } from "express";
import { isAdmin } from "@shared/roles";
import type { IStorage } from "../../storage";
import { isAuthenticated, requireRole } from "../../auth";
import { isInFlightLoanAppStatus, isLoanAppStatus, isStaffRole, LOAN_APP_STATUSES, LOAN_CONDITION_STATUSES, canSetConditionVerdict } from "@shared/schema";
import type { User, LoanAppStatus, LoanApplication, DealTeamMember } from "@shared/schema";
import { toBorrowerConditionViews } from "@shared/borrowerConditionView";
import { getLenderIdentifiers } from "../../services/lenderIdentifiers";
import { z } from "zod";
import { parseBodyOr400 } from "../validate";
import { assertVerifiedForDecisioning, type DataProvenance } from "@shared/dataProvenance";
import { assertStageRequirements } from "@shared/stageRequirements";
import { tridHardStopError } from "../../services/trid";
import * as creditService from "../../services/creditService";
import { updateConditionMetrics } from "../../services/outcomeTracker";
import { routeParams } from "../../http/routeParams";
import { getCurrentDecisionGrade } from "../../services/currentDecisionGrade";

/**
 * Checks whether a staff user is authorized to mutate a specific loan application.
 * Admins always pass. All other staff roles must be active members of the deal team.
 */
async function isAssignedToApplication(
  storage: IStorage,
  applicationId: string,
  userId: string,
  userRole: string,
): Promise<boolean> {
  if (userRole === "admin") return true;
  const teamMembers = await storage.getDealTeamMembers(applicationId);
  return teamMembers.some(m => m.userId === userId);
}

/**
 * Roles permitted to execute each stage transition.
 * Transitions not listed here are allowed by any assigned staff member.
 */
const STAGE_TRANSITION_ROLES: Record<string, string[]> = {
  denied: ["admin", "underwriter"],
  approved: ["admin", "underwriter"],
  clear_to_close: ["admin", "underwriter"],
  funded: ["admin", "closer"],
};

/**
 * A staffer can legitimately have more than one active deal-team role on a
 * file, and historical data may contain repeated rows for the same role. The
 * work queue is a list of applications, so its identity is applicationId — not
 * membership id. Returning one row per membership inflated pipeline totals and
 * repeated the same borrower throughout the command center.
 */
export function uniqueMemberApplications(
  memberships: Array<Pick<DealTeamMember, "applicationId"> & { application?: LoanApplication }>,
): LoanApplication[] {
  const byId = new Map<string, LoanApplication>();
  for (const membership of memberships) {
    if (membership.application) byId.set(membership.application.id, membership.application);
  }
  return [...byId.values()];
}

export function registerPipelineRoutes(
  app: Express,
  storage: IStorage,
) {
  app.get("/api/loan-applications/:id/pipeline", isAuthenticated, async (req, res) => {
    try {
      const { id } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const { checkPipelineProgress, getPipelineSummary } = await import("../../pipelineEngine");
      
      const [progress, summary, milestones, conditions] = await Promise.all([
        checkPipelineProgress(id),
        getPipelineSummary(id),
        storage.getLoanMilestones(id),
        storage.getLoanConditionsByApplication(id),
      ]);

      res.json({
        progress,
        summary,
        milestones,
        // Non-staff callers get the whitelist view: staff clearance notes,
        // the clearing user's id, rule/task linkage, and the wholesale-lender
        // submission link never leave the server (borrower transparency
        // doctrine — shared/borrowerConditionView.ts). Staff keep full rows.
        conditions: isStaffRole(req.user!.role)
          ? conditions
          : toBorrowerConditionViews(conditions, await getLenderIdentifiers()),
      });
    } catch (error) {
      console.error("Get pipeline status error:", error);
      res.status(500).json({ error: "Failed to get pipeline status" });
    }
  });

  app.get("/api/loan-applications/:id/conditions", isAuthenticated, async (req, res) => {
    try {
      const { id } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const rows = await storage.getLoanConditionsByApplication(id);
      // Same whitelist boundary as /pipeline above: map BEFORE grouping so
      // every shape in the response carries the masked rows for non-staff.
      const conditions = isStaffRole(req.user!.role)
        ? rows
        : toBorrowerConditionViews(rows, await getLenderIdentifiers());

      const grouped = {
        priorToApproval: conditions.filter(c => c.priority === "prior_to_approval"),
        priorToDocs: conditions.filter(c => c.priority === "prior_to_docs"),
        priorToFunding: conditions.filter(c => c.priority === "prior_to_funding"),
      };

      const stats = {
        total: conditions.length,
        outstanding: conditions.filter(c => c.status === "outstanding").length,
        submitted: conditions.filter(c => c.status === "submitted").length,
        cleared: conditions.filter(c => c.status === "cleared").length,
        waived: conditions.filter(c => c.status === "waived").length,
      };

      res.json({ conditions, grouped, stats });
    } catch (error) {
      console.error("Get conditions error:", error);
      res.status(500).json({ error: "Failed to get conditions" });
    }
  });

  app.patch("/api/conditions/:id", requireRole("admin", "lo", "processor", "underwriter", "closer"), async (req, res) => {
    try {
      const { id } = routeParams(req);
      const condition = await storage.getLoanCondition(id);
      if (!condition) {
        return res.status(404).json({ error: "Condition not found" });
      }

      // Verify the application exists and is accessible
      const application = await storage.getLoanApplicationWithAccess(
        condition.applicationId,
        req.user!.id,
        req.user!.role,
      );
      if (!application) {
        return res.status(403).json({ error: "Access denied to this application" });
      }

      // Verify the caller is on the deal team for this application (admins bypass)
      const assigned = await isAssignedToApplication(
        storage,
        condition.applicationId,
        req.user!.id,
        req.user!.role,
      );
      if (!assigned) {
        return res.status(403).json({ error: "You are not assigned to this loan file" });
      }

      // The status vocabulary is closed — the old raw-body fall-through let
      // any string reach loanConditions.status, and an off-vocabulary value
      // makes the condition invisible to open-condition counts and readiness
      // gates without ever being settled.
      const body = parseBodyOr400(
        z.object({
          status: z.enum(LOAN_CONDITION_STATUSES),
          clearanceNotes: z.string().max(2000).optional(),
        }),
        req.body,
        res,
      );
      if (body === undefined) return;
      const { status, clearanceNotes } = body;
      const callerRole = req.user!.role;

      // Waiving a condition is restricted to underwriters and admins only.
      // Role lists live in CONDITION_VERDICT_ROLES (shared/statusVocabularies)
      // so ConditionsTab renders only the verdicts the caller may set —
      // behavior-identical hoist of the former inline literals.
      if (status === "waived") {
        if (!canSetConditionVerdict(callerRole, "waived")) {
          return res.status(403).json({ error: "Only underwriters and admins can waive conditions" });
        }

        const updated = await storage.updateLoanCondition(id, {
          status: "waived",
          clearanceNotes,
          clearedByUserId: req.user!.id,
          clearedAt: new Date(),
        });

        await storage.createDealActivity({
          applicationId: condition.applicationId,
          activityType: "condition_waived",
          title: "Condition Waived",
          description: `"${condition.title}" has been waived.${clearanceNotes ? ` Reason: ${clearanceNotes}` : ""}`,
          performedBy: req.user!.id,
          metadata: { conditionId: id, notes: clearanceNotes },
        });

        // Refresh the outcomes condition metrics (issued/cleared/waived counts,
        // avg clearance days) — self-guarded, never throws (F-002 wiring).
        await updateConditionMetrics(condition.applicationId);
        return res.json(updated);
      }

      // Clearing a condition is restricted to underwriters, processors, closers, and admins
      if (status === "cleared") {
        if (!canSetConditionVerdict(callerRole, "cleared")) {
          return res.status(403).json({ error: "Only underwriters, processors, closers, and admins can clear conditions" });
        }

        const updated = await storage.clearLoanCondition(id, req.user!.id, clearanceNotes);
        
        await storage.createDealActivity({
          applicationId: condition.applicationId,
          activityType: "condition_cleared",
          title: "Condition Cleared",
          description: `"${condition.title}" has been cleared.`,
          performedBy: req.user!.id,
          metadata: { conditionId: id, notes: clearanceNotes },
        });

        await updateConditionMetrics(condition.applicationId);
        return res.json(updated);
      }

      if (status === "not_applicable") {
        if (!canSetConditionVerdict(callerRole, "not_applicable")) {
          return res.status(403).json({ error: "Only underwriters, processors, and admins can mark conditions as not applicable" });
        }

        const updated = await storage.updateLoanCondition(id, {
          status: "not_applicable",
          clearanceNotes,
          clearedByUserId: req.user!.id,
          clearedAt: new Date(),
        });

        await storage.createDealActivity({
          applicationId: condition.applicationId,
          activityType: "condition_not_applicable",
          title: "Condition Marked N/A",
          description: `"${condition.title}" marked as not applicable.${clearanceNotes ? ` Reason: ${clearanceNotes}` : ""}`,
          performedBy: req.user!.id,
          metadata: { conditionId: id, notes: clearanceNotes },
        });

        await updateConditionMetrics(condition.applicationId);
        return res.json(updated);
      }

      const updated = await storage.updateLoanCondition(id, { status, clearanceNotes });
      await updateConditionMetrics(condition.applicationId);
      res.json(updated);
    } catch (error) {
      console.error("Update condition error:", error);
      res.status(500).json({ error: "Failed to update condition" });
    }
  });

  app.get("/api/loan-applications/:id/milestones", isAuthenticated, async (req, res) => {
    try {
      const { id } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const milestones = await storage.getLoanMilestones(id);
      res.json(milestones || {});
    } catch (error) {
      console.error("Get milestones error:", error);
      res.status(500).json({ error: "Failed to get milestones" });
    }
  });

  app.post("/api/loan-applications/:id/advance-stage", requireRole("admin", "lo", "processor", "underwriter", "closer"), async (req, res) => {
    try {
      const { id } = routeParams(req);

      const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const { newStage, denialReasons } = req.body;
      if (!newStage) {
        return res.status(400).json({ error: "New stage is required" });
      }
      if (!isLoanAppStatus(newStage)) {
        return res.status(400).json({
          error: `Unknown stage '${newStage}'`,
          code: "unknown_status",
          allowedStatuses: LOAN_APP_STATUSES,
        });
      }

      // HMDA LAR requires at least 2 denial reasons when an application is denied.
      if (newStage === "denied" && (!Array.isArray(denialReasons) || denialReasons.length < 2)) {
        return res.status(400).json({
          error: "At least 2 denial reasons are required to deny an application (HMDA LAR)",
        });
      }

      // TRID hard stop (Reg Z §1026.19(e)(1)(iii)): a file with an overdue
      // Loan Estimate may not advance to any non-exit stage.
      const tridBlock = tridHardStopError(application, newStage);
      if (tridBlock) {
        return res.status(422).json({ error: tridBlock });
      }

      // Approval-grade stages may not be reached on self-reported/estimated data.
      // (Denial is not gated — see the status endpoint for the rationale.)
      const APPROVAL_GRADE_STAGES = new Set<LoanAppStatus>(["pre_approved", "conditional", "clear_to_close", "funded"]);
      if (APPROVAL_GRADE_STAGES.has(newStage)) {
        try {
          assertVerifiedForDecisioning(
            application.financialDataProvenance as DataProvenance,
            `advancing to '${newStage}'`,
          );
        } catch (guardErr) {
          return res.status(422).json({
            error: guardErr instanceof Error ? guardErr.message : "Financial data must be verified",
          });
        }
        const currentGrade = await getCurrentDecisionGrade(application);
        if (!currentGrade.isDecisionGrade) {
          return res.status(422).json({
            error: "The approved financial or credit evidence is missing or stale. Refresh the financial review before advancing this file.",
            code: "decision_evidence_not_current",
            blockers: currentGrade.reasons,
          });
        }

        // ...and must carry a coherent loan amount — a decision stage with no
        // pre-approval amount or purchase price is an impossible state (#7).
        try {
          assertStageRequirements(
            {
              status: newStage,
              preApprovalAmount: application.preApprovalAmount,
              purchasePrice: application.purchasePrice,
            },
            `advancing to '${newStage}'`,
          );
        } catch (guardErr) {
          return res.status(422).json({
            error: guardErr instanceof Error ? guardErr.message : "A loan amount is required at this stage",
          });
        }
      }

      // Verify the caller is on the deal team for this application (admins bypass)
      const assigned = await isAssignedToApplication(storage, id, req.user!.id, req.user!.role);
      if (!assigned) {
        return res.status(403).json({ error: "You are not assigned to this loan file" });
      }

      // Enforce role-based stage transition policy for sensitive transitions
      const allowedRolesForStage = STAGE_TRANSITION_ROLES[newStage];
      if (allowedRolesForStage && !allowedRolesForStage.includes(req.user!.role)) {
        return res.status(403).json({
          error: `Only ${allowedRolesForStage.join(" or ")} can move a loan to '${newStage}'`,
        });
      }

      const { updatePipelineStage, checkPipelineProgress, PipelineTransitionError } = await import("../../pipelineEngine");

      const progress = await checkPipelineProgress(id);
      if (!progress.readyForNextStage && newStage !== "denied") {
        return res.status(400).json({
          error: "Cannot advance stage",
          code: "stage_blocked",
          blockers: progress.blockers
        });
      }

      // ECOA/Reg B §1002.9 + FCRA §615: a denial via this pipeline path must
      // carry an adverse-action notice, exactly as the status endpoint does.
      // Generate it BEFORE the stage moves — if it can't, the denial is blocked.
      if (newStage === "denied") {
        const aa = await creditService.ensureAdverseActionForDenial({
          applicationId: id,
          userId: application.userId,
          denialReasons,
          creditScoreUsed: application.creditScore,
          generatedBy: req.user!.id,
        });
        if (!aa.ok) {
          return res.status(422).json({ error: aa.error });
        }
        if (aa.created) {
          const { logAudit } = await import("../../auditLog");
          logAudit(req, "adverse_action.generated", "loan_application", id, {
            adverseActionId: aa.adverseActionId,
            trigger: "advance_stage_denied",
          });
        }
      }

      try {
        await updatePipelineStage(id, newStage, newStage === "denied" ? { denialReasons } : undefined);
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

      await storage.createDealActivity({
        applicationId: id,
        activityType: "status_change",
        title: `Stage Advanced to ${newStage.replace(/_/g, " ").replace(/\b\w/g, (l: string) => l.toUpperCase())}`,
        description: `Loan advanced to ${newStage} stage.`,
        performedBy: req.user!.id,
      });

      // Audit trail: pipeline/underwriting stage transition (a credit decision).
      const { logAudit } = await import("../../auditLog");
      logAudit(req, "underwriting.stage_advanced", "loan_application", id, {
        newStage,
        performedBy: req.user!.id,
        ...(newStage === "denied" && denialReasons ? { denialReasons } : {}),
      });

      const updatedApp = await storage.getLoanApplication(id);
      res.json(updatedApp);
    } catch (error) {
      console.error("Advance stage error:", error);
      res.status(500).json({ error: "Failed to advance stage" });
    }
  });

  app.get("/api/pipeline/queue", requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"), async (req, res) => {
    try {
      const user = req.user as User;
      let applications: Awaited<ReturnType<typeof storage.getAllLoanApplications>>;

      if (isAdmin(user)) {
        applications = await storage.getAllLoanApplications();
      } else {
        const teamMemberships = await storage.getTeamMembersByUser(user.id);
        applications = uniqueMemberApplications(teamMemberships);
      }

      // The work queue holds in-flight files only: no drafts, no terminal
      // statuses (funded/denied/withdrawn/expired). Suspended files stay —
      // paused work is still the team's work.
      const activeApps = applications.filter(a => isInFlightLoanAppStatus(a.status));

      const { getPipelineSummaries } = await import("../../pipelineEngine");

      // Batched: fetches milestones, conditions, and borrowers in three
      // inArray queries total rather than 4×N serial round trips.
      const summaries = await getPipelineSummaries(activeApps);

      const queue = summaries
        .sort((a, b) => {
          const priorityOrder = { urgent: 0, high: 1, normal: 2 };
          if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
            return priorityOrder[a.priority] - priorityOrder[b.priority];
          }
          return b.daysInPipeline - a.daysInPipeline;
        });

      const byStage: Record<string, typeof queue> = {};
      for (const item of queue) {
        if (!byStage[item.currentStage]) {
          byStage[item.currentStage] = [];
        }
        byStage[item.currentStage].push(item);
      }

      res.json({
        total: queue.length,
        byPriority: {
          urgent: queue.filter(q => q.priority === "urgent").length,
          high: queue.filter(q => q.priority === "high").length,
          normal: queue.filter(q => q.priority === "normal").length,
        },
        byStage,
        queue,
      });
    } catch (error) {
      console.error("Get pipeline queue error:", error);
      res.status(500).json({ error: "Failed to get pipeline queue" });
    }
  });

  // The intake "pool": active applications with no loan officer yet. Any LO/LOA
  // (and admins) can see it and claim a file, so a self-serve applicant who
  // arrived without a referral is never stranded waiting on an admin assignment.
  // Same summary shape as the queue.
  app.get("/api/pipeline/unassigned", requireRole("admin", "lo", "loa"), async (req, res) => {
    try {
      const unassigned = await storage.getUnassignedApplications();
      const { getPipelineSummaries } = await import("../../pipelineEngine");
      const summaries = await getPipelineSummaries(unassigned);
      const queue = summaries.sort((a, b) => b.daysInPipeline - a.daysInPipeline);
      res.json({ total: queue.length, queue });
    } catch (error) {
      console.error("Get unassigned pool error:", error);
      res.status(500).json({ error: "Failed to get unassigned applications" });
    }
  });

  // An LO/LOA claims an unassigned file from the intake pool onto their own desk.
  // Refuses to take a file already owned by another LO (409); re-claiming your
  // own file is an idempotent success. assignLoanOfficer atomically grants file
  // access + queue visibility.
  app.post("/api/loan-applications/:applicationId/claim", requireRole("lo", "loa"), async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId } = routeParams(req);
      const application = await storage.getLoanApplication(applicationId);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      if (application.loanOfficerId && application.loanOfficerId !== user.id) {
        return res.status(409).json({ error: "This file is already assigned to another loan officer." });
      }
      const updated = await storage.assignLoanOfficer(applicationId, user.id, user.id);
      await storage.createDealActivity({
        applicationId,
        activityType: "team_updated",
        title: "Loan officer assigned",
        description: "A loan officer claimed this file from the intake pool.",
        performedBy: user.id,
      });
      const { logAudit } = await import("../../auditLog");
      logAudit(req, "loan_application.lo_claimed", "loan_application", applicationId, {
        loanOfficerId: user.id,
      });
      res.json({ success: true, application: updated });
    } catch (error) {
      console.error("Claim application error:", error);
      res.status(500).json({ error: "Failed to claim application" });
    }
  });

  // Staff-scoped applications listing for the internal dashboard.
  // Admin sees every application; every other internal-staff role sees only the
  // applications they are an active deal-team member on — mirroring the scoping
  // used by GET /api/pipeline/queue. This is the non-admin equivalent of the
  // admin-only GET /api/admin/applications.
}
