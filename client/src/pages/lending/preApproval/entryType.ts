// The `?type=` entry vocabulary — what the marketing/rates surfaces say when
// they hand a visitor to /apply, translated into the funnel's own enums.
//
// THIS IS THE SAME SHAPE OF BUG AS THE CREDIT BAND (see calculatorPrefill.ts):
// an entry point speaking a vocabulary the funnel does not accept. There it
// wrote a value the schema rejected; here the miss is quieter — an unknown
// `?type=` simply falls through to the "purchase" default, which is a valid
// answer, so nothing throws and no guard fires.
//
// `/rates/cash-out` sent `?type=cashout` from three CTAs
// (pages/rates/CashOutRates.tsx:119,132,148) while the funnel matched only
// `heloc`. A borrower who read a cash-out refinance page and tapped Apply
// landed on "What are you looking to do?" with **Buying a Home** preselected.
// The step is asked, so they can correct it — but the one who accepts the
// preselection files a PURCHASE application off a cash-out inquiry, and
// `loanPurpose` drives program eligibility and pricing from there.
//
// Every value below is emitted somewhere in client/src today; the map is the
// single place that has to agree with those links.
import type { PreApprovalFormData } from "@shared/schema";

type LoanPurpose = PreApprovalFormData["loanPurpose"];
type OccupancyType = NonNullable<PreApprovalFormData["occupancyType"]>;

/**
 * Read the current entry vocabulary while preserving links emitted by the
 * legacy site. Core uses `?type=`; older public pages used `?goal=`. Giving the
 * current key precedence makes the compatibility rule deterministic if a URL
 * contains both.
 */
export function entryTypeFromSearchParams(params: Pick<URLSearchParams, "get">): string | null {
  return params.get("type") ?? params.get("goal");
}

/**
 * `?type=` → `loanPurpose`. Anything absent means "the entry point said
 * nothing about purpose", which is a purchase.
 *
 * Deliberately NOT listed, and not an oversight:
 *   `va`, `first-time`  — these preselect `isVeteran` / `isFirstTimeBuyer`
 *                         in PreApproval.tsx, not the purpose.
 *   `self-employed`     — preselects `employmentType`.
 *   `investment`        — remains a purchase purpose and separately maps to
 *                         investment occupancy below.
 */
// A Map, not an object literal: the key comes straight off the URL, and
// `({} as Record<string, T>)["constructor"]` returns a truthy function that
// would sail past a `?? "purchase"` fallback.
const ENTRY_TYPE_LOAN_PURPOSE = new Map<string, LoanPurpose>([
  ["refinance", "refinance"],
  // Both spellings reach the same place: `heloc` from /home-equity, `cashout`
  // from /rates/cash-out. Cash-out IS the funnel's third purpose option.
  ["heloc", "cash_out"],
  ["cashout", "cash_out"],
]);

/**
 * The purpose a `?type=` entry link implies. Total: an unknown, absent or
 * purpose-less type is a purchase, which is what the funnel has always
 * defaulted to.
 */
export function loanPurposeForEntryType(urlType: string | null | undefined): LoanPurpose {
  if (!urlType) return "purchase";
  return ENTRY_TYPE_LOAN_PURPOSE.get(urlType) ?? "purchase";
}

export function occupancyForEntryType(
  urlType: string | null | undefined,
): OccupancyType | undefined {
  return urlType === "investment" ? "investment" : undefined;
}
