import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MAX_UPLOAD_BYTES } from "@shared/uploads";
import { MAX_FORM_INSTANCES, type ClassifiedFormInstance } from "@shared/taxFormExtraction";
import {
  EXTRACTION_MODEL_SINGLE_DOC,
  EXTRACTION_MODEL_TAX_PACKAGE,
  EXTRACTION_PROMPT_VERSION,
  SIMULATED_MODEL_ID,
  type DocumentClassification,
  type ExtractedDocumentData,
  type ExtractionLineage,
} from "../extractionCore";
import {
  classifyTaxDocument,
  extractBankStatementData,
  extractLeaseData,
  extractPayStubData,
  extractTaxFormInstanceFields,
  extractW2Data,
  type TaxFormInstanceExtraction,
} from "../extractionService";
import {
  scoreExtractionBenchmark,
  type BenchmarkField,
  type ExtractionBenchmarkCase,
  type ExtractionBenchmarkDataset,
  type ExtractionBenchmarkPredictions,
  type ExtractionBenchmarkReport,
} from "./extractionBenchmark";
import {
  assertNonOverlappingTaxFormRanges,
  TaxPacketExcerptSession,
} from "./taxPacketExcerpt";

export const EXTRACTION_EVALUATION_SCHEMA_VERSION = "1";
export const EXTRACTION_EVALUATION_RUNNER_VERSION = "2026-09-v1";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const PRIVATE_PERMISSION_MASK = 0o077;
const MAX_EVALUATION_CASES = 500;
const MAX_PROVIDER_CALL_BUDGET = 2_000;
const DEFAULT_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const EVALUATION_LOCK_FILE = ".extraction-evaluation.lock";

export const EXTRACTION_EVALUATOR_TYPES = [
  "pay_stub",
  "w2",
  "bank_statement",
  "lease_agreement",
  "tax_package",
] as const;

export type ExtractionEvaluatorType = (typeof EXTRACTION_EVALUATOR_TYPES)[number];
export type EvaluationMimeType = "application/pdf" | "image/jpeg" | "image/png";

const sha256Schema = z.string().regex(SHA256_PATTERN);
const manifestCaseSchema = z.object({
  caseId: z.string().trim().min(1).max(100),
  sourcePath: z.string().trim().min(1).max(1_000),
  sourceSha256: sha256Schema,
  mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  extractor: z.enum(EXTRACTION_EVALUATOR_TYPES),
  maxProviderCalls: z.number().int().min(1).max(MAX_FORM_INSTANCES + 1),
}).strict().superRefine((item, context) => {
  if (item.extractor === "tax_package" && item.maxProviderCalls < 2) {
    context.addIssue({
      code: "custom",
      path: ["maxProviderCalls"],
      message: "A tax package needs one classification call plus at least one form call",
    });
  }
  if (item.extractor !== "tax_package" && item.maxProviderCalls !== 1) {
    context.addIssue({
      code: "custom",
      path: ["maxProviderCalls"],
      message: "A simple document uses exactly one provider call",
    });
  }
});

const manifestSchema = z.object({
  schemaVersion: z.literal(EXTRACTION_EVALUATION_SCHEMA_VERSION),
  dataset: z.object({
    datasetId: z.string().trim().min(1).max(100),
    version: z.string().trim().min(1).max(100),
    path: z.string().trim().min(1).max(1_000),
    sha256: sha256Schema,
  }).strict(),
  providerCallBudget: z.number().int().min(1).max(MAX_PROVIDER_CALL_BUDGET),
  cases: z.array(manifestCaseSchema).min(1).max(MAX_EVALUATION_CASES),
}).strict().superRefine((manifest, context) => {
  const ids = new Set<string>();
  const sourceHashes = new Set<string>();
  for (const [index, item] of manifest.cases.entries()) {
    if (ids.has(item.caseId)) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "caseId"],
        message: `Duplicate evaluation case id ${item.caseId}`,
      });
    }
    ids.add(item.caseId);
    const normalizedSourceHash = item.sourceSha256.toLowerCase();
    if (sourceHashes.has(normalizedSourceHash)) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "sourceSha256"],
        message: "Every evaluation case must use a unique source document hash",
      });
    }
    sourceHashes.add(normalizedSourceHash);
  }
  const plannedCalls = manifest.cases.reduce((total, item) => total + item.maxProviderCalls, 0);
  if (plannedCalls > manifest.providerCallBudget) {
    context.addIssue({
      code: "custom",
      path: ["providerCallBudget"],
      message: `The manifest reserves ${plannedCalls} provider calls but permits ${manifest.providerCallBudget}`,
    });
  }
});

export type ExtractionEvaluationManifest = z.infer<typeof manifestSchema>;
export type ExtractionEvaluationManifestCase = z.infer<typeof manifestCaseSchema>;

export interface PreparedEvaluationCase extends ExtractionEvaluationManifestCase {
  sourceAbsolutePath: string;
  sourceBytes: number;
  pageCount: number;
  truth: ExtractionBenchmarkCase;
}

export interface PreparedExtractionEvaluation {
  manifest: ExtractionEvaluationManifest;
  manifestSha256: string;
  manifestAbsolutePath: string;
  dataset: ExtractionBenchmarkDataset;
  datasetSha256: string;
  datasetAbsolutePath: string;
  plannedProviderCalls: number;
  claimReadiness: ExtractionBenchmarkReport;
  cases: PreparedEvaluationCase[];
}

export type EvaluationCaseErrorCode =
  | "classification_failed"
  | "classification_page_mismatch"
  | "empty_extraction"
  | "form_extraction_failed"
  | "lineage_incomplete"
  | "provider_call_failed"
  | "provider_call_limit"
  | "simulated_output"
  | "source_changed";

const evaluationCaseErrorCodeSchema = z.enum([
  "classification_failed",
  "classification_page_mismatch",
  "empty_extraction",
  "form_extraction_failed",
  "lineage_incomplete",
  "provider_call_failed",
  "provider_call_limit",
  "simulated_output",
  "source_changed",
]);

const benchmarkFieldSchema = z.object({
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  pageNumber: z.number().int().min(1).max(1_000),
  impact: z.enum(["critical", "standard"]).optional(),
}).strict();

const benchmarkCaseShape = {
  caseId: z.string().trim().min(1).max(100),
  documentType: z.string().trim().min(1).max(100),
  situationTags: z.array(z.string().trim().min(1).max(100)).max(100),
  pageCount: z.number().int().min(1).max(1_000),
  fields: z.record(z.string().trim().min(1).max(200), benchmarkFieldSchema),
  logicalDocuments: z.array(z.object({
    documentType: z.string().trim().min(1).max(100),
    pageStart: z.number().int().min(1).max(1_000),
    pageEnd: z.number().int().min(1).max(1_000),
  }).strict()).max(1_000),
};

