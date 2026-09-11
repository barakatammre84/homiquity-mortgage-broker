import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFunnelAutosave } from "./useFunnelAutosave";

/**
 * The regression these pin: the debounce effect depended on the `values` OBJECT.
 *
 * Every caller passes `form.watch()`, which returns a fresh object on every
 * render, so the effect re-ran — and cleared its own pending timer — on every
 * render rather than every change. Any render source firing faster than
 * debounceMs starved the write forever, and the funnel's drop-off restore then
 * had nothing to offer even though the borrower had typed a full application.
 *
 * The fix keys the effect on the serialized snapshot, so "same values, new
 * object" is a no-op. `useServerDraftAutosave` already did this; this hook did
 * not, which is exactly the kind of divergence between sibling hooks that is
 * invisible until someone loses their answers.
 */

const KEY = "test_autosave";
const STEP_KEY = "test_autosave_step";

function render(values: Record<string, string>, stepId = "annualIncome", ownerId?: string) {
  return renderHook(
    (props: { values: Record<string, string>; stepId: string; ownerId?: string }) =>
      useFunnelAutosave({
        storageKey: KEY,
        stepStorageKey: STEP_KEY,
        values: props.values,
        stepId: props.stepId,
        ownerId: props.ownerId,
        enabled: true,
        debounceMs: 800,
      }),
    { initialProps: { values, stepId, ownerId } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useFunnelAutosave debounce", () => {
  it("is not starved by a steady stream of renders that change nothing", () => {
    const { rerender } = render({ annualIncome: "120000" });

    // Renders arriving every 400ms — faster than the 800ms debounce — each
    // handing over a NEW object with IDENTICAL contents. That is exactly what
    // `form.watch()` produces, and the funnel re-renders on far more than
    // typing (context updates, toasts, mutation state).
    //
    // Note there is deliberately NO quiet window before the assertion: a
    // trailing advanceTimersByTime would let even the broken version flush on
    // the last armed timer and hide the bug. The write has to land WHILE the
    // renders are still coming.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(400);
      rerender({ values: { annualIncome: "120000" }, stepId: "annualIncome", ownerId: undefined });
    }

    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ annualIncome: "120000" }));
    expect(localStorage.getItem(STEP_KEY)).toBe("annualIncome");
  });

  it("still debounces genuinely changing values — only the last one lands", () => {
    const { rerender } = render({ annualIncome: "1" });

    for (const v of ["12", "120", "1200"]) {
      vi.advanceTimersByTime(300);
      rerender({ values: { annualIncome: v }, stepId: "annualIncome", ownerId: undefined });
      // Nothing written yet: each change re-arms the debounce.
      expect(localStorage.getItem(KEY)).toBeNull();
    }
    vi.advanceTimersByTime(900);

    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ annualIncome: "1200" }));
  });

  it("writes the values current at fire time, not a stale closure", () => {
    const { rerender } = render({ annualIncome: "1" });
    rerender({ values: { annualIncome: "999" }, stepId: "creditScore", ownerId: undefined });
    vi.advanceTimersByTime(900);

    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ annualIncome: "999" }));
    expect(localStorage.getItem(STEP_KEY)).toBe("creditScore");
  });

  it("skips the write when shouldPersist rejects the values", () => {
    renderHook(() =>
      useFunnelAutosave({
        storageKey: KEY,
        stepStorageKey: STEP_KEY,
        values: { annualIncome: "" },
        stepId: "annualIncome",
        enabled: true,
        debounceMs: 800,
        shouldPersist: (v) => Object.values(v).some((x) => x !== ""),
      }),
    );
    vi.advanceTimersByTime(900);

    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("binds an authenticated snapshot to its owner and reports when it was saved", () => {
    const { result } = render({ annualIncome: "120000" }, "propertyType", "borrower-1");
    vi.setSystemTime(new Date("2026-09-12T15:00:00.000Z"));
    vi.advanceTimersByTime(900);

    expect(result.current.readSaved()).toEqual({
      values: { annualIncome: "120000" },
      stepId: "propertyType",
      ownerId: "borrower-1",
      savedAt: new Date("2026-09-12T15:00:00.800Z").getTime(),
    });
  });

  it("clears the values, step, owner, and timestamp together", () => {
    const { result } = render({ annualIncome: "120000" }, "propertyType", "borrower-1");
    vi.advanceTimersByTime(900);

    result.current.clear();

    expect(result.current.readSaved()).toBeNull();
    expect(localStorage.getItem(`${KEY}:owner`)).toBeNull();
    expect(localStorage.getItem(`${KEY}:saved-at`)).toBeNull();
  });
});
