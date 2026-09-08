# Design System — Homiquity

**Status:** binding on every client surface. **Owner:** founder (Amr).
**Last verified against the code:** 2026-08-22 at `074899e3`.

> **Freshness:** last verified 2026-08-22 · review every 30 days
>
> ⚠️ The previous stamp read *2026-08-18 at `56cf00a`* — **two days before the palette
> rebuild landed** (`3cba2dae`, 2026-08-20). §1 described a system the code had already
> replaced, and the name "Royal Blue Emerald" propagated from here into CLAUDE.md, three
> auto-loading skill/agent files, and the token guard's own header. That is the failure
> mode this stamp exists to catch: **a doc can be "fresh" and wrong if the freshness date
> predates the change.** Re-verify §1 against `client/src/index.css` on any palette commit.

> **Code wins.** Tokens live in [`client/src/index.css`](../../../client/src/index.css) and
> [`tailwind.config.ts`](../../../tailwind.config.ts); primitives live in
> [`client/src/components/ui/`](../../../client/src/components/ui). When this doc and the code
> disagree, **the code is right and this doc is a bug** — fix the doc.
>
> **Supersedes** `design_guidelines.md` (the *language*) and `visual-consistency-standard.md`
> (the *checklist*), merged into this file on 2026-08-18 and archived at
> [`archive/design/`](../../archive/design/). They were split as why-vs-what on 2026-08-06; the
> split cost more than it bought, because a rule and its rationale drifted apart and **both
> halves went stale in the same five weeks** (§0). One file, one truth.
>
> **Scope:** visual and structural. Copy, terminology and voice are a separate,
> compliance-gated track and are not covered here — except where §13 makes an honesty claim
> about a specific control.

---

## 0. Adoption status — the part that rots, so it is measured

The predecessor docs marked in-flight work with **⏳**, a symbol that cannot distinguish
*designed but not built* from *built but nobody adopted it*. Both were true at once and the
docs could not say which, so three primitives shipped and then sat unused for five weeks while
the docs still called them future work — and the one number they did quote drifted in the
flattering direction (they said 57% of pages opt out of PageShell; the real figure had reached
**82%**).

So: **⏳ is retired.** Every row below carries a state, a measured number, and the command that
measures it. `SPEC'D` = decided, not built. `BUILT` = the code exists. `ADOPTED n%` = call
sites actually use it.

<!-- BEGIN GENERATED — do not hand-edit; run `pnpm guard:ui --write-table` -->