const benchmarkCaseSchema: z.ZodType<ExtractionBenchmarkCase> = z.object(
  benchmarkCaseShape,
).strict();

const benchmarkTruthCaseSchema = z.object({
  ...benchmarkCaseShape,
  labelReview: z.object({
    reviewerIds: z.array(z.string().trim().min(1).max(100)).min(2).max(20),
    resolution: z.enum(["agreement", "adjudicated"]),
  }).strict().optional(),
}).strict();

const acceptanceThresholdsSchema = z.object({
  valuePrecision: z.number().finite().min(0).max(1),
  valueRecall: z.number().finite().min(0).max(1),
  pageAttributionAccuracy: z.number().finite().min(0).max(1),
  documentTypeAccuracy: z.number().finite().min(0).max(1),
  boundaryPrecision: z.number().finite().min(0).max(1),
  boundaryRecall: z.number().finite().min(0).max(1),
  criticalFieldAccuracy: z.number().finite().min(0).max(1),
  businessWeightedFieldAccuracy: z.number().finite().min(0).max(1),
}).strict();

const benchmarkDatasetSchema = z.object({
  datasetId: z.string().trim().min(1).max(100),
  version: z.string().trim().min(1).max(100),
  kind: z.enum(["synthetic", "production_redacted"]),
  labeling: z.object({
    protocolVersion: z.string().trim().min(1).max(100),
    reviewerCount: z.number().int().min(2).max(20),
    reviewerIds: z.array(z.string().trim().min(1).max(100)).min(2).max(20),
    independentlyReviewed: z.boolean(),
    adjudicated: z.boolean(),
    manifestSha256: sha256Schema,
  }).strict().optional(),
  claimScope: z.object({
    documentTypes: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
    situationTags: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
  }).strict().optional(),
  acceptanceThresholds: acceptanceThresholdsSchema.optional(),
  cases: z.array(benchmarkTruthCaseSchema).min(1).max(MAX_EVALUATION_CASES),
}).strict();

export interface EvaluationCaseLineage {
  modelIds: string[];
  promptVersions: string[];
  responseHashes: string[];
}

export interface EvaluationCaseExecution {
  status: "completed" | "failed";
  errorCodes: EvaluationCaseErrorCode[];
  prediction: ExtractionBenchmarkCase;
  lineage: EvaluationCaseLineage;
}

export interface ExtractionEvaluationCheckpointRecord extends EvaluationCaseExecution {
  caseId: string;
  sourceSha256: string;
  providerCalls: number;
  completedAt: string;
}

export interface ExtractionEvaluationCheckpoint {
  schemaVersion: typeof EXTRACTION_EVALUATION_SCHEMA_VERSION;
  runnerVersion: typeof EXTRACTION_EVALUATION_RUNNER_VERSION;
  datasetId: string;
  datasetVersion: string;
  manifestSha256: string;
  datasetSha256: string;
  providerCallBudget: number;
  providerCallsConsumed: number;
  providerCallsByCase: Record<string, number>;
  startedAt: string;
  updatedAt: string;
  records: ExtractionEvaluationCheckpointRecord[];
}

const checkpointSchema: z.ZodType<ExtractionEvaluationCheckpoint> = z.object({
  schemaVersion: z.literal(EXTRACTION_EVALUATION_SCHEMA_VERSION),
  runnerVersion: z.literal(EXTRACTION_EVALUATION_RUNNER_VERSION),
  datasetId: z.string().trim().min(1).max(100),
  datasetVersion: z.string().trim().min(1).max(100),
  manifestSha256: sha256Schema,
  datasetSha256: sha256Schema,
  providerCallBudget: z.number().int().min(1).max(MAX_PROVIDER_CALL_BUDGET),
  providerCallsConsumed: z.number().int().min(0).max(MAX_PROVIDER_CALL_BUDGET),
  providerCallsByCase: z.record(
    z.string().trim().min(1).max(100),
    z.number().int().min(1).max(MAX_FORM_INSTANCES + 1),
  ),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  records: z.array(z.object({
    caseId: z.string().trim().min(1).max(100),
    sourceSha256: sha256Schema,
    providerCalls: z.number().int().min(0).max(MAX_FORM_INSTANCES + 1),
    completedAt: z.string().datetime(),
    status: z.enum(["completed", "failed"]),
    errorCodes: z.array(evaluationCaseErrorCodeSchema).max(20),
    prediction: benchmarkCaseSchema,
    lineage: z.object({
      modelIds: z.array(z.string().trim().min(1).max(100)).max(10),
      promptVersions: z.array(z.string().trim().min(1).max(100)).max(10),
      responseHashes: z.array(sha256Schema).max(MAX_FORM_INSTANCES + 1),
    }).strict(),
  }).strict()).max(MAX_EVALUATION_CASES),
}).strict().superRefine((checkpoint, context) => {
  if (checkpoint.providerCallsConsumed > checkpoint.providerCallBudget) {
    context.addIssue({
      code: "custom",
      path: ["providerCallsConsumed"],
      message: "Consumed provider calls exceed the checkpoint budget",
    });
  }
  const callsByCase = Object.values(checkpoint.providerCallsByCase)
    .reduce((total, calls) => total + calls, 0);
  if (callsByCase !== checkpoint.providerCallsConsumed) {
    context.addIssue({
      code: "custom",
      path: ["providerCallsByCase"],
      message: "Per-case provider-call reservations do not match the consumed total",
    });
  }
  for (const [index, record] of checkpoint.records.entries()) {
    if (record.providerCalls !== (checkpoint.providerCallsByCase[record.caseId] ?? 0)) {
      context.addIssue({
        code: "custom",
        path: ["records", index, "providerCalls"],
        message: "Recorded case calls do not match its reservation history",
      });
    }
  }
});

export interface ExtractionEvaluationReport {
  schemaVersion: typeof EXTRACTION_EVALUATION_SCHEMA_VERSION;
  runnerVersion: typeof EXTRACTION_EVALUATION_RUNNER_VERSION;
  datasetId: string;
  datasetVersion: string;
  manifestSha256: string;
  datasetSha256: string;
  runComplete: boolean;
  casesExpected: number;
  casesRecorded: number;
  casesFailed: number;
  providerCallBudget: number;
  providerCallsConsumed: number;
  modelIds: string[];
  promptVersions: string[];
  responseHashesRecorded: number;
  generatedAt: string;
  benchmark: ExtractionBenchmarkReport;
}

export interface RunExtractionEvaluationOptions {
  manifestPath: string;
  outputDirectory: string;
  resume?: boolean;
  maxCases?: number;
  repositoryRoot?: string;
  now?: () => Date;
}

