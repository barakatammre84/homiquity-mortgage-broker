import { createHash } from "node:crypto";
import path from "node:path";
import PDFDocument from "pdfkit";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  documentPages,
  documentUploads,
  extractedFields,
  logicalDocumentPages,
  logicalDocuments,
  pageClassifications,
  type Document,
  type DocumentTypeTaxonomy,
} from "@shared/schema";
import type { DocumentClassification } from "../extractionCore";
import {
  fileToBase64,
  SIMULATED_MODEL_ID,
  type ExtractedDocumentData,
  type ExtractedFieldEvidence,
} from "../extractionCore";
import {
  extractBankStatementData,
  extractLeaseData,
  extractPayStubData,
  extractProfitLossData,
  extractW2Data,
} from "../extractionService";
import {
  ObjectStorageService,
  deleteLocalObject,
  isLocalFallbackEnabled,
  writeLocalDerivedObject,
} from "../integrations/object_storage";
import { db } from "../db";
import { classificationSegments } from "./documentClassification";
import { assessDocumentClassification } from "./documentClassification";
import { buildDocumentFacts } from "./documentFacts";
import { coarseConfidenceToNumeric } from "./documentConfidence";
import type { DatabaseTransaction } from "./documentLineage";
import { isTaxReturnDocumentType } from "@shared/documentTypes";

const NORMALIZED_MAX_DIMENSION = 2_200;
const PDF_RENDER_SCALE = 2;

export interface NormalizedDocumentPage {
  pageNumber: number;
  bytes: Buffer;
  width: number;
  height: number;
}

export interface DocumentPageMaterializationSummary {
  uploadId: string;
  pageCount: number;
  logicalDocumentCount: number;
  reused: boolean;
}

export interface TaxPageLinkSummary {
  logicalDocumentsLinked: number;
  fieldsLinked: number;
}

export interface PacketSegmentExtractionSummary {
  attemptedSegments: number;
  extractedSegments: number;
  factsPersisted: number;
  unsupportedTypes: string[];
}

export interface DocumentPacketPageReview {
  pageId: string;
  pageNumber: number;
  imageUrl: string;
  documentType: DocumentTypeTaxonomy;
  machineDocumentType: DocumentTypeTaxonomy;
  confidence: number;
  humanReviewed: boolean;
}

export interface DocumentPacketReview {
  documentId: string;
  pageCount: number;
  mixedPacket: boolean;
  pages: DocumentPacketPageReview[];
  segments: Array<{
    documentType: DocumentTypeTaxonomy;
    pageStart: number;
    pageEnd: number;
    confidence: number;
  }>;
}

export class DocumentPageMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentPageMaterializationError";
  }
}

type PageVisitor = (page: NormalizedDocumentPage) => Promise<void> | void;

function normalizedDimensions(width: number, height: number) {
  const ratio = Math.min(1, NORMALIZED_MAX_DIMENSION / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * Render every source page into a consistent PNG coordinate space. This is a
 * pure byte boundary: model output is never used to create pixels, so the
 * review image remains an independently rendered copy of the original page.
 */
async function visitNormalizedDocumentPages(
  bytes: Buffer,
  mimeType: string,
  visit: PageVisitor,
): Promise<number> {
  if (mimeType.startsWith("image/")) {
    const image = await loadImage(bytes);
    const size = normalizedDimensions(image.width, image.height);
    const canvas = createCanvas(size.width, size.height);
    try {
      canvas.getContext("2d").drawImage(image, 0, 0, size.width, size.height);
      await visit({
        pageNumber: 1,
        bytes: canvas.toBuffer("image/png"),
        width: size.width,
        height: size.height,
      });
    } finally {
      // @napi-rs/canvas owns native pixel memory outside V8's ordinary heap.
      // Resize immediately after persistence instead of waiting for a later GC.
      canvas.width = 0;
      canvas.height = 0;
    }
    return 1;
  }

  if (mimeType !== "application/pdf") {
    throw new DocumentPageMaterializationError(`Unsupported page source type: ${mimeType}`);
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const standardFontDataUrl =
    path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl,
  });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        PDF_RENDER_SCALE,
        NORMALIZED_MAX_DIMENSION / Math.max(base.width, base.height),
      );
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        await page.render({
          canvas: canvas as never,
          canvasContext: canvas.getContext("2d") as never,
          viewport,
        }).promise;
        const width = canvas.width;
        const height = canvas.height;
        await visit({
          pageNumber,
          bytes: canvas.toBuffer("image/png"),
          width,
          height,
        });
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  return pageCount;
}

