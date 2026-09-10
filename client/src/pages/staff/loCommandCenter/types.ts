export type HealthLight = "green" | "yellow" | "red";

export interface FileHealth {
  light: HealthLight;
  reasons: string[];
}

// Mirrors server/pipelineEngine.ts PipelineSummary (Dates arrive as ISO strings).
export interface PipelineSummary {
  applicationId: string;
  borrowerName: string;
  currentStage: string;
  daysInPipeline: number;
  conditionsOutstanding: number;
  conditionsTotal: number;
  nextAction: string;
  priority: "normal" | "high" | "urgent";
  daysIdle: number | null;
  fileHealth: FileHealth;
}

export interface QueueData {
  total: number;
  queue: PipelineSummary[];
}

// Mirrors server/services/signalEngine.ts StaffSignal.
export interface StaffSignal {
  type: "preuw_flag" | "conditions_review" | "stalled" | "docs_expiring" | "investor_candidate";
  priority: 1 | 2 | 3 | 4;
  applicationId: string | null;
  userId?: string;
  borrowerName: string;
  title: string;
  detail: string;
}

export interface IncomePath {
  pathId: string;
  role: "component" | "alternative";
  status: "applicable" | "not_indicated" | "unavailable";
  kind: "dti_income" | "coverage_ratio";
  monthlyQualifyingIncome?: number;
  appliedToDti?: boolean;
  /** What the path contributed to primaryMonthlyQualifyingIncome (rental
   *  differs from its net; absent on evaluations predating the split). */
  appliedMonthlyIncome?: number;
  /** What it contributed to monthly obligations instead (rental losses). */
  appliedMonthlyObligation?: number;
  coverageRatio?: number | null;
  requiresManualReview: boolean;
}

// Mirrors GET /api/staff/applications/:id/cockpit.
export interface CockpitData {
  application: {
    id: string;
    borrowerUserId: string;
    borrowerName: string;
    status: string;
    loanPurpose: string | null;
    purchasePrice: string | null;
    downPayment: string | null;
    propertyState: string | null;
    propertyType: string | null;
    financialDataProvenance: string | null;
    currentDecisionGrade: boolean;
    decisionGradeBlockers: string[];
    isVeteran: boolean;
    closingDate: string | null;
    createdAt: string | null;
  };
  income: {
    primaryMonthlyQualifyingIncome: number;
    incomeBasis: string;
    recommendedPathId: string | null;
    requiresManualReview: boolean;
    evaluatedAt: string | null;
    paths: IncomePath[];
  } | null;
  conditions: {
    total: number;
    open: number;
    items: { id: string; title: string; category: string; status: string; priority: string }[];
  };
  documents: {
    uploadedCount: number;
    verifiedCount: number;
    byType: { type: string; status: string; fileName: string }[];
  };
  messages: {
    unreadFromBorrower: number;
    recent: { id: string; fromBorrower: boolean; snippet: string; createdAt: string | null }[];
  };
  activity: {
    totalPageViews: number;
    propertySearches: number;
    calculatorUses: number;
    propertyViews: number;
  };
}

export const HEALTH_ORDER: Record<HealthLight, number> = { red: 0, yellow: 1, green: 2 };
export const HEALTH_META: Record<HealthLight, { label: string; dotClass: string }> = {
  red: { label: "Stalled", dotClass: "bg-destructive" },
  yellow: { label: "Watch", dotClass: "bg-warning" },
  green: { label: "On track", dotClass: "bg-success" },
};

export const SIGNAL_META: Record<
  StaffSignal["priority"],
  { label: string; badge: "destructive" | "warning" | "info" | "secondary" }
> = {
  1: { label: "Act now", badge: "destructive" },
  2: { label: "Review", badge: "warning" },
  3: { label: "Rescue", badge: "info" },
  4: { label: "Freshness", badge: "secondary" },
};

export function prettyPathId(pathId: string): string {
  return pathId
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Dscr/i, "DSCR")
    .replace(/\bSe\b/i, "Self-Employment");
}
