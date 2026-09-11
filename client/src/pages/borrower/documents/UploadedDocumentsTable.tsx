import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DocumentList, type DocumentGroup } from "@/components/patterns/DocumentList";
import { formatDate } from "@/lib/formatters";
import type { Document } from "@shared/schema";
import { DOCUMENT_CATEGORIES, docTypeName } from "../documentCategories";

// The borrower's uploaded-documents vault, on the DocumentList pattern
// (knowledge-base/handbook/design/DESIGN_SYSTEM.md §13). Titles resolve through the catalog's own
// docTypeName map — the data layer's naming, never a view-side
// `replace(/_/g, " ")` — rows group by the catalog's categories, dates read as
// plain English ("You uploaded on …"), a rejection's reason rides the row, and
// the filename is secondary metadata rather than a column.

const CATEGORY_OF: Record<string, string> = Object.fromEntries(
  DOCUMENT_CATEGORIES.flatMap((cat) => cat.documents.map((d) => [d.type, cat.name])),
);

export function UploadedDocumentsTable({
  documents,
  title = "All Uploaded Documents",
  scopeLabel = "in your file",
}: {
  documents: Document[];
  title?: string;
  scopeLabel?: string;
}) {
  const titles = Object.fromEntries(
    documents.map((d) => [d.documentType, docTypeName(d.documentType)]),
  );

  const groupOrder: string[] = [];
  const byCategory = new Map<string, Document[]>();
  for (const doc of documents) {
    const label = CATEGORY_OF[doc.documentType] ?? "Other documents";
    if (!byCategory.has(label)) {
      byCategory.set(label, []);
      groupOrder.push(label);
    }
    byCategory.get(label)!.push(doc);
  }

  const groups: DocumentGroup[] = groupOrder.map((label) => ({
    label,
    documents: byCategory.get(label)!.map((doc) => ({
      id: doc.id,
      slug: doc.documentType,
      status: doc.status,
      fileName: doc.fileName ?? undefined,
      date: { verb: "You uploaded", on: formatDate(doc.createdAt) },
      note:
        doc.status === "rejected" && doc.rejectionReason
          ? { text: doc.rejectionReason, tone: "destructive" as const }
          : undefined,
      action: (
        <Button
          size="sm"
          variant="ghost"
          className="touch-target gap-2"
          data-testid={`button-download-doc-${doc.id}`}
          onClick={() => window.open(`/api/documents/${doc.id}/download`, "_blank")}
        >
          <Download className="h-4 w-4" />
          <span className="hidden sm:inline">Download</span>
        </Button>
      ),
    })),
  }));

  return (
    <Card className="mt-8" data-testid="card-all-documents">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          {title}
        </CardTitle>
        <CardDescription>
          {documents.length} document{documents.length !== 1 ? "s" : ""} {scopeLabel}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DocumentList groups={groups} titles={titles} data-testid="uploaded-documents" />
      </CardContent>
    </Card>
  );
}
