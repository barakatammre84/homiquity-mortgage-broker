import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useLocation, useSearchParams, Link } from "wouter";
import { SEOHead } from "@/components/SEOHead";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { preApprovalFormSchema } from "@shared/preApprovalForm";
import type { PreApprovalFormData } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, loanApplicationKeys, dashboardKeys } from "@/lib/queryClient";
import { friendlyApiError } from "@/lib/errorMessage";
import { maskCurrencyDigits } from "@/lib/formatters";
import {
  PREAPPROVAL_AUTOSAVE_KEY as AUTOSAVE_KEY,
  PREAPPROVAL_STEP_KEY as AUTOSAVE_STEP_KEY,
  PREAPPROVAL_PENDING_SUBMIT_KEY as PENDING_SUBMIT_KEY,
  readPendingInviteId,
  clearPendingInviteId,
} from "@/lib/pendingAttribution";
import { useAuth } from "@/hooks/useAuth";
import { usePageView, useTrackActivity, useTrackFormStart, useTrackFormAbandon } from "@/hooks/useActivityTracker";
import {
  ArrowRight,
  ChevronLeft,
  DollarSign,
  Loader2,
  Check,
  AlertCircle,
  Info,
  ShieldCheck,
} from "lucide-react";

import { FunnelProvider, useFunnel } from "@/funnel/FunnelContext";
import { PRE_APPROVAL_DEFAULTS, routingSignature } from "@/funnel/preApprovalMachine";
import { entryTypeFromSearchParams, loanPurposeForEntryType, occupancyForEntryType } from "./preApproval/entryType";
import { useFunnelAutosave } from "@/funnel/useFunnelAutosave";
import { VerificationPulse } from "@/funnel/VerificationPulse";
import { Checkbox } from "@/components/ui/checkbox";
import { QUESTIONS_BY_ID } from "./preApproval/questions";
import { AdvisoryPanel, resolveStepCopy, ADVISORY_HIDDEN_STEPS } from "./preApproval/AdvisoryPanel";
import { useDeferredSubmit } from "./preApproval/useDeferredSubmit";
import { useDraftRestore } from "./preApproval/useDraftRestore";
import { useServerDraftAutosave } from "./preApproval/useServerDraftAutosave";
import { useCoachPrefill, type CoachIntake } from "./preApproval/coachPrefill";
import { useCalculatorPrefill } from "./preApproval/calculatorPrefill";
import { StateStep } from "./preApproval/StateStep";
import { IncomeSourcesStep } from "./preApproval/IncomeSourcesStep";
import { RestoreDraftBanner, AuthGateOverlay, AffordabilityTeaserOverlay, FunnelFooter, FunnelProgressHeader } from "./preApproval/FunnelChrome";
import { calculateAffordabilityEstimate, type AffordabilityEstimateResults } from "@/lib/affordabilityEstimate";
import { buildTeaserInputs, parseTargetPrice } from "./preApproval/affordabilityTeaser";
import { FUNNEL_SOFT_PULL_CONSENT_TEXT } from "@shared/creditConsentCopy";
import { EditorialNavigation } from "@/components/EditorialNavigation";
import { SkipLink } from "@/components/SkipLink";

export default function PreApproval() {
  return (
    <FunnelProvider initialAnswers={PRE_APPROVAL_DEFAULTS}>
      <PreApprovalFunnel />
    </FunnelProvider>
  );
}

