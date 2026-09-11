import { db } from "../db";
import { eq, inArray } from "drizzle-orm";
import {
  borrowerBusinessEntities,
  logicalDocuments,
  type BorrowerBusinessEntity,
  type BusinessEntityType,
} from "@shared/schema";
import {
  ENTITY_BEARING_FORM_TYPES,
  normalizeEntityName,
  type TaxFormType,
} from "@shared/taxFormExtraction";
import {
  getLatestInstancesForUser,
  type PublicTaxFormInstance,
} from "./taxDocumentIntelligence";
import type { DatabaseTransaction } from "./documentLineage";

/**
 * Borrower business-entity resolution (UAL P2b). Reconstructs the borrower's
 * business structure from extracted tax forms: three Schedule Cs are three
 * sole proprietorships; a K-1 and the Form 1065 sharing an EIN are ONE
 * partnership; the same business across two tax years is one entity with
 * two source years.
 *
 * Deterministic and purely structural — it never computes income. Matching:
 *   1. EIN last-4 (strong key — same last-4 for the same user is the same
 *      entity for resolution purposes; a collision surfaces as a note when
 *      the names disagree);
 *   2. normalized entity name (see normalizeEntityName — suffix-preserving).
 *
 * Entity typing precedence: an authoritative business return (1065/1120-S/
 * 1120) outranks a K-1, which outranks a Schedule C default.
 */

export interface ResolvedEntitySourceForm {
  logicalDocumentId: string;
  formType: TaxFormType;
  taxYear: number | null;
}

export interface ResolvedEntity {
  identityKey: string;
  entityType: BusinessEntityType;
  name: string | null;
  einLast4: string | null;
  ownershipPercent: number | null;
  firstTaxYear: number | null;
  lastTaxYear: number | null;
  sourceForms: ResolvedEntitySourceForm[];
  notes: string[];
}

/** Higher wins when two forms disagree about what an entity is. */
const TYPE_PRECEDENCE: Record<BusinessEntityType, number> = {
  c_corporation: 4,
  s_corporation: 4,
  partnership: 4,
  single_member_llc: 2,
  sole_proprietorship: 1,
};

function entityTypeForInstance(instance: PublicTaxFormInstance): BusinessEntityType | null {
  switch (instance.formType) {
    case "schedule_c":
      // Schedule C cannot distinguish a sole proprietorship from a
      // single-member LLC; default to sole_proprietorship — the borrower
      // corrects it on the SE worksheet / P5 workbench.
      return "sole_proprietorship";
    case "business_tax_return_1065":
      return "partnership";
    case "business_tax_return_1120s":
      return "s_corporation";
    case "business_tax_return_1120":
      return "c_corporation";
    case "schedule_k1":
      return instance.k1Variant === "1120s" ? "s_corporation" : "partnership";
    default:
      return null;
  }
}

/** K-1 typing is weaker than the entity's own return; Schedule C is weakest. */
function typeStrength(instance: PublicTaxFormInstance): number {
  if (instance.formType === "schedule_k1") return 3;
  const t = entityTypeForInstance(instance);
  return t ? TYPE_PRECEDENCE[t] : 0;
}

function instanceEntityName(instance: PublicTaxFormInstance): string | null {
  const fromFields =
    (instance.fields.businessName?.value as string | undefined) ??
    (instance.fields.entityName?.value as string | undefined);
  return (typeof fromFields === "string" && fromFields.trim()) || instance.entityName || null;
}

function instanceEinLast4(instance: PublicTaxFormInstance): string | null {
  const v = instance.fields.entityEinLast4?.value;
  return typeof v === "string" && /^\d{4}$/.test(v) ? v : null;
}

interface EntityGroup {
  einLast4: string | null;
  name: string | null;
  normName: string | null;
  entityType: BusinessEntityType;
  typeStrength: number;
  ownershipPercent: number | null;
  ownershipYear: number | null;
  years: number[];
  sourceForms: ResolvedEntitySourceForm[];
  notes: string[];
}

/**
 * Pure resolution core — deterministic for a given instance list. Instances
 * are internally ordered (business returns → K-1s → Schedule Cs) so typing
 * and naming precedence never depend on caller order.
 */
