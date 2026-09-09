import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { BASE_URL } from "./setup";

const applicationId = randomUUID();
const outsideApplicationId = randomUUID();
let borrowerId = randomUUID();
const documentTypes = ["w2", "schedule_k1", "business_bank_statement", "lease_agreement", "bank_statement_checking", "credit_report", "business_bank_statement"];
const documentIds = documentTypes.map(() => randomUUID());
const businessEntityId = randomUUID();
const otherBusinessEntityId = randomUUID();
const workpaperIds: string[] = [];
let memoId: string | null = null;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const cookies: Record<string, string> = {};

async function call(role: string, path = `/api/loan-applications/${applicationId}/financial-review`, body?: unknown) {
  return fetch(`${BASE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookies[role] ?? "", Origin: BASE_URL, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function workspace() {
  const response = await call("lo");
  expect(response.status).toBe(200);
  return response.json();
}

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Financial review fixtures require a local test database");
  for (const role of ["lo", "loa", "buyer", "broker"]) {
    const response = await fetch(`${BASE_URL}/api/test-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ email: `${role}@test.com`, password: process.env.DEV_TEST_PASSWORD || "test1234" }),
    });
    expect(response.status).toBe(200);
    cookies[role] = response.headers.get("set-cookie")!.split(";")[0];
  }
  const registration = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ email: `financial-review-${borrowerId}@example.test`, password: `Review-${borrowerId}`, firstName: "Fictional", lastName: "Owner" }),
  });
  expect(registration.status).toBe(200);
  borrowerId = (await registration.json()).user.id;

  const rental = [{ type: "rental", annualAmount: "0", rentalProperties: [{ address: "10 Rental Way", monthlyRentalIncome: "3000", monthlyDebtPayment: "1800" }] }];
  await pool.query(
    "INSERT INTO loan_applications (id,user_id,status,loan_purpose,preferred_loan_type,purchase_price,down_payment,annual_income,financial_data_provenance,income_sources) VALUES ($1,$3,'processing','purchase','conventional','650000','130000','160000','verified',$4::jsonb),($2,$3,'draft','purchase','conventional','400000','80000','90000','stated','[]'::jsonb)",
    [applicationId, outsideApplicationId, borrowerId, JSON.stringify(rental)],
  );
  await pool.query("INSERT INTO deal_team_members (application_id,user_id,team_role,is_active) VALUES ($1,'test-lo','loan_officer',true)", [applicationId]);

  const worksheet = {
    version: 1,
    businessStructure: "s_corporation",
    ownershipPercent: 60,
    confirmedByBorrowerAt: "2026-09-04T12:00:00.000Z",
    k1: {
      currentYear: { ordinaryBusinessIncome: 90000, netRentalRealEstateIncome: 0, otherNetRentalIncome: 0, guaranteedPayments: 0, distributionsReceived: 40000 },
      priorYear: { ordinaryBusinessIncome: 80000, netRentalRealEstateIncome: 0, otherNetRentalIncome: 0, guaranteedPayments: 0, distributionsReceived: 35000 },
      hasTwoYearGuaranteedPayments: false,
      liquidity: { currentAssets: 120000, currentLiabilities: 50000, inventory: 10000 },
      w2FromBusiness: 48000,
    },
  };
  await pool.query(
    "INSERT INTO employment_history (id,application_id,borrower_sequence_number,employment_type,employer_name,is_self_employed,self_employment_income) VALUES ($1,$3,1,'self_employed','Fictional S Corp',true,$4::jsonb),($2,$3,2,'full_time','Fictional Hospital',false,NULL)",
    [randomUUID(), randomUUID(), applicationId, JSON.stringify(worksheet)],
  );
  await pool.query(
    "INSERT INTO borrower_business_entities (id,user_id,application_id,identity_key,entity_type,name) VALUES ($1,$3,$4,'name:fictional_s_corp','s_corporation','Fictional S Corp'),($2,$3,$4,'name:other_business','s_corporation','Other Business')",
    [businessEntityId, otherBusinessEntityId, borrowerId, applicationId],
  );
  await pool.query("UPDATE employment_history SET base_income='6000',total_monthly_income='6000' WHERE application_id=$1 AND borrower_sequence_number=2", [applicationId]);
  await pool.query("INSERT INTO urla_assets (application_id,borrower_sequence_number,account_type,financial_institution,account_number_last4,cash_or_market_value) VALUES ($1,1,'checking','Fictional Bank','1234','90000'),($1,2,'401k','Fictional Retirement','5678','120000')", [applicationId]);
  await pool.query("INSERT INTO urla_liabilities (application_id,borrower_sequence_number,liability_type,creditor_name,account_number_last4,unpaid_balance,monthly_payment) VALUES ($1,1,'credit_card','Fictional Card','9999','5000','250'),($1,2,'student_loan','Fictional Servicer','8888','20000','0')", [applicationId]);

  for (let index = 0; index < documentIds.length; index += 1) {
    const id = documentIds[index];
    const type = documentTypes[index];
    await pool.query("INSERT INTO documents (id,application_id,user_id,document_type,file_name,storage_path,status,reviewed_by_user_id,reviewed_at) VALUES ($1,$2,$3,$4,$5,$6,'verified','test-lo',now())", [id, applicationId, borrowerId, type, `Fictional ${type}.pdf`, `/objects/financial-${id}`]);
    const businessDocument = index === 2 || index === 6;
    const subjectId = index === 2 ? businessEntityId : index === 6 ? otherBusinessEntityId : applicationId;
    await pool.query("INSERT INTO document_lineage (application_id,document_id,lineage_id,version_number,content_sha256,subject_type,subject_id,recorded_by_user_id) VALUES ($1,$2,$2,1,$3,$4,$5,'test-lo')", [applicationId, id, `${index + 1}`.padStart(64, "a"), businessDocument ? "business" : "application", subjectId]);
    await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_numeric,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,$2,'1000','currency','0.99','fixture',true,'test-lo',now())", [id, `${type}_amount`]);
  }
});

