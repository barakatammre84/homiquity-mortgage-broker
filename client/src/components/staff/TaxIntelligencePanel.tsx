import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Brain, FileQuestion, CheckCircle2, AlertTriangle, Route } from "lucide-react";
import type { SituationProfile, IncomePathSignal } from "@shared/situationProfile";

/**
 * Tax Intelligence panel (UAL P2c LO surface) — renders the borrower's latest
 * SituationProfile for staff: what kind of borrower this is, which income
 * paths the file indicates, and which documents to request. Read-only,
 * processing signal — never a qualification figure (those come only from the
 * cited calculators after human confirmation; the P5 workbench owns review).
 */

interface SituationResponse {
  id: string;
  userId: string;
  generatedAt: string;
  inputsFingerprint: string;
  profile: SituationProfile;
}

const PATH_LABELS: Record<IncomePathSignal["pathId"], string> = {
  agency_wage: "Agency W-2 wage",
  self_employment: "Self-employment (Fannie 1084)",
  capital_gains: "Capital gains (Schedule D)",
  employment_related_assets: "Employment-related assets",
  rental: "Rental offsets (B3-3.8-01)",
  dscr: "DSCR (non-QM)",
  bank_statement: "Bank statement (non-QM)",
};

function signalBadge(signal: IncomePathSignal["signal"]) {
  switch (signal) {
    case "applicable":
      return <Badge variant="success" data-testid="badge-path-applicable">Applicable</Badge>;
    case "candidate":
      return <Badge variant="info" data-testid="badge-path-candidate">Candidate (gated)</Badge>;
    default:
      return <Badge variant="outline" data-testid="badge-path-not-indicated">Not indicated</Badge>;
  }
}

export function TaxIntelligencePanel({
  borrowerUserId,
  applicationId,
}: {
  borrowerUserId: string;
  /** Required for non-admin staff: the deal-team application proving assignment. */
  applicationId?: string;
}) {
  const { data, isLoading, isError } = useQuery<SituationResponse>({
    queryKey: [
      `/api/tax-intelligence/situation?userId=${encodeURIComponent(borrowerUserId)}${applicationId ? `&applicationId=${encodeURIComponent(applicationId)}` : ""}`,
    ],
  });

  if (isLoading) {
    return (
      <Card data-testid="tax-intelligence-loading">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            Tax Intelligence
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card data-testid="tax-intelligence-error">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            Tax Intelligence
          </CardTitle>
          <CardDescription>
            Couldn't load the situation profile. It may not exist yet — it is generated when the
            borrower processes an uploaded tax return.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const p = data.profile;
  const empty = p.taxYears.length === 0 && p.entityCount === 0;

  return (
    <div className="space-y-4" data-testid="tax-intelligence-panel">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Brain className="h-5 w-5" />
            Situation Profile
          </CardTitle>
          <CardDescription data-testid="text-situation-summary">
            {empty
              ? "No processed tax documents yet — the profile fills in seconds after the borrower runs extraction on an uploaded return."
              : p.summary}
          </CardDescription>
        </CardHeader>
        {!empty && (
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2" data-testid="situation-flags">
              {p.flags.map((f) => (
                <Badge
                  key={f.id}
                  variant={f.id === "extraction_variances_open" ? "warning" : "secondary"}
                  title={f.detail}
                  data-testid={`flag-${f.id.replace(/_/g, "-")}`}
                >
                  {f.id === "extraction_variances_open" && (
                    <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />
                  )}
                  {f.label}
                </Badge>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div>
                <div className="text-muted-foreground">Tax years</div>
                <div data-testid="text-tax-years">{p.taxYears.join(", ") || "—"}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Entities</div>
                <div data-testid="text-entity-count">{p.entityCount}</div>
              </div>
              <div>
                <div className="text-muted-foreground">Tie-outs passing</div>
                <div data-testid="text-tieout-pass">
                  {p.tieOutSummary.pass}/{p.tieOutSummary.pass + p.tieOutSummary.variance}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground">Open variances</div>
                <div data-testid="text-tieout-variance">{p.tieOutSummary.variance}</div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Processing signal from extracted documents — qualifying figures come only from the
              cited calculators after values are human-confirmed.
            </p>
          </CardContent>
        )}
      </Card>

      {!empty && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Route className="h-4 w-4" />
                Income Path Signals
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-3" data-testid="income-path-signals">
                {p.incomePaths.map((path) => (
                  <li key={path.pathId} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{PATH_LABELS[path.pathId]}</span>
                      {signalBadge(path.signal)}
                    </div>
                    <p className="text-xs text-muted-foreground">{path.reason}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FileQuestion className="h-4 w-4" />
                Documents to Request
              </CardTitle>
              <CardDescription>Generated from the file's actual gaps</CardDescription>
            </CardHeader>
            <CardContent>
              {p.documentRequests.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="text-no-doc-requests">
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  Nothing outstanding — the file is internally complete.
                </div>
              ) : (
                <ul className="space-y-3" data-testid="document-requests">
                  {p.documentRequests.map((d, idx) => (
                    <li key={d.id} className="space-y-1">
                      {idx > 0 && <Separator className="mb-2" />}
                      <div className="text-sm font-medium" data-testid={`doc-request-${idx}`}>
                        {d.description}
                      </div>
                      <p className="text-xs text-muted-foreground">{d.reason}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
