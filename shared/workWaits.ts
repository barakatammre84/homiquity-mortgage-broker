import { z } from "zod";

export const WAIT_COUNTERPARTIES = ["borrower", "lender", "vendor", "title", "internal"] as const;
export const WAIT_OUTCOMES = ["work_received", "cancelled", "superseded"] as const;
const reference = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const eventId = z.string().uuid().transform(value => value.toLowerCase());
const instant = z.string().datetime({ offset: true }).transform(value => new Date(value));

// References and structured observations only; do not duplicate task text or borrower PII.
export const recordWorkWaitSchema = z.object({
  taskId: reference,
  counterparty: z.enum(WAIT_COUNTERPARTIES),
  startEventId: eventId,
  startedAt: instant,
  promisedAt: instant.nullable().default(null),
}).strict();

export const closeWorkWaitSchema = z.object({
  closingEventId: eventId,
  closedAt: instant,
  outcome: z.enum(WAIT_OUTCOMES),
  documentId: reference.nullable().default(null),
}).strict();

export const listWorkWaitsSchema = z.object({
  afterId: eventId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export type RecordWorkWait = z.infer<typeof recordWorkWaitSchema>;
export type CloseWorkWait = z.infer<typeof closeWorkWaitSchema>;
export type ListWorkWaits = z.infer<typeof listWorkWaitsSchema>;

/** Wall-clock observation time, never a business-day or regulatory deadline calculation. */
export function elapsedWaitMs(startedAt: Date, closedAt: Date | null, asOf: Date): number {
  return Math.max(0, (closedAt ?? asOf).getTime() - startedAt.getTime());
}
