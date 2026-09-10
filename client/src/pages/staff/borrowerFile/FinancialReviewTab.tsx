import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { friendlyApiError } from "@/lib/errorMessage";
import { formatCurrency } from "@/lib/formatters";
import { Icons } from "@/lib/icons";
import { useToast } from "@/hooks/use-toast";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type {
  CreditMemoView,
  FinancialReviewWorkspace,
  FinancialWorkpaperOutput,
  FinancialWorkpaperView,
} from "@shared/financialReview";

function evidenceFactLabel(fieldName: string) {
  return fieldName
    .replaceAll("_", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, value => value.toUpperCase());
}

function outputLines(output: FinancialWorkpaperOutput) {
  if (output.kind === "income_summary") {
    return [
      ["Monthly qualifying income", formatCurrency(output.evaluation.primaryMonthlyQualifyingIncome)],
      ["Income basis", output.evaluation.incomeBasis.replaceAll("_", " ")],
      ["Borrowers represented", String(output.borrowerBreakdown.length)],
    ];
  }
  if (output.kind === "self_employment") {
    return [
      ["Monthly qualifying income", formatCurrency(output.result.monthlyQualifyingIncome)],
      ["Two-year annual figure", formatCurrency(output.result.avgAnnualCashFlow)],
      ["Trend", output.result.trend.replaceAll("_", " ")],
      ["Ownership", output.ownershipPercent === null ? "Not recorded" : `${output.ownershipPercent}%`],
    ];
  }
  if (output.kind === "business_liquidity") {
    const ratio = output.method === "quick_ratio" ? output.quickRatio : output.currentRatio;
    return [
      ["Method", output.method.replaceAll("_", " ")],
      ["Reviewed ratio", ratio === null ? "Unavailable" : ratio.toFixed(2)],
      ["Ordinary income support", output.supportsOrdinaryIncome === null ? "Needs inputs" : output.supportsOrdinaryIncome ? "Supported" : "Limited to distributions"],
    ];
  }
  if (output.kind === "rental_cash_flow") {
    return output.result.kind === "dti_income" ? [
      ["Income applied", formatCurrency(output.result.appliedMonthlyIncome ?? 0)],
      ["Obligation applied", formatCurrency(output.result.appliedMonthlyObligation ?? 0)],
      ["Manual review", output.result.requiresManualReview ? "Required" : "No flag"],
    ] : [
      ["Coverage ratio", output.result.coverageRatio?.toFixed(2) ?? "Unavailable"],
      ["Manual review", output.result.requiresManualReview ? "Required" : "No flag"],
    ];
  }
  if (output.kind === "asset_reconciliation") {
    return [
      ["Recorded assets", formatCurrency(output.result.totalAssets)],
      ["Policy-adjusted liquid assets", formatCurrency(output.result.liquidAssets)],
      ["Retirement assets", formatCurrency(output.result.retirementAssets)],
    ];
  }
  if (output.kind === "liability_reconciliation") return [
    ["Monthly obligations included", formatCurrency(output.result.totalMonthlyPayment)],
    ["Monthly debts excluded", formatCurrency(output.result.excludedDebts)],
    ["Liabilities reviewed", String(output.result.breakdown.length)],
  ];
  return [];
}

function ReviewBadge({ artifact }: { artifact: { isCurrent: boolean; review: { action: "approve" | "reject" } | null } }) {
  if (!artifact.isCurrent) return <Badge variant="destructive">Refresh required</Badge>;
  if (artifact.review?.action === "approve") return <Badge className="bg-success-subtle text-success-subtle-foreground">Approved</Badge>;
  if (artifact.review?.action === "reject") return <Badge variant="destructive">Rejected</Badge>;
  return <Badge variant="secondary">Needs review</Badge>;
}

