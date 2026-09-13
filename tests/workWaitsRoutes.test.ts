import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { BASE_URL } from "./setup";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const applicationId = randomUUID(), otherApplicationId = randomUUID(), borrowerId = randomUUID();
const taskId = randomUUID(), otherTaskId = randomUUID(), documentId = randomUUID(), otherDocumentId = randomUUID();
const endpoint = `/api/loan-applications/${applicationId}/work-waits`;
const cookies: Record<string, string> = {};
const startedAt = "2026-01-01T10:00:00.000Z", promisedAt = "2026-01-02T10:00:00.000Z", closedAt = "2026-01-03T10:00:00.000Z";
const startEventId = randomUUID(), closingEventId = randomUUID();
const observation = { taskId, counterparty: "borrower", startEventId, startedAt, promisedAt };
const closure = { closingEventId, closedAt, outcome: "work_received", documentId };
let waitId: string;
async function request(role: string, path = endpoint, body?: unknown) {
  return fetch(`${BASE_URL}${path}`, { method: body === undefined ? "GET" : "POST", headers: {
    Cookie: cookies[role] ?? "", Origin: BASE_URL, "Content-Type": "application/json",
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function counts() {
  const result = await pool.query(`SELECT
    (SELECT count(*)::int FROM tasks WHERE application_id=$1) AS tasks,
    (SELECT count(*)::int FROM task_events WHERE application_id=$1) AS events,
    (SELECT count(*)::int FROM notifications WHERE user_id=$2) AS notifications,
    (SELECT status FROM loan_applications WHERE id=$1) AS status,
    (SELECT status FROM tasks WHERE id=$3) AS task_status,
    (SELECT status FROM documents WHERE id=$4) AS document_status`, [applicationId, borrowerId, taskId, documentId]);
  return result.rows[0];
}
let initialState: Awaited<ReturnType<typeof counts>>;

beforeAll(async () => {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname)) {
    throw new Error("Work wait fixtures require a disposable local database");
  }
  for (const role of ["admin", "lo", "loa", "processor", "underwriter", "closer", "buyer", "broker", "lender"]) {
    const response = await fetch(`${BASE_URL}/api/test-login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ email: `${role}@test.com`, password: process.env.DEV_TEST_PASSWORD || "test1234" }) });
    expect(response.status).toBe(200); cookies[role] = response.headers.get("set-cookie")!.split(";")[0];
  }
  await pool.query("INSERT INTO users (id,email,first_name,last_name,role) VALUES ($1,$2,'Fictional','Wait Borrower','buyer')", [borrowerId, `${borrowerId}@example.test`]);
  await pool.query("INSERT INTO loan_applications (id,user_id,status) VALUES ($1,$3,'draft'),($2,$3,'draft')", [applicationId, otherApplicationId, borrowerId]);
  await pool.query("INSERT INTO tasks (id,application_id,title,task_type,status) VALUES ($1,$2,'Fictional outstanding work','document_request','BLOCKED'),($3,$4,'Other file work','document_request','OPEN')", [taskId, applicationId, otherTaskId, otherApplicationId]);
  await pool.query("INSERT INTO documents (id,application_id,user_id,document_type,file_name,storage_path,status) VALUES ($1,$2,$5,'paystub','Fictional.pdf','/objects/fictional-wait','uploaded'),($3,$4,$5,'paystub','Other.pdf','/objects/fictional-other','uploaded')", [documentId, applicationId, otherDocumentId, otherApplicationId, borrowerId]);
  for (const role of ["lo", "processor", "underwriter", "closer", "broker", "lender"]) {
    await pool.query("INSERT INTO deal_team_members (application_id,user_id,team_role,is_active) VALUES ($1,$2,$3,true)", [applicationId, `test-${role}`, role]);
  }
  await pool.query("INSERT INTO deal_team_members (application_id,user_id,team_role,is_active) VALUES ($1,'test-loa','loa',false)", [applicationId]);
  initialState = await counts();
});
afterAll(async () => {
  await pool.query("DELETE FROM work_waits WHERE application_id IN ($1,$2)", [applicationId, otherApplicationId]);
  await pool.query("DELETE FROM audit_logs WHERE target_id IN ($1,$2)", [applicationId, otherApplicationId]);
  await pool.query("DELETE FROM tasks WHERE id IN ($1,$2)", [taskId, otherTaskId]);
  await pool.query("DELETE FROM documents WHERE id IN ($1,$2)", [documentId, otherDocumentId]);
  await pool.query("DELETE FROM deal_team_members WHERE application_id IN ($1,$2)", [applicationId, otherApplicationId]);
  await pool.query("DELETE FROM loan_applications WHERE id IN ($1,$2)", [applicationId, otherApplicationId]);
  await pool.query("DELETE FROM users WHERE id=$1", [borrowerId]);
  await pool.end();
});

describe.sequential("observation-only work waits over real HTTP and PostgreSQL", () => {
  it("requires authentication and internal staff on every operation", async () => {
    for (const role of ["anonymous", "buyer", "broker", "lender"]) {
      const expected = role === "anonymous" ? 401 : 403;
      expect((await request(role)).status).toBe(expected);
      expect((await request(role, endpoint, observation)).status).toBe(expected);
      expect((await request(role, `${endpoint}/${randomUUID()}/close`, closure)).status).toBe(expected);
    }
  });
  it("rejects inactive or unrelated staff and permits scoped staff and admin", async () => {
    expect((await request("loa")).status).toBe(404);
    expect((await request("loa", endpoint, observation)).status).toBe(404);
    expect((await request("lo", `/api/loan-applications/${otherApplicationId}/work-waits`)).status).toBe(404);
    for (const role of ["lo", "processor", "underwriter", "closer", "admin"]) expect((await request(role)).status).toBe(200);
    await pool.query("UPDATE loan_applications SET loan_officer_id='test-loa' WHERE id=$1", [otherApplicationId]);
    expect((await request("loa", `/api/loan-applications/${otherApplicationId}/work-waits`)).status).toBe(200);
  });
  it("validates references, chronology, pagination and rejects unrecognized writable fields", async () => {
    expect((await request("lo", endpoint, { ...observation, taskId: otherTaskId })).status).toBe(404);
    for (const changes of [{ startedAt: "2099-01-01T00:00:00Z", promisedAt: null }, { promisedAt: "not-a-date" }, { counterparty: "unknown" }, { recordedBy: "test-admin" }]) {
      expect((await request("lo", endpoint, { ...observation, ...changes })).status).toBe(400);
    }
    expect((await request("lo", `${endpoint}?limit=101`)).status).toBe(400);
    expect((await request("lo", `${endpoint}?afterId=invalid`)).status).toBe(400);
  });
  it("records one wait and one audit entry across simultaneous retries", async () => {
    const responses = await Promise.all([request("lo", endpoint, observation), request("lo", endpoint, observation)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 201]);
    const results = await Promise.all(responses.map(r => r.json()));
    expect(results[0].wait.id).toBe(results[1].wait.id); waitId = results[0].wait.id;
    expect(results[0].wait).toMatchObject({ recordedBy: "test-lo", promisedAt, closedAt: null });
    const audit = await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE target_id=$1 AND action='work_wait.recorded'", [applicationId]);
    expect(audit.rows[0].count).toBe(1);
    expect((await request("lo", endpoint, { ...observation, promisedAt: null })).status).toBe(409);
    expect((await request("lo", endpoint, { ...observation, startEventId: randomUUID() })).status).toBe(409);
    const retry = await request("lo", endpoint, { ...observation, startedAt: "2026-01-01T05:00:00-05:00" });
    expect(retry.status).toBe(200);
  });
  it("measures open waits at one stated instant without disclosing task or document text", async () => {
    const response = await request("lo"); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const data = await response.json(); expect(data.waits).toHaveLength(1);
    expect(data.waits[0].elapsedMs).toBe(Date.parse(data.asOf) - Date.parse(startedAt));
    expect(JSON.stringify(data)).not.toMatch(/Fictional|objects|storagePath|fileName/);
  });
  it("rejects a foreign wait, foreign evidence, invalid closure and revoked access", async () => {
    expect((await request("admin", `/api/loan-applications/${otherApplicationId}/work-waits/${waitId}/close`, closure)).status).toBe(404);
    expect((await request("lo", `${endpoint}/${waitId}/close`, { ...closure, documentId: otherDocumentId })).status).toBe(404);
    for (const closedAt of ["2025-01-01T00:00:00Z", "2099-01-01T00:00:00Z"]) {
      expect((await request("lo", `${endpoint}/${waitId}/close`, { ...closure, closedAt })).status).toBe(400);
    }
    await pool.query("UPDATE deal_team_members SET is_active=false WHERE application_id=$1 AND user_id='test-lo'", [applicationId]);
    try {
      expect((await request("lo")).status).toBe(404);
      expect((await request("lo", `${endpoint}/${waitId}/close`, closure)).status).toBe(404);
    } finally {
      await pool.query("UPDATE deal_team_members SET is_active=true WHERE application_id=$1 AND user_id='test-lo'", [applicationId]);
    }
  });
  it("freezes elapsed time on closure, preserving one closure and its audit under retries", async () => {
    const responses = await Promise.all([request("lo", `${endpoint}/${waitId}/close`, closure), request("processor", `${endpoint}/${waitId}/close`, closure)]);
    for (const response of responses) expect(response.status).toBe(200);
    const results = await Promise.all(responses.map(r => r.json()));
    expect(results.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(results[0].wait.elapsedMs).toBe(172_800_000);
    expect(results[0].wait.closedBy).toBe(results[1].wait.closedBy);
    const audit = await pool.query("SELECT count(*)::int AS count FROM audit_logs WHERE target_id=$1 AND action='work_wait.closed'", [applicationId]);
    expect(audit.rows[0].count).toBe(1);
    expect((await request("lo", `${endpoint}/${waitId}/close`, { ...closure, outcome: "cancelled" })).status).toBe(409);
    expect((await request("lo", `${endpoint}/${waitId}/close`, { ...closure, closingEventId: randomUUID() })).status).toBe(409);
    const replay = await (await request("lo", endpoint, observation)).json();
    expect(replay.replayed).toBe(true); expect(replay.wait.elapsedMs).toBe(172_800_000);
  });
  it("records subsequent cycles and parallel counterparties without reusing a closing event", async () => {
    expect((await request("lo", endpoint, { ...observation, startEventId: randomUUID() })).status).toBe(409);
    const next = await request("lo", endpoint, { ...observation, startEventId: randomUUID(), startedAt: closedAt, promisedAt: null });
    expect(next.status).toBe(201); const nextId = (await next.json()).wait.id; expect(nextId).not.toBe(waitId);
    expect((await request("lo", `${endpoint}/${nextId}/close`, closure)).status).toBe(409);
    expect((await request("lo", `${endpoint}/${nextId}/close`, { closingEventId: randomUUID(), closedAt, outcome: "superseded" })).status).toBe(200);
    expect((await request("lo", endpoint, { ...observation, startEventId: randomUUID(), counterparty: "lender" })).status).toBe(201);
    expect((await request("lo", endpoint, { ...observation, startEventId: randomUUID(), counterparty: "title" })).status).toBe(201);
    const ids: string[] = []; let cursor: string | null = null;
    do {
      const page = await (await request("lo", `${endpoint}?limit=1${cursor ? `&afterId=${cursor}` : ""}`)).json();
      ids.push(...page.waits.map((w: { id: string }) => w.id)); cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(4); expect(new Set(ids).size).toBe(4);
  });
  it("keeps loan state, task status, evidence verification and borrower notifications unchanged", async () => {
    expect(await counts()).toEqual(initialState);
  });
  it("scopes event identifiers to the application", async () => {
    const otherEndpoint = `/api/loan-applications/${otherApplicationId}/work-waits`;
    const response = await request("admin", otherEndpoint, { ...observation, taskId: otherTaskId });
    expect(response.status).toBe(201);
    const otherWait = (await response.json()).wait;
    expect(otherWait.id).not.toBe(waitId);
    expect((await request("admin", `${otherEndpoint}/${otherWait.id}/close`, { ...closure, documentId: otherDocumentId })).status).toBe(200);
  });
  it("preserves an already-overdue promise when a later wait cycle starts", async () => {
    const response = await request("lo", endpoint, { ...observation, startEventId: randomUUID(), startedAt: closedAt });
    expect(response.status).toBe(201);
    expect((await response.json()).wait).toMatchObject({ startedAt: closedAt, promisedAt });
  });
  it("allows only one competing opening and one competing closure to win", async () => {
    const openings = await Promise.all([0, 1].map(() => request("lo", endpoint, {
      ...observation, counterparty: "internal", startEventId: randomUUID(),
    })));
    expect(openings.map(r => r.status).sort()).toEqual([201, 409]);
    const winner = await openings.find(r => r.status === 201)!.json();
    const closings = await Promise.all([0, 1].map(() => request("lo", `${endpoint}/${winner.wait.id}/close`, {
      closingEventId: randomUUID(), closedAt, outcome: "cancelled",
    })));
    expect(closings.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it("rolls back the observation if its audit write fails", async () => {
    const suffix = randomUUID().replaceAll("-", ""), trigger = `wait_audit_failure_${suffix}`;
    const eventId = randomUUID();
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='work_wait.recorded' AND NEW.target_id='${applicationId}'
        THEN RAISE EXCEPTION 'Fictional audit failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
    try {
      const response = await request("lo", endpoint, { ...observation, counterparty: "vendor", startEventId: eventId });
      expect(response.status).toBe(500);
      const rows = await pool.query("SELECT id FROM work_waits WHERE application_id=$1 AND start_event_id=$2", [applicationId, eventId]);
      expect(rows.rows).toHaveLength(0);
    } finally {
      await pool.query(`DROP TRIGGER ${trigger} ON audit_logs`);
      await pool.query(`DROP FUNCTION ${trigger}()`);
    }
    expect((await request("lo", endpoint, { ...observation, counterparty: "vendor", startEventId: eventId })).status).toBe(201);
    expect(await counts()).toEqual(initialState);
  });
});
