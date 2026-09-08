import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ShellBadges } from "@/hooks/useShellBadges";

// The notification-bell badge count. The bell opens a notification/activity
// panel, so its badge measures unread notifications only. Messages and borrower
// actions each have their own navigation badge and must not be added here.

let badges: ShellBadges;
let role: string;

vi.mock("@/hooks/useShellBadges", () => ({
  useShellBadges: () => badges,
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { role }, isAuthenticated: true, isLoading: false, isError: false, hasRole: () => true }),
}));

import {
  NotificationsBell,
  isNotificationUnread,
  realNotificationToItem,
  type RealNotification,
} from "./NotificationsPanel";

// Popover is closed by default, so the on-open /api/notifications and
// /api/dashboard queries stay disabled and never fetch — the provider only
// needs to satisfy useQuery's context requirement.
function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationsBell />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  badges = { unreadMessages: 0, unreadNotifications: 0, pendingTasks: 0 };
  role = "aspiring_owner";
});

describe("NotificationsBell badge count", () => {
  it("shows unread notifications only for a borrower", () => {
    badges = { unreadMessages: 2, unreadNotifications: 1, pendingTasks: 3 };
    role = "active_buyer";
    renderBell();
    expect(screen.getByTestId("badge-notification-count").textContent).toBe("1");
  });

  it("uses the same notification-only meaning for staff", () => {
    badges = { unreadMessages: 2, unreadNotifications: 1, pendingTasks: 3 };
    role = "lo";
    renderBell();
    expect(screen.getByTestId("badge-notification-count").textContent).toBe("1");
  });

  it("caps the display at 9+", () => {
    badges = { unreadMessages: 0, unreadNotifications: 12, pendingTasks: 0 };
    role = "active_buyer";
    renderBell();
    expect(screen.getByTestId("badge-notification-count").textContent).toBe("9+");
  });

  it("renders no badge when every count is zero", () => {
    renderBell();
    expect(screen.queryByTestId("badge-notification-count")).toBeNull();
  });
});

// The fixture below is the row `GET /api/notifications` actually returns —
// `notifications` columns, nothing else. It used to carry `readAt: null`, a
// field that table has never had, which is why the mapper could key off it for
// months with a green test: the fixture supplied what the product could not.
const notif = (over: Partial<RealNotification> = {}): RealNotification => ({
  id: "n-1",
  type: "generic",
  title: "t",
  body: "b",
  status: "unread",
  entityType: null,
  entityId: null,
  createdAt: new Date().toISOString(),
  ...over,
});

describe("realNotificationToItem entity routing", () => {

  it("routes an adverse-action notification to its notice page (ECOA reachability)", () => {
    const item = realNotificationToItem(
      notif({ type: "adverse_action", entityType: "loan_application", entityId: "app-42" }),
    );
    expect(item.href).toBe("/adverse-action/app-42");
  });

  it("keeps the existing entity mappings and the dashboard fallback", () => {
    expect(realNotificationToItem(notif({ entityType: "deal", entityId: "d-1" })).href).toBe("/deals/d-1");
    expect(realNotificationToItem(notif({ entityType: "document", entityId: "x" })).href).toBe("/documents");
    expect(realNotificationToItem(notif({ entityType: "task", entityId: "x" })).href).toBe("/tasks");
    // A loan_application entity with a non-adverse-action type still falls back.
    expect(realNotificationToItem(notif({ type: "status_change", entityType: "loan_application", entityId: "x" })).href).toBe("/dashboard");
  });

  it("carries the server row's uuid through, so the read PATCH addresses a real row", () => {
    const item = realNotificationToItem(notif({ id: "8f14e45f-ceea-467a-9575-0f1a9f0b0e21" }));
    expect(item.realId).toBe("8f14e45f-ceea-467a-9575-0f1a9f0b0e21");
    expect(item.isReal).toBe(true);
  });
});

// F-0819-10 — read state was keyed off `readAt`, which the notifications table
// does not have. `!undefined` is `true`, so every notification rendered unread
// forever: clicking one PATCHed it read, the panel refetched, and it came back
// looking exactly as unread as before — while the bell count, which reads
// `status`, went down. The write happened; the surface said it hadn't.
describe("notification read state", () => {
  it("reads a read notification as read", () => {
    expect(isNotificationUnread({ status: "read" })).toBe(false);
    expect(realNotificationToItem(notif({ status: "read" })).isUnread).toBe(false);
  });

  it("reads the column default as unread", () => {
    expect(isNotificationUnread({ status: "unread" })).toBe(true);
    expect(realNotificationToItem(notif({ status: "unread" })).isUnread).toBe(true);
  });

  it("shows an unrecognised status rather than hiding it", () => {
    // Fail-safe direction: a notification the borrower still sees beats one
    // silently marked read by a vocabulary change.
    expect(isNotificationUnread({ status: "queued" })).toBe(true);
  });
});

// The vocabulary this component branches on has to be the one the server writes.
// Read both sides rather than trusting either — a phantom field is exactly what
// a hand-written fixture cannot catch.
describe("the client and the server agree on what 'read' means", () => {
  const opsSrc = readFileSync(
    join(__dirname, "..", "..", "..", "server", "storage", "notificationsOps.ts"),
    "utf8",
  );
  const schemaSrc = readFileSync(
    join(__dirname, "..", "..", "..", "shared", "schema", "admin.ts"),
    "utf8",
  );

  it("marks read by setting status, not by stamping a timestamp", () => {
    expect(opsSrc).toMatch(/markNotificationRead[\s\S]{0,200}status:\s*"read"/);
    expect(opsSrc).toMatch(/markAllNotificationsRead[\s\S]{0,300}status:\s*"read"/);
  });

  it("counts unread by status, the same field this panel reads", () => {
    expect(opsSrc).toMatch(/getUnreadNotificationCount[\s\S]{0,400}eq\(notifications\.status, "unread"\)/);
  });

  it("has no readAt column to key off", () => {
    const table = schemaSrc.slice(schemaSrc.indexOf('pgTable("notifications"'));
    expect(table.slice(0, table.indexOf("]);"))).not.toContain("read_at");
  });
});
