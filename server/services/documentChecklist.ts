/**
 * Borrower document-checklist builder — the single derivation behind
 * GET /api/applications/:id/document-checklist.
 *
 * Personalization: the pipeline engine already writes per-application
 * requirements as loan_conditions rows with `requiredDocumentTypes`
 * (self-employed → P&L / business returns, LTV>80% → gift letter, …). This
 * builder turns only those conditions and explicit borrower tasks into the
 * borrower's checklist. Uploaded history never becomes a request by itself.
 *
 * Pure by design: no storage, no clock, no I/O — the route fetches, this
 * decides, tests pin the rules. Fixes carried in from the old inline version:
 *  - alias-aware document matching via shared/documentTypes.ts (an uploaded
 *    "paystub" now satisfies a "pay_stub" requirement),
 *  - the LATEST upload of a type decides the item status (re-uploads count),
 *  - a document staged "verifying" surfaces as "verifying" instead of
 *    collapsing to "uploaded" (the borrower's "Under Review" badge),
 *  - rejected items expose rejectionReason/reviewedAt so the portal can say
 *    WHY and invite a re-upload.
 */
import {
  SETTLED_CONDITION_STATUSES as SHARED_SETTLED_CONDITION_STATUSES,
  TERMINAL_TASK_STATUSES,
  type Document,
  type LoanCondition,
  type Task,
} from "@shared/schema";
import { documentTypesMatch } from "@shared/documentTypes";
import {
  DOCUMENT_STATUS,
  isDocumentStatus,
  type ChecklistItemStatus,
} from "@shared/documentStatus";

export type ChecklistCondition = Pick<
  LoanCondition,
  "id" | "title" | "description" | "category" | "priority" | "status" | "requiredDocumentTypes"
>;
export type ChecklistDocument = Pick<
  Document,
  "id" | "documentType" | "fileName" | "status" | "rejectionReason" | "reviewedAt" | "createdAt"
>;
export type ChecklistTask = Pick<
  Task,
  | "id"
  | "taskType"
  | "documentCategory"
  | "documentYear"
  | "title"
  | "status"
  | "verificationStatus"
  | "verificationNotes"
  | "requestingTeam"
  | "isCustomRequest"
  | "documentInstructions"
  | "ownerRole"
>;

/**
 * "Verifying" = the borrower has acted and staff review is pending. Lives on
 * the verification axis (tasks.verificationStatus), NOT the lifecycle status —
 * the old check compared status === "submitted", a value the task engine never
 * writes.
 */
function taskAwaitingReview(task: ChecklistTask | undefined): boolean {
  return task?.status === "IN_PROGRESS" && task?.verificationStatus === "pending";
}

export interface ChecklistItemDto {
  /** Stable per-source id: conditionId | taskId | `std-<type>`. */
  id: string;
  source: "condition" | "standard" | "task";
  conditionId?: string;
  /** Every condition cleared by this one upload action. */
  conditionIds?: string[];
  /** CONDITION_CATEGORIES value ("income", "assets", …) or "other". */
  category: string;
  /** Primary type to POST on upload. */
  documentType: string;
  /** Every type that satisfies the item (condition.requiredDocumentTypes). */
  acceptedTypes: string[];
  label: string;
  description?: string;
  required: boolean;
  priority?: string;
  status: ChecklistItemStatus;
  documentId?: string;
  fileName?: string;
  uploadedAt?: string;
  rejectionReason?: string | null;
  reviewedAt?: string | null;
  /**
   * Borrower-facing context only: `notes`/`instructions` carry the
   * staff-authored documentInstructions — NEVER tasks.verificationNotes,
   * which is staff review-axis free text.
   */
  notes?: string;
  requestingTeam?: string;
  isCustomRequest?: boolean;
  instructions?: string;
  /** Which year's document ("2023") — from the requesting task; conditions have no year. */
  documentYear?: string;
}

export interface ChecklistStats {
  total: number;
  verified: number;
  uploaded: number;
  needed: number;
  rejected: number;
}

/** Condition states that mean "this to-do is settled" — no checklist item. */
const SETTLED_CONDITION_STATUSES: ReadonlySet<string> = new Set(SHARED_SETTLED_CONDITION_STATUSES);

