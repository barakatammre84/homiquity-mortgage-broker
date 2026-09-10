import type { Express } from "express";
import { isAdmin } from "@shared/roles";
import type { IStorage } from "../storage";
import { requireRole } from "../auth";
import { buildStaffSignals } from "../services/signalEngine";
import { getLatestIncomePathEvaluation } from "../services/scenarioSimulator";
import { getUserActivitySummary } from "../services/activitySummary";
import { verifyInternalStaffApplicationAccess } from "./borrower";
import {
  LOAN_APP_TERMINAL_STATUSES,
  SETTLED_CONDITION_STATUSES,
  type User,
  type DealTeamMember,
  type LoanApplication,
} from "@shared/schema";
import { routeParam } from "../http/routeParams";
import { getCurrentDecisionGrade } from "../services/currentDecisionGrade";

/**
 * LO Command Center cockpit routes (LO Advisor Program prompt LO-1).
 *
 * Two internal-staff, deal-team-scoped reads that turn the pipeline list into
 * an advisory cockpit without navigating away from a file:
 *   - GET /api/staff/signals — THE prioritized "who needs attention" feed
 *     (signalEngine), scoped to the caller's book (admins see all). This is the
 *     only route permitted to serve it: an unscoped twin at GET
 *     /api/signals/staff was removed after it was found serving
 *     borrower-identifying signals across deal teams. tests/cockpitScoping.test.ts
 *     fails the build if a second or unscoped caller reappears.
 *   - GET /api/staff/applications/:id/cockpit — the active-borrower panel + call
 *     prep, composed in ONE access-checked read: operational summary, latest UAL
 *     income evaluation, conditions, document checklist, recent messages, and
 *     the borrower's activity digest.
 *
 * PII discipline (I4): this surface returns OPERATIONAL data only — status,
 * derived income figures, conditions, document status, message snippets. No
 * SSN/DOB/account numbers; full PII stays behind the deep-linked BorrowerFile's
 * existing audited reveal path.
 */

const OPEN_CONDITION_CLOSED_STATUSES: ReadonlySet<string> = new Set(SETTLED_CONDITION_STATUSES);
const RECENT_MESSAGE_LIMIT = 6;
const MESSAGE_SNIPPET_CHARS = 140;

/**
 * Statuses excluded from the "active" cockpit book: nothing submitted yet
 * (draft) or the file has ended (every terminal status). "suspended" stays in
 * the book on purpose — a paused file still belongs to its deal team. The
 * signals feed applies its own tighter gate (SIGNAL_ACTIVE_STATUSES) on top.
 */
const INACTIVE_STATUSES: ReadonlySet<string> = new Set(["draft", ...LOAN_APP_TERMINAL_STATUSES]);

/**
 * Deduplicated ids of the ACTIVE applications a staffer is on the deal team for.
 * Pure over the membership rows so it can be unit-tested without a database.
 */
export function filterAccessibleActiveApplicationIds(
  memberships: (DealTeamMember & { application?: LoanApplication })[],
): string[] {
  const ids = new Set<string>();
  for (const m of memberships) {
    if (m.application && !INACTIVE_STATUSES.has(m.application.status ?? "draft")) {
      ids.add(m.application.id);
    }
  }
  return [...ids];
}

/** Accessible active application ids for a staffer (admins: all active). */
async function accessibleActiveApplicationIds(storage: IStorage, user: User): Promise<string[] | "all"> {
  if (isAdmin(user)) return "all";
  const memberships = await storage.getTeamMembersByUser(user.id);
  return filterAccessibleActiveApplicationIds(memberships);
}

