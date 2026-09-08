import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { useShellBadges } from "@/hooks/useShellBadges";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Bell,
  MessageCircle,
  FileText,
  CheckCircle2,
  Clock,
  Upload,
  AlertCircle,
  ArrowRight,
  CheckCheck,
} from "lucide-react";
import type { DealActivity } from "@shared/schema";
import { apiRequest, dashboardKeys } from "@/lib/queryClient";

interface NotificationItem {
  id: string;
  icon: typeof Bell;
  iconColor: string;
  title: string;
  description: string;
  time: string;
  href: string;
  isUnread: boolean;
  isReal?: boolean;
  /** The server row's uuid — used to PATCH it read. */
  realId?: string;
}

function formatTimeAgo(timestamp: string | Date): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function activityToNotification(activity: DealActivity, index: number): NotificationItem {
  const type = activity.activityType || "";
  let icon = Clock;
  let iconColor = "text-muted-foreground";
  let href = "/dashboard";

  if (type.includes("document")) {
    icon = FileText;
    iconColor = "text-info";
    href = "/documents";
  } else if (type.includes("message")) {
    icon = MessageCircle;
    iconColor = "text-primary";
    href = "/messages";
  } else if (type.includes("approved") || type.includes("verified")) {
    icon = CheckCircle2;
    iconColor = "text-success-subtle-foreground";
    href = "/dashboard";
  } else if (type.includes("task")) {
    icon = Upload;
    iconColor = "text-warning-subtle-foreground";
    href = "/tasks";
  } else if (type.includes("denied") || type.includes("rejected")) {
    icon = AlertCircle;
    iconColor = "text-destructive";
    href = "/dashboard";
  }

  return {
    id: activity.id,
    icon,
    iconColor,
    title: activity.title || "Update",
    description: activity.description || "",
    time: formatTimeAgo(activity.createdAt!),
    href,
    isUnread: index < 3,
  };
}

/**
 * A row from `GET /api/notifications`, which returns `notifications` rows
 * verbatim (`server/storage/notificationsOps.ts:145`).
 *
 * **Read state lives in `status`, and only in `status`.** The table has no
 * `readAt` column — `markNotificationRead` sets `status: "read"` and the bell's
 * unread count is `count(*) where status = 'unread'`. This interface used to
 * declare a `readAt` the API never sends, and the mapper below keyed off it, so
 * `isUnread` was `!undefined` for every row: every notification rendered unread
 * forever, and stayed unread after being clicked, while the bell count went
 * down. Two surfaces, one fact, opposite answers.
 */
export interface RealNotification {
  /** uuid — `notifications.id` is a varchar, not a serial. */
  id: string;
  type: string;
  title: string;
  body: string;
  /** `"unread"` (the column default) or `"read"`. */
  status: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
}

/**
 * Anything not explicitly read is shown as unread. Deliberately not
 * `status === "unread"`: if the vocabulary ever grows, the safe failure is a
 * notification the borrower still sees, not one silently hidden.
 */
export function isNotificationUnread(n: Pick<RealNotification, "status">): boolean {
  return n.status !== "read";
}

// Exported for unit tests: pure mapper from a server notification row to a
// panel item (icon/color/href derivation).
export function realNotificationToItem(n: RealNotification): NotificationItem {
  let icon = Bell;
  let iconColor = "text-muted-foreground";
  let href = "/dashboard";

  const type = n.type || "";
  if (type.includes("document")) {
    icon = FileText;
    iconColor = "text-info";
    href = "/documents";
  } else if (type.includes("message")) {
    icon = MessageCircle;
    iconColor = "text-primary";
    href = "/messages";
  } else if (type.includes("approved") || type.includes("verified")) {
    icon = CheckCircle2;
    iconColor = "text-success-subtle-foreground";
  } else if (type.includes("task")) {
    icon = Upload;
    iconColor = "text-warning-subtle-foreground";
    href = "/tasks";
  } else if (type.includes("denied") || type.includes("rejected") || type.includes("alert")) {
    icon = AlertCircle;
    iconColor = "text-destructive";
  }

  if (n.entityType && n.entityId) {
    if (n.entityType === "deal") href = `/deals/${n.entityId}`;
    else if (n.entityType === "document") href = "/documents";
    else if (n.entityType === "task") href = "/tasks";
    // ECOA adverse-action notices must be reachable from the notification that
    // announces them — without this mapping the click dead-ends on /dashboard.
    else if (n.type === "adverse_action" && n.entityType === "loan_application")
      href = `/adverse-action/${n.entityId}`;
  }

  return {
    id: `real-${n.id}`,
    icon,
    iconColor,
    title: n.title,
    description: n.body || "",
    time: formatTimeAgo(n.createdAt),
    href,
    isUnread: isNotificationUnread(n),
    isReal: true,
    realId: n.id,
  };
}

