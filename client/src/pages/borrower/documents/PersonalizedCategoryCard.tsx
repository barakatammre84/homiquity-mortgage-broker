import { CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { DocRow } from "@/components/DocumentItemRow";
import type { ChecklistItemView } from "@/lib/documentChecklist";
import { CONDITION_CATEGORY_META } from "../documentCategories";
import { ChecklistRows } from "./ChecklistRows";
import type { UploadControls } from "./types";

export function personalizedCategoryDescription(
  categoryId: string,
  items: Pick<ChecklistItemView, "documentType" | "acceptedTypes">[],
): string {
  const requestedTypes = new Set(
    items.flatMap((item) => [item.documentType, ...(item.acceptedTypes ?? [])]),
  );

  const hasSelfEmployedEvidence = [
    "tax_return",
    "tax_return_1040",
    "profit_loss",
    "profit_loss_statement",
    "business_license",
  ].some((type) => requestedTypes.has(type));
  const hasEmployeeEvidence = ["pay_stub", "paystub", "w2"].some((type) =>
    requestedTypes.has(type),
  );

  if (categoryId === "income" && hasSelfEmployedEvidence && !hasEmployeeEvidence) {
    return "Tax returns, profit and loss statements, and business records";
  }

  return CONDITION_CATEGORY_META[categoryId].description;
}

/** A category of the pipeline-driven personalized checklist. */
export function PersonalizedCategoryCard({
  categoryId,
  items,
  rowFromItem,
  upload,
}: {
  categoryId: string;
  items: ChecklistItemView[];
  rowFromItem: (item: ChecklistItemView) => DocRow;
  upload: UploadControls;
}) {
  const meta = CONDITION_CATEGORY_META[categoryId];
  const CategoryIcon = meta.icon;
  const pendingInGroup = items.filter(
    (i) => i.status === "needed" || i.status === "rejected",
  ).length;
  const description = personalizedCategoryDescription(categoryId, items);

  return (
    <Card className="shadow-lg border-0" data-testid={`card-category-${categoryId}`}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`p-3 rounded-lg ${meta.bgColor}`}>
              <CategoryIcon className={`h-5 w-5 ${meta.color}`} />
            </div>
            <div>
              <CardTitle className="flex items-center gap-2">
                {meta.name}
                {pendingInGroup === 0 && (
                  <CheckCircle2 className="h-5 w-5 text-success-subtle-foreground" />
                )}
              </CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>
          <Badge
            className={
              pendingInGroup === 0
                ? "bg-success-subtle text-success-subtle-foreground"
                : "bg-warning-subtle text-warning-subtle-foreground"
            }
          >
            {pendingInGroup === 0 ? "Complete" : `${pendingInGroup} needed`}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="border-t pt-4">
          <ChecklistRows
            rows={items.map((item) => ({ key: item.id, row: rowFromItem(item) }))}
            upload={upload}
          />
        </div>
      </CardContent>
    </Card>
  );
}
