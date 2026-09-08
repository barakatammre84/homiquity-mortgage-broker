import { Link, useLocation } from "wouter";
import { logout } from "@/lib/logout";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { dashboardKeys } from "@/lib/queryClient";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LayoutDashboard, Menu, X, Phone, ChevronDown, Home, Calculator, FileText, Percent, ArrowRight, Users, Gauge, CircleUser } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { PRELAUNCH_GATED } from "@/lib/prelaunch";
import { COMPANY_IDENTITY, contactPhoneTel } from "@shared/companyIdentity";
import { Logo } from "@/components/brand/Logo";

interface NavItem {
  href: string;
  label: string;
  description?: string;
  icon?: React.ComponentType<{ className?: string }>;
}

const buyMenuItems: NavItem[] = [
  { href: "/apply", label: "Get Pre-Approved", description: "Takes about 3 minutes", icon: FileText },
  { href: "/approval-strength", label: "Approval Strength", description: "See where you stand before you apply", icon: Gauge },
  { href: "/rates/purchase", label: "Today's Rates", description: "Current purchase rates", icon: Percent },
  { href: "/calculators/affordability", label: "Affordability Calculator", description: "See what fits your budget", icon: Calculator },
  { href: "/calculators/rent-to-own", label: "Rent-to-Own Readiness", description: "Turn your rent into a mortgage", icon: Home },
  { href: "/find-an-agent", label: "Find an Agent", description: "Get matched with a local expert", icon: Users },
];

const refinanceMenuItems: NavItem[] = [
  { href: "/apply?type=refinance", label: "Refinance", description: "See if you can lower your payment", icon: FileText },
  { href: "/apply?type=heloc", label: "Apply for HELOC", description: "Tap into your home equity", icon: FileText },
  { href: "/rates/cash-out", label: "Cash-Out Rates", description: "Current cash-out rates", icon: Percent },
  { href: "/rates/heloc", label: "HELOC Rates", description: "Current HELOC rates", icon: Percent },
];

interface NavDropdownProps {
  label: string;
  items: NavItem[];
  testId: string;
}

