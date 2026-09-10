import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXTRACTION_EVALUATION_RUNNER_VERSION,
  assertExtractionEvaluationRuntime,
  computeEvaluationManifestSha256,
  prepareExtractionEvaluation,
  runExtractionEvaluation,
  simpleExtractionToBenchmarkCase,
  taxExtractionToBenchmarkCase,
  type ExtractionEvaluationDependencies,
  type ExtractionEvaluationManifest,
} from "../server/services/extractionEvaluationRunner";
import {
  EXTRACTION_MODEL_SINGLE_DOC,
  EXTRACTION_PROMPT_VERSION,
} from "../server/extractionCore";
import type { ExtractionBenchmarkDataset } from "../server/services/extractionBenchmark";

const temporaryDirectories: string[] = [];
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function privateWrite(filePath: string, value: string | Buffer): Promise<void> {
  await writeFile(filePath, value, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function evaluationFixture(caseCount = 1): Promise<{
  root: string;
  manifestPath: string;
  outputDirectory: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "homiquity-extraction-eval-"));
  temporaryDirectories.push(root);
  await chmod(root, 0o700);
  const datasetPath = path.join(root, "labels.json");
  const manifestPath = path.join(root, "manifest.json");
  const outputDirectory = path.join(root, "output");
  const sources = Array.from({ length: caseCount }, (_, index) => ({
    fileName: `source-${index + 1}.png`,
    bytes: Buffer.concat([ONE_PIXEL_PNG, Buffer.from([index])]),
  }));
  await Promise.all(sources.map((source) =>
    privateWrite(path.join(root, source.fileName), source.bytes),
  ));

  const cases = Array.from({ length: caseCount }, (_, index) => ({
    caseId: `pay-${index + 1}`,
    documentType: "paystub",
    situationTags: ["w2_income", "raster_scan"],
    pageCount: 1,
    fields: {
      grossPay: { value: 4_200 + index, pageNumber: 1, impact: "critical" as const },
    },
    logicalDocuments: [{ documentType: "paystub", pageStart: 1, pageEnd: 1 }],
  }));
  const manifest: ExtractionEvaluationManifest = {
    schemaVersion: "1",
    dataset: {
      datasetId: "protected-test",
      version: "1",
      path: "labels.json",
      sha256: "0".repeat(64),
    },
    providerCallBudget: caseCount,
    cases: cases.map((item, index) => ({
      caseId: item.caseId,
      sourcePath: sources[index].fileName,
      sourceSha256: sha256(sources[index].bytes),
      mimeType: "image/png" as const,
      extractor: "pay_stub" as const,
      maxProviderCalls: 1,
    })),
  };
  const manifestSha256 = computeEvaluationManifestSha256(manifest);
  const dataset: ExtractionBenchmarkDataset = {
    datasetId: manifest.dataset.datasetId,
    version: manifest.dataset.version,
    kind: "production_redacted",
    labeling: {
      protocolVersion: "mortgage-labeling-v1",
      reviewerCount: 2,
      independentlyReviewed: true,
      adjudicated: true,
      manifestSha256,
    },
    claimScope: {
      documentTypes: ["paystub"],
      situationTags: ["raster_scan"],
    },
    acceptanceThresholds: {
      valuePrecision: 0.95,
      valueRecall: 0.95,
      pageAttributionAccuracy: 0.95,
      documentTypeAccuracy: 0.95,
      boundaryPrecision: 0.95,
      boundaryRecall: 0.95,
      businessWeightedFieldAccuracy: 0.95,
    },
    cases,
  };
  const datasetBytes = Buffer.from(`${JSON.stringify(dataset, null, 2)}\n`);
  await privateWrite(datasetPath, datasetBytes);
  manifest.dataset.sha256 = sha256(datasetBytes);
  await privateWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, manifestPath, outputDirectory };
}

