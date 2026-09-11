import type { LoanApplication } from "@shared/schema";
import { getLoanAppStatusMeta } from "@shared/schema";

/**
 * The borrower's single "what should I do next" — computed ONCE, server-side,
 * from data the server already holds. Before this, four independent copies of
 * the stage→action mapping lived in Dashboard.tsx (twice), borrowerGraph.ts,
 * and borrowerStateMachine.ts, and had already drifted apart. The client
 * renders `kind` (icon choice) and the strings; it decides nothing.
 *
 * Returned as `nextAction` on GET /api/dashboard.
 */

export interface NextAction {
  kind:
    | "start_application"
    | "resume_draft"
    | "renew_preapproval"
    | "read_messages"
    | "strengthen_file"
    | "upload_documents"
    | "complete_tasks"
    | "clear_conditions"
    | "browse_homes"
    | "contact_team"
    | "talk_to_coach"
    | "homeowner_hub"
    | "in_review";
  title: string;
  description: string;
  href: string;
  buttonLabel: string;
  whyNeeded?: string;
  timeEstimate?: string;
  count?: number;
  urgency?: "normal" | "urgent" | "expired";
}

export interface ExpirationInfo {
  label: string;
  daysLeft: number;
  urgency: "expired" | "urgent" | "normal";
}

const PRE_APPROVAL_VALIDITY_DAYS = 30;

/** Pre-approval shelf life (30 days from issuance). */
export function computeExpirationInfo(application: LoanApplication): ExpirationInfo | null {
  if (application.status !== "pre_approved") return null;
  if (!application.createdAt) return null;
  const createdDate = new Date(application.createdAt);
  if (isNaN(createdDate.getTime())) return null;
  const expirationDate = new Date(createdDate);
  expirationDate.setDate(expirationDate.getDate() + PRE_APPROVAL_VALIDITY_DAYS);
  const daysLeft = Math.ceil((expirationDate.getTime() - Date.now()) / 86400000);
  const label = expirationDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const urgency = daysLeft <= 0 ? "expired" : daysLeft <= 7 ? "urgent" : "normal";
  return { label, daysLeft, urgency };
}

interface PreUwFlagsPayload {
  flags?: Array<{ reason: string }>;
  evaluatedAt?: string;
}

function getPreUwFlags(application: LoanApplication | null): PreUwFlagsPayload | null {
  if (!application) return null;
  const raw = (application as { preUwFlags?: unknown }).preUwFlags;
  if (!raw || typeof raw !== "object") return null;
  return raw as PreUwFlagsPayload;
}

function needsSelfEmployedWorksheet(application: LoanApplication): boolean {
  if (application.employmentType !== "self_employed") return false;
  const analysis = application.aiAnalysis as { concerns?: unknown } | null;
  return (
    Array.isArray(analysis?.concerns) &&
    analysis.concerns.some(
      (concern) =>
        typeof concern === "string" &&
        /self-employment details|income worksheet/i.test(concern),
    )
  );
}

export interface NextActionInput {
  application: LoanApplication | null;
  pendingTasks: { total: number; documents: number };
  pendingDocuments: number;
  unreadMessages: number;
  activitySummary: { propertySearches: number; calculatorUses: number } | null;
}

