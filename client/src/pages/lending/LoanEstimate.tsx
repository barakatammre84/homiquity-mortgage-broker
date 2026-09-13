import { useQuery, useQueryClient } from "@tanstack/react-query";
import { loanApplicationKeys } from "@/lib/queryClient";
import { useAuth } from "@/hooks/useAuth";
import { ConsentGateCard } from "@/components/ConsentGateCard";
import { useParams, Link } from "wouter";
import { formatCurrency, formatDate } from "@/lib/formatters";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ArrowLeft,
  Download,
  Printer,
  FileText,
  DollarSign,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Info,
  Home,
  Percent,
} from "lucide-react";

interface LoanEstimateData {
  applicationId: string;
  loanProgram: "CONVENTIONAL" | "FHA" | "VA";
  dateIssued: string;
  expirationDate: string;
  loanTerms: {
    loanAmount: number;
    loanAmountFormatted: string;
    interestRate: number;
    interestRateFormatted: string;
    termMonths: number;
    monthlyPrincipalAndInterest: number;
    monthlyPIFormatted: string;
    prepaymentPenalty: boolean;
    balloonPayment: boolean;
  };
  projectedPayments: {
    years1Through5: {
      principalAndInterest: number;
      mortgageInsurance: number;
      estimatedEscrow: number;
      estimatedTotal: number;
    };
    years6Through30?: {
      principalAndInterest: number;
      mortgageInsurance: number;
      estimatedEscrow: number;
      estimatedTotal: number;
    };
  };
  costsAtClosing: {
    estimatedClosingCosts: number;
    estimatedClosingCostsFormatted: string;
    estimatedCashToClose: number;
    estimatedCashToCloseFormatted: string;
  };
  closingCostDetails: {
    loanCosts: {
      originationCharges: { originationFee: number; points: number; applicationFee: number; underwritingFee: number; total: number; };
      servicesYouCannotShopFor: { appraisal: number; creditReport: number; floodDetermination: number; taxService: number; total: number; };
      servicesYouCanShopFor: { titleInsurance: number; titleSearch: number; surveyFee: number; pestInspection: number; total: number; };
      totalLoanCosts: number;
    };
    otherCosts: {
      taxesAndGovernmentFees: { recordingFees: number; transferTaxes: number; total: number; };
      prepaids: { homeownersInsurance: number; mortgageInsurance: number; prepaidInterest: number; propertyTaxes: number; total: number; };
      initialEscrowPaymentAtClosing: { homeownersInsurance: number; mortgageInsurance: number; propertyTaxes: number; total: number; };
      otherItems: { ownersTitleInsurance: number; total: number; };
      totalOtherCosts: number;
    };
    totalClosingCosts: number;
  };
  cashToClose: {
    totalClosingCosts: number;
    closingCostsPaidBeforeClosing: number;
    downPayment: number;
    deposit: number;
    fundsFromBorrower: number;
    sellerCredits: number;
    adjustmentsAndOtherCredits: number;
    cashToClose: number;
  };
  appraisedPropertyValue: number;
  estimatedPropertyTaxes: number;
  homeownersInsurance: number;
  comparisons: {
    inFiveYears: { totalYouWillHavePaid: number; principalPaidOff: number; };
    apr: number;
    totalInterestPercentage: number;
  };
  lenderCredits: number;
  tridCompliance: {
    disclosureProvided: boolean;
    dateProvided: string | null;
    /**
     * Three-valued: `null` means the TRID clock never started, so there is no
     * deadline to have met or missed. Never render it as compliant (ux-30).
     */
    withinThreeBusinessDays: boolean | null;
    applicationDate: string;
  };
}

function CostLineItem({ label, amount, bold = false }: { label: string; amount: number; bold?: boolean }) {
  return (
    <div className={`flex justify-between py-1 ${bold ? "font-semibold" : ""}`}>
      <span>{label}</span>
      <span>{formatCurrency(amount)}</span>
    </div>
  );
}

