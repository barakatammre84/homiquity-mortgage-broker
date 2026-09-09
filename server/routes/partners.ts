import type { Express } from "express";
import type { IStorage } from "../storage";
import { isAuthenticated, requireRole, hashPassword } from "../auth";
import { authStorage } from "../integrations/auth/storage";
import { logAudit } from "../auditLog";
import { sendEmail, emailTemplates } from "../services/emailService";
import { z } from "zod";
import crypto from "crypto";
import type { User, PartnerProfile } from "@shared/schema";
import {
  LICENSE_VERIFICATION_STATUSES,
  PARTNER_PROFILE_STATUSES,
} from "@shared/schema";
import { routeParam } from "../http/routeParams";
import { clientIpForRecord } from "../clientIp";

/**
 * PartnerHub identity spine (PH-1 — knowledge-base/specs/PARTNER_HUB_PROGRAM.md).
 *
 * The realtor lane of the unified partner spine. Doctrine (charter §5, binding):
 * a partner is an INVITER ONLY — no endpoint here returns borrower financial
 * data, documents, or contact details; referral views are the same stage-level
 * projection the CPA portal uses. No compensation is tracked anywhere (RESPA §8).
 * The partner's referral slug is written to users.referral_code on the same
 * account, so the existing consumer attribution rail (/p/:slug landing stashes
 * the code → /api/apply-referral sets users.referred_by_user_id) works unchanged.
 *
 * `realtor` is a self-registering PARTNER_ROLE (shared/roles.ts) — never a
 * STAFF_ROLE; everything below gates by exact role. License identifiers enter a
 * manual admin review queue: no public real-time license-lookup API exists and
 * we never render "verified" from a lookup we didn't perform (§5-C10).
 */

/** Public projection of a partner — safe to hand back to the partner themselves. */
function ownPartnerProfile(profile: PartnerProfile, baseUrl: string) {
  return {
    id: profile.id,
    persona: profile.persona,
    firmName: profile.firmName,
    contactName: profile.contactName,
    email: profile.email,
    licenseNumber: profile.licenseNumber,
    licenseState: profile.licenseState,
    licenseVerificationStatus: profile.licenseVerificationStatus,
    referralSlug: profile.referralSlug,
    referralLink: `${baseUrl}/p/${profile.referralSlug}`,
    status: profile.status,
    createdAt: profile.createdAt,
  };
}

function baseUrlOf(req: { get: (h: string) => string | undefined }): string {
  return process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
}

/**
 * Server-generated, sanitized slug: NAME-1234. Never client-supplied. Kept
 * ≤19 chars so the identical value fits users.referral_code (varchar(20)).
 */
export function makePartnerSlug(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 14) || "PARTNER";
  const suffix = crypto.randomInt(1000, 10000);
  return `${base}-${suffix}`;
}

/** Drizzle wraps node-postgres errors in DrizzleQueryError. */
export function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (candidate.code === "23505") return true;
  return Boolean(
    candidate.cause &&
    typeof candidate.cause === "object" &&
    (candidate.cause as { code?: unknown }).code === "23505",
  );
}

// Waitlist partner_type → join-page persona preselect.
const WAITLIST_PERSONA: Record<string, string> = {
  real_estate_agent: "realtor",
  cpa: "cpa",
};

