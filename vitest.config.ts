import { configDefaults, defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // TIMEOUTS ARE A HANG DETECTOR HERE, NOT A PERFORMANCE ASSERTION.
    //
    // Raised 15s -> 45s (and hooks 30s -> 60s) on 2026-08-19. Several sessions build and
    // test on this machine at once, and the measured cost is real: the same suite runs
    // 172s idle and 305-419s under load, ~2.4x. Any test doing more than ~6s of honest
    // work therefore crossed a 15s ceiling at random — tests/statusVocabulary.test.ts and
    // tests/intakeNeverDenies.test.ts both did, neither for a reason in the code.
    //
    // That matters more than a slow suite, because a gate that fails at random teaches
    // --no-verify, and that habit disables it permanently — the exact failure the
    // pre-push hook's own header warns about.
    //
    // CORRECTED 2026-08-24. This paragraph used to read: "`main` no longer requires a
    // CI status check (Actions billing failed; development is local-only), so
    // .githooks/pre-push is the only gate there is." That was true for the 2026-08-19..22
    // outage and false afterwards — .githooks/pre-push:70 already said "CI is back" while
    // this file still said it was dead. Two load-bearing config files stating opposite
    // facts about whether anything checks the code is worse than either being wrong
    // alone: a session reads whichever it opens first and calibrates on it.
    //
    // What is true now: CI runs on every PR, the `gate` job is the required status check
    // on `main`, and since 2026-08-24 it no longer exempts drafts. The pre-push hook is
    // an early warning, not the gate. If CI ever goes dark again, fix THIS comment in the
    // same commit that changes the posture — a stale reassurance is the failure mode this
    // repo keeps paying for.
    //
    // Deliberately 45s and not 300s: a genuinely hung test must still be caught. If a test
    // needs more than this, the test is the problem — profile it, do not raise this again.
    // The root-cause fix is still preferable where it is cheap: statusVocabulary went
    // 41s -> 1.4s by reading the tree once instead of once per test.
    testTimeout: 45000,
    hookTimeout: 60000,
    // Unit / logic tests. Pure in-process logic — no running HTTP server and no
    // database required. Everything that makes network calls to the app lives in
    // vitest.integration.config.ts instead.
    //
    // THIS WAS AN ALLOWLIST OF ~230 HAND-TYPED PATHS UNTIL 2026-08-24.
    //
    // It was the most-churned file in the repository — 222 commits, more than
    // package.json (92) and more than any source file. 172 of its last 195
    // commits added nothing but test-path lines. Its globbed sibling,
    // vitest.client.config.ts, has 3 commits in its whole life doing the same
    // job for 125 files.
    //
    // The list carried no information: 248 test files in tests/ minus the 18
    // integration files is exactly 230, the number that was typed out here. A
    // glob computes it, and cannot be wrong.
    //
    // It also cost merges. The header that used to sit at the bottom of the list
    // said it plainly: "#440 and #443 both went stale without merging because
    // every concurrent PR inserted its entry just after
    // tests/accessControl.test.ts, so each one conflicted with whichever sibling
    // merged first." Two PRs died on one line of a file this glob replaces. With
    // ~50 PRs a week the contention was continuous, and the advice that followed
    // — append at the END, not the top — treated the symptom.
    //
    // WHAT STILL PROTECTS THIS. An allowlist did have one virtue: it failed
    // closed on a typo'd path. A glob cannot, so the floor moved into
    // scripts/test-collection-guard.cjs, which enumerates from disk with
    // readdirSync and fails when a lane collects fewer files than exist. That
    // guard is mechanism-agnostic — it caught `pnpm test` running 111 of 118
    // files and exiting 0 — and it now also fails when a file is claimed by two
    // lanes, which is the one new way a glob can be wrong.
    include: ["tests/**/*.test.{ts,tsx}"],
    // The integration lane's files, which need a live HTTP server and a seeded
    // database. The glob above matches them; this drops them. They are listed
    // ONE more time, in vitest.integration.config.ts, and the two lists cannot
    // drift: test-collection-guard.cjs fails if a file lands in both lanes, and
    // its orphan floor fails if a file lands in neither.
    exclude: [
      ...configDefaults.exclude,
      "tests/fileReviewRoutes.test.ts",
      "tests/financialReviewRoutes.test.ts",
      "tests/api.test.ts",
      "tests/authRecovery.test.ts",
      "tests/leads.test.ts",
      "tests/lookupMatrixCoverageGap.test.ts",
      "tests/lookupMatrixLifecycle.test.ts",
      "tests/loCommandCenter.test.ts",
      "tests/intakeHandoff.test.ts",
      "tests/intakeActionItems.test.ts",
      "tests/rateLocks.test.ts",
      "tests/lenderConditions.test.ts",
      "tests/cocRoutes.test.ts",
      "tests/mismoExportAccess.test.ts",
      "tests/roleSeparation.test.ts",
      "tests/pricingUnderwriting.test.ts",
      "tests/taxInsightRoutes.test.ts",
      "tests/cpaPartnerRoutes.test.ts",
      "tests/partnerRoutes.test.ts",
      "tests/partnerConsent.test.ts",
      "tests/documentCorrectionJourney.test.ts",
      "tests/applicationSignalIsolation.test.ts",
      "tests/staleEvidenceIsolation.test.ts",
      "tests/documentExtractionQueue.integration.test.ts",
      "tests/documentFieldReview.integration.test.ts",
      "tests/coreProviderCanaries.integration.test.ts",
      "tests/documentPageMaterialization.integration.test.ts",
    ],
    // Some modules under test transitively import server/db.ts, which refuses to
    // boot without a DATABASE_URL. Unit tests never touch the database, so a
    // placeholder keeps them hermetic (no .env or real database needed).
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://unit-tests:placeholder@localhost:5432/unit_tests_never_connects",
    },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client", "src"),
    },
  },
});