export interface ExtractionEvaluationDependencies {
  assertRuntimeReady(): void;
  executeCase(
    item: PreparedEvaluationCase,
    reserveProviderCall: () => Promise<void>,
  ): Promise<EvaluationCaseExecution>;
}

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The manifest identity excludes only the label-file digest. This breaks the
 * otherwise-circular chain: labels contain this manifest identity, while the
 * final manifest pins the exact label bytes through dataset.sha256.
 */
export function computeEvaluationManifestSha256(
  manifest: ExtractionEvaluationManifest,
): string {
  return digest(stableJson({
    ...manifest,
    dataset: { ...manifest.dataset, sha256: "<dataset-sha256-excluded>" },
  }));
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function assertPrivateFile(
  inputPath: string,
  repositoryRoot: string,
  label: string,
): Promise<string> {
  const [repository, target] = await Promise.all([
    realpath(repositoryRoot),
    realpath(path.resolve(inputPath)),
  ]);
  if (isInside(repository, target)) {
    throw new Error(`${label} must live outside the repository`);
  }
  const details = await stat(target);
  if (!details.isFile()) throw new Error(`${label} must be a regular file`);
  if ((details.mode & PRIVATE_PERMISSION_MASK) !== 0) {
    throw new Error(`${label} must not be accessible to group or other users (use chmod 600)`);
  }
  return target;
}

async function ensurePrivateOutputDirectory(
  inputPath: string,
  repositoryRoot: string,
): Promise<string> {
  const repository = await realpath(repositoryRoot);
  const absolute = path.resolve(inputPath);
  if (isInside(repository, absolute)) {
    throw new Error("Evaluation output must live outside the repository");
  }
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const target = await realpath(absolute);
  if (isInside(repository, target)) {
    throw new Error("Evaluation output must resolve outside the repository");
  }
  const details = await stat(target);
  if (!details.isDirectory()) throw new Error("Evaluation output must be a directory");
  if ((details.mode & PRIVATE_PERMISSION_MASK) !== 0) {
    throw new Error("Evaluation output must not be accessible to group or other users (use chmod 700)");
  }
  return target;
}

function resolvePrivateReference(reference: string, manifestAbsolutePath: string): string {
  return path.isAbsolute(reference)
    ? reference
    : path.resolve(path.dirname(manifestAbsolutePath), reference);
}

function assertMimeSignature(bytes: Buffer, mimeType: EvaluationMimeType, label: string): void {
  const valid = mimeType === "application/pdf"
    ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
    : mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!valid) throw new Error(`${label} bytes do not match the declared MIME type`);
}

async function sourcePageCount(bytes: Buffer, mimeType: EvaluationMimeType): Promise<number> {
  if (mimeType !== "application/pdf") return 1;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  try {
    const pdf = await loadingTask.promise;
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 1_000) {
      throw new Error("Source PDF has an invalid page count");
    }
    return pdf.numPages;
  } finally {
    await loadingTask.destroy();
  }
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) return false;
    throw error;
  }
}

async function acquireEvaluationLock(outputDirectory: string): Promise<() => Promise<void>> {
  const lockPath = path.join(outputDirectory, EVALUATION_LOCK_FILE);
  const token = randomUUID();
  try {
    await writeFile(lockPath, `${JSON.stringify({
      pid: process.pid,
      token,
      startedAt: new Date().toISOString(),
    })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(lockPath, 0o600);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new Error(
        "Evaluation output is already locked; if the prior process terminated, remove the private lock file before resuming",
      );
    }
    throw error;
  }
  return async () => {
    try {
      const current = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
      if (current.token === token) await unlink(lockPath);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) throw error;
    }
  };
}

function parseJson<T>(bytes: Buffer, schema: z.ZodType<T>, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${label} is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`);
  }
  return parsed.data;
}

function parseDataset(bytes: Buffer): ExtractionBenchmarkDataset {
  return parseJson(
    bytes,
    benchmarkDatasetSchema,
    "Evaluation dataset",
  ) as ExtractionBenchmarkDataset;
}

function assertTruthFitsExtractor(
  item: ExtractionEvaluationManifestCase,
  truth: ExtractionBenchmarkCase,
): void {
  if (item.extractor === "tax_package") {
    if (truth.documentType !== "tax_package") {
      throw new Error(`Tax-package case ${item.caseId} must label documentType tax_package`);
    }
    const unsupported = Object.keys(truth.fields).find((field) =>
      !/^[a-z0-9_]+\[[1-9]\d*\]\.[A-Za-z][A-Za-z0-9]*$/.test(field),
    );
    if (unsupported) {
      throw new Error(`Tax-package case ${item.caseId} has an unsupported field key ${unsupported}`);
    }
    return;
  }
  const allowedFields = new Set(SIMPLE_FIELD_PATHS[item.extractor]);
  const unsupported = Object.keys(truth.fields).find((field) => !allowedFields.has(field));
  if (unsupported) {
    throw new Error(`${item.extractor} case ${item.caseId} has an unsupported field key ${unsupported}`);
  }
}

export async function loadExtractionEvaluationManifest(
  manifestPath: string,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): Promise<{
  manifest: ExtractionEvaluationManifest;
  manifestSha256: string;
  manifestAbsolutePath: string;
}> {
  const manifestAbsolutePath = await assertPrivateFile(
    manifestPath,
    repositoryRoot,
    "Evaluation manifest",
  );
  const manifest = parseJson(
    await readFile(manifestAbsolutePath),
    manifestSchema,
    "Evaluation manifest",
  );
  return {
    manifest,
    manifestSha256: computeEvaluationManifestSha256(manifest),
    manifestAbsolutePath,
  };
}

