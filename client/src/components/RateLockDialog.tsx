import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, loanApplicationKeys } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { friendlyApiError } from "@/lib/errorMessage";
import { Clock, Lock, RefreshCw, XCircle } from "lucide-react";
import { OPEN_RATE_LOCK_STATUSES } from "@shared/statusVocabularies";
import type { LoanOption, RateLock } from "@shared/schema";
// -----------------------------------------------------------------------------
// Rate-lock desk — the loan officer's lock/extend/cancel control for one file.
//
// Surfaces the rate_locks backend (create/extend/cancel + expiration) that had
// no UI: GET /api/rate-locks/application/:id and POST /api/rate-locks[/:id/...].
// Mirrors SubmissionReadinessDialog — a self-contained per-row dialog that
// fetches lazily on open. The server re-enforces every gate; this is the
// convenience surface, not the enforcement point.
//
// Locking on the borrower's behalf is procedural (Reg Z anti-steering is the
// borrower's own acknowledgement, enforced on the borrower path); this desk is
// internal-staff only.
// -----------------------------------------------------------------------------

const LOCK_PERIODS = [15, 30, 45, 60, 90] as const;

function daysUntil(expiresAt: string | Date): number {
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
}

interface RateLockDialogProps {
  applicationId: string;
  borrowerName: string;
}

interface WholesaleLenderOption {
  lenderId: string;
  lenderName: string;
  approvalStatus: string;
  isDemo: boolean;
  status: string | null;
}

function lenderStatusLabel(lender: WholesaleLenderOption): string {
  if (lender.isDemo) return "demo — indicative only";
  if (lender.approvalStatus === "approved") return "approved";
  return `${lender.approvalStatus.replaceAll("_", " ")} — indicative only`;
}

