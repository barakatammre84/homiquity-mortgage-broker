import type { Express } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  loanApplications,
  users,
  verificationReports,
} from "@shared/schema";
import type { User } from "@shared/schema";
import { requireRole } from "../auth";
import { storage } from "../storage";
import {
  buildCommitmentLetter,
  parsePlaidAssetReport,
  submitToDU,
  submitToLPA,
} from "../services/ausSubmission";
import { validateMISMOCompleteness, evaluateGseSubmissionReadiness } from "../services/mismoValidation";
import { AUS_INPUT_FINGERPRINT_VERSION, buildAusSubmissionContext } from "../services/ausDecisionIntegrity";

/**
 * AUS orchestration routes: Plaid asset webhook ingestion and GSE (Fannie DU)
 * casefile submission. See server/services/ausSubmission.ts for the vendor
 * adapters and simulation gates.
 */

const plaidAssetsWebhookSchema = z.object({
  webhook_type: z.literal("ASSETS").optional(),
  webhook_code: z.string().optional(), // PRODUCT_READY
  asset_report_id: z.string().min(1).optional(),
  asset_report_token: z.string().min(1),
  // Homiquity-specific correlation hint (set when we create the asset report)
  application_id: z.string().min(1),
  days_requested: z.number().int().positive().optional(),
});

const submitGseSchema = z.object({
  applicationId: z.string().min(1),
});

