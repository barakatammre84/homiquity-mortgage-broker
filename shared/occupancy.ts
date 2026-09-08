export const OCCUPANCY_TYPES = [
  "primary_residence",
  "second_home",
  "investment",
] as const;

export type OccupancyType = (typeof OCCUPANCY_TYPES)[number];

export function parseOccupancyType(value: unknown): OccupancyType | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "primary") return "primary_residence";
  return OCCUPANCY_TYPES.includes(normalized as OccupancyType)
    ? (normalized as OccupancyType)
    : null;
}

export function occupancyLabel(value: unknown): string {
  switch (parseOccupancyType(value)) {
    case "primary_residence":
      return "Primary residence";
    case "second_home":
      return "Second home";
    case "investment":
      return "Investment property";
    default:
      return "Occupancy not provided";
  }
}

export function occupancyLetterLabel(value: unknown): string | null {
  const occupancy = parseOccupancyType(value);
  if (!occupancy) return null;
  return occupancyLabel(occupancy);
}
