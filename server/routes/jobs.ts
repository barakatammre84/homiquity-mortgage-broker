import type { Express, Request } from "express";
import { requireRole } from "../auth";
import { runLifecycleSweep, graduateClosedLoan } from "../services/lifecycleEngine";
import { sweepUndeliveredAdverseActions } from "../services/adverseActionDelivery";
import { aggregateAnonymizedData } from "../services/optimizationEngine";
import { runRateLockAlertSweep } from "../services/rateLockAlerts";
import { runLetterExpirySweep } from "../services/letterExpiry";
import { runCreditMonitoringSweep } from "../services/creditMonitoring";
import { taskEngine } from "../services/taskEngine";
import { logAudit } from "../auditLog";
import { db } from "../db";
import { intentEvents } from "@shared/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { routeParam } from "../http/routeParams";
import { runCoreProviderCanarySweep } from "../services/coreProviderCanaries";

/**
 * Scheduled-job endpoints.
 *
 * /api/jobs/lifecycle is invoked two ways:
 * - the cron scheduler (.github/workflows/cron-jobs.yml) — authenticated with the
 *   CRON_SECRET env var, sent as "Authorization: Bearer <CRON_SECRET>".
 * - Manually by an admin session (useful locally and for on-demand runs).
 *
 * If CRON_SECRET is unset (e.g. before the env var is configured), only the
 * admin path works — the job degrades to manual rather than becoming open.
 */

function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.authorization === `Bearer ${secret}`;
}

