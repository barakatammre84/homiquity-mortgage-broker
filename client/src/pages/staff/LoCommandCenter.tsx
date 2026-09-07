import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { downloadResponseAsFile } from "@/lib/downloadFile";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { friendlyApiError } from "@/lib/errorMessage";
import { isInternalStaffRole } from "@shared/roles";
import { Gauge, Users } from "lucide-react";
import { AttentionRail } from "./loCommandCenter/AttentionRail";
import { ActiveBorrowerPane } from "./loCommandCenter/ActiveBorrowerPane";
import { ActionsRail } from "./loCommandCenter/ActionsRail";
import { IntakeInboxCard } from "./loCommandCenter/IntakeInboxCard";
import type { QueueData, StaffSignal } from "./loCommandCenter/types";

// -----------------------------------------------------------------------------
// LO Command Center — advisory cockpit (LO Advisor Program prompt LO-1).
//
// Three panes, one question answered without navigating away: "where does this
// file stand and what do I do next?"
//   Left  — attention rail: signalEngine feed (priority-sorted) + pipeline queue.
//   Center— active borrower: on select, the file's cockpit loads in place
//           (status, UAL income evaluation, conditions, documents, messages).
//   Right — actions: pre-approval letter, What-If simulator (LO-2), rate lock,
//           MISMO export, and a Call Prep digest.
//
// Wiring, not greenfield: every pane reads endpoints that already exist plus the
// two LO-1 additions (GET /api/staff/signals, GET /api/staff/applications/:id/
// cockpit). Client role gate mirrors the server (isInternalStaffRole); PII stays
// masked — the cockpit shows operational data, full PII lives behind the
// deep-linked BorrowerFile's audited reveal.
// -----------------------------------------------------------------------------

export default function LoCommandCenter() {
  const { user, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [didInitialSelect, setDidInitialSelect] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);

  const isInternalStaff = isInternalStaffRole(user?.role || "");
  const canClaim = user?.role === "lo" || user?.role === "loa";
  const enabled = !authLoading && !!user && isInternalStaff;

  const { data: queueData, isLoading: queueLoading } = useQuery<QueueData>({
    queryKey: ["/api/pipeline/queue"],
    enabled,
  });
  const { data: signalsData } = useQuery<{ signals: StaffSignal[] }>({
    queryKey: ["/api/staff/signals"],
    enabled,
  });

  const queue = queueData?.queue ?? [];
  const signals = useMemo(() => signalsData?.signals ?? [], [signalsData]);

  // Default the center pane to the top signal (or first file) ONCE on first
  // load — not on every deselect, or the mobile back button could never return
  // to the attention rail. Prefer the highest-priority signal's file.
  useEffect(() => {
    if (!didInitialSelect && queue.length > 0) {
      const firstSignal = signals.find((s) => s.applicationId);
      setSelectedId(firstSignal?.applicationId ?? queue[0].applicationId);
      setDidInitialSelect(true);
    }
  }, [didInitialSelect, queue, signals]);

  const selectedBorrowerName = useMemo(
    () => queue.find((f) => f.applicationId === selectedId)?.borrowerName ?? "Borrower",
    [queue, selectedId],
  );

  const handleExportMismo = async (applicationId: string) => {
    setExportingId(applicationId);
    try {
      const res = await apiRequest("GET", `/api/loan-applications/${applicationId}/mismo-export`).catch(
        (err: unknown) => {
          throw new Error(err instanceof ApiError && err.status === 403
            ? "MISMO export is restricted to internal staff with access to this application."
            : friendlyApiError(err, "Failed to generate the MISMO file."));
        },
      );
      await downloadResponseAsFile(res, `mismo-${applicationId}.xml`);
      toast({ title: "MISMO 3.4 exported", description: "The readiness-gated XML package has been downloaded." });
    } catch (error) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "Unexpected error.",
        variant: "destructive",
      });
    } finally {
      setExportingId(null);
    }
  };

  if (authLoading || (enabled && queueLoading)) {
    return (
      <div className="p-8">
        <Skeleton className="mb-6 h-8 w-64" />
        <div className="grid gap-4 lg:grid-cols-[280px_1fr_220px]">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (!user || !isInternalStaff) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <Card className="max-w-md">
          <CardContent className="p-8 text-center">
            <Users className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden="true" />
            <h2 className="mb-2 text-xl font-semibold">Internal staff only</h2>
            <p className="text-muted-foreground">
              The LO Command Center works on deal-team pipelines and lender-ready exports, which are reserved for
              internal staff.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="lo-command-center">
      <div className="border-b border-border px-4 py-4 md:px-6">
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Gauge className="h-6 w-6 text-primary" aria-hidden="true" />
          LO Command Center
        </h1>
        <p className="text-sm text-muted-foreground">
          {user.role === "admin"
            ? "Every active file, most urgent first — pick one to see where it stands and what's next."
            : "Your book, most urgent first — pick a file to see where it stands and what's next."}
        </p>
      </div>

      <div className="grid flex-1 gap-4 overflow-hidden p-4 md:px-6 lg:grid-cols-[300px_1fr_240px]">
        {/* Left: attention rail (hidden on mobile once a file is open) */}
        <aside className={`overflow-y-auto ${selectedId ? "hidden lg:block" : "block"}`} aria-label="Attention rail">
          {canClaim && <IntakeInboxCard onClaim={setSelectedId} />}
          <AttentionRail
            queue={queue}
            signals={signals}
            selectedId={selectedId}
            onSelect={setSelectedId}
            loading={queueLoading}
          />
        </aside>

        {/* Center: active borrower */}
        <main className={`overflow-y-auto rounded-lg border border-border ${selectedId ? "block" : "hidden lg:block"}`}>
          {selectedId ? (
            <ActiveBorrowerPane applicationId={selectedId} onBack={() => setSelectedId(null)} />
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div>
                <Gauge className="mx-auto mb-3 h-10 w-10 text-muted-foreground" aria-hidden="true" />
                <p className="font-medium">Pick a file to open the cockpit</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Its status, income, conditions, documents and messages load here — no navigating away.
                </p>
              </div>
            </div>
          )}
        </main>

        {/* Right: actions (only when a file is active) */}
        <aside className={`overflow-y-auto ${selectedId ? "block" : "hidden lg:block"}`} aria-label="Actions">
          {selectedId ? (
            <ActionsRail
              applicationId={selectedId}
              borrowerName={selectedBorrowerName}
              signals={signals}
              onExportMismo={() => handleExportMismo(selectedId)}
              exporting={exportingId === selectedId}
            />
          ) : (
            <p className="hidden text-sm text-muted-foreground lg:block">Actions appear when you pick a file.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
