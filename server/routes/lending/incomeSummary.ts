// Lending routes: borrower income summary — C1 post-decision transparency +
// the educational analyzing state (Borrower Clarity PR 7, kb log 2026-08-04 §4).
// One registrar in the original registration order — see ./index.ts.
import type { Express } from "express";
import type { IStorage } from "../../storage";
import { isAuthenticated } from "../../auth";
import { isApprovedGradeLoanAppStatus, type User } from "@shared/schema";
import { getCurrentDecisionGrade } from "../../services/currentDecisionGrade";
import {
  parsePersistedPaths,
  toBorrowerIncomeAnalyzingView,
  toBorrowerIncomeAvailableView,
} from "@shared/borrowerIncomeView";
import { logAudit } from "../../auditLog";
import { routeParams } from "../../http/routeParams";

export function registerIncomeSummaryRoutes(
  app: Express,
  storage: IStorage,
) {
  app.get("/api/loan-applications/:id/income-summary", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);

      const application = await storage.getLoanApplicationWithAccess(id, user.id, user.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const { getLatestIncomePathEvaluation } = await import("../../services/scenarioSimulator");
      const evaluation = await getLatestIncomePathEvaluation(id);
      const paths = parsePersistedPaths(evaluation?.paths);

      // Figures unlock at the letter's gate class: approved-grade status AND
      // decision-grade (staff-verified) financial data. Anything earlier gets
      // the educational analyzing view — source labels, never numbers (the
      // live-math variant is a recorded binding rejection; MR-2, Reg N).
      const decisionReady =
        isApprovedGradeLoanAppStatus(application.status) &&
        (await getCurrentDecisionGrade(application)).isDecisionGrade;

      // A non-owner (staff/deal-team) read of another borrower's file is
      // audited in BOTH states — the analyzing view's source labels are still
      // derived from the borrower's file (tax-intelligence owner/staff
      // pattern). The owner reading their own is not audited.
      if (application.userId !== user.id) {
        logAudit(req, "income_summary.viewed", "loan_application", id, {
          evaluationId: evaluation?.id ?? null,
          state: decisionReady && evaluation && paths ? "available" : "analyzing",
        });
      }

      if (!decisionReady || !evaluation || !paths) {
        return res.json(toBorrowerIncomeAnalyzingView(paths));
      }

      res.json(
        toBorrowerIncomeAvailableView({
          createdAt: evaluation.createdAt,
          incomeBasis: evaluation.incomeBasis,
          primaryMonthlyQualifyingIncome: evaluation.primaryMonthlyQualifyingIncome,
          paths,
        }),
      );
    } catch (error) {
      console.error("Income summary error:", error);
      res.status(500).json({ error: "Failed to load income summary" });
    }
  });
}
