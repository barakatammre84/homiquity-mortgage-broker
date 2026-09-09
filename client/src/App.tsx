import { lazy, Suspense, useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PublicLayout } from "@/components/layouts/PublicLayout";
import { PrivateLayout } from "@/components/layouts/PrivateLayout";
import { BareLayout } from "@/components/layouts/BareLayout";
import { Loader2 } from "lucide-react";
import { PRELAUNCH_GATED } from "@/lib/prelaunch";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { ROUTE_GATES } from "@/lib/routeGates";

// Lazy — this modal is the only eager import that pulls framer-motion, so
// loading it eagerly shipped the whole animation library in the main chunk on
// every page. It only appears on education/content paths, so we both lazy-load
// it AND gate the mount on those paths (below) — otherwise React would still
// fetch the chunk on every page just because the component sits in the tree.
const EmailCaptureModal = lazy(() =>
  import("@/components/EmailCaptureModal").then((m) => ({ default: m.EmailCaptureModal })),
);

// Paths where the email-capture modal can trigger (mirrors the allowlist inside
// the modal). Kept here so the chunk is never fetched elsewhere.
const EMAIL_CAPTURE_PATHS = [
  "/resources",
  "/learn",
  "/education",
  "/down-payment-wizard",
  "/article",
  "/faq",
];

function EmailCaptureGate() {
  const [location] = useLocation();
  if (!EMAIL_CAPTURE_PATHS.some((p) => location.startsWith(p))) return null;
  return (
    <Suspense fallback={null}>
      <EmailCaptureModal />
    </Suspense>
  );
}

const Landing = lazy(() => import("@/pages/public/Landing"));
const Refinance = lazy(() => import("@/pages/public/Refinance"));
const VALoans = lazy(() => import("@/pages/public/VALoans"));
const SelfEmployed = lazy(() => import("@/pages/public/SelfEmployed"));
const FirstTimeBuyer = lazy(() => import("@/pages/public/FirstTimeBuyer"));
const Privacy = lazy(() => import("@/pages/public/Privacy"));
const Terms = lazy(() => import("@/pages/public/Terms"));
const Disclosures = lazy(() => import("@/pages/public/Disclosures"));
const TestLogin = lazy(() => import("@/pages/public/TestLogin"));
const RedeemInvite = lazy(() => import("@/pages/public/RedeemInvite"));
const Login = lazy(() => import("@/pages/public/Login"));
const Signup = lazy(() => import("@/pages/public/Signup"));
const ForgotPassword = lazy(() => import("@/pages/public/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/public/ResetPassword"));
const VerifyEmail = lazy(() => import("@/pages/public/VerifyEmail"));
const AffordabilityCheck = lazy(() => import("@/pages/public/AffordabilityCheck"));
const ApprovalStrength = lazy(() => import("@/pages/public/ApprovalStrength"));
const Waitlist = lazy(() => import("@/pages/public/Waitlist"));
const PartnerWaitlist = lazy(() => import("@/pages/public/PartnerWaitlist"));
const RentReporting = lazy(() => import("@/pages/public/RentReporting"));

const PreApproval = lazy(() => import("@/pages/lending/PreApproval"));
const LoanOptions = lazy(() => import("@/pages/lending/LoanOptions"));
const LoanPipeline = lazy(() => import("@/pages/lending/LoanPipeline"));
const LoanEstimate = lazy(() => import("@/pages/lending/LoanEstimate"));
const ApplicationSummary = lazy(() => import("@/pages/lending/ApplicationSummary"));
const BorrowerDealComparison = lazy(() => import("@/pages/lending/BorrowerDealComparison"));

