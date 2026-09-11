import { CLIENT_ROLES } from "@shared/roles";

const HOMI_OUTCOME_SCHEMA_VERSION = 2;
const MAX_VALID_TURN_RESPONSE_MS = 120_000;
const MIN_MEASURED_TURNS = 30;
const MIN_UNIQUE_BORROWERS = 10;

const SERVER_TRUTH_TOOLS = new Set([
  "lookup_dpa_programs",
  "get_loan_status",
  "get_document_checklist",
  "get_borrower_tasks",
  "get_document_evidence",
]);

const SERVER_ACTION_TOOLS = new Set([
  "record_intake",
  "request_human_help",
]);

export interface HomiCaptureOutcome {
  attempts: number;
  createdApplication: boolean;
  appliedFields: string[];
  skippedFields: number;
}

export interface HomiTurnOutcomeInput {
  repeatedQuestion: boolean;
  completionBefore: number | null;
  completionAfter: number | null;
  degraded: boolean;
  lintReplaced: boolean;
  modelCalls: number;
  toolCalls: string[];
  captureOutcome?: HomiCaptureOutcome;
  humanHelpRequest?: { taskId: string; alreadyOpen: boolean };
}

export interface HomiTurnOutcomePayload {
  schemaVersion: typeof HOMI_OUTCOME_SCHEMA_VERSION;
  completionBasis: "server_file_snapshot";
  repeatDetection: "normalized_exact_match";
  repeatedQuestion: boolean;
  completionBefore: number | null;
  completionAfter: number | null;
  completionDelta: number | null;
  degraded: boolean;
  lintReplaced: boolean;
  modelCalls: number;
  toolCalls: string[];
  serverTruthToolCalls: string[];
  serverActionToolCalls: string[];
  captureAttempted: boolean;
  capturedFieldCount: number;
  captureCreatedApplication: boolean;
  captureSkippedFieldCount: number;
  humanHandoff: boolean;
  humanHandoffCreated: boolean;
}

const HOMI_FAILURE_CODES = new Set([
  "not_configured",
  "provider_rate_limited",
  "timeout",
  "network",
  "provider_error",
  "aborted",
  "internal",
]);

export function buildHomiTurnFailurePayload(input: {
  code: string;
  streamOpened: boolean;
}): {
  schemaVersion: typeof HOMI_OUTCOME_SCHEMA_VERSION;
  failureCode: string;
  streamOpened: boolean;
} {
  return {
    schemaVersion: HOMI_OUTCOME_SCHEMA_VERSION,
    failureCode: HOMI_FAILURE_CODES.has(input.code) ? input.code : "internal",
    streamOpened: input.streamOpened,
  };
}

function validCompletion(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
}

function uniqueKnownTools(toolCalls: string[], allowed: Set<string>): string[] {
  return [...new Set(toolCalls.filter((tool) => allowed.has(tool)))];
}

/**
 * Build the redacted outcome record for a completed Homi turn. Completion is
 * accepted only from the two server snapshots supplied by the route; neither
 * model prose nor a model-authored profile can move the metric.
 */
export function buildHomiTurnOutcomePayload(input: HomiTurnOutcomeInput): HomiTurnOutcomePayload {
  const completionBefore = validCompletion(input.completionBefore) ? input.completionBefore : null;
  const completionAfter = validCompletion(input.completionAfter) ? input.completionAfter : null;
  const completionDelta = completionBefore !== null && completionAfter !== null
    ? completionAfter - completionBefore
    : null;
  const toolCalls = [...new Set(input.toolCalls)];
  const capture = input.captureOutcome;

  return {
    schemaVersion: HOMI_OUTCOME_SCHEMA_VERSION,
    completionBasis: "server_file_snapshot",
    repeatDetection: "normalized_exact_match",
    repeatedQuestion: input.repeatedQuestion,
    completionBefore,
    completionAfter,
    completionDelta,
    degraded: input.degraded,
    lintReplaced: input.lintReplaced,
    modelCalls: Math.max(0, Math.floor(input.modelCalls)),
    toolCalls,
    serverTruthToolCalls: uniqueKnownTools(toolCalls, SERVER_TRUTH_TOOLS),
    serverActionToolCalls: uniqueKnownTools(toolCalls, SERVER_ACTION_TOOLS),
    captureAttempted: (capture?.attempts ?? 0) > 0,
    capturedFieldCount: capture?.appliedFields.length ?? 0,
    captureCreatedApplication: capture?.createdApplication ?? false,
    captureSkippedFieldCount: capture?.skippedFields ?? 0,
    humanHandoff: !!input.humanHelpRequest,
    humanHandoffCreated: !!input.humanHelpRequest && !input.humanHelpRequest.alreadyOpen,
  };
}