export default function LoanEstimate() {
  const { id } = useParams<{ id: string }>();
  const { user, isLoading: authLoading } = useAuth();

  const queryClient = useQueryClient();
  const { data: le, isLoading, error } = useQuery<LoanEstimateData>({
    queryKey: loanApplicationKeys.loanEstimate(id),
    enabled: !!id && !authLoading,
    retry: (failureCount, err) =>
      !(err instanceof Error && err.message.includes("CONSENT_REQUIRED")) && failureCount < 2,
  });

  const consentRequired = error instanceof Error && error.message.includes("CONSENT_REQUIRED");

  if (isLoading || authLoading) {
    return (
      <div className="overflow-y-auto p-6">
        <div className="mx-auto max-w-4xl space-y-6">
          <Skeleton className="h-12 w-64" />
          <div className="grid gap-4 md:grid-cols-3">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-28" />)}
          </div>
          <Skeleton className="h-96 w-full" />
        </div>
      </div>
    );
  }

  if (consentRequired && id) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <ConsentGateCard
          applicationId={id}
          consentType="e_disclosure"
          onConsented={() =>
            queryClient.invalidateQueries({ queryKey: loanApplicationKeys.loanEstimate(id) })
          }
        />
      </div>
    );
  }

  if (error || !le) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Error Loading Loan Estimate</CardTitle>
            <CardDescription>
              Unable to generate the loan estimate for this application.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/dashboard">Go to Dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between border-b bg-background px-6 py-3">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="Back" asChild>
            <Link href={`/borrower-file/${id}`}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Loan Estimate
            </h1>
            <p className="text-sm text-muted-foreground">
              TRID-Compliant Disclosure Document
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="touch-target" onClick={() => window.print()} data-testid="button-print">
            <Printer className="mr-2 h-4 w-4" />
            Print
          </Button>
          {/*
            Download PDF has no implementation behind it. A Loan Estimate PDF is
            a TRID disclosure with prescribed content and layout — it is not a
            screenshot of this page — and generating one belongs in
            pdfLetterGenerator alongside the pre-approval, pre-qualification and
            adverse-action documents, verified against the form.

            Until then the control says so rather than looking clickable and
            doing nothing, which is what it did before. Print covers the
            borrower's actual need today: the disclosure tells them to save this
            and compare it against their Closing Disclosure.
          */}
          <Button
            size="sm" className="touch-target"
            disabled
            title="Not available yet — use Print, and choose “Save as PDF”."
            data-testid="button-download"
          >
            <Download className="mr-2 h-4 w-4" />
            Download PDF
          </Button>
        </div>
      </div>

      <ScrollArea className="h-[calc(100vh-64px)]">
            <div className="p-6">
              <div className="mx-auto max-w-4xl space-y-6">
                <Card className="bg-primary/5 border-primary/20">
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="text-2xl">Loan Estimate</CardTitle>
                        <CardDescription className="text-base mt-1">
                          Save this Loan Estimate to compare with your Closing Disclosure.
                        </CardDescription>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">Date Issued</p>
                        <p className="font-semibold" data-testid="text-date-issued">{formatDate(le.dateIssued)}</p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" data-testid="badge-loan-program">
                        {le.loanProgram}
                      </Badge>
                      {/*
                        Three states, not two (ux-30). `null` means the TRID
                        clock never started — no deadline exists yet, so
                        neither "Compliant" nor "Deadline Passed" is true.
                        Collapsing it into the affirmative branch is what put a
                        green compliance badge on 173 of 176 files.
                      */}
                      {le.tridCompliance.withinThreeBusinessDays === null ? (
                        <Badge variant="outline" data-testid="badge-trid-not-started">
                          <Info className="mr-1 h-3 w-3" />
                          TRID window not started
                        </Badge>
                      ) : le.tridCompliance.withinThreeBusinessDays ? (
                        <Badge className="bg-success text-success-foreground" data-testid="badge-trid-compliant">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          TRID Compliant
                        </Badge>
                      ) : (
                        <Badge variant="destructive" data-testid="badge-trid-deadline-passed">
                          <AlertTriangle className="mr-1 h-3 w-3" />
                          TRID Deadline Passed
                        </Badge>
                      )}
                      <Badge variant="outline">
                        <Clock className="mr-1 h-3 w-3" />
                        Expires {formatDate(le.expirationDate)}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>

                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">Loan Amount</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold" data-testid="text-loan-amount">
                        {le.loanTerms.loanAmountFormatted}
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">Loan Term</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold" data-testid="text-loan-term">
                        {le.loanTerms.termMonths / 12} years
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">Interest Rate</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold" data-testid="text-interest-rate">
                        {le.loanTerms.interestRateFormatted}
                      </p>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium text-muted-foreground">Monthly P&I</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold" data-testid="text-monthly-pi">
                        {le.loanTerms.monthlyPIFormatted}
                      </p>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <DollarSign className="h-5 w-5" />
                      Projected Payments
                    </CardTitle>
                    <CardDescription>
                      Your estimated monthly payment over the life of the loan
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="rounded-lg border p-4">
                        <h4 className="font-semibold mb-3">Years 1-5</h4>
                        <CostLineItem label="Principal & Interest" amount={le.projectedPayments.years1Through5.principalAndInterest} />
                        <CostLineItem label="Mortgage Insurance" amount={le.projectedPayments.years1Through5.mortgageInsurance} />
                        <CostLineItem label="Estimated Escrow" amount={le.projectedPayments.years1Through5.estimatedEscrow} />
                        <Separator className="my-2" />
                        <CostLineItem label="Estimated Total" amount={le.projectedPayments.years1Through5.estimatedTotal} bold />
                      </div>
                      
                      {le.projectedPayments.years6Through30 && (
                        <div className="rounded-lg border p-4">
                          <h4 className="font-semibold mb-3">Years 6-{le.loanTerms.termMonths / 12}</h4>
                          <CostLineItem label="Principal & Interest" amount={le.projectedPayments.years6Through30.principalAndInterest} />
                          <CostLineItem label="Mortgage Insurance" amount={le.projectedPayments.years6Through30.mortgageInsurance} />
                          <CostLineItem label="Estimated Escrow" amount={le.projectedPayments.years6Through30.estimatedEscrow} />
                          <Separator className="my-2" />
                          <CostLineItem label="Estimated Total" amount={le.projectedPayments.years6Through30.estimatedTotal} bold />
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Home className="h-5 w-5" />
                      Costs at Closing
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="rounded-lg bg-muted p-4 text-center">
                        <p className="text-sm text-muted-foreground mb-1">Estimated Closing Costs</p>
                        <p className="text-3xl font-bold" data-testid="text-closing-costs">
                          {le.costsAtClosing.estimatedClosingCostsFormatted}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Includes loan costs + other costs
                        </p>
                      </div>
                      <div className="rounded-lg bg-primary/10 p-4 text-center">
                        <p className="text-sm text-muted-foreground mb-1">Estimated Cash to Close</p>
                        <p className="text-3xl font-bold text-primary" data-testid="text-cash-to-close">
                          {le.costsAtClosing.estimatedCashToCloseFormatted}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Includes down payment
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Closing Cost Details</CardTitle>
                    <CardDescription>Itemized breakdown of all closing costs</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div>
                      <h4 className="font-semibold text-lg mb-3">A. Loan Costs</h4>
                      
                      <div className="space-y-4">
                        <div className="rounded-lg border p-3">
                          <h5 className="font-medium mb-2">Origination Charges</h5>
                          <CostLineItem label="Origination Fee" amount={le.closingCostDetails.loanCosts.originationCharges.originationFee} />
                          <CostLineItem label="Points" amount={le.closingCostDetails.loanCosts.originationCharges.points} />
                          <CostLineItem label="Application Fee" amount={le.closingCostDetails.loanCosts.originationCharges.applicationFee} />
                          <CostLineItem label="Underwriting Fee" amount={le.closingCostDetails.loanCosts.originationCharges.underwritingFee} />
                          <Separator className="my-1" />
                          <CostLineItem label="Subtotal" amount={le.closingCostDetails.loanCosts.originationCharges.total} bold />
                        </div>

                        <div className="rounded-lg border p-3">
                          <h5 className="font-medium mb-2">Services You Cannot Shop For</h5>
                          <CostLineItem label="Appraisal" amount={le.closingCostDetails.loanCosts.servicesYouCannotShopFor.appraisal} />
                          <CostLineItem label="Credit Report" amount={le.closingCostDetails.loanCosts.servicesYouCannotShopFor.creditReport} />
                          <CostLineItem label="Flood Determination" amount={le.closingCostDetails.loanCosts.servicesYouCannotShopFor.floodDetermination} />
                          <CostLineItem label="Tax Service" amount={le.closingCostDetails.loanCosts.servicesYouCannotShopFor.taxService} />
                          <Separator className="my-1" />
                          <CostLineItem label="Subtotal" amount={le.closingCostDetails.loanCosts.servicesYouCannotShopFor.total} bold />
                        </div>

                        <div className="rounded-lg border p-3">
                          <h5 className="font-medium mb-2">Services You Can Shop For</h5>
                          <CostLineItem label="Title Insurance" amount={le.closingCostDetails.loanCosts.servicesYouCanShopFor.titleInsurance} />
                          <CostLineItem label="Title Search" amount={le.closingCostDetails.loanCosts.servicesYouCanShopFor.titleSearch} />
                          <CostLineItem label="Survey" amount={le.closingCostDetails.loanCosts.servicesYouCanShopFor.surveyFee} />
                          <CostLineItem label="Pest Inspection" amount={le.closingCostDetails.loanCosts.servicesYouCanShopFor.pestInspection} />
                          <Separator className="my-1" />
                          <CostLineItem label="Subtotal" amount={le.closingCostDetails.loanCosts.servicesYouCanShopFor.total} bold />
                        </div>

                        <div className="bg-muted rounded-lg p-3">
                          <CostLineItem label="Total Loan Costs (A)" amount={le.closingCostDetails.loanCosts.totalLoanCosts} bold />
                        </div>
                      </div>
                    </div>

                    <Separator />

                    <div>
                      <h4 className="font-semibold text-lg mb-3">B. Other Costs</h4>
                      
                      <div className="space-y-4">
                        <div className="rounded-lg border p-3">
                          <h5 className="font-medium mb-2">Taxes and Government Fees</h5>
                          <CostLineItem label="Recording Fees" amount={le.closingCostDetails.otherCosts.taxesAndGovernmentFees.recordingFees} />
                          <CostLineItem label="Transfer Taxes" amount={le.closingCostDetails.otherCosts.taxesAndGovernmentFees.transferTaxes} />
                          <Separator className="my-1" />
                          <CostLineItem label="Subtotal" amount={le.closingCostDetails.otherCosts.taxesAndGovernmentFees.total} bold />
                        </div>

                        <div className="rounded-lg border p-3">
                          <h5 className="font-medium mb-2">Prepaids</h5>
                          <CostLineItem label="Homeowner's Insurance" amount={le.closingCostDetails.otherCosts.prepaids.homeownersInsurance} />
                          <CostLineItem label="Mortgage Insurance" amount={le.closingCostDetails.otherCosts.prepaids.mortgageInsurance} />
                          <CostLineItem label="Prepaid Interest" amount={le.closingCostDetails.otherCosts.prepaids.prepaidInterest} />
                          <CostLineItem label="Property Taxes" amount={le.closingCostDetails.otherCosts.prepaids.propertyTaxes} />
                          <Separator className="my-1" />
                          <CostLineItem label="Subtotal" amount={le.closingCostDetails.otherCosts.prepaids.total} bold />
                        </div>

                        <div className="rounded-lg border p-3">
                          <h5 className="font-medium mb-2">Initial Escrow Payment at Closing</h5>
                          <CostLineItem label="Homeowner's Insurance" amount={le.closingCostDetails.otherCosts.initialEscrowPaymentAtClosing.homeownersInsurance} />
                          <CostLineItem label="Mortgage Insurance" amount={le.closingCostDetails.otherCosts.initialEscrowPaymentAtClosing.mortgageInsurance} />
                          <CostLineItem label="Property Taxes" amount={le.closingCostDetails.otherCosts.initialEscrowPaymentAtClosing.propertyTaxes} />
                          <Separator className="my-1" />
                          <CostLineItem label="Subtotal" amount={le.closingCostDetails.otherCosts.initialEscrowPaymentAtClosing.total} bold />
                        </div>

                        <div className="bg-muted rounded-lg p-3">
                          <CostLineItem label="Total Other Costs (B)" amount={le.closingCostDetails.otherCosts.totalOtherCosts} bold />
                        </div>
                      </div>
                    </div>

                    <Separator />

                    <div className="bg-primary/10 rounded-lg p-4">
                      <CostLineItem label="Total Closing Costs (A + B)" amount={le.closingCostDetails.totalClosingCosts} bold />
                      {le.lenderCredits > 0 && (
                        <CostLineItem label="Lender Credits" amount={-le.lenderCredits} />
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      <Percent className="h-5 w-5" />
                      Comparisons
                    </CardTitle>
                    <CardDescription>
                      Use these measures to compare this loan with other loans.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="grid gap-4 md:grid-cols-3">
                      <div className="rounded-lg border p-4 text-center">
                        <p className="text-sm text-muted-foreground mb-1">In 5 Years</p>
                        <p className="text-xl font-bold">
                          {formatCurrency(le.comparisons.inFiveYears.totalYouWillHavePaid)}
                        </p>
                        <p className="text-xs text-muted-foreground">Total you will have paid</p>
                        <p className="text-lg font-semibold text-success-subtle-foreground mt-2">
                          {formatCurrency(le.comparisons.inFiveYears.principalPaidOff)}
                        </p>
                        <p className="text-xs text-muted-foreground">Principal paid off</p>
                      </div>

                      <div className="rounded-lg border p-4 text-center">
                        <p className="text-sm text-muted-foreground mb-1">Annual Percentage Rate (APR)</p>
                        <p className="text-2xl font-bold" data-testid="text-apr">
                          {le.comparisons.apr}%
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Cost over the loan term as a yearly rate
                        </p>
                      </div>

                      <div className="rounded-lg border p-4 text-center">
                        <p className="text-sm text-muted-foreground mb-1">Total Interest Percentage</p>
                        <p className="text-2xl font-bold">
                          {le.comparisons.totalInterestPercentage}%
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          Total interest as % of loan amount
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-border/30 bg-warning-subtle/50">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-warning-subtle-foreground">
                      <Info className="h-5 w-5" />
                      Important Information
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-muted-foreground space-y-2">
                    <p>
                      <strong>Prepayment Penalty:</strong> {le.loanTerms.prepaymentPenalty ? "Yes - see loan documents" : "No prepayment penalty"}
                    </p>
                    <p>
                      <strong>Balloon Payment:</strong> {le.loanTerms.balloonPayment ? "Yes - see loan documents" : "No balloon payment"}
                    </p>
                    <p>
                      Your actual rate, payment, and costs could be higher. Get an official Loan Estimate before choosing a loan.
                    </p>
                  </CardContent>
                </Card>
              </div>
            </div>
      </ScrollArea>
    </>
  );
}
