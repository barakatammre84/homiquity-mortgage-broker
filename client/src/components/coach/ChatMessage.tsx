import { User } from "lucide-react";
import { Logo } from "@/components/brand/Logo";
import { MessageContent } from "./MessageContent";
import type { CoachMessage } from "./types";

export function ChatMessage({ message }: { message: CoachMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`} data-testid={`chat-message-${message.id}`}>
      <div className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${
        isUser ? "bg-primary text-primary-foreground" : "bg-success/10 text-success-subtle-foreground"
      }`}>
        {isUser ? <User className="h-4 w-4" /> : <Logo size="sm" variant="mark" data-testid="logo-homi-message" />}
      </div>
      <div className={`flex-1 max-w-[85%] ${isUser ? "text-right" : ""}`}>
        <div className={`inline-block text-left rounded-xl px-4 py-3 text-sm leading-relaxed ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}>
          <MessageContent content={message.content} />
        </div>
        <p className="text-[10px] text-muted-foreground mt-1 px-1">
          {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}

/** The user's just-sent message, rendered instantly (no server round-trip). */
export function PendingUserMessage({ content }: { content: string }) {
  return (
    <div className="flex gap-3 flex-row-reverse" data-testid="chat-message-pending">
      <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center bg-primary text-primary-foreground">
        <User className="h-4 w-4" />
      </div>
      <div className="flex-1 max-w-[85%] text-right">
        <div className="inline-block text-left rounded-xl px-4 py-3 text-sm leading-relaxed bg-primary text-primary-foreground">
          <MessageContent content={content} />
        </div>
      </div>
    </div>
  );
}

/** The assistant reply as it streams in, with a live cursor. */
export function StreamingMessage({ text }: { text: string }) {
  return (
    <div className="flex gap-3" data-testid="chat-message-streaming">
      <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center bg-success/10 text-success-subtle-foreground">
        <Logo size="sm" variant="mark" data-testid="logo-homi-streaming" />
      </div>
      <div className="flex-1 max-w-[85%]">
        <div className="inline-block text-left rounded-xl px-4 py-3 text-sm leading-relaxed bg-muted text-foreground">
          <MessageContent content={text} />
          <span className="inline-block h-3.5 w-[2px] bg-current opacity-60 animate-pulse align-baseline ml-0.5" aria-hidden />
        </div>
      </div>
    </div>
  );
}

/** Shown between send and the first streamed token. */
export function TypingIndicator({ label = "Thinking…" }: { label?: string }) {
  return (
    <div className="flex gap-3" data-testid="chat-typing-indicator">
      <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center bg-success/10 text-success-subtle-foreground">
        <Logo size="sm" variant="mark" data-testid="logo-homi-typing" />
      </div>
      <div className="bg-muted rounded-xl px-4 py-3 flex items-center gap-1.5">
        <span className="sr-only">{label}</span>
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60 animate-bounce" />
      </div>
    </div>
  );
}
