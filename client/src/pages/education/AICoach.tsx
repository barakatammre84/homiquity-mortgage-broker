import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, coachContextKeys, coachConversationKeys } from "@/lib/queryClient";
import { clearPendingCoachQuestion, readPendingCoachQuestion } from "@/lib/pendingCoachQuestion";
import { Button } from "@/components/ui/button";
import { companyNmlsDisplay } from "@shared/companyIdentity";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { usePageView, useTrackActivity, useTrackCoachSession } from "@/hooks/useActivityTracker";
import { useCoachStream } from "@/components/coach/useCoachStream";
import { MessageList } from "@/components/coach/MessageList";
import { Composer } from "@/components/coach/Composer";
import { ConversationSidebar } from "@/components/coach/ConversationSidebar";
import { Logo } from "@/components/brand/Logo";
import { InsightsBanner, WelcomeState } from "@/components/coach/WelcomeState";
import { ActionPlanPanel, ConnectedFilePanel, DocumentChecklistInline, DocumentEvidencePanel } from "@/components/coach/panels";
import type {
  ActionPlanItem,
  CoachConversation,
  CoachInsight,
  CoachMessage,
  CoachProfile,
  CoachUsage,
  CoachDocumentEvidenceView,
  LoanStatusView,
  PlanningDocumentStatsView,
  FileDocumentStatsView,
} from "@/components/coach/types";
import type { ChecklistItemView } from "@/lib/documentChecklist";

// The Homi — streaming chat (SSE via useCoachStream) with a live
// "Pre-App Profile" capture panel. Everything the model captures through the
// record_intake tool is auto-saved to the borrower's draft application
// server-side and surfaced here as a visible trail.

function getSourceContext(): { banner: string; autoMessage: string } | null {
  const params = new URLSearchParams(window.location.search);
  const source = params.get("source");
  const context = params.get("context");
  const type = params.get("type");

  if (source === "va" || type === "va" || context === "va") {
    return {
      banner: "VA Loan Guidance",
      autoMessage: "I'm a veteran and I'd like to explore VA loan options. Can you help me understand my eligibility and benefits?",
    };
  }
  if (source === "first-time" || context === "first-time") {
    return {
      banner: "First-Time Buyer",
      autoMessage: "I'm a first-time homebuyer and I want to understand what I need to get started. Can you assess my readiness?",
    };
  }
  if (source === "refinance" || type === "refinance") {
    return {
      banner: "Refinance Guidance",
      autoMessage: "I'm interested in refinancing my current mortgage. Can you help me understand my options?",
    };
  }
  if (source === "investor" || context === "investor") {
    return {
      banner: "Investment Property",
      autoMessage: "I'm looking at investment properties. Can you help me understand mortgage requirements for rental properties?",
    };
  }
  const propertyPrice = params.get("propertyPrice");
  const propertyAddress = params.get("propertyAddress");
  if (propertyPrice && propertyAddress) {
    const formattedPrice = parseFloat(propertyPrice).toLocaleString();
    return {
      banner: "Property Analysis",
      autoMessage: `I'm looking at a property at ${decodeURIComponent(propertyAddress)} listed at $${formattedPrice}. What information is still needed before my loan team can evaluate this property?`,
    };
  }
  if (propertyPrice) {
    const formattedPrice = parseFloat(propertyPrice).toLocaleString();
    return {
      banner: "Property Analysis",
      autoMessage: `I'm considering a home priced at $${formattedPrice}. What information is still needed before my loan team can evaluate it?`,
    };
  }
  return null;
}

