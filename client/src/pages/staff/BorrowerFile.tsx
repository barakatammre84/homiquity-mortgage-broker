import { FileReviewTab } from "./borrowerFile/FileReviewTab";
import { lazy, Suspense, useState } from "react";
import { friendlyApiError } from "@/lib/errorMessage";
import { useParams, useSearchParams, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ApiError, loanApplicationKeys, urlaKeys } from "@/lib/queryClient";
import { downloadResponseAsFile } from "@/lib/downloadFile";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { DealTeam } from "@/components/DealTeam";
import { DealTeamManagement } from "@/components/DealTeamManagement";
import { TaxIntelligencePanel } from "@/components/staff/TaxIntelligencePanel";
import { ReviewWorkbenchPanel } from "@/components/staff/ReviewWorkbenchPanel";
import {
  FileText,
  User,
  DollarSign,
  CheckCircle2,
  Clock,
  Download,
  ArrowLeft,
  Briefcase,
  CreditCard,
  Home,
  Users,
  Brain,
  Receipt,
} from "lucide-react";
import { PageShell } from "@/components/PageShell";
import { ChangeOfCircumstancePanel } from "@/components/staff/ChangeOfCircumstancePanel";
import { RiskBriefPanel } from "@/components/staff/RiskBriefPanel";
import { isStaffRole, isInternalStaffRole } from "@shared/roles";
import { canReviewDocuments } from "@shared/documentStatus";
import { formatCurrency } from "@/lib/formatters";
import { DocumentReviewPanel } from "@/components/staff/DocumentReviewPanel";
import { CREDIT_DECISION_ROLES, FINANCIAL_VERIFICATION_ROLES } from "@shared/loanApplicationStatus";
import type { RealEstateOwned, UrlaPersonalInfo } from "@shared/schema";
import { type ApplicationData, type PipelineData } from "./borrowerFile/model";
import { StatusUpdateDialog } from "./borrowerFile/StatusUpdateDialog";
import { CompensationCard } from "./borrowerFile/CompensationCard";
import { ConditionsTab } from "./borrowerFile/ConditionsTab";
import { CreditTab } from "./borrowerFile/CreditTab";
import { FinancialsTab } from "./borrowerFile/FinancialsTab";
import { TimelineTab } from "./borrowerFile/TimelineTab";

// Lazy so pdfjs-dist stays in a staff-only async chunk, off every borrower
// bundle and off this page's own initial render.
const DocumentViewer = lazy(() => import("@/components/staff/DocumentViewer"));
const FinancialReviewTab = lazy(() =>
  import("./borrowerFile/FinancialReviewTab").then(module => ({ default: module.FinancialReviewTab })),
);

const TAB_PARAM = "tab";
const TAB_VALUES = ["overview", "file-review", "financial-review", "documents", "conditions", "timeline", "credit", "financials", "tax-intel", "team"];

// DATA FLOW — this page currently runs BOTH directions, and that is the known
// debt, not a design.
//
//   props-down:      DocumentReviewPanel, ConditionsTab, TimelineTab receive
//                    server data from the three queries below.
//   fetch-your-own:  CreditTab, FinancialsTab, CompensationCard take only an
//                    applicationId and query for themselves.
//
// The props-down children still invalidate this page's OWN keys after a write
// (e.g. DocumentReviewPanel → loanApplicationKeys.detail), which is correct but
// invisible: the child's refresh silently depends on the parent having fetched
// with exactly that key.
//
// A NEW TAB USES fetch-your-own. It is independently testable, it carries no
// hidden coupling to a parent's key, and its loading state is its own instead of
// blocking behind this page's combined `isLoading`. The three props-down tabs
// migrate child-by-child; do not add a fourth. (kb rule: .claude/skills/ui-components)