export function registerCockpitRoutes(app: Express, storage: IStorage) {
  // -------------------------------------------------------------------------
  // Left rail — the prioritized attention feed, scoped to the caller's book.
  // -------------------------------------------------------------------------
  app.get(
    "/api/staff/signals",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const user = req.user as User;
        const scopeIds = await accessibleActiveApplicationIds(storage, user);
        const signals =
          scopeIds === "all"
            ? await buildStaffSignals(40)
            : await buildStaffSignals(40, { applicationIds: scopeIds });
        res.json({ signals });
      } catch (error) {
        console.error("Get staff signals error:", error);
        res.status(500).json({ error: "Failed to load signals" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // LO-M17: pre-filled document-request draft from the file's outstanding
  // conditions. READ-ONLY — this drafts; sending stays a human decision
  // through POST /api/messages (document_request), whose staff gate and
  // borrower notification path are unchanged. Same role + assignment scope
  // as the cockpit read below.
  // -------------------------------------------------------------------------
  app.get(
    "/api/staff/applications/:id/doc-request-draft",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const user = req.user as User;
        const applicationId = routeParam(req, "id");

        const allowed = await verifyInternalStaffApplicationAccess(storage, applicationId, user.id, user.role);
        if (!allowed) {
          return res.status(403).json({ error: "Access denied to this application" });
        }

        const application = await storage.getLoanApplication(applicationId);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }

        const [conditions, documents, openRequests] = await Promise.all([
          storage.getLoanConditionsByApplication(applicationId),
          storage.getDocumentsByApplication(applicationId),
          storage.getOpenDocumentRequestsForApplication(applicationId, application.userId),
        ]);

        const { buildDocRequestDraft } = await import("../services/docRequestDraft");
        const items = buildDocRequestDraft(
          conditions.map((c) => ({
            id: c.id,
            status: c.status,
            title: c.title,
            requiredDocumentTypes: c.requiredDocumentTypes ?? null,
          })),
          documents.map((d) => ({ documentType: d.documentType, status: d.status })),
          openRequests.map((message) =>
            String(
              (message.documentRequestData as { documentType?: string } | null)
                ?.documentType ?? "",
            ),
          ),
        );

        res.json({
          applicationId,
          recipientId: application.userId,
          items,
        });
      } catch (error) {
        console.error("Doc-request draft error:", error);
        res.status(500).json({ error: "Failed to build the document-request draft" });
      }
    },
  );

  // -------------------------------------------------------------------------
  // Center pane + call prep — one deal-team-scoped read for the active file.
  // -------------------------------------------------------------------------
  app.get(
    "/api/staff/applications/:id/cockpit",
    requireRole("admin", "lo", "loa", "processor", "underwriter", "closer"),
    async (req, res) => {
      try {
        const user = req.user as User;
        const applicationId = routeParam(req, "id");

        // Assignment-scoped: the same gate the rate-lock desk and simulator use.
        const allowed = await verifyInternalStaffApplicationAccess(storage, applicationId, user.id, user.role);
        if (!allowed) {
          return res.status(403).json({ error: "Access denied to this application" });
        }

        const application = await storage.getLoanApplication(applicationId);
        if (!application) {
          return res.status(404).json({ error: "Application not found" });
        }

        const [borrower, incomeRow, conditions, documents, messages, activity, currentGrade] = await Promise.all([
          storage.getUser(application.userId),
          getLatestIncomePathEvaluation(applicationId),
          storage.getLoanConditionsByApplication(applicationId),
          storage.getDocumentsByApplication(applicationId),
          storage.getMessages(user.id, application.userId),
          getUserActivitySummary(application.userId),
          getCurrentDecisionGrade(application),
        ]);

        const borrowerName =
          [borrower?.firstName, borrower?.lastName].filter(Boolean).join(" ") ||
          borrower?.email ||
          "Borrower";

        const openConditions = conditions.filter(
          (c) => !OPEN_CONDITION_CLOSED_STATUSES.has(c.status),
        );

        // Recent thread with THIS staffer (newest first, trimmed to snippets).
        const recentMessages = [...messages]
          .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
          .slice(0, RECENT_MESSAGE_LIMIT)
          .map((m) => ({
            id: m.id,
            fromBorrower: m.senderId === application.userId,
            snippet: (m.message ?? "").slice(0, MESSAGE_SNIPPET_CHARS),
            createdAt: m.createdAt,
          }));
        const unreadFromBorrower = messages.filter(
          (m) => m.senderId === application.userId && !m.isRead,
        ).length;

        // Document checklist: uploaded/verified rollup by document type (status
        // only — the file bytes and any extracted PII stay in the vault).
        const docByType = new Map<string, { status: string; fileName: string; createdAt: Date | null }>();
        for (const d of documents) {
          const key = d.documentType ?? "other";
          const existing = docByType.get(key);
          if (!existing || (d.createdAt && existing.createdAt && d.createdAt > existing.createdAt)) {
            docByType.set(key, {
              status: d.status ?? "uploaded",
              fileName: d.fileName ?? "",
              createdAt: d.createdAt ?? null,
            });
          }
        }
        const documentSummary = {
          uploadedCount: documents.length,
          verifiedCount: documents.filter((d) => d.status === "verified").length,
          byType: [...docByType.entries()].map(([type, v]) => ({
            type,
            status: v.status,
            fileName: v.fileName,
          })),
        };

        res.json({
          application: {
            id: application.id,
            borrowerUserId: application.userId,
            borrowerName,
            status: application.status,
            loanPurpose: application.loanPurpose,
            purchasePrice: application.purchasePrice,
            downPayment: application.downPayment,
            propertyState: application.propertyState,
            propertyType: application.propertyType,
            financialDataProvenance: application.financialDataProvenance,
            currentDecisionGrade: currentGrade.isDecisionGrade,
            decisionGradeBlockers: currentGrade.reasons,
            isVeteran: application.isVeteran ?? false,
            closingDate: application.closingDate ?? null,
            createdAt: application.createdAt,
          },
          income: incomeRow
            ? {
                evaluationId: incomeRow.id,
                primaryMonthlyQualifyingIncome: Number(incomeRow.primaryMonthlyQualifyingIncome),
                incomeBasis: incomeRow.incomeBasis,
                recommendedPathId: incomeRow.recommendedPathId,
                requiresManualReview: incomeRow.requiresManualReview,
                evaluatedAt: incomeRow.createdAt,
                paths: incomeRow.paths,
              }
            : null,
          conditions: {
            total: conditions.length,
            open: openConditions.length,
            items: openConditions.slice(0, 12).map((c) => ({
              id: c.id,
              title: c.title,
              category: c.category,
              status: c.status,
              priority: c.priority,
            })),
          },
          documents: documentSummary,
          messages: {
            unreadFromBorrower,
            recent: recentMessages,
          },
          activity,
        });
      } catch (error) {
        console.error("Get application cockpit error:", error);
        res.status(500).json({ error: "Failed to load the cockpit view" });
      }
    },
  );
}
