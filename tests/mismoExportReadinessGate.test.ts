import { describe, expect, it } from "vitest";
import { mismoExportReadinessBlockers } from "../server/routes/lending/delivery";
import type { BrokerSubmissionReadiness } from "../server/services/brokerSubmissionReadiness";

function report(readyToSubmitToLender: boolean): BrokerSubmissionReadiness {
  return {
    applicationId: "app-1",
    readyToSubmitToLender,
    currentStage: "lenderPackage",
    nextActions: [],
    stages: [
      { key: "intake", label: "File intake & disclosures", status: "ready", blockers: [], warnings: [] },
      { key: "aus", label: "Automated underwriting", status: "ready", blockers: [], warnings: [] },
      {
        key: "lenderPackage",
        label: "Wholesale lender package",
        status: readyToSubmitToLender ? "ready" : "blocked",
        blockers: readyToSubmitToLender ? [] : ["Income review incomplete", "Required documents outstanding"],
        warnings: [],
      },
      { key: "deliveryPreflight", label: "Delivery pre-flight", status: "attention", blockers: [], warnings: ["Closing data pending"] },
    ],
  };
}

describe("manual MISMO export readiness gate", () => {
  it("returns the same lender-package blockers used by submission", () => {
    expect(mismoExportReadinessBlockers(report(false))).toEqual([
      "[Wholesale lender package] Income review incomplete",
      "[Wholesale lender package] Required documents outstanding",
    ]);
  });

  it("does not turn informational delivery warnings into blockers", () => {
    expect(mismoExportReadinessBlockers(report(true))).toEqual([]);
  });
});
