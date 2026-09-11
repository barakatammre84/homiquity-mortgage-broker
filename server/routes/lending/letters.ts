// Lending routes: Pre-approval + pre-qualification letters: generation, PDF, status.
// One registrar in the original registration order — see ./index.ts.
import type { Express } from "express";
import type { IStorage } from "../../storage";
import { isAuthenticated, requireRole } from "../../auth";
import { insertBorrowerDeclarationsSchema, CREDIT_DECISION_ROLES, type User } from "@shared/schema";
import { isAdmin } from "@shared/roles";
import { PREQUAL_ELIGIBLE_STATUSES, effectiveLetterStatus, effectivePreApprovalLetterStatus, letterRevocationSchema, resolveLetterAmount } from "@shared/letters";
import { z } from "zod";
import crypto from "crypto";
import { logAudit } from "../../auditLog";
import * as creditService from "../../services/creditService";
import { sendNotificationEmail } from "../../services/emailService";
import { COMPANY_CONFIG } from "../../config/company";
import { assertVerifiedForDecisioning, type DataProvenance } from "@shared/dataProvenance";
import { unlicensedStateRejection } from "@shared/companyIdentity";
import { routeParams } from "../../http/routeParams";
import { occupancyLetterLabel, parseOccupancyType } from "@shared/occupancy";

const declarationsValidationSchema = insertBorrowerDeclarationsSchema.partial().extend({
  applicationId: z.string().optional(),
});

// Intake validation lives in shared/schema/lending.ts (loanApplicationIntakeSchema),
// derived from the same base schema the funnel validates with client-side — the
// server rejects exactly what the client rejects, and "not_sure" credit maps to
// the named CREDIT_SCORE_UNKNOWN_DEFAULT instead of a silent clamp.

async function isPreApprovalLetterDecisionCurrent(
  applicationId: string,
  letter: { decisionInputFingerprint?: string | null; policyFingerprint?: string | null },
): Promise<boolean> {
  // Legacy letters carry no reproducible input lineage and therefore cannot
  // be asserted as current after this gate ships.
  if (!letter.decisionInputFingerprint || !letter.policyFingerprint) return false;
  const { runInstantDecision } = await import("../../services/decisionEngine");
  const decision = await runInstantDecision(applicationId);
  return decision.status === "DECISION_READY"
    && decision.decision === "APPROVED"
    && decision.qualifier === "VERIFIED"
    && decision.inputsFingerprint === letter.decisionInputFingerprint
    && decision.resolvedPolicy?.fingerprint === letter.policyFingerprint;
}

