import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";

import { ConsentGateCard } from "@/components/ConsentGateCard";
import { LoanComparisonMatrix } from "@/components/LoanComparisonMatrix";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, loanApplicationKeys, consentKeys } from "@/lib/queryClient";
import { formatCurrency } from "@/lib/formatters";
import type { LoanApplication, LoanOption } from "@shared/schema";
import { AlertCircle, CheckCircle2, Clock, Shield } from "lucide-react";
import { ActionItemsSection } from "./loanOptions/ActionItemsSection";
import { MarketPricingSection, type MarketOffersResponse } from "./loanOptions/MarketPricingSection";
import { LoanOptionCard } from "./loanOptions/LoanOptionCard";
import { LoanLetterButton } from "./loanOptions/LoanLetterButton";
import { WhatIfPanel } from "./loanOptions/WhatIfPanel";
import { isDecisionGrade, type DataProvenance } from "@shared/dataProvenance";
import { getLoanOptionsPresentation } from "./loanOptions/loanOptionsPresentation";

interface LoanOptionsData {
  application: LoanApplication;
  options: LoanOption[];
}

export default function LoanOptions() {
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [viewMode, setViewMode] = useState<"cards" | "compare">("cards");

  const { data, isLoading, error } = useQuery<LoanOptionsData>({
    queryKey: loanApplicationKeys.options(id),
    enabled: !!id,
    // Scenarios are computed right after the 201, so the first visit can land
    // before they exist. Poll until they arrive instead of waiting for a
    // window-focus refetch — the page used to sit on "Analyzing…" until the
    // borrower happened to tab away and back. Terminal statuses (denied,
    // withdrawn, …) legitimately have no options; don't poll those.
    refetchInterval: (query) => {
      const current = query.state.data;
      if (!current || current.options.length > 0) return false;
      return ["submitted", "analyzing", "under_review", "pre_approved"].includes(
        current.application.status,
      )
        ? 4000
        : false;
    },
  });

  // Live wholesale pricing — repriced server-side on every request from the
  // active rate sheets, so vendor-fed market updates show up automatically.
  const { data: market } = useQuery<MarketOffersResponse>({
    queryKey: loanApplicationKeys.offers(id),
    enabled: !!id,
    staleTime: 60_000,
  });
  const marketPriced = market?.status === "PRICED";

  // Reg Z anti-steering: the loan-options disclosure must be acknowledged
  // before a rate can be locked. The server enforces this on the lock
  // endpoint; this query drives the disclosure card and button state.
  const { data: steeringConsent } = useQuery<{ hasConsent: boolean }>({
    queryKey: consentKeys.check(id, 'anti_steering'),
    enabled: !!id,
  });
  const steeringAcknowledged = steeringConsent?.hasConsent === true;

  const lockRateMutation = useMutation({
    mutationFn: async (optionId: string) => {
      return await apiRequest("POST", `/api/loan-options/${optionId}/lock`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.options(id) });
      toast({
        title: "Rate Locked!",
        description: "Your rate has been locked for 30 days.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to lock rate. Please try again.",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="mb-8 text-center">
            <Skeleton className="mx-auto h-8 w-64" />
            <Skeleton className="mx-auto mt-4 h-4 w-96" />
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-96 w-full" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen">
        <div className="mx-auto max-w-7xl px-4 py-16 text-center sm:px-6 lg:px-8">
          <AlertCircle className="mx-auto h-12 w-12 text-destructive" />
          <h2 className="mt-4 text-xl font-semibold">Unable to load loan options</h2>
          <p className="mt-2 text-muted-foreground">Please try again later.</p>
          <Button asChild className="mt-6">
            <Link href="/apply">Start New Application</Link>
          </Button>
        </div>
      </div>
    );
  }

  const { application, options } = data;
  const financialsVerified = isDecisionGrade(application.financialDataProvenance as DataProvenance | undefined);
  const preApprovalAmount = application.preApprovalAmount
    ? formatCurrency(application.preApprovalAmount)
    : formatCurrency(application.purchasePrice || "0");
  const presentation = getLoanOptionsPresentation({
    status: application.status,
    financialsVerified,
    hasOptions: options.length > 0,
  });

  return (
    <div className="min-h-screen">
      <div className="bg-gradient-to-b from-primary/5 to-surface py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            {presentation.kind === "estimate" ? (
              <>
                <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-warning-subtle px-4 py-1.5">
                  <Clock className="h-4 w-4 text-warning-subtle-foreground" />
                  <span className="text-sm font-medium text-warning-subtle-foreground">
                    {presentation.badge}
                  </span>
                </div>
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                  {presentation.title}
                </h1>
                <p className="mt-4 text-muted-foreground" data-testid="text-under-review">
                  {presentation.description}
                </p>
              </>
            ) : (
              <>
                <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-success-subtle px-4 py-1.5">
                  <CheckCircle2 className="h-4 w-4 text-success-subtle-foreground" />
                  <span className="text-sm font-medium text-success-subtle-foreground">
                    {presentation.badge}
                  </span>
                </div>
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                  {presentation.title}
                </h1>
                <p className="mt-4 text-5xl font-bold text-primary" data-testid="text-preapproval-amount">
                  {preApprovalAmount}
                </p>
                <p className="mt-4 text-muted-foreground">
                  {presentation.description}
                </p>
              </>
            )}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <LoanLetterButton
                applicationId={application.id}
                status={application.status}
                kind="preapproval"
                financialsVerified={financialsVerified}
              />
              <LoanLetterButton
                applicationId={application.id}
                status={application.status}
                kind="prequal"
                financialsVerified={financialsVerified}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        {/* The first thing after the status banner is what to DO — the
            server-computed action items (documents, consents, conditions). */}
        <ActionItemsSection applicationId={application.id} stillAnalyzing={options.length === 0} />
        {!steeringAcknowledged && (
          <div className="mb-8 flex justify-center" data-testid="section-anti-steering">
            <ConsentGateCard
              applicationId={id!}
              consentType="anti_steering"
              onConsented={() =>
                queryClient.invalidateQueries({ queryKey: consentKeys.check(id, 'anti_steering') })
              }
            />
          </div>
        )}
        {market && <MarketPricingSection market={market} />}
        {id && (
          <WhatIfPanel
            applicationId={id}
            currentPurchasePrice={
              application?.purchasePrice != null ? Number(application.purchasePrice) : null
            }
            currentDownPayment={
              application?.downPayment != null ? Number(application.downPayment) : null
            }
          />
        )}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">{marketPriced ? "Payment Scenarios" : "Your Loan Options"}</h2>
            <p className="text-muted-foreground" data-testid="text-options-qualifier">
              {marketPriced
                ? "Illustrative payment breakdowns by loan program"
                : "Estimates from your self-reported answers — not offers or approvals"}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex">
              <Shield className="h-4 w-4" />
              <span>Rates as of today</span>
            </div>
            {options.length > 1 && (
              <div className="flex rounded-lg border p-0.5" role="group" aria-label="View mode">
                <Button
                  size="sm" className="touch-target"
                  variant={viewMode === "cards" ? "secondary" : "ghost"}
                  onClick={() => setViewMode("cards")}
                  data-testid="button-view-cards"
                >
                  Cards
                </Button>
                <Button
                  size="sm" className="touch-target"
                  variant={viewMode === "compare" ? "secondary" : "ghost"}
                  onClick={() => setViewMode("compare")}
                  data-testid="button-view-compare"
                >
                  Compare
                </Button>
              </div>
            )}
          </div>
        </div>

        {options.length === 0 ? (
          <Card className="p-12 text-center">
            <Clock className="mx-auto h-12 w-12 text-muted-foreground" />
            <h3 className="mt-4 text-lg font-semibold">Analyzing Your Application</h3>
            <p className="mt-2 text-muted-foreground">
              Your scenarios are being computed against underwriting guidelines. This usually takes less than a minute.
            </p>
          </Card>
        ) : viewMode === "compare" ? (
          <LoanComparisonMatrix
            options={options}
            steeringAcknowledged={steeringAcknowledged}
            lockPending={lockRateMutation.isPending}
            onLockRate={(optionId) => lockRateMutation.mutate(optionId)}
          />
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            {options.map((option) => (
              <LoanOptionCard
                key={option.id}
                option={option}
                steeringAcknowledged={steeringAcknowledged}
                lockPending={lockRateMutation.isPending}
                onLockRate={(optionId) => lockRateMutation.mutate(optionId)}
              />
            ))}
          </div>
        )}
      </div>

      <Footer />
    </div>
  );
}
