import { and, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  borrowerConsents,
  documentExtractionJobs,
  documents,
  taxExtractionRuns,
  users,
  type DocumentExtractionJob,
} from "@shared/schema";
import type { ClassifiedFormInstance, TaxDocumentClassification, TaxFormType } from "@shared/taxFormExtraction";
import type { ExtractionLineage } from "../extractionCore";
import type { TaxFormInstanceExtraction } from "../extractionService";
import { db, pool } from "../db";
import { ObjectStorageService } from "../integrations/object_storage";
import { buildSyntheticTaxPacketPdf } from "./coreCanaryFixtures";
import {
  CORE_PROOF_AUTH_PROVIDER,
  assertTaxPacketFixtureOwnership,
  cleanupTaxPacketProofFixture,
  getTaxPacketEvidenceSnapshot,
  isTaxPacketProofJob,
  taxPacketFixtureObjectPaths,
  validateTaxPacketEvidenceSnapshot,
  type CoreTaxPacketProofIdentity,
  type CoreTaxPacketProofObjectStore,
} from "./coreTaxPacketProofShared";
import { withDocumentWorkflowLock } from "./documentLineage";

export const CORE_TAX_PACKET_RESTART_USER_ID = "00000000-0000-4000-8000-00000000c211";
export const CORE_TAX_PACKET_RESTART_DOCUMENT_ID = "00000000-0000-4000-8000-00000000c212";
export const CORE_TAX_PACKET_RESTART_JOB_ID = "00000000-0000-4000-8000-00000000c213";
export const CORE_TAX_PACKET_RESTART_FILE_NAME = "core-tax-packet-restart-proof.pdf";

const SEEDED_ACTION = "core.tax_packet_restart_seeded";
const PROVIDER_READY_ACTION = "core.tax_packet_restart_provider_ready";
export const CORE_TAX_PACKET_RESTART_COMPLETED_ACTION = "core.tax_packet_restart_completed";
export const CORE_TAX_PACKET_RESTART_TRIGGERED_ACTION = "core.tax_packet_restart_triggered";
const PROOF_MAX_AGE_MS = 60 * 60 * 1_000;
const PROVIDER_READY_WAIT_MS = 150_000;
const COMPLETION_WAIT_MS = 250_000;
const FIRST_CLAIM_HOLD_MS = 10 * 60 * 1_000;
const POLL_MS = 1_000;
const RERUN_COOLDOWN_MS = 30 * 60 * 1_000;
const LIFECYCLE_LOCK_KEY = "core-tax-packet-restart:lifecycle:v1";

export const CORE_TAX_PACKET_RESTART_LEASE_MS = 30_000;
export const CORE_TAX_PACKET_RESTART_HEARTBEAT_MS = 10_000;
export const CORE_TAX_PACKET_RESTART_RECLAIM_WAIT_MS = 120_000;

const IDENTITY: CoreTaxPacketProofIdentity = {
  userId: CORE_TAX_PACKET_RESTART_USER_ID,
  documentId: CORE_TAX_PACKET_RESTART_DOCUMENT_ID,
  jobId: CORE_TAX_PACKET_RESTART_JOB_ID,
  fileName: CORE_TAX_PACKET_RESTART_FILE_NAME,
  preservedAuditAction: CORE_TAX_PACKET_RESTART_TRIGGERED_ACTION,
};

export type CoreTaxPacketRestartProofFailure =
  | "runtime_identity_missing"
  | "release_mismatch"
  | "proof_in_progress"
  | "proof_cooldown"
  | "proof_missing"
  | "provider_not_ready"
  | "restart_not_observed"
  | "commit_changed"
  | "marker_expired"
  | "processing_failed"
  | "proof_timeout"
  | "invariant_failed"
  | "fixture_collision";