function successfulDependencies(onExecute?: () => void): ExtractionEvaluationDependencies {
  return {
    assertRuntimeReady: () => undefined,
    executeCase: async (item, reserveProviderCall) => {
      onExecute?.();
      await reserveProviderCall();
      return {
        status: "completed",
        errorCodes: [],
        prediction: structuredClone(item.truth),
        lineage: {
          modelIds: [EXTRACTION_MODEL_SINGLE_DOC],
          promptVersions: [EXTRACTION_PROMPT_VERSION],
          responseHashes: ["a".repeat(64)],
        },
        // The runner constructs a strict record rather than serializing this object.
        rawResponseEncrypted: "must-never-reach-disk",
      } as never;
    },
  };
}

describe("protected extraction evaluation runner", () => {
  it("binds private sources and labels before any provider work", async () => {
    const fixture = await evaluationFixture();
    const prepared = await prepareExtractionEvaluation(fixture.manifestPath);
    expect(prepared).toMatchObject({
      datasetSha256: prepared.manifest.dataset.sha256,
      plannedProviderCalls: 1,
      cases: [{
        caseId: "pay-1",
        pageCount: 1,
        sourceBytes: ONE_PIXEL_PNG.length + 1,
      }],
    });

    await privateWrite(path.join(fixture.root, "source-1.png"), Buffer.concat([ONE_PIXEL_PNG, Buffer.from("changed")]));
    await expect(prepareExtractionEvaluation(fixture.manifestPath)).rejects.toThrow(/SHA-256/i);
  });

  it("refuses duplicate source documents that could inflate benchmark coverage", async () => {
    const fixture = await evaluationFixture(2);
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
    manifest.cases[1].sourcePath = manifest.cases[0].sourcePath;
    manifest.cases[1].sourceSha256 = manifest.cases[0].sourceSha256;
    await privateWrite(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(prepareExtractionEvaluation(fixture.manifestPath))
      .rejects.toThrow(/unique source document hash/i);
  });

  it("refuses a protected manifest inside the public repository", async () => {
    await expect(prepareExtractionEvaluation(path.join(process.cwd(), "package.json")))
      .rejects.toThrow(/outside the repository/i);
  });

  it("checkpoints private predictions, writes aggregate metrics, and never serializes raw responses", async () => {
    const fixture = await evaluationFixture();
    let executions = 0;
    const report = await runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
      now: () => new Date("2026-09-10T20:00:00.000Z"),
    }, successfulDependencies(() => { executions += 1; }));

    expect(executions).toBe(1);
    expect(report).toMatchObject({
      runnerVersion: EXTRACTION_EVALUATION_RUNNER_VERSION,
      runComplete: true,
      casesRecorded: 1,
      casesFailed: 0,
      providerCallsConsumed: 1,
    });
    expect(report.benchmark.overall.valueRecall).toBe(1);
    expect(report.benchmark.eligibleForProductionClaim).toBe(false);
    expect(report.benchmark.claimBlockers.join(" ")).toMatch(/30 human-labeled/i);

    const checkpointPath = path.join(fixture.outputDirectory, "checkpoint.json");
    const reportPath = path.join(fixture.outputDirectory, "report.json");
    const checkpointText = await readFile(checkpointPath, "utf8");
    const reportText = await readFile(reportPath, "utf8");
    expect(checkpointText).not.toContain("must-never-reach-disk");
    expect(checkpointText).not.toContain("rawResponse");
    expect(reportText).not.toContain("grossPay");
    expect((await stat(checkpointPath)).mode & 0o077).toBe(0);
    expect((await stat(reportPath)).mode & 0o077).toBe(0);
  });

  it("resumes completed cases without paying for another provider call", async () => {
    const fixture = await evaluationFixture();
    let executions = 0;
    const dependencies = successfulDependencies(() => { executions += 1; });
    await runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
    }, dependencies);
    const resumed = await runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
      resume: true,
    }, dependencies);
    expect(executions).toBe(1);
    expect(resumed.providerCallsConsumed).toBe(1);
    expect(resumed.runComplete).toBe(true);
  });

  it("locks one output directory so concurrent runs cannot overwrite call accounting", async () => {
    const fixture = await evaluationFixture();
    let markReserved!: () => void;
    let releaseProvider!: () => void;
    const reserved = new Promise<void>((resolve) => { markReserved = resolve; });
    const providerBlocked = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const firstRun = runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
    }, {
      assertRuntimeReady: () => undefined,
      executeCase: async (item, reserveProviderCall) => {
        await reserveProviderCall();
        markReserved();
        await providerBlocked;
        return {
          status: "completed",
          errorCodes: [],
          prediction: structuredClone(item.truth),
          lineage: {
            modelIds: [EXTRACTION_MODEL_SINGLE_DOC],
            promptVersions: [EXTRACTION_PROMPT_VERSION],
            responseHashes: ["b".repeat(64)],
          },
        };
      },
    });
    await reserved;

    await expect(runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
      resume: true,
    }, successfulDependencies())).rejects.toThrow(/already locked/i);

    releaseProvider();
    await expect(firstRun).resolves.toMatchObject({ providerCallsConsumed: 1 });
    await expect(stat(path.join(fixture.outputDirectory, ".extraction-evaluation.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite an existing report when starting a fresh run", async () => {
    const fixture = await evaluationFixture();
    await mkdir(fixture.outputDirectory, { mode: 0o700 });
    await privateWrite(path.join(fixture.outputDirectory, "report.json"), "protected-existing-report\n");

    await expect(runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
    }, successfulDependencies())).rejects.toThrow(/output already exists/i);
    expect(await readFile(path.join(fixture.outputDirectory, "report.json"), "utf8"))
      .toBe("protected-existing-report\n");
  });

  it("keeps an intentionally bounded tranche ineligible until every case is recorded", async () => {
    const fixture = await evaluationFixture(2);
    const report = await runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
      maxCases: 1,
    }, successfulDependencies());
    expect(report).toMatchObject({
      runComplete: false,
      casesExpected: 2,
      casesRecorded: 1,
      providerCallsConsumed: 1,
    });
    expect(report.benchmark.eligibleForProductionClaim).toBe(false);
    expect(report.benchmark.claimBlockers.join(" ")).toMatch(/did not run every manifest case/i);
  });

  it("rejects unknown checkpoint fields instead of carrying possible raw provider data forward", async () => {
    const fixture = await evaluationFixture();
    await runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
    }, successfulDependencies());
    const checkpointPath = path.join(fixture.outputDirectory, "checkpoint.json");
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    checkpoint.records[0].rawResponse = "unexpected-secret";
    await privateWrite(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    await expect(runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
      resume: true,
    }, successfulDependencies())).rejects.toThrow(/checkpoint is incompatible/i);
  });

  it("persists a reservation before a provider call and enforces each case limit", async () => {
    const fixture = await evaluationFixture();
    const dependencies: ExtractionEvaluationDependencies = {
      assertRuntimeReady: () => undefined,
      executeCase: async (_item, reserveProviderCall) => {
        await reserveProviderCall();
        await reserveProviderCall();
        throw new Error("unreachable");
      },
    };
    await expect(runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
    }, dependencies)).rejects.toThrow(/case provider-call limit/i);
    const checkpoint = JSON.parse(
      await readFile(path.join(fixture.outputDirectory, "checkpoint.json"), "utf8"),
    );
    expect(checkpoint.providerCallsConsumed).toBe(1);
    expect(checkpoint.providerCallsByCase).toEqual({ "pay-1": 1 });

    let resumedCalls = 0;
    await expect(runExtractionEvaluation({
      manifestPath: fixture.manifestPath,
      outputDirectory: fixture.outputDirectory,
      resume: true,
    }, {
      assertRuntimeReady: () => undefined,
      executeCase: async (_item, reserveProviderCall) => {
        resumedCalls += 1;
        await reserveProviderCall();
        throw new Error("unreachable");
      },
    })).rejects.toThrow(/case provider-call limit/i);
    expect(resumedCalls).toBe(1);
    const resumedCheckpoint = JSON.parse(
      await readFile(path.join(fixture.outputDirectory, "checkpoint.json"), "utf8"),
    );
    expect(resumedCheckpoint.providerCallsConsumed).toBe(1);
  });

  it("projects only evidence-backed simple fields and collapses page classifications into boundaries", () => {
    const prediction = simpleExtractionToBenchmarkCase({
      caseId: "pay-1",
      extractor: "pay_stub",
      situationTags: ["mixed_income"],
      pageCount: 2,
      extracted: {
        grossPay: 4_200,
        netPay: 3_100,
        ytdGross: 50_400,
        confidence: "high",
        extractedFields: ["grossPay", "netPay", "ytdGross"],
        fieldEvidence: {
          grossPay: { pageNumber: 1, confidence: 0.99 },
          netPay: { pageNumber: 2, confidence: 0.99 },
        },
        pageCount: 2,
        documentClassification: {
          pageCount: 2,
          pages: [
            { pageNumber: 1, documentType: "paystub", confidence: 0.99 },
            { pageNumber: 2, documentType: "w2", confidence: 0.99 },
          ],
        },
        rawResponseEncrypted: "ciphertext",
      },
    });
    expect(prediction).toEqual({
      caseId: "pay-1",
      documentType: "mixed_packet",
      situationTags: ["mixed_income"],
      pageCount: 2,
      fields: {
        grossPay: { value: 4_200, pageNumber: 1 },
        netPay: { value: 3_100, pageNumber: 2 },
      },
      logicalDocuments: [
        { documentType: "paystub", pageStart: 1, pageEnd: 1 },
        { documentType: "w2", pageStart: 2, pageEnd: 2 },
      ],
    });
  });

  it("namespaces repeated tax forms by source order without exposing entity names in field keys", () => {
    const prediction = taxExtractionToBenchmarkCase({
      caseId: "tax-1",
      situationTags: ["multi_business"],
      pageCount: 4,
      instances: [
        {
          instance: {
            formType: "schedule_c",
            taxYear: 2025,
            entityName: "Second Private Business",
            k1Variant: null,
            pageStart: 3,
            pageEnd: 4,
            confidence: 0.98,
          },
          extraction: {
            taxYear: 2025,
            entityName: "Second Private Business",
            fields: { netProfitOrLoss: { value: 25_000, confidence: 0.97, pageNumber: 4 } },
            warnings: [],
            lineage: {},
            simulated: false,
          },
        },
        {
          instance: {
            formType: "schedule_c",
            taxYear: 2025,
            entityName: "First Private Business",
            k1Variant: null,
            pageStart: 1,
            pageEnd: 2,
            confidence: 0.98,
          },
          extraction: {
            taxYear: 2025,
            entityName: "First Private Business",
            fields: { netProfitOrLoss: { value: 40_000, confidence: 0.97, pageNumber: 2 } },
            warnings: [],
            lineage: {},
            simulated: false,
          },
        },
      ],
    });
    expect(prediction.fields).toEqual({
      "schedule_c[1].netProfitOrLoss": { value: 40_000, pageNumber: 2 },
      "schedule_c[2].netProfitOrLoss": { value: 25_000, pageNumber: 4 },
    });
    expect(JSON.stringify(prediction.fields)).not.toMatch(/Private Business/);
  });

  it("refuses production-service and simulated runs before provider use", () => {
    expect(() => assertExtractionEvaluationRuntime({
      NODE_ENV: "production",
      ANTHROPIC_API_KEY: "present",
    })).toThrow(/production service/i);
    expect(() => assertExtractionEvaluationRuntime({
      NODE_ENV: "test",
      EXTRACTION_SIMULATE: "true",
      ANTHROPIC_API_KEY: "present",
    })).toThrow(/simulated/i);
    expect(() => assertExtractionEvaluationRuntime({ NODE_ENV: "test" }))
      .toThrow(/credential/i);
  });
});
