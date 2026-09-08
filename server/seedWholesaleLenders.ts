import { eq, or } from "drizzle-orm";
import { db } from "./db";
import { wholesaleLenders } from "@shared/schema";
import { TARGET_LENDERS } from "./seedData/wholesaleLenderTargets";

// =============================================================================
// WHOLESALE LENDER COUNTERPARTIES (real companies, not demo data)
//
// These are the Target-5 shortlist from the lender-liquidity work. They used to
// live in a hardcoded array in shared/wholesaleLenders.ts, which meant the
// submission path and the pricing engine read two different lender lists. They
// are rows now: one source of truth, editable from the admin lender screen.
//
// Distinct from seedMarketPricing.ts, whose lenders are FICTIONAL and carry
// isDemo = true. These are real companies, so isDemo is false — and precisely
// because they are real, every one is seeded at approvalStatus "target".
//
// "target" means: we want to broker to them and they have never heard of us.
// Sending a borrower's file to a target is transmitting PII to a company with
// no agreement and no obligation to us, which is what the submission gate
// exists to prevent. Promote a lender to "approved" ONLY when a broker
// agreement is executed, and set epoClawbackDays from that agreement at the
// same time (NULL there means "unknown", never "no clawback").
//
// Product menus, requirements and pricing hang off these rows: `capabilities`
// on the row, plus rate_sheets → rate_sheet_products. They are intentionally
// left unpopulated here — publishing a guideline number we have not read from
// the lender's own matrix would be inventing underwriting criteria.
// =============================================================================

/**
 * Idempotent. Inserts any missing target counterparty and leaves existing rows
 * ALONE — approvalStatus, epoClawbackDays and capabilities are operator-owned
 * once the row exists, and a reseed must never quietly demote an approved
 * lender back to "target" or wipe agreement terms.
 */
export async function seedWholesaleLenderCounterparties(): Promise<void> {
  for (const t of TARGET_LENDERS) {
    const existing = await db
      .select({ id: wholesaleLenders.id })
      .from(wholesaleLenders)
      // Older environments may already contain the counterparty under a
      // different external id. lenderCode is unique too, so either identity
      // means the operator-owned row must be preserved.
      .where(or(
        eq(wholesaleLenders.lenderId, t.lenderId),
        eq(wholesaleLenders.lenderCode, t.lenderCode),
      ))
      .limit(1);
    if (existing.length > 0) continue;

    await db.insert(wholesaleLenders).values({
      lenderId: t.lenderId,
      lenderName: t.lenderName,
      lenderCode: t.lenderCode,
      specialty: t.specialty,
      ausSupport: t.ausSupport,
      nonQm: t.nonQm,
      isDemo: false,
      // No agreement exists yet for any of them.
      approvalStatus: "target",
      epoClawbackDays: null,
      integrationTier: "MANUAL",
      status: "ACTIVE",
    });
    console.log(`Seeded wholesale lender counterparty: ${t.lenderName} (target)`);
  }
}
