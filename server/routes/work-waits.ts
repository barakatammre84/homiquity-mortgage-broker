import type { Express, NextFunction, Response } from "express";
import { requireRole } from "../auth";
import { INTERNAL_STAFF_ROLES } from "@shared/roles";
import { closeWorkWaitSchema, listWorkWaitsSchema, recordWorkWaitSchema } from "@shared/workWaits";
import { routeParam } from "../http/routeParams";
import { closeWorkWait, listWorkWaits, recordWorkWait, WorkWaitError } from "../services/workWaits";
import { postgresErrorCode } from "../services/transactionRetry";
import { logAudit } from "../auditLog";

function handleError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof WorkWaitError) { res.status(error.status).json({ error: error.message }); return; }
  if (["23505", "40001", "40P01"].includes(postgresErrorCode(error) ?? "")) {
    res.status(409).json({ error: "The observation changed while saving. Reload the wait before retrying." }); return;
  }
  next(error);
}

export function registerWorkWaitRoutes(app: Express) {
  app.get("/api/loan-applications/:id/work-waits", requireRole(...INTERNAL_STAFF_ROLES), async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const parsed = listWorkWaitsSchema.safeParse(req.query);
      if (!parsed.success) { res.status(400).json({ error: "Use a valid cursor and a limit from 1 to 100." }); return; }
      const id = routeParam(req, "id");
      const result = await listWorkWaits(id, req.user!, parsed.data);
      await logAudit(req, "work_wait.viewed", "loan_application", id);
      res.json(result);
    } catch (error) { handleError(error, res, next); }
  });
  app.post("/api/loan-applications/:id/work-waits", requireRole(...INTERNAL_STAFF_ROLES), async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const parsed = recordWorkWaitSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "Supply a task, counterparty, stable event UUID, and valid observation times." }); return; }
      const result = await recordWorkWait(routeParam(req, "id"), req.user!, parsed.data);
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) { handleError(error, res, next); }
  });
  app.post("/api/loan-applications/:id/work-waits/:waitId/close", requireRole(...INTERNAL_STAFF_ROLES), async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      const parsed = closeWorkWaitSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: "Supply a stable closing-event UUID, closure time, and outcome." }); return; }
      res.json(await closeWorkWait(routeParam(req, "id"), routeParam(req, "waitId"), req.user!, parsed.data));
    } catch (error) { handleError(error, res, next); }
  });
}