export interface HomiTurnMetricRow {
  userId: string | null;
  userRole: string | null;
  payload: unknown;
  responseMs: number | null;
}

export interface HomiFailedTurnMetricRow {
  userId: string | null;
  userRole: string | null;
  responseMs: number | null;
  payload: unknown;
}

export interface HomiHandoffMetricRow {
  id: string;
  applicationId: string;
  borrowerUserId: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  slaDueAt: Date | null;
  autoResolved: boolean | null;
}

export interface HomiStaffMessageMetricRow {
  applicationId: string | null;
  recipientId: string;
  createdAt: Date;
}

export type HomiMeasurementStatus = "collecting" | "observational_only";

export interface HomiOutcomeMetrics {
  daysBack: number;
  turnAttempts: number;
  turns: number;
  failedTurns: number;
  excludedNonBorrowerTurnAttempts: number;
  turnSuccessRate: number;
  uniqueBorrowers: number;
  measuredUniqueBorrowers: number;
  serverTruthTurns: number;
  serverActionTurns: number;
  exactRepeatedQuestions: number;
  exactRepeatedQuestionRate: number;
  completionMeasuredTurns: number;
  completionMeasurementCoverageRate: number;
  captureAttemptTurns: number;
  captureSucceededTurns: number;
  capturedFields: number;
  completionMeasuredCaptureTurns: number;
  completionImprovedTurns: number;
  completionImprovementRate: number;
  completionRegressedTurns: number;
  humanHelpRequests: number;
  openHumanHelpRequests: number;
  recordedStaffResponses: number;
  recordedStaffResponseRate: number;
  averageRecordedStaffResponseMinutes: number | null;
  medianRecordedStaffResponseMinutes: number | null;
  completedWithoutRecordedStaffResponse: number;
  pastDueWithoutRecordedStaffResponse: number;
  averageTurnResponseMs: number | null;
  p95TurnResponseMs: number | null;
  invalidTurnLatencyRows: number;
  degradedTurns: number;
  lintReplacedTurns: number;
  legacyTurns: number;
  measurement: {
    status: HomiMeasurementStatus;
    canClaimReducedFriction: false;
    minimumMeasuredTurns: typeof MIN_MEASURED_TURNS;
    minimumUniqueBorrowers: typeof MIN_UNIQUE_BORROWERS;
    comparisonStudy: {
      status: "not_registered";
      registrationId: null;
      assignmentUnit: null;
      comparisonCohort: null;
    };
    blockers: string[];
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function rate(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 10_000) / 100 : 0;
}

function average(values: number[]): number | null {
  return values.length > 0
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const value = ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
  return Math.round(value);
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((percentileValue / 100) * ordered.length) - 1);
  return Math.round(ordered[index]);
}

function isCurrentOutcome(payload: Record<string, unknown>): boolean {
  return payload.schemaVersion === HOMI_OUTCOME_SCHEMA_VERSION
    && payload.completionBasis === "server_file_snapshot";
}

function isEligibleBorrowerRole(role: string | null): boolean {
  return role !== null && CLIENT_ROLES.includes(role as typeof CLIENT_ROLES[number]);
}

function responseKey(applicationId: string | null, recipientId: string): string {
  return `${applicationId ?? ""}\u0000${recipientId}`;
}

function indexStaffResponses(
  staffMessages: HomiStaffMessageMetricRow[],
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const message of staffMessages) {
    const timestamp = message.createdAt.getTime();
    if (!Number.isFinite(timestamp)) continue;
    const key = responseKey(message.applicationId, message.recipientId);
    const timestamps = index.get(key) ?? [];
    timestamps.push(timestamp);
    index.set(key, timestamps);
  }
  for (const timestamps of index.values()) timestamps.sort((a, b) => a - b);
  return index;
}

/**
 * Match each secure staff message to at most one Homi handoff. A later message
 * is evidence only while that request is still open: a message sent after the
 * task was completed cannot retroactively prove how the request was handled.
 *
 * Tasks are processed oldest-first within one borrower file. `request_human_help`
 * prevents simultaneous open Homi tasks today, but the one-to-one consumption
 * below also keeps historical or malformed overlap from counting one message
 * as several responses.
 */
