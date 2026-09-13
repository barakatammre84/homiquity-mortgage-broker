import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, dealTeamMembers, documents, loanApplications, tasks, workWaits, type WorkWait } from "@shared/schema";
import { isInternalStaffRole } from "@shared/roles";
import { elapsedWaitMs, type CloseWorkWait, type ListWorkWaits, type RecordWorkWait } from "@shared/workWaits";
import { withPostgresTransactionRetry } from "./transactionRetry";

type Actor = { id: string; role: string };
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class WorkWaitError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function authorize(tx: Transaction, applicationId: string, actor: Actor, write: boolean) {
  if (!isInternalStaffRole(actor.role)) throw new WorkWaitError("Staff access required", 403);
  // Serialize a file's observation writes. The lock also keeps assignment stable until commit.
  const [application] = await tx.select({ id: loanApplications.id, loanOfficerId: loanApplications.loanOfficerId })
    .from(loanApplications).where(eq(loanApplications.id, applicationId)).for(write ? "update" : "share");
  if (!application) throw new WorkWaitError("Application not found", 404);
  if (actor.role === "admin" || application.loanOfficerId === actor.id) return;
  const members = await tx.select({ id: dealTeamMembers.id }).from(dealTeamMembers).where(and(
    eq(dealTeamMembers.applicationId, applicationId), eq(dealTeamMembers.userId, actor.id), eq(dealTeamMembers.isActive, true),
  )).for("share");
  if (!members.length) throw new WorkWaitError("Application not found", 404);
}

function view(row: WorkWait, asOf: Date) {
  return { ...row, elapsedMs: elapsedWaitMs(row.startedAt, row.closedAt, asOf) };
}
function sameTime(a: Date | null, b: Date | null) { return a?.getTime() === b?.getTime(); }
function conflict(): never { throw new WorkWaitError("This event or wait already has a different observation.", 409); }

export async function listWorkWaits(applicationId: string, actor: Actor, query: ListWorkWaits) {
  return withPostgresTransactionRetry(() => db.transaction(async tx => {
    await authorize(tx, applicationId, actor, false);
    const asOf = new Date();
    const rows = await tx.select().from(workWaits).where(and(eq(workWaits.applicationId, applicationId),
      query.afterId ? gt(workWaits.id, query.afterId) : undefined)).orderBy(asc(workWaits.id)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return { asOf: asOf.toISOString(), waits: page.map(row => view(row, asOf)),
      nextCursor: rows.length > query.limit ? page[page.length - 1].id : null };
  }));
}

export async function recordWorkWait(applicationId: string, actor: Actor, input: RecordWorkWait) {
  return withPostgresTransactionRetry(() => db.transaction(async tx => {
    await authorize(tx, applicationId, actor, true);
    const now = new Date();
    if (input.startedAt > now) throw new WorkWaitError("A wait cannot start in the future.", 400);
    const [existing] = await tx.select().from(workWaits).where(and(
      eq(workWaits.applicationId, applicationId), eq(workWaits.startEventId, input.startEventId),
    ));
    if (existing) {
      if (existing.taskId !== input.taskId || existing.counterparty !== input.counterparty ||
          !sameTime(existing.startedAt, input.startedAt) || !sameTime(existing.promisedAt, input.promisedAt)) conflict();
      return { replayed: true, wait: view(existing, now) };
    }
    const [task] = await tx.select({ id: tasks.id }).from(tasks).where(and(
      eq(tasks.id, input.taskId), eq(tasks.applicationId, applicationId),
    )).for("share");
    if (!task) throw new WorkWaitError("Task not found in this application.", 404);
    // A later cycle must start at or after the previous closure. Otherwise backdating
    // could count the same party's wait twice even though only one row is open now.
    const [overlap] = await tx.select({ id: workWaits.id }).from(workWaits).where(and(
      eq(workWaits.taskId, input.taskId), eq(workWaits.counterparty, input.counterparty),
      or(isNull(workWaits.closedAt), gt(workWaits.closedAt, input.startedAt)),
    ));
    if (overlap) conflict();
    const [row] = await tx.insert(workWaits).values({ ...input, applicationId, recordedBy: actor.id, recordedAt: now }).returning();
    await tx.insert(auditLogs).values({ actorUserId: actor.id, action: "work_wait.recorded", targetType: "loan_application",
      targetId: applicationId, metadata: { waitId: row.id, taskId: row.taskId, counterparty: row.counterparty } });
    return { replayed: false, wait: view(row, now) };
  }));
}

export async function closeWorkWait(applicationId: string, waitId: string, actor: Actor, input: CloseWorkWait) {
  return withPostgresTransactionRetry(() => db.transaction(async tx => {
    await authorize(tx, applicationId, actor, true);
    const now = new Date();
    const [row] = await tx.select().from(workWaits).where(and(eq(workWaits.id, waitId), eq(workWaits.applicationId, applicationId)));
    if (!row) throw new WorkWaitError("Wait not found in this application.", 404);
    if (input.closedAt < row.startedAt || input.closedAt > now) throw new WorkWaitError("Closure must fall between the start and now.", 400);
    if (row.closedAt) {
      if (row.closingEventId !== input.closingEventId || !sameTime(row.closedAt, input.closedAt) ||
          row.outcome !== input.outcome || row.documentId !== input.documentId) conflict();
      return { replayed: true, wait: view(row, now) };
    }
    const [usedEvent] = await tx.select({ id: workWaits.id }).from(workWaits).where(and(
      eq(workWaits.applicationId, applicationId), eq(workWaits.closingEventId, input.closingEventId),
    ));
    if (usedEvent) conflict();
    if (input.documentId) {
      const [document] = await tx.select({ id: documents.id }).from(documents).where(and(
        eq(documents.id, input.documentId), eq(documents.applicationId, applicationId),
      )).for("share");
      if (!document) throw new WorkWaitError("Document not found in this application.", 404);
    }
    const [closed] = await tx.update(workWaits).set({ ...input, closedBy: actor.id, closureRecordedAt: now })
      .where(eq(workWaits.id, row.id)).returning();
    await tx.insert(auditLogs).values({ actorUserId: actor.id, action: "work_wait.closed", targetType: "loan_application",
      targetId: applicationId, metadata: { waitId: row.id, outcome: input.outcome, documentId: input.documentId } });
    return { replayed: false, wait: view(closed, now) };
  }));
}
