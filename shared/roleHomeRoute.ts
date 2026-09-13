import { isStaffRole } from "./roles";

// Post-login landing route for a given role. This module is shared by the
// browser and server OAuth callback so every successful login lands in the
// same role-specific workspace.
export function getRoleHomeRoute(role: string): string {
  if (role === "admin") return "/admin";
  if (role === "broker") return "/broker-dashboard";
  if (role === "cpa") return "/cpa-portal";
  if (role === "realtor") return "/partners/hub";
  if (role === "lo" || role === "loa") return "/lo-command-center";
  if (isStaffRole(role)) return "/staff-dashboard";
  return "/dashboard";
}
