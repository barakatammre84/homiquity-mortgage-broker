# Browser probe — seeing the product in a real renderer

> Tool documentation, not a living doc: it is verified against
> `scripts/browser-probe.cjs`, so it goes stale when that script changes, not on a date. It
> deliberately carries **no** `Freshness:` line. That used to be because the doc-freshness guard
> read a fixed list of seven living docs and a line outside it was a claim nothing checked; #811
> retired that guard (its script is gone), so now **no** `Freshness:` line anywhere is checked. The
> reasoning survives the guard: date a doc only where someone re-reads it on that cadence.

`scripts/browser-probe.cjs` renders a page in Chromium and answers the questions a text scan
cannot. **It adds no dependency** — Chromium is already on disk in any environment that has it
(Playwright's browser cache via `PLAYWRIGHT_BROWSERS_PATH`, or a system Chrome), and Node 22 ships
a WebSocket client in core, so the Chrome DevTools Protocol is reachable with `node` alone.
`package.json` and `pnpm-lock.yaml` are untouched, which is what
[shared working practices](../../AGENTS.md) actually protects.

## Why it exists

Until 2026-08-18 every UI change in this repo shipped on a text scan. `pnpm guard:ui` says so about
itself: no layout engine, and its className metrics see only literal double-quoted strings — so
`unprefixedMultiColGrid` is a **proxy** for "breaks at 320px", never a measurement. The client test
lane is happy-dom, which has no layout at all. Nothing here could answer *does this page actually
work at 320 pixels*.

## Usage

```bash
# Start the app first (dev on 5001, worktree on 5002, or the built bundle on any port)
node scripts/browser-probe.cjs --url http://localhost:5001/calculators --width 320
node scripts/browser-probe.cjs --url <url> --out /tmp/shot.png --full-page
node scripts/browser-probe.cjs --url <url> --expr "document.querySelectorAll('[data-testid]').length"
```

| Flag | Meaning |
|---|---|
| `--url` | required |
| `--width` / `--height` | viewport; `≤480` turns on mobile emulation (or force it with `--mobile`) |
| `--out` | write a PNG |
| `--full-page` | capture beyond the viewport |
| `--expr` | evaluate any JS in the page and print the result |
| `--timeout` | ms to wait for `load` (default 30000) |

Exit **1** on: no browser found, no server, a page error, horizontal overflow, or a broken image.
Exit **0** otherwise. Touch-target and accessible-name counts are printed but do **not** fail the
run — see the caveat below.

## The four built-in checks

1. **Horizontal overflow at the requested width** — `scrollWidth > min(innerWidth, screen.width)`,
   with the offending elements named (tag, `data-testid`, class, geometry). This is
   DESIGN_SYSTEM §12.3's real question rather than its proxy.

   ⚠️ **It compared against `window.innerWidth` alone until 2026-08-18, and that check could never
   fail.** Under mobile emulation the *visual* viewport widens to fit overflowing content, so
   `innerWidth` grew in lockstep with `scrollWidth`. On `/calculators/affordability` it printed
   `✓ no horizontal overflow (scrollWidth 329 ≤ 329)` while the layout viewport was 320 and the page
   really did overflow by 9px. **Any "no overflow" result recorded before that date is not
   evidence.** Two sessions found this independently the same day and fixed it two ways —
   `min(innerWidth, screen.width)` landed first and is what ships; `documentElement.clientWidth` is
   the equivalent standard measure and was dropped rather than re-litigated. When `innerWidth`
   exceeds the emulated width the output now says so explicitly, because that gap *is* the finding:
   something on the page forces a min-width.
2. **Images that failed to load** (`naturalWidth === 0`). Before calling one a new defect, compare
   `/api/health`'s `commit` against `origin/main`: a hashed-asset 404 with drift > 0 is a **stale
   deploy**, not a missing file. That mistake has been made here twice.
3. **Interactive elements under 44×44 px** (DESIGN_SYSTEM §11).
4. **Interactive elements with no accessible name** — resolved roughly the way the accname spec
   does: `aria-labelledby` → `aria-label` → an associated `<label for>` or wrapping `<label>` →
   `title` → `placeholder` → text content.

   ⚠️ **It checked only `aria-label` / `title` / text content until 2026-08-18**, so a correctly
   labelled `<input id=x>` + `<Label htmlFor=x>` was reported as unnamed. That produced **nine
   false positives across five public pages and zero true ones** on its first real sweep — four on
   the affordability calculator alone, every one properly associated. Since AGENTS.md working practices now lets
   this output be cited as evidence, over-reporting sends people to fix what is not broken.

   ⚠️ **It also ignored the accessibility tree until the same day.** Anything inside
   `[aria-hidden="true"]` is now skipped by *both* this check and the touch-target one. The case
   that found it: `/partners` has a spam honeypot — `absolute -left-[9999px]`, `aria-hidden`,
   `tabIndex={-1}` — which has no accessible name **by design**. Reporting it invites someone to
   "fix" it by adding a label, which would defeat the honeypot.

   Once both were fixed, the check immediately earned its keep: the `/rates/*` family and
   `/approval-strength` reported controls that **were** genuinely unnamed — `<Label>` with no
   `htmlFor` beside `<Input>` with no `id`, plus an icon-only search button with no `aria-label`.
   Fixed in #593 and after. That is the whole argument for narrowing a guard: the same check that
   cried wolf nine times found eleven real WCAG failures once it stopped.

## What it still cannot do — and what §10 therefore still forbids claiming

- **It does not measure contrast.** No colour-contrast check exists in this repo.
- **It is not an accessibility audit.** There is no axe here. Checks 3 and 4 are two mechanical
  rules out of WCAG, not a verdict.
- **One viewport is not "mobile verified".** It is one width, one height, one engine.
- **The 44 px count includes inline text links in prose**, where a touch-target rule is arguably
  not aimed. Read the list, don't quote the number: it is a starting point for judgement, not a
  defect count. Same discipline `guard:ui` demands — every count it prints is a floor.

So the rail in [shared working practices](../../AGENTS.md) stands, in its amended form: **report the
command you ran and what it printed.** That is what turns "verified in a browser" from a claim into
a fact, and it is the only form of that claim anyone here may make.

## Deliberately not in CI

The GitHub runner's browser is not this repo's to guarantee, and a gate that depends on a browser
being present fails for reasons no diff caused — the same argument that keeps `doc-freshness` out
of the merge gate. Run it in a session, paste the output into the PR.

## First run, 2026-08-18

Against the built bundle on a freshly-seeded database:

- `/` at 1280 and at 320 — no overflow, no broken images.
- `/calculators` at 320 — no overflow; **19 interactive elements under 44 px**, including the whole
  footer link set at 36 px tall and the mobile-menu wordmark at 32 px. Measured, not inferred, and
  not visible to any guard in this repo before that day.

## First ten-page sweep, 2026-08-18 — and the bug class `guard:ui` cannot see

Ten public pages at 320 px. **One real page defect, and two defects in this script** (both fixed
above; the sweep was re-run afterwards and the other nine pages hold up).

`/calculators/affordability` overflowed the viewport by 9 px. The cause is the *inverse* of what
`unprefixedMultiColGrid` hunts for, which is why no guard in this repo could have caught it:

```
<div className="grid gap-8 lg:grid-cols-5">   ← multi-column template is correctly prefixed
  <div className="lg:col-span-3 …">           ← but measured 313px inside a 288px grid
```

With **no** template at the mobile breakpoint, the implicit column is `auto`, which sizes to the
item's **min-content** — 313 px — and the item overflows a 288 px grid box. The metric only flags a
multi-column template *missing* a prefix (breaks mobile by staying multi-column); a template that
exists *only* above `lg` leaves an unshrinkable `auto` column below it, and reads as correct.

The fix is `grid-cols-1`, which Tailwind compiles to `repeat(1, minmax(0, 1fr))` — the `minmax(0,…)`
is the load-bearing half. Proven by setting `gridTemplateColumns` live through `--expr` before
editing anything: the item went 313 → 288 and the page overflow cleared. Desktop is untouched
(5 × 192 px, item spans 3 = 640 px).

**Neither `min-width: 0` on the item nor on all of its descendants fixes this** — both were tried
and measured. The floor is the track, not the box.

### The wider sweep, same day: 34 public pages

**146 sites in `client/src` use `grid` with a prefixed-only template.** That number is not a defect
count and must not be reported as one — most shrink fine, and a guard flagging all 146 would be the
cry-wolf failure this file already records twice. **Six pages actually overflowed at 320px**, each
confirmed by measurement and fixed: `/calculators/affordability`, `/payoff`, `/home-equity`,
`/rent-to-own`, `/bah`, and `/approval-strength`.

One overflow had a different cause worth knowing: `/find-an-agent` reached **369px** because a
`Button` label ("Skip Search — Match Me with an Agent" plus an icon) inherits `whitespace-nowrap`
from the Button base, giving it a 319px min-content that cannot fit the 288px available. The fix is
`whitespace-normal` on that instance — `cn` uses `twMerge`, so the later class wins.

Final state across the 34 pages walked: **no overflow, no broken images, no uncaught page errors,
no unnamed controls.** The sub-44px touch-target counts remain (36 on `/rates`, 26 on `/`) — those
are the 233 `subMinTouchTarget` instances #581 began ratcheting, not new findings.
