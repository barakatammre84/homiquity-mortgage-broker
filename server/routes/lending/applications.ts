// Lending routes: Loan-application intake (TRID trigger on create), list, detail, options.
// One registrar in the original registration order — see ./index.ts.
import type { Express } from "express";
import type { IStorage } from "../../storage";
import { isAuthenticated } from "../../auth";
import { insertBorrowerDeclarationsSchema, isStaffRole, loanApplicationIntakeSchema, type User } from "@shared/schema";
import { toBorrowerActivityViews } from "@shared/borrowerActivityView";
import { getLenderIdentifiers } from "../../services/lenderIdentifiers";
import { unlicensedStateRejection } from "@shared/companyIdentity";
import { toDocumentViewsForRole } from "@shared/borrowerDocumentView";
import { finalizeIntake } from "../../services/loanAnalysis";
import { z } from "zod";
import { logAudit } from "../../auditLog";
import * as creditService from "../../services/creditService";
import { FUNNEL_SOFT_PULL_CONSENT_TEXT, FUNNEL_SOFT_PULL_CONSENT_VERSION } from "@shared/creditConsentCopy";
import { sendNotificationEmail } from "../../services/emailService";
import { evaluateTridTrigger } from "../../services/trid";
import { intakePausedGate } from "../../services/maintenanceMode";
import { prelaunchGate } from "../../services/prelaunchGate";
import { updatePipelineStage } from "../../pipelineEngine";
import { routeParam } from "../../http/routeParams";
import { clientIpForRecord } from "../../clientIp";

const declarationsValidationSchema = insertBorrowerDeclarationsSchema.partial().extend({
  applicationId: z.string().optional(),
});

// Intake validation lives in shared/schema/lending.ts (loanApplicationIntakeSchema),
// derived from the same base schema the funnel validates with client-side — the
// server rejects exactly what the client rejects, and "not_sure" credit maps to
// the named CREDIT_SCORE_UNKNOWN_DEFAULT instead of a silent clamp.

