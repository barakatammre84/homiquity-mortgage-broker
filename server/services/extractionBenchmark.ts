/**
 * Versioned extraction benchmark scorer.
 *
 * Model confidence is a routing hint. This scorer measures predictions against
 * human-labeled truth across the failure modes that matter to a mortgage file:
 * exact value, omissions, hallucinated fields, source-page attribution and
 * logical-document boundaries. It is pure so a redacted evaluation set can be
 * scored in CI without database or provider access.
 */

export type BenchmarkImpact = "critical" | "standard";

export interface BenchmarkField {
  value: string | number | boolean | null;
  pageNumber: number;
  impact?: BenchmarkImpact;
}

export interface BenchmarkLogicalDocument {
  documentType: string;
  pageStart: number;
  pageEnd: number;
}

export interface ExtractionBenchmarkCase {
  caseId: string;
  documentType: string;
  situationTags: string[];
  pageCount: number;
  fields: Record<string, BenchmarkField>;
  logicalDocuments: BenchmarkLogicalDocument[];
}

export interface ExtractionBenchmarkDataset {
  datasetId: string;
  version: string;
  kind: "synthetic" | "production_redacted";
  /**
   * A digest of the private source manifest, never the source documents. It
   * binds labels and predictions to one immutable evaluation population.
   */
  labeling?: {
    protocolVersion: string;
    reviewerCount: number;
    independentlyReviewed: boolean;
    adjudicated: boolean;
    manifestSha256: string;
  };
  /** The exact segments a published accuracy statement is allowed to name. */
  claimScope?: {
    documentTypes: string[];
    situationTags: string[];
  };
  /** Quality targets approved before a run is scored. */
  acceptanceThresholds?: ExtractionBenchmarkAcceptanceThresholds;
  cases: ExtractionBenchmarkCase[];
}

export interface ExtractionBenchmarkPredictions {
  datasetId: string;
  datasetVersion: string;
  datasetManifestSha256?: string;
  modelId: string;
  promptVersion: string;
  cases: ExtractionBenchmarkCase[];
}

export interface ExtractionBenchmarkAcceptanceThresholds {
  valuePrecision: number;
  valueRecall: number;
  pageAttributionAccuracy: number;
  documentTypeAccuracy: number;
  boundaryPrecision: number;
  boundaryRecall: number;
  businessWeightedFieldAccuracy: number;
}

export interface ExtractionBenchmarkMetrics {
  cases: number;
  expectedFields: number;
  predictedFields: number;
  correctValues: number;
  missedFields: number;
  falseFields: number;
  correctSourcePages: number;
  correctDocumentTypes: number;
  expectedLogicalDocuments: number;
  predictedLogicalDocuments: number;
  exactLogicalDocuments: number;
  falseLogicalDocuments: number;
  valuePrecision: number;
  valueRecall: number;
  pageAttributionAccuracy: number;
  documentTypeAccuracy: number;
  boundaryPrecision: number;
  boundaryRecall: number;
  boundaryAccuracy: number;
  businessWeightedFieldAccuracy: number;
}

export interface ExtractionBenchmarkReport {
  datasetId: string;
  datasetVersion: string;
  datasetKind: ExtractionBenchmarkDataset["kind"];
  modelId: string;
  promptVersion: string;
  evidenceEligibleForProductionClaim: boolean;
  meetsAcceptanceThresholds: boolean;
  eligibleForProductionClaim: boolean;
  claimScope: {
    documentTypes: string[];
    situationTags: string[];
  };
  thresholdFailures: string[];
  claimBlockers: string[];
  overall: ExtractionBenchmarkMetrics;
  byDocumentType: Record<string, ExtractionBenchmarkMetrics>;
  bySituationTag: Record<string, ExtractionBenchmarkMetrics>;
}

const MINIMUM_HUMAN_LABELED_CASES = 30;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const THRESHOLD_METRICS = [
  "valuePrecision",
  "valueRecall",
  "pageAttributionAccuracy",
  "documentTypeAccuracy",
  "boundaryPrecision",
  "boundaryRecall",
  "businessWeightedFieldAccuracy",
] as const satisfies ReadonlyArray<keyof ExtractionBenchmarkAcceptanceThresholds>;

interface ScoreAccumulator {
  cases: number;
  expectedFields: number;
  predictedFields: number;
  correctValues: number;
  missedFields: number;
  falseFields: number;
  correctSourcePages: number;
  correctDocumentTypes: number;
  expectedLogicalDocuments: number;
  predictedLogicalDocuments: number;
  exactLogicalDocuments: number;
  falseLogicalDocuments: number;
  weightedCorrect: number;
  weightedTotal: number;
}

