import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { PageShell } from "@/components/PageShell";
import { PresalesDisclaimer } from "@/components/PresalesDisclaimer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowRight,
  BadgeCheck,
  Bot,
  FileText,
  Pencil,
  Sparkles,
  UserCircle2,
  X,
} from "lucide-react";
// From the tiny table-free module, NOT the @shared/schema barrel (a value
// import of the barrel ships all 174 Drizzle tables to the browser — #482) and
// NOT preApprovalForm, which sits in the eager entry chunk every visitor
// downloads. This page is lazily routed, so the catalog rides in its chunk.
import { isClearableIntakeField } from "@shared/intakeClearable";
import {
  CAPTURE_FIELDS,
  TIER_CONFIG,
  formatCaptureValue,
  type CaptureFieldDef,
} from "@/components/coach/types";

// "My Profile" — the borrower-visible home of everything captured about them:
// identity, the self-reported financial profile on their draft application
// (single source of truth — the same record the Homi writes to and the
// funnel edits), provenance/verification badges, the AI-coach capture trail,
// and mortgage readiness. Inline edits reuse the existing draft-only
// PATCH /api/loan-applications/:id (shared funnel schema).

interface FinancialProfileResponse {
  user: { firstName: string | null; lastName: string | null; email: string | null; role: string };
  application: {
    id: string;
    status: string;
    editable: boolean;
    financialDataProvenance: string | null;
    currentDecisionGrade: boolean;
    incomeVerified: boolean;
    assetsVerified: boolean;
    creditVerified: boolean;
    updatedAt: string | null;
    fields: Record<string, string | number | boolean | null>;
  } | null;
  readiness: { tier: string | null; completionPercentage: number | null; updatedAt: string | null } | null;
  coachCapture: { lastSyncedAt: string; fields: string[] } | null;
}

// Profile shows the coach's canonical capture catalog plus two funnel-only
// fields (employer, property state), in intake order.
interface ProfileFieldDef extends Omit<CaptureFieldDef, "key"> {
  key: string;
}

// Exported for Profile.test.tsx's catalog invariant: every field this editor
// can EMPTY must have a wire clear (CLEARABLE_INTAKE_FIELDS). Reading the list
// is how that test stays true as fields are added.
export const PROFILE_FIELDS: ProfileFieldDef[] = [
  ...CAPTURE_FIELDS.slice(0, 5),
  { key: "employerName", label: "Employer", kind: "text", icon: UserCircle2 },
  ...CAPTURE_FIELDS.slice(5, 9),
  { key: "propertyState", label: "Property state", kind: "text", icon: FileText },
  ...CAPTURE_FIELDS.slice(9),
];

const CREDIT_BAND_OPTIONS = [
  { value: "760", label: "Excellent (760+)" },
  { value: "720", label: "Very good (720–759)" },
  { value: "680", label: "Good (680–719)" },
  { value: "640", label: "Fair (640–679)" },
  { value: "600", label: "Below average (600–639)" },
  { value: "not_sure", label: "Not sure" },
];

const ENUM_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  employmentType: [
    { value: "employed", label: "Employed" },
    { value: "self_employed", label: "Self-employed" },
    { value: "retired", label: "Retired" },
    { value: "other", label: "Other" },
  ],
  propertyType: [
    { value: "single_family", label: "Single family" },
    { value: "condo", label: "Condo" },
    { value: "townhouse", label: "Townhouse" },
    { value: "multi_family", label: "Multi-family" },
  ],
  loanPurpose: [
    { value: "purchase", label: "Purchase" },
    { value: "refinance", label: "Refinance" },
    { value: "cash_out", label: "Cash-out refinance" },
  ],
};

function toFormValue(field: ProfileFieldDef, raw: string | number | boolean | null): string | boolean {
  if (field.kind === "bool") return raw === true;
  if (raw === null || raw === undefined) return "";
  if (field.kind === "money") {
    const n = parseFloat(String(raw));
    return Number.isFinite(n) ? String(n) : String(raw);
  }
  return String(raw);
}