export default function AICoach() {
  const queryClient = useQueryClient();
  usePageView("/ai-coach");
  const trackActivity = useTrackActivity();
  const trackCoachSession = useTrackCoachSession();
  const { toast } = useToast();

  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => {
    const requested = new URLSearchParams(window.location.search).get("conversation");
    return requested?.trim() || null;
  });
  const [sourceHandled, setSourceHandled] = useState(false);
  const [mobileConvOpen, setMobileConvOpen] = useState(false);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  const { data: conversations = [], isLoading: loadingConvs } = useQuery<CoachConversation[]>({
    queryKey: coachConversationKeys.all(),
  });

  const { data: activeData } = useQuery<{
    conversation: CoachConversation;
    messages: CoachMessage[];
  }>({
    queryKey: coachConversationKeys.detail(activeConversationId!),
    enabled: !!activeConversationId,
  });

  const { data: usage } = useQuery<CoachUsage>({
    queryKey: ["/api/coach/usage"],
  });

  const { data: insightsData } = useQuery<{ insights: CoachInsight[]; hasApplication: boolean; hasAssessment: boolean }>({
    queryKey: ["/api/coach/insights"],
  });

  /**
   * The borrower's file, from the same functions the assistant's tools read.
   *
   * Fetched on load rather than only mid-turn: before this, a returning
   * borrower saw whatever the LAST turn left in the conversation row until
   * they typed again — stale figures presented as current, on a file that may
   * have moved days ago.
   */
  const { data: fileContext, isLoading: fileContextLoading, isError: fileContextError, refetch: refetchFileContext } = useQuery<{
    hasApplication: boolean;
    applicationId: string | null;
    loanStatus: LoanStatusView;
    documentChecklist: ChecklistItemView[];
    checklistStats: { total: number; verified: number; uploaded: number; needed: number; rejected: number } | null;
    planningDocumentStats: PlanningDocumentStatsView | null;
    fileDocumentStats: FileDocumentStatsView | null;
    tasks: unknown[];
    readiness: CoachProfile;
  }>({
    queryKey: coachContextKeys.root(),
  });

  const { turn, send, retry, dismissError, isBusy } = useCoachStream({
    conversationId: activeConversationId,
    onConversationId: setActiveConversationId,
  });

  // Returns whether the message was actually handed to the stream. Callers that
  // consume a one-shot input (the landing-hero handoff below) must not discard
  // it on a refusal — a rate-limited or mid-stream send is a no-op, and clearing
  // regardless would drop the question with nothing to show for it.
  const handleSend = (msg: string): boolean => {
    if (isBusy || usage?.isLimited) return false;
    if (!activeConversationId) {
      trackCoachSession("coach_session_start");
    }
    void send(msg);
    trackActivity("coach_chat", "/ai-coach");
    return true;
  };

  // The question the visitor typed into the public landing hero, carried across
  // the signup boundary in localStorage (see lib/pendingAttribution.ts). It runs
  // ahead of getSourceContext and WITHOUT that effect's `conversations.length === 0`
  // guard: a returning borrower who asks something on the home page meant to ask
  // it, and having prior conversations is no reason to swallow it.
  const heroQuestionSent = useRef(false);
  useEffect(() => {
    if (heroQuestionSent.current || activeConversationId || loadingConvs) return;
    const pending = readPendingCoachQuestion();
    if (!pending) return;
    if (handleSend(pending)) {
      heroQuestionSent.current = true;
      clearPendingCoachQuestion();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, loadingConvs, isBusy, usage?.isLimited]);

  const sourceContext = getSourceContext();
  useEffect(() => {
    if (heroQuestionSent.current) return;
    if (sourceContext && !sourceHandled && !activeConversationId && conversations.length === 0 && !loadingConvs) {
      setSourceHandled(true);
      handleSend(sourceContext.autoMessage);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceContext, sourceHandled, activeConversationId, conversations.length, loadingConvs]);

  const toggleActionItem = useMutation({
    mutationFn: async (itemId: string) => {
      if (!activeConversationId) return;
      const res = await apiRequest("PATCH", `/api/coach/conversations/${activeConversationId}/action-plan/${itemId}`);
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: coachConversationKeys.detail(activeConversationId!) });
      queryClient.invalidateQueries({ queryKey: coachConversationKeys.all() });
      if (data?.toggled) {
        toast({
          title: data.toggled.completed ? "Nice work!" : "Unmarked",
          description: data.toggled.completed
            ? `"${data.toggled.title}" marked as complete.`
            : `"${data.toggled.title}" marked as incomplete.`,
        });
      }
    },
    // Silent before: the checkbox simply did not change, so an action item
    // looked un-tickable for no visible reason.
    onError: (error: Error) => {
      toast({
        title: "Couldn't update that item",
        description: error.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  const messages = activeData?.messages ?? [];
  const activeConv = activeData?.conversation;

  // Live turn data overrides the persisted conversation while streaming.
  // The file panels read SERVER TRUTH first and fall back to nothing.
  //
  // They used to fall back to activeConv.documentChecklist — the legacy column
  // the deleted set_document_checklist tool wrote. Those rows are precisely the
  // invented ones: a docType matching no loan_condition, rendered next to an
  // Upload button that could never clear it. Reading them again would
  // reintroduce the bug for every borrower with history.
  const currentFileContext = fileContextError ? undefined : fileContext;
  const loanStatus = (turn.panel.loanStatus ?? currentFileContext?.loanStatus ?? null) as LoanStatusView | null;
  const documentChecklist = (turn.panel.documentChecklist
    ?? currentFileContext?.documentChecklist
    ?? null) as ChecklistItemView[] | null;
  // The action plan is the one panel the assistant still authors, so it keeps
  // its conversation-scoped fallback — it belongs to the chat, not the file.
  const actionPlan = (turn.panel.actionPlan ?? activeConv?.actionPlan ?? null) as ActionPlanItem[] | null;
  // Application to attach a Plaid connection to — surfaced by record_intake's
  // captured events; null until the coach has saved intake this session.
  const capturedAppId = useMemo(() => {
    let id: string | null = null;
    for (const e of turn.captured) if (e.applicationId) id = e.applicationId;
    return id;
  }, [turn.captured]);
  const activeApplicationId = capturedAppId ?? currentFileContext?.applicationId ?? null;
  const hasChecklist = !!documentChecklist && documentChecklist.length > 0;

  const insights = insightsData?.insights ?? [];
  // First-message fix: an in-flight turn counts as an active chat, so the
  // pending bubble + typing indicator render immediately on the very first send.
  const hasActiveChat = !!activeConversationId || messages.length > 0 || turn.status !== "idle";

  const selectConversation = (id: string | null) => {
    if (isBusy) return;
    dismissError();
    setActiveConversationId(id);
    setMobileConvOpen(false);
  };

  const sidePanelContent = (
    <ConnectedFilePanel
      status={loanStatus}
      docs={documentChecklist ?? []}
      planningDocuments={currentFileContext?.planningDocumentStats ?? null}
      fileDocuments={currentFileContext?.fileDocumentStats ?? null}
      loading={fileContextLoading}
      error={fileContextError}
      onRetry={() => { void refetchFileContext(); }}
    />
  );

  const conversationListContent = (
    <>
      <div className="mb-4 flex items-center gap-3 border-b border-border px-1 pb-4">
        <Logo variant="mark" tone="mono" size="sm" data-testid="logo-homi-history" />
        <div>
          <h2 className="font-semibold text-foreground">Conversation history</h2>
          <p className="text-xs text-muted-foreground">Return to an earlier question or start fresh.</p>
        </div>
      </div>
      {loadingConvs ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Loading conversations…</p>
      ) : (
        <ConversationSidebar
          conversations={conversations}
          activeId={activeConversationId}
          onSelect={(id) => selectConversation(id)}
          onNew={() => selectConversation(null)}
        />
      )}
    </>
  );

  const documentEvidence = turn.panel.documentEvidence as CoachDocumentEvidenceView | undefined;
  const activeArtifact = documentEvidence ? (
    <div className="mx-auto mb-2 w-full max-w-3xl px-3">
      <DocumentEvidencePanel evidence={documentEvidence} />
    </div>
  ) : hasChecklist ? (
    <DocumentChecklistInline docs={documentChecklist!} applicationId={activeApplicationId} />
  ) : actionPlan && actionPlan.length > 0 ? (
    <div className="mx-auto mb-2 w-full max-w-3xl px-3">
      <ActionPlanPanel plan={actionPlan} onToggle={(itemId) => toggleActionItem.mutate(itemId)} />
    </div>
  ) : null;

  return (
    <div className="flex h-[calc(100vh-4rem)] bg-surface" data-testid="page-ai-coach">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-background px-3 py-3 sm:px-5" data-testid="homi-workspace-header">
          <Logo variant="mark" tone="mono" size="md" data-testid="logo-homi-workspace" />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-lg font-bold leading-tight">Homi Workspace</h1>
            <p className="truncate text-xs text-muted-foreground" data-testid="text-active-conversation-title">
              {activeConv?.title || "Your mortgage questions and connected file"}
            </p>
          </div>

          <Sheet open={mobileConvOpen} onOpenChange={setMobileConvOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="touch-target" data-testid="button-mobile-conversations">History</Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-80 p-4">
              <SheetHeader className="sr-only"><SheetTitle>Conversation history</SheetTitle></SheetHeader>
              {conversationListContent}
            </SheetContent>
          </Sheet>

          <Sheet open={mobilePanelOpen} onOpenChange={setMobilePanelOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="touch-target xl:hidden" data-testid="button-mobile-panel">My file</Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-80 overflow-y-auto p-4">
              <SheetHeader className="sr-only"><SheetTitle>Your connected file</SheetTitle></SheetHeader>
              {sidePanelContent}
            </SheetContent>
          </Sheet>
        </header>

        {turn.degraded && (
          <div className="border-b border-border bg-muted px-4 py-2 text-xs text-muted-foreground" data-testid="banner-degraded">
            Homi is using standard guidance right now. Your connected file remains available, and your loan officer can still help.
          </div>
        )}

        <div className="border-b border-border bg-background px-4 py-2 text-xs text-muted-foreground" data-testid="banner-coach-disclosure">
          <span>
            You're chatting with Homiquity's AI assistant. Its guidance is educational — estimates aren't offers or approvals, and final terms come from underwriting review and official disclosures. Please don't share your Social Security number or date of birth in chat.
            {companyNmlsDisplay() ? ` ${companyNmlsDisplay()} · ` : " "}Equal Housing Opportunity.
          </span>
        </div>

        {!hasActiveChat ? (
          <WelcomeState onStart={(msg) => handleSend(msg)} insights={insights} />
        ) : (
          <>
            {insights.length > 0 && messages.length === 0 && turn.status === "idle" && (
              <InsightsBanner insights={insights} onAction={(msg) => handleSend(msg)} />
            )}
            <MessageList messages={messages} turn={turn} onRetry={retry} onDismissError={dismissError} />
          </>
        )}

        {hasActiveChat && activeArtifact}

        {hasActiveChat && (
          <Composer onSend={handleSend} busy={isBusy} usage={usage} suggestions={turn.panel.suggestions} />
        )}
      </div>

      <aside className="hidden w-80 overflow-y-auto border-l border-border bg-background p-4 xl:block" aria-label="Connected file">
        {sidePanelContent}
      </aside>
    </div>
  );
}