export function resolveBusinessEntities(instances: PublicTaxFormInstance[]): ResolvedEntity[] {
  const bearing = instances
    .filter((i) => (ENTITY_BEARING_FORM_TYPES as readonly string[]).includes(i.formType))
    // Total order — resolution must not depend on caller order: authority
    // first, then form type, newest year, entity name.
    .sort(
      (a, b) =>
        typeStrength(b) - typeStrength(a) ||
        a.formType.localeCompare(b.formType) ||
        (b.taxYear ?? -1) - (a.taxYear ?? -1) ||
        (a.entityName ?? "").localeCompare(b.entityName ?? ""),
    );

  const byEin = new Map<string, EntityGroup>();
  const byName = new Map<string, EntityGroup>();
  const groups: EntityGroup[] = [];

  for (const instance of bearing) {
    const name = instanceEntityName(instance);
    const normName = name ? normalizeEntityName(name) : null;
    const ein = instanceEinLast4(instance);
    const type = entityTypeForInstance(instance);
    if (!type) continue;
    if (!name && !ein) {
      // An entity-bearing form with no readable identity cannot be resolved;
      // it stays unlinked and surfaces via the form's own review status.
      continue;
    }

    let group = (ein && byEin.get(ein)) || (normName && byName.get(normName)) || null;
    if (!group) {
      group = {
        einLast4: null,
        name: null,
        normName: null,
        entityType: type,
        typeStrength: 0,
        ownershipPercent: null,
        ownershipYear: null,
        years: [],
        sourceForms: [],
        notes: [],
      };
      groups.push(group);
    }

    // Register/verify keys.
    if (ein) {
      if (group.einLast4 && group.einLast4 !== ein) {
        group.notes.push(
          `Conflicting EIN last-4 (${group.einLast4} vs ${ein}) under the same entity name — needs review`,
        );
      } else if (!group.einLast4) {
        group.einLast4 = ein;
        byEin.set(ein, group);
      }
    }
    if (normName) {
      if (group.normName && group.normName !== normName) {
        group.notes.push(
          `EIN ...${group.einLast4} appears under two names ("${group.name}" and "${name}") — needs review`,
        );
      } else if (!group.normName) {
        group.name = name;
        group.normName = normName;
        byName.set(normName, group);
      }
    }

    // Typing precedence.
    const strength = typeStrength(instance);
    if (strength > group.typeStrength) {
      if (group.typeStrength > 0 && group.entityType !== type) {
        group.notes.push(
          `Entity type upgraded from ${group.entityType} to ${type} based on ${instance.formType}`,
        );
      }
      group.entityType = type;
      group.typeStrength = strength;
    }

    // Ownership: from the most recent K-1.
    if (instance.formType === "schedule_k1") {
      const pct = instance.fields.ownershipPercentEndOfYear?.value;
      const year = instance.taxYear ?? 0;
      if (typeof pct === "number" && year >= (group.ownershipYear ?? -1)) {
        group.ownershipPercent = pct;
        group.ownershipYear = year;
      }
    }

    if (instance.taxYear !== null) group.years.push(instance.taxYear);
    group.sourceForms.push({
      logicalDocumentId: instance.logicalDocumentId,
      formType: instance.formType,
      taxYear: instance.taxYear,
    });
  }

  return groups
    .map((g) => ({
      identityKey: g.einLast4 ? `ein:${g.einLast4}` : `name:${g.normName}`,
      entityType: g.entityType,
      name: g.name,
      einLast4: g.einLast4,
      ownershipPercent: g.ownershipPercent,
      firstTaxYear: g.years.length ? Math.min(...g.years) : null,
      lastTaxYear: g.years.length ? Math.max(...g.years) : null,
      sourceForms: g.sourceForms,
      notes: g.notes,
    }))
    .sort((a, b) => a.identityKey.localeCompare(b.identityKey));
}

/**
 * Resolve the user's entities from their latest extractions and persist:
 * upsert on (user_id, identity_key), refresh auto-resolved rows, never
 * overwrite a human-confirmed row (auto_resolved=false), and link each
 * source logical_documents row to its entity.
 */
