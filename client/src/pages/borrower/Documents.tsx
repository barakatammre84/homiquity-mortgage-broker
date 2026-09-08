import { useState, useRef, useEffect } from "react";
import { useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useUpload } from "@/hooks/use-upload";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, loanApplicationKeys, dashboardKeys, applicationResourceKeys, taskKeys } from "@/lib/queryClient";
import { useActiveApplication } from "@/hooks/useActiveApplication";
import type { Document, LoanApplication, LoanCondition } from "@shared/schema";
import { canonicalDocumentType } from "@shared/documentTypes";
import { validateUploadFile } from "@shared/uploads";
import { PageShell } from "@/components/PageShell";
import { QueryErrorState } from "@/components/ui/query-boundary";
import type { DocRow } from "@/components/DocumentItemRow";
import { DocumentRequestReasons } from "@/components/borrower/DocumentRequestReasons";
import { DOCUMENT_CATEGORIES, getUploadNextStep } from "./documentCategories";
import {
  groupDocumentsByType,
  countPendingCatalogDocs,
  countPendingChecklistItems,
  buildPersonalizedGroups,
  rowFromChecklistItem,
  getChecklistStatusInfo,
  type ChecklistItemView,
} from "@/lib/documentChecklist";
import { ConditionFocusBanner, ConditionGoneNotice } from "./documents/ConditionFocusBanner";
import { ChecklistStatusSummary } from "./documents/ChecklistStatusSummary";
import { PersonalizedCategoryCard } from "./documents/PersonalizedCategoryCard";
import { CatalogCategoryCard } from "./documents/CatalogCategoryCard";
import { UploadedDocumentsTable } from "./documents/UploadedDocumentsTable";
import type { UploadControls } from "./documents/types";

interface DashboardData {
  documents: Document[];
}

