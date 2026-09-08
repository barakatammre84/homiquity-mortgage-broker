import { type ComponentType, useState } from "react";
import { logout } from "@/lib/logout";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { getPresenceColor } from "@/lib/formatters";
import { isStaffRole, isInternalStaffRole, isPartnerRole, ROLE_DISPLAY_NAMES, type UserRole } from "@shared/roles";
import { ROUTE_GATES } from "@/lib/routeGates";
import { useShellBadges } from "@/hooks/useShellBadges";
import { useActiveBorrowerActionItems } from "@/hooks/useBorrowerActionItems";
import {
  BarChart3,
  LayoutDashboard,
  FileText,
  CheckSquare,
  Upload,
  Users,
  LogOut,
  Shield,
  Home,
  DollarSign,
  Percent,
  PenSquare,
  Star,
  Calculator,
  Link2,
  Scale,
  Grid3x3,
  Brain,
  ChevronDown,
  ChevronRight,
  MessageCircle,
  Circle,
  ListTodo,
  HelpCircle,
  GraduationCap,
  Rocket,
  PiggyBank,
  ClipboardList,
  Palette,
  Gauge,
  Handshake,
  Building2,
  CircleUser,
} from "lucide-react";
import { Logo } from "@/components/brand/Logo";

interface TeamMember {
  id: string;
  name: string;
  role: string;
  initials: string;
  email: string | null;
  profileImageUrl: string | null;
  presenceStatus: 'online' | 'away' | 'offline';
}

interface NavItem {
  title: string;
  href: string;
  icon?: ComponentType<{ className?: string }>;
  brandMark?: boolean;
  testId: string;
  showBadge?: boolean;
  showMessageBadge?: boolean;
  /** Typed so a typo is a build error, not a link that silently shows nobody. */
  roles?: readonly UserRole[];
}

interface NavSection {
  section: string;
  items: NavItem[];
}

const aspiringOwnerNavigation: NavSection[] = [
  {
    section: "Explore",
    items: [
      { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard, testId: "link-borrower-dashboard" },
      { title: "Homi", href: "/ai-coach", brandMark: true, testId: "link-ai-coach" },
      { title: "My Profile", href: "/profile", icon: CircleUser, testId: "link-my-profile" },
      { title: "Messages", href: "/messages", icon: MessageCircle, testId: "link-messages", showMessageBadge: true },
    ],
  },
  {
    section: "Get Ready",
    items: [
      { title: "Get Pre-Approved", href: "/apply", icon: Star, testId: "link-pre-approval" },
      { title: "My Journey", href: "/onboarding", icon: Rocket, testId: "link-onboarding" },
      { title: "Gap Calculator", href: "/gap-calculator", icon: Calculator, testId: "link-gap-calculator" },
      // The rent-ledger surface — shipped 2026-08-17 with no inbound nav at all.
      { title: "My Lease", href: "/my-lease", icon: ClipboardList, testId: "link-my-lease" },
      { title: "Down Payment Help", href: "/down-payment-wizard", icon: PiggyBank, testId: "link-dpa-wizard" },
    ],
  },
];

const activeBuyerNavigation: NavSection[] = [
  {
    section: "My Mortgage",
    items: [
      { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard, testId: "link-borrower-dashboard" },
      { title: "To-Do", href: "/tasks", icon: CheckSquare, testId: "link-tasks", showBadge: true },
      { title: "Documents", href: "/documents", icon: Upload, testId: "link-documents" },
      { title: "Homi", href: "/ai-coach", brandMark: true, testId: "link-ai-coach" },
      { title: "Messages", href: "/messages", icon: MessageCircle, testId: "link-messages", showMessageBadge: true },
    ],
  },
  {
    section: "Progress",
    items: [
      { title: "My Journey", href: "/onboarding", icon: Rocket, testId: "link-onboarding" },
      { title: "My Profile", href: "/profile", icon: CircleUser, testId: "link-my-profile" },
      { title: "Application Details", href: "/application-summary", icon: FileText, testId: "link-application-summary" },
      { title: "Verification", href: "/verification", icon: Shield, testId: "link-verification" },
    ],
  },
];

