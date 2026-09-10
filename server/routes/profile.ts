import type { Express } from "express";
import { and, desc, eq } from "drizzle-orm";
import { isAuthenticated } from "../auth";
import { storage } from "../storage";
import { db } from "../db";
import { auditLogs, pickActiveLoanApplication } from "@shared/schema";
import type { LoanApplication, User } from "@shared/schema";
import { getCoachIntakeSnapshots } from "../services/coachIntake";
import { getCurrentDecisionGrade } from "../services/currentDecisionGrade";

// Borrower-facing financial profile aggregate — backs the "My Profile" page.
//
// READ-ONLY aggregation: identity + the intake-relevant slice of the user's
// draft/active application (with provenance + per-dimension verification
// flags) + latest coach readiness + the AI-coach capture trail (derived from
// coach.intake_synced audit rows, which carry field NAMES only). There is no
// second store: the draft application remains the single source of truth for
// pre-app data, so this page and the coach can never drift.
//
// Inline edits reuse the existing draft-only PATCH /api/loan-applications/:id
// (same shared Zod schema as the funnel) — no new write endpoint.

const PROFILE_APPLICATION_FIELDS = [
  "annualIncome",
  "monthlyDebts",
  "creditScore",
  "employmentType",
  "employmentYears",
  "employerName",
  "downPayment",
  "purchasePrice",
  "propertyType",
  "loanPurpose",
  "isVeteran",
  "isFirstTimeBuyer",
  "propertyState",
] as const;

export function registerProfileRoutes(app: Express) {
  app.get("/api/profile/financial", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;

      const applications = await storage.getLoanApplicationsByUser(user.id);
      const draft = applications.find((a) => a.status === "draft");
      const active = pickActiveLoanApplication(applications);
      const display: LoanApplication | null = draft ?? active ?? applications[0] ?? null;
      const currentGrade = display ? await getCurrentDecisionGrade(display) : null;

      const { conversations } = await getCoachIntakeSnapshots(user.id);
      const latestConversation = conversations[0] ?? null;

      const syncRows = await db
        .select({ metadata: auditLogs.metadata, createdAt: auditLogs.createdAt })
        .from(auditLogs)
        .where(and(eq(auditLogs.actorUserId, user.id), eq(auditLogs.action, "coach.intake_synced")))
        .orderBy(desc(auditLogs.createdAt))
        .limit(50);
      const coachFields = new Set<string>();
      for (const row of syncRows) {
        const fields = (row.metadata as { fields?: unknown } | null)?.fields;
        if (Array.isArray(fields)) {
          for (const f of fields) {
            if (typeof f === "string") coachFields.add(f);
          }
        }
      }

      res.json({
        user: {
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
          email: user.email ?? null,
          role: user.role,
        },
        application: display
          ? {
              id: display.id,
              status: display.status,
              editable: display.status === "draft",
              financialDataProvenance: display.financialDataProvenance,
              currentDecisionGrade: currentGrade?.isDecisionGrade ?? false,
              incomeVerified: currentGrade?.verification.income ?? false,
              assetsVerified: currentGrade?.verification.assets ?? false,
              creditVerified: currentGrade?.verification.credit ?? false,
              updatedAt: display.updatedAt,
              fields: Object.fromEntries(
                PROFILE_APPLICATION_FIELDS.map((f) => [f, (display as Record<string, unknown>)[f] ?? null]),
              ),
            }
          : null,
        readiness: latestConversation
          ? {
              tier: latestConversation.readinessTier,
              completionPercentage: latestConversation.completionPercentage,
              updatedAt: latestConversation.updatedAt,
            }
          : null,
        coachCapture:
          syncRows.length > 0
            ? { lastSyncedAt: syncRows[0].createdAt, fields: [...coachFields] }
            : null,
      });
    } catch (error) {
      console.error("Get financial profile error:", error);
      res.status(500).json({ error: "Failed to load profile" });
    }
  });
}
