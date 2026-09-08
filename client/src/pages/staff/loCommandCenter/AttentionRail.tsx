import { useMemo, useState } from "react";
import { Search, TrendingUp, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HEALTH_META, HEALTH_ORDER, SIGNAL_META, type PipelineSummary, type StaffSignal } from "./types";

// -----------------------------------------------------------------------------
// Left pane — attention rail
// -----------------------------------------------------------------------------
const DEFAULT_VISIBLE_SIGNALS = 8;
const DEFAULT_VISIBLE_FILES = 20;

export function AttentionRail({
  queue,
  signals,
  selectedId,
  onSelect,
  loading,
}: {
  queue: PipelineSummary[];
  signals: StaffSignal[];
  selectedId: string | null;
  onSelect: (applicationId: string) => void;
  loading: boolean;
}) {
  const [search, setSearch] = useState("");
  const filesSorted = useMemo(
    () =>
      [...queue].sort((a, b) => {
        const byHealth = HEALTH_ORDER[a.fileHealth.light] - HEALTH_ORDER[b.fileHealth.light];
        if (byHealth !== 0) return byHealth;
        return (b.daysIdle ?? 0) - (a.daysIdle ?? 0);
      }),
    [queue],
  );

  // Signals that point at a file the LO can open (priority-sorted already).
  const actionableSignals = useMemo(() => signals.filter((s) => s.applicationId), [signals]);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleSignals = useMemo(
    () => normalizedSearch
      ? actionableSignals.filter((signal) =>
          `${signal.borrowerName} ${signal.title}`.toLocaleLowerCase().includes(normalizedSearch),
        )
      : actionableSignals.slice(0, DEFAULT_VISIBLE_SIGNALS),
    [actionableSignals, normalizedSearch],
  );
  const visibleFiles = useMemo(() => {
    if (normalizedSearch) {
      return filesSorted.filter((file) => file.borrowerName.toLocaleLowerCase().includes(normalizedSearch));
    }
    const firstFiles = filesSorted.slice(0, DEFAULT_VISIBLE_FILES);
    const selected = selectedId ? filesSorted.find((file) => file.applicationId === selectedId) : undefined;
    return selected && !firstFiles.some((file) => file.applicationId === selected.applicationId)
      ? [selected, ...firstFiles]
      : firstFiles;
  }, [filesSorted, normalizedSearch, selectedId]);

  if (loading) {
    return (
      <div className="space-y-3" data-testid="attention-rail-loading">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="attention-rail">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Find a pipeline borrower"
          aria-label="Find a pipeline borrower"
          className="h-9 pl-8 text-sm"
          data-testid="input-pipeline-search"
        />
      </div>

      {visibleSignals.length > 0 && (
        <section aria-labelledby="signals-heading">
          <h2
            id="signals-heading"
            className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
            Needs attention ({actionableSignals.length})
          </h2>
          <ul className="space-y-2">
            {visibleSignals.map((signal, idx) => {
              const meta = SIGNAL_META[signal.priority];
              const active = signal.applicationId === selectedId;
              return (
                <li key={`${signal.applicationId}-${signal.type}-${idx}`}>
                  <button
                    type="button"
                    onClick={() => signal.applicationId && onSelect(signal.applicationId)}
                    className={`w-full rounded-md border p-3 text-left transition-colors hover:bg-muted/50 ${
                      active ? "border-primary bg-primary/5" : "border-border"
                    }`}
                    data-testid={`signal-${signal.applicationId}`}
                    aria-current={active ? "true" : undefined}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{signal.borrowerName}</span>
                      <Badge variant={meta.badge}>{meta.label}</Badge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground" title={signal.title}>
                      {signal.title}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
          {!normalizedSearch && actionableSignals.length > DEFAULT_VISIBLE_SIGNALS && (
            <p className="mt-2 text-xs text-muted-foreground">
              Showing the {DEFAULT_VISIBLE_SIGNALS} most urgent signals. Search to find another borrower.
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="pipeline-heading">
        <h2
          id="pipeline-heading"
          className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          <Users className="h-3.5 w-3.5" aria-hidden="true" />
          Pipeline ({filesSorted.length})
        </h2>
        {filesSorted.length === 0 ? (
          <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">
            No active files in your pipeline yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {visibleFiles.map((file) => {
              const meta = HEALTH_META[file.fileHealth.light];
              const active = file.applicationId === selectedId;
              return (
                <li key={file.applicationId}>
                  <button
                    type="button"
                    onClick={() => onSelect(file.applicationId)}
                    className={`flex w-full items-center gap-2 rounded-md border p-2.5 text-left transition-colors hover:bg-muted/50 ${
                      active ? "border-primary bg-primary/5" : "border-transparent"
                    }`}
                    data-testid={`pipeline-file-${file.applicationId}`}
                    aria-current={active ? "true" : undefined}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className={`h-2.5 w-2.5 shrink-0 rounded-full ${meta.dotClass}`}
                          aria-label={`File health: ${meta.label}`}
                        />
                      </TooltipTrigger>
                      <TooltipContent side="right">{meta.label}</TooltipContent>
                    </Tooltip>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{file.borrowerName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {file.conditionsOutstanding}/{file.conditionsTotal} cond · {file.daysInPipeline}d
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {normalizedSearch && visibleFiles.length === 0 && visibleSignals.length === 0 && (
          <p className="rounded-md border border-border p-3 text-sm text-muted-foreground" data-testid="text-no-pipeline-match">
            No borrower matches that search.
          </p>
        )}
        {!normalizedSearch && filesSorted.length > DEFAULT_VISIBLE_FILES && (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="text-pipeline-limited">
            Showing the {DEFAULT_VISIBLE_FILES} most urgent files. Search to find another borrower.
          </p>
        )}
      </section>
    </div>
  );
}
