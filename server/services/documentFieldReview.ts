import { and, eq, ne, or } from "drizzle-orm";
import { extractedFields, logicalDocuments } from "@shared/schema";
import { db } from "../db";
import { recordHumanReview } from "./documentConfidence";
import type { DatabaseTransaction } from "./documentLineage";

export interface ExtractedFieldReviewValue {
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

type FieldRow = typeof extractedFields.$inferSelect;

function machineValue(row: FieldRow): string | number | boolean | null {
  if (row.valueType === "currency" || row.valueType === "number") {
    return row.valueNumeric === null ? null : Number(row.valueNumeric);
  }
  if (row.valueType === "boolean") return row.valueBoolean;
  if (row.valueType === "date") return row.valueDate?.toISOString().slice(0, 10) ?? null;
  return row.valueString;
}

function effectiveValue(row: FieldRow): string | number | boolean | null {
  if (row.humanCorrectedValue === null) return machineValue(row);
  if (row.valueType === "currency" || row.valueType === "number") {
    const numeric = Number(row.humanCorrectedValue);
    return Number.isFinite(numeric) ? numeric : row.humanCorrectedValue;
  }
  if (row.valueType === "boolean") {
    return ["true", "yes", "1"].includes(row.humanCorrectedValue.trim().toLowerCase());
  }
  return row.humanCorrectedValue;
}

/** Safe, plaintext field projection for an authorized staff review surface. */
export async function getDocumentFieldReview(
  documentId: string,
): Promise<ExtractedFieldReviewValue[]> {
  const rows = await db
    .select({ field: extractedFields })
    .from(extractedFields)
    .leftJoin(logicalDocuments, eq(extractedFields.logicalDocumentId, logicalDocuments.id))
    .where(or(
      eq(extractedFields.documentId, documentId),
      and(
        eq(logicalDocuments.sourceDocumentId, documentId),
        ne(logicalDocuments.status, "rejected"),
      ),
    ));

  return rows
    .map(({ field }) => ({
      id: field.id,
      fieldName: field.fieldName,
      fieldCategory: field.fieldCategory,
      valueType: field.valueType,
      value: effectiveValue(field),
      machineValue: machineValue(field),
      confidence: Number(field.confidence),
      pageNumber: field.pageNumber,
      boundingBox: field.boundingBox,
      humanVerified: field.humanVerified ?? false,
      humanCorrected: field.humanCorrectedValue !== null,
      extractionMethod: field.extractionMethod,
      modelVersion: field.modelVersion,
    }))
    .sort((a, b) =>
      (a.pageNumber ?? Number.MAX_SAFE_INTEGER) - (b.pageNumber ?? Number.MAX_SAFE_INTEGER) ||
      a.fieldName.localeCompare(b.fieldName)
    );
}

export interface DocumentFieldReviewDecision {
  fieldId: string;
  action: "confirm" | "correct";
  correctedValue?: string;
}

export interface MissingDocumentField {
  fieldName: string;
  fieldCategory: "income" | "asset" | "identity" | "property";
  valueType: "currency" | "number" | "string" | "date" | "boolean";
  correctedValue: string;
  pageNumber?: number;
}

export async function reviewDocumentFields(input: {
  documentId: string;
  reviewedBy: string;
  decisions: DocumentFieldReviewDecision[];
  missingFields: MissingDocumentField[];
}, existingTransaction?: DatabaseTransaction): Promise<{ fieldsCorrect: number; fieldsCorrected: number; fieldsMissed: number }> {
  const counts = { fieldsCorrect: 0, fieldsCorrected: 0, fieldsMissed: input.missingFields.length };

  const persist = async (transaction: DatabaseTransaction) => {
    const rows = await transaction
      .select({ field: extractedFields })
      .from(extractedFields)
      .leftJoin(logicalDocuments, eq(extractedFields.logicalDocumentId, logicalDocuments.id))
      .where(or(
        eq(extractedFields.documentId, input.documentId),
        and(
          eq(logicalDocuments.sourceDocumentId, input.documentId),
          ne(logicalDocuments.status, "rejected"),
        ),
      ));
    const allowedIds = new Set(rows
      .filter(({ field }) => field.humanVerified !== true)
      .map(({ field }) => field.id));
    if (input.decisions.some((decision) => !allowedIds.has(decision.fieldId))) {
      throw new Error("One or more fields do not belong to this document");
    }

    for (const decision of input.decisions) {
      const updated = await transaction
        .update(extractedFields)
        .set({
          humanVerified: true,
          humanCorrectedValue:
            decision.action === "correct" ? decision.correctedValue!.trim() : null,
          verifiedByUserId: input.reviewedBy,
          verifiedAt: new Date(),
        })
        .where(and(
          eq(extractedFields.id, decision.fieldId),
          eq(extractedFields.humanVerified, false),
        ))
        .returning({ id: extractedFields.id });
      if (updated.length !== 1) throw new Error("Field review changed while it was being saved");
      if (decision.action === "confirm") counts.fieldsCorrect += 1;
      else counts.fieldsCorrected += 1;
    }

    if (input.missingFields.length > 0) {
      await transaction.insert(extractedFields).values(input.missingFields.map((field) => {
        const numeric = ["currency", "number"].includes(field.valueType)
          ? Number(field.correctedValue)
          : null;
        if (numeric !== null && !Number.isFinite(numeric)) {
          throw new Error(`Corrected value for ${field.fieldName} must be numeric`);
        }
        return {
          documentId: input.documentId,
          fieldName: field.fieldName,
          fieldCategory: field.fieldCategory,
          valueString: numeric === null ? field.correctedValue : null,
          valueNumeric: numeric === null ? null : String(numeric),
          valueType: field.valueType,
          confidence: "0.0000",
          pageNumber: field.pageNumber ?? null,
          extractionMethod: "human_correction",
          humanVerified: true,
          humanCorrectedValue: field.correctedValue,
          verifiedByUserId: input.reviewedBy,
          verifiedAt: new Date(),
        };
      }));
    }

    await recordHumanReview(input.documentId, input.reviewedBy, counts, transaction);
  };
  if (existingTransaction) await persist(existingTransaction);
  else await db.transaction(persist);
  return counts;
}
