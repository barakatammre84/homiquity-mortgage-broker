// ---------------------------------------------------------------------------
// What happens to an extraction once the model has read the document.
//
// WHY THIS IS ONE FUNCTION AND NOT TWO CALL SITES. Extraction reaches a
// document by two routes:
//
//   A. POST /api/documents/:id/extract — a STAFF action, from the review
//      workbench (DocumentReviewPanel.tsx is its only caller).
//   B. the durable job inserted by POST /api/documents/upload — what runs when
//      a BORROWER uploads a pay stub, bank statement or lease. Nothing in the
//      borrower UI triggers (A).
//
// They drifted. (A) grew the F-028 fact persistence, the F-030 readiness wiring
// and the model/prompt lineage columns; (B) kept writing field NAMES to
// `documents.notes` and nothing else. So on the only path a borrower can reach,
// the numbers the model read were discarded and the file went on asking for
// them — which is the exact gap `documentFacts.ts` says it closes.
//
// Two call sites implementing "the same" post-extraction behaviour is what let
// that happen, so the behaviour lives here and both routes call it. Anything a
// single path genuinely owns — the tax-insight derivation, task events, the
// audit row — deliberately stays in its route or durable worker.
// ---------------------------------------------------------------------------

import type { ExtractedDocumentData } from "../extractionCore";
import {
  coarseConfidenceToNumeric,
  recordExtractionConfidence,
} from "./documentConfidence";
import { DOCUMENT_STATUS } from "@shared/documentStatus";
import {
  documentProcessingBlockReason,
  withDocumentWorkflowLock,
  type DatabaseTransaction,
} from "./documentLineage";
import {
  withActiveTaxDocumentConsent,
  type TaxConsentTransaction,
} from "./taxConsentWorkflow";
import { assessDocumentClassification } from "./documentClassification";

/** The slice of IStorage this needs — keeps the unit testable without a DB. */
interface DocumentUpdater {
  updateDocument(
    id: string,
    patch: Record<string, unknown>,
    transaction?: DatabaseTransaction,
  ): Promise<unknown>;
}

export interface ApplyExtractionResult {
  humanReviewRequired: boolean;
  /** Values were withheld because the uploaded pages did not match the label. */
  classificationBlocked: boolean;
  /** Why an extraction result was discarded instead of becoming current file state. */
  skipReason: "reviewed" | "replaced" | null;
  /** Number of `extracted_fields` rows written (0 when the read was low-confidence). */
  factsPersisted: number;
  /** Readiness fields credited from the values (empty when low-confidence). */
  readinessFieldsUpdated: string[];
  /** Tax persistence lost borrower authorization before the final write. */
  authorizationRevoked: boolean;
}