export class CoreTaxPacketRestartProofError extends Error {
  constructor(readonly code: CoreTaxPacketRestartProofFailure) {
    super(code);
    this.name = "CoreTaxPacketRestartProofError";
    Object.setPrototypeOf(this, CoreTaxPacketRestartProofError.prototype);
  }
}

interface RuntimeIdentity {
  deploymentId: string;
  commitSha: string;
}

interface SeedMetadata {
  version: 1;
  sourceDeploymentId: string;
  sourceCommitSha: string;
  seededAt: string;
}

interface ProviderReadyMetadata extends SeedMetadata {
  providerReadyAt: string;
  attemptCount: 1;
  classificationHash: string;
  formCount: 4;
  exactFactCount: 8;
}

interface CompletionMetadata {
  version: 1;
  completionDeploymentId: string;
  completionCommitSha: string;
  completedAt: string;
  attemptCount: number;
}

function rowsOf<T>(result: unknown): T[] {
  const candidate = result as { rows?: T[] } | T[];
  return Array.isArray(candidate) ? candidate : candidate.rows ?? [];
}

export interface CoreTaxPacketProviderRead {
  classification: TaxDocumentClassification;
  instances: ClassifiedFormInstance[];
  extractions: TaxFormInstanceExtraction[];
  classificationLineage: ExtractionLineage;
  simulated: boolean;
}

export interface CoreTaxPacketRestartSeedResult {
  status: "provider_read_complete";
  sourceCommitSha: string;
  seededAt: string;
  providerReadyAt: string;
  attemptCount: 1;
  reused: boolean;
}

export interface CoreTaxPacketRestartVerifyResult {
  status: "verified";
  sourceCommitSha: string;
  currentCommitSha: string;
  seededAt: string;
  providerReadyAt: string;
  completedAt: string;
  ageMs: number;
  attemptCount: number;
  pageCount: number;
  formCount: number;
  factRows: number;
  exactFactRows: number;
  groundedFactRows: number;
  cleanedUp: true;
}

function runtimeIdentity(): RuntimeIdentity {
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim();
  const commitSha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  if (!deploymentId || !commitSha || !/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw new CoreTaxPacketRestartProofError("runtime_identity_missing");
  }
  return { deploymentId, commitSha };
}

export function assertCoreTaxPacketRestartExpectedCommit(expectedCommitSha: string): void {
  const runtime = runtimeIdentity();
  if (!/^[0-9a-f]{40}$/i.test(expectedCommitSha) || expectedCommitSha.toLowerCase() !== runtime.commitSha.toLowerCase()) {
    throw new CoreTaxPacketRestartProofError("release_mismatch");
  }
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseSeed(value: unknown): SeedMetadata {
  const metadata = value as Partial<SeedMetadata>;
  if (
    metadata.version !== 1 ||
    typeof metadata.sourceDeploymentId !== "string" || metadata.sourceDeploymentId.length < 8 ||
    typeof metadata.sourceCommitSha !== "string" || !/^[0-9a-f]{40}$/i.test(metadata.sourceCommitSha) ||
    !validDate(metadata.seededAt)
  ) throw new CoreTaxPacketRestartProofError("invariant_failed");
  return metadata as SeedMetadata;
}

function parseReady(value: unknown): ProviderReadyMetadata {
  const metadata = value as Partial<ProviderReadyMetadata>;
  const seed = parseSeed(value);
  if (
    metadata.attemptCount !== 1 || !validDate(metadata.providerReadyAt) ||
    typeof metadata.classificationHash !== "string" || !/^[0-9a-f]{64}$/.test(metadata.classificationHash) ||
    metadata.formCount !== 4 || metadata.exactFactCount !== 8
  ) throw new CoreTaxPacketRestartProofError("invariant_failed");
  if (Date.parse(metadata.providerReadyAt) < Date.parse(seed.seededAt)) {
    throw new CoreTaxPacketRestartProofError("invariant_failed");
  }
  return { ...seed, ...metadata } as ProviderReadyMetadata;
}

function parseCompletion(value: unknown): CompletionMetadata {
  const metadata = value as Partial<CompletionMetadata>;
  if (
    metadata.version !== 1 ||
    typeof metadata.completionDeploymentId !== "string" || metadata.completionDeploymentId.length < 8 ||
    typeof metadata.completionCommitSha !== "string" || !/^[0-9a-f]{40}$/i.test(metadata.completionCommitSha) ||
    !validDate(metadata.completedAt) || !Number.isInteger(metadata.attemptCount) || (metadata.attemptCount ?? 0) < 1
  ) throw new CoreTaxPacketRestartProofError("invariant_failed");
  return metadata as CompletionMetadata;
}

async function getAuditMetadata(action: string): Promise<unknown | null> {
  const [row] = await db.select({ metadata: auditLogs.metadata }).from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.targetId, CORE_TAX_PACKET_RESTART_JOB_ID)))
    .limit(1);
  return row?.metadata ?? null;
}