export async function renderNormalizedDocumentPages(
  bytes: Buffer,
  mimeType: string,
): Promise<NormalizedDocumentPage[]> {
  const pages: NormalizedDocumentPage[] = [];
  await visitNormalizedDocumentPages(bytes, mimeType, (page) => {
    pages.push(page);
  });
  return pages;
}

interface MaterializedSegmentPage {
  logicalDocumentId: string;
  documentType: DocumentTypeTaxonomy;
  aggregatedConfidence: number;
  pageId: string;
  pageNumber: number;
  imageUri: string;
  width: number | null;
  height: number | null;
}

const SEGMENT_EXTRACTOR_TYPE: Partial<Record<DocumentTypeTaxonomy, string>> = {
  paystub: "pay_stub",
  w2: "w2",
  bank_statement_checking: "bank_statement",
  bank_statement_savings: "bank_statement",
  business_bank_statement: "bank_statement",
  brokerage_statement: "bank_statement",
  retirement_statement: "bank_statement",
  retirement_statement_401k: "bank_statement",
  retirement_statement_ira: "bank_statement",
  lease_agreement: "lease_agreement",
  profit_loss_statement: "profit_loss",
};

export function packetSegmentExtractorType(
  documentType: DocumentTypeTaxonomy,
): string | null {
  return SEGMENT_EXTRACTOR_TYPE[documentType] ?? null;
}

async function pagesAsPdf(pages: MaterializedSegmentPage[]): Promise<Buffer> {
  const buffers: Buffer[] = [];
  const document = new PDFDocument({ autoFirstPage: false, compress: false });
  document.on("data", (chunk: Buffer) => buffers.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(buffers)));
    document.on("error", reject);
  });
  for (const page of pages) {
    const imageBytes = Buffer.from(await fileToBase64(page.imageUri), "base64");
    const width = page.width && page.width > 0 ? page.width : 1_700;
    const height = page.height && page.height > 0 ? page.height : 2_200;
    document.addPage({ size: [width, height], margin: 0 });
    document.image(imageBytes, 0, 0, { width, height });
  }
  document.end();
  return finished;
}

async function extractSegment(
  extractorType: string,
  source: Buffer,
  detectedDocumentType: DocumentTypeTaxonomy,
): Promise<ExtractedDocumentData> {
  switch (extractorType) {
    case "pay_stub": return extractPayStubData(source, "application/pdf");
    case "w2": return extractW2Data(source, "application/pdf");
    case "bank_statement": return extractBankStatementData(source, "application/pdf", detectedDocumentType);
    case "lease_agreement": return extractLeaseData(source, "application/pdf");
    case "profit_loss": return extractProfitLossData(source, "application/pdf");
    default: throw new DocumentPageMaterializationError(`Unsupported logical document type: ${extractorType}`);
  }
}

/**
 * Route each materialized packet segment through its own specialized extractor.
 * Values remain review material on the logical document; the source upload is
 * still blocked from automatic acceptance when it was mixed or mislabeled.
 */