export async function bindExtractionEvaluationLabels(
  manifestPath: string,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): Promise<{
  manifestSha256: string;
  datasetSha256: string;
  cases: number;
}> {
  const loaded = await loadExtractionEvaluationManifest(manifestPath, repositoryRoot);
  if (loaded.manifest.dataset.sha256 !== "0".repeat(64)) {
    throw new Error(
      "Label binding requires dataset.sha256 to contain 64 zeroes; copy the files before rebinding",
    );
  }
  const datasetAbsolutePath = await assertPrivateFile(
    resolvePrivateReference(loaded.manifest.dataset.path, loaded.manifestAbsolutePath),
    repositoryRoot,
    "Evaluation dataset",
  );
  const dataset = parseDataset(await readFile(datasetAbsolutePath));
  if (dataset.kind !== "production_redacted" || !dataset.labeling) {
    throw new Error("Label binding requires a production_redacted dataset with labeling metadata");
  }
  if (
    dataset.datasetId !== loaded.manifest.dataset.datasetId ||
    dataset.version !== loaded.manifest.dataset.version
  ) {
    throw new Error("Evaluation dataset identity does not match the manifest");
  }
  const datasetIds = new Set(dataset.cases.map((item) => item.caseId));
  const manifestIds = new Set(loaded.manifest.cases.map((item) => item.caseId));
  if (
    datasetIds.size !== dataset.cases.length ||
    manifestIds.size !== loaded.manifest.cases.length ||
    datasetIds.size !== manifestIds.size ||
    [...datasetIds].some((caseId) => !manifestIds.has(caseId))
  ) {
    throw new Error("Manifest and dataset must contain exactly the same unique case ids");
  }

  dataset.labeling.manifestSha256 = loaded.manifestSha256;
  const datasetBytes = Buffer.from(`${JSON.stringify(dataset, null, 2)}\n`);
  const datasetSha256 = digest(datasetBytes);
  const finalManifest: ExtractionEvaluationManifest = {
    ...loaded.manifest,
    dataset: {
      ...loaded.manifest.dataset,
      sha256: datasetSha256,
    },
  };
  await atomicWriteJson(datasetAbsolutePath, dataset);
  await atomicWriteJson(loaded.manifestAbsolutePath, finalManifest);
  return {
    manifestSha256: loaded.manifestSha256,
    datasetSha256,
    cases: dataset.cases.length,
  };
}

export async function prepareExtractionEvaluation(
  manifestPath: string,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
): Promise<PreparedExtractionEvaluation> {
  const loaded = await loadExtractionEvaluationManifest(manifestPath, repositoryRoot);
  const datasetAbsolutePath = await assertPrivateFile(
    resolvePrivateReference(loaded.manifest.dataset.path, loaded.manifestAbsolutePath),
    repositoryRoot,
    "Evaluation dataset",
  );
  const datasetBytes = await readFile(datasetAbsolutePath);
  const datasetSha256 = digest(datasetBytes);
  if (datasetSha256 !== loaded.manifest.dataset.sha256) {
    throw new Error("Evaluation dataset SHA-256 does not match the manifest");
  }
  const dataset = parseDataset(datasetBytes);
  if (
    dataset.datasetId !== loaded.manifest.dataset.datasetId ||
    dataset.version !== loaded.manifest.dataset.version
  ) {
    throw new Error("Evaluation dataset identity does not match the manifest");
  }
  if (
    dataset.kind === "production_redacted" &&
    dataset.labeling?.manifestSha256 !== loaded.manifestSha256
  ) {
    throw new Error("Human-reviewed labels are not bound to this evaluation manifest");
  }
  const claimReadiness = scoreExtractionBenchmark(dataset, {
    datasetId: dataset.datasetId,
    datasetVersion: dataset.version,
    datasetManifestSha256: loaded.manifestSha256,
    modelId: "preflight-perfect-candidate",
    promptVersion: "preflight-perfect-candidate",
    cases: dataset.cases,
  });

  const truthById = new Map(dataset.cases.map((item) => [item.caseId, item]));
  if (truthById.size !== dataset.cases.length) {
    throw new Error("Evaluation dataset case ids must be unique");
  }
  const manifestIds = new Set(loaded.manifest.cases.map((item) => item.caseId));
  const missingManifestCase = dataset.cases.find((item) => !manifestIds.has(item.caseId));
  const missingDatasetCase = loaded.manifest.cases.find((item) => !truthById.has(item.caseId));
  if (missingManifestCase || missingDatasetCase) {
    throw new Error("Manifest and dataset must contain exactly the same case ids");
  }
  for (const item of loaded.manifest.cases) {
    assertTruthFitsExtractor(item, truthById.get(item.caseId)!);
  }

  const preparedCases: PreparedEvaluationCase[] = [];
  for (const item of loaded.manifest.cases) {
    const sourceAbsolutePath = await assertPrivateFile(
      resolvePrivateReference(item.sourcePath, loaded.manifestAbsolutePath),
      repositoryRoot,
      `Source for case ${item.caseId}`,
    );
    const bytes = await readFile(sourceAbsolutePath);
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new Error(`Source for case ${item.caseId} exceeds the product upload limit`);
    }
    assertMimeSignature(bytes, item.mimeType, `Source for case ${item.caseId}`);
    if (digest(bytes) !== item.sourceSha256) {
      throw new Error(`Source SHA-256 does not match for case ${item.caseId}`);
    }
    const pageCount = await sourcePageCount(bytes, item.mimeType);
    const truth = truthById.get(item.caseId)!;
    if (truth.pageCount !== pageCount) {
      throw new Error(`Labeled page count does not match the source for case ${item.caseId}`);
    }
    preparedCases.push({
      ...item,
      sourceAbsolutePath,
      sourceBytes: bytes.length,
      pageCount,
      truth,
    });
  }

  return {
    ...loaded,
    dataset,
    datasetSha256,
    datasetAbsolutePath,
    plannedProviderCalls: loaded.manifest.cases.reduce(
      (total, item) => total + item.maxProviderCalls,
      0,
    ),
    claimReadiness,
    cases: preparedCases,
  };
}

export function assertExtractionEvaluationRuntime(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.NODE_ENV === "production") {
    throw new Error("Protected extraction evaluation cannot run inside the production service");
  }
  if (env.EXTRACTION_SIMULATE === "true") {
    throw new Error("Protected extraction evaluation refuses simulated extraction");
  }
  if (!(env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY)) {
    throw new Error("A live Anthropic credential is required for protected extraction evaluation");
  }
}

const SIMPLE_FIELD_PATHS: Record<Exclude<ExtractionEvaluatorType, "tax_package">, string[]> = {
  pay_stub: [
    "employeeName", "employerName", "payPeriodStartDate", "payPeriodEndDate",
    "grossPay", "netPay", "ytdGross", "ytdNetPay", "ytdTaxes",
    "deductions.federal", "deductions.fica", "deductions.other",
  ],
  w2: [
    "employeeName", "employerName", "taxYear", "employerEinLast4",
    "wagesTipsOtherCompensation", "federalIncomeTaxWithheld", "socialSecurityWages",
    "socialSecurityTaxWithheld", "medicareWagesAndTips", "medicareTaxWithheld",
    "stateWagesTips", "stateCode",
  ],
  bank_statement: [
    "accountType", "accountNumber", "statementPeriod.start", "statementPeriod.end",
    "openingBalance", "closingBalance", "totalDeposits", "totalWithdrawals",
    "averageDailyBalance",
  ],
  lease_agreement: [
    "monthlyRent", "tenantName", "landlordName", "propertyAddress",
    "leaseStartDate", "leaseEndDate", "securityDeposit",
  ],
};

