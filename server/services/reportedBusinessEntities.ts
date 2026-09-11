import { eq } from "drizzle-orm";
import {
  borrowerBusinessEntities,
  BUSINESS_ENTITY_TYPES,
  type BorrowerBusinessEntity,
  type BusinessEntityType,
  type IncomeSourceEntry,
} from "@shared/schema";
import { normalizeEntityName } from "@shared/taxFormExtraction";
import { db } from "../db";
import type { DatabaseTransaction } from "./documentLineage";

export interface ReportedBusinessCandidate {
  identityKey: string;
  entityType: BusinessEntityType;
  name: string;
  ownershipPercent: string | null;
}

const businessEntityTypes = new Set<string>(BUSINESS_ENTITY_TYPES);

/** Convert fast-intake self-employment answers into stable borrower facts. */
export function reportedBusinessCandidates(
  incomeSources: IncomeSourceEntry[] | null | undefined,
): ReportedBusinessCandidate[] {
  const candidates = new Map<string, ReportedBusinessCandidate>();
  for (const source of incomeSources ?? []) {
    if (source.type !== "self_employed") continue;
    const name = source.employerName?.trim();
    const normalizedName = name ? normalizeEntityName(name) : "";
    if (!name || !normalizedName || !source.businessStructure || !businessEntityTypes.has(source.businessStructure)) continue;
    const ownership = source.ownershipPercent?.trim();
    const ownershipNumber = ownership ? Number(ownership) : null;
    const identityKey = `name:${normalizedName}`;
    candidates.set(identityKey, {
      identityKey,
      entityType: source.businessStructure as BusinessEntityType,
      name,
      ownershipPercent: ownershipNumber !== null && Number.isFinite(ownershipNumber)
        ? ownershipNumber.toFixed(2)
        : null,
    });
  }
  return [...candidates.values()].sort((a, b) => a.identityKey.localeCompare(b.identityKey));
}

/**
 * Materialize the borrower's stated businesses so a standalone P&L or bank
 * statement can be attributed before a tax package exists. Idempotent and
 * conservative: human-confirmed rows and tax-enriched fields are preserved.
 */
export async function syncReportedBusinessEntities(
  userId: string,
  applicationId: string,
  incomeSources: IncomeSourceEntry[] | null | undefined,
  existingTransaction?: DatabaseTransaction,
): Promise<BorrowerBusinessEntity[]> {
  const transaction = existingTransaction ?? db;
  const candidates = reportedBusinessCandidates(incomeSources);
  if (!candidates.length) return [];
  const existing = await transaction.select().from(borrowerBusinessEntities)
    .where(eq(borrowerBusinessEntities.userId, userId));
  const existingByKey = new Map(existing.map(entity => [entity.identityKey, entity]));
  const rows: BorrowerBusinessEntity[] = [];

  for (const candidate of candidates) {
    const prior = existingByKey.get(candidate.identityKey);
    if (prior) {
      if (!prior.autoResolved || prior.sourceFormCount > 0) {
        if (!prior.reportedByBorrower || prior.applicationId !== applicationId) {
          const [updated] = await transaction.update(borrowerBusinessEntities).set({
            applicationId,
            reportedByBorrower: true,
            updatedAt: new Date(),
          }).where(eq(borrowerBusinessEntities.id, prior.id)).returning();
          rows.push(updated);
        } else {
          rows.push(prior);
        }
        continue;
      }
      const [updated] = await transaction.update(borrowerBusinessEntities).set({
        applicationId,
        entityType: candidate.entityType,
        name: candidate.name,
        ownershipPercent: candidate.ownershipPercent,
        resolutionNotes: "Reported by borrower in mortgage intake; supporting evidence has not yet been reviewed.",
        reportedByBorrower: true,
        updatedAt: new Date(),
      }).where(eq(borrowerBusinessEntities.id, prior.id)).returning();
      rows.push(updated);
      continue;
    }
    const [created] = await transaction.insert(borrowerBusinessEntities).values({
      userId,
      applicationId,
      identityKey: candidate.identityKey,
      entityType: candidate.entityType,
      name: candidate.name,
      ownershipPercent: candidate.ownershipPercent,
      sourceFormCount: 0,
      resolutionNotes: "Reported by borrower in mortgage intake; supporting evidence has not yet been reviewed.",
      reportedByBorrower: true,
      autoResolved: true,
    }).onConflictDoUpdate({
      target: [borrowerBusinessEntities.userId, borrowerBusinessEntities.identityKey],
      set: {
        applicationId,
        reportedByBorrower: true,
        updatedAt: new Date(),
      },
    }).returning();
    rows.push(created);
  }
  return rows;
}