export async function extractMaterializedPacketSegments(input: {
  documentId: string;
  borrowerUserId: string;
  beforePersist?: (transaction: DatabaseTransaction) => Promise<void>;
}): Promise<PacketSegmentExtractionSummary> {
  const rows = await db.select({
    logicalDocumentId: logicalDocuments.id,
    documentType: logicalDocuments.documentType,
    aggregatedConfidence: logicalDocuments.aggregatedConfidence,
    pageId: documentPages.id,
    pageNumber: documentPages.pageNumber,
    imageUri: documentPages.imageUri,
    width: documentPages.width,
    height: documentPages.height,
  })
    .from(logicalDocuments)
    .innerJoin(logicalDocumentPages, eq(logicalDocumentPages.logicalDocumentId, logicalDocuments.id))
    .innerJoin(documentPages, eq(documentPages.id, logicalDocumentPages.pageId))
    .where(and(
      eq(logicalDocuments.sourceDocumentId, input.documentId),
      eq(logicalDocuments.borrowerId, input.borrowerUserId),
      ne(logicalDocuments.status, "rejected"),
    ))
    .orderBy(asc(logicalDocuments.createdAt), asc(logicalDocumentPages.pageOrder));

  const grouped = new Map<string, MaterializedSegmentPage[]>();
  for (const row of rows) {
    const page: MaterializedSegmentPage = {
      logicalDocumentId: row.logicalDocumentId,
      documentType: row.documentType as DocumentTypeTaxonomy,
      aggregatedConfidence: Number(row.aggregatedConfidence),
      pageId: row.pageId,
      pageNumber: row.pageNumber,
      imageUri: row.imageUri,
      width: row.width,
      height: row.height,
    };
    grouped.set(row.logicalDocumentId, [...(grouped.get(row.logicalDocumentId) ?? []), page]);
  }

  const unsupportedTypes = new Set<string>();
  const extractedSegments: Array<{
    logicalDocumentId: string;
    extracted: ExtractedDocumentData;
    facts: ReturnType<typeof buildDocumentFacts>;
    pageByNumber: Map<number, string>;
    overallConfidence: number;
  }> = [];
  let attemptedSegments = 0;

  for (const pages of grouped.values()) {
    const detectedType = pages[0].documentType;
    const extractorType = packetSegmentExtractorType(detectedType);
    if (!extractorType) {
      unsupportedTypes.add(pages[0].documentType);
      continue;
    }
    attemptedSegments += 1;
    const extracted = await extractSegment(extractorType, await pagesAsPdf(pages), detectedType);
    const assessment = assessDocumentClassification(detectedType, extracted.documentClassification);
    if (extracted.confidence === "low" || !assessment.compatible) continue;

    const relativeToSource = new Map(pages.map((page, index) => [index + 1, page]));
    const remappedEvidence: Record<string, ExtractedFieldEvidence> = {};
    for (const [fieldName, evidence] of Object.entries(extracted.fieldEvidence ?? {})) {
      const sourcePage = relativeToSource.get(evidence.pageNumber);
      if (sourcePage) {
        remappedEvidence[fieldName] = { ...evidence, pageNumber: sourcePage.pageNumber };
      }
    }
    const remapped = { ...extracted, fieldEvidence: remappedEvidence } as ExtractedDocumentData;
    const facts = buildDocumentFacts(extractorType, remapped as unknown as Record<string, any>);
    const fieldConfidence = facts.length > 0
      ? facts.reduce((sum, fact) => sum + (fact.confidence ?? 0), 0) / facts.length
      : coarseConfidenceToNumeric(extracted.confidence);
    extractedSegments.push({
      logicalDocumentId: pages[0].logicalDocumentId,
      extracted,
      facts,
      pageByNumber: new Map(pages.map((page) => [page.pageNumber, page.pageId])),
      overallConfidence: Math.min(pages[0].aggregatedConfidence, fieldConfidence),
    });
  }

  let factsPersisted = 0;
  await db.transaction(async (transaction) => {
    await input.beforePersist?.(transaction);
    for (const segment of extractedSegments) {
      const verifiedRows = await transaction.select({ fieldName: extractedFields.fieldName })
        .from(extractedFields)
        .where(and(
          eq(extractedFields.logicalDocumentId, segment.logicalDocumentId),
          eq(extractedFields.humanVerified, true),
        ));
      const verifiedNames = new Set(verifiedRows.map((row) => row.fieldName));
      await transaction.delete(extractedFields).where(and(
        eq(extractedFields.logicalDocumentId, segment.logicalDocumentId),
        eq(extractedFields.humanVerified, false),
      ));
      const facts = segment.facts.filter((fact) => !verifiedNames.has(fact.fieldName));
      if (facts.length > 0) {
        const insertRows: Array<typeof extractedFields.$inferInsert> = facts.map((fact) => ({
          logicalDocumentId: segment.logicalDocumentId,
          pageId: fact.pageNumber ? segment.pageByNumber.get(fact.pageNumber) ?? null : null,
          pageNumber: fact.pageNumber ?? null,
          fieldName: fact.fieldName,
          fieldCategory: fact.fieldCategory,
          valueString: fact.valueString ?? null,
          valueNumeric: fact.valueNumeric === undefined ? null : String(fact.valueNumeric),
          valueType: fact.valueType,
          confidence: String(fact.confidence ?? segment.overallConfidence),
          boundingBox: fact.boundingBox ?? null,
          extractionMethod: segment.extracted.modelId === SIMULATED_MODEL_ID ? "simulated" : "claude",
          modelVersion: segment.extracted.modelId ?? null,
        }));
        await transaction.insert(extractedFields).values(insertRows);
        factsPersisted += facts.length;
      }
      await transaction.update(logicalDocuments).set({
        aggregatedConfidence: segment.overallConfidence.toFixed(4),
        modelId: segment.extracted.modelId ?? null,
        promptVersion: segment.extracted.promptVersion ?? null,
        rawResponseHash: segment.extracted.rawResponseHash ?? null,
        rawResponseEncrypted: segment.extracted.rawResponseEncrypted ?? null,
        rawResponseIv: segment.extracted.rawResponseIv ?? null,
        rawResponseKeyId: segment.extracted.rawResponseKeyId ?? null,
        updatedAt: new Date(),
      }).where(eq(logicalDocuments.id, segment.logicalDocumentId));
    }
  });

  return {
    attemptedSegments,
    extractedSegments: extractedSegments.length,
    factsPersisted,
    unsupportedTypes: [...unsupportedTypes].sort(),
  };
}

