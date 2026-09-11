import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest, coachContextKeys, coachConversationKeys } from "@/lib/queryClient";
import type {
  CapturedEvent,
  CoachPanelState,
  CoachStreamError,
  TurnStatus,
} from "./types";

// Transport hook for the coach chat: POSTs to the SSE endpoint and parses the
// frame stream with a fetch reader (EventSource can't POST). Turn state lives
// here as an overlay rendered AFTER the query-cached messages — which is what
// fixes the old first-message dead-air bug (the page used to show nothing
// until the full round-trip + refetch landed).
//
// Fallback: if the stream endpoint 404s (client deployed ahead of the server),
// the same message is sent once through the buffered JSON endpoint. A proxy
// that buffers SSE still works — frames just arrive late in one batch.

export interface CoachTurnState {
  status: TurnStatus;
  pendingUserMessage: string | null;
  streamingText: string;
  captured: CapturedEvent[];
  panel: CoachPanelState;
  lintReplaced: boolean;
  degraded: boolean;
  error: CoachStreamError | null;
}

const IDLE_TURN: CoachTurnState = {
  status: "idle",
  pendingUserMessage: null,
  streamingText: "",
  captured: [],
  panel: {},
  lintReplaced: false,
  degraded: false,
  error: null,
};

export interface SendExtras {
  propertyPrice?: number;
  propertyAddress?: string;
}

