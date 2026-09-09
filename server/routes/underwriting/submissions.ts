// Underwriting routes: MISMO validation, submission readiness, wholesale lenders, lender submissions + packages + conditions.
// One registrar in the original registration order — see ./index.ts.
import type { Express } from "express";
import type { IStorage } from "../../storage";
import { isAuthenticated, requireRole } from "../../auth";
import { CONDITION_PRIORITY } from "@shared/schema";
import { z } from "zod";
import * as creditService from "../../services/creditService";
import { updateConditionMetrics } from "../../services/outcomeTracker";
import { routeParams } from "../../http/routeParams";
import { createHash } from "node:crypto";

/**
 * Window the working-capital days-to-cash figure is measured over. Matches the
 * cycle-time endpoint's own default so the two reports describe the same cohort.
 */
const WORKING_CAPITAL_WINDOW_DAYS = 90;

export function registerSubmissionRoutes(
  app: Express,
  storage: IStorage,
) {
  app.get("/api/loan-applications/:id/mismo-validation", isAuthenticated, async (req, res) => {
    try {
      const { id } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const { validateMISMOCompleteness } = await import("../../services/mismoValidation");
      const validation = await validateMISMOCompleteness(id);
      res.json(validation);
    } catch (error) {
      console.error("MISMO validation error:", error);
      res.status(500).json({ error: "Failed to validate MISMO completeness" });
    }
  });

  // Broker submission workflow: staged gate from intake to wholesale-lender
  // package (intake/TRID → DU → package + anti-steering), with the Fannie Mae
  // delivery edits as an informational lender's-eye pre-flight. This is the
  // operational "can this file go to a lender today" view for LO/processor.
  app.get(
    "/api/loan-applications/:id/submission-readiness",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const { id } = routeParams(req);
        const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }

        const { evaluateBrokerSubmissionReadiness } = await import("../../services/brokerSubmissionReadiness");
        const report = await evaluateBrokerSubmissionReadiness(id);
        res.json(report);
      } catch (error) {
        console.error("Submission readiness error:", error);
        res.status(500).json({ error: "Failed to evaluate submission readiness" });
      }
    },
  );

  // Wholesale lender catalog — read from the wholesale_lenders table, the one
  // source of truth shared with pricing. `apiConfig` is withheld: it carries
  // integration endpoints/auth shape that no staff picker needs.
  app.get(
    "/api/wholesale-lenders",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (_req, res) => {
      try {
        const lenders = await storage.getWholesaleLenders();
        res.json(lenders.map(({ apiConfig, ...lender }) => lender));
      } catch (error) {
        console.error("List wholesale lenders error:", error);
        res.status(500).json({ error: "Failed to list wholesale lenders" });
      }
    },
  );

  // Submit a packaging-complete file to a wholesale lender. Server-enforced:
  // the broker submission-readiness gate must pass (stages 1–3 blocker-free)
  // and only one active submission per lender is allowed.
  app.post(
    "/api/loan-applications/:id/lender-submissions",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const { id } = routeParams(req);
        const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }
        const lenderId = typeof req.body?.lenderId === "string" ? req.body.lenderId : "";
        if (!lenderId) {
          return res.status(400).json({ error: "lenderId is required" });
        }

        const { submitToWholesaleLender, SubmissionBlockedError } = await import("../../services/lenderSubmission");
        try {
          const result = await submitToWholesaleLender(id, lenderId, req.user!.id);
          const { logAudit } = await import("../../auditLog");
          logAudit(req, "broker.lender_submission_created", "loan_application", id, {
            lenderId,
            submissionId: result.submission.id,
            confirmationId: result.submission.confirmationId,
            simulated: result.submission.simulated,
          });
          // Omit the MISMO XML body (carries full SSN/DOB) from the response;
          // fetch it explicitly via the mismo-package route below.
          const { mismoPackageXml, ausFindingsJson, ...submission } = result.submission;
          res.status(201).json(submission);
        } catch (err) {
          if (err instanceof SubmissionBlockedError) {
            return res.status(422).json({ error: err.message, blockers: err.blockers });
          }
          throw err;
        }
      } catch (error) {
        console.error("Lender submission error:", error);
        res.status(500).json({ error: "Failed to submit to lender" });
      }
    },
  );

  app.get(
    "/api/loan-applications/:id/lender-submissions",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const { id } = routeParams(req);
        const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }
        const submissions = await storage.getLenderSubmissionsByApplication(id);
        // Per-submission lender-condition rollup — one batched query, then
        // group in memory (never query per submission).
        const linkedConditions = await storage.getLoanConditionsBySubmissionIds(submissions.map(s => s.id));
        const statsBySubmission = new Map<string, { total: number; open: number; cleared: number }>();
        for (const c of linkedConditions) {
          if (!c.lenderSubmissionId) continue;
          const stats = statsBySubmission.get(c.lenderSubmissionId) ?? { total: 0, open: 0, cleared: 0 };
          stats.total += 1;
          if (c.status === "outstanding" || c.status === "submitted") stats.open += 1;
          else stats.cleared += 1;
          statsBySubmission.set(c.lenderSubmissionId, stats);
        }
        // Omit the MISMO XML body (carries full SSN/DOB) from the list view;
        // fetch it explicitly via the mismo-package route below.
        res.json(submissions.map(({ mismoPackageXml, ausFindingsJson, ...s }) => ({
          ...s,
          conditionStats: statsBySubmission.get(s.id) ?? { total: 0, open: 0, cleared: 0 },
        })));
      } catch (error) {
        console.error("List lender submissions error:", error);
        res.status(500).json({ error: "Failed to list lender submissions" });
      }
    },
  );

  // Download the exact MISMO 3.4 XML package sent for a given submission —
  // an immutable snapshot, not regenerated from current data. Internal staff
  // only, same rationale as the mismo-export route (full SSN/DOB payload).
  app.get(
    "/api/loan-applications/:id/lender-submissions/:submissionId/mismo-package",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const { id, submissionId } = routeParams(req);
        const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }
        const submission = await storage.getLenderSubmission(submissionId);
        if (!submission || submission.applicationId !== id || !submission.mismoPackageXml) {
          return res.status(404).json({ error: "Package not found" });
        }
        const currentHash = createHash("sha256").update(submission.mismoPackageXml).digest("hex");
        if (!submission.mismoPackageHash || currentHash !== submission.mismoPackageHash) {
          return res.status(409).json({ error: "Stored MISMO package failed its integrity check." });
        }
        const { logAuditRequired } = await import("../../auditLog");
        await logAuditRequired(req, "broker.lender_submission_mismo_downloaded", "lender_submission", submissionId, {
          applicationId: id,
          packageHashPrefix: submission.mismoPackageHash.slice(0, 12),
        });
        res.setHeader("Content-Type", "application/xml");
        res.setHeader("Content-Disposition", `attachment; filename="mismo-package-${submissionId}.xml"`);
        res.send(submission.mismoPackageXml);
      } catch (error) {
        console.error("Lender package download error:", error);
        res.status(500).json({ error: "Failed to fetch lender package" });
      }
    },
  );

  // Download the exact dual-AUS report retained with the lender package.
  // Re-hash before release so a changed database value cannot masquerade as
  // the findings that were current when the submission was created.
  app.get(
    "/api/loan-applications/:id/lender-submissions/:submissionId/aus-findings",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const { id, submissionId } = routeParams(req);
        const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
        if (!application) return res.status(404).json({ error: "Application not found" });
        const submission = await storage.getLenderSubmission(submissionId);
        if (!submission || submission.applicationId !== id || !submission.ausFindingsJson) {
          return res.status(404).json({ error: "AUS findings artifact not found" });
        }
        const { buildAusFindingsArtifact, SubmissionBlockedError } = await import("../../services/lenderSubmission");
        let artifact;
        try {
          artifact = buildAusFindingsArtifact(submission.ausFindingsJson);
        } catch (error) {
          if (error instanceof SubmissionBlockedError) {
            return res.status(409).json({ error: "Stored AUS findings failed their integrity check." });
          }
          throw error;
        }
        if (!submission.ausFindingsHash || artifact.hash !== submission.ausFindingsHash) {
          return res.status(409).json({ error: "Stored AUS findings failed their integrity check." });
        }
        const { logAuditRequired } = await import("../../auditLog");
        await logAuditRequired(req, "broker.lender_submission_aus_downloaded", "lender_submission", submissionId, {
          applicationId: id,
          packageHashPrefix: submission.ausFindingsHash.slice(0, 12),
        });
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="aus-findings-${submissionId}.json"`);
        res.send(JSON.stringify({
          hash: submission.ausFindingsHash,
          generatedAt: submission.ausFindingsGeneratedAt,
          findings: submission.ausFindingsJson,
        }, null, 2));
      } catch (error) {
        console.error("AUS findings download error:", error);
        res.status(500).json({ error: "Failed to fetch AUS findings artifact" });
      }
    },
  );

  // Log wholesale-lender conditions against a submission — the per-condition
  // leg of the post-submission workflow. No lender feed exists until broker
  // agreements, so staff transcribe conditions from the lender's portal. Rows
  // land in loan_conditions (category "lender_condition") and therefore ride
  // every existing conditions surface (pipeline, clearing UI, borrower
  // outstanding lists, metrics); clearing stays on PATCH /api/conditions/:id.
  const logLenderConditionsSchema = z.object({
    conditions: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(255),
          description: z.string().trim().max(2000).optional(),
          priority: z.enum(CONDITION_PRIORITY).optional(),
        }),
      )
      .min(1)
      .max(50),
  });
  app.post(
    "/api/loan-applications/:id/lender-submissions/:submissionId/conditions",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const parsed = logLenderConditionsSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid conditions payload", details: parsed.error.flatten() });
        }
        const { id, submissionId } = routeParams(req);
        const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }
        const submission = await storage.getLenderSubmission(submissionId);
        if (!submission || submission.applicationId !== id) {
          return res.status(404).json({ error: "Submission not found" });
        }

        const created = await storage.createLoanConditions(
          parsed.data.conditions.map(c => ({
            applicationId: id,
            category: "lender_condition",
            title: c.title,
            description: c.description,
            priority: c.priority ?? "prior_to_docs",
            status: "outstanding",
            isAutoGenerated: false,
            sourceRule: `lender:${submission.lenderId}`,
            lenderSubmissionId: submissionId,
          })),
        );

        const lenderRow = await storage.getWholesaleLenderByLenderId(submission.lenderId);
        const lenderName = lenderRow?.lenderName ?? submission.lenderId;
        await storage.createDealActivity({
          applicationId: id,
          activityType: "lender_conditions_logged",
          title: "Lender conditions logged",
          description: `${created.length} condition(s) from ${lenderName} logged for clearing.`,
          performedBy: req.user!.id,
          metadata: { submissionId, count: created.length },
        });
        await updateConditionMetrics(id);

        const { logAudit } = await import("../../auditLog");
        logAudit(req, "broker.lender_conditions_logged", "loan_application", id, {
          submissionId,
          count: created.length,
        });

        res.status(201).json({ conditions: created });
      } catch (error) {
        console.error("Log lender conditions error:", error);
        res.status(500).json({ error: "Failed to log lender conditions" });
      }
    },
  );

  // Advance a submission's status as the lender responds (transition-checked).
  app.patch(
    "/api/lender-submissions/:submissionId",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const { submissionId } = routeParams(req);
        const submission = await storage.getLenderSubmission(submissionId);
        if (!submission) {
          return res.status(404).json({ error: "Submission not found" });
        }
        const application = await storage.getLoanApplicationWithAccess(
          submission.applicationId, req.user!.id, req.user!.role,
        );
        if (!application) {
          return res.status(403).json({ error: "Access denied" });
        }

        const toStatus = typeof req.body?.status === "string" ? req.body.status : "";
        const notes = typeof req.body?.notes === "string" ? req.body.notes.slice(0, 2000) : undefined;

        // Funding is where revenue is realized, so the transition to "funded"
        // carries the figures that make it measurable (F-6). The service
        // rejects the transition without them.
        let funding: { fundedLoanAmount: number; compensationReceivedAmount: number } | undefined;
        if (toStatus === "funded") {
          const fundingSchema = z.object({
            fundedLoanAmount: z.number().positive(),
            compensationReceivedAmount: z.number().min(0),
          });
          const parsedFunding = fundingSchema.safeParse(req.body?.funding);
          if (!parsedFunding.success) {
            return res.status(400).json({
              error:
                "Marking a submission funded requires funding.fundedLoanAmount and " +
                "funding.compensationReceivedAmount.",
              details: parsedFunding.error.flatten().fieldErrors,
            });
          }
          funding = parsedFunding.data;
        }

        const { updateSubmissionStatus, SubmissionBlockedError } = await import("../../services/lenderSubmission");
        try {
          const updated = await updateSubmissionStatus(submissionId, toStatus, notes, req.user!.id, funding);

          // Autopilot decision relay: on a terminal lender decision, tell the
          // borrower they're approved / funded (Reg N), or flag the deal team
          // for the ECOA §1002.9 adverse-action notice on a denial. Gated by the
          // kill switch and non-fatal — never break the status update.
          try {
            const { relayLenderDecision } = await import("../../services/autopilot/decisionRelay");
            await relayLenderDecision({ application, toStatus, performedBy: req.user!.id });
          } catch (relayErr) {
            console.warn("[Autopilot] Decision relay failed (non-fatal):", relayErr);
          }

          const { logAudit } = await import("../../auditLog");
          logAudit(req, "broker.lender_submission_status", "loan_application", submission.applicationId, {
            submissionId,
            from: submission.status,
            to: toStatus,
          });
          res.json(updated);
        } catch (err) {
          if (err instanceof SubmissionBlockedError) {
            return res.status(422).json({ error: err.message });
          }
          throw err;
        }
      } catch (error) {
        console.error("Update lender submission error:", error);
        res.status(500).json({ error: "Failed to update submission" });
      }
    },
  );

  // ---------------------------------------------------------------------
  // Broker revenue report (F-6). What did the book actually earn, did the
  // lenders pay what the comp plans say, and how much of the pipeline
  // converts? Admin-only: this is company-level financial data, not a
  // per-file view.
  // ---------------------------------------------------------------------
  app.get("/api/reports/compensation", requireRole("admin"), async (_req, res) => {
    try {
      const submissions = await storage.getAllLenderSubmissions();
      const { summarizeCompensation, evaluateCompensationVariance } = await import(
        "@shared/compensationLedger"
      );
      const { approvedLenderCount } = await import("@shared/wholesaleLenders");
      const { toCounterparty } = await import("../../services/lenderSubmission");

      // Lenders come from the wholesale_lenders table (one source of truth with
      // pricing). One read, then an in-memory index — the discrepancy list below
      // is per-submission and must not turn into a query per row.
      const lenderRows = await storage.getWholesaleLenders();
      const lenderByKey = new Map(lenderRows.map(l => [l.lenderId, l]));

      const summary = summarizeCompensation(submissions);

      // Discrepancies worth a human: funded loans that were short-paid, or
      // funded with no remittance recorded at all.
      // Simulated fundings are excluded: a "short-pay" on money nobody wired
      // is not a discrepancy anyone can chase, and putting it on this list
      // sends staff to reconcile a lender that was never billed (F-21).
      const discrepancies = submissions
        .filter(s => s.status === "funded" && !s.simulated)
        .map(s => ({
          submissionId: s.id,
          applicationId: s.applicationId,
          lender: lenderByKey.get(s.lenderId)?.lenderName ?? s.lenderId,
          fundedAt: s.fundedAt,
          ...evaluateCompensationVariance({
            expectedAmount: s.compensationExpectedAmount,
            receivedAmount: s.compensationReceivedAmount,
          }),
        }))
        .filter(row => row.status === "short_paid" || row.status === "over_paid" || row.status === "pending");

      // Contingent liability (F-8): compensation the lenders can still
      // reclaim if these loans pay off early. For an asset-light broker this
      // is the balance sheet, and it existed nowhere before.
      const { buildClawbackRegister } = await import("@shared/compensationClawback");
      const clawback = buildClawbackRegister(
        submissions.map(s => ({
          submissionId: s.id,
          applicationId: s.applicationId,
          status: s.status,
          lenderId: s.lenderId,
          // Contracted EPO window from the lender row; undefined when no
          // agreement exists yet, which the register flags as assumed.
          epoClawbackDays: lenderByKey.get(s.lenderId)?.epoClawbackDays,
          fundedAt: s.fundedAt,
          compensationReceivedAmount: s.compensationReceivedAmount,
          simulated: s.simulated,
        })),
      );

      // Revenue recognition (F-0808-03 / F-0809-02 / F-0811-03). Revenue was
      // lender compensation only, so the platform's own ~$2,000/file was
      // income nowhere and a BORROWER-PAID file reported a negative margin.
      // Recognized on the lender's remittance advice (owner decision), sourced
      // from the file's ISSUED Loan Estimate rather than a recompute of
      // today's fee schedule — which would re-price history.
      const { recognizeRevenue } = await import("@shared/revenueRecognition");
      const disclosures = await storage.getAllLoanEstimateDisclosures();
      const latestDisclosure = new Map<string, any>();
      for (const d of disclosures) {
        // Rows come back version-descending, so the first per application is
        // its current baseline.
        if (!latestDisclosure.has(d.applicationId)) latestDisclosure.set(d.applicationId, d);
      }
      let platformFeeRevenueTotal = 0;
      let unrecognizedPlatformFees = 0;
      let platformFeesUnknownCount = 0;
      for (const sub of submissions) {
        const snapshot = latestDisclosure.get(sub.applicationId)?.snapshot as
          | { fees?: { id: string; label: string; amount: number; bucket: string }[] }
          | undefined;
        const recognized = recognizeRevenue({
          status: sub.status,
          compensationModel: sub.compensationModel,
          compensationReceivedAmount: sub.compensationReceivedAmount,
          compensationReceivedAt: sub.compensationReceivedAt,
          disclosedFees: (snapshot?.fees as never) ?? null,
          simulated: sub.simulated,
        });
        platformFeeRevenueTotal += recognized.platformFees;
        unrecognizedPlatformFees += recognized.unrecognizedPlatformFees;
        if (recognized.platformFeesUnknown) platformFeesUnknownCount += 1;
      }
      const revenue = {
        lenderCompensation: summary.receivedCompensation,
        platformFees: Math.round((platformFeeRevenueTotal + Number.EPSILON) * 100) / 100,
        total:
          Math.round((summary.receivedCompensation + platformFeeRevenueTotal + Number.EPSILON) * 100) / 100,
        unrecognizedPlatformFees:
          Math.round((unrecognizedPlatformFees + Number.EPSILON) * 100) / 100,
        /** Funded files with no issued LE — unknown, never summed as zero. */
        platformFeesUnknownCount,
      };

      // Cost side + margin (F-11). Revenue alone is not unit economics: costs
      // are incurred on every file and revenue arrives only on the ones that
      // close, so the meaningful denominator is the funded count.
      const {
        summarizeCosts,
        summarizeCommissionCosts,
        computeUnitEconomics,
        computeWorkingCapitalPosition,
      } = await import("@shared/costLedger");
      const [costEntries, commissionRows] = await Promise.all([
        storage.getAllLoanCostEntries(),
        storage.getAllBrokerCommissions(),
      ]);
      const costs = summarizeCosts(costEntries);
      // Commission payouts are the other half of the cost side: money that
      // leaves the company per funded loan, previously sitting in a table no
      // financial view read.
      const commissions = summarizeCommissionCosts(commissionRows);
      const unitEconomics = computeUnitEconomics({
        // BOTH channels now — a margin built on lender compensation alone
        // understates a lender-paid file and inverts a borrower-paid one.
        receivedCompensation: revenue.total,
        fundedCount: summary.fundedCount,
        costs,
        simulatedRevenue: summary.simulated.receivedCompensation,
        commissions,
      });

      // Working capital (F-23). The only liquidity risk this structure carries:
      // spend goes out at application, cash comes back after the lender's wire.
      //
      // "Unrecovered" is cost booked against a file with no funded submission —
      // measured off the ledger, not modeled. The days-to-cash window comes
      // from buildCycleTimeReport, called rather than reimplemented so the two
      // surfaces cannot disagree about an interval only one of them defines.
      const { buildCycleTimeReport } = await import("../../services/cycleTimeReport");
      const cycle = await buildCycleTimeReport(WORKING_CAPITAL_WINDOW_DAYS);

      const fundedApplicationIds = new Set(
        submissions.filter(s => s.status === "funded").map(s => s.applicationId),
      );
      const unrecoveredFiles = new Set<string>();
      let unrecoveredCost = 0;
      for (const entry of costEntries) {
        if (entry.simulated) continue; // never let simulated spend size a cash need
        if (fundedApplicationIds.has(entry.applicationId)) continue;
        unrecoveredCost += Number(entry.amount) || 0;
        unrecoveredFiles.add(entry.applicationId);
      }
      const workingCapital = computeWorkingCapitalPosition({
        unrecoveredCost,
        unrecoveredFileCount: unrecoveredFiles.size,
        daysToCashMedian: cycle.daysToCash.medianDays,
        daysToCashP90: cycle.daysToCash.p90Days,
      });

      res.json({
        ...summary,
        // The binding constraint on all of the above: with no approved
        // counterparty there is no revenue capacity at all (F-5).
        approvedLenderCount: approvedLenderCount(lenderRows.map(toCounterparty)),
        discrepancies,
        revenue,
        clawbackExposure: clawback,
        costs,
        commissions,
        unitEconomics,
        workingCapital,
      });
    } catch (error) {
      console.error("Compensation report error:", error);
      res.status(500).json({ error: "Failed to build the compensation report" });
    }
  });

  // ---------------------------------------------------------------------
  // Contingent-liability register (F-13). For an asset-light broker these
  // exposures ARE the balance sheet: obligations that exist only if something
  // happens. Admin-only — company-level financial data.
  //
  // The response deliberately reports a `quantifiedFloor` plus an
  // `unquantifiedCount`, never a "total": TILA damages, the surety bond and
  // minimum net worth are real exposures with no figure here, and a number
  // that looked complete would be worse than no number.
  // ---------------------------------------------------------------------
  // Roadmap G-C: pull-through % + cycle-time days for a created-in window
  // (default 90 days, clamp 7–365). Derived from the audit trail's status
  // ledger, computed by the pure shared module. Admin-only: company-level
  // funnel metrics, not a per-file view.
  app.get("/api/reports/cycle-time", requireRole("admin"), async (req, res) => {
    try {
      const raw = parseInt(String(req.query.days ?? ""), 10);
      const days = Number.isFinite(raw) ? Math.min(365, Math.max(7, raw)) : 90;
      const { buildCycleTimeReport } = await import("../../services/cycleTimeReport");
      res.json(await buildCycleTimeReport(days));
    } catch (error) {
      console.error("Cycle-time report error:", error);
      res.status(500).json({ error: "Failed to build the cycle-time report" });
    }
  });

  app.get("/api/reports/contingent-liabilities", requireRole("admin"), async (_req, res) => {
    try {
      const { buildLiveContingentLiabilityRegister } = await import(
        "../../services/contingentLiabilityRegister"
      );
      res.json(await buildLiveContingentLiabilityRegister());
    } catch (error) {
      console.error("Contingent liability register error:", error);
      res.status(500).json({ error: "Failed to build the contingent-liability register" });
    }
  });

  // ---------------------------------------------------------------------
  // Per-file cost ledger (F-11). Vendor spend the platform does not book
  // automatically — appraisal invoices, verification services, AMC charges.
  // Append-only: a correction is a negative reversal entry, never an edit.
  // ---------------------------------------------------------------------
  app.get(
    "/api/loan-applications/:id/costs",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const { id } = routeParams(req);
        const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }
        const entries = await storage.getLoanCostEntries(id);
        const { summarizeCosts } = await import("@shared/costLedger");
        res.json({ entries, summary: summarizeCosts(entries) });
      } catch (error) {
        console.error("Loan cost ledger error:", error);
        res.status(500).json({ error: "Failed to load the cost ledger" });
      }
    },
  );

  app.post(
    "/api/loan-applications/:id/costs",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const { id } = routeParams(req);
        const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }

        const { LOAN_COST_CATEGORIES } = await import("@shared/costLedger");
        const costSchema = z.object({
          category: z.enum(LOAN_COST_CATEGORIES),
          // Negative is permitted: that is how a reversal is recorded.
          amount: z.number().finite(),
          vendor: z.string().trim().min(1).max(100).optional(),
          description: z.string().trim().max(1000).optional(),
          incurredAt: z.coerce.date().optional(),
        });
        const parsed = costSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors });
        }

        const entry = await storage.createLoanCostEntry({
          applicationId: id,
          category: parsed.data.category,
          amount: parsed.data.amount.toFixed(2),
          vendor: parsed.data.vendor ?? null,
          description: parsed.data.description ?? null,
          incurredAt: parsed.data.incurredAt ?? new Date(),
          automatic: false,
          simulated: false,
          recordedBy: req.user!.id,
        });

        // F-0807-03 — four of these categories re-price ZERO-TOLERANCE Loan
        // Estimate lines. With a baseline in place the borrower's number is
        // held, so the entry does not change what they see; it creates CURE
        // LIABILITY instead. Surface that here, where the person booking it
        // can still act, rather than in a cure report read at closing.
        // Never blocks: a real invoice is a real invoice.
        const { COST_CATEGORY_TO_DISCLOSED_FEE_ID } = await import("../../services/loanEstimate");
        const feeId = COST_CATEGORY_TO_DISCLOSED_FEE_ID[parsed.data.category];
        let disclosureImpact = null;
        if (feeId) {
          const { evaluateCostEntryDisclosureImpact } = await import(
            "../../services/leDisclosureBaseline"
          );
          // The ledger total for this category, not the single entry: a
          // supplemental invoice adds to the first, and a reversal subtracts.
          const allEntries = await storage.getLoanCostEntries(id);
          const ledgerTotal = allEntries
            .filter(e => e.category === parsed.data.category && !e.simulated)
            .reduce((sum, e) => sum + Number(e.amount || 0), 0);
          disclosureImpact = await evaluateCostEntryDisclosureImpact(id, feeId, ledgerTotal);
        }

        const { logAudit } = await import("../../auditLog");
        logAudit(req, "loan_cost.recorded", "loan_application", id, {
          costEntryId: entry.id,
          category: parsed.data.category,
          amount: parsed.data.amount,
          // The cure has a traceable cause now, rather than appearing in a
          // tolerance report with no record of what moved it.
          disclosureImpact,
        });

        res.status(201).json({ ...entry, disclosureImpact });
      } catch (error) {
        console.error("Record loan cost error:", error);
        res.status(500).json({ error: "Failed to record the cost entry" });
      }
    },
  );

  // Fannie Mae delivery readiness: URLA gating + Loan Delivery / UCD /
  // EarlyCheck edit mirror + Special Feature Code derivation. Internal staff
  // only — this is a delivery-ops view, not a partner/borrower surface.
}