function validateClassification(
  classification: DocumentClassification,
  renderedPageCount: number,
): void {
  const pageNumbers = classification.pages.map((page) => page.pageNumber).sort((a, b) => a - b);
  if (
    classification.pageCount !== renderedPageCount ||
    pageNumbers.length !== renderedPageCount ||
    pageNumbers.some((pageNumber, index) => pageNumber !== index + 1)
  ) {
    throw new DocumentPageMaterializationError(
      "The classified page manifest does not match the rendered source document",
    );
  }
}

async function savePage(
  page: NormalizedDocumentPage,
  borrowerUserId: string,
  objectStorage: ObjectStorageService,
): Promise<string> {
  if (isLocalFallbackEnabled()) return writeLocalDerivedObject(page.bytes);
  return objectStorage.savePrivateDerivedObject(page.bytes, "image/png", borrowerUserId);
}

async function removePage(uri: string, objectStorage: ObjectStorageService): Promise<void> {
  if (isLocalFallbackEnabled()) {
    deleteLocalObject(uri);
    return;
  }
  await objectStorage.deleteObjectEntity(uri);
}

/**
 * Materialize a live `documents` upload into immutable normalized pages,
 * page-level classifications and contiguous logical documents. Re-runs are
 * idempotent by sourceDocumentId. The original bytes remain untouched.
 */