function validateReplacementDeployment(input: {
  seed: SeedMetadata;
  ready: ProviderReadyMetadata;
  current: RuntimeIdentity;
}): void {
  if (
    input.ready.sourceDeploymentId !== input.seed.sourceDeploymentId ||
    input.ready.sourceCommitSha !== input.seed.sourceCommitSha ||
    input.ready.seededAt !== input.seed.seededAt
  ) throw new CoreTaxPacketRestartProofError("invariant_failed");
  if (input.seed.sourceDeploymentId === input.current.deploymentId) {
    throw new CoreTaxPacketRestartProofError("restart_not_observed");
  }
  if (input.seed.sourceCommitSha.toLowerCase() !== input.current.commitSha.toLowerCase()) {
    throw new CoreTaxPacketRestartProofError("commit_changed");
  }
}

async function loadReplacementDeploymentContext(): Promise<{
  current: RuntimeIdentity;
  seed: SeedMetadata;
  ready: ProviderReadyMetadata;
}> {
  const current = runtimeIdentity();
  const seed = parseSeed(await getAuditMetadata(SEEDED_ACTION));
  const ready = parseReady(await getAuditMetadata(PROVIDER_READY_ACTION));
  validateReplacementDeployment({ seed, ready, current });
  return { current, seed, ready };
}

/** Reject the seed deployment before it can start or destroy attempt two. */
export async function assertCoreTaxPacketRestartReplacementDeployment(): Promise<void> {
  await loadReplacementDeploymentContext();
}

async function withLifecycleLock<T>(run: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let discard = false;
  try {
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [LIFECYCLE_LOCK_KEY],
      );
      locked = result.rows[0]?.locked === true;
    } catch (error) {
      discard = true;
      throw error;
    }
    if (!locked) throw new CoreTaxPacketRestartProofError("proof_in_progress");
    return await run();
  } finally {
    if (locked) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
          [LIFECYCLE_LOCK_KEY],
        );
        discard = result.rows[0]?.unlocked !== true;
      } catch {
        discard = true;
      }
    }
    client.release(discard);
  }
}

function mapSharedError(error: unknown): never {
  if (error instanceof CoreTaxPacketRestartProofError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (message === "fixture_collision" || message === "proof_missing" || message === "invariant_failed") {
    throw new CoreTaxPacketRestartProofError(message);
  }
  throw error;
}

export function isCoreTaxPacketRestartJob(
  job: Pick<DocumentExtractionJob, "id" | "documentId" | "requestedByUserId" | "mode">,
): boolean {
  return isTaxPacketProofJob(job, IDENTITY);
}

export async function cleanupCoreTaxPacketRestartProof(
  objectStorage: CoreTaxPacketProofObjectStore = new ObjectStorageService(),
): Promise<void> {
  try {
    await withLifecycleLock(() => cleanupTaxPacketProofFixture(IDENTITY, objectStorage));
  } catch (error) {
    mapSharedError(error);
  }
}

async function assertRerunAllowed(commitSha: string, now: Date): Promise<void> {
  const [recent] = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(
    eq(auditLogs.action, CORE_TAX_PACKET_RESTART_TRIGGERED_ACTION),
    sql`${auditLogs.metadata}->>'sourceCommitSha' = ${commitSha}`,
    sql`${auditLogs.metadata}->>'seededAt' > ${new Date(now.getTime() - RERUN_COOLDOWN_MS).toISOString()}`,
  )).limit(1);
  if (recent) throw new CoreTaxPacketRestartProofError("proof_cooldown");
}

