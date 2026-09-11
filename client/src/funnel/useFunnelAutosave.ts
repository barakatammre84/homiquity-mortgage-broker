import { useCallback, useEffect, useRef } from "react";

/**
 * Debounced localStorage persistence for funnel progress. Writes {values,
 * stepId} after the user pauses typing, so a drop-off can be restored to the
 * exact step. Deliberately localStorage (not the backend) per keystroke:
 * server drafts persist on submit/auth via the existing
 * /api/loan-applications draft flow — hammering Neon on every keystroke would
 * be all cost and no benefit.
 *
 * Consent acknowledgements are intentionally NOT persisted — compliance
 * acknowledgements must be re-affirmed each session.
 */

export interface FunnelSaved<TValues> {
  values: TValues;
  stepId: string;
  /** Binds an authenticated browser snapshot to its owner before restore. */
  ownerId?: string | null;
  savedAt?: number;
}

export function useFunnelAutosave<TValues>({
  storageKey,
  stepStorageKey,
  values,
  stepId,
  ownerId,
  enabled,
  debounceMs = 800,
  shouldPersist,
}: {
  storageKey: string;
  stepStorageKey: string;
  values: TValues;
  stepId: string;
  ownerId?: string | null;
  /** Persist only while true (e.g. past the intro, not yet submitted). */
  enabled: boolean;
  debounceMs?: number;
  /** Skip writes for effectively-empty forms so we don't nag with restores. */
  shouldPersist?: (values: TValues) => boolean;
}) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Depend on the serialized snapshot, not the object identity. Callers pass
  // `form.watch()`, which returns a FRESH OBJECT every render — keying the
  // effect on it re-armed the debounce on every render rather than every
  // change, so any render source firing faster than debounceMs starved the
  // write indefinitely and the drop-off restore silently had nothing to offer.
  // (useServerDraftAutosave already did this; its sibling did not.)
  const snapshotJson = JSON.stringify(values);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  useEffect(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        if (shouldPersist && !shouldPersist(valuesRef.current)) return;
        localStorage.setItem(storageKey, snapshotJson);
        localStorage.setItem(stepStorageKey, stepId);
        localStorage.setItem(`${storageKey}:saved-at`, String(Date.now()));
        if (ownerId) localStorage.setItem(`${storageKey}:owner`, ownerId);
        else localStorage.removeItem(`${storageKey}:owner`);
      } catch {
        // Private browsing / quota — autosave is best-effort by design.
      }
    }, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // `shouldPersist` is read through the ref-backed callback at fire time, so
    // it is deliberately not a dependency — a caller passing an unmemoized
    // predicate would otherwise re-arm the debounce on every render, which is
    // the exact bug this snapshot dependency exists to fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotJson, stepId, ownerId, enabled, debounceMs, storageKey, stepStorageKey]);

  const readSaved = useCallback((): FunnelSaved<TValues> | null => {
    try {
      const raw = localStorage.getItem(storageKey);
      const savedStep = localStorage.getItem(stepStorageKey);
      if (!raw || !savedStep) return null;
      const rawSavedAt = localStorage.getItem(`${storageKey}:saved-at`);
      const savedAt = rawSavedAt ? Number(rawSavedAt) : undefined;
      return {
        values: JSON.parse(raw) as TValues,
        stepId: savedStep,
        ownerId: localStorage.getItem(`${storageKey}:owner`),
        savedAt: savedAt && Number.isFinite(savedAt) ? savedAt : undefined,
      };
    } catch {
      return null;
    }
  }, [storageKey, stepStorageKey]);

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
      localStorage.removeItem(stepStorageKey);
      localStorage.removeItem(`${storageKey}:owner`);
      localStorage.removeItem(`${storageKey}:saved-at`);
    } catch {}
  }, [storageKey, stepStorageKey]);

  return { readSaved, clear };
}