| Capability | State | Measured |
|---|---|---|
| `PageShell` page geometry | **BUILT · ADOPTED 17%** | 49 of 285 page files import it — *pnpm guard:ui → `pageShellDrift`* |
| Icon registry `lib/icons.ts` | **BUILT · ADOPTED 7%** | 25 file(s) import the registry, 323 still import `lucide-react` directly — *pnpm guard:ui → `directLucideImports`* |
| `PageShell fullHeight` | **BUILT · ADOPTED 0%** | zero call sites — correct: it is for `BareLayout` routes only, and none use PageShell yet |
| `Heading` / `Text` (`ui/typography.tsx`) | **BUILT · ADOPTED 0%** | zero call sites — allowlisted in `scripts/orphan-scan.cjs` as known-unused |
| `Logo` + `BrandingProvider` | **BUILT · ADOPTED** | 21 call site(s) |
| Raw `<button>` with no height, padding or `.touch-target` | **NEEDS REVIEW** | 34 in 25 file(s) — each is EITHER a sub-44px control or a button wrapping a large area; only a human can tell which |
| `EmptyState` | **BUILT** | 10 file(s) use it |
| `bg-surface` app ground | **ADOPTED (via layout)** | set once on `PrivateLayout`'s `<main>`; 3 file(s) name it directly — pages inherit it |
| Component tests / `components/ui` primitives | **BUILT** | colocated `*.test.tsx` beside components; 34 primitives — *pnpm test:client* |
| `pageShellDrift` — PageShell drift (hand-rolled min-h-screen in a file that also imports PageShell) | **HELD** | **0** file(s) — **at zero; any hit is a regression** |
| `directLucideImports` — direct lucide-react import (icon-registry drift) | ratcheting down | **323** file(s) |
| `nestedInteractive` — nested interactive control (a link wrapping a button) | **HELD** | **0** occurrence(s) — **at zero; any hit is a regression** |
| `rawHexLiterals` — raw hex colour literal | ratcheting down | **11** occurrence(s) |
| `arbitraryColorValues` — arbitrary colour value (bg-[#…], to-[hsl(…)]) | ratcheting down | **3** occurrence(s) |
| `arbitraryTypeScale` — arbitrary size/length value (text-[11px], w-[240px]) | ratcheting down | **151** occurrence(s) |
| `blindSpotPaletteClasses` — palette class in a shape the token guard cannot see | **HELD** | **0** occurrence(s) — **at zero; any hit is a regression** |
| `subMinTouchTarget` — Button size="sm" (h-9 = 36px) with no .touch-target | **HELD** | **0** occurrence(s) — **at zero; any hit is a regression** |
| `unprefixedMultiColGrid` — multi-column grid with no responsive prefix (mobile breakage) | ratcheting down | **58** occurrence(s) |

<!-- END GENERATED -->

**The table above is generated, and that is the point.** It was hand-written on 2026-08-18 and was
wrong by the same evening: it stated the nested-control class at 122 while three PRs closed it to
**0** that afternoon, and quoted 69 un-prefixed grids after a fix took them to 67. A number a human
retypes is a number that will be wrong — the predecessor docs proved that over five weeks, and this
one proved it in nine hours.

So it is emitted by `scripts/ui-standard-guard.cjs`, and **`pnpm guard:ui` fails when the committed
block disagrees with the live measurement.** To update it, run `pnpm guard:ui --write-table` and
commit the result in the same PR; never edit the block by hand. Adding a row means adding a
*measurement*, not a sentence.

---

## 1. Design approach — "Mint & Flare"

*Rebuilt 2026-08-20 (`3cba2dae`) on **Monzo's structure**, superseding "Royal Blue Emerald"
(2026-07-08) → "Charcoal Emerald" → "Obsidian Indigo" (2026-07-06).* Monzo's whole live site
measures as white + one near-black + **one** tint; the restraint is the craft, not the specific
hues. So Homiquity took the structural decisions and **deliberately not the values** — the
near-black is tinted with Homiquity's own emerald rather than Monzo's navy, because an
indistinguishable palette from a bank in the same sector is trade-dress risk, not homage.

🚨 **There is no royal blue in this system, and the neutral ramp is no longer the slate family.**
Every neutral now carries the brand hue. Audit notes, screenshots or docs describing stark-white
surfaces over a slate structure with royal-blue dark surfaces describe the *previous* system.

White ground · **green-black dark surfaces** (sidebar, footer, hero gradients) · **one mint
tint** · **emerald reserved for forward-moving conversion actions** ("green means Go") · **one
orange `--flare`** as the single warm accent.

**Dark-surface ramp** (`precision.950/900/700` — hero gradients only): `950 #0B1E19` green-black,
hero anchor · `900 #112823` green-black mid · `700 #17302A` deep emerald-slate, hero end. *White
on 950 measures 17.30:1; on 700, 14.07:1.* **Neutral light ramp** (`precision.500→50`):
`500 #5A726C` muted green-grey, micro-copy (5.17:1 on white) · `300 #93A5A0` hover/disabled
borders · `100 #E2E9E7` hairlines · `50 #F1F8F5` the single pale tint.

**The warm accent — `--flare` #FF5E00 (hue 22deg), and it is a FILL colour, never text.** It does
the job Monzo's coral does (one jolt of warmth against a cold near-black, used sparingly) at a
plainly different hue. **The value is SAMPLED FROM THE LOGO, not chosen** — it is the exact ink of
the founder's logomark. Its usage is constrained by contrast, not taste:

| | Pair | Ratio |
|---|---|---|
| ✅ ALLOWED | fills, borders, illustration, focus rings — any ground | — |
| ✅ ALLOWED | flare as text on the dark ground `#0B1E19` | 5.65:1 |
| ✅ ALLOWED | flare as text on the sidebar `#17302A` | 4.59:1 |
| ✅ ALLOWED | `--flare-foreground` text on a flare fill | 5.65:1 |
| ❌ FORBIDDEN | flare as text on white | 3.06:1 |
| ❌ FORBIDDEN | white text on a flare fill | 3.06:1 |
| ❌ FORBIDDEN | flare as text on mint | 2.77:1 |

When orange must actually be **read**, use **`--flare-ink` #AD4000** (5.98:1 on white, 5.40:1 on
mint). Logos are exempt from WCAG 1.4.3, so the logomark and wordmark may carry bright `--flare`
**on white** — that exemption covers the mark only, never body copy, labels or numbers, and it was
measured for white, **not** for mint.

> ⚠️ **This block was stale for one commit and it is worth recording why.** It was written with
> `--flare` at #DD610E (hue 24), then `client/src/index.css` moved to the logo's #FF5E00 without
> this table following — recreating, inside the very PR that fixed the palette-name drift, exactly
> the doc-versus-code split that PR existed to close. **The sidebar row is new**: the old table
> quoted only the darkest ground, so flare-on-sidebar was never measured, and at the old value it
> was **3.88:1 — a silent AA failure** for a pairing the table implied was fine. Re-derive every
> ratio here from `index.css` on any palette commit; the code is the source, this is the mirror.

**Core principles**

1. **Hierarchy through VALUE, not hue.** Depth comes from the neutral ramp, whitespace, and — on
   app surfaces — a soft neutral card shadow over a light-gray ground; never from harsh borders
   or coloured shadows.
2. **Emerald = action.** `bg-primary` is `#047857` (emerald-700, AA-safe with white text at
   **5.49:1** — raw `#10B981` is only 2.49:1 and must never carry white text); `--ring` is
   emerald-600. Non-action green stays in the success tokens.
   **Corollary, and the most common way an outside proposal breaks this system: blue is not the
   CTA colour here.** Royal blue is a dark *surface*. A `bg-blue-600` primary button is wrong
   twice over — it inverts the semantics and it is a raw palette class the guard rejects.
3. **Other non-ramp colour is reserved for semantic status only** (§2).
4. Radical transparency, speed indicators, trust through clarity, data-as-centerpiece.

**Dark mode is decided-unsupported.** `index.css` carries a coherent `.dark` block, but no
provider ever applies the class. Keep it coherent; do not invest in tuning it.

---

## 2. Colour system

### Layers

- **Layer 0** `bg-background` — stark-white canvas (public/marketing, forms, reading surfaces);
  `bg-muted` (`#F8FAFC`) separates data sections (e.g. PITI panels).
- **Layer 0-surface** `bg-surface` — the light-gray **app ground** (one hair deeper than
  `--muted`) that white cards sit *on* so their shadow reads. Shipped app-wide for the
  authenticated app: `PrivateLayout`'s `<main>` carries `bg-surface` + the `app-surface` hook.
  Layer 0 white stays for public/marketing, auth and reading surfaces.
- **Layer 1** — white cards + 1px hairline (`border-card-border`). Near-flat on the white
  canvas; on `bg-surface` they carry `shadow-card`, supplied automatically (§5).
- **Layer 2** — emerald conversion actions (`bg-primary`); hover deepens via the elevate system.
- **Sidebar** — deep royal-blue dark nav container.

### Semantic status (the ONLY non-ramp colour)

Use these tokens or the `<Badge>`/`<Alert>` variants — **never** raw palette classes like
`text-emerald-600` or `bg-amber-100`. The guard blocks them and they fail WCAG AA.

| Intent | Solid fill | Foreground on fill | Subtle chip (default for text) |
|---|---|---|---|
| success | `bg-success` (`#10B981`) | `text-success-foreground` (charcoal) | `bg-success-subtle` + `text-success-subtle-foreground` |
| warning | `bg-warning` (`#F59E0B`) | `text-warning-foreground` (charcoal) | `bg-warning-subtle` + `text-warning-subtle-foreground` |
| info | `bg-info` | `text-info-foreground` | `bg-info-subtle` + `text-info-subtle-foreground` |
| destructive | `bg-destructive` (red-600) | `text-destructive-foreground` (white) | `bg-destructive-subtle` + `text-destructive-subtle-foreground` |

**AA rules (enforced by design, each hand-verified in `index.css`):**

- Status colour as *text on canvas* is a WCAG fail — use the `*-subtle` pair (dark tint text on
  pale tint fill, all ≥5.5:1) for badges, labels and inline text.
- Solid fills carry **dark** foregrounds for success/warning (white-on-emerald was 2.54:1);
  `destructive` is red-600 so white-on-red clears 4.80:1.
- `--muted-foreground` was darkened 2026-07-08 to ~6.2:1 on white (from 4.83:1).
- `--ring` is 3.77:1 — passes the 3:1 non-text UI threshold, not the 4.5:1 text one. It is a
  ring, never type.
- On **dark image overlays**, keep icons vivid (`text-warning`/`text-success`), not the dark
  subtle-foreground, which vanishes.

### Charts

`chart-1..5` is a **colourblind-safe categorical** set (navy/teal/amber/indigo/rose) for
multi-series data-viz. It deliberately does **not** reuse the success/warning hues. For a single
ordered metric use the neutral value ramp instead.

### The `veteran-*` tokens — deliberately not in Tailwind

`--veteran-gold` / `-navy` / `-red` / `-seal-bg` are an **off-palette brand accent, not semantic
status**. They are intentionally *not* mapped into the Tailwind theme and are consumed via
inline `hsl(var(--veteran-gold))` on seal/VA surfaces only (`VeteranFoundedBadge.tsx`). Gold is
ring-and-icon only and **never text-bearing** — gold on white fails AA. Their absence from
Tailwind is containment, not an oversight; do not "fix" it with a blanket mapping.

---

## 3. Typography

- **Fonts:** Geist (primary) → Inter fallback; Source Serif 4 for display/hero (`font-display`);
  Geist Mono for code/figures. Loaded via `--font-sans` / `-serif` / `-mono`.
- Headings weight 600–700, tight tracking (−0.02em). Body 400, line-height 1.6. Financial
  figures 500–600 with `tabular-nums`.
- **The scale is owned by [`ui/typography.tsx`](../../../client/src/components/ui/typography.tsx)**,
  not hand-picked per page:

| Rung | Class string |
|---|---|
| `<Heading level={1}>` — page h1 | `text-2xl font-bold tracking-tight sm:text-3xl` |
| `<Heading level={2}>` — section | `text-2xl font-semibold tracking-tight` |
| `<Heading level={3}>` | `text-lg font-semibold tracking-tight` |
| `<Heading level={4}>` | `text-base font-semibold` |
| `<Text variant="body">` | `text-base leading-relaxed` |
| `<Text variant="lead">` | `text-lg leading-relaxed` |
| `<Text variant="muted">` | `text-sm text-muted-foreground` |
| `<Text variant="caption">` | `text-xs text-muted-foreground` |
| `<Text variant="eyebrow">` | `text-xs font-semibold uppercase tracking-wider text-muted-foreground` |

`<Heading>` takes `as` to decouple visual level from tag, so heading *order* stays correct for
screen readers while size is chosen for design. Pass `className` for spacing and colour only —
**never to resize**. Hero type on marketing pages (`text-4xl`→`text-6xl`) is the one exception
and stays outside the component.

> **Known code-vs-code drift, unresolved:** `PageShell.tsx`'s `PageHeader` renders its eyebrow as
> `text-sm font-medium uppercase tracking-wide` — a different rung from the canonical eyebrow
> above. `typography.tsx` is the scale owner and wins; `PageHeader` is the one to change.
> Recorded here rather than fixed because this doc's landing commit carries no product code.

---

## 4. Layout & spacing

**[`PageShell`](../../../client/src/components/PageShell.tsx) owns page geometry.** Every authed
page wraps its content in it; it sets width, centering, gutter and vertical rhythm so pages stop
hand-rolling `min-h-screen` / `mx-auto max-w-…` wrappers (which drifted across `max-w-xl`→`7xl`,
three gutters and `py-8`→`py-24` — finding `ux-03`). New authed pages **must** use it.

| Dimension | Canonical | Retire |
|---|---|---|
| Container width | `narrow` 2xl (forms) · `content` 4xl (default) · `wide` 6xl (dashboards) · `full` 7xl (data/marketing) | page-level `max-w-xl / 3xl / 5xl` |
| Gutter | `px-4 sm:px-6 lg:px-8` (PageShell — shipped) | bespoke `px-4` at page level |
| Page vertical padding | PageShell `py-8 sm:py-10` | per-page `py-12/16/20/24` (except marketing hero) |
| Section rhythm | `space-y-6` default (`-4` compact, `-8` generous) | everything else at page level |
| Card padding | `p-6` default, `p-4` dense | `p-2 / p-3 / p-8` |
| Page `<h1>` | `text-2xl sm:text-3xl` (via `<Heading level={1}>`) | bespoke `text-xl / 4xl / 5xl` h1s |

The widths are a **semantic set, not a scale** — pick by what the page *is* (form / reading /
dashboard / data), which is why `max-w-xl / 3xl / 5xl` are retired rather than merely
discouraged. Spacing primitives stay on Tailwind's `2, 4, 6, 8, 12, 16`; form fields use
`space-y-4`; dashboards grid as `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` and comparisons as
`lg:grid-cols-3`.

**`fullHeight` is for `BareLayout` routes only** (login, signup, legal, invite landings) — those
are the only ones whose layout supplies no height and no background.

Under `PrivateLayout` it paints a white `min-h-screen` over the gray app surface, *and* overflows
that layout's `flex-1 overflow-y-auto` `<main>`. Under `PublicLayout` it is just as wrong for a
reason that is easy to miss: that layout is **already** `flex min-h-screen flex-col bg-background`
around a `flex-1` `<main>`, so a second 100vh inside it forces the content region to a full
viewport *on top of* the nav — which pushes the Footer, and with it the NMLS identifier, the Equal
Housing notice and the broker-not-lender disclosure, below the fold on every page however short.
That was live on all ten calculators and both property pages until 2026-08-18.

If a page under a real layout genuinely needs to fill its container, that is `min-h-full`, not
`min-h-screen` (§15).

**Documented exceptions:** full-bleed marketing/hero pages, centered spinner/empty-state routes,
and auth pages (`max-w-md` centered card). Note that `max-w-md` is an *auth-card* width — it is
not the capture-flow container; see §12.

---

## 5. Radii, elevation, motion

- **Radii — six rungs, all derived from `--radius` (.75rem).** Radius encodes container
  **size**: the bigger the box, the rounder the corner.

  | Class | Value | Use |
  |---|---|---|
  | `rounded-sm` | 4px | chips, badges |
  | `rounded-md` | 8px | inputs, selects, buttons |
  | `rounded-lg` | 12px | cards, modals |
  | `rounded-xl` | 16px | feature cards |
  | `rounded-2xl` | 24px | large panels |
  | `rounded-3xl` | 32px | hero and band containers |

  🚨 **The three large rungs must stay declared in `tailwind.config.ts`.** They live under
  `theme.extend`, which previously overrode only sm/md/lg — so `rounded-xl` fell through to
  Tailwind's default `0.75rem`, which is **12px**, which is exactly what `--radius` already
  is. `rounded-lg` and `rounded-xl` rendered **identically**, and the 40 files reaching for
  `rounded-xl` to get a softer container got no change at all. A silent no-op rather than a
  wrong value, which is why it survived so long. Deleting an `xl`/`2xl`/`3xl` line
  reintroduces it, and nothing will go red.
- **Elevation.** The neutral-tinted `--shadow-*` vars are wired into Tailwind as a named card
  scale: `shadow-card` (= `--shadow-sm`), `shadow-card-hover` (= `--shadow-md`), `shadow-card-lg`
  (= `--shadow-lg`).
  - A **content card on `bg-surface`** carries `shadow-card` plus its hairline. On the white
    canvas cards stay near-flat (hairline only) — a shadow needs the gray ground to read.
  - **You don't hand-apply it inside the authed app.** `index.css` supplies the default via
    `.app-surface .shadcn-card:not([class*="shadow-"])`. Declaring any `shadow-*` class opts out
    and wins — `shadow-card-lg` for emphasis, `shadow-none` to go flat.
  - **The `:not()` guard is load-bearing — keep it.** Without it, that two-class selector
    out-specifies a one-class `shadow-card-lg` utility and silently flattens every explicit
    override (it did, on the dashboard's next-step card). *(The predecessor docs justified this
    by "Tailwind v3's `@layer` is a build-time directive, not a native cascade layer." That
    reasoning is now wrong — the project runs **Tailwind v4** in compatibility mode, where
    `@layer` IS native, as `index.css` states. The guard is still required, for plain
    specificity. The rule survived its own rationale, which is exactly why the rationale had to
    be re-checked.)*
  - **Interaction depth:** clickable cards/rows use `hover-elevate` (pair with
    `shadow-card-hover`); `active-elevate-2` is the pressed state. Don't mix raw `hover:shadow-*`
    on cards.
  - **Overlays** (popover/dropdown/dialog/toast/sheet) keep their Radix shadows.
  - **Retire ad-hoc surface shadows:** no `shadow-2xl`, `shadow-lg border-0`, or one-off
    `shadow-primary/25` on content cards. Use the card scale.
- **Motion:** `transition-all duration-150 ease-in-out` on interactive atoms; the elevate system
  supplies hover/active tints. Loading is `<Skeleton>` (`animate-skeleton-precision`), **never a
  spinner**.

  🚨 **JS-driven reveals must not be the only thing that makes content visible.**
  `Reveal`/`Stagger`/`StaggerItem` (`client/src/components/motion/`) set inline
  `opacity: 0` and animate to 1 — so anything that stops the animation leaves the
  content **permanently unseen**, not merely un-animated.

  That is not theoretical. On 2026-08-22 the home page was measured with two of
  four journey cards at `opacity: 0` and the other two at 0.27 and 0.78 —
  **identical readings at 6s and 10s.** Stalled. The cause is `document.hidden`:
  browsers throttle `requestAnimationFrame` in a background tab, and
  framer-motion drives on rAF, so a reveal that begins while hidden can stop
  mid-ramp. Opening a link in a background tab is an ordinary thing to do.

  The primitives now gate on `useCanAnimate()` — **reduced motion OR a hidden
  document renders plainly**, with no observer and no inline opacity to get stuck
  at. `client/src/components/motion/hiddenTab.test.tsx` pins it.

  Two things to carry forward:
  - **`prefers-reduced-motion` is not the whole accessibility story for motion.**
    It was handled correctly here from the first commit, and the page was still
    broken for a different reason entirely.
  - **Verify reveals on a FULL-PAGE capture.** This survived several rounds of
    review because every screenshot was a partial viewport that happened to miss
    the section. A tall viewport (e.g. 1280x2600) puts the whole page in one
    frame.

---

## 5a. Horizontal rhythm — `OffsetBlock`

Every content block on the public pages was `mx-auto`, so the eye tracked one
unchanging centre line from the top of a page to the bottom. `OffsetBlock`
(`client/src/components/layout/OffsetBlock.tsx`) anchors a block to one side at
`lg` and above, so the page zig-zags instead.

| Prop | Effect at `lg`+ |
|---|---|
| `side="left"` | `lg:ml-16 lg:mr-auto` — hugs left, slack thrown right |
| `side="right"` | `lg:mr-16 lg:ml-auto` — hugs right, slack thrown left |
| `side="center"` | unchanged, `mx-auto` (the default) |

Measured on `/self-employed` at 1440px: offset blocks land at 96/320 and
320/96 (left/right gaps), five other blocks stay centred.

🚨 **It collapses to centred below `lg`, and that is the load-bearing part.**
Under ~1024px an offset block is not a rhythm, it is a cramped column with a
useless margin — and the breakage is invisible until someone opens a laptop.
That collapse is why this is a primitive instead of utility classes pasted onto
sections, and `OffsetBlock.test.tsx` asserts it for all three sides.

**It sets no width.** Callers keep their own `max-w-*`; line length is a
readability decision, not a rhythm one.

**Use it as a rhythm, not a metronome.** The reference centres two of its six
blocks; `/self-employed` offsets two of seven. Alternating every section is just
a different monotony. Keep **forms and long prose centred** — a drifting form
reads as a bug, and drifting prose costs readability for nothing.

Because it is structural rather than chromatic, it survives the tenant
white-label constraint and is usable on authed surfaces.

## 6. Components — `client/src/components/ui/**`

**33 primitives.** House additions beyond stock shadcn: `empty-state`, `stat-card`, `typography`,
`query-boundary`.

**Button** — variants `default, destructive, outline, secondary, ghost, link`.

| Size | Classes | Height |
|---|---|---|
| `default` | `h-11 px-5 py-2` | **44px — already the WCAG/Apple-HIG touch target** |
| `sm` | `h-9 px-4 text-xs` | 36px — dense/secondary only, never a primary mobile CTA |
| `lg` | `h-12 px-8 text-base` | 48px — primary funnel CTAs |
| `icon` | `h-11 w-11` | 44px — **requires `aria-label`** |

Focus ring is centralized: `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`.
`asChild` (Radix `Slot`) is how a Button becomes a link — see §12's nesting rule.

**Input** — `h-11`, `px-4 py-2`, `text-[15px]`, `border-input bg-card`, focus swaps the hairline
for the emerald ring. No variants. Never drop below `text-base`/`text-[15px]` on a mobile field:
iOS Safari auto-zooms any input under 16px.

**Other primitives:** `Card` (`rounded-lg bg-card border border-card-border`, the `shadcn-card`
class is the hook for the auto-shadow rule; `CardTitle` = `text-2xl font-semibold leading-none
tracking-tight`) · `Badge` (`default/secondary/destructive/success/warning/info/outline`) ·
`Alert` (`default/destructive/success/warning/info`, `role="alert"` hardcoded) · `StatCard`
(status rendered as a filled chip, never bare text on the canvas) · `Skeleton` · `Form`.

> **Known drift:** `Select` is `h-9`/`text-sm`/`px-3` where `Input` is `h-11`/`text-[15px]`/`px-4`,
> and `Select` and `Badge` use `focus:` where everything else uses `focus-visible:`. A select
> beside a text input is visibly shorter. Recorded, not fixed here (no product code in this
> commit).

---

## 7. Iconography

- **Library: `lucide-react`.** No emoji or raster glyphs for UI. Icon-only controls **must**
  carry `aria-label`; decorative icons take `aria-hidden="true"`.
- **One glyph per concept.** Import by semantic name from
  [`client/src/lib/icons.ts`](../../../client/src/lib/icons.ts) — `import { Icons, iconSize } from
  "@/lib/icons"` — **never** directly from `lucide-react`. That file is the one place allowed to
  import the library, and it carries the full concept→glyph table (done, money, savings, funding,
  assets, home, lender, person, people, document, upload, tasks, time, security, warning, info,
  edit, add, forward, calendar, phone, email, location, analytics, settings, rate).
- **Sizing** uses the `h-N w-N` form, never the `size-4` shorthand, so the guard and a reader see
  the same thing: inline `h-4 w-4` · emphasis `h-5 w-5` · badge/dense `h-3.5 w-3.5` · feature
  `h-6`/`h-8` · empty-state `h-10`. Buttons keep `[&_svg]:size-4` internally.
- The registry is **built and unused** (§0): 323 files still import directly. `guard:ui` ratchets
  that number down; it may never go up.

---

## 8. Empty states

**[`ui/empty-state.tsx`](../../../client/src/components/ui/empty-state.tsx) is the only sanctioned
zero-state.** It takes an illustration (preferred) or a registry icon at `h-10`, plus title,
description and an optional action.

Roughly 18 surfaces still hand-roll the "lucide icon inside a `rounded-full bg-muted` circle"
look that reads as stock. Replace them as their pages are converted. The dashboard's "all caught
up" state and RenterHome's readiness ring are the quality bar.

---

## 9. Brand & white-label

**Boundary:** private/authenticated surfaces are tenant-branded; public marketing stays
Homiquity.

- **`<Logo>`** (`components/brand/Logo.tsx`) replaces the **18** copy-pasted wordmark spans that
  varied in weight, size and colour — the count was previously written here as "~13"; the census
  was re-run against the tree. Props: `size` (`sm|md|lg`), `variant` (`wordmark|mark|lockup`),
  `tone` (`brand|onDark|mono`), `mark` (`compact|primary`, default `compact`). Branding-aware: on
  a private surface with an active tenant it renders the tenant logo/name; on public surfaces
  always Homiquity.
  - The logomark is a **CSS mask** (`.brand-mark` in index.css) over `client/public/brand/*.png`,
    not an `<img>` or inline SVG — there is no vector master, and a mask takes its colour from
    `currentColor` so one asset serves every tone and a tenant re-skin reaches it for free.
  - `mark` defaults to `compact` because the primary artwork's outlined stem and chart columns
    stop resolving below ~48px and every lockup here renders at 20-28px.
- **`BrandingProvider`** is the white-label seam — and it is **currently INERT: it is mounted
  NOWHERE.** (`grep -rn "<BrandingProvider" client/src` returns zero JSX mounts; its only consumer
  is `Logo.tsx`, so `useBranding()` always returns the default context.) This line previously said
  "mounted on `PrivateLayout` only", which was never true of the shipped tree. When it *is*
  mounted it sets the **brandable** vars on the layout root: `--primary`, `--accent`, `--sidebar`,
  `--ring`. Because components use `bg-primary`/`bg-accent` semantically, the portal re-skins
  automatically — and stays token-guard-safe (no inline hex in components).
  - ⚠️ `--brand-logo` was listed here as one of those vars. **No such token exists** in
    `index.css`, `tailwind.config.ts` or `BrandingProvider.tsx`. Removed rather than implemented:
    the mark is coloured by `currentColor` through the mask, so a tenant's `--primary` already
    reaches it and a dedicated logo var would be a second, competing mechanism.
- **Fixed tokens, never tenant-overridable:** the neutral ramp, `--surface` + the elevation
  scale, and all semantic status tokens. They carry meaning and AA guarantees and must stay
  constant across tenants.
- **Contrast is not optional.** A tenant may pick any brand colour, so `--primary-foreground`
  must be **derived from that colour's luminance, or validated for AA on save**. White text is
  not assumed to pass — the house emerald was hand-verified at 5.49:1; a tenant colour gets no
  such guarantee for free.
- **Compliance gate:** white-labelling a *licensed mortgage* portal raises advertising/NMLS
  questions (whose entity is advertised, whose NMLS shows, any "Powered by" attribution). Route
  feature completion through compliance review before ship. **Never fabricate NMLS or brand
  data.**
- Out of scope of the token seam: the pre-existing public co-brand landing `/partner/:profileId`
  keeps its own inline colours.

---

## 10. Graphics & illustration

`client/src/components/illustrations/` holds **brand-token-coloured inline SVG** spot
illustrations — they consume `--primary`/`--accent`/neutral tokens, so they re-skin per tenant
and stay guard-safe. Simple, geometric, on-brand; not stock clip-art. They appear in primary
empty states (§8) and dashboard/onboarding hero moments. Keep them inline with no external
requests (matches the CSP and perf posture). Anything needing commissioned art or photography is
out of autonomous scope — flag it.

---

## 11. Accessibility (WCAG 2.1 AA)

- **Skip link:** `<SkipLink />` is the first focusable element in every layout;
  `<main id="main" tabIndex={-1}>` is the target. It stays in the DOM and is translated
  off-screen, deliberately avoiding the `sr-only` / `focus:not-sr-only` cascade fragility.
- **Form errors are announced:** `FormMessage` renders `role="alert"`; `FormControl` sets
  `aria-invalid` and `aria-describedby`. Radix toasts announce automatically.
- **Focus is never removed.** It is centralized as `focus-visible:ring-ring`.
- **Labels are always visible** — placeholder-only labelling is a defect.
- **Touch targets ≥44px** — `.touch-target` enforces `min-height`/`min-width: 44px` under
  767px. `Button` `default` and `icon` already clear it at `h-11`.

  `size="sm"` does **not** (h-9 = 36px), and this was the one accessibility rule with no
  mechanical check behind it until 2026-08-18 — so it drifted to **233** `size="sm"` buttons
  without `.touch-target` across 114 files. `subMinTouchTarget` in `pnpm guard:ui` now ratchets
  it. Two limits stated rather than implied: the utility is scoped `max-width: 767px`, so a
  768px+ touch device (iPad portrait) is **not** covered by it; and a raw `<button>` can be
  sub-44px too, but it can equally wrap a whole card — that class is reported in §0 as needing
  human review, never failed on.
- **Contrast:** every semantic pair is hand-verified (§2). New pairs need the same treatment,
  light and dark, before they ship.
- **Open follow-ups:** an `aria-label` sweep on icon-only controls, and landmark/skip-link
  coverage on bare (layout-less) routes.

**What is not verifiable here, and must not be claimed:** the client test lane is happy-dom,
which has **no layout engine**. There is no Playwright, no Storybook and no axe in this repo, and
`CHARTER.md` §6 forbids adding dependencies. So no automated check in this repo can prove a
rendered layout, a contrast ratio in situ, or a mobile viewport. Say what you actually ran.

---

## 12. Capture-flow standard

The rules above make a page *consistent*. These make a capture screen *convert*. They apply to
every screen where a borrower is being asked for something: the pre-approval funnel, the URLA,
consent and verification screens, and any future intake.

**The reference implementation is `/apply`** (`pages/lending/PreApproval.tsx` + `funnel/`): a
question catalog, a pure routing machine, three-layer draft persistence, one question per
screen. Copy its shape. **The counter-example is `/urla-form`** (`pages/borrower/URLAForm.tsx`):
seven tabs inside the full app chrome, up to ~22 inputs on one tab, and a horizontally scrolling
tab rail on mobile. *(Before touching that file, read
[`URLA_FORM_REFACTOR_TRAP.md`](../URLA_FORM_REFACTOR_TRAP.md) — three adversarial reviews
refuted the obvious extractions, and the worst failure mode writes a co-applicant's PII into the
primary borrower's rows.)*

### 12.1 Progressive disclosure

1. **One decision per screen.** A screen asks one question. Where a question genuinely has parts
   (a value and its unit), they are parts of one decision, not two questions.
2. **Ceiling: three visible inputs per capture screen.** Above that, split the step or reveal
   conditionally. A step whose input count depends on earlier answers must be counted at its
   *worst* case, not its typical one — today's worst offender renders ~18 inputs for a borrower
   with rental and investment income.
3. **Never bundle unrelated signals** onto one screen to save a step.
4. **Sequencing is data, not layout.** Step order lives in the question catalog and the routing
   machine, so a visual change can never reorder a flow. Keep it that way.

### 12.2 Tunnel vision

Once capture begins, remove everything that is not the question, the answer, and the way
forward:

- **No global navigation, no sidebar, no marketing footer.** `/apply` correctly uses
  `BareLayout`. `/urla-form` renders inside `PrivateLayout` with the sidebar, header, bell and
  mobile bottom nav all live — that is the defect, not the pattern.
- **The only controls are Next, Back, and Save-and-exit.**
- **Compliance disclosures stay, but sized as chrome, not as content.** A full disclosure block
  repeated under every question buries the question on a phone. Disclose once per flow at the
  point of consent, and keep the persistent per-step footprint to a single line.
- **Progress must be honest.** Show a step indicator whose denominator cannot move mid-flow. If
  the route can branch, snapshot the total at flow start or show no fraction at all.

### 12.3 Mobile invariants

Mobile is the default, not the adaptation.

1. **Design at 320px first.** A multi-column grid needs a breakpoint prefix — `grid-cols-1
   sm:grid-cols-2`, never a bare `grid-cols-2`. `guard:ui` ratchets the un-prefixed count.
2. **Primary CTA is `w-full` on mobile** and may relax to `sm:w-auto` above the breakpoint. Use
   `Button` `size="lg"` (h-12) for a primary funnel CTA; `size="sm"` is never a primary mobile
   action.
3. **No horizontal scrolling on a capture screen.** No `min-w-[…]` tables, no `overflow-x-auto`
   step rails. Tabular comparison data stacks into cards on mobile.
4. **Never below 16px on an input** — iOS Safari auto-zooms, which visually breaks the layout.
   Conversely, oversized display type on a currency field needs a downshift: a `text-4xl` figure
   in a narrow container truncates a seven-digit number on a 360px screen.
5. **Reassurance is not a desktop luxury.** A live-calculation or explanation panel gated behind
   `lg:` means the borrower most likely to abandon gets the least help. Give mobile an inline
   equivalent, not nothing.
6. **Respect the safe area** — `.safe-area-bottom` for sticky footers.
7. `useIsMobile` exists (`hooks/use-mobile.tsx`) for behavioural branches. Layout branches belong
   in CSS breakpoints, not JS.

### 12.4 Interactive-control integrity

- **A link may not contain a button, and a button may not contain a link.** It is invalid HTML
  and it breaks keyboard and assistive-technology navigation. To make a Button navigate, use
  `<Link href=…><Button asChild>…` — 45 sites already spell it correctly. `Button` renders a real
  `<button>` unless `asChild` is passed, so wrapping it in a link *always* nests two interactive
  controls. `guard:ui` holds the count at 122 and falling.
- **Selection lists are cards, not bare radios**, where the choice is a primary decision
  (purchase vs refinance). They still must be real radio semantics underneath — a `div` with an
  `onClick` is not a control.
- **Every control keeps its focus ring.** No `outline-none` without a `focus-visible` replacement.

---

## 13. The four-question gate

Every borrower-facing screen passes all four, or it is a finding. This is the standard the weekly
UX review scores against.

**1. PROVENANCE — every displayed number declares its source.**
The vocabulary binds to [`shared/dataProvenance.ts`](../../../shared/dataProvenance.ts) and to
nothing else. The real states are exactly three:

| State | Meaning | Display language |
|---|---|---|
| `self_reported` | entered by the borrower in a pre-sales/exploratory flow; unverified | "you told us" / "estimate" |
| `verified` | backed by a document, credit pull, or authoritative source | "verified" |
| `system_calculated` | derived by the system from other values — **inherits the weakest input** | "calculated from…" |

Only `verified` is decision-grade (`isDecisionGrade`). Self-reported data may power calculators
and "what could I afford" flows — always labelled non-binding — and must **never** silently
become the basis for a credit decision, a Loan Estimate or Closing Disclosure, a pre-approval
letter, or anything implying a commitment (TILA/TRID, ECOA).

> ⚠️ **Do not invent a second provenance enum.** A parallel client-side vocabulary is the
> two-sources-of-truth anti-pattern this standard exists to prevent. In particular the terms
> "soft-check" and "estimated" appear in some review prompts but **do not exist** in
> `dataProvenance.ts`. Display language may differ from the enum; the enum may not.

**2. EXPLANATION — every intrusive ask says why.**
Pair each request with what it is used for and what will be asked next to verify it. "Why we ask"
micro-copy is part of the question, not a tooltip afterthought.

**3. AGREEMENT — no two elements may disagree about the same fact.**
All counts, badges and progress indicators derive from **one** selector. A component with local
scope may not make a global claim ("all caught up") — and no fraction may have a denominator that
moves while the user is looking at it.

**4. HONESTY — every choice is a positive opt-in.**
Never pre-ticked, never a double negative, never penalty language for declining. A consent
control states plainly what it authorizes at the moment it is given — not only inside a scrolled
disclosure.

**Compliance copy is load-bearing and pinned by tests.** `FUNNEL_SOFT_PULL_CONSENT_TEXT`
(`shared/creditConsentCopy.ts`) is rendered verbatim in the funnel and persisted as
`credit_consents.disclosure_text`; the funnel-chrome tests pin the footer disclosure strings.
A redesign preserves those **byte-for-byte**. Never weaken a consent gate, a disclosure gate or
an FCRA pull gate to make a layout nicer.

---

## 14. Visual refactors and data logic ship separately

**A PR that changes the layout or styling of a capture screen must not change form-state
management in the same commit** — no `react-hook-form` rewiring, no Zod schema edits, no API
payload shape changes. Ship the visual change, then the logic change, as separate reviewable
PRs.

The reason is specific to this product: capture-screen fields feed the URLA and the ULDD/UCD
delivery package. A styling diff that silently drops or renames a field produces an invalid
loan-delivery payload, and a large visual diff is exactly where that is hardest to see in review.

Corollary: `shared/preApprovalForm.ts` must keep importing nothing but `zod` — importing the
Drizzle barrel once shipped 174 pg tables into the browser bundle.

---

## 15. Reference surface — the borrower dashboard

The worked example of the whole standard (spacing · surface + `shadow-card` · registry icons ·
vertical timeline · branding-aware chrome): `client/src/pages/borrower/Dashboard.tsx`.

- **Shell:** `min-h-full bg-surface`; a full-bleed royal-blue hero (`bg-accent
  text-accent-foreground` — re-skins per tenant; never `text-white`), then a `max-w-6xl`
  two-column grid overlapping the hero, collapsing to one column on mobile. Keep the sidebar
  chrome — no competing top nav.
- **Left column (wider):** "next step" card → **Tasks** → **Loan Progress** (the 7-step journey
  as a vertical timeline: COMPLETE = `bg-success` check + green connector, CURRENT = `bg-primary`
  emerald dot — not blue — UPCOMING = gray).
- **Right column:** **Pre-Approved** card → **Contact** → **Loan Team** (assigned LO; NMLS from
  `user.nmlsId` **only when present**; no LO phone — no such column exists).
- **Mobile order:** next-step → Tasks → Pre-Approved → Loan Progress → Contact → Loan Team →
  secondary, collapsed.
- **Preserve:** the RenterHome empty state, the staff redirect, ApplicationSwitcher, status
  gating, and every `data-testid`. **Never fabricate** NMLS or phone data.

---

## 16. PageShell adoption checklist

Converting one of the 82% opt-out pages (§0):

1. Delete the hand-rolled wrapper (`<div className="min-h-screen …">`, `mx-auto max-w-… px-… py-…`).
   Delete it — do **not** move it onto `PageShell` as `fullHeight`; under either real layout that
   reproduces the same bug through a prop instead of a div.
   If the page imports PageShell but wraps it in `min-h-screen`, remove that wrapper — that is
   the `pageShellDrift` metric.
2. Wrap content in `<PageShell width={narrow|content|wide|full}>`, picked by §4's semantic set.
   Don't set `fullHeight` under `PrivateLayout` **or** `PublicLayout` — `BareLayout` routes only.
3. Move the page header into `PageHeader` props (`title`/`subtitle`/`icon`/`eyebrow`/
   `headerAction`), passing `titleTestId` to keep the existing `data-testid`.
4. Replace bespoke `space-y-*` and card padding with §4's tiers; replace direct `lucide-react`
   imports with the registry (§7); replace hand-rolled zero-states with `<EmptyState>` (§8); on
   dashboards adopt `bg-surface` + `shadow-card` (§5).
5. Verify: `pnpm guard:tokens` (baseline unchanged) + `pnpm guard:ui` (counts down, never up) +
   `pnpm check` + the `ux-reviewer` agent.

**Batch size:** one surface area per PR, sized to a single CI cycle. A 200-file mechanical sweep
is unreviewable and will be rejected.

---

## 17. Enforcement

| Machine | What it actually proves |
|---|---|
| `pnpm guard:tokens` — `scripts/design-token-guard.cjs` | raw palette classes stay at **0**; bare `white`/`black` literals ratchet down from 97. Required CI gate. |
| `pnpm guard:ui` — `scripts/ui-standard-guard.cjs` | the seven §0 counts may only go down. Required CI gate. |
| `pnpm guard:kb` | this doc is indexed. An unindexed doc is an unread doc. |
| `pnpm guard:docs` | this doc has been re-read against the code within 30 days. |
| `.claude/agents/ux-reviewer.md` + the `ui-components` skill | the human/agent review gate for every propagation batch. |

**A green guard is not a clean bill of health.** Both guards are text scans. Neither sees
rendered layout, contrast in situ, focus order, or anything in `.css`. The token guard's regex
is class-shaped and cannot see a hex literal or an arbitrary value — which is precisely why
`guard:ui` carries `rawHexLiterals`, `arbitraryColorValues` and `blindSpotPaletteClasses`. And
the className metrics only see literal double-quoted strings, so classes built in `cn()`,
template literals or cva variants are invisible: **every count is a floor, not a total.**

---

## 18. Governance

- **Single source of truth:** `index.css` + `tailwind.config.ts` + `components/ui/**`. This doc
  is normative about *rules* and descriptive about *values* — on a value, the code wins.
- **Adding a new status colour?** Add a `<Badge>`/`<Alert>` variant plus `*-subtle` tokens
  (light and dark, AA-verified) — never a one-off palette class in a page.
- **Adding a new primitive or token?** It needs review and a changelog entry.
- **This doc is re-verified every 30 days** (`pnpm guard:docs`). Re-verification means re-reading
  it against the code and re-running `pnpm guard:ui` for the §0 numbers — not bumping the date.
  The predecessors went five weeks without that pass, and every number in them drifted.

**Historical:** `knowledge-base/archive/ux-audit/` is a quarantined 2026-07 snapshot — do not act
on it; its `design-tokens.json` describes the retired "Obsidian Indigo" palette. The successor
defect register is [`feature-review/FINDINGS.md`](../../feature-review/FINDINGS.md).
