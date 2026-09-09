import { readFileSync } from "node:fs";
import {
  scoreExtractionBenchmark,
  type ExtractionBenchmarkDataset,
  type ExtractionBenchmarkPredictions,
} from "../server/services/extractionBenchmark";

const [datasetPath, predictionsPath] = process.argv.slice(2);
if (!datasetPath || !predictionsPath) {
  console.error("Usage: pnpm benchmark:extraction <ground-truth.json> <predictions.json>");
  process.exit(2);
}

const dataset = JSON.parse(readFileSync(datasetPath, "utf8")) as ExtractionBenchmarkDataset;
const predictions = JSON.parse(readFileSync(predictionsPath, "utf8")) as ExtractionBenchmarkPredictions;
console.log(JSON.stringify(scoreExtractionBenchmark(dataset, predictions), null, 2));
