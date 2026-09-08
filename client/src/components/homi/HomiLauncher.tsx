import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/Logo";
import { ASSISTANT_NAME } from "@shared/assistant/identity";

/**
 * The floating launcher — Homi reachable from wherever the borrower is stuck,
 * instead of only from its own page.
 *
 * 🚨 THIS FILE IS EAGER. KEEP IT TINY.
 *
 * `App.tsx` imports `PrivateLayout` non-lazily, and this mounts inside it, so
 * every byte here is in the entry chunk that every first-time visitor downloads
 * before anything renders. Worse, Rollup hoists a module shared by an eager AND
 * a lazy chunk WHOLE into the eager one — so importing the chat surface here
 * would drag `useCoachStream`, the markdown renderer, the panels, Plaid and the
 * upload button onto the landing page's critical path.
 *
 * Everything it imports is ALREADY eager for other reasons: `Button` and the
 * brand `Logo` are used by the private shell, `useLocation` by App.tsx, and
 * `ASSISTANT_NAME` is a zero-import leaf. So this costs the entry chunk roughly
 * the size of its own JSX while giving Homi the same identity everywhere.
 *
 * The chat lives in `HomiDock`, behind `lazy()`. The dock and the /ai-coach
 * page are both lazy importers of the same modules, so Rollup puts the shared
 * chat code in a common LAZY chunk — fetched on first open, never before.
 * `pnpm guard:bundle` is what enforces this; see the PR body for the delta.
 */
const HomiDock = lazy(() => import("@/components/homi/HomiDock"));

/** The assistant's own page — a launcher there would open a window onto itself. */
const ASSISTANT_ROUTES = ["/ai-coach", "/homi"];

export function HomiLauncher() {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  // Kept mounted once opened so a minimize does not discard the conversation.
  const [everOpened, setEverOpened] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    // Return focus to the control that opened it — without this a keyboard user
    // is dropped at the top of the document with no idea where they are.
    launcherRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (ASSISTANT_ROUTES.includes(location)) return null;

  return (
    <>
      <Button
        ref={launcherRef}
        onClick={() => {
          setOpen((v) => !v);
          setEverOpened(true);
        }}
        size="icon"
        aria-expanded={open}
        aria-controls="homi-dock"
        aria-label={open ? `Minimize ${ASSISTANT_NAME}` : `Ask ${ASSISTANT_NAME}`}
        data-testid="button-homi-launcher"
        /*
         * Sits above page content but BELOW MobileBottomNav (z-50, mobile-only),
         * and above the corner StickyFormBar already reserves for it
         * (`mr-14 sm:mr-16` — that reservation predates this component).
         * bottom-20 on mobile clears the bottom nav; bottom-6 from md up.
         */
        className="touch-target fixed bottom-20 right-4 z-40 h-14 w-14 rounded-full shadow-lg md:bottom-6 md:right-6"
      >
        <Logo size="sm" variant="mark" tone="onDark" data-testid="logo-homi-launcher" />
      </Button>

      {everOpened && (
        <Suspense fallback={null}>
          {/* Rendered while hidden so a minimize keeps the conversation. */}
          <HomiDock open={open} onClose={close} />
        </Suspense>
      )}
    </>
  );
}