const staffNavigation: NavSection[] = [
  {
    section: "Operations",
    items: [
      { title: "Dashboard", href: "/staff-dashboard", icon: LayoutDashboard, testId: "link-staff-overview" },
      { title: "LO Command Center", href: "/lo-command-center", icon: Gauge, testId: "link-lo-command-center" },
      // Task/Policy/Pricing governance is requireRole("admin","underwriter") on the
      // server — only show the links to roles that can actually load the pages.
      // The gate is shared with the router (ROUTE_GATES.underwriterOps) so the
      // nav can't offer a link the route would bounce.
      { title: "Task Operations", href: "/task-operations", icon: ListTodo, testId: "link-task-operations", roles: ROUTE_GATES.underwriterOps },
      { title: "Policy Operations", href: "/policy-ops", icon: Scale, testId: "link-policy-ops", roles: ROUTE_GATES.underwriterOps },
      { title: "Pricing Matrices", href: "/pricing-matrices", icon: Grid3x3, testId: "link-pricing-matrices", roles: ROUTE_GATES.underwriterOps },
      { title: "Pricing Intelligence", href: "/pricing-intelligence", icon: BarChart3, testId: "link-pricing-intelligence", roles: ROUTE_GATES.marketData },
      { title: "Messages", href: "/messages", icon: MessageCircle, testId: "link-messages", showMessageBadge: true },
    ],
  },
  {
    section: "Partners",
    items: [
      { title: "Broker Dashboard", href: "/broker-dashboard", icon: DollarSign, testId: "link-broker-dashboard" },
      { title: "Client Pipeline", href: "/agent-pipeline", icon: ClipboardList, testId: "link-agent-pipeline" },
      // Application invites are an LO-team tool (POST is admin/lo/loa on the server).
      { title: "Invite Clients", href: "/invite-clients", icon: Link2, testId: "link-invite-clients", roles: ROUTE_GATES.loTeam },
      { title: "Co-Branding", href: "/co-branding", icon: Palette, testId: "link-co-branding" },
    ],
  },
];

// External partners (broker, lender) get a partner-only nav — the internal
// operations links (Task/Policy Operations, Pricing Matrices) don't apply to them.
// No "Invite Clients" here either: application invites are an LO-team tool;
// partners refer clients through their referral code on the Broker Dashboard.
const partnerNavigation: NavSection[] = [
  {
    section: "Partner",
    items: [
      { title: "Broker Dashboard", href: "/broker-dashboard", icon: DollarSign, testId: "link-broker-dashboard" },
      { title: "Client Pipeline", href: "/agent-pipeline", icon: ClipboardList, testId: "link-agent-pipeline" },
      { title: "Co-Branding", href: "/co-branding", icon: Palette, testId: "link-co-branding" },
      { title: "Messages", href: "/messages", icon: MessageCircle, testId: "link-messages", showMessageBadge: true },
    ],
  },
];

// CPA partners are a self-registering PARTNER role (not staff). They reach only
// their own portal — inviter-only, no borrower/staff routes — so the nav is a
// single Dashboard entry rather than the borrower nav they'd otherwise inherit.
const cpaNavigation: NavSection[] = [
  {
    section: "Partner",
    items: [
      { title: "CPA Dashboard", href: "/cpa-portal", icon: LayoutDashboard, testId: "link-cpa-portal" },
    ],
  },
];

// Realtor partners (PH-1) — same inviter-only posture, PartnerHub home.
const realtorNavigation: NavSection[] = [
  {
    section: "Partner",
    items: [
      { title: "Partner Hub", href: "/partners/hub", icon: LayoutDashboard, testId: "link-partners-hub" },
    ],
  },
];

