import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DocumentExtractionJob } from "@shared/schema";
import type { ClassifiedFormInstance, TaxFormType } from "@shared/taxFormExtraction";
import { EXTRACTION_MODEL_TAX_PACKAGE } from "../server/extractionCore";
import {
  CORE_TAX_PACKET_RESTART_DOCUMENT_ID,
  CORE_TAX_PACKET_RESTART_JOB_ID,
  CORE_TAX_PACKET_RESTART_USER_ID,
  CoreTaxPacketRestartProofError,
  isCoreTaxPacketRestartJob,
  validateCoreTaxPacketProviderRead,
  validateCoreTaxPacketRestartTransition,
  type CoreTaxPacketProviderRead,
} from "../server/services/coreTaxPacketRestartProof";
import {
  validateTaxPacketEvidenceSnapshot,
  type CoreTaxPacketEvidenceSnapshot,
} from "../server/services/coreTaxPacketProofShared";

const commit = "a".repeat(40);
const seededAt = "2026-09-10T14:00:00.000Z";
const providerReadyAt = "2026-09-10T14:01:20.000Z";
const completedAt = "2026-09-10T14:03:10.000Z";

function job(overrides: Partial<DocumentExtractionJob> = {}): DocumentExtractionJob {
  return {
    id: CORE_TAX_PACKET_RESTART_JOB_ID,
    documentId: CORE_TAX_PACKET_RESTART_DOCUMENT_ID,
    requestedByUserId: CORE_TAX_PACKET_RESTART_USER_ID,
    mode: "tax_package",
    status: "processing",
    attemptCount: 1,
    maxAttempts: 2,
    availableAt: new Date(seededAt),
    claimedAt: new Date(seededAt),
    leaseExpiresAt: new Date("2026-09-10T14:00:30.000Z"),
    claimedBy: "worker-a",
    lastErrorCode: null,
    lastErrorAt: null,
    completedAt: null,
    createdAt: new Date(seededAt),
    updatedAt: new Date(seededAt),
    ...overrides,
  };
}

const forms: ClassifiedFormInstance[] = [
  { formType: "tax_return_1040", taxYear: 2025, pageStart: 1, pageEnd: 2, confidence: 0.99 },
  { formType: "schedule_c", taxYear: 2025, pageStart: 26, pageEnd: 27, confidence: 0.99 },
  { formType: "schedule_e", taxYear: 2025, pageStart: 51, pageEnd: 52, confidence: 0.99 },
  { formType: "business_tax_return_1120s", taxYear: 2025, pageStart: 76, pageEnd: 77, confidence: 0.99 },
];

const expected: Record<TaxFormType, Record<string, number>> = {
  tax_return_1040: { wagesSalariesTips: 84_000, adjustedGrossIncome: 103_500 },
  schedule_c: { grossReceipts: 48_000, netProfitOrLoss: 30_000 },
  schedule_e: { rentsReceivedTotal: 36_000, netRentalRealEstateIncomeOrLoss: 14_400 },
  business_tax_return_1120s: { grossReceipts: 210_000, ordinaryBusinessIncomeOrLoss: 42_000 },
  schedule_1: {}, schedule_b: {}, schedule_d: {}, schedule_k1: {}, business_tax_return_1065: {},
  business_tax_return_1120: {}, form_8825: {}, form_4562: {}, w2: {}, "1099_nec": {}, "1099_misc": {},
};

function providerRead(): CoreTaxPacketProviderRead {
  return {
    classification: { pageCount: 100, forms, warnings: [] },
    instances: forms,
    classificationLineage: {
      modelId: EXTRACTION_MODEL_TAX_PACKAGE,
      promptVersion: "tax/v1",
      rawResponseHash: "b".repeat(64),
    },
    simulated: false,
    extractions: forms.map((form, index) => ({
      taxYear: 2025,
      entityName: null,
      fields: Object.fromEntries(Object.entries(expected[form.formType]).map(([name, value]) => [
        name,
        { value, confidence: 0.98, pageNumber: form.pageStart ?? index + 1 },
      ])),
      warnings: [],
      lineage: {
        modelId: EXTRACTION_MODEL_TAX_PACKAGE,
        promptVersion: "tax/v1",
        rawResponseHash: String(index + 1).repeat(64),
      },
      simulated: false,
    })),
  };
}

function snapshot(overrides: Partial<CoreTaxPacketEvidenceSnapshot> = {}): CoreTaxPacketEvidenceSnapshot {
  return {
    jobStatus: "completed",
    attemptCount: 2,
    claimedBy: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    documentStatus: "verifying",
    runRows: 2,
    completedRunRows: 1,
    failedRunRows: 1,
    pageCount: 100,
    formCount: 4,
    modelId: EXTRACTION_MODEL_TAX_PACKAGE,
    simulated: false,
    overallConfidence: 0.92,
    classificationHash: "c".repeat(64),
    logicalDocumentRows: 4,
    distinctFormTypes: 4,
    lineageRows: 4,
    overlapRows: 0,
    maxFormPages: 2,
    factRows: 28,
    exactFactRows: 8,
    groundedFactRows: 28,
    uploadRows: 1,
    materializedPageRows: 100,
    pageClassificationRows: 100,
    logicalPageRows: 8,
    ...overrides,
  };
}

