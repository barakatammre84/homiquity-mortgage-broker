import type { LoanApplication, DealActivity, LoanAppStatus } from "@shared/schema";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Clock,
  FileText,
  Home,
  MessageCircle,
  Sparkles,
} from "lucide-react";

// Pure model for the borrower Dashboard (extracted from Dashboard.tsx):
// server-shaped payload types, the next-action icon map, and the derivation
// helpers (readiness score, greeting, pre-approval expiration, activity time).
// Everything here is deterministic and unit-tested.

/** Server-computed next action (see server/services/nextAction.ts). */
export interface NextActionData {
  kind:
    | "start_application" | "resume_draft" | "renew_preapproval" | "read_messages"
    | "strengthen_file" | "upload_documents" | "complete_tasks" | "clear_conditions"
    | "browse_homes" | "contact_team" | "talk_to_coach" | "homeowner_hub" | "in_review";
  title: string;
  description: string;
  href: string;
  buttonLabel: string;
  whyNeeded?: string;
  timeEstimate?: string;
  count?: number;
  urgency?: "normal" | "urgent" | "expired";
}

export interface DashboardData {
  applications: LoanApplication[];
  stats: {
    totalApplications: number;
    preApprovedAmount: string;
    pendingDocuments: number;
  };
  activities: DealActivity[];
  unreadMessages: number;
  pendingTaskCount: number;
  pendingTasksByApplication?: Record<string, { total: number; documents: number }>;
  loanOptionCounts?: Record<string, number>;
  hmdaStatus?: Record<string, boolean>;
  recentOptions?: Array<{ id: string; applicationId: string; interestRate: string; loanType: string; loanTerm: number; monthlyPayment: string; isRecommended: boolean | null; lockedAt: string | null }>;
  verificationStatus?: Record<string, { hasCreditConsent: boolean; hasIdVerification: boolean; hasBankConnected: boolean; hasRateLocked: boolean }>;
  activitySummary?: { totalPageViews: number; propertySearches: number; calculatorUses: number; coachChats: number; propertyViews: number };
  nextAction?: NextActionData;
}

/** Icon per next-action kind — the only presentation decision left client-side. */
export const NEXT_ACTION_ICONS: Record<NextActionData["kind"], React.ElementType> = {
  start_application: Sparkles,
  resume_draft: FileText,
  renew_preapproval: AlertTriangle,
  read_messages: MessageCircle,
  strengthen_file: AlertTriangle,
  upload_documents: FileText,
  complete_tasks: FileText,
  clear_conditions: AlertCircle,
  browse_homes: Home,
  contact_team: Sparkles,
  talk_to_coach: Bot,
  homeowner_hub: Home,
  in_review: Clock,
};

/** Shape of loan_applications.pre_uw_flags (written by the pre-underwriting validator). */
export interface PreUwFlagsPayload {
  flags?: Array<{ code: string; severity: string; reason: string }>;
  evaluatedAt?: string;
}

/**
 * The Incubator (RenterHome) is the home surface not only for brand-new users
 * but for any borrower with no workable file — every application ended in a
 * terminal, non-funded status (denied/withdrawn/expired). ECOA's adverse-action
 * notice owns the decision disclosure; the home surface's job is the path
 * forward (readiness, goals, gap calculator), not a re-apply pitch.
 * A deep-linked terminal file (?app=<id>) resolves an activeApplication, so
 * closed-file views stay reachable; a funded loan always keeps the Dashboard.
 */
export function showIncubatorHome(
  applications: ReadonlyArray<{ status: string }>,
  activeApplication: { status: string } | null | undefined,
): boolean {
  return !activeApplication && !applications.some((a) => a.status === "funded");
}

export function getPreUwFlags(application: LoanApplication | null | undefined): PreUwFlagsPayload | null {
  if (!application) return null;
  const raw = (application as { preUwFlags?: unknown }).preUwFlags;
  if (!raw || typeof raw !== "object") return null;
  return raw as PreUwFlagsPayload;
}

export function getExpirationInfo(application: LoanApplication, decisionGrade: boolean): { label: string; daysLeft: number; urgency: "expired" | "urgent" | "normal" } | null {
  if (application.status !== "pre_approved") return null;
  if (!decisionGrade) return null;
  if (!application.createdAt) return null;
  const createdDate = new Date(application.createdAt);
  if (isNaN(createdDate.getTime())) return null;
  const expirationDate = new Date(createdDate);
  expirationDate.setDate(expirationDate.getDate() + 30);
  const now = new Date();
  const daysLeft = Math.ceil((expirationDate.getTime() - now.getTime()) / 86400000);
  const label = expirationDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const urgency = daysLeft <= 0 ? "expired" : daysLeft <= 7 ? "urgent" : "normal";
  return { label, daysLeft, urgency };
}