export function registerLetterRoutes(
  app: Express,
  storage: IStorage,
) {
  app.post("/api/loan-applications/:id/generate-letter", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);

      const application = await storage.getLoanApplicationWithAccess(id, user.id, user.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      if (application.status !== "pre_approved") {
        return res.status(400).json({ error: "Only pre-approved applications can generate letters" });
      }

      const savedPropertyInfo = await storage.getUrlaPropertyInfo(id);
      const occupancyType =
        parseOccupancyType(application.occupancyType) ??
        parseOccupancyType(savedPropertyInfo?.occupancyType);
      const occupancy = occupancyLetterLabel(occupancyType);
      if (!occupancy) {
        return res.status(422).json({
          error: "Property occupancy is required before a pre-approval letter can be issued.",
        });
      }

      // Licensed-state gate (roadmap A5): a letter is an outward creditworthiness
      // document and may not name a property outside the licensed footprint
      // (SAFE Act/Reg H; state law controls — see shared/companyIdentity.ts).
      // Every propertyState write path is gated today; this closes the residual
      // hole for files created before the 2026-07-17 footprint gate. Absent
      // state passes: the TRID address-last funnel may not have the property yet.
      const stateRejection = unlicensedStateRejection(application.propertyState);
      if (stateRejection) {
        return res.status(422).json(stateRejection);
      }

      // A pre-approval letter represents a creditworthiness determination — it may
      // not be issued from self-reported/estimated figures. Require verified data.
      try {
        assertVerifiedForDecisioning(
          application.financialDataProvenance as DataProvenance,
          "generating a pre-approval letter",
        );
      } catch (guardErr) {
        return res.status(422).json({
          error: guardErr instanceof Error ? guardErr.message : "Financial data must be verified",
        });
      }

      // Recompute at issuance. The application status and amount are cached
      // projections and may predate newer URLA facts, evidence, or policy. A
      // current VERIFIED approval is the only state that may create an outward
      // pre-approval letter.
      const { analyzeIntake } = await import("../../services/loanAnalysis");
      const currentAnalysis = await analyzeIntake(id, "preapproval_letter_generation");
      const currentDecision = currentAnalysis.decision;
      if (
        !currentDecision
        || currentDecision.status !== "DECISION_READY"
        || currentDecision.decision !== "APPROVED"
        || currentDecision.qualifier !== "VERIFIED"
        || !currentDecision.resolvedPolicy?.fingerprint
      ) {
        return res.status(422).json({
          error: "The current verified decision does not support a pre-approval letter. Review the latest facts and run underwriting again.",
          code: currentDecision?.decision === "MANUAL_REVIEW" ? "manual_underwrite" : "decision_not_currently_approved",
          reasons: currentDecision?.reasons ?? currentDecision?.missingItems ?? [],
        });
      }
      const decisionProductType = currentDecision.resolvedPolicy.loanType === "VA" ? "VA" : "CONV";

      const { generatePreApprovalPDF, STANDARD_PRE_APPROVAL_CONDITIONS } = await import("../../services/pdfLetterGenerator");

      const letterNumber = `BN-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + 90);

      const resolvedAmount = resolveLetterAmount(
        currentAnalysis.preApprovalAmount,
        application.purchasePrice,
        application.downPayment,
      );
      if (resolvedAmount == null) {
        // An outward creditworthiness document must never assert $0 — the
        // intake cascade persists "0.00" on undecidable files, and the old
        // truthy-string fallback printed exactly that on the letter.
        return res.status(422).json({
          error:
            "A pre-approval amount has not been determined for this application yet — complete the decision before generating a letter.",
        });
      }
      const loanAmount = String(resolvedAmount);
      // Display/DTI inputs for the PDF body — independent of the resolved
      // letter amount above.
      const purchasePrice = parseFloat(application.purchasePrice || "0");
      const downPayment = parseFloat(application.downPayment || "0");

      const conditions = [...STANDARD_PRE_APPROVAL_CONDITIONS];

      const disclaimers = [
        "This pre-approval is not a commitment to lend. Final approval is subject to satisfactory appraisal, title search, and verification of all information provided.",
        "This letter is valid only for the borrower named above and is non-transferable. Terms are subject to change based on market conditions.",
        "The pre-approved amount is based on verified information and the current underwriting evaluation. The actual loan amount may differ upon full underwriting.",
        "This pre-approval does not guarantee any specific interest rate. Rate lock is available separately.",
        "Equal Housing Opportunity. All loans are subject to credit approval.",
      ];

      // The caller can be assigned staff. The letter and its notification must
      // always name and reach the application's borrower, never the LO who
      // clicked Generate in the Command Center.
      const borrower = await storage.getUser(application.userId);
      if (!borrower) {
        return res.status(422).json({ error: "The borrower record is missing; the letter was not issued." });
      }
      const borrowerName = [borrower.firstName, borrower.lastName].filter(Boolean).join(" ") || "Borrower";

      const annualIncome = currentDecision.metrics!.monthlyIncome * 12;
      // A pre-approval amount is the maximum purchase amount supported by the
      // verified analysis, while the application's purchase price can be a
      // smaller current target. A payment calculated from that current target
      // would sit beside the maximum amount and imply the two share a basis.
      // Do not quote an estimated payment on this non-rate-locked artifact;
      // product-specific payment figures remain on the Loan Estimate/options.
      const dti = currentDecision.metrics!.dti;
      const dpPercent = purchasePrice > 0 ? ((downPayment / purchasePrice) * 100).toFixed(1) : undefined;

      const creditScore = application.creditScore ? parseInt(String(application.creditScore)) : 0;
      let creditRange = "";
      if (creditScore >= 760) creditRange = "760+";
      else if (creditScore >= 720) creditRange = "720-759";
      else if (creditScore >= 680) creditRange = "680-719";
      else if (creditScore >= 640) creditRange = "640-679";
      else if (creditScore > 0) creditRange = `${creditScore}`;

      const incomeSources = Array.isArray(application.incomeSources) ? (application.incomeSources as any[]).map(s => ({
        type: s.type || "other",
        annualAmount: String(s.annualAmount || "0"),
        rentalProperties: Array.isArray(s.rentalProperties) ? s.rentalProperties.map((p: any) => ({
          address: p.address || "",
          monthlyRentalIncome: String(p.monthlyRentalIncome || "0"),
          monthlyDebtPayment: String(p.monthlyDebtPayment || "0"),
        })) : undefined,
      })) : undefined;

      const pdfBuffer = await generatePreApprovalPDF({
        letterNumber,
        borrowerName,
        loanAmount,
        productType: decisionProductType,
        occupancy,
        loanPurpose: application.loanPurpose || "Purchase",
        companyLegalName: COMPANY_CONFIG.legalName,
        companyNmlsId: COMPANY_CONFIG.nmlsId,
        companyContactInfo: COMPANY_CONFIG.contactInfo,
        expirationDate,
        generatedAt: new Date(),
        conditions,
        disclaimers,
        watermarkApplied: true,
        purchasePrice: purchasePrice > 0 ? String(purchasePrice) : undefined,
        downPayment: downPayment > 0 ? String(downPayment) : undefined,
        downPaymentPercent: dpPercent,
        annualIncome: annualIncome > 0 ? String(annualIncome) : undefined,
        estimatedDti: dti > 0 ? dti.toFixed(1) : undefined,
        creditScoreRange: creditRange || undefined,
        employmentType: application.employmentType || undefined,
        propertyType: application.propertyType || undefined,
        propertyState: application.propertyState || undefined,
        incomeSources: incomeSources && incomeSources.length > 0 ? incomeSources : undefined,
      });

      const storageKey = `letters/${letterNumber}.pdf`;
      let pdfStored = false;
      try {
        const { objectStorageClient } = await import("../../integrations/object_storage/objectStorage");
        const privateDir = process.env.PRIVATE_OBJECT_DIR || "";
        if (privateDir) {
          const fullPath = `${privateDir}/${storageKey}`;
          const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
          const bucketName = parts[0];
          const objectName = parts.slice(1).join("/");
          const bucket = objectStorageClient.bucket(bucketName);
          const file = bucket.file(objectName);
          await file.save(pdfBuffer, { contentType: "application/pdf" });
          pdfStored = true;
        }
      } catch (storageErr) {
        console.error("[Letter] Object storage upload failed, will regenerate on demand:", storageErr);
      }

      const { db: database } = await import("../../db");
      const { preApprovalLetters, disclaimerVersions, underwritingDecisions } = await import("@shared/schema");
      const { eq, desc, and, ne } = await import("drizzle-orm");

      let snapshotId: string | null = null;
      try {
        const [snapshot] = await database.select().from(underwritingDecisions)
          .where(eq(underwritingDecisions.loanId, id))
          .orderBy(desc(underwritingDecisions.decidedAt))
          .limit(1);
        snapshotId = snapshot?.id || null;
      } catch (snapErr) {
        console.warn("[Letter] Underwriting snapshot lookup failed:", snapErr);
      }

      let disclaimerId: string | null = null;
      try {
        const [disc] = await database.select().from(disclaimerVersions).limit(1);
        disclaimerId = disc?.id || null;
      } catch (discErr) {
        console.warn("[Letter] Disclaimer lookup failed:", discErr);
      }

      if (!disclaimerId) {
        try {
          const [fallbackDisc] = await database.insert(disclaimerVersions).values({
            disclaimerType: "primary",
            version: "1.0",
            text: "This pre-approval is not a commitment to lend. Final approval is subject to a satisfactory appraisal, title search, and verification of all information provided.",
            effectiveFrom: new Date(),
          }).returning();
          disclaimerId = fallbackDisc.id;
        } catch (discErr) {
          console.error("[Letter] Fallback disclaimer creation failed:", discErr);
        }
      }

      let letterId: string | null = null;
      try {
        const insertValues: any = {
          letterNumber,
          borrowerName,
          applicationId: id,
          loanAmount,
          productType: decisionProductType,
          occupancy,
          loanPurpose: application.loanPurpose || "Purchase",
          decisionInputFingerprint: currentDecision.inputsFingerprint,
          policyFingerprint: currentDecision.resolvedPolicy.fingerprint,
          expirationDate,
          companyLegalName: COMPANY_CONFIG.legalName,
          companyNmlsId: COMPANY_CONFIG.nmlsId,
          companyContactInfo: COMPANY_CONFIG.contactInfo,
          // The audit log records the clicking actor. This column records the
          // file's assigned LO, so a processor or underwriter issuing the
          // artifact cannot silently become the officer of record.
          loanOfficerId: application.loanOfficerId ?? (user.role === "lo" ? user.id : undefined),
          pdfStorageKey: pdfStored ? storageKey : undefined,
          pdfGeneratedAt: new Date(),
        };

        if (snapshotId) {
          insertValues.underwritingSnapshotId = snapshotId;
        }
        if (disclaimerId) {
          insertValues.primaryDisclaimerId = disclaimerId;
          insertValues.brokerRoleDisclaimerId = disclaimerId;
          insertValues.documentRelianceDisclaimerId = disclaimerId;
          insertValues.changeInCircumstanceDisclaimerId = disclaimerId;
          insertValues.systemGeneratedDisclaimerId = disclaimerId;
        }

        const [letter] = await database.insert(preApprovalLetters).values(insertValues).returning();
        letterId = letter?.id || null;
      } catch (dbErr) {
        console.error("[Letter] DB insert failed:", dbErr);
      }

      // An outward creditworthiness document with no record is not issued: the
      // stored row is what the download route re-renders from, what audit and
      // revocation would act on. Fail loudly rather than hand out a PDF the
      // system cannot account for.
      if (!letterId) {
        return res.status(500).json({ error: "Letter could not be recorded and was not issued. Please try again." });
      }

      // Supersede-on-reissue: an application has one current pre-approval
      // letter. Prior issued letters flip to "superseded" (supersededBy = the
      // superseding letter's id) so a re-decision never leaves stale letters
      // reading "issued". Failure here is logged, not fatal — the new letter
      // is already recorded, and the next reissue re-covers the same rows.
      try {
        const superseded = await database.update(preApprovalLetters)
          .set({ status: "superseded", supersededAt: new Date(), supersededBy: letterId })
          .where(and(
            eq(preApprovalLetters.applicationId, id),
            ne(preApprovalLetters.id, letterId),
            eq(preApprovalLetters.status, "issued"),
          ))
          .returning({ id: preApprovalLetters.id });
        if (superseded.length > 0) {
          logAudit(req, "pre_approval_letter.superseded", "pre_approval_letter", letterId, {
            supersededLetterIds: superseded.map((s) => s.id),
          });
        }
      } catch (supersedeErr) {
        console.error("[Letter] Supersede-on-reissue failed:", supersedeErr);
      }

      await storage.createNotification({
        userId: borrower.id,
        type: "pre_approval_letter_ready",
        title: "Pre-Approval Letter Ready",
        body: `Your pre-approval letter #${letterNumber} is ready for download.`,
        entityType: "pre_approval_letter",
        entityId: letterId || id,
        status: "unread",
      });

      if (borrower.email) {
        sendNotificationEmail({
          type: "pre_approval_letter_ready",
          recipientEmail: borrower.email,
          data: {
            borrowerName,
            amount: (parseFloat(loanAmount) || 0).toLocaleString(),
            letterNumber,
          },
        });
      }

      logAudit(req, "pre_approval_letter.generated", "pre_approval_letter", letterId || letterNumber);

      res.json({
        letterNumber,
        letterId,
        loanAmount,
        expirationDate,
        pdfAvailable: true,
        pdfStored,
      });
    } catch (error) {
      console.error("Generate letter error:", error);
      res.status(500).json({ error: "Failed to generate pre-approval letter" });
    }
  });

  app.get("/api/loan-applications/:id/letter-pdf", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);

      const application = await storage.getLoanApplicationWithAccess(id, user.id, user.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const { db: database } = await import("../../db");
      const { preApprovalLetters } = await import("@shared/schema");
      const { eq, desc } = await import("drizzle-orm");

      const [letter] = await database.select().from(preApprovalLetters)
        .where(eq(preApprovalLetters.applicationId, id))
        .orderBy(desc(preApprovalLetters.createdAt))
        .limit(1);

      // This route renders an already-issued record; it carries none of the
      // issuance gates (status, provenance, licensed state). Without a stored
      // letter there is nothing issued to render — generating here would mint
      // an ungated letter.
      if (!letter) {
        return res.status(404).json({ error: "No pre-approval letter found" });
      }

      // A revoked letter must not keep circulating silently — surface the
      // revocation instead of serving the PDF. Expired letters still download:
      // the document shows its expiration date on its face, and letter-status
      // reads "expired" so the UI can prompt a reissue.
      if (letter.status === "revoked") {
        return res.status(409).json({
          error: "This pre-approval letter has been revoked and is no longer valid.",
          code: "letter_revoked",
          letterNumber: letter.letterNumber,
          revokedAt: letter.revokedAt,
        });
      }

      if (
        letter.status === "issued"
        && !(await isPreApprovalLetterDecisionCurrent(id, letter))
      ) {
        return res.status(409).json({
          error: "Financial facts or underwriting policy changed after this letter was issued. Re-run the decision and issue a new letter.",
          code: "letter_stale",
          letterNumber: letter.letterNumber,
        });
      }

      if (letter.pdfStorageKey) {
        try {
          const { objectStorageClient } = await import("../../integrations/object_storage/objectStorage");
          const privateDir = process.env.PRIVATE_OBJECT_DIR || "";
          const fullPath = `${privateDir}/${letter.pdfStorageKey}`;
          const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
          const bucketName = parts[0];
          const objectName = parts.slice(1).join("/");
          const bucket = objectStorageClient.bucket(bucketName);
          const file = bucket.file(objectName);
          const [exists] = await file.exists();
          if (exists) {
            const [contents] = await file.download();
            logAudit(req, "pre_approval_letter.downloaded", "pre_approval_letter", letter.id);
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `attachment; filename="${letter.letterNumber}.pdf"`);
            return res.send(contents);
          }
        } catch (storageErr) {
          console.error("[Letter] Storage download failed, regenerating:", storageErr);
        }
      }

      // Regeneration fallback: render strictly from the stored letter row
      // (same pattern as prequal-pdf below). Never from current application
      // data or today's rate — that would put different figures under the
      // original letter number and issuance date.
      const { generatePreApprovalPDF, letterDataFromStoredRow } = await import("../../services/pdfLetterGenerator");
      const pdfBuffer = await generatePreApprovalPDF(letterDataFromStoredRow(letter));

      logAudit(req, "pre_approval_letter.downloaded", "pre_approval_letter", letter.id);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${letter.letterNumber}.pdf"`);
      res.send(pdfBuffer);
    } catch (error) {
      console.error("Download letter PDF error:", error);
      res.status(500).json({ error: "Failed to download pre-approval letter" });
    }
  });

  app.get("/api/loan-applications/:id/letter-status", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);

      const application = await storage.getLoanApplicationWithAccess(id, user.id, user.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const { db: database } = await import("../../db");
      const { preApprovalLetters } = await import("@shared/schema");
      const { eq, desc } = await import("drizzle-orm");

      const [letter] = await database.select().from(preApprovalLetters)
        .where(eq(preApprovalLetters.applicationId, id))
        .orderBy(desc(preApprovalLetters.createdAt))
        .limit(1);

      if (!letter) {
        return res.json({ hasLetter: false });
      }

      // Computed-at-read expiry: never report "issued" past the expiration
      // date, whatever the sweep's timing. The revocation reason stays
      // server-side — staff free text does not reach borrower-facing responses.
      const effectiveStatus = effectiveLetterStatus(letter);
      const decisionCurrent = effectiveStatus === "issued"
        ? await isPreApprovalLetterDecisionCurrent(id, letter)
        : true;
      res.json({
        hasLetter: true,
        letterId: letter.id,
        letterNumber: letter.letterNumber,
        status: effectivePreApprovalLetterStatus(letter, decisionCurrent),
        expirationDate: letter.expirationDate,
        generatedAt: letter.generatedAt,
        revokedAt: letter.revokedAt,
        pdfAvailable: !!(letter.pdfStorageKey || letter.pdfGeneratedAt),
      });
    } catch (error) {
      console.error("Letter status error:", error);
      res.status(500).json({ error: "Failed to check letter status" });
    }
  });

  // Staff revocation — the deal-team boundary and role class of the status
  // machine (statusDecisions.ts): revoking an outward creditworthiness
  // document withdraws an approval outcome, so only CREDIT_DECISION_ROLES may
  // do it, and non-admins must be on the deal team. The reason is required —
  // an unaccountable revocation is as bad as an unaccountable issuance.
  // Validation uses the SHARED letterRevocationSchema so the staff dialog's
  // confirm gate and this 400 can never drift.
  app.post("/api/pre-approval-letters/:letterId/revoke", requireRole(...CREDIT_DECISION_ROLES), async (req, res) => {
    try {
      const user = req.user as User;
      const { letterId } = routeParams(req);

      const parsed = letterRevocationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten().fieldErrors });
      }

      const { db: database } = await import("../../db");
      const { preApprovalLetters, letterGenerationLogs } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const [letter] = await database.select().from(preApprovalLetters)
        .where(eq(preApprovalLetters.id, letterId))
        .limit(1);
      if (!letter) {
        return res.status(404).json({ error: "Letter not found" });
      }

      if (!isAdmin(user)) {
        const teamMembers = await storage.getDealTeamMembers(letter.applicationId);
        if (!teamMembers.some((m) => m.userId === user.id)) {
          return res.status(403).json({ error: "You are not assigned to this application" });
        }
      }

      // Atomic issued-only transition — the guard compares in SQL so two
      // concurrent revocations (or a racing supersede) cannot both win.
      // Issued-but-past-expiration rows remain revocable: an explicit
      // revocation record on a lapsed letter is strictly more information.
      const [revoked] = await database.update(preApprovalLetters)
        .set({
          status: "revoked",
          revokedAt: new Date(),
          revokedBy: user.id,
          revocationReason: parsed.data.reason,
        })
        .where(and(
          eq(preApprovalLetters.id, letterId),
          eq(preApprovalLetters.status, "issued"),
        ))
        .returning();

      if (!revoked) {
        const [current] = await database.select({ status: preApprovalLetters.status })
          .from(preApprovalLetters)
          .where(eq(preApprovalLetters.id, letterId))
          .limit(1);
        return res.status(409).json({
          error: `Only issued letters can be revoked; this letter is ${current?.status ?? "unknown"}.`,
          code: "not_revocable",
          status: current?.status,
        });
      }

      // Ledger row — non-fatal: the status flip is the guarantee, the ledger
      // is the narrative.
      try {
        await database.insert(letterGenerationLogs).values({
          applicationId: revoked.applicationId,
          letterId: revoked.id,
          eventType: "letter_revoked",
          eventDetails: { reason: parsed.data.reason },
          triggeredBy: user.id,
          triggeredBySystem: false,
        });
      } catch (ledgerErr) {
        console.error("[Letter] Revocation ledger write failed:", ledgerErr);
      }

      // The borrower may be shopping with this letter — tell them it is no
      // longer valid. The reason stays in the audit trail and ledger only.
      const application = await storage.getLoanApplication(revoked.applicationId);
      if (application) {
        await storage.createNotification({
          userId: application.userId,
          type: "pre_approval_letter_revoked",
          title: "Pre-Approval Letter Revoked",
          body: `Your pre-approval letter #${revoked.letterNumber} has been revoked and is no longer valid. Contact your loan team with any questions.`,
          entityType: "pre_approval_letter",
          entityId: revoked.id,
          status: "unread",
        });
      }

      logAudit(req, "pre_approval_letter.revoked", "pre_approval_letter", revoked.id, {
        applicationId: revoked.applicationId,
        letterNumber: revoked.letterNumber,
        reason: parsed.data.reason,
      });

      res.json({
        ok: true,
        letterId: revoked.id,
        letterNumber: revoked.letterNumber,
        status: "revoked",
        revokedAt: revoked.revokedAt,
      });
    } catch (error) {
      console.error("Revoke letter error:", error);
      res.status(500).json({ error: "Failed to revoke pre-approval letter" });
    }
  });

  app.post("/api/loan-applications/:id/generate-prequal", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);

      const application = await storage.getLoanApplicationWithAccess(id, user.id, user.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      if (!(PREQUAL_ELIGIBLE_STATUSES as readonly string[]).includes(application.status)) {
        return res.status(400).json({ error: "Application must be submitted before generating a pre-qualification letter" });
      }
      const savedPropertyInfo = await storage.getUrlaPropertyInfo(id);
      const occupancyType =
        parseOccupancyType(application.occupancyType) ??
        parseOccupancyType(savedPropertyInfo?.occupancyType);
      const occupancy = occupancyLetterLabel(occupancyType);
      if (!occupancy) {
        return res.status(422).json({
          error: "Property occupancy is required before a pre-qualification letter can be issued.",
        });
      }

      // Licensed-state gate — same boundary as generate-letter above (prequal is
      // wider: submitted-status only, no provenance guard, so the gate matters more).
      const stateRejection = unlicensedStateRejection(application.propertyState);
      if (stateRejection) {
        return res.status(422).json(stateRejection);
      }

      const { generatePreQualificationPDF } = await import("../../services/pdfLetterGenerator");
      const crypto = await import("crypto");

      const letterNumber = `PQ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + 60);

      const borrowerName = user.firstName && user.lastName
        ? `${user.firstName} ${user.lastName}`
        : (user.email?.split("@")[0] || "Borrower");

      const loanAmount = application.preApprovalAmount || application.purchasePrice || "0";
      const downPayment = application.downPayment ? parseFloat(application.downPayment) : 0;
      const purchasePrice = application.purchasePrice ? parseFloat(application.purchasePrice) : 0;
      const estimatedAmount = purchasePrice > 0 ? (purchasePrice - downPayment).toString() : loanAmount.toString();

      let creditScoreRange = "Not provided";
      if (application.creditScore) {
        const cs = application.creditScore;
        if (cs >= 760) creditScoreRange = "760+";
        else if (cs >= 720) creditScoreRange = "720-759";
        else if (cs >= 680) creditScoreRange = "680-719";
        else if (cs >= 640) creditScoreRange = "640-679";
        else creditScoreRange = "Below 640";
      }

      let downPaymentPercent: string | undefined;
      if (downPayment > 0 && purchasePrice > 0) {
        downPaymentPercent = ((downPayment / purchasePrice) * 100).toFixed(1);
      }

      const pdfBuffer = await generatePreQualificationPDF({
        letterNumber,
        borrowerName,
        estimatedAmount,
        productType: application.preferredLoanType || "conventional",
        occupancy,
        loanPurpose: application.loanPurpose || "Purchase",
        annualIncome: application.annualIncome?.toString(),
        creditScoreRange,
        employmentType: application.employmentType || undefined,
        estimatedDti: application.dtiRatio?.toString(),
        downPaymentPercent,
        companyLegalName: COMPANY_CONFIG.legalName,
        companyNmlsId: COMPANY_CONFIG.nmlsId,
        expirationDate,
        generatedAt: new Date(),
      });

      const { db: database } = await import("../../db");
      const { preQualificationLetters } = await import("@shared/schema");

      const storageKey = `prequal-letters/${letterNumber}.pdf`;
      let pdfStorageKey: string | null = null;
      try {
        const { objectStorageClient } = await import("../../integrations/object_storage/objectStorage");
        const privateDir = process.env.PRIVATE_OBJECT_DIR || "";
        if (privateDir) {
          const fullPath = `${privateDir}/${storageKey}`;
          const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
          const bucketName = parts[0];
          const objectName = parts.slice(1).join("/");
          const bucket = objectStorageClient.bucket(bucketName);
          const file = bucket.file(objectName);
          await file.save(pdfBuffer, { contentType: "application/pdf" });
          pdfStorageKey = storageKey;
        }
      } catch (storageErr) {
        console.warn("[PreQual] Could not store PDF in object storage:", storageErr);
      }

      const [letter] = await database.insert(preQualificationLetters).values({
        letterNumber,
        borrowerName,
        applicationId: id,
        estimatedAmount,
        productType: application.preferredLoanType || "conventional",
        occupancy,
        loanPurpose: application.loanPurpose || "Purchase",
        annualIncome: application.annualIncome?.toString(),
        creditScoreRange,
        employmentType: application.employmentType,
        estimatedDti: application.dtiRatio?.toString(),
        downPaymentPercent,
        expirationDate,
        status: "issued",
        companyLegalName: COMPANY_CONFIG.legalName,
        companyNmlsId: COMPANY_CONFIG.nmlsId,
        pdfStorageKey,
        pdfGeneratedAt: new Date(),
      }).returning();

      res.json({
        letterNumber: letter.letterNumber,
        expirationDate: letter.expirationDate,
        estimatedAmount: letter.estimatedAmount,
        pdfAvailable: true,
      });
    } catch (error) {
      console.error("Generate prequal letter error:", error);
      res.status(500).json({ error: "Failed to generate pre-qualification letter" });
    }
  });

  app.get("/api/loan-applications/:id/prequal-pdf", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);

      const application = await storage.getLoanApplicationWithAccess(id, user.id, user.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const { db: database } = await import("../../db");
      const { preQualificationLetters } = await import("@shared/schema");
      const { eq, desc } = await import("drizzle-orm");

      const [letter] = await database.select().from(preQualificationLetters)
        .where(eq(preQualificationLetters.applicationId, id))
        .orderBy(desc(preQualificationLetters.createdAt))
        .limit(1);

      if (!letter) {
        return res.status(404).json({ error: "No pre-qualification letter found" });
      }

      if (letter.pdfStorageKey) {
        try {
          const { objectStorageClient } = await import("../../integrations/object_storage/objectStorage");
          const privateDir = process.env.PRIVATE_OBJECT_DIR || "";
          const fullPath = `${privateDir}/${letter.pdfStorageKey}`;
          const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
          const bucketName = parts[0];
          const objectName = parts.slice(1).join("/");
          const bucket = objectStorageClient.bucket(bucketName);
          const file = bucket.file(objectName);
          const [exists] = await file.exists();
          if (exists) {
            const [contents] = await file.download();
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", `inline; filename="PreQualification-${letter.letterNumber}.pdf"`);
            return res.send(contents);
          }
        } catch (downloadErr) {
          console.warn("[PreQual] Could not download from storage, regenerating:", downloadErr);
        }
      }

      const { generatePreQualificationPDF } = await import("../../services/pdfLetterGenerator");
      const borrowerName = letter.borrowerName;

      const pdfBuffer = await generatePreQualificationPDF({
        letterNumber: letter.letterNumber,
        borrowerName,
        estimatedAmount: letter.estimatedAmount,
        productType: letter.productType,
        occupancy: letter.occupancy,
        loanPurpose: letter.loanPurpose || undefined,
        annualIncome: letter.annualIncome?.toString(),
        creditScoreRange: letter.creditScoreRange || undefined,
        employmentType: letter.employmentType || undefined,
        estimatedDti: letter.estimatedDti?.toString(),
        downPaymentPercent: letter.downPaymentPercent?.toString(),
        companyLegalName: letter.companyLegalName,
        companyNmlsId: letter.companyNmlsId,
        expirationDate: new Date(letter.expirationDate),
        generatedAt: new Date(letter.generatedAt || letter.createdAt!),
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="PreQualification-${letter.letterNumber}.pdf"`);
      res.send(pdfBuffer);
    } catch (error) {
      console.error("PreQual PDF error:", error);
      res.status(500).json({ error: "Failed to retrieve pre-qualification letter" });
    }
  });

  app.get("/api/loan-applications/:id/prequal-status", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const { id } = routeParams(req);

      const application = await storage.getLoanApplicationWithAccess(id, user.id, user.role);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      const { db: database } = await import("../../db");
      const { preQualificationLetters } = await import("@shared/schema");
      const { eq, desc } = await import("drizzle-orm");

      const [letter] = await database.select().from(preQualificationLetters)
        .where(eq(preQualificationLetters.applicationId, id))
        .orderBy(desc(preQualificationLetters.createdAt))
        .limit(1);

      if (!letter) {
        return res.json({ hasLetter: false });
      }

      // Computed-at-read expiry, same as letter-status above.
      res.json({
        hasLetter: true,
        letterNumber: letter.letterNumber,
        status: effectiveLetterStatus(letter),
        expirationDate: letter.expirationDate,
        estimatedAmount: letter.estimatedAmount,
        generatedAt: letter.generatedAt,
        pdfAvailable: !!(letter.pdfStorageKey || letter.pdfGeneratedAt),
      });
    } catch (error) {
      console.error("PreQual status error:", error);
      res.status(500).json({ error: "Failed to check pre-qualification status" });
    }
  });
}
