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
  cases: ExtractionBenchmarkCase[];
}

export interface ExtractionBenchmarkPredictions {
  datasetId: string;
  datasetVersion: string;
  modelId: string;
  promptVersion: string;
  cases: ExtractionBenchmarkCase[];
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
  eligibleForProductionClaim: boolean;
  claimBlockers: string[];
  overall: ExtractionBenchmarkMetrics;
  byDocumentType: Record<string, ExtractionBenchmarkMetrics>;
  bySituationTag: Record<string, ExtractionBenchmarkMetrics>;
}

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

  const claimBlockers: string[] = [];
  if (dataset.kind !== "production_redacted") {
    claimBlockers.push("The dataset is synthetic; it cannot support a production accuracy claim.");
  }
  const underrepresented = [...byDocumentType.entries()]
    .filter(([, value]) => value.cases < 30)
    .map(([type, value]) => `${type} (${value.cases}/30)`);
  if (underrepresented.length > 0) {
    claimBlockers.push(`Document types need at least 30 human-labeled cases: ${underrepresented.join(", ")}.`);
  }

  return {
    datasetId: dataset.datasetId,
    datasetVersion: dataset.version,
    datasetKind: dataset.kind,
    modelId: predictions.modelId,
    promptVersion: predictions.promptVersion,
    eligibleForProductionClaim: claimBlockers.length === 0,
    claimBlockers,
    overall: metrics(overall),
    byDocumentType: Object.fromEntries([...byDocumentType].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, metrics(value)])),
    bySituationTag: Object.fromEntries([...bySituationTag].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, metrics(value)])),
  };
}