export async function applyExtractionToDocument(params: {
  storage: DocumentUpdater;
  /** Owner of the document — readiness is credited to the borrower, not the actor. */
  userId: string;
  documentId: string;
  documentType: string;
  applicationId: string | null;
  fileSize?: number;
  extracted: ExtractedDocumentData;
  /** Locks and validates the durable queue claim at the write boundary. */
  beforePersist?: (transaction: DatabaseTransaction) => Promise<void>;
  /** When present, every write is serialized with tax-consent revocation. */
  taxConsentUserId?: string;
  /** Additional tax projection committed while the consent lock is held. */
  afterAuthorizedPersist?: (transaction: TaxConsentTransaction) => Promise<void>;
}): Promise<ApplyExtractionResult> {
  const {
    storage,
    userId,
    documentId,
    documentType,
    applicationId,
    fileSize,
    extracted,
    beforePersist,
    taxConsentUserId,
    afterAuthorizedPersist,
  } = params;

  return withDocumentWorkflowLock(documentId, async (currentDocument, isCurrentVersion, transaction) => {
    const skipReason = documentProcessingBlockReason(currentDocument, isCurrentVersion);
    if (skipReason) {
      return {
        humanReviewRequired: false,
        classificationBlocked: false,
        skipReason,
        factsPersisted: 0,
        readinessFieldsUpdated: [],
        authorizationRevoked: false,
      };
    }

    await beforePersist?.(transaction);

    const persist = async (): Promise<ApplyExtractionResult> => {

    const coarseConfidence = coarseConfidenceToNumeric(extracted.confidence);
    const classification = ["pay_stub", "bank_statement", "lease_agreement"].includes(documentType)
      ? assessDocumentClassification(documentType, extracted.documentClassification)
      : null;
    let classificationWarning = classification?.warning ?? null;
    if (
      classification &&
      extracted.pageCount !== undefined &&
      extracted.documentClassification?.pageCount !== extracted.pageCount
    ) {
      classificationWarning =
        "The extractor and page classifier reported different page counts; manual classification is required";
    }
    if (
      classification &&
      extracted.documentClassification &&
      Object.values(extracted.fieldEvidence ?? {}).some(
        (evidence) => evidence.pageNumber > extracted.documentClassification!.pageCount,
      )
    ) {
      classificationWarning =
        "An extracted value points outside the classified page range; manual classification is required";
    }
    const classificationBlocked = !!classification && (!classification.compatible || !!classificationWarning);
    if (classificationWarning) {
      extracted.warnings = [...new Set([...(extracted.warnings ?? []), classificationWarning])];
    }
    const fieldConfidences = (extracted.extractedFields ?? []).map((fieldName) => {
      const confidence = extracted.fieldEvidence?.[fieldName]?.confidence ?? coarseConfidence;
      return { fieldName, value: null, confidence, needsReview: confidence < 0.7 };
    });
    const observedConfidence = fieldConfidences.length > 0
      ? fieldConfidences.reduce((sum, field) => sum + field.confidence, 0) / fieldConfidences.length
      : coarseConfidence;
    const overallConfidence = classificationBlocked
      ? 0
      : Math.min(
          coarseConfidence,
          observedConfidence,
          classification?.minimumConfidence ?? 1,
        );
    const confidenceResult = await recordExtractionConfidence({
      documentId,
      documentType,
      applicationId: applicationId ?? undefined,
      overallConfidence,
      fieldConfidences,
      fileSize,
      pageCount: extracted.pageCount,
      extractionEngine: extracted.modelId ?? "claude",
      extractionVersion: extracted.promptVersion,
    }, transaction);
    const humanReviewRequired = confidenceResult.humanReviewRequired || classificationBlocked;

    await storage.updateDocument(documentId, {
      // MR-2: AI confidence never auto-verifies. "verified" is reserved for
      // POST /api/documents/:id/verify — a human on the deal team. A read that
      // clears the type's confidence threshold is staged "verifying" for that
      // human to confirm; everything else stays "uploaded".
      status: !humanReviewRequired ? DOCUMENT_STATUS.VERIFYING : DOCUMENT_STATUS.UPLOADED,
      notes: JSON.stringify({
        extractedAt: new Date().toISOString(),
        extractedFields: extracted.extractedFields,
        confidence: extracted.confidence,
        humanReviewRequired,
        warnings: extracted.warnings,
        modelId: extracted.modelId,
        promptVersion: extracted.promptVersion,
        responseHash: extracted.rawResponseHash,
        documentClassification: classification
          ? {
              pageCount: extracted.documentClassification?.pageCount ?? null,
              compatible: !classificationBlocked,
              mixedPacket: classification.mixedPacket,
              minimumConfidence: classification.minimumConfidence,
              segments: classification.segments,
            }
          : undefined,
      }),
      extractionResponseHash: extracted.rawResponseHash,
      extractionRawEncrypted: extracted.rawResponseEncrypted,
      extractionRawIv: extracted.rawResponseIv,
      extractionRawKeyId: extracted.rawResponseKeyId,
    }, transaction);

    // A low-confidence read is a guess, and a guess is not a fact: it is recorded
    // on the document (above) for a human to look at, and it feeds nothing.
    if (extracted.confidence === "low" || classificationBlocked) {
      const { clearUnverifiedDocumentFacts } = await import("./documentFacts");
      await clearUnverifiedDocumentFacts(documentId, transaction);
      return {
        humanReviewRequired,
        classificationBlocked,
        skipReason: null,
        factsPersisted: 0,
        readinessFieldsUpdated: [],
        authorizationRevoked: false,
      };
    }

    // Facts, readiness, confidence, and the document state form one database
    // unit. If any write fails, the durable job retries the entire unit rather
    // than exposing a half-updated borrower file.
    const { persistDocumentFacts } = await import("./documentFacts");
    const factsPersisted = await persistDocumentFacts(
      documentId,
      documentType,
      extracted as unknown as Record<string, any>,
      extracted.confidence,
      extracted.modelId,
      transaction,
    );

    const { wireExtractionToReadiness } = await import("./optimizationEngine");
    // Pass the extraction RESULT, not `extractedFields` — the latter is a
    // string[] of field NAMES, and handing it to a value-reading map is what
    // made every value-bearing readiness row silently skip (F-030).
    const readinessResult = await wireExtractionToReadiness(
      userId,
      documentId,
      documentType,
      extracted as unknown as Record<string, any>,
      extracted.confidence,
      transaction,
    );
    const readinessFieldsUpdated = readinessResult.fieldsUpdated;
    console.log(`[OPT-1] Readiness fields updated: ${readinessFieldsUpdated.join(", ") || "none"}`);

    return {
      humanReviewRequired,
      classificationBlocked,
      skipReason: null,
      factsPersisted,
      readinessFieldsUpdated,
      authorizationRevoked: false,
    };
    };

    if (!taxConsentUserId) return persist();

    const authorized = await withActiveTaxDocumentConsent(
      taxConsentUserId,
      async (consentTransaction) => {
        const result = await persist();
        await afterAuthorizedPersist?.(consentTransaction);
        return result;
      },
      transaction,
    );
    if (authorized.authorized) return authorized.value;
    return {
      humanReviewRequired: false,
      classificationBlocked: false,
      skipReason: null,
      factsPersisted: 0,
      readinessFieldsUpdated: [],
      authorizationRevoked: true,
    };
  });
}