export function formatActivityTime(timestamp: string | Date): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function getReadinessPercent(
  application: LoanApplication | null,
  pendingDocs: number,
  pendingTasks: number,
  verificationStatus?: { hasCreditConsent: boolean; hasIdVerification: boolean; hasBankConnected: boolean; hasRateLocked: boolean },
  hasCoachSession?: boolean,
  hasBrowsedProperties?: boolean,
  decisionGrade = false,
): number {
  if (!application) {
    let score = 10;
    if (hasCoachSession) score += 15;
    if (hasBrowsedProperties) score += 10;
    return score;
  }
  const status = application.status;
  // Full Record over the canonical vocabulary — a new status cannot compile
  // without an explicit weight decision here.
  const statusWeights: Record<LoanAppStatus, number> = {
    draft: 20,
    submitted: 35,
    analyzing: 40,
    under_review: 45,
    pre_approved: 60,
    doc_collection: 55,
    processing: 65,
    underwriting: 75,
    conditional: 85,
    clear_to_close: 95,
    closing: 98,
    funded: 100,
    denied: 10,
    withdrawn: 10,
    expired: 15,
    suspended: 25,
  };
  let base = statusWeights[status as LoanAppStatus] || 30;
  if (status === "pre_approved" && !decisionGrade) {
    base = statusWeights.under_review;
  }
  if (verificationStatus) {
    if (verificationStatus.hasCreditConsent) base += 3;
    if (verificationStatus.hasIdVerification) base += 3;
    if (verificationStatus.hasBankConnected) base += 3;
    if (verificationStatus.hasRateLocked) base += 3;
  }
  if (pendingDocs === 0 && base >= 50) base += 5;
  if (pendingTasks === 0 && base >= 50) base += 5;
  return Math.min(base, 100);
}

export function getPersonalizedGreeting(user: { firstName?: string | null } | null | undefined, application: LoanApplication | null, decisionGrade = false): { title: string; subtitle: string } {
  const name = user?.firstName || "";
  const greeting = name ? `Hi, ${name}` : "Welcome back";

  if (!application) {
    return { title: greeting, subtitle: "Here's where you stand on your mortgage journey." };
  }

  switch (application.status) {
    case "draft":
      return { title: greeting, subtitle: "You have an unfinished application. Pick up where you left off." };
    case "submitted":
    case "analyzing":
      return { title: greeting, subtitle: "Your application is being reviewed. We'll have an answer shortly." };
    case "pre_approved":
      return decisionGrade
        ? { title: greeting, subtitle: "You're pre-approved. Time to find your home." }
        : { title: greeting, subtitle: "Your initial review is ready. Complete verification to confirm your borrowing range." };
    case "doc_collection":
    case "processing":
      return { title: greeting, subtitle: "We're processing your documents. Upload anything still needed." };
    case "underwriting":
      return { title: greeting, subtitle: "Your file is with underwriting. We'll keep you posted." };
    case "conditional":
      return { title: greeting, subtitle: "Almost there. A few conditions left to clear." };
    case "clear_to_close":
    case "closing":
      return { title: greeting, subtitle: "You're clear to close. The finish line is in sight." };
    case "denied":
      return { title: greeting, subtitle: "Let's look at your options and find a path forward." };
    case "funded":
      return { title: greeting, subtitle: "Congratulations on closing! Your Homeowner Hub is tracking your equity." };
    case "suspended":
      return { title: greeting, subtitle: "Your application is on hold. Your loan team will be in touch." };
    case "expired":
      return { title: greeting, subtitle: "Your pre-approval expired. Renew it to keep shopping with confidence." };
    default:
      return { title: greeting, subtitle: "Here's where things stand with your mortgage." };
  }
}

export interface BorrowerGraphData {
  activeApplicationId: string | null;
  financialVerification: {
    income: boolean;
    assets: boolean;
    credit: boolean;
    decisionGrade: boolean;
  };
  bestAnnualIncome: number | null;
  bestIncomeSource: string | null;
  totalVerifiedAssets: number | null;
  totalMonthlyDebts: number | null;
  documentsUploaded: number;
  documentsVerified: number;
  documentsMissing: string[];
  readiness: {
    completionPercentage: number;
    tier: string;
    completedInputs: string[];
    outstandingInputs: string[];
  };
  eligibility: {
    estimatedDTI: number | null;
    estimatedLTV: number | null;
    creditTier: string;
    creditScore: number | null;
    employmentStable: boolean | null;
    hasAdequateSavings: boolean | null;
    estimatedMaxPurchase: number | null;
    eligibleLoanTypes: string[];
  };
  predictiveSignals: {
    engagementLevel: string;
    suggestedNextAction: string;
  };
}
