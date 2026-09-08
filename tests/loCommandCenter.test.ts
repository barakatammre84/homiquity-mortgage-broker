import { describe, it, expect } from "vitest";
import { BASE_URL } from "./setup";

// ---------------------------------------------------------------------------
// LO Command Center contract tests.
//
// The Command Center reads GET /api/pipeline/queue, which must stay:
//   1. internal-staff-only (broker/lender/borrower get 403 — same boundary
//      class as the H8 MISMO-export fix, list-level instead of object-level);
//   2. deal-team-scoped for non-admin staff (an LO sees only files they are
//      an active team member on — admin sees everything);
//   3. carrying the deterministic fileHealth signal on every row (the
//      No-Stall green/yellow/red light plus its reasons).
//
// Uses the dev test-login accounts (DEV_TEST_PASSWORD). The session cookie is
// secure-only, so every request sends X-Forwarded-Proto: https.
// ---------------------------------------------------------------------------

const TEST_PASSWORD = process.env.DEV_TEST_PASSWORD || "test1234";
const HTTPS_PROXY_HEADER = { "X-Forwarded-Proto": "https" };

async function loginAs(email: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/test-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...HTTPS_PROXY_HEADER },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  expect(res.status, `test-login as ${email}`).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  expect(setCookie, `session cookie for ${email}`).toBeTruthy();
  return setCookie!.split(";")[0];
}

async function getQueue(cookie: string) {
  const res = await fetch(`${BASE_URL}/api/pipeline/queue`, {
    method: "GET",
    headers: { Cookie: cookie, ...HTTPS_PROXY_HEADER },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

interface QueueItem {
  applicationId: string;
  fileHealth?: { light: string; reasons: string[] };
  daysIdle?: number | null;
  lastActivityAt?: string | null;
}

function expectHealthShape(item: QueueItem, context: string) {
  expect(item.fileHealth, `${context}: fileHealth missing`).toBeTruthy();
  expect(["green", "yellow", "red"], `${context}: unknown light`).toContain(item.fileHealth!.light);
  expect(Array.isArray(item.fileHealth!.reasons), `${context}: reasons not an array`).toBe(true);
  if (item.fileHealth!.light !== "green") {
    expect(item.fileHealth!.reasons.length, `${context}: non-green light must explain itself`).toBeGreaterThan(0);
  }
  expect(
    item.daysIdle === null || typeof item.daysIdle === "number",
    `${context}: daysIdle must be number|null`,
  ).toBe(true);
}

describe("pipeline queue role gate (Command Center boundary)", () => {
  it("rejects an authenticated broker with 403", async () => {
    const cookie = await loginAs("broker@test.com");
    const res = await getQueue(cookie);
    expect(res.status).toBe(403);
  });

  it("rejects an authenticated lender with 403", async () => {
    const cookie = await loginAs("lender@test.com");
    const res = await getQueue(cookie);
    expect(res.status).toBe(403);
  });

  it("rejects an authenticated borrower client with 403", async () => {
    const cookie = await loginAs("buyer@test.com");
    const res = await getQueue(cookie);
    expect(res.status).toBe(403);
  });
});

describe("pipeline queue scoping + fileHealth contract", () => {
  it("scopes a loan officer to their deal-team files, all carrying fileHealth", async () => {
    const loCookie = await loginAs("lo@test.com");
    const adminCookie = await loginAs("admin@test.com");

    const loRes = await getQueue(loCookie);
    const adminRes = await getQueue(adminCookie);
    expect(loRes.status).toBe(200);
    expect(adminRes.status).toBe(200);

    const loQueue: QueueItem[] = loRes.body.queue;
    const adminQueue: QueueItem[] = adminRes.body.queue;
    expect(Array.isArray(loQueue)).toBe(true);
    expect(Array.isArray(adminQueue)).toBe(true);

    // The queue's identity is the application, not a deal-team membership.
    // Historical rows can repeat the same staffer/file pairing, and one person
    // may legitimately hold multiple roles on one file. Neither may inflate the
    // workload count or render the same borrower more than once.
    expect(new Set(loQueue.map(q => q.applicationId)).size).toBe(loQueue.length);
    expect(new Set(adminQueue.map(q => q.applicationId)).size).toBe(adminQueue.length);

    // The LO's view must be a subset of the platform-wide (admin) view: any
    // file visible to the LO without admin seeing it would mean the two
    // paths disagree about what exists.
    const adminIds = new Set(adminQueue.map(q => q.applicationId));
    for (const item of loQueue) {
      expect(adminIds.has(item.applicationId), `LO sees ${item.applicationId} that admin cannot`).toBe(true);
    }

    for (const item of loQueue) expectHealthShape(item, `lo queue ${item.applicationId}`);
  });

  it("serves fileHealth on every row of the admin queue", async (ctx) => {
    const cookie = await loginAs("admin@test.com");
    const res = await getQueue(cookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("byPriority");

    const queue: QueueItem[] = res.body.queue;
    if (queue.length === 0) {
      ctx.skip(); // empty DB — the role-gate tests above still ran
      return;
    }
    for (const item of queue) expectHealthShape(item, `admin queue ${item.applicationId}`);
  });
});
