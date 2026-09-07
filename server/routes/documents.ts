import express, { type Express } from "express";
import { isAdmin } from "@shared/roles";
import type { IStorage } from "../storage";
import { isAuthenticated, requireRole } from "../auth";
import {
  extractTaxReturnData,
  extractPayStubData,
  extractBankStatementData,
  extractLeaseData,
} from "../extractionService";
import type { ExtractedDocumentData, ExtractedTaxReturnData } from "../extractionCore";
import { markHumanReviewCompleted } from "../services/documentConfidence";
import { allowedUploadTypes, bufferMatchesAllowedSignature } from "./utils";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  UPLOAD_CREATE_ONLY_HEADER,
  UPLOAD_CREATE_ONLY_VALUE,
} from "@shared/uploads";
import {
  ObjectStorageService,
  ObjectNotFoundError,
  isLocalFallbackEnabled,
  isValidObjectId,
  createLocalUpload,
  writeLocalObject,
  streamLocalObject,
} from "../integrations/object_storage";
import { type User } from "@shared/schema";
import { toStaffDocumentView } from "@shared/borrowerDocumentView";
import { DOCUMENT_STATUS } from "@shared/documentStatus";
import { logAudit } from "../auditLog";
import { sendNotificationEmail } from "../services/emailService";
import { routeParam, routeParams } from "../http/routeParams";
import {
  documentProcessingBlockReason,
  DocumentLineageError,
  getDocumentProcessingBlockReason,
  reviewCurrentDocument,
  withDocumentWorkflowLock,
} from "../services/documentLineage";

const objectStorageService = new ObjectStorageService();

// The encrypted raw model response is stored server-side only; never return the
// ciphertext/IV/key to the client. The hash and model/prompt lineage are safe.
export function publicExtraction<T extends Record<string, any>>(extractedData: T) {
  const { rawResponseEncrypted, rawResponseIv, rawResponseKeyId, ...rest } = extractedData;
  return rest;
}

/**
 * document.fileName is uploader-controlled. Quotes/control chars in a quoted
 * Content-Disposition filename can break out of the quoting or corrupt the
 * header, so strip them before echoing the name back in a download header.
 */
