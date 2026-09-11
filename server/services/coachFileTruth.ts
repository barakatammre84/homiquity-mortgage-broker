/**
 * Server truth for the borrower assistant.
 *
 * WHY THIS MODULE EXISTS. The assistant used to answer "where does my
 * application stand?" and "what documents do you need?" from the model's own
 * memory of the conversation, while the server already computed both facts
 * exactly. Worse, one tool let the MODEL author the document checklist — so it
 * invented a `documentType` slug matching no loan_condition, the panel rendered
 * it authoritatively next to an upload button, the borrower uploaded, and the
 * item never ticked off. The UI said the operation happened; the file said
 * nothing happened.
 *
 * So: every fact the assistant states about a borrower's file is loaded HERE,
 * from the same functions the borrower's own dashboard and document-checklist
 * endpoint use. Same inputs, same derivations, same output. If this module and
 * `GET /api/applications/:id/document-checklist` ever disagree, that is a bug
 * in one of them, and tests/integration/homiTruth.test.ts is the oracle.
 *
 * TWO BOUNDARIES THAT ARE NOT NEGOTIABLE.
 *
 * 1. Never trust a model-supplied id. Nothing here takes an applicationId from
 *    tool input — the caller resolves it from the authenticated session, and
 *    every load re-authorizes through getLoanApplicationWithAccess. A model can
 *    be talked into emitting someone else's uuid; that is an IDOR primitive
 *    with a plausible-sounding wrapper (cf. F-027).
 *
 * 2. Staff signals stay on the staff side. PipelineSummary carries fileHealth,
 *    priority, borrowerName and daysIdle — the No-Stall signals the LO cockpit
 *    sorts its queue by. "Urgent"/red on a borrower-facing surface reads as a
 *    problem with THEIR application, which is not what it means. The snapshot
 *    below is a whitelist, never a spread, for exactly that reason.
 */
import { storage } from "../storage";
import { getPipelineSummary } from "../pipelineEngine";
import { buildDocumentChecklist, type ChecklistItemDto, type ChecklistStats } from "./documentChecklist";
import { taskEngine } from "./taskEngine";
import { computeNextAction, type NextAction } from "./nextAction";
import { getUserActivitySummary } from "./activitySummary";
import { toBorrowerTaskViews, type BorrowerTaskView } from "@shared/borrowerTaskView";
import { deriveJourneyStepDetails, type JourneyStepId } from "@shared/borrowerJourney";
import { getLoanAppStatusMeta } from "@shared/loanApplicationStatus";
import { pickActiveLoanApplication, pickWorkableLoanApplication } from "@shared/loanApplicationStatus";
import type { User } from "@shared/schema";

/**
 * Resolve one coherent Homi file. A submitted file takes priority over a newer
 * draft; closed history is narrative-only and can never receive actions.
 */
export function selectCoachApplications<T extends { status: string }>(applications: readonly T[]): {
  contextApplication: T | undefined;
  workableApplication: T | undefined;
} {
  const workableApplication = pickActiveLoanApplication(applications)
    ?? pickWorkableLoanApplication(applications);
  return {
    workableApplication,
    contextApplication: workableApplication
      ?? applications.find((application) => application.status === "funded")
      ?? applications[0],
  };
}

/** The borrower-safe slice of stage state. Whitelist — see boundary 2 above. */
export interface LoanStageSnapshot {
  status: string;
  label: string;
  description: string;
  progressPercent: number;
  phase: string;
}

export interface LoanPipelineSnapshot {
  daysInPipeline: number;
  conditionsOutstanding: number;
  conditionsTotal: number;
  /** Conditions cleared+waived over total — the pipeline engine's own figure. */
  percentComplete: number;
  targetCloseDate: string | null;
}

export interface LoanStatusSnapshot {
  hasApplication: boolean;
  stage: LoanStageSnapshot | null;
  pipeline: LoanPipelineSnapshot | null;
  /** Per-step borrower display lines, e.g. "Conditions cleared: 2 of 5". */
  journey: Array<{ stepId: JourneyStepId; lines: string[] }>;
  nextAction: NextAction | null;
  lastActivityAt: string | null;
}

export interface DocumentChecklistSnapshot {
  documents: ChecklistItemDto[];
  stats: ChecklistStats;
}

/**
 * One authorized load of everything the assistant may say about a file.
 *
 * Returns null when the caller may not see this application — callers surface
 * that as "temporarily unavailable", never as a fabricated answer.
 */
