// Loan-application status machine — the canonical vocabulary, the legal
// transitions, and the selectors built on them.
//
// WHY THIS IS NOT IN shared/schema/lendingCore.ts ANY MORE
//
// It is imported by the CLIENT (useActiveApplication, LoanPipeline,
// ActiveBorrowerPane, BorrowerFile, …) as runtime values, not types. While it
// sat beside `pgTable("loan_applications", …)`, importing `isTerminalLoanAppStatus`
// pulled the whole schema barrel into the browser bundle: 174 Drizzle table
// definitions, column names and all, shipped to every visitor of a public site.
// Drizzle's pgTable() calls are side-effecting, so tree-shaking could not drop them.
//
// This module therefore defines NO table and imports nothing. Keep it that way:
// a single `import { pgTable }` here re-opens the leak for every client file
// that imports any symbol below. tests/clientSchemaImports.test.ts is the guard.
//
// lendingCore.ts re-exports all of it, so server code and `@shared/schema`
// consumers are unchanged.
// Loan application status — the canonical vocabulary.
//
// This is the ONLY list of statuses `loanApplications.status` may hold, and
// LOAN_APP_TRANSITIONS is the ONLY definition of which moves are legal. Both
// client and server import from here; a status literal that isn't in this
// list is a bug (enforced by tests/statusVocabulary.test.ts). All status
// writes go through updatePipelineStage (server/pipelineEngine.ts), which
// rejects transitions not in this table.
// ---------------------------------------------------------------------------

export const LOAN_APP_STATUSES = [
  "draft",
  "submitted",
  "analyzing",
  // Intake automation could not auto-approve — a licensed underwriter must
  // decide (ECOA: automation never issues a denial). See finalizeIntake.
  "under_review",
  "pre_approved",
  "doc_collection",
  "processing",
  "underwriting",
  "conditional",
  "clear_to_close",
  "closing",
  "funded",
  "denied",
  "withdrawn",
  "suspended",
  "expired",
] as const;

export type LoanAppStatus = (typeof LOAN_APP_STATUSES)[number];

export const LOAN_APP_TERMINAL_STATUSES: readonly LoanAppStatus[] = [
  "funded",
  "denied",
  "withdrawn",
  "expired",
] as const;

export const LOAN_APP_TRANSITIONS: Record<LoanAppStatus, readonly LoanAppStatus[]> = {
  draft:          ["submitted", "withdrawn"],
  submitted:      ["analyzing", "suspended", "withdrawn"],
  // "submitted" allows the analysis-failure rollback (system retry path);
  // "under_review" is the intake automation's non-approval outcome.
  analyzing:      ["pre_approved", "under_review", "denied", "suspended", "withdrawn", "submitted"],
  // Awaiting a human underwriting decision — they may approve, advance, deny, or hold.
  under_review:   ["pre_approved", "doc_collection", "underwriting", "denied", "suspended", "withdrawn"],
  pre_approved:   ["doc_collection", "expired", "withdrawn", "denied"],
  doc_collection: ["processing", "suspended", "withdrawn", "denied"],
  processing:     ["underwriting", "suspended", "withdrawn", "denied"],
  underwriting:   ["conditional", "clear_to_close", "denied", "suspended", "withdrawn"],
  conditional:    ["clear_to_close", "denied", "suspended", "withdrawn"],
  clear_to_close: ["closing", "suspended", "withdrawn"],
  closing:        ["funded", "suspended", "withdrawn"],
  funded:         [],
  denied:         [],
  withdrawn:      [],
  // Suspension pauses a file; it resumes to any in-flight working stage.
  suspended:      ["doc_collection", "processing", "underwriting", "conditional", "withdrawn", "denied"],
  // An expired pre-approval can be renewed by re-submitting.
  expired:        ["submitted"],
};

export function isLoanAppStatus(value: string): value is LoanAppStatus {
  return (LOAN_APP_STATUSES as readonly string[]).includes(value);
}

export function isTerminalLoanAppStatus(value: string): boolean {
  return (LOAN_APP_TERMINAL_STATUSES as readonly string[]).includes(value);
}