function matchRecordedStaffResponses(
  tasks: HomiHandoffMetricRow[],
  responseIndex: Map<string, number[]>,
): Map<string, Date> {
  const matches = new Map<string, Date>();
  const tasksByKey = new Map<string, HomiHandoffMetricRow[]>();
  for (const task of tasks) {
    const key = responseKey(task.applicationId, task.borrowerUserId);
    const grouped = tasksByKey.get(key) ?? [];
    grouped.push(task);
    tasksByKey.set(key, grouped);
  }

  for (const [key, groupedTasks] of tasksByKey) {
    const timestamps = responseIndex.get(key) ?? [];
    let messageIndex = 0;
    for (const task of [...groupedTasks].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    )) {
      const openedAt = task.createdAt.getTime();
      const closedAt = task.completedAt?.getTime() ?? Number.POSITIVE_INFINITY;
      while (messageIndex < timestamps.length && timestamps[messageIndex] < openedAt) {
        messageIndex += 1;
      }
      const candidate = timestamps[messageIndex];
      if (candidate === undefined || candidate > closedAt) continue;
      matches.set(task.id, new Date(candidate));
      messageIndex += 1;
    }
  }

  return matches;
}

/**
 * Aggregate privacy-minimal operational evidence. It deliberately refuses a
 * causal product claim: without a pre-registered comparison cohort, these are
 * observations about Homi users rather than proof that Homi caused improvement.
 */