function code(run: () => void): string | null {
  try { run(); return null; }
  catch (error) {
    expect(error).toBeInstanceOf(CoreTaxPacketRestartProofError);
    return (error as CoreTaxPacketRestartProofError).code;
  }
}

describe("100-page tax packet restart proof", () => {
  it("recognizes only the complete fixed restart identity", () => {
    expect(isCoreTaxPacketRestartJob(job())).toBe(true);
    expect(isCoreTaxPacketRestartJob(job({ mode: "standard" }))).toBe(false);
    expect(isCoreTaxPacketRestartJob(job({ id: "other" }))).toBe(false);
  });

  it("requires all four real provider reads and eight evidence-backed exact facts", () => {
    expect(() => validateCoreTaxPacketProviderRead(providerRead())).not.toThrow();
    const simulated = providerRead();
    simulated.simulated = true;
    expect(code(() => validateCoreTaxPacketProviderRead(simulated))).toBe("invariant_failed");
    const wrong = providerRead();
    wrong.extractions[2].fields.rentsReceivedTotal.value = 35_999;
    expect(code(() => validateCoreTaxPacketProviderRead(wrong))).toBe("invariant_failed");
    const ungrounded = providerRead();
    delete ungrounded.extractions[0].fields.wagesSalariesTips.pageNumber;
    expect(code(() => validateCoreTaxPacketProviderRead(ungrounded))).toBe("invariant_failed");
  });

  it("requires a different deployment on the same commit and exactly attempt two", () => {
    const seed = { version: 1 as const, sourceDeploymentId: "deployment-a", sourceCommitSha: commit, seededAt };
    const ready = {
      ...seed,
      providerReadyAt,
      attemptCount: 1 as const,
      classificationHash: "d".repeat(64),
      formCount: 4 as const,
      exactFactCount: 8 as const,
    };
    const completion = {
      version: 1 as const,
      completionDeploymentId: "deployment-b",
      completionCommitSha: commit,
      completedAt,
      attemptCount: 2,
    };
    const current = { deploymentId: "deployment-b", commitSha: commit };
    expect(() => validateCoreTaxPacketRestartTransition({
      seed, ready, completion, current, now: new Date("2026-09-10T14:03:11.000Z"),
    })).not.toThrow();
    expect(code(() => validateCoreTaxPacketRestartTransition({
      seed, ready, completion: { ...completion, attemptCount: 1 }, current,
      now: new Date("2026-09-10T14:03:11.000Z"),
    }))).toBe("invariant_failed");
    expect(code(() => validateCoreTaxPacketRestartTransition({
      seed, ready, completion: { ...completion, completionDeploymentId: "deployment-a" },
      current: { deploymentId: "deployment-a", commitSha: commit },
      now: new Date("2026-09-10T14:03:11.000Z"),
    }))).toBe("restart_not_observed");
    expect(code(() => validateCoreTaxPacketRestartTransition({
      seed, ready, completion, current,
      now: new Date("2026-09-10T15:00:00.001Z"),
    }))).toBe("marker_expired");
  });

  it("accepts one completed run after one abandoned run and rejects duplicate evidence", () => {
    expect(() => validateTaxPacketEvidenceSnapshot(snapshot(), {
      minimumAttempts: 2, runRows: 2, failedRunRows: 1,
    })).not.toThrow();
    for (const invalid of [
      snapshot({ attemptCount: 1 }),
      snapshot({ runRows: 3 }),
      snapshot({ logicalDocumentRows: 8 }),
      snapshot({ groundedFactRows: 27 }),
      snapshot({ claimedBy: "stale", leaseExpiresAt: new Date() }),
    ]) {
      expect(() => validateTaxPacketEvidenceSnapshot(invalid, {
        minimumAttempts: 2, runRows: 2, failedRunRows: 1,
      })).toThrowError("invariant_failed");
    }
  });

  it("holds after provider validation and before every evidence persistence step", async () => {
    const source = await readFile(join(__dirname, "../server/services/documentExtractionJobs.ts"), "utf8");
    const start = source.indexOf("async function executeTaxPackageJob");
    const end = source.indexOf("async function executeJob", start);
    const taxJob = source.slice(start, end);
    const providerRun = taxJob.indexOf("runTaxDocumentIntelligence(");
    const ready = taxJob.indexOf("recordCoreTaxPacketRestartProviderReady");
    const hold = taxJob.indexOf("holdCoreTaxPacketRestartFirstResult");
    const materialize = taxJob.indexOf("materializeDocumentPages");
    expect(providerRun).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(providerRun);
    expect(hold).toBeGreaterThan(ready);
    expect(materialize).toBeGreaterThan(hold);
    expect(source).toContain('claimNextJob(new Date(), "tax_restart", "tax_package")');
    expect(source).toContain("ne(documentExtractionJobs.id, CORE_TAX_PACKET_RESTART_JOB_ID)");
  });
});
