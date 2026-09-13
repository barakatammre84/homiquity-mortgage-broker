import express, { type Express } from "express";
import { isAdmin } from "@shared/roles";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { IStorage } from "../storage";
import { isAuthenticated, requireRole } from "../auth";
import {
  extractTaxReturnData,
  extractPayStubData,
  extractW2Data,
  extractBankStatementData,
  extractLeaseData,
  extractProfitLossData,
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
import {
  DOCUMENT_TYPE_TAXONOMY,
  documentPages,
  documentUploads,
  type Document,
  type User,
} from "@shared/schema";
import { db } from "../db";
import { toStaffDocumentView } from "@shared/borrowerDocumentView";
import { canReviewDocuments, DOCUMENT_STATUS } from "@shared/documentStatus";
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
import { hasUserConsent } from "../consentGate";
import { resolveDocumentBorrowerUserId } from "../services/documentBorrower";
import { saveTaxInsightForDocumentInTransaction } from "../services/taxInsightService";
import {
  getDocumentFieldReview,
  reviewDocumentFields,
} from "../services/documentFieldReview";
import { withActiveTaxDocumentConsent } from "../services/taxConsentWorkflow";
import { hasActionableExtractionWarning } from "../services/documentExtractionOutcome";
import {
  extractionDocumentType,
  isTaxReturnDocumentType,
} from "@shared/documentTypes";

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

async function hasActiveDocumentTeamAccess(
  user: User,
  document: Document,
  storage: IStorage,
): Promise<boolean> {
  if (isAdmin(user)) return true;
  if (!document.applicationId) return false;
  const members = await storage.getDealTeamMembers(document.applicationId);
  return members.some((member) => member.userId === user.id);
}

const fieldReviewSchema = z.object({
  decisions: z.array(z.object({
    fieldId: z.string().min(1),
    action: z.enum(["confirm", "correct"]),
    correctedValue: z.string().trim().min(1).max(500).optional(),
  }).superRefine((decision, context) => {
    if (decision.action === "correct" && !decision.correctedValue) {
      context.addIssue({ code: "custom", message: "A corrected value is required" });
    }
  })).max(200).default([]),
  missingFields: z.array(z.object({
    fieldName: z.string().trim().min(1).max(100),
    fieldCategory: z.enum(["income", "asset", "identity", "property"]),
    valueType: z.enum(["currency", "number", "string", "date", "boolean"]),
    correctedValue: z.string().trim().min(1).max(500),
    pageNumber: z.number().int().min(1).max(1000).optional(),
  })).max(50).default([]),
}).strict().superRefine((value, context) => {
  const ids = value.decisions.map((decision) => decision.fieldId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Each field can be reviewed only once" });
  }
  if (value.decisions.length + value.missingFields.length === 0) {
    context.addIssue({ code: "custom", message: "Review at least one field" });
  }
});

const pageBoundaryCorrectionSchema = z.object({
  corrections: z.array(z.object({
    pageNumber: z.number().int().min(1).max(1000),
    documentType: z.enum(DOCUMENT_TYPE_TAXONOMY),
  }).strict()).min(1).max(1000),
}).strict();

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

      const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
      const isOwner = borrowerUserId === user.id;
      if (
        isTaxReturnDocumentType(document.documentType) &&
        !isOwner &&
        !(await hasUserConsent("tax_document_use", borrowerUserId))
      ) {
        return res.status(403).json({
          error: "Tax document authorization is no longer active",
        });
      }

      // Owners always have access. Admins retain global access. All other roles
      // (including non-admin internal staff) must be active deal-team members on the
      // application the document belongs to.
      if (!isOwner && !(await hasActiveDocumentTeamAccess(user, document, storage))) {
        return res.status(403).json({ error: "Unauthorized" });
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

  app.get("/api/documents/:id/pages", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const document = await storage.getDocument(routeParam(req, "id"));
      if (!document) return res.status(404).json({ error: "Document not found" });
      const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
      if (
        borrowerUserId !== user.id &&
        !(await hasActiveDocumentTeamAccess(user, document, storage))
      ) return res.status(403).json({ error: "Unauthorized" });
      if (
        isTaxReturnDocumentType(document.documentType) &&
        borrowerUserId !== user.id &&
        !(await hasUserConsent("tax_document_use", borrowerUserId))
      ) return res.status(403).json({ error: "Tax document authorization is no longer active" });

      const { getDocumentPacketReview } = await import("../services/documentPageMaterialization");
      const packet = await getDocumentPacketReview(document.id);
      if (!packet) return res.status(404).json({ error: "Normalized pages are not available yet" });
      res.json(packet);
    } catch (error) {
      console.error("Document page manifest error:", error);
      res.status(500).json({ error: "Failed to load normalized document pages" });
    }
  });

  app.get("/api/documents/:id/pages/:pageNumber/image", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const document = await storage.getDocument(routeParam(req, "id"));
      if (!document) return res.status(404).json({ error: "Document not found" });
      const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
      if (
        borrowerUserId !== user.id &&
        !(await hasActiveDocumentTeamAccess(user, document, storage))
      ) return res.status(403).json({ error: "Unauthorized" });
      if (
        isTaxReturnDocumentType(document.documentType) &&
        borrowerUserId !== user.id &&
        !(await hasUserConsent("tax_document_use", borrowerUserId))
      ) return res.status(403).json({ error: "Tax document authorization is no longer active" });

      const pageNumber = Number(routeParam(req, "pageNumber"));
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 1000) {
        return res.status(400).json({ error: "Invalid page number" });
      }
      const [page] = await db.select({ imageUri: documentPages.imageUri })
        .from(documentPages)
        .innerJoin(documentUploads, eq(documentPages.uploadId, documentUploads.id))
        .where(and(
          eq(documentUploads.sourceDocumentId, document.id),
          eq(documentPages.pageNumber, pageNumber),
        ))
        .limit(1);
      if (!page) return res.status(404).json({ error: "Normalized page not found" });

      res.set("Content-Type", "image/png");
      res.set("Content-Disposition", `inline; filename="page-${pageNumber}.png"`);
      if (isLocalFallbackEnabled()) return streamLocalObject(page.imageUri, res);
      const objectFile = await objectStorageService.getObjectEntityFile(page.imageUri);
      await objectStorageService.downloadObject(objectFile, res, 3600);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return res.status(404).json({ error: "Normalized page not found" });
      }
      console.error("Document page image error:", error);
      res.status(500).json({ error: "Failed to load normalized document page" });
    }
  });

  app.patch(
    "/api/documents/:id/pages/classification",
    requireRole("admin", "lo", "loa", "processor", "underwriter"),
    async (req, res) => {
      try {
        const user = req.user as User;
        const document = await storage.getDocument(routeParam(req, "id"));
        if (!document) return res.status(404).json({ error: "Document not found" });
        if (!(await hasActiveDocumentTeamAccess(user, document, storage))) {
          return res.status(403).json({ error: "Unauthorized" });
        }
        const parsed = pageBoundaryCorrectionSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid page corrections",
            details: parsed.error.flatten().fieldErrors,
          });
        }
        const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
        if (
          isTaxReturnDocumentType(document.documentType) &&
          !(await hasUserConsent("tax_document_use", borrowerUserId))
        ) return res.status(403).json({ error: "Tax document authorization is no longer active" });

        const {
          correctDocumentPacketBoundaries,
          extractMaterializedPacketSegments,
        } = await import("../services/documentPageMaterialization");
        const packet = await correctDocumentPacketBoundaries({
          document,
          borrowerUserId,
          reviewedByUserId: user.id,
          corrections: parsed.data.corrections,
        });
        const extraction = await extractMaterializedPacketSegments({
          documentId: document.id,
          borrowerUserId,
        });
        logAudit(req, "document.page_classification_corrected", "document", document.id, {
          applicationId: document.applicationId,
          correctedPages: parsed.data.corrections.map((correction) => correction.pageNumber),
        });
        res.json({ ...packet, extraction });
      } catch (error) {
        console.error("Document page correction error:", error);
        res.status(500).json({ error: "Failed to save page corrections" });
      }
    },
  );

  app.post("/api/documents/:id/extract", isAuthenticated, async (req, res) => {
    try {
      const { id } = routeParams(req);
      const user = req.user as User;
      const document = await storage.getDocument(id);

      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }

      const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
      if (isTaxReturnDocumentType(document.documentType) && borrowerUserId !== user.id) {
        return res.status(403).json({
          error: "Only the borrower can authorize tax-return processing",
        });
      }

      // Owner and admin as before; deal-team staff may also (re-)run
      // extraction — the same roles and deal-team check as /verify below, so
      // the review workbench can refresh values without an admin. Extraction
      // only stages (MR-2): it can never verify, so widening the trigger does
      // not widen who can bind an outcome.
      let authorized = borrowerUserId === user.id || isAdmin(user);
      if (
        !authorized &&
        ["lo", "loa", "processor", "underwriter"].includes(user.role) &&
        document.applicationId
      ) {
        authorized = await hasActiveDocumentTeamAccess(user, document, storage);
      }
      if (!authorized) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      if (
        isTaxReturnDocumentType(document.documentType) &&
        !(await hasUserConsent("tax_document_use", borrowerUserId))
      ) {
        return res.status(403).json({
          error: "Please review and accept the tax document authorization first.",
          code: "CONSENT_REQUIRED",
          consentType: "tax_document_use",
        });
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

      const extractorType = extractionDocumentType(document.documentType);
      switch (extractorType) {
        case "tax_return":
          extractedData = await extractTaxReturnData(
            document.storagePath,
            documentYear,
            document.mimeType ?? undefined,
          );
          break;
        case "pay_stub":
          extractedData = await extractPayStubData(document.storagePath, document.mimeType ?? undefined);
          break;
        case "w2":
          extractedData = await extractW2Data(document.storagePath, document.mimeType ?? undefined);
          break;
        case "bank_statement":
          extractedData = await extractBankStatementData(
            document.storagePath,
            document.mimeType ?? undefined,
            document.documentType,
          );
          break;
        case "lease_agreement":
          extractedData = await extractLeaseData(document.storagePath, document.mimeType ?? undefined);
          break;
        case "profit_loss":
          extractedData = await extractProfitLossData(document.storagePath, document.mimeType ?? undefined);
          break;
        default:
          return res.status(400).json({ 
            error: "Document type not supported for extraction",
            supportedTypes: ["tax_return", "pay_stub", "w2", "bank_statement", "lease_agreement", "profit_loss"]
          });
      }

      if (extractedData.documentClassification) {
        const { materializeDocumentPages } = await import("../services/documentPageMaterialization");
        await materializeDocumentPages({
          document,
          borrowerUserId,
          classification: extractedData.documentClassification,
          modelVersion: extractedData.modelId ?? "unknown_extraction_model",
        });
      }

      // Shared with the fire-and-forget auto-extraction inside
      // POST /api/documents/upload (the borrower's own path): status, notes +
      // lineage, document facts (F-028) and readiness wiring (F-030) all live
      // in one place so the two paths cannot drift apart again.
      const { applyExtractionToDocument } = await import("../services/extractionPersistence");
      const extractionResult = await applyExtractionToDocument({
        storage,
        userId: borrowerUserId,
        documentId: id,
        documentType: document.documentType,
        applicationId: document.applicationId,
        fileSize: document.fileSize ?? undefined,
        extracted: extractedData,
        taxConsentUserId:
          isTaxReturnDocumentType(document.documentType) ? borrowerUserId : undefined,
        afterAuthorizedPersist:
          isTaxReturnDocumentType(document.documentType)
            ? (transaction) => saveTaxInsightForDocumentInTransaction(
                transaction,
                borrowerUserId,
                id,
                extractedData as ExtractedTaxReturnData,
              ).then(() => undefined)
            : undefined,
      });
      if (extractionResult.authorizationRevoked) {
        return res.status(403).json({
          error: "Tax document authorization was revoked before results could be filed",
          code: "CONSENT_REQUIRED",
          consentType: "tax_document_use",
        });
      }
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

      let packetExtraction = null;
      if (extractionResult.classificationBlocked) {
        const { extractMaterializedPacketSegments } = await import("../services/documentPageMaterialization");
        packetExtraction = await extractMaterializedPacketSegments({
          documentId: document.id,
          borrowerUserId,
        });
      }

      if (document.applicationId) {
        const { taskEventEmitter } = await import("../services/taskEventEmitter");
        
        if (extractedData.confidence === "low" || hasActionableExtractionWarning(extractedData.warnings)) {
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
        classificationBlocked: extractionResult.classificationBlocked,
        packetExtraction,
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

  app.get("/api/documents/:id/extracted-fields", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const document = await storage.getDocument(routeParam(req, "id"));
      if (!document) return res.status(404).json({ error: "Document not found" });
      if (
        !canReviewDocuments(user.role) ||
        !(await hasActiveDocumentTeamAccess(user, document, storage))
      ) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
      if (
        isTaxReturnDocumentType(document.documentType) &&
        !(await hasUserConsent("tax_document_use", borrowerUserId))
      ) {
        return res.status(403).json({ error: "Tax document authorization is no longer active" });
      }

      const fields = await getDocumentFieldReview(document.id);
      logAudit(req, "document.extracted_fields_viewed", "document", document.id, {
        applicationId: document.applicationId,
        fieldCount: fields.length,
      });
      res.json({ documentId: document.id, fields });
    } catch (error) {
      console.error("Document field review fetch error:", error);
      res.status(500).json({ error: "Failed to load extracted fields" });
    }
  });

  app.post("/api/documents/:id/extracted-fields/review", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const document = await storage.getDocument(routeParam(req, "id"));
      if (!document) return res.status(404).json({ error: "Document not found" });
      if (
        !canReviewDocuments(user.role) ||
        !(await hasActiveDocumentTeamAccess(user, document, storage))
      ) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      const parsed = fieldReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid field review", details: parsed.error.flatten() });
      }
      const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);
      const counts = await withDocumentWorkflowLock(
        document.id,
        async (currentDocument, isCurrentVersion, transaction) => {
          const block = documentProcessingBlockReason(currentDocument, isCurrentVersion);
          if (block) {
            throw new DocumentLineageError(
              block === "replaced"
                ? "Review the current document version instead"
                : "This document already has a final review",
              409,
            );
          }
          const write = () => reviewDocumentFields({
            documentId: document.id,
            reviewedBy: user.id,
            decisions: parsed.data.decisions,
            missingFields: parsed.data.missingFields,
          }, transaction);
          if (!isTaxReturnDocumentType(document.documentType)) return write();
          const authorized = await withActiveTaxDocumentConsent(
            borrowerUserId,
            write,
            transaction,
          );
          if (!authorized.authorized) {
            throw new DocumentLineageError(
              "Tax document authorization is no longer active",
              403,
            );
          }
          return authorized.value;
        },
      );

      logAudit(req, "document.extracted_fields_reviewed", "document", document.id, {
        applicationId: document.applicationId,
        ...counts,
      });
      res.json({ documentId: document.id, ...counts });
    } catch (error) {
      if (error instanceof DocumentLineageError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Document field review error:", error);
      res.status(500).json({ error: "Failed to record field review" });
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
        const borrowerUserId = await resolveDocumentBorrowerUserId(document, storage);

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
            await creditDocumentPresence(borrowerUserId, id, document.documentType, "verified");
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
            userId: borrowerUserId,
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
          const borrower = await storage.getUser(borrowerUserId);
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
