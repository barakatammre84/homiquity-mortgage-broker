import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const useQuery = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery };
});
vi.mock("@/components/coach/useCoachStream", () => ({
  useCoachStream: () => ({
    turn: {
      status: "idle",
      pendingUserMessage: null,
      streamingText: "",
      captured: [],
      panel: {
        documentChecklist: [{
          id: "condition-tax",
          source: "condition",
          conditionId: "condition-tax",
          category: "income",
          documentType: "tax_return",
          acceptedTypes: ["tax_return"],
          label: "Complete personal tax return",
          required: true,
          status: "needed",
        }],
      },
      lintReplaced: false,
      degraded: false,
      error: null,
    },
    send,
    retry: vi.fn(),
    dismissError: vi.fn(),
    isBusy: false,
  }),
}));
vi.mock("@/components/coach/MessageList", () => ({ MessageList: () => <div /> }));
vi.mock("@/components/coach/Composer", () => ({ Composer: () => <div /> }));
vi.mock("@/components/coach/panels", () => ({
  DocumentChecklistInline: ({ applicationId }: { applicationId?: string | null }) => (
    <button data-testid="button-upload-tax_return" data-application-id={applicationId ?? ""}>Upload</button>
  ),
  DocumentEvidencePanel: () => <div />,
}));

import HomiDock from "./HomiDock";

describe("HomiDock", () => {
  it("renders the real inline upload action against the connected application", () => {
    useQuery.mockImplementation(({ queryKey }: { queryKey: readonly string[] }) => {
      if (queryKey[0] === "/api/coach/context") {
        return { data: { applicationId: "app-current", documentChecklist: [] } };
      }
      return { data: undefined };
    });

    render(<HomiDock open onClose={vi.fn()} />);

    expect(screen.getByTestId("homi-dock-document-checklist")).toBeTruthy();
    expect(screen.getByTestId("button-upload-tax_return").getAttribute("data-application-id"))
      .toBe("app-current");
  });
});
