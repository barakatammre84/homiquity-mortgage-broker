import { sql } from "drizzle-orm";
import { check, index, pgEnum, pgTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { users } from "./core";
import { loanApplications, documents } from "./lending";
import { tasks } from "./underwritingTasks";
import { WAIT_COUNTERPARTIES, WAIT_OUTCOMES } from "../workWaits";

export const workWaitCounterparty = pgEnum("work_wait_counterparty", WAIT_COUNTERPARTIES);
export const workWaitOutcome = pgEnum("work_wait_outcome", WAIT_OUTCOMES);

// An observation of a task's wait, not a task reassignment, completion, or evidence approval.
export const workWaits = pgTable("work_waits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  applicationId: varchar("application_id").notNull().references(() => loanApplications.id),
  taskId: varchar("task_id").notNull().references(() => tasks.id),
  counterparty: workWaitCounterparty("counterparty").notNull(),
  startEventId: varchar("start_event_id", { length: 36 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }).notNull(),
  promisedAt: timestamp("promised_at", { withTimezone: true, precision: 3 }),
  recordedBy: varchar("recorded_by").notNull().references(() => users.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  closingEventId: varchar("closing_event_id", { length: 36 }),
  closedAt: timestamp("closed_at", { withTimezone: true, precision: 3 }),
  outcome: workWaitOutcome("outcome"),
  documentId: varchar("document_id").references(() => documents.id),
  closedBy: varchar("closed_by").references(() => users.id),
  closureRecordedAt: timestamp("closure_recorded_at", { withTimezone: true, precision: 3 }),
}, table => [
  uniqueIndex("work_waits_start_event").on(table.applicationId, table.startEventId),
  uniqueIndex("work_waits_closing_event").on(table.applicationId, table.closingEventId),
  uniqueIndex("work_waits_active_task_counterparty").on(table.taskId, table.counterparty).where(sql`${table.closedAt} IS NULL`),
  index("work_waits_application_id").on(table.applicationId, table.id),
  check("work_waits_promise_order", sql`${table.promisedAt} IS NULL OR ${table.promisedAt} >= ${table.startedAt}`),
  check("work_waits_start_order", sql`${table.startedAt} <= ${table.recordedAt}`),
  check("work_waits_closure_complete", sql`
    (${table.closedAt} IS NULL AND ${table.closingEventId} IS NULL AND ${table.outcome} IS NULL
      AND ${table.documentId} IS NULL AND ${table.closedBy} IS NULL AND ${table.closureRecordedAt} IS NULL)
    OR (${table.closedAt} IS NOT NULL AND ${table.closingEventId} IS NOT NULL AND ${table.outcome} IS NOT NULL
      AND ${table.closedBy} IS NOT NULL AND ${table.closureRecordedAt} IS NOT NULL
      AND ${table.closedAt} >= ${table.startedAt} AND ${table.closedAt} <= ${table.closureRecordedAt})
  `),
]);

export type WorkWait = typeof workWaits.$inferSelect;
