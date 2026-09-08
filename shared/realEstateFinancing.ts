import type { RealEstateOwned } from "./schema";

/**
 * Count financed owned properties only when the ownership disclosure and the
 * financing state of every listed property are known. A payment proves
 * financing; an explicit zero balance proves the opposite.
 */
export function confirmedMortgagedReoCount(
  ownsOtherRealEstate: boolean | null | undefined,
  reo: Array<Pick<RealEstateOwned, "mortgageBalance" | "mortgagePayment">>,
): number | undefined {
  if (ownsOtherRealEstate === false) return 0;
  if (ownsOtherRealEstate !== true || reo.length === 0) return undefined;
  if (reo.some((property) => property.mortgageBalance == null && property.mortgagePayment == null)) {
    return undefined;
  }
  return reo.filter((property) =>
    Number(property.mortgageBalance || 0) > 0 || Number(property.mortgagePayment || 0) > 0,
  ).length;
}