export default function Profile() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery<FinancialProfileResponse>({
    queryKey: ["/api/profile/financial"],
  });

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string | boolean>>({});

  const application = data?.application ?? null;
  const coachFields = new Set(data?.coachCapture?.fields ?? []);

  const startEditing = () => {
    if (!application) return;
    const initial: Record<string, string | boolean> = {};
    for (const field of PROFILE_FIELDS) {
      initial[field.key] = toFormValue(field, application.fields[field.key] ?? null);
    }
    setForm(initial);
    setEditing(true);
  };

  const saveEdits = useMutation({
    mutationFn: async () => {
      if (!application) return null;
      const payload: Record<string, string | boolean | null> = {};
      // Fields the borrower EMPTIED that already held a value.
      //
      // These used to be dropped in silence — the other edits saved, the toast
      // said "Your self-reported details were saved", the refetch put the old
      // value back, and no state existed in which the borrower could tell
      // (#451's defect class). They now travel as an explicit `null`, which is
      // the intake schema's third wire state: absent = unchanged, a value =
      // set, `null` = clear (CLEARABLE_INTAKE_FIELDS, shared/schema/
      // lendingUrla.ts). An empty string is still rejected on purpose, so the
      // translation has to happen here rather than by sending `next` through.
      const uncleared: string[] = [];
      for (const field of PROFILE_FIELDS) {
        const current = toFormValue(field, application.fields[field.key] ?? null);
        const next = form[field.key];
        if (next === undefined || next === current) continue;
        if (typeof next === "string" && next.trim() === "") { // absent, never "0"
          // Blanking an already-blank field is a no-op the borrower cannot
          // perceive; reporting it would be noise.
          if (typeof current !== "string" || current.trim() === "") continue;
          if (isClearableIntakeField(field.key)) {
            payload[field.key] = null;
            continue;
          }
          // No wire representation for clearing this one. Reachable only if a
          // field becomes emptyable in this editor without being added to the
          // catalog — say so rather than discard the edit, which is the whole
          // lesson of #451. `Profile.test.tsx` pins the invariant that keeps
          // this branch unreachable in practice.
          uncleared.push(field.label);
          continue;
        }
        payload[field.key] = next;
      }
      if (Object.keys(payload).length === 0) return { updated: null, uncleared };
      const res = await apiRequest("PATCH", `/api/loan-applications/${application.id}`, payload);
      return { updated: await res.json(), uncleared };
    },
    onSuccess: (result) => {
      const uncleared = result?.uncleared ?? [];
      // Stay in the editor while a field still needs the borrower's attention —
      // closing it would discard the very edit they are being asked to correct.
      if (!uncleared.length) setEditing(false);

      if (uncleared.length) {
        const list = uncleared.length === 1
          ? uncleared[0]
          : `${uncleared.slice(0, -1).join(", ")} and ${uncleared[uncleared.length - 1]}`;
        toast({
          title: result?.updated ? "Saved — but some fields can't be left blank" : "We couldn't clear those fields",
          description: `${list} can't be emptied. Enter a value instead — 0 is fine for an amount you don't have — or put the previous one back.`,
          variant: "destructive",
        });
      } else if (result?.updated) {
        toast({ title: "Profile updated", description: "Your self-reported details were saved to your draft application." });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/profile/financial"] });
      queryClient.invalidateQueries({ queryKey: ["/api/coach/intake/latest"] });
    },
    onError: (error: Error) => {
      const raw = error.message;
      let description = "Please check the values and try again.";
      try {
        const parsed = JSON.parse(raw.slice(raw.indexOf("{")));
        if (parsed.details && typeof parsed.details === "object") {
          const first = Object.entries(parsed.details as Record<string, string[]>)[0];
          if (first) description = `${first[0]}: ${first[1]?.[0] ?? "invalid value"}`;
        } else if (typeof parsed.error === "string") {
          description = parsed.error;
        }
      } catch {
        // keep generic description
      }
      toast({ title: "Couldn't save", description, variant: "destructive" });
    },
  });

  const tier = data?.readiness?.tier ? TIER_CONFIG[data.readiness.tier] : null;
  const initials = `${data?.user.firstName?.[0] ?? ""}${data?.user.lastName?.[0] ?? ""}`.toUpperCase() || "?";

  return (
    <PageShell
      width="content"
      icon={<UserCircle2 className="h-7 w-7 text-primary" />}
      title="My Profile"
      subtitle="Your account and the self-reported financial profile behind your pre-application"
    >
      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Identity */}
          <Card data-testid="card-profile-identity">
            <CardContent className="flex items-center gap-4 pt-6">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary">
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-foreground truncate" data-testid="text-profile-name">
                  {[data?.user.firstName, data?.user.lastName].filter(Boolean).join(" ") || "Your account"}
                </p>
                <p className="text-sm text-muted-foreground truncate">{data?.user.email}</p>
              </div>
              <Badge variant="secondary" className="shrink-0 capitalize">
                {data?.user.role?.replace(/_/g, " ")}
              </Badge>
            </CardContent>
          </Card>

          {/* Financial profile */}
          <Card data-testid="card-financial-profile">
            <CardHeader className="pb-3">
              <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                <span className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  Financial Profile
                </span>
                <span className="flex items-center gap-1.5">
                  {application?.currentDecisionGrade ? (
                    <Badge className="gap-1 text-xs"><BadgeCheck className="h-3 w-3" />Verified</Badge>
                  ) : application?.financialDataProvenance === "verified" ? (
                    <Badge variant="secondary" className="text-xs font-normal">Evidence needs refresh</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs font-normal">Self-reported</Badge>
                  )}
                  {application?.editable && !editing && (
                    <Button variant="outline" size="sm" className="touch-target gap-1 text-xs" onClick={startEditing} data-testid="button-edit-profile">
                      <Pencil className="h-3 w-3" />
                      Edit
                    </Button>
                  )}
                  {editing && (
                    <>
                      <Button
                        size="sm"
                        className="touch-target text-xs"
                        onClick={() => saveEdits.mutate()}
                        disabled={saveEdits.isPending}
                        data-testid="button-save-profile"
                      >
                        {saveEdits.isPending ? "Saving…" : "Save"}
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Cancel" onClick={() => setEditing(false)} data-testid="button-cancel-edit">
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </span>
              </CardTitle>
              {data?.coachCapture && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="text-coach-capture-trail">
                  <Bot className="h-3.5 w-3.5 shrink-0" />
                  {data.coachCapture.fields.length} detail{data.coachCapture.fields.length === 1 ? "" : "s"} captured by yHomi ·
                  last saved {new Date(data.coachCapture.lastSyncedAt).toLocaleDateString()}
                </p>
              )}
              {application && !application.editable && (
                <p className="text-xs text-muted-foreground">
                  Your application has been submitted — contact your loan team to update these details.
                </p>
              )}
            </CardHeader>
            <CardContent>
              {!application ? (
                <div className="space-y-3 py-6 text-center" data-testid="profile-empty-state">
                  <p className="text-sm text-muted-foreground">
                    Nothing captured yet. Chat with yHomi — every detail you share is saved here automatically.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button asChild className="gap-2" data-testid="button-empty-coach">
                      <Link href="/ai-coach">
                        <Bot className="h-4 w-4" />
                        Chat with Homi
                      </Link>
                    </Button>
                    <Button asChild variant="outline" className="gap-2" data-testid="button-empty-apply">
                      <Link href="/apply">
                        <FileText className="h-4 w-4" />
                        Start Pre-Approval
                      </Link>
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2" data-testid="profile-field-grid">
                  {PROFILE_FIELDS.map((field) => {
                    const raw = application.fields[field.key] ?? null;
                    const display = formatCaptureValue(field.kind, raw as never);
                    const fromCoach = coachFields.has(field.key);
                    const Icon = field.icon;

                    if (!editing) {
                      return (
                        <div key={field.key} className="flex items-center gap-2.5 rounded-lg px-2 py-2" data-testid={`profile-field-${field.key}`}>
                          <Icon className={`h-4 w-4 shrink-0 ${display ? "text-primary" : "text-muted-foreground/50"}`} />
                          <span className={`flex-1 min-w-0 truncate text-sm ${display ? "text-foreground" : "text-muted-foreground"}`}>
                            {field.label}
                          </span>
                          {fromCoach && display && (
                            <Bot className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Captured by Homi" />
                          )}
                          <span className={`shrink-0 text-sm font-medium ${display ? "text-foreground" : "text-muted-foreground/70"}`}>
                            {display ?? "—"}
                          </span>
                        </div>
                      );
                    }

                    const formValue = form[field.key];
                    return (
                      <div key={field.key} className="space-y-1 px-2 py-1.5" data-testid={`profile-edit-${field.key}`}>
                        <Label htmlFor={`edit-${field.key}`} className="text-xs text-muted-foreground">
                          {field.label}
                        </Label>
                        {field.kind === "bool" ? (
                          <div className="flex h-9 items-center">
                            <Switch
                              id={`edit-${field.key}`}
                              checked={formValue === true}
                              onCheckedChange={(checked) => setForm((f) => ({ ...f, [field.key]: checked }))}
                            />
                          </div>
                        ) : field.kind === "credit" ? (
                          <Select
                            value={String(formValue || "")}
                            onValueChange={(v) => setForm((f) => ({ ...f, [field.key]: v }))}
                          >
                            <SelectTrigger id={`edit-${field.key}`} className="h-9">
                              <SelectValue placeholder="Select range" />
                            </SelectTrigger>
                            <SelectContent>
                              {CREDIT_BAND_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : field.kind === "enum" ? (
                          <Select
                            value={String(formValue || "")}
                            onValueChange={(v) => setForm((f) => ({ ...f, [field.key]: v }))}
                          >
                            <SelectTrigger id={`edit-${field.key}`} className="h-9">
                              <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
                            </SelectTrigger>
                            <SelectContent>
                              {(ENUM_OPTIONS[field.key] ?? []).map((o) => (
                                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Input
                            id={`edit-${field.key}`}
                            className="h-9"
                            inputMode={field.kind === "money" || field.kind === "years" ? "numeric" : undefined}
                            maxLength={field.key === "propertyState" ? 2 : undefined}
                            value={String(formValue ?? "")}
                            onChange={(e) =>
                              setForm((f) => ({
                                ...f,
                                [field.key]:
                                  field.key === "propertyState" ? e.target.value.toUpperCase() : e.target.value,
                              }))
                            }
                            placeholder={field.kind === "money" ? "e.g. 85000" : undefined}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Readiness */}
          {data?.readiness && (
            <Card data-testid="card-profile-readiness">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Mortgage Readiness
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {tier && <Badge variant="secondary">{tier.label}</Badge>}
                  {typeof data.readiness.completionPercentage === "number" && (
                    <span className="text-sm text-muted-foreground">
                      {data.readiness.completionPercentage}% of required inputs complete
                    </span>
                  )}
                </div>
                {typeof data.readiness.completionPercentage === "number" && (
                  <Progress value={data.readiness.completionPercentage} className="h-2" />
                )}
                <Button asChild variant="outline" className="w-full gap-2" data-testid="button-continue-coach">
                  <Link href="/ai-coach">
                    <Bot className="h-4 w-4" />
                    Continue with yHomi
                    <ArrowRight className="h-4 w-4 ml-auto" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Next steps */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button asChild className="w-full gap-2" data-testid="button-profile-apply">
              <Link href="/apply">
                <FileText className="h-4 w-4" />
                Get Pre-Approved
                <ArrowRight className="h-4 w-4 ml-auto" />
              </Link>
            </Button>
            <Button asChild variant="outline" className="w-full gap-2" data-testid="button-profile-urla">
              <Link href="/urla-form">
                <FileText className="h-4 w-4" />
                Full Application (URLA)
                <ArrowRight className="h-4 w-4 ml-auto" />
              </Link>
            </Button>
          </div>

          <PresalesDisclaimer />
        </div>
      )}
    </PageShell>
  );
}