afterAll(async () => {
  // Financial-review records are intentionally database-enforced append-only.
  // The randomized fictional fixture may remain in the disposable local/CI DB.
  await pool.end();
});

describe.sequential("financial workpapers and cited memo", () => {
  it("enforces authentication, internal roles, and exact deal-team access", async () => {
    expect((await call("anonymous")).status).toBe(401);
    expect((await call("buyer")).status).toBe(403);
    expect((await call("broker")).status).toBe(403);
    expect((await call("loa")).status).toBe(404);
    expect((await call("lo", `/api/loan-applications/${outsideApplicationId}/financial-review`)).status).toBe(404);
  });

  it("reproduces the S-corp, co-borrower, rental, asset, and liability analysis from versioned evidence", async () => {
    const before = await workspace();
    expect(before.requiredCount).toBe(6);
    expect(before.workpapers.every((row: { id: string | null }) => row.id === null)).toBe(true);
    const prepared = await call("lo", `/api/loan-applications/${applicationId}/financial-review/prepare`, {});
    expect(prepared.status).toBe(201);
    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/prepare`, {})).status).toBe(200);

    const current = await workspace();
    expect(current.workpapers).toHaveLength(6);
    expect(current.workpapers.every((row: { isCurrent: boolean }) => row.isCurrent)).toBe(true);
    const income = current.workpapers.find((row: { kind: string }) => row.kind === "income_summary");
    const selfEmployed = current.workpapers.find((row: { kind: string }) => row.kind === "self_employment");
    const liquidity = current.workpapers.find((row: { kind: string }) => row.kind === "business_liquidity");
    const rentalPaper = current.workpapers.find((row: { kind: string }) => row.kind === "rental_cash_flow");
    const assetPaper = current.workpapers.find((row: { kind: string }) => row.kind === "asset_reconciliation");
    const liabilities = current.workpapers.find((row: { kind: string }) => row.kind === "liability_reconciliation");
    expect(income.output.borrowerBreakdown.map((row: { borrowerSequenceNumber: number }) => row.borrowerSequenceNumber)).toEqual([1, 2]);
    expect(selfEmployed.output.result.monthlyQualifyingIncome).toBeCloseTo(11083.33, 2);
    expect(liquidity.output).toMatchObject({ method: "quick_ratio", quickRatio: 2.2, supportsOrdinaryIncome: true });
    expect(rentalPaper.output.result.appliedMonthlyIncome).toBe(450);
    expect(liabilities.output.result.totalMonthlyPayment).toBe(450);
    expect(current.workpapers.flatMap((row: { sources: Array<{ contentFingerprint: string | null }> }) => row.sources).every((source: { contentFingerprint: string | null }) => source.contentFingerprint?.length === 64)).toBe(true);
    expect(selfEmployed.sources.some((source: { documentId: string }) => source.documentId === documentIds[2])).toBe(true);
    expect(selfEmployed.sources.some((source: { documentId: string }) => source.documentId === documentIds[6])).toBe(false);
    expect(assetPaper.sources.some((source: { documentId: string }) => [documentIds[2], documentIds[6]].includes(source.documentId))).toBe(false);
    expect(JSON.stringify(current.workpapers.map((row: { input: unknown }) => row.input))).not.toContain("1234");
    expect(JSON.stringify(current.workpapers.map((row: { input: unknown }) => row.input))).not.toContain("9999");
  });

  it("requires dependency approval, then builds and approves a memo with exact version references", async () => {
    let current = await workspace();
    const income = current.workpapers.find((row: { kind: string }) => row.kind === "income_summary");
    const early = await call("lo", `/api/loan-applications/${applicationId}/financial-review/workpapers/${income.id}/review`, { action: "approve", reason: "Reviewed current household calculation.", expectedFingerprint: income.inputFingerprint });
    expect(early.status).toBe(409);

    for (const item of current.workpapers) {
      if (item.kind === "income_summary") continue;
      const response = await call("lo", `/api/loan-applications/${applicationId}/financial-review/workpapers/${item.id}/review`, { action: "approve", reason: `Reviewed current ${item.kind} evidence.`, expectedFingerprint: item.inputFingerprint });
      expect(response.status, item.kind).toBe(201);
      workpaperIds.push(item.id);
    }
    current = await workspace();
    const currentIncome = current.workpapers.find((row: { kind: string }) => row.kind === "income_summary");
    const incomeReview = await call("lo", `/api/loan-applications/${applicationId}/financial-review/workpapers/${currentIncome.id}/review`, { action: "approve", reason: "Reviewed all household components and evidence.", expectedFingerprint: currentIncome.inputFingerprint });
    expect(incomeReview.status).toBe(201);
    workpaperIds.push(currentIncome.id);

    current = await workspace();
    expect(current.currentApprovedCount).toBe(6);
    expect(current.canBuildMemo).toBe(true);
    const built = await call("lo", `/api/loan-applications/${applicationId}/financial-review/memo`, {});
    expect(built.status).toBe(201);
    memoId = (await built.json()).id;
    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/memo`, {})).status).toBe(200);
    current = await workspace();
    expect(current.memo.workpaperVersionIds).toHaveLength(6);
    expect(current.memo.sections.find((section: { key: string }) => section.key === "business").body).toContain("Fictional S Corp");
    expect(current.memo.sections.find((section: { key: string }) => section.key === "business").referenceIds).toContain(`document:${documentIds[2]}`);
    expect(current.memo.references.some((reference: { type: string; label: string; pageNumber?: number }) =>
      reference.type === "document" && reference.label.includes("p. 1") && reference.pageNumber === 1,
    )).toBe(true);
    const approved = await call("lo", `/api/loan-applications/${applicationId}/financial-review/memo/${memoId}/review`, { action: "approve", reason: "Approved for lender presentation after complete review.", expectedFingerprint: current.memo.inputFingerprint });
    expect(approved.status).toBe(201);
    expect((await workspace()).memo.review.action).toBe("approve");
  });

  it("marks the household workpaper and memo stale when a co-borrower figure changes", async () => {
    await pool.query("UPDATE employment_history SET base_income='6500',total_monthly_income='6500',updated_at=now() WHERE application_id=$1 AND borrower_sequence_number=2", [applicationId]);
    const changed = await workspace();
    expect(changed.workpapers.find((row: { kind: string }) => row.kind === "income_summary").isCurrent).toBe(false);
    expect(changed.memo.isCurrent).toBe(false);
    expect(changed.currentApprovedCount).toBe(5);
  });
});
