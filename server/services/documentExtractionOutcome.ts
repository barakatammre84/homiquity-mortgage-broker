import type { ExtractedDocumentData } from "../extractionCore";

export interface ExtractionFailure {
  code: string;
  retryable: boolean;
}

export function hasActionableExtractionWarning(
  warnings: string[] | undefined,
): boolean {
  return (warnings ?? []).some((warning) => !/^Simulated extraction\b/i.test(warning));
}

/**
 * Extractors intentionally degrade malformed model output to a low-confidence
 * result. Provider/configuration failures use narrower warnings so the durable
 * queue can retry transient failures without repeatedly billing for documents
 * that merely need human review.
 */
export function classifyExtractionResult(
  extracted: Pick<ExtractedDocumentData, "warnings">,
): ExtractionFailure | null {
  const warnings = extracted.warnings ?? [];
  if (warnings.some((warning) => /API not configured|no Anthropic credentials/i.test(warning))) {
    return { code: "provider_not_configured", retryable: false };
  }
  if (warnings.some((warning) => /^Failed to extract data from /i.test(warning))) {
    return { code: "provider_or_storage_failure", retryable: true };
  }
  return null;
}
