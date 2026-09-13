import { describe, it, expect } from "vitest";
import { canAccessRoleQueue } from "../server/services/taskEngine";
import { getRoleHomeRoute } from "../client/src/lib/roleRoutes";

const INTERNAL_STAFF = ["lo", "loa", "processor", "underwriter", "closer"];
const EXTERNAL_PARTNERS = ["broker", "lender", "cpa"];
const CLIENTS = ["active_buyer", "aspiring_owner"];

describe("canAccessRoleQueue — by-role work queue gate", () => {
  it("admin may query any role's queue", () => {
    for (const requested of [...INTERNAL_STAFF, "admin", ...EXTERNAL_PARTNERS]) {
      expect(canAccessRoleQueue("admin", requested)).toBe(true);
    }
  });

  it("internal staff may query their own role's queue", () => {
    for (const role of INTERNAL_STAFF) {
      expect(canAccessRoleQueue(role, role)).toBe(true);
    }
  });

  it("normalizes owner-role aliases so underwriter matches UW", () => {
    expect(canAccessRoleQueue("underwriter", "UNDERWRITER")).toBe(true);
    expect(canAccessRoleQueue("underwriter", "underwriter")).toBe(true);
    expect(canAccessRoleQueue("underwriter", "UW")).toBe(true);
    expect(canAccessRoleQueue("underwriter", "uw")).toBe(true);
  });

  it("denies cross-role enumeration by internal staff", () => {
    expect(canAccessRoleQueue("lo", "underwriter")).toBe(false);
    expect(canAccessRoleQueue("processor", "closer")).toBe(false);
    expect(canAccessRoleQueue("loa", "lo")).toBe(false);
  });

  it("denies external partners and clients for any role (including their own)", () => {
    for (const role of [...EXTERNAL_PARTNERS, ...CLIENTS, ""]) {
      expect(canAccessRoleQueue(role, "lo")).toBe(false);
      expect(canAccessRoleQueue(role, role)).toBe(false);
    }
  });
});

describe("getRoleHomeRoute — post-login landing", () => {
  it("routes admin to the admin console", () => {
    expect(getRoleHomeRoute("admin")).toBe("/admin");
  });

  it("routes brokers to their own dashboard", () => {
    expect(getRoleHomeRoute("broker")).toBe("/broker-dashboard");
  });

  it("routes CPAs to their inviter-only partner portal", () => {
    expect(getRoleHomeRoute("cpa")).toBe("/cpa-portal");
  });

  it("routes the loan team to the deal desk", () => {
    for (const role of ["lo", "loa"]) {
      expect(getRoleHomeRoute(role)).toBe("/lo-command-center");
    }
  });

  it("routes downstream operations staff to the operations dashboard", () => {
    for (const role of ["processor", "underwriter", "closer"]) {
      expect(getRoleHomeRoute(role)).toBe("/staff-dashboard");
    }
  });

  it("routes the deferred lender to the staff route (neutral partner landing)", () => {
    expect(getRoleHomeRoute("lender")).toBe("/staff-dashboard");
  });

  it("routes clients to the borrower dashboard", () => {
    for (const role of CLIENTS) {
      expect(getRoleHomeRoute(role)).toBe("/dashboard");
    }
  });
});
