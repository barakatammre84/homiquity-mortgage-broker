import { beforeEach, describe, expect, it, vi } from "vitest";

const createAuditLog = vi.hoisted(() => vi.fn());

vi.mock("../server/storage", () => ({
  storage: { createAuditLog },
}));

vi.mock("../server/clientIp", () => ({
  clientIpForRecord: () => "203.0.113.10",
}));

import { logAudit, logAuditRequired } from "../server/auditLog";

const request = {
  user: { id: "staff-1" },
  headers: { "user-agent": "audit-test" },
} as any;

describe("audit logging failure modes", () => {
  beforeEach(() => {
    createAuditLog.mockReset();
  });

  it("propagates a required audit failure so sensitive egress can be blocked", async () => {
    createAuditLog.mockRejectedValueOnce(new Error("audit store unavailable"));

    await expect(
      logAuditRequired(request, "loan_application.mismo_exported", "loan_application", "loan-1"),
    ).rejects.toThrow("audit store unavailable");
  });

  it("retains best-effort logging for non-sensitive product telemetry", async () => {
    createAuditLog.mockRejectedValueOnce(new Error("audit store unavailable"));

    await expect(
      logAudit(request, "product.event", "loan_application", "loan-1"),
    ).resolves.toBeUndefined();
  });
});
