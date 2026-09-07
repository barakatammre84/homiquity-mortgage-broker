// Pre-approval letter integrity: an issued letter is a record, and every
// re-render must come from that record.
//
// Two layers, mirroring tests/licensedStates.test.ts:
//  1. Unit tests on letterDataFromStoredRow — the pure regeneration builder.
//  2. Source guards on server/routes/lending/letters.ts pinning the route
//     contracts the 2026-08-04 cross-sector adjudication §3 established:
//     no regeneration from live application data, no letter minted by the
//     download route, prior letters superseded on reissue, and issuance
//     failing loudly when the row cannot be recorded.
//  3. The §3.2 lifecycle follow-ups: effectiveLetterStatus (computed-at-read
//     expiry), the staff revocation route, and the persisting expiry sweep
//     (source guards + the scheduled sweep that actually runs it).

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  letterDataFromStoredRow,
  STANDARD_PRE_APPROVAL_CONDITIONS,
  type StoredPreApprovalLetter,
} from "../server/services/pdfLetterGenerator";
import { effectiveLetterStatus, resolveLetterAmount } from "../shared/letters";

const storedRow: StoredPreApprovalLetter = {
  letterNumber: "BN-TEST123-ABCD",
  borrowerName: "Jordan Example",
  loanAmount: "400000.00",
  productType: "CONV",
  occupancy: "Primary",
  loanPurpose: "Purchase",
  companyLegalName: "Homiquity LLC",
  companyNmlsId: "427468",
  companyContactInfo: "support@homiquity.com",
  expirationDate: "2026-11-02T00:00:00.000Z",
  generatedAt: "2026-08-04T12:00:00.000Z",
  createdAt: "2026-08-04T12:00:00.000Z",
  watermarkApplied: true,
};

