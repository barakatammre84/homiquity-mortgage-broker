import { Link } from "wouter";
import { AlertCircle, ArrowRight, CheckCircle2, Circle, Clock, ExternalLink, FileSearch, FileText, Landmark, Sparkles, Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { PlaidConnectButton } from "@/components/PlaidConnectButton";
import { DocumentUploadButton } from "@/components/DocumentUploadButton";
import { formatCurrency } from "@/lib/formatters";

import type { ChecklistItemView } from "@/lib/documentChecklist";
import type { CoachDocumentEvidenceView, FileDocumentStatsView, LoanStatusView, PlanningDocumentStatsView } from "./types";

const EVIDENCE_STATUS_LABELS: Record<string, string> = {
  not_extracted: "No financial fields read",
  machine_read: "Machine read",
  partly_human_verified: "Partly human verified",
  human_verified: "Human verified",
};

const DOCUMENT_REVIEW_LABELS: Record<string, string> = {
  uploaded: "Received",
  in_review: "Document in review",
  accepted: "Document accepted",
};

/** Deterministic OCR and review facts from the current file. */
export function DocumentEvidencePanel({ evidence }: { evidence: CoachDocumentEvidenceView }) {
  const approved = evidence.financialReview.status === "approved_for_lender_package";
  return (
    <Card data-testid="card-document-evidence">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <FileSearch className="h-4 w-4 text-primary" />
          What Homiquity read
          <PanelSource source="file" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={`rounded-lg border p-3 ${approved ? "border-success/30 bg-success/5" : "border-border bg-muted/30"}`}>
          <p className="text-sm font-semibold text-foreground">
            {approved ? "Current financial review approved for package preparation" : "Financial review is not approved yet"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Income: {evidence.financialReview.income === "approved" ? "approved" : "not approved"} · Assets: {evidence.financialReview.assets === "approved" ? "approved" : "not approved"} · Liabilities: {evidence.financialReview.liabilities === "approved" ? "approved" : evidence.financialReview.liabilities === "not_required" ? "none to review" : "not approved"}
          </p>
        </div>

        {evidence.documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">No safe extracted financial facts are available for the current file.</p>
        ) : (
          <div className="space-y-3">
            {evidence.documents.map((document) => (
              <div key={document.documentId} className="rounded-lg border border-border p-3" data-testid={`evidence-document-${document.documentId}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-foreground">{document.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {DOCUMENT_REVIEW_LABELS[document.documentReviewStatus]} · {EVIDENCE_STATUS_LABELS[document.evidenceStatus]}
                    </p>
                  </div>
                  {document.facts.some((fact) => fact.needsHumanReview) && (
                    <Badge variant="outline" className="border-warning/40 text-warning-subtle-foreground">Staff review needed</Badge>
                  )}
                </div>

                {document.facts.length > 0 ? (
                  <dl className="mt-3 divide-y divide-border border-y border-border">
                    {document.facts.map((fact, index) => (
                      <div key={`${fact.label}-${index}`} className="grid gap-1 py-2 sm:grid-cols-[1fr_auto] sm:items-center">
                        <div>
                          <dt className="text-xs text-muted-foreground">{fact.label}</dt>
                          <dd className="text-sm font-semibold tabular-nums text-foreground">
                            {fact.format === "currency" ? formatCurrency(fact.value) : fact.value.toLocaleString()}
                          </dd>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          <Badge variant={fact.reviewStatus === "human_verified" ? "secondary" : "outline"}>
                            {fact.reviewStatus === "human_verified" ? "Human verified" : `Machine read · ${fact.confidence}`}
                          </Badge>
                          {fact.pageNumber ? (
                            <Button asChild variant="ghost" size="sm" className="touch-target h-8 px-2 text-xs">
                              <a href={`/api/documents/${document.documentId}/pages/${fact.pageNumber}/image`} target="_blank" rel="noreferrer" data-testid={`link-evidence-source-${document.documentId}-${index}`}>
                                Page {fact.pageNumber}<ExternalLink className="ml-1 h-3 w-3" />
                              </a>
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">Page not linked</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">No allowlisted financial fields were extracted.</p>
                )}
                {document.omittedFactCount > 0 && <p className="mt-2 text-xs text-muted-foreground">{document.omittedFactCount} additional fact{document.omittedFactCount === 1 ? "" : "s"} omitted from this bounded view.</p>}
              </div>
            ))}
          </div>
        )}
        {evidence.summary.omittedDocumentCount > 0 && (
          <p className="text-xs text-muted-foreground">{evidence.summary.omittedDocumentCount} older document{evidence.summary.omittedDocumentCount === 1 ? "" : "s"} omitted. Use the full Documents page for receipt status.</p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Machine-read values are provisional. Human verification confirms a field was checked; it does not by itself approve a loan or establish qualifying income.
        </p>
      </CardContent>
    </Card>
  );
}

/** Bank/asset items verify as "assets"; income/employment docs as "income". */
function plaidVerificationType(doc: ChecklistItemView): "assets" | "income" {
  return /income|employ|pay.?stub|w-?2|1099|profit|salary/i.test(
    `${doc.documentType} ${doc.category} ${doc.label}`,
  )
    ? "income"
    : "assets";
}

/** Plaid can satisfy bank/asset and payroll items; nothing else. */
function isPlaidEligible(doc: ChecklistItemView): boolean {
  return /bank_statement|asset|pay.?stub|payroll|income/i.test(
    `${doc.documentType} ${doc.category}`,
  );
}

const STATUS_META: Record<
  ChecklistItemView["status"],
  { label: string; icon: typeof Circle; tone: string; badge: "secondary" | "destructive" | "outline" }
> = {
  needed: { label: "Needed", icon: Circle, tone: "text-muted-foreground", badge: "outline" },
  uploaded: { label: "Received", icon: Clock, tone: "text-info", badge: "secondary" },
  verifying: { label: "In review", icon: Clock, tone: "text-info", badge: "secondary" },
  verified: { label: "Verified", icon: CheckCircle2, tone: "text-success-subtle-foreground", badge: "secondary" },
  rejected: { label: "Needs a fix", icon: AlertCircle, tone: "text-status-danger", badge: "destructive" },
};

/**
 * Says whether a panel is a FACT from the borrower's file or the assistant's
 * SUGGESTION. Before this they rendered identically, so a suggested step and a
 * real requirement looked the same and were acted on the same way.
 */
export function PanelSource({ source }: { source: "file" | "assistant" }) {
  return (
    <Badge
      variant="outline"
      className="ml-auto text-xs font-normal px-1.5 py-0"
      data-testid={`badge-panel-source-${source}`}
    >
      {source === "file" ? "On your file" : "Suggested by Homi"}
    </Badge>
  );
}
import {
  CATEGORY_ICONS,
  TIER_CONFIG,
  type ActionPlanItem,
  type CoachProfile,
  type DocumentRequirement,
} from "./types";

// Assessment side panels, moved from the old page-local components in
// AICoach.tsx (markup unchanged).

export function ReadinessPanel({ profile }: { profile: CoachProfile }) {
  const tier = TIER_CONFIG[profile.readinessTier ?? ""] || TIER_CONFIG.exploring;
  const TierIcon = tier.icon;
  // A partially-written profile is a real wire shape (see CoachProfile) — an
  // incomplete panel is the right degradation, a blank /ai-coach page is not.
  const completedInputs = profile.completedInputs ?? [];
  const outstandingInputs = profile.outstandingInputs ?? [];

  return (
    <Card data-testid="card-readiness-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Sparkles className="h-4 w-4 text-primary" />
          Your Readiness Assessment
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <div className={`p-2 rounded-lg ${tier.color}/10`}>
            <TierIcon className={`h-5 w-5 ${tier.color.replace("bg-", "text-")}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-foreground" data-testid="text-readiness-tier">{tier.label}</span>
              <Badge variant="secondary" className="text-xs" data-testid="badge-readiness-score">
                {profile.completionPercentage}% Complete
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">{profile.estimatedTimeline}</p>
          </div>
        </div>
        <Progress value={profile.completionPercentage} className="h-2" data-testid="progress-readiness" />
        <p className="text-sm text-muted-foreground" data-testid="text-readiness-summary">{profile.statusNote}</p>

        {completedInputs.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">COMPLETED INPUTS</p>
            <div className="flex flex-wrap gap-1.5">
              {completedInputs.map((s, i) => (
                <Badge key={i} variant="secondary" className="text-xs font-normal">
                  {s}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {outstandingInputs.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">OUTSTANDING INPUTS</p>
            <div className="flex flex-wrap gap-1.5">
              {outstandingInputs.map((g, i) => (
                <Badge key={i} variant="outline" className="text-xs font-normal">
                  {g}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {(profile.readinessTier === "ready_now" || profile.readinessTier === "almost_ready") && (
          <div className="pt-2 border-t space-y-2">
            <Button asChild className="w-full gap-2" data-testid="button-ready-to-apply">
              <Link href={`/apply?source=coach&readiness=${profile.readinessTier}`} data-testid="link-ready-to-apply">
                <FileText className="h-4 w-4" />
                {profile.readinessTier === "ready_now"
                  ? "Start Your Pre-Approval"
                  : "Get a Head Start on Your Application"}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <p className="text-xs text-muted-foreground text-center">
              Your coach data will be used to pre-fill the application
            </p>
          </div>
        )}
        {profile.readinessTier !== "ready_now" && profile.readinessTier !== "almost_ready" && (
          <div className="pt-2 border-t">
            <Button asChild variant="outline" className="w-full gap-2" data-testid="button-explore-apply">
              <Link href="/apply?source=coach" data-testid="link-explore-apply">
                <FileText className="h-4 w-4" />
                Explore Pre-Approval Anyway
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <p className="text-xs text-muted-foreground text-center mt-2">
              See where you stand with a no-impact pre-approval check
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ActionPlanPanel({
  plan,
  onToggle,
}: {
  plan: ActionPlanItem[];
  onToggle?: (itemId: string) => void;
}) {
  const completedCount = plan.filter(a => a.completed).length;

  return (
    <Card data-testid="card-action-plan">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
          <span className="flex items-center gap-2">
            <Target className="h-4 w-4 text-primary" />
            Your Action Plan
          </span>
          <Badge variant="secondary" className="text-xs">
            {completedCount}/{plan.length}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {plan.map((item) => {
            const CatIcon = CATEGORY_ICONS[item.category] || Target;
            return (
              <button
                key={item.id}
                onClick={() => onToggle?.(item.id)}
                className={`w-full text-left flex items-start gap-3 p-2.5 rounded-lg border transition-colors ${
                  item.completed ? "bg-muted/50 border-muted" : "border-border hover-elevate"
                }`}
                data-testid={`action-item-${item.id}`}
              >
                {item.completed ? (
                  <CheckCircle2 className="h-4 w-4 text-success-subtle-foreground mt-0.5 shrink-0" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm font-medium ${item.completed ? "line-through text-muted-foreground" : "text-foreground"}`}>
                      {item.title}
                    </span>
                    <Badge
                      variant={item.priority === "high" ? "destructive" : item.priority === "medium" ? "default" : "secondary"}
                      className="text-[10px] px-1.5 py-0"
                    >
                      {item.priority}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                </div>
                <CatIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              </button>
            );
          })}
        </div>
        {completedCount > 0 && completedCount < plan.length && (
          <div className="mt-3">
            <Progress value={(completedCount / plan.length) * 100} className="h-1.5" />
            <p className="text-[10px] text-muted-foreground mt-1 text-center">
              {completedCount} of {plan.length} completed
            </p>
          </div>
        )}
        {completedCount === plan.length && plan.length > 0 && (
          <div className="mt-3 p-2 rounded-lg bg-success/10 text-center">
            <p className="text-xs font-medium text-success-subtle-foreground">
              All action items completed!
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function groupByCategory(docs: ChecklistItemView[]): Record<string, ChecklistItemView[]> {
  return docs.reduce((acc, d) => {
    const cat = d.category || "Other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(d);
    return acc;
  }, {} as Record<string, ChecklistItemView[]>);
}

/**
 * One checklist document with its action row. EVERY item gets a direct "Upload"
 * button so the borrower can attach it without leaving the conversation; bank/
 * asset items ALSO offer the faster Plaid connect (upload becomes the fallback).
 * Shared by the side panel and the in-chat checklist so both stay actionable.
 */
function ChecklistItemRow({
  doc,
  applicationId,
}: {
  doc: ChecklistItemView;
  applicationId?: string | null;
}) {
  const meta = STATUS_META[doc.status] ?? STATUS_META.needed;
  const StatusIcon = meta.icon;
  const plaid = isPlaidEligible(doc);
  // Only an item still owed gets action buttons. Offering "Upload" on a
  // verified document invites a borrower to redo work that is already done.
  const actionable = doc.status === "needed" || doc.status === "rejected";

  return (
    <div
      className="flex items-start gap-2.5 p-2 rounded-lg hover-elevate"
      data-testid={`doc-item-${doc.documentType}`}
    >
      <StatusIcon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${meta.tone}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-foreground">{doc.label}</span>
          {doc.documentYear && (
            <span className="text-xs text-muted-foreground">({doc.documentYear})</span>
          )}
          <Badge variant={meta.badge} className="text-[10px] px-1.5 py-0" data-testid={`doc-status-${doc.documentType}`}>
            {meta.label}
          </Badge>
        </div>
        {doc.description && <p className="text-xs text-muted-foreground">{doc.description}</p>}
        {doc.instructions && (
          <p className="text-xs text-muted-foreground mt-0.5">{doc.instructions}</p>
        )}
        {/*
          A rejection is the one state where the borrower is blocked and cannot
          work out why on their own: the file IS uploaded, so it looks done, and
          only the reviewer's reason explains the bounce. It gets its own line.
        */}
        {doc.status === "rejected" && doc.rejectionReason && (
          <p
            className="mt-1 text-xs text-status-danger"
            data-testid={`doc-rejection-${doc.documentType}`}
          >
            {doc.rejectionReason}
          </p>
        )}
        {actionable && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {plaid &&
              (applicationId ? (
                <PlaidConnectButton
                  applicationId={applicationId}
                  verificationType={plaidVerificationType(doc)}
                  label="Connect with Plaid"
                  className="h-7 text-xs"
                  testId={`button-plaid-connect-${doc.documentType}`}
                />
              ) : (
                <Button asChild
                    size="sm"
                    variant="outline"
                    className="touch-target h-7 gap-1.5 text-xs"
                    data-testid={`button-plaid-connect-${doc.documentType}`}
                  >
                  <Link href="/verification">
                    <Landmark className="h-3.5 w-3.5" />
                    Connect with Plaid
                  </Link>
                </Button>
              ))}
            {/*
              docType is the REAL condition's documentType, so the upload
              matches an actual requirement and pipelineEngine's zero-touch
              matcher flips the condition outstanding → submitted. When this
              slug was model-authored it matched nothing, the item never
              cleared, and the borrower had been told it was handled.
            */}
            <DocumentUploadButton
              docType={doc.documentType}
              label={doc.status === "rejected" ? "Re-upload" : plaid ? "Upload instead" : "Upload"}
              applicationId={applicationId}
              className="h-7 text-xs"
              testId={`button-upload-${doc.documentType}`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where the borrower's file actually stands — the answer to the question they
 * most often arrive with, rendered from server truth rather than from whatever
 * the assistant last said.
 *
 * Everything here is whitelisted server-side (coachFileTruth.ts): the staff
 * No-Stall signals — fileHealth, priority, daysIdle — never reach this
 * component, because "urgent"/red means the FILE needs staff attention and
 * reads to a borrower as a problem with their application.
 */
export function StatusPanel({ status }: { status: LoanStatusView }) {
  if (!status.hasApplication || !status.stage) return null;
  const { stage, pipeline, journey, nextAction } = status;

  return (
    <Card data-testid="card-status-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Target className="h-4 w-4 text-primary" />
          Where Your File Stands
          <PanelSource source="file" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-foreground" data-testid="text-stage-label">
              {stage.label}
            </span>
            <Badge variant="secondary" className="text-xs" data-testid="badge-stage-progress">
              {stage.progressPercent}%
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5" data-testid="text-stage-description">
            {stage.description}
          </p>
        </div>
        <Progress value={stage.progressPercent} className="h-2" data-testid="progress-stage" />

        {pipeline && pipeline.conditionsTotal > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-conditions">
            Conditions cleared: {pipeline.conditionsTotal - pipeline.conditionsOutstanding} of{" "}
            {pipeline.conditionsTotal}
          </p>
        )}

        {journey.length > 0 && (
          <div className="space-y-1">
            {journey.map((step) => (
              <p key={step.stepId} className="text-xs text-muted-foreground" data-testid={`journey-${step.stepId}`}>
                {step.lines.join(" · ")}
              </p>
            ))}
          </div>
        )}

        {nextAction && (
          <div className="pt-2 border-t space-y-2">
            <p className="text-sm font-medium text-foreground">{nextAction.title}</p>
            <p className="text-xs text-muted-foreground">{nextAction.description}</p>
            <Button asChild className="w-full gap-2" data-testid="button-next-action">
              <Link href={nextAction.href} data-testid="link-next-action">
                {nextAction.buttonLabel}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The compact rail for Homi. Stage, evidence, and one next action come from the
 * same file context, without turning unrelated completion measures into a row
 * of competing percentages.
 */
export function FileSnapshotPanel({
  status,
  docs,
  planningDocuments = null,
  fileDocuments = null,
}: {
  status: LoanStatusView;
  docs: ChecklistItemView[];
  planningDocuments?: PlanningDocumentStatsView | null;
  fileDocuments?: FileDocumentStatsView | null;
}) {
  const verified = docs.filter((doc) => doc.status === "verified").length;
  const received = docs.filter((doc) => doc.status === "uploaded" || doc.status === "verifying").length;
  const nextAction = status.hasApplication && status.nextAction
    ? status.nextAction
    : {
        title: "Build your homebuyer plan",
        description: "Set a target, organize your income, and choose the next milestone.",
        href: "/gap-calculator",
        buttonLabel: "Open My Plan",
      };

  return (
    <Card data-testid="card-file-snapshot">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Your connected file</p>
            <CardTitle className="font-display mt-1 text-xl">File snapshot</CardTitle>
          </div>
          <PanelSource source="file" />
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="border-l-2 border-flare pl-3" data-testid="file-snapshot-stage">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current stage</p>
          <p className="mt-1 font-semibold text-foreground">
            {status.hasApplication && status.stage ? status.stage.label : "Homebuyer planning"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {status.hasApplication && status.stage
              ? status.stage.description
              : "No mortgage application has been started yet."}
          </p>
        </div>

        {status.hasApplication && docs.length > 0 && (
          <div data-testid="file-snapshot-evidence">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Evidence</p>
            <p className="mt-1 text-sm font-medium text-foreground">{verified} of {docs.length} verified</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {received > 0 ? `${received} received and being reviewed` : "Nothing else is currently in review"}
            </p>
            <Button asChild variant="outline" size="sm" className="touch-target mt-3 w-full" data-testid="button-view-documents">
              <Link href="/documents">View document checklist</Link>
            </Button>
          </div>
        )}

        {status.hasApplication && docs.length === 0 && fileDocuments && fileDocuments.total > 0 && (
          <div data-testid="file-snapshot-uploaded-documents">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Documents on file</p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {fileDocuments.total} saved to this application
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {fileDocuments.underReview > 0
                ? `${fileDocuments.underReview} being reviewed`
                : fileDocuments.verified > 0
                  ? `${fileDocuments.verified} verified`
                  : fileDocuments.rejected > 0
                    ? `${fileDocuments.rejected} need attention`
                    : "No open document requests"}
            </p>
            <Button asChild variant="outline" size="sm" className="touch-target mt-3 w-full" data-testid="button-view-file-documents">
              <Link href="/documents">View application documents</Link>
            </Button>
          </div>
        )}

        {!status.hasApplication && planningDocuments && planningDocuments.total > 0 && (
          <div data-testid="file-snapshot-planning-documents">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Planning documents</p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {planningDocuments.total} saved to your account
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {planningDocuments.underReview > 0
                ? `${planningDocuments.underReview} being reviewed`
                : planningDocuments.verified > 0
                  ? `${planningDocuments.verified} verified`
                  : planningDocuments.rejected > 0
                    ? `${planningDocuments.rejected} need attention`
                    : "Ready when you begin your application"}
            </p>
            <Button asChild variant="outline" size="sm" className="touch-target mt-3 w-full" data-testid="button-view-planning-documents">
              <Link href="/documents">View planning documents</Link>
            </Button>
          </div>
        )}

        <div className="border-t border-border pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Next action</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{nextAction.title}</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{nextAction.description}</p>
          <Button asChild className="mt-3 w-full" data-testid="button-file-snapshot-next">
            <Link href={nextAction.href} data-testid="link-file-snapshot-next">{nextAction.buttonLabel}</Link>
          </Button>
        </div>

        <Button asChild variant="outline" className="w-full" data-testid="button-message-loan-officer">
          <Link href="/messages" data-testid="link-message-loan-officer">Message my loan officer</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Resolves the connected-file request into a terminal UI state. Access errors
 * used to leave staff and other non-borrower sessions on a permanent loading
 * message even though the server had already returned 403.
 */
export function ConnectedFilePanel({
  status,
  docs,
  planningDocuments = null,
  fileDocuments = null,
  loading,
  error = false,
  onRetry,
}: {
  status: LoanStatusView | null;
  docs: ChecklistItemView[];
  planningDocuments?: PlanningDocumentStatsView | null;
  fileDocuments?: FileDocumentStatsView | null;
  loading: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  if (status) {
    return (
      <div data-testid="coach-side-panel">
        <FileSnapshotPanel
          status={status}
          docs={docs}
          planningDocuments={planningDocuments}
          fileDocuments={fileDocuments}
        />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground" data-testid="coach-side-panel-loading">
        Loading your connected file…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4" data-testid="coach-side-panel-error">
        <p className="font-semibold text-foreground">Couldn't load your connected file</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Homi will not guess about your status or documents while the file is unavailable.
        </p>
        {onRetry && <Button type="button" variant="outline" size="sm" className="touch-target mt-3" onClick={onRetry}>Try again</Button>}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4" data-testid="coach-side-panel-unavailable">
      <p className="font-semibold text-foreground">No connected file for this session</p>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        Homi can still provide educational guidance. File facts and document status will appear only when an accessible borrower file is connected.
      </p>
    </div>
  );
}

export function DocumentChecklistPanel({
  docs,
  applicationId,
}: {
  docs: ChecklistItemView[];
  applicationId?: string | null;
}) {
  const grouped = groupByCategory(docs);

  return (
    <Card data-testid="card-document-checklist">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <FileText className="h-4 w-4 text-primary" />
          Your Document Checklist
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category}>
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">{category}</p>
              <div className="space-y-1.5">
                {items.map((doc) => (
                  <ChecklistItemRow key={doc.id} doc={doc} applicationId={applicationId} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The actionable document checklist rendered INLINE in the chat stream (not just
 * the side panel) — so the borrower can upload each document, or Plaid-connect
 * bank items, right where the coach asks for them. This is what makes the chat
 * feel like a rep walking them through: every item has a one-tap action here.
 */
export function DocumentChecklistInline({
  docs,
  applicationId,
}: {
  docs: ChecklistItemView[];
  applicationId?: string | null;
}) {
  const active = docs.filter((doc) => doc.status === "needed" || doc.status === "rejected");
  const received = docs.filter((doc) => doc.status === "uploaded" || doc.status === "verifying").length;
  const visible = active.slice(0, 3);

  return (
    <div
      className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-border bg-muted/30 px-4 py-3"
      data-testid="coach-checklist-inline"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Document plan</p>
          <p className="mt-0.5 text-sm font-medium text-foreground">
            {active.length > 0 ? `${active.length} ${active.length === 1 ? "item" : "items"} to gather` : "Everything requested has been received"}
          </p>
        </div>
        {received > 0 && <Badge variant="secondary">{received} in review</Badge>}
      </div>
      {visible.length > 0 && (
        <div className="mt-2 divide-y divide-border border-y border-border">
          {visible.map((doc) => <ChecklistItemRow key={doc.id} doc={doc} applicationId={applicationId} />)}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        {active.length > visible.length ? (
          <p className="text-xs text-muted-foreground">Plus {active.length - visible.length} more in your full checklist.</p>
        ) : <span />}
        <Button asChild variant="outline" size="sm" className="touch-target" data-testid="button-open-full-checklist">
          <Link href="/documents">View full checklist</Link>
        </Button>
      </div>
    </div>
  );
}