const adminNavigation: NavSection[] = [
  {
    section: "Administration",
    items: [
      { title: "Admin Dashboard", href: "/admin", icon: LayoutDashboard, testId: "link-admin" },
      { title: "Manage Users", href: "/admin/users", icon: Users, testId: "link-admin-users" },
      { title: "Partner Waitlist", href: "/admin/partners", icon: Handshake, testId: "link-admin-partners" },
      { title: "Manage Rates", href: "/admin/rates", icon: Percent, testId: "link-admin-rates" },
      { title: "Manage Content", href: "/admin/content", icon: PenSquare, testId: "link-admin-content" },
      { title: "Policy Operations", href: "/admin/policy-ops", icon: Scale, testId: "link-admin-policy-ops" },
      { title: "Pricing Matrices", href: "/admin/pricing-matrices", icon: Grid3x3, testId: "link-admin-pricing-matrices" },
      { title: "Autopilot", href: "/admin/autopilot", icon: Brain, testId: "link-admin-autopilot" },
      { title: "Counterparties", href: "/admin/lenders", icon: Building2, testId: "link-admin-lenders" },
      // Wholesale comp bands live here and are lender data too; the page
      // shipped with the F-17 work but was never linked, so it was
      // reachable only by typing the URL.
      { title: "Pricing Policy", href: "/admin/pricing-policy", icon: Percent, testId: "link-admin-pricing-policy" },
      { title: "Financial Reports", href: "/admin/financial-reports", icon: Scale, testId: "link-admin-financial-reports" },
    ],
  },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { user } = useAuth();
  const [isHelpExpanded, setIsHelpExpanded] = useState(false);

  const { data: teamMembers = [], isLoading: teamLoading } = useQuery<TeamMember[]>({
    queryKey: ["/api/team-members"],
    enabled: !!user,
    refetchInterval: 30000,
  });

  // Messages and notifications are shell-level. Borrower actions are scoped to
  // the selected application and use the same payload as What to do next.
  const badges = useShellBadges();
  const unreadCount = badges.unreadMessages;

  const isActive = (href: string) => {
    if (href === "/messages") return location === href || location.startsWith("/messages/");
    return location === href;
  };

  const userRole = user?.role || "";
  const isStaff = isStaffRole(userRole);
  const isInternalStaff = isInternalStaffRole(userRole);
  const isSelfServicePartner = isPartnerRole(userRole);
  const isAdmin = userRole === "admin";
  const isAspiringOwner = userRole === "aspiring_owner";
  const { data: borrowerActions } = useActiveBorrowerActionItems(!isStaff && !isSelfServicePartner);
  const pendingTaskCount = isStaff ? 0 : borrowerActions?.stats.total ?? 0;

  let navigation: NavSection[];
  if (isInternalStaff) {
    navigation = staffNavigation;
  } else if (isStaff) {
    navigation = partnerNavigation;
  } else if (isSelfServicePartner) {
    navigation = userRole === "realtor" ? realtorNavigation : cpaNavigation;
  } else if (isAspiringOwner) {
    navigation = aspiringOwnerNavigation;
  } else {
    navigation = activeBuyerNavigation;
  }

  const isBroker = userRole === "broker";
  const isLender = userRole === "lender";

  const portalLabel = isAdmin
    ? "Admin Portal"
    : isBroker
      ? "Broker Portal"
      : isLender
        ? "Lender Portal"
        : isStaff
          ? "Staff Portal"
          : isSelfServicePartner
            ? ROLE_DISPLAY_NAMES[userRole as keyof typeof ROLE_DISPLAY_NAMES] ?? "Partner"
            : isAspiringOwner
              ? "Aspiring Owner"
              : "Active Buyer";

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="px-2 py-4">
          <Logo size="sm" tone="onDark" data-testid="logo-sidebar" />
          <p className="text-xs text-muted-foreground">
            {portalLabel}
          </p>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {navigation.map((section) => {
          // `.some(r => r === userRole)` rather than `.includes(userRole)`:
          // userRole is a bare string off the user record, and this matches how
          // PrivateLayout tests the same gate.
          const visibleItems = section.items.filter(
            (item) => !item.roles || item.roles.some((r) => r === userRole),
          );
          if (visibleItems.length === 0) return null;
          return (
          <SidebarGroup key={section.section}>
            <SidebarGroupLabel>{section.section}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {visibleItems.map((item) => (
                  <SidebarMenuItem key={`${section.section}-${item.title}`}>
                    <SidebarMenuButton asChild isActive={isActive(item.href)}>
                      <Link href={item.href} className="cursor-pointer" data-testid={item.testId}>
                        {item.brandMark
                          ? <Logo size="sm" variant="mark" tone="onDark" data-testid="logo-sidebar-homi" />
                          : item.icon ? <item.icon className="h-4 w-4" /> : null}
                        <span>{item.title}</span>
                        {item.showBadge && pendingTaskCount > 0 && (
                          <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-xs font-medium text-warning-foreground" data-testid="badge-pending-tasks">
                            {pendingTaskCount > 99 ? '99+' : pendingTaskCount}
                          </span>
                        )}
                        {item.showMessageBadge && unreadCount > 0 && (
                          <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground" data-testid="badge-unread-count">
                            {unreadCount > 99 ? '99+' : unreadCount}
                          </span>
                        )}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          );
        })}

        {isAdmin && adminNavigation.map((section) => (
          <SidebarGroup key={section.section}>
            <SidebarGroupLabel>{section.section}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => (
                  <SidebarMenuItem key={`${section.section}-${item.title}`}>
                    <SidebarMenuButton asChild isActive={isActive(item.href)}>
                      <Link href={item.href} className="cursor-pointer" data-testid={item.testId}>
                        {item.brandMark
                          ? <Logo size="sm" variant="mark" tone="onDark" data-testid="logo-sidebar-homi-admin" />
                          : item.icon ? <item.icon className="h-4 w-4" /> : null}
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        {!isStaff && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    onClick={() => setIsHelpExpanded(!isHelpExpanded)}
                    data-testid="button-help-toggle"
                  >
                    <HelpCircle className="h-4 w-4" />
                    <span>Your Team</span>
                    <div className="ml-auto">
                      {isHelpExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </div>
                  </SidebarMenuButton>
                  {isHelpExpanded && (
                    <SidebarMenuSub>
                      {teamLoading && teamMembers.length === 0 ? (
                        [1, 2].map((i) => (
                          <SidebarMenuSubItem key={i}>
                            <div className="flex items-center gap-2 px-2 py-1.5" data-testid="team-loading">
                              <Skeleton className="h-6 w-6 rounded-full" />
                              <div className="flex-1 space-y-1">
                                <Skeleton className="h-3 w-20" />
                                <Skeleton className="h-2.5 w-14" />
                              </div>
                            </div>
                          </SidebarMenuSubItem>
                        ))
                      ) : teamMembers.length > 0 ? (
                        teamMembers.map((member) => (
                          <SidebarMenuSubItem key={member.id}>
                            <SidebarMenuSubButton asChild>
                              <Link
                                href={`/messages/${member.id}`}
                                className="cursor-pointer flex items-center gap-2"
                                data-testid={`link-help-team-${member.id}`}
                              >
                                <div className="relative">
                                  <Avatar className="h-6 w-6">
                                    <AvatarFallback className="text-xs bg-primary/10 text-primary">
                                      {member.initials}
                                    </AvatarFallback>
                                  </Avatar>
                                  <Circle
                                    className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 fill-current ${getPresenceColor(member.presenceStatus)}`}
                                  />
                                </div>
                                <div className="flex flex-col min-w-0">
                                  <span className="text-sm truncate">{member.name}</span>
                                  <span className="text-xs text-muted-foreground truncate">{ROLE_DISPLAY_NAMES[member.role as keyof typeof ROLE_DISPLAY_NAMES] || member.role}</span>
                                </div>
                              </Link>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))
                      ) : (
                        <SidebarMenuSubItem>
                          <div className="px-2 py-2 text-sm text-muted-foreground">
                            No team assigned yet
                          </div>
                        </SidebarMenuSubItem>
                      )}
                    </SidebarMenuSub>
                  )}
                </SidebarMenuItem>

                <SidebarMenuItem>
                  <SidebarMenuButton asChild isActive={isActive("/resources")}>
                    <Link href="/resources" className="cursor-pointer" data-testid="link-learn">
                      <GraduationCap className="h-4 w-4" />
                      <span>Learn</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="cursor-pointer"
              data-testid="link-logout"
              onClick={() => void logout()}
            >
              <LogOut className="h-4 w-4" />
              <span>Log Out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