export function computeNextAction(input: NextActionInput): NextAction {
  const { application, pendingTasks, pendingDocuments, unreadMessages, activitySummary } = input;

  if (!application) {
    if (activitySummary && activitySummary.propertySearches > 0) {
      return {
        kind: "start_application",
        title: "Get pre-approved to make offers",
        description: "You've been browsing homes. A pre-approval letter shows sellers you're serious.",
        href: "/apply",
        buttonLabel: "Start Now",
      };
    }
    if (activitySummary && activitySummary.calculatorUses > 0) {
      return {
        kind: "start_application",
        title: "See what you qualify for",
        description: "You've run the numbers. Now find out your actual pre-approval amount.",
        href: "/apply",
        buttonLabel: "Start Now",
      };
    }
    return {
      kind: "start_application",
      title: "Start your pre-approval",
      description: "Takes about 3 minutes. No hard credit check.",
      href: "/apply",
      buttonLabel: "Get Started",
    };
  }

  const status = application.status;
  const expiration = computeExpirationInfo(application);

  if (expiration?.urgency === "expired" || status === "expired") {
    return {
      kind: "renew_preapproval",
      title: "Renew your pre-approval",
      description: "Your pre-approval has expired. Renew it to keep shopping with confidence.",
      href: "/apply",
      buttonLabel: "Renew Now",
      urgency: "expired",
    };
  }

  if (status === "draft") {
    return {
      kind: "resume_draft",
      title: "Complete your application",
      description: "Pick up right where you left off. It only takes a few minutes.",
      href: "/apply",
      buttonLabel: "Continue",
      timeEstimate: "about 3 minutes",
    };
  }

  if (unreadMessages > 0) {
    return {
      kind: "read_messages",
      title: `You have ${unreadMessages} new message${unreadMessages > 1 ? "s" : ""}`,
      description: "Your loan team sent you a message. Respond to keep things moving.",
      href: "/messages",
      buttonLabel: "View Messages",
      count: unreadMessages,
    };
  }

  // A document cannot replace the business-by-business URLA worksheet. Put
  // the exact blocking form ahead of the generic document flag so a complex
  // borrower does not upload files and then discover their application itself
  // was still incomplete.
  if (needsSelfEmployedWorksheet(application)) {
    return {
      kind: "strengthen_file",
      title: "Complete your self-employed income details",
      description:
        "Review each business or 1099 source and complete its income worksheet so we can calculate qualifying income without asking you to repeat the intake.",
      href: "/urla-form",
      buttonLabel: "Continue Application",
      whyNeeded:
        "Mortgage guidelines calculate qualifying self-employed income from business details and supporting records, not the rough annual estimate alone.",
      timeEstimate: "about 5 minutes",
    };
  }

  // Pre-underwriting flags outrank generic tasks — they name the exact
  // documents underwriting is waiting on.
  const preUw = getPreUwFlags(application);
  if (preUw?.flags && preUw.flags.length > 0) {
    return {
      kind: "strengthen_file",
      title: "Strengthen your file",
      description: preUw.flags[0].reason,
      href: "/documents",
      buttonLabel: "Add Documents",
      whyNeeded: "Clearing these flags keeps your approval on track — your file re-checks automatically when documents arrive.",
      timeEstimate: "a few minutes",
      count: preUw.flags.length,
    };
  }

  // Document requests grouped into ONE milestone action, not N task rows.
  if (pendingTasks.documents > 0) {
    return {
      kind: "upload_documents",
      title: `Upload your documents — ${pendingTasks.documents} needed`,
      description: "Everything on the list unlocks your next stage. Upload what you have; each document checks itself off.",
      href: "/documents",
      buttonLabel: "Upload Documents",
      whyNeeded: "Underwriting can't start until your document set is complete.",
      timeEstimate: "a few minutes",
      count: pendingTasks.documents,
    };
  }

  if (pendingTasks.total > 0) {
    return {
      kind: "complete_tasks",
      title: `Complete ${pendingTasks.total} pending task${pendingTasks.total > 1 ? "s" : ""}`,
      description: "These tasks are needed to move your application forward.",
      href: "/tasks",
      buttonLabel: "View Tasks",
      whyNeeded: "Completing tasks on time prevents delays in your approval.",
      timeEstimate: "a few minutes",
      count: pendingTasks.total,
    };
  }

  if (pendingDocuments > 0) {
    return {
      kind: "upload_documents",
      title: `Upload ${pendingDocuments} document${pendingDocuments > 1 ? "s" : ""}`,
      description: "We need these documents to continue reviewing your application.",
      href: "/documents",
      buttonLabel: "Upload",
      whyNeeded: "Documents verify the information in your application, as required by federal regulations.",
      timeEstimate: "about 5 minutes",
      count: pendingDocuments,
    };
  }

  if (status === "conditional") {
    return {
      kind: "clear_conditions",
      title: "Clear remaining conditions",
      description: "Review and fulfill the conditions to move to final approval.",
      href: `/pipeline/${application.id}`,
      buttonLabel: "View Conditions",
    };
  }

  if (status === "pre_approved") {
    return {
      kind: "browse_homes",
      title: "Check if you can afford a home",
      description: "You're pre-approved. See if a specific home fits your budget.",
      href: "/afford",
      buttonLabel: "Can I Afford This Home?",
      ...(expiration?.urgency === "urgent" && { urgency: "urgent" as const }),
    };
  }

  if (status === "clear_to_close" || status === "closing") {
    return {
      kind: "contact_team",
      title: "You're almost there",
      description: "Your loan is clear to close. Your closer will reach out to schedule signing.",
      href: "/messages",
      buttonLabel: "Contact Team",
    };
  }

  if (status === "denied") {
    return {
      kind: "talk_to_coach",
      title: "Let's explore your options",
      description: "Chat with Homi to learn what you can do next.",
      href: "/ai-coach",
      buttonLabel: "Talk to Homi",
    };
  }

  if (status === "funded") {
    return {
      kind: "homeowner_hub",
      title: "Welcome to your Homeowner Hub",
      description: "Your loan is funded. Track your equity, watch rates, and get PMI-removal alerts.",
      href: "/homeowner-dashboard",
      buttonLabel: "Open Homeowner Hub",
    };
  }

  return {
    kind: "in_review",
    title: "Your file is ready for loan-team review",
    description: getLoanAppStatusMeta(status).description,
    href: "/messages",
    buttonLabel: "View Status",
  };
}
