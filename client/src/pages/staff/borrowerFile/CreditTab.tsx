import { useState } from "react";
import { friendlyApiError } from "@/lib/errorMessage";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, loanApplicationKeys } from "@/lib/queryClient";
import { downloadResponseAsFile } from "@/lib/downloadFile";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  AlertCircle,
  AlertOctagon,
  CheckCircle2,
  CreditCard,
  Download,
  FileWarning,
  RefreshCw,
  Shield,
} from "lucide-react";
import { format } from "date-fns";
import { formatCurrency } from "@/lib/formatters";
import { type CreditSummary, type CreditAuditEntry } from "./model";
import { PreApprovalLetterCard } from "./PreApprovalLetterCard";

/**
 * Credit tab (extracted from BorrowerFile.tsx): FCRA consent status, tri-merge
 * pull, the file's pre-approval letter (with the CREDIT_DECISION_ROLES-gated
 * revocation action), adverse-action notices with the ECOA/Reg B §1002.9
 * postal-fallback delivery flow (download PDF → mail → confirm; no undo
 * endpoint), and the immutable credit audit log. Owns its own queries and
 * mutations — the parent supplies the application id and the role gate.
 */
export function CreditTab({
  applicationId,
  canRevokeLetter,
}: {
  applicationId: string;
  canRevokeLetter: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: creditData, isLoading: creditLoading } = useQuery<CreditSummary>({
    queryKey: loanApplicationKeys.credit.summary(applicationId),
    enabled: !!applicationId,
  });

  const { data: auditLog } = useQuery<{ auditLog: CreditAuditEntry[] }>({
    queryKey: loanApplicationKeys.credit.auditLog(applicationId),
    enabled: !!applicationId,
  });

  const pullCreditMutation = useMutation({
    mutationFn: async (pullType: string) => {
      const response = await apiRequest("POST", `/api/loan-applications/${applicationId}/credit/pull`, {
        pullType,
        bureaus: ["experian", "equifax", "transunion"],
      });
      return await response.json() as { pull?: { isSimulated?: boolean } };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.credit.summary(applicationId) });
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.credit.auditLog(applicationId) });
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.detail(applicationId) });
      toast({
        title: result.pull?.isSimulated ? "Credit workflow simulation complete" : "Credit pull complete",
        description: result.pull?.isSimulated
          ? "No bureau report was retrieved. This simulated result cannot verify credit or support a binding decision."
          : "The bureau credit report has been retrieved.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Credit Pull Failed",
        description: error.message || "Failed to pull credit report",
        variant: "destructive",
      });
    },
  });

  // Postal fallback for the ECOA/Reg B delivery window: download the notice as
  // a mailable PDF, send it, then confirm delivery with the method used.
  // Confirmation goes through a dialog: marking a notice delivered records the
  // Reg B §1002.9 obligation as met and there is no undo endpoint.
  const [noticeDelivery, setNoticeDelivery] = useState<{ open: boolean; method: string; confirmation: string }>({
    open: false,
    method: "mail",
    confirmation: "",
  });
  const [downloadingNotice, setDownloadingNotice] = useState(false);

  const handleDownloadAdverseActionPdf = async (adverseActionId: string) => {
    setDownloadingNotice(true);
    try {
      const res = await apiRequest(
        "GET",
        `/api/credit/adverse-action/${adverseActionId}/letter-pdf`,
      ).catch((err: unknown) => {
        throw new Error(friendlyApiError(err, "Failed to generate the notice PDF."));
      });
      await downloadResponseAsFile(res, `adverse-action-${adverseActionId.substring(0, 8)}.pdf`);
      toast({
        title: "Notice Downloaded",
        description: "Print and mail the letter, then confirm delivery below.",
      });
    } catch (error) {
      toast({
        title: "Download Failed",
        description: error instanceof Error ? error.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setDownloadingNotice(false);
    }
  };

  const confirmNoticeDeliveryMutation = useMutation({
    mutationFn: async ({ adverseActionId, method, confirmation }: { adverseActionId: string; method: string; confirmation?: string }) => {
      return apiRequest("POST", `/api/credit/adverse-action/${adverseActionId}/deliver`, {
        deliveryMethod: method,
        deliveryConfirmation: confirmation || undefined,
      });
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.credit.summary(applicationId) });
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.credit.auditLog(applicationId) });
      setNoticeDelivery({ open: false, method: "mail", confirmation: "" });
      toast({
        title: "Delivery Confirmed",
        description: `Adverse-action notice recorded as delivered via ${variables.method.replace(/_/g, "-")}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Delivery Confirmation Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-5 w-5" />
                Consent Status
              </CardTitle>
              {creditLoading && <RefreshCw className="h-4 w-4 animate-spin" />}
            </div>
          </CardHeader>
          <CardContent>
            {creditData?.hasActiveConsent ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-success-subtle-foreground" />
                  <span className="font-medium text-success-subtle-foreground" data-testid="text-consent-status">
                    Consent Active
                  </span>
                </div>
                <div className="text-sm text-muted-foreground space-y-1">
                  <p>Signed by: {creditData.consent?.borrowerFullName}</p>
                  <p>Date: {creditData.consent?.consentTimestamp && format(new Date(creditData.consent.consentTimestamp), "MMM d, yyyy 'at' h:mm a")}</p>
                  <p>Version: {creditData.consent?.disclosureVersion}</p>
                  {/*
                    Show what the borrower actually authorized. The card used to
                    show signer/date/version only, so a soft-scoped consent looked
                    identical to a hard one and staff clicked "Pull Credit" in good
                    faith (F-035). The server now refuses the mismatch; this is so
                    the human is not surprised by that refusal.
                  */}
                  <p data-testid="text-consent-scope">
                    Authorizes:{" "}
                    <span className="font-medium text-foreground">
                      {creditData.consent?.consentType === "soft_pull"
                        ? "soft inquiry only"
                        : creditData.consent?.consentType === "hard_pull"
                          ? "soft or hard inquiry"
                          : (creditData.consent?.consentType ?? "unknown")}
                    </span>
                  </p>
                </div>
                {creditData.consent?.consentType === "soft_pull" && (
                  <p
                    className="rounded-md bg-warning-subtle p-2 text-xs text-warning-subtle-foreground"
                    data-testid="text-consent-soft-only-warning"
                  >
                    This borrower authorized a soft inquiry only. A hard or tri-merge pull will be
                    refused until they authorize one.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 text-warning-subtle-foreground" />
                  <span className="font-medium text-warning-subtle-foreground" data-testid="text-consent-status">
                    No Active Consent
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  Borrower must provide credit authorization before a credit pull can be performed.
                </p>
                <Button variant="outline" size="sm" className="touch-target" asChild>
                  <Link href={`/credit-consent/${applicationId}`}>
                    Request Consent
                  </Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <CreditCard className="h-5 w-5" />
                Credit Report
              </CardTitle>
              <Button
                size="sm" className="touch-target"
                disabled={creditData?.consent?.consentType !== "hard_pull" || pullCreditMutation.isPending}
                onClick={() => pullCreditMutation.mutate("tri_merge")}
                data-testid="button-pull-credit"
              >
                {pullCreditMutation.isPending ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    Pulling...
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Pull Credit
                  </>
                )}
              </Button>
            </div>
            {creditData?.hasActiveConsent && creditData.consent?.consentType !== "hard_pull" && (
              <CardDescription data-testid="text-credit-pull-blocked-by-consent">
                Waiting for the borrower to authorize a hard inquiry before a tri-merge can be requested.
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {creditData?.latestPull ? (
              <div className="space-y-4">
                {creditData.latestPull.isSimulated && (
                  <div
                    className="rounded-md border bg-warning-subtle px-3 py-2 text-xs font-medium text-warning-subtle-foreground"
                    data-testid="badge-simulated-pull"
                  >
                    Simulated credit data — no live bureau pull. Not for a binding decision.
                  </div>
                )}
                <div className="grid grid-cols-4 gap-4 text-center">
                  <div>
                    <p className="text-xs text-muted-foreground">Representative</p>
                    <p className="text-2xl font-bold" data-testid="text-rep-score">
                      {creditData.latestPull.representativeScore || "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Experian</p>
                    <p className="text-lg font-semibold" data-testid="text-exp-score">
                      {creditData.latestPull.experianScore || "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Equifax</p>
                    <p className="text-lg font-semibold" data-testid="text-eqf-score">
                      {creditData.latestPull.equifaxScore || "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">TransUnion</p>
                    <p className="text-lg font-semibold" data-testid="text-tu-score">
                      {creditData.latestPull.transunionScore || "—"}
                    </p>
                  </div>
                </div>
                <Separator />
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Tradelines:</span>
                    <span className="ml-2 font-medium">
                      {creditData.latestPull.openTradelines}/{creditData.latestPull.totalTradelines}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Derogatory:</span>
                    <span className="ml-2 font-medium">
                      {creditData.latestPull.derogatoryCount || 0}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Total Debt:</span>
                    <span className="ml-2 font-medium">
                      {formatCurrency(creditData.latestPull.totalDebt)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Monthly Payments:</span>
                    <span className="ml-2 font-medium">
                      {formatCurrency(creditData.latestPull.monthlyPayments)}
                    </span>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  Pulled: {creditData.latestPull.completedAt && format(new Date(creditData.latestPull.completedAt), "MMM d, yyyy")}
                  {creditData.latestPull.expiresAt && ` • Expires: ${format(new Date(creditData.latestPull.expiresAt), "MMM d, yyyy")}`}
                </div>
              </div>
            ) : (
              <div className="text-center py-6">
                <CreditCard className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
                <p className="text-muted-foreground">
                  No credit report on file
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {creditData?.pullCount || 0} previous pull(s)
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <PreApprovalLetterCard applicationId={applicationId} canRevoke={canRevokeLetter} />

      {creditData?.adverseActionCount && creditData.adverseActionCount > 0 && (
        <Card className="border-border">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertOctagon className="h-5 w-5" />
              Adverse Action Notices ({creditData.adverseActionCount})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {creditData.latestAdverseAction && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium capitalize">
                    {creditData.latestAdverseAction.actionType.replace(/_/g, " ")}
                  </span>
                  <Badge variant={creditData.latestAdverseAction.deliveredAt ? "default" : "secondary"}>
                    {creditData.latestAdverseAction.deliveredAt ? "Delivered" : "Pending Delivery"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {creditData.latestAdverseAction.primaryReason}
                </p>
                <p className="text-xs text-muted-foreground">
                  Generated: {format(new Date(creditData.latestAdverseAction.noticeDate), "MMM d, yyyy")}
                </p>
                {creditData.latestAdverseAction.deliveredAt ? (
                  <p className="text-xs text-muted-foreground" data-testid="text-notice-delivered">
                    Delivered
                    {creditData.latestAdverseAction.deliveryMethod
                      ? ` via ${creditData.latestAdverseAction.deliveryMethod.replace(/_/g, "-")}`
                      : ""}
                    : {format(new Date(creditData.latestAdverseAction.deliveredAt), "MMM d, yyyy")}
                  </p>
                ) : (
                  <>
                    <Separator />
                    <p className="text-xs text-muted-foreground">
                      Reg B §1002.9 requires the applicant be notified within 30 days of the
                      decision. If the borrower hasn't seen the in-app notice, download the
                      letter, mail it, then confirm delivery here.
                    </p>
                  </>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm" className="touch-target"
                    onClick={() => handleDownloadAdverseActionPdf(creditData.latestAdverseAction!.id)}
                    disabled={downloadingNotice}
                    data-testid="button-download-adverse-action-pdf"
                  >
                    <Download className="h-4 w-4 mr-2" />
                    {downloadingNotice ? "Preparing…" : "Download for mailing"}
                  </Button>
                  {!creditData.latestAdverseAction.deliveredAt && (
                    <Dialog
                      open={noticeDelivery.open}
                      onOpenChange={(o) => setNoticeDelivery(prev => ({ ...prev, open: o }))}
                    >
                      <DialogTrigger asChild>
                        <Button size="sm" className="touch-target" data-testid="button-confirm-notice-delivery">
                          <CheckCircle2 className="h-4 w-4 mr-2" />
                          Confirm delivery
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Confirm notice delivery</DialogTitle>
                          <DialogDescription>
                            This records the adverse-action notice as delivered, satisfying the
                            Reg B §1002.9 notification requirement. It cannot be undone — confirm
                            only after the notice has actually been sent to the borrower.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                          <div className="space-y-2">
                            <Label>Delivery method</Label>
                            <Select
                              value={noticeDelivery.method}
                              onValueChange={(v) => setNoticeDelivery(prev => ({ ...prev, method: v }))}
                            >
                              <SelectTrigger data-testid="select-notice-delivery-method">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="mail">Mail</SelectItem>
                                <SelectItem value="email">Email</SelectItem>
                                <SelectItem value="in_app">In-app</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label>Delivery confirmation (optional)</Label>
                            <Input
                              value={noticeDelivery.confirmation}
                              onChange={(e) => setNoticeDelivery(prev => ({ ...prev, confirmation: e.target.value }))}
                              placeholder="e.g., certified-mail tracking number"
                              maxLength={255}
                              data-testid="input-notice-delivery-confirmation"
                            />
                          </div>
                        </div>
                        <DialogFooter>
                          <Button
                            variant="outline"
                            onClick={() => setNoticeDelivery({ open: false, method: "mail", confirmation: "" })}
                            data-testid="button-cancel-notice-delivery"
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={() =>
                              confirmNoticeDeliveryMutation.mutate({
                                adverseActionId: creditData.latestAdverseAction!.id,
                                method: noticeDelivery.method,
                                confirmation: noticeDelivery.confirmation.trim() || undefined,
                              })
                            }
                            disabled={confirmNoticeDeliveryMutation.isPending}
                            data-testid="button-confirm-notice-delivery-submit"
                          >
                            <CheckCircle2 className="h-4 w-4 mr-2" />
                            {confirmNoticeDeliveryMutation.isPending ? "Confirming…" : "Confirm delivery"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileWarning className="h-5 w-5" />
            Credit Audit Log
          </CardTitle>
          <CardDescription>
            Immutable record of all credit-related actions for FCRA compliance
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-[200px]">
            {auditLog?.auditLog && auditLog.auditLog.length > 0 ? (
              <div className="space-y-2">
                {auditLog.auditLog.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-start justify-between text-sm border-b pb-2 last:border-0"
                  >
                    <div>
                      <p className="font-medium capitalize">
                        {entry.action.replace(/_/g, " ")}
                      </p>
                      {entry.actionDetails && (
                        <p className="text-xs text-muted-foreground">
                          {JSON.stringify(entry.actionDetails)}
                        </p>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {format(new Date(entry.timestamp), "MMM d, h:mm a")}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-center text-muted-foreground py-8">
                No credit activity recorded yet.
              </p>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </>
  );
}
