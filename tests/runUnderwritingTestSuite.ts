/**
 * Standalone Underwriting / Pricing Decision Engine Test Suite
 *
 * Exercises the data-driven lookup matrices end-to-end against the live
 * Postgres-seeded grids:
 *   - Conventional conforming BPMI premium resolution (FICO x LTV)
 *   - Dynamic Fannie Mae LLPA point resolution (FICO x rounded LTV)
 *   - Policy scalar resolution (DTI / LTV caps, asset haircuts)
 *   - Complex multi-dimensional VA regional residual income scenarios
 *   - Loud failure behaviour on out-of-range / missing matrix inputs
 *
 * Run with: `tsx tests/runUnderwritingTestSuite.ts`
 * Requires the matrices to be seeded first (`tsx server/scripts/seedLendingGrids.ts`).
 */
import { lookupResolver } from "../server/services/lookupResolver";
import { lookupLLPA, calculateLLPA } from "../server/pricing";
import { getPMIRateCard } from "../server/propertyAnalyzer";
import { ConsolidatedUnderwritingEngine, type UnderwritingInput } from "../server/underwritingEngine";

let passed = 0;
let failed = 0;

function approxEqual(actual: number, expected: number, tolerance = 0.0001): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

async function expectValue(label: string, actualPromise: Promise<number>, expected: number) {
  try {
    const actual = await actualPromise;
    if (approxEqual(actual, expected)) {
      passed++;
      console.log(`  PASS  ${label} -> ${actual}`);
    } else {
      failed++;
      console.error(`  FAIL  ${label} -> expected ${expected}, got ${actual}`);
    }
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${label} -> threw unexpectedly: ${(err as Error).message}`);
  }
}

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` -> ${detail}` : ""}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? ` -> ${detail}` : ""}`);
  }
}

async function expectThrows(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    failed++;
    console.error(`  FAIL  ${label} -> expected an error but none was thrown`);
  } catch {
    passed++;
    console.log(`  PASS  ${label} (threw as expected)`);
  }
}