const emptyScore = (): ScoreAccumulator => ({
  cases: 0,
  expectedFields: 0,
  predictedFields: 0,
  correctValues: 0,
  missedFields: 0,
  falseFields: 0,
  correctSourcePages: 0,
  correctDocumentTypes: 0,
  expectedLogicalDocuments: 0,
  predictedLogicalDocuments: 0,
  exactLogicalDocuments: 0,
  falseLogicalDocuments: 0,
  weightedCorrect: 0,
  weightedTotal: 0,
});

const ratio = (numerator: number, denominator: number): number =>
  denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));

function normalizedValue(value: BenchmarkField["value"]): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(Number(value.toFixed(4))) : "invalid";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  return value.trim().replace(/[$,%\s]/g, "").toLowerCase();
}

function exactBoundaryKey(document: BenchmarkLogicalDocument): string {
  return `${document.documentType}:${document.pageStart}-${document.pageEnd}`;
}

function validateCase(item: ExtractionBenchmarkCase, label: string): void {
  if (!item.caseId?.trim() || !item.documentType?.trim()) throw new Error(`${label} needs a case id and document type`);
  if (!Number.isInteger(item.pageCount) || item.pageCount < 1) throw new Error(`${label} has an invalid page count`);
  for (const [name, field] of Object.entries(item.fields ?? {})) {
    if (!name.trim() || !Number.isInteger(field.pageNumber) || field.pageNumber < 1 || field.pageNumber > item.pageCount) {
      throw new Error(`${label} field ${name || "(blank)"} has an invalid source page`);
    }
  }
  for (const logical of item.logicalDocuments ?? []) {
    if (
      !logical.documentType?.trim() ||
      !Number.isInteger(logical.pageStart) ||
      !Number.isInteger(logical.pageEnd) ||
      logical.pageStart < 1 ||
      logical.pageEnd < logical.pageStart ||
      logical.pageEnd > item.pageCount
    ) {
      throw new Error(`${label} has an invalid logical-document boundary`);
    }
  }
}

function addCase(
  score: ScoreAccumulator,
  truth: ExtractionBenchmarkCase,
  prediction: ExtractionBenchmarkCase | undefined,
): void {
  score.cases += 1;
  if (prediction?.documentType === truth.documentType) score.correctDocumentTypes += 1;
  const predictedFields = prediction?.fields ?? {};
  score.expectedFields += Object.keys(truth.fields).length;
  score.predictedFields += Object.keys(predictedFields).length;

  for (const [name, expected] of Object.entries(truth.fields)) {
    const weight = expected.impact === "critical" ? 3 : 1;
    score.weightedTotal += weight;
    const actual = predictedFields[name];
    if (!actual) {
      score.missedFields += 1;
      continue;
    }
    if (normalizedValue(actual.value) === normalizedValue(expected.value)) {
      score.correctValues += 1;
      score.weightedCorrect += weight;
      if (actual.pageNumber === expected.pageNumber) score.correctSourcePages += 1;
    }
  }

  for (const [name, actual] of Object.entries(predictedFields)) {
    if (truth.fields[name]) continue;
    score.falseFields += 1;
    score.weightedTotal += actual.impact === "critical" ? 3 : 1;
  }

  const predictedBoundaries = new Set((prediction?.logicalDocuments ?? []).map(exactBoundaryKey));
  const truthBoundaries = new Set(truth.logicalDocuments.map(exactBoundaryKey));
  score.expectedLogicalDocuments += truth.logicalDocuments.length;
  score.predictedLogicalDocuments += predictedBoundaries.size;
  score.exactLogicalDocuments += truth.logicalDocuments.filter((item) =>
    predictedBoundaries.has(exactBoundaryKey(item)),
  ).length;
  score.falseLogicalDocuments += [...predictedBoundaries].filter((key) => !truthBoundaries.has(key)).length;
}

function mergeScore(target: ScoreAccumulator, source: ScoreAccumulator): void {
  for (const key of Object.keys(target) as Array<keyof ScoreAccumulator>) target[key] += source[key];
}

