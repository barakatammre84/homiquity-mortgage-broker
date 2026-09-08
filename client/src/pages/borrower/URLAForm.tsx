import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryErrorState } from "@/components/ui/query-boundary";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { useTrackActivity, useTrackFormStart } from "@/hooks/useActivityTracker";
import { apiRequest, dashboardKeys, urlaKeys, loanApplicationKeys } from "@/lib/queryClient";
import { friendlyApiError } from "@/lib/errorMessage";
import type {
  LoanApplication,
  UrlaPersonalInfo,
  EmploymentHistory,
  UrlaAsset,
  UrlaLiability,
  UrlaPropertyInfo,
  OtherIncomeSource,
  RealEstateOwned,
  BorrowerDeclarations,
  HmdaDemographics,
} from "@shared/schema";
import { useActiveApplication } from "@/hooks/useActiveApplication";
import {
  Users,
  FileText,
  Save,
  Plus,
  Trash2,
  Loader2,
  Check,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { PageShell } from "@/components/PageShell";
import {
  DECLARATION_QUESTIONS,
  demographicsToPayload,
  emptyDemographics,
  emptySlice,
  hmdaToState,
  prefillPrimaryEmployment,
  orderEmploymentRecords,
  prefillPrimaryPersonalInfo,
  prefillRealEstateOwned,
  toLoanDetailsState,
  type AssetForm,
  type BorrowerSlice,
  type LiabilityForm,
  type PersonalInfoForm,
  type RealEstateOwnedForm,
  type SectionsPayload,
  type UrlaSavePayload,
} from "./urla/types";
import { isUrlaRowSaveable, urlaRowSaveState, type UrlaRowSection } from "@shared/lib/urlaRowContent";
import type { UrlaLoanDetails } from "@shared/schema";
import { isSelfEmploymentWorksheetComplete } from "@shared/lib/selfEmploymentWorksheet";
import { PersonalInfoSection } from "./urla/PersonalInfoSection";
import { EmploymentSection } from "./urla/EmploymentSection";
import { AssetsSection } from "./urla/AssetsSection";
import { LiabilitiesSection } from "./urla/LiabilitiesSection";
import { PropertySection } from "./urla/PropertySection";
import { DeclarationsSection } from "./urla/DeclarationsSection";
import { DemographicsSection } from "./urla/DemographicsSection";
import { RealEstateOwnedSection } from "./urla/RealEstateOwnedSection";

interface DashboardData {
  applications: LoanApplication[];
}

interface UrlaData {
  application: LoanApplication;
  personalInfo: UrlaPersonalInfo | null;
  allPersonalInfo?: UrlaPersonalInfo[];
  employmentHistory: EmploymentHistory[];
  otherIncomeSources: OtherIncomeSource[];
  assets: UrlaAsset[];
  liabilities: UrlaLiability[];
  propertyInfo: UrlaPropertyInfo | null;
  declarations?: BorrowerDeclarations | null;
  allDeclarations?: BorrowerDeclarations[];
  hmdaDemographics?: HmdaDemographics[];
  realEstateOwned?: RealEstateOwned[];
}

interface StepContext {
  slice: BorrowerSlice;
  otherIncomes: Partial<OtherIncomeSource>[];
  propertyInfo: Partial<UrlaPropertyInfo>;
  realEstateOwned: RealEstateOwnedForm[];
  ownsOtherRealEstate: boolean | null;
  app: LoanApplication;
}

/**
 * The seven step ids, as a union rather than `string`.
 *
 * These ids are matched against the `<TabsContent value="…">` literals ~580
 * lines below, in the same file. While `id` was `string` that was a
 * compiler-unchecked contract: renaming a step here silently rendered an empty
 * tab panel, with nothing red in `tsc`, the test suite, or any guard.
 *
 * Narrowing it closes that in both directions — each panel literal is pinned
 * with `satisfies UrlaStepId`, so a typo or a half-finished rename is a build
 * error. knowledge-base/handbook/URLA_FORM_REFACTOR_TRAP.md names exactly this
 * narrowing as the prerequisite for ever moving the STEPS table out of this
 * file. It is the prerequisite only — the move itself is still refuted there,
 * and this change does not license it.
 */
type UrlaStepId =
  | "borrower"
  | "employment"
  | "assets"
  | "liabilities"
  | "real-estate"
  | "property"
  | "declarations"
  | "demographics";

interface UrlaStep {
  id: UrlaStepId;
  label: string;
  estimate: string;
  intro: string;
  isComplete: (ctx: StepContext) => boolean;
}

export function isEmploymentSectionComplete(records: Partial<EmploymentHistory>[]): boolean {
  const started = records.filter((record) => record.employerName || record.positionTitle || record.isSelfEmployed);
  if (started.length === 0) return false;
  return started.every((record) => {
    if (!record.employerName) return false;
    if (!record.isSelfEmployed) return true;
    return isSelfEmploymentWorksheetComplete(record.selfEmploymentIncome);
  });
}

// Completion is advisory only — it drives the progress bar and the check marks
// in the step rail, never gates navigation or saving (URLA is save-as-you-go).
const STEPS: UrlaStep[] = [
  {
    id: "borrower",
    label: "About you",
    estimate: "~4 min",
    intro: "Let's start with you. Nothing here is graded — it's simply how your loan file gets opened.",
    isComplete: ({ slice }) =>
      !!(slice.personalInfo.firstName && slice.personalInfo.lastName &&
         slice.personalInfo.dateOfBirth && (slice.personalInfo.ssn || slice.personalInfo.ssnLast4)),
  },
  {
    id: "employment",
    label: "Work & income",
    estimate: "~5 min",
    intro: "Your work and income story. Two years of history is the underwriting standard.",
    isComplete: ({ slice }) => isEmploymentSectionComplete(slice.employmentRecords),
  },
  {
    id: "assets",
    label: "Assets",
    estimate: "~2 min",
    intro: "Where your down payment and reserves will come from.",
    isComplete: ({ slice }) =>
      slice.assets.some((a) => a.accountType || a.financialInstitution),
  },
  {
    id: "liabilities",
    label: "Liabilities",
    estimate: "~2 min",
    intro: "Your monthly obligations. Listing everything now prevents surprises later.",
    isComplete: ({ slice }) =>
      slice.liabilities.some((l) => l.liabilityType || l.creditorName),
  },
  {
    id: "real-estate",
    label: "Properties you own",
    estimate: "~2 min",
    intro: "One property record powers rental income, monthly obligations, reserves, and the lender package — review it once here.",
    isComplete: ({ ownsOtherRealEstate, realEstateOwned }) =>
      ownsOtherRealEstate === false || (
        ownsOtherRealEstate === true &&
        realEstateOwned.length > 0 &&
        realEstateOwned.every((property) =>
          !!property.propertyAddress &&
          property.marketValue !== null && property.marketValue !== undefined && property.marketValue !== "" &&
          property.mortgageBalance !== null && property.mortgageBalance !== undefined && property.mortgageBalance !== "" &&
          !!(property.status || property.occupancyType),
        )
      ),
  },
  {
    id: "property",
    label: "Property & loan",
    estimate: "~2 min",
    intro: "The home and loan this application is for — much of it carries over from your pre-approval.",
    isComplete: ({ propertyInfo, app }) =>
      !!((propertyInfo.propertyStreet || app.propertyAddress) &&
         (propertyInfo.propertyValue || app.propertyValue || app.purchasePrice)),
  },
  {
    id: "declarations",
    label: "Declarations",
    estimate: "~2 min",
    intro: "Standard questions every lender must ask — answer honestly, there are no trick questions.",
    isComplete: ({ slice }) =>
      DECLARATION_QUESTIONS.every((q) => typeof slice.declarations[q.key] === "boolean"),
  },
  {
    id: "demographics",
    label: "Demographics",
    estimate: "~1 min",
    intro: "Optional federal monitoring questions. Declining to answer is always allowed.",
    isComplete: ({ slice }) => {
      const d = slice.demographics;
      const ethnicity = d.ethnicityHispanicLatino || d.ethnicityNotHispanicLatino || d.ethnicityNotProvided;
      const race = d.raceAmericanIndian || d.raceAsian || d.raceBlack || d.raceNativeHawaiian || d.raceWhite || d.raceNotProvided;
      const sex = d.sexFemale || d.sexMale || d.sexNotProvided;
      const age = !!d.age || d.ageNotProvided;
      return ethnicity && race && sex && age;
    },
  },
];

/**
 * Sections that belong to the FILE rather than to a person: the property and
 * loan answers are the same whichever borrower tab is open, so the application
 * total counts them once no matter how many borrowers are on it. Every other
 * step reads `slice`, and therefore exists once PER borrower.
 */
const SHARED_STEP_IDS: ReadonlySet<UrlaStepId> = new Set<UrlaStepId>(["real-estate", "property"]);

export default function URLAForm() {
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const track = useTrackActivity();
  const trackFormStart = useTrackFormStart();

  const {
    data: dashboardData,
    isLoading: dashboardLoading,
    isError: dashboardIsError,
    error: dashboardErrorObj,
    refetch: refetchDashboard,
  } = useQuery<DashboardData>({
    queryKey: dashboardKeys.root(),
    enabled: !authLoading,
  });

  const applications = dashboardData?.applications || [];
  const { activeApplication } = useActiveApplication(applications);

  const {
    data: urlaData,
    isLoading: urlaLoading,
    isError: urlaIsError,
    error: urlaErrorObj,
    refetch: refetchUrla,
  } = useQuery<UrlaData>({
    queryKey: urlaKeys.detail(activeApplication?.id),
    enabled: !!activeApplication?.id,
  });

  // Per-borrower section data, keyed by borrowerSequenceNumber (1 = primary, 2 = co-borrower)
  const [borrowerData, setBorrowerData] = useState<Record<number, BorrowerSlice>>({ 1: emptySlice(), 2: emptySlice() });
  const [activeSeq, setActiveSeq] = useState<number>(1);
  const [hasCoBorrower, setHasCoBorrower] = useState<boolean>(false);
  // Shared (primary-only) data
  const [otherIncomes, setOtherIncomes] = useState<Partial<OtherIncomeSource>[]>([]);
  const [propertyInfo, setPropertyInfo] = useState<Partial<UrlaPropertyInfo>>({});
  const [realEstateOwned, setRealEstateOwned] = useState<RealEstateOwnedForm[]>([]);
  const [ownsOtherRealEstate, setOwnsOtherRealEstate] = useState<boolean | null>(null);
  // Section 4a (WF2-F4): borrower-stated loan type + amortization type, with
  // borrower-safe defaults preselected — visible and editable, never a silent
  // server-side default. Saved to the loan_applications columns section-4
  // gating requires.
  const [loanDetails, setLoanDetails] = useState<UrlaLoanDetails>({
    preferredLoanType: "conventional",
    amortizationType: "fixed",
  });

  const [activeStep, setActiveStep] = useState<string>(STEPS[0].id);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const slice = borrowerData[activeSeq] ?? emptySlice();
  const updateSlice = (patch: Partial<BorrowerSlice>) =>
    setBorrowerData((prev) => ({ ...prev, [activeSeq]: { ...(prev[activeSeq] ?? emptySlice()), ...patch } }));

  const setPersonalInfo = (v: PersonalInfoForm) => updateSlice({ personalInfo: v });
  const setEmploymentRecords = (v: Partial<EmploymentHistory>[]) => updateSlice({ employmentRecords: v });
  const setAssets = (v: AssetForm[]) => updateSlice({ assets: v });
  const setLiabilities = (v: LiabilityForm[]) => updateSlice({ liabilities: v });
  const setDeclarations = (v: Partial<BorrowerDeclarations>) => updateSlice({ declarations: v });
  const setDemographics = (v: BorrowerSlice["demographics"]) => updateSlice({ demographics: v });

  useEffect(() => {
    if (!urlaData) return;
    const seqOf = (r: { borrowerSequenceNumber?: number | null }) => r.borrowerSequenceNumber ?? 1;

    const buildSlice = (seq: number): BorrowerSlice => {
      const pi = (urlaData.allPersonalInfo || []).find((p) => seqOf(p) === seq);
      const emp = orderEmploymentRecords(
        (urlaData.employmentHistory || []).filter((e) => seqOf(e) === seq),
      );
      const ast = (urlaData.assets || []).filter((a) => seqOf(a) === seq);
      const lia = (urlaData.liabilities || []).filter((l) => seqOf(l) === seq);
      const decl = (urlaData.allDeclarations || []).find((d) => seqOf(d) === seq);
      const hmda = (urlaData.hmdaDemographics || []).find((h) => seqOf(h) === seq);
      return {
        personalInfo: seq === 1 ? prefillPrimaryPersonalInfo(pi, user) : pi || {},
        employmentRecords: seq === 1 ? prefillPrimaryEmployment(emp, urlaData.application) : emp.length ? emp : [{}],
        assets: ast.length ? ast : [{}],
        liabilities: lia.length ? lia : [{}],
        declarations: decl || {},
        demographics: hmda ? hmdaToState(hmda) : emptyDemographics(),
      };
    };

    setBorrowerData({ 1: buildSlice(1), 2: buildSlice(2) });
    setOtherIncomes(urlaData.otherIncomeSources?.length ? urlaData.otherIncomeSources : []);
    setPropertyInfo(urlaData.propertyInfo || {});
    const carriedRealEstate = prefillRealEstateOwned(
      urlaData.realEstateOwned || [],
      urlaData.application,
    );
    setRealEstateOwned(carriedRealEstate);
    setOwnsOtherRealEstate(
      urlaData.application.ownsOtherRealEstate ?? (carriedRealEstate.length > 0 ? true : null),
    );
    setLoanDetails(toLoanDetailsState(urlaData.application));

    const hasCo =
      (urlaData.allPersonalInfo || []).some((p) => seqOf(p) > 1) ||
      (urlaData.employmentHistory || []).some((e) => seqOf(e) > 1) ||
      (urlaData.assets || []).some((a) => seqOf(a) > 1) ||
      (urlaData.liabilities || []).some((l) => seqOf(l) > 1) ||
      (urlaData.allDeclarations || []).some((d) => seqOf(d) > 1) ||
      (urlaData.hmdaDemographics || []).some((h) => seqOf(h) > 1);
    if (hasCo) setHasCoBorrower(true);
  }, [urlaData, activeApplication?.id, user]);

  useEffect(() => {
    if (activeApplication?.id) trackFormStart("urla");
  }, [activeApplication?.id, trackFormStart]);

  // Removal has to be a real request. The bulk save is upsert-only and simply
  // omits `coApplicants` when the flag is false, so clearing slot 2 locally
  // deleted nothing and the next refetch put the co-borrower back (#450).
  //
  // Note what this does NOT do: it does not make `hasCoBorrower` two-way. That
  // latch is monotonic on purpose — hydration only ever sets it TRUE, which is
  // what lets ADD Co-Borrower survive the post-save refetch. Once the seq-2 rows
  // are genuinely gone, the six-way `hasCo` check computes false on its own and
  // the latch never fires. Fixing the data made the state machine correct.
  const removeCoBorrowerMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("DELETE", `/api/urla/${activeApplication?.id}/co-applicant/2`);
      return response.json();
    },
    onSuccess: () => {
      setBorrowerData((prev) => ({ ...prev, 2: emptySlice() }));
      setHasCoBorrower(false);
      setActiveSeq(1);
      queryClient.invalidateQueries({ queryKey: urlaKeys.detail(activeApplication?.id) });
      toast({
        title: "Co-borrower removed",
        description: "Their information has been deleted from this application. Yours is unchanged.",
      });
    },
    onError: () => {
      // The old behaviour failed silently and looked like success. Say so.
      toast({
        title: "We couldn't remove the co-borrower",
        description: "Nothing was changed. Give it another try in a moment — if it keeps happening, message your loan team.",
        variant: "destructive",
      });
    },
  });

  // Which rows the borrower filled in but the save cannot accept, phrased for
  // them. Takes no arguments and reads the same state buildPayload does, on
  // purpose — see knowledge-base/handbook/URLA_FORM_REFACTOR_TRAP.md: giving
  // these builders a parameter is what lets the wrong borrower slice be passed.
  const describeUnsavedRows = (): string[] => {
    const notes: string[] = [];
    // Whose rows are being described. The #451 fix covered slot 1 only, while
    // `buildPayload` filters BOTH slices through the same `isUrlaRowSaveable`
    // — so a co-borrower's half-filled asset was dropped from the payload,
    // reported "Everything is safely stored", and then erased from the screen
    // by the post-save refetch. Same defect, the other borrower.
    //
    // The owner prefix is empty when there is no co-borrower, so the
    // single-borrower wording is unchanged; once a second borrower exists,
    // "an asset row" is ambiguous and both sides get named.
    const mine = hasCoBorrower ? "your " : "";
    const sections: { section: UrlaRowSection; rows: Record<string, unknown>[]; noun: string; whose: string }[] = [
      { section: "employment", rows: borrowerData[1]?.employmentRecords ?? [], noun: "job", whose: mine },
      { section: "asset", rows: borrowerData[1]?.assets ?? [], noun: "asset", whose: mine },
      { section: "liability", rows: borrowerData[1]?.liabilities ?? [], noun: "liability", whose: mine },
      // Other income is shared, primary-only state — `buildPayload` sends it
      // once, outside either slice, so it carries no owner.
      { section: "otherIncome", rows: otherIncomes as Record<string, unknown>[], noun: "other-income", whose: "" },
    ];
    // Gated on the same flag `buildPayload` gates `coApplicants` on, so the
    // two can never disagree about which rows were actually filtered.
    if (hasCoBorrower) {
      sections.push(
        { section: "employment", rows: borrowerData[2]?.employmentRecords ?? [], noun: "job", whose: "co-borrower " },
        { section: "asset", rows: borrowerData[2]?.assets ?? [], noun: "asset", whose: "co-borrower " },
        { section: "liability", rows: borrowerData[2]?.liabilities ?? [], noun: "liability", whose: "co-borrower " },
      );
    }
    for (const { section, rows, noun, whose } of sections) {
      const blocked = rows
        .map(r => urlaRowSaveState(section, r))
        .filter((s): s is { state: "incomplete"; missing: string[] } => s.state === "incomplete");
      if (!blocked.length) continue;
      const missing = Array.from(new Set(blocked.flatMap(b => b.missing)));
      notes.push(
        blocked.length === 1
          ? `one ${whose}${noun} row still needs ${missing.join(" and ")}`
          : `${blocked.length} ${whose}${noun} rows still need ${missing.join(" and ")}`,
      );
    }
    if (ownsOtherRealEstate === null) {
      notes.push("the properties-you-own question still needs Yes or No");
    } else if (ownsOtherRealEstate && realEstateOwned.length === 0) {
      notes.push("the properties-you-own section still needs a property");
    } else if (ownsOtherRealEstate && realEstateOwned.some((property) => !property.propertyAddress?.trim())) {
      notes.push("one property row still needs its address");
    }
    return notes;
  };

  const saveMutation = useMutation({
    mutationFn: async ({ data }: { data: UrlaSavePayload; silent?: boolean }) => {
      const response = await apiRequest("POST", `/api/urla/${activeApplication?.id}/save`, data);
      return response.json();
    },
    onSuccess: (_result, variables) => {
      setLastSavedAt(new Date());
      if (!variables.silent) {
        // Rows the database cannot accept are still left out of the payload —
        // but the borrower is told, by row and by reason. Reporting "Everything
        // is safely stored" over a dropped row was the actual defect in #451:
        // the row vanished from the payload, the toast claimed success, and the
        // post-save refetch erased it from the screen too, so no state existed
        // in which the borrower could tell.
        const unsaved = describeUnsavedRows();
        if (unsaved.length) {
          toast({
            title: "Saved — but some rows need one more detail",
            description: `${unsaved.join("; ")}. Everything else is stored; add the missing detail and save again.`,
            variant: "destructive",
          });
        } else {
          toast({
            title: "Application saved",
            description: "Everything is safely stored — you can pick this up anytime.",
          });
        }
      }
      const savedApplicationId = activeApplication?.id;
      if (!savedApplicationId) return;
      queryClient.invalidateQueries({ queryKey: urlaKeys.detail(savedApplicationId) });
      queryClient.invalidateQueries({ queryKey: dashboardKeys.root() });
      // The save is NOT confined to the URLA tables. `POST /api/urla/:id/save`
      // runs evaluateTridTrigger (server/services/trid.ts), and once the six
      // pieces of application information are on file that writes
      // `tridTriggeredAt` onto the LOAN APPLICATION ROW and appends a
      // compliance deal-activity — Reg Z §1026.2(a)(3), which starts the
      // 3-business-day Loan Estimate clock.
      //
      // Both of those are served under loanApplicationKeys.detail (the detail
      // response carries `activities`), and two borrower surfaces read it:
      // LoanPipeline and CreditConsent. Invalidating only the URLA key left
      // them rendering the pre-trigger file — the borrower completes the
      // section that legally starts their LE clock and the app still shows the
      // state from before it started.
      //
      // detail() is the family PREFIX, so this reaches the nested pipeline /
      // conditions reads too; enumerating those by hand is the failure mode
      // documented on homeownershipGoalKeys.
      //
      // Deliberately OUTSIDE the `!variables.silent` branch. The six pieces
      // complete at an INTERMEDIATE step (personal info + property info), which
      // saves silently — so gating this on the loud final save would skip the
      // one save that actually trips the trigger. `silent` is per-step, not a
      // debounced autosave (handleContinue), so this runs a handful of times
      // per session, not per keystroke.
      queryClient.invalidateQueries({
        queryKey: loanApplicationKeys.detail(savedApplicationId),
      });
    },
    onError: (error: unknown) => {
      toast({
        title: "We couldn't save that just now",
        description: friendlyApiError(
          error,
          "Your answers are still here on the page. Give it another try in a moment — if it keeps happening, message your loan team.",
        ),
        variant: "destructive",
      });
    },
  });

  // Every repeating section drops rows the borrower never touched, but the test
  // is EMPTINESS (hasBorrowerContent), not "did they fill in the one field we
  // picked". The old per-section predicates discarded any row filled in a
  // different order — employment dates and income without the employer name, an
  // asset balance without an institution, a liability payment without a
  // creditor — and the save then reported "Everything is safely stored".
  const buildSectionsPayload = (s: BorrowerSlice): SectionsPayload => ({
    personalInfo: s.personalInfo,
    employmentHistory: s.employmentRecords
      .filter(r => isUrlaRowSaveable("employment", r))
      .map(emp => ({ ...emp, employmentType: emp.employmentType || "current" })),
    assets: s.assets.filter(r => isUrlaRowSaveable("asset", r)),
    liabilities: s.liabilities.filter(r => isUrlaRowSaveable("liability", r)),
    declarations: s.declarations,
    demographics: demographicsToPayload(s.demographics),
  });

  const buildPayload = (): UrlaSavePayload => {
    // Was `incomeSource && monthlyAmount` — the only section requiring BOTH, so
    // it lost a row for a source with no amount yet AND for an amount with no
    // source. That asymmetry was not deliberate.
    const cleanedOtherIncomes = otherIncomes.filter(r => isUrlaRowSaveable("otherIncome", r));
    const primary = buildSectionsPayload(borrowerData[1] ?? emptySlice());

    const payload: UrlaSavePayload = {
      ...primary,
      otherIncomeSources: cleanedOtherIncomes,
      propertyInfo,
      loanDetails,
    };

    const realEstateRowsHaveAddresses =
      realEstateOwned.length > 0 && realEstateOwned.every((property) => !!property.propertyAddress?.trim());
    if (
      ownsOtherRealEstate === false ||
      (ownsOtherRealEstate === true && realEstateRowsHaveAddresses)
    ) {
      payload.realEstateOwned = {
        ownsOtherRealEstate,
        properties: ownsOtherRealEstate ? realEstateOwned : [],
      };
    }

    if (hasCoBorrower) {
      payload.coApplicants = [buildSectionsPayload(borrowerData[2] ?? emptySlice())];
    }

    return payload;
  };

  const handleSave = () => {
    saveMutation.mutate({ data: buildPayload() });
  };

  const stepIndex = STEPS.findIndex((s) => s.id === activeStep);
  const isLastStep = stepIndex === STEPS.length - 1;

  const handleContinue = () => {
    // Final step saves loudly (toast); intermediate steps save quietly and advance.
    saveMutation.mutate({ data: buildPayload(), silent: !isLastStep });
    track("urla_section_complete", "/urla-form", {
      form: "urla",
      step_id: activeStep,
      step: stepIndex + 1,
      total: STEPS.length,
      application_id: activeApplication?.id,
    });
    if (!isLastStep) {
      setActiveStep(STEPS[stepIndex + 1].id);
      window.scrollTo({ top: 0 });
    }
  };

  const handleBack = () => {
    if (stepIndex > 0) {
      setActiveStep(STEPS[stepIndex - 1].id);
      window.scrollTo({ top: 0 });
    }
  };

  if (authLoading || dashboardLoading || urlaLoading) {
    return (
      <PageShell width="wide">
        <Skeleton className="mb-8 h-8 w-48" />
        <div className="lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:gap-8">
          <Skeleton className="mb-6 h-12 lg:h-96" />
          <Skeleton className="h-96" />
        </div>
      </PageShell>
    );
  }

  // A load failure would otherwise fall through to "No application open yet"
  // (masking a server error) or a blank 1003 the user could overwrite — show an
  // honest error + retry first (ux-01).
  if (dashboardIsError || urlaIsError) {
    return (
      <div className="p-8">
        <QueryErrorState
          error={dashboardErrorObj ?? urlaErrorObj}
          onRetry={() => {
            void refetchDashboard();
            void refetchUrla();
          }}
          title="We couldn't load your loan file"
          data-testid="urla-error"
        />
      </div>
    );
  }

  if (!activeApplication) {
    return (
      <PageShell width="wide">
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <FileText className="mb-4 h-12 w-12 text-muted-foreground" />
            <p className="text-lg font-medium">No application open yet</p>
            <p className="text-sm text-muted-foreground mt-2 max-w-md text-center">
              Start your pre-approval and we'll open your loan file here — most people
              finish it in about three minutes.
            </p>
            <Button asChild className="mt-6">
              <Link href="/apply">Start pre-approval</Link>
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  const app = urlaData?.application || activeApplication;
  const stepContext: StepContext = {
    slice,
    otherIncomes,
    propertyInfo,
    realEstateOwned,
    ownsOtherRealEstate,
    app,
  };

  // The rail's check marks are per-borrower — the "Editing for:" control above
  // says whose, so that scope is right. The progress bar is not: it is labelled
  // "Application progress", and counting only the ACTIVE slice made it describe
  // a person while claiming to describe the file. With a co-borrower on the
  // application it read "7 of 7 sections complete" while their six sections
  // were empty, then fell to "1 of 7" the instant you switched tabs — the same
  // file, two answers, neither of them the file's, and the higher one the lie
  // that stops a borrower filling the rest in.
  //
  // So the bar counts the whole application: every per-borrower section once
  // per borrower, the shared property section once. The numerator can then only
  // ever rise as sections are finished; adding a co-borrower raises the
  // denominator, which is the truth about how much work the file now needs.
  const borrowerSeqs = hasCoBorrower ? [1, 2] : [1];
  const applicationProgress = STEPS.reduce(
    (acc, step) => {
      if (SHARED_STEP_IDS.has(step.id)) {
        acc.total += 1;
        if (step.isComplete(stepContext)) acc.done += 1;
        return acc;
      }
      for (const seq of borrowerSeqs) {
        acc.total += 1;
        const ctx: StepContext = {
          slice: borrowerData[seq] ?? emptySlice(),
          otherIncomes,
          propertyInfo,
          realEstateOwned,
          ownsOtherRealEstate,
          app,
        };
        if (step.isComplete(ctx)) acc.done += 1;
      }
      return acc;
    },
    { done: 0, total: 0 },
  );
  const currentStep = STEPS[stepIndex];

  return (
    <PageShell
      width="wide"
      title="Your Loan Application"
      subtitle="Uniform Residential Loan Application · Freddie Mac Form 65 / Fannie Mae Form 1003 (Effective 1/2021)"
      headerAction={
        <div className="flex items-center gap-4">
          <p aria-live="polite" className="text-xs text-muted-foreground" data-testid="text-urla-save-status">
            {saveMutation.isPending ? (
              "Saving…"
            ) : lastSavedAt ? (
              <span className="flex items-center gap-1">
                <Check aria-hidden="true" className="h-3 w-3" />
                Saved at {lastSavedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            ) : (
              "Progress saves each time you continue"
            )}
          </p>
          <Button onClick={handleSave} disabled={saveMutation.isPending} variant="outline" className="gap-2" data-testid="button-save-urla-top">
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </Button>
        </div>
      }
    >
      <div className="mb-8 space-y-2">
        <Progress
          value={(applicationProgress.done / applicationProgress.total) * 100}
          className="h-1.5"
          aria-label={`Application progress: ${applicationProgress.done} of ${applicationProgress.total} sections complete`}
        />
        <p className="text-xs text-muted-foreground" data-testid="text-urla-progress">
          {applicationProgress.done} of {applicationProgress.total} sections complete
          {hasCoBorrower ? " — you and your co-borrower" : ""}
        </p>
      </div>

        <Card className="mb-8">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Editing for:</span>
              {/* touch-target: `sm` is h-9 (36px), under the 44px floor. A mis-tap on
                  this pair selects the WRONG BORROWER and every keystroke after it lands
                  in that slice — the same cross-contamination class the refactor trap
                  guards. The utility raises the hit area below 767px only. */}
              <Button
                variant={activeSeq === 1 ? "default" : "outline"}
                size="sm"
                className="touch-target"
                onClick={() => setActiveSeq(1)}
                data-testid="button-borrower-primary"
              >
                Primary Borrower
              </Button>
              {hasCoBorrower && (
                <Button
                  variant={activeSeq === 2 ? "default" : "outline"}
                  size="sm"
                  className="touch-target"
                  onClick={() => setActiveSeq(2)}
                  data-testid="button-borrower-co"
                >
                  Co-Borrower
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!hasCoBorrower ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="touch-target gap-2"
                  onClick={() => {
                    setHasCoBorrower(true);
                    setActiveSeq(2);
                  }}
                  data-testid="button-add-coborrower"
                >
                  <Plus className="h-4 w-4" />
                  Add Co-Borrower
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="touch-target gap-2"
                  disabled={removeCoBorrowerMutation.isPending}
                  onClick={() => {
                    // Confirm because this is now durable and irreversible. It
                    // used to be local state only, which is exactly why the
                    // co-borrower came back after the next refetch (#450).
                    const co = borrowerData[2]?.personalInfo;
                    const who = [co?.firstName, co?.lastName].filter(Boolean).join(" ").trim();
                    const ok = window.confirm(
                      `Remove ${who || "the co-borrower"} from this application?\n\n` +
                      "Everything they entered — employment, assets, liabilities and declarations — is deleted and cannot be recovered. Your own information is not affected.",
                    );
                    if (!ok) return;
                    removeCoBorrowerMutation.mutate();
                  }}
                  data-testid="button-remove-coborrower"
                >
                  <Trash2 className="h-4 w-4" />
                  Remove Co-Borrower
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Tabs value={activeStep} onValueChange={setActiveStep}>
          <div className="lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start lg:gap-8">
            <div className="mb-6 lg:sticky lg:top-6 lg:mb-0">
              {/* Wraps on a phone; it used to be `overflow-x-auto`, a horizontally
                  scrolling step rail that put steps 4–7 off-screen with no affordance
                  that they existed (DESIGN_SYSTEM.md §12.3 — no horizontal scrolling on
                  a capture screen). Below lg the triggers are badge-only so all seven
                  fit; their labels stay in the DOM as `sr-only` so each tab keeps its
                  accessible name, and the active step's label is rendered beside the
                  step counter below. lg is unchanged: the vertical rail with labels. */}
              <TabsList className="flex h-auto w-full flex-wrap items-stretch justify-start gap-1 bg-transparent p-0 lg:flex-col lg:flex-nowrap">
                {STEPS.map((step, index) => {
                  const complete = step.isComplete(stepContext);
                  return (
                    <TabsTrigger
                      key={step.id}
                      value={step.id}
                      data-testid={`tab-${step.id}`}
                      className="h-auto shrink-0 justify-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left text-muted-foreground data-[state=active]:border-border data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-none lg:justify-start"
                    >
                      {complete ? (
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success-subtle text-success-subtle-foreground">
                          <Check aria-hidden="true" className="h-3.5 w-3.5" />
                          <span className="sr-only">Section complete:</span>
                        </span>
                      ) : (
                        <span
                          aria-hidden="true"
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium"
                        >
                          {index + 1}
                        </span>
                      )}
                      <span className="sr-only lg:not-sr-only lg:flex lg:min-w-0 lg:flex-col">
                        <span className="truncate text-sm font-medium">{step.label}</span>
                        <span className="hidden text-[11px] font-normal text-muted-foreground lg:block">
                          {step.estimate}
                        </span>
                      </span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </div>

            <div className="min-w-0">
              <div aria-live="polite" className="mb-6 space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Step {stepIndex + 1} of {STEPS.length} · {currentStep.estimate}
                </p>
                {/* The step's name is in the rail on desktop, but the rail is
                    badge-only on a phone — so render it here below lg. */}
                <p className="text-base font-semibold text-foreground lg:hidden" data-testid="text-urla-step-label">
                  {currentStep.label}
                </p>
                <p className="text-sm text-muted-foreground">{currentStep.intro}</p>
              </div>

              <TabsContent value={"borrower" satisfies UrlaStepId} className="mt-0 space-y-6">
                <PersonalInfoSection personalInfo={slice.personalInfo} onChange={setPersonalInfo} />
              </TabsContent>

              <TabsContent value={"employment" satisfies UrlaStepId} className="mt-0 space-y-6">
                <EmploymentSection
                  employmentRecords={slice.employmentRecords}
                  onChange={setEmploymentRecords}
                  otherIncomes={otherIncomes}
                  onOtherIncomesChange={setOtherIncomes}
                />
              </TabsContent>

              <TabsContent value={"assets" satisfies UrlaStepId} className="mt-0 space-y-6">
                <AssetsSection assets={slice.assets} onChange={setAssets} />
              </TabsContent>

              <TabsContent value={"liabilities" satisfies UrlaStepId} className="mt-0 space-y-6">
                <LiabilitiesSection liabilities={slice.liabilities} onChange={setLiabilities} />
              </TabsContent>

              <TabsContent value={"real-estate" satisfies UrlaStepId} className="mt-0 space-y-6">
                <RealEstateOwnedSection
                  ownsOtherRealEstate={ownsOtherRealEstate}
                  properties={realEstateOwned}
                  onOwnershipChange={setOwnsOtherRealEstate}
                  onChange={setRealEstateOwned}
                />
              </TabsContent>

              <TabsContent value={"property" satisfies UrlaStepId} className="mt-0 space-y-6">
                <PropertySection
                  propertyInfo={propertyInfo}
                  onChange={setPropertyInfo}
                  loanDetails={loanDetails}
                  onLoanDetailsChange={setLoanDetails}
                  app={app}
                />
              </TabsContent>

              <TabsContent value={"declarations" satisfies UrlaStepId} className="mt-0 space-y-6">
                <DeclarationsSection
                  declarations={slice.declarations}
                  onChange={setDeclarations}
                  activeSeq={activeSeq}
                />
              </TabsContent>

              <TabsContent value={"demographics" satisfies UrlaStepId} className="mt-0 space-y-6">
                <DemographicsSection
                  demographics={slice.demographics}
                  onChange={setDemographics}
                  activeSeq={activeSeq}
                />
              </TabsContent>

              <div className="mt-8 flex flex-col-reverse gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
                <Button
                  variant="ghost"
                  className="gap-2"
                  onClick={handleBack}
                  disabled={stepIndex === 0}
                  data-testid="button-urla-back"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </Button>
                <Button
                  className="gap-2"
                  onClick={handleContinue}
                  disabled={saveMutation.isPending}
                  data-testid={isLastStep ? "button-save-urla" : "button-urla-continue"}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isLastStep ? (
                    <Save className="h-4 w-4" />
                  ) : null}
                  {isLastStep ? "Save application" : "Save & continue"}
                  {!isLastStep && <ChevronRight className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>
        </Tabs>
    </PageShell>
  );
}
