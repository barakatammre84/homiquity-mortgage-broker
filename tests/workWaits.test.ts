import { describe, expect, it } from "vitest";
import { closeWorkWaitSchema, elapsedWaitMs, listWorkWaitsSchema, recordWorkWaitSchema } from "../shared/workWaits";

const start = { taskId: "task-1", counterparty: "borrower", startEventId: "f0c627a6-d812-47cf-adb5-6eac9595eec9", startedAt: "2026-09-01T10:00:00Z" };
describe("work wait observation contract", () => {
  it("preserves an unknown promise instead of inventing a deadline", () => {
    expect(recordWorkWaitSchema.parse(start).promisedAt).toBeNull();
    // A late handoff can already be overdue when this counterparty's wait starts.
    expect(recordWorkWaitSchema.parse({ ...start, promisedAt: "2026-09-01T09:59:59Z" }).promisedAt?.toISOString()).toBe("2026-09-01T09:59:59.000Z");
  });
  it("rejects ambiguous local timestamps, invented counterparties and client-supplied actors", () => {
    for (const fields of [{ startedAt: "2026-09-01T10:00:00" }, { counterparty: "none" }, { recordedBy: "admin" }, { startEventId: "event-1" }, { note: "borrower details" }]) {
      expect(recordWorkWaitSchema.safeParse({ ...start, ...fields }).success).toBe(false);
    }
    expect(closeWorkWaitSchema.safeParse({ closingEventId: start.startEventId, closedAt: start.startedAt, outcome: "approved" }).success).toBe(false);
  });
  it("normalizes equivalent UTC instants and UUID casing for retry comparisons", () => {
    const parsed = recordWorkWaitSchema.parse({ ...start, startEventId: start.startEventId.toUpperCase(), startedAt: "2026-09-01T05:00:00-05:00" });
    expect(parsed.startEventId).toBe(start.startEventId);
    expect(parsed.startedAt.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });
  it("measures actual elapsed time across a daylight-saving transition, freezing a closed wait", () => {
    const since = new Date("2026-11-01T01:30:00-05:00"), end = new Date("2026-11-01T01:30:00-06:00");
    expect(elapsedWaitMs(since, null, end)).toBe(3_600_000);
    expect(elapsedWaitMs(since, end, new Date("2026-12-01T00:00:00Z"))).toBe(3_600_000);
    expect(elapsedWaitMs(since, null, new Date(0))).toBe(0);
  });
  it("does not overflow after 25 days and bounds each read", () => {
    expect(elapsedWaitMs(new Date(0), null, new Date(90 * 86_400_000))).toBe(7_776_000_000);
    expect(listWorkWaitsSchema.parse({})).toEqual({ limit: 50 });
    for (const query of [{ limit: 0 }, { limit: 101 }, { limit: "1.5" }, { afterId: "bad" }, { applicationId: "other" }]) {
      expect(listWorkWaitsSchema.safeParse(query).success).toBe(false);
    }
  });
});