export default function Documents() {
  const queryClient = useQueryClient();
  const { isLoading: authLoading } = useAuth();
  const [expandedCategories, setExpandedCategories] = useState<string[]>(["income", "assets"]);
  const [activeDocType, setActiveDocType] = useState<{ type: string; rowKey: string; replacesDocumentId?: string } | null>(null);
  // The row whose file is in flight — it swaps its dropzone for the live
  // progress card. One upload at a time keeps the page state honest.
  // rowKey identifies the ROW (two personalized items can accept one type).
  const [activeUpload, setActiveUpload] = useState<{
    rowKey: string;
    docType: string;
    fileName: string;
    fileSize: number;
  } | null>(null);
  const cancelledRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { uploadFile, isUploading, progress, cancel } = useUpload();

  const {
    data,
    isLoading,
    isError: docsError,
    error: docsErrorObj,
    refetch: refetchDocs,
  } = useQuery<DashboardData>({
    queryKey: dashboardKeys.root(),
    enabled: !authLoading,
  });

  // Condition-focus mode: the pipeline's per-condition "Upload" button links
  // here with ?condition=<id>. Resolve it through the same pipeline endpoint
  // the Loan Progress page uses (one deterministic source), then spotlight the
  // document types that clear it. Uploads of a matching type flip the
  // condition to "submitted" server-side (matchUploadedDocumentToConditions).
  const search = useSearch();
  const conditionId = new URLSearchParams(search).get("condition");

  // Always know the borrower's open application (not just in focus mode):
  // registrations carry its id so uploads land on the loan file explicitly.
  // This MUST skip closed files — the list is newest-created-first, so taking
  // [0] attached uploads to a denied/withdrawn/funded loan whenever the
  // borrower's most recent file was the closed one.
  const { data: myApps } = useQuery<LoanApplication[]>({
    queryKey: loanApplicationKeys.all(),
    enabled: !authLoading,
  });
  const { activeApplication } = useActiveApplication(myApps ?? []);
  const focusAppId = activeApplication?.id;

  const { data: focusPipeline, isLoading: focusLoading } = useQuery<{ conditions: LoanCondition[] }>({
    queryKey: loanApplicationKeys.pipeline(focusAppId!),
    enabled: !!conditionId && !!focusAppId,
  });

  // Personalized checklist: same endpoint the messaging surface uses, now
  // built from the pipeline engine's loan_conditions (self-employed borrowers
  // see P&L/business items). Falls back to the static catalog below when the
  // application has no document-bearing conditions or there's no application.
  const { data: checklistData } = useQuery<{
    documents: ChecklistItemView[];
    personalized: boolean;
  }>({
    queryKey: applicationResourceKeys.documentChecklist(focusAppId),
    enabled: !!focusAppId && !authLoading,
  });
  const personalizedItems = (checklistData?.documents ?? []).filter(
    (i) =>
      i.source === "condition" ||
      // Custom document-request tasks join the list, but internal review
      // tasks surface with documentType "other" and are staff work, not
      // borrower uploads — same rule as outstandingItems() in
      // UploadDocumentDialog.
      (i.source === "task" && i.documentType !== "other"),
  );
  const personalized = checklistData?.personalized ?? personalizedItems.length > 0;

  const focusedCondition = conditionId
    ? (focusPipeline?.conditions ?? []).find((c) => c.id === conditionId) ?? null
    : null;
  const focusedChecklistItem = conditionId
    ? personalizedItems.find(
        (item) =>
          item.conditionIds?.includes(conditionId) || item.conditionId === conditionId,
      )
    : undefined;
  // Canonical set so catalog types ("paystub") match condition requirements
  // ("pay_stub") — same bridge the server-side auto-matcher uses.
  const focusTypes = new Set(
    (focusedCondition?.requiredDocumentTypes ?? []).map(canonicalDocumentType),
  );

  // Open the categories that contain the spotlighted document types.
  useEffect(() => {
    if (!focusedCondition) return;
    const types = new Set(focusedCondition.requiredDocumentTypes ?? []);
    const cats = DOCUMENT_CATEGORIES.filter((c) => c.documents.some((d) => types.has(d.type))).map(
      (c) => c.id,
    );
    if (cats.length) {
      setExpandedCategories((prev) => Array.from(new Set([...prev, ...cats])));
    }
  }, [focusedCondition?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleUploadClick = (docType: string, rowKey: string = docType, replacesDocumentId?: string) => {
    setActiveDocType({ type: docType, rowKey, replacesDocumentId });
    fileInputRef.current?.click();
  };

  // One shared upload path for every affordance on this page (row dropzones,
  // Replace buttons, the condition-focus banner): validate → presigned PUT
  // with real byte-level progress → JSON registration.
  //
  // This flow deliberately stays in the page rather than moving into
  // ./documents/ — uploads are a TEAM_PRACTICES §9 security-review trigger, and
  // splitting validation from registration across files makes the fail-closed
  // behaviour below harder to review as one piece.
  const startUpload = async (docType: string, file: File, rowKey: string = docType, replacesDocumentId?: string) => {
    if (isUploading) {
      toast({
        title: "One upload at a time",
        description: "Let the current file finish (or cancel it), then try again.",
      });
      return;
    }
    const check = validateUploadFile(file);
    if (!check.ok) {
      toast({ title: "That file won't work", description: check.message, variant: "destructive" });
      return;
    }
    cancelledRef.current = false;
    setActiveUpload({ rowKey, docType, fileName: file.name, fileSize: file.size });
    try {
      const response = await uploadFile(file);
      if (!response) {
        // A user cancel resets quietly; a real failure gets an honest toast.
        if (!cancelledRef.current) {
          toast({
            title: "Upload didn't complete",
            description: "The file never reached storage. Please try again.",
            variant: "destructive",
          });
        }
        return;
      }
      try {
        await apiRequest("POST", "/api/documents/upload", {
          objectPath: response.objectPath,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          documentType: docType,
          ...(focusAppId ? { applicationId: focusAppId } : {}),
          ...(replacesDocumentId ? { replacesDocumentId } : {}),
        });
      } catch {
        // Never claim success on a failed registration — that's how files get lost.
        toast({
          title: "Upload didn't complete",
          description: "The file reached storage but couldn't be filed on your loan. Please try again.",
          variant: "destructive",
        });
        return;
      }
      queryClient.invalidateQueries({ queryKey: dashboardKeys.root() });
      queryClient.invalidateQueries({ queryKey: taskKeys.all() });
      queryClient.invalidateQueries({ queryKey: ["/api/shell/badges"] });
      // Refresh pipeline data too — a matching upload moves the focused
      // condition to "submitted" and the banner should say so.
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.all() });
      if (focusAppId) {
        queryClient.invalidateQueries({ queryKey: loanApplicationKeys.actionItems(focusAppId) });
        queryClient.invalidateQueries({
          queryKey: applicationResourceKeys.documentChecklist(focusAppId),
        });
      }
      toast({ title: "Document uploaded", description: getUploadNextStep(docType) });
    } finally {
      setActiveUpload(null);
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const picked = activeDocType;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setActiveDocType(null);
    if (!file || !picked) return;
    await startUpload(picked.type, file, picked.rowKey, picked.replacesDocumentId);
  };

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories(prev =>
      prev.includes(categoryId)
        ? prev.filter(id => id !== categoryId)
        : [...prev, categoryId]
    );
  };

  if (authLoading || isLoading) {
    return (
      <div className="p-8">
        <Skeleton className="mb-8 h-8 w-48" />
        <div className="space-y-4">
          {[1, 2, 3].map(i => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  // A server failure on the dashboard query used to render the checklist as if
  // nothing was submitted (all "pending") — show an honest error + retry (ux-01).
  if (docsError) {
    return (
      <PageShell width="wide" title="Document Checklist" subtitle="Submit required documents as requested — we may ask for more as your application progresses">
        <QueryErrorState
          error={docsErrorObj}
          onRetry={() => refetchDocs()}
          title="We couldn't load your documents"
          data-testid="documents-error"
        />
      </PageShell>
    );
  }

  const documents = data?.documents || [];

  const documentsByType = groupDocumentsByType(documents);

  // Calculate current status - count pending required items. Personalized
  // mode counts the pipeline's own items instead of the static catalog.
  const pendingCount = personalized
    ? countPendingChecklistItems(personalizedItems)
    : countPendingCatalogDocs(DOCUMENT_CATEGORIES.flatMap((cat) => cat.documents), documentsByType);
  const isAllCaughtUp = pendingCount === 0;

  const personalizedGroups = personalized ? buildPersonalizedGroups(personalizedItems) : new Map<string, ChecklistItemView[]>();

  const rowFromItem = (item: ChecklistItemView): DocRow => rowFromChecklistItem(item, conditionId);

  const statusInfo = getChecklistStatusInfo(isAllCaughtUp, pendingCount);

  const uploadControls: UploadControls = {
    activeUpload,
    progress,
    anyUploadBusy: isUploading,
    onFile: (row, file) => startUpload(row.uploadType, file, row.uploadKey, row.documentId),
    onBrowse: (row) => handleUploadClick(row.uploadType, row.uploadKey, row.documentId),
    onCancel: () => {
      cancelledRef.current = true;
      cancel();
    },
  };

  return (
    <>
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        onChange={handleFileSelected}
        data-testid="input-file-upload"
      />
      <PageShell width="wide" title="Document Checklist" subtitle="Submit required documents as requested — we may ask for more as your application progresses">
        {conditionId && focusedCondition && (
          <ConditionFocusBanner
            condition={focusedCondition}
            onUploadType={(type) =>
              handleUploadClick(
                type,
                focusedChecklistItem?.id ?? type,
                focusedChecklistItem?.status === "rejected"
                  ? focusedChecklistItem.documentId
                  : undefined,
              )
            }
            isUploading={isUploading}
          />
        )}
        {conditionId && !focusedCondition && !focusLoading && myApps && <ConditionGoneNotice />}

        <ChecklistStatusSummary statusInfo={statusInfo} />

        {/* Why-we-need-these: tie-out-driven reasons from the borrower's own
            SituationProfile (owner-readable endpoint; renders nothing when the
            file has no generated requests). */}
        <div className="mb-6">
          <DocumentRequestReasons />
        </div>

        <div className="space-y-4">
        {personalized
          ? [...personalizedGroups.entries()].map(([catId, items]) => (
              <PersonalizedCategoryCard
                key={catId}
                categoryId={catId}
                items={items}
                rowFromItem={rowFromItem}
                upload={uploadControls}
              />
            ))
          : DOCUMENT_CATEGORIES.map((category) => (
              <CatalogCategoryCard
                key={category.id}
                category={category}
                documentsByType={documentsByType}
                focusTypes={focusTypes}
                isExpanded={expandedCategories.includes(category.id)}
                onToggle={() => toggleCategory(category.id)}
                upload={uploadControls}
              />
            ))}

        {documents.length > 0 && <UploadedDocumentsTable documents={documents} />}
      </div>
      </PageShell>
    </>
  );
}
