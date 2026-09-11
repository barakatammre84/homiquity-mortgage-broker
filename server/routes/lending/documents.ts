// Lending routes: Borrower declarations + document upload/list.
// One registrar in the original registration order — see ./index.ts.
import type { Express } from "express";
import type { IStorage } from "../../storage";
import { isAuthenticated } from "../../auth";
import {
  insertBorrowerDeclarationsSchema,
  isTerminalLoanAppStatus,
  pickWorkableLoanApplication,
  type User,
} from "@shared/schema";
import { isStaffRole } from "@shared/roles";
import { toDocumentViewForRole, toDocumentViewsForRole } from "@shared/borrowerDocumentView";
import { z } from "zod";
import { allowedUploadTypes } from "../utils";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL } from "@shared/uploads";
import { DOCUMENT_STATUS } from "@shared/documentStatus";
import { logAudit } from "../../auditLog";
import * as creditService from "../../services/creditService";
import { routeParams } from "../../http/routeParams";
import {
  DocumentLineageError,
  documentProcessingBlockReason,
  registerDocumentVersion,
  registerRequestedDocumentVersion,
  withDocumentWorkflowLock,
} from "../../services/documentLineage";
import { sha256LocalObject } from "../../integrations/object_storage";
import {
  kickDocumentExtractionWorker,
  standardDocumentNeedsExtraction,
} from "../../services/documentExtractionJobs";
import { isTaxReturnDocumentType } from "@shared/documentTypes";
import { hasUserConsent } from "../../consentGate";

const declarationsValidationSchema = insertBorrowerDeclarationsSchema.partial().extend({
  applicationId: z.string().optional(),
});

// Intake validation lives in shared/schema/lending.ts (loanApplicationIntakeSchema),
// derived from the same base schema the funnel validates with client-side — the
// server rejects exactly what the client rejects, and "not_sure" credit maps to
// the named CREDIT_SCORE_UNKNOWN_DEFAULT instead of a silent clamp.

