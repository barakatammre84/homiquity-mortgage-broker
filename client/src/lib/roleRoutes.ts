// Post-login landing route for a given role. Single source of truth so the login
// flow, OAuth callback, and tests can't drift.
//
// - admin        -> admin console
// - broker       -> its own referral/commission dashboard
// - cpa          -> its own inviter-only partner portal
// - realtor      -> PartnerHub (PH-1), the self-service partner home
// - lender       -> deferred persona: falls through to the staff route, which renders
//                   a neutral partner landing for non-internal-staff (no product surface yet)
// - lo / loa     -> streamlined deal desk (the daily sales + file workspace)
// - other staff  -> internal operations dashboard
// - clients      -> borrower dashboard
export { getRoleHomeRoute } from "@shared/roleHomeRoute";
