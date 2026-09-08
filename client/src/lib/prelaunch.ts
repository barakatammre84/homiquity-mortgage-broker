import { COMPANY_NMLS_ID } from "@shared/companyLicense";

/**
 * Pre-license launch gate (client).
 *
 * Homiquity cannot solicit a mortgage transaction until the company NMLS
 * license (roadmap F1) is issued. Until then the public site runs in a
 * "gated" mode: educational + legal content and a waitlist only — no rates,
 * no pricing, no application funnel, no persona conversion pages.
 *
 * Fail-safe: an explicit true always closes the funnel. When the flag is
 * omitted, production follows the same issued-license source of truth as the
 * server. This prevents an otherwise valid production build from silently
 * closing the application after the real NMLS identifier has been installed.
 *
 * On F1 day this flips together with (a) the real NMLS id in
 * shared/companyLicense.ts and (b) the server PRELAUNCH_GATED env var. See
 * knowledge-base/governance/ARMED_LAUNCH_CHARTER_2026-07-07.md.
 */
export const PRELAUNCH_GATED: boolean =
  import.meta.env.VITE_PRELAUNCH_GATED === "true" ||
  (import.meta.env.PROD &&
    import.meta.env.VITE_PRELAUNCH_GATED !== "false" &&
    (!COMPANY_NMLS_ID || COMPANY_NMLS_ID === "PENDING"));
