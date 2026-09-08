import { isApprovedGradeLoanAppStatus } from "@shared/loanApplicationStatus";

export interface LoanOptionsPresentationInput {
  status: string;
  financialsVerified: boolean;
  hasOptions: boolean;
}

export interface LoanOptionsPresentation {
  kind: "estimate" | "preapproved";
  badge: string;
  title: string;
  description: string;
}

/** Intake writes rate scenarios before it finishes the document plan. Keep the
 * results page in its short refresh loop until the application status confirms
 * that both halves are ready. */
export function isIntakeStillFinalizing(status: string): boolean {
  return status === "submitted" || status === "analyzing";
}

/**
 * Submission alone does not mean a lender has received or reviewed the file.
 * Until the inputs are verified, every scenario is described as an estimate
 * and the copy points to the evidence needed to advance it.
 */
export function getLoanOptionsPresentation({
  status,
  financialsVerified,
  hasOptions,
}: LoanOptionsPresentationInput): LoanOptionsPresentation {
  if (financialsVerified && isApprovedGradeLoanAppStatus(status)) {
    return {
      kind: "preapproved",
      badge: "Pre-Approved",
      title: "Congratulations! You're pre-approved for",
      description: "Compare your loan options below and choose the next step that works for you.",
    };
  }

  if (!hasOptions) {
    return {
      kind: "estimate",
      badge: "Application saved",
      title: "We're building your estimated options",
      description: "We're checking the answers you provided and preparing your personalized next steps.",
    };
  }

  return {
    kind: "estimate",
    badge: "Based on your answers",
    title: "Your estimated loan options are ready",
    description:
      "Complete the steps below so your loan team can verify your information before any lender review. These scenarios are estimates, not offers.",
  };
}
