import { COMPANY_NMLS_ID } from "./companyLicense";

/**
 * Public company identity — the single source for every customer-facing
 * mention of who Homiquity is. Shared because both the client (footer, LPs)
 * and the server (emails, generated documents, MISMO) must render the same
 * identity, and the SAFE Act / Reg H unique-identifier requirement (12 CFR
 * 1008; see docs/nmls-safe/ + knowledge-base/compliance/SAFE_MLO_COMPLIANCE_MAP.md) binds them all
 * the moment a real NMLS ID exists.
 *
 * Server-only settings (baseUrl env resolution, MERS org ID) stay in
 * server/config/company.ts, which composes this object.
 */
export const COMPANY_IDENTITY = {
  legalName: "Homiquity Mortgage Corporation",
  shortName: "Homiquity Mortgage Corp.",
  /** NMLS unique identifier — issued at F1 licensing (SAFE Act 12 CFR 1008). */
  nmlsId: COMPANY_NMLS_ID,
  contactEmail: "support@homiquity.com",
  contactPhone: "(224) 400-0531",
  /**
   * Business mailing address. Founder-supplied 2026-08-06.
   *
   * Not cosmetic: ECOA / Reg B §1002.9(b)(1) requires an adverse-action notice
   * to carry the creditor's name AND address, and the notice generator renders
   * this into the CREDITOR block. It is also the "Mailing Address" on the
   * public Disclosures page, which previously said "available on request" —
   * the state counsel flagged as resolve-before-un-gating.
   *
   * Structured rather than a single string so the letter, the PDF, and the
   * disclosures card cannot drift on formatting.
   */
  mailingAddress: {
    street: "7372 W. 87th St",
    city: "Bridgeview",
    state: "IL",
    postalCode: "60455",
  },
  /**
   * Canonical public web address — the single source for absolute canonical
   * tags, OG/Twitter URLs, and the sitemap host. Keep in sync with the
   * og:/JSON-LD literals in client/index.html and the Sitemap line in
   * client/public/robots.txt.
   *
   * This is the WWW host, and that is load-bearing, not stylistic: the apex
   * (homiquity.com) has no DNS record at all. Railway serves this site through
   * `CNAME www -> *.up.railway.app`, and Railway accepts an apex domain only
   * via CNAME flattening or a dynamic ALIAS record — neither of which the
   * zone's DNS provider (Squarespace) offers. So the apex cannot be pointed
   * at the app without moving nameservers, and until it is, any absolute URL
   * on the apex resolves to nothing.
   *
   * Reconciled 2026-08-06 with server/config/company.ts's `baseUrl`
   * (APP_BASE_URL, same www host), which had drifted: this value said apex
   * while baseUrl said www, so every canonical tag, og:url, JSON-LD node and
   * sitemap entry advertised a host that did not resolve, while customer-facing
   * links used one that did.
   */
  siteUrl: "https://www.homiquity.com",
} as const;

/**
 * tel: href for the company contact phone, derived from contactPhone so the
 * displayed number and the dial target can never drift apart. Assumes a
 * 10-digit US number (prefixes +1).
 */
export function contactPhoneTel(): string {
  const digits = COMPANY_IDENTITY.contactPhone.replace(/\D/g, "");
  return `tel:+${digits.length === 10 ? `1${digits}` : digits}`;
}

/**
 * The business mailing address as a display block.
 *
 * @param separator "\n" for letters and PDFs (ECOA notices put the creditor
 *   address on its own lines); ", " for inline UI.
 */
export function companyAddressLines(separator: "\n" | ", " = "\n"): string {
  const a = COMPANY_IDENTITY.mailingAddress;
  return [a.street, `${a.city}, ${a.state} ${a.postalCode}`].join(separator);
}

/**
 * Display string for the company NMLS unique identifier, or null while
 * licensing is pending. Callers must render NOTHING when this is null — an
 * invented or placeholder NMLS ID on a public surface would itself be a
 * violation, so the display "lights up" only when F1 assigns the real ID
 * (one edit: COMPANY_NMLS_ID in companyLicense.ts).
 */
export function companyNmlsDisplay(): string | null {
  const id = COMPANY_IDENTITY.nmlsId as string;
  if (!id || id === "PENDING") return null;
  return `NMLS #${id}`;
}

/**
 * True while the company NMLS license (roadmap F1) has not yet been issued.
 * Drives the pre-license launch gate (server/services/prelaunchGate.ts): we
 * cannot solicit a mortgage transaction until this returns false.
 */
export function isCompanyNmlsPending(): boolean {
  const id = COMPANY_IDENTITY.nmlsId as string;
  return !id || id === "PENDING";
}

