import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, loanApplicationKeys } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Icons, iconSize } from "@/lib/icons";
import { format } from "date-fns";
import { PRE_APPROVAL_LETTER_STATUS } from "@shared/statusVocabularies";
import type { PreApprovalLetterStatus } from "@shared/schema";
import { letterRevocationSchema } from "@shared/letters";

/**
 * Staff view of the file's current pre-approval letter with the revocation
 * action (#340's route). Status comes from GET letter-status, which already
 * computes expiry at read (effectiveLetterStatus) — no client-side date math.
 *
 * `canRevoke` mirrors the server gate on POST /api/pre-approval-letters/
 * :letterId/revoke (CREDIT_DECISION_ROLES); the button also only renders for
 * "issued" letters, mirroring the route's issued-only SQL transition — the
 * card never offers an action the server would reject.
 */

type LetterStatusResponse = {
  hasLetter: boolean;
  letterId?: string;
  letterNumber?: string;
  status?: string;
  expirationDate?: string;
  generatedAt?: string | null;
  revokedAt?: string | null;
  pdfAvailable?: boolean;
};

// One entry per shared PRE_APPROVAL_LETTER_STATUS — the Record type keeps this
// exhaustive at compile time; the colocated test pins it against the shared
// vocabulary (the #247 phantom-status bug class).
export const LETTER_STATUS_BADGE: Record<
  PreApprovalLetterStatus,
  { label: string; variant: "success" | "warning" | "destructive" | "secondary" }
> = {
  draft: { label: "Draft", variant: "secondary" },
  issued: { label: "Issued", variant: "success" },
  stale: { label: "Stale", variant: "destructive" },
  superseded: { label: "Superseded", variant: "secondary" },
  expired: { label: "Expired", variant: "warning" },
  revoked: { label: "Revoked", variant: "destructive" },
};

function isKnownLetterStatus(status: string | undefined): status is PreApprovalLetterStatus {
  return !!status && (PRE_APPROVAL_LETTER_STATUS as readonly string[]).includes(status);
}

export function PreApprovalLetterCard({
  applicationId,
  canRevoke,
}: {
  applicationId: string;
  canRevoke: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [revokeDialog, setRevokeDialog] = useState<{ open: boolean; reason: string }>({
    open: false,
    reason: "",
  });

  const { data: letter, isLoading } = useQuery<LetterStatusResponse>({
    queryKey: loanApplicationKeys.letterStatus(applicationId),
    enabled: !!applicationId,
  });

  const revokeMutation = useMutation({
    mutationFn: async ({ letterId, reason }: { letterId: string; reason: string }) => {
      return apiRequest("POST", `/api/pre-approval-letters/${letterId}/revoke`, { reason });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: loanApplicationKeys.letterStatus(applicationId) });
      setRevokeDialog({ open: false, reason: "" });
      toast({
        title: "Letter Revoked",
        description:
          "The letter is no longer valid and its download is blocked. The borrower has been notified.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Revocation Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Same gate the server 400s on — the confirm button can never offer a
  // submission the shared schema rejects.
  const reasonValid = letterRevocationSchema.safeParse({ reason: revokeDialog.reason }).success;

  const badge = isKnownLetterStatus(letter?.status) ? LETTER_STATUS_BADGE[letter.status] : undefined;
  const revocable = canRevoke && letter?.status === "issued" && !!letter.letterId;

  return (
    <Card data-testid="card-preapproval-letter">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Icons.documentVerified className={iconSize.emphasis} />
            Pre-Approval Letter
          </CardTitle>
          {isLoading ? (
            <Icons.rerun className={`${iconSize.inline} animate-spin`} aria-label="Loading letter status" />
          ) : (
            badge && (
              <Badge variant={badge.variant} data-testid="badge-letter-status">
                {badge.label}
              </Badge>
            )
          )}
        </div>
      </CardHeader>
      <CardContent>
        {letter?.hasLetter ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <span className="text-muted-foreground">Letter #:</span>
              <span className="font-medium" data-testid="text-letter-number">
                {letter.letterNumber}
              </span>
              {letter.generatedAt && (
                <>
                  <span className="text-muted-foreground">Issued:</span>
                  <span>{format(new Date(letter.generatedAt), "MMM d, yyyy")}</span>
                </>
              )}
              {letter.expirationDate && (
                <>
                  <span className="text-muted-foreground">Expires:</span>
                  <span data-testid="text-letter-expiration">
                    {format(new Date(letter.expirationDate), "MMM d, yyyy")}
                  </span>
                </>
              )}
              {letter.revokedAt && (
                <>
                  <span className="text-muted-foreground">Revoked:</span>
                  <span data-testid="text-letter-revoked-at">
                    {format(new Date(letter.revokedAt), "MMM d, yyyy")}
                  </span>
                </>
              )}
            </div>
            {letter.status === "stale" && (
              <p className="text-sm text-destructive" data-testid="text-letter-stale">
                Financial facts or underwriting policy changed after this letter was issued. Re-run the decision and issue a new letter before using it.
              </p>
            )}
            {revocable && (
              <Dialog
                open={revokeDialog.open}
                onOpenChange={(o) => setRevokeDialog((prev) => ({ ...prev, open: o }))}
              >
                <DialogTrigger asChild>
                  <Button variant="destructive" size="sm" className="touch-target" data-testid="button-revoke-letter">
                    <Icons.reject className={`${iconSize.inline} mr-2`} />
                    Revoke letter
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Revoke pre-approval letter</DialogTitle>
                    <DialogDescription>
                      This permanently invalidates letter #{letter.letterNumber}: its PDF can no
                      longer be downloaded and the borrower is notified in-app. The reason is
                      recorded in the audit trail and is not shown to the borrower. This cannot
                      be undone.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-2 py-2">
                    <Label htmlFor="revocation-reason">Revocation reason</Label>
                    <Textarea
                      id="revocation-reason"
                      value={revokeDialog.reason}
                      onChange={(e) =>
                        setRevokeDialog((prev) => ({ ...prev, reason: e.target.value }))
                      }
                      placeholder="e.g., material change in the borrower's financial condition"
                      maxLength={2000}
                      data-testid="input-revocation-reason"
                    />
                    <p className="text-xs text-muted-foreground">
                      Required — at least 10 characters. Kept in the audit record only.
                    </p>
                  </div>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setRevokeDialog({ open: false, reason: "" })}
                      data-testid="button-cancel-revoke-letter"
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={!reasonValid || revokeMutation.isPending}
                      onClick={() =>
                        revokeMutation.mutate({
                          letterId: letter.letterId!,
                          reason: revokeDialog.reason.trim(),
                        })
                      }
                      data-testid="button-confirm-revoke-letter"
                    >
                      <Icons.reject className={`${iconSize.inline} mr-2`} />
                      {revokeMutation.isPending ? "Revoking…" : "Revoke letter"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
          </div>
        ) : (
          !isLoading && (
            <p className="text-sm text-muted-foreground" data-testid="text-no-letter">
              No pre-approval letter has been issued for this file.
            </p>
          )
        )}
      </CardContent>
    </Card>
  );
}