export function registerApplicationRoutes(
  app: Express,
  storage: IStorage,
) {
  app.post("/api/loan-applications", isAuthenticated, prelaunchGate, intakePausedGate, async (req, res) => {
    try {
      const user = req.user as User;
      const userId = user.id;
      
      const parsed = loanApplicationIntakeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors });
      }
      const formData = parsed.data;

      // Licensed-state gate (roadmap A5): we cannot take an application for a
      // property outside the licensed footprint (SAFE Act/Reg H; state law
      // controls — see shared/companyIdentity.ts). Absent state passes: the
      // TRID address-last funnel may not have collected the property yet.
      const stateRejection = unlicensedStateRejection(formData.propertyState);
      if (stateRejection) {
        return res.status(422).json(stateRejection);
      }

      let referringBrokerId: string | undefined = undefined;
      if (user.referredByUserId) {
        referringBrokerId = user.referredByUserId;
      }

      // All figures are schema-required and validated — no "|| 0" fallbacks
      // manufacturing $0 incomes out of missing data.
      const applicationData = {
        userId,
        status: "submitted" as const,
        annualIncome: formData.annualIncome,
        monthlyDebts: formData.monthlyDebts,
        creditScore: formData.creditScore,
        employmentType: formData.employmentType,
        employmentYears: formData.employmentYears,
        propertyType: formData.propertyType,
        purchasePrice: formData.purchasePrice,
        downPayment: formData.downPayment,
        loanPurpose: formData.loanPurpose,
        isVeteran: formData.isVeteran,
        isFirstTimeBuyer: formData.isFirstTimeBuyer,
        // UAL P7 routing signal; null = not answered (never defaulted).
        avoidsInterestFinancing: formData.avoidsInterestFinancing ?? null,
        propertyState: formData.propertyState,
        // Schema-validated numeric strings → integer columns.
        householdFamilySize: formData.householdFamilySize ? parseInt(formData.householdFamilySize) : null,
        homeSquareFootage: formData.homeSquareFootage ? parseInt(formData.homeSquareFootage) : null,
        incomeSources: formData.incomeSources || null,
        referringBrokerId,
      };

      // A1: consume the user's existing draft container instead of minting a
      // sibling row. The funnel autosaves into a server draft (POST /draft +
      // PATCH below); a submit that created a NEW row would strand that draft
      // to re-offer stale answers on every future visit (the exact bug
      // useDraftRestore's module comment documents). The status flip goes
      // through updatePipelineStage — THE single status writer (draft →
      // submitted is a legal transition) — never a direct status update.
      const { status: _intendedStatus, ...draftFields } = applicationData;
      const existingDraft = (await storage.getLoanApplicationsByUser(userId)).find(
        (a) => a.status === "draft",
      );

      let application;
      if (existingDraft) {
        await storage.updateLoanApplication(existingDraft.id, draftFields);
        await updatePipelineStage(existingDraft.id, "submitted");
        application = (await storage.getLoanApplication(existingDraft.id))!;
        logAudit(req, "loan_application.created", "loan_application", application.id, {
          consumedDraftId: existingDraft.id,
        });
      } else {
        application = await storage.createLoanApplication(applicationData);
        logAudit(req, "loan_application.created", "loan_application", application.id);
      }

      // The fast application already collected each rental property. Carry it
      // into URLA section 2c immediately so the borrower does not type it again
      // and the loan officer receives a real property record rather than an
      // income-only note. The intake source remains self-reported and still
      // requires normal document review.
      try {
        const syncedRentalProperties = await storage.syncIntakeRentalProperties(
          application.id,
          userId,
          formData.incomeSources,
        );
        if (syncedRentalProperties.length > 0) {
          application = (await storage.getLoanApplication(application.id)) ?? application;
          logAudit(req, "urla.real_estate_owned.intake_synced", "loan_application", application.id, {
            propertyCount: syncedRentalProperties.length,
          });
        }
      } catch (reoSyncErr) {
        // The validated incomeSources JSON remains durable and the URLA screen
        // can still rehydrate it. Keep intake fast and observable rather than
        // inviting a duplicate application submission.
        console.error("[Intake] Rental-property URLA sync failed (recoverable):", reoSyncErr);
      }

      // Seed the readiness checklist from what the application already says.
      // Until now nothing fed it from the application — only the document
      // paths wrote to it — so a borrower who had stated income, employer,
      // credit score and property still scored near zero on the model that
      // knew the most, and the borrower-facing percentage had to come from
      // somewhere else. Recorded at `application_stated` (tier 2); documents
      // upgrade the same rows to tier 1. Non-fatal: readiness is a signal.
      try {
        const { syncApplicationToReadiness } = await import("../../services/readinessSync");
        await syncApplicationToReadiness(userId, application.id, application);
      } catch (readinessErr) {
        console.warn("[Intake] readiness sync failed (non-fatal):", readinessErr);
      }

      // Roadmap A3: applying is the moment an aspiring_owner becomes an
      // active_buyer — the promotion writer this split never had. Both are
      // CLIENT_ROLES with identical server-side authorization (verified: no
      // route gates on either), so this changes navigation cohort + admin
      // stats, never privileges. Guarded to exactly aspiring_owner: a staff
      // or partner role can never be rewritten by creating an application.
      // Best-effort — a promotion failure must not fail intake.
      if (user.role === "aspiring_owner") {
        try {
          await storage.updateUserRole(userId, "active_buyer");
          logAudit(req, "user.role_change", "user", userId, {
            previousRole: "aspiring_owner",
            newRole: "active_buyer",
            reason: "auto_promotion_on_application",
          });
        } catch (promoteErr) {
          console.warn("[Intake] active_buyer promotion failed (non-fatal):", promoteErr);
        }
      }

      // Seed the outcomes/analytics row at funnel entry (the "submitted" stamp
      // the conversion-funnel dashboard counts). createLoanApplication writes
      // status "submitted" directly, bypassing updatePipelineStage, so the
      // intake stamp is recorded here — for the CREATE path only (the
      // consumed-draft path went through updatePipelineStage, which records
      // the stamp itself). Best-effort — never blocks the response.
      if (!existingDraft) {
        try {
          const { recordStageTimestamp } = await import("../../services/outcomeTracker");
          await recordStageTimestamp(application.id, "submitted");
        } catch (outcomeErr) {
          console.warn("[Intake] Outcome submitted-stamp failed (non-fatal):", outcomeErr);
        }
      }

      // TRID §1026.2(a)(3): intake may have just supplied the 6th piece of
      // application information — evaluate the Loan Estimate trigger.
      // Non-fatal: a trigger-bookkeeping failure must not lose the application.
      try {
        const trid = await evaluateTridTrigger(application.id);
        if (trid.justTriggered) {
          logAudit(req, "trid.application_triggered", "loan_application", application.id, {
            leDueDate: trid.leDueDate?.toISOString(),
          });
        }
      } catch (tridErr) {
        console.error("[TRID] Trigger evaluation failed (non-fatal):", tridErr);
      }

      // Persist the funnel's FCRA soft-pull acknowledgment as ledger evidence
      // (canonical disclosure text + IP + user agent). Non-fatal: a consent
      // write failure must not lose the application itself.
      if (formData.softPullConsentAccepted === true) {
        try {
          const borrowerFullName =
            [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || "Borrower";
          const consent = await creditService.createCreditConsent({
            applicationId: application.id,
            userId,
            consentType: "soft_pull",
            borrowerFullName,
            consentGiven: true,
            // Record what the borrower ACTUALLY saw — the funnel checkbox is the
            // entire disclosure in this path. Previously this row stored the full
            // FCRA authorization (both inquiry types, 120-day validity, identity
            // attestations) that the funnel never displayed (F-034).
            disclosureText: FUNNEL_SOFT_PULL_CONSENT_TEXT,
            disclosureVersion: FUNNEL_SOFT_PULL_CONSENT_VERSION,
            ipAddress: clientIpForRecord(req) ?? undefined,
            userAgent: req.get("User-Agent"),
          });
          logAudit(req, "credit_consent.created", "loan_application", application.id, {
            consentId: consent.id,
            consentType: "soft_pull",
            source: "preapproval_funnel",
          });
        } catch (consentErr) {
          console.error("[Consent] Failed to persist funnel soft-pull consent (non-fatal):", consentErr);
        }
      }

      const inviteId = req.body.inviteId;
      if (inviteId && typeof inviteId === "string") {
        try {
          const invite = await storage.updateApplicationInvite(inviteId, {
            status: "applied",
            appliedAt: new Date(),
            loanApplicationId: application.id,
          });
          if (invite) {
            console.log(`[Invite] Linked invite ${inviteId} to application ${application.id}`);
            // Fold the inviting LO/LOA into the deal's own attribution. A client
            // who arrived via a direct-apply invite never went through /ref, so
            // referringBrokerId was null above; without this, attribution would
            // live only on the invite row and be invisible to any pipeline logic
            // reading the application. Only fill it if not already set (a real
            // /ref attribution wins) and only for LO/LOA referrers.
            if (
              !referringBrokerId &&
              (invite.referrerType === "lo" || invite.referrerType === "loa")
            ) {
              await storage.updateLoanApplication(application.id, {
                referringBrokerId: invite.referrerId,
              });
            }
          }
        } catch (inviteErr) {
          console.warn(`[Invite] Failed to link invite ${inviteId}:`, inviteErr);
        }
      }

      // Route a referred/invited applicant straight onto the referring loan
      // officer's desk — full file access + pipeline queue visibility — with no
      // admin step. Reads the final referringBrokerId (the invite block may have
      // just folded an inviting LO into it). Only lo/loa may own a file; broker
      // and other referrers stay attribution-only. Non-fatal: a routing failure
      // must not lose the application (it simply falls to the unassigned pool).
      try {
        const finalApp = await storage.getLoanApplication(application.id);
        const referrerId = finalApp?.referringBrokerId ?? referringBrokerId ?? null;
        if (referrerId) {
          const referrer = await storage.getUser(referrerId);
          if (referrer && (referrer.role === "lo" || referrer.role === "loa")) {
            await storage.assignLoanOfficer(application.id, referrerId, userId);
            logAudit(req, "loan_application.lo_auto_assigned", "loan_application", application.id, {
              loanOfficerId: referrerId,
              source: "referral",
            });
          }
        }
      } catch (assignErr) {
        console.warn("[Intake] LO auto-assignment skipped (non-fatal):", assignErr);
      }

      await storage.createDealActivity({
        applicationId: application.id,
        activityType: "status_change",
        title: "Application Submitted",
        description: "Your loan application has been received and is being analyzed.",
        performedBy: userId,
      });

      await storage.createNotification({
        userId,
        type: "application_submitted",
        title: "Application Received",
        body: "Your mortgage application has been submitted and is being reviewed.",
        entityType: "loan_application",
        entityId: application.id,
        status: "unread",
      });

      res.status(201).json(application);

      // Deterministic decision path (Reg B): matrix-driven engine + closed-form
      // math, no AI. Runs after the response so intake stays snappy. This same
      // finalizer is re-drivable by the recovery sweep if a downstream drop
      // strands the application mid-analysis (never left stuck in "analyzing").
      //
      // ONE submission email, not two: finalizeIntake's decision email (issued
      // seconds from now) also acknowledges receipt. A separate "received"
      // email sent here raced it through the provider and routinely landed
      // AFTER the decision email, reading as duplicate noise. The plain
      // receipt below is the fallback for the one path where no decision
      // email is coming yet — analysis failed and the recovery sweep will
      // re-drive it later.
      try {
        await finalizeIntake(application.id);
      } catch (analysisError) {
        console.error("Intake analysis error:", analysisError);
        // finalizeIntake already reset status to "submitted" for retry.
        if (user.email) {
          sendNotificationEmail({
            type: "application_submitted",
            recipientEmail: user.email,
            data: { borrowerName: user.firstName || "Borrower", applicationId: application.id },
          });
        }
      }
    } catch (error) {
      console.error("Create application error:", error);
      res.status(500).json({ error: "Failed to create application" });
    }
  });

  // A1: find-or-create the user's ONE draft container, so the authenticated
  // funnel can autosave server-side (PATCH /api/loan-applications/:id, the
  // existing drafts-only edit route) and progress survives a device switch.
  // Idempotent — a second call returns the same row. Same intake gates as
  // application creation: while intake is paused, autosave degrades to
  // localStorage-only (the client treats a failure here as non-fatal).
  // Self-only by construction (the row is minted for req.user); no figures
  // are accepted here — answers arrive only through the validated PATCH.
  app.post("/api/loan-applications/draft", isAuthenticated, prelaunchGate, intakePausedGate, async (req, res) => {
    try {
      const userId = req.user!.id;
      const existing = (await storage.getLoanApplicationsByUser(userId)).find(
        (a) => a.status === "draft",
      );
      if (existing) {
        return res.json(existing);
      }
      const draft = await storage.createLoanApplication({ userId, status: "draft" });
      logAudit(req, "loan_application.draft_created", "loan_application", draft.id);
      res.status(201).json(draft);
    } catch (error) {
      console.error("Create draft error:", error);
      res.status(500).json({ error: "Failed to create draft" });
    }
  });

  app.get("/api/loan-applications", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user!.id;
      const applications = await storage.getLoanApplicationsByUser(userId);
      res.json(applications);
    } catch (error) {
      console.error("Get applications error:", error);
      res.status(500).json({ error: "Failed to get applications" });
    }
  });

  app.get("/api/loan-applications/:id", isAuthenticated, async (req, res) => {
    try {
      const application = await storage.getLoanApplicationWithAccess(
        routeParam(req, "id"), 
        req.user!.id, 
        req.user!.role
      );
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      const [options, documents, activities] = await Promise.all([
        storage.getLoanOptionsByApplication(routeParam(req, "id")),
        storage.getDocumentsByApplication(routeParam(req, "id")),
        storage.getDealActivitiesByApplication(routeParam(req, "id")),
      ]);

      res.json({
        application,
        options,
        // Ciphertext trio never ships; reviewedByUserId is staff-only —
        // see shared/borrowerDocumentView.ts.
        documents: toDocumentViewsForRole(documents, req.user!.role),
        // Non-staff callers get the whitelist view: staff clearance notes,
        // wholesale-lender names, internal ops entries, and activity metadata
        // never leave the server (borrower transparency doctrine —
        // shared/borrowerActivityView.ts). Staff keep full rows.
        activities: isStaffRole(req.user!.role)
          ? activities
          : toBorrowerActivityViews(activities, await getLenderIdentifiers(), req.user!.id),
      });
    } catch (error) {
      console.error("Get application error:", error);
      res.status(500).json({ error: "Failed to get application" });
    }
  });

  app.get("/api/loan-applications/:id/options", isAuthenticated, async (req, res) => {
    try {
      const application = await storage.getLoanApplicationWithAccess(
        routeParam(req, "id"), 
        req.user!.id, 
        req.user!.role
      );
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const options = await storage.getLoanOptionsByApplication(routeParam(req, "id"));
      
      res.json({
        application,
        options,
      });
    } catch (error) {
      console.error("Get loan options error:", error);
      res.status(500).json({ error: "Failed to get loan options" });
    }
  });

  // Live market pricing (Binding Contract 2): price the borrower's profile
  // against the active wholesale rate sheets on every request — base rate +
  // LLPA + lock term + lender overlays, all deterministic. Sample sheets and
  // vendor-fed sheets flow through the same tables, so this endpoint reprices
  // automatically as market data updates. PRELIMINARY (self-reported) profiles
  // get indicative pricing only; locking stays gated on verification.
}
