import type {
  DocumentClassification,
  DocumentPageClassification,
} from "../extractionCore";

export interface DocumentClassificationSegment {
  documentType: DocumentPageClassification["documentType"];
  pageStart: number;
  pageEnd: number;
  confidence: number;
}

const COMPATIBLE_PAGE_TYPES: Record<string, ReadonlySet<string>> = {
  pay_stub: new Set(["paystub"]),
  bank_statement: new Set(["bank_statement_checking", "bank_statement_savings"]),
  lease_agreement: new Set(["lease_agreement"]),
};

export function classificationSegments(
  classification: DocumentClassification,
): DocumentClassificationSegment[] {
  const ordered = [...classification.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const segments: DocumentClassificationSegment[] = [];
  for (const page of ordered) {
    const prior = segments.at(-1);
    if (prior && prior.documentType === page.documentType && prior.pageEnd + 1 === page.pageNumber) {
      const pageCount = prior.pageEnd - prior.pageStart + 1;
      prior.confidence = (prior.confidence * pageCount + page.confidence) / (pageCount + 1);
      prior.pageEnd = page.pageNumber;
      continue;
    }
    segments.push({
      documentType: page.documentType,
      pageStart: page.pageNumber,
      pageEnd: page.pageNumber,
      confidence: page.confidence,
    });
  }
  return segments;
}

export interface DocumentClassificationAssessment {
  compatible: boolean;
  mixedPacket: boolean;
  minimumConfidence: number;
  segments: DocumentClassificationSegment[];
  warning: string | null;
}

/**
 * Decide whether extracted values may enter the evidence graph. A selected
 * upload type is only a routing hint. Every page must independently agree with
 * that type at reviewable confidence before its fields can be credited.
 */
export function assessDocumentClassification(
  declaredDocumentType: string,
  classification: DocumentClassification | undefined,
): DocumentClassificationAssessment {
  if (!classification || classification.pages.length === 0) {
    return {
      compatible: false,
      mixedPacket: false,
      minimumConfidence: 0,
      segments: [],
      warning: "Document type could not be confirmed from the uploaded pages; manual classification is required",
    };
  }

  const segments = classificationSegments(classification);
  const minimumConfidence = Math.min(...classification.pages.map((page) => page.confidence));
  const acceptedTypes = COMPATIBLE_PAGE_TYPES[declaredDocumentType] ?? new Set<string>();
  const incompatibleSegments = segments.filter((segment) => !acceptedTypes.has(segment.documentType));
  const mixedPacket = new Set(classification.pages.map((page) => page.documentType)).size > 1;

  if (minimumConfidence < 0.75) {
    return {
      compatible: false,
      mixedPacket,
      minimumConfidence,
      segments,
      warning: "One or more pages could not be classified confidently; manual classification is required",
    };
  }
  if (mixedPacket) {
    const detected = [...new Set(segments.map((segment) => segment.documentType))]
      .map((type) => type.replace(/_/g, " "))
      .join(", ");
    return {
      compatible: false,
      mixedPacket: true,
      minimumConfidence,
      segments,
      warning: `This upload contains multiple document types (${detected}); split or classify the packet before using its values`,
    };
  }
  if (incompatibleSegments.length > 0) {
    const detected = [...new Set(incompatibleSegments.map((segment) => segment.documentType))]
      .map((type) => type.replace(/_/g, " "))
      .join(", ");
    return {
      compatible: false,
      mixedPacket,
      minimumConfidence,
      segments,
      warning: `The uploaded pages appear to be ${detected}, not ${declaredDocumentType.replace(/_/g, " ")}; confirm the document type before using its values`,
    };
  }

  return { compatible: true, mixedPacket, minimumConfidence, segments, warning: null };
}
