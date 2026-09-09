import { sql } from "drizzle-orm";
import { pgTable, varchar, text, integer, decimal, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { loanApplications } from "./lending";

// =============================================================================
// DECISION SNAPSHOTS — the deterministic engine's "context graph" history.
//
// Every time the instant-decision engine runs (on data change or on demand) it
// records an immutable snapshot here. This gives a time-ordered trail of how the
// decision evolved as facts arrived — the audit surface behind a Tinman-style
// real-time recalc, and the source for "what changed the decision, and when."
// =============================================================================

export const decisionSnapshots = pgTable(
  "decision_snapshots",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    applicationId: varchar("application_id").references(() => loanApplications.id).notNull(),

    // What triggered this recalc: "credit_pull", "income_updated",
    // "liability_updated", "financials_verified", "manual", etc.
    trigger: varchar("trigger", { length: 50 }).notNull(),

    status: varchar("status", { length: 30 }).notNull(), // DECISION_READY | NEEDS_MORE_INFO
    decision: varchar("decision", { length: 30 }), // APPROVED | REJECTED | MANUAL_REVIEW | null
    qualifier: varchar("qualifier", { length: 20 }).notNull(), // PRELIMINARY | VERIFIED

    // Snapshotted metrics (null when NEEDS_MORE_INFO)
    dti: decimal("dti", { precision: 6, scale: 2 }),
    ltv: decimal("ltv", { precision: 6, scale: 2 }),
    monthlyIncome: decimal("monthly_income", { precision: 12, scale: 2 }),
    monthlyDebts: decimal("monthly_debts", { precision: 12, scale: 2 }),
    monthlyPiti: decimal("monthly_piti", { precision: 12, scale: 2 }),
    loanAmount: decimal("loan_amount", { precision: 14, scale: 2 }),
    borrowerCount: integer("borrower_count"),
    incomeBasis: varchar("income_basis", { length: 30 }), // urla_line_items | application_summary

    reasons: text("reasons").array(),
    missingItems: text("missing_items").array(),

    // Reproducibility: the resolved policy thresholds/matrix cells this decision
    // used, plus a short fingerprint over them. Lookup matrices are mutable, so
    // these let a past decision be reconstructed even after a matrix edit.
    inputFingerprint: varchar("input_fingerprint", { length: 64 }),
    resolvedPolicy: jsonb("resolved_policy"),
    policyFingerprint: varchar("policy_fingerprint", { length: 64 }),

    // Which multi-path income evaluation (P3) produced the income figure behind
    // this decision. Nullable: back-fills as evaluations start being recorded.
    incomePathEvaluationId: varchar("income_path_evaluation_id", { length: 36 }),

    createdAt: timestamp("created_at").notNull().default(sql`now()`),
  },
  (table) => ({
    applicationIdx: index("decision_snapshots_application_idx").on(table.applicationId),
    createdAtIdx: index("decision_snapshots_created_at_idx").on(table.createdAt),
  }),
);

export const insertDecisionSnapshotSchema = createInsertSchema(decisionSnapshots).omit({
  id: true,
  createdAt: true,
});

export type DecisionSnapshot = typeof decisionSnapshots.$inferSelect;
export type InsertDecisionSnapshot = typeof decisionSnapshots.$inferInsert;
