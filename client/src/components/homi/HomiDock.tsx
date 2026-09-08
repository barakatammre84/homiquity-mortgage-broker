import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/Logo";
import { coachConversationKeys } from "@/lib/queryClient";
import { Icons, iconSize } from "@/lib/icons";
import { companyNmlsDisplay, COMPANY_IDENTITY } from "@shared/companyIdentity";
import { ASSISTANT_NAME } from "@shared/assistant/identity";
import { useCoachStream } from "@/components/coach/useCoachStream";
import { MessageList } from "@/components/coach/MessageList";
import { Composer } from "@/components/coach/Composer";
import type { CoachConversation, CoachMessage, CoachUsage } from "@/components/coach/types";

/**
 * The chat itself, behind `lazy()` in HomiLauncher — never on the entry chunk.
 *
 * It shares useCoachStream / MessageList / Composer with the /ai-coach page.
 * Both importers are lazy, so Rollup puts the shared chat code in a common LAZY
 * chunk rather than hoisting it into the eager one. That is the whole reason
 * the launcher is split from this file.
 *
 * Kept MOUNTED while minimized (the launcher renders it with `open=false`
 * rather than unmounting): a borrower who minimizes mid-answer and reopens
 * should find their conversation, not a blank panel.
 */
export default function HomiDock({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const { data } = useQuery<{ conversation: CoachConversation; messages: CoachMessage[] }>({
    queryKey: coachConversationKeys.detail(conversationId!),
    enabled: !!conversationId,
  });
  const { data: usage } = useQuery<CoachUsage>({ queryKey: ["/api/coach/usage"] });

  const { turn, send, retry, dismissError, isBusy } = useCoachStream({
    conversationId,
    onConversationId: setConversationId,
  });

  // Move focus into the panel on open so a keyboard user lands inside the thing
  // they just opened rather than continuing from the launcher behind it.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const messages = data?.messages ?? [];

  return (
    <div
      id="homi-dock"
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-label={`Chat with ${ASSISTANT_NAME}`}
      data-testid="homi-dock"
      // `hidden` rather than unmounted — see the mounted-while-minimized note.
      hidden={!open}
      className="fixed bottom-36 right-4 z-40 flex h-[min(32rem,70vh)] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-xl focus:outline-none md:bottom-24 md:right-6"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Logo size="sm" variant="mark" data-testid="logo-homi-dock" />
        <span className="text-sm font-semibold text-foreground">{ASSISTANT_NAME}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button asChild size="icon" variant="ghost" className="touch-target h-11 w-11" data-testid="link-homi-full-page">
            <Link href="/ai-coach" aria-label={`Open ${ASSISTANT_NAME} full page`}>
              <Icons.externalLink className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="touch-target h-11 w-11"
            onClick={onClose}
            aria-label={`Minimize ${ASSISTANT_NAME}`}
            data-testid="button-homi-minimize"
          >
            <Icons.minimize className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/*
        First-contact disclosure — the same compliance artifact the full page
        carries, and it renders BEFORE Homi's first word, not after it fails.
        Static copy, deliberately not model-generated: AI identity, the
        educational-guidance limitation, the PII channel rule, and the SAFE Act
        unique identifier (which appears only once licensed).
      */}
      <div
        className="flex items-start gap-2 border-b px-3 py-2 text-xs text-muted-foreground"
        data-testid="banner-homi-disclosure"
      >
        <Icons.security className={`${iconSize.dense} mt-0.5 shrink-0`} />
        <span>
          You're chatting with {ASSISTANT_NAME}, Homiquity's AI assistant. Its guidance is
          educational — estimates aren't offers or approvals, and final terms come from underwriting
          review and official disclosures. Please don't share your Social Security number or date of
          birth in chat.
          {companyNmlsDisplay() ? ` ${companyNmlsDisplay()} · ` : " "}Equal Housing Opportunity.
          {COMPANY_IDENTITY.contactPhone ? (
            <>
              {" "}Prefer a person? Call{" "}
              <a href={`tel:${COMPANY_IDENTITY.contactPhone}`} className="underline">
                {COMPANY_IDENTITY.contactPhone}
              </a>
              .
            </>
          ) : null}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 && turn.status === "idle" ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground" data-testid="text-homi-empty">
            Ask about your documents, where your file stands, or anything about the process.
          </p>
        ) : (
          <MessageList messages={messages} turn={turn} onRetry={retry} onDismissError={dismissError} />
        )}
      </div>

      <Composer
        onSend={(m) => send(m)}
        busy={isBusy}
        usage={usage}
        suggestions={turn.panel.suggestions}
      />
    </div>
  );
}
