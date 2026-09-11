import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { BASE_URL } from "./setup";

const appId = randomUUID(), otherAppId = randomUUID(), documentId = randomUUID(), factId = randomUUID();
let borrowerId = randomUUID();
const coBorrowerId = randomUUID();
const businessId = randomUUID(), outsiderBusinessId = randomUUID(), propertyId = randomUUID();
let replacementDocumentId: string | null = null;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const cookies: Record<string, string> = {};
const endpoint = `/api/loan-applications/${appId}/file-review`;
async function request(role: string, path = endpoint, body?: unknown) {
  return fetch(`${BASE_URL}${path}`, { method: body === undefined ? "GET" : "POST", headers: {
    Cookie: cookies[role] ?? "", Origin: BASE_URL, "Content-Type": "application/json",
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function current() { const response = await request("lo"); expect(response.status).toBe(200); return response.json(); }
async function save(revision: string, role = "lo") { return request(role, endpoint, { expectedRevision: revision, acknowledged: true }); }
async function patchLineage(role: string, applicationId: string, targetDocumentId: string, body: unknown) {
  return fetch(`${BASE_URL}/api/loan-applications/${applicationId}/documents/${targetDocumentId}/lineage`, {
    method: "PATCH",
    headers: { Cookie: cookies[role] ?? "", Origin: BASE_URL, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // This suite creates only fictional records in the disposable local/CI database.
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("File review fixtures require a local test database");
  for (const role of ["admin", "lo", "loa", "closer", "buyer", "broker", "lender"]) {
    const response = await fetch(`${BASE_URL}/api/test-login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE_URL }, body: JSON.stringify({ email: `${role}@test.com`, password: process.env.DEV_TEST_PASSWORD || "test1234" }) });
    expect(response.status).toBe(200); cookies[role] = response.headers.get("set-cookie")!.split(";")[0];
  }
  // Intake resumes the shared test buyer's newest draft. Give this suite its own
  // borrower so parallel intake cannot resume a fixture that afterAll removes.
  const registration = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({
      email: `file-review-${borrowerId}@example.test`,
      password: `Review-${borrowerId}`,
      firstName: "Fictional",
      lastName: "Borrower",
    }),
  });
  expect(registration.status).toBe(200);
  const registered = await registration.json();
  borrowerId = registered.user.id;
  cookies.borrower = registration.headers.get("set-cookie")!.split(";")[0];
  await pool.query("INSERT INTO users (id,email,first_name,last_name,role) VALUES ($1,$2,'Casey','Co-borrower','buyer')", [coBorrowerId, `file-review-${coBorrowerId}@example.test`]);
  await pool.query("INSERT INTO borrower_profiles (user_id,has_co_borrower,co_borrower_user_id) VALUES ($1,true,$2)", [borrowerId, coBorrowerId]);
  await pool.query("INSERT INTO loan_applications (id,user_id,status,income_sources) VALUES ($1,$3,'draft',$4::jsonb),($2,$3,'draft','[]'::jsonb)", [appId, otherAppId, borrowerId, JSON.stringify([{
    type: "self_employed",
    annualAmount: "42000",
    employerName: "Reported Design LLC",
    businessStructure: "single_member_llc",
    ownershipPercent: "100",
  }])]);
  await pool.query("INSERT INTO deal_team_members (application_id,user_id,team_role,is_active) VALUES ($1,'test-lo','lo',true),($1,'test-closer','closer',true),($1,'test-broker','broker',true),($1,'test-lender','lender',true)", [appId]);
  await pool.query("INSERT INTO documents (id,application_id,user_id,document_type,file_name,storage_path,status) VALUES ($1,$2,$3,'business_bank_statement','Fictional statement.pdf','/objects/fictional-file-review','uploaded')", [documentId, appId, borrowerId]);
  await pool.query("INSERT INTO extracted_fields (id,document_id,field_name,value_numeric,value_type,confidence,extraction_method) VALUES ($1,$2,'closing_balance','3000','currency','0.9','fixture')", [factId, documentId]);
  await pool.query("INSERT INTO borrower_business_entities (id,user_id,application_id,identity_key,entity_type,name) VALUES ($1,$2,$3,$4,'s_corporation','Fictional Consulting Inc.'),($5,'test-lo',$3,$6,'sole_proprietorship','Outside Business')", [businessId, borrowerId, otherAppId, `name:fictional-${businessId}`, outsiderBusinessId, `name:outside-${outsiderBusinessId}`]);
  await pool.query("INSERT INTO application_properties (id,application_id,address,purchase_price) VALUES ($1,$2,'100 Fictional Way','500000')", [propertyId, appId]);
});
afterAll(async () => {
  await pool.query("DELETE FROM file_review_checkpoints WHERE application_id IN ($1,$2)", [appId, otherAppId]);
  await pool.query("DELETE FROM audit_logs WHERE target_id=ANY($1::varchar[])", [[appId, otherAppId, documentId, replacementDocumentId].filter(Boolean)]);
  await pool.query("DELETE FROM extracted_fields WHERE id=$1", [factId]);
  await pool.query("DELETE FROM document_lineage WHERE application_id IN ($1,$2)", [appId, otherAppId]);
  await pool.query("DELETE FROM deal_activities WHERE application_id IN ($1,$2)", [appId, otherAppId]);
  await pool.query("DELETE FROM task_events WHERE application_id IN ($1,$2)", [appId, otherAppId]);
  await pool.query("DELETE FROM task_documents WHERE task_id IN (SELECT id FROM tasks WHERE application_id IN ($1,$2))", [appId, otherAppId]);
  await pool.query("DELETE FROM task_audit_log WHERE task_id IN (SELECT id FROM tasks WHERE application_id IN ($1,$2))", [appId, otherAppId]);
  await pool.query("DELETE FROM tasks WHERE application_id IN ($1,$2)", [appId, otherAppId]);
  await pool.query("DELETE FROM analytics_events WHERE application_id IN ($1,$2)", [appId, otherAppId]);
  await pool.query("DELETE FROM document_extraction_jobs WHERE document_id=ANY($1::varchar[])", [[documentId, replacementDocumentId].filter(Boolean)]);
  if (replacementDocumentId) await pool.query("DELETE FROM documents WHERE id=$1", [replacementDocumentId]);
  await pool.query("DELETE FROM documents WHERE id=$1", [documentId]);
  await pool.query("DELETE FROM borrower_business_entities WHERE user_id=$1 OR id=ANY($2::varchar[])", [borrowerId, [businessId, outsiderBusinessId]]);
  await pool.query("DELETE FROM application_properties WHERE id=$1", [propertyId]);
  await pool.query("DELETE FROM deal_team_members WHERE application_id IN ($1,$2)", [appId, otherAppId]);
  await pool.query("DELETE FROM loan_applications WHERE id IN ($1,$2)", [appId, otherAppId]);
  await pool.query("DELETE FROM borrower_profiles WHERE user_id=$1", [borrowerId]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::varchar[])", [[borrowerId, coBorrowerId]]);
  await pool.end();
});

describe.sequential("Core review inside the existing authenticated loan file", () => {
  it("requires a signed-in session", async () => { expect((await request("anonymous")).status).toBe(401); });
  it.each(["buyer", "broker", "lender"])("denies the %s role", async role => { expect((await request(role)).status).toBe(403); });
  it("denies an officer outside the deal team", async () => { expect((await request("loa")).status).toBe(404); });
  it("enforces exact application membership and read-only closer access", async () => {
    expect((await request("lo", `/api/loan-applications/${otherAppId}/file-review`)).status).toBe(404);
    const view = await current(); expect(view.manifest.documents.count).toBe(1); expect(view.manifest.facts.count).toBe(1);
    expect(view.documents[0].name).toBe("Fictional statement.pdf");
    expect(view.documents[0].lineage.needsAssignment).toBe(true);
    expect(view.subjectOptions.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([appId, borrowerId, coBorrowerId, businessId, propertyId]));
    expect(view.subjectOptions.map((row: { label: string }) => row.label)).toContain("Reported Design LLC");
    expect(view.subjectOptions.map((row: { id: string }) => row.id)).not.toContain(outsiderBusinessId);
    expect(JSON.stringify(view)).not.toContain("/objects/fictional");
    const closer = await (await request("closer")).json(); expect(closer.canSave).toBe(false);
    expect((await save(view.revision, "closer")).status).toBe(403);
  });
  it("records an application-scoped subject and period with reviewer-only access", async () => {
    const body = { subjectType: "business", subjectId: businessId, periodStart: "2026-01-01", periodEnd: "2026-06-30", taxYear: 2026 };
    expect((await patchLineage("buyer", appId, documentId, body)).status).toBe(403);
    expect((await patchLineage("loa", appId, documentId, body)).status).toBe(404);
    expect((await patchLineage("lo", appId, documentId, { ...body, subjectType: "application", subjectId: otherAppId })).status).toBe(400);
    expect((await patchLineage("lo", appId, documentId, { ...body, subjectId: outsiderBusinessId })).status).toBe(400);
    expect((await patchLineage("lo", appId, documentId, { ...body, subjectType: "borrower", subjectId: coBorrowerId })).status).toBe(200);
    expect((await current()).documents[0].lineage.subjectLabel).toBe("Casey Co-borrower");
    expect((await patchLineage("lo", appId, documentId, { ...body, subjectType: "property", subjectId: propertyId })).status).toBe(200);
    expect((await current()).documents[0].lineage.subjectLabel).toBe("100 Fictional Way");
    expect((await patchLineage("lo", appId, documentId, body)).status).toBe(200);
    const view = await current();
    expect(view.documents[0].lineage).toMatchObject({
      versionNumber: 1,
      subjectType: "business",
      subjectId: businessId,
      subjectLabel: "Fictional Consulting Inc.",
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
      taxYear: 2026,
      needsAssignment: false,
    });
  });
  it("does not mistake an empty application for a reviewed file", async () => {
    const response = await request("admin", `/api/loan-applications/${otherAppId}/file-review`);
    const data = await response.json(); expect(data.canSave).toBe(false);
    expect((await request("admin", `/api/loan-applications/${otherAppId}/file-review`, { acknowledged: true, expectedRevision: data.revision })).status).toBe(409);
  });
  it("persists one review and its audit record without verifying outstanding documents or values", async () => {
    const before = await current();
    expect((await request("lo", endpoint, { expectedRevision: before.revision })).status).toBe(400);
    expect((await save(before.revision)).status).toBe(201);
    expect((await save(before.revision)).status).toBe(200);
    const after = await current(); expect(after.checkpoints).toHaveLength(1); expect(after.checkpoints[0].isStale).toBe(false);
    expect(after.unreviewedDocumentCount).toBe(1); expect(after.unreviewedFactCount).toBe(1);
    const audit = await pool.query("SELECT count(*) FROM audit_logs WHERE target_id=$1 AND action='file_review.checkpoint_recorded'", [appId]); expect(Number(audit.rows[0].count)).toBe(1);
  });
  it("rejects stale saves and retains the older review after document and value changes", async () => {
    const before = await current();
    await pool.query("UPDATE documents SET status='verified',reviewed_by_user_id='test-lo',reviewed_at=now(),updated_at=now() WHERE id=$1", [documentId]);
    await pool.query("UPDATE extracted_fields SET value_numeric='3500' WHERE id=$1", [factId]);
    expect((await save(before.revision)).status).toBe(409);
    const changed = await current(); expect(changed.checkpoints[0].isStale).toBe(true);
    expect(changed.checkpoints[0].staleReasons).toContain("Uploaded documents changed after this review.");
    expect(changed.checkpoints[0].staleReasons).toContain("Extracted values changed after this review.");
    expect((await save(changed.revision)).status).toBe(201);
    const after = await current(); expect(after.checkpoints).toHaveLength(2); expect(after.checkpoints[0].version).toBe(2);
    expect(after.checkpoints[0].isStale).toBe(false); expect(after.checkpoints[1].isStale).toBe(true);
  });
  it("handles simultaneous saves without duplicate history or an internal error", async () => {
    await pool.query("UPDATE extracted_fields SET value_numeric='3700' WHERE id=$1", [factId]);
    const view = await current();

    // Presence/login traffic updates users.last_active_at. A checkpoint insert
    // references the reviewer row, so PostgreSQL aborts a repeatable-read
    // transaction with 40001 when that update commits after its snapshot but
    // before the FK check. Hold both saves at their application lock, commit a
    // presence update, then release them to reproduce the exact CI collision.
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM loan_applications WHERE id=$1 FOR UPDATE", [appId]);
    const saves = Promise.all([save(view.revision), save(view.revision)]);
    let observedBlockedSave = false;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const active = await pool.query<{ count: number }>(`
          SELECT count(*)::int AS count
          FROM pg_stat_activity
          WHERE datname=current_database()
            AND pid <> pg_backend_pid()
            AND state <> 'idle'
            AND wait_event_type='Lock'
            -- pg_stat_activity truncates this wide SELECT before its FROM;
            -- the stable leading projection identifies loadSources' app lock.
            AND query LIKE 'select "id", "user_id", "status", "financial_data_provenance"%'
        `);
        if (active.rows[0].count > 0) {
          observedBlockedSave = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await pool.query("UPDATE users SET last_active_at=now() WHERE id='test-lo'");
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    const responses = await saves;
    expect(
      observedBlockedSave,
      "a save established its snapshot before presence changed",
    ).toBe(true);
    expect(responses.map(response => response.status)).toContain(201);
    for (const response of responses) expect([200, 201, 409]).toContain(response.status);
    expect((await current()).checkpoints).toHaveLength(3);
  });
  it("includes both extraction paths and excludes contradictory application references", async () => {
    const foreignDoc = randomUUID();
    const forms = Array.from({ length: 4 }, () => randomUUID());
    const facts = Array.from({ length: 4 }, () => randomUUID());
    try {
      await pool.query("INSERT INTO documents (id,application_id,user_id,document_type,file_name,storage_path) VALUES ($1,$2,$3,'other','Other file.pdf','/objects/fictional-other-review')", [foreignDoc, otherAppId, borrowerId]);
      await pool.query(`INSERT INTO logical_documents (id,loan_id,source_document_id,borrower_id,document_type,aggregated_confidence) VALUES
        ($1,$5,NULL,$9,'w2','0.9'),
        ($2,NULL,$7,$9,'w2','0.9'),
        ($3,$6,$7,$9,'w2','0.9'),
        ($4,$5,$8,$9,'w2','0.9')`, [...forms, appId, otherAppId, documentId, foreignDoc, borrowerId]);
      await pool.query(`INSERT INTO extracted_fields (id,document_id,logical_document_id,field_name,value_type,confidence,extraction_method) VALUES
        ($1,NULL,$5,'wages','currency','0.9','fixture'),
        ($2,$8,$6,'wages','currency','0.9','fixture'),
        ($3,$8,$7,'wages','currency','0.9','fixture'),
        ($4,$9,$5,'wages','currency','0.9','fixture')`, [...facts, ...forms.slice(0, 3), documentId, foreignDoc]);
      const view = await current();
      expect(view.manifest.documents.count).toBe(1);
      expect(view.manifest.forms.count).toBe(2);
      expect(view.manifest.facts.count).toBe(3);
    } finally {
      await pool.query("DELETE FROM extracted_fields WHERE id=ANY($1::varchar[])", [facts]);
      await pool.query("DELETE FROM logical_documents WHERE id=ANY($1::varchar[])", [forms]);
      await pool.query("DELETE FROM documents WHERE id=$1", [foreignDoc]);
    }
  });
  it.each(["broker", "lender"])("does not let an assigned %s replace borrower-owned evidence", async role => {
    const fileName = `Unauthorized ${role} replacement.pdf`;
    const response = await request(role, "/api/documents/upload", {
      objectPath: `/objects/fictional-${role}-replacement-${randomUUID()}`,
      fileName,
      fileSize: 128,
      mimeType: "application/pdf",
      documentType: "business_bank_statement",
      applicationId: appId,
      replacesDocumentId: documentId,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "The document to replace is not available" });
    const inserted = await pool.query("SELECT id FROM documents WHERE file_name=$1", [fileName]);
    expect(inserted.rowCount).toBe(0);
  });
  it("keeps a replacement in the same lineage and invalidates only its current evidence", async () => {
    const before = await current();
    const bytes = Buffer.from("%PDF-1.4\nfictional replacement\n%%EOF");
    const targetResponse = await request("lo", "/api/uploads/request-url", {
      name: "Fictional statement replacement.pdf",
      size: bytes.length,
      contentType: "application/pdf",
    });
    expect(targetResponse.status).toBe(200);
    const target = await targetResponse.json();
    const stored = await fetch(`${BASE_URL}${target.uploadURL}`, {
      method: "PUT",
      headers: { Cookie: cookies.lo, Origin: BASE_URL, "Content-Type": "application/pdf" },
      body: bytes,
    });
    expect(stored.status).toBe(200);
    const registered = await request("lo", "/api/documents/upload", {
      objectPath: target.objectPath,
      fileName: "Fictional statement replacement.pdf",
      fileSize: bytes.length,
      mimeType: "application/pdf",
      documentType: "business_bank_statement",
      applicationId: appId,
      replacesDocumentId: documentId,
    });
    expect(registered.status).toBe(201);
    replacementDocumentId = (await registered.json()).id;

    const changed = await current();
    expect(changed.manifest.documents.count).toBe(1);
    expect(changed.manifest.facts.count).toBe(0);
    expect(changed.documents).toHaveLength(1);
    expect(changed.documents[0]).toMatchObject({ id: replacementDocumentId, name: "Fictional statement replacement.pdf" });
    expect(changed.documents[0].lineage).toMatchObject({
      versionNumber: 2,
      subjectType: "business",
      subjectId: businessId,
      contentFingerprintRecorded: true,
      changedSinceLatestReview: true,
    });
    expect(changed.documents[0].lineage.history).toHaveLength(2);
    expect(changed.checkpoints[0].isStale).toBe(true);
    expect(changed.checkpoints[0].staleReasons).toEqual(expect.arrayContaining([
      "Uploaded documents changed after this review.",
      "Extracted values changed after this review.",
    ]));
    expect(changed.checkpoints[0].changedDocumentLineageIds).toEqual([documentId]);
    expect((await save(before.revision)).status).toBe(409);
    expect((await patchLineage("lo", appId, documentId, {
      subjectType: "application", subjectId: appId, periodStart: null, periodEnd: null, taxYear: null,
    })).status).toBe(409);
    const applicationDetail = await (await request("lo", `/api/loan-applications/${appId}`)).json();
    expect(applicationDetail.documents.map((row: { id: string }) => row.id)).toEqual([replacementDocumentId]);

    // User-scoped reads start from borrower-owned rows. They must still expand
    // the visible lineage and return the staff-owned current version. Resolve
    // lineage before status filtering so an uploaded v1 cannot remain pending
    // after a verified v2 replaces it.
    await pool.query("UPDATE documents SET status='uploaded' WHERE id=$1", [documentId]);
    await pool.query("UPDATE documents SET status='verified' WHERE id=$1", [replacementDocumentId]);
    const dashboardResponse = await request("borrower", "/api/dashboard");
    expect(dashboardResponse.status).toBe(200);
    const dashboard = await dashboardResponse.json();
    expect(dashboard.documents.map((row: { id: string }) => row.id)).toContain(replacementDocumentId);
    expect(dashboard.documents.map((row: { id: string }) => row.id)).not.toContain(documentId);
    expect(dashboard.stats.pendingDocuments).toBe(0);
  });
  it("preserves history but does not save new reviews on a closed application", async () => {
    await pool.query("UPDATE loan_applications SET status='funded' WHERE id=$1", [appId]);
    const view = await current();
    expect(view.checkpoints).toHaveLength(3); expect(view.canSave).toBe(false);
    expect((await save(view.revision)).status).toBe(409);
  });
  it("revokes review access when the deal-team membership is removed", async () => {
    await pool.query("UPDATE deal_team_members SET is_active=false WHERE application_id=$1 AND user_id='test-lo'", [appId]);
    expect((await request("lo")).status).toBe(404); expect((await save("a".repeat(64))).status).toBe(404);
  });
});
