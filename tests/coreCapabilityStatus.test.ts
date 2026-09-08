import { describe, expect, it } from "vitest";
import {
  getCoreCapabilityReport,
  type CoreCapabilityReport,
} from "../server/services/coreCapabilityStatus";

function capability(report: CoreCapabilityReport, id: string) {
  return report.capabilities.find((item) => item.id === id)!;
}

describe("getCoreCapabilityReport", () => {
  it("does not call an incomplete production mortgage stack ready", () => {
    const report = getCoreCapabilityReport(
      { NODE_ENV: "production" },
      new Date("2026-09-08T12:00:00.000Z"),
    );

    expect(report.readyForLiveLoanLifecycle).toBe(false);
    expect(capability(report, "underwriting_engine").state).toBe("live");
    expect(capability(report, "financial_analysis").state).toBe("live");
    expect(capability(report, "document_extraction").state).toBe("disabled");
    expect(capability(report, "object_storage").state).toBe("disabled");
    expect(capability(report, "credit").state).toBe("disabled");
    expect(capability(report, "du").state).toBe("simulated");
    expect(capability(report, "lpa").state).toBe("simulated");
    expect(capability(report, "lender_delivery").state).toBe("simulated");
    expect(report.generatedAt).toBe("2026-09-08T12:00:00.000Z");
  });

  it("separates Homi and extraction credentials and labels simulations", () => {
    const extractionOnly = getCoreCapabilityReport({
      NODE_ENV: "development",
      AI_INTEGRATIONS_ANTHROPIC_API_KEY: "extract-key",
      EXTRACTION_SIMULATE: "true",
      CREDIT_VENDOR_MODE: "simulation",
    });
    expect(capability(extractionOnly, "homi").state).toBe("disabled");
    expect(capability(extractionOnly, "document_extraction").state).toBe("live");
    expect(capability(extractionOnly, "credit").state).toBe("simulated");

    const simulationOnly = getCoreCapabilityReport({
      NODE_ENV: "development",
      EXTRACTION_SIMULATE: "true",
    });
    expect(capability(simulationOnly, "document_extraction").state).toBe("simulated");
  });

  it("surfaces contradictory or incomplete provider configuration", () => {
    const report = getCoreCapabilityReport({
      NODE_ENV: "production",
      PRIVATE_OBJECT_DIR: "/bucket/private",
      GCS_SERVICE_ACCOUNT_KEY: "{bad json",
      PLAID_CLIENT_ID: "id-only",
      CREDIT_VENDOR_API_KEY: "provenance-without-adapter",
      FANNIE_DU_API_KEY: "not-implemented",
      FREDDIE_LPA_API_KEY: "not-implemented",
    });

    expect(capability(report, "object_storage").state).toBe("configuration_error");
    expect(capability(report, "plaid_verification").state).toBe("configuration_error");
    expect(capability(report, "credit").state).toBe("configuration_error");
    expect(capability(report, "du").state).toBe("configuration_error");
    expect(capability(report, "lpa").state).toBe("configuration_error");
  });

  it("never exposes credential values and does not invent verification dates", () => {
    const secret = "top-secret-value";
    const report = getCoreCapabilityReport({
      NODE_ENV: "production",
      ANTHROPIC_API_KEY: secret,
      PRIVATE_OBJECT_DIR: "/bucket/private",
      GCS_SERVICE_ACCOUNT_KEY: JSON.stringify({
        project_id: "project",
        client_email: "service@example.com",
        private_key: secret,
      }),
      PLAID_CLIENT_ID: "client",
      PLAID_SECRET: secret,
      PLAID_WEBHOOK_SECRET: secret,
    });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(secret);
    expect(report.capabilities.every((item) => item.lastSuccessfulVerificationAt === null)).toBe(true);
    expect(capability(report, "homi").state).toBe("live");
    expect(capability(report, "document_extraction").state).toBe("live");
    expect(capability(report, "object_storage").state).toBe("live");
    expect(capability(report, "plaid_verification").state).toBe("live");
  });
});
