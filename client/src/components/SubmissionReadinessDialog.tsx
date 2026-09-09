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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle2, ChevronDown, CircleDashed, Send, XCircle } from "lucide-react";
import { SubmissionLifecycleControl } from "@/components/SubmissionLifecycleControl";
import {
  PackageConformanceBadge,
  type XsdConformance,
} from "@/components/PackageConformanceBadge";
import type { LenderSubmissionStatus } from "@shared/wholesaleLenders";

// -----------------------------------------------------------------------------
// Submission readiness + submit-to-lender dialog.
//
// Lazily fetches the broker workflow report when opened:
//   GET /api/loan-applications/:id/submission-readiness  (stages 1–4)
//   GET /api/loan-applications/:id/lender-submissions    (history)
//   GET /api/wholesale-lenders                           (Target-5 catalog)
// and submits via POST /api/loan-applications/:id/lender-submissions — the
// server re-runs the readiness gate, so this UI is a convenience, not the
// enforcement point.
// -----------------------------------------------------------------------------

type StageStatus = "ready" | "blocked" | "attention" | "not_applicable";

interface SubmissionStage {
  key: string;
  label: string;
  status: StageStatus;
  blockers: string[];
  warnings: string[];
}

interface ReadinessReport {
  applicationId: string;
  readyToSubmitToLender: boolean;
  currentStage: string;
  stages: SubmissionStage[];
  nextActions: string[];
}

/**
 * A row from `GET /api/wholesale-lenders` — the whole `wholesale_lenders` row
 * minus `apiConfig` (server/routes/underwriting/submissions.ts).
 *
 * The table carries TWO identifiers and they are not interchangeable (F-0818-09):
 * `id` is a `gen_random_uuid()` primary key, while `lenderId` is the business key
 * ("uwm") that `getWholesaleLenderByLenderId` resolves a submission on —
 * `WHERE lender_id = $1`, with no fallback. Posting the uuid throws
 * "Unknown wholesale lender <uuid>" before the counterparty gate is reached.
 * **Send `lenderId`; display `lenderName`.** There is no `name` column.
 */
interface WholesaleLender {
  id: string;
  lenderId: string;
  lenderName: string;
  specialty: string | null;
  approvalStatus: string;
}

interface LenderSubmissionRow {
  id: string;
  lenderId: string;
  status: string;
  confirmationId: string | null;
  simulated: boolean;
  submittedAt: string;
  ausFindingsHash?: string | null;
  /** Rollup of loan_conditions rows linked to this submission (lender-issued). */
  conditionStats?: { total: number; open: number; cleared: number };
  /**
   * The immutable snapshot taken at submit time. Already on this payload — the
   * recorded XSD result is read straight off it, no extra round trip.
   */
  readinessSnapshot?: { xsdConformance?: XsdConformance | null } | null;
}

/**
 * The persisted shape of an AUS run (server/services/ausSubmission.ts, written
 * onto loan_applications.ausFindings by routes/aus.ts — the LPA leg rides
 * nested under `lpa`). Selling Guide B3-2-11 (p.317): the DU Underwriting
 * Findings report "summarizes the overall underwriting recommendation … and
 * lists certain steps necessary for the lender to complete the processing of
 * the loan file"; B3-2-01 (p.290) calls it "typically the first report viewed
 * by an underwriter or a loan officer". Until 2026-08-23 the run's findings
 * were persisted and returned to this client — and no surface rendered them.
 */
interface AusMessage {
  code: string;
  severity: "info" | "condition" | "risk" | string;
  text: string;
}

interface AusFindings {
  simulated?: boolean;
  casefileId?: string;
  duVersion?: string;
  recommendation?: string;
  decisionPath?: "automated" | "manual_underwrite";
  inputIntegrity?: {
    decisionPath?: "automated" | "manual_underwrite";
  };
  riskAssessment?: { dti?: number | null; ltv?: number | null; creditScore?: number | null };
  day1Certainty?: Record<string, { relief: boolean; reason?: string | null }>;
  messages?: AusMessage[];
  lpa?: {
    simulated?: boolean;
    assessmentId?: string;
    riskClass?: string;
    purchaseEligibility?: string;
    messages?: AusMessage[];
  };
}

