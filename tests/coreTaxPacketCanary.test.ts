import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRACTION_MODEL_TAX_PACKAGE } from "../server/extractionCore";
import {
  buildSyntheticTaxPacketPdf,
  SYNTHETIC_TAX_PACKET_PAGE_COUNT,
} from "../server/services/coreCanaryFixtures";
import {
  CORE_TAX_PACKET_CANARY_DOCUMENT_ID,
  CORE_TAX_PACKET_CANARY_JOB_ID,
  CORE_TAX_PACKET_CANARY_USER_ID,
  CoreTaxPacketCanaryError,
  assertCoreTaxPacketCanaryExpectedCommit,
  isCoreTaxPacketCanaryJob,
  type CoreTaxPacketCanarySnapshot,
  validateCoreTaxPacketCanarySnapshot,
} from "../server/services/coreTaxPacketCanary";
import { TaxPacketExcerptSession } from "../server/services/taxPacketExcerpt";

const validSnapshot = (): CoreTaxPacketCanarySnapshot => ({
  jobStatus: "completed",
  attemptCount: 1,
  lastErrorCode: null,
  documentStatus: "uploaded",
  runRows: 1,
  completedRunRows: 1,
  failedRunRows: 0,
  pageCount: 100,
  formCount: 4,
  modelId: EXTRACTION_MODEL_TAX_PACKAGE,
  simulated: false,
  overallConfidence: 0.91,
  classificationHash: "a".repeat(64),
  logicalDocumentRows: 4,
  distinctFormTypes: 4,
  lineageRows: 4,
  overlapRows: 0,
  maxFormPages: 2,
  factRows: 24,
  exactFactRows: 8,
  groundedFactRows: 24,
  uploadRows: 1,
  materializedPageRows: 100,
  pageClassificationRows: 100,
  logicalPageRows: 8,
});

describe("core 100-page tax packet canary", () => {
  it("binds the release proof to the exact deployed commit", () => {
    const originalCommit = process.env.RAILWAY_GIT_COMMIT_SHA;
    const originalDeployment = process.env.RAILWAY_DEPLOYMENT_ID;
    process.env.RAILWAY_GIT_COMMIT_SHA = "a".repeat(40);
    process.env.RAILWAY_DEPLOYMENT_ID = "tax-canary-test-deployment";
    try {
      expect(() => assertCoreTaxPacketCanaryExpectedCommit("A".repeat(40))).not.toThrow();
      expect(() => assertCoreTaxPacketCanaryExpectedCommit("b".repeat(40)))
        .toThrowError("release_mismatch");
      expect(() => assertCoreTaxPacketCanaryExpectedCommit("not-a-commit"))
        .toThrowError("release_mismatch");
    } finally {
      if (originalCommit === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
      else process.env.RAILWAY_GIT_COMMIT_SHA = originalCommit;
      if (originalDeployment === undefined) delete process.env.RAILWAY_DEPLOYMENT_ID;
      else process.env.RAILWAY_DEPLOYMENT_ID = originalDeployment;
    }
  });

  it("builds a bounded 100-page borrower-free PDF", async () => {
    const bytes = await buildSyntheticTaxPacketPdf();
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
    const packet = await TaxPacketExcerptSession.open(bytes, "application/pdf");
    try {
      expect(packet.pageCount).toBe(SYNTHETIC_TAX_PACKET_PAGE_COUNT);
    } finally {
      await packet.close();
    }
  });

  it("recognizes only the complete fixed durable-job identity", () => {
    expect(isCoreTaxPacketCanaryJob({
      id: CORE_TAX_PACKET_CANARY_JOB_ID,
      documentId: CORE_TAX_PACKET_CANARY_DOCUMENT_ID,
      requestedByUserId: CORE_TAX_PACKET_CANARY_USER_ID,
      mode: "tax_package",
    })).toBe(true);
    expect(isCoreTaxPacketCanaryJob({
      id: CORE_TAX_PACKET_CANARY_JOB_ID,
      documentId: CORE_TAX_PACKET_CANARY_DOCUMENT_ID,
      requestedByUserId: CORE_TAX_PACKET_CANARY_USER_ID,
      mode: "standard",
    })).toBe(false);
  });

  it("requires the complete provider, exact-value, and evidence proof", () => {
    expect(() => validateCoreTaxPacketCanarySnapshot(validSnapshot())).not.toThrow();
    for (const broken of [
      { simulated: true },
      { pageCount: 99 },
      { formCount: 3 },
      { exactFactRows: 7 },
      { overlapRows: 1 },
      { maxFormPages: 26 },
      { groundedFactRows: 23 },
      { materializedPageRows: 99 },
      { pageClassificationRows: 99 },
      { lineageRows: 3 },
    ]) {
      expect(() => validateCoreTaxPacketCanarySnapshot({
        ...validSnapshot(),
        ...broken,
      })).toThrowError(CoreTaxPacketCanaryError);
    }
  });

  it("keeps the large operational proof out of both borrower worker lanes", async () => {
    const source = await readFile(
      join(__dirname, "../server/services/documentExtractionJobs.ts"),
      "utf8",
    );
    const ordinaryClaim = source.slice(
      source.indexOf("async function claimNextJob"),
      source.indexOf("async function expireExhaustedLeases"),
    );
    expect(ordinaryClaim).toContain("ne(documentExtractionJobs.id, CORE_TAX_PACKET_CANARY_JOB_ID)");
    expect(source).toContain('claimNextJob(new Date(), "tax_canary", "tax_package")');
    expect(source).toContain("kickCoreTaxPacketCanaryWorker");
  });
});
