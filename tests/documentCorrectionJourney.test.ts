import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { BASE_URL } from "./setup";
import { getLatestInstancesForUser } from "../server/services/taxDocumentIntelligence";
import { buildBorrowerGraph } from "../server/services/borrowerGraph";

const applicationId = randomUUID();
const otherApplicationId = randomUUID();
const firstConditionId = randomUUID();
const secondConditionId = randomUUID();
const supersededConditionId = randomUUID();
let borrowerId = "";
let borrowerCookie = "";
let loanOfficerCookie = "";
let requestMessageId = "";
let firstDocumentId = "";
let replacementDocumentId = "";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function cookie(response: Response): string {
  return response.headers.get("set-cookie")!.split(";")[0];
}

async function jsonRequest(
  sessionCookie: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
) {
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Cookie: sessionCookie,
      Origin: BASE_URL,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function uploadRequestedDocument(input: {
  fileName: string;
  replacesDocumentId?: string;
  includeRequestMessageId?: boolean;
}) {
  const bytes = Buffer.from(`%PDF-1.4\nfictional ${input.fileName}\n%%EOF`);
  const targetResponse = await jsonRequest(
    borrowerCookie,
    "POST",
    "/api/uploads/request-url",
    { name: input.fileName, size: bytes.length, contentType: "application/pdf" },
  );
  expect(targetResponse.status).toBe(200);
  const target = await targetResponse.json();
  const stored = await fetch(`${BASE_URL}${target.uploadURL}`, {
    method: "PUT",
    headers: {
      Cookie: borrowerCookie,
      Origin: BASE_URL,
      "Content-Type": "application/pdf",
    },
    body: bytes,
  });
  expect(stored.status).toBe(200);
  const registered = await jsonRequest(
    borrowerCookie,
    "POST",
    "/api/documents/upload",
    {
      objectPath: target.objectPath,
      fileName: input.fileName,
      fileSize: bytes.length,
      mimeType: "application/pdf",
      documentType: "drivers_license",
      applicationId,
      ...(input.includeRequestMessageId === false ? {} : { requestMessageId }),
      ...(input.replacesDocumentId
        ? { replacesDocumentId: input.replacesDocumentId }
        : {}),
    },
  );
  expect(registered.status).toBe(201);
  return registered.json();
}

async function uploadStandaloneDocument(
  fileName: string,
  documentType: string,
  replacesDocumentId?: string,
) {
  const bytes = Buffer.from(`%PDF-1.4\nfictional ${fileName}\n%%EOF`);
  const targetResponse = await jsonRequest(
    borrowerCookie,
    "POST",
    "/api/uploads/request-url",
    { name: fileName, size: bytes.length, contentType: "application/pdf" },
  );
  expect(targetResponse.status).toBe(200);
  const target = await targetResponse.json();
  const stored = await fetch(`${BASE_URL}${target.uploadURL}`, {
    method: "PUT",
    headers: {
      Cookie: borrowerCookie,
      Origin: BASE_URL,
      "Content-Type": "application/pdf",
    },
    body: bytes,
  });
  expect(stored.status).toBe(200);
  const registered = await jsonRequest(
    borrowerCookie,
    "POST",
    "/api/documents/upload",
    {
      objectPath: target.objectPath,
      fileName,
      fileSize: bytes.length,
      mimeType: "application/pdf",
      documentType,
      applicationId,
      ...(replacesDocumentId ? { replacesDocumentId } : {}),
    },
  );
  expect(registered.status).toBe(201);
  return registered.json();
}

async function conversation() {
  const response = await jsonRequest(
    borrowerCookie,
    "GET",
    "/api/messages/test-lo",
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<Array<Record<string, any>>>;
}

async function currentRequest() {
  const message = (await conversation()).find((row) => row.id === requestMessageId);
  expect(message).toBeTruthy();
  return message!;
}

beforeAll(async () => {
  // These records and bytes are fictional and live only in the disposable
  // local/CI database and local object directory.
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Correction journey fixtures require a local test database");
  }

  const registration = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({
      email: `correction-journey-${randomUUID()}@example.test`,
      password: `Correction-${randomUUID()}!`,
      firstName: "Fictional",
      lastName: "Borrower",
    }),
  });
  expect(registration.status).toBe(200);
  const registered = await registration.json();
  borrowerId = registered.user.id;
  borrowerCookie = cookie(registration);

  const loanOfficerLogin = await fetch(`${BASE_URL}/api/test-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({
      email: "lo@test.com",
      password: process.env.DEV_TEST_PASSWORD || "test1234",
    }),
  });
  expect(loanOfficerLogin.status).toBe(200);
  loanOfficerCookie = cookie(loanOfficerLogin);

  await pool.query(
    `INSERT INTO loan_applications
      (id,user_id,status,loan_officer_id,annual_income,monthly_debts,credit_score,
       employment_type,purchase_price,down_payment,loan_purpose)
     VALUES ($1,$2,'underwriting','test-lo','144000','1800',748,
       'w2','625000','125000','purchase')`,
    [applicationId, borrowerId],
  );
  await pool.query(
    `INSERT INTO loan_applications
      (id,user_id,status,loan_officer_id,annual_income,monthly_debts,credit_score,
       employment_type,purchase_price,down_payment,loan_purpose)
     VALUES ($1,$2,'underwriting','test-lo','144000','1800',748,
       'w2','625000','125000','purchase')`,
    [otherApplicationId, borrowerId],
  );
  await pool.query(
    `INSERT INTO deal_team_members (application_id,user_id,team_role,is_active)
     VALUES ($1,'test-lo','lo',true),($2,'test-lo','lo',true)`,
    [applicationId, otherApplicationId],
  );
  await pool.query(
    `INSERT INTO loan_conditions
      (id,application_id,category,title,description,priority,status,required_document_types,created_at)
     VALUES
      ($1,$3,'compliance','Government-issued photo ID','Upload a readable current ID.','prior_to_docs','outstanding',ARRAY['government_id'],CURRENT_TIMESTAMP),
      ($2,$3,'compliance','Identity verification','The same ID satisfies this verification item.','prior_to_docs','outstanding',ARRAY['drivers_license'],CURRENT_TIMESTAMP - interval '1 millisecond')`,
    [firstConditionId, secondConditionId, applicationId],
  );
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe.sequential("borrower correction journey", () => {
  it("preserves the application while one request moves through reject, replacement, and approval", async () => {
    const stableAnswers = await pool.query(
      `SELECT annual_income,monthly_debts,credit_score,employment_type,
              purchase_price,down_payment,loan_purpose
         FROM loan_applications WHERE id=$1`,
      [applicationId],
    );

    // Two staff tabs can approve equivalent labels at the same moment. The
    // advisory lock must converge both sends on one borrower request.
    const [firstSend, secondSend] = await Promise.all([
      jsonRequest(loanOfficerCookie, "POST", "/api/messages", {
        recipientId: borrowerId,
        applicationId,
        message: "Document Request: Government-issued photo ID",
        messageType: "document_request",
        documentRequestData: {
          documentType: "government_id",
          documentName: "Government-issued photo ID",
          description: "Upload a clear image showing all four corners.",
          status: "pending",
        },
      }),
      jsonRequest(loanOfficerCookie, "POST", "/api/messages", {
        recipientId: borrowerId,
        applicationId,
        message: "Document Request: Driver license",
        messageType: "document_request",
        documentRequestData: {
          documentType: "drivers_license",
          documentName: "Driver license",
          status: "pending",
        },
      }),
    ]);
    expect([firstSend.status, secondSend.status].sort()).toEqual([200, 201]);
    const [firstSendBody, secondSendBody] = await Promise.all([
      firstSend.json(),
      secondSend.json(),
    ]);
    const createdBody = firstSend.status === 201 ? firstSendBody : secondSendBody;
    const duplicateBody = firstSend.status === 200 ? firstSendBody : secondSendBody;
    requestMessageId = createdBody.id;
    expect(createdBody.documentRequestData).toMatchObject({ documentType: "government_id" });
    expect(duplicateBody).toMatchObject({ id: requestMessageId, deduplicated: true });
    const requestCount = await pool.query(
      "SELECT count(*) FROM team_messages WHERE application_id=$1 AND message_type='document_request'",
      [applicationId],
    );
    expect(Number(requestCount.rows[0].count)).toBe(1);

    const initialChecklistResponse = await jsonRequest(
      borrowerCookie,
      "GET",
      `/api/applications/${applicationId}/document-checklist`,
    );
    expect(initialChecklistResponse.status).toBe(200);
    const initialChecklist = await initialChecklistResponse.json();
    expect(initialChecklist.personalized).toBe(true);
    expect(initialChecklist.documents).toHaveLength(1);
    expect(initialChecklist.documents[0].conditionIds).toEqual([
      firstConditionId,
      secondConditionId,
    ]);
    expect(initialChecklist.documents[0].status).toBe("needed");

    const pendingBeforeUpload = await jsonRequest(
      borrowerCookie,
      "GET",
      "/api/messages/document-requests/pending",
    );
    expect(pendingBeforeUpload.status).toBe(200);
    expect((await pendingBeforeUpload.json()).map((row: any) => row.id)).toContain(
      requestMessageId,
    );

    const firstDocument = await uploadRequestedDocument({
      fileName: "Fictional license.pdf",
    });
    firstDocumentId = firstDocument.id;
    expect((await currentRequest()).documentRequestData).toMatchObject({
      status: "submitted",
      documentId: firstDocumentId,
    });
    const inReviewChecklistResponse = await jsonRequest(
      borrowerCookie,
      "GET",
      `/api/applications/${applicationId}/document-checklist`,
    );
    expect(inReviewChecklistResponse.status).toBe(200);
    const inReviewChecklist = await inReviewChecklistResponse.json();
    expect(inReviewChecklist.documents).toHaveLength(1);
    expect(inReviewChecklist.documents[0].source).toBe("condition");
    const actionItemsResponse = await jsonRequest(
      borrowerCookie,
      "GET",
      `/api/applications/${applicationId}/action-items`,
    );
    expect(actionItemsResponse.status).toBe(200);
    expect(JSON.stringify(await actionItemsResponse.json())).not.toContain(
      "Review uploaded drivers license",
    );

    const vagueRejection = await jsonRequest(
      loanOfficerCookie,
      "POST",
      `/api/documents/${firstDocumentId}/verify`,
      { status: "rejected", reason: "Blurry" },
    );
    expect(vagueRejection.status).toBe(400);
    expect((await currentRequest()).documentRequestData.status).toBe("submitted");

    const rejected = await jsonRequest(
      loanOfficerCookie,
      "POST",
      `/api/documents/${firstDocumentId}/verify`,
      {
        status: "rejected",
        reason: "Upload the full front side; the expiration date is cropped out.",
      },
    );
    expect(rejected.status).toBe(200);
    const rejectedRequest = await currentRequest();
    expect(rejectedRequest.documentRequestData).toMatchObject({
      status: "rejected",
      documentId: firstDocumentId,
      rejectionReason: "Upload the full front side; the expiration date is cropped out.",
    });
    const conditionsAfterRejection = await pool.query(
      "SELECT status FROM loan_conditions WHERE application_id=$1 ORDER BY id",
      [applicationId],
    );
    expect(conditionsAfterRejection.rows.every((row) => row.status === "outstanding")).toBe(true);

    // A derived row that points at rejected evidence stays retained for audit,
    // but it must immediately disappear from every active borrower signal.
    await pool.query(
      `INSERT INTO tax_insights
        (user_id,document_id,tax_year,adjusted_gross_income,self_employed,dscr_candidate,confidence)
       VALUES ($1,$2,1999,'999999.00',false,false,'high')`,
      [borrowerId, firstDocumentId],
    );
    const activeInsights = await jsonRequest(
      borrowerCookie,
      "GET",
      "/api/tax-insights/me",
    );
    expect(activeInsights.status).toBe(200);
    expect((await activeInsights.json()).insights).toEqual([]);

    // Historical conversation context remains visible after reassignment, but
    // review details written on the loan file do not cross the revoked access
    // boundary. Ownership means the borrower always retains the correction.
    await pool.query(
      "UPDATE deal_team_members SET is_active=false WHERE application_id=$1 AND user_id='test-lo'",
      [applicationId],
    );
    const removedStaffThreadResponse = await jsonRequest(
      loanOfficerCookie,
      "GET",
      `/api/messages/${borrowerId}`,
    );
    expect(removedStaffThreadResponse.status).toBe(200);
    const removedStaffRequest = (await removedStaffThreadResponse.json()).find(
      (row: any) => row.id === requestMessageId,
    );
    for (const field of ["status", "documentId", "rejectionReason", "respondedAt", "reviewedAt"]) {
      expect(removedStaffRequest.documentRequestData).not.toHaveProperty(field);
    }
    const crossApplicationReply = await jsonRequest(
      borrowerCookie,
      "POST",
      "/api/messages",
      {
        recipientId: "test-lo",
        applicationId,
        message: "I uploaded a corrected document for this loan file.",
      },
    );
    expect(crossApplicationReply.status).toBe(403);
    const removedStaffConversationsResponse = await jsonRequest(
      loanOfficerCookie,
      "GET",
      "/api/messages/conversations",
    );
    expect(removedStaffConversationsResponse.status).toBe(200);
    const removedStaffConversation = (await removedStaffConversationsResponse.json()).find(
      (row: any) => row.partnerId === borrowerId,
    );
    expect(removedStaffConversation.lastMessage.id).toBe(requestMessageId);
    for (const field of ["status", "documentId", "rejectionReason", "respondedAt", "reviewedAt"]) {
      expect(removedStaffConversation.lastMessage.documentRequestData).not.toHaveProperty(field);
    }
    expect((await currentRequest()).documentRequestData.rejectionReason).toContain(
      "expiration date",
    );
    await pool.query(
      "UPDATE deal_team_members SET is_active=true WHERE application_id=$1 AND user_id='test-lo'",
      [applicationId],
    );
    const restoredStaffThreadResponse = await jsonRequest(
      loanOfficerCookie,
      "GET",
      `/api/messages/${borrowerId}`,
    );
    const restoredStaffRequest = (await restoredStaffThreadResponse.json()).find(
      (row: any) => row.id === requestMessageId,
    );
    expect(restoredStaffRequest.documentRequestData.rejectionReason).toContain(
      "expiration date",
    );
    const actionableAfterRejection = await jsonRequest(
      borrowerCookie,
      "GET",
      "/api/messages/document-requests/pending",
    );
    expect(actionableAfterRejection.status).toBe(200);
    expect((await actionableAfterRejection.json()).map((row: any) => row.id)).toContain(
      requestMessageId,
    );

    const replacement = await uploadRequestedDocument({
      fileName: "Fictional license corrected.pdf",
      replacesDocumentId: firstDocumentId,
      // The Documents page has the exact rejected version but no chat message
      // id. The server must resolve and advance the request atomically.
      includeRequestMessageId: false,
    });
    replacementDocumentId = replacement.id;
    const resubmittedRequest = await currentRequest();
    expect(resubmittedRequest.documentRequestData).toMatchObject({
      status: "submitted",
      documentId: replacementDocumentId,
    });
    expect(resubmittedRequest.documentRequestData).not.toHaveProperty("rejectionReason");
    expect(resubmittedRequest.documentRequestData).not.toHaveProperty("reviewedAt");
    const conditionsAfterReplacement = await pool.query(
      "SELECT status FROM loan_conditions WHERE application_id=$1 ORDER BY id",
      [applicationId],
    );
    expect(conditionsAfterReplacement.rows.every((row) => row.status === "submitted")).toBe(true);

    const oldRunId = randomUUID();
    const currentRunId = randomUUID();
    const oldLogicalDocumentId = randomUUID();
    const currentLogicalDocumentId = randomUUID();
    await pool.query(
      `INSERT INTO tax_extraction_runs
        (id,document_id,user_id,application_id,status,simulated,form_count,overall_confidence,started_at,completed_at)
       VALUES
        ($1,$2,$3,$4,'completed',true,1,'0.9000',now() - interval '1 second',now() - interval '1 second'),
        ($5,$6,$3,$4,'completed',true,1,'0.9000',now(),now())`,
      [oldRunId, firstDocumentId, borrowerId, applicationId, currentRunId, replacementDocumentId],
    );
    await pool.query(
      `INSERT INTO logical_documents
        (id,loan_id,borrower_id,document_type,aggregated_confidence,status,tax_year,source_document_id,extraction_run_id)
       VALUES
        ($1,$2,$3,'w2','0.9000','needs_review',2024,$4,$5),
        ($6,$2,$3,'w2','0.9000','needs_review',2025,$7,$8)`,
      [
        oldLogicalDocumentId,
        applicationId,
        borrowerId,
        firstDocumentId,
        oldRunId,
        currentLogicalDocumentId,
        replacementDocumentId,
        currentRunId,
      ],
    );
    const currentTaxInstances = await getLatestInstancesForUser(borrowerId, applicationId);
    expect(currentTaxInstances.map((instance) => instance.logicalDocumentId)).toEqual([
      currentLogicalDocumentId,
    ]);

    await pool.query(
      `INSERT INTO extracted_fields
        (document_id,field_name,field_category,value_numeric,value_type,confidence,extraction_method)
       VALUES
        ($1,'monthly_income_ytd_avg','income','99999','currency','0.9900','fixture'),
        ($2,'monthly_income_ytd_avg','income','7000','currency','0.9900','fixture')`,
      [firstDocumentId, replacementDocumentId],
    );
    const graph = await buildBorrowerGraph(borrowerId);
    expect(
      graph.income
        .filter((source) => source.type === "pay_stub_ytd_average")
        .map((source) => source.amount),
    ).toEqual([7000]);

    const staleReview = await jsonRequest(
      loanOfficerCookie,
      "POST",
      `/api/documents/${firstDocumentId}/verify`,
      { status: "verified" },
    );
    expect(staleReview.status).toBe(409);

    const staleExtraction = await jsonRequest(
      borrowerCookie,
      "POST",
      `/api/documents/${firstDocumentId}/extract`,
      {},
    );
    expect(staleExtraction.status).toBe(409);
    expect((await staleExtraction.json()).code).toBe("DOCUMENT_VERSION_REPLACED");

    const accepted = await jsonRequest(
      loanOfficerCookie,
      "POST",
      `/api/documents/${replacementDocumentId}/verify`,
      { status: "verified" },
    );
    expect(accepted.status).toBe(200);
    expect((await currentRequest()).documentRequestData).toMatchObject({
      status: "approved",
      documentId: replacementDocumentId,
    });
    const reviewTasks = await pool.query(
      `SELECT status FROM tasks
        WHERE application_id=$1 AND task_type_code='DOC_REVIEW'
        ORDER BY created_at`,
      [applicationId],
    );
    expect(reviewTasks.rows).toHaveLength(2);
    expect(reviewTasks.rows.every((row) => row.status === "COMPLETED")).toBe(true);

    await pool.query(
      `INSERT INTO loan_conditions
        (id,application_id,category,title,description,priority,status,required_document_types)
       VALUES ($1,$2,'income','Current W-2','Upload the current W-2.','prior_to_docs','outstanding',ARRAY['w2'])`,
      [supersededConditionId, applicationId],
    );
    const supersededEvidence = await uploadStandaloneDocument(
      "Fictional superseded W-2.pdf",
      "w2",
    );
    const currentEvidence = await uploadStandaloneDocument(
      "Fictional current W-2.pdf",
      "w2",
      supersededEvidence.id,
    );
    const rejectedCurrentEvidence = await jsonRequest(
      loanOfficerCookie,
      "POST",
      `/api/documents/${currentEvidence.id}/verify`,
      {
        status: "rejected",
        reason: "Upload the complete W-2; the employer name is missing.",
      },
    );
    expect(rejectedCurrentEvidence.status).toBe(200);
    const conditionAfterCurrentRejection = await pool.query(
      "SELECT status FROM loan_conditions WHERE id=$1",
      [supersededConditionId],
    );
    expect(conditionAfterCurrentRejection.rows[0].status).toBe("outstanding");

    // Two opposite decisions on one current version linearize to one winner,
    // and only that winner produces side effects.
    const raceDocument = await uploadStandaloneDocument(
      "Fictional concurrency evidence.pdf",
      "w2",
    );
    const wrongRecipientRequestId = randomUUID();
    const wrongTypeRequestId = randomUUID();
    await pool.query(
      `INSERT INTO team_messages
        (id,sender_id,recipient_id,application_id,message,message_type,document_request_data)
       VALUES
        ($1,'test-lo','test-lo',$3,'Legacy malformed recipient binding','document_request',$4::jsonb),
        ($2,'test-lo',$5,$3,'Legacy malformed type binding','document_request',$6::jsonb)`,
      [
        wrongRecipientRequestId,
        wrongTypeRequestId,
        applicationId,
        JSON.stringify({ documentType: "w2", status: "submitted", documentId: raceDocument.id }),
        borrowerId,
        JSON.stringify({ documentType: "bank_statement", status: "submitted", documentId: raceDocument.id }),
      ],
    );
    const [raceVerified, raceRejected] = await Promise.all([
      jsonRequest(
        loanOfficerCookie,
        "POST",
        `/api/documents/${raceDocument.id}/verify`,
        { status: "verified" },
      ),
      jsonRequest(
        loanOfficerCookie,
        "POST",
        `/api/documents/${raceDocument.id}/verify`,
        {
          status: "rejected",
          reason: "Upload the complete W-2; the employer name is missing.",
        },
      ),
    ]);
    expect([raceVerified.status, raceRejected.status].sort()).toEqual([200, 409]);
    const winningResponse = raceVerified.status === 200 ? raceVerified : raceRejected;
    const winningDocument = await winningResponse.json();
    const storedRaceDocument = await pool.query(
      "SELECT status FROM documents WHERE id=$1",
      [raceDocument.id],
    );
    expect(storedRaceDocument.rows[0].status).toBe(winningDocument.status);
    const idempotentRetry = await jsonRequest(
      loanOfficerCookie,
      "POST",
      `/api/documents/${raceDocument.id}/verify`,
      {
        status: winningDocument.status,
        ...(winningDocument.status === "rejected"
          ? { reason: "Upload the complete W-2; the employer name is missing." }
          : {}),
      },
    );
    expect(idempotentRetry.status).toBe(200);
    const reviewNotifications = await pool.query(
      "SELECT count(*) FROM notifications WHERE entity_type='document' AND entity_id=$1 AND type IN ('document_verified','document_rejected')",
      [raceDocument.id],
    );
    expect(Number(reviewNotifications.rows[0].count)).toBe(1);
    const malformedBindings = await pool.query(
      `SELECT id,document_request_data->>'status' AS status
         FROM team_messages
        WHERE id IN ($1,$2)
        ORDER BY id`,
      [wrongRecipientRequestId, wrongTypeRequestId],
    );
    expect(malformedBindings.rows).toHaveLength(2);
    expect(malformedBindings.rows.every((row) => row.status === "submitted")).toBe(true);
    const lineage = await pool.query(
      `SELECT document_id,lineage_id,version_number,replaces_document_id
         FROM document_lineage
        WHERE application_id=$1 AND document_id IN ($2,$3)
        ORDER BY version_number`,
      [applicationId, firstDocumentId, replacementDocumentId],
    );
    expect(lineage.rows).toHaveLength(2);
    expect(lineage.rows[0]).toMatchObject({
      document_id: firstDocumentId,
      version_number: 1,
      replaces_document_id: null,
    });
    expect(lineage.rows[1]).toMatchObject({
      document_id: replacementDocumentId,
      lineage_id: lineage.rows[0].lineage_id,
      version_number: 2,
      replaces_document_id: firstDocumentId,
    });

    await pool.query(
      "UPDATE loan_conditions SET status='cleared',cleared_by_user_id='test-lo',cleared_at=now() WHERE application_id=$1",
      [applicationId],
    );
    const settledChecklistResponse = await jsonRequest(
      borrowerCookie,
      "GET",
      `/api/applications/${applicationId}/document-checklist`,
    );
    expect(settledChecklistResponse.status).toBe(200);
    const settledChecklist = await settledChecklistResponse.json();
    expect(settledChecklist.personalized).toBe(true);
    expect(settledChecklist.documents).toEqual([]);
    expect(settledChecklist.stats.needed).toBe(0);

    const answersAfter = await pool.query(
      `SELECT annual_income,monthly_debts,credit_score,employment_type,
              purchase_price,down_payment,loan_purpose
         FROM loan_applications WHERE id=$1`,
      [applicationId],
    );
    expect(answersAfter.rows[0]).toEqual(stableAnswers.rows[0]);
  }, 120_000);
});