interface ApplicationDetailEnvelope {
  application: {
    ausCasefileId: string | null;
    ausRecommendation: string | null;
    ausSubmittedAt: string | null;
    ausFindings: AusFindings | null;
  };
}

const RECOMMENDATION_META: Record<string, { label: string; className: string }> = {
  approve_eligible: { label: "Approve / Eligible", className: "text-success" },
  approve_ineligible: { label: "Approve / Ineligible", className: "text-warning" },
  refer: { label: "Refer", className: "text-warning" },
  refer_with_caution: { label: "Refer with Caution", className: "text-destructive" },
};

const MESSAGE_SEVERITY_CLASS: Record<string, string> = {
  info: "text-muted-foreground",
  condition: "text-warning",
  risk: "text-destructive",
};

const STAGE_ICON: Record<StageStatus, { icon: typeof CheckCircle2; className: string; label: string }> = {
  ready: { icon: CheckCircle2, className: "text-success", label: "Ready" },
  attention: { icon: AlertTriangle, className: "text-warning", label: "Attention" },
  blocked: { icon: XCircle, className: "text-destructive", label: "Blocked" },
  not_applicable: { icon: CircleDashed, className: "text-muted-foreground", label: "N/A" },
};

export function SubmissionReadinessDialog({
  applicationId,
  borrowerName,
}: {
  applicationId: string;
  borrowerName: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [lenderId, setLenderId] = useState<string>("");
  // Which submission's "log lender conditions" form is expanded, if any.
  const [logConditionsFor, setLogConditionsFor] = useState<string | null>(null);
  const [conditionText, setConditionText] = useState("");
  const { toast } = useToast();

  const { data: readiness, isLoading } = useQuery<ReadinessReport>({
    queryKey: loanApplicationKeys.submissionReadiness(applicationId),
    enabled: open,
  });
  const { data: lenders } = useQuery<WholesaleLender[]>({
    queryKey: ["/api/wholesale-lenders"],
    enabled: open,
  });
  const { data: submissions } = useQuery<LenderSubmissionRow[]>({
    queryKey: loanApplicationKeys.lenderSubmissions(applicationId),
    enabled: open,
  });
  // The application row already carries the persisted AUS findings — the DU /
  // LPA panel below reads them off the standard detail query, no new endpoint.
  const { data: appDetail } = useQuery<ApplicationDetailEnvelope>({
    queryKey: loanApplicationKeys.detail(applicationId),
    enabled: open,
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/loan-applications/${applicationId}/lender-submissions`, {
        lenderId,
      });
      return res.json();
    },
    onSuccess: (submission: LenderSubmissionRow) => {
      queryClient.invalidateQueries({
        queryKey: loanApplicationKeys.lenderSubmissions(applicationId),
      });
      toast({
        title: "Submitted to lender",
        description: `Confirmation ${submission.confirmationId}${submission.simulated ? " (simulated — no broker agreement live yet)" : ""}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Submission blocked",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Run the dual AUS (DU + LPA, simulated behind the adapter) so the AUS stage
  // can be satisfied from the UI. Refreshes the readiness report on success.
  const runAusMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/underwrite/submit-gse", { applicationId });
      return res.json();
    },
    onSuccess: (data: { recommendation?: string; findings?: { simulated?: boolean } }) => {
      queryClient.invalidateQueries({
        queryKey: loanApplicationKeys.submissionReadiness(applicationId),
      });
      // The findings panel reads the application row — refresh it so the new
      // run's report appears without a reload.
      queryClient.invalidateQueries({
        queryKey: loanApplicationKeys.detail(applicationId),
      });
      toast({
        title: "Automated underwriting complete (DU + LPA)",
        description: `DU recommendation: ${data.recommendation ?? "—"}${data.findings?.simulated ? " (simulated)" : ""}`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Automated underwriting could not run", description: error.message, variant: "destructive" });
    },
  });

  // Staff transcribe lender-issued conditions (one per line) from the lender's
  // portal; rows land in loan_conditions and are cleared in the existing
  // conditions UI. Refreshes both the submission rollups and the conditions list.
  const logConditionsMutation = useMutation({
    mutationFn: async ({ submissionId, lines }: { submissionId: string; lines: string[] }) => {
      const res = await apiRequest(
        "POST",
        `/api/loan-applications/${applicationId}/lender-submissions/${submissionId}/conditions`,
        { conditions: lines.map(title => ({ title: title.slice(0, 255) })) },
      );
      return res.json();
    },
    onSuccess: (data: { conditions: unknown[] }) => {
      queryClient.invalidateQueries({
        queryKey: loanApplicationKeys.lenderSubmissions(applicationId),
      });
      // The conditions list is served by the *pipeline* query — BorrowerFile
      // reads `pipelineData.conditions` and passes it down to ConditionsTab.
      // This previously invalidated `/api/loan-applications/<id>/conditions`,
      // a key no query subscribes to, so freshly logged lender conditions did
      // not appear in the Conditions tab until a full reload.
      queryClient.invalidateQueries({
        queryKey: loanApplicationKeys.pipeline(applicationId),
      });
      setLogConditionsFor(null);
      setConditionText("");
      toast({
        title: "Lender conditions logged",
        description: `${data.conditions.length} condition(s) added to the file's conditions list for clearing.`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Could not log conditions", description: error.message, variant: "destructive" });
    },
  });

  const submitLoggedConditions = (submissionId: string) => {
    const lines = conditionText
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .slice(0, 50);
    if (lines.length === 0) return;
    logConditionsMutation.mutate({ submissionId, lines });
  };

  // `lender_submissions.lenderId` stores the BUSINESS key, so the catalog lookup
  // must match on `lenderId` too. Matching the uuid `id` never hits, which
  // degraded every submission row to the raw slug.
  const lenderName = (id: string) =>
    lenders?.find(l => l.lenderId === id)?.lenderName ?? id;
  const intakeStage = readiness?.stages.find(stage => stage.key === "intake");
  const canRunAus = !intakeStage || intakeStage.blockers.length === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="touch-target w-full justify-start"
          data-testid={`submission-readiness-${applicationId}`}
        >
          <Send className="mr-2 h-4 w-4" aria-hidden="true" />
          Submit to lender
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Lender submission — {borrowerName}</DialogTitle>
          <DialogDescription>
            Broker workflow: intake → DU → lender package. Stages 1–3 gate submission; the
            final delivery pre-flight is the lender's-eye view and remains informational.
          </DialogDescription>
        </DialogHeader>

        {isLoading || !readiness ? (
          <div className="space-y-2">
            {[1, 2, 3, 4].map(i => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <ol className="space-y-2">
              {readiness.stages.map(stage => {
                const meta = STAGE_ICON[stage.status];
                const Icon = meta.icon;
                return (
                  <li key={stage.key} className="rounded-md border border-border p-3" data-testid={`stage-${stage.key}`}>
                    <div className="flex items-center gap-2">
                      <Icon className={`h-4 w-4 ${meta.className}`} aria-hidden="true" />
                      <span className="font-medium">{stage.label}</span>
                      <Badge variant="outline" className="ml-auto">{meta.label}</Badge>
                    </div>
                    {(stage.blockers.length > 0 || stage.warnings.length > 0) && (
                      <ul className="mt-2 space-y-1 pl-6 text-sm text-muted-foreground">
                        {stage.blockers.map(b => (
                          <li key={b} className="list-disc text-destructive">{b}</li>
                        ))}
                        {stage.warnings.map(w => (
                          <li key={w} className="list-disc">{w}</li>
                        ))}
                      </ul>
                    )}
                    {stage.key === "aus" && (
                      <div className="mt-2 space-y-2 pl-6">
                        <Button
                          size="sm" className="touch-target"
                          variant="outline"
                          onClick={() => runAusMutation.mutate()}
                          disabled={runAusMutation.isPending || !canRunAus}
                          data-testid="run-aus"
                        >
                          {runAusMutation.isPending ? "Running DU / LPA…" : "Run DU / LPA"}
                        </Button>
                        {!canRunAus && (
                          <p className="text-xs text-muted-foreground" data-testid="run-aus-blocked-reason">
                            Complete the intake blockers above before sending this file to automated underwriting.
                          </p>
                        )}
                        {(() => {
                          const application = appDetail?.application;
                          const findings = application?.ausFindings ?? null;
                          if (!application?.ausCasefileId || !findings) return null;
                          const recommendation =
                            application.ausRecommendation ?? findings.recommendation ?? "";
                          const recMeta = RECOMMENDATION_META[recommendation] ?? {
                            label: recommendation.replace(/_/g, " ") || "—",
                            className: "text-muted-foreground",
                          };
                          const d1c = findings.day1Certainty ?? {};
                          const messages = findings.messages ?? [];
                          const lpaMessages = findings.lpa?.messages ?? [];
                          const inputsAreStale = stage.blockers.some(blocker =>
                            blocker.toLowerCase().includes("aus findings are stale"),
                          );
                          return (
                            <Collapsible>
                              <CollapsibleTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="touch-target h-7 px-2 text-xs"
                                  data-testid="aus-findings-toggle"
                                >
                                  <ChevronDown className="mr-1 h-3 w-3" aria-hidden="true" />
                                  DU / LPA findings
                                </Button>
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <div
                                  className="mt-1 space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm"
                                  data-testid="aus-findings-panel"
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span
                                      className={`font-medium ${recMeta.className}`}
                                      data-testid="aus-findings-recommendation"
                                    >
                                      {recMeta.label}
                                    </span>
                                    {findings.simulated && (
                                      <Badge variant="outline" data-testid="aus-findings-simulated">
                                        Simulated
                                      </Badge>
                                    )}
                                    {inputsAreStale && (
                                      <Badge variant="destructive" data-testid="aus-findings-stale">
                                        Stale — rerun required
                                      </Badge>
                                    )}
                                    {(findings.inputIntegrity?.decisionPath ?? findings.decisionPath) === "manual_underwrite" && (
                                      <Badge variant="outline" data-testid="aus-findings-manual">
                                        Manual underwriting
                                      </Badge>
                                    )}
                                    <span className="ml-auto text-xs text-muted-foreground">
                                      {findings.duVersion ? `DU ${findings.duVersion} · ` : ""}
                                      {application.ausCasefileId}
                                    </span>
                                  </div>
                                  {findings.riskAssessment && (
                                    <p className="text-xs text-muted-foreground" data-testid="aus-findings-risk">
                                      {[
                                        findings.riskAssessment.dti != null &&
                                          `DTI ${(findings.riskAssessment.dti * 100).toFixed(1)}%`,
                                        findings.riskAssessment.ltv != null &&
                                          `LTV ${(findings.riskAssessment.ltv * 100).toFixed(1)}%`,
                                        findings.riskAssessment.creditScore != null &&
                                          `Credit ${findings.riskAssessment.creditScore}`,
                                      ]
                                        .filter(Boolean)
                                        .join(" · ")}
                                    </p>
                                  )}
                                  {findings.lpa && (
                                    <p className="text-xs text-muted-foreground" data-testid="aus-findings-lpa">
                                      LPA leg: {findings.lpa.riskClass ?? "—"} /{" "}
                                      {findings.lpa.purchaseEligibility ?? "—"}
                                      {findings.lpa.assessmentId ? ` · ${findings.lpa.assessmentId}` : ""}
                                    </p>
                                  )}
                                  {(messages.length > 0 || lpaMessages.length > 0) && (
                                    <ul className="space-y-1" data-testid="aus-findings-messages">
                                      {messages.map(m => (
                                        <li key={`du-${m.code}`} className="text-xs">
                                          <span className={MESSAGE_SEVERITY_CLASS[m.severity] ?? "text-muted-foreground"}>
                                            [{m.code}]
                                          </span>{" "}
                                          {m.text}
                                        </li>
                                      ))}
                                      {lpaMessages.map(m => (
                                        <li key={`lpa-${m.code}`} className="text-xs">
                                          <span className={MESSAGE_SEVERITY_CLASS[m.severity] ?? "text-muted-foreground"}>
                                            [{m.code}]
                                          </span>{" "}
                                          {m.text}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                  {Object.keys(d1c).length > 0 && (
                                    <div className="text-xs text-muted-foreground" data-testid="aus-findings-d1c">
                                      {Object.entries(d1c).map(([layer, r]) => (
                                        <p key={layer}>
                                          D1C {layer}: {r.relief ? "relief granted" : r.reason ?? "relief withheld"}
                                        </p>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                          );
                        })()}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>

            {(submissions?.length ?? 0) > 0 && (
              <div className="rounded-md bg-muted/50 p-3 text-sm">
                <p className="mb-1 font-medium">Submissions</p>
                <ul className="space-y-2">
                  {submissions!.map(s => {
                    const stats = s.conditionStats ?? { total: 0, open: 0, cleared: 0 };
                    return (
                      <li key={s.id} className="space-y-1" data-testid={`submission-row-${s.id}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span>{lenderName(s.lenderId)}</span>
                          <span className="text-muted-foreground">
                            {s.confirmationId} · {s.status.replace(/_/g, " ")}
                            {stats.total > 0 && ` · ${stats.open}/${stats.total} condition(s) open`}
                          </span>
                        </div>
                        {s.status === "conditions_issued" && stats.total > 0 && stats.open === 0 && (
                          <p className="text-xs text-success" data-testid={`conditions-cleared-hint-${s.id}`}>
                            All logged conditions cleared — confirm with the lender, then advance the
                            submission to conditions cleared.
                          </p>
                        )}
                        {/*
                          The XSD result recorded on this submission's immutable
                          snapshot. The service claimed it was "shown to staff";
                          until now nothing read the field.
                        */}
                        <PackageConformanceBadge
                          submissionId={s.id}
                          conformance={s.readinessSnapshot?.xsdConformance}
                        />
                        {s.ausFindingsHash && (
                          <Button asChild variant="outline" size="sm" className="touch-target h-8 text-xs">
                            <a
                              href={`/api/loan-applications/${applicationId}/lender-submissions/${s.id}/aus-findings`}
                              data-testid={`aus-artifact-download-${s.id}`}
                            >
                              Download final DU / LPA findings
                            </a>
                          </Button>
                        )}
                        {/*
                          The control that hint points at. Without it the row was
                          read-only after submission and the funded figures (F-6)
                          had no UI writer at all — WF2-F5.
                        */}
                        <SubmissionLifecycleControl
                          applicationId={applicationId}
                          submissionId={s.id}
                          status={s.status as LenderSubmissionStatus}
                          lenderName={lenderName(s.lenderId)}
                        />
                        {logConditionsFor === s.id ? (
                          <div className="space-y-2">
                            <Label htmlFor={`conditions-input-${s.id}`} className="text-xs">
                              Lender conditions (one per line, as issued in the lender's portal)
                            </Label>
                            <Textarea
                              id={`conditions-input-${s.id}`}
                              rows={3}
                              value={conditionText}
                              onChange={e => setConditionText(e.target.value)}
                              data-testid={`conditions-input-${s.id}`}
                            />
                            <div className="flex gap-2">
                              <Button
                                size="sm" className="touch-target"
                                onClick={() => submitLoggedConditions(s.id)}
                                disabled={logConditionsMutation.isPending || conditionText.trim().length === 0}
                                data-testid={`save-conditions-${s.id}`}
                              >
                                {logConditionsMutation.isPending ? "Saving…" : "Save conditions"}
                              </Button>
                              <Button
                                size="sm" className="touch-target"
                                variant="ghost"
                                onClick={() => {
                                  setLogConditionsFor(null);
                                  setConditionText("");
                                }}
                                data-testid={`cancel-conditions-${s.id}`}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="touch-target h-7 px-2 text-xs"
                            onClick={() => {
                              setLogConditionsFor(s.id);
                              setConditionText("");
                            }}
                            data-testid={`log-conditions-${s.id}`}
                          >
                            Log lender conditions
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Select value={lenderId} onValueChange={setLenderId}>
                <SelectTrigger className="flex-1" data-testid="lender-select">
                  <SelectValue placeholder="Choose a wholesale lender" />
                </SelectTrigger>
                <SelectContent>
                  {(lenders ?? []).map(l => (
                    <SelectItem
                      key={l.id}
                      value={l.lenderId}
                      data-testid={`lender-option-${l.lenderId}`}
                    >
                      {l.specialty ? `${l.lenderName} — ${l.specialty}` : l.lenderName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                disabled={!readiness.readyToSubmitToLender || !lenderId || submitMutation.isPending}
                onClick={() => submitMutation.mutate()}
                data-testid="submit-to-lender"
              >
                {submitMutation.isPending ? "Submitting…" : "Submit"}
              </Button>
            </div>
            {!readiness.readyToSubmitToLender && (
              <p className="text-sm text-muted-foreground">
                Submission unlocks when stages 1–3 have no blockers.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
