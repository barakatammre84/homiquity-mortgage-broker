import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * Compliance invariants — executable guardrails.
 *
 * These assertions turn the platform's federal/industry compliance posture
 * into tests that fail loudly if a change drifts:
 *  - Reg B (ECOA): AI services must NEVER sit in the credit-decision path.
 *  - FCRA: credit pulls stay consent-gated; the funnel persists consent.
 *  - ESIGN / Reg Z: disclosure gates stay wired to their routes.
 *  - Guideline traceability: every underwriting rule cites its source.
 *  - MCP protocol safety: stdout stays reserved for JSON-RPC.
 *
 * If one of these fails, treat it as a compliance incident, not a flaky test.
 */

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// The lending route groups (split from the old single routes/lending.ts).
const routeDirFiles = (dir: string) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${dir}/${f}`);
const lendingRouteFiles = () =>
  readdirSync(join(ROOT, "server/routes/lending"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `server/routes/lending/${f}`);
const readLendingRoutes = () => lendingRouteFiles().map(read).join("\n");

// Modules that make or feed credit decisions — the "decision path".
const DECISION_PATH_MODULES = [
  "server/services/underwritingNuance.ts",
  "server/services/preUnderwriting.ts",
  "server/services/decisionEngine.ts",
  "server/services/loanAnalysis.ts",
  "server/services/ausSubmission.ts",
  "server/pricing.ts",
  "server/underwriting.ts",
  "server/underwritingEngine.ts",
];

// Imports that would put an AI model in the decision path.
const AI_IMPORT_PATTERNS = [
  /from\s+["']openai["']/,
  /from\s+["']@google\/genai["']/,
  /from\s+["'][^"']*\/coaching[A-Za-z]*["']/,
  /from\s+["'][^"']*\/gemini["']/,
  /from\s+["'][^"']*riskBrief["']/,
  /@anthropic-ai\/sdk/,
];

describe("Reg B (ECOA): AI stays out of the credit-decision path", () => {
  for (const module of DECISION_PATH_MODULES) {
    it(`${module} imports no AI service`, () => {
      const source = read(module);
      for (const pattern of AI_IMPORT_PATTERNS) {
        expect(source).not.toMatch(pattern);
      }
    });
  }
});

describe("FCRA: credit pulls remain consent-gated", () => {
  it("the MCP soft-pull tool hard-fails without an active covering consent — before any bureau data, cached included", () => {
    // The gate lives in softPullGate.ts (F-042) so its ORDER is unit-testable:
    // consent first, cache second, and the consent's TYPE must cover the pull.
    // Behavioral teeth are in tests/mcpSoftPullGate.test.ts (including that a
    // refusal never touches the credit_pulls table); this invariant pins the
    // wiring. Strictly stronger than the pre-F-042 form of this test, which
    // only asserted a consent query existed SOMEWHERE in index.ts — where it
    // sat below the cached-pull return.
    const handler = read("server/mcp/index.ts");
    expect(handler).toContain("evaluateSoftPull");
    expect(handler).toMatch(/FCRA: no active credit consent/);

    const gate = read("server/mcp/softPullGate.ts");
    expect(gate).toContain("creditConsents");
    expect(gate).toContain("consentCoversPullType");
    expect(gate).toContain("no_active_consent");
    expect(gate).toContain("consent_scope_mismatch");
  });

  it("the funnel persists the soft-pull acknowledgment as evidence", () => {
    const source = read("server/routes/lending/applications.ts");
    expect(source).toContain("softPullConsentAccepted");
    expect(source).toContain("createCreditConsent");
  });
});

describe("ESIGN / Reg Z: disclosure gates stay wired", () => {
  it("Loan Estimate delivery requires the e_disclosure consent", () => {
    const source = read("server/routes/underwriting/delivery.ts");
    expect(source).toMatch(/loan-estimate.*requireConsent\("e_disclosure"\)/s);
  });

  it("rate locking requires the anti-steering acknowledgment for borrowers", () => {
    const source = read("server/routes/lending/pricing.ts");
    expect(source).toMatch(/hasBorrowerConsent\("anti_steering"/);
  });

  it("the anti-steering template cites Reg Z §1026.36(e)", () => {
    const source = read("server/consentGate.ts");
    expect(source).toContain("1026.36(e)");
  });
});

describe("Guideline traceability: underwriting rules cite their sources", () => {
  it("underwritingNuance cites every governing guideline", () => {
    const source = read("server/services/underwritingNuance.ts");
    // 2026-08-20: was "B3-3.2". The rule assessIncomeSeasoning implements is
    // Length of Self-Employment — a two-year earnings history, or under two
    // years where the returns show a full 12 months in the current business.
    // That lives in B3-3.5-01. B3-3.2-01 is a different topic (verbal VOE and
    // verifying business existence within 120 days) and never stated this rule,
    // so the old cite pointed auditors at text that does not contain it.
    // Verified against docs/fannie-mae/selling-guide/ (08-05-2026 edition).
    expect(source).toContain("B3-3.5-01"); // income seasoning / length of self-employment
    expect(source).toContain("B3-6-05"); // deferred student loans
    expect(source).toContain("B3-4.2-02"); // large-deposit sourcing (depository accounts)
    expect(source).toContain("B3-4.3-04"); // gift funds resolution path
    expect(source).toContain("26-7"); // VA residual income
  });

  it("the deferred-student-loan factor remains exactly 1%", () => {
    const source = read("server/services/underwritingNuance.ts");
    expect(source).toMatch(/DEFERRED_STUDENT_LOAN_FACTOR\s*=\s*0\.01/);
  });

  // B3-6-05, Debts Paid by Others (08/05/2026 edition): one shared predicate,
  // read by every DTI path. Two implementations of a regulated exclusion is the
  // drift the VA-residual case above already paid for once.
  it("the Debts-Paid-by-Others rule cites B3-6-05 and is the single predicate every DTI path reads", () => {
    const rule = read("shared/liabilityExclusions.ts");
    expect(rule).toContain("B3-6-05");
    expect(rule).toContain("Debts Paid by Others");
    expect(rule).toContain("12 months");
    for (const [file, symbol] of [
      ["server/services/decisionEngine.ts", "isExcludedAsPaidByOtherParty"],
      ["server/underwriting.ts", "assessPaidByOtherParty"],
      ["server/mismo.ts", "isExcludedAsPaidByOtherParty"],
      ["server/services/preUnderwriting.ts", "assessPaidByOtherParty"],
    ] as const) {
      expect(read(file), `${file} must read the shared B3-6-05 predicate`).toContain(symbol);
    }
  });

  it("the VA utility rate remains the statutory $0.14/sqft", () => {
    const source = read("server/services/underwritingNuance.ts");
    expect(source).toMatch(/VA_UTILITY_RATE_PER_SQFT\s*=\s*0\.14/);
  });

  // 2026-07-04 (roadmap #29): the live engine carried its own inline VA residual
  // math (uncited 18% tax rate, &&-gated 5% reduction, uncapped family addition)
  // that drifted from the cited reference module — and these citation checks only
  // read underwritingNuance.ts, so the drift was invisible. The engine must now
  // share the cited constants; duplicated regulated math is itself a violation.
  it("the live engine shares the cited VA residual constants — no forked regulated math", () => {
    const engine = read("server/underwritingEngine.ts");
    for (const constant of [
      "RESIDUAL_TAX_RATE",
      "VA_RESIDUAL_REDUCTION_FACTOR",
      "VA_EXTRA_MEMBER_FAMILY_CAP",
      // Three stragglers de-forked 2026-08-20: the 2026-07-04 pass shared the
      // constants it knew about and these survived as literals.
      "VA_UTILITY_RATE_PER_SQFT",
      "VA_CUSHION_MULTIPLIER",
      "VA_DTI_CUSHION_TRIGGER",
    ]) {
      expect(engine, `engine must use the shared ${constant}`).toContain(constant);
    }
    // The retired inline literals must not reappear (a ban-list only bans what
    // someone already thought of — the real guard is the behavioral parity
    // suite in vaResidualEngineParity.test.ts; this is belt-and-braces):
    expect(engine).not.toMatch(/\*\s*0\.18\b/);
    expect(engine).not.toMatch(/\*\s*0\.95\b/);
    expect(engine).not.toMatch(/\*\s*0\.14\b/);
    expect(engine).not.toMatch(/\*\s*1\.2\b/);
    expect(engine).not.toMatch(/>\s*41\.0\b/);
  });

  it("the VA residual reduction stays 5% and DISJUNCTIVE (26-7 Ch. 4, Topic 9, Item 43)", () => {
    const source = read("server/services/underwritingNuance.ts");
    expect(source).toMatch(/VA_RESIDUAL_REDUCTION_FACTOR\s*=\s*0\.95/);
    const engine = read("server/underwritingEngine.ts");
    expect(engine).toMatch(/input\.isActiveDuty\s*\|\|\s*input\.hasExchangeAccess/);
  });

  it("the extra-member addition caps at a family of seven (26-7 Ch. 4, Topic 9, Item 43)", () => {
    const source = read("server/services/underwritingNuance.ts");
    expect(source).toMatch(/VA_EXTRA_MEMBER_FAMILY_CAP\s*=\s*7/);
    const engine = read("server/underwritingEngine.ts");
    expect(engine).toContain("Math.min(familySize, VA_EXTRA_MEMBER_FAMILY_CAP)");
  });

  // UAL P7: the alternative-structure translation math is regulated
  // calculation surface. The research doc (§3) requires the author to extend
  // this guard to the new file — citations must be present, and the
  // equivalent rate must come from the SHARED Appendix J solver, never a
  // forked one (same rule as the VA-residual case above).
  it("structureTranslation cites its authority and shares the Appendix J solver", () => {
    const source = read("server/services/structureTranslation.ts");
    expect(source).toContain("UNIVERSAL_ADAPTATION_LAYER.md");
    expect(source).toContain("§1026.22");
    expect(source).toMatch(/import \{[^}]*solveAPRFromStream[^}]*\} from "\.\/apr"/);
    // No forked solver: the file must not implement its own root-finding.
    expect(source).not.toMatch(/presentValue|bisection|while\s*\(/i);
  });

  it("structureTranslation stays translation-only — no pricing or Shariah judgment", () => {
    const source = read("server/services/structureTranslation.ts");
    // Every economic input comes from the funder's term sheet; the module
    // must not carry its own rate/markup defaults.
    expect(source).not.toMatch(/DEFAULT_(RATE|YIELD|MARKUP)/);
    expect(source).toContain("TRANSLATION ONLY");
  });
});

describe("Reg B: the intake decision path is fully deterministic", () => {
  it("the intake route no longer imports the retired LLM analysis module", () => {
    const source = readLendingRoutes();
    expect(source).not.toMatch(/from\s+["'][^"']*\/gemini["']/);
    // The route drives the deterministic finalizer, which wraps the engine.
    expect(source).toContain("finalizeIntake");
    const analysis = read("server/services/loanAnalysis.ts");
    expect(analysis).toContain("analyzeIntake");
  });

  it("intake analysis derives approval from the engine, never sets denied itself", () => {
    const source = read("server/services/loanAnalysis.ts");
    // Approval comes from the deterministic engine's decision…
    expect(source).toMatch(/decision\?\.decision === "APPROVED"/);
    // …and the only statuses intake may set exclude "denied" (ECOA locus:
    // only a human may deny, with adverse-action handling).
    expect(source).toMatch(/"pre_approved" \| "under_review"/);
    expect(source).not.toMatch(/outcome[^\n]*"denied"/);
  });
});

describe("TRID (Reg Z §1026.19): the LE clock is triggered, business-day based, and enforced", () => {
  it("the six-piece trigger is evaluated on every write path that can complete an application", () => {
    // Intake creation + borrower PATCH (income, property address, value, loan amount)…
    // intake creation and the borrower PATCH live in separate group files now —
    // pin each write path individually.
    expect(read("server/routes/lending/applications.ts")).toMatch(/evaluateTridTrigger\(/);
    expect(read("server/routes/lending/statusDecisions.ts")).toMatch(/evaluateTridTrigger\(/);
    // …and the URLA SSN save. A whole-file match here is NOT sufficient: the
    // client only ever calls POST /api/urla/:id/save (URLAForm.tsx). A
    // whole-file regex previously passed even though /save never called the
    // trigger, because a dead POST /api/urla/:id/personal-info route (no
    // client caller — since deleted, intake-04) happened to contain the call
    // instead (this happened for real — intake-01, fixed alongside this
    // test). Scope the assertion to the /save handler specifically.
    const borrowerUrla = read("server/routes/borrower/urla.ts");
    const saveHandlerStart = borrowerUrla.indexOf('app.post("/api/urla/:applicationId/save"');
    const saveHandlerEnd = borrowerUrla.indexOf("// ===== ASPIRING OWNER JOURNEY API =====");
    expect(saveHandlerStart).toBeGreaterThan(-1);
    expect(saveHandlerEnd).toBeGreaterThan(saveHandlerStart);
    const saveHandlerSource = borrowerUrla.slice(saveHandlerStart, saveHandlerEnd);
    expect(saveHandlerSource).toMatch(/evaluateTridTrigger\(/);
  });

  it("only the trid service writes tridTriggeredAt", () => {
    const trid = read("server/services/trid.ts");
    expect(trid).toMatch(/updateLoanApplication\([^)]*tridTriggeredAt/s);
    // Every borrower route group, so new group files are covered automatically.
    const borrowerRoutes = readdirSync(join(ROOT, "server/routes/borrower"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `server/routes/borrower/${f}`);
    for (const route of [...lendingRouteFiles(), ...borrowerRoutes, ...routeDirFiles("server/routes/underwriting"), "server/services/coachProfileSync.ts"]) {
      expect(read(route)).not.toMatch(/tridTriggeredAt\s*:/);
    }
  });

  it("the AI-coach intake writeback evaluates the trigger too (it can supply the last of the six items)", () => {
    const sync = read("server/services/coachProfileSync.ts");
    expect(sync).toMatch(/evaluateTridTrigger\(/);
  });

  it("LE timing math is business-day based — never calendar setDate arithmetic", () => {
    const loanEstimate = read("server/services/loanEstimate.ts");
    expect(loanEstimate).toMatch(/from\s+["']\.\/businessDays["']/);
    expect(loanEstimate).not.toMatch(/setDate\([^)]*\+\s*3\)/);
    const mismo = read("server/services/mismoValidation.ts");
    expect(mismo).toMatch(/from\s+["']\.\/businessDays["']/);
  });

  it("status and stage advancement enforce the TRID hard stop", () => {
    expect(read("server/routes/lending/statusDecisions.ts")).toMatch(/tridHardStopError\(/);
    expect(read("server/routes/underwriting/pipeline.ts")).toMatch(/tridHardStopError\(/);
  });

  it("borrower LE retrieval persists the delivery date", () => {
    const underwriting = read("server/routes/underwriting/delivery.ts");
    expect(underwriting).toMatch(/leIssuedDate/);
    expect(underwriting).toMatch(/trid\.loan_estimate_delivered/);
  });
});

describe("Reg Z §1026.22: every displayed APR comes from the actuarial engine", () => {
  it("advertised rates use the APR solver, not flat spreads", () => {
    const rateService = read("server/services/rateService.ts");
    expect(rateService).toMatch(/advertisedAPR\(/);
    expect(rateService).not.toMatch(/rate\s*\+\s*0\.(2|45)\b/);
    expect(rateService).not.toMatch(/rate\.rate\s*\+\s*0\.002/);
  });

  it("the Loan Estimate APR is solved from the payment stream and its fee schedule", () => {
    const loanEstimate = read("server/services/loanEstimate.ts");
    expect(loanEstimate).toMatch(/calculateMortgageAPR\(/);
    expect(loanEstimate).toMatch(/prepaidFinanceCharges/);
  });

  it("non-rate-locked pre-approval letters do not quote a rate-derived payment", () => {
    const lending = read("server/routes/lending/letters.ts");
    expect(lending).not.toMatch(/return 0\.0(65|7)/);
    expect(lending).not.toMatch(/currentAdvertised30YrRate/);
    expect(lending).not.toMatch(/computeDecisionPaymentProjection/);
    expect(lending).not.toMatch(/monthlyPaymentEstimate:/);
  });
});

describe("ECOA/Reg B §1002.9: a denial cannot outrun its adverse-action notice", () => {
  it("EVERY denial route runs through the shared adverse-action chokepoint", () => {
    // Both denial paths — the status PATCH and the pipeline advance-stage
    // POST — must call ensureAdverseActionForDenial before the disposition
    // is applied. A denial path that skips it reopens the §1002.9 hole.
    for (const route of ["server/routes/lending/statusDecisions.ts", "server/routes/underwriting/pipeline.ts"]) {
      expect(read(route)).toMatch(/ensureAdverseActionForDenial\(/);
    }
  });

  it("the chokepoint and its HMDA→Reg B mapping live only in creditAdverseActions", () => {
    const credit = read("server/services/creditAdverseActions.ts");
    expect(credit).toMatch(/export async function ensureAdverseActionForDenial/);
    expect(credit).toMatch(/HMDA_TO_ADVERSE_ACTION_REASON/);
    // Routes must not carry their own copy of the mapping (single source).
    for (const route of [...lendingRouteFiles(), ...routeDirFiles("server/routes/underwriting")]) {
      expect(read(route)).not.toMatch(/HMDA_TO_ADVERSE_ACTION_REASON\s*:/);
    }
  });

  it("the adverse-action notice carries the mandatory ECOA §1002.9 block, not just FCRA", () => {
    const credit = read("server/services/creditAdverseActions.ts");
    expect(credit).toMatch(/EQUAL CREDIT OPPORTUNITY ACT/);
    expect(credit).toMatch(/prohibits creditors from discriminating/);
    // Creditor identity + administering agency are required alongside the notice.
    expect(credit).toMatch(/ECOA_ADMINISTERING_AGENCY/);
    expect(credit).toMatch(/COMPANY_CONFIG\.legalName/);
  });

  it("the automated denial email stays decision-neutral", () => {
    const email = read("server/services/emailService.ts");
    // The compliant adverse-action notice lives in-app (creditService); the
    // email may only point the borrower at their account.
    expect(email).not.toMatch(/unable to issue/i);
    expect(email).not.toMatch(/we're unable|not approved|has been denied/i);
    expect(email).toMatch(/There's an update on your mortgage application/);
  });
});

describe("Reg N / UDAAP: borrower-facing AI coach output rides the deterministic lint rail", () => {
  it("coach replies pass through the shared loCommsLint hard-block filter before display/persistence", () => {
    const svc = read("server/services/coachingLint.ts");
    expect(svc).toMatch(/from\s+["']@shared\/compliance\/loCommsLint["']/);
    expect(svc).toContain("hardBlockMatches");
    expect(svc).toContain("COACH_LINT_SAFE_MESSAGE");
  });

  it("the coach writeback keeps chat data self_reported — it never touches provenance or verification flags", () => {
    const sync = read("server/services/coachProfileSync.ts");
    expect(sync).not.toMatch(/financialDataProvenance\s*:/);
    expect(sync).not.toMatch(/(incomeVerified|assetsVerified|creditVerified)\s*:\s*true/);
    expect(sync).not.toMatch(/status\s*:\s*"(?!draft)/);
  });

  it("every coach model call lands in the ai_interactions governance log", () => {
    const svc = read("server/services/coachingTurn.ts");
    expect(svc).toContain("logAiInteraction");
    expect(svc).toMatch(/workflow:\s*"ai_coach"/);
    expect(svc).toMatch(/provider:\s*"claude"/);
  });
});

describe("Advisory AI risk brief (M-7): narrates decisions, never makes or delivers them", () => {
  it("the adverse-action path never imports the risk brief", () => {
    // The brief must be unusable as adverse-action content (ECOA §1002.9): the
    // notice chokepoint and the letter generator stay AI-free.
    for (const module of [
      "server/services/adverseActionDelivery.ts",
      "server/services/pdfLetterGenerator.ts",
      "server/services/creditService.ts",
    ]) {
      expect(read(module)).not.toMatch(/riskBrief/);
    }
  });

  it("every risk-brief model call lands in the ai_interactions governance log as internal_only", () => {
    const source = read("server/services/riskBrief.ts");
    expect(source).toContain("logAiInteraction");
    expect(source).toMatch(/workflow:\s*"risk_brief"/);
    expect(source).toMatch(/classification:\s*"internal_only"/);
    expect(source).toContain("RISK_BRIEF_DISCLAIMER");
  });

  it("the narrative is echo-only: unsourced numbers force the deterministic fallback", () => {
    const source = read("server/services/riskBrief.ts");
    expect(source).toContain("findUnsourcedNumbers");
    expect(source).toContain("buildDeterministicBrief");
    expect(source).toMatch(/validation_failed/);
  });
});

describe("State licensing (SAFE Act/Reg H, 12 CFR 1008): the footprint gate stays wired", () => {
  // Roadmap A5, Illinois-only (founder-confirmed 2026-07-17). A write path
  // that sets the subject-property state without the gate reopens
  // unlicensed-solicitation exposure — state law controls what requires
  // licensure, so we simply refuse to transact outside the footprint.
  it("every subject-property-state write path calls the shared gate", () => {
    // Intake create + draft PATCH both gate (separate group files post-split).
    expect(read("server/routes/lending/applications.ts")).toMatch(/unlicensedStateRejection\(/);
    expect(read("server/routes/lending/statusDecisions.ts")).toMatch(/unlicensedStateRejection\(/);
    const properties = read("server/routes/borrower/applicationProperties.ts");
    // Property attach, switch, and edit all gate.
    expect(properties.match(/unlicensedStateRejection\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("the MCP pricing tool refuses ZIPs outside the footprint", () => {
    const source = read("server/mcp/index.ts");
    expect(source).toContain("isZipInLicensedStates");
    expect(source).toMatch(/unlicensed_state_zip/);
  });

  it("the footprint is founder-maintained in one place with the light-up contract", () => {
    const identity = read("shared/companyIdentity.ts");
    expect(identity).toMatch(/LICENSED_STATES = \["IL"\] as const/);
    expect(identity).toContain("isCompanyNmlsPending()) return false");
  });
});

describe("Protocol & platform safety", () => {
  it("the MCP server's first import is the stdout-protecting bootstrap", () => {
    const source = read("server/mcp/index.ts");
    const firstImport = source.split("\n").find((l) => l.trim().startsWith("import"));
    expect(firstImport).toContain("./bootstrap");
  });

  it("the CSRF carve-out covers only /api/webhooks paths", () => {
    const source = read("server/app.ts");
    expect(source).toContain("/api/webhooks");
  });

  it("simulated vendor adapters stay flagged as simulations", () => {
    const vendors = read("server/mcp/vendors.ts");
    expect(vendors).toMatch(/simulated:\s*true/);
    const aus = read("server/services/ausSubmission.ts");
    expect(aus).toMatch(/simulated/);
  });
});

describe("AI governance (AG-1): MCP tool actions land in the tamper-evident audit chain", () => {
  it("the MCP server never inserts credit pulls directly — persistence goes through creditService", () => {
    const source = read("server/mcp/index.ts");
    expect(source).not.toMatch(/insert\(\s*creditPulls\s*\)/);
    expect(source).toContain("recordExternalSoftPull");
  });

  it("every registered tool writes an invocation entry (tool name + args hash) to the chain", () => {
    const source = read("server/mcp/index.ts");
    const registered = [...source.matchAll(/server\.registerTool\(\s*\n?\s*"([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(registered.length).toBeGreaterThanOrEqual(3);
    for (const tool of registered) {
      // Each tool handler pins its toolName, and the shared audit helper
      // hashes the args and routes through creditService's hash chain.
      expect(source).toMatch(new RegExp(`const toolName = "${tool}"`));
    }
    expect(source).toContain("auditInvocation");
    expect(source).toContain("logAgentToolInvocation");
    expect(source).toMatch(/createHash\("sha256"\)/);
  });

  it("audited soft-pull persistence re-verifies FCRA consent inside creditAudit", () => {
    const credit = read("server/services/creditAudit.ts");
    expect(credit).toMatch(/export async function recordExternalSoftPull/);
    expect(credit).toMatch(/Valid consent required before credit pull/);
    expect(credit).toMatch(/does not belong to this borrower/);
  });

  it("agent caller identity stays pluggable (AG-2 seam)", () => {
    expect(read("server/services/creditAudit.ts")).toMatch(
      /DEFAULT_AGENT_CALLER_IDENTITY = "mcp-stdio"/,
    );
    expect(read("server/mcp/identity.ts")).toMatch(/MCP_CALLER_IDENTITY/);
  });
});

describe("AI governance (AG-2): the MCP surface authenticates WHICH agent it serves", () => {
  it("identity is resolved and enforced before the transport connects", () => {
    const source = read("server/mcp/index.ts");
    const resolveAt = source.indexOf("resolveAgentIdentity(process.env)");
    const enforceAt = source.indexOf("assertDeploymentAllowed(");
    const connectAt = source.indexOf("await server.connect(");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(enforceAt).toBeGreaterThan(resolveAt);
    expect(connectAt).toBeGreaterThan(enforceAt);
  });

  it("the registry holds token hashes, compared in constant time — never plaintext", () => {
    const identity = read("server/mcp/identity.ts");
    expect(identity).toMatch(/createHash\("sha256"\)/);
    expect(identity).toMatch(/timingSafeEqual/);
    expect(identity).not.toMatch(/token\s*===\s*/);
  });

  it("production deployments refuse to serve without an authenticated agent", () => {
    const identity = read("server/mcp/identity.ts");
    expect(identity).toMatch(/NODE_ENV === "production"/);
    expect(identity).toMatch(/MCP_REQUIRE_AGENT_IDENTITY/);
    expect(identity).toMatch(/Refusing to serve tools/);
  });

  it("a failed handshake never downgrades to the unauthenticated fallback", () => {
    expect(read("server/mcp/identity.ts")).toMatch(/handshake failed/);
  });

  it("agent identity is stamped on every row the MCP surface persists", () => {
    expect(read("shared/schema/compliance.ts")).toMatch(/agent_identity/);
    expect(read("shared/schema/property.ts")).toMatch(/avm_agent_identity/);
    expect(read("server/services/creditAudit.ts")).toMatch(/agentIdentity: callerIdentity/);
    expect(read("server/mcp/index.ts")).toMatch(/avmAgentIdentity: CALLER_IDENTITY/);
    expect(read("migrations/0005_ag2_agent_identity.sql")).toMatch(/ADD COLUMN IF NOT EXISTS/);
  });

  it("every audit entry carries the resolved agent context", () => {
    const source = read("server/mcp/index.ts");
    expect(source).toMatch(/agentContext: agentContext\(\)/);
    expect(read("server/services/creditAudit.ts")).toMatch(/agentContext/);
  });
});

describe("C2 binding: raw pre-underwriting flag prose never reaches borrower surfaces", () => {
  // The preUnderwriting flag reasons carry staff-side signal prose — creditor
  // names, balances, what-if DTI figures computed over unverified data (the
  // class the rate-com adjudication's C2 binding bars from borrowers; the
  // 2026-08-04 CROA audit found the Dashboard chip tooltip relaying it).
  it("the borrower Dashboard chip tooltip stays generic", () => {
    const source = read("client/src/pages/borrower/Dashboard.tsx");
    expect(source).not.toMatch(/title=\{[^}]*f\.reason/s);
    expect(source).toContain("your loan team will guide you");
  });
});

// ---------------------------------------------------------------------------
// Compliance-critical field registry (audit F-2 class).
//
// The worst defect the 2026-08-04 financial architecture audit found was not
// wrong logic — it was a DEAD COLUMN feeding a LIVE GATE.
// `loanApplications.totalPointsAndFees` was read by the QM points-and-fees
// check and written by nothing, so the gate returned "compliant" on every
// file. Dead data reaching a regulated decision is invisible in review: the
// code reads correctly, the column exists, the tests pass on fixtures that
// populate it by hand.
//
// This registry is the standing guard against that shape. Every field a
// regulated decision depends on is listed with where it is READ and where it
// is WRITTEN — and the binding rule is:
//
//   A field with NO production writer MUST declare how its gate fails CLOSED.
//
// Neither a writer nor a documented fallback is the F-2 bug, and this test
// fails on it. Adding a compliance-gating field means adding it here, which
// is the point: the omission becomes a build failure rather than a discovery
// a year later.
// ---------------------------------------------------------------------------

interface ComplianceCriticalField {
  /** camelCase property as it appears in code. */
  field: string;
  table: string;
  /** The regulated decision that consumes it. */
  gate: string;
  /** File where the gate reads it. */
  readBy: string;
  /** Files that write a real value. Empty means none exist. */
  writtenBy: string[];
  /**
   * Set when the write goes through a schema spread rather than a literal
   * mention (e.g. `...parsed.data`), so the name-match check is skipped and
   * the indirection is documented instead of silently tolerated.
   */
  indirectWrite?: string;
  /**
   * REQUIRED when `writtenBy` is empty: where the gate handles absence
   * without passing. This is the F-2 contract.
   */
  failsClosedBy?: string;
  why: string;
}

const COMPLIANCE_CRITICAL_FIELDS: ComplianceCriticalField[] = [
  {
    field: "totalPointsAndFees",
    table: "loan_applications",
    gate: "QM points-and-fees cap (Reg Z 1026.43(e)(2)(iii))",
    readBy: "server/services/mismoValidation.ts",
    writtenBy: [], // still none — the original F-2 defect, now mitigated not cured
    failsClosedBy: "shared/compliance/loCompensation.ts",
    why:
      "Absent, the gate falls back to the computed points-and-fees FLOOR and can return " +
      "over_cap or not_cleared — never a clean pass. Before F-2 it returned compliant:true.",
  },
  {
    field: "loCompensationModel",
    table: "loan_applications",
    gate: "Dual compensation (Reg Z 1026.36(d)(2)) + the borrower-paid origination fee",
    // loanCosts.ts takes compensation as a PARAMETER; the column itself is read
    // here, where the application is resolved. (The first run of this guard
    // caught that distinction — the registry originally named loanCosts.)
    readBy: "server/services/loanEstimate.ts",
    writtenBy: ["server/routes/lending/pricing.ts"],
    why: "No election means no Loan Estimate — generateLoanEstimate throws rather than guessing.",
  },
  {
    field: "loCompensationBps",
    table: "loan_applications",
    gate: "QM points-and-fees floor — creditor-paid broker comp counts toward the cap",
    readBy: "server/services/mismoValidation.ts",
    writtenBy: ["server/routes/lending/pricing.ts"],
    why: "A model without a rate cannot be scored against the cap; resolveCompensation rejects it.",
  },
  {
    field: "lockConfirmationNumber",
    table: "rate_locks",
    gate: "A rate lock is a lender commitment, not a broker assertion",
    readBy: "shared/rateLockConfirmation.ts",
    writtenBy: ["server/routes/borrower/rateLocks.ts"],
    why: "Absent, the row resolves to unconfirmed_quote and is never called a lock to a borrower.",
  },
  {
    field: "compensationReceivedAmount",
    table: "lender_submissions",
    gate: "EPO clawback exposure + compensation variance (short-pay detection)",
    readBy: "shared/compensationClawback.ts",
    writtenBy: ["server/services/lenderSubmission.ts"],
    why:
      "Required to mark a submission funded. Absent on an at-risk loan, the exposure is " +
      "reported indeterminate rather than $0 — an unknown is not an absence of risk.",
  },
  {
    field: "regulationZTotalPointsAndFeesAmount",
    table: "loan_delivery_data",
    gate: "Loan Delivery edit 3128 / C87-C88 (QM cap at delivery)",
    readBy: "shared/fannieMae/loanDeliveryEdits.ts",
    writtenBy: ["server/routes/underwriting/delivery.ts"],
    indirectWrite:
      "Written through insertLoanDeliveryDataSchema via `...parsed.data`, so the field name " +
      "never appears literally in the route.",
    why: "Edit 3128 fails when absent — the delivery edits already fail closed on this one.",
  },
];

describe("compliance-critical field registry (F-2 class: dead data feeding a live gate)", () => {
  it("registers at least the fields the 2026-08-04 audit identified", () => {
    expect(COMPLIANCE_CRITICAL_FIELDS.length).toBeGreaterThanOrEqual(6);
  });

  it.each(COMPLIANCE_CRITICAL_FIELDS.map((f) => [f.field, f] as const))(
    "%s — the gate that reads it still reads it",
    (_name, entry) => {
      expect(read(entry.readBy)).toContain(entry.field);
    },
  );

  it.each(COMPLIANCE_CRITICAL_FIELDS.map((f) => [f.field, f] as const))(
    "%s — every declared writer exists and writes it",
    (_name, entry) => {
      for (const writer of entry.writtenBy) {
        const source = read(writer);
        if (entry.indirectWrite) {
          // The write is a schema spread; assert the file is real, and rely on
          // the documented note rather than pretending to detect the name.
          expect(source.length).toBeGreaterThan(0);
        } else {
          expect(source).toContain(entry.field);
        }
      }
    },
  );

  // THE invariant. A compliance gate whose input has no writer and no
  // documented fallback is the F-2 bug, whatever else is true of it.
  it.each(COMPLIANCE_CRITICAL_FIELDS.map((f) => [f.field, f] as const))(
    "%s — has a writer, or declares how its gate fails closed",
    (_name, entry) => {
      const hasWriter = entry.writtenBy.length > 0;
      if (!hasWriter) {
        expect(
          entry.failsClosedBy,
          `${entry.field} has no production writer and no failsClosedBy. Its gate (${entry.gate}) ` +
            `can therefore pass on missing data — the exact defect that made the QM cap ` +
            `wave through every file. Either wire a writer or document the fail-closed path.`,
        ).toBeTruthy();
        expect(read(entry.failsClosedBy!).length).toBeGreaterThan(0);
      }
    },
  );

  it("every entry explains why the field matters", () => {
    for (const entry of COMPLIANCE_CRITICAL_FIELDS) {
      expect(entry.why.length).toBeGreaterThan(30);
      expect(entry.gate.length).toBeGreaterThan(10);
    }
  });
});