export function registerDocumentRoutes(
  app: Express,
  storage: IStorage,
  dependencies: {
    registerDocumentVersion?: typeof registerDocumentVersion;
    registerRequestedDocumentVersion?: typeof registerRequestedDocumentVersion;
    dispatchQueuedExtraction?: () => void;
  } = {},
) {
  const persistDocumentVersion = dependencies.registerDocumentVersion ?? registerDocumentVersion;
  const persistRequestedDocumentVersion =
    dependencies.registerRequestedDocumentVersion ?? registerRequestedDocumentVersion;
  const dispatchQueuedExtraction = dependencies.dispatchQueuedExtraction ??
    (dependencies.registerDocumentVersion || dependencies.registerRequestedDocumentVersion
      ? () => {}
      : kickDocumentExtractionWorker);
  app.get("/api/loan-applications/:id/declarations", isAuthenticated, async (req, res) => {
    try {
      const { id } = routeParams(req);
      // Use ownership-scoped query - authorization happens at database level
      const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role || "");
      
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      const declarations = await storage.getBorrowerDeclarations(id);
      res.json(declarations || null);
    } catch (error) {
      console.error("Get declarations error:", error);
      res.status(500).json({ error: "Failed to get declarations" });
    }
  });

  app.post("/api/loan-applications/:id/declarations", isAuthenticated, async (req, res) => {
    try {
      const { id } = routeParams(req);
      
      // Validate request body with Zod schema
      const parseResult = declarationsValidationSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid declarations data", 
          details: parseResult.error.flatten() 
        });
      }
      
      // Use ownership-scoped query - authorization happens at database level
      const application = await storage.getLoanApplicationWithAccess(id, req.user!.id, req.user!.role || "");
      
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      const data = { ...parseResult.data, applicationId: id };
      const declarations = await storage.upsertBorrowerDeclarations(data);
      
      await storage.createDealActivity({
        applicationId: id,
        activityType: "note",
        title: "Declarations Updated",
        description: "Borrower declarations have been submitted",
        performedBy: req.user!.id,
      });
      
      res.json(declarations);
    } catch (error) {
      console.error("Save declarations error:", error);
      res.status(500).json({ error: "Failed to save declarations" });
    }
  });

  // One ingestion mode, one registration path: the file goes browser → object
  // storage via a presigned URL (/api/uploads/request-url), then this endpoint
  // registers its metadata. The old multipart leg (multer → serverless disk)
  // was removed — files written to container disk vanish on redeploy (roadmap #1).
  // Every accepted upload becomes a document record — unsolicited files are
  // stamped onto the borrower's latest application instead of being lost.
  const uploadRegistrationSchema = z.object({
    objectPath: z.string().regex(/^\/objects\/[^\s]+$/, "objectPath must be a normalized /objects/ path"),
    fileName: z.string().min(1).max(255),
    fileSize: z.number().int().positive().max(MAX_UPLOAD_BYTES, `File exceeds the ${MAX_UPLOAD_LABEL} limit`),
    mimeType: z.string().refine((m) => allowedUploadTypes.includes(m), "Unsupported file type"),
    documentType: z.string().max(50).optional(),
    applicationId: z.string().optional(),
    description: z.string().max(500).optional(),
    replacesDocumentId: z.string().min(1).max(100).optional(),
    requestMessageId: z.string().min(1).max(100).optional(),
  });

  const rejectMultipart = (req: any, res: any, next: any) => {
    if (!req.is("multipart/form-data")) return next();
    return res.status(400).json({
      error:
        "Multipart uploads are not supported. Request a presigned URL from POST /api/uploads/request-url, PUT the file there, then register it here as JSON.",
    });
  };

  app.post("/api/documents/upload", isAuthenticated, rejectMultipart, async (req, res) => {
    try {
      const user = req.user as User;
      const userId = user.id;

      const parsed = uploadRegistrationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "No file uploaded",
          details: parsed.error.flatten().fieldErrors,
          acceptedTypes: allowedUploadTypes,
        });
      }
      // Object-level authorization + content verification (P0). The client
      // supplies the storage path, so before we trust it: confirm the object
      // exists, that this user owns it (not someone else's object — IDOR),
      // and that its REAL content-type/size match the allow-list rather than
      // the client-declared MIME (magic-byte parity for the JSON path).
      const { ObjectStorageService } = await import("../../integrations/object_storage/objectStorage");
      const objectStorage = new ObjectStorageService();
      const verification = await objectStorage.verifyAndClaimObject(parsed.data.objectPath, userId);
      if (verification.configured && !verification.ok) {
        return res.status(403).json({ error: verification.reason });
      }
      if (verification.configured && verification.ok) {
        if (verification.contentType && !allowedUploadTypes.includes(verification.contentType)) {
          return res.status(400).json({ error: "Unsupported file type", acceptedTypes: allowedUploadTypes });
        }
        if (verification.size !== undefined && verification.size > MAX_UPLOAD_BYTES) {
          return res.status(400).json({ error: `File exceeds the ${MAX_UPLOAD_LABEL} limit` });
        }
      } else if (process.env.NODE_ENV === "production") {
        // Storage misconfigured in prod: fail CLOSED rather than trust the
        // client's path blindly.
        return res.status(503).json({ error: "Uploads are temporarily unavailable" });
      }

      const fileMeta = {
        fileName: parsed.data.fileName,
        // Prefer storage-verified size/type when available; fall back to the
        // client values in unconfigured dev.
        fileSize:
          verification.configured && verification.ok && verification.size !== undefined
            ? verification.size
            : parsed.data.fileSize,
        mimeType:
          verification.configured && verification.ok && verification.contentType
            ? verification.contentType
            : parsed.data.mimeType,
        storagePath: parsed.data.objectPath,
      };
      const documentType = parsed.data.documentType || "other";
      const requestedApplicationId = parsed.data.applicationId;
      const description = parsed.data.description;

      if (requestedApplicationId) {
        const application = await storage.getLoanApplicationWithAccess(requestedApplicationId, userId, user.role);
        if (!application) {
          return res.status(403).json({ error: "You do not have access to this application" });
        }
        // Access is not the same question as workability: a denied/withdrawn/
        // funded file still BELONGS to the borrower, so the ownership check
        // above passes and the upload lands on a closed loan (#271, #273).
        // The client resolver refuses to select a terminal file; this is the
        // server-side half of that rule — a stale `?app=`, a replayed request
        // or a direct API call can't route documents onto a closed file.
        //
        // Staff are exempt on purpose: attaching a document to a closed file
        // (post-denial correspondence, a funded file's trailing doc) is a
        // legitimate record-keeping act, and staff choose the file explicitly.
        if (!isStaffRole(user.role) && isTerminalLoanAppStatus(application.status)) {
          return res.status(409).json({
            error:
              "This loan file is closed and no longer accepts documents. Switch to your active application, or contact your loan team.",
            applicationStatus: application.status,
          });
        }
      }

      // Never let an unsolicited borrower upload float free of the loan file:
      // default to the file the borrower is actually working on. NOT
      // `apps[0]` — that list is newest-first with no status filter, so the
      // newest entry is routinely a denied/withdrawn/funded one while an older
      // file is still in flight (the ban in pickWorkableLoanApplication's
      // docblock). When nothing is workable the document stays unattached,
      // which is recoverable; stamping it onto a closed file is not.
      let applicationId = requestedApplicationId || null;
      if (!applicationId && !isStaffRole(user.role)) {
        const apps = await storage.getLoanApplicationsByUser(userId);
        applicationId = pickWorkableLoanApplication(apps)?.id ?? null;
      }

      // Decide the background workflow before registration so the document and
      // its extraction job commit atomically. The worker re-checks Autopilot's
      // kill switch at execution time as a second safety boundary.
      let autopilotEnabled = false;
      if (applicationId) {
        const { getAutopilotConfig, isAutopilotEnabled } = await import("../../services/autopilot/config");
        if ((await getAutopilotConfig()).enabled) {
          const appForGate = await storage.getLoanApplication(applicationId);
          autopilotEnabled = await isAutopilotEnabled(appForGate?.loanOfficerId);
        }
      }
      // A mortgage borrower uploads tax returns from the ordinary Documents
      // page, not the renter-only TaxReturnInsightCard. Once the borrower has
      // authorized tax-document use, register the durable tax job in the same
      // transaction as the document so there is no acknowledged-but-idle file.
      // Without consent, keep the source file and report the exact next step;
      // granting consent backfills the current unprocessed return(s).
      const isTaxReturn = isTaxReturnDocumentType(documentType);
      const taxAnalysisAuthorized = isTaxReturn
        ? await hasUserConsent("tax_document_use", userId)
        : false;
      const extractionMode = isTaxReturn
        ? taxAnalysisAuthorized
          ? "tax_package" as const
          : null
        : autopilotEnabled
          ? "autopilot" as const
          : standardDocumentNeedsExtraction(documentType)
            ? "standard" as const
            : null;

      // Soft duplicate detection (same name + size for this borrower). Never
      // blocks — the response carries the hint so the UI can surface it.
      const existingDocs = await storage.getDocumentsByUser(userId);
      const similar = existingDocs.find(
        (d) => d.fileName === fileMeta.fileName && d.fileSize === fileMeta.fileSize,
      );

      // Hash the bytes after the server has verified the stored object. GCS is
      // fail-closed in production; local integration fixtures that register a
      // synthetic path retain a null fingerprint, while the real local PUT
      // flow records the same SHA-256 used in production.
      const contentSha256 = verification.configured && verification.ok
        ? await objectStorage.sha256ObjectEntity(fileMeta.storagePath)
        : sha256LocalObject(fileMeta.storagePath);
      const registrationInput = {
        actor: { id: userId, role: user.role },
        contentSha256,
        replacesDocumentId: parsed.data.replacesDocumentId,
        ...(extractionMode
          ? { extractionJob: { mode: extractionMode, requestedByUserId: userId } }
          : {}),
        document: {
          userId,
          applicationId,
          documentType,
          fileName: fileMeta.fileName,
          fileSize: fileMeta.fileSize,
          mimeType: fileMeta.mimeType,
          storagePath: fileMeta.storagePath,
          status: DOCUMENT_STATUS.UPLOADED,
          // Borrower free text goes to its OWN column. It used to land in
          // `notes`, which borrowerGraph and the coach parse as trusted
          // extraction output — so a borrower could type JSON and have it read
          // back as document-verified fact (F-027). `notes` is now written only
          // by the extraction routes.
          borrowerDescription: description || null,
        },
      };
      const { document } = parsed.data.requestMessageId
        ? await persistRequestedDocumentVersion({
            ...registrationInput,
            requestMessageId: parsed.data.requestMessageId,
          })
        : await persistDocumentVersion(registrationInput);

      // Handing over the document IS the completion of "we need your W-2".
      // Credited at tier 3 (the borrower's assertion about what they attached);
      // extraction and staff verification upgrade it from there. Non-fatal —
      // a readiness signal must never fail an upload.
      try {
        const { creditDocumentPresence } = await import("../../services/optimizationEngine");
        await creditDocumentPresence(userId, document.id, documentType, "uploaded");
      } catch (readinessErr) {
        console.warn("[Readiness] presence credit on upload failed (non-fatal):", readinessErr);
      }

      logAudit(req, "document.uploaded", "document", document.id, {
        applicationId,
        documentType,
        fileName: fileMeta.fileName,
        duplicateOf: similar?.id ?? null,
        replacesDocumentId: parsed.data.replacesDocumentId ?? null,
      });

      if (applicationId) {
        await storage.createDealActivity({
          applicationId,
          activityType: "document_uploaded",
          title: "Document Uploaded",
          description: `${fileMeta.fileName} has been uploaded.`,
          performedBy: userId,
        });

        // Keep task creation and condition matching in the same serialized
        // workflow as review. If a reviewer already returned the document (or
        // a replacement won), delayed upload fan-out must not resurrect work
        // or mark rejected evidence as submitted.
        await withDocumentWorkflowLock(
          document.id,
          async (currentDocument, isCurrentVersion) => {
            if (documentProcessingBlockReason(currentDocument, isCurrentVersion)) return;

            const { taskEventEmitter } = await import("../../services/taskEventEmitter");
            if (parsed.data.replacesDocumentId) {
              const { expireSupersededDocumentReviewTasks } = await import("../../pipelineEngine");
              await expireSupersededDocumentReviewTasks({
                applicationId,
                replacedDocumentId: parsed.data.replacesDocumentId,
                replacedByUserId: userId,
              });
            }
            await taskEventEmitter.emitDocumentEvent("DOCUMENT_UPLOADED", {
              applicationId,
              documentId: document.id,
              documentType,
              triggeredBy: userId,
            });

            // Zero-touch: one upload advances both borrower-facing records.
            // Conditions wait for staff clearance; the matching upload task
            // moves to in-progress and points at this exact document.
            try {
              const {
                advanceMatchingDocumentTasks,
                matchUploadedDocumentToConditions,
              } = await import("../../pipelineEngine");
              await advanceMatchingDocumentTasks({
                applicationId,
                documentId: document.id,
                documentType,
                replacesDocumentId: parsed.data.replacesDocumentId,
              });
              await matchUploadedDocumentToConditions({
                applicationId,
                documentType,
                fileName: fileMeta.fileName,
                uploadedBy: userId,
              });
            } catch (matchErr) {
              console.error("[Documents] Workflow matching failed (non-fatal):", matchErr);
            }
          },
        );
      }

      // The durable worker claims the job with a database lease. Kicking it is
      // only a latency optimization: startup recovery and the polling loop will
      // resume the same row after a restart even if this process stops here.
      if (extractionMode) dispatchQueuedExtraction();

      res.status(201).json({
        ...toDocumentViewForRole(document, user.role),
        taxAnalysis: isTaxReturn
          ? { status: taxAnalysisAuthorized ? "queued" : "authorization_required" }
          : undefined,
        similarDocument: similar
          ? { id: similar.id, fileName: similar.fileName, uploadedAt: similar.createdAt }
          : null,
      });
    } catch (error) {
      if (error instanceof DocumentLineageError) {
        return res.status(error.status).json({ error: error.message });
      }
      console.error("Document upload error:", error);
      try {
        const { logFriction } = await import("../../services/frictionLog");
        logFriction("document_upload_failed", {
          userId: req.user?.id,
          applicationId: typeof req.body?.applicationId === "string" ? req.body.applicationId : undefined,
          detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        });
      } catch {}
      res.status(500).json({ error: "Failed to upload document" });
    }
  });

  app.get("/api/documents", isAuthenticated, async (req, res) => {
    try {
      const userId = req.user!.id;
      const documents = await storage.getDocumentsByUser(userId);
      res.json(toDocumentViewsForRole(documents, (req.user as User).role));
    } catch (error) {
      console.error("Get documents error:", error);
      res.status(500).json({ error: "Failed to get documents" });
    }
  });

}