export async function prepareCoreTaxPacketRestartProof(
  now = new Date(),
  objectStorage: CoreTaxPacketProofObjectStore = new ObjectStorageService(),
): Promise<{ sourceCommitSha: string; seededAt: string; reused: boolean }> {
  return withLifecycleLock(async () => {
    const runtime = runtimeIdentity();
    const [existing] = await db.select().from(documentExtractionJobs)
      .where(eq(documentExtractionJobs.id, CORE_TAX_PACKET_RESTART_JOB_ID)).limit(1);
    if (existing && ["pending", "processing"].includes(existing.status)) {
      try { await assertTaxPacketFixtureOwnership(IDENTITY); } catch (error) { mapSharedError(error); }
      const seed = parseSeed(await getAuditMetadata(SEEDED_ACTION));
      if (seed.sourceDeploymentId !== runtime.deploymentId || seed.sourceCommitSha !== runtime.commitSha) {
        throw new CoreTaxPacketRestartProofError("proof_in_progress");
      }
      return { sourceCommitSha: seed.sourceCommitSha, seededAt: seed.seededAt, reused: true };
    }
    await assertRerunAllowed(runtime.commitSha, now);
    if (existing || (await taxPacketFixtureObjectPaths(IDENTITY)).length > 0) {
      try { await cleanupTaxPacketProofFixture(IDENTITY, objectStorage); } catch (error) { mapSharedError(error); }
    } else {
      try { await assertTaxPacketFixtureOwnership(IDENTITY); } catch (error) { mapSharedError(error); }
      const [orphan] = await db.select({ id: users.id }).from(users)
        .where(eq(users.id, CORE_TAX_PACKET_RESTART_USER_ID)).limit(1);
      if (orphan) {
        try { await cleanupTaxPacketProofFixture(IDENTITY, objectStorage); } catch (error) { mapSharedError(error); }
      }
    }

    let objectPath: string | null = null;
    let userCreated = false;
    try {
      const pdf = await buildSyntheticTaxPacketPdf();
      await db.insert(users).values({
        id: CORE_TAX_PACKET_RESTART_USER_ID,
        email: null,
        passwordHash: null,
        authProvider: CORE_PROOF_AUTH_PROVIDER,
        firstName: "Core",
        lastName: "Tax Restart Canary",
        role: "aspiring_owner",
      });
      userCreated = true;
      objectPath = await objectStorage.savePrivateDerivedObject(pdf, "application/pdf", CORE_TAX_PACKET_RESTART_USER_ID);
      const metadata: SeedMetadata = {
        version: 1,
        sourceDeploymentId: runtime.deploymentId,
        sourceCommitSha: runtime.commitSha,
        seededAt: now.toISOString(),
      };
      await db.transaction(async (transaction) => {
        await transaction.insert(documents).values({
          id: CORE_TAX_PACKET_RESTART_DOCUMENT_ID,
          userId: CORE_TAX_PACKET_RESTART_USER_ID,
          documentType: "tax_return",
          fileName: CORE_TAX_PACKET_RESTART_FILE_NAME,
          fileSize: pdf.length,
          mimeType: "application/pdf",
          storagePath: objectPath!,
          status: "uploaded",
        });
        await transaction.insert(borrowerConsents).values({
          userId: CORE_TAX_PACKET_RESTART_USER_ID,
          consentType: "tax_document_use",
          consentGiven: true,
          consentMethod: "operational_canary",
          contentHash: "synthetic-tax-packet-restart-v1",
        });
        await transaction.insert(documentExtractionJobs).values({
          id: CORE_TAX_PACKET_RESTART_JOB_ID,
          documentId: CORE_TAX_PACKET_RESTART_DOCUMENT_ID,
          requestedByUserId: CORE_TAX_PACKET_RESTART_USER_ID,
          mode: "tax_package",
          status: "pending",
          maxAttempts: 2,
          availableAt: now,
        });
        await transaction.insert(auditLogs).values({
          actorUserId: null,
          action: SEEDED_ACTION,
          targetType: "system",
          targetId: CORE_TAX_PACKET_RESTART_JOB_ID,
          metadata,
          createdAt: now,
        });
        await transaction.insert(auditLogs).values({
          actorUserId: null,
          action: CORE_TAX_PACKET_RESTART_TRIGGERED_ACTION,
          targetType: "system",
          targetId: CORE_TAX_PACKET_RESTART_JOB_ID,
          metadata,
          createdAt: now,
        });
      });
      return { sourceCommitSha: runtime.commitSha, seededAt: metadata.seededAt, reused: false };
    } catch (error) {
      if (objectPath) await objectStorage.deleteObjectEntity(objectPath).catch(() => undefined);
      if (userCreated) await db.delete(users).where(and(
        eq(users.id, CORE_TAX_PACKET_RESTART_USER_ID),
        eq(users.authProvider, CORE_PROOF_AUTH_PROVIDER),
      )).catch(() => undefined);
      throw error;
    }
  });
}

