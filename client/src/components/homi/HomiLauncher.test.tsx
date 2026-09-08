import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

let currentLocation = "/dashboard";
vi.mock("wouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wouter")>();
  return { ...actual, useLocation: () => [currentLocation, vi.fn()] };
});

import { HomiLauncher } from "./HomiLauncher";
import { ASSISTANT_NAME } from "@shared/assistant/identity";

/**
 * The launcher is the reason Homi is an assistant rather than a destination —
 * and it is the single riskiest place in this feature for the client bundle.
 *
 * `App.tsx` imports `PrivateLayout` non-lazily and the launcher mounts inside
 * it, so everything the launcher REACHES ships in the entry chunk that every
 * first-time visitor downloads before anything renders. Rollup hoists a module
 * shared by an eager and a lazy chunk WHOLE into the eager one, so a single
 * careless import here would pull the chat surface, the markdown renderer,
 * Plaid and the upload button onto the landing page's critical path.
 *
 * `pnpm guard:bundle` is the real enforcement (it measures a build). These
 * tests cover what a unit test can: that the dock is genuinely absent until
 * opened, and that the keyboard path works.
 */

// The dock arrives through `lazy()`, so the FIRST open in the file has to
// compile a dynamic import — which under load took >15s and made whichever
// test happened to click first look like a real failure while the rest passed.
//
// Warmed once here rather than papering over it with ever-larger timeouts.
// This does NOT weaken the "not mounted until opened" assertion below: that
// assertion is about what is in the DOM, and importing a module never mounts
// it. The requirement that the LAUNCHER reach it lazily is enforced separately,
// by the source scan at the bottom of this file.
beforeAll(async () => {
  await import("./HomiDock");
  // 60s, not the 10s default: compiling this dynamic import took >10s on a
  // loaded machine. Paid once for the whole file.
}, 60000);

function renderLauncher(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  currentLocation = "/dashboard";
});

describe("HomiLauncher", () => {
  it("renders a launcher labelled with the assistant's actual name", () => {
    const { container } = renderLauncher(<HomiLauncher />);
    const btn = screen.getByTestId("button-homi-launcher");
    expect(btn.getAttribute("aria-label")).toContain(ASSISTANT_NAME);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("logo-homi-launcher")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("does NOT mount the chat surface until it is opened", async () => {
    // The observable proxy for the lazy split. If someone converts the
    // `lazy(() => import(...))` into a static import, the dock renders on mount
    // and this fails — which is the cheap early warning before guard:bundle
    // catches the same mistake as a byte regression.
    renderLauncher(<HomiLauncher />);
    expect(screen.queryByTestId("homi-dock")).toBeNull();

    await userEvent.click(screen.getByTestId("button-homi-launcher"));
    await waitFor(() => expect(screen.getByTestId("homi-dock")).toBeTruthy(), { timeout: 15000 });
  });

  it("reports its expanded state to assistive tech", async () => {
    renderLauncher(<HomiLauncher />);
    const btn = screen.getByTestId("button-homi-launcher");
    expect(btn.getAttribute("aria-controls")).toBe("homi-dock");
    await userEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute("aria-expanded")).toBe("true"), { timeout: 15000 });
  });

  it("closes on Escape and keeps the conversation mounted", async () => {
    renderLauncher(<HomiLauncher />);
    await userEvent.click(screen.getByTestId("button-homi-launcher"));
    await waitFor(() => expect(screen.getByTestId("homi-dock")).toBeTruthy(), { timeout: 15000 });

    await userEvent.keyboard("{Escape}");
    await waitFor(
      () => expect(screen.getByTestId("button-homi-launcher").getAttribute("aria-expanded")).toBe("false"),
      { timeout: 15000 },
    );
    // Minimize, not close: the dock stays in the tree with `hidden`, so a
    // borrower who minimizes mid-answer and reopens finds their conversation
    // rather than a blank panel.
    expect(screen.getByTestId("homi-dock").hasAttribute("hidden")).toBe(true);
  });

  it("returns focus to the launcher when dismissed", async () => {
    // Without this a keyboard user is dropped at the top of the document with
    // no idea where they are.
    renderLauncher(<HomiLauncher />);
    const btn = screen.getByTestId("button-homi-launcher");
    await userEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId("homi-dock")).toBeTruthy(), { timeout: 15000 });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(btn), { timeout: 15000 });
  });

  it.each(["/ai-coach", "/homi"])("is suppressed on %s — the page IS the assistant", (route) => {
    currentLocation = route;
    const { container } = renderLauncher(<HomiLauncher />);
    expect(container.firstChild).toBeNull();
  });
});

describe("HomiLauncher stays off the critical path", () => {
  const src = require("fs").readFileSync(
    require("path").resolve(__dirname, "HomiLauncher.tsx"),
    "utf8",
  );
  // Strip comments — this file's own header NAMES the modules it must not
  // import, and a guard that reads prose as code punishes the explanation.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("reaches the dock only through lazy()", () => {
    expect(code).toMatch(/lazy\(\s*\(\)\s*=>\s*import\(/);
    expect(code, "a static import of the dock puts the whole chat in the entry chunk").not.toMatch(
      /^import .*HomiDock/m,
    );
  });

  it("imports nothing that is not already eager for another reason", () => {
    // Button + Logo arrive via PrivateLayout, useLocation via App.tsx, and the
    // identity module is a zero-import leaf. Anything else is new weight on
    // every first-time page load.
    const allowed = [
      "react",
      "wouter",
      "lucide-react",
      "@/components/ui/button",
      "@/components/brand/Logo",
      "@shared/assistant/identity",
      "@/components/homi/HomiDock",
    ];
    const imported = [...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    const dynamic = [...code.matchAll(/import\("([^"]+)"\)/g)].map((m) => m[1]);
    for (const mod of [...imported, ...dynamic]) {
      expect(allowed, `unexpected eager import: ${mod}`).toContain(mod);
    }
  });
});