function WorkpaperCard({
  applicationId,
  workpaper,
  reason,
  setReason,
  onSaved,
  onOpenEvidence,
}: {
  applicationId: string;
  workpaper: FinancialWorkpaperView;
  reason: string;
  setReason: (reason: string) => void;
  onSaved: () => void;
  onOpenEvidence: (documentId: string, pageNumber?: number) => void;
}) {
  const { toast } = useToast();
  const [acknowledgedComparisons, setAcknowledgedComparisons] = useState<string[]>([]);
  const comparisons = workpaper.input.evidenceComparisons ?? [];
  const comparisonsNeedingAttention = comparisons.filter(comparison => comparison.status !== "match");
  const allComparisonsAcknowledged = comparisonsNeedingAttention.every(comparison => acknowledgedComparisons.includes(comparison.id));
  const review = useMutation({
    mutationFn: async (action: "approve" | "reject") => apiRequest(
      "POST",
      `/api/loan-applications/${applicationId}/financial-review/workpapers/${workpaper.id}/review`,
      { action, reason, expectedFingerprint: workpaper.inputFingerprint, acknowledgedComparisonIds: acknowledgedComparisons },
    ),
    onSuccess: () => {
      setReason("");
      onSaved();
      toast({ title: "Workpaper review recorded" });
    },
    onError: (error: unknown) => toast({ title: "Could not save review", description: friendlyApiError(error, "Refresh and try again."), variant: "destructive" }),
  });
  return (
    <Card data-testid={`financial-workpaper-${workpaper.key}`}>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{workpaper.title}</CardTitle>
            <CardDescription>{workpaper.subjectLabel}{workpaper.versionNumber ? ` · version ${workpaper.versionNumber}` : " · not prepared"}</CardDescription>
          </div>
          <ReviewBadge artifact={workpaper} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          {outputLines(workpaper.output).map(([label, value]) => (
            <div key={label} className="rounded-md border bg-muted/20 p-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-medium capitalize">{value}</dd>
            </div>
          ))}
        </dl>
        {comparisons.length > 0 && (
          <div className="space-y-2" data-testid={`evidence-reconciliation-${workpaper.key}`}>
            <p className="text-sm font-medium">Document-to-calculation checks</p>
            {comparisons.map(comparison => {
              const needsAttention = comparison.status !== "match";
              return (
                <div key={comparison.id} className="rounded-md border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{comparison.label}</span>
                    <Badge variant={comparison.status === "match" ? "secondary" : "destructive"}>
                      {comparison.status === "match" ? "Matches" : comparison.status === "variance" ? "Variance" : "Needs link"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    Document {formatCurrency(comparison.evidenceValue)} · Calculation {comparison.calculationValue === null ? "not linked" : formatCurrency(comparison.calculationValue)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{comparison.detail}</p>
                  {needsAttention && (
                    <label className="mt-3 flex cursor-pointer items-start gap-2">
                      <Checkbox
                        checked={acknowledgedComparisons.includes(comparison.id)}
                        onCheckedChange={checked => setAcknowledgedComparisons(current => checked
                          ? [...new Set([...current, comparison.id])]
                          : current.filter(id => id !== comparison.id))}
                        aria-label={`Acknowledge ${comparison.label}`}
                      />
                      <span className="text-xs">I reviewed this difference and explained the treatment in my approval reason.</span>
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {workpaper.blockers.length > 0 && (
          <Alert variant="destructive">
                <Icons.warning className="h-4 w-4" />
            <AlertTitle>Resolve before approval</AlertTitle>
            <AlertDescription>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {workpaper.blockers.map((blocker, index) => <li key={`${blocker.code}-${index}`}>{blocker.message}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-1 text-sm">
          <p className="font-medium">Evidence used</p>
          {workpaper.sources.length ? workpaper.sources.map(source => (
            <div key={source.documentId} className="rounded-md border p-3">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="touch-target h-auto justify-start whitespace-normal p-0 text-left font-normal text-muted-foreground"
                onClick={() => onOpenEvidence(source.documentId, source.pages[0])}
                data-testid={`open-workpaper-source-${source.documentId}`}
              >
                {source.documentName} · v{source.versionNumber}{source.pages.length ? ` · page ${source.pages.join(", ")}` : ""} · Open source
              </Button>
              {(source.verifiedFacts?.length ?? 0) > 0 && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs font-medium text-foreground">
                    {source.verifiedFacts!.length} human-reviewed financial {source.verifiedFacts!.length === 1 ? "figure" : "figures"}
                  </summary>
                  <dl className="mt-2 grid gap-1 text-xs text-muted-foreground">
                    {source.verifiedFacts!.map(fact => (
                      <div key={fact.id} className="flex flex-wrap justify-between gap-2">
                        <dt>{evidenceFactLabel(fact.fieldName)}{fact.pageNumber ? ` · page ${fact.pageNumber}` : ""}</dt>
                        <dd className="font-medium text-foreground">
                          {fact.valueType === "currency" ? formatCurrency(fact.value) : fact.value.toLocaleString("en-US")}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
            </div>
          )) : <p className="text-muted-foreground">No accepted source evidence is linked yet.</p>}
        </div>
        {workpaper.review ? (
          <p className="rounded-md bg-muted p-3 text-sm"><span className="font-medium capitalize">{workpaper.review.action}d:</span> {workpaper.review.reason}</p>
        ) : workpaper.id && workpaper.isCurrent ? (
          <div className="space-y-2">
            <Textarea
              value={reason}
              onChange={event => setReason(event.target.value)}
              placeholder="Record what you checked and why this conclusion is supportable."
              aria-label={`Review reason for ${workpaper.title}`}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm" className="touch-target"
                onClick={() => review.mutate("approve")}
                disabled={review.isPending || reason.trim().length < 8 || workpaper.blockers.length > 0 || !allComparisonsAcknowledged}
                data-testid={`approve-${workpaper.key}`}
              >
                <Icons.done className="mr-2 h-4 w-4" />Approve
              </Button>
              <Button size="sm" className="touch-target" variant="outline" onClick={() => review.mutate("reject")} disabled={review.isPending || reason.trim().length < 8}>
                Reject with reason
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MemoCard({
  applicationId,
  memo,
  reason,
  setReason,
  onSaved,
  onOpenEvidence,
}: {
  applicationId: string;
  memo: CreditMemoView;
  reason: string;
  setReason: (reason: string) => void;
  onSaved: () => void;
  onOpenEvidence: (documentId: string, pageNumber?: number) => void;
}) {
  const { toast } = useToast();
  const review = useMutation({
    mutationFn: async (action: "approve" | "reject") => apiRequest(
      "POST",
      `/api/loan-applications/${applicationId}/financial-review/memo/${memo.id}/review`,
      { action, reason, expectedFingerprint: memo.inputFingerprint },
    ),
    onSuccess: () => { setReason(""); onSaved(); toast({ title: "Credit memo review recorded" }); },
    onError: (error: unknown) => toast({ title: "Could not save memo review", description: friendlyApiError(error, "Refresh and try again."), variant: "destructive" }),
  });
  return (
    <Card data-testid="credit-memo">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2"><Icons.documentVerified className="h-5 w-5" />Credit memo · version {memo.versionNumber}</CardTitle>
            <CardDescription>Built only from the approved workpaper versions listed below.</CardDescription>
          </div>
          <ReviewBadge artifact={memo} />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {memo.blockers.map(blocker => <Alert key={blocker.message} variant="destructive"><Icons.warning className="h-4 w-4" /><AlertDescription>{blocker.message}</AlertDescription></Alert>)}
        {memo.sections.map(section => (
          <section key={section.key} className="space-y-1">
            <h3 className="font-semibold">{section.title}</h3>
            <p className="whitespace-pre-line text-sm text-muted-foreground">{section.body}</p>
          </section>
        ))}
        <div className="rounded-md border p-3 text-sm">
          <p className="font-medium">Reference index</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {memo.references.map(reference => (
              <li key={`${reference.type}:${reference.id}`}>
                {reference.type === "document" ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="touch-target h-auto justify-start whitespace-normal p-0 text-left font-normal text-muted-foreground"
                    onClick={() => onOpenEvidence(reference.id, reference.pageNumber)}
                    data-testid={`open-memo-source-${reference.id}`}
                  >
                    {reference.label} · Open source
                  </Button>
                ) : reference.label}
              </li>
            ))}
          </ul>
        </div>
        {memo.review ? (
          <p className="rounded-md bg-muted p-3 text-sm"><span className="font-medium capitalize">{memo.review.action}d:</span> {memo.review.reason}</p>
        ) : memo.isCurrent ? (
          <div className="space-y-2">
            <Textarea value={reason} onChange={event => setReason(event.target.value)} placeholder="Record why this memo is ready for lender presentation." aria-label="Credit memo review reason" />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => review.mutate("approve")} disabled={review.isPending || reason.trim().length < 8 || memo.blockers.length > 0} data-testid="approve-credit-memo">
                <Icons.done className="mr-2 h-4 w-4" />Approve memo
              </Button>
              <Button variant="outline" onClick={() => review.mutate("reject")} disabled={review.isPending || reason.trim().length < 8}>Reject with reason</Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BankStatementAnalysisCard({
  applicationId,
  existing,
  evidence,
  onSaved,
}: {
  applicationId: string;
  existing: FinancialReviewWorkspace["bankStatementAnalysis"];
  evidence: FinancialReviewWorkspace["bankStatementEvidence"];
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [months, setMonths] = useState<"12" | "24">(String(existing?.months ?? 12) as "12" | "24");
  const [eligibleDeposits, setEligibleDeposits] = useState(existing ? String(existing.totalEligibleDeposits) : "");
  const [expenseFactorPercent, setExpenseFactorPercent] = useState(existing?.expenseFactor === null || existing?.expenseFactor === undefined ? "" : String(existing.expenseFactor * 100));
  const [hasThirdPartyStatement, setHasThirdPartyStatement] = useState(existing?.hasThirdPartyExpenseStatement ?? false);
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const parsedDeposits = Number(eligibleDeposits.replace(/[,$\s]/g, ""));
  const parsedExpensePercent = expenseFactorPercent.trim() === "" ? null : Number(expenseFactorPercent);
  const valid = Number.isFinite(parsedDeposits) && parsedDeposits > 0
    && (parsedExpensePercent === null || (Number.isFinite(parsedExpensePercent) && parsedExpensePercent >= 0 && parsedExpensePercent < 100));
  const save = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/applications/${applicationId}/bank-statement-analysis`, {
      months: Number(months),
      totalEligibleDeposits: parsedDeposits,
      ...(parsedExpensePercent === null ? {} : { expenseFactor: parsedExpensePercent / 100 }),
      hasThirdPartyExpenseStatement: hasThirdPartyStatement,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    }),
    onSuccess: () => {
      onSaved();
      toast({ title: "Bank-statement analysis saved", description: "Income workpapers now need a fresh version and review." });
    },
    onError: (error: unknown) => toast({ title: "Could not save bank-statement analysis", description: friendlyApiError(error, "Check the figures and try again."), variant: "destructive" }),
  });

  return (
    <Card data-testid="bank-statement-analysis">
      <CardHeader>
        <CardTitle>Bank-statement income analysis</CardTitle>
        <CardDescription>
          Screen deposits, record the eligible total, and let the cited calculator apply the selected expense factor. The observed OCR total is a starting point, not an eligible-income conclusion.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-muted/20 p-3 text-sm">
          <p className="font-medium">Reviewed statement evidence</p>
          <p className="mt-1 text-muted-foreground">
            {evidence.documentCount} accepted statement{evidence.documentCount === 1 ? "" : "s"} · {evidence.reviewedDepositFactCount} human-reviewed deposit total{evidence.reviewedDepositFactCount === 1 ? "" : "s"} · {formatCurrency(evidence.observedTotalDeposits)} observed
          </p>
          {evidence.observedTotalDeposits > 0 && (
            <Button type="button" size="sm" variant="outline" className="touch-target mt-3" onClick={() => setEligibleDeposits(String(evidence.observedTotalDeposits))}>
              Use observed total as a draft
            </Button>
          )}
        </div>
        <Alert>
          <Icons.warning className="h-4 w-4" />
          <AlertDescription>Remove transfers, refunds, duplicate deposits, and other ineligible activity before saving. The current lender reference still requires officer review.</AlertDescription>
        </Alert>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-2">
            <Label>Statement period</Label>
            <Select value={months} onValueChange={value => setMonths(value as "12" | "24")}>
              <SelectTrigger aria-label="Bank statement period"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="12">12 months</SelectItem><SelectItem value="24">24 months</SelectItem></SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="eligible-deposits">Eligible deposits</Label>
            <Input id="eligible-deposits" inputMode="decimal" value={eligibleDeposits} onChange={event => setEligibleDeposits(event.target.value)} placeholder="$0" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="expense-factor">Expense factor %</Label>
            <Input id="expense-factor" inputMode="decimal" value={expenseFactorPercent} onChange={event => setExpenseFactorPercent(event.target.value)} placeholder="50 (program default)" />
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={hasThirdPartyStatement} onCheckedChange={checked => setHasThirdPartyStatement(checked === true)} aria-label="Third-party expense statement on file" />
          <span>A CPA, tax preparer, or bookkeeper expense statement is on file.</span>
        </label>
        <div className="space-y-2">
          <Label htmlFor="bank-analysis-notes">Screening notes</Label>
          <Textarea id="bank-analysis-notes" value={notes} onChange={event => setNotes(event.target.value)} placeholder="Record excluded transfers, unusual deposits, and the source of the expense factor." />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending} data-testid="save-bank-statement-analysis">
            {save.isPending ? "Saving…" : existing ? "Save new analysis version" : "Save analysis"}
          </Button>
          {existing && <p className="text-xs text-muted-foreground">Current: {existing.months} months · {formatCurrency(existing.totalEligibleDeposits)} eligible deposits</p>}
        </div>
      </CardContent>
    </Card>
  );
}

export function FinancialReviewTab({
  applicationId,
  onNavigate,
  onOpenEvidence,
  incomeVerified = false,
  assetsVerified = false,
  canVerify = true,
}: {
  applicationId: string;
  onNavigate: (tab: string) => void;
  onOpenEvidence: (documentId: string, pageNumber?: number) => void;
  incomeVerified?: boolean;
  assetsVerified?: boolean;
  canVerify?: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const queryKey = ["/api/loan-applications", applicationId, "financial-review"] as const;
  const { data, isLoading, error } = useQuery<FinancialReviewWorkspace>({ queryKey });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const refresh = () => queryClient.invalidateQueries({ queryKey });
  const prepare = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/loan-applications/${applicationId}/financial-review/prepare`, {}),
    onSuccess: () => { refresh(); toast({ title: "Financial workpapers are current" }); },
    onError: (mutationError: unknown) => toast({ title: "Could not prepare workpapers", description: friendlyApiError(mutationError, "Refresh and try again."), variant: "destructive" }),
  });
  const buildMemo = useMutation({
    mutationFn: async () => apiRequest("POST", `/api/loan-applications/${applicationId}/financial-review/memo`, {}),
    onSuccess: () => { refresh(); toast({ title: "Credit memo built from approved workpapers" }); },
    onError: (mutationError: unknown) => toast({ title: "Could not build memo", description: friendlyApiError(mutationError, "Refresh and try again."), variant: "destructive" }),
  });
  const applyVerification = useMutation({
    mutationFn: async () => {
      if (!incomeVerified && approvedIncomeReview) {
        await apiRequest("POST", `/api/loan-applications/${applicationId}/verify/income`, {});
      }
      if (!assetsVerified && approvedAssetReview) {
        await apiRequest("POST", `/api/loan-applications/${applicationId}/verify/assets`, {});
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/loan-applications", applicationId] });
      toast({ title: "Reviewed income and assets verified", description: "The application now cites the approved financial memo as evidence." });
    },
    onError: (mutationError: unknown) => toast({ title: "Could not apply verification", description: friendlyApiError(mutationError, "Refresh the current memo and try again."), variant: "destructive" }),
  });

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-72" /></div>;
  if (error || !data) return <Alert variant="destructive" data-testid="financial-review-error"><Icons.warning className="h-4 w-4" /><AlertTitle>Financial review could not load</AlertTitle><AlertDescription>{friendlyApiError(error, "Refresh the borrower file and try again.")}</AlertDescription></Alert>;
  const currentCount = data.workpapers.filter(item => item.isCurrent && item.id).length;
  const needsRefresh = data.workpapers.some(item => !item.id || !item.isCurrent);
  const approvedCurrentMemo = !!data.memo?.isCurrent
    && data.memo.blockers.length === 0
    && data.memo.review?.action === "approve";
  const approvedIncomeReview = data.workpapers.some(workpaper =>
    workpaper.kind === "income_summary"
    && !!workpaper.id
    && workpaper.isCurrent
    && workpaper.blockers.length === 0
    && workpaper.review?.action === "approve",
  );
  const approvedAssetReview = data.workpapers.some(workpaper =>
    workpaper.kind === "asset_reconciliation"
    && !!workpaper.id
    && workpaper.isCurrent
    && workpaper.blockers.length === 0
    && workpaper.review?.action === "approve",
  );
  const reviewedFinancialsVerified = incomeVerified && assetsVerified;
  const hasVerificationToApply = (!incomeVerified && approvedIncomeReview)
    || (!assetsVerified && approvedAssetReview);
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2"><Icons.analytics className="h-5 w-5" />Financial review</CardTitle>
              <CardDescription>One review path from current borrower data and accepted evidence to a cited lender memo.</CardDescription>
            </div>
            <Button onClick={() => prepare.mutate()} disabled={!data.canPrepare || prepare.isPending} data-testid="prepare-financial-workpapers">
              <Icons.rerun className={`mr-2 h-4 w-4 ${prepare.isPending ? "animate-spin" : ""}`} />
              {needsRefresh ? "Prepare workpapers" : "Check for changes"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm"><span>{data.currentApprovedCount} of {data.requiredCount} approved</span><span>{currentCount} current</span></div>
          <Progress value={data.requiredCount ? data.currentApprovedCount / data.requiredCount * 100 : 0} aria-label="Financial workpapers approved" />
          {data.prepareBlockedReason && <p className="text-sm text-muted-foreground">{data.prepareBlockedReason}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="touch-target" variant="outline" onClick={() => onNavigate("documents")}>Review evidence</Button>
            <Button size="sm" className="touch-target" variant="outline" onClick={() => onNavigate("tax-intel")}>Review tax figures</Button>
            <Button size="sm" className="touch-target" variant="outline" onClick={() => onNavigate("financials")}>Open financials</Button>
          </div>
        </CardContent>
      </Card>

      {(data.bankStatementEvidence.documentCount > 0 || data.bankStatementAnalysis) && (
        <BankStatementAnalysisCard
          key={data.bankStatementAnalysis?.id ?? "new"}
          applicationId={applicationId}
          existing={data.bankStatementAnalysis}
          evidence={data.bankStatementEvidence}
          onSaved={refresh}
        />
      )}

      {data.workpapers.map(workpaper => (
        <WorkpaperCard
          key={workpaper.key}
          applicationId={applicationId}
          workpaper={workpaper}
          reason={reasons[workpaper.key] ?? ""}
          setReason={reason => setReasons(current => ({ ...current, [workpaper.key]: reason }))}
          onSaved={refresh}
          onOpenEvidence={onOpenEvidence}
        />
      ))}

      <Card>
        <CardHeader>
          <CardTitle>Credit memo</CardTitle>
          <CardDescription>{data.memoBlockedReason ?? "Every current workpaper is approved. Build the versioned memo."}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={() => buildMemo.mutate()} disabled={!data.canBuildMemo || buildMemo.isPending} data-testid="build-credit-memo">
            <Icons.documentVerified className="mr-2 h-4 w-4" />{data.memo ? "Build current memo" : "Build credit memo"}
          </Button>
        </CardContent>
      </Card>

      {data.memo && (
        <MemoCard
          applicationId={applicationId}
          memo={data.memo}
          reason={reasons.memo ?? ""}
          setReason={reason => setReasons(current => ({ ...current, memo: reason }))}
          onSaved={refresh}
          onOpenEvidence={onOpenEvidence}
        />
      )}

      {approvedCurrentMemo && (
        <Card data-testid="reviewed-financial-verification">
          <CardHeader>
            <CardTitle>Apply the approved review</CardTitle>
            <CardDescription>
              The current memo and every required workpaper are approved. Record only the dimensions supported by a current approved workpaper.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {reviewedFinancialsVerified ? (
              <Badge className="bg-success-subtle text-success-subtle-foreground">Income and assets verified</Badge>
            ) : canVerify && hasVerificationToApply ? (
              <Button
                onClick={() => applyVerification.mutate()}
                disabled={applyVerification.isPending}
                data-testid="apply-reviewed-financial-verification"
              >
                <Icons.done className="mr-2 h-4 w-4" />
                {applyVerification.isPending ? "Applying…" : "Verify supported financial dimensions"}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                {canVerify
                  ? "Add and approve the missing income or asset workpaper before that dimension can be verified."
                  : "A financial reviewer must apply this approved evidence."}
              </p>
            )}
            {!reviewedFinancialsVerified && (
              <p className="mt-2 text-xs text-muted-foreground" data-testid="reviewed-dimension-support">
                Income: {approvedIncomeReview ? "supported" : "missing approved workpaper"} · Assets: {approvedAssetReview ? "supported" : "missing approved workpaper"}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