const Dashboard = lazy(() => import("@/pages/borrower/Dashboard"));
const Documents = lazy(() => import("@/pages/borrower/Documents"));
const Tasks = lazy(() => import("@/pages/borrower/Tasks"));
const TaskDetail = lazy(() => import("@/pages/borrower/TaskDetail"));
const Messages = lazy(() => import("@/pages/borrower/Messages"));
const URLAForm = lazy(() => import("@/pages/borrower/URLAForm"));
const CreditConsent = lazy(() => import("@/pages/borrower/CreditConsent"));
const AdverseActionNotice = lazy(() => import("@/pages/borrower/AdverseActionNotice"));
const Verification = lazy(() => import("@/pages/borrower/Verification"));
const IdentityVerification = lazy(() => import("@/pages/borrower/IdentityVerification"));
const OnboardingJourney = lazy(() => import("@/pages/borrower/OnboardingJourney"));
const EConsent = lazy(() => import("@/pages/borrower/EConsent"));
const GapCalculator = lazy(() => import("@/pages/borrower/GapCalculator"));
const MyLease = lazy(() => import("@/pages/borrower/MyLease"));
const BuyerProperties = lazy(() => import("@/pages/borrower/BuyerProperties"));
const HmdaDemographics = lazy(() => import("@/pages/borrower/HmdaDemographics"));

const StaffDashboard = lazy(() => import("@/pages/staff/StaffDashboard"));
const LoCommandCenter = lazy(() => import("@/pages/staff/LoCommandCenter"));
const BorrowerFile = lazy(() => import("@/pages/staff/BorrowerFile"));
const PolicyOps = lazy(() => import("@/pages/staff/PolicyOps"));
const PricingMatrices = lazy(() => import("@/pages/staff/PricingMatrices"));
const PricingIntelligence = lazy(() => import("@/pages/staff/PricingIntelligence"));
const TaskOperations = lazy(() => import("@/pages/staff/TaskOperations"));
const DesignPrototype = lazy(() => import("@/pages/staff/DesignPrototype"));

const AgentCoBranding = lazy(() => import("@/pages/agent-broker/AgentCoBranding"));
const AgentDashboard = lazy(() => import("@/pages/agent-broker/AgentDashboard"));
const AgentEdit = lazy(() => import("@/pages/agent-broker/AgentEdit"));
const AgentPipeline = lazy(() => import("@/pages/agent-broker/AgentPipeline"));
const BrokerDashboard = lazy(() => import("@/pages/agent-broker/BrokerDashboard"));
const InviteGenerator = lazy(() => import("@/pages/agent-broker/InviteGenerator"));
const PartnerServices = lazy(() => import("@/pages/agent-broker/PartnerServices"));
const ReferralLanding = lazy(() => import("@/pages/agent-broker/ReferralLanding"));
const PartnerLanding = lazy(() => import("@/pages/agent-broker/PartnerLanding"));
const ApplyInvite = lazy(() => import("@/pages/agent-broker/ApplyInvite"));
const FindAnAgent = lazy(() => import("@/pages/agent-broker/FindAnAgent"));
const CpaPartnerLanding = lazy(() => import("@/pages/agent-broker/CpaPartnerLanding"));
const CpaInviteLanding = lazy(() => import("@/pages/agent-broker/CpaInviteLanding"));
const CpaPortal = lazy(() => import("@/pages/agent-broker/CpaPortal"));
const PartnersJoin = lazy(() => import("@/pages/agent-broker/PartnersJoin"));
const PartnersHub = lazy(() => import("@/pages/agent-broker/PartnersHub"));
const PartnerReferralLanding = lazy(() => import("@/pages/agent-broker/PartnerReferralLanding"));

const ScenarioDesk = lazy(() => import("@/pages/realtor-engine/ScenarioDesk"));
const DealRescue = lazy(() => import("@/pages/realtor-engine/DealRescue"));
const StrategySessions = lazy(() => import("@/pages/realtor-engine/StrategySessions"));
const ClosingGuarantee = lazy(() => import("@/pages/realtor-engine/ClosingGuarantee"));

