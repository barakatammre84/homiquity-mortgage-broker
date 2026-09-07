// Borrower routes: URLA sections (personal info/SSN/employment/income/assets/liabilities/property) + bulk save.
// One registrar in the original registration order — see ./index.ts.
import type { Express } from "express";
import { isUrlaRowSaveable } from "@shared/lib/urlaRowContent";
import type { IStorage } from "../../storage";
import { isAuthenticated } from "../../auth";
import { logAudit } from "../../auditLog";
import { selfEmploymentWorksheetSchema, urlaLoanDetailsSchema, isStaffRole, isInternalStaffRole, type User } from "@shared/schema";
import { pickTableFields, sanitizePersonalInfoBody, URLA_TABLES } from "../urlaValidation";
import { stripEncryptedFields } from "../../services/piiVault";
import { evaluateTridTrigger } from "../../services/trid";

// Verify that an internal staff user is actually assigned to the given application.
// Returns true for admin (unrestricted), checks LO assignment for lo/loa, and
// deal-team membership for processor/underwriter/closer.
// External partner roles (broker, lender) are NOT permitted by this helper.
// Exported: the LO-2 scenario route reuses this gate (one access model, no forks).
import { maskUrlaPersonalInfo } from "./access";
import { routeParams } from "../../http/routeParams";

/**
 * B3-6-05, Debts Paid by Others: a liability the borrower says someone else
 * pays has left (or re-entered) the qualifying ratio, and the Guide's 12-month
 * payment history must follow it as a condition — runPreUnderwriting
 * reconciles them. Detached: the write has already succeeded, and a flag-run
 * failure must never fail the borrower's save.
 */
function scheduleThirdPartyPaidDebtReconcile(applicationId: string): void {
  (async () => {
    const { runPreUnderwriting } = await import("../../services/preUnderwriting");
    await runPreUnderwriting(applicationId, "liability_declared");
  })().catch((err) =>
    console.warn(`[B3-6-05] Third-party-paid debt reconcile failed for ${applicationId} (non-fatal):`, err?.message || err),
  );
}

