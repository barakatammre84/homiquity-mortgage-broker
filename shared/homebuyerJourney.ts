export type HomebuyerPlanningStage = "exploring" | "preparing" | "ready";

/**
 * A relationship stage, never a credit decision. The database's currentPhase
 * remains the detailed journey state; this reduces it to the three labels used
 * consistently across the renter experience.
 */
export function deriveHomebuyerPlanningStage(
  goal: { currentPhase?: string | null } | null,
): HomebuyerPlanningStage {
  if (!goal) return "exploring";
  return goal.currentPhase === "ready" ? "ready" : "preparing";
}