function valueAtPath(value: object, fieldPath: string): unknown {
  return fieldPath.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function contiguousLogicalDocuments(
  classification: DocumentClassification | undefined,
  pageCount: number,
): ExtractionBenchmarkCase["logicalDocuments"] {
  if (
    !classification ||
    classification.pageCount !== pageCount ||
    classification.pages.length !== pageCount
  ) return [];
  const ordered = [...classification.pages].sort((left, right) => left.pageNumber - right.pageNumber);
  if (ordered.some((item, index) => item.pageNumber !== index + 1)) return [];
  const result: ExtractionBenchmarkCase["logicalDocuments"] = [];
  for (const page of ordered) {
    const previous = result.at(-1);
    if (previous?.documentType === page.documentType && previous.pageEnd === page.pageNumber - 1) {
      previous.pageEnd = page.pageNumber;
    } else {
      result.push({
        documentType: page.documentType,
        pageStart: page.pageNumber,
        pageEnd: page.pageNumber,
      });
    }
  }
  return result;
}

function predictedDocumentType(
  logicalDocuments: ExtractionBenchmarkCase["logicalDocuments"],
): string {
  if (logicalDocuments.length === 0) return "unknown";
  const types = new Set(logicalDocuments.map((item) => item.documentType));
  return types.size === 1 ? logicalDocuments[0].documentType : "mixed_packet";
}

function scalarBenchmarkValue(value: unknown): BenchmarkField["value"] | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : value === null
      ? null
      : undefined;
}

export function simpleExtractionToBenchmarkCase(input: {
  caseId: string;
  extractor: Exclude<ExtractionEvaluatorType, "tax_package">;
  situationTags: string[];
  pageCount: number;
  extracted: ExtractedDocumentData;
}): ExtractionBenchmarkCase {
  const fields: Record<string, BenchmarkField> = {};
  for (const fieldPath of SIMPLE_FIELD_PATHS[input.extractor]) {
    const value = scalarBenchmarkValue(valueAtPath(input.extracted, fieldPath));
    const evidence = input.extracted.fieldEvidence?.[fieldPath];
    if (
      value === undefined ||
      !evidence ||
      !Number.isInteger(evidence.pageNumber) ||
      evidence.pageNumber < 1 ||
      evidence.pageNumber > input.pageCount
    ) continue;
    fields[fieldPath] = { value, pageNumber: evidence.pageNumber };
  }
  const logicalDocuments = contiguousLogicalDocuments(
    input.extracted.documentClassification,
    input.pageCount,
  );
  return {
    caseId: input.caseId,
    documentType: predictedDocumentType(logicalDocuments),
    situationTags: [...input.situationTags],
    pageCount: input.pageCount,
    fields,
    logicalDocuments,
  };
}

function taxInstanceKey(
  instance: ClassifiedFormInstance,
  ordinal: number,
  fieldName: string,
): string {
  return `${instance.formType}[${ordinal}].${fieldName}`;
}

export function taxExtractionToBenchmarkCase(input: {
  caseId: string;
  situationTags: string[];
  pageCount: number;
  instances: Array<{
    instance: ClassifiedFormInstance;
    extraction: TaxFormInstanceExtraction;
  }>;
}): ExtractionBenchmarkCase {
  const ordered = [...input.instances].sort((left, right) =>
    (left.instance.pageStart ?? Number.MAX_SAFE_INTEGER) -
      (right.instance.pageStart ?? Number.MAX_SAFE_INTEGER) ||
    left.instance.formType.localeCompare(right.instance.formType),
  );
  const typeCounts = new Map<string, number>();
  const fields: Record<string, BenchmarkField> = {};
  const logicalDocuments: ExtractionBenchmarkCase["logicalDocuments"] = [];
  for (const item of ordered) {
    const ordinal = (typeCounts.get(item.instance.formType) ?? 0) + 1;
    typeCounts.set(item.instance.formType, ordinal);
    if (
      item.instance.pageStart &&
      item.instance.pageEnd &&
      item.instance.pageStart >= 1 &&
      item.instance.pageEnd >= item.instance.pageStart &&
      item.instance.pageEnd <= input.pageCount
    ) {
      logicalDocuments.push({
        documentType: item.instance.formType,
        pageStart: item.instance.pageStart,
        pageEnd: item.instance.pageEnd,
      });
    }
    for (const [fieldName, field] of Object.entries(item.extraction.fields)) {
      const value = scalarBenchmarkValue(field.value);
      if (
        value === undefined ||
        !Number.isInteger(field.pageNumber) ||
        !field.pageNumber ||
        field.pageNumber < 1 ||
        field.pageNumber > input.pageCount
      ) continue;
      fields[taxInstanceKey(item.instance, ordinal, fieldName)] = {
        value,
        pageNumber: field.pageNumber,
      };
    }
  }
  return {
    caseId: input.caseId,
    documentType: ordered.length > 0 ? "tax_package" : "unknown",
    situationTags: [...input.situationTags],
    pageCount: input.pageCount,
    fields,
    logicalDocuments,
  };
}

function collectLineage(items: ExtractionLineage[]): EvaluationCaseLineage {
  return {
    modelIds: [...new Set(items.flatMap((item) => item.modelId ? [item.modelId] : []))].sort(),
    promptVersions: [...new Set(items.flatMap((item) => item.promptVersion ? [item.promptVersion] : []))].sort(),
    responseHashes: items.flatMap((item) =>
      item.rawResponseHash && SHA256_PATTERN.test(item.rawResponseHash)
        ? [item.rawResponseHash]
        : [],
    ).sort(),
  };
}

function emptyPrediction(item: PreparedEvaluationCase): ExtractionBenchmarkCase {
  return {
    caseId: item.caseId,
    documentType: "unknown",
    situationTags: [...item.truth.situationTags],
    pageCount: item.pageCount,
    fields: {},
    logicalDocuments: [],
  };
}

async function readUnchangedSource(item: PreparedEvaluationCase): Promise<Buffer> {
  const bytes = await readFile(item.sourceAbsolutePath);
  if (bytes.length !== item.sourceBytes || digest(bytes) !== item.sourceSha256) {
    throw Object.assign(new Error("Evaluation source changed after validation"), {
      evaluationCode: "source_changed" satisfies EvaluationCaseErrorCode,
    });
  }
  return bytes;
}