export async function materializeDocumentPages(input: {
  document: Document;
  borrowerUserId: string;
  classification: DocumentClassification;
  modelVersion: string;
  /** Tax intelligence persists richer per-form rows itself and only needs the normalized page layer here. */
  createLogicalDocuments?: boolean;
  beforePersist?: (transaction: DatabaseTransaction) => Promise<void>;
}): Promise<DocumentPageMaterializationSummary> {
  const existing = await db.select({ id: documentUploads.id, pageCount: documentUploads.pageCount })
    .from(documentUploads)
    .where(eq(documentUploads.sourceDocumentId, input.document.id))
    .limit(1);
  if (existing[0]) {
    const logical = await db.select({ id: logicalDocuments.id })
      .from(logicalDocuments)
      .where(eq(logicalDocuments.sourceDocumentId, input.document.id));
    return {
      uploadId: existing[0].id,
      pageCount: existing[0].pageCount ?? input.classification.pageCount,
      logicalDocumentCount: logical.length,
      reused: true,
    };
  }

  const objectStorage = new ObjectStorageService();
  const storedUris: string[] = [];
  const rendered: Array<Omit<NormalizedDocumentPage, "bytes">> = [];
  try {
    const sourceBytes = Buffer.from(await fileToBase64(input.document.storagePath), "base64");
    const pageCount = await visitNormalizedDocumentPages(
      sourceBytes,
      input.document.mimeType ?? "application/octet-stream",
      async (page) => {
        storedUris.push(await savePage(page, input.borrowerUserId, objectStorage));
        rendered.push({
          pageNumber: page.pageNumber,
          width: page.width,
          height: page.height,
        });
      },
    );
    validateClassification(input.classification, pageCount);

    const persisted = await db.transaction(async (transaction) => {
      await input.beforePersist?.(transaction);
      const [already] = await transaction.select({ id: documentUploads.id, pageCount: documentUploads.pageCount })
        .from(documentUploads)
        .where(eq(documentUploads.sourceDocumentId, input.document.id))
        .for("update")
        .limit(1);
      if (already) {
        return {
          uploadId: already.id,
          pageCount: already.pageCount ?? rendered.length,
          logicalDocumentCount: 0,
          reused: true,
        };
      }

      const [upload] = await transaction.insert(documentUploads).values({
        loanId: input.document.applicationId ?? null,
        borrowerId: input.borrowerUserId,
        sourceDocumentId: input.document.id,
        originalFileName: input.document.fileName,
        mimeType: input.document.mimeType ?? "application/octet-stream",
        fileSizeBytes: input.document.fileSize ?? sourceBytes.length,
        uploadSource: "documents_bridge",
        uploadedAt: input.document.createdAt ?? new Date(),
        rawFileUri: input.document.storagePath,
        checksum: createHash("sha256").update(sourceBytes).digest("hex"),
        processingStatus: "completed",
        processingStartedAt: new Date(),
        processingCompletedAt: new Date(),
        pageCount: rendered.length,
      }).returning({ id: documentUploads.id });

      const pageRows = await transaction.insert(documentPages).values(
        rendered.map((page, index) => ({
          uploadId: upload.id,
          pageNumber: page.pageNumber,
          imageUri: storedUris[index],
          width: page.width,
          height: page.height,
          ocrEngine: "pdfjs_canvas_normalizer",
        })),
      ).returning({ id: documentPages.id, pageNumber: documentPages.pageNumber });
      const pageIdByNumber = new Map(pageRows.map((page) => [page.pageNumber, page.id]));
      const classificationByPage = new Map(
        input.classification.pages.map((classification) => [classification.pageNumber, classification]),
      );
      await transaction.insert(pageClassifications).values(pageRows.map((page) => {
        const classification = classificationByPage.get(page.pageNumber)!;
        return {
          pageId: page.id,
          documentType: classification.documentType,
          confidence: classification.confidence.toFixed(4),
          modelVersion: input.modelVersion,
          classificationMethod: "model_vision",
        };
      }));

      const segments = input.createLogicalDocuments === false
        ? []
        : classificationSegments(input.classification);
      const persistedSegments = segments.length === 0
        ? []
        : await transaction.insert(logicalDocuments).values(segments.map((segment) => ({
          loanId: input.document.applicationId ?? null,
          borrowerId: input.borrowerUserId,
          documentType: segment.documentType,
          aggregatedConfidence: segment.confidence.toFixed(4),
          status: "needs_review",
          sourceDocumentId: input.document.id,
          pageStart: segment.pageStart,
          pageEnd: segment.pageEnd,
          expectedPageCount: segment.pageEnd - segment.pageStart + 1,
          actualPageCount: segment.pageEnd - segment.pageStart + 1,
          isComplete: true,
          modelId: input.modelVersion,
        }))).returning({
          id: logicalDocuments.id,
          pageStart: logicalDocuments.pageStart,
          pageEnd: logicalDocuments.pageEnd,
        });
      const pageLinks = persistedSegments.flatMap((segment) => {
        const pageStart = segment.pageStart!;
        const pageEnd = segment.pageEnd!;
        return Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => ({
          logicalDocumentId: segment.id,
          pageId: pageIdByNumber.get(pageStart + index)!,
          pageOrder: index + 1,
        }));
      });
      if (pageLinks.length > 0) {
        await transaction.insert(logicalDocumentPages).values(pageLinks);
      }

      return {
        uploadId: upload.id,
        pageCount: rendered.length,
        logicalDocumentCount: segments.length,
        reused: false,
      };
    });

    if (persisted.reused) {
      await Promise.allSettled(storedUris.map((uri) => removePage(uri, objectStorage)));
      const logical = await db.select({ id: logicalDocuments.id })
        .from(logicalDocuments)
        .where(eq(logicalDocuments.sourceDocumentId, input.document.id));
      return { ...persisted, logicalDocumentCount: logical.length };
    }
    return persisted;
  } catch (error) {
    await Promise.allSettled(storedUris.map((uri) => removePage(uri, objectStorage)));
    throw error;
  }
}

