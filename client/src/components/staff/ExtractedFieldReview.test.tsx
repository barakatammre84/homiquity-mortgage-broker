import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExtractedFieldReview } from "./ExtractedFieldReview";

const { apiRequest, toast } = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/queryClient", () => ({ apiRequest }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

const response = {
  documentId: "doc-1",
  fields: [{
    id: "field-1",
    fieldName: "closing_balance",
    fieldCategory: "asset",
    valueType: "currency",
    value: 20_000,
    machineValue: 20_000,
    confidence: 0.91,
    pageNumber: 2,
    boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    humanVerified: false,
    humanCorrected: false,
    extractionMethod: "claude",
    modelVersion: "claude-sonnet-5",
  }],
};

function renderReview(onOpenSourcePage = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, queryFn: async () => response },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <ExtractedFieldReview
        documentId="doc-1"
        canReview
        onOpenSourcePage={onOpenSourcePage}
      />
    </QueryClientProvider>,
  );
  return { onOpenSourcePage };
}

describe("ExtractedFieldReview", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    toast.mockReset();
    apiRequest.mockImplementation(async (method: string) => ({
      json: async () => method === "GET"
        ? response
        : { documentId: "doc-1", fieldsCorrect: 0, fieldsCorrected: 1, fieldsMissed: 0 },
    }));
  });

  it("links a field to its source page and submits a human correction", async () => {
    const user = userEvent.setup();
    const { onOpenSourcePage } = renderReview();

    expect(await screen.findByText("Closing Balance")).toBeTruthy();
    expect(screen.getByText("91%")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Page 2" }));
    expect(onOpenSourcePage).toHaveBeenCalledWith(2);

    const input = screen.getByLabelText("Closing Balance");
    await user.clear(input);
    await user.type(input, "20500");
    await user.click(screen.getByRole("button", { name: "Save field review" }));

    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith(
      "POST",
      "/api/documents/doc-1/extracted-fields/review",
      {
        decisions: [{ fieldId: "field-1", action: "correct", correctedValue: "20500" }],
        missingFields: [],
      },
    ));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Field review saved" }));
  });
});
