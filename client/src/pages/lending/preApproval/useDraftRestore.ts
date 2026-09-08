// Draft-restore wiring for the pre-approval funnel: ONE decision point for
// adopting previously-saved answers. Two sources feed it — the authenticated
// server draft (GET /api/loan-applications/draft/latest) and the anonymous
// localStorage autosave — and both sit behind the same restore banner: no
// saved answers reach the form until the borrower says yes.
//
// The application *container* is a separate concern from its *answers*: the
// server keeps at most one draft row per user (draft/latest returns the first
// status="draft" match), so the draft's id is always adopted as the submit
// PATCH target. Declining the banner discards the saved answers but still
// submits into the same row — "start over" overwrites the old draft instead
// of stranding it to re-offer stale data on every future visit.
import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { loanApplicationKeys } from "@/lib/queryClient";
import type { UseFormReturn } from "react-hook-form";
import type { IncomeSourceEntry, LoanApplication, PreApprovalFormData } from "@shared/schema";
import type { FunnelStepId } from "@/funnel/preApprovalMachine";
import type { FunnelSaved } from "@/funnel/useFunnelAutosave";
import { toStepId } from "./questions";

interface UseDraftRestoreArgs {
  form: UseFormReturn<PreApprovalFormData>;
  isAuthenticated: boolean;
  /**
   * True while a deferred post-auth submit owns the saved answers — offering
   * a restore banner over it would double-consume them mid-submit.
   */
  hasPendingSubmit: () => boolean;
  readSaved: () => FunnelSaved<PreApprovalFormData> | null;
  clearAutosave: () => void;
  goTo: (stepId: FunnelStepId) => void;
  hydrate: (stepId: FunnelStepId, answers: PreApprovalFormData) => void;
  toast: (opts: { title: string; description?: string }) => void;
}

/** The draft carries borrower answers worth asking about (vs an empty container row). */
export function draftHasAnswers(draft: LoanApplication): boolean {
  return Boolean(
    draft.annualIncome ||
    draft.purchasePrice ||
    draft.creditScore ||
    draft.monthlyDebts ||
    draft.occupancyType ||
    draft.numberOfUnits ||
    draft.subjectMonthlyRentalIncome,
  );
}

/**
 * Exported for its test: every field the server draft can carry must come
 * back here, because the result is fed to `form.reset` — an omitted field is
 * RESET to its default, not left alone. The two VA residual-income inputs were
 * omitted until 2026-08-22 and a veteran was re-asked for them on every resume.
 */
export function draftToFormValues(
  draft: LoanApplication,
  current: PreApprovalFormData,
): PreApprovalFormData {
  const sources: IncomeSourceEntry[] = Array.isArray(draft.incomeSources)
    ? (draft.incomeSources as IncomeSourceEntry[])
    : [];
  return {
    ...current,
    annualIncome: draft.annualIncome || "",
    employmentType:
      (draft.employmentType as PreApprovalFormData["employmentType"]) || "employed",
    employmentYears: draft.employmentYears ? String(draft.employmentYears) : "",
    monthlyDebts: draft.monthlyDebts || "",
    creditScore: draft.creditScore ? String(draft.creditScore) : "",
    loanPurpose: (draft.loanPurpose as PreApprovalFormData["loanPurpose"]) || "purchase",
    propertyType:
      (draft.propertyType as PreApprovalFormData["propertyType"]) || "single_family",
    occupancyType: (draft.occupancyType as PreApprovalFormData["occupancyType"]) || undefined,
    numberOfUnits: draft.numberOfUnits ? String(draft.numberOfUnits) : "",
    subjectMonthlyRentalIncome: draft.subjectMonthlyRentalIncome || "",
    purchasePrice: draft.purchasePrice || "",
    downPayment: draft.downPayment || "",
    isVeteran: !!draft.isVeteran,
    isFirstTimeBuyer: !!draft.isFirstTimeBuyer,
    avoidsInterestFinancing: !!draft.avoidsInterestFinancing,
    // Integer columns → the form's digit strings (38 CFR 36.4340(e) inputs).
    householdFamilySize: draft.householdFamilySize ? String(draft.householdFamilySize) : "",
    homeSquareFootage: draft.homeSquareFootage ? String(draft.homeSquareFootage) : "",
    propertyState: draft.propertyState || "",
    hasAdditionalIncome: sources.length > 0,
    incomeSources: sources,
  };
}

export function useDraftRestore({
  form,
  isAuthenticated,
  hasPendingSubmit,
  readSaved,
  clearAutosave,
  goTo,
  hydrate,
  toast,
}: UseDraftRestoreArgs) {
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const [showRestoreBanner, setShowRestoreBanner] = useState(false);
  const [decided, setDecided] = useState(false);

  const { data: serverDraft, isLoading: serverDraftLoading } = useQuery<LoanApplication | null>({
    queryKey: loanApplicationKeys.draftLatest(),
    enabled: isAuthenticated,
  });

  // Container adoption is unconditional (see module comment); answer adoption
  // below is what the banner gates.
  useEffect(() => {
    if (serverDraft?.id) {
      setApplicationId(serverDraft.id);
    }
  }, [serverDraft]);

  // The single restore-offer decision. Runs once per mount, after the server
  // draft (when authenticated) has had a chance to load.
  useEffect(() => {
    if (decided) return;
    if (hasPendingSubmit()) {
      setDecided(true);
      return;
    }
    if (isAuthenticated && serverDraftLoading) return;
    if (isAuthenticated && serverDraft && draftHasAnswers(serverDraft)) {
      setShowRestoreBanner(true);
      setDecided(true);
      return;
    }
    const saved = readSaved();
    if (saved && saved.stepId !== "intro") {
      setShowRestoreBanner(true);
    }
    setDecided(true);
  }, [decided, hasPendingSubmit, isAuthenticated, serverDraft, serverDraftLoading, readSaved]);

  const restore = useCallback(() => {
    if (isAuthenticated && serverDraft && draftHasAnswers(serverDraft)) {
      const values = draftToFormValues(serverDraft, form.getValues());
      // form.reset IS the restore: IncomeSourcesStep derives its selected
      // types, per-type details and rental rows from form.incomeSources, so
      // there is no second store to reseed (there used to be, via a
      // page-owned applyIncomeSources threaded in as an argument).
      form.reset(values);
      goTo("loanPurpose");
      setShowRestoreBanner(false);
      toast({
        title: "Draft restored from your account",
        description: "We loaded your saved progress.",
      });
      return;
    }
    try {
      const saved = readSaved();
      if (!saved) {
        setShowRestoreBanner(false);
        return;
      }
      const merged = { ...form.getValues(), ...saved.values };
      form.reset(merged);
      hydrate(toStepId(saved.stepId), merged);
      setShowRestoreBanner(false);
      toast({ title: "Progress restored", description: "We picked up where you left off." });
    } catch {
      setShowRestoreBanner(false);
    }
  }, [isAuthenticated, serverDraft, form, goTo, hydrate, readSaved, toast]);

  const dismiss = useCallback(() => {
    // "No" adopts nothing: the form keeps only what this visit produced, and
    // the saved copies are cleared so the offer doesn't repeat.
    setShowRestoreBanner(false);
    clearAutosave();
  }, [clearAutosave]);

  return { applicationId, showRestoreBanner, restore, dismiss };
}