/**
 * Statuses at or past pre-approval that haven't ended in denial/withdrawal —
 * "this borrower holds an approval". Used for approval-rate metrics, MISMO
 * underwriting-decision blocks, and "can this borrower make offers" checks.
 */
export const LOAN_APP_APPROVED_GRADE_STATUSES: readonly LoanAppStatus[] = [
  "pre_approved",
  "doc_collection",
  "processing",
  "underwriting",
  "conditional",
  "clear_to_close",
  "closing",
  "funded",
] as const;

export function isApprovedGradeLoanAppStatus(value: string): boolean {
  return (LOAN_APP_APPROVED_GRADE_STATUSES as readonly string[]).includes(value);
}

/**
 * In-flight = submitted into the pipeline and not yet ended: neither "draft"
 * (not submitted) nor any terminal status. "suspended" IS in-flight — a
 * suspension pauses a file, it doesn't end it. Derived from the canonical
 * list so a vocabulary change can never leave it stale.
 */
export const LOAN_APP_IN_FLIGHT_STATUSES: readonly LoanAppStatus[] = LOAN_APP_STATUSES.filter(
  (status) => status !== "draft" && !isTerminalLoanAppStatus(status),
);

export function isInFlightLoanAppStatus(value: string): boolean {
  return (LOAN_APP_IN_FLIGHT_STATUSES as readonly string[]).includes(value);
}

/**
 * THE selector for "the borrower's active application": the first in-flight
 * entry in list order (every caller passes a newest-first list, so this is
 * the most recent in-flight file). Returns undefined when nothing is
 * in-flight — surfaces that would rather show a closed file than nothing
 * compose their own fallback, e.g. `pickActiveLoanApplication(apps) ?? apps[0]`.
 *
 * Replaces the hand-rolled `status !== "draft" && status !== "denied"`
 * selectors that let withdrawn/expired/funded files pose as the active one.
 */
export function pickActiveLoanApplication<T extends { status: string }>(
  applications: readonly T[],
): T | undefined {
  return applications.find((a) => isInFlightLoanAppStatus(a.status));
}

/**
 * THE selector for "the file the borrower is currently working on" — in-flight
 * OR still a draft, but never a closed one. Borrower-facing surfaces need this
 * wider notion than `pickActiveLoanApplication`: a draft is a real file the
 * borrower can resume and attach documents to, it just hasn't been submitted.
 *
 * Callers that must distinguish the two branch on `status === "draft"` (the
 * Dashboard hides the journey tracker and predictions for drafts).
 *
 * Use this over `pickActiveLoanApplication(apps) ?? apps[0]`: the `?? apps[0]`
 * fallback silently resurrects denied/withdrawn/funded files, which is how
 * document uploads once landed on a closed loan.
 */
export function pickWorkableLoanApplication<T extends { status: string }>(
  applications: readonly T[],
): T | undefined {
  return applications.find((a) => !isTerminalLoanAppStatus(a.status));
}

/**
 * THE selector for "the approval this borrower holds" — the first
 * approved-grade file in newest-first list order. Returns undefined when none.
 *
 * Never compose `?? apps[0]` onto this: a denied/withdrawn/expired file still
 * carries annualIncome, so the fallback made `hasPreApproval` go true and showed
 * qualification math to a borrower who was denied — while hiding the
 * Get-Pre-Approved CTA they actually needed.
 */
export function pickApprovedGradeLoanApplication<T extends { status: string }>(
  applications: readonly T[],
): T | undefined {
  return applications.find((a) => isApprovedGradeLoanAppStatus(a.status));
}

/** Money columns arrive from Postgres as strings; tolerate string|number|null. */
type MoneyLike = string | number | null | undefined;

function toMoneyNumber(value: MoneyLike): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Subset of loan_applications fields the affordability surfaces read. */
export interface PreApprovalDerivationFields {
  status: string;
  annualIncome?: MoneyLike;
  preApprovalAmount?: MoneyLike;
  monthlyDebts?: MoneyLike;
  creditScore?: number | null;
}

