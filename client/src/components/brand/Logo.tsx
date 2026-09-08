import * as React from "react";

import { cn } from "@/lib/utils";
import { useBranding } from "./BrandingProvider";

/**
 * The one brand lockup. Branding-aware: on a private surface with an active
 * tenant it shows the tenant logo/brand name; otherwise the Homiquity wordmark
 * + logomark. See DESIGN_SYSTEM.md → Brand & white-label.
 *
 * This replaces 18 copy-pasted `homiquity` spans — not the "~13" an earlier
 * revision of this comment claimed; the census was re-run and the real count is
 * 18. They rendered in FIVE different tones with no rule behind which was which:
 * Login orange and Signup emerald, with byte-identical markup around them.
 * Centralising them here is what makes the tone a decision instead of an
 * accident.
 */

const wordmarkSize = {
  sm: "text-lg",
  md: "text-xl",
  lg: "text-2xl",
  xl: "text-3xl",
} as const;

// Height only. `.brand-mark` carries the artwork's real aspect-ratio, so the
// width follows from the height — pinning `w-*` as well would force a square and
// letterbox the mark inside it.
const markSize = {
  sm: "h-5",
  md: "h-6",
  lg: "h-7",
  xl: "h-9",
} as const;

const imgHeight = {
  sm: "h-6",
  md: "h-7",
  lg: "h-9",
  xl: "h-11",
} as const;

const toneClass = {
  brand: "text-flare", // the wordmark carries the orange accent on light surfaces.
  // WCAG 1.4.3 exempts logotypes from contrast, which is why the BRIGHT flare is
  // permitted here and nowhere a person has to read prose (use --flare-ink there).
  onDark: "text-sidebar-foreground", // on the royal sidebar / dark surfaces
  mono: "text-foreground", // neutral
} as const;

export interface LogoProps {
  size?: keyof typeof wordmarkSize;
  variant?: "wordmark" | "mark" | "lockup";
  tone?: keyof typeof toneClass;
  /**
   * Which artwork to paint. The kit holds two drawings, and they are a
   * large/small pair rather than duplicates: `compact` (solid stem) stays legible
   * down to 16px, `primary` (outlined stem + chart columns) turns to a blob below
   * ~48px. Every lockup here renders the mark at 20-28px, so `compact` is the
   * default and `primary` is an opt-in for hero-scale use.
   */
  mark?: "compact" | "primary";
  className?: string;
  "data-testid"?: string;
}

/**
 * Homiquity logomark — the founder's h-as-bridge mark with the growth arrow.
 *
 * Painted as a CSS mask (see `.brand-mark` in index.css), not an <img> or inline
 * SVG: the mask takes its colour from `currentColor`, so one asset serves every
 * tone and a white-label tenant's re-skin reaches it for free. It replaced a
 * hand-drawn "rising roofline" placeholder that was never the real logo and that
 * nothing ever imported.
 */
function Logomark({
  className,
  mark,
}: {
  className?: string;
  mark: "compact" | "primary";
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(mark === "primary" ? "brand-mark-primary" : "brand-mark", className)}
    />
  );
}

export function Logo({
  size = "md",
  variant = "lockup",
  tone = "brand",
  mark = "compact",
  className,
  "data-testid": testId = "logo",
}: LogoProps) {
  const { isWhiteLabeled, logoUrl, brandName } = useBranding();

  // White-label: a tenant logo image wins when present.
  if (isWhiteLabeled && logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={brandName ?? "Brand logo"}
        className={cn("object-contain w-auto", imgHeight[size], className)}
        data-testid={testId}
      />
    );
  }

  const label = isWhiteLabeled && brandName ? brandName : "homiquity";
  const showMark = variant !== "wordmark";
  const showWord = variant !== "mark";

  return (
    <span
      className={cn("inline-flex items-center gap-2", toneClass[tone], className)}
      data-testid={testId}
      // The mark itself is aria-hidden (it is a mask, so it carries no text).
      // When the wordmark is showing, the visible name IS the accessible name and
      // labelling the wrapper too would make a screen reader announce it twice.
      // With `variant="mark"` there is no text at all, so the wrapper has to
      // supply the name or the logo is an unlabelled decoration.
      {...(showWord ? {} : { role: "img", "aria-label": label })}
    >
      {showMark && <Logomark className={markSize[size]} mark={mark} />}
      {showWord && (
        <span className={cn("font-bold tracking-tight", wordmarkSize[size])}>
          {label}
        </span>
      )}
    </span>
  );
}
