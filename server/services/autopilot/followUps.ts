import { storage } from "../../storage";
import type { PreUwFlag, PreUwFlagCode } from "../preUnderwriting";

/**
 * Autopilot follow-up materialization — closes the flag→condition gap.
 *
 * `runPreUnderwriting` derives a full flag set but today only LOW_RESERVES
 * becomes a real loan_condition; the rest stop at a dedup'd borrower email. This
 * gives the remaining flags teeth: each becomes an idempotent, guideline-cited
 * loan_condition (already borrower- and LO-visible, and auto-resolves on a
 * matching upload via pipelineEngine.matchUploadedDocumentToConditions).
 *
 * Every follow-up carries a Selling-Guide citation verifiable in the in-repo
 * references (no-citation-no-implementation): a flag with no verifiable citation
 * is not materialized here.
 *
 * Deliberately EXCLUDED:
 *   - LOW_RESERVES_WARNING     — already materialized by runPreUnderwriting.
 *   - COMPLEX_INCOME_CHECK     — self-employed 2-yr tax-return condition is
 *                                already created by pipelineEngine at intake;
 *                                re-creating it would double-ask the borrower.
 *
 * The CALLER gates on isAutopilotEnabled() + canGenerateFollowUps() — Homiquity
 * is a broker, so these are packaging follow-ups, never a credit decision, and
 * none of this messaging claims approval (Reg N).
 */

interface FollowUpSpec {
  title: string;
  category: string; // CONDITION_CATEGORIES
  /** Selling-Guide citation, verified against docs/fannie-mae/ + income engine. */
  citation: string;
}

// Only flags whose Selling-Guide section is verifiable in the in-repo references
// (server/services/preUnderwriting.ts comments + shared/incomePaths.ts citations).
const MATERIALIZABLE: Partial<Record<PreUwFlagCode, FollowUpSpec>> = {
  INCOME_SEASONING: {
    title: "Income History Verification",
    category: "income",
    citation: "Fannie Mae B3-3.5-01",
  },
  VERIFIED_DEBT_DTI: {
    title: "Debt / DTI Documentation",
    category: "credit",
    citation: "Fannie Mae B3-6-05",
  },
  LARGE_DEPOSIT_SOURCING: {
    title: "Large Deposit Sourcing (Letter of Explanation)",
    category: "assets",
    citation: "Fannie Mae B3-4.2-02 (gifts resolved per B3-4.3-04)",
  },
  RENTAL_INCOME_OFFSET: {
    title: "Rental Income Documentation",
    category: "income",
    citation: "Fannie Mae B3-3.8-01 (formerly B3-3.1-08)",
  },
  SUBJECT_PROPERTY_RENTAL_OFFSET: {
    title: "Subject Property Rental Income Documentation",
    category: "income",
    citation: "Fannie Mae B3-3.8-01 (formerly B3-3.1-08)",
  },
};

/** Stable per-flag source-rule key — the idempotency handle for the condition. */
export function autopilotSourceRule(code: PreUwFlagCode): string {
  return `AUTOPILOT_${code}`;
}

/** The condition a flag becomes — the pure, DB-free decision (unit-testable). */
export interface FollowUpConditionPlan {
  category: string;
  title: string;
  description: string;
  priority: "prior_to_approval" | "prior_to_docs";
  requiredDocumentTypes: string[];
  sourceRule: string;
}

/**
 * Map a pre-UW flag to the loan_condition it should become, or null if it isn't
 * materializable by Autopilot (no verifiable citation, or handled elsewhere).
 * Pure — no DB, no side effects.
 */
export function planFollowUpForFlag(flag: PreUwFlag): FollowUpConditionPlan | null {
  const spec = MATERIALIZABLE[flag.code];
  if (!spec) return null;
  return {
    category: spec.category,
    title: spec.title,
    // The reason is already borrower-first with the specific numbers; append
    // the guideline citation so the LO and borrower always see the source.
    description: `${flag.reason} (${spec.citation})`,
    priority: flag.severity === "blocking" ? "prior_to_approval" : "prior_to_docs",
    requiredDocumentTypes: [...new Set(flag.requiredDocs.map((d) => d.documentType))],
    sourceRule: flag.conditionSourceRule ?? autopilotSourceRule(flag.code),
  };
}

/**
 * Reconcile one control-grade follow-up whether or not Autopilot is enabled.
 * Used for findings that directly affect a reviewed calculation.
 */
export async function reconcileFlagFollowUp(
  applicationId: string,
  code: PreUwFlagCode,
  currentFlag: PreUwFlag | null,
): Promise<void> {
  const prefix = autopilotSourceRule(code);
  const plan = currentFlag ? planFollowUpForFlag(currentFlag) : null;
  const existing = await storage.getLoanConditionsByApplication(applicationId);
  for (const condition of existing) {
    if (!condition.sourceRule?.startsWith(prefix)) continue;
    if (plan && condition.sourceRule === plan.sourceRule) continue;
    if (condition.status === "outstanding" || condition.status === "submitted") {
      await storage.updateLoanCondition(condition.id, {
        status: "not_applicable",
        clearedAt: new Date(),
        clearanceNotes: "This large-deposit evidence set is no longer current.",
      });
    }
  }
  if (!plan || existing.some(condition => condition.sourceRule === plan.sourceRule)) return;
  await storage.createLoanCondition({
    applicationId,
    category: plan.category,
    title: plan.title,
    description: plan.description,
    priority: "prior_to_approval",
    status: "outstanding",
    requiredDocumentTypes: plan.requiredDocumentTypes,
    isAutoGenerated: true,
    sourceRule: plan.sourceRule,
  });
}

export interface MaterializeResult {
  /** Titles of conditions newly created on this call (empty if all pre-existed). */
  created: string[];
}

/**
 * For each materializable flag, create a cited loan_condition if one doesn't
 * already exist for this application (idempotent by sourceRule, across all
 * statuses — a cleared condition is never re-nagged). Never throws.
 */
export async function materializeFlagsToFollowUps(
  applicationId: string,
  flags: PreUwFlag[],
): Promise<MaterializeResult> {
  const created: string[] = [];
  try {
    const existing = await storage.getLoanConditionsByApplication(applicationId);
    const existingSourceRules = new Set(existing.map((c) => c.sourceRule).filter(Boolean));

    for (const flag of flags) {
      const plan = planFollowUpForFlag(flag);
      if (!plan) continue; // not materializable (no verifiable citation / handled elsewhere)
      if (existingSourceRules.has(plan.sourceRule)) continue; // already has teeth

      await storage.createLoanCondition({
        applicationId,
        category: plan.category,
        title: plan.title,
        description: plan.description,
        priority: plan.priority,
        status: "outstanding",
        requiredDocumentTypes: plan.requiredDocumentTypes,
        isAutoGenerated: true,
        sourceRule: plan.sourceRule,
      });
      existingSourceRules.add(plan.sourceRule);
      created.push(plan.title);
    }
  } catch (err) {
    console.error(`[Autopilot] Follow-up materialization failed for ${applicationId} (non-fatal):`, err);
  }
  return { created };
}