export async function resolveAndPersistEntities(
  userId: string,
  applicationId?: string,
  existingTransaction?: DatabaseTransaction,
): Promise<{
  entities: BorrowerBusinessEntity[];
  linkedForms: number;
}> {
  const transaction = existingTransaction ?? db;
  const instances = await getLatestInstancesForUser(userId, applicationId, transaction);
  const resolved = resolveBusinessEntities(instances);
  if (resolved.length === 0) return { entities: [], linkedForms: 0 };

  const existing = await transaction
    .select()
    .from(borrowerBusinessEntities)
    .where(eq(borrowerBusinessEntities.userId, userId));
  const existingByKey = new Map(existing.map((e) => [e.identityKey, e]));
  const reportedByName = new Map(existing.flatMap((entity) => {
    const name = entity.reportedByBorrower && entity.name ? normalizeEntityName(entity.name) : "";
    return name ? [[name, entity] as const] : [];
  }));

  const persisted: BorrowerBusinessEntity[] = [];
  let linkedForms = 0;

  const persist = async (tx: DatabaseTransaction) => {
    for (const entity of resolved) {
      // Intake usually knows a business name before tax extraction reveals an
      // EIN. Reuse that stable row so P&L lineage and tax forms converge.
      const prior = existingByKey.get(entity.identityKey)
        ?? (entity.name ? reportedByName.get(normalizeEntityName(entity.name)) : undefined);
      let row: BorrowerBusinessEntity;
      if (prior && !prior.autoResolved) {
        // Human-confirmed: keep their values, still refresh coverage counters.
        [row] = await tx
          .update(borrowerBusinessEntities)
          .set({
            applicationId: applicationId ?? prior.applicationId,
            einLast4: entity.einLast4,
            firstTaxYear: entity.firstTaxYear,
            lastTaxYear: entity.lastTaxYear,
            sourceFormCount: entity.sourceForms.length,
            updatedAt: new Date(),
          })
          .where(eq(borrowerBusinessEntities.id, prior.id))
          .returning();
      } else if (prior) {
        [row] = await tx
          .update(borrowerBusinessEntities)
          .set({
            applicationId: applicationId ?? prior.applicationId,
            entityType: prior.reportedByBorrower ? prior.entityType : entity.entityType,
            name: prior.reportedByBorrower ? prior.name : entity.name,
            einLast4: entity.einLast4,
            ownershipPercent: prior.reportedByBorrower
              ? prior.ownershipPercent
              : entity.ownershipPercent !== null ? entity.ownershipPercent.toFixed(2) : null,
            firstTaxYear: entity.firstTaxYear,
            lastTaxYear: entity.lastTaxYear,
            sourceFormCount: entity.sourceForms.length,
            resolutionNotes: entity.notes.length ? entity.notes.join("; ") : null,
            updatedAt: new Date(),
          })
          .where(eq(borrowerBusinessEntities.id, prior.id))
          .returning();
      } else {
        [row] = await tx
          .insert(borrowerBusinessEntities)
          .values({
            userId,
            applicationId: applicationId ?? null,
            identityKey: entity.identityKey,
            entityType: entity.entityType,
            name: entity.name,
            einLast4: entity.einLast4,
            ownershipPercent:
              entity.ownershipPercent !== null ? entity.ownershipPercent.toFixed(2) : null,
            firstTaxYear: entity.firstTaxYear,
            lastTaxYear: entity.lastTaxYear,
            sourceFormCount: entity.sourceForms.length,
            resolutionNotes: entity.notes.length ? entity.notes.join("; ") : null,
            autoResolved: true,
          })
          .onConflictDoUpdate({
            target: [borrowerBusinessEntities.userId, borrowerBusinessEntities.identityKey],
            set: {
              applicationId: applicationId ?? null,
              entityType: entity.entityType,
              name: entity.name,
              einLast4: entity.einLast4,
              ownershipPercent:
                entity.ownershipPercent !== null ? entity.ownershipPercent.toFixed(2) : null,
              firstTaxYear: entity.firstTaxYear,
              lastTaxYear: entity.lastTaxYear,
              sourceFormCount: entity.sourceForms.length,
              resolutionNotes: entity.notes.length ? entity.notes.join("; ") : null,
              updatedAt: new Date(),
            },
          })
          .returning();
      }
      persisted.push(row);

      const formIds = entity.sourceForms.map((f) => f.logicalDocumentId);
      if (formIds.length > 0) {
        await tx
          .update(logicalDocuments)
          .set({ businessEntityId: row.id })
          .where(inArray(logicalDocuments.id, formIds));
        linkedForms += formIds.length;
      }
    }
  };
  if (existingTransaction) await persist(existingTransaction);
  else await db.transaction(persist);

  return { entities: persisted, linkedForms };
}