/**
 * Attach the rich tax-form rows from one completed extraction run to the
 * normalized page layer. Safe to repeat after a queue lease expires: existing
 * page links are reused and individual field page ids are updated in place.
 */
export async function linkTaxExtractionRunToMaterializedPages(input: {
  documentId: string;
  extractionRunId: string;
  beforePersist?: (transaction: DatabaseTransaction) => Promise<void>;
}): Promise<TaxPageLinkSummary> {
  return db.transaction(async (transaction) => {
    await input.beforePersist?.(transaction);
    const pages = await transaction.select({
      id: documentPages.id,
      pageNumber: documentPages.pageNumber,
    })
      .from(documentPages)
      .innerJoin(documentUploads, eq(documentPages.uploadId, documentUploads.id))
      .where(eq(documentUploads.sourceDocumentId, input.documentId))
      .orderBy(asc(documentPages.pageNumber));
    if (pages.length === 0) {
      throw new DocumentPageMaterializationError("Normalized tax pages are not available");
    }

    const forms = await transaction.select({
      id: logicalDocuments.id,
      pageStart: logicalDocuments.pageStart,
      pageEnd: logicalDocuments.pageEnd,
    })
      .from(logicalDocuments)
      .where(and(
        eq(logicalDocuments.sourceDocumentId, input.documentId),
        eq(logicalDocuments.extractionRunId, input.extractionRunId),
        ne(logicalDocuments.status, "revoked"),
      ));
    if (forms.length === 0) return { logicalDocumentsLinked: 0, fieldsLinked: 0 };

    const formIds = forms.map((form) => form.id);
    const existing = await transaction.select({
      logicalDocumentId: logicalDocumentPages.logicalDocumentId,
      pageId: logicalDocumentPages.pageId,
    })
      .from(logicalDocumentPages)
      .where(inArray(logicalDocumentPages.logicalDocumentId, formIds));
    const linked = new Set(existing.map((row) => `${row.logicalDocumentId}:${row.pageId}`));
    const pageByNumber = new Map(pages.map((page) => [page.pageNumber, page.id]));
    let logicalDocumentsLinked = 0;

    for (const form of forms) {
      const start = form.pageStart;
      const end = form.pageEnd;
      if (!start || !end || end < start) continue;
      const formPages = pages.filter((page) => page.pageNumber >= start && page.pageNumber <= end);
      const missing = formPages.filter((page) => !linked.has(`${form.id}:${page.id}`));
      if (missing.length > 0) {
        await transaction.insert(logicalDocumentPages).values(missing.map((page) => ({
          logicalDocumentId: form.id,
          pageId: page.id,
          pageOrder: page.pageNumber - start + 1,
        })));
      }
      if (formPages.length > 0) logicalDocumentsLinked += 1;
      await transaction.update(logicalDocuments).set({
        expectedPageCount: end - start + 1,
        actualPageCount: formPages.length,
        isComplete: formPages.length === end - start + 1,
        updatedAt: new Date(),
      }).where(eq(logicalDocuments.id, form.id));
    }

    const fields = await transaction.select({
      id: extractedFields.id,
      pageNumber: extractedFields.pageNumber,
    })
      .from(extractedFields)
      .where(inArray(extractedFields.logicalDocumentId, formIds));
    let fieldsLinked = 0;
    for (const field of fields) {
      const pageId = field.pageNumber ? pageByNumber.get(field.pageNumber) : undefined;
      if (!pageId) continue;
      await transaction.update(extractedFields).set({ pageId }).where(eq(extractedFields.id, field.id));
      fieldsLinked += 1;
    }
    return { logicalDocumentsLinked, fieldsLinked };
  });
}

