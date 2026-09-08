import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";

import { useAuth } from "@/hooks/useAuth";
import { PRELAUNCH_GATED } from "@/lib/prelaunch";
import { dashboardKeys } from "@/lib/queryClient";

const EDITORIAL_LINKS = [
  { href: "#mortgage-pathways", label: "Mortgages" },
  { href: "#pathways", label: "Who we help" },
  { href: "/about", label: "About" },
  { href: "/resources", label: "Resources" },
] as const;

/** Landing-only navigation. Keeping this out of the global shell means the
 * editorial homepage does not add its markup to the eager bundle downloaded by
 * borrowers who open the application, dashboard, or a deep link directly. */
export function EditorialNavigation() {
  const { isAuthenticated, isLoading } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [location] = useLocation();
  const { data: dashboardData } = useQuery<{ applications: Array<{ id: number; status: string }> }>({
    queryKey: dashboardKeys.root(),
    enabled: isAuthenticated,
  });
  const hasDraft = dashboardData?.applications?.some((app) => app.status === "draft");
  const navHref = (href: string) => href.startsWith("#") && location !== "/" ? `/${href}` : href;

  return (
    <nav className="sticky top-0 z-50 w-full border-b border-precision-100 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85" data-testid="navigation-editorial">
      {isAuthenticated && hasDraft && !location.startsWith("/dashboard") && !location.startsWith("/apply") && (
        <div className="border-b border-primary/20 bg-primary/10">
          <div className="mx-auto flex max-w-screen-2xl items-center justify-between gap-4 px-5 py-2 sm:px-8 lg:px-12 2xl:px-20">
            <span className="text-sm text-foreground/80" data-testid="text-resume-banner">You have an application in progress</span>
            <Link href="/dashboard" className="touch-target inline-flex items-center text-sm font-semibold underline decoration-2 underline-offset-4" data-testid="button-resume-app">Resume</Link>
          </div>
        </div>
      )}

      <div className="mx-auto flex h-20 max-w-screen-2xl items-center justify-between gap-5 px-5 sm:px-8 lg:h-24 lg:px-12 2xl:px-20">
        <Link href="/" className="touch-target flex shrink-0 items-center font-serif text-3xl font-bold tracking-tighter text-foreground sm:text-4xl" aria-label="Homiquity home" data-testid="logo-nav-editorial">
          Homiquity
        </Link>

        <div className="hidden items-center gap-6 lg:flex xl:gap-8">
          {EDITORIAL_LINKS.map((item) => (
            <Link key={item.href} href={navHref(item.href)} className="touch-target inline-flex items-center text-sm font-medium text-foreground/80 hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </div>

        <div className="ml-auto hidden items-center gap-4 sm:flex">
          {isLoading ? (
            <div className="h-11 w-24 animate-pulse bg-precision-100" />
          ) : isAuthenticated ? (
            <Link href="/dashboard" className="touch-target inline-flex items-center px-3 text-sm font-medium text-foreground" data-testid="editorial-link-dashboard">Dashboard</Link>
          ) : (
            <Link href="/login" className="touch-target inline-flex items-center px-3 text-sm font-medium text-foreground" data-testid="button-login">Log in</Link>
          )}
          {!PRELAUNCH_GATED && (
            <Link href="/apply" className="touch-target inline-flex min-h-12 items-center justify-center bg-flare-ink px-7 text-sm font-semibold text-primary-foreground transition-colors hover:bg-flare-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" data-testid="button-get-started">
              Get started
            </Link>
          )}
        </div>

        <button type="button" aria-label={mobileMenuOpen ? "Close menu" : "Open menu"} aria-expanded={mobileMenuOpen} className="touch-target inline-flex items-center justify-center text-foreground lg:hidden" onClick={() => setMobileMenuOpen((open) => !open)} data-testid="button-mobile-menu">
          <span aria-hidden="true" className="relative block h-5 w-5">
            {mobileMenuOpen ? (
              <>
                <span className="absolute left-0 top-2.5 block h-px w-5 rotate-45 bg-current" />
                <span className="absolute left-0 top-2.5 block h-px w-5 -rotate-45 bg-current" />
              </>
            ) : (
              <>
                <span className="absolute left-0 top-1 block h-px w-5 bg-current" />
                <span className="absolute left-0 top-2.5 block h-px w-5 bg-current" />
                <span className="absolute bottom-1 left-0 block h-px w-5 bg-current" />
              </>
            )}
          </span>
        </button>
      </div>

      {mobileMenuOpen && (
        <div className="border-t border-precision-100 bg-background px-5 py-5 lg:hidden">
          <div className="mx-auto flex max-w-screen-2xl flex-col">
            {EDITORIAL_LINKS.map((item) => (
              <Link key={item.href} href={navHref(item.href)} className="touch-target flex items-center border-b border-precision-100 py-3 font-medium" onClick={() => setMobileMenuOpen(false)}>
                {item.label}
              </Link>
            ))}
            <Link href={isAuthenticated ? "/dashboard" : "/login"} className="touch-target mt-3 flex items-center font-medium" onClick={() => setMobileMenuOpen(false)} data-testid={isAuthenticated ? "mobile-link-dashboard" : "mobile-button-login"}>
              {isAuthenticated ? "Dashboard" : "Log in"}
            </Link>
            {!PRELAUNCH_GATED && (
              <Link href="/apply" className="touch-target mt-4 flex min-h-12 items-center justify-center bg-flare-ink px-6 font-semibold text-primary-foreground" onClick={() => setMobileMenuOpen(false)} data-testid="mobile-button-apply">
                Get started
              </Link>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