describe("letterDataFromStoredRow", () => {
  it("renders the issued terms verbatim from the row", () => {
    const data = letterDataFromStoredRow(storedRow);
    expect(data.letterNumber).toBe("BN-TEST123-ABCD");
    expect(data.borrowerName).toBe("Jordan Example");
    expect(data.loanAmount).toBe("400000.00");
    expect(data.productType).toBe("CONV");
    expect(data.occupancy).toBe("Primary");
    expect(data.expirationDate).toEqual(new Date("2026-11-02T00:00:00.000Z"));
    expect(data.generatedAt).toEqual(new Date("2026-08-04T12:00:00.000Z"));
    expect(data.conditions).toEqual([...STANDARD_PRE_APPROVAL_CONDITIONS]);
    expect(data.watermarkApplied).toBe(true);
  });

  it("carries no live-application financial detail — omitted, not recomputed", () => {
    const data = letterDataFromStoredRow(storedRow);
    // The row does not store these; a regeneration must not source them from
    // the application's current state (the drift the adjudication §3.1 bars).
    expect(data.purchasePrice).toBeUndefined();
    expect(data.downPayment).toBeUndefined();
    expect(data.downPaymentPercent).toBeUndefined();
    expect(data.annualIncome).toBeUndefined();
    expect(data.monthlyPaymentEstimate).toBeUndefined();
    expect(data.estimatedDti).toBeUndefined();
    expect(data.creditScoreRange).toBeUndefined();
    expect(data.employmentType).toBeUndefined();
    expect(data.propertyType).toBeUndefined();
    expect(data.propertyState).toBeUndefined();
    expect(data.incomeSources).toBeUndefined();
    // Empty disclaimers fall back to the generator's standard five.
    expect(data.disclaimers).toEqual([]);
  });

  it("falls back to createdAt when generatedAt is missing", () => {
    const data = letterDataFromStoredRow({
      ...storedRow,
      generatedAt: null,
      createdAt: "2026-08-01T09:30:00.000Z",
    });
    expect(data.generatedAt).toEqual(new Date("2026-08-01T09:30:00.000Z"));
  });

  it("the stored-row input renders a real PDF (the regen path end-to-end)", async () => {
    const { generatePreApprovalPDF } = await import("../server/services/pdfLetterGenerator");
    const buffer = await generatePreApprovalPDF(letterDataFromStoredRow(storedRow));
    expect(buffer.length).toBeGreaterThan(1000);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

describe("letters route source guards", () => {
  const lettersSource = () =>
    readFile(join(__dirname, "../server/routes/lending/letters.ts"), "utf8");

  it("letter-pdf refuses to serve when no letter was ever issued", async () => {
    const source = await lettersSource();
    expect(
      source.includes('"No pre-approval letter found"'),
      "expected the letter-pdf route to 404 when no pre_approval_letters row exists — the download route carries none of the issuance gates and must never mint a letter",
    ).toBe(true);
    // Exactly one BN- letter number is ever minted: at issuance. A second
    // minting site means the download route regrew its fresh-number fallback.
    expect(
      (source.match(/`BN-\$\{/g) || []).length,
      "expected exactly one BN- letter-number minting site (the issuance route)",
    ).toBe(1);
  });

  it("regeneration renders from the stored row, and only issuance prices", async () => {
    const source = await lettersSource();
    expect(
      source.includes("letterDataFromStoredRow(letter)"),
      "expected the letter-pdf regeneration fallback to build its render input from the stored row via letterDataFromStoredRow",
    ).toBe(true);
    // currentAdvertised30YrRate: one definition + one call, in generate-letter.
    // A second call site means a download/regen path started pricing from
    // today's rates under an original issuance date.
    expect(
      (source.match(/currentAdvertised30YrRate\(/g) || []).length,
      "expected currentAdvertised30YrRate to appear exactly twice: its definition and the single issuance-route call",
    ).toBe(2);
  });

  it("issuing a new letter supersedes prior issued letters", async () => {
    const source = await lettersSource();
    expect(
      source.includes('status: "superseded"'),
      "expected generate-letter to flip prior issued letters to superseded (supersede-on-reissue)",
    ).toBe(true);
    expect(
      source.includes("supersededAt"),
      "expected the supersede writer to stamp supersededAt",
    ).toBe(true);
  });

  it("an unrecorded letter is not issued", async () => {
    const source = await lettersSource();
    expect(
      source.includes("Letter could not be recorded and was not issued"),
      "expected generate-letter to fail loudly (500) when the pre_approval_letters insert fails, instead of handing out a PDF the system cannot account for",
    ).toBe(true);
  });

  it("names and notifies the application borrower when staff issues the letter", async () => {
    const source = await lettersSource();
    expect(source).toContain("storage.getUser(application.userId)");
    expect(source).toContain("userId: borrower.id");
    expect(source).toContain("recipientEmail: borrower.email");
    expect(source).not.toContain("recipientEmail: user.email");
    expect(source).toContain('application.loanOfficerId ?? (user.role === "lo" ? user.id : undefined)');
  });
});

describe("effectiveLetterStatus", () => {
  const NOW = new Date("2026-08-04T12:00:00.000Z");

  it("issued and unexpired reads issued", () => {
    expect(
      effectiveLetterStatus({ status: "issued", expirationDate: "2026-11-02T00:00:00.000Z" }, NOW),
    ).toBe("issued");
  });

  it("issued past expiration reads expired", () => {
    expect(
      effectiveLetterStatus({ status: "issued", expirationDate: "2026-08-04T11:59:59.999Z" }, NOW),
    ).toBe("expired");
  });

  it("the letter remains issued through its stored expiration instant", () => {
    expect(
      effectiveLetterStatus({ status: "issued", expirationDate: NOW }, NOW),
    ).toBe("issued");
  });

  it("revocation wins over expiry — a revoked letter never re-reads expired", () => {
    expect(
      effectiveLetterStatus({ status: "revoked", expirationDate: "2020-01-01T00:00:00.000Z" }, NOW),
    ).toBe("revoked");
  });

  it("superseded stays superseded past expiration", () => {
    expect(
      effectiveLetterStatus({ status: "superseded", expirationDate: "2020-01-01T00:00:00.000Z" }, NOW),
    ).toBe("superseded");
  });

  it("accepts Date objects for expirationDate", () => {
    expect(
      effectiveLetterStatus({ status: "issued", expirationDate: new Date("2020-01-01T00:00:00.000Z") }, NOW),
    ).toBe("expired");
  });
});

describe("letter lifecycle route guards", () => {
  const lettersSource = () =>
    readFile(join(__dirname, "../server/routes/lending/letters.ts"), "utf8");

  it("revocation is gated to the credit-decision role class", async () => {
    const source = await lettersSource();
    expect(
      source.includes("requireRole(...CREDIT_DECISION_ROLES)"),
      "expected the revoke route to require CREDIT_DECISION_ROLES — revoking a creditworthiness document is the same class of action as setting an approval outcome",
    ).toBe(true);
  });

  it("lifecycle transitions guard on issued IN SQL (supersede + revoke)", async () => {
    const source = await lettersSource();
    expect(
      (source.match(/eq\(preApprovalLetters\.status, "issued"\)/g) || []).length,
      "expected exactly two atomic issued-only guards: the supersede-on-reissue writer and the revocation writer — the status check must compare in SQL, not in JS",
    ).toBe(2);
  });

  it("a revocation requires a recorded reason", async () => {
    const source = await lettersSource();
    expect(
      source.includes("revocationReason: parsed.data.reason"),
      "expected the revoke route to persist the staff-supplied revocationReason on the letter row",
    ).toBe(true);
  });

  it("letter-pdf refuses to serve a revoked letter", async () => {
    const source = await lettersSource();
    expect(
      source.includes('"letter_revoked"'),
      "expected the letter-pdf route to surface revoked status (409, code letter_revoked) instead of serving the PDF silently",
    ).toBe(true);
  });

  it("revocation is audited", async () => {
    const source = await lettersSource();
    expect(
      source.includes('"pre_approval_letter.revoked"'),
      "expected the revoke route to write a pre_approval_letter.revoked audit entry",
    ).toBe(true);
  });

  it("status endpoints report the computed status, expiry included", async () => {
    const source = await lettersSource();
    expect(
      (source.match(/status: effectiveLetterStatus\(letter\)/g) || []).length,
      "expected both letter-status and prequal-status to report effectiveLetterStatus(letter) — the API must never assert 'issued' on an expired letter, whatever the sweep's timing",
    ).toBe(2);
  });

  it("revocation validates with the shared schema; letter-status exposes the revocation target", async () => {
    const source = await lettersSource();
    expect(
      source.includes("letterRevocationSchema.safeParse"),
      "expected the revoke route to validate with the SHARED letterRevocationSchema (shared/letters.ts) — the staff dialog gates its confirm button with the same schema, so the two cannot drift",
    ).toBe(true);
    expect(
      source.includes("letterId: letter.id"),
      "expected letter-status to expose letterId — the staff revocation card's mutation target",
    ).toBe(true);
  });

  it("borrower-facing responses never carry the revocation reason", async () => {
    const source = await lettersSource();
    // revocationReason appears exactly once: the revoke route's own write.
    // letter-status / letter-pdf must not echo staff free text to borrowers.
    expect(
      (source.match(/revocationReason/g) || []).length,
      "expected revocationReason to appear only at its single write site — status and pdf responses must not echo staff free text",
    ).toBe(1);
  });
});

describe("letter expiry sweep", () => {
  const sweepSource = () =>
    readFile(join(__dirname, "../server/services/letterExpiry.ts"), "utf8");

  it("flips only issued rows past their expiration date, both letter tables", async () => {
    const source = await sweepSource();
    expect(
      source.includes('eq(preApprovalLetters.status, "issued")'),
      "expected the sweep to flip only issued pre-approval letters — revoked/superseded are terminal and must never be overwritten by a clock",
    ).toBe(true);
    expect(
      source.includes("lt(preApprovalLetters.expirationDate, now)"),
      "expected the sweep to compare expiration in SQL",
    ).toBe(true);
    expect(
      source.includes('eq(preQualificationLetters.status, "issued")'),
      "expected the sweep to cover pre-qualification letters too — same issued-past-expiration defect",
    ).toBe(true);
  });

  it("writes a letter_expired ledger row per expired pre-approval letter", async () => {
    const source = await sweepSource();
    expect(
      source.includes('"letter_expired"'),
      "expected the sweep to record letter_expired in letter_generation_logs",
    ).toBe(true);
  });

  it("is registered as a job and actually scheduled", async () => {
    const jobsSource = await readFile(join(__dirname, "../server/routes/jobs.ts"), "utf8");
    expect(
      jobsSource.includes('"/api/jobs/letter-expiry"'),
      "expected /api/jobs/letter-expiry registered in jobs.ts with the dual-trigger shape",
    ).toBe(true);

    // .github/workflows/cron-jobs.yml is the ONLY scheduler for this sweep.
    // Both halves are pinned together or it silently never fires: the schedule
    // trigger exists, AND the resolve step maps that expression to this job's
    // path — an unmapped expression never curls anything. This is the
    // "a sweep nobody schedules never runs" invariant.
    const SCHEDULE = "30 12 * * *";
    const cronWorkflow = await readFile(
      join(__dirname, "../.github/workflows/cron-jobs.yml"),
      "utf8",
    );
    expect(
      cronWorkflow.includes(`- cron: "${SCHEDULE}"`),
      `expected cron-jobs.yml to register a schedule trigger for "${SCHEDULE}"`,
    ).toBe(true);
    const escaped = SCHEDULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(
      new RegExp(`"${escaped}"\\)\\s+job="letter-expiry"`).test(cronWorkflow),
      `expected cron-jobs.yml to map "${SCHEDULE}" to the letter-expiry job path`,
    ).toBe(true);
  });
});

// 2026-08-05 pre-flight (WF1-003): the intake cascade persists
// preApprovalAmount "0.00" on undecidable files, and the route's old
// truthy-string fallback printed "PRE-APPROVED AMOUNT $0" on an outward
// creditworthiness document. The resolver is the guard.
describe("resolveLetterAmount (the $0-letter guard)", () => {
  it("ignores the persisted '0.00' and derives from price minus down payment", () => {
    expect(resolveLetterAmount("0.00", "400000", "80000")).toBe(320000);
  });

  it("prefers a real persisted pre-approval amount", () => {
    expect(resolveLetterAmount("315000.00", "400000", "80000")).toBe(315000);
  });

  it("returns null when no positive amount exists — the route must refuse, never print $0", () => {
    expect(resolveLetterAmount("0.00", null, null)).toBeNull();
    expect(resolveLetterAmount(null, "80000", "80000")).toBeNull();
  });

  it("derives from price alone when the down payment is absent", () => {
    expect(resolveLetterAmount(null, "400000", null)).toBe(400000);
  });
});