function NavDropdown({ label, items, testId }: NavDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [, navigate] = useLocation();

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <button
        className={cn(
          "flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors",
          "text-foreground/80 hover:text-foreground",
          isOpen && "text-foreground"
        )}
        data-testid={testId}
      >
        {label}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", isOpen && "rotate-180")} />
      </button>

      <div className={cn(
        "absolute left-0 top-full pt-2 transition-opacity duration-150",
        isOpen ? "opacity-100 visible" : "opacity-0 invisible pointer-events-none"
      )}>
        <div className="w-72 rounded-xl border bg-card p-2 shadow-xl">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.href + item.label}
                onClick={() => {
                  navigate(item.href);
                  setIsOpen(false);
                }}
                className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted"
                data-testid={`nav-dropdown-${label.toLowerCase()}-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
              >
                {Icon && (
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Icon className="h-4 w-4 text-primary" />
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium text-foreground">{item.label}</p>
                  {item.description && (
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MobileNavSection({ label, items, onItemClick }: { label: string; items: NavItem[]; onItemClick: () => void }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-b border-border py-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between py-2 text-left"
        data-testid={`mobile-nav-${label.toLowerCase()}`}
      >
        <span className="font-medium text-foreground">{label}</span>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform duration-200", isOpen && "rotate-180")} />
      </button>
      {isOpen && (
        <div className="flex flex-col gap-1 pb-2 pl-4">
          {items.map((item) => (
            <Link
              key={item.href + item.label}
              href={item.href}
              className="inline-block w-full py-2 text-left text-sm text-muted-foreground hover:text-foreground"
              onClick={onItemClick}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function Navigation() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [location] = useLocation();

  const { data: dashboardData } = useQuery<{ applications: Array<{ id: number; status: string }> }>({
    queryKey: dashboardKeys.root(),
    enabled: isAuthenticated && !location.startsWith("/apply") && !location.startsWith("/dashboard"),
  });

  // "draft" is the only resumable status — the old check matched statuses no
  // backend path writes ("under_review", "pending") and treated submitted
  // applications as resumable, so the banner showed for the wrong people.
  const hasDraft = dashboardData?.applications?.some(
    (app) => app.status === "draft"
  );

  return (
    <nav className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {isAuthenticated && hasDraft && !location.startsWith("/dashboard") && !location.startsWith("/apply") && (
        <div className="bg-primary/10 border-b border-primary/20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4 py-2">
            <span className="text-sm text-foreground/80" data-testid="text-resume-banner">
              You have an application in progress
            </span>
            <Button asChild variant="ghost" size="sm" className="touch-target gap-1 text-primary text-sm font-medium" data-testid="button-resume-app">
              <Link href="/dashboard">
                Resume <ArrowRight className="h-3 w-3" />
              </Link>
            </Button>
          </div>
        </div>
      )}
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Two lockups, one visible at a time. Below sm the full lockup does
              not fit: it needs 139px (22 mark + 8 gap + 109 wordmark) beside a
              135px CTA and a 44px menu button, which is 358px of header in a
              320px viewport. It did not overflow the page — `.touch-target`
              sets `min-width: 44px`, replacing this flex item's default
              `min-width: auto`, so the link shrank to 101px and 38px of the
              brand rendered UNDER the CTA instead. Measured, not inferred.

              `shrink-0` alone is not the fix here: it removes the spill but
              then the header really does overflow (342px right edge at 320px).
              The mark alone is 22px and leaves a 57px gap, and Logo's own note
              says the compact mark stays legible to 16px.

              Rendering both rather than hiding the wordmark inside one Logo is
              deliberate: `variant="mark"` is what adds `role="img"` +
              `aria-label`, so hiding just the wordmark span would leave the
              link with NO accessible name on phones. `display:none` keeps
              exactly one of these in the a11y tree at any width. */}
          <Link href="/" className="touch-target flex shrink-0 items-center">
            <Logo size="lg" tone="brand" variant="mark" className="sm:hidden" data-testid="logo-nav-mark" />
            <Logo size="lg" tone="brand" className="hidden sm:inline-flex" data-testid="logo-nav" />
          </Link>

          <div className="hidden items-center gap-1 lg:flex">
            {!PRELAUNCH_GATED && (
              <>
                <NavDropdown label="Buy" items={buyMenuItems} testId="nav-dropdown-buy" />
                <NavDropdown label="Refinance & HELOC" items={refinanceMenuItems} testId="nav-dropdown-refinance" />
                <Link
                  href="/rates"
                  className="inline-block px-4 py-2 text-sm font-medium text-foreground/80 hover:text-foreground"
                >
                  Rates
                </Link>
              </>
            )}
            {/* Calculators stay visible even in gated pre-launch mode — they are
                free educational tools, not the rate/pricing/application funnel. */}
            <Link
              href="/calculators"
              className="inline-block px-4 py-2 text-sm font-medium text-foreground/80 hover:text-foreground"
            >
              Calculators
            </Link>
            <Link
              href="/resources"
              className="inline-block px-4 py-2 text-sm font-medium text-foreground/80 hover:text-foreground"
            >
              Resources
            </Link>
            <Link
              href="/glossary"
              className="inline-block px-4 py-2 text-sm font-medium text-foreground/80 hover:text-foreground"
            >
              Glossary
            </Link>
          </div>

          <div className="flex items-center gap-2">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="touch-target hidden gap-2 text-muted-foreground hover:text-foreground sm:inline-flex"
              data-testid="button-phone"
            >
              <a href={contactPhoneTel()}>
                <Phone className="h-4 w-4" />
                <span className="hidden md:inline">{COMPANY_IDENTITY.contactPhone}</span>
              </a>
            </Button>

            {isLoading ? (
              <div className="h-9 w-20 animate-pulse rounded-lg bg-muted" />
            ) : isAuthenticated && user ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="touch-target gap-2" data-testid="user-menu-button">
                    <Avatar className="h-7 w-7">
                      <AvatarImage src={user.profileImageUrl || undefined} alt={user.firstName || "User"} />
                      <AvatarFallback className="bg-primary text-xs text-primary-foreground">
                        {user.firstName?.[0] || user.email?.[0]?.toUpperCase() || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <span className="hidden text-sm font-medium md:inline">
                      {user.firstName || "Account"}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <div className="flex items-center gap-3 p-3">
                    <Avatar className="h-10 w-10">
                      <AvatarImage src={user.profileImageUrl || undefined} />
                      <AvatarFallback className="bg-primary text-primary-foreground">
                        {user.firstName?.[0] || user.email?.[0]?.toUpperCase() || "U"}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      {user.firstName && (
                        <p className="text-sm font-medium" data-testid="text-user-name">
                          {user.firstName} {user.lastName}
                        </p>
                      )}
                      {user.email && (
                        <p className="text-xs text-muted-foreground" data-testid="text-user-email">
                          {user.email}
                        </p>
                      )}
                    </div>
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link href="/dashboard" className="w-full cursor-pointer" data-testid="menu-dashboard">
                      <LayoutDashboard className="mr-2 h-4 w-4" />
                      Dashboard
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/ai-coach" className="w-full cursor-pointer" data-testid="menu-ai-coach">
                      <Logo size="sm" variant="mark" className="mr-2" data-testid="logo-menu-homi" />
                      Homi
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/profile" className="w-full cursor-pointer" data-testid="menu-my-profile">
                      <CircleUser className="mr-2 h-4 w-4" />
                      My Profile
                    </Link>
                  </DropdownMenuItem>
                  {user.role === "admin" && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem asChild>
                        <Link href="/admin" className="w-full cursor-pointer" data-testid="menu-admin">
                          <LayoutDashboard className="mr-2 h-4 w-4" />
                          Admin Panel
                        </Link>
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="w-full cursor-pointer text-destructive"
                    data-testid="button-logout"
                    onClick={() => void logout()}
                  >
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="flex items-center gap-2">
                <Button asChild
                    variant="ghost"
                    size="sm"
                    className="touch-target hidden text-foreground/80 hover:text-foreground sm:inline-flex"
                    data-testid="button-login"
                  >
                  <Link href="/login">
                    Sign in
                  </Link>
                </Button>
                {!PRELAUNCH_GATED && (
                  <Button asChild
                      size="sm"
                      className="touch-target font-semibold"
                      data-testid="button-get-started"
                    >
                    <Link href="/apply">
                      Get Pre-Approved
                    </Link>
                  </Button>
                )}
              </div>
            )}

            <Button
              variant="ghost"
              size="icon"
              aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
              aria-expanded={mobileMenuOpen}
              className="lg:hidden"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              data-testid="button-mobile-menu"
            >
              {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </Button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="border-t py-4 lg:hidden">
            <div className="flex flex-col">
              {!PRELAUNCH_GATED && (
                <>
                  <MobileNavSection label="Buy" items={buyMenuItems} onItemClick={() => setMobileMenuOpen(false)} />
                  <MobileNavSection label="Refinance & HELOC" items={refinanceMenuItems} onItemClick={() => setMobileMenuOpen(false)} />
                  <Link
                    href="/rates"
                    className="inline-block w-full border-b border-border py-4 text-left font-medium text-foreground"
                    onClick={() => setMobileMenuOpen(false)}
                  >
                    Rates
                  </Link>
                </>
              )}
              <Link
                href="/calculators"
                className="inline-block w-full border-b border-border py-4 text-left font-medium text-foreground"
                onClick={() => setMobileMenuOpen(false)}
              >
                Calculators
              </Link>
              <Link
                href="/resources"
                className="inline-block w-full border-b border-border py-4 text-left font-medium text-foreground"
                onClick={() => setMobileMenuOpen(false)}
              >
                Resources
              </Link>
              <Link
                href="/glossary"
                className="inline-block w-full py-4 text-left font-medium text-foreground"
                onClick={() => setMobileMenuOpen(false)}
              >
                Glossary
              </Link>

              {isAuthenticated ? (
                <div className="mt-4 flex flex-col gap-1">
                  <Link
                    href="/dashboard"
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-3 text-left text-sm font-medium text-foreground hover-elevate"
                    onClick={() => setMobileMenuOpen(false)}
                    data-testid="mobile-link-dashboard"
                  >
                    <LayoutDashboard className="h-4 w-4 text-muted-foreground" />
                    Dashboard
                  </Link>
                  <div className="mt-2 border-t pt-3">
                    <Button
                      variant="outline"
                      size="lg"
                      className="w-full text-destructive"
                      data-testid="mobile-button-logout"
                      onClick={() => {
                        setMobileMenuOpen(false);
                        void logout();
                      }}
                    >
                      Sign out
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-4 flex flex-col gap-3">
                  <Button asChild variant="outline" size="lg" className="w-full" onClick={() => setMobileMenuOpen(false)} data-testid="mobile-button-login">
                    <Link href="/login">
                      Sign in
                    </Link>
                  </Button>
                  {!PRELAUNCH_GATED && (
                    <Button asChild size="lg" className="w-full font-semibold" onClick={() => setMobileMenuOpen(false)} data-testid="mobile-button-apply">
                      <Link href="/apply">
                        Get Pre-Approved
                      </Link>
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