export interface PreApprovalContext<T> {
  /** The approved-grade application, or null when none is held. */
  application: T | null;
  /** True only when an approved-grade file exists AND carries positive income. */
  hasPreApproval: boolean;
  preApprovalAmount: number;
  monthlyIncome: number;
  monthlyDebts: number;
  creditScore: number | undefined;
}

/**
 * THE derivation for the property/buyer affordability surfaces: picks the
 * approved-grade application and unpacks the numeric fields the qualification
 * math needs. Centralizes the identical `parseFloat(String(...))` block that
 * PropertyDetail and BuyerProperties each hand-rolled, so the no-fallback rule
 * above is enforced in one tested place instead of restated in two comments.
 */
export function selectPreApprovalContext<T extends PreApprovalDerivationFields>(
  applications: readonly T[] | null | undefined,
): PreApprovalContext<T> {
  const application = applications?.length
    ? pickApprovedGradeLoanApplication(applications) ?? null
    : null;
  const annualIncome = toMoneyNumber(application?.annualIncome);
  return {
    application,
    hasPreApproval: !!application && annualIncome > 0,
    preApprovalAmount: toMoneyNumber(application?.preApprovalAmount),
    monthlyIncome: annualIncome / 12,
    monthlyDebts: toMoneyNumber(application?.monthlyDebts),
    creditScore: application?.creditScore || undefined,
  };
}

export interface LoanAppStatusMeta {
  /** Short badge/label text. */
  label: string;
  /** Borrower-facing one-liner for dashboards and status screens. */
  description: string;
  /** 0–100 journey progress for progress bars. */
  progressPercent: number;
  phase: "intake" | "application" | "processing" | "closing" | "complete" | "terminal";
  /** shadcn Badge variant so every status renders the same everywhere. */
  badgeVariant: "default" | "secondary" | "outline" | "destructive";
}

/**
 * The single source of borrower-facing status semantics. Client components
 * must render from this map instead of maintaining their own status switches
 * (which is how phantom statuses like "declined"/"closed"/"under_review"
 * crept in — checks for values no backend path ever wrote).
 */
export const LOAN_APP_STATUS_META: Record<LoanAppStatus, LoanAppStatusMeta> = {
  draft:          { label: "Incomplete",     description: "Pick up where you left off.",                          progressPercent: 5,   phase: "intake",      badgeVariant: "outline" },
  submitted:      { label: "Submitted",      description: "Your application has been received.",                  progressPercent: 15,  phase: "application", badgeVariant: "outline" },
  analyzing:      { label: "Analyzing",      description: "We're checking your answers and preparing your next steps.", progressPercent: 20,  phase: "application", badgeVariant: "secondary" },
  under_review:   { label: "Under Review",   description: "Your application needs loan-team review. Complete the requested steps so the team can verify it.", progressPercent: 25,  phase: "application", badgeVariant: "secondary" },
  pre_approved:   { label: "Pre-Approved",   description: "You're pre-approved. Time to find your home.",         progressPercent: 35,  phase: "application", badgeVariant: "default" },
  doc_collection: { label: "Documents",      description: "We're collecting your documents.",                     progressPercent: 45,  phase: "processing",  badgeVariant: "secondary" },
  processing:     { label: "Processing",     description: "Your file is being processed.",                        progressPercent: 55,  phase: "processing",  badgeVariant: "secondary" },
  underwriting:   { label: "Underwriting",   description: "Your file is with underwriting.",                      progressPercent: 65,  phase: "processing",  badgeVariant: "secondary" },
  conditional:    { label: "Conditional",    description: "Almost there — a few conditions left to clear.",       progressPercent: 80,  phase: "processing",  badgeVariant: "secondary" },
  clear_to_close: { label: "Clear to Close", description: "You're clear to close.",                               progressPercent: 90,  phase: "closing",     badgeVariant: "default" },
  closing:        { label: "Closing",        description: "Closing is being scheduled.",                          progressPercent: 95,  phase: "closing",     badgeVariant: "default" },
  funded:         { label: "Funded",         description: "Congratulations — your loan is funded!",               progressPercent: 100, phase: "complete",    badgeVariant: "default" },
  denied:         { label: "Denied",         description: "Let's look at your options and find a path forward.",  progressPercent: 0,   phase: "terminal",    badgeVariant: "destructive" },
  withdrawn:      { label: "Withdrawn",      description: "This application was withdrawn.",                      progressPercent: 0,   phase: "terminal",    badgeVariant: "destructive" },
  suspended:      { label: "On Hold",        description: "Your application is temporarily on hold.",             progressPercent: 0,   phase: "terminal",    badgeVariant: "secondary" },
  expired:        { label: "Expired",        description: "Your pre-approval expired — renew to keep shopping.",  progressPercent: 0,   phase: "terminal",    badgeVariant: "destructive" },
};

