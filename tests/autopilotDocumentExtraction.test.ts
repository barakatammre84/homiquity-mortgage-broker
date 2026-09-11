import { afterEach, describe, expect, it } from "vitest";
import { extractAutopilotDocument } from "../server/services/autopilot/orchestrator";

const priorSimulation = process.env.EXTRACTION_SIMULATE;

afterEach(() => {
  if (priorSimulation === undefined) delete process.env.EXTRACTION_SIMULATE;
  else process.env.EXTRACTION_SIMULATE = priorSimulation;
});

describe("Autopilot document extraction coverage", () => {
  it("extracts a P&L instead of acknowledging it without analysis", async () => {
    process.env.EXTRACTION_SIMULATE = "true";
    const outcome = await extractAutopilotDocument(
      "profit_loss",
      "/tmp/synthetic-pnl-fixture.pdf",
      "application/pdf",
    );

    expect(outcome?.extracted).toMatchObject({
      confidence: "medium",
      documentClassification: {
        pages: [{ documentType: "profit_loss_statement" }],
      },
    });
    expect(outcome?.highlights).toEqual(expect.arrayContaining([
      expect.stringContaining("Business:"),
      expect.stringContaining("YTD net profit or loss:"),
    ]));
  });

  it("never exposes a tax-return reader outside the consent-gated tax lane", async () => {
    process.env.EXTRACTION_SIMULATE = "true";
    await expect(extractAutopilotDocument(
      "tax_return_1040",
      "/tmp/tax-return.pdf",
      "application/pdf",
    )).resolves.toBeNull();
  });
});