export function registerPartnerRoutes(app: Express, storage: IStorage) {
  // ---- Public: realtor self-serve onboarding (B2B, pre-F1-safe) --------------
  app.post("/api/partners/register", async (req, res) => {
    try {
      const schema = z.object({
        // v1 accepts the realtor persona only; the CPA lane keeps its existing
        // endpoint (/api/cpa-partners/register) until the convergence prompt.
        persona: z.literal("realtor"),
        contactName: z.string().trim().min(1).max(255),
        firmName: z.string().trim().min(1).max(255),
        email: z.string().trim().email().max(255),
        password: z.string().min(8).max(200),
        licenseNumber: z.string().trim().max(60).optional(),
        licenseState: z.string().trim().length(2).toUpperCase().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.format() });
      }
      const { persona, contactName, firmName, email: rawEmail, password, licenseNumber, licenseState } = parsed.data;
      const email = rawEmail.toLowerCase();

      if (await authStorage.getUserByEmail(email)) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }

      const passwordHash = await hashPassword(password);
      const [firstName, ...rest] = contactName.split(/\s+/);
      let user: User;
      try {
        user = await authStorage.createUserWithPassword({
          email,
          passwordHash,
          firstName,
          lastName: rest.join(" ") || null,
          role: persona,
        });
      } catch (dbError: unknown) {
        if (isUniqueConstraintError(dbError)) {
          return res.status(409).json({ error: "An account with this email already exists" });
        }
        throw dbError;
      }

      // Claim the slug on users.referral_code FIRST (its unique index is the
      // gate — every partner slug is also a users code, so winning here means
      // the partner_profiles insert below cannot collide). Retry on the rare clash.
      let slug: string | undefined;
      for (let attempt = 0; attempt < 5 && !slug; attempt++) {
        const candidate = makePartnerSlug(contactName);
        try {
          await storage.setUserPartnerIdentity(user.id, {
            referralCode: candidate,
            partnerCompanyName: firmName,
          });
          slug = candidate;
        } catch (dbError: unknown) {
          if (isUniqueConstraintError(dbError) && attempt < 4) continue; // slug collision → retry
          throw dbError;
        }
      }
      if (!slug) {
        return res.status(500).json({ error: "Could not allocate a referral link, please retry" });
      }

      const profile = await storage.createPartnerProfile({
        userId: user.id,
        persona,
        firmName,
        contactName,
        email,
        licenseNumber: licenseNumber || null,
        licenseState: licenseState || null,
        referralSlug: slug,
        status: "active",
        source: "self_service",
      });

      logAudit(req, "partner.registered", "partner_profile", profile.id, { persona, firmName });

      req.login(
        {
          id: user.id,
          email: user.email || undefined,
          firstName: user.firstName || undefined,
          lastName: user.lastName || undefined,
          profileImageUrl: user.profileImageUrl || undefined,
          role: user.role,
        },
        (err: unknown) => {
          if (err) {
            return res.status(500).json({ error: "Registration succeeded but login failed" });
          }
          res.status(201).json({ partner: ownPartnerProfile(profile, baseUrlOf(req)) });
        },
      );
    } catch (error) {
      console.error("Partner register error:", error);
      res.status(500).json({ error: "Failed to register partner" });
    }
  });

  // ---- Public: co-brand branding for the /p/:slug landing ---------------------
  app.get("/api/p/:slug", async (req, res) => {
    try {
      const profile = await storage.getPartnerProfileBySlug(routeParam(req, "slug"));
      if (!profile || profile.status !== "active") {
        return res.status(404).json({ error: "Invalid or inactive referral link" });
      }
      // Branding only — no email, no license identifiers, no referral data.
      res.json({
        valid: true,
        persona: profile.persona,
        displayName: profile.contactName || profile.firmName,
        firmName: profile.firmName,
        referralSlug: profile.referralSlug,
      });
    } catch (error) {
      console.error("Partner slug lookup error:", error);
      res.status(500).json({ error: "Failed to validate referral link" });
    }
  });

  // ---- Authed partner: own profile + stage-only referral visibility ----------
  app.get("/api/partners/me", requireRole("realtor", "admin"), async (req, res) => {
    try {
      const user = req.user as User;
      const profile = await storage.getPartnerProfileByUserId(user.id);
      if (!profile) {
        return res.status(404).json({ error: "No partner profile for this account" });
      }
      res.json({ partner: ownPartnerProfile(profile, baseUrlOf(req)) });
    } catch (error) {
      console.error("Partner me error:", error);
      res.status(500).json({ error: "Failed to load partner profile" });
    }
  });

  app.get("/api/partners/me/referrals", requireRole("realtor", "admin"), async (req, res) => {
    try {
      const user = req.user as User;
      const profile = await storage.getPartnerProfileByUserId(user.id);
      if (!profile) {
        return res.status(404).json({ error: "No partner profile for this account" });
      }
      // A suspended partner's slug already 404s and their consent write path is
      // blocked; close the read side too so suspension fully takes effect
      // (mirrors the /api/p/:slug and consent-write active-status checks).
      if (profile.status !== "active") {
        return res.status(403).json({ error: "Your partner account is not active" });
      }
      // Scoped to the caller's own attribution rail — the partner user id is
      // taken from the session, never from a parameter (no cross-partner path).
      // Stages are consent-gated inside the storage read (PH-2, §5-C6).
      const referrals = await storage.getPartnerReferralsForHub(user.id);
      // Audit every partner read of the pipeline (charter PH-2 done-when).
      logAudit(req, "partner.pipeline_viewed", "partner_profile", profile.id, {
        referralCount: referrals.length,
        sharedCount: referrals.filter((r) => r.shared).length,
      });
      res.json({ referrals });
    } catch (error) {
      console.error("Partner referrals error:", error);
      res.status(500).json({ error: "Failed to load referrals" });
    }
  });

  // ---- Borrower: view + toggle progress-sharing with their referring partner --
  // PH-2 consent spine. The consent is borrower-directed (never partner-initiated),
  // default OFF, and only meaningful when the referrer is a self-registering
  // partner (realtor) — an LO referrer is the borrower's own loan team, a
  // different relationship with no partner hub.
  app.get("/api/me/referring-partner", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const me = await storage.getUser(user.id);
      if (!me?.referredByUserId) {
        return res.json({ partner: null, shared: false });
      }
      const partnerProfile = await storage.getPartnerProfileByUserId(me.referredByUserId);
      // Only surface the toggle for a partner-persona referrer (realtor), and
      // only while that partner is active.
      if (!partnerProfile || partnerProfile.status !== "active") {
        return res.json({ partner: null, shared: false });
      }
      const consent = await storage.getPartnerProgressConsent(user.id, me.referredByUserId);
      res.json({
        partner: {
          displayName: partnerProfile.contactName || partnerProfile.firmName,
          firmName: partnerProfile.firmName,
          persona: partnerProfile.persona,
        },
        shared: consent?.shared ?? false,
        grantedAt: consent?.shared ? consent.grantedAt : null,
      });
    } catch (error) {
      console.error("Referring-partner lookup error:", error);
      res.status(500).json({ error: "Failed to load your referring partner" });
    }
  });

  app.put("/api/me/referring-partner/consent", isAuthenticated, async (req, res) => {
    try {
      const user = req.user as User;
      const schema = z.object({ share: z.boolean() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "share (boolean) is required" });
      }
      const me = await storage.getUser(user.id);
      if (!me?.referredByUserId) {
        return res.status(404).json({ error: "You have no referring partner" });
      }
      // Guard: consent only applies to a partner-persona referrer. Never let a
      // borrower create a share record against a non-partner (e.g. their LO).
      const partnerProfile = await storage.getPartnerProfileByUserId(me.referredByUserId);
      if (!partnerProfile || partnerProfile.status !== "active") {
        return res.status(404).json({ error: "You have no active referring partner" });
      }
      const consent = await storage.setPartnerProgressConsent(
        user.id,
        me.referredByUserId,
        parsed.data.share,
        { ipAddress: clientIpForRecord(req) },
      );
      logAudit(req, parsed.data.share ? "partner_progress.shared" : "partner_progress.revoked",
        "partner_profile", partnerProfile.id, { share: parsed.data.share });
      res.json({ shared: consent.shared, grantedAt: consent.shared ? consent.grantedAt : null });
    } catch (error) {
      console.error("Referring-partner consent error:", error);
      res.status(500).json({ error: "Failed to update sharing" });
    }
  });

  // ---- Admin: unified partner queue (partner_profiles ∪ cpa_partners) --------
  app.get("/api/admin/partners", requireRole("admin"), async (req, res) => {
    try {
      const [profiles, cpas] = await Promise.all([
        storage.listPartnerProfiles(),
        storage.listCpaPartners(),
      ]);
      const rows = [
        ...profiles.map((p) => ({
          id: p.id,
          table: "partner_profiles" as const,
          persona: p.persona,
          firmName: p.firmName,
          contactName: p.contactName,
          email: p.email,
          referralSlug: p.referralSlug,
          licenseNumber: p.licenseNumber,
          licenseState: p.licenseState,
          licenseVerificationStatus: p.licenseVerificationStatus,
          status: p.status,
          source: p.source,
          createdAt: p.createdAt,
        })),
        // CPA lane rows are read-only here until the convergence prompt —
        // their lifecycle stays on the existing cpa_partners routes.
        ...cpas.map((c) => ({
          id: c.id,
          table: "cpa_partners" as const,
          persona: "cpa",
          firmName: c.firmName,
          contactName: c.contactName,
          email: c.email,
          referralSlug: c.referralCode,
          licenseNumber: null,
          licenseState: null,
          licenseVerificationStatus: null,
          status: c.status,
          source: "self_service",
          createdAt: c.createdAt,
        })),
      ].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
      res.json({ partners: rows });
    } catch (error) {
      console.error("Admin partners error:", error);
      res.status(500).json({ error: "Failed to load partners" });
    }
  });

  app.post("/api/admin/partners/:id/license-review", requireRole("admin"), async (req, res) => {
    try {
      const schema = z.object({
        decision: z.enum(LICENSE_VERIFICATION_STATUSES),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid decision" });
      }
      const updated = await storage.updatePartnerProfileReview(routeParam(req, "id"), {
        licenseVerificationStatus: parsed.data.decision,
      });
      if (!updated) {
        return res.status(404).json({ error: "Partner not found" });
      }
      logAudit(req, "partner.license_review", "partner_profile", updated.id, {
        decision: parsed.data.decision,
      });
      res.json({ partner: ownPartnerProfile(updated, baseUrlOf(req)) });
    } catch (error) {
      console.error("Partner license-review error:", error);
      res.status(500).json({ error: "Failed to update license review" });
    }
  });

  app.post("/api/admin/partners/:id/status", requireRole("admin"), async (req, res) => {
    try {
      const schema = z.object({ status: z.enum(PARTNER_PROFILE_STATUSES) });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid status" });
      }
      const updated = await storage.updatePartnerProfileReview(routeParam(req, "id"), {
        status: parsed.data.status,
      });
      if (!updated) {
        return res.status(404).json({ error: "Partner not found" });
      }
      logAudit(req, "partner.status_changed", "partner_profile", updated.id, {
        status: parsed.data.status,
      });
      res.json({ partner: ownPartnerProfile(updated, baseUrlOf(req)) });
    } catch (error) {
      console.error("Partner status error:", error);
      res.status(500).json({ error: "Failed to update partner status" });
    }
  });

  // ---- Admin: waitlist → activation conversion --------------------------------
  app.post("/api/admin/partner-waitlist/:id/invite", requireRole("admin"), async (req, res) => {
    try {
      const row = await storage.markPartnerWaitlistInvited(routeParam(req, "id"));
      if (!row) {
        return res.status(404).json({ error: "Waitlist entry not found" });
      }
      const persona = WAITLIST_PERSONA[row.partnerType];
      const joinUrl = `${baseUrlOf(req)}/partners/join${persona ? `?persona=${persona}` : ""}`;
      const template = emailTemplates.partnerWaitlistInvite(row.name, joinUrl);
      // `emailSent` is now the real delivery result — sendEmail returned `true`
      // unconditionally when no provider was configured until 2026-08-06, which
      // is how this audit entry came to record delivery for mail that reached
      // nobody. NOTE the ordering above: markPartnerWaitlistInvited has already
      // stamped `invitedAt`, so a failed send leaves the row marked invited and
      // this audit metadata is the only honest record of what happened.
      // Reordering the write is a separate change with its own double-send
      // tradeoff, so it is deliberately not made here.
      const emailSent = await sendEmail({ ...template, to: row.email });
      logAudit(req, "partner_waitlist.invited", "partner_waitlist", row.id, {
        partnerType: row.partnerType,
        emailSent,
      });
      res.json({ invited: true, emailSent, invitedAt: row.invitedAt });
    } catch (error) {
      console.error("Partner waitlist invite error:", error);
      res.status(500).json({ error: "Failed to send invite" });
    }
  });
}
