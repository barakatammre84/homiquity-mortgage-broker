import { db } from "../db";
import { lookupMatrices, lookupMatrixCells } from "@shared/schema";
import { CONFORMING_LOAN_LIMIT_2026 } from "@shared/lendingLimits";

/**
 * Dynamic seeding pipeline for the underwriting/pricing decision engine.
 *
 * Populates the policy scalars, conventional BPMI premium cards, the Fannie Mae
 * conforming LLPA grid, and the multi-dimensional VA regional residual income
 * requirements. Running it replaces all existing matrix data with a clean,
 * versioned ACTIVE set effective 2026-01-01.
 */
export async function seed() {
  console.log("INITIALIZING DECISION ENGINE SEEDING PIPELINE...");

  // Wipe existing matrices to ensure clean seed runs
  await db.delete(lookupMatrixCells);
  await db.delete(lookupMatrices);

  // Helper function to seed matrices
  const createMatrix = async (code: string, desc: string, version = 1) => {
    const [inserted] = await db
      .insert(lookupMatrices)
      .values({
        matrixCode: code,
        description: desc,
        version,
        lifecycleStatus: "ACTIVE",
        effectiveDate: new Date("2026-01-01T00:00:00Z"),
      })
      .returning();
    return inserted.id;
  };

  // ==========================================
  // SEED: Policy Scalars (Hardcoded values moved to database)
  // Every scalar here is cited in data/regulatory/regulatory-ledger.json (roadmap #30) —
  // agency-sourced values carry the Selling Guide/FHFA entry, deliberately
  // conservative platform overlays carry a PLATFORM POLICY entry. Never change
  // a value without updating its ledger entry; changes to regulated math route
  // through the guardian/scenario lane.
  // ==========================================
  const scalarMap = [
    { code: "CONVENTIONAL_DTI_CAP", value: 43.0, desc: "Baseline DTI ceiling for standard approvals — PLATFORM POLICY, conservative vs DU 50%/manual 45% (ledger: platform-conv-dti-cap-43)" },
    { code: "CONVENTIONAL_STRETCH_DTI", value: 50.0, desc: "DU maximum DTI per Selling Guide B3-6-02 (ledger: fnma-b3-6-02-du-max-dti)" },
    { code: "CONVENTIONAL_LTV_CAP", value: 95.0, desc: "Max LTV — PLATFORM POLICY; 95.01-97% programs deliberately not offered (ledger: platform-conv-ltv-cap-95)" },
    { code: "CONVENTIONAL_FICO_FLOOR", value: 620.0, desc: "Minimum representative credit score, fixed-rate, per Selling Guide B3-5.1-01 (ledger: fnma-b3-5-1-01-min-credit-score)" },
    { code: "CONFORMING_LOAN_LIMIT", value: CONFORMING_LOAN_LIMIT_2026, desc: "FHFA 2026 conforming loan limit, one-unit baseline; loans above route to jumbo (ledger: fhfa-conforming-loan-limit-2026)" },
    { code: "VA_RESIDUAL_EXTRA_MEMBER", value: 80.0, desc: "VA residual income addition per family member beyond 5 (Pamphlet 26-7 Table 4-2)" },
    { code: "HAIRCUT_STOCK_INVESTMENT", value: 60.0, desc: "Stock asset haircut — PLATFORM POLICY overlay; Fannie B3-4.3-01 requires NO haircut (ledger: platform-haircut-stock-60)" },
    { code: "HAIRCUT_RETIREMENT", value: 70.0, desc: "Retirement asset haircut — PLATFORM POLICY overlay, B3-4.3-03 mapping pending (ledger: platform-haircut-retirement-70)" },
  ];

  for (const s of scalarMap) {
    const mId = await createMatrix(s.code, s.desc);
    await db.insert(lookupMatrixCells).values({
      matrixId: mId,
      outputValue: s.value.toString(),
    });
  }

  // ==========================================
  // SEED: Conventional Monthly BPMI Matrix (National MI/MGIC)
  // ==========================================
  const pmiId = await createMatrix("CONVENTIONAL_PMI", "Annual Monthly BPMI premiums by Credit Score vs LTV Range");

  // Standard LTV Band: 95.01% - 97.00% LTV (35% Coverage)
  const pmi97Cells = [
    { fMin: 760, fMax: 850, rate: 0.58 },
    { fMin: 740, fMax: 759, rate: 0.7 },
    { fMin: 720, fMax: 739, rate: 0.87 },
    { fMin: 700, fMax: 719, rate: 0.99 },
    { fMin: 680, fMax: 699, rate: 1.21 },
    { fMin: 660, fMax: 679, rate: 1.54 },
    { fMin: 640, fMax: 659, rate: 1.65 },
    { fMin: 620, fMax: 639, rate: 1.86 },
  ];

  for (const c of pmi97Cells) {
    await db.insert(lookupMatrixCells).values({
      matrixId: pmiId,
      dim1Min: c.fMin.toString(),
      dim1Max: c.fMax.toString(),
      dim2Min: "95.01",
      dim2Max: "97.00",
      outputValue: c.rate.toString(),
    });
  }

  // Standard LTV Band: 90.01% - 95.00% LTV (30% Coverage)
  const pmi95Cells = [
    { fMin: 760, fMax: 850, rate: 0.38 },
    { fMin: 740, fMax: 759, rate: 0.53 },
    { fMin: 720, fMax: 739, rate: 0.66 },
    { fMin: 700, fMax: 719, rate: 0.78 },
    { fMin: 680, fMax: 699, rate: 0.96 },
    { fMin: 660, fMax: 679, rate: 1.28 },
    { fMin: 640, fMax: 659, rate: 1.33 },
    { fMin: 620, fMax: 639, rate: 1.42 },
  ];

  for (const c of pmi95Cells) {
    await db.insert(lookupMatrixCells).values({
      matrixId: pmiId,
      dim1Min: c.fMin.toString(),
      dim1Max: c.fMax.toString(),
      dim2Min: "90.01",
      dim2Max: "95.00",
      outputValue: c.rate.toString(),
    });
  }

  // Standard LTV Band: 85.01% - 90.00% LTV (25% Coverage)
  const pmi90Cells = [
    { fMin: 760, fMax: 850, rate: 0.28 },
    { fMin: 740, fMax: 759, rate: 0.38 },
    { fMin: 720, fMax: 739, rate: 0.46 },
    { fMin: 700, fMax: 719, rate: 0.54 },
    { fMin: 680, fMax: 699, rate: 0.67 },
    { fMin: 660, fMax: 679, rate: 0.90 },
    { fMin: 640, fMax: 659, rate: 0.94 },
    { fMin: 620, fMax: 639, rate: 1.02 },
  ];

  for (const c of pmi90Cells) {
    await db.insert(lookupMatrixCells).values({
      matrixId: pmiId,
      dim1Min: c.fMin.toString(),
      dim1Max: c.fMax.toString(),
      dim2Min: "85.01",
      dim2Max: "90.00",
      outputValue: c.rate.toString(),
    });
  }

  // Standard LTV Band: 80.01% - 85.00% LTV (12% Coverage)
  const pmi85Cells = [
    { fMin: 760, fMax: 850, rate: 0.19 },
    { fMin: 740, fMax: 759, rate: 0.23 },
    { fMin: 720, fMax: 739, rate: 0.27 },
    { fMin: 700, fMax: 719, rate: 0.30 },
    { fMin: 680, fMax: 699, rate: 0.38 },
    { fMin: 660, fMax: 679, rate: 0.49 },
    { fMin: 640, fMax: 659, rate: 0.52 },
    { fMin: 620, fMax: 639, rate: 0.58 },
  ];

  for (const c of pmi85Cells) {
    await db.insert(lookupMatrixCells).values({
      matrixId: pmiId,
      dim1Min: c.fMin.toString(),
      dim1Max: c.fMax.toString(),
      dim2Min: "80.01",
      dim2Max: "85.00",
      outputValue: c.rate.toString(),
    });
  }

  // ==========================================
  // SEED: Conventional max LTV by occupancy x units. Verified 2026-09-11
  // against Fannie Mae's current Eligibility Matrix. The 2-4 unit primary rows
  // are the MANUAL-underwriting ceilings; Desktop Underwriter permits eligible
  // purchase/limited-cash-out files to 95%. The engine therefore routes a
  // purchase above these manual rows but at or below 95% to review for a current
  // DU finding. Investment rows are absolute standard-product ceilings.
  // ==========================================
  const maxLtvId = await createMatrix(
    "CONVENTIONAL_MAX_LTV",
    "Maximum LTV for purchase, fixed-rate conventional loans by unit count and occupancy",
  );

  // [units, occupancy] -> manual/standard max LTV for the local review path.
  // Second homes are 1-unit only; other combinations are intentionally unseeded
  // (a matrix miss routes to manual review as out-of-band).
  const maxLtvDefs: Array<{ units: number; occupancy: string; maxLtv: number }> = [
    { units: 1, occupancy: "PRIMARY", maxLtv: 95 },
    { units: 2, occupancy: "PRIMARY", maxLtv: 85 },
    { units: 3, occupancy: "PRIMARY", maxLtv: 75 },
    { units: 4, occupancy: "PRIMARY", maxLtv: 75 },
    { units: 1, occupancy: "SECOND", maxLtv: 90 },
    { units: 1, occupancy: "INVESTMENT", maxLtv: 85 },
    { units: 2, occupancy: "INVESTMENT", maxLtv: 75 },
    { units: 3, occupancy: "INVESTMENT", maxLtv: 75 },
    { units: 4, occupancy: "INVESTMENT", maxLtv: 75 },
  ];

  for (const def of maxLtvDefs) {
    await db.insert(lookupMatrixCells).values({
      matrixId: maxLtvId,
      dim1Min: def.units.toString(),
      dim1Max: def.units.toString(),
      dim3Identifier: def.occupancy,
      outputValue: def.maxLtv.toString(),
    });
  }

  // ==========================================
  // SEED: Fannie Mae Conforming LLPA Matrix
  // ==========================================
  const llpaId = await createMatrix("FANNIE_LLPA", "Standard baseline upfront risk-adjusted fees by Credit Score vs Rounded LTV");

  // Mapping LTV column brackets
  const ltvBands = [
    { min: 0, max: 60, rates: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] },
    { min: 61, max: 70, rates: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.125, 0.125] },
    { min: 71, max: 75, rates: [0.0, 0.0, 0.125, 0.25, 0.375, 0.625, 0.875, 1.125, 1.5] },
    { min: 76, max: 80, rates: [0.375, 0.625, 0.875, 1.0, 1.125, 1.375, 1.75, 2.0, 2.25] },
    { min: 81, max: 85, rates: [0.375, 0.625, 1.0, 1.25, 1.5, 1.625, 1.875, 2.5, 2.875] },
    { min: 86, max: 90, rates: [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.625] },
    { min: 91, max: 95, rates: [0.25, 0.5, 0.625, 0.875, 1.125, 1.375, 1.625, 1.875, 2.25] },
    { min: 96, max: 97, rates: [0.125, 0.25, 0.5, 0.75, 0.875, 1.125, 1.375, 1.5, 1.75] },
  ];

  const ficoSlices = [
    { min: 780, max: 850 },
    { min: 760, max: 779 },
    { min: 740, max: 759 },
    { min: 720, max: 739 },
    { min: 700, max: 719 },
    { min: 680, max: 699 },
    { min: 660, max: 679 },
    { min: 640, max: 659 },
    { min: 300, max: 639 },
  ];

  for (const band of ltvBands) {
    for (let i = 0; i < ficoSlices.length; i++) {
      const slice = ficoSlices[i];
      const rate = band.rates[i];
      await db.insert(lookupMatrixCells).values({
        matrixId: llpaId,
        dim1Min: slice.min.toString(),
        dim1Max: slice.max.toString(),
        dim2Min: band.min.toString(),
        dim2Max: band.max.toString(),
        outputValue: rate.toString(),
      });
    }
  }

  // ==========================================
  // SEED: VA Minimum Monthly Residual Income Requirements
  // ==========================================
  const vaId = await createMatrix("VA_RESIDUAL", "Minimum monthly residual cash flow requirements by family size, loan amount and region");

  // Multi-dimensional ruleset array mapping [Family Size, Threshold Limit, Region] -> Target Value
  const vaDefinitions = [
    // Standard Loan Amounts: >= $80,000
    { size: 1, limitMin: 80000, limitMax: 9999999, region: "NORTHEAST", value: 450 },
    { size: 2, limitMin: 80000, limitMax: 9999999, region: "NORTHEAST", value: 755 },
    { size: 3, limitMin: 80000, limitMax: 9999999, region: "NORTHEAST", value: 909 },
    { size: 4, limitMin: 80000, limitMax: 9999999, region: "NORTHEAST", value: 1025 },
    { size: 5, limitMin: 80000, limitMax: 9999999, region: "NORTHEAST", value: 1062 },

    { size: 1, limitMin: 80000, limitMax: 9999999, region: "MIDWEST", value: 441 },
    { size: 2, limitMin: 80000, limitMax: 9999999, region: "MIDWEST", value: 738 },
    { size: 3, limitMin: 80000, limitMax: 9999999, region: "MIDWEST", value: 889 },
    { size: 4, limitMin: 80000, limitMax: 9999999, region: "MIDWEST", value: 1003 },
    { size: 5, limitMin: 80000, limitMax: 9999999, region: "MIDWEST", value: 1039 },

    { size: 1, limitMin: 80000, limitMax: 9999999, region: "SOUTH", value: 441 },
    { size: 2, limitMin: 80000, limitMax: 9999999, region: "SOUTH", value: 738 },
    { size: 3, limitMin: 80000, limitMax: 9999999, region: "SOUTH", value: 889 },
    { size: 4, limitMin: 80000, limitMax: 9999999, region: "SOUTH", value: 1003 },
    { size: 5, limitMin: 80000, limitMax: 9999999, region: "SOUTH", value: 1039 },

    { size: 1, limitMin: 80000, limitMax: 9999999, region: "WEST", value: 491 },
    { size: 2, limitMin: 80000, limitMax: 9999999, region: "WEST", value: 823 },
    { size: 3, limitMin: 80000, limitMax: 9999999, region: "WEST", value: 990 },
    { size: 4, limitMin: 80000, limitMax: 9999999, region: "WEST", value: 1117 },
    { size: 5, limitMin: 80000, limitMax: 9999999, region: "WEST", value: 1158 },

    // Low Loan Amounts: < $80,000. Band max is 79,999.99 (cent granularity) so
    // fractional amounts like $79,999.50 resolve — an integer max of 79,999
    // left a $1 gap to the >= $80,000 band that crashed the lookup.
    { size: 1, limitMin: 0, limitMax: 79999.99, region: "NORTHEAST", value: 390 },
    { size: 2, limitMin: 0, limitMax: 79999.99, region: "NORTHEAST", value: 654 },
    { size: 3, limitMin: 0, limitMax: 79999.99, region: "NORTHEAST", value: 788 },
    { size: 4, limitMin: 0, limitMax: 79999.99, region: "NORTHEAST", value: 888 },
    { size: 5, limitMin: 0, limitMax: 79999.99, region: "NORTHEAST", value: 921 },

    { size: 1, limitMin: 0, limitMax: 79999.99, region: "MIDWEST", value: 382 },
    { size: 2, limitMin: 0, limitMax: 79999.99, region: "MIDWEST", value: 641 },
    { size: 3, limitMin: 0, limitMax: 79999.99, region: "MIDWEST", value: 772 },
    { size: 4, limitMin: 0, limitMax: 79999.99, region: "MIDWEST", value: 868 },
    { size: 5, limitMin: 0, limitMax: 79999.99, region: "MIDWEST", value: 902 },

    { size: 1, limitMin: 0, limitMax: 79999.99, region: "SOUTH", value: 382 },
    { size: 2, limitMin: 0, limitMax: 79999.99, region: "SOUTH", value: 641 },
    { size: 3, limitMin: 0, limitMax: 79999.99, region: "SOUTH", value: 772 },
    { size: 4, limitMin: 0, limitMax: 79999.99, region: "SOUTH", value: 868 },
    { size: 5, limitMin: 0, limitMax: 79999.99, region: "SOUTH", value: 902 },

    { size: 1, limitMin: 0, limitMax: 79999.99, region: "WEST", value: 425 },
    { size: 2, limitMin: 0, limitMax: 79999.99, region: "WEST", value: 713 },
    { size: 3, limitMin: 0, limitMax: 79999.99, region: "WEST", value: 859 },
    { size: 4, limitMin: 0, limitMax: 79999.99, region: "WEST", value: 967 },
    { size: 5, limitMin: 0, limitMax: 79999.99, region: "WEST", value: 1004 },
  ];

  for (const def of vaDefinitions) {
    await db.insert(lookupMatrixCells).values({
      matrixId: vaId,
      dim1Min: def.size.toString(),
      dim1Max: def.size.toString(),
      dim2Min: def.limitMin.toString(),
      dim2Max: def.limitMax.toString(),
      dim3Identifier: def.region,
      outputValue: def.value.toString(),
    });
  }

  console.log("DECISION ENGINE SEEDING PIPELINE EXECUTED SUCCESSFULLY.");
}

// Allow direct execution: `tsx server/scripts/seedLendingGrids.ts`
const isDirectRun =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /seedLendingGrids\.(ts|js)$/.test(process.argv[1] || "");

if (isDirectRun) {
  seed()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("FATAL DATA-SEED ERROR:", err);
      process.exit(1);
    });
}