export function registerAusRoutes(app: Express) {
  /**
   * Plaid asset-report webhook. Unauthenticated by nature (Plaid calls it),
   * so: CSRF-exempt (see app.ts), optionally guarded by a shared secret
   * (PLAID_WEBHOOK_SECRET), and it only ever writes verification metadata —
   * never returns borrower data to the caller.
   */
  app.post("/api/webhooks/plaid-assets", async (req, res) => {
    try {
      // Fail CLOSED in production: an unset secret must not leave an open,
      // unauthenticated endpoint that forges asset-verification reports
      // (gseEligible=true with attacker-controlled balances). Same posture as
      // CRON_SECRET in routes/jobs.ts — unset means the path is disabled, not
      // open. Dev/test keeps the permissive behavior for simulated vendors.
      const secret = process.env.PLAID_WEBHOOK_SECRET;
      if (process.env.NODE_ENV === "production" && !secret) {
        console.error("[aus] plaid-assets webhook rejected: PLAID_WEBHOOK_SECRET is not configured");
        return res.status(503).json({ error: "Webhook not configured" });
      }
      if (secret && req.headers["x-webhook-secret"] !== secret) {
        return res.status(401).json({ error: "Invalid webhook secret" });
      }

      const parsed = plaidAssetsWebhookSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid webhook payload", details: parsed.error.flatten().fieldErrors });
      }
      const { asset_report_token, asset_report_id, application_id, days_requested } = parsed.data;

      const [application] = await db
        .select({ id: loanApplications.id, userId: loanApplications.userId })
        .from(loanApplications)
        .where(eq(loanApplications.id, application_id))
        .limit(1);
      if (!application) {
        // Acknowledge so Plaid stops retrying, but flag the orphan loudly.
        console.error(`[aus] plaid-assets webhook for unknown application ${application_id}`);
        return res.status(202).json({ received: true, matched: false });
      }

      const report = await parsePlaidAssetReport(asset_report_token);

      const [inserted] = await db
        .insert(verificationReports)
        .values({
          applicationId: application.id,
          userId: application.userId,
          provider: "plaid",
          reportType: "voa",
          voaReportId: asset_report_id ?? report.assetReportId,
          providerRequestId: report.assetReportId,
          status: "completed",
          daysRequested: days_requested ?? 90,
          gseEligible: true,
          institutionCount: report.institutionCount,
          accountCount: report.accountCount,
          totalBalance: report.totalBalance.toFixed(2),
          // Audit trace + large-deposit sourcing input (B3-4.2-02 Depository Accounts; a deposit that
            // turns out to be a gift resolves under B3-4.3-04).
          rawPayload: report,
          completedAt: new Date(),
          expiresAt: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000),
        })
        .returning({ id: verificationReports.id });

      console.error(
        `[aus] VOA stored for application ${application.id}: ${report.accountCount} accounts, ` +
          `$${report.totalBalance.toLocaleString()} total, trend=${report.transactionTrend}` +
          (report.simulated ? " (simulated)" : ""),
      );

      // Re-run the pre-underwriting validator now that verified assets exist —
      // this is where the asset-to-income reserves check gets real data.
      try {
        const { runPreUnderwriting } = await import("../services/preUnderwriting");
        await runPreUnderwriting(application.id, "voa_received");
      } catch (preUwErr) {
        console.error("[aus] Pre-underwriting re-evaluation failed (non-fatal):", preUwErr);
      }

      return res.status(200).json({
        received: true,
        matched: true,
        verificationReportId: inserted.id,
        simulated: report.simulated,
      });
    } catch (error) {
      console.error("[aus] plaid-assets webhook error:", error);
      return res.status(500).json({ error: "Failed to process asset report webhook" });
    }
  });

  /**
   * Submit the casefile to Fannie Mae DU (12.1-shaped), parse Day 1 Certainty,
   * persist findings, and return a structured commitment letter.
   */
  app.post(
    "/api/underwrite/submit-gse",
    requireRole("lo", "loa", "processor", "underwriter", "admin"),
    async (req, res) => {
      try {
        const parsed = submitGseSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid request", details: parsed.error.flatten().fieldErrors });
        }
        const { applicationId } = parsed.data;

        // Object-level access: a non-admin staffer may only run AUS on a file
        // they are on the deal team for (getLoanApplicationWithAccess returns
        // undefined for both "not found" and "no access" — 404 either way so we
        // don't leak which applications exist).
        const user = req.user as User;
        const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
        if (!application) return res.status(404).json({ error: "Application not found" });

        const [borrower] = await db
          .select({ firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, application.userId))
          .limit(1);

        // Completeness gate: refuse to hand DU a casefile that is missing
        // required URLA fields (SSN, DOB, citizenship, address, employment,
        // declarations, HMDA) or carries critical compliance errors (ARM,
        // ATR/QM points-and-fees — both surface via criticalErrors). Blocks
        // with an actionable field list rather than failing downstream at the
        // GSE. Deliberately does NOT block on a merely-low completeness score
        // or missing document uploads: DU runs on casefile data, and its
        // findings often determine which documents are needed.
        const validation = await validateMISMOCompleteness(applicationId);
        const gate = evaluateGseSubmissionReadiness(validation);
        if (gate.blocked) {
          return res.status(gate.status).json(gate.body);
        }

        // One calculation path produces the casefile: the deterministic engine
        // supplies its current income, debts, qualifying PITIA and policy
        // fingerprint. If that engine cannot make a coherent casefile, do not
        // manufacture a partial DU result from application summary fields.
        const context = await buildAusSubmissionContext(applicationId);
        if (!context.casefileInput || !context.inputFingerprint) {
          return res.status(422).json({
            error: context.decisionPath === "manual_underwrite"
              ? "This file is outside the automated decision matrix and needs manual underwriting."
              : "Current underwriting inputs are incomplete.",
            code: context.decisionPath,
            blockers: context.blockers,
            decision: context.decision,
          });
        }
        const casefileInput = context.casefileInput;
        const loanAmount = casefileInput.loanAmount;
        const purchasePrice = casefileInput.propertyValue;

        // Dual AUS: DU and LPA run on the same casefile inputs so lender
        // selection can follow whichever engine reads the file better. DU
        // stays the headline recommendation; LPA rides along in ausFindings.
        const [rawFindings, lpaFindings] = await Promise.all([
          submitToDU(casefileInput),
          submitToLPA(casefileInput),
        ]);
        const findings = {
          ...rawFindings,
          inputIntegrity: {
            version: AUS_INPUT_FINGERPRINT_VERSION,
            inputFingerprint: context.inputFingerprint,
            evidenceFingerprint: context.evidenceFingerprint,
            decisionInputsFingerprint: context.decision.inputsFingerprint,
            policyFingerprint: context.decision.resolvedPolicy?.fingerprint ?? null,
            decisionPath: context.decisionPath,
          },
        };

        // Persist findings onto the application…
        await db
          .update(loanApplications)
          .set({
            ausCasefileId: findings.casefileId,
            ausRecommendation: findings.recommendation,
            ausSubmittedAt: new Date(),
            ausFindings: { ...findings, lpa: lpaFindings },
            d1cAssetsRelief: findings.day1Certainty.assets.relief,
            d1cIncomeRelief: findings.day1Certainty.income.relief,
            d1cEmploymentRelief: findings.day1Certainty.employment.relief,
          })
          .where(eq(loanApplications.id, applicationId));

        // …and mark the consumed reports GSE-eligible/ineligible per findings.
        const reliefByReportId: Array<[string | undefined, boolean]> = [
          [context.verificationReportIds.voa ?? undefined, findings.day1Certainty.assets.relief],
          [context.verificationReportIds.voie ?? undefined, findings.day1Certainty.income.relief || findings.day1Certainty.employment.relief],
        ];
        for (const [reportId, relief] of reliefByReportId) {
          if (reportId) {
            await db
              .update(verificationReports)
              .set({ gseEligible: relief, updatedAt: new Date() })
              .where(eq(verificationReports.id, reportId));
          }
        }

        // Autopilot (Phase 2): map AUS findings to the right split — borrower
        // follow-ups for Day 1 Certainty assets/income, lender-internal for VOE
        // and structural (LTV/credit/DTI) conditions. No-op when the agent is
        // off or this file is out of pilot scope, so today's behavior is intact.
        try {
          const { isAutopilotEnabled, canGenerateFollowUps } = await import("../services/autopilot/config");
          if ((await isAutopilotEnabled(application.loanOfficerId)) && (await canGenerateFollowUps())) {
            const { materializeAusFollowUps } = await import("../services/autopilot/ausFollowUps");
            const mapped = await materializeAusFollowUps(applicationId, findings, lpaFindings);
            const total = mapped.borrowerActionable + mapped.lenderInternal;
            await storage.createDealActivity({
              applicationId,
              activityType: "autopilot_review",
              title: "Autopilot mapped AUS findings",
              description:
                total === 0
                  ? "DU/LPA returned no borrower-actionable conditions — the file is verification-clean."
                  : `DU/LPA returned ${total} condition(s): created ${mapped.created.length} borrower follow-up(s)` +
                    `${mapped.created.length ? ` (${mapped.created.join(", ")})` : ""}, kept ${mapped.lenderInternal} lender-internal.`,
              performedBy: application.userId,
            });
          }
        } catch (autopilotErr) {
          console.warn("[Autopilot] AUS mapping failed (non-fatal):", autopilotErr);
        }

        const commitmentLetter = buildCommitmentLetter({
          applicationId,
          borrowerName: [borrower?.firstName, borrower?.lastName].filter(Boolean).join(" ") || "Borrower",
          propertyAddress: application.propertyAddress,
          loanAmount,
          propertyValue: purchasePrice,
          findings,
        });

        console.error(
          `[aus] DU casefile ${findings.casefileId} for ${applicationId}: ${findings.recommendation} ` +
            `(D1C assets=${findings.day1Certainty.assets.relief} income=${findings.day1Certainty.income.relief} ` +
            `employment=${findings.day1Certainty.employment.relief})${findings.simulated ? " (simulated)" : ""}`,
        );
        return res.json({
          casefileId: findings.casefileId,
          recommendation: findings.recommendation,
          day1Certainty: findings.day1Certainty,
          findings,
          commitmentLetter,
        });
      } catch (error) {
        console.error("[aus] submit-gse error:", error);
        return res.status(500).json({ error: "GSE submission failed" });
      }
    },
  );
}
