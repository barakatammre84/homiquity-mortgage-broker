import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

// Client component-test lane (adjudication log 2026-07-19 §4, intervention #1).
// Runs React components in happy-dom against the data-testid substrate — no
// dev server, no browser, no database. Part of `pnpm test`, so the CI gate
// catches UI regressions; live browser verification remains for genuinely
// visual/E2E acceptance (TEAM_PRACTICES §5.4).
//
// Include is a GLOB on purpose: a colocated *.test.tsx can never be silently
// stranded outside an include list (the trap CICD.md documents for the node
// configs). Server/logic tests stay in vitest.config.ts's explicit list.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true, // also enables @testing-library/react auto-cleanup
    environment: "happy-dom",
    // TIMEOUTS ARE A HANG DETECTOR HERE, NOT A PERFORMANCE ASSERTION.
    //
    // Raised 15s -> 45s (and hooks 30s -> 60s) on 2026-08-19. Several sessions build and
    // test on this machine at once, and the measured cost is real: the same suite runs
    // 172s idle and 305-419s under load, ~2.4x. Any test doing more than ~6s of honest
    // work therefore crossed a 15s ceiling at random — tests/statusVocabulary.test.ts and
    // tests/intakeNeverDenies.test.ts both did, neither for a reason in the code.
    //
    // That matters more than a slow suite. `main` no longer requires a CI status check
    // (Actions billing failed; development is local-only), so .githooks/pre-push is the
    // only gate there is. A gate that fails at random teaches --no-verify, and that habit
    // disables it permanently — the exact failure the hook's own header warns about.
    //
    // Deliberately 45s and not 300s: a genuinely hung test must still be caught. If a test
    // needs more than this, the test is the problem — profile it, do not raise this again.
    // The root-cause fix is still preferable where it is cheap: statusVocabulary went
    // 41s -> 1.4s by reading the tree once instead of once per test.
    testTimeout: 45000,
    // Keep component collection reliable on the shared development host. A
    // wide default fork burst can exhaust worker startup resources and cause
    // Vitest to omit files even though each file passes in isolation.
    maxWorkers: 4,
    include: ["client/src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client", "src"),
      // Mirrors vite.config.ts. Without it, any component test that reaches a
      // module importing a lifestyle photo fails to RESOLVE — the suite reports
      // "0 tests" rather than a failure, which reads like the file was never
      // picked up at all.
      "@assets": path.resolve(__dirname, "attached_assets"),
    },
  },
});