const Properties = lazy(() => import("@/pages/property/Properties"));
const PropertyDetail = lazy(() => import("@/pages/property/PropertyDetail"));
const LivePropertyDetail = lazy(() => import("@/pages/property/LivePropertyDetail"));
const PropertyForm = lazy(() => import("@/pages/property/PropertyForm"));

const FirstTimeBuyerHub = lazy(() => import("@/pages/education/FirstTimeBuyerHub"));
const DownPaymentWizard = lazy(() => import("@/pages/education/DownPaymentWizard"));
const LearningCenter = lazy(() => import("@/pages/education/LearningCenter"));
const ArticleDetail = lazy(() => import("@/pages/education/ArticleDetail"));
const FAQ = lazy(() => import("@/pages/education/FAQ"));
const Resources = lazy(() => import("@/pages/education/Resources"));
const AcceleratorProgram = lazy(() => import("@/pages/education/AcceleratorProgram"));
const AICoach = lazy(() => import("@/pages/education/AICoach"));
const Profile = lazy(() => import("@/pages/profile/Profile"));
const Glossary = lazy(() => import("@/pages/education/Glossary"));

const HomeownerDashboard = lazy(() => import("@/pages/homeowner/HomeownerDashboard"));

const PurchaseRates = lazy(() => import("@/pages/rates/PurchaseRates"));
const RefinanceRates = lazy(() => import("@/pages/rates/RefinanceRates"));
const CashOutRates = lazy(() => import("@/pages/rates/CashOutRates"));
const HelocRates = lazy(() => import("@/pages/rates/HelocRates"));
const VaRates = lazy(() => import("@/pages/rates/VaRates"));
const MortgageRates = lazy(() => import("@/pages/rates/MortgageRates"));

const CalculatorsHub = lazy(() => import("@/pages/calculators/CalculatorsHub"));
const RentVsBuyCalculator = lazy(() => import("@/pages/calculators/RentVsBuyCalculator"));
const AffordabilityCalculator = lazy(() => import("@/pages/calculators/AffordabilityCalculator"));
const MortgageCalculator = lazy(() => import("@/pages/calculators/MortgageCalculator"));
const RentToOwnReadiness = lazy(() => import("@/pages/calculators/RentToOwnReadiness"));
const AmortizationCalculator = lazy(() => import("@/pages/calculators/AmortizationCalculator"));
const HomeEquityCalculator = lazy(() => import("@/pages/calculators/HomeEquityCalculator"));
const MortgagePayoffCalculator = lazy(() => import("@/pages/calculators/MortgagePayoffCalculator"));
const DownPaymentCalculator = lazy(() => import("@/pages/calculators/DownPaymentCalculator"));
const BahCalculator = lazy(() => import("@/pages/calculators/BahCalculator"));

const AdminDashboard = lazy(() => import("@/pages/admin/AdminDashboard"));
const AdminRates = lazy(() => import("@/pages/admin/AdminRates"));
const AdminContent = lazy(() => import("@/pages/admin/AdminContent"));
const AdminUsers = lazy(() => import("@/pages/admin/AdminUsers"));
const AutopilotConsole = lazy(() => import("@/pages/admin/AutopilotConsole"));
const AdminPartnerWaitlist = lazy(() => import("@/pages/admin/AdminPartnerWaitlist"));
const FinancialReports = lazy(() => import("@/pages/admin/FinancialReports"));
const PricingPolicy = lazy(() => import("@/pages/admin/PricingPolicy"));
const AdminLenders = lazy(() => import("@/pages/admin/Lenders"));
const AdminPartners = lazy(() => import("@/pages/admin/AdminPartners"));

import NotFound from "@/pages/not-found";

const isProduction = import.meta.env.PROD;

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]" data-testid="page-loader">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function PublicPage({ children }: { children: React.ReactNode }) {
  return <PublicLayout>{children}</PublicLayout>;
}

// Route gates live in @/lib/routeGates — one definition shared with the sidebar,
// so the nav and the router can't disagree about who may reach a page. Each gate
// documents the server-side authorization it mirrors.