/** Meta lookup that tolerates legacy/unknown strings (pre-migration rows). */
export function getLoanAppStatusMeta(status: string): LoanAppStatusMeta {
  if (isLoanAppStatus(status)) return LOAN_APP_STATUS_META[status];
  return { label: "In Progress", description: "Here's where things stand with your mortgage.", progressPercent: 0, phase: "application", badgeVariant: "outline" };
}

export function isValidLoanAppTransition(from: LoanAppStatus, to: LoanAppStatus): boolean {
  return LOAN_APP_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Statuses staff may set directly via PATCH /api/loan-applications/:id/status:
 * the canonical vocabulary minus system-only states — "draft" belongs to the
 * borrower funnel, "analyzing"/"expired" are written by automation. The route's
 * Zod schema and every staff status picker derive from this one list; a
 * hand-listed picker is how phantom statuses ("in_review",
 * "conditional_approval", "approved") survived the vocabulary sweeps.
 */
export const STAFF_SETTABLE_STATUSES = LOAN_APP_STATUSES.filter(
  (status) => status !== "draft" && status !== "analyzing" && status !== "expired",
) as [LoanAppStatus, ...LoanAppStatus[]];

/**
 * Final credit decisions and the roles allowed to set them on the staff status
 * route. Every other role must go through the guarded advance-stage endpoint
 * (STAGE_TRANSITION_ROLES policy in server/routes/underwriting/). The two
 * halves of the policy live together so client pickers gate exactly the
 * statuses the server 403s.
 */
export const PROTECTED_CREDIT_DECISION_STATUSES: readonly LoanAppStatus[] = [
  "pre_approved",
  "clear_to_close",
  "funded",
  "denied",
] as const;

export const CREDIT_DECISION_ROLES: readonly string[] = ["admin", "underwriter"] as const;

/**
 * Staff roles permitted to mark a borrower's financials verified — the gate that
 * lets a file proceed to approval and pre-approval-letter generation.
 *
 * Read by BOTH the requireRole list on POST /api/loan-applications/:id/verify-financials
 * and the "Mark Financials Verified" button in BorrowerFile, so the client can never
 * offer an action the server will reject. `closer` is deliberately excluded (a
 * closing-stage role, not a document reviewer), as are the external partner roles
 * (broker, lender), which never review borrower documentation.
 */
export const FINANCIAL_VERIFICATION_ROLES: readonly string[] = [
  "admin",
  "lo",
  "loa",
  "processor",
  "underwriter",
] as const;

export function isProtectedCreditDecisionStatus(value: string): boolean {
  return (PROTECTED_CREDIT_DECISION_STATUSES as readonly string[]).includes(value);
}

/**
 * Favorable credit determinations — these may not rest on self-reported
 * figures. The status route rejects them (422) via assertVerifiedForDecisioning
 * (shared/dataProvenance.ts) unless financialDataProvenance is "verified".
 * Denial is deliberately absent: a file can be denied for unverifiable or
 * incomplete information.
 */
export const APPROVAL_OUTCOME_STATUSES: readonly LoanAppStatus[] = [
  "pre_approved",
  "clear_to_close",
  "funded",
] as const;

export function isApprovalOutcomeStatus(value: string): boolean {
  return (APPROVAL_OUTCOME_STATUSES as readonly string[]).includes(value);
}
