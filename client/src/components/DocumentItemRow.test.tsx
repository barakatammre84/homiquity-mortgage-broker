import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DocumentItemRow, type DocRow } from "./DocumentItemRow";

// Borrower Clarity PR 2: the checklist row can now say WHICH year's document
// is needed and relay the staff-authored instructions — contextual document
// requests instead of a bare type name. Year and instructions are optional:
// rows without them must render exactly as before.

const baseRow: DocRow = {
  key: "tax_return",
  uploadKey: "t-1",
  uploadType: "tax_return",
  name: "Tax Returns",
  required: true,
  status: "needed",
};

function renderRow(row: DocRow) {
  return render(
    <DocumentItemRow
      row={row}
      uploading={false}
      uploadingFile={null}
      progress={0}
      anyUploadBusy={false}
      onFile={vi.fn()}
      onBrowse={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
}

describe("DocumentItemRow — year + instructions context", () => {
  it("reserves Complete for verified evidence", () => {
    const { rerender } = renderRow({ ...baseRow, status: "verifying", fileName: "return.pdf" });
    expect(screen.getByText("Submitted")).toBeTruthy();
    expect(screen.queryByText("Complete")).toBeNull();

    rerender(
      <DocumentItemRow
        row={{ ...baseRow, status: "verified", fileName: "return.pdf" }}
        uploading={false}
        uploadingFile={null}
        progress={0}
        anyUploadBusy={false}
        onFile={vi.fn()}
        onBrowse={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Complete")).toBeTruthy();
  });

  it("shows the document year beside the name when the request names one", () => {
    renderRow({ ...baseRow, year: "2023" });
    const year = screen.getByTestId("text-doc-year-tax_return");
    expect(year.textContent).toContain("2023");
  });

  it("renders the staff-authored instructions line", () => {
    renderRow({
      ...baseRow,
      instructions: "Please upload all pages of your 2023 federal return.",
    });
    const instructions = screen.getByTestId("text-doc-instructions-tax_return");
    expect(instructions.textContent).toBe(
      "Please upload all pages of your 2023 federal return.",
    );
  });

  it("renders neither node when the request has no year or instructions", () => {
    renderRow(baseRow);
    expect(screen.queryByTestId("text-doc-year-tax_return")).toBeNull();
    expect(screen.queryByTestId("text-doc-instructions-tax_return")).toBeNull();
  });

  it("keeps year and instructions visible on a rejected row (the re-upload moment)", () => {
    renderRow({
      ...baseRow,
      year: "2023",
      instructions: "Include all schedules.",
      status: "rejected",
      fileName: "return.pdf",
      rejectionReason: "Missing Schedule C",
    });
    expect(screen.getByTestId("text-doc-year-tax_return").textContent).toContain("2023");
    expect(screen.getByTestId("text-doc-instructions-tax_return").textContent).toBe(
      "Include all schedules.",
    );
    expect(screen.getByTestId("text-reject-reason-tax_return").textContent).toContain(
      "Missing Schedule C",
    );
  });
});
