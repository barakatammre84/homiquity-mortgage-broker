import { useQuery } from "@tanstack/react-query";

import { loanApplicationKeys } from "@/lib/queryClient";
import { useActiveApplication } from "@/hooks/useActiveApplication";
import type { LoanApplication } from "@shared/schema";

export interface BorrowerActionItem {
  id: string;
  type: string;
  title: string;
  description?: string | null;
  priority: "urgent" | "high" | "normal" | string;
  dueDate?: string;
  status: "pending" | "in_progress" | string;
  actionUrl: string;
  actionLabel: string;
}

export interface BorrowerActionItemsResponse {
  items: BorrowerActionItem[];
  stats: { total: number; urgent: number; pending: number; completed: number };
}

export function useBorrowerActionItems(applicationId: string | undefined, enabled = true) {
  return useQuery<BorrowerActionItemsResponse>({
    queryKey: loanApplicationKeys.actionItems(applicationId ?? ""),
    enabled: enabled && !!applicationId,
    refetchInterval: enabled && applicationId ? 30_000 : false,
  });
}

/** The borrower shell reads the same selected-file actions as the page body. */
export function useActiveBorrowerActionItems(enabled = true) {
  const { data: applications = [], isLoading: applicationsLoading } = useQuery<LoanApplication[]>({
    queryKey: loanApplicationKeys.all(),
    enabled,
  });
  const { activeApplication } = useActiveApplication(applications);
  const query = useBorrowerActionItems(activeApplication?.id, enabled);

  return {
    ...query,
    activeApplication,
    isLoading: applicationsLoading || query.isLoading,
  };
}
