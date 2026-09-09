import type { Express } from "express";
import type { IStorage } from "../storage";
import { isAuthenticated } from "../auth";
import { hasUserConsent } from "../consentGate";
import { logAudit } from "../auditLog";
import { logFriction } from "../services/frictionLog";
import type { TaxInsight, User } from "@shared/schema";
import { getDocumentProcessingBlockReason } from "../services/documentLineage";
import {
  enqueueTaxPackageExtraction,
  kickDocumentExtractionWorker,
} from "../services/documentExtractionJobs";
import { resolveDocumentBorrowerUserId } from "../services/documentBorrower";

/**
 * Tax Return Insight — consumer-direct: the borrower processes their OWN
 * uploaded return (owner-only, no staff/admin override) because the
 * tax_document_use consent that gates it is granted by that user for their
 * own data. Output is an educational readiness signal, never a
 * prequalification (Reg N framing enforced client-side and in the consent
 * text).
 */

/** Client-facing projection — derived aggregates only, no lineage ciphertext. */
function publicInsight(insight: TaxInsight) {
  return {
    taxYear: insight.taxYear,
    documentId: insight.documentId,
    wagesW2: insight.wagesW2,
    grossIncome: insight.grossIncome,
    adjustedGrossIncome: insight.adjustedGrossIncome,
    scheduleCNetProfit: insight.scheduleCNetProfit,
    scheduleENetRental: insight.scheduleENetRental,
    rentalPropertyCount: insight.rentalPropertyCount,
    selfEmployed: insight.selfEmployed,
    dscrCandidate: insight.dscrCandidate,
    confidence: insight.confidence,
    createdAt: insight.createdAt,
    updatedAt: insight.updatedAt,
  };
}

export function registerTaxInsightRoutes(app: Express, storage: IStorage) {
  app.post("/api/tax-insights/process", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { documentId } = req.body as {
        documentId?: string;
      };

      if (!documentId || typeof documentId !== "string") {
        return res.status(400).json({ error: "Missing required field: documentId" });
      }
      const document = await storage.getDocument(documentId);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }
      const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
      if (borrowerUserId !== user.id) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      if (document.documentType !== "tax_return") {
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

      const preflightBlock = await getDocumentProcessingBlockReason(documentId);
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

      const job = await enqueueTaxPackageExtraction(documentId, user.id);
      kickDocumentExtractionWorker();
      logAudit(req, "tax_insight.queued", "document", documentId, {
        jobId: job.id,
        status: job.status,
      });
      res.status(202).json({
        documentId,
        jobId: job.id,
        status: job.status === "processing" ? "running" : job.status,
      });
    } catch (error) {
      console.error("Tax insight processing error:", error);
      res.status(500).json({ error: "Failed to process tax return" });
    }
  });

  app.get("/api/tax-insights/me", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      if (!(await hasUserConsent("tax_document_use", user.id))) {
        return res.json({ insights: [] });
      }
      const insights = await storage.getTaxInsightsByUser(user.id);
      res.json({ insights: insights.map(publicInsight) });
    } catch (error) {
      console.error("Tax insight fetch error:", error);
      res.status(500).json({ error: "Failed to load tax insights" });
    }
  });
}
