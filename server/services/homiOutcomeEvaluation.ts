const HOMI_OUTCOME_SCHEMA_VERSION = 2;
const MAX_VALID_TURN_RESPONSE_MS = 120_000;
const MIN_MEASURED_TURNS = 30;
const MIN_UNIQUE_BORROWERS = 10;

const SERVER_TRUTH_TOOLS = new Set([
  "lookup_dpa_programs",
  "get_loan_status",
  "get_document_checklist",
  "get_borrower_tasks",
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
  payload: unknown;
  responseMs: number | null;
}

export interface HomiFailedTurnMetricRow {
  userId: string | null;
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
  turnSuccessRate: number;
  uniqueBorrowers: number;
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

function firstRecordedStaffResponse(
  task: HomiHandoffMetricRow,
  staffMessages: HomiStaffMessageMetricRow[],
): Date | null {
  const matches = staffMessages
    .filter((message) =>
      message.applicationId === task.applicationId
      && message.recipientId === task.borrowerUserId
      && message.createdAt.getTime() >= task.createdAt.getTime()
    )
    .map((message) => message.createdAt.getTime());
  return matches.length > 0 ? new Date(Math.min(...matches)) : null;
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
  const failedTurns = input.failedTurns ?? [];
  const payloads = input.turns.map((turn) => recordOf(turn.payload));
  const current = payloads.filter(isCurrentOutcome);
  const measuredCompletion = current.filter((payload) =>
    validCompletion(typeof payload.completionBefore === "number" ? payload.completionBefore : null)
    && validCompletion(typeof payload.completionAfter === "number" ? payload.completionAfter : null)
  );
  const captureAttempts = current.filter((payload) => payload.captureAttempted === true);
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
  const completionRegressedTurns = measuredCompletion.filter((payload) =>
    (payload.completionAfter as number) < (payload.completionBefore as number)
  ).length;
  const responseTimes = input.turns
    .map((turn) => turn.responseMs)
    .filter((value): value is number =>
      value !== null && Number.isFinite(value) && value >= 0 && value <= MAX_VALID_TURN_RESPONSE_MS
    );
  const invalidTurnLatencyRows = input.turns.filter((turn) =>
    turn.responseMs !== null
    && (!Number.isFinite(turn.responseMs) || turn.responseMs < 0 || turn.responseMs > MAX_VALID_TURN_RESPONSE_MS)
  ).length;

  const handoffResponses = input.handoffs.map((task) => ({
    task,
    responseAt: firstRecordedStaffResponse(task, input.staffMessages),
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
    [...input.turns, ...failedTurns].flatMap((turn) => turn.userId ? [turn.userId] : []),
  ).size;
  const enoughMeasuredTurns = measuredCompletion.length >= MIN_MEASURED_TURNS;
  const enoughBorrowers = uniqueBorrowers >= MIN_UNIQUE_BORROWERS;
  const blockers: string[] = [];
  if (!enoughMeasuredTurns) {
    blockers.push(`Collect ${MIN_MEASURED_TURNS - measuredCompletion.length} more server-measured Homi turns.`);
  }
  if (!enoughBorrowers) {
    blockers.push(`Collect outcomes from ${MIN_UNIQUE_BORROWERS - uniqueBorrowers} more distinct borrowers.`);
  }
  blockers.push("Define a pre-registered comparison cohort before claiming that Homi reduced friction.");
  blockers.push("Phone calls and work completed outside secure Messages are not measured as staff responses.");

  return {
    daysBack: input.daysBack,
    turnAttempts: input.turns.length + failedTurns.length,
    turns: input.turns.length,
    failedTurns: failedTurns.length,
    turnSuccessRate: rate(input.turns.length, input.turns.length + failedTurns.length),
    uniqueBorrowers,
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
    exactRepeatedQuestions: payloads.filter((payload) => payload.repeatedQuestion === true).length,
    exactRepeatedQuestionRate: rate(
      payloads.filter((payload) => payload.repeatedQuestion === true).length,
      input.turns.length,
    ),
    completionMeasuredTurns: measuredCompletion.length,
    completionMeasurementCoverageRate: rate(measuredCompletion.length, input.turns.length),
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
    legacyTurns: input.turns.length - current.length,
    measurement: {
      status: enoughMeasuredTurns && enoughBorrowers ? "observational_only" : "collecting",
      canClaimReducedFriction: false,
      minimumMeasuredTurns: MIN_MEASURED_TURNS,
      minimumUniqueBorrowers: MIN_UNIQUE_BORROWERS,
      blockers,
    },
  };
}