export async function getDocumentPacketReview(
  documentId: string,
): Promise<DocumentPacketReview | null> {
  const rows = await db.select({
    pageId: documentPages.id,
    pageNumber: documentPages.pageNumber,
    machineDocumentType: pageClassifications.documentType,
    correctedDocumentType: pageClassifications.humanCorrectedType,
    confidence: pageClassifications.confidence,
    humanReviewed: pageClassifications.humanReviewed,
  })
    .from(documentPages)
    .innerJoin(documentUploads, eq(documentPages.uploadId, documentUploads.id))
    .innerJoin(pageClassifications, eq(pageClassifications.pageId, documentPages.id))
    .where(eq(documentUploads.sourceDocumentId, documentId))
    .orderBy(asc(documentPages.pageNumber));
  if (rows.length === 0) return null;

  const pages: DocumentPacketPageReview[] = rows.map((row) => ({
    pageId: row.pageId,
    pageNumber: row.pageNumber,
    imageUrl: `/api/documents/${documentId}/pages/${row.pageNumber}/image`,
    machineDocumentType: row.machineDocumentType as DocumentTypeTaxonomy,
    documentType: (row.correctedDocumentType ?? row.machineDocumentType) as DocumentTypeTaxonomy,
    confidence: row.humanReviewed ? 1 : Number(row.confidence),
    humanReviewed: row.humanReviewed ?? false,
  }));
  const classification: DocumentClassification = {
    pageCount: pages.length,
    pages: pages.map((page) => ({
      pageNumber: page.pageNumber,
      documentType: page.documentType,
      confidence: page.confidence,
    })),
  };
  const segments = classificationSegments(classification);
  return {
    documentId,
    pageCount: pages.length,
    mixedPacket: new Set(pages.map((page) => page.documentType)).size > 1,
    pages,
    segments,
  };
}

/**
 * Apply reviewer corrections to page types and rebuild the active logical
 * boundaries. Prior machine boundaries remain as rejected history, while the
 * corrected page classifications record who changed them and when.
 */