function metrics(score: ScoreAccumulator): ExtractionBenchmarkMetrics {
  return {
    cases: score.cases,
    expectedFields: score.expectedFields,
    predictedFields: score.predictedFields,
    correctValues: score.correctValues,
    missedFields: score.missedFields,
    falseFields: score.falseFields,
    correctSourcePages: score.correctSourcePages,
    correctDocumentTypes: score.correctDocumentTypes,
    expectedLogicalDocuments: score.expectedLogicalDocuments,
    predictedLogicalDocuments: score.predictedLogicalDocuments,
    exactLogicalDocuments: score.exactLogicalDocuments,
    falseLogicalDocuments: score.falseLogicalDocuments,
    valuePrecision: ratio(score.correctValues, score.predictedFields),
    valueRecall: ratio(score.correctValues, score.expectedFields),
    pageAttributionAccuracy: ratio(score.correctSourcePages, score.correctValues),
    documentTypeAccuracy: ratio(score.correctDocumentTypes, score.cases),
    boundaryPrecision: ratio(score.exactLogicalDocuments, score.predictedLogicalDocuments),
    boundaryRecall: ratio(score.exactLogicalDocuments, score.expectedLogicalDocuments),
    boundaryAccuracy: ratio(score.exactLogicalDocuments, score.expectedLogicalDocuments),
    businessWeightedFieldAccuracy: ratio(score.weightedCorrect, score.weightedTotal),
  };
}

function normalizedScope(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))].sort();
}

function validateThresholds(
  thresholds: ExtractionBenchmarkAcceptanceThresholds | undefined,
): void {
  if (!thresholds) return;
  for (const metric of THRESHOLD_METRICS) {
    const value = thresholds[metric];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`Benchmark acceptance threshold ${metric} must be between 0 and 1`);
    }
  }
}

function thresholdFailuresFor(
  label: string,
  actual: ExtractionBenchmarkMetrics,
  thresholds: ExtractionBenchmarkAcceptanceThresholds,
): string[] {
  return THRESHOLD_METRICS.flatMap((metric) =>
    actual[metric] < thresholds[metric]
      ? [`${label} ${metric} ${actual[metric].toFixed(4)} is below ${thresholds[metric].toFixed(4)}.`]
      : [],
  );
}