async function executeSimpleEvaluationCase(
  item: PreparedEvaluationCase,
  reserveProviderCall: () => Promise<void>,
): Promise<EvaluationCaseExecution> {
  const source = await readUnchangedSource(item);
  await reserveProviderCall();
  const extracted = item.extractor === "pay_stub"
    ? await extractPayStubData(source, item.mimeType)
    : item.extractor === "w2"
      ? await extractW2Data(source, item.mimeType)
      : item.extractor === "bank_statement"
        ? await extractBankStatementData(source, item.mimeType)
        : await extractLeaseData(source, item.mimeType);
  const lineage = collectLineage([extracted]);
  const prediction = simpleExtractionToBenchmarkCase({
    caseId: item.caseId,
    extractor: item.extractor as Exclude<ExtractionEvaluatorType, "tax_package">,
    situationTags: item.truth.situationTags,
    pageCount: item.pageCount,
    extracted,
  });
  const errorCodes: EvaluationCaseErrorCode[] = [];
  if (lineage.modelIds.includes(SIMULATED_MODEL_ID)) errorCodes.push("simulated_output");
  if (
    lineage.modelIds.length !== 1 ||
    lineage.modelIds[0] !== EXTRACTION_MODEL_SINGLE_DOC ||
    lineage.promptVersions.length !== 1 ||
    lineage.promptVersions[0] !== EXTRACTION_PROMPT_VERSION ||
    lineage.responseHashes.length !== 1
  ) errorCodes.push("lineage_incomplete");
  if (Object.keys(prediction.fields).length === 0) errorCodes.push("empty_extraction");
  return {
    status: errorCodes.includes("simulated_output") || errorCodes.includes("lineage_incomplete")
      ? "failed"
      : "completed",
    errorCodes: [...new Set(errorCodes)],
    prediction,
    lineage,
  };
}

async function executeTaxEvaluationCase(
  item: PreparedEvaluationCase,
  reserveProviderCall: () => Promise<void>,
): Promise<EvaluationCaseExecution> {
  const source = await readUnchangedSource(item);
  const packet = await TaxPacketExcerptSession.open(source, item.mimeType);
  const lineages: ExtractionLineage[] = [];
  const extractedInstances: Array<{
    instance: ClassifiedFormInstance;
    extraction: TaxFormInstanceExtraction;
  }> = [];
  const errorCodes: EvaluationCaseErrorCode[] = [];
  try {
    await reserveProviderCall();
    const classified = await classifyTaxDocument(packet.sourceBytes, packet.sourceMimeType);
    lineages.push(classified.lineage);
    if (classified.simulated) errorCodes.push("simulated_output");
    if (!classified.classification) {
      errorCodes.push("classification_failed");
      return {
        status: "failed",
        errorCodes,
        prediction: emptyPrediction(item),
        lineage: collectLineage(lineages),
      };
    }
    if (classified.classification.pageCount !== item.pageCount) {
      errorCodes.push("classification_page_mismatch");
      return {
        status: "failed",
        errorCodes,
        prediction: emptyPrediction(item),
        lineage: collectLineage(lineages),
      };
    }
    const instances = classified.classification.forms.filter((instance) =>
      instance.pageStart !== null &&
      instance.pageStart !== undefined &&
      instance.pageEnd !== null &&
      instance.pageEnd !== undefined,
    ) as Array<ClassifiedFormInstance & { pageStart: number; pageEnd: number }>;
    if (instances.length === 0 || instances.length !== classified.classification.forms.length) {
      errorCodes.push("classification_failed");
    }
    if (instances.length + 1 > item.maxProviderCalls) {
      errorCodes.push("provider_call_limit");
      return {
        status: "failed",
        errorCodes,
        prediction: emptyPrediction(item),
        lineage: collectLineage(lineages),
      };
    }
    try {
      assertNonOverlappingTaxFormRanges(instances, item.pageCount);
    } catch {
      errorCodes.push("classification_failed");
      return {
        status: "failed",
        errorCodes: [...new Set(errorCodes)],
        prediction: emptyPrediction(item),
        lineage: collectLineage(lineages),
      };
    }
    for (const instance of instances) {
      const excerpt = await packet.excerpt(instance.pageStart, instance.pageEnd);
      await reserveProviderCall();
      const extraction = await extractTaxFormInstanceFields(
        excerpt.bytes,
        instance,
        excerpt.mimeType,
        {
          sourcePageOffset: excerpt.sourcePageOffset,
          attachedPageCount: excerpt.pageCount,
        },
      );
      lineages.push(extraction.lineage);
      if (extraction.simulated) errorCodes.push("simulated_output");
      if (extraction.failureReason) errorCodes.push("form_extraction_failed");
      extractedInstances.push({ instance, extraction });
    }
    const lineage = collectLineage(lineages);
    if (
      lineage.modelIds.length !== 1 ||
      lineage.modelIds[0] !== EXTRACTION_MODEL_TAX_PACKAGE ||
      lineage.promptVersions.length !== 1 ||
      lineage.promptVersions[0] !== EXTRACTION_PROMPT_VERSION ||
      lineage.responseHashes.length !== lineages.length
    ) errorCodes.push("lineage_incomplete");
    return {
      status: errorCodes.some((code) =>
        code === "classification_failed" ||
        code === "simulated_output" ||
        code === "form_extraction_failed" ||
        code === "lineage_incomplete",
      ) ? "failed" : "completed",
      errorCodes: [...new Set(errorCodes)],
      prediction: taxExtractionToBenchmarkCase({
        caseId: item.caseId,
        situationTags: item.truth.situationTags,
        pageCount: item.pageCount,
        instances: extractedInstances,
      }),
      lineage,
    };
  } catch (error) {
    const code = (
      error &&
      typeof error === "object" &&
      "evaluationCode" in error &&
      typeof error.evaluationCode === "string"
    ) ? error.evaluationCode as EvaluationCaseErrorCode : "provider_call_failed";
    return {
      status: "failed",
      errorCodes: [...new Set([...errorCodes, code])],
      prediction: taxExtractionToBenchmarkCase({
        caseId: item.caseId,
        situationTags: item.truth.situationTags,
        pageCount: item.pageCount,
        instances: extractedInstances,
      }),
      lineage: collectLineage(lineages),
    };
  } finally {
    await packet.close();
  }
}

export async function executeProductionEvaluationCase(
  item: PreparedEvaluationCase,
  reserveProviderCall: () => Promise<void>,
): Promise<EvaluationCaseExecution> {
  try {
    return item.extractor === "tax_package"
      ? await executeTaxEvaluationCase(item, reserveProviderCall)
      : await executeSimpleEvaluationCase(item, reserveProviderCall);
  } catch (error) {
    const code = (
      error &&
      typeof error === "object" &&
      "evaluationCode" in error &&
      typeof error.evaluationCode === "string"
    ) ? error.evaluationCode as EvaluationCaseErrorCode : "provider_call_failed";
    return {
      status: "failed",
      errorCodes: [code],
      prediction: emptyPrediction(item),
      lineage: { modelIds: [], promptVersions: [], responseHashes: [] },
    };
  }
}