async function run() {
  console.log("RUNNING UNDERWRITING / PRICING DECISION ENGINE TEST SUITE\n");

  // --------------------------------------------------------------------------
  console.log("Policy scalars:");
  await expectValue("CONVENTIONAL_DTI_CAP", lookupResolver.getPolicyScalar("CONVENTIONAL_DTI_CAP"), 43);
  await expectValue("CONVENTIONAL_STRETCH_DTI", lookupResolver.getPolicyScalar("CONVENTIONAL_STRETCH_DTI"), 50);
  await expectValue("CONVENTIONAL_LTV_CAP", lookupResolver.getPolicyScalar("CONVENTIONAL_LTV_CAP"), 95);
  await expectValue("HAIRCUT_STOCK_INVESTMENT", lookupResolver.getPolicyScalar("HAIRCUT_STOCK_INVESTMENT"), 60);
  await expectValue("HAIRCUT_RETIREMENT", lookupResolver.getPolicyScalar("HAIRCUT_RETIREMENT"), 70);

  // --------------------------------------------------------------------------
  console.log("\nConventional conforming BPMI (FICO x LTV):");
  // 95.01 - 97.00 band
  await expectValue(
    "PMI FICO 800 @ 96.00% LTV",
    getPMIRateCard(800, 96).then((c) => c.annualRate),
    0.58,
  );
  await expectValue(
    "PMI FICO 620 @ 97.00% LTV",
    getPMIRateCard(620, 97).then((c) => c.annualRate),
    1.86,
  );
  // 90.01 - 95.00 band
  await expectValue(
    "PMI FICO 700 @ 92.00% LTV",
    getPMIRateCard(700, 92).then((c) => c.annualRate),
    0.78,
  );
  await expectValue(
    "PMI FICO 760 @ 95.00% LTV",
    getPMIRateCard(760, 95).then((c) => c.annualRate),
    0.38,
  );
  // 85.01 - 90.00 band (25% coverage)
  await expectValue(
    "PMI FICO 700 @ 90.00% LTV",
    getPMIRateCard(700, 90).then((c) => c.annualRate),
    0.54,
  );
  await expectValue(
    "PMI FICO 760 @ 86.00% LTV",
    getPMIRateCard(760, 86).then((c) => c.annualRate),
    0.28,
  );
  // 80.01 - 85.00 band (12% coverage)
  await expectValue(
    "PMI FICO 700 @ 85.00% LTV",
    getPMIRateCard(700, 85).then((c) => c.annualRate),
    0.30,
  );
  await expectValue(
    "PMI FICO 620 @ 81.00% LTV",
    getPMIRateCard(620, 81).then((c) => c.annualRate),
    0.58,
  );
  // Below the 80.01% MI trigger -> no matching band -> 0 rate, 0 coverage
  await expectValue(
    "PMI FICO 760 @ 80.00% LTV (no MI)",
    getPMIRateCard(760, 80).then((c) => c.annualRate),
    0,
  );
  await expectValue(
    "PMI coverage @ 96.00% LTV",
    getPMIRateCard(760, 96).then((c) => c.coverage),
    35,
  );
  await expectValue(
    "PMI coverage @ 93.00% LTV",
    getPMIRateCard(760, 93).then((c) => c.coverage),
    30,
  );
  await expectValue(
    "PMI coverage @ 88.00% LTV",
    getPMIRateCard(760, 88).then((c) => c.coverage),
    25,
  );
  await expectValue(
    "PMI coverage @ 83.00% LTV",
    getPMIRateCard(760, 83).then((c) => c.coverage),
    12,
  );
  // Pricing path (calculateLLPA) end-to-end PMI for the 80.01-90 range:
  // FICO 700 @ 85% LTV -> 0.30% annual on $200k = $50/mo.
  await expectValue(
    "calculateLLPA PMI monthly FICO 700 @ 85% LTV",
    calculateLLPA(200000, 700, 85).then((r) => r.pricing.pmiMonthlyPayment),
    (200000 * 0.3) / 12 / 100,
  );
  // FICO 760 @ 88% LTV -> 0.28% annual on $300k.
  await expectValue(
    "calculateLLPA PMI monthly FICO 760 @ 88% LTV",
    calculateLLPA(300000, 760, 88).then((r) => r.pricing.pmiMonthlyPayment),
    (300000 * 0.28) / 12 / 100,
  );

  // --------------------------------------------------------------------------
  console.log("\nDynamic Fannie Mae LLPA points (FICO x rounded LTV):");
  await expectValue("LLPA FICO 800 @ 75% LTV", lookupLLPA(800, 75), 0.0);
  await expectValue("LLPA FICO 700 @ 85% LTV", lookupLLPA(700, 85), 1.5);
  await expectValue("LLPA FICO 640 @ 90% LTV", lookupLLPA(640, 90), 2.0);
  await expectValue("LLPA FICO 660 @ 97% LTV", lookupLLPA(660, 97), 1.375);
  await expectValue("LLPA FICO 600 @ 95% LTV", lookupLLPA(600, 95), 2.25);
  // Rounding: 90.01% LTV rounds up into the 91-95 band
  await expectValue("LLPA FICO 780 @ 90.01% LTV (rounds to 91-95)", lookupLLPA(780, 90.01), 0.25);

  // --------------------------------------------------------------------------
  console.log("\nComplex VA regional residual income (size x loan amount x region):");
  // Standard loan amounts (>= $80,000)
  await expectValue(
    "VA residual: size 3, $250k loan, NORTHEAST",
    lookupResolver.resolveMatrixValue({ matrixCode: "VA_RESIDUAL", dim1Value: 3, dim2Value: 250000, dim3Identifier: "NORTHEAST" }),
    909,
  );
  await expectValue(
    "VA residual: size 5, $400k loan, WEST",
    lookupResolver.resolveMatrixValue({ matrixCode: "VA_RESIDUAL", dim1Value: 5, dim2Value: 400000, dim3Identifier: "WEST" }),
    1158,
  );
  await expectValue(
    "VA residual: size 1, $80k loan (boundary), MIDWEST",
    lookupResolver.resolveMatrixValue({ matrixCode: "VA_RESIDUAL", dim1Value: 1, dim2Value: 80000, dim3Identifier: "MIDWEST" }),
    441,
  );
  // Low loan amounts (< $80,000)
  await expectValue(
    "VA residual: size 5, $50k loan, WEST",
    lookupResolver.resolveMatrixValue({ matrixCode: "VA_RESIDUAL", dim1Value: 5, dim2Value: 50000, dim3Identifier: "WEST" }),
    1004,
  );
  await expectValue(
    "VA residual: size 2, $79,999 loan (boundary), SOUTH",
    lookupResolver.resolveMatrixValue({ matrixCode: "VA_RESIDUAL", dim1Value: 2, dim2Value: 79999, dim3Identifier: "SOUTH" }),
    641,
  );

  // --------------------------------------------------------------------------
  console.log("\nConsolidated VA underwriting engine (commissary discount + 20% cushion):");
  const engine = new ConsolidatedUnderwritingEngine();

  const baseVaInput = (): UnderwritingInput => ({
    requestedLoanProgram: "VA",
    isVeteran: true,
    baseMonthlyIncome: 8000,
    bonusMonthlyIncome: 0,
    existingMonthlyDebts: 500,
    originalLoanAmount: 250000,
    contractSalesPrice: 300000,
    appraisalValue: 300000,
    representativeFico: 720,
    proposedPiti: 1800,
    assets: [{ type: "CHECKING_SAVINGS", balance: 50000 }],
    homeSquareFootage: 2000,
    subjectPropertyState: "NY", // NORTHEAST
    householdFamilySize: 3,
  });

  // Active-duty commissary discount applied: base NE size-3 >=$80k = 909 -> *0.95
  const commissaryOn = await engine.evaluate({
    ...baseVaInput(),
    isActiveDuty: true,
    hasExchangeAccess: true,
  });
  check(
    "VA commissary discount applies 0.95 to required residual",
    approxEqual(commissaryOn.requiredResidualIncome ?? -1, 909 * 0.95),
    `required=${commissaryOn.requiredResidualIncome}`,
  );
  // actual = 8000 - (8000*0.18) - 1800 - 500 - (2000*0.14) = 3980
  check(
    "VA actual residual income computed correctly",
    approxEqual(commissaryOn.actualResidualIncome ?? -1, 3980),
    `actual=${commissaryOn.actualResidualIncome}`,
  );
  check(
    "VA low-DTI clean profile is APPROVED",
    commissaryOn.decision === "APPROVED",
    commissaryOn.decision,
  );

  // No exchange access: commissary discount NOT applied, required stays 909
  const commissaryOff = await engine.evaluate({
    ...baseVaInput(),
    isActiveDuty: true,
    hasExchangeAccess: false,
  });
  check(
    "VA without exchange access keeps full required residual",
    approxEqual(commissaryOff.requiredResidualIncome ?? -1, 909),
    `required=${commissaryOff.requiredResidualIncome}`,
  );

  // High-DTI 20% cushion FAIL: residual clears the base requirement but not the
  // 1.2x buffer required above 41% DTI. SOUTH size-2 >=$80k base = 738.
  const cushionFail = await engine.evaluate({
    requestedLoanProgram: "VA",
    isVeteran: true,
    baseMonthlyIncome: 5000,
    bonusMonthlyIncome: 0,
    existingMonthlyDebts: 700,
    originalLoanAmount: 250000,
    contractSalesPrice: 300000,
    appraisalValue: 300000,
    representativeFico: 700,
    proposedPiti: 2400,
    assets: [{ type: "CHECKING_SAVINGS", balance: 40000 }],
    homeSquareFootage: 1500,
    subjectPropertyState: "TX", // SOUTH
    householdFamilySize: 2,
  });
  // DTI = (700+2400)/5000 = 62% (>41). actual = 5000 - 900 - 2400 - 700 - 210 = 790.
  // base required 738 (actual passes standard rule) but 1.2x buffer = 885.6 (fails).
  check(
    "VA high-DTI within base but under 20% cushion is REJECTED",
    cushionFail.decision === "REJECTED" &&
      cushionFail.rejectionReasons.some((r) => r.includes("residual income buffer")),
    cushionFail.rejectionReasons.join("; ") || cushionFail.decision,
  );

  // High-DTI 20% cushion PASS: DTI > 41% but residual clears the 1.2x buffer.
  // MIDWEST size-1 >=$80k base = 441, buffer = 529.2.
  const cushionPass = await engine.evaluate({
    requestedLoanProgram: "VA",
    isVeteran: true,
    baseMonthlyIncome: 6000,
    bonusMonthlyIncome: 0,
    existingMonthlyDebts: 700,
    originalLoanAmount: 250000,
    contractSalesPrice: 300000,
    appraisalValue: 300000,
    representativeFico: 700,
    proposedPiti: 2200,
    assets: [{ type: "CHECKING_SAVINGS", balance: 40000 }],
    homeSquareFootage: 1500,
    subjectPropertyState: "OH", // MIDWEST
    householdFamilySize: 1,
  });
  // DTI = (700+2200)/6000 = 48.33% (>41). actual = 6000 - 1080 - 2200 - 700 - 210 = 1810 > 529.2.
  check(
    "VA high-DTI clearing 20% cushion is APPROVED",
    cushionPass.decision === "APPROVED",
    cushionPass.decision,
  );

  // --------------------------------------------------------------------------
  console.log("\nLoud failure behaviour (no silent fallbacks):");
  await expectThrows("Missing matrix code throws", () =>
    lookupResolver.resolveMatrixValue({ matrixCode: "DOES_NOT_EXIST", dim1Value: 1 }),
  );
  await expectThrows("Out-of-range FICO (590) in PMI throws", () =>
    lookupResolver.resolveMatrixValue({ matrixCode: "CONVENTIONAL_PMI", dim1Value: 590, dim2Value: 96 }),
  );
  await expectThrows("Unknown VA region throws", () =>
    lookupResolver.resolveMatrixValue({ matrixCode: "VA_RESIDUAL", dim1Value: 3, dim2Value: 250000, dim3Identifier: "ATLANTIS" }),
  );

  // --------------------------------------------------------------------------
  console.log(`\nTEST SUITE COMPLETE: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err) => {
  console.error("FATAL TEST SUITE ERROR:", err);
  process.exit(1);
});
