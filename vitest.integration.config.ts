import "dotenv/config";
import { defineConfig } from "vitest/config";
import path from "path";

// Integration tests. These hit a *running* HTTP server over the network
// (default http://localhost:5000, override with TEST_BASE_URL). Start the
// server first (npm run build && npm start, or npm run dev) before running:
//
//   TEST_BASE_URL=http://localhost:5001 npm run test:integration
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // These journeys share and deliberately mutate one disposable database.
    // Running files in parallel creates lock contention between fixture setup,
    // route side effects, and cleanup, which can turn healthy endpoints into
    // hook timeouts. Keep the lane deterministic locally and in CI.
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 30000,
    include: [
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
      "tests/coreExtractionRestartProof.integration.test.ts",
      "tests/coreTaxPacketCanary.integration.test.ts",
      "tests/coreTaxPacketRestartProof.integration.test.ts",
      "tests/documentPageMaterialization.integration.test.ts",
      "tests/planningDocumentHandoff.integration.test.ts",
      "tests/taxDocumentReviewConsent.integration.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});