const defaultDependencies: ExtractionEvaluationDependencies = {
  assertRuntimeReady: assertExtractionEvaluationRuntime,
  executeCase: executeProductionEvaluationCase,
};

function newCheckpoint(
  prepared: PreparedExtractionEvaluation,
  now: Date,
): ExtractionEvaluationCheckpoint {
  return {
    schemaVersion: EXTRACTION_EVALUATION_SCHEMA_VERSION,
    runnerVersion: EXTRACTION_EVALUATION_RUNNER_VERSION,
    datasetId: prepared.dataset.datasetId,
    datasetVersion: prepared.dataset.version,
    manifestSha256: prepared.manifestSha256,
    datasetSha256: prepared.datasetSha256,
    providerCallBudget: prepared.manifest.providerCallBudget,
    providerCallsConsumed: 0,
    providerCallsByCase: {},
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    records: [],
  };
}

function parseCheckpoint(value: unknown): ExtractionEvaluationCheckpoint {
  const parsed = checkpointSchema.safeParse(value);
  if (!parsed.success) throw new Error("Evaluation checkpoint is incompatible with this runner");
  const checkpoint = parsed.data;
  const ids = new Set<string>();
  for (const record of checkpoint.records) {
    if (!record?.caseId || ids.has(record.caseId)) {
      throw new Error("Evaluation checkpoint records must have unique case ids");
    }
    ids.add(record.caseId);
  }
  return checkpoint;
}

function recordHasExpectedLineage(
  record: ExtractionEvaluationCheckpointRecord,
  item: PreparedEvaluationCase,
): boolean {
  const expectedModel = item.extractor === "tax_package"
    ? EXTRACTION_MODEL_TAX_PACKAGE
    : EXTRACTION_MODEL_SINGLE_DOC;
  return (
    record.lineage.modelIds.length === 1 &&
    record.lineage.modelIds[0] === expectedModel &&
    record.lineage.promptVersions.length === 1 &&
    record.lineage.promptVersions[0] === EXTRACTION_PROMPT_VERSION &&
    record.lineage.responseHashes.length === record.providerCalls
  );
}

async function loadCheckpoint(
  checkpointPath: string,
  prepared: PreparedExtractionEvaluation,
): Promise<ExtractionEvaluationCheckpoint> {
  let value: unknown;
  try {
    value = JSON.parse((await readFile(checkpointPath)).toString("utf8"));
  } catch {
    throw new Error("Evaluation checkpoint is missing or invalid");
  }
  const checkpoint = parseCheckpoint(value);
  if (
    checkpoint.datasetId !== prepared.dataset.datasetId ||
    checkpoint.datasetVersion !== prepared.dataset.version ||
    checkpoint.manifestSha256 !== prepared.manifestSha256 ||
    checkpoint.datasetSha256 !== prepared.datasetSha256 ||
    checkpoint.providerCallBudget !== prepared.manifest.providerCallBudget
  ) throw new Error("Evaluation checkpoint does not match the manifest and labels");
  return checkpoint;
}

function predictionsFromCheckpoint(
  prepared: PreparedExtractionEvaluation,
  checkpoint: ExtractionEvaluationCheckpoint,
): ExtractionBenchmarkPredictions {
  const modelIds = [...new Set(checkpoint.records.flatMap((record) => record.lineage.modelIds))].sort();
  const promptVersions = [...new Set(checkpoint.records.flatMap((record) => record.lineage.promptVersions))].sort();
  return {
    datasetId: prepared.dataset.datasetId,
    datasetVersion: prepared.dataset.version,
    datasetManifestSha256: prepared.manifestSha256,
    modelId: modelIds.join("+") || "provider-unavailable",
    promptVersion: promptVersions.join("+") || EXTRACTION_PROMPT_VERSION,
    cases: checkpoint.records.map((record) => record.prediction),
  };
}

function reportFromCheckpoint(
  prepared: PreparedExtractionEvaluation,
  checkpoint: ExtractionEvaluationCheckpoint,
  now: Date,
): ExtractionEvaluationReport {
  const predictions = predictionsFromCheckpoint(prepared, checkpoint);
  let benchmark = scoreExtractionBenchmark(prepared.dataset, predictions);
  const recordedIds = new Set(checkpoint.records.map((record) => record.caseId));
  const runComplete = prepared.cases.every((item) => recordedIds.has(item.caseId));
  const failed = checkpoint.records.filter((record) => record.status === "failed");
  const invalidLineage = checkpoint.records.filter((record) => {
    const item = prepared.cases.find((candidate) => candidate.caseId === record.caseId);
    return !item || !recordHasExpectedLineage(record, item);
  });
  const runBlockers: string[] = [];
  if (!runComplete) runBlockers.push("Evaluation did not run every manifest case.");
  if (failed.length > 0) runBlockers.push(`${failed.length} evaluation case(s) had a provider or lineage failure.`);
  if (invalidLineage.length > 0) runBlockers.push(`${invalidLineage.length} evaluation case(s) lack complete production lineage.`);
  if (runBlockers.length > 0) {
    benchmark = {
      ...benchmark,
      eligibleForProductionClaim: false,
      claimBlockers: [...benchmark.claimBlockers, ...runBlockers],
    };
  }
  return {
    schemaVersion: EXTRACTION_EVALUATION_SCHEMA_VERSION,
    runnerVersion: EXTRACTION_EVALUATION_RUNNER_VERSION,
    datasetId: prepared.dataset.datasetId,
    datasetVersion: prepared.dataset.version,
    manifestSha256: prepared.manifestSha256,
    datasetSha256: prepared.datasetSha256,
    runComplete,
    casesExpected: prepared.cases.length,
    casesRecorded: checkpoint.records.length,
    casesFailed: failed.length,
    providerCallBudget: checkpoint.providerCallBudget,
    providerCallsConsumed: checkpoint.providerCallsConsumed,
    modelIds: [...new Set(checkpoint.records.flatMap((record) => record.lineage.modelIds))].sort(),
    promptVersions: [...new Set(checkpoint.records.flatMap((record) => record.lineage.promptVersions))].sort(),
    responseHashesRecorded: checkpoint.records
      .reduce((total, record) => total + record.lineage.responseHashes.length, 0),
    generatedAt: now.toISOString(),
    benchmark,
  };
}

