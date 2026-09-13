import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { BASE_URL } from "./setup";

const applicationId = randomUUID();
const outsideApplicationId = randomUUID();
let borrowerId = randomUUID();
const documentTypes = [
  "pay_stub",
  "schedule_k1",
  "business_tax_return_1120s",
  "lease_agreement",
  "bank_statement_checking",
  "credit_report",
  "business_bank_statement",
  "tax_return_1040",
  "tax_return_1040",
  "brokerage_statement",
  "retirement_statement",
  "employment_verification",
];
const documentIds = documentTypes.map(() => randomUUID());
const liquidityFormId = randomUUID();
const currentK1FormId = randomUUID();
const priorK1FormId = randomUUID();
const capital1040CurrentFormId = randomUUID();
const capitalScheduleDCurrentFormId = randomUUID();
const capital1040PriorFormId = randomUUID();
const capitalScheduleDPriorFormId = randomUUID();
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
    "INSERT INTO loan_applications (id,user_id,status,loan_purpose,preferred_loan_type,loan_term_months,purchase_price,down_payment,annual_income,financial_data_provenance,income_sources,owns_other_real_estate,closing_date,occupancy_type) VALUES ($1,$3,'processing','purchase','conventional',360,'650000','130000','160000','self_reported',$4::jsonb,true,'2026-10-15','primary_residence'),($2,$3,'draft','purchase','conventional',360,'400000','80000','90000','self_reported','[]'::jsonb,false,'2026-10-15','primary_residence')",
    [applicationId, outsideApplicationId, borrowerId, JSON.stringify(rental)],
  );
  await pool.query(
    "INSERT INTO real_estate_owned (application_id,user_id,property_address,property_type,market_value,mortgage_balance,heloc_balance,mortgage_payment,heloc_payment,monthly_rental_income,monthly_insurance,monthly_taxes,monthly_hoa,occupancy_type,status,will_be_sold,will_be_rented,personally_obligated,verification_source) VALUES ($1,$2,'10 Rental Way','single_family','420000','200000','0','1400','0','3000','100','250','50','investment','retained',false,true,true,'borrower_stated')",
    [applicationId, borrowerId],
  );
  await pool.query("INSERT INTO deal_team_members (application_id,user_id,team_role,is_active) VALUES ($1,'test-lo','loan_officer',true)", [applicationId]);

  const worksheet = {
    version: 1,
    businessStructure: "s_corporation",
    ownershipPercent: 60,
    confirmedByBorrowerAt: "2026-09-04T12:00:00.000Z",
    k1: {
      currentYear: { taxYear: 2025, ordinaryBusinessIncome: 90000, netRentalRealEstateIncome: 0, otherNetRentalIncome: 0, guaranteedPayments: 0, distributionsReceived: 40000 },
      priorYear: { taxYear: 2024, ordinaryBusinessIncome: 80000, netRentalRealEstateIncome: 0, otherNetRentalIncome: 0, guaranteedPayments: 0, distributionsReceived: 35000 },
      hasTwoYearGuaranteedPayments: false,
      liquidity: { currentAssets: 120000, currentLiabilities: 50000, inventory: 10000 },
      w2FromBusiness: 48000,
    },
  };
  await pool.query(
    "INSERT INTO employment_history (id,application_id,borrower_sequence_number,employment_type,employer_name,is_self_employed,self_employment_income,paid_in_virtual_currency,has_known_future_income_reduction) VALUES ($1,$3,1,'self_employed','Fictional S Corp',true,$4::jsonb,false,false),($2,$3,2,'full_time','Fictional Hospital',false,NULL,false,false)",
    [randomUUID(), randomUUID(), applicationId, JSON.stringify(worksheet)],
  );
  await pool.query(
    "INSERT INTO borrower_business_entities (id,user_id,application_id,identity_key,entity_type,name) VALUES ($1,$3,$4,'name:fictional_s_corp','s_corporation','Fictional S Corp'),($2,$3,$4,'name:other_business','s_corporation','Other Business')",
    [businessEntityId, otherBusinessEntityId, borrowerId, applicationId],
  );
  await pool.query("UPDATE employment_history SET base_income='6000',total_monthly_income='6000' WHERE application_id=$1 AND borrower_sequence_number=2", [applicationId]);
  await pool.query(
    "INSERT INTO other_income_sources (application_id,borrower_sequence_number,income_source,monthly_amount,tax_treatment,has_defined_expiration,paid_in_virtual_currency,linked_asset_account_last4,asset_ownership_type,has_unrestricted_access,full_distribution_penalty_amount,funds_used_for_transaction) VALUES ($1,2,'Retirement (e.g., Pension, IRA)','1000','taxable',false,false,NULL,NULL,NULL,NULL,NULL),($1,1,'Capital Gains','0','taxable',false,false,NULL,NULL,NULL,NULL,NULL),($1,2,'Employment-Related Assets as Income','0','taxable',false,false,'5678','individual',true,'12000','18000')",
    [applicationId],
  );
  await pool.query("INSERT INTO urla_personal_info (application_id,borrower_sequence_number,is_primary_borrower,date_of_birth) VALUES ($1,1,true,'1970-01-01'),($1,2,false,'1960-01-01')", [applicationId]);
  await pool.query(
    "INSERT INTO urla_property_info (application_id,monthly_flood_insurance,monthly_ground_rent,monthly_special_assessments,subordinate_financing_exists,closed_end_subordinate_balance,heloc_drawn_balance,heloc_credit_limit,monthly_subordinate_financing_payment) VALUES ($1,'0','0','0',false,'0','0','0','0')",
    [applicationId],
  );
  await pool.query("INSERT INTO urla_assets (application_id,borrower_sequence_number,account_type,financial_institution,account_number_last4,cash_or_market_value) VALUES ($1,1,'checking','Fictional Bank','1234','90000'),($1,2,'401k','Fictional Retirement','5678','120000'),($1,1,'Brokerage account','Fictional Brokerage','4321','250000')", [applicationId]);
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
  await pool.query(
    "INSERT INTO logical_documents (id,loan_id,borrower_id,document_type,aggregated_confidence,status,tax_year,source_document_id,business_entity_id,page_start,page_end,is_complete,verified_by_user_id,verified_at) VALUES ($1,$2,$3,'business_tax_return_1120s','0.99','accepted',2025,$4,$5,1,2,true,'test-lo',now())",
    [liquidityFormId, applicationId, borrowerId, documentIds[2], businessEntityId],
  );
  for (const [fieldName, value] of [
    ["scheduleLCashEndOfYear", 100000],
    ["scheduleLReceivablesEndOfYear", 10000],
    ["scheduleLInventoriesEndOfYear", 10000],
    ["scheduleLAccountsPayableEndOfYear", 30000],
    ["scheduleLShortTermDebtEndOfYear", 10000],
    ["scheduleLOtherCurrentLiabilitiesEndOfYear", 10000],
  ] as const) {
    await pool.query(
      "INSERT INTO extracted_fields (document_id,logical_document_id,page_number,field_name,value_numeric,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,$2,2,$3,$4,'currency','0.99','fixture',true,'test-lo',now())",
      [documentIds[2], liquidityFormId, fieldName, String(value)],
    );
  }
  for (const [formId, taxYear, ordinaryIncome] of [
    [currentK1FormId, 2025, 90000],
    [priorK1FormId, 2024, 80000],
  ] as const) {
    await pool.query(
      "INSERT INTO logical_documents (id,loan_id,borrower_id,document_type,aggregated_confidence,status,tax_year,source_document_id,business_entity_id,page_start,page_end,is_complete,verified_by_user_id,verified_at) VALUES ($1,$2,$3,'schedule_k1','0.99','accepted',$4,$5,$6,1,1,true,'test-lo',now())",
      [formId, applicationId, borrowerId, taxYear, documentIds[1], businessEntityId],
    );
    await pool.query(
      "INSERT INTO extracted_fields (document_id,logical_document_id,page_number,field_name,value_numeric,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,$2,1,'ordinaryBusinessIncomeOrLoss',$3,'currency','0.99','fixture',true,'test-lo',now())",
      [documentIds[1], formId, String(ordinaryIncome)],
    );
  }
  for (const [form1040Id, scheduleDId, taxYear, sourceDocumentId, capitalGain] of [
    [capital1040CurrentFormId, capitalScheduleDCurrentFormId, 2025, documentIds[7], 120000],
    [capital1040PriorFormId, capitalScheduleDPriorFormId, 2024, documentIds[8], 96000],
  ] as const) {
    await pool.query(
      "INSERT INTO logical_documents (id,loan_id,borrower_id,document_type,aggregated_confidence,status,tax_year,source_document_id,page_start,page_end,is_complete,verified_by_user_id,verified_at) VALUES ($1,$3,$4,'tax_return_1040','0.99','accepted',$5,$6,1,2,true,'test-lo',now()),($2,$3,$4,'schedule_d','0.99','accepted',$5,$6,3,4,true,'test-lo',now())",
      [form1040Id, scheduleDId, applicationId, borrowerId, taxYear, sourceDocumentId],
    );
    await pool.query(
      "INSERT INTO extracted_fields (document_id,logical_document_id,page_number,field_name,value_boolean,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,$2,2,'signatureEvidencePresent',true,'boolean','0.99','fixture',true,'test-lo',now())",
      [sourceDocumentId, form1040Id],
    );
    await pool.query(
      "INSERT INTO extracted_fields (document_id,logical_document_id,page_number,field_name,value_numeric,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,$2,4,'totalCapitalGainOrLoss',$3,'currency','0.99','fixture',true,'test-lo',now())",
      [sourceDocumentId, scheduleDId, String(capitalGain)],
    );
  }
  await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_numeric,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,'monthly_income_ytd_avg','6000','currency','0.99','fixture',true,'test-lo',now())", [documentIds[0]]);
  await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_string,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,'employer_name','Fictional Hospital','string','0.99','fixture',true,'test-lo',now())", [documentIds[0]]);
  await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_numeric,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,'closing_balance','90000','currency','0.99','fixture',true,'test-lo',now())", [documentIds[4]]);
  await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_string,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,'account_number_last4','1234','string','0.99','fixture',true,'test-lo',now())", [documentIds[4]]);
  await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_numeric,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,'monthly_rent','3000','currency','0.99','fixture',true,'test-lo',now())", [documentIds[3]]);
  await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_string,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,'property_address','10 Rental Way','string','0.99','fixture',true,'test-lo',now())", [documentIds[3]]);
  await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_numeric,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,'closing_balance','250000','currency','0.99','fixture',true,'test-lo',now())", [documentIds[9]]);
  await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_string,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,'statement_period_end','2026-08-31','string','0.99','fixture',true,'test-lo',now()),($1,1,'account_number_last4','4321','string','0.99','fixture',true,'test-lo',now())", [documentIds[9]]);
  await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_numeric,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,'closing_balance','120000','currency','0.99','fixture',true,'test-lo',now())", [documentIds[10]]);
  await pool.query("INSERT INTO extracted_fields (document_id,page_number,field_name,value_string,value_type,confidence,extraction_method,human_verified,verified_by_user_id,verified_at) VALUES ($1,1,'statement_period_end','2026-08-31','string','0.99','fixture',true,'test-lo',now()),($1,1,'account_number_last4','5678','string','0.99','fixture',true,'test-lo',now())", [documentIds[10]]);
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
    expect(income.output.borrowerBreakdown).toContainEqual({ borrowerSequenceNumber: 2, monthlyIncome: 7250 });
    expect(income.output.evaluation.paths).toContainEqual(expect.objectContaining({
      pathId: "capital_gains",
      status: "applicable",
      monthlyQualifyingIncome: 9000,
      appliedToDti: true,
    }));
    expect(income.input.evidenceComparisons.filter((row: { label: string }) => row.label.includes("Schedule D capital gain or loss"))).toHaveLength(2);
    expect(income.sources.some((source: { documentId: string }) => source.documentId === documentIds[9])).toBe(true);
    expect(income.output.evaluation.paths).toContainEqual(expect.objectContaining({
      pathId: "employment_related_assets",
      status: "applicable",
      monthlyQualifyingIncome: 250,
      appliedToDti: true,
    }));
    expect(income.sources.some((source: { documentId: string }) => source.documentId === documentIds[10])).toBe(true);
    expect(selfEmployed.output.result.monthlyQualifyingIncome).toBeCloseTo(11083.33, 2);
    expect(selfEmployed.input.evidenceComparisons.filter((row: { label: string }) => row.label.endsWith("Ordinary business income or loss"))).toHaveLength(2);
    expect(liquidity.output).toMatchObject({ method: "quick_ratio", quickRatio: 2.2, supportsOrdinaryIncome: true });
    expect(liquidity.input.evidenceComparisons).toHaveLength(3);
    expect(liquidity.input.evidenceComparisons.every((row: { status: string }) => row.status === "match")).toBe(true);
    expect(rentalPaper.output.result.appliedMonthlyIncome).toBe(450);
    expect(liabilities.output.result.totalMonthlyPayment).toBe(450);
    expect(current.workpapers.flatMap((row: { sources: Array<{ contentFingerprint: string | null }> }) => row.sources).every((source: { contentFingerprint: string | null }) => source.contentFingerprint?.length === 64)).toBe(true);
    expect(selfEmployed.sources.some((source: { documentId: string }) => source.documentId === documentIds[2])).toBe(true);
    expect(selfEmployed.sources.some((source: { documentId: string }) => source.documentId === documentIds[6])).toBe(false);
    expect(assetPaper.sources.some((source: { documentId: string }) => [documentIds[2], documentIds[6]].includes(source.documentId))).toBe(false);
    expect(JSON.stringify(current.workpapers.map((row: { input: unknown }) => row.input))).not.toContain("1234");
    expect(JSON.stringify(current.workpapers.map((row: { input: unknown }) => row.input))).not.toContain("9999");
    expect(income.input.evidenceComparisons).toContainEqual(expect.objectContaining({ kind: "income", status: "match", evidenceValue: 6000, calculationValue: 6000 }));
    expect(assetPaper.input.evidenceComparisons).toContainEqual(expect.objectContaining({ kind: "asset", status: "match", evidenceValue: 90000, calculationValue: 90000 }));
    expect(rentalPaper.input.evidenceComparisons).toContainEqual(expect.objectContaining({ kind: "rental", status: "match", evidenceValue: 3000, calculationValue: 3000 }));
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

  it("keeps the approved review current when its verification promotes application provenance", async () => {
    await pool.query("UPDATE loan_applications SET financial_data_provenance='verified',income_verified=true,assets_verified=true,credit_verified=true WHERE id=$1", [applicationId]);
    const promoted = await workspace();
    expect(promoted.currentApprovedCount).toBe(6);
    expect(promoted.memo.isCurrent).toBe(true);
    expect(promoted.workpapers.find((row: { kind: string }) => row.kind === "rental_cash_flow").output.result.appliedMonthlyIncome).toBe(450);
  });

  it("invalidates approved workpapers when a reviewer corrects a fact without changing its ID", async () => {
    await pool.query(
      "UPDATE extracted_fields SET human_corrected_value='6500',verified_at=now() WHERE document_id=$1 AND field_name='monthly_income_ytd_avg'",
      [documentIds[0]],
    );
    const changed = await workspace();
    const income = changed.workpapers.find((row: { kind: string }) => row.kind === "income_summary");
    expect(income.isCurrent).toBe(false);
    expect(income.blockers).toContainEqual(expect.objectContaining({ code: "stale_version" }));
    expect(changed.memo.isCurrent).toBe(false);
    expect(changed.currentApprovedCount).toBe(5);

    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/prepare`, {})).status).toBe(201);
    const refreshed = await workspace();
    const refreshedIncome = refreshed.workpapers.find((row: { kind: string }) => row.kind === "income_summary");
    const comparison = refreshedIncome.input.evidenceComparisons.find(
      (row: { kind: string; evidenceValue: number }) => row.kind === "income" && row.evidenceValue === 6500,
    );
    expect(comparison).toMatchObject({ status: "variance", evidenceValue: 6500, calculationValue: 6000, variance: 500 });
    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/workpapers/${refreshedIncome.id}/review`, {
      action: "approve",
      reason: "Reviewed variable pay treatment.",
      expectedFingerprint: refreshedIncome.inputFingerprint,
    })).status).toBe(409);
    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/workpapers/${refreshedIncome.id}/review`, {
      action: "approve",
      reason: "Reviewed variable pay treatment.",
      expectedFingerprint: refreshedIncome.inputFingerprint,
      acknowledgedComparisonIds: [comparison.id],
    })).status).toBe(201);
  });

  it("rebuilds the liability workpaper around a current bureau ledger and requires discrepancy acknowledgement", async () => {
    const consentId = randomUUID();
    const creditPullId = randomUUID();
    const bureauLiabilities = [
      { creditor: "Fictional Card", type: "credit_card", balance: 5000, monthlyPayment: 250 },
      { creditor: "Fictional Servicer", type: "student_loan", balance: 20000, monthlyPayment: 0, deferred: true },
      { creditor: "Fictional Auto", type: "auto", balance: 12000, monthlyPayment: 300 },
    ];
    const borrowerScores = [
      { borrowerSequenceNumber: 1, experianScore: 720, equifaxScore: 730, transunionScore: 740, representativeScore: 730 },
      { borrowerSequenceNumber: 2, experianScore: 760, equifaxScore: 750, transunionScore: 770, representativeScore: 760 },
    ];
    await pool.query(
      "INSERT INTO credit_consents (id,application_id,user_id,consent_type,disclosure_version,disclosure_text,consent_given,consent_timestamp,borrower_full_name,is_active) VALUES ($1,$2,$3,'soft_pull','fixture-v1','Fictional integration disclosure',true,now(),'Fictional Owner',true)",
      [consentId, applicationId, borrowerId],
    );
    await pool.query(
      "INSERT INTO credit_pulls (id,application_id,consent_id,requested_by,pull_type,bureaus,status,external_request_id,experian_score,equifax_score,transunion_score,representative_score,borrower_scores,total_tradelines,open_tradelines,total_debt,monthly_payments,liabilities,vendor_request_id,is_simulated,completed_at,expires_at) VALUES ($1,$2,$3,$4,'tri_merge',ARRAY['experian','equifax','transunion'],'completed','fixture-external',720,730,740,730,$6::jsonb,3,3,'37000','550',$5::jsonb,'fixture-vendor-request',false,now(),now() + interval '120 days')",
      [creditPullId, applicationId, consentId, borrowerId, JSON.stringify(bureauLiabilities), JSON.stringify(borrowerScores)],
    );

    const changed = await workspace();
    const staleLiability = changed.workpapers.find((row: { kind: string }) => row.kind === "liability_reconciliation");
    expect(staleLiability.isCurrent).toBe(false);
    expect(changed.memo.isCurrent).toBe(false);

    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/prepare`, {})).status).toBe(201);
    const refreshed = await workspace();
    const liability = refreshed.workpapers.find((row: { kind: string }) => row.kind === "liability_reconciliation");
    expect(liability.output).toMatchObject({
      decisionMonthlyPayment: 750,
      bureau: {
        pullId: creditPullId,
        representativeScore: 730,
        borrowerScores,
        reportedMonthlyPayments: 550,
        adjustedMonthlyDebt: 750,
        tradelineCount: 3,
      },
    });
    const comparison = liability.input.evidenceComparisons.find((row: { kind: string }) => row.kind === "liability");
    expect(comparison).toMatchObject({ status: "variance", evidenceValue: 750, calculationValue: 450, variance: 300 });
    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/workpapers/${liability.id}/review`, {
      action: "approve",
      reason: "Reviewed the current bureau liability ledger.",
      expectedFingerprint: liability.inputFingerprint,
    })).status).toBe(409);
    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/workpapers/${liability.id}/review`, {
      action: "approve",
      reason: "Reviewed the current bureau liability ledger and application difference.",
      expectedFingerprint: liability.inputFingerprint,
      acknowledgedComparisonIds: [comparison.id],
    })).status).toBe(201);
  });

  it("applies a documented $0 student-loan payment only after linking the accepted statement and current bureau line", async () => {
    const currentCredit = await pool.query(
      "SELECT id FROM credit_pulls WHERE application_id=$1 AND status='completed' ORDER BY completed_at DESC LIMIT 1",
      [applicationId],
    );
    const creditPullId = currentCredit.rows[0].id as string;
    const student = await pool.query(
      "UPDATE urla_liabilities SET student_loan_repayment_plan='income_driven' WHERE application_id=$1 AND liability_type='student_loan' RETURNING id",
      [applicationId],
    );
    const liabilityId = student.rows[0].id as string;

    // The repayment-plan change invalidates the immutable prior workpaper.
    // Prepare its current version before the reviewer sees treatment options.
    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/prepare`, {})).status).toBe(201);
    const available = await workspace();
    const before = available.workpapers.find((row: { kind: string }) => row.kind === "liability_reconciliation");
    expect(before.output.treatmentCandidates).toContainEqual(expect.objectContaining({
      liabilityId,
      recommendedTreatment: "documented_zero_student_loan",
      currentTreatment: null,
    }));

    const applied = await call(
      "lo",
      `/api/loan-applications/${applicationId}/financial-review/liabilities/${liabilityId}/treatment`,
      {
        treatment: "documented_zero_student_loan",
        sourceDocumentId: documentIds[5],
        creditPullId,
        tradelineIndex: 1,
      },
    );
    expect(applied.status).toBe(200);
    expect((await workspace()).workpapers.find((row: { kind: string }) => row.kind === "liability_reconciliation").isCurrent).toBe(false);

    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/prepare`, {})).status).toBe(201);
    const reviewed = await workspace();
    const liability = reviewed.workpapers.find((row: { kind: string }) => row.kind === "liability_reconciliation");
    expect(liability.output.result.totalMonthlyPayment).toBe(250);
    expect(liability.output.decisionMonthlyPayment).toBe(550);
    expect(liability.output.treatmentCandidates).toContainEqual(expect.objectContaining({
      liabilityId,
      currentTreatment: "documented_zero_student_loan",
      evidenceCurrent: true,
      bureauLinkCurrent: true,
    }));

    const borrowerEdit = await fetch(`${BASE_URL}/api/urla/liabilities/${liabilityId}`, {
      method: "PATCH",
      headers: { Cookie: cookies.lo, Origin: BASE_URL, "Content-Type": "application/json" },
      body: JSON.stringify({
        studentLoanRepaymentPlan: "deferred",
        // A standard URLA writer cannot preserve or manufacture the staff-only
        // exception when a reviewed basis fact changes.
        underwritingTreatment: "documented_zero_student_loan",
        treatmentSourceDocumentId: documentIds[5],
      }),
    });
    expect(borrowerEdit.status).toBe(200);
    const stored = await pool.query(
      "SELECT underwriting_treatment,treatment_source_document_id,treatment_credit_pull_id,treatment_tradeline_index FROM urla_liabilities WHERE id=$1",
      [liabilityId],
    );
    expect(stored.rows[0]).toEqual({
      underwriting_treatment: null,
      treatment_source_document_id: null,
      treatment_credit_pull_id: null,
      treatment_tradeline_index: null,
    });
  });

  it("marks the household workpaper and memo stale when a co-borrower figure changes", async () => {
    await pool.query("UPDATE employment_history SET base_income='6500',total_monthly_income='6500',updated_at=now() WHERE application_id=$1 AND borrower_sequence_number=2", [applicationId]);
    const changed = await workspace();
    expect(changed.workpapers.find((row: { kind: string }) => row.kind === "income_summary").isCurrent).toBe(false);
    expect(changed.memo.isCurrent).toBe(false);
    expect(changed.currentApprovedCount).toBe(4);
  });

  it("blocks the asset workpaper on large deposits measured against reviewed qualifying income", async () => {
    await pool.query(
      "INSERT INTO verification_reports (application_id,user_id,provider,report_type,provider_request_id,status,total_balance,raw_payload,completed_at,expires_at) VALUES ($1,$2,'fixture-bank','voa','fixture-voa-large-deposit','completed','210000',$3::jsonb,now(),now() + interval '120 days')",
      [applicationId, borrowerId, JSON.stringify({ transactions: [
        { amount: -20_000, date: "2026-09-01", description: "Fictional wire" },
        { amount: -2_000, date: "2026-09-02", description: "Fictional payroll" },
      ] })],
    );

    const changed = await workspace();
    const staleAsset = changed.workpapers.find((row: { kind: string }) => row.kind === "asset_reconciliation");
    expect(staleAsset.isCurrent).toBe(false);

    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/prepare`, {})).status).toBe(201);
    const blocked = await workspace();
    const asset = blocked.workpapers.find((row: { kind: string }) => row.kind === "asset_reconciliation");
    expect(asset.blockers.map((row: { message: string }) => row.message).join(" ")).toMatch(/large deposits/i);
    expect(asset.input.subject.largeDepositSourcing).toMatchObject({
      depositCount: 1,
      totalFlaggedAmount: 20_000,
      conditionStatus: "missing",
    });
    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/workpapers/${asset.id}/review`, {
      action: "approve",
      reason: "Reviewed available account evidence.",
      expectedFingerprint: asset.inputFingerprint,
    })).status).toBe(409);

    const sourceRule = asset.input.subject.largeDepositSourcing.sourceRule;
    await pool.query(
      "INSERT INTO loan_conditions (application_id,category,title,description,priority,status,is_auto_generated,source_rule,cleared_by_user_id,cleared_at,clearance_notes) VALUES ($1,'assets','Large Deposit Sourcing','Fixture sourcing review','prior_to_approval','cleared',true,$2,'test-lo',now(),'Reviewed source and transfer trail.')",
      [applicationId, sourceRule],
    );
    const resolved = await workspace();
    expect(resolved.workpapers.find((row: { kind: string }) => row.kind === "asset_reconciliation").isCurrent).toBe(false);
    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/prepare`, {})).status).toBe(201);
    const refreshed = await workspace();
    const refreshedAsset = refreshed.workpapers.find((row: { kind: string }) => row.kind === "asset_reconciliation");
    expect(refreshedAsset.blockers).toHaveLength(0);
    expect(refreshedAsset.input.subject.largeDepositSourcing.conditionStatus).toBe("cleared");
  });

  it("invalidates rental, asset, and household calculations when owned-property financing changes", async () => {
    await pool.query(
      "UPDATE real_estate_owned SET heloc_balance='10000',heloc_payment='100',updated_at=now() WHERE application_id=$1",
      [applicationId],
    );
    const changed = await workspace();
    expect(changed.workpapers.find((row: { kind: string }) => row.kind === "rental_cash_flow").isCurrent).toBe(false);
    expect(changed.workpapers.find((row: { kind: string }) => row.kind === "asset_reconciliation").isCurrent).toBe(false);
    expect(changed.workpapers.find((row: { kind: string }) => row.kind === "income_summary").isCurrent).toBe(false);

    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/prepare`, {})).status).toBe(201);
    const refreshed = await workspace();
    expect(refreshed.workpapers.find((row: { kind: string }) => row.kind === "rental_cash_flow").output.result.appliedMonthlyIncome).toBe(350);
    expect(refreshed.workpapers.find((row: { kind: string }) => row.kind === "asset_reconciliation").input.subject.realEstateOwned[0].helocBalance).toBe("10000.00");
  });

  it("rebuilds household income with a verified known future pay reduction", async () => {
    await pool.query(
      "UPDATE employment_history SET has_known_future_income_reduction=true,future_monthly_income='4000',future_income_effective_date='2026-12-01',future_income_reason='Moving to reduced hours',updated_at=now() WHERE application_id=$1 AND borrower_sequence_number=2",
      [applicationId],
    );
    const changed = await workspace();
    expect(changed.workpapers.find((row: { kind: string }) => row.kind === "income_summary").isCurrent).toBe(false);

    expect((await call("lo", `/api/loan-applications/${applicationId}/financial-review/prepare`, {})).status).toBe(201);
    const refreshed = await workspace();
    const income = refreshed.workpapers.find((row: { kind: string }) => row.kind === "income_summary");
    expect(income.blockers.map((blocker: { message: string }) => blocker.message).join(" ")).not.toMatch(/future income|employer verification/i);
    expect(income.output.borrowerBreakdown).toContainEqual({
      borrowerSequenceNumber: 2,
      monthlyIncome: 5250,
    });
    expect(income.output.evaluation.paths.find((path: { pathId: string }) => path.pathId === "agency_wage").notes.join(" ")).toMatch(/lower future gross monthly income/i);
    expect(income.sources.some((source: { documentId: string }) => source.documentId === documentIds[11])).toBe(true);
  });
});