export function NotificationsBell() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // Every shell badge count comes from the single shared shell-badges poll
  // (useShellBadges) — the same source the sidebar and mobile nav read. The
  // bell no longer takes drilled counts/activities from a second /api/dashboard
  // poll in the layout; that double-poll (and the double-count it produced) is
  // gone. The bell opens notifications, so its badge is deliberately limited
  // to unread notifications. Messages and borrower actions each have their own
  // labelled navigation badge.
  const badges = useShellBadges();

  const { data: notifData, isLoading: notifLoading } = useQuery<{ notifications: RealNotification[] }>({
    queryKey: ["/api/notifications"],
    enabled: open,
  });

  // The deal-activity feed shown inside the popover is fetched lazily on open
  // (like /api/notifications above), sharing the ["/api/dashboard"] cache key so
  // borrower pages that already loaded it reuse the warm cache instead of the
  // layout re-polling this heavy endpoint on every page for every role.
  const { data: dashData } = useQuery<{ activities: DealActivity[] }>({
    queryKey: dashboardKeys.root(),
    enabled: open,
  });
  const activities = dashData?.activities ?? [];

  const realNotifications = (notifData?.notifications || []).map(realNotificationToItem);
  const activityNotifications = activities
    .slice(0, 10)
    .map((a, i) => activityToNotification(a, i));

  const totalUnread = badges.unreadNotifications;

  const allNotifications = [...realNotifications, ...activityNotifications];

  async function handleMarkAllRead() {
    await apiRequest("PATCH", "/api/notifications/read-all");
    queryClient.invalidateQueries({ queryKey: ["/api/shell/badges"] });
    queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
  }

  async function handleNotificationClick(notif: NotificationItem) {
    if (notif.isReal && notif.realId) {
      await apiRequest("PATCH", `/api/notifications/${notif.realId}/read`);
      queryClient.invalidateQueries({ queryKey: ["/api/shell/badges"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Notifications" className="relative" data-testid="button-notifications">
          <Bell className="h-5 w-5" />
          {totalUnread > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground"
              data-testid="badge-notification-count"
            >
              {totalUnread > 9 ? "9+" : totalUnread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end">
        <div className="flex items-center justify-between gap-4 border-b p-3">
          <h3 className="font-semibold text-sm">Notifications</h3>
          <div className="flex items-center gap-2 flex-wrap">
            {totalUnread > 0 && (
              <Badge variant="secondary" className="text-xs">
                {totalUnread} new
              </Badge>
            )}
            {totalUnread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="touch-target text-xs h-auto py-1 px-2"
                onClick={handleMarkAllRead}
                data-testid="button-mark-all-read"
              >
                <CheckCheck className="h-3 w-3 mr-1" />
                Mark all read
              </Button>
            )}
          </div>
        </div>
        <ScrollArea className="max-h-80">
          {notifLoading && allNotifications.length === 0 ? (
            <div className="divide-y" data-testid="notifications-loading">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-start gap-3 p-3">
                  <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : allNotifications.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground" data-testid="text-no-notifications">
              <Bell className="h-8 w-8 mx-auto mb-2 opacity-40" />
              No notifications yet
            </div>
          ) : (
            <div className="divide-y">
              {allNotifications.map((notif) => {
                const Icon = notif.icon;
                return (
                  <Link key={notif.id} href={notif.href} onClick={() => handleNotificationClick(notif)}>
                    <div
                      className={`flex items-start gap-3 p-3 hover-elevate cursor-pointer ${
                        notif.isUnread ? "bg-primary/5" : ""
                      }`}
                      data-testid={`notification-${notif.id}`}
                    >
                      <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${notif.iconColor}`}>
                        <Icon className="h-4 w-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm leading-tight ${notif.isUnread ? "font-medium" : ""}`}>
                          {notif.title}
                        </p>
                        {notif.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {notif.description}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1">{notif.time}</p>
                      </div>
                      {notif.isUnread && (
                        <div className="h-2 w-2 rounded-full bg-primary mt-1.5 shrink-0" />
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </ScrollArea>
        <div className="border-t p-2">
          <Button asChild variant="ghost" size="sm" className="touch-target w-full text-xs" data-testid="button-view-all-notifications">
            <Link href="/dashboard">
              View all activity
              <ArrowRight className="h-3 w-3 ml-1" />
            </Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