async function runLockedExtractionEvaluation(
  prepared: PreparedExtractionEvaluation,
  outputDirectory: string,
  options: RunExtractionEvaluationOptions,
  dependencies: ExtractionEvaluationDependencies,
  now: () => Date,
): Promise<ExtractionEvaluationReport> {
  const checkpointPath = path.join(outputDirectory, "checkpoint.json");
  const reportPath = path.join(outputDirectory, "report.json");
  let checkpoint: ExtractionEvaluationCheckpoint;
  if (options.resume) {
    checkpoint = await loadCheckpoint(checkpointPath, prepared);
  } else {
    if (await fileExists(checkpointPath) || await fileExists(reportPath)) {
      throw new Error("Evaluation output already exists; use --resume or a new output directory");
    }
    checkpoint = newCheckpoint(prepared, now());
    await atomicWriteJson(checkpointPath, checkpoint);
  }

  const existingById = new Map(checkpoint.records.map((record) => [record.caseId, record]));
  const preparedById = new Map(prepared.cases.map((item) => [item.caseId, item]));
  const unknownCheckpointRecord = checkpoint.records.find((record) => !preparedById.has(record.caseId));
  if (unknownCheckpointRecord) {
    throw new Error(`Checkpoint case ${unknownCheckpointRecord.caseId} is not in the manifest`);
  }
  const unknownReservedCase = Object.keys(checkpoint.providerCallsByCase)
    .find((caseId) => !preparedById.has(caseId));
  if (unknownReservedCase) {
    throw new Error(`Checkpoint call reservation ${unknownReservedCase} is not in the manifest`);
  }
  for (const item of prepared.cases) {
    const existing = existingById.get(item.caseId);
    if (existing && existing.status === "completed") {
      if (existing.sourceSha256 !== item.sourceSha256) {
        throw new Error(`Completed checkpoint source does not match case ${item.caseId}`);
      }
      if (!recordHasExpectedLineage(existing, item)) {
        throw new Error(`Completed checkpoint lineage does not match case ${item.caseId}`);
      }
      continue;
    }
  }
  const pending = prepared.cases.filter((item) => existingById.get(item.caseId)?.status !== "completed");
  const maxCases = options.maxCases ?? pending.length;
  if (
    !Number.isInteger(maxCases) ||
    maxCases < (pending.length === 0 && options.maxCases === undefined ? 0 : 1) ||
    maxCases > MAX_EVALUATION_CASES
  ) {
    throw new Error(`--max-cases must be an integer from 1 to ${MAX_EVALUATION_CASES}`);
  }

  for (const item of pending.slice(0, maxCases)) {
    const previousRecord = existingById.get(item.caseId);
    const reserveProviderCall = async () => {
      const caseCalls = checkpoint.providerCallsByCase[item.caseId] ?? 0;
      if (caseCalls >= item.maxProviderCalls) {
        throw Object.assign(new Error("Case provider-call limit exhausted"), {
          evaluationCode: "provider_call_limit" satisfies EvaluationCaseErrorCode,
        });
      }
      if (checkpoint.providerCallsConsumed >= checkpoint.providerCallBudget) {
        throw Object.assign(new Error("Provider-call budget exhausted"), {
          evaluationCode: "provider_call_limit" satisfies EvaluationCaseErrorCode,
        });
      }
      checkpoint.providerCallsConsumed += 1;
      checkpoint.providerCallsByCase[item.caseId] = caseCalls + 1;
      checkpoint.updatedAt = now().toISOString();
      await atomicWriteJson(checkpointPath, checkpoint);
    };
    const executed = await dependencies.executeCase(item, reserveProviderCall);
    const providerCalls = checkpoint.providerCallsByCase[item.caseId] ?? 0;
    const lineage: EvaluationCaseLineage = {
      modelIds: [...new Set([
        ...(previousRecord?.lineage.modelIds ?? []),
        ...executed.lineage.modelIds,
      ])].sort(),
      promptVersions: [...new Set([
        ...(previousRecord?.lineage.promptVersions ?? []),
        ...executed.lineage.promptVersions,
      ])].sort(),
      responseHashes: [
        ...(previousRecord?.lineage.responseHashes ?? []),
        ...executed.lineage.responseHashes,
      ].sort(),
    };
    const errorCodes: EvaluationCaseErrorCode[] = [...new Set<EvaluationCaseErrorCode>([
      ...(previousRecord?.errorCodes ?? []),
      ...executed.errorCodes,
    ])];
    if (
      lineage.responseHashes.length !== providerCalls &&
      !errorCodes.includes("lineage_incomplete")
    ) errorCodes.push("lineage_incomplete");
    const record: ExtractionEvaluationCheckpointRecord = {
      caseId: item.caseId,
      sourceSha256: item.sourceSha256,
      providerCalls,
      completedAt: now().toISOString(),
      status: previousRecord?.status === "failed" || executed.status === "failed" ||
        errorCodes.includes("lineage_incomplete") ? "failed" : "completed",
      errorCodes,
      prediction: executed.prediction,
      lineage,
    };
    checkpoint.records = checkpoint.records.filter((item) => item.caseId !== record.caseId);
    checkpoint.records.push(record);
    checkpoint.updatedAt = now().toISOString();
    await atomicWriteJson(checkpointPath, checkpoint);
  }

  const report = reportFromCheckpoint(prepared, checkpoint, now());
  await atomicWriteJson(reportPath, report);
  return report;
}

export async function runExtractionEvaluation(
  options: RunExtractionEvaluationOptions,
  dependencies: ExtractionEvaluationDependencies = defaultDependencies,
): Promise<ExtractionEvaluationReport> {
  const now = options.now ?? (() => new Date());
  const repositoryRoot = options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT;
  const prepared = await prepareExtractionEvaluation(options.manifestPath, repositoryRoot);
  if (
    prepared.dataset.kind === "production_redacted" &&
    !prepared.claimReadiness.eligibleForProductionClaim
  ) {
    throw new Error(
      `Production-redacted evaluation is not claim-ready; no provider calls were made. ` +
      prepared.claimReadiness.claimBlockers.join(" "),
    );
  }
  dependencies.assertRuntimeReady();
  const outputDirectory = await ensurePrivateOutputDirectory(
    options.outputDirectory,
    repositoryRoot,
  );
  const outputFiles = [
    path.join(outputDirectory, "checkpoint.json"),
    path.join(outputDirectory, "report.json"),
  ];
  const inputFiles = new Set([
    prepared.manifestAbsolutePath,
    prepared.datasetAbsolutePath,
    ...prepared.cases.map((item) => item.sourceAbsolutePath),
  ]);
  if (outputFiles.some((filePath) => inputFiles.has(filePath))) {
    throw new Error("Evaluation output files must not overlap the manifest, labels, or sources");
  }
  const releaseLock = await acquireEvaluationLock(outputDirectory);
  try {
    return await runLockedExtractionEvaluation(
      prepared,
      outputDirectory,
      options,
      dependencies,
      now,
    );
  } finally {
    await releaseLock();
  }
}