export function useCoachStream(opts: {
  conversationId: string | null;
  onConversationId: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [turn, setTurn] = useState<CoachTurnState>(IDLE_TURN);
  const lastSendRef = useRef<{ message: string; extras?: SendExtras } | null>(null);
  const convIdRef = useRef<string | null>(null);
  const suppressTextRef = useRef(false);

  // Text deltas are buffered and flushed on a short timer so the markdown
  // renderer re-parses ~20×/s instead of once per token.
  const textBufferRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushText = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (!textBufferRef.current) return;
    const chunk = textBufferRef.current;
    textBufferRef.current = "";
    setTurn((t) => ({ ...t, streamingText: t.streamingText + chunk }));
  }, []);

  const queueText = useCallback((delta: string) => {
    if (suppressTextRef.current) return;
    textBufferRef.current += delta;
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(flushText, 50);
    }
  }, [flushText]);

  const finalize = useCallback(async (conversationId: string | null) => {
    flushText();
    setTurn((t) => ({ ...t, status: "finalizing" }));
    const invalidations = [
      queryClient.invalidateQueries({ queryKey: coachConversationKeys.all() }),
      queryClient.invalidateQueries({ queryKey: ["/api/coach/usage"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/coach/intake/latest"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/profile/financial"] }),
      // A record_intake writeback this turn can move readiness, and the file
      // may have changed under a long conversation. Re-read it rather than
      // trusting what the turn happened to emit.
      queryClient.invalidateQueries({ queryKey: coachContextKeys.root() }),
    ];
    if (conversationId) {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: coachConversationKeys.detail(conversationId) }),
      );
    }
    await Promise.allSettled(invalidations);
    // Keep `captured` (the "saved just now" flash) and the suggestion chips
    // visible after the turn; the next send resets them.
    setTurn((t) => ({
      ...IDLE_TURN,
      captured: t.captured,
      panel: {
        suggestions: t.panel.suggestions,
        documentEvidence: t.panel.documentEvidence,
        documentChecklist: t.panel.documentChecklist,
      },
      degraded: t.degraded,
    }));
  }, [flushText, queryClient]);

  const runJsonFallback = useCallback(
    async (message: string, extras: SendExtras | undefined, conversationId: string | null) => {
      const res = await apiRequest("POST", "/api/coach/message", {
        message,
        conversationId: conversationId || undefined,
        ...extras,
      });
      const data = await res.json();
      if (data.conversationId && !convIdRef.current) {
        convIdRef.current = data.conversationId;
        opts.onConversationId(data.conversationId);
      }
      setTurn((t) => ({
        ...t,
        status: "streaming",
        degraded: !!data.degraded,
        captured: data.captured ? [...t.captured, { ...data.captured, at: Date.now() }] : t.captured,
        panel: {
          ...t.panel,
          ...(data.suggestions ? { suggestions: data.suggestions } : {}),
          ...(data.documentEvidence ? { documentEvidence: data.documentEvidence } : {}),
        },
      }));
      await finalize(data.conversationId ?? conversationId);
    },
    [finalize, opts],
  );

  const readSse = useCallback(
    async (body: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let doneReceived = false;
      let streamError: CoachStreamError | null = null;

      const handleFrame = (frame: string) => {
        const lines = frame.split("\n");
        const eventLine = lines.find((l) => l.startsWith("event: "));
        const dataLine = lines.find((l) => l.startsWith("data: "));
        if (!eventLine || !dataLine) return;
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataLine.slice("data: ".length));
        } catch {
          return;
        }
        switch (eventLine.slice("event: ".length)) {
          case "meta": {
            const id = data.conversationId as string;
            if (id && !convIdRef.current) {
              convIdRef.current = id;
              opts.onConversationId(id);
            } else if (id) {
              convIdRef.current = id;
            }
            setTurn((t) => ({ ...t, status: "streaming", degraded: !!data.degraded }));
            break;
          }
          case "text":
            queueText(String(data.delta ?? ""));
            break;
          case "captured":
            setTurn((t) => ({
              ...t,
              captured: [...t.captured, { ...(data as unknown as Omit<CapturedEvent, "at">), at: Date.now() }],
            }));
            break;
          case "panel":
            setTurn((t) => ({ ...t, panel: { ...t.panel, ...(data as CoachPanelState) } }));
            break;
          case "degraded":
            setTurn((t) => ({ ...t, degraded: true }));
            break;
          case "lint_replaced":
            // The streamed draft was replaced server-side; the persisted safe
            // message arrives with the refetch after `done`.
            suppressTextRef.current = true;
            textBufferRef.current = "";
            if (flushTimerRef.current) {
              clearTimeout(flushTimerRef.current);
              flushTimerRef.current = null;
            }
            setTurn((t) => ({ ...t, lintReplaced: true, streamingText: "" }));
            break;
          case "done":
            doneReceived = true;
            break;
          case "error":
            streamError = {
              code: String(data.code ?? "internal"),
              message: String(data.message ?? "Something went wrong."),
              retryable: !!data.retryable,
            };
            break;
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          handleFrame(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
        }
      }
      flushText();

      if (streamError) {
        setTurn((t) => ({ ...t, status: "error", error: streamError }));
        return;
      }
      if (doneReceived) {
        await finalize(convIdRef.current);
        return;
      }
      // Stream ended without done/error — connection dropped mid-turn. The
      // user message (and any synced intake) is already persisted server-side.
      setTurn((t) => ({
        ...t,
        status: "error",
        error: {
          code: "disconnected",
          message: "The connection was interrupted. Your message was received — refresh or try again.",
          retryable: true,
        },
      }));
      void queryClient.invalidateQueries({ queryKey: coachConversationKeys.all() });
      if (convIdRef.current) {
        void queryClient.invalidateQueries({ queryKey: coachConversationKeys.detail(convIdRef.current) });
      }
    },
    [finalize, flushText, opts, queryClient, queueText],
  );

  const send = useCallback(
    async (message: string, extras?: SendExtras) => {
      const text = message.trim();
      if (!text) return;
      lastSendRef.current = { message: text, extras };
      convIdRef.current = opts.conversationId;
      suppressTextRef.current = false;
      textBufferRef.current = "";
      setTurn({ ...IDLE_TURN, status: "connecting", pendingUserMessage: text });

      try {
        const res = await apiRequest("POST", "/api/coach/message/stream", {
          message: text,
          conversationId: opts.conversationId || undefined,
          ...extras,
        });
        if (!res.body) throw new Error("204: empty stream body");
        await readSse(res.body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("404")) {
          // Server predates the stream endpoint — the message was NOT
          // persisted (404 fires before prepare), so one JSON retry is safe.
          try {
            await runJsonFallback(text, extras, opts.conversationId);
            return;
          } catch (fallbackErr) {
            const fmsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            setTurn((t) => ({
              ...t,
              status: "error",
              error: { code: "request_failed", message: humanizeRequestError(fmsg), retryable: !fmsg.startsWith("429") },
            }));
            return;
          }
        }
        setTurn((t) => ({
          ...t,
          status: "error",
          error: {
            code: msg.startsWith("429") ? "daily_limit" : "request_failed",
            message: humanizeRequestError(msg),
            retryable: !msg.startsWith("429"),
          },
        }));
      }
    },
    [opts.conversationId, readSse, runJsonFallback],
  );

  const retry = useCallback(() => {
    const last = lastSendRef.current;
    if (last) void send(last.message, last.extras);
  }, [send]);

  const dismissError = useCallback(() => {
    setTurn((t) => ({ ...IDLE_TURN, captured: t.captured, panel: { suggestions: t.panel.suggestions } }));
  }, []);

  const isBusy = turn.status === "connecting" || turn.status === "streaming" || turn.status === "finalizing";

  return { turn, send, retry, dismissError, isBusy };
}

function humanizeRequestError(raw: string): string {
  if (raw.startsWith("429")) return "You've reached today's message limit. It resets tomorrow.";
  try {
    // apiRequest errors look like "502: {json body}" — surface the server's message.
    const jsonStart = raw.indexOf("{");
    if (jsonStart >= 0) {
      const parsed = JSON.parse(raw.slice(jsonStart));
      if (typeof parsed.error === "string") return parsed.error;
      if (typeof parsed.message === "string") return parsed.message;
    }
  } catch {
    // fall through to the generic message
  }
  return "Couldn't send your message. Please try again.";
}
