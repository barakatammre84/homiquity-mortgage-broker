import { useState, useRef } from "react";
import { Link, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useUpload } from "@/hooks/use-upload";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, loanApplicationKeys, dashboardKeys, applicationResourceKeys, taskKeys } from "@/lib/queryClient";
import { useActiveApplication } from "@/hooks/useActiveApplication";
import type { Document, LoanApplication, LoanCondition } from "@shared/schema";
import { validateUploadFile } from "@shared/uploads";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/patterns/EmptyState";
import { QueryErrorState } from "@/components/ui/query-boundary";
import type { DocRow } from "@/components/DocumentItemRow";
import { DocumentRequestReasons } from "@/components/borrower/DocumentRequestReasons";
import { getUploadNextStep } from "./documentCategories";
import {
  countPendingChecklistItems,
  buildPersonalizedGroups,
  rowFromChecklistItem,
  getChecklistStatusInfo,
  type ChecklistItemView,
} from "@/lib/documentChecklist";
import { ConditionFocusBanner, ConditionGoneNotice } from "./documents/ConditionFocusBanner";
import { ChecklistStatusSummary } from "./documents/ChecklistStatusSummary";
import { PersonalizedCategoryCard } from "./documents/PersonalizedCategoryCard";
import { UploadedDocumentsTable } from "./documents/UploadedDocumentsTable";
import type { UploadControls } from "./documents/types";

interface DashboardData {
  documents: Document[];
}

export default function Documents() {
  const queryClient = useQueryClient();
  const { isLoading: authLoading } = useAuth();
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
  const {
    data: myApps,
    isLoading: appsLoading,
    isError: appsError,
    error: appsErrorObj,
    refetch: refetchApps,
  } = useQuery<LoanApplication[]>({
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
  // application has no document-bearing conditions, the page shows an honest
  // scoped empty state instead of inventing a generic required list.
  const {
    data: checklistData,
    isLoading: checklistLoading,
    isError: checklistError,
    error: checklistErrorObj,
    refetch: refetchChecklist,
  } = useQuery<{
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
      let taxAnalysisStatus: "queued" | "authorization_required" | undefined;
      try {
        const registeredResponse = await apiRequest("POST", "/api/documents/upload", {
          objectPath: response.objectPath,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          documentType: docType,
          ...(focusAppId ? { applicationId: focusAppId } : {}),
          ...(replacesDocumentId ? { replacesDocumentId } : {}),
        });
        const registered = await registeredResponse.json() as {
          taxAnalysis?: { status?: "queued" | "authorization_required" };
        };
        taxAnalysisStatus = registered.taxAnalysis?.status;
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
      toast({
        title: "Document uploaded",
        description: taxAnalysisStatus === "queued"
          ? "Secure tax analysis has started. Your loan team will review every figure before it can support a decision."
          : taxAnalysisStatus === "authorization_required"
            ? "Your return is secure. Complete the Tax Document Use Authorization in To-do so we can analyze it; you won't need to upload it again."
            : getUploadNextStep(docType),
      });
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

  if (authLoading || isLoading || appsLoading || (!!focusAppId && checklistLoading)) {
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
  if (docsError || appsError || checklistError) {
    return (
      <PageShell width="wide" title="Document Checklist" subtitle="Submit required documents as requested — we may ask for more as your application progresses">
        <QueryErrorState
          error={docsErrorObj ?? appsErrorObj ?? checklistErrorObj}
          onRetry={() => {
            void refetchDocs();
            void refetchApps();
            if (focusAppId) void refetchChecklist();
          }}
          title="We couldn't load your document plan"
          data-testid="documents-error"
        />
      </PageShell>
    );
  }

  const documents = data?.documents || [];

  if (!activeApplication) {
    return (
      <PageShell
        width="wide"
        title="Documents"
        subtitle="Keep planning records secure before you begin a mortgage application"
      >
        <EmptyState
          scope="mortgage document checklist"
          description="Start an application and we'll build a focused checklist from your income, assets, property, and loan goal. You'll only see requests that apply to you."
          action={(
            <Button asChild>
              <Link href="/apply">Start Application</Link>
            </Button>
          )}
          data-testid="documents-no-active-application"
        />
        {documents.length > 0 && (
          <UploadedDocumentsTable
            documents={documents}
            title="Planning Documents"
            scopeLabel="saved to your account"
          />
        )}
      </PageShell>
    );
  }

  if (!personalized) {
    const isDraft = activeApplication.status === "draft";
    return (
      <PageShell
        width="wide"
        title="Document Checklist"
        subtitle="Document requests based on this application"
      >
        <EmptyState
          scope="document requests for this application"
          description={isDraft
            ? "Finish the application questions first. We'll use your answers to request only the documents that apply to this loan."
            : "You have no open document requests on this application. If your loan team needs something, it will appear here with the reason."}
          action={isDraft ? (
            <Button asChild>
              <Link href="/apply">Continue Application</Link>
            </Button>
          ) : undefined}
          data-testid="documents-no-personalized-requests"
        />
        {documents.length > 0 && <UploadedDocumentsTable documents={documents} />}
      </PageShell>
    );
  }

  // Calculate current status - count pending required items. Personalized
  // mode counts the pipeline's own items. The retired generic fallback marked
  // irrelevant tax, asset, and property documents as required.
  const pendingCount = countPendingChecklistItems(personalizedItems);
  const isAllSubmitted = pendingCount === 0;
  const isAllVerified = personalizedItems.length > 0 && personalizedItems.every(
    (item) => item.status === "verified",
  );

  const personalizedGroups = buildPersonalizedGroups(personalizedItems);

  const rowFromItem = (item: ChecklistItemView): DocRow => rowFromChecklistItem(item, conditionId);

  const statusInfo = getChecklistStatusInfo(isAllSubmitted, pendingCount, isAllVerified);

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
        {[...personalizedGroups.entries()].map(([catId, items]) => (
              <PersonalizedCategoryCard
                key={catId}
                categoryId={catId}
                items={items}
                rowFromItem={rowFromItem}
                upload={uploadControls}
              />
            ))}

        {documents.length > 0 && <UploadedDocumentsTable documents={documents} />}
      </div>
      </PageShell>
    </>
  );
}