export function buildHomiOutcomeMetrics(input: {
  daysBack: number;
  turns: HomiTurnMetricRow[];
  failedTurns?: HomiFailedTurnMetricRow[];
  handoffs: HomiHandoffMetricRow[];
  staffMessages: HomiStaffMessageMetricRow[];
  now?: Date;
}): HomiOutcomeMetrics {
  const now = input.now ?? new Date();
  const allFailedTurns = input.failedTurns ?? [];
  const turns = input.turns.filter((turn) => isEligibleBorrowerRole(turn.userRole));
  const failedTurns = allFailedTurns.filter((turn) => isEligibleBorrowerRole(turn.userRole));
  const excludedNonBorrowerTurnAttempts =
    (input.turns.length - turns.length) + (allFailedTurns.length - failedTurns.length);
  const turnsWithPayload = turns.map((turn) => ({
    turn,
    payload: recordOf(turn.payload),
  }));
  const payloads = turnsWithPayload.map(({ payload }) => payload);
  const current = turnsWithPayload.filter(({ payload }) => isCurrentOutcome(payload));
  const measuredCompletion = current.filter(({ payload }) =>
    validCompletion(typeof payload.completionBefore === "number" ? payload.completionBefore : null)
    && validCompletion(typeof payload.completionAfter === "number" ? payload.completionAfter : null)
  );
  const captureAttempts = current
    .map(({ payload }) => payload)
    .filter((payload) => payload.captureAttempted === true);
  const captureSuccesses = captureAttempts.filter((payload) =>
    typeof payload.capturedFieldCount === "number" && payload.capturedFieldCount > 0
  );
  const measuredCaptureSuccesses = captureSuccesses.filter((payload) =>
    validCompletion(typeof payload.completionBefore === "number" ? payload.completionBefore : null)
    && validCompletion(typeof payload.completionAfter === "number" ? payload.completionAfter : null)
  );
  const completionImprovedTurns = measuredCaptureSuccesses.filter((payload) =>
    (payload.completionAfter as number) > (payload.completionBefore as number)
  ).length;
  const completionRegressedTurns = measuredCompletion.filter(({ payload }) =>
    (payload.completionAfter as number) < (payload.completionBefore as number)
  ).length;
  const responseTimes = turns
    .map((turn) => turn.responseMs)
    .filter((value): value is number =>
      value !== null && Number.isFinite(value) && value >= 0 && value <= MAX_VALID_TURN_RESPONSE_MS
    );
  const invalidTurnLatencyRows = turns.filter((turn) =>
    turn.responseMs !== null
    && (!Number.isFinite(turn.responseMs) || turn.responseMs < 0 || turn.responseMs > MAX_VALID_TURN_RESPONSE_MS)
  ).length;

  const responseIndex = indexStaffResponses(input.staffMessages);
  const matchedResponses = matchRecordedStaffResponses(input.handoffs, responseIndex);
  const handoffResponses = input.handoffs.map((task) => ({
    task,
    responseAt: matchedResponses.get(task.id) ?? null,
  }));
  const responseDurations = handoffResponses
    .filter((item): item is typeof item & { responseAt: Date } => item.responseAt !== null)
    .map((item) => (item.responseAt.getTime() - item.task.createdAt.getTime()) / 60_000)
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0);
  const completedWithoutRecordedStaffResponse = handoffResponses.filter((item) =>
    item.task.status === "COMPLETED"
    && item.task.autoResolved !== true
    && item.responseAt === null
  ).length;
  const pastDueWithoutRecordedStaffResponse = handoffResponses.filter((item) =>
    ["OPEN", "IN_PROGRESS", "BLOCKED"].includes(item.task.status)
    && item.task.slaDueAt !== null
    && item.task.slaDueAt.getTime() < now.getTime()
    && item.responseAt === null
  ).length;

  const uniqueBorrowers = new Set(
    [...turns, ...failedTurns].flatMap((turn) => turn.userId ? [turn.userId] : []),
  ).size;
  const measuredUniqueBorrowers = new Set(
    measuredCompletion.flatMap(({ turn }) => turn.userId ? [turn.userId] : []),
  ).size;
  const enoughMeasuredTurns = measuredCompletion.length >= MIN_MEASURED_TURNS;
  const enoughBorrowers = measuredUniqueBorrowers >= MIN_UNIQUE_BORROWERS;
  const blockers: string[] = [];
  if (!enoughMeasuredTurns) {
    blockers.push(`Collect ${MIN_MEASURED_TURNS - measuredCompletion.length} more server-measured Homi turns.`);
  }
  if (!enoughBorrowers) {
    blockers.push(`Collect server-measured outcomes from ${MIN_UNIQUE_BORROWERS - measuredUniqueBorrowers} more distinct borrowers.`);
  }
  blockers.push("Register the comparison study before enrollment; the 30-turn/10-borrower floor proves measurement coverage, not causation.");
  blockers.push("Phone calls and work completed outside secure Messages are not measured as staff responses.");

  return {
    daysBack: input.daysBack,
    turnAttempts: turns.length + failedTurns.length,
    turns: turns.length,
    failedTurns: failedTurns.length,
    excludedNonBorrowerTurnAttempts,
    turnSuccessRate: rate(turns.length, turns.length + failedTurns.length),
    uniqueBorrowers,
    measuredUniqueBorrowers,
    serverTruthTurns: payloads.filter((payload) => {
      const calls = stringArray(payload.serverTruthToolCalls).length > 0
        ? stringArray(payload.serverTruthToolCalls)
        : uniqueKnownTools(stringArray(payload.toolCalls), SERVER_TRUTH_TOOLS);
      return calls.length > 0;
    }).length,
    serverActionTurns: payloads.filter((payload) => {
      const calls = stringArray(payload.serverActionToolCalls).length > 0
        ? stringArray(payload.serverActionToolCalls)
        : uniqueKnownTools(stringArray(payload.toolCalls), SERVER_ACTION_TOOLS);
      return calls.length > 0;
    }).length,
    exactRepeatedQuestions: current.filter(({ payload }) => payload.repeatedQuestion === true).length,
    exactRepeatedQuestionRate: rate(
      current.filter(({ payload }) => payload.repeatedQuestion === true).length,
      current.length,
    ),
    completionMeasuredTurns: measuredCompletion.length,
    completionMeasurementCoverageRate: rate(measuredCompletion.length, turns.length),
    captureAttemptTurns: captureAttempts.length,
    captureSucceededTurns: captureSuccesses.length,
    capturedFields: captureSuccesses.reduce(
      (sum, payload) => sum + (payload.capturedFieldCount as number),
      0,
    ),
    completionMeasuredCaptureTurns: measuredCaptureSuccesses.length,
    completionImprovedTurns,
    completionImprovementRate: rate(completionImprovedTurns, measuredCaptureSuccesses.length),
    completionRegressedTurns,
    humanHelpRequests: input.handoffs.length,
    openHumanHelpRequests: input.handoffs.filter((task) =>
      ["OPEN", "IN_PROGRESS", "BLOCKED"].includes(task.status)
    ).length,
    recordedStaffResponses: responseDurations.length,
    recordedStaffResponseRate: rate(responseDurations.length, input.handoffs.length),
    averageRecordedStaffResponseMinutes: average(responseDurations),
    medianRecordedStaffResponseMinutes: median(responseDurations),
    completedWithoutRecordedStaffResponse,
    pastDueWithoutRecordedStaffResponse,
    averageTurnResponseMs: average(responseTimes),
    p95TurnResponseMs: percentile(responseTimes, 95),
    invalidTurnLatencyRows,
    degradedTurns: payloads.filter((payload) => payload.degraded === true).length,
    lintReplacedTurns: payloads.filter((payload) => payload.lintReplaced === true).length,
    legacyTurns: turns.length - current.length,
    measurement: {
      status: enoughMeasuredTurns && enoughBorrowers ? "observational_only" : "collecting",
      canClaimReducedFriction: false,
      minimumMeasuredTurns: MIN_MEASURED_TURNS,
      minimumUniqueBorrowers: MIN_UNIQUE_BORROWERS,
      comparisonStudy: {
        status: "not_registered",
        registrationId: null,
        assignmentUnit: null,
        comparisonCohort: null,
      },
      blockers,
    },
  };
}