function PreApprovalFunnel() {
  const queryClient = useQueryClient();
  const {
    stepId,
    flags,
    progress,
    next,
    back,
    goTo,
    hydrate,
    syncAnswers,
    setConsent,
    checkGate,
    state: funnelState,
  } = useFunnel();
  const direction = funnelState.direction;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { isAuthenticated } = useAuth();

  usePageView("/apply");
  const track = useTrackActivity();
  const trackFormStart = useTrackFormStart();
  useTrackFormAbandon("preapproval", progress.index > 0 && stepId !== "final", {
    step: progress.index,
    step_id: stepId,
    total: progress.total,
  });
  const prevStepRef = useRef(0);

  // Through the router, not `window.location.search`. Reading the global at
  // render made these values invisible to wouter — a client-side nav that
  // changed ?type= left the page reading the old query string — and made the
  // component untestable without stubbing window.
  const [urlParams] = useSearchParams();
  const urlType = entryTypeFromSearchParams(urlParams);
  const urlPrice = urlParams.get("price");
  const urlState = urlParams.get("state");
  const urlPropertyType = urlParams.get("propertyType");
  const urlPropertyId = urlParams.get("propertyId");
  const urlSource = urlParams.get("source");
  // The `?type=` → purpose translation lives in one named place; the inline
  // ternary this replaced matched `heloc` but not `cashout`, which is what
  // /rates/cash-out actually sends. See preApproval/entryType.ts.
  const defaultLoanPurpose = loanPurposeForEntryType(urlType);

  // Read once per mount, through the shared module so the legacy per-tab key is
  // still honoured for an invite stashed by an older client. Captured in a ref
  // rather than read at submit time because the deferred post-auth replay
  // (useDeferredSubmit) fires from a closure created at mount.
  const inviteId = useRef(readPendingInviteId());

  const form = useForm<PreApprovalFormData>({
    resolver: zodResolver(preApprovalFormSchema),
    mode: "onChange",
    defaultValues: {
      annualIncome: "",
      // /self-employed pre-screens income shape; honor it so those borrowers
      // land with the right employment type preselected (still editable at
      // its step — the route recomputes if they change it).
      employmentType: urlType === "self-employed" ? "self_employed" : "employed",
      employmentYears: "",
      monthlyDebts: "",
      creditScore: "",
      loanPurpose: defaultLoanPurpose,
      occupancyType: occupancyForEntryType(urlType),
      propertyType: (urlPropertyType as any) || "single_family",
      numberOfUnits: "",
      subjectMonthlyRentalIncome: "",
      purchasePrice: urlPrice || "",
      downPayment: "",
      // /va-loans and /first-time-buyer pre-screen these; honor them so
      // borrowers aren't asked twice (checkboxes stay editable at their step).
      isVeteran: urlType === "va",
      isFirstTimeBuyer: urlType === "first-time",
      avoidsInterestFinancing: false,
      propertyState: urlState || "",
      // Unanswered on arrival — see PRE_APPROVAL_DEFAULTS. Defaulting to false
      // pre-highlighted "No, this is my only income" before the borrower chose.
      hasAdditionalIncome: undefined,
      incomeSources: [],
    },
  });

  // Figures handed over by the affordability / rent-to-own calculators. Gap-fill
  // only, and deliberately BEFORE useCoachPrefill below — see
  // preApproval/calculatorPrefill.ts for the contract and for the credit-band
  // vocabulary bug the inline version of this shipped.
  useCalculatorPrefill(form);

  // Draft/step/pending-submit keys now live in @/lib/pendingAttribution so the
  // post-auth router (getPostAuthRoute) can detect a deferred submit too.
  const [showAuthGate, setShowAuthGate] = useState(false);
  const [teaser, setTeaser] = useState<{ estimate: AffordabilityEstimateResults; targetPrice: number | null } | null>(null);

  const hasMeaningfulData = useCallback((values: PreApprovalFormData) => {
    return Object.entries(values).some(([k, v]) => {
      if (k === "isVeteran" || k === "isFirstTimeBuyer" || k === "avoidsInterestFinancing") return false;
      if (k === "employmentType" && v === "employed") return false;
      if (k === "propertyType" && v === "single_family") return false;
      if (k === "loanPurpose" && v === defaultLoanPurpose) return false;
      return typeof v === "string" && v.length > 0;
    });
  }, [defaultLoanPurpose]);

  const clearAutosave = useCallback(() => {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
      localStorage.removeItem(AUTOSAVE_STEP_KEY);
      localStorage.removeItem(PENDING_SUBMIT_KEY);
    } catch {}
  }, []);

  // Create/update application mutation. Declared HERE, above its consumers,
  // rather than 130 lines down: the post-auth replay effect used to reference
  // it from a closure created long before the binding was initialised, which
  // works only by accident of when effects run and reads as a TDZ bug.
  const submitMutation = useMutation({
    mutationFn: async (data: PreApprovalFormData) => {
      const payload: Record<string, unknown> = {
        ...data,
        annualIncome: data.annualIncome.replace(/,/g, ""),
        purchasePrice: data.purchasePrice.replace(/,/g, ""),
        downPayment: data.downPayment.replace(/,/g, ""),
        monthlyDebts: data.monthlyDebts.replace(/,/g, ""),
        subjectMonthlyRentalIncome: data.subjectMonthlyRentalIncome?.replace(/,/g, ""),
        // FCRA soft-pull authorization from the final step — persisted
        // server-side as a credit_consents evidence row (IP, UA, disclosure).
        softPullConsentAccepted: funnelState.consent.softPullAcknowledged,
      };

      if (inviteId.current) {
        payload.inviteId = inviteId.current;
      }

      // Always POST — the intake route consumes the user's existing draft
      // container server-side (updating it and flipping draft → submitted
      // through the pipeline engine with the full intake side effects). The
      // old client-side PATCH branch skipped the status flip, analysis, and
      // notifications entirely, leaving the "submitted" application in draft.
      const response = await apiRequest("POST", "/api/loan-applications", payload);
      return response.json();
    },
    onSuccess: async (result) => {
      clearAutosave();
      // Application creation promotes an aspiring owner to active buyer on the
      // server. Refresh that session fact before changing pages; otherwise the
      // persistent shell keeps the old role and hides the new file's To-Do and
      // Documents links until a full reload. Waiting also keeps every borrower
      // surface aligned with the newly submitted application on first render.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] }),
        queryClient.invalidateQueries({ queryKey: loanApplicationKeys.all() }),
      ]);
      // The dashboard may still hold the pre-application empty response. If it
      // survives, React Query paints the aspiring-owner dashboard for a moment
      // before the fresh application arrives. Remove that snapshot so the next
      // visit shows the loading shell until current data is available.
      queryClient.removeQueries({ queryKey: dashboardKeys.root() });

      // Consume only now, on a SUCCESSFUL submit — a borrower who abandons the
      // funnel keeps their attribution for the next attempt. Clears both tiers
      // so a legacy per-tab copy cannot re-attribute a later application.
      if (inviteId.current) {
        clearPendingInviteId();
      }

      toast({
        title: "Application submitted",
        description: "We received what you shared. Upload the requested documents so your loan team can verify it.",
      });
      // A borrower may have an older workable file selected in this tab. Name
      // the new file in the URL so the shell, dashboard, tasks, and documents
      // all resolve the application that was just submitted on first paint.
      navigate(`/loan-options/${result.id}?app=${encodeURIComponent(result.id)}`);
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: friendlyApiError(error, "Failed to submit application. Please try again."),
        variant: "destructive",
      });
    },
  });

  // Finishes a pre-approval the visitor completed before they had an account.
  // Owns the PENDING_SUBMIT marker, the exactly-once claim, and the replay
  // timer's cleanup (see preApproval/useDeferredSubmit.ts).
  const { hasPendingSubmit } = useDeferredSubmit({
    form,
    isAuthenticated,
    setConsent,
    submit: submitMutation.mutate,
  });

  const currentQ = QUESTIONS_BY_ID[stepId];

  // Every step starts at the top of the page.
  //
  // Without this the funnel drifts: `AnimatePresence mode="wait"` keeps the
  // OUTGOING step mounted until its exit animation finishes, so for those
  // ~250ms the document is roughly twice as tall and the incoming step's input
  // sits far down it. Focusing that input (below) makes the browser scroll it
  // into view — a long way — and when the exit completes and the document
  // shrinks back, the scroll offset stays where it was. Measured on the
  // purchase-price step: scrollY 242 of a possible 265, which put the question
  // heading 162px ABOVE the viewport and left the input pinned under the fixed
  // "Step X of Y" header. The step looked blank.
  //
  // `focus({ preventScroll: true })` below stops the scroll being provoked;
  // this resets anything the borrower scrolled themselves on the previous step.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [stepId]);

  // Autofocus WITHOUT the browser's implicit scroll-into-view — see above. The
  // `autoFocus` attribute gives no way to pass `preventScroll`, so focus is
  // driven by hand.
  //
  // A ref CALLBACK rather than an effect on `stepId`: under
  // `AnimatePresence mode="wait"` the incoming step does not mount until the
  // outgoing one has finished animating out, so a `[stepId]` effect fires while
  // the new input does not yet exist and would focus nothing. The callback runs
  // when the element actually attaches, whenever that turns out to be.
  const focusStepInput = useCallback((el: HTMLInputElement | null) => {
    el?.focus({ preventScroll: true });
  }, []);

  const watchedValues = form.watch();
  // Title, subtext and "why we ask" resolve together against the answers so
  // far — see resolveStepCopy. A refinancer is not asked for a "purchase
  // price", and a self-employed borrower is not asked about "other" income.
  const stepCopy = useMemo(() => resolveStepCopy(currentQ, watchedValues), [currentQ, watchedValues]);

  // Mirror form values into the machine so routing always sees the latest
  // answers — but ONLY when a routing-relevant answer moved.
  //
  // This used to key on JSON.stringify(watchedValues), i.e. on every keystroke.
  // Each dispatch replaces FunnelState, which rebuilds FunnelContext's memo
  // (computeRoute + computeFlags + routeProgress) and re-renders this whole
  // 900-line component a SECOND time — for a character typed into a field the
  // route does not depend on. `routingSignature` covers exactly the answers
  // computeFlags/computeRoute read (preApprovalMachine.ts), and
  // preApprovalMachine.test.ts proves that list is complete, so skipping the
  // rest cannot change what the machine decides. Everything else already reads
  // fresh values: next/back/checkGate/submit all pass form.getValues().
  const routingKey = routingSignature(watchedValues);
  useEffect(() => {
    syncAnswers(form.getValues());
  }, [routingKey, syncAnswers, form]);

  // A blocked NEXT (validation gate) surfaces as a toast.
  useEffect(() => {
    if (funnelState.blockedGate) {
      toast({
        title: "One more thing",
        description: funnelState.blockedGate.errors[0],
        variant: "destructive",
      });
    }
  }, [funnelState.blockedGate, toast]);

  const { readSaved } = useFunnelAutosave<PreApprovalFormData>({
    storageKey: AUTOSAVE_KEY,
    stepStorageKey: AUTOSAVE_STEP_KEY,
    values: watchedValues,
    stepId,
    enabled: stepId !== "intro",
    shouldPersist: hasMeaningfulData,
  });

  // (There used to be an applyIncomeSources here, rebuilding the income step's
  // three mirror stores from restored entries. IncomeSourcesStep now derives
  // its whole UI from form.incomeSources, so form.reset() is the entire
  // restore — no second store to reseed, and no way to forget to.)

  // A1: the server-draft container id — adopted from useDraftRestore when a
  // prior draft exists, or minted by the server autosave's find-or-create.
  const [adoptedDraftId, setAdoptedDraftId] = useState<string | null>(null);

  const {
    applicationId,
    showRestoreBanner,
    restore: handleRestoreDraft,
    dismiss: handleDismissRestore,
  } = useDraftRestore({
    form,
    isAuthenticated,
    hasPendingSubmit,
    readSaved,
    clearAutosave,
    goTo,
    hydrate,
    toast,
  });

  useEffect(() => {
    if (progress.index !== prevStepRef.current && progress.index > 0) {
      track("preapproval_step", "/apply", {
        step: progress.index,
        step_id: stepId,
        total: progress.total,
      });
      prevStepRef.current = progress.index;
    }
  }, [progress.index, progress.total, stepId, track]);

  // Load coach intake data to gap-fill fields the borrower has left blank.
  const { data: coachIntake } = useQuery<{
    intake: CoachIntake | null;
    readinessTier?: string;
    completionPercentage?: number;
  } | null>({
    queryKey: ["/api/coach/intake/latest"],
    enabled: isAuthenticated,
  });

  // Gap-fill from the coach conversation's intake: blank fields only, never an
  // answer the borrower already gave (see preApproval/coachPrefill.ts for the
  // rule and the overwrite bug it replaces). Saved-draft answers are
  // deliberately NOT applied here — adopting a draft (data + PATCH target) is
  // consent-gated through useDraftRestore's banner.
  useCoachPrefill(form, coachIntake?.intake);

  // A1: authenticated progress also persists to the ONE server draft row, so
  // a device switch doesn't lose the application. Disabled once a submit is
  // in flight — the intake route consumes the draft at that point.
  useServerDraftAutosave({
    isAuthenticated,
    values: watchedValues,
    enabled: stepId !== "intro" && !submitMutation.isPending && !submitMutation.isSuccess,
    hasMeaningfulData,
    applicationId: applicationId ?? adoptedDraftId,
    onDraftAdopted: setAdoptedDraftId,
  });

  const handleNext = async () => {
    if (currentQ.type === "intro") {
      trackFormStart("preapproval");
      next(form.getValues());
      return;
    }

    if (currentQ.type === "final") {
      const isValid = await form.trigger();
      const gate = checkGate("final", form.getValues());
      if (!isValid || !gate.ok) {
        toast({
          title: "Please complete all fields",
          description: gate.errors[0] ?? "Some required information is missing.",
          variant: "destructive",
        });
        return;
      }
      if (!isAuthenticated) {
        try {
          localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(form.getValues()));
          localStorage.setItem(AUTOSAVE_STEP_KEY, stepId);
          localStorage.setItem(PENDING_SUBMIT_KEY, "true");
        } catch {}
        const values = form.getValues();
        const teaserInputs = buildTeaserInputs(values);
        if (teaserInputs) {
          setTeaser({
            estimate: calculateAffordabilityEstimate(teaserInputs),
            targetPrice: parseTargetPrice(values.purchasePrice),
          });
        } else {
          setShowAuthGate(true);
        }
        return;
      }
      submitMutation.mutate(form.getValues());
      return;
    }

    // boolean_pair and incomeSources have no single field to trigger; the
    // machine's step gate validates them (and everything else) inside NEXT.
    if (currentQ.type === "boolean_pair" || currentQ.id === "incomeSources") {
      next(form.getValues());
      return;
    }

    if (currentQ.field) {
      const isValid = await form.trigger(currentQ.field);
      if (isValid) {
        next(form.getValues());
      } else {
        toast({
          title: "Please fill out this field",
          description: "This information is required to continue.",
          variant: "destructive"
        });
      }
    }
  };

  const handleBack = () => {
    if (progress.index > 0) {
      back(form.getValues());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && currentQ.type !== "choice" && currentQ.type !== "state" && currentQ.type !== "income_sources") {
      e.preventDefault();
      handleNext();
    }
  };

  const renderInput = () => {
    const IconComponent = currentQ.icon;

    switch (currentQ.type) {
      // The display-size step inputs carry a mobile rung: text-4xl in a
      // max-w-md box truncates "$1,250,000" on a 360px screen, and the w-8
      // glyph at left-4 needs pl-16 to clear it. text-3xl / pl-12 / w-6 fits,
      // and stays far above the 16px floor below which iOS Safari auto-zooms
      // (DESIGN_SYSTEM.md §12.3).
      case "currency": {
        const fieldName = currentQ.field as keyof PreApprovalFormData;
        const watchedValue = form.watch(fieldName);
        const displayValue = typeof watchedValue === 'string' ? watchedValue : "";
        const fieldError = form.formState.errors[fieldName];
        return (
          <div className="w-full max-w-md mx-auto">
            <div className="relative">
              <DollarSign className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 w-6 h-6 sm:w-8 sm:h-8 text-primary" />
              <Input
                key={`currency-${fieldName}`}
                ref={focusStepInput}
                aria-label={stepCopy.title}
                data-testid={`input-${currentQ.field}`}
                value={displayValue}
                onChange={(e) => {
                  const formatted = maskCurrencyDigits(e.target.value);
                  form.setValue(fieldName, formatted as never, { shouldValidate: true, shouldDirty: true });
                }}
                className={`pl-12 sm:pl-16 h-16 sm:h-20 text-3xl sm:text-4xl border-0 border-b-2 rounded-none focus-visible:ring-0 bg-transparent placeholder:text-muted-foreground/40 ${fieldError ? "border-destructive focus-visible:border-destructive" : "border-muted focus-visible:border-primary"}`}
                placeholder={currentQ.placeholder}
                onKeyDown={handleKeyDown}
              />
            </div>
            {fieldError && (
              <p role="alert" className="mt-2 text-sm text-destructive flex items-center gap-1.5" data-testid={`error-${currentQ.field}`}>
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {fieldError.message as string}
              </p>
            )}
          </div>
        );
      }

      case "number": {
        const fieldName = currentQ.field as keyof PreApprovalFormData;
        const watchedValue = form.watch(fieldName);
        const displayValue = typeof watchedValue === 'string' ? watchedValue : "";
        const fieldError = form.formState.errors[fieldName];
        return (
          <div className="w-full max-w-md mx-auto">
            <div className="relative">
              {IconComponent && <IconComponent className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 w-6 h-6 sm:w-8 sm:h-8 text-primary" />}
              <Input
                key={`number-${fieldName}`}
                ref={focusStepInput}
                aria-label={stepCopy.title}
                data-testid={`input-${currentQ.field}`}
                type="text"
                inputMode="numeric"
                value={displayValue}
                onChange={(e) => {
                  const value = e.target.value.replace(/\D/g, "");
                  form.setValue(fieldName, value as never, { shouldValidate: true, shouldDirty: true });
                }}
                className={`pl-12 sm:pl-16 h-16 sm:h-20 text-3xl sm:text-4xl border-0 border-b-2 rounded-none focus-visible:ring-0 bg-transparent placeholder:text-muted-foreground/40 ${fieldError ? "border-destructive focus-visible:border-destructive" : "border-muted focus-visible:border-primary"}`}
                placeholder={currentQ.placeholder}
                onKeyDown={handleKeyDown}
              />
            </div>
            {fieldError && (
              <p role="alert" className="mt-2 text-sm text-destructive flex items-center gap-1.5" data-testid={`error-${currentQ.field}`}>
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {fieldError.message as string}
              </p>
            )}
          </div>
        );
      }

      case "choice":
        return (
          <div className="grid gap-3 w-full max-w-lg mx-auto" role="radiogroup" aria-labelledby="apply-question-title">
            {currentQ.options?.map((option) => {
              const OptionIcon = option.icon;
              const fieldVal = form.watch(currentQ.field as keyof PreApprovalFormData);
              const isSelected = currentQ.id === "hasAdditionalIncome"
                ? (option.value === "yes" ? fieldVal === true : fieldVal === false)
                : fieldVal === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  data-testid={`option-${currentQ.field}-${option.value}`}
                  onClick={() => {
                    if (currentQ.id === "hasAdditionalIncome") {
                      form.setValue("hasAdditionalIncome", (option.value === "yes") as never);
                      if (option.value === "no") {
                        form.setValue("incomeSources", [] as never);
                      }
                    } else {
                      form.setValue(currentQ.field as keyof PreApprovalFormData, option.value as never);
                    }
                    // The machine recomputes the route from the answers, so
                    // injected steps (complex income) appear/disappear here.
                    setTimeout(() => next(form.getValues()), 200);
                  }}
                  className={`flex items-center gap-4 p-5 text-left text-lg font-medium border-2 rounded-xl transition-all duration-200 group hover:scale-[1.02] active:scale-[0.99]
                    ${isSelected
                      ? "border-primary bg-primary/5"
                      : "border-transparent bg-muted/40 hover:bg-muted"
                    }`}
                >
                  {OptionIcon && (
                    <div className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors
                      ${isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary"}`}>
                      <OptionIcon className="h-5 w-5" />
                    </div>
                  )}
                  <span className={`flex-1 ${isSelected ? "text-primary" : "text-foreground"}`}>
                    {option.label}
                  </span>
                  <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors
                    ${isSelected ? "border-primary bg-primary" : "border-muted-foreground/30"}`}>
                    {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                  </div>
                </button>
              );
            })}
          </div>
        );

      case "state":
        return (
          <StateStep
            value={form.watch("propertyState")}
            onSelectState={(v) => form.setValue("propertyState", v, { shouldValidate: true })}
            onAdvance={() => next(form.getValues())}
          />
        );

      case "income_sources": {
        // Single source of truth: the step derives its whole UI from
        // form.incomeSources, so a restore that resets the form is all a
        // restore has to do.
        return (
          <IncomeSourcesStep
            employmentType={form.getValues("employmentType")}
            householdAnnualIncome={form.getValues("annualIncome")}
            value={watchedValues.incomeSources}
            onChange={(entries) => form.setValue("incomeSources", entries as never)}
          />
        );
      }

      case "boolean_pair":
        return (
          <div className="grid gap-4 w-full max-w-lg mx-auto">
            {currentQ.booleanFields?.map((field) => {
              const FieldIcon = field.icon;
              const isChecked = form.watch(field.field) as boolean;
              return (
                <button
                  key={field.field}
                  type="button"
                  data-testid={`toggle-${field.field}`}
                  onClick={() => {
                    form.setValue(field.field, !isChecked as never);
                  }}
                  className={`flex items-center gap-4 p-5 text-left text-lg font-medium border-2 rounded-xl transition-all duration-200 hover:scale-[1.02] active:scale-[0.99]
                    ${isChecked 
                      ? "border-primary bg-primary/5" 
                      : "border-muted hover:border-primary/50"
                    }`}
                >
                  <div className={`flex h-10 w-10 items-center justify-center rounded-lg transition-colors
                    ${isChecked ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                    <FieldIcon className="h-5 w-5" />
                  </div>
                  <span className={`flex-1 ${isChecked ? "text-primary" : "text-foreground"}`}>
                    {field.label}
                  </span>
                  <div className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-colors
                    ${isChecked ? "border-primary bg-primary" : "border-muted-foreground/30"}`}>
                    {isChecked && <Check className="w-4 h-4 text-primary-foreground" />}
                  </div>
                </button>
              );
            })}
          </div>
        );

      case "final": {
        const acknowledged = funnelState.consent.softPullAcknowledged;
        return (
          <div className="w-full max-w-md mx-auto text-left">
            <label
              className={`flex items-start gap-3 p-4 border-2 rounded-xl cursor-pointer transition-colors
                ${acknowledged ? "border-primary bg-primary/5" : "border-muted hover:border-primary/50"}`}
              data-testid="label-soft-pull-consent"
            >
              <Checkbox
                checked={acknowledged}
                onCheckedChange={(checked) => setConsent(checked === true)}
                className="mt-0.5"
                data-testid="checkbox-soft-pull-consent"
              />
              {/*
                Rendered from the SHARED constant the server also persists as
                `credit_consents.disclosure_text`, so the words on screen and the
                words in the evidence record cannot drift (F-034). Split only to
                emphasise "soft inquiry" — the concatenation is byte-identical to
                the constant, so fidelity is preserved. Edit the copy in
                shared/creditConsentCopy.ts, never here.
              */}
              <span
                className="text-sm text-muted-foreground leading-relaxed"
                data-testid="text-soft-pull-consent"
              >
                {FUNNEL_SOFT_PULL_CONSENT_TEXT.split("soft inquiry")[0]}
                <span className="font-medium text-foreground">soft inquiry</span>
                {FUNNEL_SOFT_PULL_CONSENT_TEXT.split("soft inquiry")[1]}
              </span>
            </label>
            {/*
              Data-handling reassurance at the funnel's most sensitive moment.
              This copy already existed but only in the auth-gate overlay and the
              FunnelFooter, both of which sit below the fold of the centred
              question card — so the visitor deciding whether to authorise a
              credit pull never saw it.

              Deliberately OUTSIDE the <label> above: everything inside that
              element is the verbatim disclosure persisted as
              `credit_consents.disclosure_text`, and rendered text that is not in
              FUNNEL_SOFT_PULL_CONSENT_TEXT must never appear to be part of it
              (F-034). This is page chrome, not disclosure — it makes no claim
              about the inquiry itself, which the consent copy already covers.
            */}
            <p
              className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground"
              data-testid="text-consent-security-note"
            >
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              Your information is encrypted and never sold.
            </p>
          </div>
        );
      }

      default:
        return null;
    }
  };

  const restoreBanner = showRestoreBanner ? (
    <RestoreDraftBanner onRestore={handleRestoreDraft} onDismiss={handleDismissRestore} />
  ) : null;

  if (currentQ.type === "intro") {
    const introLabel = urlType === "refinance"
      ? "Refinance"
      : urlType === "heloc" || urlType === "cashout"
        ? "Home equity"
        : "Purchase mortgage";

    return (
      <div className="min-h-screen bg-background">
        <SEOHead title="Start Your Mortgage Application" description="Start your Homiquity mortgage application and get a clear next step in about three minutes." />
        <SkipLink />
        <EditorialNavigation />
        {restoreBanner}
        <main id="main" tabIndex={-1} className="flex min-h-[calc(100vh-6rem)] items-center justify-center px-5 py-16 text-center focus:outline-none sm:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-2xl"
          >
            <p className="text-xs font-semibold uppercase tracking-widest text-flare-ink">{introLabel}</p>
            <h1 className="mt-5 font-display text-5xl font-bold leading-tight tracking-tighter text-foreground sm:text-6xl" data-testid="text-intro-title">
              {currentQ.title}
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">{currentQ.subtitle}</p>
            <Button onClick={handleNext} size="lg" className="mt-10 h-auto min-h-14 rounded-full bg-flare-ink px-8 py-4 text-base font-semibold text-primary-foreground hover:bg-flare-ink/90" data-testid="button-start-preapproval">
              {currentQ.buttonText} <ArrowRight className="ml-2" />
            </Button>
            <p className="mt-7 text-sm text-muted-foreground">
              Have a saved application?{" "}
              <a href="/login" className="font-medium text-foreground underline underline-offset-4">Sign in to resume</a>
            </p>
            {urlPropertyId && urlSource === "property-detail" && (
              <Button asChild variant="ghost" size="sm" className="touch-target mt-4 gap-1.5 text-muted-foreground" data-testid="button-back-to-property">
                <Link href={`/properties/${urlPropertyId}`}><ChevronLeft className="h-3.5 w-3.5" /> Back to property listing</Link>
              </Button>
            )}
          </motion.div>
        </main>
      </div>
    );
  }

  // The Conversational Form Steps
  return (
    <div className="min-h-screen flex flex-col bg-background overflow-x-hidden">
      <SEOHead title="Get Pre-Approved in 3 Minutes" description="Start your mortgage pre-approval application. Answer a few questions about your income and finances to get a clear, confident approval decision." />
      {restoreBanner}
      
      <VerificationPulse active={submitMutation.isPending || (isAuthenticated && hasPendingSubmit())} />

      {/* Orientation chrome — chapter rail, step counter, percentage, and a
          time-to-finish derived from the steps actually left on this
          borrower's route. Shares the max-w-5xl container with the content
          grid below so the two line up. */}
      <FunnelProgressHeader
        progress={progress}
        onBack={handleBack}
        canGoBack={progress.index > 0}
        showSaved={progress.index > 0}
      />

      {/* Main Content Area — on lg+ a two-column grid: the question column and
          the advisory panel share one centered container and one coordinate
          system (the panel used to be viewport-fixed while the content
          reserved a padding gutter for it, which left the question sitting
          left of every other centered element with dead space in between).
          The column is reserved on every step, so the question never jumps
          when the panel's numbers start arriving. */}
      {/* pt clears the fixed FunnelProgressHeader, which is ~115px tall (counter
          row + chapter rail + labels + the chapter/time line) rather than the
          ~70px of the single-line header it replaced. */}
      <div className="flex-1 w-full max-w-5xl mx-auto px-4 sm:px-6 pt-32 sm:pt-36 pb-0 relative flex flex-col items-center lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-10 lg:items-center">
       <div className="w-full min-w-0 flex flex-1 lg:flex-none flex-col items-center justify-center">
        {/*
          mode="wait" mounts the next step only after the previous step's exit
          animation completes, and framer-motion drives that animation off
          requestAnimationFrame — which browsers stop entirely while
          document.visibilityState === "hidden". Machine state (and the
          "Step X of Y" header above, which lives outside this AnimatePresence)
          still advances, so a hidden document can sit indefinitely at
          header = step N+1 while the step-N question stays in the DOM, frozen
          at its last animation pose. Verified 2026-07-17: a real user cannot
          reach that state — a hidden tab receives no trusted pointer/keyboard
          input, and if the tab is hidden mid-transition the stalled exit
          completes on the first frame after it becomes visible again,
          resyncing the UI. Only scripted drivers (element.click() / CDP
          against an unrendered pane) can observe the desync, so headless
          funnel tests must force the pane to render (screenshot/focus) or
          assert on the step counter, not on the question text.
        */}
        <AnimatePresence mode="wait" custom={direction}>
          <motion.div
            key={stepId}
            custom={direction}
            initial={{ x: direction * 50, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: direction * -50, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="w-full text-center"
          >
            {/* Question Title */}
            <h2
              id="apply-question-title"
              className="text-2xl sm:text-3xl md:text-4xl font-bold text-foreground mb-4 leading-tight"
              data-testid="text-question"
            >
              {stepCopy.title}
            </h2>

            {currentQ.subtitle && (
              <p className="text-lg text-muted-foreground mb-8">{currentQ.subtitle}</p>
            )}

            {(currentQ.id === "downPayment" && flags.vaZeroDown) ? (
               <p className="text-base text-muted-foreground/70 mb-8 max-w-lg mx-auto" data-testid="text-va-zero-down">
                 As a veteran, you may qualify for a VA loan with <span className="font-medium text-foreground">$0 down and no PMI</span>. Enter 0 to explore that path.
               </p>
            ) : stepCopy.subtext && (
               <p className="text-base text-muted-foreground/70 mb-8 max-w-lg mx-auto">{stepCopy.subtext}</p>
            )}

            {/* Input Area */}
            <div className="mb-10">
              {renderInput()}
              {stepCopy.why && (
                <p
                  className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground/70"
                  data-testid={`text-why-${currentQ.id}`}
                >
                  <Info className="h-3 w-3 shrink-0" />
                  {stepCopy.why}
                </p>
              )}
            </div>

            {/* Continue Button (for non-choice inputs) */}
            {(currentQ.type === "currency" || currentQ.type === "number" || currentQ.type === "boolean_pair" || currentQ.type === "income_sources" || currentQ.type === "final") && (
              <Button 
                onClick={handleNext} 
                size="lg" 
                disabled={submitMutation.isPending}
                className="w-full sm:w-auto text-lg px-10 py-6 h-auto rounded-full shadow-card-lg hover:shadow-card-hover transition-all"
                data-testid={currentQ.type === "final" ? "button-submit" : "button-continue"}
              >
                {submitMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    Analyzing...
                  </>
                ) : currentQ.type === "final" ? (
                  "Get My Loan Options"
                ) : (
                  <>
                    Continue
                    <ArrowRight className="ml-2 w-5 h-5" />
                  </>
                )}
              </Button>
            )}

          </motion.div>
        </AnimatePresence>
       </div>

       {/* Advisory Panel — the grid's right column at lg, and below the question
           and its CTA on a phone. It is NOT desktop-only any more: leaving mobile
           without the DTI, the payment estimate and the why-we-ask advice starved
           the borrower most likely to abandon (DESIGN_SYSTEM.md §12.3). */}
       <AdvisoryPanel formValues={watchedValues} currentStepId={currentQ.id} />
      </div>

      {teaser && (
        <AffordabilityTeaserOverlay
          estimate={teaser.estimate}
          targetPrice={teaser.targetPrice}
          onContinue={() => {
            setTeaser(null);
            setShowAuthGate(true);
          }}
          onDismiss={() => setTeaser(null)}
        />
      )}

      {showAuthGate && <AuthGateOverlay onDismiss={() => setShowAuthGate(false)} />}

      <FunnelFooter />
    </div>
  );
}
