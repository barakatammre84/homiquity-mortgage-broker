import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getReadinessPercent,
  getPersonalizedGreeting,
  getExpirationInfo,
  formatActivityTime,
  showIncubatorHome,
  NEXT_ACTION_ICONS,
} from "./model";
import { LOAN_APP_STATUSES } from "@shared/loanApplicationStatus";
import type { LoanApplication } from "@shared/schema";
// First-ever unit coverage for the dashboard's derivation helpers — pure
// functions that previously lived inline in a 1,092-line page.

const app = (over: Partial<LoanApplication>): LoanApplication =>
  ({ id: "a-1", status: "draft", createdAt: new Date().toISOString(), ...over }) as unknown as LoanApplication;

describe("getReadinessPercent", () => {
  it("scores pre-application engagement: base 10, +15 coach, +10 browsing", () => {
    expect(getReadinessPercent(null, 0, 0)).toBe(10);
    expect(getReadinessPercent(null, 0, 0, undefined, true)).toBe(25);
    expect(getReadinessPercent(null, 0, 0, undefined, true, true)).toBe(35);
  });

  it("weights every canonical status (funded=100, denied=10) and caps at 100", () => {
    expect(getReadinessPercent(app({ status: "funded" }), 5, 5)).toBe(100);
    expect(getReadinessPercent(app({ status: "denied" }), 0, 0)).toBe(10);
    const all = getReadinessPercent(
      app({ status: "funded" }), 0, 0,
      { hasCreditConsent: true, hasIdVerification: true, hasBankConnected: true, hasRateLocked: true },
    );
    expect(all).toBe(100); // 100 + bonuses still capped
  });

  it("adds verification bonuses and the zero-pending bonuses only from mid-funnel", () => {
    expect(
      getReadinessPercent(app({ status: "pre_approved" }), 0, 0, {
        hasCreditConsent: true, hasIdVerification: false, hasBankConnected: false, hasRateLocked: false,
      }),
    ).toBe(45 + 3);
    expect(
      getReadinessPercent(app({ status: "pre_approved", financialDataProvenance: "verified" }), 0, 0, {
        hasCreditConsent: true, hasIdVerification: false, hasBankConnected: false, hasRateLocked: false,
      }),
    ).toBe(60 + 3 + 5 + 5);
    // draft (20) is below the >=50 threshold — no zero-pending bonuses.
    expect(getReadinessPercent(app({ status: "draft" }), 0, 0)).toBe(20);
  });

  it("stays exhaustive over the shared vocabulary — no status falls to the fallback silently", () => {
    for (const status of LOAN_APP_STATUSES) {
      const score = getReadinessPercent(app({ status }), 1, 1);
      expect(score, `status ${status} must have an explicit weight`).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});

describe("getPersonalizedGreeting", () => {
  it("greets by first name when known, neutrally otherwise", () => {
    expect(getPersonalizedGreeting({ firstName: "Amira" }, null).title).toBe("Hi, Amira");
    expect(getPersonalizedGreeting(null, null).title).toBe("Welcome back");
  });

  it("matches the subtitle to the application stage", () => {
    expect(getPersonalizedGreeting(null, app({ status: "pre_approved", financialDataProvenance: "verified" })).subtitle).toContain("pre-approved");
    expect(getPersonalizedGreeting(null, app({ status: "pre_approved", financialDataProvenance: "self_reported" })).subtitle).toContain("initial review");
    expect(getPersonalizedGreeting(null, app({ status: "expired" })).subtitle).toContain("expired");
    expect(getPersonalizedGreeting(null, app({ status: "funded" })).subtitle).toContain("Congratulations");
  });
});

describe("getExpirationInfo (30-day pre-approval window)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is null for non-pre_approved applications", () => {
    expect(getExpirationInfo(app({ status: "draft" }))).toBeNull();
  });

  it("buckets urgency: normal → urgent (≤7 days) → expired (≤0)", () => {
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    const preApproved = (createdAt: string) => app({ status: "pre_approved", financialDataProvenance: "verified", createdAt: createdAt as never });
    expect(getExpirationInfo(preApproved("2026-07-10T12:00:00Z"))?.urgency).toBe("normal");   // 21 days left
    expect(getExpirationInfo(preApproved("2026-06-25T12:00:00Z"))?.urgency).toBe("urgent");   // 6 days left
    expect(getExpirationInfo(preApproved("2026-06-01T12:00:00Z"))?.urgency).toBe("expired");  // long gone
  });

  it("does not assign an approval expiration to a preliminary calculation", () => {
    expect(getExpirationInfo(app({ status: "pre_approved", financialDataProvenance: "self_reported" }))).toBeNull();
  });
});

describe("formatActivityTime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("buckets relative time: just now → minutes → hours → days → date", () => {
    vi.setSystemTime(new Date("2026-07-19T12:00:00Z"));
    expect(formatActivityTime("2026-07-19T11:59:40Z")).toBe("Just now");
    expect(formatActivityTime("2026-07-19T11:15:00Z")).toBe("45m ago");
    expect(formatActivityTime("2026-07-19T06:00:00Z")).toBe("6h ago");
    expect(formatActivityTime("2026-07-16T12:00:00Z")).toBe("3d ago");
    expect(formatActivityTime("2026-06-01T12:00:00Z")).toMatch(/Jun 1/);
  });
});

describe("showIncubatorHome", () => {
  const s = (status: string) => ({ status });

  it("keeps the first-visit behavior: no applications → Incubator", () => {
    expect(showIncubatorHome([], undefined)).toBe(true);
  });

  it("routes terminal-only borrowers to the Incubator instead of a re-apply dashboard", () => {
    expect(showIncubatorHome([s("denied")], undefined)).toBe(true);
    expect(showIncubatorHome([s("withdrawn")], undefined)).toBe(true);
    expect(showIncubatorHome([s("expired")], undefined)).toBe(true);
    expect(showIncubatorHome([s("denied"), s("withdrawn")], undefined)).toBe(true);
  });

  it("never hijacks a borrower with a funded loan", () => {
    expect(showIncubatorHome([s("denied"), s("funded")], undefined)).toBe(false);
    expect(showIncubatorHome([s("funded")], undefined)).toBe(false);
  });

  it("defers to any resolved active application (workable or deep-linked terminal)", () => {
    expect(showIncubatorHome([s("pre_approved")], s("pre_approved"))).toBe(false);
    expect(showIncubatorHome([s("draft")], s("draft"))).toBe(false);
    // ?app=<deniedId> deep link: resolveActiveApplication returns the closed
    // file, and the Dashboard must still render it.
    expect(showIncubatorHome([s("denied")], s("denied"))).toBe(false);
  });
});

describe("NEXT_ACTION_ICONS", () => {
  it("covers every next-action kind the server can emit", () => {
    const kinds = [
      "start_application", "resume_draft", "renew_preapproval", "read_messages",
      "strengthen_file", "upload_documents", "complete_tasks", "clear_conditions",
      "browse_homes", "contact_team", "talk_to_coach", "homeowner_hub", "in_review",
    ] as const;
    for (const kind of kinds) {
      expect(NEXT_ACTION_ICONS[kind], `icon for ${kind}`).toBeTruthy();
    }
  });
});