export function registerJobRoutes(app: Express) {
  // Borrower-data-free proof that the three core provider paths can execute in
  // the deployed environment. Every capability records its own redacted row;
  // an unhealthy result returns 503 so the scheduler becomes a visible alarm.
  app.post("/api/jobs/core-provider-canaries", async (req, res) => {
    if (isCronRequest(req)) {
      try {
        const result = await runCoreProviderCanarySweep(null);
        return res.status(result.failed === 0 ? 200 : 503).json({
          ok: result.failed === 0,
          trigger: "cron",
          ...result,
        });
      } catch (err) {
        console.error("[jobs] Core provider canary sweep failed:", err);
        return res.status(500).json({ ok: false, error: "Core provider canary sweep failed" });
      }
    }
    return requireRole("admin")(req, res, async () => {
      try {
        const user = req.user as { id: string };
        const result = await runCoreProviderCanarySweep(user.id);
        await logAudit(req, "jobs.core_provider_canaries", "system", "core_provider", {
          total: result.total,
          successful: result.successful,
          failed: result.failed,
        });
        res.status(result.failed === 0 ? 200 : 503).json({
          ok: result.failed === 0,
          trigger: "manual",
          ...result,
        });
      } catch (err) {
        console.error("[jobs] Core provider canary sweep failed:", err);
        res.status(500).json({ ok: false, error: "Core provider canary sweep failed" });
      }
    });
  });

  app.get("/api/jobs/lifecycle", async (req, res, next) => {
    if (isCronRequest(req)) {
      try {
        const result = await runLifecycleSweep();
        return res.json({ ok: true, trigger: "cron", ...result });
      } catch (err) {
        console.error("[jobs] Lifecycle sweep failed:", err);
        return res.status(500).json({ ok: false, error: "Lifecycle sweep failed" });
      }
    }
    // Not a cron call — fall through to the admin-authenticated variant.
    return requireRole("admin")(req, res, async () => {
      try {
        const result = await runLifecycleSweep();
        logAudit(req, "jobs.lifecycle_sweep", "system", "lifecycle", { ...result });
        res.json({ ok: true, trigger: "manual", ...result });
      } catch (err) {
        console.error("[jobs] Lifecycle sweep failed:", err);
        res.status(500).json({ ok: false, error: "Lifecycle sweep failed" });
      }
    });
  });

  // Rate-lock expiration watchdog. Same dual-trigger shape as the lifecycle
  // sweep: the cron scheduler (CRON_SECRET) or an admin session. Notifies the assigned
  // loan officer about locks expiring within the alert window so a lock never
  // lapses unseen (one notification per lock; it lingers until read).
  app.get("/api/jobs/rate-lock-alerts", async (req, res) => {
    if (isCronRequest(req)) {
      try {
        const result = await runRateLockAlertSweep();
        return res.json({ ok: true, trigger: "cron", ...result });
      } catch (err) {
        console.error("[jobs] Rate-lock alert sweep failed:", err);
        return res.status(500).json({ ok: false, error: "Rate-lock alert sweep failed" });
      }
    }
    // Not a cron call — fall through to the admin-authenticated variant.
    return requireRole("admin")(req, res, async () => {
      try {
        const result = await runRateLockAlertSweep();
        logAudit(req, "jobs.rate_lock_alerts", "system", "rate_lock", { ...result });
        res.json({ ok: true, trigger: "manual", ...result });
      } catch (err) {
        console.error("[jobs] Rate-lock alert sweep failed:", err);
        res.status(500).json({ ok: false, error: "Rate-lock alert sweep failed" });
      }
    });
  });

  // Credit-monitoring sweep. Emits a staff task per representative-score DROP between an
  // application's two most recent completed pulls. Same dual-trigger shape as its siblings.
  //
  // Output is a STAFF TASK, never borrower outreach: this repo models no FCRA permissible
  // purpose, and a credit-triggered solicitation is prescreen/firm-offer territory. The
  // lookback window in the sweep is what makes repeated runs idempotent — emitCreditEvent
  // stamps Date.now() into its own idempotency key, so it does not dedupe.
  app.get("/api/jobs/credit-monitoring", async (req, res) => {
    if (isCronRequest(req)) {
      try {
        const result = await runCreditMonitoringSweep();
        return res.json({ ok: true, trigger: "cron", ...result });
      } catch (err) {
        console.error("[jobs] Credit monitoring sweep failed:", err);
        return res.status(500).json({ ok: false, error: "Credit monitoring sweep failed" });
      }
    }
    return requireRole("admin")(req, res, async () => {
      try {
        const result = await runCreditMonitoringSweep();
        logAudit(req, "jobs.credit_monitoring", "system", "credit_monitoring", { ...result });
        res.json({ ok: true, trigger: "manual", ...result });
      } catch (err) {
        console.error("[jobs] Credit monitoring sweep failed:", err);
        res.status(500).json({ ok: false, error: "Credit monitoring sweep failed" });
      }
    });
  });

  // Letter-expiry sweep. Same dual-trigger shape as the lifecycle sweep:
  // the cron scheduler (CRON_SECRET) or an admin session. Persists "expired" onto
  // issued letters past their expiration date so the stored row matches what
  // the read paths already compute (shared/letters.ts effectiveLetterStatus).
  app.get("/api/jobs/letter-expiry", async (req, res) => {
    if (isCronRequest(req)) {
      try {
        const result = await runLetterExpirySweep();
        return res.json({ ok: true, trigger: "cron", ...result });
      } catch (err) {
        console.error("[jobs] Letter-expiry sweep failed:", err);
        return res.status(500).json({ ok: false, error: "Letter-expiry sweep failed" });
      }
    }
    // Not a cron call — fall through to the admin-authenticated variant.
    return requireRole("admin")(req, res, async () => {
      try {
        const result = await runLetterExpirySweep();
        logAudit(req, "jobs.letter_expiry_sweep", "system", "pre_approval_letter", { ...result });
        res.json({ ok: true, trigger: "manual", ...result });
      } catch (err) {
        console.error("[jobs] Letter-expiry sweep failed:", err);
        res.status(500).json({ ok: false, error: "Letter-expiry sweep failed" });
      }
    });
  });

  // Task-engine SLA escalation sweep (roadmap CS1's scheduler leg). Same
  // dual-trigger shape: the cron scheduler (CRON_SECRET) or an admin session.
  // Escalates every active task past its slaDueAt that isn't fully escalated
  // (taskEngine.runEscalationCheck — level bump + task audit log + configured
  // escalation actions). taskEngine is the SINGLE owner of scheduled SLA
  // enforcement: optimizationEngine's checkSlaBreaches duplicate was deleted
  // outright (roadmap OPT-7) — never wire a second channel here. Daily cadence matches
  // the plan's cron granularity — an S0's 15-minute escalation window is
  // aspirational until the cron tier supports sub-daily schedules; the manual
  // admin trigger (POST /api/task-engine/run-escalation) covers on-demand runs.
  app.get("/api/jobs/task-escalation", async (req, res) => {
    if (isCronRequest(req)) {
      try {
        const escalatedCount = await taskEngine.runEscalationCheck();
        return res.json({ ok: true, trigger: "cron", escalatedCount });
      } catch (err) {
        console.error("[jobs] Task-escalation sweep failed:", err);
        return res.status(500).json({ ok: false, error: "Task-escalation sweep failed" });
      }
    }
    return requireRole("admin")(req, res, async () => {
      try {
        const escalatedCount = await taskEngine.runEscalationCheck();
        logAudit(req, "jobs.task_escalation_sweep", "system", "task", { escalatedCount });
        res.json({ ok: true, trigger: "manual", escalatedCount });
      } catch (err) {
        console.error("[jobs] Task-escalation sweep failed:", err);
        res.status(500).json({ ok: false, error: "Task-escalation sweep failed" });
      }
    });
  });

  // ECOA §1002.9 adverse-action delivery watchdog. Same dual-trigger shape as
  // the lifecycle sweep: the cron scheduler (CRON_SECRET) or an admin session. Flags
  // any generated-but-undelivered adverse-action notice approaching or past the
  // 30-day statutory delivery window and raises a staff task for it.
  app.get("/api/jobs/adverse-action-delivery", async (req, res, next) => {
    if (isCronRequest(req)) {
      try {
        const result = await sweepUndeliveredAdverseActions();
        return res.json({ ok: true, trigger: "cron", ...result });
      } catch (err) {
        console.error("[jobs] Adverse-action delivery sweep failed:", err);
        return res.status(500).json({ ok: false, error: "Adverse-action delivery sweep failed" });
      }
    }
    // Not a cron call — fall through to the admin-authenticated variant.
    return requireRole("admin")(req, res, async () => {
      try {
        const result = await sweepUndeliveredAdverseActions();
        logAudit(req, "jobs.adverse_action_delivery_sweep", "system", "adverse_action", {
          scanned: result.scanned,
          warning: result.warning,
          breach: result.breach,
          notificationsCreated: result.notificationsCreated,
        });
        res.json({ ok: true, trigger: "manual", ...result });
      } catch (err) {
        console.error("[jobs] Adverse-action delivery sweep failed:", err);
        res.status(500).json({ ok: false, error: "Adverse-action delivery sweep failed" });
      }
    });
  });

  // Anonymized cohort-data pipeline (OPT-9). Buckets borrower graphs into
  // PII-hashed aggregate facts for benchmarking — no PII, no outbound, purely
  // internal analytics. Same dual-trigger shape as the sweeps above: the cron
  // cron (CRON_SECRET) or an admin session.
  app.get("/api/jobs/aggregate-data", async (req, res) => {
    if (isCronRequest(req)) {
      try {
        const result = await aggregateAnonymizedData();
        return res.json({ ok: true, trigger: "cron", ...result });
      } catch (err) {
        console.error("[jobs] Anonymized data aggregation failed:", err);
        return res.status(500).json({ ok: false, error: "Data aggregation failed" });
      }
    }
    // Not a cron call — fall through to the admin-authenticated variant.
    return requireRole("admin")(req, res, async () => {
      try {
        const result = await aggregateAnonymizedData();
        logAudit(req, "jobs.aggregate_data", "system", "analytics", { ...result });
        res.json({ ok: true, trigger: "manual", ...result });
      } catch (err) {
        console.error("[jobs] Anonymized data aggregation failed:", err);
        res.status(500).json({ ok: false, error: "Data aggregation failed" });
      }
    });
  });

  // NOTE: the loan-officer signals feed used to live here as an UNSCOPED
  // GET /api/signals/staff (buildStaffSignals() over every active file). It was
  // removed rather than patched: GET /api/staff/signals in routes/cockpit.ts is
  // the same feed already scoped to the caller's deal-team book, so keeping a
  // second, unscoped copy behind the same requireRole list only let the two
  // drift — which is exactly what happened. One feed, scoped, is the contract.

  // Read-only scenario catalog — a projection of the implemented rules for
  // staff tooling, lender due-diligence, and duplicate-prevention when
  // generating new scenarios. NOT a rules engine: underwriting behavior
  // changes only through the registry pipeline (cited, tested code).
  app.get(
    "/api/scenarios/catalog",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (_req, res) => {
      const { SCENARIO_CATALOG } = await import("../services/scenarioCatalog");
      res.json({ scenarios: SCENARIO_CATALOG, count: SCENARIO_CATALOG.length });
    },
  );

  // Friction summary — the raw material of the continuous learning loop.
  // Aggregates server-observed friction events (blocked gates, failed
  // uploads) so the daily guardian can turn recurring walls into scenario
  // proposals or UX fixes. Proposals only — friction never changes rules.
  app.get(
    "/api/jobs/friction-summary",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const days = Math.min(Math.max(parseInt(String(req.query.days ?? "7"), 10) || 7, 1), 90);
        const since = new Date(Date.now() - days * 24 * 3600 * 1000);
        const [byPoint, recent] = await Promise.all([
          db
            .select({
              point: intentEvents.targetLabel,
              count: sql<number>`count(*)::int`,
            })
            .from(intentEvents)
            .where(and(eq(intentEvents.eventType, "friction_event"), gte(intentEvents.occurredAt, since)))
            .groupBy(intentEvents.targetLabel)
            .orderBy(desc(sql`count(*)`)),
          db
            .select({
              point: intentEvents.targetLabel,
              applicationId: intentEvents.targetId,
              metadata: intentEvents.metadata,
              occurredAt: intentEvents.occurredAt,
            })
            .from(intentEvents)
            .where(and(eq(intentEvents.eventType, "friction_event"), gte(intentEvents.occurredAt, since)))
            .orderBy(desc(intentEvents.occurredAt))
            .limit(25),
        ]);
        res.json({ windowDays: days, byPoint, recent });
      } catch (err) {
        console.error("[jobs] Friction summary failed:", err);
        res.status(500).json({ error: "Failed to build friction summary" });
      }
    },
  );

  // Backfill: graduate an already-funded loan into a homeowner profile
  // (the automatic hook only fires on NEW funded transitions).
  app.post("/api/jobs/graduate/:applicationId", requireRole("admin"), async (req, res) => {
    try {
      await graduateClosedLoan(routeParam(req, "applicationId"));
      logAudit(req, "jobs.graduate_loan", "loan_application", routeParam(req, "applicationId"));
      res.json({ ok: true });
    } catch (err) {
      console.error("[jobs] Graduation failed:", err);
      res.status(500).json({ ok: false, error: "Graduation failed" });
    }
  });
}