export interface FileTruth {
  applicationId: string;
  status: LoanStatusSnapshot;
  checklist: DocumentChecklistSnapshot;
  tasks: BorrowerTaskView[];
}

export async function loadFileTruth(
  applicationId: string,
  user: Pick<User, "id" | "role">,
): Promise<FileTruth | null> {
  // Re-authorize on every load. The session resolved this id, but a service
  // that trusts its caller is one refactor away from trusting a tool input.
  const application = await storage.getLoanApplicationWithAccess(
    applicationId,
    user.id,
    user.role,
  );
  if (!application) return null;

  // The same three reads GET /api/applications/:id/document-checklist performs,
  // feeding the same pure builder. Divergence here is the bug the oracle test
  // exists to catch.
  const [conditions, uploadedDocs, tasks, summary, milestones, borrowerTasks, unreadMessages, activity] =
    await Promise.all([
      storage.getLoanConditionsByApplication(applicationId),
      storage.getDocumentsByApplication(applicationId),
      storage.getTasksByApplication(applicationId),
      getPipelineSummary(applicationId),
      storage.getLoanMilestones(applicationId),
      taskEngine.getBorrowerTasks(applicationId),
      storage.getUnreadMessageCount(user.id),
      getUserActivitySummary(user.id).catch(() => null),
    ]);

  const checklist = buildDocumentChecklist({ conditions, documents: uploadedDocs, tasks });
  const meta = getLoanAppStatusMeta(application.status);

  // Document counters for the journey lines. "Complete" means the borrower has
  // done their part — uploaded, in review, or verified — because the line is
  // telling THEM what is still on their plate, not what staff has finished.
  const docsTotal = checklist.stats.total;
  const docsComplete = checklist.stats.verified + checklist.stats.uploaded;

  const conditionsTotal = summary?.conditionsTotal ?? 0;
  const conditionsCleared = Math.max(0, conditionsTotal - (summary?.conditionsOutstanding ?? 0));

  const closingPrepInProgress = borrowerTasks.some(
    (t) => t.taskTypeCode === "CMP_CLOSING_DISC" && (t.status === "OPEN" || t.status === "IN_PROGRESS"),
  );

  const journeyDetails = deriveJourneyStepDetails({
    milestones: milestones ?? null,
    documents: docsTotal > 0 ? { complete: docsComplete, total: docsTotal } : null,
    conditions: conditionsTotal > 0 ? { cleared: conditionsCleared, total: conditionsTotal } : null,
    closingPrepInProgress,
  });

  const documentTaskCount = borrowerTasks.filter((t) => t.taskType === "document_request").length;

  const nextAction = computeNextAction({
    application,
    pendingTasks: { total: borrowerTasks.length, documents: documentTaskCount },
    pendingDocuments: checklist.stats.needed,
    unreadMessages,
    activitySummary: activity
      ? { propertySearches: activity.propertySearches, calculatorUses: activity.calculatorUses }
      : null,
  });

  return {
    applicationId,
    status: {
      hasApplication: true,
      stage: {
        status: application.status,
        label: meta.label,
        description: meta.description,
        progressPercent: meta.progressPercent,
        phase: meta.phase,
      },
      pipeline: summary
        ? {
            daysInPipeline: summary.daysInPipeline,
            conditionsOutstanding: summary.conditionsOutstanding,
            conditionsTotal: summary.conditionsTotal,
            percentComplete: summary.percentComplete,
            targetCloseDate: summary.targetCloseDate ? summary.targetCloseDate.toISOString() : null,
          }
        : null,
      journey: (Object.entries(journeyDetails) as Array<[JourneyStepId, string[]]>)
        .filter(([, lines]) => lines.length > 0)
        .map(([stepId, lines]) => ({ stepId, lines })),
      nextAction,
      lastActivityAt: summary?.lastActivityAt ? summary.lastActivityAt.toISOString() : null,
    },
    checklist,
    // Masked BEFORE anything else can touch them. Raw task rows carry
    // verificationNotes, resolutionNotes, staff user ids and escalation
    // internals (BORROWER_TASK_EMBARGOED_COLUMNS). Handing those to a model
    // whose output is borrower-facing is a leak with a laundering step in
    // front of it.
    tasks: toBorrowerTaskViews(borrowerTasks, user.id),
  };
}

/** The no-application case, stated honestly rather than left to the model. */
export const EMPTY_LOAN_STATUS: LoanStatusSnapshot = {
  hasApplication: false,
  stage: null,
  pipeline: null,
  journey: [],
  nextAction: null,
  lastActivityAt: null,
};