function BorrowerPage({ children }: { children: React.ReactNode }) {
  return <PrivateLayout requiredRoles={ROUTE_GATES.borrower}>{children}</PrivateLayout>;
}

function StaffPage({ children }: { children: React.ReactNode }) {
  return <PrivateLayout requiredRoles={ROUTE_GATES.staff}>{children}</PrivateLayout>;
}

function InternalStaffPage({ children }: { children: React.ReactNode }) {
  return <PrivateLayout requiredRoles={ROUTE_GATES.internalStaff}>{children}</PrivateLayout>;
}

function UnderwriterOpsPage({ children }: { children: React.ReactNode }) {
  return <PrivateLayout requiredRoles={ROUTE_GATES.underwriterOps}>{children}</PrivateLayout>;
}

function MarketDataPage({ children }: { children: React.ReactNode }) {
  return <PrivateLayout requiredRoles={ROUTE_GATES.marketData}>{children}</PrivateLayout>;
}

function LoTeamPage({ children }: { children: React.ReactNode }) {
  return <PrivateLayout requiredRoles={ROUTE_GATES.loTeam}>{children}</PrivateLayout>;
}

function CpaPage({ children }: { children: React.ReactNode }) {
  return <PrivateLayout requiredRoles={ROUTE_GATES.cpaPortal}>{children}</PrivateLayout>;
}

function PartnerPage({ children }: { children: React.ReactNode }) {
  return <PrivateLayout requiredRoles={ROUTE_GATES.partnerHub}>{children}</PrivateLayout>;
}

function AdminPage({ children }: { children: React.ReactNode }) {
  return <PrivateLayout requiredRoles={ROUTE_GATES.adminOnly}>{children}</PrivateLayout>;
}

function AnyAuthPage({ children }: { children: React.ReactNode }) {
  return <PrivateLayout>{children}</PrivateLayout>;
}

function Redirect({ to }: { to: string }) {
  const [, navigate] = useLocation();
  useEffect(() => { navigate(to, { replace: true }); }, [to, navigate]);
  return null;
}

// Pre-license gate: a public route that would solicit a mortgage transaction
// (rates, pricing, the application funnel, persona conversion pages) redirects
// to the waitlist "/" while PRELAUNCH_GATED. See knowledge-base/governance/ARMED_LAUNCH_CHARTER_2026-07-07.md.
function Gated({ children }: { children: React.ReactNode }) {
  if (PRELAUNCH_GATED) return <Redirect to="/" />;
  return <>{children}</>;
}

