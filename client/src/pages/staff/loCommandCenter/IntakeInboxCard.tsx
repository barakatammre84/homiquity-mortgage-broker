import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Inbox, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { QueueData } from "./types";

// Intake inbox — applications that arrived without a loan officer (self-serve
// applicants with no referral). Shown to LO/LOA at the top of the attention
// rail; claiming a file puts it on their desk (server-side assignLoanOfficer
// grants file access + queue visibility in one step) so no applicant sits
// stranded waiting on an admin assignment.
const DEFAULT_VISIBLE_FILES = 8;

export function IntakeInboxCard({ onClaim }: { onClaim?: (applicationId: string) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const { data, isLoading } = useQuery<QueueData>({
    queryKey: ["/api/pipeline/unassigned"],
  });

  const claim = useMutation({
    mutationFn: async (applicationId: string) => {
      const res = await apiRequest("POST", `/api/loan-applications/${applicationId}/claim`, {});
      return res.json();
    },
    onSuccess: (_data, applicationId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline/unassigned"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pipeline/queue"] });
      onClaim?.(applicationId);
      toast({ title: "File claimed", description: "It's on your desk and in your pipeline now." });
    },
    onError: (error) => {
      toast({
        title: "Couldn't claim this file",
        description: error instanceof Error ? error.message : "Unexpected error.",
        variant: "destructive",
      });
    },
  });

  const pool = data?.queue ?? [];
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visiblePool = useMemo(
    () =>
      normalizedSearch
        ? pool.filter((file) => file.borrowerName.toLocaleLowerCase().includes(normalizedSearch))
        : pool.slice(0, DEFAULT_VISIBLE_FILES),
    [normalizedSearch, pool],
  );
  if (isLoading || pool.length === 0) return null;

  return (
    <div
      className="mb-3 rounded-lg border border-info-subtle-foreground/25 bg-info-subtle p-3 text-info-subtle-foreground"
      data-testid="intake-inbox"
    >
      <div className="mb-2 flex items-center gap-2">
        <Inbox className="h-4 w-4 shrink-0" aria-hidden="true" />
        <h2 className="text-sm font-semibold">
          Intake inbox — {pool.length} waiting
        </h2>
      </div>
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-70" aria-hidden="true" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Find borrower"
          aria-label="Find an unassigned borrower"
          className="h-9 bg-background pl-8 text-sm text-foreground"
          data-testid="input-intake-search"
        />
      </div>
      <ul className="space-y-1.5">
        {visiblePool.map((file) => (
          <li
            key={file.applicationId}
            className="flex items-center justify-between gap-2"
            data-testid={`intake-${file.applicationId}`}
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{file.borrowerName}</p>
              <p className="text-xs opacity-80">waiting {file.daysInPipeline}d</p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="touch-target h-7 shrink-0 px-2 text-xs"
              onClick={() => claim.mutate(file.applicationId)}
              disabled={claim.isPending}
              data-testid={`claim-${file.applicationId}`}
            >
              {claim.isPending && claim.variables === file.applicationId ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                "Claim"
              )}
            </Button>
          </li>
        ))}
      </ul>
      {visiblePool.length === 0 && (
        <p className="py-2 text-sm opacity-80" data-testid="text-no-intake-match">
          No waiting borrower matches that name.
        </p>
      )}
      {!normalizedSearch && pool.length > DEFAULT_VISIBLE_FILES && (
        <p className="mt-2 text-xs opacity-80" data-testid="text-intake-limited">
          Showing the {DEFAULT_VISIBLE_FILES} most urgent. Search to find another borrower.
        </p>
      )}
    </div>
  );
}
