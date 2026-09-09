// Borrower routes: Consent templates + borrower consents (record/revoke/list/check).
// One registrar in the original registration order — see ./index.ts.
import type { Express } from "express";
import { type IStorage } from "../../storage";
import { isAuthenticated, requireRole } from "../../auth";
import { logAudit } from "../../auditLog";
import { type User } from "@shared/schema";
import crypto from "crypto";
import { z } from "zod";
import { firstQueryValue } from "../queryParams";
import { routeParams } from "../../http/routeParams";
import { revokeTaxDocumentConsentAndPurge } from "../../services/taxConsentWorkflow";
import { clientIpForRecord } from "../../clientIp";

// Verify that an internal staff user is actually assigned to the given application.
// Returns true for admin (unrestricted), checks LO assignment for lo/loa, and
// deal-team membership for processor/underwriter/closer.
// External partner roles (broker, lender) are NOT permitted by this helper.
// Exported: the LO-2 scenario route reuses this gate (one access model, no forks).

export function registerConsentRoutes(
  app: Express,
  storage: IStorage,
) {
  // Get consent templates
  app.get("/api/consent-templates", isAuthenticated, async (req, res) => {
    try {
      const templates = await storage.getActiveConsentTemplates(
        firstQueryValue(req.query.type),
        firstQueryValue(req.query.state)
      );
      res.json(templates);
    } catch (error) {
      console.error("Get consent templates error:", error);
      res.status(500).json({ error: "Failed to get consent templates" });
    }
  });

  // Create consent template (admin only)
  app.post("/api/consent-templates", requireRole("admin"), async (req, res) => {
    try {
      const schema = z.object({
        consentType: z.string(),
        version: z.string(),
        state: z.string().optional(),
        title: z.string(),
        shortDescription: z.string().optional(),
        fullText: z.string(),
        regulatoryReference: z.string().optional(),
        requiredForLoanTypes: z.array(z.string()).optional(),
        effectiveDate: z.string().transform(s => new Date(s)),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: "Invalid input", details: result.error.format() });
      }

      const template = await storage.createConsentTemplate({
        ...result.data,
        isActive: true,
      });

      res.status(201).json(template);
    } catch (error) {
      console.error("Create consent template error:", error);
      res.status(500).json({ error: "Failed to create consent template" });
    }
  });

  // Record borrower consent
  app.post("/api/consents", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      
      const schema = z.object({
        applicationId: z.string().optional(),
        templateId: z.string().optional(),
        consentType: z.string(),
        templateVersion: z.string().optional(),
        consentGiven: z.boolean(),
        consentMethod: z.enum(["click", "signature", "verbal", "paper"]),
        signatureData: z.string().optional(),
        signatureType: z.enum(["drawn", "typed", "none"]).optional(),
      });

      const result = schema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: "Invalid input", details: result.error.format() });
      }

      // If an applicationId is provided, verify the requesting user is the actual borrower
      // who owns that application. Staff must not be allowed to forge consent records on
      // behalf of a borrower — consent is a borrower-only action.
      if (result.data.applicationId) {
        const application = await storage.getLoanApplication(result.data.applicationId);
        if (!application || application.userId !== user.id) {
          return res.status(403).json({ error: "Access denied" });
        }
      }

      // Generate content hash for tamper evidence
      const contentHash = crypto
        .createHash("sha256")
        .update(JSON.stringify(result.data) + new Date().toISOString())
        .digest("hex");

      const consent = await storage.createBorrowerConsent({
        userId: user.id,
        ...result.data,
        ipAddress: clientIpForRecord(req) ?? undefined,
        userAgent: req.headers["user-agent"],
        contentHash,
        consentedAt: new Date(),
      });

      // Log activity if application-related
      if (result.data.applicationId) {
        await storage.createDealActivity({
          applicationId: result.data.applicationId,
          activityType: "consent_given",
          title: `Consent: ${result.data.consentType}`,
          description: `Borrower provided ${result.data.consentType} consent`,
          performedBy: user.id,
        });
      }

      res.status(201).json(consent);
    } catch (error) {
      console.error("Record consent error:", error);
      res.status(500).json({ error: "Failed to record consent" });
    }
  });

  // Revoke a consent the borrower granted for their own data. Only consent
  // types the borrower may self-revoke go through here: credit consent has a
  // dedicated staff-gated workflow (/api/credit/consent/:consentId/revoke)
  // because revoking it mid-application disrupts a regulated flow, and
  // e-disclosure withdrawal needs a paper-delivery fallback before it can be
  // honored. tax_document_use promises revocation in its template text.
  const SELF_REVOCABLE_CONSENT_TYPES = new Set(["tax_document_use"]);

  app.post("/api/consents/:consentType/revoke", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { consentType } = routeParams(req);

      if (!SELF_REVOCABLE_CONSENT_TYPES.has(consentType)) {
        return res.status(400).json({ error: "This consent type cannot be revoked from here" });
      }

      const purge = await revokeTaxDocumentConsentAndPurge(
        user.id,
        "borrower_requested",
      );
      const { revoked, ...purgeCounts } = purge;
      if (revoked.length === 0) {
        return res.status(404).json({ error: "No active consent to revoke" });
      }

      // The revocation and purge share the same borrower-scoped database lock
      // as final tax persistence. An in-flight worker therefore cannot restore
      // a derived signal after this response succeeds. Encrypted extraction
      // lineage stays on the source document for audit purposes.

      await logAudit(req, "consent.revoked", "borrower_consent", revoked[0].id, {
        consentType,
        consentsRevoked: revoked.length,
        ...purgeCounts,
      });

      res.json({ revoked: revoked.length, ...purgeCounts });
    } catch (error) {
      console.error("Revoke consent error:", error);
      res.status(500).json({ error: "Failed to revoke consent" });
    }
  });

  // Get consents for current user
  app.get("/api/consents/me", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const consents = await storage.getBorrowerConsentsByUser(user.id);
      res.json(consents);
    } catch (error) {
      console.error("Get user consents error:", error);
      res.status(500).json({ error: "Failed to get consents" });
    }
  });

  // Get consents for an application
  app.get("/api/consents/application/:applicationId", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      const consents = await storage.getBorrowerConsentsByApplication(applicationId);
      res.json(consents);
    } catch (error) {
      console.error("Get application consents error:", error);
      res.status(500).json({ error: "Failed to get consents" });
    }
  });

  // Check if specific consent exists for application
  app.get("/api/consents/check/:applicationId/:consentType", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId, consentType } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      const consent = await storage.getConsentByTypeAndApplication(consentType, applicationId);
      res.json({ hasConsent: !!consent, consent });
    } catch (error) {
      console.error("Check consent error:", error);
      res.status(500).json({ error: "Failed to check consent" });
    }
  });

  // ===== PARTNER API INTEGRATIONS =====

}