function Router() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Switch>
        {/* Public Pages - Anyone can access */}
        <Route path="/">{PRELAUNCH_GATED ? <Waitlist /> : <Landing />}</Route>
        {/* Dedicated persona conversion pages — render their own SkipLink/main/Footer like Landing */}
        <Route path="/refinance"><Gated><Refinance /></Gated></Route>
        <Route path="/va-loans"><Gated><VALoans /></Gated></Route>
        <Route path="/self-employed"><Gated><SelfEmployed /></Gated></Route>
        <Route path="/first-time-buyer"><Gated><FirstTimeBuyer /></Gated></Route>
        <Route path="/login"><BareLayout><Login /></BareLayout></Route>
        <Route path="/signup"><BareLayout><Signup /></BareLayout></Route>
        <Route path="/forgot-password"><BareLayout><ForgotPassword /></BareLayout></Route>
        <Route path="/reset-password"><BareLayout><ResetPassword /></BareLayout></Route>
        <Route path="/verify-email"><BareLayout><VerifyEmail /></BareLayout></Route>
        {!isProduction && <Route path="/test-login"><BareLayout><TestLogin /></BareLayout></Route>}
        <Route path="/redeem-invite"><BareLayout><RedeemInvite /></BareLayout></Route>
        <Route path="/redeem-invite/:code"><BareLayout><RedeemInvite /></BareLayout></Route>
        {/* PreApproval owns its complete page shell: public navigation on the
            introduction, focused application chrome after the borrower starts,
            and one skip-link/main landmark in both states. Wrapping it in
            BareLayout created a second <main id="main"> and a second skip link,
            which made the public header unreliable at the application door. */}
        <Route path="/apply"><Gated><PreApproval /></Gated></Route>
        <Route path="/apply/:token">
          {(params) => <Gated><BareLayout><ApplyInvite /></BareLayout></Gated>}
        </Route>
        <Route path="/ref/:code">
          {(params) => <Gated><BareLayout><ReferralLanding /></BareLayout></Gated>}
        </Route>
        <Route path="/partner/:profileId">
          {(params) => <Gated><BareLayout><PartnerLanding /></BareLayout></Gated>}
        </Route>
        {/* CPA channel: /for-cpas is B2B partner onboarding (ungated); the client
            invite landing is gated like /ref/:code so it funnels to the waitlist
            during prelaunch. */}
        <Route path="/for-cpas"><BareLayout><CpaPartnerLanding /></BareLayout></Route>
        {/* Partner / center-of-influence waitlist — ungated. Pre-launch we recruit
            the referral network (LOs, lenders, CPAs, agents), not consumer applicants. */}
        <Route path="/partners"><BareLayout><PartnerWaitlist /></BareLayout></Route>
        {/* Rent reporting — pre-launch interest capture, ungated. Email-only waitlist:
            nothing is reported to a bureau and nothing is sold, and the page says so. */}
        <Route path="/rent-reporting"><BareLayout><RentReporting /></BareLayout></Route>
        {/* PartnerHub self-service onboarding (PH-1) — ungated B2B, like /for-cpas. */}
        <Route path="/partners/join"><BareLayout><PartnersJoin /></BareLayout></Route>
        {/* Partner co-brand landing — consumer-facing, so prelaunch-gated like /ref/:code. */}
        <Route path="/p/:slug">
          {(params) => <Gated><BareLayout><PartnerReferralLanding /></BareLayout></Gated>}
        </Route>
        <Route path="/cpa/:code">
          {(params) => <Gated><BareLayout><CpaInviteLanding /></BareLayout></Gated>}
        </Route>
        <Route path="/find-an-agent">
          <Gated><PublicPage><FindAnAgent /></PublicPage></Gated>
        </Route>
        <Route path="/resources">
          <PublicPage><Resources /></PublicPage>
        </Route>
        <Route path="/learn">
          <PublicPage><LearningCenter /></PublicPage>
        </Route>
        {/* Must precede /learn/:slug — Switch takes the first match */}
        <Route path="/learn/first-time-buyer">
          <Gated><PublicPage><FirstTimeBuyerHub /></PublicPage></Gated>
        </Route>
        <Route path="/learn/:slug">
          {(params) => <PublicPage><ArticleDetail /></PublicPage>}
        </Route>
        <Route path="/faq">
          <PublicPage><FAQ /></PublicPage>
        </Route>
        <Route path="/glossary">
          <PublicPage><Glossary /></PublicPage>
        </Route>
        <Route path="/privacy">
          <BareLayout><Privacy /></BareLayout>
        </Route>
        <Route path="/terms">
          <BareLayout><Terms /></BareLayout>
        </Route>
        <Route path="/disclosures">
          <BareLayout><Disclosures /></BareLayout>
        </Route>
        
        {/* Property Pages - Public */}
        <Route path="/down-payment-wizard">
          <PublicPage><DownPaymentWizard /></PublicPage>
        </Route>
        <Route path="/properties">
          <Gated><PublicPage><Properties /></PublicPage></Gated>
        </Route>
        <Route path="/properties/live">
          <Gated><PublicPage><LivePropertyDetail /></PublicPage></Gated>
        </Route>
        <Route path="/properties/:id">
          {(params) => <Gated><PublicPage><PropertyDetail /></PublicPage></Gated>}
        </Route>

        {/* Rate Pages - Public with navigation header */}
        <Route path="/rates">
          <Gated><PublicPage><MortgageRates /></PublicPage></Gated>
        </Route>
        <Route path="/rates/purchase">
          <Gated><PublicPage><PurchaseRates /></PublicPage></Gated>
        </Route>
        <Route path="/rates/refinance">
          <Gated><PublicPage><RefinanceRates /></PublicPage></Gated>
        </Route>
        <Route path="/rates/cash-out">
          <Gated><PublicPage><CashOutRates /></PublicPage></Gated>
        </Route>
        <Route path="/rates/heloc">
          <Gated><PublicPage><HelocRates /></PublicPage></Gated>
        </Route>
        <Route path="/rates/va">
          <Gated><PublicPage><VaRates /></PublicPage></Gated>
        </Route>

        {/* Calculator Pages - Public with navigation header */}
        <Route path="/calculators">
          <PublicPage><CalculatorsHub /></PublicPage>
        </Route>
        <Route path="/calculators/rent-vs-buy">
          <PublicPage><RentVsBuyCalculator /></PublicPage>
        </Route>
        <Route path="/calculators/affordability">
          <PublicPage><AffordabilityCalculator /></PublicPage>
        </Route>
        <Route path="/calculators/mortgage">
          <PublicPage><MortgageCalculator /></PublicPage>
        </Route>
        <Route path="/calculators/amortization">
          <PublicPage><AmortizationCalculator /></PublicPage>
        </Route>
        <Route path="/calculators/home-equity">
          <PublicPage><HomeEquityCalculator /></PublicPage>
        </Route>
        <Route path="/calculators/payoff">
          <PublicPage><MortgagePayoffCalculator /></PublicPage>
        </Route>
        <Route path="/calculators/down-payment">
          <PublicPage><DownPaymentCalculator /></PublicPage>
        </Route>
        <Route path="/calculators/bah">
          <PublicPage><BahCalculator /></PublicPage>
        </Route>
        <Route path="/calculators/rent-to-own">
          <Gated><PublicPage><RentToOwnReadiness /></PublicPage></Gated>
        </Route>

        {/* Affordability Check - "Can I Afford This Home?" */}
        <Route path="/afford"><Gated><BareLayout><AffordabilityCheck /></BareLayout></Gated></Route>

        {/* Approval Strength - "Will I qualify?" Gated pre-F1: the tool's whole
            vocabulary is approval language, which the launch charter bars from
            the public pre-license surface (kb/ARMED_LAUNCH_CHARTER_2026-07-07.md §2). */}
        <Route path="/approval-strength"><Gated><BareLayout><ApprovalStrength /></BareLayout></Gated></Route>

        {/* Private Pages - Any authenticated user (role-aware content) */}
        <Route path="/dashboard">
          <AnyAuthPage><Dashboard /></AnyAuthPage>
        </Route>
        <Route path="/tasks">
          <AnyAuthPage><Tasks /></AnyAuthPage>
        </Route>
        <Route path="/task/:id">
          {(params) => <AnyAuthPage><TaskDetail /></AnyAuthPage>}
        </Route>
        <Route path="/messages">
          <AnyAuthPage><Messages /></AnyAuthPage>
        </Route>
        <Route path="/messages/:memberId">
          {(params) => <AnyAuthPage><Messages /></AnyAuthPage>}
        </Route>
        <Route path="/documents">
          <AnyAuthPage><Documents /></AnyAuthPage>
        </Route>

        {/* Private Pages - Borrower only (clients working on their mortgage) */}
        <Route path="/gap-calculator">
          <BorrowerPage><GapCalculator /></BorrowerPage>
        </Route>
        {/* Rent ledger capture. Saving a lease furnishes nothing — the page says so. */}
        <Route path="/my-lease">
          <BorrowerPage><MyLease /></BorrowerPage>
        </Route>
        <Route path="/loan-options/:id">
          {(params) => <BorrowerPage><LoanOptions /></BorrowerPage>}
        </Route>
        <Route path="/pipeline/:id">
          {(params) => <BorrowerPage><LoanPipeline /></BorrowerPage>}
        </Route>
        <Route path="/application-summary">
          <BorrowerPage><ApplicationSummary /></BorrowerPage>
        </Route>
        <Route path="/verification">
          <BorrowerPage><Verification /></BorrowerPage>
        </Route>
        <Route path="/identity-verification">
          <BorrowerPage><IdentityVerification /></BorrowerPage>
        </Route>
        <Route path="/onboarding">
          <BorrowerPage><OnboardingJourney /></BorrowerPage>
        </Route>
        <Route path="/credit-consent/:id">
          {(params) => <BorrowerPage><CreditConsent /></BorrowerPage>}
        </Route>
        <Route path="/adverse-action/:id">
          {(params) => <BorrowerPage><AdverseActionNotice /></BorrowerPage>}
        </Route>
        <Route path="/hmda/:id">
          {(params) => <BorrowerPage><HmdaDemographics /></BorrowerPage>}
        </Route>
        <Route path="/urla-form">
          <BorrowerPage><URLAForm /></BorrowerPage>
        </Route>
        <Route path="/compare-offers/:id">
          {(params) => <BorrowerPage><BorrowerDealComparison /></BorrowerPage>}
        </Route>

        {/* Private Pages - Staff (brokers, lenders processing mortgage applications) */}
        <Route path="/staff-dashboard">
          <StaffPage><StaffDashboard /></StaffPage>
        </Route>
        <Route path="/lo-command-center">
          <InternalStaffPage><LoCommandCenter /></InternalStaffPage>
        </Route>
        <Route path="/design-prototype">
          <InternalStaffPage><DesignPrototype /></InternalStaffPage>
        </Route>
        <Route path="/pipeline-queue">
          <Redirect to="/staff-dashboard" />
        </Route>
        <Route path="/borrower-file/:id">
          {(params) => <StaffPage><BorrowerFile /></StaffPage>}
        </Route>
        {/* Inlined rather than given a page wrapper: ROUTE_GATES.disclosure has
            exactly one route, and a fifth single-use wrapper measured 56 extra
            bytes on the eager entry every visitor downloads. Uses the named
            gate, never an inline role literal (tests/routeGates.test.ts:99). */}
        <Route path="/loan-estimate/:id">
          {(params) => (
            <PrivateLayout requiredRoles={ROUTE_GATES.disclosure}>
              <LoanEstimate />
            </PrivateLayout>
          )}
        </Route>
        <Route path="/compliance">
          <Redirect to="/staff-dashboard" />
        </Route>
        <Route path="/staff">
          <Redirect to="/staff-dashboard" />
        </Route>
        <Route path="/broker-dashboard">
          <StaffPage><BrokerDashboard /></StaffPage>
        </Route>
        <Route path="/cpa-portal">
          <CpaPage><CpaPortal /></CpaPage>
        </Route>
        <Route path="/partners/hub">
          <PartnerPage><PartnersHub /></PartnerPage>
        </Route>
        <Route path="/invite-clients">
          <LoTeamPage><InviteGenerator /></LoTeamPage>
        </Route>
        <Route path="/analytics">
          <Redirect to="/staff-dashboard" />
        </Route>
        <Route path="/partner-services">
          <StaffPage><PartnerServices /></StaffPage>
        </Route>
        <Route path="/co-branding">
          <StaffPage><AgentCoBranding /></StaffPage>
        </Route>
        <Route path="/agent-pipeline">
          <StaffPage><AgentPipeline /></StaffPage>
        </Route>
        <Route path="/scenario-desk">
          <StaffPage><ScenarioDesk /></StaffPage>
        </Route>
        <Route path="/deal-rescue">
          <StaffPage><DealRescue /></StaffPage>
        </Route>
        <Route path="/strategy-sessions">
          <StaffPage><StrategySessions /></StaffPage>
        </Route>
        {/* The page's primary query is GET /api/closing-guarantees, which returns
            every guarantee system-wide and is admin-only on the server (it cannot be
            scoped without enumerating the caller's assigned files). The other seven
            staff roles reached this page and got nothing but a 403. */}
        <Route path="/closing-guarantee">
          <AdminPage><ClosingGuarantee /></AdminPage>
        </Route>
        <Route path="/policy-ops">
          <UnderwriterOpsPage><PolicyOps /></UnderwriterOpsPage>
        </Route>
        <Route path="/task-operations">
          <UnderwriterOpsPage><TaskOperations /></UnderwriterOpsPage>
        </Route>
        <Route path="/pricing-matrices">
          <UnderwriterOpsPage><PricingMatrices /></UnderwriterOpsPage>
        </Route>
        <Route path="/pricing-intelligence">
          <MarketDataPage><PricingIntelligence /></MarketDataPage>
        </Route>
        <Route path="/accelerator">
          <BorrowerPage><AcceleratorProgram /></BorrowerPage>
        </Route>
        <Route path="/ai-coach">
          <AnyAuthPage><AICoach /></AnyAuthPage>
        </Route>
        <Route path="/profile">
          <AnyAuthPage><Profile /></AnyAuthPage>
        </Route>
        <Route path="/homeowner-dashboard">
          <BorrowerPage><HomeownerDashboard /></BorrowerPage>
        </Route>
        <Route path="/e-consent">
          <BorrowerPage><EConsent /></BorrowerPage>
        </Route>
        <Route path="/buy">
          <BorrowerPage><BuyerProperties /></BorrowerPage>
        </Route>

        {/* Private Pages - Agent (real estate agents managing listings) */}
        <Route path="/agent/dashboard">
          <StaffPage><AgentDashboard /></StaffPage>
        </Route>
        <Route path="/agent/edit">
          <StaffPage><AgentEdit /></StaffPage>
        </Route>
        <Route path="/property/new">
          <StaffPage><PropertyForm /></StaffPage>
        </Route>
        <Route path="/property/:id/edit">
          {(params) => <StaffPage><PropertyForm /></StaffPage>}
        </Route>

        {/* Private Pages - Admin only (manage content, rates, users) */}
        <Route path="/admin">
          <AdminPage><AdminDashboard /></AdminPage>
        </Route>
        <Route path="/admin/rates">
          <AdminPage><AdminRates /></AdminPage>
        </Route>
        <Route path="/admin/content">
          <AdminPage><AdminContent /></AdminPage>
        </Route>
        <Route path="/admin/users">
          <AdminPage><AdminUsers /></AdminPage>
        </Route>
        <Route path="/admin/partners">
          <AdminPage><AdminPartners /></AdminPage>
        </Route>
        <Route path="/admin/policy-ops">
          <AdminPage><PolicyOps /></AdminPage>
        </Route>
        <Route path="/admin/pricing-matrices">
          <AdminPage><PricingMatrices /></AdminPage>
        </Route>
        <Route path="/admin/autopilot">
          <AdminPage><AutopilotConsole /></AdminPage>
        </Route>
        <Route path="/admin/financial-reports">
          <AdminPage><FinancialReports /></AdminPage>
        </Route>
        <Route path="/admin/pricing-policy">
          <AdminPage><PricingPolicy /></AdminPage>
        </Route>
        <Route path="/admin/lenders">
          <AdminPage><AdminLenders /></AdminPage>
        </Route>

        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        {/* Inner boundary: a route whose lazy chunk fails to load is contained
            here, so the Toaster and the providers stay mounted. The root
            boundary in main.tsx backstops the providers themselves. */}
        <AppErrorBoundary>
          <Router />
        </AppErrorBoundary>
        <EmailCaptureGate />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