function safeDispositionFilename(fileName: string | null | undefined): string {
  const cleaned = (fileName ?? "download")
    .replace(/[\r\n"\\]/g, "_")
    .replace(/[\x00-\x1f\x7f]/g, "_")
    .trim();
  return cleaned || "download";
}

export function registerDocumentRoutes(
  app: Express,
  storage: IStorage,
) {
  app.post("/api/uploads/request-url", isAuthenticated, async (req, res) => {
    try {
      const { name, size, contentType } = req.body;

      if (!name) {
        return res.status(400).json({ error: "Missing required field: name" });
      }
      if (contentType && !allowedUploadTypes.includes(contentType)) {
        return res.status(400).json({ error: "Invalid file type" });
      }
      if (size && size > MAX_UPLOAD_BYTES) {
        return res.status(400).json({ error: `File too large (max ${MAX_UPLOAD_LABEL})` });
      }

      // No GCS bucket configured: in local dev, hand back a local upload target so
      // the same client flow (request-url → PUT → register → download) works without
      // cloud credentials. In PRODUCTION we refuse loudly (503, UPLOADS_UNCONFIGURED)
      // rather than silently storing on ephemeral disk — the exact "uploads vanish on
      // redeploy" bug the GCS path fixes (see .env.example: GCS_SERVICE_ACCOUNT_KEY +
      // PRIVATE_OBJECT_DIR).
      if (!objectStorageService.isConfigured()) {
        if (!isLocalFallbackEnabled()) {
          return res.status(503).json({
            // This message is what the borrower READS: friendlyApiError's
            // deliberate-503 carve-out passes an enveloped 503 through
            // verbatim, and UploadDocumentDialog renders it.
            //
            // It used to say "temporarily unavailable — please try again
            // later". Both halves were false. Object storage is unconfigured,
            // not degraded, so nothing about waiting or retrying changes the
            // outcome; a borrower could retry a pay stub indefinitely and
            // never succeed, while believing the failure was transient or
            // their fault. Say what is true and give them a route that works.
            error:
              "Document upload isn't available yet — that's a setup step on our side, not a problem with your file, and retrying won't help. Please send your documents to your loan officer directly.",
            code: "UPLOADS_UNCONFIGURED",
          });
        }
        const { uploadURL, objectPath } = createLocalUpload();
        return res.json({ uploadURL, objectPath, metadata: { name, size, contentType } });
      }

      const signedContentType = contentType || "application/octet-stream";
      const uploadURL = await objectStorageService.getObjectEntityUploadURL(signedContentType);
      const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);

      res.json({
        uploadURL,
        objectPath,
        metadata: { name, size, contentType: signedContentType },
        uploadHeaders: {
          [UPLOAD_CREATE_ONLY_HEADER]: UPLOAD_CREATE_ONLY_VALUE,
        },
      });
    } catch (error) {
      console.error("Error generating upload URL:", error);
      res.status(500).json({ error: "Failed to generate upload URL" });
    }
  });

  // Local-only upload receiver, the counterpart to createLocalUpload(). Accepts the
  // raw bytes a client would otherwise PUT to a presigned GCS URL and stores them on
  // the local filesystem. Guarded so it can never be a prod write surface: 404s in
  // production and whenever real object storage is configured.
  app.put(
    "/api/uploads/local/:objectId",
    isAuthenticated,
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    (req, res) => {
      if (!isLocalFallbackEnabled()) {
        return res.status(404).json({ error: "Not found" });
      }
      const { objectId } = routeParams(req);
      if (!isValidObjectId(objectId)) {
        return res.status(400).json({ error: "Invalid object id" });
      }
      const buf = req.body;
      if (!Buffer.isBuffer(buf) || buf.length === 0) {
        return res.status(400).json({ error: "Empty upload" });
      }
      // Same magic-byte guard the disk path enforces, so the local flow rejects
      // spoofed/unsupported content just like production's allowlist + GCS.
      if (!bufferMatchesAllowedSignature(buf)) {
        return res.status(400).json({ error: "Invalid or unsupported file content" });
      }
      try {
        writeLocalObject(objectId, buf);
        return res.status(200).json({ ok: true });
      } catch (err) {
        console.error("Local object write failed:", err);
        return res.status(500).json({ error: "Failed to store file" });
      }
    },
  );

  // Express 5 / path-to-regexp v8 removed the `:param(regex)` form; `*name` is
  // the wildcard spelling. The handler resolves the document from `req.path`,
  // so the capture itself is unused (v8 would hand it back as a segment array).
  app.get("/objects/*objectPath", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;

      // Resolve the document record that owns this storage path.
      const allDocs = await storage.getDocumentsByStoragePath(req.path);
      const matchedDoc = allDocs[0];

      if (matchedDoc) {
        const isOwner = matchedDoc.userId === user.id;
        if (!isOwner) {
          // Admins retain global access.
          if (!isAdmin(user)) {
            // All other roles (including non-admin internal staff) must be active
            // deal-team members on the application the document belongs to.
            if (!matchedDoc.applicationId) {
              return res.status(403).json({ error: "Unauthorized" });
            }
            const app = await storage.getLoanApplicationWithAccess(
              matchedDoc.applicationId, user.id, user.role
            );
            if (!app) {
              return res.status(403).json({ error: "Unauthorized" });
            }
          }
        }
      } else {
        // No document record found for this path — only admins may access.
        if (!isAdmin(user)) {
          return res.status(403).json({ error: "Unauthorized" });
        }
      }

      logAudit(req, "document.download", "document", req.path, { role: user.role });

      // Dev local fallback: when no GCS bucket is configured, stream from the local
      // store (dev only; 404 in prod so a misconfigured deploy is obvious, not lossy).
      if (!objectStorageService.isConfigured()) {
        if (!isLocalFallbackEnabled()) {
          return res.status(404).json({ error: "Object not found" });
        }
        return streamLocalObject(req.path, res);
      }

      const objectFile = await objectStorageService.getObjectEntityFile(req.path);
      await objectStorageService.downloadObject(objectFile, res);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Object not found" });
      }
      console.error("Error serving object:", error);
      return res.status(500).json({ error: "Failed to serve object" });
    }
  });

  app.get("/api/documents/:id/download", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const document = await storage.getDocument(routeParam(req, "id"));

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      // Owners always have access. Admins retain global access. All other roles
      // (including non-admin internal staff) must be active deal-team members on the
      // application the document belongs to.
      const isOwner = document.userId === user.id;
      if (!isOwner && !isAdmin(user)) {
        if (document.applicationId) {
          const assignedApp = await storage.getLoanApplicationWithAccess(
            document.applicationId, user.id, user.role
          );
          if (!assignedApp) {
            return res.status(403).json({ error: "Unauthorized" });
          }
        } else {
          return res.status(403).json({ error: "Unauthorized" });
        }
      }

      if (document.storagePath?.startsWith("/objects/")) {
        // Dev local fallback: stream from the local store when GCS is unconfigured
        // (dev only; 404 in prod).
        if (!objectStorageService.isConfigured()) {
          if (!isLocalFallbackEnabled()) {
            return res.status(404).json({ error: "File not found in storage" });
          }
          res.set("Content-Disposition", `attachment; filename="${safeDispositionFilename(document.fileName)}"`);
          return streamLocalObject(document.storagePath, res);
        }
        const objectFile = await objectStorageService.getObjectEntityFile(document.storagePath);
        // Defense in depth: even though the app-level checks above passed, the
        // object's own ACL is the second gate — so a document record that was
        // somehow pointed at another user's object still cannot be streamed.
        if (objectStorageService.isConfigured()) {
          const allowed = await objectStorageService.canAccessObjectEntity({ userId: user.id, objectFile });
          const isPrivileged = isAdmin(user);
          if (!allowed && !isPrivileged) {
            return res.status(403).json({ error: "Unauthorized" });
          }
        }
        // Force download rather than inline render so borrower-uploaded files
        // (e.g. crafted HTML/SVG/PDF) cannot execute in the browser context.
        res.set("Content-Disposition", `attachment; filename="${safeDispositionFilename(document.fileName)}"`);
        await objectStorageService.downloadObject(objectFile, res);
      } else if (document.storagePath) {
        const fs = await import("fs");
        if (fs.existsSync(document.storagePath)) {
          res.set("Content-Disposition", `attachment; filename="${safeDispositionFilename(document.fileName)}"`);
          res.set("Content-Type", document.mimeType || "application/octet-stream");
          fs.createReadStream(document.storagePath).pipe(res);
        } else {
          return res.status(404).json({ error: "File not found on disk" });
        }
      } else {
        return res.status(404).json({ error: "No storage path for document" });
      }
    } catch (error) {
      console.error("Document download error:", error);
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "File not found in storage" });
      }
      res.status(500).json({ error: "Failed to download document" });
    }
  });

  app.post("/api/documents/:id/extract", isAuthenticated, async (req, res) => {
    try {
      const { id } = routeParams(req);
      const user = req.user as User;
      const document = await storage.getDocument(id);

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      // Owner and admin as before; deal-team staff may also (re-)run
      // extraction — the same roles and deal-team check as /verify below, so
      // the review workbench can refresh values without an admin. Extraction
      // only stages (MR-2): it can never verify, so widening the trigger does
      // not widen who can bind an outcome.
      let authorized = document.userId === user.id || isAdmin(user);
      if (
        !authorized &&
        ["lo", "loa", "processor", "underwriter"].includes(user.role) &&
        document.applicationId
      ) {
        const assignedApp = await storage.getLoanApplicationWithAccess(
          document.applicationId, user.id, user.role
        );
        authorized = !!assignedApp;
      }
      if (!authorized) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const processingBlock = await getDocumentProcessingBlockReason(id);
      if (processingBlock) {
        return res.status(409).json({
          error:
            processingBlock === "replaced"
              ? "This document has been replaced. Process the current version instead."
              : "This document already has a final human review.",
          code:
            processingBlock === "replaced"
              ? "DOCUMENT_VERSION_REPLACED"
              : "DOCUMENT_ALREADY_REVIEWED",
        });
      }

      const { documentYear } = req.body;
      // Typed, not `any`: the readiness wiring below reads real fields off this
      // object, and an `any` here is exactly what hid F-030 from tsc — a map
      // indexed by field names that exist on none of these interfaces.
      let extractedData: ExtractedDocumentData;

      switch (document.documentType) {
        case "tax_return":
          extractedData = await extractTaxReturnData(document.storagePath, documentYear);
          break;
        case "pay_stub":
          extractedData = await extractPayStubData(document.storagePath);
          break;
        case "bank_statement":
          extractedData = await extractBankStatementData(document.storagePath);
          break;
        case "lease_agreement":
          extractedData = await extractLeaseData(document.storagePath);
          break;
        default:
          return res.status(400).json({ 
            error: "Document type not supported for extraction",
            supportedTypes: ["tax_return", "pay_stub", "bank_statement", "lease_agreement"]
          });
      }

      // Shared with the fire-and-forget auto-extraction inside
      // POST /api/documents/upload (the borrower's own path): status, notes +
      // lineage, document facts (F-028) and readiness wiring (F-030) all live
      // in one place so the two paths cannot drift apart again.
      const { applyExtractionToDocument } = await import("../services/extractionPersistence");
      const extractionResult = await applyExtractionToDocument({
        storage,
        userId: document.userId,
        documentId: id,
        documentType: document.documentType,
        applicationId: document.applicationId,
        fileSize: document.fileSize ?? undefined,
        extracted: extractedData,
      });
      if (extractionResult.skipReason) {
        return res.status(409).json({
          error:
            extractionResult.skipReason === "replaced"
              ? "This document was replaced while extraction was running. The result was discarded."
              : "This document was reviewed while extraction was running. The human decision was kept.",
          code:
            extractionResult.skipReason === "replaced"
              ? "DOCUMENT_VERSION_REPLACED"
              : "DOCUMENT_ALREADY_REVIEWED",
        });
      }

      if (document.documentType === "tax_return") {
        // Keep the derived tax-insight row in sync when a tax return is
        // extracted through the origination flow too (non-fatal: the insight
        // is a readiness signal, not part of the extraction contract).
        // Consent-gated exactly like POST /api/tax-insights/process: without
        // the borrower's tax_document_use authorization, extraction proceeds
        // but NO insight is derived — the DSCR staff signal and readiness
        // income feed must never exist for an unconsented borrower.
        try {
          const { hasUserConsent } = await import("../consentGate");
          if (await hasUserConsent("tax_document_use", document.userId)) {
            const { saveTaxInsightForDocument } = await import("../services/taxInsightService");
            // Safe by construction: this branch is guarded on
            // documentType === "tax_return", which is exactly the case that
            // selected extractTaxReturnData in the switch above.
            await withDocumentWorkflowLock(id, async (currentDocument, isCurrentVersion) => {
              if (documentProcessingBlockReason(currentDocument, isCurrentVersion)) return;
              await saveTaxInsightForDocument(
                document.userId,
                id,
                extractedData as ExtractedTaxReturnData,
              );
            });
          }
        } catch (insightErr) {
          console.warn("[TaxInsight] Insight derivation failed (non-fatal):", insightErr);
        }
      }

      if (document.applicationId) {
        const { taskEventEmitter } = await import("../services/taskEventEmitter");
        
        if (extractedData.confidence === "low" || (extractedData.warnings && extractedData.warnings.length > 0)) {
          // The raw extractor warnings can name the OCR vendor or be otherwise
          // technical — keep them in the logs, and give the task a plain,
          // reviewer-facing message.
          if (extractedData.warnings?.length) {
            console.warn(`[Documents] OCR warnings for ${id}:`, extractedData.warnings.join(", "));
          }
          await taskEventEmitter.emitDocumentEvent("DOCUMENT_OCR_ISSUE", {
            applicationId: document.applicationId,
            documentId: id,
            documentType: document.documentType,
            errorMessage: "Some details couldn't be read automatically and need a manual review.",
            triggeredBy: req.user!.id,
          });
        }
      }

      // Extraction reads a PII-bearing document and returns financial values —
      // record who triggered it (the other document actions already log).
      logAudit(req, "document.extract", "document", id, {
        documentType: document.documentType,
        applicationId: document.applicationId,
        confidence: extractedData.confidence,
      });

      res.json({
        documentId: id,
        documentType: document.documentType,
        ...publicExtraction(extractedData),
      });
    } catch (error) {
      console.error("Document extraction error:", error);
      
      const document = await storage.getDocument(routeParam(req, "id"));
      if (document?.applicationId) {
        const { taskEventEmitter } = await import("../services/taskEventEmitter");
        // The real error is already logged above; the task event carries a
        // plain, reviewer-facing message rather than raw exception text.
        await taskEventEmitter.emitDocumentEvent("DOCUMENT_EXTRACTION_FAILED", {
          applicationId: document.applicationId,
          documentId: routeParam(req, "id"),
          documentType: document.documentType,
          errorMessage: "We couldn't process this document automatically. Please upload a clear copy, or our team will review it.",
        });
      }
      
      res.status(500).json({ error: "Failed to extract document data" });
    }
  });

  // Human document verification — the ONLY path to status "verified". AI
  // extraction can at most advance a document to "verifying"; a staff member
  // assigned to the deal (or an admin) makes the verify/reject call.
  app.post(
    "/api/documents/:id/verify",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const user = req.user as User;
        const { id } = routeParams(req);
        const { status, reason } = req.body as { status?: string; reason?: string };

        if (status !== DOCUMENT_STATUS.VERIFIED && status !== DOCUMENT_STATUS.REJECTED) {
          return res.status(400).json({ error: 'status must be "verified" or "rejected"' });
        }
        const trimmedReason = typeof reason === "string" ? reason.trim() : "";
        if (status === DOCUMENT_STATUS.REJECTED && trimmedReason.length < 12) {
          return res.status(400).json({
            error: "Explain exactly what the borrower needs to fix (at least 12 characters)",
          });
        }
        if (trimmedReason.length > 1000) {
          return res.status(400).json({ error: "The review reason is too long" });
        }

        const review = await reviewCurrentDocument({
          actor: user,
          documentId: id,
          status,
          rejectionReason:
            status === DOCUMENT_STATUS.REJECTED ? trimmedReason : undefined,
        });
        const document = review.document;

        // Same-decision retries are successful reads of the committed verdict.
        // They must not duplicate tasks, readiness credit, audits, condition
        // changes, or borrower notifications.
        if (!review.decisionApplied) {
          return res.json(toStaffDocumentView(document));
        }

        // The upload event creates a staff-owned DOC_REVIEW task. This human
        // decision completes that task on both outcomes; a rejected document's
        // replacement will create its own review task. Without this, the
        // borrower-facing progress view says "we're reviewing" forever after
        // the chat card already says approved or rejected.
        if (document.applicationId) {
          try {
            const reviewTasks = (await storage.getTasksByApplication(document.applicationId)).filter(
              (task) =>
                task.taskTypeCode === "DOC_REVIEW" &&
                !["COMPLETED", "EXPIRED"].includes(task.status) &&
                (task.triggerMetadata as { documentId?: string } | null)?.documentId === id,
            );
            if (reviewTasks.length > 0) {
              const { taskEngine } = await import("../services/taskEngine");
              await Promise.all(
                reviewTasks.map((task) =>
                  taskEngine.updateTaskStatus(
                    task.id,
                    "COMPLETED",
                    user.id,
                    status === DOCUMENT_STATUS.VERIFIED
                      ? "Document accepted"
                      : "Document returned for correction",
                  ),
                ),
              );
            }
            const { reconcileDocumentReviewTasks } = await import("../pipelineEngine");
            await reconcileDocumentReviewTasks({
              applicationId: document.applicationId,
              documentId: id,
              status,
              reason: status === DOCUMENT_STATUS.REJECTED ? trimmedReason : undefined,
              reviewedBy: user.id,
            });
          } catch (taskErr) {
            console.warn(`[Documents] Review task synchronization failed for ${id} (non-fatal):`, taskErr);
          }
        }

        // A human confirmed this really is the document it claims to be, so the
        // presence credit granted at upload climbs from tier 3 to tier 1. Only
        // on verify: a rejection must never promote, and updateReadinessField
        // never downgrades, so a bounce simply leaves the tier-3 credit alone.
        if (status === DOCUMENT_STATUS.VERIFIED) {
          try {
            const { creditDocumentPresence } = await import("../services/optimizationEngine");
            await creditDocumentPresence(document.userId, id, document.documentType, "verified");
          } catch (readinessErr) {
            console.warn("[Readiness] presence credit on verify failed (non-fatal):", readinessErr);
          }
        }

        // Close the MR-6 accuracy loop: a verify/reject IS a completed human
        // review, so stamp the confidence row (no-op when extraction never
        // ran). Non-fatal — the human verdict must stand even if the stamp
        // fails.
        try {
          await markHumanReviewCompleted(id, user.id);
        } catch (stampErr) {
          console.warn(`[Documents] Review stamp failed for ${id} (non-fatal):`, stampErr);
        }

        logAudit(req, `document.${status}`, "document", id, {
          documentType: document.documentType,
          applicationId: document.applicationId,
          reviewedBy: user.id,
          ...(trimmedReason ? { reason: trimmedReason } : {}),
        });

        // Close the loop with the borrower: in-app notification (carries the
        // reason — it stays behind login) plus a content-free email nudge (the
        // reason is staff-typed free text and never travels over email).
        try {
          const isVerified = status === DOCUMENT_STATUS.VERIFIED;
          const documentLabel = document.documentType.replace(/_/g, " ");
          await storage.createNotification({
            userId: document.userId,
            type: isVerified ? "document_verified" : "document_rejected",
            title: isVerified ? "Document accepted" : "A document needs your attention",
            body: isVerified
              ? `${document.fileName} has been reviewed and accepted.`
              : `${document.fileName} couldn't be accepted: ${trimmedReason} Open Documents to upload a new copy.`,
            entityType: "document",
            entityId: document.id,
            status: "unread",
            metadata: { documentType: document.documentType, applicationId: document.applicationId },
          });
          const borrower = await storage.getUser(document.userId);
          if (borrower?.email) {
            sendNotificationEmail({
              type: isVerified ? "document_verified" : "document_rejected",
              recipientEmail: borrower.email,
              data: { borrowerName: borrower.firstName || "there", documentName: documentLabel },
            });
          }
        } catch (notifyErr) {
          console.error("[Documents] Review notification failed (non-fatal):", notifyErr);
        }

        // Staff-only route, but the ciphertext trio still never ships to a
        // browser — see shared/borrowerDocumentView.ts.
        res.json(toStaffDocumentView(document));
      } catch (error) {
        if (error instanceof DocumentLineageError) {
          return res.status(error.status).json({ error: error.message });
        }
        console.error("Document verify error:", error);
        res.status(500).json({ error: "Failed to update document status" });
      }
    }
  );

}