export function registerUrlaRoutes(
  app: Express,
  storage: IStorage,
) {
  // URLA Data Routes
  app.get("/api/urla/:applicationId", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      const urlaData = await storage.getCompleteUrlaData(applicationId);
      // Redact raw PII for external partners (broker/lender). They may be
      // deal-team members but must not see full SSN/DOB — matching the
      // redaction discipline already applied on the credit/verification routes
      // in compliance.ts. The borrower (a client role) and internal staff are
      // unaffected and see the full record.
      if (isStaffRole(user.role) && !isInternalStaffRole(user.role)) {
        if (urlaData.personalInfo) {
          urlaData.personalInfo = maskUrlaPersonalInfo(urlaData.personalInfo);
        }
        urlaData.allPersonalInfo = (urlaData.allPersonalInfo ?? []).map(maskUrlaPersonalInfo);
      }
      // Ciphertext/IV/key columns never leave the server — clients get last4 only.
      res.json({
        application,
        ...urlaData,
        personalInfo: urlaData.personalInfo ? stripEncryptedFields(urlaData.personalInfo) : urlaData.personalInfo,
        allPersonalInfo: urlaData.allPersonalInfo.map(stripEncryptedFields),
        assets: urlaData.assets.map(stripEncryptedFields),
        liabilities: urlaData.liabilities.map(stripEncryptedFields),
      });
    } catch (error) {
      console.error("Get URLA data error:", error);
      res.status(500).json({ error: "Failed to get URLA data" });
    }
  });

  /**
   * Audited full-SSN reveal. Everything else in the API returns the masked
   * form; this endpoint exists for the narrow staff workflows that genuinely
   * need the full value (credit pulls, GSE casefile fixes). Owner borrowers
   * may read their own. Every call writes an audit entry.
   */
  app.get("/api/urla/:applicationId/ssn", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId } = routeParams(req);
      const seq = Math.max(parseInt(String(req.query.borrowerSequenceNumber ?? "1"), 10) || 1, 1);

      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }

      const isOwner = application.userId === user.id;
      const allowedStaff = ["admin", "underwriter", "processor"];
      if (!isOwner && !allowedStaff.includes(user.role)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const ssn = await storage.getDecryptedUrlaSsn(applicationId, seq);
      if (!ssn) {
        return res.status(404).json({ error: "No SSN on file" });
      }

      await logAudit(req, "urla.ssn_reveal", "loan_application", applicationId, {
        borrowerSequenceNumber: seq,
        role: user.role,
      });
      res.json({ ssn });
    } catch (error) {
      console.error("SSN reveal error:", error);
      res.status(500).json({ error: "Failed to retrieve SSN" });
    }
  });

  app.post("/api/urla/:applicationId/employment", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      const data = { ...pickTableFields(URLA_TABLES.employment, req.body), applicationId };
      const result = await storage.createEmploymentHistory(data as any);
      res.status(201).json(result);
    } catch (error) {
      console.error("Create employment error:", error);
      res.status(500).json({ error: "Failed to create employment record" });
    }
  });

  app.patch("/api/urla/employment/:id", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);
      const record = await storage.getEmploymentHistoryById(id);
      if (!record) {
        return res.status(404).json({ error: "Employment record not found" });
      }
      const application = await storage.getLoanApplicationWithAccess(record.applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      // Whitelist to table columns; applicationId is always stripped (immutable).
      const safeBody = pickTableFields(URLA_TABLES.employment, req.body);
      const result = await storage.updateEmploymentHistory(id, safeBody as any);
      if (!result) {
        return res.status(404).json({ error: "Employment record not found" });
      }
      res.json(result);
    } catch (error) {
      console.error("Update employment error:", error);
      res.status(500).json({ error: "Failed to update employment record" });
    }
  });

  app.delete("/api/urla/employment/:id", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);
      const record = await storage.getEmploymentHistoryById(id);
      if (!record) {
        return res.status(404).json({ error: "Employment record not found" });
      }
      const application = await storage.getLoanApplicationWithAccess(record.applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deleteEmploymentHistory(id);
      try {
        const { refreshEarlyStageIntakeAnalysis } = await import("../../services/loanAnalysis");
        await refreshEarlyStageIntakeAnalysis(record.applicationId, "income_updated");
      } catch (analysisErr) {
        console.error("[Analysis] Employment deletion refresh failed (non-fatal):", analysisErr);
      }
      res.status(204).send();
    } catch (error) {
      console.error("Delete employment error:", error);
      res.status(500).json({ error: "Failed to delete employment record" });
    }
  });

  // Self-employment income worksheet (Form 1084 / B3-3.5 & B3-3.6). This is a
  // structured JSON object, so it does NOT go through the generic employment
  // save (pickTableFields drops JSON by design) — it has its own Zod-validated
  // write path. Providing a worksheet marks the record self-employed.
  app.put("/api/urla/employment/:id/self-employment", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);
      const record = await storage.getEmploymentHistoryById(id);
      if (!record) {
        return res.status(404).json({ error: "Employment record not found" });
      }
      const application = await storage.getLoanApplicationWithAccess(record.applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      const parsed = selfEmploymentWorksheetSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid self-employment worksheet",
          details: parsed.error.flatten(),
        });
      }
      const result = await storage.updateEmploymentHistory(id, {
        selfEmploymentIncome: parsed.data,
        isSelfEmployed: true,
      } as any);
      if (!result) {
        return res.status(404).json({ error: "Employment record not found" });
      }

      // P5 accuracy loop: a saved worksheet changes qualifying income. Await
      // the shared preliminary-analysis refresh so the response, decision
      // history, dashboard headline, and staff file all describe the same facts.
      try {
        const { refreshEarlyStageIntakeAnalysis } = await import("../../services/loanAnalysis");
        await refreshEarlyStageIntakeAnalysis(
          record.applicationId,
          parsed.data.confirmedByBorrowerAt ? "worksheet_confirmed" : "income_updated",
        );
      } catch (analysisErr) {
        console.error("[Analysis] Worksheet refresh failed (non-fatal):", analysisErr);
      }

      res.json(result);
    } catch (error) {
      console.error("Save self-employment worksheet error:", error);
      res.status(500).json({ error: "Failed to save self-employment worksheet" });
    }
  });

  app.post("/api/urla/:applicationId/other-income", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      const data = { ...pickTableFields(URLA_TABLES.otherIncome, req.body), applicationId };
      const result = await storage.createOtherIncomeSource(data as any);
      res.status(201).json(result);
    } catch (error) {
      console.error("Create other income error:", error);
      res.status(500).json({ error: "Failed to create other income source" });
    }
  });

  app.delete("/api/urla/other-income/:id", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);
      const record = await storage.getOtherIncomeSourceById(id);
      if (!record) {
        return res.status(404).json({ error: "Income source not found" });
      }
      const application = await storage.getLoanApplicationWithAccess(record.applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deleteOtherIncomeSource(id);
      res.status(204).send();
    } catch (error) {
      console.error("Delete other income error:", error);
      res.status(500).json({ error: "Failed to delete other income source" });
    }
  });

  app.post("/api/urla/:applicationId/assets", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      const data = { ...pickTableFields(URLA_TABLES.asset, req.body, ["accountNumber"]), applicationId };
      const result = await storage.createUrlaAsset(data as any);
      res.status(201).json(stripEncryptedFields(result));
    } catch (error) {
      console.error("Create asset error:", error);
      res.status(500).json({ error: "Failed to create asset" });
    }
  });

  app.patch("/api/urla/assets/:id", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);
      const record = await storage.getUrlaAssetById(id);
      if (!record) {
        return res.status(404).json({ error: "Asset not found" });
      }
      const application = await storage.getLoanApplicationWithAccess(record.applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      // Whitelist to table columns; applicationId is always stripped (immutable).
      const safeBody = pickTableFields(URLA_TABLES.asset, req.body, ["accountNumber"]);
      const result = await storage.updateUrlaAsset(id, safeBody as any);
      if (!result) {
        return res.status(404).json({ error: "Asset not found" });
      }
      res.json(stripEncryptedFields(result));
    } catch (error) {
      console.error("Update asset error:", error);
      res.status(500).json({ error: "Failed to update asset" });
    }
  });

  // Remove a co-applicant from the application.
  //
  // The Remove Co-Borrower button used to be purely local state: the bulk save
  // is upsert-only and simply omitted `coApplicants` when the flag was false,
  // so nothing was ever deleted and the post-save refetch found the seq-2 rows
  // still there and put the co-borrower straight back on screen — after a
  // success toast. A co-applicant the borrower had deliberately removed stayed
  // on the loan file and was still exported to MISMO (#450).
  //
  // Destructive and irreversible, so: ownership-checked like every other delete
  // here, refuses the primary borrower, and writes an audit entry recording
  // exactly what was removed. The audit log is where the evidence of the
  // removal lives once the rows are gone.
  app.delete("/api/urla/:applicationId/co-applicant/:seq", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId, seq } = routeParams(req);
      const sequence = Number(seq);
      if (!Number.isInteger(sequence) || sequence <= 1) {
        return res.status(400).json({ error: "Only a co-applicant (borrower sequence 2 or higher) can be removed" });
      }
      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      const removed = await storage.deleteCoApplicantRecords(applicationId, sequence);
      await logAudit(req, "urla.co_applicant.removed", "loan_application", applicationId, {
        borrowerSequenceNumber: sequence,
        removed,
      });
      res.json({ removed });
    } catch (error) {
      console.error("Remove co-applicant error:", error);
      res.status(500).json({ error: "Failed to remove co-applicant" });
    }
  });

  app.delete("/api/urla/assets/:id", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);
      const record = await storage.getUrlaAssetById(id);
      if (!record) {
        return res.status(404).json({ error: "Asset not found" });
      }
      const application = await storage.getLoanApplicationWithAccess(record.applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deleteUrlaAsset(id);
      res.status(204).send();
    } catch (error) {
      console.error("Delete asset error:", error);
      res.status(500).json({ error: "Failed to delete asset" });
    }
  });

  app.post("/api/urla/:applicationId/liabilities", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      const data = { ...pickTableFields(URLA_TABLES.liability, req.body, ["accountNumber"]), applicationId };
      const result = await storage.createUrlaLiability(data as any);
      if (result.paidByOtherParty) scheduleThirdPartyPaidDebtReconcile(applicationId);
      res.status(201).json(stripEncryptedFields(result));
    } catch (error) {
      console.error("Create liability error:", error);
      res.status(500).json({ error: "Failed to create liability" });
    }
  });

  app.patch("/api/urla/liabilities/:id", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);
      const record = await storage.getUrlaLiabilityById(id);
      if (!record) {
        return res.status(404).json({ error: "Liability not found" });
      }
      const application = await storage.getLoanApplicationWithAccess(record.applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      // Whitelist to table columns; applicationId is always stripped (immutable).
      const safeBody = pickTableFields(URLA_TABLES.liability, req.body, ["accountNumber"]);
      const result = await storage.updateUrlaLiability(id, safeBody as any);
      if (!result) {
        return res.status(404).json({ error: "Liability not found" });
      }
      if (result.paidByOtherParty || record.paidByOtherParty) scheduleThirdPartyPaidDebtReconcile(record.applicationId);
      res.json(stripEncryptedFields(result));
    } catch (error) {
      console.error("Update liability error:", error);
      res.status(500).json({ error: "Failed to update liability" });
    }
  });

  app.delete("/api/urla/liabilities/:id", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);
      const record = await storage.getUrlaLiabilityById(id);
      if (!record) {
        return res.status(404).json({ error: "Liability not found" });
      }
      const application = await storage.getLoanApplicationWithAccess(record.applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      await storage.deleteUrlaLiability(id);
      if (record.paidByOtherParty) scheduleThirdPartyPaidDebtReconcile(record.applicationId);
      res.status(204).send();
    } catch (error) {
      console.error("Delete liability error:", error);
      res.status(500).json({ error: "Failed to delete liability" });
    }
  });

  app.post("/api/urla/:applicationId/property-info", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId } = routeParams(req);
      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }
      const data = { ...pickTableFields(URLA_TABLES.propertyInfo, req.body), applicationId };
      const result = await storage.upsertUrlaPropertyInfo(data as any);
      res.json(result);
    } catch (error) {
      console.error("Save property info error:", error);
      res.status(500).json({ error: "Failed to save property info" });
    }
  });

  // Bulk save URLA data - only updates sections that are explicitly provided with content
  app.post("/api/urla/:applicationId/save", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { applicationId } = routeParams(req);
      const { personalInfo, employmentHistory, otherIncomeSources, assets, liabilities, propertyInfo, loanDetails, declarations, demographics, coApplicants } = req.body;

      // Verify the requesting user owns (or has staff access to) this application
      const application = await storage.getLoanApplicationWithAccess(applicationId, user.id, user.role);
      if (!application) {
        return res.status(403).json({ error: "Access denied" });
      }

      const hasContent = (obj: any) =>
        obj && typeof obj === "object" &&
        Object.keys(obj).some(key => obj[key] !== undefined && obj[key] !== "" && obj[key] !== null);

      const demographicsHasContent = (d: any) =>
        d && typeof d === "object" && (
          d.ethnicityHispanicLatino || d.ethnicityNotHispanicLatino || d.ethnicityNotProvided ||
          d.raceAmericanIndian || d.raceAsian || d.raceBlack || d.raceNativeHawaiian || d.raceWhite || d.raceNotProvided ||
          d.sexFemale || d.sexMale || d.sexNotProvided ||
          d.ageNotProvided || (d.age !== null && d.age !== undefined && d.age !== "")
        );

      const collectionMethod = isStaffRole(user.role) ? "loan_officer" : "borrower";
      let decisionInputsChanged = false;

      // Writes one borrower's URLA sections, scoped to a borrowerSequenceNumber.
      // Bodies are whitelisted to their table's columns (pickTableFields) before
      // any write. Returns ok=false with an http status when a referenced child
      // record fails the ownership check or a field fails format validation.
      const writeBorrowerSections = async (opts: {
        seq: number;
        isPrimary: boolean;
        personalInfo?: any;
        employmentHistory?: any[];
        assets?: any[];
        liabilities?: any[];
        declarations?: any;
        demographics?: any;
      }): Promise<{ ok: boolean; status?: number; error?: string; results: any }> => {
        const { seq, isPrimary } = opts;
        const results: any = {};

        if (hasContent(opts.personalInfo)) {
          const sanitized = sanitizePersonalInfoBody(opts.personalInfo);
          if (!sanitized.ok) {
            return { ok: false, status: 400, error: sanitized.error, results };
          }
          results.personalInfo = await storage.upsertUrlaPersonalInfo({
            ...sanitized.data,
            applicationId,
            borrowerSequenceNumber: seq,
            isPrimaryBorrower: isPrimary,
          } as any);

          // TRID §1026.2(a)(3): the SSN often arrives here as the 6th piece of
          // application information — evaluate the Loan Estimate trigger right
          // after the write, not at the end of the handler. This is the only
          // client-reachable SSN write path (the /personal-info route below is
          // dead — no client ever calls it), so this must not be skipped by a
          // later section (co-applicant validation, etc.) failing and early-
          // returning before the handler's end. evaluateTridTrigger reads the
          // primary borrower's data (borrowerSequenceNumber 1), so only run it
          // for the primary borrower's write.
          if (isPrimary) {
            try {
              const trid = await evaluateTridTrigger(applicationId);
              if (trid.justTriggered) {
                logAudit(req, "trid.application_triggered", "loan_application", applicationId, {
                  leDueDate: trid.leDueDate?.toISOString(),
                });
              }
            } catch (tridErr) {
              console.error("[TRID] Trigger evaluation failed (non-fatal):", tridErr);
            }
          }
        }

        if (Array.isArray(opts.employmentHistory) && opts.employmentHistory.length > 0) {
          results.employmentHistory = [];
          for (const emp of opts.employmentHistory) {
            if (!isUrlaRowSaveable("employment", emp)) continue;
            const cleanEmp = pickTableFields(URLA_TABLES.employment, emp);
            // The self-employment worksheet is a structured JSON object, so
            // pickTableFields drops it (URLA tables are scalar-only by design).
            // Validate it explicitly here and merge it back in. `null` clears it.
            if (emp.selfEmploymentIncome === null) {
              (cleanEmp as any).selfEmploymentIncome = null;
            } else if (emp.selfEmploymentIncome !== undefined) {
              const wk = selfEmploymentWorksheetSchema.safeParse(emp.selfEmploymentIncome);
              if (!wk.success) {
                return { ok: false, status: 400, error: "Invalid self-employment worksheet", results };
              }
              (cleanEmp as any).selfEmploymentIncome = wk.data;
            }
            if (emp.id) {
              const existing = await storage.getEmploymentHistoryById(emp.id);
              if (!existing || existing.applicationId !== applicationId) return { ok: false, results };
              const updated = await storage.updateEmploymentHistory(emp.id, { ...cleanEmp, borrowerSequenceNumber: seq } as any);
              if (updated) {
                results.employmentHistory.push(updated);
                decisionInputsChanged = true;
              }
            } else {
              const created = await storage.createEmploymentHistory({
                ...cleanEmp,
                applicationId,
                borrowerSequenceNumber: seq,
                employmentType: cleanEmp.employmentType || "current",
              } as any);
              results.employmentHistory.push(created);
              decisionInputsChanged = true;
            }
          }
        }

        if (Array.isArray(opts.assets) && opts.assets.length > 0) {
          results.assets = [];
          for (const asset of opts.assets) {
            if (!isUrlaRowSaveable("asset", asset)) continue;
            const cleanAsset = pickTableFields(URLA_TABLES.asset, asset, ["accountNumber"]);
            if (asset.id) {
              const existing = await storage.getUrlaAssetById(asset.id);
              if (!existing || existing.applicationId !== applicationId) return { ok: false, results };
              const updated = await storage.updateUrlaAsset(asset.id, { ...cleanAsset, borrowerSequenceNumber: seq } as any);
              if (updated) {
                results.assets.push(updated);
                decisionInputsChanged = true;
              }
            } else if (asset.accountType) {
              const created = await storage.createUrlaAsset({ ...cleanAsset, applicationId, borrowerSequenceNumber: seq } as any);
              results.assets.push(created);
              decisionInputsChanged = true;
            }
          }
        }

        if (Array.isArray(opts.liabilities) && opts.liabilities.length > 0) {
          results.liabilities = [];
          for (const liability of opts.liabilities) {
            if (!isUrlaRowSaveable("liability", liability)) continue;
            const cleanLiability = pickTableFields(URLA_TABLES.liability, liability, ["accountNumber"]);
            if (liability.id) {
              const existing = await storage.getUrlaLiabilityById(liability.id);
              if (!existing || existing.applicationId !== applicationId) return { ok: false, results };
              const updated = await storage.updateUrlaLiability(liability.id, { ...cleanLiability, borrowerSequenceNumber: seq } as any);
              if (updated) {
                results.liabilities.push(updated);
                decisionInputsChanged = true;
              }
            } else if (liability.liabilityType) {
              const created = await storage.createUrlaLiability({ ...cleanLiability, applicationId, borrowerSequenceNumber: seq } as any);
              results.liabilities.push(created);
              decisionInputsChanged = true;
            }
          }
        }

        if (hasContent(opts.declarations)) {
          results.declarations = await storage.upsertBorrowerDeclarations({
            ...pickTableFields(URLA_TABLES.declarations, opts.declarations),
            applicationId,
            borrowerSequenceNumber: seq,
          } as any);
        }

        if (demographicsHasContent(opts.demographics)) {
          results.demographics = await storage.upsertHmdaDemographics({
            ...pickTableFields(URLA_TABLES.demographics, opts.demographics),
            applicationId,
            borrowerId: application.userId,
            borrowerSequenceNumber: seq,
            collectionMethod,
          } as any);
        }

        return { ok: true, results };
      };

      // Primary borrower (sequence 1)
      const primary = await writeBorrowerSections({
        seq: 1,
        isPrimary: true,
        personalInfo,
        employmentHistory,
        assets,
        liabilities,
        declarations,
        demographics,
      });
      if (!primary.ok) {
        return res.status(primary.status ?? 403).json({ error: primary.error ?? "Access denied" });
      }
      const results: any = { ...primary.results };

      // Property info (shared subject property)
      if (hasContent(propertyInfo)) {
        results.propertyInfo = await storage.upsertUrlaPropertyInfo({
          ...pickTableFields(URLA_TABLES.propertyInfo, propertyInfo),
          applicationId,
        } as any);
        decisionInputsChanged = true;
      }

      // URLA Section 4a — loan type + amortization type (WF2-F4). These are
      // loan_applications columns, not URLA-table columns, and this is their
      // only client-reachable write path: section-4 gating
      // (services/mismoValidation.ts) requires both, and without a write path
      // every product-created file was permanently blocked from wholesale
      // submission. The borrower STATES the values; the server validates them
      // against the exact MISMO-mappable vocabulary (shared
      // urlaLoanDetailsSchema) — an invalid or partial section is a 400,
      // never a silently guessed value.
      if (hasContent(loanDetails)) {
        const parsedLoanDetails = urlaLoanDetailsSchema.safeParse(loanDetails);
        if (!parsedLoanDetails.success) {
          return res.status(400).json({
            error: "Invalid loan details",
            details: parsedLoanDetails.error.flatten(),
          });
        }
        const loanDetailsChanged =
          parsedLoanDetails.data.preferredLoanType !== application.preferredLoanType ||
          parsedLoanDetails.data.amortizationType !== application.amortizationType;
        if (loanDetailsChanged) {
          const updated = await storage.updateLoanApplication(applicationId, parsedLoanDetails.data);
          results.loanDetails = updated
            ? { preferredLoanType: updated.preferredLoanType, amortizationType: updated.amortizationType }
            : parsedLoanDetails.data;
          decisionInputsChanged = true;
        } else {
          results.loanDetails = {
            preferredLoanType: application.preferredLoanType,
            amortizationType: application.amortizationType,
          };
        }
      }

      // Other income sources (primary only)
      if (otherIncomeSources && Array.isArray(otherIncomeSources) && otherIncomeSources.length > 0) {
        results.otherIncomeSources = [];
        for (const income of otherIncomeSources) {
          if (!isUrlaRowSaveable("otherIncome", income)) continue;
          const cleanIncome = pickTableFields(URLA_TABLES.otherIncome, income);
          if (income.id) {
            const existing = await storage.getOtherIncomeSourceById(income.id);
            if (!existing || existing.applicationId !== applicationId) {
              return res.status(403).json({ error: "Access denied" });
            }
            const updated = await storage.updateOtherIncomeSource(income.id, cleanIncome as any);
            if (updated) {
              results.otherIncomeSources.push(updated);
              decisionInputsChanged = true;
            }
          } else {
            const created = await storage.createOtherIncomeSource({
              ...cleanIncome,
              applicationId,
            } as any);
            results.otherIncomeSources.push(created);
            decisionInputsChanged = true;
          }
        }
      }

      // Co-applicants (sequence 2, 3, ...)
      if (Array.isArray(coApplicants) && coApplicants.length > 0) {
        results.coApplicants = [];
        for (let i = 0; i < coApplicants.length; i++) {
          const co = coApplicants[i] || {};
          const coResult = await writeBorrowerSections({
            seq: i + 2,
            isPrimary: false,
            personalInfo: co.personalInfo,
            employmentHistory: co.employmentHistory,
            assets: co.assets,
            liabilities: co.liabilities,
            declarations: co.declarations,
            demographics: co.demographics,
          });
          if (!coResult.ok) {
            return res.status(coResult.status ?? 403).json({ error: coResult.error ?? "Access denied" });
          }
          results.coApplicants.push(coResult.results);
        }
      }

      if (decisionInputsChanged) {
        try {
          const { refreshEarlyStageIntakeAnalysis } = await import("../../services/loanAnalysis");
          const refreshed = await refreshEarlyStageIntakeAnalysis(applicationId, "urla_updated");
          if (refreshed) {
            results.analysis = {
              outcome: refreshed.outcome,
              preApprovalAmount: refreshed.preApprovalAmount,
              dtiRatio: refreshed.dtiRatio,
              ltvRatio: refreshed.ltvRatio,
            };
          }
        } catch (analysisErr) {
          // The URLA rows are already durable. Preserve a successful save and
          // surface the refresh failure to operations for retry rather than
          // returning a 500 that invites duplicate borrower rows.
          console.error("[Analysis] URLA refresh failed after save (non-fatal):", analysisErr);
        }
      }

      // Ciphertext/IV/key columns never leave the server.
      const sanitizeBorrowerResults = (r: any) => ({
        ...r,
        ...(r.personalInfo ? { personalInfo: stripEncryptedFields(r.personalInfo) } : {}),
        ...(Array.isArray(r.assets) ? { assets: r.assets.map(stripEncryptedFields) } : {}),
        ...(Array.isArray(r.liabilities) ? { liabilities: r.liabilities.map(stripEncryptedFields) } : {}),
      });
      const safeResults = sanitizeBorrowerResults(results);
      if (Array.isArray(safeResults.coApplicants)) {
        safeResults.coApplicants = safeResults.coApplicants.map(sanitizeBorrowerResults);
      }

      // Autopilot (Phase 3): proactively build the document needs list from the
      // borrower's stated URLA data — before any upload — so there's no dead
      // time waiting on a human to say what's needed. Detached + gated (the
      // cached global check means an OFF agent adds no work); the orchestrator
      // re-checks the pilot allowlist.
      (async () => {
        const { getAutopilotConfig } = await import("../../services/autopilot/config");
        if ((await getAutopilotConfig()).enabled) {
          const { runAutopilotForSection } = await import("../../services/autopilot/orchestrator");
          await runAutopilotForSection({ applicationId, triggeredBy: user.id });
        }
      })().catch((err) =>
        console.warn(`[Autopilot] Section run failed for ${applicationId} (non-fatal):`, err?.message || err),
      );

      // B3-6-05, Debts Paid by Others: a liability the borrower says someone
      // else pays has just left (or re-entered) the qualifying ratio, and the
      // Guide's 12-month payment history must follow it as a condition —
      // reconciled by runPreUnderwriting. Detached: the save has already
      // succeeded, and a flag-run failure must not fail the borrower's save.
      const savedLiabilities = [
        ...(Array.isArray(results.liabilities) ? results.liabilities : []),
        ...(Array.isArray(results.coApplicants)
          ? results.coApplicants.flatMap((c: any) => (Array.isArray(c?.liabilities) ? c.liabilities : []))
          : []),
      ];
      const touchesThirdPartyPaid =
        savedLiabilities.some((l: any) => l?.paidByOtherParty) ||
        [liabilities, ...(Array.isArray(req.body?.coApplicants) ? req.body.coApplicants.map((c: any) => c?.liabilities) : [])]
          .flat()
          .some((l: any) => l && typeof l === "object" && "paidByOtherParty" in l);
      if (touchesThirdPartyPaid) scheduleThirdPartyPaidDebtReconcile(applicationId);

      res.json(safeResults);
    } catch (error) {
      console.error("Save URLA data error:", error);
      res.status(500).json({ error: "Failed to save URLA data" });
    }
  });

  // ===== ASPIRING OWNER JOURNEY API =====

}