export async function correctDocumentPacketBoundaries(input: {
  document: Document;
  borrowerUserId: string;
  reviewedByUserId: string;
  corrections: Array<{ pageNumber: number; documentType: DocumentTypeTaxonomy }>;
}): Promise<DocumentPacketReview> {
  if (isTaxReturnDocumentType(input.document.documentType)) {
    throw new DocumentPageMaterializationError(
      "Tax form boundaries carry year and entity identity; replace or reprocess the tax package instead of applying a page-type-only correction",
    );
  }
  await db.transaction(async (transaction) => {
    const [upload] = await transaction.select({ id: documentUploads.id })
      .from(documentUploads)
      .where(eq(documentUploads.sourceDocumentId, input.document.id))
      .for("update")
      .limit(1);
    if (!upload) throw new DocumentPageMaterializationError("Normalized pages are not available yet");

    const rows = await transaction.select({
      pageId: documentPages.id,
      pageNumber: documentPages.pageNumber,
      machineDocumentType: pageClassifications.documentType,
      correctedDocumentType: pageClassifications.humanCorrectedType,
      confidence: pageClassifications.confidence,
      humanReviewed: pageClassifications.humanReviewed,
    })
      .from(documentPages)
      .innerJoin(pageClassifications, eq(pageClassifications.pageId, documentPages.id))
      .where(eq(documentPages.uploadId, upload.id))
      .orderBy(asc(documentPages.pageNumber));

    const byPage = new Map(rows.map((row) => [row.pageNumber, row]));
    if (input.corrections.some((correction) => !byPage.has(correction.pageNumber))) {
      throw new DocumentPageMaterializationError("One or more corrected pages do not belong to this document");
    }
    const correctedPageNumbers = new Set<number>();
    for (const correction of input.corrections) {
      if (correctedPageNumbers.has(correction.pageNumber)) {
        throw new DocumentPageMaterializationError("Each page can be corrected only once");
      }
      correctedPageNumbers.add(correction.pageNumber);
      const row = byPage.get(correction.pageNumber)!;
      await transaction.update(pageClassifications).set({
        humanReviewed: true,
        humanCorrectedType: correction.documentType,
        reviewedByUserId: input.reviewedByUserId,
        reviewedAt: new Date(),
      }).where(eq(pageClassifications.pageId, row.pageId));
      row.correctedDocumentType = correction.documentType;
      row.humanReviewed = true;
    }

    const classification: DocumentClassification = {
      pageCount: rows.length,
      pages: rows.map((row) => ({
        pageNumber: row.pageNumber,
        documentType: (row.correctedDocumentType ?? row.machineDocumentType) as DocumentTypeTaxonomy,
        confidence: row.humanReviewed ? 1 : Number(row.confidence),
      })),
    };
    const segments = classificationSegments(classification);

    await transaction.update(logicalDocuments).set({
      status: "rejected",
      verificationNotes: "Superseded by corrected page boundaries",
      updatedAt: new Date(),
    }).where(and(
      eq(logicalDocuments.sourceDocumentId, input.document.id),
      ne(logicalDocuments.status, "rejected"),
      isNull(logicalDocuments.extractionRunId),
    ));

    for (const segment of segments) {
      const segmentPages = rows.filter(
        (page) => page.pageNumber >= segment.pageStart && page.pageNumber <= segment.pageEnd,
      );
      const [logical] = await transaction.insert(logicalDocuments).values({
        loanId: input.document.applicationId ?? null,
        borrowerId: input.borrowerUserId,
        documentType: segment.documentType,
        aggregatedConfidence: segment.confidence.toFixed(4),
        status: "needs_review",
        sourceDocumentId: input.document.id,
        pageStart: segment.pageStart,
        pageEnd: segment.pageEnd,
        expectedPageCount: segmentPages.length,
        actualPageCount: segmentPages.length,
        isComplete: true,
        modelId: "human_boundary_review",
      }).returning({ id: logicalDocuments.id });
      await transaction.insert(logicalDocumentPages).values(segmentPages.map((page, index) => ({
        logicalDocumentId: logical.id,
        pageId: page.pageId,
        pageOrder: index + 1,
      })));
    }
  });

  const review = await getDocumentPacketReview(input.document.id);
  if (!review) throw new DocumentPageMaterializationError("Corrected page review could not be loaded");
  return review;
}
