import { describe, it, expect, beforeAll } from "vitest";
import { apiPost, apiGet } from "./setup";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";

// Dev test-login accounts all share DEV_TEST_PASSWORD (see TEST_ACCOUNTS.md).
const TEST_PASSWORD = process.env.DEV_TEST_PASSWORD || "test1234";

// Log in as a role and return the session cookie for authenticated requests.
async function loginCookie(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/test-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const setCookie = res.headers.get("set-cookie");
  return setCookie ? setCookie.split(";")[0] : "";
}

async function waitForTaxPackage(documentId: string, cookie: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const status = await apiGet(`/api/documents/${documentId}/tax-intelligence`, {
      headers: { Cookie: cookie },
    });
    if (status.status === 200 && status.body?.status === "completed") return status.body;
    if (status.status === 200 && ["failed", "cancelled"].includes(status.body?.status)) {
      throw new Error(`Tax package ended as ${status.body.status}: ${status.body.error ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for durable tax package processing");
}

/**
 * Tax Return Insight routes. The preflight and CI integration servers run with
 * EXTRACTION_SIMULATE=true and blank model credentials so extraction is
 * deterministic without private object storage or external model calls.
 *
 * renter@test.com is the incubator persona (no application) — exactly the
 * user this consumer-direct flow serves.
 */
describe("Tax insight routes", () => {
  let renterCookie: string;
  let documentId: string;

  beforeAll(async () => {
    renterCookie = await loginCookie("renter@test.com", TEST_PASSWORD);
    expect(renterCookie).toBeTruthy();

    // Register an application-less tax-return document. Object storage is
    // unconfigured in local dev, so registration trusts the supplied path
    // (dev-only behavior) and simulated extraction never reads the file.
    const reg = await apiPost(
      "/api/documents/upload",
      {
        objectPath: `/objects/test-tax-insight-${Date.now()}.pdf`,
        fileName: "test-tax-return-2025.pdf",
        fileSize: 123456,
        mimeType: "application/pdf",
        documentType: "tax_return",
      },
      { headers: { Cookie: renterCookie } },
    );
    expect(reg.status).toBeLessThan(300);
    documentId = reg.body?.id;
    expect(documentId).toBeTruthy();
  });

  it("rejects unauthenticated processing and listing", async () => {
    const process_ = await apiPost("/api/tax-insights/process", { documentId: "any" });
    expect(process_.status).toBe(401);
    const me = await apiGet("/api/tax-insights/me");
    expect(me.status).toBe(401);
  });

  it("gates processing on tax_document_use consent, then processes after consent", async () => {
    // Consent may already exist from a prior run (borrower_consents persist).
    const consents = await apiGet("/api/consents/me", { headers: { Cookie: renterCookie } });
    const hadConsent =
      Array.isArray(consents.body) &&
      consents.body.some(
        (c: any) => c.consentType === "tax_document_use" && c.consentGiven && !c.isRevoked,
      );

    if (!hadConsent) {
      const blocked = await apiPost(
        "/api/tax-insights/process",
        { documentId },
        { headers: { Cookie: renterCookie } },
      );
      expect(blocked.status).toBe(403);
      expect(blocked.body?.code).toBe("CONSENT_REQUIRED");
      expect(blocked.body?.consentType).toBe("tax_document_use");

      const consent = await apiPost(
        "/api/consents",
        { consentType: "tax_document_use", consentGiven: true, consentMethod: "click" },
        { headers: { Cookie: renterCookie } },
      );
      expect(consent.status).toBe(201);
    }

    const processed = await apiPost(
      "/api/tax-insights/process",
      { documentId },
      { headers: { Cookie: renterCookie } },
    );
    expect(processed.status).toBe(202);
    expect(["pending", "running", "completed"]).toContain(processed.body?.status);
    const completed = await waitForTaxPackage(documentId, renterCookie);
    expect(completed.formCount).toBeGreaterThan(0);

    // The encrypted raw model response must never reach the client.
    const raw = JSON.stringify(processed.body);
    expect(raw).not.toContain("rawResponseEncrypted");
    expect(raw).not.toContain("rawResponseIv");
    expect(raw).not.toContain("rawResponseKeyId");
  });

  it("returns the caller's insights from /api/tax-insights/me", async () => {
    const me = await apiGet("/api/tax-insights/me", { headers: { Cookie: renterCookie } });
    expect(me.status).toBe(200);
    expect(Array.isArray(me.body?.insights)).toBe(true);
    expect(me.body.insights.length).toBeGreaterThan(0);
    expect(me.body.insights[0].taxYear).toBeTypeOf("number");
  });

  it("rejects reviewed documents before starting more model work", async () => {
    const adminCookie = await loginCookie("admin@test.com", TEST_PASSWORD);
    expect(adminCookie).toBeTruthy();
    const reviewed = await apiPost(
      `/api/documents/${documentId}/verify`,
      { status: "verified" },
      { headers: { Cookie: adminCookie } },
    );
    expect(reviewed.status).toBe(200);

    const processAgain = await apiPost(
      "/api/tax-insights/process",
      { documentId },
      { headers: { Cookie: renterCookie } },
    );
    expect(processAgain.status).toBe(409);
    expect(processAgain.body?.code).toBe("DOCUMENT_ALREADY_REVIEWED");
  });

  it("refuses to process another user's document", async () => {
    const buyerCookie = await loginCookie("buyer@test.com", TEST_PASSWORD);
    expect(buyerCookie).toBeTruthy();
    const res = await apiPost(
      "/api/tax-insights/process",
      { documentId },
      { headers: { Cookie: buyerCookie } },
    );
    expect([403, 404]).toContain(res.status);
  });

  it("origination extract route performs no tax processing without consent", async () => {
    const buyerCookie = await loginCookie("buyer@test.com", TEST_PASSWORD);
    expect(buyerCookie).toBeTruthy();

    // buyer may have consented in a previous run — branch the assertion.
    const consents = await apiGet("/api/consents/me", { headers: { Cookie: buyerCookie } });
    const hasConsent =
      Array.isArray(consents.body) &&
      consents.body.some(
        (c: any) => c.consentType === "tax_document_use" && c.consentGiven && !c.isRevoked,
      );

    const reg = await apiPost(
      "/api/documents/upload",
      {
        objectPath: `/objects/test-extract-hook-${Date.now()}.pdf`,
        fileName: "buyer-tax-return-2025.pdf",
        fileSize: 23456,
        mimeType: "application/pdf",
        documentType: "tax_return",
      },
      { headers: { Cookie: buyerCookie } },
    );
    expect(reg.status).toBeLessThan(300);

    const extract = await apiPost(
      `/api/documents/${reg.body.id}/extract`,
      {},
      { headers: { Cookie: buyerCookie } },
    );
    expect(extract.status).toBe(hasConsent ? 200 : 403);
    if (!hasConsent) {
      expect(extract.body?.code).toBe("CONSENT_REQUIRED");
    }

    const me = await apiGet("/api/tax-insights/me", { headers: { Cookie: buyerCookie } });
    expect(me.status).toBe(200);
    if (!hasConsent) {
      // The source file remains available, but no extraction or projection runs.
      expect(me.body.insights.length).toBe(0);
    } else {
      expect(me.body.insights.length).toBeGreaterThan(0);
    }
  });

  it("rejects a non-tax-return document type", async () => {
    const reg = await apiPost(
      "/api/documents/upload",
      {
        objectPath: `/objects/test-paystub-${Date.now()}.pdf`,
        fileName: "test-paystub.pdf",
        fileSize: 4567,
        mimeType: "application/pdf",
        documentType: "pay_stub",
      },
      { headers: { Cookie: renterCookie } },
    );
    expect(reg.status).toBeLessThan(300);
    const res = await apiPost(
      "/api/tax-insights/process",
      { documentId: reg.body.id },
      { headers: { Cookie: renterCookie } },
    );
    expect(res.status).toBe(400);
  });
});

/**
 * tax_document_use revocation — the template text promises "You can revoke
 * this authorization at any time", so revocation must (a) flip isRevoked on
 * the consent rows, (b) purge derived tax_insights so the staff DSCR feed and
 * borrower graph stop reading them, and (c) re-lock the processing gate.
 *
 * Self-contained: ensures its own consent + insight in beforeAll, so it holds
 * regardless of what earlier blocks left behind. It deliberately ends with the
 * renter unconsented, which exercises the consent-gate branch in the block
 * above on the next run.
 */
describe("Tax consent revocation", () => {
  let renterCookie: string;

  const registerTaxDoc = async () => {
    const reg = await apiPost(
      "/api/documents/upload",
      {
        objectPath: `/objects/test-tax-revoke-${Date.now()}.pdf`,
        fileName: "test-tax-return-2025.pdf",
        fileSize: 123456,
        mimeType: "application/pdf",
        documentType: "tax_return",
      },
      { headers: { Cookie: renterCookie } },
    );
    expect(reg.status).toBeLessThan(300);
    return reg.body.id as string;
  };

  beforeAll(async () => {
    renterCookie = await loginCookie("renter@test.com", TEST_PASSWORD);
    expect(renterCookie).toBeTruthy();

    // Ensure an active consent and at least one derived insight exist.
    const consents = await apiGet("/api/consents/me", { headers: { Cookie: renterCookie } });
    const hasConsent =
      Array.isArray(consents.body) &&
      consents.body.some(
        (c: any) => c.consentType === "tax_document_use" && c.consentGiven && !c.isRevoked,
      );
    if (!hasConsent) {
      const consent = await apiPost(
        "/api/consents",
        { consentType: "tax_document_use", consentGiven: true, consentMethod: "click" },
        { headers: { Cookie: renterCookie } },
      );
      expect(consent.status).toBe(201);
    }

    const queuedDocumentId = await registerTaxDoc();
    const processed = await apiPost(
      "/api/tax-insights/process",
      { documentId: queuedDocumentId },
      { headers: { Cookie: renterCookie } },
    );
    expect(processed.status).toBe(202);
    await waitForTaxPackage(queuedDocumentId, renterCookie);
  });

  it("rejects unauthenticated revocation", async () => {
    const res = await apiPost("/api/consents/tax_document_use/revoke", {});
    expect(res.status).toBe(401);
  });

  it("rejects consent types that are not borrower-self-revocable", async () => {
    const res = await apiPost(
      "/api/consents/credit_check/revoke",
      {},
      { headers: { Cookie: renterCookie } },
    );
    expect(res.status).toBe(400);
  });

  it("revokes the consent, purges derived insights, and re-locks the gate", async () => {
    const res = await apiPost(
      "/api/consents/tax_document_use/revoke",
      {},
      { headers: { Cookie: renterCookie } },
    );
    expect(res.status).toBe(200);
    expect(res.body?.revoked).toBeGreaterThan(0);
    expect(res.body?.taxInsightsDeleted).toBeGreaterThan(0);

    // No active consent row remains…
    const consents = await apiGet("/api/consents/me", { headers: { Cookie: renterCookie } });
    expect(consents.status).toBe(200);
    const active = (consents.body as any[]).filter(
      (c) => c.consentType === "tax_document_use" && c.consentGiven && !c.isRevoked,
    );
    expect(active.length).toBe(0);

    // …the derived rows are gone (this is what the staff DSCR feed and the
    // borrower graph read — they select from tax_insights)…
    const me = await apiGet("/api/tax-insights/me", { headers: { Cookie: renterCookie } });
    expect(me.status).toBe(200);
    expect(me.body.insights.length).toBe(0);

    // …and processing is blocked again until fresh consent.
    const blocked = await apiPost(
      "/api/tax-insights/process",
      { documentId: await registerTaxDoc() },
      { headers: { Cookie: renterCookie } },
    );
    expect(blocked.status).toBe(403);
    expect(blocked.body?.code).toBe("CONSENT_REQUIRED");
  });

  it("returns 404 when there is no active consent to revoke", async () => {
    const res = await apiPost(
      "/api/consents/tax_document_use/revoke",
      {},
      { headers: { Cookie: renterCookie } },
    );
    expect(res.status).toBe(404);
  });
});