function numericField(extraction: TaxFormInstanceExtraction, name: string): number | null {
  const value = extraction.fields[name]?.value;
  return typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : null;
}

const EXPECTED_FACTS: Record<TaxFormType, Record<string, number>> = {
  tax_return_1040: { wagesSalariesTips: 84_000, adjustedGrossIncome: 103_500 },
  schedule_c: { grossReceipts: 48_000, netProfitOrLoss: 30_000 },
  schedule_e: { rentsReceivedTotal: 36_000, netRentalRealEstateIncomeOrLoss: 14_400 },
  business_tax_return_1120s: { grossReceipts: 210_000, ordinaryBusinessIncomeOrLoss: 42_000 },
  schedule_1: {}, schedule_b: {}, schedule_d: {}, schedule_k1: {}, business_tax_return_1065: {},
  business_tax_return_1120: {}, form_8825: {}, form_4562: {}, w2: {}, "1099_nec": {}, "1099_misc": {},
};

export function validateCoreTaxPacketProviderRead(read: CoreTaxPacketProviderRead): void {
  if (
    read.simulated || read.classification.pageCount !== 100 || read.instances.length !== 4 ||
    read.extractions.length !== read.instances.length ||
    !/^[0-9a-f]{64}$/.test(read.classificationLineage.rawResponseHash ?? "")
  ) throw new CoreTaxPacketRestartProofError("invariant_failed");
  let exact = 0;
  const formTypes = new Set<TaxFormType>();
  for (let index = 0; index < read.instances.length; index++) {
    const instance = read.instances[index];
    const extraction = read.extractions[index];
    formTypes.add(instance.formType);
    if (extraction.simulated || extraction.failureReason || !/^[0-9a-f]{64}$/.test(extraction.lineage.rawResponseHash ?? "")) {
      throw new CoreTaxPacketRestartProofError("invariant_failed");
    }
    for (const [field, expected] of Object.entries(EXPECTED_FACTS[instance.formType] ?? {})) {
      if (!Number.isFinite(expected)) continue;
      const value = numericField(extraction, field);
      const evidence = extraction.fields[field];
      if (value !== expected || !evidence?.pageNumber || !(evidence.confidence > 0)) {
        throw new CoreTaxPacketRestartProofError("invariant_failed");
      }
      exact += 1;
    }
  }
  if (exact !== 8 || formTypes.size !== 4) throw new CoreTaxPacketRestartProofError("invariant_failed");
}