export function scoreExtractionBenchmark(
  dataset: ExtractionBenchmarkDataset,
  predictions: ExtractionBenchmarkPredictions,
): ExtractionBenchmarkReport {
  if (dataset.datasetId !== predictions.datasetId || dataset.version !== predictions.datasetVersion) {
    throw new Error("Predictions do not match the benchmark dataset id and version");
  }
  if (!dataset.datasetId?.trim() || !dataset.version?.trim() || !predictions.modelId?.trim() || !predictions.promptVersion?.trim()) {
    throw new Error("Benchmark identity, version, model and prompt are required");
  }
  validateThresholds(dataset.acceptanceThresholds);
  if (
    dataset.labeling?.manifestSha256 &&
    predictions.datasetManifestSha256 &&
    dataset.labeling.manifestSha256 !== predictions.datasetManifestSha256
  ) {
    throw new Error("Predictions do not match the benchmark dataset manifest");
  }
  dataset.cases.forEach((item) => validateCase(item, `Benchmark case ${item.caseId || "(blank)"}`));
  predictions.cases.forEach((item) => validateCase(item, `Prediction case ${item.caseId || "(blank)"}`));
  const truthIds = new Set(dataset.cases.map((item) => item.caseId));
  if (truthIds.size !== dataset.cases.length) throw new Error("Benchmark case ids must be unique");
  const predictionById = new Map(predictions.cases.map((item) => [item.caseId, item]));
  if (predictionById.size !== predictions.cases.length) throw new Error("Prediction case ids must be unique");
  const unknown = predictions.cases.find((item) => !truthIds.has(item.caseId));
  if (unknown) throw new Error(`Prediction case ${unknown.caseId} is not in the benchmark dataset`);

  const overall = emptyScore();
  const byDocumentType = new Map<string, ScoreAccumulator>();
  const bySituationTag = new Map<string, ScoreAccumulator>();
  for (const truth of dataset.cases) {
    const caseScore = emptyScore();
    addCase(caseScore, truth, predictionById.get(truth.caseId));
    mergeScore(overall, caseScore);
    const typeScore = byDocumentType.get(truth.documentType) ?? emptyScore();
    mergeScore(typeScore, caseScore);
    byDocumentType.set(truth.documentType, typeScore);
    for (const tag of new Set(truth.situationTags)) {
      const tagScore = bySituationTag.get(tag) ?? emptyScore();
      mergeScore(tagScore, caseScore);
      bySituationTag.set(tag, tagScore);
    }
  }

  const scoredOverall = metrics(overall);
  const scoredByDocumentType = Object.fromEntries(
    [...byDocumentType].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, metrics(value)]),
  );
  const scoredBySituationTag = Object.fromEntries(
    [...bySituationTag].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, metrics(value)]),
  );
  const claimScope = {
    documentTypes: normalizedScope(dataset.claimScope?.documentTypes),
    situationTags: normalizedScope(dataset.claimScope?.situationTags),
  };
  const evidenceBlockers: string[] = [];
  if (dataset.kind !== "production_redacted") {
    evidenceBlockers.push("The dataset is synthetic; it cannot support a production accuracy claim.");
  }
  const labeling = dataset.labeling;
  if (
    typeof labeling?.protocolVersion !== "string" ||
    !labeling.protocolVersion.trim() ||
    !Number.isInteger(labeling.reviewerCount) ||
    labeling.reviewerCount < 2 ||
    !labeling.independentlyReviewed ||
    !labeling.adjudicated ||
    typeof labeling.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(labeling.manifestSha256)
  ) {
    evidenceBlockers.push(
      "Labels need a versioned protocol, two independent reviewers, adjudication, and a valid private-manifest SHA-256.",
    );
  }
  if (labeling?.manifestSha256 && predictions.datasetManifestSha256 !== labeling.manifestSha256) {
    evidenceBlockers.push("Predictions are not bound to the labeled dataset manifest SHA-256.");
  }
  if (claimScope.documentTypes.length === 0) {
    evidenceBlockers.push("The production claim must name at least one document type.");
  }
  if (claimScope.situationTags.length === 0) {
    evidenceBlockers.push("A complex-borrower claim must name at least one situation tag.");
  }
  const underrepresentedDocuments = claimScope.documentTypes
    .map((type) => [type, scoredByDocumentType[type]?.cases ?? 0] as const)
    .filter(([, count]) => count < MINIMUM_HUMAN_LABELED_CASES)
    .map(([type, count]) => `${type} (${count}/${MINIMUM_HUMAN_LABELED_CASES})`);
  if (underrepresentedDocuments.length > 0) {
    evidenceBlockers.push(
      `Claimed document types need at least 30 human-labeled cases: ${underrepresentedDocuments.join(", ")}.`,
    );
  }
  const underrepresentedSituations = claimScope.situationTags
    .map((tag) => [tag, scoredBySituationTag[tag]?.cases ?? 0] as const)
    .filter(([, count]) => count < MINIMUM_HUMAN_LABELED_CASES)
    .map(([tag, count]) => `${tag} (${count}/${MINIMUM_HUMAN_LABELED_CASES})`);
  if (underrepresentedSituations.length > 0) {
    evidenceBlockers.push(
      `Claimed complex situations need at least 30 human-labeled cases: ${underrepresentedSituations.join(", ")}.`,
    );
  }

  const thresholdFailures: string[] = [];
  if (!dataset.acceptanceThresholds) {
    thresholdFailures.push("Pre-approved acceptance thresholds are required before scoring a production claim.");
  } else {
    thresholdFailures.push(...thresholdFailuresFor("Overall", scoredOverall, dataset.acceptanceThresholds));
    for (const type of claimScope.documentTypes) {
      const segment = scoredByDocumentType[type];
      if (segment) thresholdFailures.push(...thresholdFailuresFor(`Document type ${type}`, segment, dataset.acceptanceThresholds));
    }
    for (const tag of claimScope.situationTags) {
      const segment = scoredBySituationTag[tag];
      if (segment) thresholdFailures.push(...thresholdFailuresFor(`Situation ${tag}`, segment, dataset.acceptanceThresholds));
    }
  }
  const evidenceEligibleForProductionClaim = evidenceBlockers.length === 0;
  const meetsAcceptanceThresholds = Boolean(dataset.acceptanceThresholds) && thresholdFailures.length === 0;
  const claimBlockers = [...evidenceBlockers, ...thresholdFailures];

  return {
    datasetId: dataset.datasetId,
    datasetVersion: dataset.version,
    datasetKind: dataset.kind,
    modelId: predictions.modelId,
    promptVersion: predictions.promptVersion,
    evidenceEligibleForProductionClaim,
    meetsAcceptanceThresholds,
    eligibleForProductionClaim: evidenceEligibleForProductionClaim && meetsAcceptanceThresholds,
    claimScope,
    thresholdFailures,
    claimBlockers,
    overall: scoredOverall,
    byDocumentType: scoredByDocumentType,
    bySituationTag: scoredBySituationTag,
  };
}
