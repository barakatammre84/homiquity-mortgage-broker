import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { FINANCIAL_VERIFICATION_ROLES } from "@shared/schema";
import { INTERNAL_STAFF_ROLES, STAFF_ROLES } from "@shared/roles";

// ---------------------------------------------------------------------------
// Client/server role-gate drift regression suite.
//
// A client route gate or action button that admits a role the corresponding
// server API then 403s is a broken page, not a security hole — but it is still
// a defect, and it is invisible until someone signs in as that exact role. The
// audit that produced these tests found three live cases (2026-08-03):
//
//   1. /closing-guarantee was gated to all 8 staff roles, but its primary query
//      GET /api/closing-guarantees is admin-only. Seven roles got a dead page.
//   2. TaskOperations offered "Run Escalation Check" (admin-only server-side)
//      and every role's task queue (canAccessRoleQueue allows a non-admin ONLY
//      its own role) to an underwriter, who 403s on both.
//   3. BorrowerFile gated "Mark Financials Verified" on isStaffRole (all 8),
//      but POST /:id/verify-financials excludes closer, broker, and lender.
//
// These are source-level guards in the same style as statusVocabulary.test.ts:
// they lock the convergence so a future edit can't silently reintroduce the
// hardcoded list that drifted in the first place.
//
// NOTE: authorization is enforced server-side; narrowing a client gate is
// defense-in-depth and never the security boundary itself. See
// tests/roleSeparation.test.ts for the HTTP-level authorization suite.
// ---------------------------------------------------------------------------

const repoRoot = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

describe("FINANCIAL_VERIFICATION_ROLES is the single source of truth", () => {
  it("excludes closer and every external partner role", () => {
    // closer is a closing-stage role, not a document reviewer; broker/lender are
    // external partners who never review borrower documentation.
    expect(FINANCIAL_VERIFICATION_ROLES).not.toContain("closer");
    expect(FINANCIAL_VERIFICATION_ROLES).not.toContain("broker");
    expect(FINANCIAL_VERIFICATION_ROLES).not.toContain("lender");
  });

  it("is a strict subset of internal staff", () => {
    for (const role of FINANCIAL_VERIFICATION_ROLES) {
      expect(INTERNAL_STAFF_ROLES as readonly string[]).toContain(role);
    }
    expect(FINANCIAL_VERIFICATION_ROLES.length).toBeLessThan(STAFF_ROLES.length);
  });

  it("gates the verify-financials routes on the server", () => {
    const source = read("server/routes/lending/statusDecisions.ts");
    // Both the all-or-nothing and the per-dimension verification routes must read
    // the shared constant rather than an inline list that can drift from the client.
    expect(source).toContain("requireRole(...FINANCIAL_VERIFICATION_ROLES)");
    expect(source).not.toMatch(
      /requireRole\(\s*"admin",\s*"lo",\s*"loa",\s*"processor",\s*"underwriter"\s*\)/,
    );
  });

  it("routes reviewed financial evidence through the granular verifier", () => {
    const file = read("client/src/pages/staff/BorrowerFile.tsx");
    const review = read("client/src/pages/staff/borrowerFile/FinancialReviewTab.tsx");
    expect(file).toContain(
      'FINANCIAL_VERIFICATION_ROLES.includes(user?.role || "")',
    );
    expect(file).not.toContain("button-verify-financials");
    expect(file).not.toContain("/verify-financials");
    expect(review).toContain("/verify/income");
    expect(review).toContain("/verify/assets");
    expect(file).toContain("canVerify={canVerifyFinancials}");
  });
});

describe("client route gates match their server APIs", () => {
  it("/closing-guarantee is admin-only, matching GET /api/closing-guarantees", () => {
    const app = read("client/src/App.tsx");
    const route = app.slice(app.indexOf('<Route path="/closing-guarantee">'));
    const block = route.slice(0, route.indexOf("</Route>"));
    expect(block).toContain("<AdminPage>");
    expect(block).not.toContain("<StaffPage>");

    // ...and the server side really is admin-only, so this stays honest if the
    // endpoint is ever scoped per-caller instead.
    const server = read("server/routes/borrower/guaranteesHomeowner.ts");
    const handler = server.slice(
      server.indexOf('app.get("/api/closing-guarantees"'),
    );
    expect(handler.slice(0, 400)).toContain("!isAdmin(req.user)"); // CH-4: shared predicate
  });
});