export async function assertCoreTaxPacketRestartRuntimeIdentity(job: DocumentExtractionJob): Promise<void> {
  if (!isCoreTaxPacketRestartJob(job)) return;
  const runtime = runtimeIdentity();
  const seed = parseSeed(await getAuditMetadata(SEEDED_ACTION));
  if (seed.sourceCommitSha.toLowerCase() !== runtime.commitSha.toLowerCase()) {
    throw new CoreTaxPacketRestartProofError("commit_changed");
  }
  if (job.attemptCount === 1 && seed.sourceDeploymentId !== runtime.deploymentId) {
    throw new CoreTaxPacketRestartProofError("release_mismatch");
  }
  if (job.attemptCount > 1) {
    parseReady(await getAuditMetadata(PROVIDER_READY_ACTION));
    if (seed.sourceDeploymentId === runtime.deploymentId) {
      throw new CoreTaxPacketRestartProofError("restart_not_observed");
    }
  }
}

/** Close exactly the first abandoned run before the replacement repeats provider work. */
export async function prepareCoreTaxPacketRestartAttempt(job: DocumentExtractionJob, now = new Date()): Promise<void> {
  if (!isCoreTaxPacketRestartJob(job) || job.attemptCount < 2) return;
  await assertCoreTaxPacketRestartRuntimeIdentity(job);
  await withDocumentWorkflowLock(CORE_TAX_PACKET_RESTART_DOCUMENT_ID, async (_document, _current, transaction) => {
    const [active] = await transaction.select({ id: documentExtractionJobs.id }).from(documentExtractionJobs)
      .where(and(
        eq(documentExtractionJobs.id, job.id),
        eq(documentExtractionJobs.status, "processing"),
        eq(documentExtractionJobs.claimedBy, job.claimedBy!),
        sql`${documentExtractionJobs.leaseExpiresAt} > CURRENT_TIMESTAMP`,
      )).for("update").limit(1);
    if (!active) throw new CoreTaxPacketRestartProofError("invariant_failed");
    const running = await transaction.select({ id: taxExtractionRuns.id }).from(taxExtractionRuns)
      .where(and(eq(taxExtractionRuns.documentId, CORE_TAX_PACKET_RESTART_DOCUMENT_ID), eq(taxExtractionRuns.status, "running")))
      .for("update");
    const evidenceResult = await transaction.execute(sql`
      SELECT
        (SELECT count(*)::int FROM logical_documents WHERE source_document_id = ${CORE_TAX_PACKET_RESTART_DOCUMENT_ID}) AS logical_rows,
        (SELECT count(*)::int FROM document_confidence_scores WHERE document_id = ${CORE_TAX_PACKET_RESTART_DOCUMENT_ID}) AS confidence_rows
    `);
    const [evidence] = rowsOf<{ logical_rows: number; confidence_rows: number }>(evidenceResult);
    if (running.length !== 1 || Number(evidence?.logical_rows ?? -1) !== 0 || Number(evidence?.confidence_rows ?? -1) !== 0) {
      throw new CoreTaxPacketRestartProofError("invariant_failed");
    }
    await transaction.update(taxExtractionRuns).set({
      status: "failed",
      error: "Controlled process interruption after provider read",
      completedAt: now,
    }).where(eq(taxExtractionRuns.id, running[0].id));
  });
}

