import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { CLIENT_ROLES } from "@shared/roles";

// ---------------------------------------------------------------------------
// Roadmap A3: the aspiring_owner / active_buyer split is a UI-navigation
// cohort (two sidebars), not a privilege boundary — and it never had a
// promotion writer, so every real borrower kept the renter sidebar forever.
// The resolution is a guarded auto-promotion at application creation. These
// guards pin the three claims that make it safe:
//   1. the promotion is guarded to exactly aspiring_owner and audited,
//   2. a promotion failure can never fail intake,
//   3. NO server route gates on either client role — the promotion moves a
//      user between two identically-privileged roles. If someone ever adds a
//      role gate on aspiring_owner or active_buyer, guard 3 fails and the
//      promotion must be re-reviewed as a privilege change (§9).
// ---------------------------------------------------------------------------

const repoRoot = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

describe("A3 auto-promotion wiring", () => {
  const src = read("server/routes/lending/applications.ts");

  it("promotes exactly aspiring_owner to active_buyer, with an audit entry", () => {
    expect(src).toContain('user.role === "aspiring_owner"');
    expect(src).toContain('updateUserRole(userId, "active_buyer")');
    expect(src).toContain('"user.role_change"');
    expect(src).toContain('reason: "auto_promotion_on_application"');
  });

  it("promotion failure is non-fatal to intake", () => {
    const at = src.indexOf('updateUserRole(userId, "active_buyer")');
    const surrounding = src.slice(Math.max(0, at - 400), at + 400);
    expect(surrounding).toContain("try {");
    expect(surrounding).toContain("catch (promoteErr)");
  });

  it("refreshes the promoted session before entering the submitted-loan journey", () => {
    const client = read("client/src/pages/lending/PreApproval.tsx");
    const success = client.indexOf("onSuccess: async (result)");
    const refresh = client.indexOf('queryKey: ["/api/auth/user"]', success);
    const navigation = client.indexOf("navigate(`/loan-options/${result.id}`)", success);

    expect(success).toBeGreaterThanOrEqual(0);
    expect(refresh).toBeGreaterThan(success);
    expect(navigation).toBeGreaterThan(refresh);
    expect(client.slice(success, navigation)).toContain("await Promise.all");
  });
});

describe("client roles carry identical server-side authorization", () => {
  it("both roles are CLIENT_ROLES", () => {
    expect(CLIENT_ROLES).toContain("aspiring_owner");
    expect(CLIENT_ROLES).toContain("active_buyer");
  });

  it("no server route gates on either client role", () => {
    // Walk server/routes recursively; any requireRole mention of a client role
    // would turn this promotion into a privilege change.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith(".ts")) {
          const content = readFileSync(p, "utf8");
          for (const line of content.split("\n")) {
            if (
              line.includes("requireRole") &&
              (line.includes("aspiring_owner") || line.includes("active_buyer"))
            ) {
              offenders.push(`${p}: ${line.trim()}`);
            }
          }
        }
      }
    };
    walk(resolve(repoRoot, "server/routes"));
    expect(offenders).toEqual([]);
  });
});