export function RateLockDialog({ applicationId, borrowerName }: RateLockDialogProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [optionId, setOptionId] = useState("");
  const [lockPeriod, setLockPeriod] = useState("30");
  const [lenderId, setLenderId] = useState("");
  const [confirmationNumber, setConfirmationNumber] = useState("");
  const [confirmedRate, setConfirmedRate] = useState("");
  const [confirmedExpiresAt, setConfirmedExpiresAt] = useState("");
  const [extensionDays, setExtensionDays] = useState("15");
  const [extensionConfirmation, setExtensionConfirmation] = useState("");
  const [extensionExpiresAt, setExtensionExpiresAt] = useState("");
  const [extensionFee, setExtensionFee] = useState("");
  const [extensionFeePaidBy, setExtensionFeePaidBy] = useState("");
  const [extensionFeeCocId, setExtensionFeeCocId] = useState("");

  // Segments, not a template string. Written as
  // [`/api/rate-locks/application/${applicationId}`] this fetched the same URL
  // but slipped past `guard:querykeys`, whose regex only fires on a template
  // key written INLINE in `queryKey:` — hoisting it into a const hid it.
  const locksKey = ["/api/rate-locks/application", applicationId] as const;
  const { data: locks, isLoading: locksLoading } = useQuery<RateLock[]>({
    queryKey: locksKey,
    enabled: open,
  });
  const { data: optionsData } = useQuery<{ options: LoanOption[] }>({
    queryKey: loanApplicationKeys.options(applicationId),
    enabled: open,
  });
  const { data: lenders } = useQuery<WholesaleLenderOption[]>({
    queryKey: ["/api/wholesale-lenders"],
    enabled: open,
  });

  const activeLock = locks?.find((lock) => OPEN_RATE_LOCK_STATUSES.includes(lock.status));
  const options = optionsData?.options ?? [];
  const activeLenders = (lenders ?? []).filter((lender) => lender.status?.toUpperCase() !== "INACTIVE");

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: locksKey });
    // No ["/api/rate-locks/expiring"] here: GET /api/rate-locks/expiring exists
    // on the server but no client surface queries it, so invalidating it was
    // inert. Add it back alongside the query if a expiring-locks view lands.
  };

  const createLock = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/rate-locks", {
        applicationId,
        loanOptionId: optionId,
        lockPeriodDays: Number(lockPeriod),
        lenderId,
        lockConfirmationNumber: confirmationNumber.trim(),
        confirmedRate: Number(confirmedRate),
        confirmedExpiresAt: new Date(confirmedExpiresAt).toISOString(),
      });
      return res.json();
    },
    onSuccess: (created: RateLock) => {
      refresh();
      toast(created.simulated
        ? {
            title: "Indicative quote recorded",
            description: "No approved lender is committed to this rate. It is not a rate lock.",
          }
        : { title: "Lender-confirmed rate lock recorded", description: `Confirmed for ${lockPeriod} days.` });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not record the lender confirmation",
        description: friendlyApiError(error, "Check the confirmation details and try again."),
        variant: "destructive",
      });
    },
  });

  const extendLock = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/rate-locks/${activeLock!.id}/extend`, {
        additionalDays: Number(extensionDays),
        lockConfirmationNumber: extensionConfirmation.trim(),
        confirmedExpiresAt: new Date(extensionExpiresAt).toISOString(),
        ...(extensionFee ? { extensionFee: Number(extensionFee) } : {}),
        ...(extensionFeePaidBy ? { extensionFeePaidBy } : {}),
        ...(extensionFeeCocId.trim() ? { extensionFeeCocId: extensionFeeCocId.trim() } : {}),
      });
      return res.json();
    },
    onSuccess: () => {
      refresh();
      setExtensionConfirmation("");
      setExtensionExpiresAt("");
      setExtensionFee("");
      setExtensionFeePaidBy("");
      setExtensionFeeCocId("");
      toast({ title: "Lender-confirmed extension recorded" });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not record the extension",
        description: friendlyApiError(error, "Check the lender confirmation and try again."),
        variant: "destructive",
      });
    },
  });

  const cancelLock = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/rate-locks/${activeLock!.id}/cancel`, {
        reason: "Cancelled from LO Command Center",
      });
      return res.json();
    },
    onSuccess: () => {
      refresh();
      toast({ title: "Lock cancelled" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not cancel the lock", description: error.message, variant: "destructive" });
    },
  });

  const remaining = activeLock ? daysUntil(activeLock.expiresAt) : null;
  const countdownAmber = remaining !== null && remaining > 3 && remaining <= 7;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="touch-target" data-testid={`rate-lock-${applicationId}`}>
          <Lock className="mr-1 h-4 w-4" aria-hidden="true" />
          Rate desk
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rate desk — {borrowerName}</DialogTitle>
          <DialogDescription>
            Record the wholesale lender&apos;s confirmation exactly as issued. The borrower&apos;s
            loan-options acknowledgement remains a separate step.
          </DialogDescription>
        </DialogHeader>

        {locksLoading ? (
          <Skeleton className="h-40" data-testid="rate-lock-loading" />
        ) : activeLock ? (
          <div className="space-y-4">
            <div className="rounded-md border border-border p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-2xl font-bold tabular-nums">{activeLock.interestRate}%</p>
                  <Badge variant={activeLock.simulated ? "secondary" : "outline"} className="mt-1">
                    {activeLock.simulated ? "Indicative quote — no lender commitment" : "Lender-confirmed lock"}
                  </Badge>
                </div>
                <Badge
                  variant={remaining !== null && remaining <= 3 ? "destructive" : "outline"}
                  className={countdownAmber ? "bg-warning-subtle text-warning-subtle-foreground" : undefined}
                  data-testid="lock-countdown"
                >
                  <Clock className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  {remaining !== null && remaining <= 0
                    ? "Expired"
                    : `${remaining} day${remaining === 1 ? "" : "s"} left`}
                </Badge>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                <div>
                  <dt className="inline">Locked </dt>
                  <dd className="inline text-foreground">{new Date(activeLock.lockedAt).toLocaleDateString()}</dd>
                </div>
                <div>
                  <dt className="inline">Expires </dt>
                  <dd className="inline text-foreground">{new Date(activeLock.expiresAt).toLocaleDateString()}</dd>
                </div>
                <div>
                  <dt className="inline">Term </dt>
                  <dd className="inline text-foreground">{activeLock.lockPeriodDays} days</dd>
                </div>
                <div>
                  <dt className="inline">Loan </dt>
                  <dd className="inline text-foreground">{activeLock.loanType} · {activeLock.loanTerm}yr</dd>
                </div>
              </dl>
              {(activeLock.extensionCount ?? 0) > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Extended {activeLock.extensionCount}× from the original lock.
                </p>
              )}
            </div>
            {!activeLock.simulated ? (
            <div className="rounded-md border border-border p-4 space-y-3" data-testid="lock-extension-form">
              <p className="text-sm font-medium">Record a lender-confirmed extension</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="extension-days">Additional days</Label>
                  <Input id="extension-days" type="number" min="1" max="90" value={extensionDays} onChange={(event) => setExtensionDays(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="extension-expires">Confirmed expiration</Label>
                  <Input id="extension-expires" type="datetime-local" value={extensionExpiresAt} onChange={(event) => setExtensionExpiresAt(event.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="extension-confirmation">Lender confirmation number</Label>
                <Input id="extension-confirmation" value={extensionConfirmation} onChange={(event) => setExtensionConfirmation(event.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="extension-fee">Extension fee (optional)</Label>
                  <Input id="extension-fee" type="number" min="0" step="0.01" value={extensionFee} onChange={(event) => setExtensionFee(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="extension-fee-payer">Fee paid by</Label>
                  <Select value={extensionFeePaidBy} onValueChange={setExtensionFeePaidBy}>
                    <SelectTrigger id="extension-fee-payer"><SelectValue placeholder="Choose payer" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="broker">Broker</SelectItem>
                      <SelectItem value="lender">Lender</SelectItem>
                      <SelectItem value="borrower">Borrower</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {extensionFeePaidBy === "borrower" && (
                <div className="space-y-1.5">
                  <Label htmlFor="extension-coc">Change-of-circumstance record ID</Label>
                  <Input id="extension-coc" value={extensionFeeCocId} onChange={(event) => setExtensionFeeCocId(event.target.value)} />
                  <p className="text-xs text-muted-foreground">Required before a borrower-paid fee can be recorded.</p>
                </div>
              )}
              <Button
                variant="outline"
                className="w-full"
                disabled={
                  extendLock.isPending ||
                  !extensionConfirmation.trim() ||
                  !extensionExpiresAt ||
                  !extensionDays ||
                  (Boolean(extensionFee) && !extensionFeePaidBy) ||
                  (extensionFeePaidBy === "borrower" && !extensionFeeCocId.trim())
                }
                onClick={() => extendLock.mutate()}
                data-testid="extend-lock"
              >
                <RefreshCw className="mr-1 h-4 w-4" aria-hidden="true" />
                Record extension
              </Button>
            </div>
            ) : (
              <p className="rounded-md border border-border p-3 text-sm text-muted-foreground" data-testid="indicative-extension-blocked">
                An indicative quote cannot be extended as a lock. Obtain a real wholesale lender confirmation and record a new lock.
              </p>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="w-full text-destructive"
                disabled={cancelLock.isPending}
                onClick={() => cancelLock.mutate()}
                data-testid="cancel-lock"
              >
                <XCircle className="mr-1 h-4 w-4" aria-hidden="true" />
                Cancel lock
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {options.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="no-options">
                No priced loan options on this file yet. Price the file first, then lock a rate.
              </p>
            ) : (
              <>
                {activeLenders.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="no-lock-lenders">
                    No active wholesale lenders are configured. Add a counterparty before recording a quote or lock.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="lock-lender">Wholesale lender</Label>
                    <Select value={lenderId} onValueChange={setLenderId}>
                      <SelectTrigger id="lock-lender" data-testid="lock-lender-select">
                        <SelectValue placeholder="Choose the confirming lender" />
                      </SelectTrigger>
                      <SelectContent>
                        {activeLenders.map((lender) => (
                          <SelectItem key={lender.lenderId} value={lender.lenderId} data-testid={`lock-lender-option-${lender.lenderId}`}>
                            {lender.lenderName} · {lenderStatusLabel(lender)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="lock-option">Loan option</label>
                  <Select value={optionId} onValueChange={(value) => {
                    setOptionId(value);
                    const selected = options.find((option) => option.id === value);
                    if (selected) setConfirmedRate(String(selected.interestRate));
                  }}>
                    <SelectTrigger id="lock-option" data-testid="lock-option-select">
                      <SelectValue placeholder="Choose an option to lock" />
                    </SelectTrigger>
                    <SelectContent>
                      {options.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.interestRate}% · {option.loanType} · {option.loanTerm}yr
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium" htmlFor="lock-period">Lock period</label>
                  <Select value={lockPeriod} onValueChange={setLockPeriod}>
                    <SelectTrigger id="lock-period" data-testid="lock-period-select">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LOCK_PERIODS.map((period) => (
                        <SelectItem key={period} value={String(period)}>{period} days</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="confirmed-rate">Lender-confirmed rate</Label>
                    <Input id="confirmed-rate" type="number" min="0.001" max="99" step="0.001" value={confirmedRate} onChange={(event) => setConfirmedRate(event.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="confirmed-expires">Lender-confirmed expiration</Label>
                    <Input id="confirmed-expires" type="datetime-local" value={confirmedExpiresAt} onChange={(event) => setConfirmedExpiresAt(event.target.value)} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lock-confirmation">Lender confirmation number</Label>
                  <Input id="lock-confirmation" value={confirmationNumber} onChange={(event) => setConfirmationNumber(event.target.value)} />
                </div>
                <Button
                  className="w-full"
                  disabled={
                    !lenderId ||
                    !optionId ||
                    !confirmationNumber.trim() ||
                    !confirmedRate ||
                    !confirmedExpiresAt ||
                    createLock.isPending
                  }
                  onClick={() => createLock.mutate()}
                  data-testid="submit-lock"
                >
                  <Lock className="mr-1 h-4 w-4" aria-hidden="true" />
                  Record lender confirmation
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
