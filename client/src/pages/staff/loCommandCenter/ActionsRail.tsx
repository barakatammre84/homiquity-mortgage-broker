import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { downloadResponseAsFile } from "@/lib/downloadFile";
import { RateLockDialog } from "@/components/RateLockDialog";
import { ScenarioSimulatorDialog } from "@/components/ScenarioSimulatorDialog";
import { SubmissionReadinessDialog } from "@/components/SubmissionReadinessDialog";
import { CallPrepDialog } from "./CallPrepDialog";
import type { StaffSignal } from "./types";
import type { CockpitData } from "./types";
import { friendlyApiError } from "@/lib/errorMessage";

// -----------------------------------------------------------------------------
// Right pane — actions
// -----------------------------------------------------------------------------
export function ActionsRail({
  applicationId,
  borrowerName,
  signals,
  onExportMismo,
  exporting,
}: {
  applicationId: string;
  borrowerName: string;
  signals: StaffSignal[];
  onExportMismo: () => void;
  exporting: boolean;
}) {
  const { toast } = useToast();
  const [generatingLetter, setGeneratingLetter] = useState(false);
  const { data: cockpit } = useQuery<CockpitData>({
    queryKey: ["/api/staff/applications", applicationId, "cockpit"],
  });
  const letterStatusReady = cockpit?.application.status === "pre_approved";
  const letterFinancialsReady = cockpit?.application.currentDecisionGrade === true;
  const canGenerateLetter = letterStatusReady && letterFinancialsReady;

  const handleGenerateLetter = async () => {
    setGeneratingLetter(true);
    try {
      const res = await apiRequest("POST", `/api/loan-applications/${applicationId}/generate-letter`, {});
      await res.json().catch(() => null);
      // Download the freshly generated PDF.
      const pdf = await apiRequest("GET", `/api/loan-applications/${applicationId}/letter-pdf`).catch(() => {
        throw new Error("The letter was generated but the PDF isn't ready yet.");
      });
      await downloadResponseAsFile(pdf, `pre-approval-${applicationId}.pdf`);
      toast({ title: "Pre-approval letter ready", description: "The PDF has been downloaded." });
    } catch (error) {
      toast({
        title: "Couldn't generate the letter",
        description:
          friendlyApiError(error, "Only pre-approved files with verified data can produce a letter."),
        variant: "destructive",
      });
    } finally {
      setGeneratingLetter(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="actions-rail">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</p>

      {/* Terminal money-path action: submission-readiness → run AUS → push the
          compliant MISMO package to a wholesale lender. (Re-wired into the
          cockpit — the LO-1 three-pane consolidation dropped it.) */}
      <SubmissionReadinessDialog applicationId={applicationId} borrowerName={borrowerName} />

      <ScenarioSimulatorDialog applicationId={applicationId} borrowerName={borrowerName} />

      <RateLockDialog applicationId={applicationId} borrowerName={borrowerName} />

      <CallPrepDialog applicationId={applicationId} borrowerName={borrowerName} signals={signals} />

      <Button
        variant="outline"
        size="sm"
        className="touch-target w-full justify-start"
        onClick={handleGenerateLetter}
        disabled={generatingLetter || !canGenerateLetter}
        data-testid="action-preapproval-letter"
      >
        {generatingLetter ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
        )}
        Pre-approval letter
      </Button>
      {!canGenerateLetter && cockpit && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="preapproval-letter-blocked-reason">
          {letterStatusReady
            ? cockpit.application.decisionGradeBlockers[0] ?? "Refresh and approve the current income, asset, and credit evidence before issuing a pre-approval letter."
            : "A letter becomes available after the file reaches pre-approval with verified financials."}
        </p>
      )}

      <Button
        variant="outline"
        size="sm"
        className="touch-target w-full justify-start"
        onClick={onExportMismo}
        disabled={exporting}
        data-testid="action-export-mismo"
      >
        {exporting ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="mr-2 h-4 w-4" aria-hidden="true" />
        )}
        Export MISMO
      </Button>
    </div>
  );
}
