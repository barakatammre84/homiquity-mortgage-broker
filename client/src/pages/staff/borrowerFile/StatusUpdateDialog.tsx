import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, loanApplicationKeys } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";
import { RefreshCw } from "lucide-react";
import { getStatusLabel } from "@/lib/formatters";
import { STAFF_SETTABLE_STATUSES, isApprovalOutcomeStatus, isProtectedCreditDecisionStatus } from "@shared/loanApplicationStatus";
import { HMDA_DENIAL_REASONS } from "./model";

/**
 * The "Update Application Status" dialog (extracted from BorrowerFile.tsx).
 * Options derive from STAFF_SETTABLE_STATUSES — the server's staffStatusSchema
 * accepts exactly this list; hand-listing statuses here is the phantom-status
 * bug class (#247, tests/statusVocabulary.test.ts). Credit-decision statuses
 * are greyed for roles outside CREDIT_DECISION_ROLES, mirroring the server's
 * 403 on PATCH /:id/status; approval outcomes are blocked while financials are
 * unverified, mirroring the server's assertVerifiedForDecisioning 422.
 */
export function StatusUpdateDialog({
  applicationId,
  currentDecisionGrade,
  decisionGradeBlockers = [],
  canSetCreditDecisions,
}: {
  applicationId: string;
  currentDecisionGrade: boolean;
  decisionGradeBlockers?: string[];
  canSetCreditDecisions: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [statusUpdate, setStatusUpdate] = useState<{ open: boolean; status: string; notes: string; denialReasons: string[] }>({ open: false, status: "", notes: "", denialReasons: [] });

  const statusUpdateMutation = useMutation({
    mutationFn: async ({ status, notes, denialReasons }: { status: string; notes?: string; denialReasons?: string[] }) => {
      return apiRequest("PATCH", `/api/loan-applications/${applicationId}/status`, { status, notes, denialReasons });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.detail(applicationId) });
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.pipeline(applicationId) });
      toast({ title: "Status Updated", description: `Application status has been changed.` });
      setStatusUpdate({ open: false, status: "", notes: "", denialReasons: [] });
    },
    onError: (error: Error) => {
      toast({ title: "Update Failed", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={statusUpdate.open} onOpenChange={(o) => setStatusUpdate(prev => ({ ...prev, open: o }))}>
      <DialogTrigger asChild>
        <Button size="sm" className="touch-target" variant="outline" data-testid="button-update-status">
          <RefreshCw className="mr-1 h-3 w-3" /> Update Status
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Application Status</DialogTitle>
          <DialogDescription>
            Change the application status. The borrower will be notified.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>New Status</Label>
            <Select value={statusUpdate.status} onValueChange={(v) => setStatusUpdate(prev => ({ ...prev, status: v }))}>
              <SelectTrigger data-testid="select-new-status">
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                {/* Derived from the canonical vocabulary — the server's
                    staffStatusSchema accepts exactly this list. Hand-listing
                    statuses here is the phantom-status bug class
                    (tests/statusVocabulary.test.ts). */}
                {STAFF_SETTABLE_STATUSES.map((s) => {
                  const locked = isProtectedCreditDecisionStatus(s) && !canSetCreditDecisions;
                  return (
                    <SelectItem key={s} value={s} disabled={locked} data-testid={`option-status-${s}`}>
                      {getStatusLabel(s)}
                      {locked && " (underwriter/admin only)"}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          {statusUpdate.status === "denied" && (
            <div className="space-y-2">
              <Label>Denial Reasons (HMDA — select at least 2)</Label>
              <div className="space-y-2 rounded-md border p-3">
                {HMDA_DENIAL_REASONS.map((reason) => {
                  const checked = statusUpdate.denialReasons.includes(reason);
                  return (
                    <label key={reason} className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) =>
                          setStatusUpdate(prev => ({
                            ...prev,
                            denialReasons: value
                              ? [...prev.denialReasons, reason]
                              : prev.denialReasons.filter(r => r !== reason),
                          }))
                        }
                        data-testid={`checkbox-denial-${reason}`}
                      />
                      {reason}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label>Notes (optional)</Label>
            <Textarea
              value={statusUpdate.notes}
              onChange={(e) => setStatusUpdate(prev => ({ ...prev, notes: e.target.value }))}
              placeholder="Reason for status change..."
              data-testid="input-status-notes"
            />
          </div>
        </div>
        {/* Same set the server 422s on via assertVerifiedForDecisioning:
            every approval outcome, not just pre_approved. */}
        {isApprovalOutcomeStatus(statusUpdate.status) &&
          !currentDecisionGrade && (
            <div className="rounded-md border border-border bg-warning-subtle p-3 text-sm text-warning-subtle-foreground">
              Current approved financial and credit evidence is required before an approval outcome can be set.
              {decisionGradeBlockers.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {decisionGradeBlockers.map(blocker => <li key={blocker}>{blocker}</li>)}
                </ul>
              )}
            </div>
          )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setStatusUpdate({ open: false, status: "", notes: "", denialReasons: [] })}>
            Cancel
          </Button>
          <Button
            disabled={
              !statusUpdate.status ||
              statusUpdateMutation.isPending ||
              (statusUpdate.status === "denied" && statusUpdate.denialReasons.length < 2) ||
              (isApprovalOutcomeStatus(statusUpdate.status) &&
                !currentDecisionGrade)
            }
            onClick={() => statusUpdateMutation.mutate({
              status: statusUpdate.status,
              notes: statusUpdate.notes || undefined,
              denialReasons: statusUpdate.status === "denied" ? statusUpdate.denialReasons : undefined,
            })}
            data-testid="button-confirm-status-update"
          >
            {statusUpdateMutation.isPending ? "Updating..." : "Update Status"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
