import type { Express, NextFunction, Response } from "express";
import { requireRole } from "../auth";
import { INTERNAL_STAFF_ROLES } from "@shared/roles";
import { FINANCIAL_VERIFICATION_ROLES } from "@shared/loanApplicationStatus";
import { liabilityTreatmentReviewSchema, reviewFinancialArtifactSchema } from "@shared/financialReview";
import { routeParam } from "../http/routeParams";
import {
  buildCreditMemo,
  FinancialReviewError,
  getFinancialReview,
  prepareFinancialWorkpapers,
  recordLiabilityUnderwritingTreatment,
  reviewCreditMemo,
  reviewFinancialWorkpaper,
} from "../services/financialReview";
import { DocumentLineageError } from "../services/documentLineage";
import { postgresErrorCode } from "../services/transactionRetry";
import { logAudit } from "../auditLog";

function financialReviewError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof FinancialReviewError || error instanceof DocumentLineageError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  const code = postgresErrorCode(error);
  if (code === "40001" || code === "40P01" || code === "23505") {
    res.status(409).json({ error: "Financial review changed while saving. Refresh and try again." });
    return;
  }
  next(error);
}

export function registerFinancialReviewRoutes(app: Express) {
  app.get("/api/loan-applications/:id/financial-review", requireRole(...INTERNAL_STAFF_ROLES), async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const id = routeParam(req, "id");
      const result = await getFinancialReview(id, req.user!);
      await logAudit(req, "financial_review.viewed", "loan_application", id);
      res.json(result);
    } catch (error) {
      financialReviewError(error, res, next);
    }
  });

  app.post("/api/loan-applications/:id/financial-review/prepare", requireRole(...FINANCIAL_VERIFICATION_ROLES), async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const result = await prepareFinancialWorkpapers(routeParam(req, "id"), req.user!);
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      financialReviewError(error, res, next);
    }
  });

  app.post("/api/loan-applications/:id/financial-review/liabilities/:liabilityId/treatment", requireRole(...FINANCIAL_VERIFICATION_ROLES), async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const parsed = liabilityTreatmentReviewSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Choose a supported treatment, accepted source document, and current bureau tradeline." });
        return;
      }
      const result = await recordLiabilityUnderwritingTreatment(
        routeParam(req, "id"),
        routeParam(req, "liabilityId"),
        req.user!,
        parsed.data,
      );
      res.json(result);
    } catch (error) {
      financialReviewError(error, res, next);
    }
  });

  app.post("/api/loan-applications/:id/financial-review/workpapers/:versionId/review", requireRole(...FINANCIAL_VERIFICATION_ROLES), async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const parsed = reviewFinancialArtifactSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Add a brief review reason and refresh the current calculation." });
        return;
      }
      const result = await reviewFinancialWorkpaper(
        routeParam(req, "id"),
        routeParam(req, "versionId"),
        req.user!,
        parsed.data,
      );
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      financialReviewError(error, res, next);
    }
  });

  app.post("/api/loan-applications/:id/financial-review/memo", requireRole(...FINANCIAL_VERIFICATION_ROLES), async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const result = await buildCreditMemo(routeParam(req, "id"), req.user!);
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      financialReviewError(error, res, next);
    }
  });

  app.post("/api/loan-applications/:id/financial-review/memo/:memoId/review", requireRole(...FINANCIAL_VERIFICATION_ROLES), async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const parsed = reviewFinancialArtifactSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Add a brief review reason and refresh the current memo." });
        return;
      }
      const result = await reviewCreditMemo(
        routeParam(req, "id"),
        routeParam(req, "memoId"),
        req.user!,
        parsed.data,
      );
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      financialReviewError(error, res, next);
    }
  });
}
