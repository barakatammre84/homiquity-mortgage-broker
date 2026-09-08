import type { Express } from "express";
import { isAdmin } from "@shared/roles";
import { isAuthenticated, requireRole } from "../auth";
import type { User } from "@shared/schema";
import { storage } from "../storage";
import {
  emitEvent,
  getEventCounts,
  getRecentEvents,
  getAutomationMetrics,
  getDomainInsights,
  emitBorrowerAction,
} from "../services/analyticsEventPipeline";
import {
  getConversionFunnel,
  getEstimateAccuracy,
  getOutcomesBySegment,
  refreshAnonymizedInsights,
} from "../services/outcomeTracker";
import {
  getAccuracyByDocType,
  getExtractionAccuracyReport,
  getPendingReviews,
  getConfidenceTrend,
  recordHumanReview,
} from "../services/documentConfidence";
import {
  computePrediction,
  getBorrowerBenchmark,
} from "../services/predictiveEngine";
import type { AnalyticsDomain } from "@shared/schema";
import { firstQueryValue } from "./queryParams";
import { routeParam, routeParams } from "../http/routeParams";
import { getCoreCapabilityReport } from "../services/coreCapabilityStatus";

export function registerDataIntelligenceRoutes(app: Express) {

  app.get("/api/analytics/core-capabilities",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    (_req, res) => {
      res.json(getCoreCapabilityReport());
    }
  );

  app.post("/api/analytics/event", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { domain, eventName, ...rest } = req.body;
      await emitBorrowerAction(user.id, eventName, rest.applicationId, rest.payload);
      res.json({ success: true });
    } catch (error) {
      console.error("Track analytics event error:", error);
      res.status(500).json({ error: "Failed to track event" });
    }
  });

  app.get("/api/analytics/automation-metrics",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const daysBack = parseInt(firstQueryValue(req.query.days) ?? "") || 30;
        const metrics = await getAutomationMetrics(daysBack);
        res.json(metrics);
      } catch (error) {
        console.error("Automation metrics error:", error);
        res.status(500).json({ error: "Failed to fetch automation metrics" });
      }
    }
  );

  app.get("/api/analytics/domain/:domain",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const domain = routeParam(req, "domain") as AnalyticsDomain;
        const daysBack = parseInt(firstQueryValue(req.query.days) ?? "") || 30;
        const insights = await getDomainInsights(domain, daysBack);
        res.json(insights);
      } catch (error) {
        console.error("Domain insights error:", error);
        res.status(500).json({ error: "Failed to fetch domain insights" });
      }
    }
  );

  app.get("/api/analytics/events",
    requireRole("admin"),
    async (req, res) => {
      try {
        const applicationId = firstQueryValue(req.query.applicationId);
        const userId = firstQueryValue(req.query.userId);
        const limit = firstQueryValue(req.query.limit);
        const daysBack = firstQueryValue(req.query.daysBack);
        const events = await getRecentEvents({
          domain: firstQueryValue(req.query.domain) as AnalyticsDomain | undefined,
          applicationId,
          userId,
          limit: limit ? parseInt(limit) : 50,
          daysBack: daysBack ? parseInt(daysBack) : 30,
        });
        res.json(events);
      } catch (error) {
        console.error("Recent events error:", error);
        res.status(500).json({ error: "Failed to fetch events" });
      }
    }
  );

  app.get("/api/outcomes/funnel",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const daysBack = parseInt(firstQueryValue(req.query.days) ?? "") || 90;
        const funnel = await getConversionFunnel(daysBack);
        res.json(funnel);
      } catch (error) {
        console.error("Conversion funnel error:", error);
        res.status(500).json({ error: "Failed to fetch conversion funnel" });
      }
    }
  );

  app.get("/api/outcomes/accuracy",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const daysBack = parseInt(firstQueryValue(req.query.days) ?? "") || 90;
        const accuracy = await getEstimateAccuracy(daysBack);
        res.json(accuracy);
      } catch (error) {
        console.error("Estimate accuracy error:", error);
        res.status(500).json({ error: "Failed to fetch estimate accuracy" });
      }
    }
  );

  app.get("/api/outcomes/segments/:field",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const field = routeParam(req, "field") as "creditScoreBucket" | "loanPurpose" | "productType" | "propertyState";
        const daysBack = parseInt(firstQueryValue(req.query.days) ?? "") || 90;
        const segments = await getOutcomesBySegment(field, daysBack);
        res.json(segments);
      } catch (error) {
        console.error("Outcome segments error:", error);
        res.status(500).json({ error: "Failed to fetch outcome segments" });
      }
    }
  );

  app.post("/api/outcomes/refresh-insights",
    requireRole("admin"),
    async (req, res) => {
      try {
        await refreshAnonymizedInsights();
        res.json({ success: true });
      } catch (error) {
        console.error("Refresh insights error:", error);
        res.status(500).json({ error: "Failed to refresh insights" });
      }
    }
  );

  app.get("/api/documents/confidence/accuracy",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const daysBack = parseInt(firstQueryValue(req.query.days) ?? "") || 90;
        const accuracy = await getAccuracyByDocType(daysBack);
        res.json(accuracy);
      } catch (error) {
        console.error("Doc accuracy error:", error);
        res.status(500).json({ error: "Failed to fetch document accuracy" });
      }
    }
  );

  // MR-6: extraction-accuracy report with model-drift alerts (flags doc types
  // whose human-verified accuracy has fallen below target).
  app.get("/api/documents/confidence/accuracy-report",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const daysBack = parseInt(firstQueryValue(req.query.days) ?? "") || 30;
        const minReviews = parseInt(firstQueryValue(req.query.minReviews) ?? "") || 10;
        const report = await getExtractionAccuracyReport(daysBack, minReviews);
        res.json(report);
      } catch (error) {
        console.error("Extraction accuracy report error:", error);
        res.status(500).json({ error: "Failed to build extraction accuracy report" });
      }
    }
  );

  app.get("/api/documents/confidence/pending-reviews",
    requireRole("admin"),
    async (req, res) => {
      try {
        const reviews = await getPendingReviews();
        res.json(reviews);
      } catch (error) {
        console.error("Pending reviews error:", error);
        res.status(500).json({ error: "Failed to fetch pending reviews" });
      }
    }
  );

  app.get("/api/documents/confidence/trend/:docType",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const daysBack = parseInt(firstQueryValue(req.query.days) ?? "") || 90;
        const trend = await getConfidenceTrend(routeParam(req, "docType"), daysBack);
        res.json(trend);
      } catch (error) {
        console.error("Confidence trend error:", error);
        res.status(500).json({ error: "Failed to fetch confidence trend" });
      }
    }
  );

  app.post("/api/documents/confidence/:documentId/review",
    requireRole("admin"),
    async (req, res) => {
      try {
        const user = req.user as User;
        const { documentId } = routeParams(req);
        const { fieldsCorrect, fieldsCorrected, fieldsMissed } = req.body;
        await recordHumanReview(documentId, user.id, {
          fieldsCorrect: fieldsCorrect || 0,
          fieldsCorrected: fieldsCorrected || 0,
          fieldsMissed: fieldsMissed || 0,
        });
        res.json({ success: true });
      } catch (error) {
        console.error("Record review error:", error);
        res.status(500).json({ error: "Failed to record review" });
      }
    }
  );

  app.get("/api/predictions/me", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const applicationId = firstQueryValue(req.query.applicationId);
      const prediction = await computePrediction(user.id, applicationId);
      res.json(prediction);
    } catch (error) {
      console.error("Prediction error:", error);
      res.status(500).json({ error: "Failed to compute prediction" });
    }
  });

  app.get("/api/predictions/benchmark", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const benchmark = await getBorrowerBenchmark(user.id);
      res.json(benchmark);
    } catch (error) {
      console.error("Benchmark error:", error);
      res.status(500).json({ error: "Failed to fetch benchmark" });
    }
  });

  app.get("/api/predictions/staff/:userId",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const caller = req.user as User;
        const { userId } = routeParams(req);
        const applicationId = firstQueryValue(req.query.applicationId);

        if (!isAdmin(caller)) {
          // Non-admin staff must supply an applicationId and must be an active
          // deal-team member on that specific application. getLoanApplicationWithAccess
          // grants internal staff global access, so we need a direct deal-team query
          // here to enforce per-file assignment even for internal staff roles.
          if (!applicationId) {
            return res.status(403).json({ error: "An applicationId is required for non-admin staff predictions" });
          }

          const teamMembers = await storage.getDealTeamMembers(applicationId);
          const isMember = teamMembers.some(m => m.userId === caller.id);
          if (!isMember) {
            return res.status(403).json({ error: "Access denied" });
          }

          // Confirm the target borrower actually owns this application.
          const application = await storage.getLoanApplication(applicationId);
          if (!application || application.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
          }
        }

        const prediction = await computePrediction(userId, applicationId);
        res.json(prediction);
      } catch (error) {
        console.error("Staff prediction error:", error);
        res.status(500).json({ error: "Failed to compute prediction" });
      }
    }
  );

  app.get("/api/intelligence/platform-health",
    requireRole("admin"),
    async (req, res) => {
      try {
        const daysBack = parseInt(firstQueryValue(req.query.days) ?? "") || 30;
        const [automation, funnel, docAccuracy, accuracy] = await Promise.all([
          getAutomationMetrics(daysBack),
          getConversionFunnel(daysBack),
          getAccuracyByDocType(daysBack),
          getEstimateAccuracy(daysBack),
        ]);

        res.json({
          automation,
          funnel,
          documentIntelligence: {
            documentTypes: docAccuracy,
            totalExtractions: docAccuracy.reduce((sum, d) => sum + d.totalExtractions, 0),
            avgConfidence: docAccuracy.length > 0
              ? docAccuracy.reduce((sum, d) => sum + d.avgConfidence, 0) / docAccuracy.length
              : null,
            pendingReviews: docAccuracy.reduce((sum, d) => sum + d.needsReviewCount, 0),
          },
          estimateAccuracy: accuracy,
        });
      } catch (error) {
        console.error("Platform health error:", error);
        res.status(500).json({ error: "Failed to fetch platform health" });
      }
    }
  );
}