export async function recordCoreTaxPacketRestartProviderReady(
  job: DocumentExtractionJob,
  read: CoreTaxPacketProviderRead,
  now = new Date(),
): Promise<void> {
  if (!isCoreTaxPacketRestartJob(job) || job.attemptCount !== 1) return;
  validateCoreTaxPacketProviderRead(read);
  await assertCoreTaxPacketRestartRuntimeIdentity(job);
  const counts = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM tax_extraction_runs WHERE document_id = ${CORE_TAX_PACKET_RESTART_DOCUMENT_ID} AND status = 'running') AS running_rows,
      (SELECT count(*)::int FROM logical_documents WHERE source_document_id = ${CORE_TAX_PACKET_RESTART_DOCUMENT_ID}) AS logical_rows,
      (SELECT count(*)::int FROM document_confidence_scores WHERE document_id = ${CORE_TAX_PACKET_RESTART_DOCUMENT_ID}) AS confidence_rows
  `);
  const [row] = rowsOf<Record<string, unknown>>(counts);
  if (Number(row?.running_rows ?? -1) !== 1 || Number(row?.logical_rows ?? -1) !== 0 || Number(row?.confidence_rows ?? -1) !== 0) {
    throw new CoreTaxPacketRestartProofError("invariant_failed");
  }
  if (await getAuditMetadata(PROVIDER_READY_ACTION)) return;
  const seed = parseSeed(await getAuditMetadata(SEEDED_ACTION));
  await db.insert(auditLogs).values({
    actorUserId: null,
    action: PROVIDER_READY_ACTION,
    targetType: "system",
    targetId: CORE_TAX_PACKET_RESTART_JOB_ID,
    metadata: {
      ...seed,
      providerReadyAt: now.toISOString(),
      attemptCount: 1,
      classificationHash: read.classificationLineage.rawResponseHash!,
      formCount: 4,
      exactFactCount: 8,
    } satisfies ProviderReadyMetadata,
    createdAt: now,
  });
}

export async function holdCoreTaxPacketRestartFirstResult(job: DocumentExtractionJob): Promise<void> {
  if (!isCoreTaxPacketRestartJob(job) || job.attemptCount !== 1) return;
  await new Promise<void>((resolve) => setTimeout(resolve, FIRST_CLAIM_HOLD_MS));
}

export function coreTaxPacketRestartCompletionAudit(
  job: DocumentExtractionJob,
  now = new Date(),
): typeof auditLogs.$inferInsert | null {
  if (!isCoreTaxPacketRestartJob(job)) return null;
  const runtime = runtimeIdentity();
  return {
    actorUserId: null,
    action: CORE_TAX_PACKET_RESTART_COMPLETED_ACTION,
    targetType: "system",
    targetId: CORE_TAX_PACKET_RESTART_JOB_ID,
    metadata: {
      version: 1,
      completionDeploymentId: runtime.deploymentId,
      completionCommitSha: runtime.commitSha,
      completedAt: now.toISOString(),
      attemptCount: job.attemptCount,
    } satisfies CompletionMetadata,
    createdAt: now,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForCoreTaxPacketRestartProviderReady(
  reused: boolean,
  deadlineMs = Date.now() + PROVIDER_READY_WAIT_MS,
): Promise<CoreTaxPacketRestartSeedResult> {
  const seed = parseSeed(await getAuditMetadata(SEEDED_ACTION));
  for (;;) {
    const readyValue = await getAuditMetadata(PROVIDER_READY_ACTION);
    if (readyValue) {
      const ready = parseReady(readyValue);
      return {
        status: "provider_read_complete",
        sourceCommitSha: ready.sourceCommitSha,
        seededAt: ready.seededAt,
        providerReadyAt: ready.providerReadyAt,
        attemptCount: 1,
        reused,
      };
    }
    const [job] = await db.select({ status: documentExtractionJobs.status }).from(documentExtractionJobs)
      .where(eq(documentExtractionJobs.id, CORE_TAX_PACKET_RESTART_JOB_ID)).limit(1);
    if (!job) throw new CoreTaxPacketRestartProofError("proof_missing");
    if (["failed", "cancelled", "completed"].includes(job.status)) {
      throw new CoreTaxPacketRestartProofError("processing_failed");
    }
    if (Date.now() >= deadlineMs) throw new CoreTaxPacketRestartProofError("provider_not_ready");
    await delay(POLL_MS);
  }
}

export function validateCoreTaxPacketRestartTransition(input: {
  seed: SeedMetadata;
  ready: ProviderReadyMetadata;
  completion: CompletionMetadata;
  current: RuntimeIdentity;
  now: Date;
}): void {
  const ageMs = input.now.getTime() - Date.parse(input.seed.seededAt);
  if (ageMs < -5_000 || ageMs > PROOF_MAX_AGE_MS) throw new CoreTaxPacketRestartProofError("marker_expired");
  validateReplacementDeployment(input);
  if (
    input.completion.completionCommitSha.toLowerCase() !== input.current.commitSha.toLowerCase()
  ) {
    throw new CoreTaxPacketRestartProofError("commit_changed");
  }
  if (input.completion.completionDeploymentId !== input.current.deploymentId || input.completion.attemptCount !== 2) {
    throw new CoreTaxPacketRestartProofError("invariant_failed");
  }
  if (Date.parse(input.completion.completedAt) < Date.parse(input.ready.providerReadyAt)) {
    throw new CoreTaxPacketRestartProofError("invariant_failed");
  }
}

export async function verifyCoreTaxPacketRestartProof(
  deadlineMs = Date.now() + COMPLETION_WAIT_MS,
  objectStorage: CoreTaxPacketProofObjectStore = new ObjectStorageService(),
): Promise<CoreTaxPacketRestartVerifyResult> {
  // These checks deliberately sit outside cleanup. A premature call from the
  // seed deployment or a mismatched build must not destroy an active proof.
  const { current, seed, ready } = await loadReplacementDeploymentContext();
  try {
    let completion: CompletionMetadata | null = null;
    for (;;) {
      const value = await getAuditMetadata(CORE_TAX_PACKET_RESTART_COMPLETED_ACTION);
      if (value) { completion = parseCompletion(value); break; }
      const [job] = await db.select({ status: documentExtractionJobs.status }).from(documentExtractionJobs)
        .where(eq(documentExtractionJobs.id, CORE_TAX_PACKET_RESTART_JOB_ID)).limit(1);
      if (!job) throw new CoreTaxPacketRestartProofError("proof_missing");
      if (["failed", "cancelled"].includes(job.status)) throw new CoreTaxPacketRestartProofError("processing_failed");
      if (Date.now() >= deadlineMs) throw new CoreTaxPacketRestartProofError("proof_timeout");
      await delay(POLL_MS);
    }
    // Freshness is measured after polling, at the moment evidence is accepted.
    const verifiedAt = new Date();
    validateCoreTaxPacketRestartTransition({ seed, ready, completion, current, now: verifiedAt });
    const snapshot = await getTaxPacketEvidenceSnapshot(IDENTITY);
    try {
      validateTaxPacketEvidenceSnapshot(snapshot, { minimumAttempts: 2, runRows: 2, failedRunRows: 1 });
    } catch (error) { mapSharedError(error); }
    const result: CoreTaxPacketRestartVerifyResult = {
      status: "verified",
      sourceCommitSha: seed.sourceCommitSha,
      currentCommitSha: current.commitSha,
      seededAt: seed.seededAt,
      providerReadyAt: ready.providerReadyAt,
      completedAt: completion.completedAt,
      ageMs: verifiedAt.getTime() - Date.parse(seed.seededAt),
      attemptCount: snapshot.attemptCount,
      pageCount: snapshot.pageCount,
      formCount: snapshot.formCount,
      factRows: snapshot.factRows,
      exactFactRows: snapshot.exactFactRows,
      groundedFactRows: snapshot.groundedFactRows,
      cleanedUp: true,
    };
    await cleanupCoreTaxPacketRestartProof(objectStorage);
    return result;
  } catch (error) {
    await cleanupCoreTaxPacketRestartProof(objectStorage).catch(() => undefined);
    throw error;
  }
}
