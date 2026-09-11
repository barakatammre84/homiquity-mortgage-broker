import { CheckCircle2, Clock, AlertCircle } from "lucide-react";
import { CONDITION_CATEGORY_META } from "@/pages/borrower/documentCategories";
import { canonicalDocumentType } from "@shared/documentTypes";
import type { Document } from "@shared/schema";
import type { DocRow } from "@/components/DocumentItemRow";

export type DocumentStatus = "needed" | "uploaded" | "verifying" | "verified" | "rejected";

// Personalized checklist item as served by /document-checklist (built from the
// pipeline engine's loan_conditions — see server/services/documentChecklist.ts).
export interface ChecklistItemView {
  id: string;
  source: "condition" | "standard" | "task";
  conditionId?: string;
  conditionIds?: string[];
  category: string;
  documentType: string;
  acceptedTypes: string[];
  label: string;
  description?: string;
  required: boolean;
  status: DocumentStatus;
  documentId?: string;
  fileName?: string;
  uploadedAt?: string;
  rejectionReason?: string | null;
  documentYear?: string;
  instructions?: string;
}

export function groupDocumentsByType(documents: Document[]): Record<string, Document[]> {
  return documents.reduce((acc, doc) => {
    if (!acc[doc.documentType]) {
      acc[doc.documentType] = [];
    }
    acc[doc.documentType].push(doc);
    return acc;
  }, {} as Record<string, Document[]>);
}

// A required item is pending when nothing was uploaded OR the latest upload
// bounced (rejected latest = action still needed, not "complete").
export function countPendingCatalogDocs(
  docs: { type: string; required: boolean }[],
  documentsByType: Record<string, Document[]>,
): number {
  return docs.filter((d) => {
    if (!d.required) return false;
    const uploaded = documentsByType[d.type];
    return !uploaded?.length || uploaded[0]?.status === "rejected";
  }).length;
}

export function countPendingChecklistItems(items: ChecklistItemView[]): number {
  return items.filter((i) => i.status === "needed" || i.status === "rejected").length;
}

// Group personalized items into the same visual category cards the static
// catalog uses (unknown categories fold into "other").
export function buildPersonalizedGroups(items: ChecklistItemView[]): Map<string, ChecklistItemView[]> {
  const groups = new Map<string, ChecklistItemView[]>();
  for (const item of items) {
    const cat = CONDITION_CATEGORY_META[item.category] ? item.category : "other";
    const group = groups.get(cat) ?? [];
    group.push(item);
    groups.set(cat, group);
  }
  return groups;
}

export function rowFromChecklistItem(item: ChecklistItemView, focusedConditionId: string | null): DocRow {
  return {
    key: item.documentType,
    uploadKey: item.id,
    uploadType: item.documentType,
    name: item.label,
    description: item.description,
    year: item.documentYear,
    instructions: item.instructions,
    required: item.required,
    status: item.status,
    fileName: item.fileName,
    uploadedAt: item.uploadedAt,
    documentId: item.documentId,
    rejectionReason: item.rejectionReason,
    focused:
      !!focusedConditionId &&
      (item.conditionIds?.includes(focusedConditionId) || item.conditionId === focusedConditionId),
  };
}

export function rowFromCatalogDoc(
  docType: { type: string; name: string; description: string; required: boolean },
  documentsByType: Record<string, Document[]>,
  focusTypes: Set<string>,
): DocRow {
  const uploadedDocs = documentsByType[docType.type] || [];
  // The dashboard document list is newest-first, so the latest upload of a
  // type is [0] — [length - 1] was the OLDEST, which froze the row on a
  // re-upload's stale status.
  const latestDoc = uploadedDocs[0];
  return {
    key: docType.type,
    uploadKey: docType.type,
    uploadType: docType.type,
    name: docType.name,
    description: docType.description,
    required: docType.required,
    status: latestDoc ? ((latestDoc.status as DocumentStatus) || "uploaded") : "needed",
    fileName: latestDoc?.fileName,
    uploadedAt: latestDoc?.createdAt,
    documentId: latestDoc?.id,
    rejectionReason: latestDoc?.rejectionReason,
    focused: focusTypes.has(canonicalDocumentType(docType.type)),
  };
}

export interface StatusInfo {
  icon: typeof CheckCircle2;
  iconColor: string;
  bgColor: string;
  borderColor: string;
  title: string;
  subtitle: string;
  badgeText: string;
  badgeColor: string;
}

export function getChecklistStatusInfo(
  isAllSubmitted: boolean,
  pendingCount: number,
  isAllVerified = false,
): StatusInfo {
  if (isAllVerified) {
    return {
      icon: CheckCircle2,
      iconColor: "text-success-subtle-foreground",
      bgColor: "bg-success/20",
      borderColor: "border-border/30",
      title: "Your documents are verified",
      subtitle: "Your loan team has accepted every currently requested document",
      badgeText: "Complete",
      badgeColor: "bg-success text-success-foreground",
    };
  } else if (isAllSubmitted) {
    return {
      icon: Clock,
      iconColor: "text-warning-subtle-foreground",
      bgColor: "bg-warning/20",
      borderColor: "border-border/30",
      title: "Everything requested is submitted",
      subtitle: "Your loan team is reviewing the documents you sent",
      badgeText: "Under review",
      badgeColor: "bg-warning text-warning-foreground",
    };
  } else if (pendingCount <= 3) {
    return {
      icon: Clock,
      iconColor: "text-warning-subtle-foreground",
      bgColor: "bg-warning/20",
      borderColor: "border-border/30",
      title: "Almost there!",
      subtitle: `${pendingCount} document${pendingCount > 1 ? "s" : ""} still needed`,
      badgeText: "Action Needed",
      badgeColor: "bg-warning text-warning-foreground",
    };
  }
  return {
    icon: AlertCircle,
    iconColor: "text-destructive",
    bgColor: "bg-destructive/20",
    borderColor: "border-border/30",
    title: "Documents needed",
    subtitle: `${pendingCount} documents still required`,
    badgeText: "Pending",
    badgeColor: "bg-destructive text-destructive-foreground",
  };
}

export interface CategoryStatus {
  text: string;
  color: string;
}

export function getCategoryStatus(requiredCount: number, pendingInCategory: number): CategoryStatus {
  if (requiredCount === 0) {
    return { text: "Optional", color: "bg-muted text-muted-foreground" };
  }
  if (pendingInCategory === 0) {
    return { text: "Complete", color: "bg-success-subtle text-success-subtle-foreground" };
  }
  if (pendingInCategory === 1) {
    return { text: "1 needed", color: "bg-warning-subtle text-warning-subtle-foreground" };
  }
  return { text: `${pendingInCategory} needed`, color: "bg-warning-subtle text-warning-subtle-foreground" };
}
