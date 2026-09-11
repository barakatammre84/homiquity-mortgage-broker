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

/** A borrower can acknowledge anti-steering only after at least one option has
 * actually been presented. Rendering the disclosure on a zero-option review
 * plan asks them to attest to an event that did not happen. */
export function shouldShowAntiSteeringConsent(
  generatedOptionCount: number,
  marketStatus?: string,
  marketOfferCount = 0,
): boolean {
  return generatedOptionCount > 0 || (marketStatus === "PRICED" && marketOfferCount > 0);
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

  if (!hasOptions && isIntakeStillFinalizing(status)) {
    return {
      kind: "estimate",
      badge: "Application saved",
      title: "We're building your estimated options",
      description: "We're checking the answers you provided and preparing your personalized next steps.",
    };
  }

  if (!hasOptions) {
    return {
      kind: "estimate",
      badge: "Next: verify your file",
      title: "Your personalized review plan is ready",
      description:
        "Your answers need document verification before we can show reliable loan scenarios. Complete the steps below and your loan team will review the verified figures.",
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
