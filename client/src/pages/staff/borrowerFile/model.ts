// Borrower-file data model: the response shapes the staff file view consumes
// plus the HMDA (Reg C) denial-reason catalog — the client-side pair of
// HMDA_TO_ADVERSE_ACTION_REASON in server/services/creditAdverseActions.ts.
// Extracted verbatim from BorrowerFile.tsx.
import type { LoanApplication, Document, LoanCondition, UrlaPersonalInfo } from "@shared/schema";

export interface ActivityItem {
  id?: string;
  activityType: string;
  title: string;
  description?: string;
  createdAt: string;
}

export interface LoanOption {
  id: string;
  loanType: string;
  interestRate: string;
  term: number;
  monthlyPayment: string;
}

export interface ApplicationData {
  application: LoanApplication;
  currentDecisionGrade: boolean;
  currentVerification: { income: boolean; assets: boolean; credit: boolean };
  decisionGradeBlockers: string[];
  options: LoanOption[];
  documents: Document[];
  activities: ActivityItem[];
}

export interface PersonalInfoData {
  personalInfo: UrlaPersonalInfo | null;
}

export interface PipelineData {
  progress: {
    currentStage: string;
    conditions: {
      total: number;
      outstanding: number;
      cleared: number;
      categories: Record<string, { total: number; cleared: number }>;
    };
    readyForNextStage: boolean;
    blockers: string[];
  };
  summary: Record<string, unknown> | null;
  milestones: Record<string, Date | null>;
  conditions: LoanCondition[];
}

export interface CreditSummary {
  hasActiveConsent: boolean;
  consent: {
    id: string;
    consentTimestamp: string;
    borrowerFullName: string;
    disclosureVersion: string;
    /**
     * What the borrower authorized — "soft_pull" or "hard_pull". Surfaced so
     * staff can see the SCOPE of a consent, not just that one exists: a
     * soft-scoped consent used to look identical to a hard one on this card
     * while silently unblocking a hard tri-merge pull (F-035).
     */
    consentType: string;
  } | null;
  latestPull: {
    id: string;
    status: string;
    pullType: string;
    bureaus: string[];
    representativeScore: number | null;
    experianScore: number | null;
    equifaxScore: number | null;
    transunionScore: number | null;
    totalTradelines: number | null;
    openTradelines: number | null;
    derogatoryCount: number | null;
    totalDebt: string | null;
    monthlyPayments: string | null;
    completedAt: string | null;
    expiresAt: string | null;
    isSimulated?: boolean;
  } | null;
  pullCount: number;
  adverseActionCount: number;
  latestAdverseAction: {
    id: string;
    actionType: string;
    primaryReason: string;
    noticeDate: string;
    deliveredAt: string | null;
    deliveryMethod: string | null;
  } | null;
}

export interface CreditAuditEntry {
  id: string;
  action: string;
  actionDetails: Record<string, any> | null;
  timestamp: string;
  performedBy: string | null;
}

// Standard HMDA (Reg C) denial reasons. At least 2 must be selected when an
// application is denied so the Loan Application Register can be reported.
export const HMDA_DENIAL_REASONS = [
  "Debt-to-income ratio",
  "Employment history",
  "Credit history",
  "Collateral",
  "Insufficient cash (downpayment, closing costs)",
  "Unverifiable information",
  "Credit application incomplete",
  "Mortgage insurance denied",
  "Other",
];
