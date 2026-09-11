import type { ChecklistItemView } from "@/lib/documentChecklist";
import {
  CheckCircle2,
  Clock,
  CreditCard,
  DollarSign,
  FileText,
  Home,
  Landmark,
  Medal,
  PiggyBank,
  Shield,
  Sparkles,
  Target,
  TrendingUp,
  Briefcase,
} from "lucide-react";

// Shared client-side types + catalogs for the Homi surface
// (client/src/components/coach/*). Server contracts: server/routes/coach.ts
// (REST + SSE) and server/services/coachTools.ts (event payloads).

export interface StructuredData {
  borrowerPackage?: Record<string, unknown>;
}

export interface CoachMessage {
  id: string;
  role: string;
  content: string;
  structuredData?: StructuredData;
  createdAt: string;
}

export interface CoachConversation {
  id: string;
  title: string;
  readinessTier: string | null;
  completionPercentage: number | null;
  financialProfile: CoachProfile | null;
  actionPlan: ActionPlanItem[] | null;
  documentChecklist: DocumentRequirement[] | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The readiness profile as it ACTUALLY arrives, which is not always complete.
 *
 * Everything except `completionPercentage` is optional on purpose. The column is
 * written from two places: a full `set_readiness` tool result, and (historically)
 * a bare server-derived percentage — which left rows holding literally
 * `{"completionPercentage": 88}`. This interface used to declare all six fields
 * required, so `ReadinessPanel` read `completedInputs.length` off `undefined` and
 * crashed the whole coach page. The server no longer writes that shape, but rows
 * in it already exist, so the type tells the truth and consumers default.
 */
export interface CoachProfile {
  completionPercentage: number;
  readinessTier?: string;
  statusNote?: string;
  completedInputs?: string[];
  outstandingInputs?: string[];
  estimatedTimeline?: string;
}

export interface ActionPlanItem {
  id: string;
  phase: number;
  title: string;
  description: string;
  priority: string;
  category: string;
  completed: boolean;
}

export interface DocumentRequirement {
  docType: string;
  label: string;
  reason: string;
  priority: string;
  category: string;
  /** True when the item can be satisfied by connecting an account via Plaid — the panel shows a "Connect with Plaid" CTA. */
  plaidEligible?: boolean;
}

export interface CoachInsight {
  type: string;
  title: string;
  description: string;
  action?: string;
}

export interface CoachUsage {
  todayCount: number;
  dailyLimit: number;
  remaining: number;
  isLimited: boolean;
}

export interface CoachIntake {
  annualIncome?: string;
  monthlyDebts?: string;
  creditScore?: string;
  employmentType?: string;
  employmentYears?: string;
  downPayment?: string;
  purchasePrice?: string;
  propertyType?: string;
  loanPurpose?: string;
  isVeteran?: boolean;
  isFirstTimeBuyer?: boolean;
}

// --- SSE turn events (mirrors server/routes/coach.ts protocol) --------------

export interface CapturedField {
  field: string;
  value: string | number | boolean;
}

export interface SkippedField {
  field: string;
  reason: string;
}

export interface CapturedEvent {
  applicationId: string | null;
  created: boolean;
  applied: CapturedField[];
  skipped: SkippedField[];
  /** Client receive time — drives the "saved just now" flash. */
  at: number;
}

export interface CoachPanelState {
  profile?: CoachProfile;
  actionPlan?: ActionPlanItem[];
  /**
   * The borrower's REAL checklist, as served by /document-checklist — no longer
   * a model-authored DocumentRequirement[]. The old shape carried an invented
   * `docType` that matched no loan_condition, so uploading against it cleared
   * nothing while the panel said otherwise.
   */
  documentChecklist?: ChecklistItemView[];
  checklistStats?: { total: number; verified: number; uploaded: number; needed: number; rejected: number };
  loanStatus?: LoanStatusView;
  tasks?: BorrowerTaskLike[];
  borrowerPackage?: Record<string, unknown>;
  documentEvidence?: CoachDocumentEvidenceView;
  suggestions?: string[];
  /** Whether the last panel payload was file-derived or assistant-authored. */
  source?: "file" | "assistant";
}

export interface CoachDocumentEvidenceFactView {
  label: string;
  value: number;
  format: "currency" | "number";
  reviewStatus: "machine_read" | "human_verified";
  confidence: "high" | "medium" | "low" | "not_applicable";
  needsHumanReview: boolean;
  pageNumber: number | null;
}

export interface CoachDocumentEvidenceItemView {
  documentId: string;
  documentType: string;
  label: string;
  documentReviewStatus: "uploaded" | "in_review" | "accepted";
  evidenceStatus: "not_extracted" | "machine_read" | "partly_human_verified" | "human_verified";
  facts: CoachDocumentEvidenceFactView[];
  omittedFactCount: number;
}

export interface CoachDocumentEvidenceView {
  documents: CoachDocumentEvidenceItemView[];
  summary: {
    documentCount: number;
    extractedFactCount: number;
    humanVerifiedFactCount: number;
    factsNeedingHumanReview: number;
    omittedDocumentCount: number;
  };
  financialReview: {
    status: "approved_for_lender_package" | "not_approved";
    income: "approved" | "not_approved";
    assets: "approved" | "not_approved";
    liabilities: "approved" | "not_approved" | "not_required";
  };
}

/** Borrower-safe stage snapshot (server whitelist — see coachFileTruth.ts). */
export interface LoanStatusView {
  hasApplication: boolean;
  stage: {
    status: string;
    label: string;
    description: string;
    progressPercent: number;
    phase: string;
  } | null;
  pipeline: {
    daysInPipeline: number;
    conditionsOutstanding: number;
    conditionsTotal: number;
    percentComplete: number;
    targetCloseDate: string | null;
  } | null;
  journey: Array<{ stepId: string; lines: string[] }>;
  nextAction: {
    kind: string;
    title: string;
    description: string;
    href: string;
    buttonLabel: string;
    whyNeeded?: string;
    timeEstimate?: string;
    count?: number;
  } | null;
  lastActivityAt: string | null;
}

export interface PlanningDocumentStatsView {
  total: number;
  verified: number;
  underReview: number;
  rejected: number;
}

export type FileDocumentStatsView = PlanningDocumentStatsView;

/** The masked borrower task view; only the fields this surface renders. */
export interface BorrowerTaskLike {
  id: string;
  title?: string | null;
  borrowerDisplayText?: string | null;
  status: string;
}

export interface CoachStreamError {
  code: string;
  message: string;
  retryable: boolean;
}

export type TurnStatus = "idle" | "connecting" | "streaming" | "finalizing" | "error";

// --- Visual catalogs ---------------------------------------------------------

export const TIER_CONFIG: Record<string, { label: string; color: string; icon: typeof Target }> = {
  ready_now: { label: "Ready Now", color: "bg-success", icon: CheckCircle2 },
  almost_ready: { label: "Almost Ready", color: "bg-info", icon: TrendingUp },
  building: { label: "Building", color: "bg-warning", icon: Target },
  exploring: { label: "Exploring", color: "bg-muted", icon: Clock },
};

export const CATEGORY_ICONS: Record<string, typeof Target> = {
  credit: Shield,
  savings: TrendingUp,
  income: Target,
  debt: FileText,
  documents: FileText,
  education: Sparkles,
};

// The canonical pre-app intake fields the coach can capture — the CapturePanel
// and /profile page render this same catalog so the two surfaces always agree.
export type CaptureKind = "money" | "credit" | "enum" | "years" | "bool" | "text";

export interface CaptureFieldDef {
  key: keyof CoachIntake;
  label: string;
  kind: CaptureKind;
  icon: typeof Target;
}

export const CAPTURE_FIELDS: CaptureFieldDef[] = [
  { key: "annualIncome", label: "Annual income", kind: "money", icon: DollarSign },
  { key: "monthlyDebts", label: "Monthly debts", kind: "money", icon: CreditCard },
  { key: "creditScore", label: "Credit score", kind: "credit", icon: Shield },
  { key: "employmentType", label: "Employment", kind: "enum", icon: Briefcase },
  { key: "employmentYears", label: "Years employed", kind: "years", icon: Clock },
  { key: "downPayment", label: "Down payment", kind: "money", icon: PiggyBank },
  { key: "purchasePrice", label: "Target price", kind: "money", icon: Home },
  { key: "propertyType", label: "Property type", kind: "enum", icon: Landmark },
  { key: "loanPurpose", label: "Loan purpose", kind: "enum", icon: Target },
  { key: "isVeteran", label: "Veteran", kind: "bool", icon: Medal },
  { key: "isFirstTimeBuyer", label: "First-time buyer", kind: "bool", icon: Sparkles },
];

const CREDIT_BAND_LABELS: Record<string, string> = {
  "760": "760+",
  "720": "720–759",
  "680": "680–719",
  "640": "640–679",
  "600": "600–639",
};

export function formatCaptureValue(kind: CaptureKind, value: string | number | boolean | undefined | null): string | null {
  if (value === undefined || value === null || value === "") return null;
  switch (kind) {
    case "money": {
      const n = parseFloat(String(value).replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? `$${n.toLocaleString()}` : String(value);
    }
    case "credit": {
      const s = String(value);
      return CREDIT_BAND_LABELS[s] ?? s;
    }
    case "enum":
      return String(value)
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    case "years":
      return `${value} yr${String(value) === "1" ? "" : "s"}`;
    case "bool":
      return value === true ? "Yes" : value === false ? "No" : null;
    case "text":
      return String(value);
  }
}

export const SKIP_REASON_LABELS: Record<string, string> = {
  unchanged: "already saved",
  invalid_value: "couldn't be read as a valid value",
  unmappable_credit_band: "outside the supported score ranges",
  application_submitted: "application already submitted — updates go through your loan team",
  verified_locked: "verified — can't be changed from chat",
  provenance_locked: "verified — can't be changed from chat",
  prelaunch_gated: "saving opens when applications open",
};