export default function BorrowerFile() {
  const queryClient = useQueryClient();
  const params = useParams();
  const applicationId = params.id as string;
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  // ?tab= deep-link (e.g. the staff docs-ready signal links straight to the
  // Documents tab). The URL is the state, not just a seed for it: reading it
  // once into useState meant the tab a processor was on could not be shared or
  // reloaded, and a second ?tab= link clicked from within the page did nothing
  // at all (the component was already mounted, so the initializer never re-ran).
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get(TAB_PARAM);
  const activeTab =
    requestedTab && TAB_VALUES.includes(requestedTab) ? requestedTab : "overview";
  const setActiveTab = (tab: string) => {
    setSearchParams(
      (prev) => {
        // Copy so sibling params survive a tab switch.
        const next = new URLSearchParams(prev);
        next.set(TAB_PARAM, tab);
        return next;
      },
      // Replace: switching tabs is a view change, not a place to go Back to.
      { replace: true },
    );
  };
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [sourcePageRequest, setSourcePageRequest] = useState<{
    pageNumber: number;
    requestId: number;
  } | null>(null);

  const { data: appData, isLoading: appLoading } = useQuery<ApplicationData>({
    queryKey: loanApplicationKeys.detail(applicationId),
    enabled: !!applicationId && !authLoading,
  });

  const { data: pipelineData, isLoading: pipelineLoading } = useQuery<PipelineData>({
    queryKey: loanApplicationKeys.pipeline(applicationId),
    enabled: !!applicationId && !authLoading,
  });

  const { data: urlaData } = useQuery<{
    personalInfo: UrlaPersonalInfo | null;
    realEstateOwned: RealEstateOwned[];
  }>({
    queryKey: urlaKeys.detail(applicationId),
    enabled: !!applicationId && !authLoading,
  });

  const [exportingMismo, setExportingMismo] = useState(false);
  const handleExportMismo = async () => {
    setExportingMismo(true);
    try {
      const res = await apiRequest("GET", `/api/loan-applications/${applicationId}/mismo-export`).catch(
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 403) {
            throw new Error(
              "MISMO export is restricted to internal staff with access to this application.",
            );
          }
          throw new Error(friendlyApiError(err, "Failed to generate the MISMO file."));
        },
      );
      await downloadResponseAsFile(res, `mismo-${applicationId}.xml`);
      toast({
        title: "MISMO 3.4 exported",
        description: "The readiness-gated XML package has been downloaded.",
      });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setExportingMismo(false);
    }
  };

  const isLoading = authLoading || appLoading || pipelineLoading;

  if (isLoading) {
    return (
      <PageShell width="wide" contentClassName="space-y-6">
          <Skeleton className="h-12 w-64" />
          <div className="grid gap-4 md:grid-cols-4">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24" />)}
          </div>
          <Skeleton className="h-96 w-full" />
      </PageShell>
    );
  }

  const application = appData?.application;
  const documents = appData?.documents || [];
  const activities = appData?.activities || [];
  const conditions = pipelineData?.conditions || [];
  const acceptedDocuments = documents.filter(document => document.status === "verified").length;
  const conditionProgress = pipelineData?.progress.conditions;
  const personalInfo = urlaData?.personalInfo;
  const ownedProperties = urlaData?.realEstateOwned ?? [];

  if (!application) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>File Not Found</CardTitle>
            <CardDescription>
              This borrower file could not be found.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/staff-dashboard">Back to Dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Mirrors the server's role gate on PATCH /:id/status (statusDecisions.ts):
  // final credit decisions are 403'd for everyone else, so grey them out here.
  const canSetCreditDecisions = CREDIT_DECISION_ROLES.includes(user?.role || "");
  // Mirrors the evidence-backed per-dimension verification routes — closer,
  // broker, and lender are 403'd there. Both sides read the shared role list.
  const canVerifyFinancials = FINANCIAL_VERIFICATION_ROLES.includes(user?.role || "");
  const financialVerificationCount = [
    application.incomeVerified,
    application.assetsVerified,
    application.creditVerified,
  ].filter(Boolean).length;
  const isPreliminaryReview = application.status === "pre_approved" && application.financialDataProvenance !== "verified";
  const propertyLocation = [application.propertyCity, application.propertyState]
    .filter(Boolean)
    .join(", ");
  const hasVerifiedCredit = application.creditVerified === true;
  const hasVerifiedIncome = application.incomeVerified === true;
  const hasDecisionGradeDti = hasVerifiedCredit && hasVerifiedIncome;

  // Pre-underwriting validator flags (loan_applications.pre_uw_flags) — the
  // machine-readable signal staff should see before opening any tab.
  const preUwFlags: Array<{ code: string; severity: string; reason: string }> =
    ((appData?.application as { preUwFlags?: { flags?: Array<{ code: string; severity: string; reason: string }> } } | undefined)
      ?.preUwFlags?.flags) ?? [];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-3 sm:px-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" className="touch-target" asChild>
            <Link href="/staff-dashboard">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Dashboard
            </Link>
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {preUwFlags.map((flag) => (
            <Badge
              key={flag.code}
              variant="secondary"
              title={flag.reason}
              className={`no-default-hover-elevate no-default-active-elevate text-[10px] ${
                flag.severity === "blocking"
                  ? "bg-status-danger/10 text-status-danger"
                  : "bg-status-warning/10 text-status-warning"
              }`}
              data-testid={`badge-preuw-${flag.code}`}
            >
              {flag.code.replace(/_/g, " ")}
            </Badge>
          ))}
          {/* GSE delivery is internal-staff-only; the server route rejects
              broker/lender, so don't offer them a button that can only 403. */}
          {isInternalStaffRole(user?.role || "") && (
            <Button
              variant="outline"
              size="sm" className="touch-target"
              onClick={handleExportMismo}
              disabled={exportingMismo}
              data-testid="button-export-mismo"
            >
              <Download className="mr-2 h-4 w-4" />
              {exportingMismo ? "Exporting…" : "Export MISMO"}
            </Button>
          )}
          {/* The LE surface is /loan-estimate/:id (ROUTE_GATES.disclosure admits
              staff). This button rendered with no handler from its first commit —
              ux-0818-01, the worked example in tests/inertButtons.test.ts. */}
          <Button asChild size="sm" className="touch-target" data-testid="button-generate-le">
            <Link href={`/loan-estimate/${applicationId}`}>
              <FileText className="mr-2 h-4 w-4" />
              Loan Estimate
            </Link>
          </Button>
        </div>
      </div>

      <PageShell width="wide" contentClassName="space-y-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-bold" data-testid="text-borrower-name">
                    {personalInfo?.firstName || "Borrower"} {personalInfo?.lastName || ""}
                  </h1>
                  <p className="text-muted-foreground">
                    Loan #{application.id.substring(0, 8).toUpperCase()}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={isPreliminaryReview ? "secondary" : application.status === "pre_approved" ? "default" : "secondary"}>
                    {isPreliminaryReview ? "INITIAL REVIEW" : application.status?.replace(/_/g, " ").toUpperCase()}
                  </Badge>
                  <Badge variant="outline">
                    {application.preferredLoanType?.toUpperCase() || "CONVENTIONAL"}
                  </Badge>
                  {application.financialDataProvenance === "verified" ? (
                    <Badge
                      className="bg-success-subtle text-success-subtle-foreground"
                      data-testid="badge-financials-verified"
                    >
                      <CheckCircle2 className="mr-1 h-3 w-3" /> Financials Verified
                    </Badge>
                  ) : (
                    <>
                      <Badge variant="outline" className="border-border text-warning-subtle-foreground">
                        Financials Unverified
                      </Badge>
                      <Badge variant="secondary" data-testid="badge-verification-progress">
                        {financialVerificationCount}/3 checks complete
                      </Badge>
                      <span className="max-w-xs text-xs text-muted-foreground" data-testid="text-verification-next-step">
                        Complete the Financial review and Credit tabs to verify evidence.
                      </span>
                    </>
                  )}
                  <StatusUpdateDialog
                    applicationId={applicationId}
                    financialDataProvenance={application.financialDataProvenance}
                    canSetCreditDecisions={canSetCreditDecisions}
                  />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-4">
                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Loan Amount</CardTitle>
                    <DollarSign className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-loan-amount">
                      {formatCurrency(
                        application.purchasePrice && application.downPayment
                          ? Number(application.purchasePrice) - Number(application.downPayment)
                          : application.purchasePrice
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {application.loanPurpose === "purchase" ? "Purchase" : "Refinance"}
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">
                      {hasVerifiedCredit ? "Credit score" : "Credit score provided"}
                    </CardTitle>
                    <CreditCard className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-credit-score">
                      {application.creditScore || "---"}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {!hasVerifiedCredit && application.creditScore ? "Awaiting bureau verification" :
                       application.creditScore && application.creditScore >= 740 ? "740+" :
                       application.creditScore && application.creditScore >= 680 ? "680-739" :
                       application.creditScore && application.creditScore >= 620 ? "620-679" : "Pending"}
                    </p>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Documents</CardTitle>
                    <FileText className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-doc-count">
                      {documents.length} uploaded
                    </div>
                    <p className="text-xs text-muted-foreground">{acceptedDocuments} accepted</p>
                    <Progress 
                      value={documents.length ? (acceptedDocuments / documents.length) * 100 : 0}
                      aria-label="Uploaded documents accepted"
                      className="mt-2 h-2" 
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">Conditions</CardTitle>
                    <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold" data-testid="text-condition-count">
                      {conditionProgress ? `${conditionProgress.cleared}/${conditionProgress.total}` : "Unavailable"}
                    </div>
                    <p className="text-xs text-muted-foreground">{conditionProgress?.total ? "Conditions cleared" : conditionProgress ? "No conditions recorded" : "Could not load conditions"}</p>
                    <Progress 
                      value={conditionProgress?.total ? (conditionProgress.cleared / conditionProgress.total) * 100 : 0}
                      aria-label="Conditions cleared"
                      className="mt-2 h-2" 
                    />
                  </CardContent>
                </Card>
              </div>

              <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
                <TabsList className="h-auto flex-wrap justify-start">
                  <TabsTrigger value="overview" data-testid="tab-overview">
                    <User className="mr-2 h-4 w-4" />
                    Overview
                  </TabsTrigger>
                  {isInternalStaffRole(user?.role ?? "") && <TabsTrigger value="file-review" data-testid="tab-file-review">File review</TabsTrigger>}
                  {isInternalStaffRole(user?.role ?? "") && <TabsTrigger value="financial-review" data-testid="tab-financial-review">Financial review</TabsTrigger>}
                  <TabsTrigger value="documents" data-testid="tab-documents">
                    <FileText className="mr-2 h-4 w-4" />
                    Documents
                  </TabsTrigger>
                  <TabsTrigger value="conditions" data-testid="tab-conditions">
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Conditions
                  </TabsTrigger>
                  <TabsTrigger value="timeline" data-testid="tab-timeline">
                    <Clock className="mr-2 h-4 w-4" />
                    Timeline
                  </TabsTrigger>
                  <TabsTrigger value="credit" data-testid="tab-credit">
                    <CreditCard className="mr-2 h-4 w-4" />
                    Credit
                  </TabsTrigger>
                  <TabsTrigger value="financials" data-testid="tab-financials">
                    <Receipt className="mr-2 h-4 w-4" />
                    Financials
                  </TabsTrigger>
                  <TabsTrigger value="tax-intel" data-testid="tab-tax-intel">
                    <Brain className="mr-2 h-4 w-4" />
                    Tax Intel
                  </TabsTrigger>
                  <TabsTrigger value="team" data-testid="tab-team">
                    <Users className="mr-2 h-4 w-4" />
                    Team
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="space-y-4">
                  {/* Compensation election (Reg Z §1026.36(d)(2)) — full width and
                      first: with no election the Loan Estimate cannot generate,
                      so this is the file's blocking state, not a detail. */}
                  <CompensationCard
                    applicationId={application.id}
                    model={application.loCompensationModel ?? null}
                    bps={application.loCompensationBps ?? null}
                    leIssued={!!application.leIssuedDate}
                  />
                  <div className="grid gap-4 md:grid-cols-2">
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <User className="h-5 w-5" />
                          Borrower Information
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="grid gap-2 text-sm sm:grid-cols-2">
                          <span className="text-muted-foreground">Name:</span>
                          <span>{personalInfo?.firstName || "N/A"} {personalInfo?.lastName || ""}</span>
                          <span className="text-muted-foreground">Email:</span>
                          <span>{personalInfo?.email || "N/A"}</span>
                          <span className="text-muted-foreground">Phone:</span>
                          <span>{personalInfo?.cellPhone || personalInfo?.homePhone || "N/A"}</span>
                          <span className="text-muted-foreground">SSN:</span>
                          <span>XXX-XX-{personalInfo?.ssnLast4 || "XXXX"}</span>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <Briefcase className="h-5 w-5" />
                          Employment
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="grid gap-2 text-sm sm:grid-cols-2">
                          <span className="text-muted-foreground">Type:</span>
                          <span className="capitalize">{application.employmentType || "N/A"}</span>
                          <span className="text-muted-foreground">Employer:</span>
                          <span>{application.employerName || "N/A"}</span>
                          <span className="text-muted-foreground">Years:</span>
                          <span>{application.employmentYears != null ? `${application.employmentYears} years` : "Not provided"}</span>
                          <span className="text-muted-foreground">{hasVerifiedIncome ? "Verified income:" : "Reported income:"}</span>
                          <span>{application.annualIncome != null ? `${formatCurrency(application.annualIncome)}/year` : "Not provided"}</span>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <Home className="h-5 w-5" />
                          Property
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="grid gap-2 text-sm sm:grid-cols-2">
                          <span className="text-muted-foreground">Address:</span>
                          <span>{application.propertyAddress || "N/A"}</span>
                          <span className="text-muted-foreground">City/State:</span>
                          <span>{propertyLocation || "Not provided"}</span>
                          <span className="text-muted-foreground">Value:</span>
                          <span>{application.propertyValue != null && Number(application.propertyValue) > 0 ? formatCurrency(application.propertyValue) : "Not provided"}</span>
                          <span className="text-muted-foreground">Type:</span>
                          <span className="capitalize">{application.propertyType || "SFR"}</span>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <DollarSign className="h-5 w-5" />
                          Loan Details
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="grid gap-2 text-sm sm:grid-cols-2">
                          <span className="text-muted-foreground">Purpose:</span>
                          <span className="capitalize">{application.loanPurpose || "Purchase"}</span>
                          <span className="text-muted-foreground">Down Payment:</span>
                          <span>{application.downPayment != null ? formatCurrency(application.downPayment) : "Not provided"}</span>
                          <span className="text-muted-foreground">LTV:</span>
                          <span>{application.ltvRatio ? `${Number(application.ltvRatio).toFixed(1)}%` : "N/A"}</span>
                          <span className="text-muted-foreground">{hasDecisionGradeDti ? "DTI:" : "Preliminary DTI:"}</span>
                          <span>{application.dtiRatio ? `${Number(application.dtiRatio).toFixed(1)}%` : "N/A"}</span>
                        </div>
                      </CardContent>
                    </Card>

                    <Card className="md:col-span-2" data-testid="card-owned-properties">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <Home className="h-5 w-5" />
                          Properties Owned
                          <Badge variant="secondary">{ownedProperties.length}</Badge>
                        </CardTitle>
                        <CardDescription>
                          One record feeds rental income, property obligations, reserves, and lender delivery.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {application.ownsOtherRealEstate === null || application.ownsOtherRealEstate === undefined ? (
                          <p className="text-sm text-warning-subtle-foreground">
                            Ownership has not been confirmed. Ask the borrower to complete URLA section 2c.
                          </p>
                        ) : application.ownsOtherRealEstate === false ? (
                          <p className="text-sm text-muted-foreground">Borrower reported no other real estate.</p>
                        ) : ownedProperties.length === 0 ? (
                          <p className="text-sm text-warning-subtle-foreground">
                            Borrower reported owning real estate, but no property details are on file.
                          </p>
                        ) : (
                          ownedProperties.map((property, index) => (
                            <div key={property.id} className="rounded-lg border p-3" data-testid={`owned-property-${index}`}>
                              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                <p className="font-medium">{property.propertyAddress}</p>
                                <div className="flex gap-2">
                                  <Badge variant="outline" className="capitalize">
                                    {(property.occupancyType || "use not provided").replace(/_/g, " ")}
                                  </Badge>
                                  {!property.verifiedAt && <Badge variant="secondary">Borrower reported</Badge>}
                                </div>
                              </div>
                              <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
                                <span><span className="text-muted-foreground">Value: </span>{property.marketValue != null ? formatCurrency(property.marketValue) : "Needed"}</span>
                                <span><span className="text-muted-foreground">Mortgage balance: </span>{property.mortgageBalance != null ? formatCurrency(property.mortgageBalance) : "Needed"}</span>
                                <span><span className="text-muted-foreground">Monthly payment: </span>{property.mortgagePayment != null ? formatCurrency(property.mortgagePayment) : "Needed"}</span>
                                <span><span className="text-muted-foreground">Monthly rent: </span>{property.monthlyRentalIncome != null ? formatCurrency(property.monthlyRentalIncome) : "None reported"}</span>
                              </div>
                            </div>
                          ))
                        )}
                      </CardContent>
                    </Card>
                  </div>

                  <ChangeOfCircumstancePanel applicationId={application.id} />

                  <RiskBriefPanel applicationId={application.id} />
                </TabsContent>

                {isInternalStaffRole(user?.role ?? "") && <TabsContent value="file-review"><FileReviewTab applicationId={applicationId} onNavigate={setActiveTab} /></TabsContent>}

                {isInternalStaffRole(user?.role ?? "") && (
                  <TabsContent value="financial-review">
                    <Suspense fallback={<Skeleton className="h-72" />}>
                      <FinancialReviewTab
                        applicationId={applicationId}
                        onNavigate={setActiveTab}
                        incomeVerified={application.incomeVerified === true}
                        assetsVerified={application.assetsVerified === true}
                        canVerify={canVerifyFinancials}
                      />
                    </Suspense>
                  </TabsContent>
                )}

                <TabsContent value="documents" className="space-y-4">
                  {/* Split workbench (roadmap A6): review list left, safe
                      rasterizing viewer right. Stacks on narrow viewports. */}
                  <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                    <DocumentReviewPanel
                      applicationId={applicationId}
                      documents={documents}
                      application={application}
                      canReview={canReviewDocuments(user?.role)}
                      selectedDocumentId={selectedDocumentId}
                      onSelectDocument={(documentId) => {
                        setSelectedDocumentId(documentId);
                        setSourcePageRequest(null);
                      }}
                      onOpenSourcePage={(pageNumber) => setSourcePageRequest((current) => ({
                        pageNumber,
                        requestId: (current?.requestId ?? 0) + 1,
                      }))}
                    />
                    {(() => {
                      const selectedDocument = documents.find((d) => d.id === selectedDocumentId);
                      return selectedDocument ? (
                        <Suspense
                          fallback={<Skeleton className="h-[560px] w-full" data-testid="viewer-suspense" />}
                        >
                          <DocumentViewer
                            documentId={selectedDocument.id}
                            fileName={selectedDocument.fileName}
                            mimeType={selectedDocument.mimeType}
                            requestedPage={sourcePageRequest}
                          />
                        </Suspense>
                      ) : (
                        <Card className="flex min-h-[320px] items-center justify-center">
                          <CardContent className="py-10 text-sm text-muted-foreground" data-testid="viewer-placeholder">
                            Select a document to preview it here.
                          </CardContent>
                        </Card>
                      );
                    })()}
                  </div>
                </TabsContent>

                <TabsContent value="conditions" className="space-y-4">
                  <ConditionsTab
                    applicationId={applicationId}
                    conditions={conditions}
                    userRole={user?.role}
                  />
                </TabsContent>

                <TabsContent value="timeline" className="space-y-4">
                  <TimelineTab activities={activities} />
                </TabsContent>

                <TabsContent value="credit" className="space-y-4">
                  <CreditTab applicationId={applicationId} canRevokeLetter={canSetCreditDecisions} />
                </TabsContent>

                <TabsContent value="financials" className="space-y-4">
                  {/* F-4 tolerance posture + F-11 per-file cost ledger — the
                      last two UNCONSUMED_CAPABILITIES entries, consumed. */}
                  <FinancialsTab applicationId={applicationId} />
                </TabsContent>

                <TabsContent value="tax-intel" className="space-y-4">
                  {application?.userId ? (
                    <>
                      <ReviewWorkbenchPanel
                        borrowerUserId={application.userId}
                        applicationId={application.id}
                      />
                      <TaxIntelligencePanel
                        borrowerUserId={application.userId}
                        applicationId={application.id}
                      />
                    </>
                  ) : (
                    <Card>
                      <CardContent className="py-6 text-sm text-muted-foreground">
                        Borrower not loaded yet.
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                <TabsContent value="team" className="space-y-4">
                  {isStaffRole(user?.role || "") ? (
                    <DealTeamManagement applicationId={applicationId} />
                  ) : (
                    <DealTeam applicationId={applicationId} />
                  )}
                </TabsContent>
              </Tabs>
      </PageShell>

    </>
  );
}
