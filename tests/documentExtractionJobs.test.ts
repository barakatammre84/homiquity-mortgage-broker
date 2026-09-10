import { describe, expect, it } from "vitest";
import {
  classifyTaxPackageFailure,
  failureFromUnknown,
  jobBelongsToWorkerLane,
  nextFailureTransition,
  retryDelayMs,
  standardDocumentNeedsExtraction,
} from "../server/services/documentExtractionJobs";
import {
  classifyExtractionResult,
  hasActionableExtractionWarning,
} from "../server/services/documentExtractionOutcome";
import { CoreExtractionRestartProofError } from "../server/services/coreExtractionRestartProof";

describe("durable document extraction job policy", () => {
  it("queues the borrower document types with a supported extractor", () => {
    expect(standardDocumentNeedsExtraction("pay_stub")).toBe(true);
    expect(standardDocumentNeedsExtraction("w2")).toBe(true);
    expect(standardDocumentNeedsExtraction("bank_statement")).toBe(true);
    expect(standardDocumentNeedsExtraction("lease_agreement")).toBe(true);
    expect(standardDocumentNeedsExtraction("government_id")).toBe(false);
  });

  it("keeps long tax packages off the ordinary borrower-document lane", () => {
    expect(jobBelongsToWorkerLane("standard", "ordinary")).toBe(true);
    expect(jobBelongsToWorkerLane("autopilot", "ordinary")).toBe(true);
    expect(jobBelongsToWorkerLane("tax_package", "ordinary")).toBe(false);
    expect(jobBelongsToWorkerLane("tax_package", "tax_package")).toBe(true);
    expect(jobBelongsToWorkerLane("standard", "tax_package")).toBe(false);
  });

  it("retries provider or storage failures but not missing configuration", () => {
    expect(classifyExtractionResult({
      warnings: ["Failed to extract data from pay stub"],
    })).toEqual({ code: "provider_or_storage_failure", retryable: true });
    expect(classifyExtractionResult({
      warnings: ["Anthropic API not configured"],
    })).toEqual({ code: "provider_not_configured", retryable: false });
  });

  it("treats a valid low-confidence read as review work instead of retry work", () => {
    expect(classifyExtractionResult({
      warnings: ["Tax return response could not be validated; manual review required"],
    })).toBeNull();
  });

  it("does not turn a simulation label into a false OCR-quality task", () => {
    expect(hasActionableExtractionWarning([
      "Simulated extraction - EXTRACTION_SIMULATE is enabled; values are demonstration data",
    ])).toBe(false);
    expect(hasActionableExtractionWarning([
      "Simulated extraction - demonstration data",
      "Page 2 is partially obscured",
    ])).toBe(true);
  });

  it("backs off bounded retries and moves the final attempt to failed", () => {
    const now = new Date("2026-09-08T12:00:00.000Z");
    const retryable = { code: "provider_or_storage_failure", retryable: true };
    const first = nextFailureTransition({
      attemptCount: 1,
      maxAttempts: 3,
      failure: retryable,
      now,
    });
    expect(first.status).toBe("pending");
    expect(first.availableAt.getTime() - now.getTime()).toBe(30_000);
    expect(first.completedAt).toBeNull();

    const final = nextFailureTransition({
      attemptCount: 3,
      maxAttempts: 3,
      failure: retryable,
      now,
    });
    expect(final.status).toBe("failed");
    expect(final.completedAt).toEqual(now);
    expect(retryDelayMs(99)).toBe(15 * 60 * 1000);
  });

  it("fails permanent configuration errors without wasting more model calls", () => {
    const now = new Date("2026-09-08T12:00:00.000Z");
    expect(nextFailureTransition({
      attemptCount: 1,
      maxAttempts: 3,
      failure: { code: "provider_not_configured", retryable: false },
      now,
    })).toEqual({ status: "failed", availableAt: now, completedAt: now });
    expect(failureFromUnknown(
      new Error("EXTRACTION_SIMULATE cannot be enabled in production"),
    )).toEqual({
      code: "invalid_production_extraction_configuration",
      retryable: false,
    });
    expect(failureFromUnknown(
      new CoreExtractionRestartProofError("invariant_failed"),
    )).toEqual({
      code: "core_restart_invariant_failed",
      retryable: false,
    });
  });

  it("retries transient tax package calls but stops on configuration and schema failures", () => {
    expect(classifyTaxPackageFailure("Tax document classification call failed")).toEqual({
      code: "tax_package_processing_failed",
      retryable: true,
    });
    expect(classifyTaxPackageFailure("Anthropic API not configured")).toEqual({
      code: "provider_not_configured",
      retryable: false,
    });
    expect(classifyTaxPackageFailure(
      "EXTRACTION_SIMULATE cannot be enabled in production",
    )).toEqual({
      code: "invalid_production_extraction_configuration",
      retryable: false,
    });
    expect(classifyTaxPackageFailure("Model response could not be validated")).toEqual({
      code: "tax_package_validation_failed",
      retryable: false,
    });
    expect(classifyTaxPackageFailure(
      "Model output failed schema validation - values discarded, manual review required",
    )).toEqual({
      code: "tax_package_validation_failed",
      retryable: false,
    });
    expect(classifyTaxPackageFailure(
      "Tax document classification returned 100 pages for a 98-page source",
    )).toEqual({
      code: "tax_package_validation_failed",
      retryable: false,
    });
    expect(classifyTaxPackageFailure(
      "Tax form excerpt is 24.0 MB; split the source packet before provider extraction",
    )).toEqual({
      code: "tax_package_validation_failed",
      retryable: false,
    });
  });
});
