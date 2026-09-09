import { describe, expect, it } from "vitest";
import {
  scoreExtractionBenchmark,
  type ExtractionBenchmarkDataset,
  type ExtractionBenchmarkPredictions,
} from "../server/services/extractionBenchmark";

const dataset: ExtractionBenchmarkDataset = {
  datasetId: "synthetic-sentinel",
  version: "1",
  kind: "synthetic",
  cases: [{
    caseId: "mixed-1",
    documentType: "mixed_packet",
    situationTags: ["w2_plus_business", "multi_document"],
    pageCount: 2,
    fields: {
      wages: { value: 82500, pageNumber: 1, impact: "critical" },
      employer: { value: "Northwind LLC", pageNumber: 1 },
      businessIncome: { value: 31000, pageNumber: 2, impact: "critical" },
    },
    logicalDocuments: [
      { documentType: "w2", pageStart: 1, pageEnd: 1 },
      { documentType: "schedule_c", pageStart: 2, pageEnd: 2 },
    ],
  }],
};

function predictions(): ExtractionBenchmarkPredictions {
  return {
    datasetId: dataset.datasetId,
    datasetVersion: dataset.version,
    modelId: "model-test",
    promptVersion: "prompt-test",
    cases: structuredClone(dataset.cases),
  };
}

describe("extraction benchmark", () => {
  it("scores values, source pages and boundaries independently", () => {
    const input = predictions();
    input.cases[0].fields.businessIncome.value = 30000;
    input.cases[0].fields.employer.pageNumber = 2;
    input.cases[0].fields.unexpected = { value: "invented", pageNumber: 2 };
    input.cases[0].logicalDocuments[1].pageStart = 1;

    const report = scoreExtractionBenchmark(dataset, input);
    expect(report.overall).toMatchObject({
      correctValues: 2,
      missedFields: 0,
      falseFields: 1,
      correctSourcePages: 1,
      correctDocumentTypes: 1,
      exactLogicalDocuments: 1,
      falseLogicalDocuments: 1,
      valueRecall: 0.6667,
      pageAttributionAccuracy: 0.5,
      documentTypeAccuracy: 1,
      boundaryPrecision: 0.5,
      boundaryRecall: 0.5,
      boundaryAccuracy: 0.5,
    });
    expect(report.overall.businessWeightedFieldAccuracy).toBe(0.5);
  });

  it("treats an absent prediction case as all fields and boundaries missed", () => {
    const input = predictions();
    input.cases = [];
    const report = scoreExtractionBenchmark(dataset, input);
    expect(report.overall.missedFields).toBe(3);
    expect(report.overall.valueRecall).toBe(0);
    expect(report.overall.boundaryAccuracy).toBe(0);
  });

  it("never permits a synthetic or under-sized set to support a production claim", () => {
    const report = scoreExtractionBenchmark(dataset, predictions());
    expect(report.eligibleForProductionClaim).toBe(false);
    expect(report.claimBlockers.join(" ")).toMatch(/synthetic/i);
    expect(report.claimBlockers.join(" ")).toMatch(/30 human-labeled/i);
  });

  it("rejects results for a different dataset version", () => {
    expect(() => scoreExtractionBenchmark(dataset, {
      ...predictions(),
      datasetVersion: "2",
    })).toThrow(/dataset id and version/i);
  });

  it("rejects impossible source pages before publishing misleading metrics", () => {
    const input = predictions();
    input.cases[0].fields.wages.pageNumber = 9;
    expect(() => scoreExtractionBenchmark(dataset, input)).toThrow(/invalid source page/i);
  });
});