// =============================================================================
// Licensed-state footprint (roadmap A5; 2026-07-17 adjudication gap D).
//
// The company license (SAFE Act / Reg H, 12 CFR 1008) is state-by-state and
// STATE LAW CONTROLS what activity requires licensure (docs/nmls/README.md
// hierarchy; for Illinois, the Residential Mortgage License Act governs). We
// therefore do not take applications, set a subject-property state, or quote
// location-scoped pricing outside this list. Same light-up contract as
// companyNmlsDisplay(): while the NMLS id is PENDING the footprint is empty.
//
// FOUNDER-MAINTAINED: founder confirmed Illinois-only on 2026-07-17. Add a
// state here ONLY when its license is issued and verifiable on NMLS Consumer
// Access — never speculatively. Keep LICENSED_STATE_DETAILS (the Disclosures
// page card) and STATE_ZIP3_RANGES (zip-scoped gates) in step.
// =============================================================================

export const LICENSED_STATES = ["IL"] as const;

/** Rendered on the Disclosures "State Licensing" card. Add the state-issued
 * license number to `licenseNumber` when at hand — never invent one; the
 * NMLS Consumer Access link is the verification path either way. */
export const LICENSED_STATE_DETAILS: Array<{
  code: string;
  name: string;
  license: string;
  licenseNumber?: string;
}> = [
  {
    code: "IL",
    name: "Illinois",
    license: "Illinois Residential Mortgage License",
    // Founder-supplied 2026-08-06 (IDFPR). NMLS Consumer Access remains the
    // verification path — this renders the number, it does not prove it.
    licenseNumber: "3423789",
  },
];

// Full-name lookup so isLicensedState accepts "Illinois" as well as "IL".
const LICENSED_STATE_NAMES = new Map(
  LICENSED_STATE_DETAILS.map((s) => [s.name.toLowerCase(), s.code]),
);

/** USPS 3-digit ZIP prefixes per licensed state (inclusive ranges). Illinois
 * is 600xx–629xx. Used where only a ZIP is known (e.g. the MCP pricing tool). */
const STATE_ZIP3_RANGES: Record<string, Array<[number, number]>> = {
  IL: [[600, 629]],
};

function normalizeStateCode(state: string | null | undefined): string | null {
  const trimmed = (state ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return LICENSED_STATE_NAMES.get(trimmed.toLowerCase()) ?? trimmed.toUpperCase();
}

/** True when the company may arrange financing for a property in `state`. */
export function isLicensedState(state: string | null | undefined): boolean {
  if (isCompanyNmlsPending()) return false;
  const code = normalizeStateCode(state);
  return code !== null && (LICENSED_STATES as readonly string[]).includes(code);
}

/** True when a 5-digit ZIP falls inside a licensed state's USPS prefix range. */
export function isZipInLicensedStates(zip: string | null | undefined): boolean {
  if (isCompanyNmlsPending()) return false;
  const digits = (zip ?? "").trim();
  if (!/^\d{5}$/.test(digits)) return false;
  const prefix = parseInt(digits.slice(0, 3), 10);
  return LICENSED_STATES.some((code) =>
    (STATE_ZIP3_RANGES[code] ?? []).some(([lo, hi]) => prefix >= lo && prefix <= hi),
  );
}

/** Borrower-safe copy for the gate responses. Names the footprint dynamically
 * so adding a state never requires a copy edit. */
export function unlicensedStateMessage(state?: string | null): string {
  const names = LICENSED_STATE_DETAILS.map((s) => s.name).join(", ");
  const where = normalizeStateCode(state);
  return (
    `Homiquity is currently licensed to arrange mortgage financing in ${names} only, ` +
    `so we can't yet accept applications or provide quotes for properties` +
    `${where ? ` in ${where}` : " outside those states"}. Our licensing is independently ` +
    `verifiable through NMLS Consumer Access (${companyNmlsDisplay() ?? "NMLS id pending"}).`
  );
}

/**
 * One-liner gate for API routes writing a subject-property state: returns the
 * 422 envelope body when the state is outside the licensed footprint, or null
 * when the write may proceed. An ABSENT state never rejects — the TRID
 * address-last funnel legitimately collects the property late; the gate fires
 * only when a concrete unlicensed state is being set.
 */
export function unlicensedStateRejection(
  state: string | null | undefined,
): { error: string; code: "UNLICENSED_STATE" } | null {
  const trimmed = (state ?? "").trim();
  if (!trimmed) return null;
  if (isLicensedState(trimmed)) return null;
  return { error: unlicensedStateMessage(trimmed), code: "UNLICENSED_STATE" };
}