describe("TaskOperations only offers what an underwriter can actually call", () => {
  const source = read("client/src/pages/staff/TaskOperations.tsx");

  it("hides the admin-only escalation trigger from non-admins", () => {
    expect(source).toMatch(/\{isAdmin && \([\s\S]{0,400}button-run-escalation/);

    // The server gate this mirrors is an inline admin check, not requireRole.
    const server = read("server/routes/task-engine.ts");
    const handler = server.slice(
      server.indexOf('app.post("/api/task-engine/run-escalation"'),
    );
    expect(handler.slice(0, 400)).toContain('userRole !== "admin"');
  });

  it("offers other roles' task queues to admins only", () => {
    // canAccessRoleQueue lets a non-admin read ONLY its own role's queue, so the
    // cross-role SelectItems must sit behind isAdmin.
    const select = source.slice(
      source.indexOf('<SelectItem value="all">'),
      source.indexOf("</SelectContent>"),
    );
    expect(select).toContain("{isAdmin ? (");
    for (const role of ["LO", "LOA", "PROCESSOR", "UW", "CLOSER", "BORROWER"]) {
      const item = `<SelectItem value="${role}">`;
      if (!select.includes(item)) continue;
      expect(select.indexOf("{isAdmin ? (")).toBeLessThan(select.indexOf(item));
    }
  });
});

describe("lender-match surfaces are staff-gated", () => {
  // matchBorrowerToLenders / matchAndPriceBorrower return wholesale lender
  // identity (lenderName/lenderId) plus uncited rate math — both barred from
  // borrowers (wholesale-identity redaction doctrine, shared/borrowerOfferView.ts;
  // multi-lender fit itself is the tracked B5 deferral, kb log 2026-07-12 §2).
  // Until B5 reopens with a redaction layer + citation-backed pricing (F11),
  // these are internal staff tooling — the same boundary as
  // GET /api/admin/lender-products. Source guard so a future edit can't quietly
  // re-open them to any authenticated borrower.
  it("intelligence.ts gates both lender-matches routes with requireRole(...INTERNAL_STAFF_ROLES)", () => {
    const source = read("server/routes/intelligence.ts");
    for (const route of ['"/api/intelligence/lender-matches"', '"/api/intelligence/lender-matches/top"']) {
      const at = source.indexOf(route);
      expect(at, `${route} registration not found`).toBeGreaterThan(-1);
      const registration = source.slice(at, at + 200);
      expect(registration, `${route} must be staff-gated`).toContain("requireRole(...INTERNAL_STAFF_ROLES)");
      expect(registration, `${route} must not sit behind bare isAuthenticated`).not.toContain("isAuthenticated");
    }
  });

  it("the dead optimizations route stays deleted (OPT-cleanup) — resurrect only with gates", () => {
    // The zero-caller /api/optimizations/* surface (incl. match-and-price,
    // which this suite used to gate-check) was deleted 2026-08-05 with
    // OPT-7/OPT-8. If someone recreates it, this guard forces the
    // staff-gating conversation the old pin enforced.
    expect(existsSync(resolve(repoRoot, "server/routes/optimizations.ts"))).toBe(false);
    expect(read("server/routes.ts")).not.toContain("registerOptimizationRoutes");
  });
});

describe("engine-calculation routes are staff-gated", () => {
  // The six legacy engine endpoints return computed qualifying-income, DTI, and
  // LLPA-pricing figures over unverified self-stated inputs. A borrower-reachable
  // qualifying figure breaches "no live qualifying figures to borrowers before
  // human verification" (kb logs: 2026-08-04 rate-com §6.1, sovereign-stack §3.1).
  // Staff analysis tooling at the same reviewer boundary as
  // POST /:id/verify-financials (FINANCIAL_VERIFICATION_ROLES — closer and the
  // external partner roles excluded). Borrower-facing income transparency arrives
  // via Borrower Clarity PR 7's post-decision whitelisted DTO, never these routes.
  // Source guard so a future edit can't quietly re-open them.
  it("calculations.ts gates all six engine endpoints with requireRole(...FINANCIAL_VERIFICATION_ROLES)", () => {
    const source = read("server/routes/underwriting/calculations.ts");
    for (const route of [
      '"/api/loan-applications/:id/calculate-income"',
      '"/api/loan-applications/:id/calculate-assets"',
      '"/api/loan-applications/:id/calculate-liabilities"',
      '"/api/loan-applications/:id/calculate-dti"',
      '"/api/loan-applications/:id/check-property-eligibility"',
      '"/api/loan-applications/:id/calculate-pricing"',
    ]) {
      const at = source.indexOf(route);
      expect(at, `${route} registration not found`).toBeGreaterThan(-1);
      const registration = source.slice(at, at + 200);
      expect(registration, `${route} must be staff-gated`).toContain(
        "requireRole(...FINANCIAL_VERIFICATION_ROLES)",
      );
      expect(registration, `${route} must not sit behind bare isAuthenticated`).not.toContain(
        "isAuthenticated",
      );
    }
  });
});

describe("ROUTE_GATES.partnerHub mirrors the server gate on /api/partners/me", () => {
  // Closes the drift the file itself had documented since 2026-08-03 and never
  // fixed: the client gate admitted `cpa` while server/routes/partners.ts
  // answered requireRole("realtor","admin"), so a CPA who reached /partners/hub
  // rendered a page whose every data call 403'd. Fail-closed, so it was a broken
  // page rather than a leak — but broken for six days and invisible unless you
  // signed in as that exact role.
  //
  // It is fixed by NARROWING the client, never by widening the server: PartnerHub
  // serves referral and commission data, and RESPA section 8(a) bars referral
  // compensation to CPAs in any form. Widening would have built the thing the
  // charter forbids. CPAs keep their own inviter-only surface (`cpaPortal`).
  const gates = read("client/src/lib/routeGates.ts");
  const partners = read("server/routes/partners.ts");

  it("does not admit cpa", () => {
    const at = gates.indexOf("partnerHub:");
    expect(at, "partnerHub gate not found").toBeGreaterThan(-1);
    const decl = gates.slice(at, gates.indexOf("]", at) + 1);
    expect(decl).not.toContain('"cpa"');
    expect(decl).toContain('"realtor"');
    expect(decl).toContain('"admin"');
  });

  it("still matches what the server actually enforces", () => {
    // If someone later widens the server, this fails and forces the client gate
    // to be reconsidered deliberately rather than drifting again.
    for (const route of ['"/api/partners/me"', '"/api/partners/me/referrals"']) {
      const at = partners.indexOf(route);
      expect(at, `${route} registration not found`).toBeGreaterThan(-1);
      const registration = partners.slice(at, at + 120);
      expect(registration, `${route} must stay realtor/admin`).toContain(
        'requireRole("realtor", "admin")',
      );
    }
  });

  it("keeps cpa on its own portal, so the role is not left without a surface", () => {
    const at = gates.indexOf("cpaPortal:");
    expect(at, "cpaPortal gate not found").toBeGreaterThan(-1);
    expect(gates.slice(at, gates.indexOf("]", at) + 1)).toContain('"cpa"');
  });
});
