import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icons, iconSize } from "@/lib/icons";

interface ExtractedField {
  id: string;
  fieldName: string;
  fieldCategory: string | null;
  valueType: string;
  value: string | number | boolean | null;
  machineValue: string | number | boolean | null;
  confidence: number;
  pageNumber: number | null;
  boundingBox: unknown;
  humanVerified: boolean;
  humanCorrected: boolean;
  extractionMethod: string;
  modelVersion: string | null;
}

interface FieldResponse {
  documentId: string;
  fields: ExtractedField[];
}

interface MissingFieldDraft {
  id: string;
  fieldName: string;
  correctedValue: string;
  fieldCategory: "income" | "asset" | "identity" | "property";
  valueType: "currency" | "number" | "string" | "date" | "boolean";
  pageNumber: string;
}

const cleanLabel = (value: string) =>
  value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

const displayValue = (value: ExtractedField["value"], valueType: string) => {
  if (value === null || value === "") return "Not read";
  if (typeof value === "number" && valueType === "currency") {
    return value.toLocaleString(undefined, { style: "currency", currency: "USD" });
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
};

export function ExtractedFieldReview({
  documentId,
  canReview,
  onOpenSourcePage,
}: {
  documentId: string;
  canReview: boolean;
  onOpenSourcePage?: (pageNumber: number, boundingBox?: unknown, fieldLabel?: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [missingFields, setMissingFields] = useState<MissingFieldDraft[]>([]);

  const fieldsQuery = useQuery<FieldResponse>({
    queryKey: ["/api/documents", documentId, "extracted-fields"],
  });
  const fields = fieldsQuery.data?.fields ?? [];
  const unreviewed = useMemo(() => fields.filter((field) => !field.humanVerified), [fields]);

  const reviewMutation = useMutation({
    mutationFn: async () => {
      const decisions = unreviewed.map((field) => {
        const original = field.value === null ? "" : String(field.value);
        const edited = edits[field.id];
        return edited !== undefined && edited.trim() !== original
          ? { fieldId: field.id, action: "correct" as const, correctedValue: edited.trim() }
          : { fieldId: field.id, action: "confirm" as const };
      });
      const response = await apiRequest(
        "POST",
        `/api/documents/${documentId}/extracted-fields/review`,
        {
          decisions,
          missingFields: missingFields.map(({ id: _id, pageNumber, ...field }) => ({
            ...field,
            ...(pageNumber ? { pageNumber: Number(pageNumber) } : {}),
          })),
        },
      );
      return response.json();
    },
    onSuccess: () => {
      setEdits({});
      setMissingFields([]);
      queryClient.invalidateQueries({ queryKey: ["/api/documents", documentId, "extracted-fields"] });
      toast({
        title: "Field review saved",
        description: "Corrections now feed the file and extraction accuracy record.",
      });
    },
    onError: (error: Error) =>
      toast({ title: "Could not save field review", description: error.message, variant: "destructive" }),
  });

  if (fieldsQuery.isLoading) {
    return <p className="text-xs text-muted-foreground">Loading extracted values…</p>;
  }
  if (fieldsQuery.isError) {
    return (
      <p className="rounded-md bg-warning-subtle p-2 text-xs text-warning-subtle-foreground">
        Extracted values are unavailable or no longer authorized.
      </p>
    );
  }
  if (fields.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        No structured values are available yet. Run extraction or review the source manually.
      </p>
    );
  }

  const canSubmit =
    canReview &&
    (unreviewed.length > 0 || missingFields.length > 0) &&
    missingFields.every((field) => field.fieldName.trim() && field.correctedValue.trim());

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-3" data-testid="extracted-field-review">
      <div>
        <p className="text-sm font-medium">Extracted values</p>
        <p className="text-xs text-muted-foreground">
          Check each value against the source. Change anything the reader missed.
        </p>
      </div>

      <div className="space-y-2">
        {fields.map((field) => {
          const current = edits[field.id] ?? (field.value === null ? "" : String(field.value));
          return (
            <div key={field.id} className="rounded-md border bg-background p-2" data-testid={`field-review-${field.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor={`field-${field.id}`} className="text-xs font-medium">
                  {cleanLabel(field.fieldName)}
                </Label>
                <div className="flex items-center gap-1">
                  <Badge variant="secondary" className="no-default-hover-elevate text-xs">
                    {Math.round(field.confidence * 100)}%
                  </Badge>
                  {field.humanVerified && (
                    <Badge variant="secondary" className="no-default-hover-elevate bg-success-subtle text-success-subtle-foreground text-xs">
                      {field.humanCorrected ? "Corrected" : "Confirmed"}
                    </Badge>
                  )}
                  {field.pageNumber && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="touch-target h-7 px-2 text-xs sm:h-7"
                      onClick={() => onOpenSourcePage?.(
                        field.pageNumber!,
                        field.boundingBox,
                        cleanLabel(field.fieldName),
                      )}
                    >
                      Page {field.pageNumber}
                    </Button>
                  )}
                </div>
              </div>
              {canReview && !field.humanVerified ? (
                <Input
                  id={`field-${field.id}`}
                  className="mt-1 h-8"
                  value={current}
                  inputMode={["currency", "number"].includes(field.valueType) ? "decimal" : undefined}
                  onChange={(event) => setEdits((prior) => ({ ...prior, [field.id]: event.target.value }))}
                />
              ) : (
                <p className="mt-1 text-sm">{displayValue(field.value, field.valueType)}</p>
              )}
            </div>
          );
        })}
      </div>

      {canReview && (
        <div className="space-y-2">
          {missingFields.map((field, index) => (
            <div key={field.id} className="grid gap-2 rounded-md border border-dashed p-2 sm:grid-cols-2">
              <Input
                aria-label="Missed field name"
                placeholder="Missed field name"
                value={field.fieldName}
                onChange={(event) => setMissingFields((rows) => rows.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, fieldName: event.target.value } : row
                ))}
              />
              <Input
                aria-label="Correct value"
                placeholder="Correct value"
                value={field.correctedValue}
                onChange={(event) => setMissingFields((rows) => rows.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, correctedValue: event.target.value } : row
                ))}
              />
              <select
                aria-label="Field category"
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={field.fieldCategory}
                onChange={(event) => setMissingFields((rows) => rows.map((row, rowIndex) =>
                  rowIndex === index
                    ? { ...row, fieldCategory: event.target.value as MissingFieldDraft["fieldCategory"] }
                    : row
                ))}
              >
                <option value="income">Income</option>
                <option value="asset">Asset</option>
                <option value="identity">Identity</option>
                <option value="property">Property</option>
              </select>
              <div className="flex gap-2">
                <select
                  aria-label="Value type"
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
                  value={field.valueType}
                  onChange={(event) => setMissingFields((rows) => rows.map((row, rowIndex) =>
                    rowIndex === index
                      ? { ...row, valueType: event.target.value as MissingFieldDraft["valueType"] }
                      : row
                  ))}
                >
                  <option value="currency">Currency</option>
                  <option value="number">Number</option>
                  <option value="string">Text</option>
                  <option value="date">Date</option>
                  <option value="boolean">Yes / no</option>
                </select>
                <Input
                  aria-label="Source page"
                  className="w-20"
                  placeholder="Page"
                  inputMode="numeric"
                  value={field.pageNumber}
                  onChange={(event) => setMissingFields((rows) => rows.map((row, rowIndex) =>
                    rowIndex === index ? { ...row, pageNumber: event.target.value } : row
                  ))}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Remove missed field"
                  onClick={() => setMissingFields((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}
                >
                  <Icons.reject className={iconSize.inline} />
                </Button>
              </div>
            </div>
          ))}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="touch-target"
              onClick={() => setMissingFields((rows) => [...rows, {
                id: crypto.randomUUID(),
                fieldName: "",
                correctedValue: "",
                fieldCategory: "income",
                valueType: "currency",
                pageNumber: "",
              }])}
            >
              Add a missed field
            </Button>
            <Button
              type="button"
              size="sm"
              className="touch-target"
              disabled={!canSubmit || reviewMutation.isPending}
              onClick={() => reviewMutation.mutate()}
            >
              {reviewMutation.isPending ? "Saving…" : "Save field review"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