function documentItemStatus(doc: ChecklistDocument): ChecklistItemStatus {
  return doc.status && isDocumentStatus(doc.status) ? doc.status : DOCUMENT_STATUS.UPLOADED;
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function buildDocumentChecklist(input: {
  conditions: ChecklistCondition[];
  documents: ChecklistDocument[];
  tasks: ChecklistTask[];
}): { documents: ChecklistItemDto[]; stats: ChecklistStats; personalized: boolean } {
  // Newest-first regardless of fetch order — the latest upload of a type is
  // the one whose review status the borrower is living with.
  const docs = [...input.documents].sort(
    (a, b) => (toIso(b.createdAt) ?? "").localeCompare(toIso(a.createdAt) ?? ""),
  );
  const docTasks = input.tasks.filter(
    (t) =>
      t.taskType === "document_request" &&
      t.ownerRole === "BORROWER" &&
      !TERMINAL_TASK_STATUSES.includes(t.status),
  );

  const latestDocFor = (acceptedTypes: string[]): ChecklistDocument | undefined =>
    docs.find((d) => acceptedTypes.some((rt) => documentTypesMatch(rt, d.documentType)));

  const withDocFields = (
    base: Omit<
      ChecklistItemDto,
      "status" | "documentId" | "fileName" | "uploadedAt" | "rejectionReason" | "reviewedAt"
    >,
    doc: ChecklistDocument | undefined,
    statusWithoutDoc: ChecklistItemStatus,
  ): ChecklistItemDto => ({
    ...base,
    status: doc ? documentItemStatus(doc) : statusWithoutDoc,
    documentId: doc?.id,
    fileName: doc?.fileName,
    uploadedAt: doc ? toIso(doc.createdAt) : undefined,
    rejectionReason: doc?.status === DOCUMENT_STATUS.REJECTED ? doc.rejectionReason : undefined,
    reviewedAt: doc?.status === DOCUMENT_STATUS.REJECTED ? toIso(doc.reviewedAt) : undefined,
  });

  const items: ChecklistItemDto[] = [];

  // 1) Personalized path: document-bearing conditions.
  const documentConditions = input.conditions.filter(
    (c) => (c.requiredDocumentTypes ?? []).length > 0,
  );
  const activeConditions = documentConditions.filter(
    (condition) => !SETTLED_CONDITION_STATUSES.has(condition.status),
  );
  const conditionGroups: Array<{
    conditions: ChecklistCondition[];
    acceptedTypes: string[];
  }> = [];
  for (const condition of activeConditions) {
    // Settled to-dos leave the checklist; their documents stay visible in the
    // full document history. (A doc still merely "uploaded" under a cleared
    // condition would otherwise show "Under Review" forever — a review that
    // may never happen.)
    const acceptedTypes = condition.requiredDocumentTypes ?? [];
    const existing = conditionGroups.find((group) =>
      group.acceptedTypes.some((left) =>
        acceptedTypes.some((right) => documentTypesMatch(left, right)),
      ),
    );
    if (existing) {
      existing.conditions.push(condition);
      for (const type of acceptedTypes) {
        if (!existing.acceptedTypes.some((current) => documentTypesMatch(current, type))) {
          existing.acceptedTypes.push(type);
        }
      }
    } else {
      conditionGroups.push({ conditions: [condition], acceptedTypes: [...acceptedTypes] });
    }
  }
  for (const group of conditionGroups) {
    const primary = group.conditions[0];
    const conditionIds = group.conditions.map((condition) => condition.id);
    const doc = latestDocFor(group.acceptedTypes);
    items.push(
      withDocFields(
        {
          id: conditionIds.join("+"),
          source: "condition",
          conditionId: primary.id,
          conditionIds,
          category: primary.category || "other",
          documentType: group.acceptedTypes[0],
          acceptedTypes: group.acceptedTypes,
          label: primary.title,
          description:
            group.conditions.length > 1
              ? `One upload will be applied to ${group.conditions.length} loan items: ${group.conditions
                  .map((condition) => condition.title)
                  .join("; ")}.`
              : primary.description ?? undefined,
          required: true,
          priority: primary.priority ?? undefined,
        },
        doc,
        group.conditions.every((condition) => condition.status === "submitted")
          ? "verifying"
          : "needed",
      ),
    );
  }

  // 2) Explicit document-request tasks not already covered by a condition.
  for (const task of docTasks) {
    const taskType = task.documentCategory || "other";
    const alreadyCovered = items.some((item) =>
      item.acceptedTypes.some((at) => documentTypesMatch(at, taskType)),
    );
    if (alreadyCovered) continue;
    const doc = task.documentCategory ? latestDocFor([task.documentCategory]) : undefined;
    items.push(
      withDocFields(
        {
          id: task.id,
          source: "task",
          category: "other",
          documentType: taskType,
          acceptedTypes: [taskType],
          label: task.title,
          required: true,
          notes: task.documentInstructions ?? undefined,
          requestingTeam: task.requestingTeam ?? undefined,
          isCustomRequest: task.isCustomRequest ?? undefined,
          instructions: task.documentInstructions ?? undefined,
          documentYear: task.documentYear ?? undefined,
        },
        doc,
        taskAwaitingReview(task) ? "verifying" : "needed",
      ),
    );
  }

  const stats: ChecklistStats = {
    total: items.length,
    verified: items.filter((d) => d.status === "verified").length,
    // Back-compat: "uploaded" has always counted in-review items (uploaded +
    // verifying) for the Messages badge math — keep the meaning stable.
    uploaded: items.filter((d) => d.status === "uploaded" || d.status === "verifying").length,
    needed: items.filter((d) => d.status === "needed").length,
    rejected: items.filter((d) => d.status === "rejected").length,
  };

  return {
    documents: items,
    stats,
    personalized: documentConditions.length > 0 || docTasks.length > 0,
  };
}
