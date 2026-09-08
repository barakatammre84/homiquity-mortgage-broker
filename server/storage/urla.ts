// Storage domain: URLA sections, GSE delivery data, wholesale lender submissions, complete-URLA/MISMO export aggregation, data-quality scoring.
// One link in the DatabaseStorage inheritance chain — see ./index.ts.
import { db } from "../db";
import { eq, desc, and, asc, inArray, notInArray } from "drizzle-orm";
// SSN uses ssnVault (canonical, from main); account numbers use piiVault (this
// branch — main leaves account numbers plaintext).
import { encryptPiiField, decryptPiiField } from "../services/piiVault";
import { resolveSsnInput, clearedSsnColumns, maskedSsnFromRow, decryptSsnFromRow } from "../services/ssnVault";

import {
  urlaPersonalInfo,
  employmentHistory,
  otherIncomeSources,
  urlaAssets,
  urlaLiabilities,
  urlaPropertyInfo,
  borrowerDeclarations,
  type UrlaPersonalInfo,
  type InsertUrlaPersonalInfo,
  type EmploymentHistory,
  type InsertEmploymentHistory,
  type OtherIncomeSource,
  type InsertOtherIncomeSource,
  type UrlaAsset,
  type InsertUrlaAsset,
  type UrlaLiability,
  type InsertUrlaLiability,
  type UrlaPropertyInfo,
  type InsertUrlaPropertyInfo,
  type BorrowerDeclarations,
  type InsertBorrowerDeclarations,
  loanDeliveryData,
  type LoanDeliveryData,
  type InsertLoanDeliveryData,
  lenderSubmissions,
  loanApplications,
  type LenderSubmission,
  type InsertLenderSubmission,
  realEstateOwned,
  type RealEstateOwned,
  type InsertRealEstateOwned,
  type IncomeSourceEntry,
  borrowerProfiles,
  type BorrowerProfile,
  hmdaDemographics,
  type HmdaDemographics,
  type InsertHmdaDemographics,
  bankStatementAnalyses,
  type BankStatementAnalysis,
} from "@shared/schema";
import { TasksStorage } from "./tasks";
import { indexRowsByKey } from "./batchGroup";
import { assembleCompleteUrlaDataBatch, type CompleteUrlaData } from "./urlaBatch";
/** Thrown by upsertUrlaPersonalInfo when the supplied SSN is not 9 digits — routes translate it to a 400. */
export class InvalidSsnError extends Error {
  constructor() {
    super("SSN must be 9 digits");
    this.name = "InvalidSsnError";
  }
}

export type { CompleteUrlaData } from "./urlaBatch";

export class UrlaStorage extends TasksStorage {
  // URLA Personal Info
  /**
   * Present a urla_personal_info row outside the storage layer: the SSN comes
   * back masked (XXX-XX-1234) and the ciphertext columns are withheld. Full
   * SSNs are available only via getDecryptedUrlaSsn (audited callers).
   */
  private presentUrlaPersonalInfo(row: UrlaPersonalInfo): UrlaPersonalInfo {
    return {
      ...row,
      ssn: maskedSsnFromRow(row),
      ssnEncrypted: null,
      ssnIv: null,
      ssnKeyId: null,
    };
  }

  private async getUrlaPersonalInfoRaw(applicationId: string, borrowerSequenceNumber: number = 1): Promise<UrlaPersonalInfo | undefined> {
    const [info] = await db
      .select()
      .from(urlaPersonalInfo)
      .where(and(
        eq(urlaPersonalInfo.applicationId, applicationId),
        eq(urlaPersonalInfo.borrowerSequenceNumber, borrowerSequenceNumber),
      ))
      .limit(1);
    return info;
  }

  async getUrlaPersonalInfo(applicationId: string, borrowerSequenceNumber: number = 1): Promise<UrlaPersonalInfo | undefined> {
    const info = await this.getUrlaPersonalInfoRaw(applicationId, borrowerSequenceNumber);
    return info ? this.presentUrlaPersonalInfo(info) : undefined;
  }

  async getAllUrlaPersonalInfo(applicationId: string): Promise<UrlaPersonalInfo[]> {
    const rows = await db
      .select()
      .from(urlaPersonalInfo)
      .where(eq(urlaPersonalInfo.applicationId, applicationId))
      .orderBy(asc(urlaPersonalInfo.borrowerSequenceNumber));
    return rows.map((row) => this.presentUrlaPersonalInfo(row));
  }

  /**
   * Full, decrypted SSN for a borrower on an application. Callers are
   * responsible for authorization and for writing an audit entry — this is
   * intentionally the ONLY path that returns more than the last 4.
   */
  async getDecryptedUrlaSsn(applicationId: string, borrowerSequenceNumber: number = 1): Promise<string | null> {
    const row = await this.getUrlaPersonalInfoRaw(applicationId, borrowerSequenceNumber);
    if (!row) return null;
    return decryptSsnFromRow(row);
  }

  async upsertUrlaPersonalInfo(
    data: InsertUrlaPersonalInfo & { ssn?: string | null },
  ): Promise<UrlaPersonalInfo> {
    const seq = (data as any).borrowerSequenceNumber ?? 1;
    const existing = await this.getUrlaPersonalInfoRaw(data.applicationId, seq);
    // Remove timestamp fields that might have been serialized as strings from
    // the frontend, plus the server-managed SSN columns — clients must never
    // write ciphertext fields directly.
    const {
      createdAt, updatedAt, id,
      ssn: ssnInput, ssnEncrypted: _e, ssnIv: _i, ssnKeyId: _k, ssnLast4: _l,
      ...cleanData
    } = data as any;

    // Encrypt SSN server-side via ssnVault. A masked echo from the UI
    // (XXX-XX-1234) means "unchanged"; an invalid value is rejected before
    // anything is written.
    const ssnResolution = resolveSsnInput(ssnInput);
    if (ssnResolution.action === "invalid") {
      throw new InvalidSsnError();
    }
    const ssnColumns =
      ssnResolution.action === "set" ? ssnResolution.columns :
      ssnResolution.action === "clear" ? clearedSsnColumns() :
      {};

    if (existing) {
      const [updated] = await db
        .update(urlaPersonalInfo)
        .set({ ...cleanData, ...ssnColumns, borrowerSequenceNumber: seq, updatedAt: new Date() })
        .where(and(
          eq(urlaPersonalInfo.applicationId, data.applicationId),
          eq(urlaPersonalInfo.borrowerSequenceNumber, seq),
        ))
        .returning();
      return this.presentUrlaPersonalInfo(updated);
    }
    const [created] = await db
      .insert(urlaPersonalInfo)
      .values({ ...cleanData, ...ssnColumns, borrowerSequenceNumber: seq })
      .returning();
    return this.presentUrlaPersonalInfo(created);
  }

  // Employment History
  async getLatestBankStatementAnalysis(applicationId: string): Promise<BankStatementAnalysis | undefined> {
    const [row] = await db
      .select()
      .from(bankStatementAnalyses)
      .where(eq(bankStatementAnalyses.applicationId, applicationId))
      .orderBy(desc(bankStatementAnalyses.createdAt))
      .limit(1);
    return row;
  }

  async getEmploymentHistory(applicationId: string): Promise<EmploymentHistory[]> {
    return await db
      .select()
      .from(employmentHistory)
      .where(eq(employmentHistory.applicationId, applicationId))
      .orderBy(desc(employmentHistory.createdAt));
  }

  async getEmploymentHistoryById(id: string): Promise<EmploymentHistory | undefined> {
    const [record] = await db
      .select()
      .from(employmentHistory)
      .where(eq(employmentHistory.id, id))
      .limit(1);
    return record;
  }

  async createEmploymentHistory(data: InsertEmploymentHistory): Promise<EmploymentHistory> {
    const [record] = await db.insert(employmentHistory).values(data).returning();
    return record;
  }

  async updateEmploymentHistory(id: string, data: Partial<EmploymentHistory>): Promise<EmploymentHistory | undefined> {
    // Remove id, timestamps, and applicationId (immutable — re-parenting is not allowed)
    const { createdAt, updatedAt, id: recordId, applicationId, ...cleanData } = data as any;
    const [updated] = await db
      .update(employmentHistory)
      .set({ ...cleanData, updatedAt: new Date() })
      .where(eq(employmentHistory.id, id))
      .returning();
    return updated;
  }

  async deleteEmploymentHistory(id: string): Promise<void> {
    await db.delete(employmentHistory).where(eq(employmentHistory.id, id));
  }

  // Other Income Sources
  async getOtherIncomeSources(applicationId: string): Promise<OtherIncomeSource[]> {
    return await db
      .select()
      .from(otherIncomeSources)
      .where(eq(otherIncomeSources.applicationId, applicationId))
      .orderBy(desc(otherIncomeSources.createdAt));
  }

  async getOtherIncomeSourceById(id: string): Promise<OtherIncomeSource | undefined> {
    const [record] = await db
      .select()
      .from(otherIncomeSources)
      .where(eq(otherIncomeSources.id, id))
      .limit(1);
    return record;
  }

  async createOtherIncomeSource(data: InsertOtherIncomeSource): Promise<OtherIncomeSource> {
    const [record] = await db.insert(otherIncomeSources).values(data).returning();
    return record;
  }

  async updateOtherIncomeSource(id: string, data: Partial<OtherIncomeSource>): Promise<OtherIncomeSource | undefined> {
    // Remove id, timestamps, and applicationId (immutable — re-parenting is not allowed)
    const { createdAt, id: recordId, applicationId, ...cleanData } = data as any;
    const [updated] = await db
      .update(otherIncomeSources)
      .set(cleanData)
      .where(eq(otherIncomeSources.id, id))
      .returning();
    return updated;
  }

  async deleteOtherIncomeSource(id: string): Promise<void> {
    await db.delete(otherIncomeSources).where(eq(otherIncomeSources.id, id));
  }

  // URLA Assets
  async getUrlaAssets(applicationId: string): Promise<UrlaAsset[]> {
    return await db
      .select()
      .from(urlaAssets)
      .where(eq(urlaAssets.applicationId, applicationId))
      .orderBy(desc(urlaAssets.createdAt));
  }

  async getUrlaAssetById(id: string): Promise<UrlaAsset | undefined> {
    const [record] = await db
      .select()
      .from(urlaAssets)
      .where(eq(urlaAssets.id, id))
      .limit(1);
    return record;
  }

  // `accountNumber` is a write-only virtual field on assets/liabilities:
  // the storage layer encrypts it (piiVault) and persists only ciphertext + last4.
  private static encryptAccountNumberField(cleanData: any, accountNumber: unknown): void {
    if (typeof accountNumber === "string" && accountNumber.trim() !== "") {
      const enc = encryptPiiField(accountNumber.trim());
      cleanData.accountNumberEncrypted = enc.encrypted;
      cleanData.accountNumberIv = enc.iv;
      cleanData.accountNumberKeyId = enc.keyId;
      cleanData.accountNumberLast4 = enc.last4;
    }
  }

  async createUrlaAsset(data: InsertUrlaAsset & { accountNumber?: string | null }): Promise<UrlaAsset> {
    const { accountNumber, ...cleanData } = data as any;
    UrlaStorage.encryptAccountNumberField(cleanData, accountNumber);
    const [record] = await db.insert(urlaAssets).values(cleanData).returning();
    return record;
  }

  async updateUrlaAsset(id: string, data: Partial<UrlaAsset> & { accountNumber?: string | null }): Promise<UrlaAsset | undefined> {
    // Remove id, timestamps, and applicationId (immutable — re-parenting is not allowed)
    const { createdAt, updatedAt, id: recordId, applicationId, accountNumber, ...cleanData } = data as any;
    UrlaStorage.encryptAccountNumberField(cleanData, accountNumber);
    const [updated] = await db
      .update(urlaAssets)
      .set(cleanData)
      .where(eq(urlaAssets.id, id))
      .returning();
    return updated;
  }

  async deleteUrlaAsset(id: string): Promise<void> {
    await db.delete(urlaAssets).where(eq(urlaAssets.id, id));
  }

  /**
   * Remove one co-applicant's URLA records from an application.
   *
   * Keyed on the EXACT borrowerSequenceNumber, never `> 1`: sequences can be
   * sparse or out of order (an application may carry only a co-borrower #3), so
   * a range delete would take people the caller did not ask to remove. Sequence
   * is also the only valid discriminator on hmda_demographics, whose borrowerId
   * is the application's userId for EVERY borrower and cannot tell them apart.
   *
   * Refuses seq <= 1 outright — the primary borrower is not removable, and a
   * bug that passed 1 here would wipe the applicant's own file.
   *
   * Returns per-table counts so the caller can audit what actually went.
   */
  async deleteCoApplicantRecords(
    applicationId: string,
    seq: number,
  ): Promise<Record<string, number>> {
    if (!Number.isInteger(seq) || seq <= 1) {
      throw new Error(`Refusing to delete borrower sequence ${seq}: only co-applicants (seq > 1) may be removed`);
    }

    const tables = [
      ["personalInfo", urlaPersonalInfo],
      ["employmentHistory", employmentHistory],
      ["assets", urlaAssets],
      ["liabilities", urlaLiabilities],
      ["declarations", borrowerDeclarations],
      ["demographics", hmdaDemographics],
    ] as const;

    const removed: Record<string, number> = {};
    for (const [label, table] of tables) {
      const rows = await db
        .delete(table as any)
        .where(and(
          eq((table as any).applicationId, applicationId),
          eq((table as any).borrowerSequenceNumber, seq),
        ))
        .returning({ id: (table as any).id });
      removed[label] = rows.length;
    }
    return removed;
  }

  // URLA Liabilities
  async getUrlaLiabilities(applicationId: string): Promise<UrlaLiability[]> {
    return await db
      .select()
      .from(urlaLiabilities)
      .where(eq(urlaLiabilities.applicationId, applicationId))
      .orderBy(desc(urlaLiabilities.createdAt));
  }

  async getUrlaLiabilityById(id: string): Promise<UrlaLiability | undefined> {
    const [record] = await db
      .select()
      .from(urlaLiabilities)
      .where(eq(urlaLiabilities.id, id))
      .limit(1);
    return record;
  }

  async createUrlaLiability(data: InsertUrlaLiability & { accountNumber?: string | null }): Promise<UrlaLiability> {
    const { accountNumber, ...cleanData } = data as any;
    UrlaStorage.encryptAccountNumberField(cleanData, accountNumber);
    const [record] = await db.insert(urlaLiabilities).values(cleanData).returning();
    return record;
  }

  async updateUrlaLiability(id: string, data: Partial<UrlaLiability> & { accountNumber?: string | null }): Promise<UrlaLiability | undefined> {
    // Remove id, timestamps, and applicationId (immutable — re-parenting is not allowed)
    const { createdAt, updatedAt, id: recordId, applicationId, accountNumber, ...cleanData } = data as any;
    UrlaStorage.encryptAccountNumberField(cleanData, accountNumber);
    const [updated] = await db
      .update(urlaLiabilities)
      .set(cleanData)
      .where(eq(urlaLiabilities.id, id))
      .returning();
    return updated;
  }

  async deleteUrlaLiability(id: string): Promise<void> {
    await db.delete(urlaLiabilities).where(eq(urlaLiabilities.id, id));
  }

  // URLA Property Info
  async getUrlaPropertyInfo(applicationId: string): Promise<UrlaPropertyInfo | undefined> {
    const [info] = await db
      .select()
      .from(urlaPropertyInfo)
      .where(eq(urlaPropertyInfo.applicationId, applicationId))
      .limit(1);
    return info;
  }

  async upsertUrlaPropertyInfo(data: InsertUrlaPropertyInfo): Promise<UrlaPropertyInfo> {
    const existing = await this.getUrlaPropertyInfo(data.applicationId);
    // Remove any timestamp fields that might have been serialized as strings from frontend
    const { createdAt, updatedAt, id, ...cleanData } = data as any;
    
    if (existing) {
      const [updated] = await db
        .update(urlaPropertyInfo)
        .set({ ...cleanData, updatedAt: new Date() })
        .where(eq(urlaPropertyInfo.applicationId, data.applicationId))
        .returning();
      return updated;
    }
    const [created] = await db.insert(urlaPropertyInfo).values(cleanData).returning();
    return created;
  }

  // GSE loan delivery data (ULDD / UCD closing-stage datapoints)
  async getLoanDeliveryData(applicationId: string): Promise<LoanDeliveryData | undefined> {
    const [row] = await db
      .select()
      .from(loanDeliveryData)
      .where(eq(loanDeliveryData.applicationId, applicationId))
      .limit(1);
    return row;
  }

  async upsertLoanDeliveryData(data: InsertLoanDeliveryData): Promise<LoanDeliveryData> {
    const existing = await this.getLoanDeliveryData(data.applicationId);
    const { createdAt, updatedAt, id, ...cleanData } = data as any;

    if (existing) {
      const [updated] = await db
        .update(loanDeliveryData)
        .set({ ...cleanData, updatedAt: new Date() })
        .where(eq(loanDeliveryData.applicationId, data.applicationId))
        .returning();
      return updated;
    }
    const [created] = await db.insert(loanDeliveryData).values(cleanData).returning();
    return created;
  }

  // Wholesale lender submissions
  async createLenderSubmission(data: InsertLenderSubmission): Promise<LenderSubmission> {
    const [created] = await db.insert(lenderSubmissions).values(data).returning();
    return created;
  }

  async getLenderSubmission(id: string): Promise<LenderSubmission | undefined> {
    const [row] = await db
      .select()
      .from(lenderSubmissions)
      .where(eq(lenderSubmissions.id, id))
      .limit(1);
    return row;
  }

  async getLenderSubmissionsByApplication(applicationId: string): Promise<LenderSubmission[]> {
    return await db
      .select()
      .from(lenderSubmissions)
      .where(eq(lenderSubmissions.applicationId, applicationId))
      .orderBy(desc(lenderSubmissions.submittedAt));
  }

  /**
   * Funded submissions belonging to one borrower. Feeds the EPO clawback
   * guard in the lifecycle sweep: we must not solicit a refinance on a loan
   * whose compensation the lender can still reclaim.
   */
  async getFundedLenderSubmissionsByUser(userId: string): Promise<LenderSubmission[]> {
    return await db
      .select({ submission: lenderSubmissions })
      .from(lenderSubmissions)
      .innerJoin(loanApplications, eq(lenderSubmissions.applicationId, loanApplications.id))
      .where(and(eq(loanApplications.userId, userId), eq(lenderSubmissions.status, "funded")))
      .orderBy(desc(lenderSubmissions.fundedAt))
      .then(rows => rows.map(r => r.submission));
  }

  /** Company-wide, for the broker revenue report. Admin-gated at the route. */
  async getAllLenderSubmissions(): Promise<LenderSubmission[]> {
    return await db
      .select()
      .from(lenderSubmissions)
      .orderBy(desc(lenderSubmissions.submittedAt));
  }

  async updateLenderSubmission(id: string, data: Partial<InsertLenderSubmission>): Promise<LenderSubmission | undefined> {
    const { createdAt, updatedAt, id: _id, ...cleanData } = data as any;
    const [updated] = await db
      .update(lenderSubmissions)
      .set({ ...cleanData, statusUpdatedAt: new Date(), updatedAt: new Date() })
      .where(eq(lenderSubmissions.id, id))
      .returning();
    return updated;
  }

  // Borrower Declarations
  async getBorrowerDeclarations(applicationId: string, borrowerSequenceNumber: number = 1): Promise<BorrowerDeclarations | undefined> {
    const [declarations] = await db
      .select()
      .from(borrowerDeclarations)
      .where(and(
        eq(borrowerDeclarations.applicationId, applicationId),
        eq(borrowerDeclarations.borrowerSequenceNumber, borrowerSequenceNumber),
      ))
      .limit(1);
    return declarations;
  }

  async getAllBorrowerDeclarations(applicationId: string): Promise<BorrowerDeclarations[]> {
    return await db
      .select()
      .from(borrowerDeclarations)
      .where(eq(borrowerDeclarations.applicationId, applicationId))
      .orderBy(asc(borrowerDeclarations.borrowerSequenceNumber));
  }

  async upsertBorrowerDeclarations(data: InsertBorrowerDeclarations): Promise<BorrowerDeclarations> {
    const seq = (data as any).borrowerSequenceNumber ?? 1;
    const existing = await this.getBorrowerDeclarations(data.applicationId, seq);
    const { createdAt, updatedAt, id, ...cleanData } = data as any;
    
    if (existing) {
      const [updated] = await db
        .update(borrowerDeclarations)
        .set({ ...cleanData, borrowerSequenceNumber: seq, updatedAt: new Date() })
        .where(and(
          eq(borrowerDeclarations.applicationId, data.applicationId),
          eq(borrowerDeclarations.borrowerSequenceNumber, seq),
        ))
        .returning();
      return updated;
    }
    const [created] = await db.insert(borrowerDeclarations).values({ ...cleanData, borrowerSequenceNumber: seq }).returning();
    return created;
  }

  // Get Complete URLA Data
  async getCompleteUrlaData(applicationId: string): Promise<CompleteUrlaData> {
    const [personalInfo, allPersonalInfo, employment, income, assets, liabilities, propertyInfo, declarations, allDeclarations, reo, hmda] = await Promise.all([
      this.getUrlaPersonalInfo(applicationId),
      this.getAllUrlaPersonalInfo(applicationId),
      this.getEmploymentHistory(applicationId),
      this.getOtherIncomeSources(applicationId),
      this.getUrlaAssets(applicationId),
      this.getUrlaLiabilities(applicationId),
      this.getUrlaPropertyInfo(applicationId),
      this.getBorrowerDeclarations(applicationId),
      this.getAllBorrowerDeclarations(applicationId),
      this.getRealEstateOwnedByApplication(applicationId),
      this.getHmdaDemographicsByApplication(applicationId),
    ]);

    return {
      personalInfo,
      allPersonalInfo,
      employmentHistory: employment,
      otherIncomeSources: income,
      assets,
      liabilities,
      propertyInfo,
      declarations,
      allDeclarations,
      realEstateOwned: reo,
      hmdaDemographics: hmda,
    };
  }

  /**
   * getCompleteUrlaData for N applications in a fixed 9 queries instead of 11N.
   *
   * The per-application split is ./urlaBatch.ts (pure, unit-tested); this method
   * is only the SQL half. Each query keeps the single-application loader's
   * `orderBy` so every bucket comes out in the same order.
   */
  async getCompleteUrlaDataBatch(applicationIds: string[]): Promise<Map<string, CompleteUrlaData>> {
    if (applicationIds.length === 0) return new Map();

    const [
      personalRows,
      employmentRows,
      incomeRows,
      assetRows,
      liabilityRows,
      propertyRows,
      declarationRows,
      reoRows,
      hmdaRows,
    ] = await Promise.all([
      db.select().from(urlaPersonalInfo)
        .where(inArray(urlaPersonalInfo.applicationId, applicationIds))
        .orderBy(asc(urlaPersonalInfo.borrowerSequenceNumber)),
      db.select().from(employmentHistory)
        .where(inArray(employmentHistory.applicationId, applicationIds))
        .orderBy(desc(employmentHistory.createdAt)),
      db.select().from(otherIncomeSources)
        .where(inArray(otherIncomeSources.applicationId, applicationIds))
        .orderBy(desc(otherIncomeSources.createdAt)),
      db.select().from(urlaAssets)
        .where(inArray(urlaAssets.applicationId, applicationIds))
        .orderBy(desc(urlaAssets.createdAt)),
      db.select().from(urlaLiabilities)
        .where(inArray(urlaLiabilities.applicationId, applicationIds))
        .orderBy(desc(urlaLiabilities.createdAt)),
      db.select().from(urlaPropertyInfo)
        .where(inArray(urlaPropertyInfo.applicationId, applicationIds)),
      db.select().from(borrowerDeclarations)
        .where(inArray(borrowerDeclarations.applicationId, applicationIds))
        .orderBy(asc(borrowerDeclarations.borrowerSequenceNumber)),
      db.select().from(realEstateOwned)
        .where(inArray(realEstateOwned.applicationId, applicationIds))
        .orderBy(desc(realEstateOwned.createdAt)),
      db.select().from(hmdaDemographics)
        .where(inArray(hmdaDemographics.applicationId, applicationIds)),
    ]);

    return assembleCompleteUrlaDataBatch(applicationIds, {
      // Masking is applied here for the same reason getAllUrlaPersonalInfo
      // applies it: nothing outside this layer may see SSN ciphertext or full
      // digits, and the assembler is explicitly given already-masked rows.
      personal: personalRows.map((row) => this.presentUrlaPersonalInfo(row)),
      employment: employmentRows,
      income: incomeRows,
      assets: assetRows,
      liabilities: liabilityRows,
      property: propertyRows,
      declarations: declarationRows,
      realEstateOwned: reoRows,
      hmda: hmdaRows,
    });
  }

  async getRealEstateOwnedByApplication(applicationId: string): Promise<RealEstateOwned[]> {
    return await db
      .select()
      .from(realEstateOwned)
      .where(eq(realEstateOwned.applicationId, applicationId))
      .orderBy(desc(realEstateOwned.createdAt));
  }

  /**
   * Replace the application-scoped URLA 2c rows in one transaction. The route
   * passes the application's borrower id (never the editing staffer's id), and
   * existing ids must already belong to the same file. Returning undefined is
   * the ownership failure signal used by the route.
   */
  async replaceRealEstateOwnedForApplication(
    applicationId: string,
    borrowerUserId: string,
    rows: Array<Partial<RealEstateOwned> & Pick<RealEstateOwned, "propertyAddress">>,
    ownsOtherRealEstate: boolean,
  ): Promise<RealEstateOwned[] | undefined> {
    return db.transaction(async (tx) => {
      const existing = await tx.select().from(realEstateOwned)
        .where(eq(realEstateOwned.applicationId, applicationId));
      const existingIds = new Set(existing.map((row) => row.id));
      if (rows.some((row) => row.id && !existingIds.has(row.id))) return undefined;

      const saved: RealEstateOwned[] = [];
      for (const row of rows) {
        const {
          id,
          userId: _userId,
          applicationId: _applicationId,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          verificationSource: _verificationSource,
          verifiedAt: _verifiedAt,
          netEquity: _netEquity,
          netRentalIncome: _netRentalIncome,
          ...editable
        } = row;
        const values: InsertRealEstateOwned = {
          ...editable,
          userId: borrowerUserId,
          applicationId,
          verificationSource: "borrower_stated",
          verifiedAt: null,
        };
        if (id) {
          const [updated] = await tx.update(realEstateOwned)
            .set({ ...values, updatedAt: new Date() })
            .where(and(eq(realEstateOwned.id, id), eq(realEstateOwned.applicationId, applicationId)))
            .returning();
          if (updated) saved.push(updated);
        } else {
          const [created] = await tx.insert(realEstateOwned).values(values).returning();
          saved.push(created);
        }
      }

      const keepIds = saved.map((row) => row.id);
      if (keepIds.length > 0) {
        await tx.delete(realEstateOwned).where(and(
          eq(realEstateOwned.applicationId, applicationId),
          notInArray(realEstateOwned.id, keepIds),
        ));
      } else {
        await tx.delete(realEstateOwned).where(eq(realEstateOwned.applicationId, applicationId));
      }
      await tx.update(loanApplications)
        .set({ ownsOtherRealEstate, updatedAt: new Date() })
        .where(eq(loanApplications.id, applicationId));
      return saved;
    });
  }

  /**
   * Carry rental-property details from the three-minute intake into URLA 2c.
   * This is idempotent and only owns rows it previously created. If a borrower
   * or loan officer already enriched a matching row, that record wins and is
   * never overwritten by another intake submission.
   */
  async syncIntakeRentalProperties(
    applicationId: string,
    borrowerUserId: string,
    incomeSources: IncomeSourceEntry[] | null | undefined,
  ): Promise<RealEstateOwned[]> {
    const rentals = (incomeSources ?? [])
      .filter((source) => source.type === "rental")
      .flatMap((source) => source.rentalProperties ?? []);
    if (rentals.length === 0) return [];

    const normalizeAddress = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
    return db.transaction(async (tx) => {
      const existing = await tx.select().from(realEstateOwned)
        .where(eq(realEstateOwned.applicationId, applicationId));
      const existingByAddress = new Map(
        existing.map((row) => [normalizeAddress(row.propertyAddress), row]),
      );
      const keptIntakeIds = new Set<string>();
      const synced: RealEstateOwned[] = [];

      for (const rental of rentals) {
        const addressKey = normalizeAddress(rental.address);
        const match = existingByAddress.get(addressKey);
        if (match && match.verificationSource !== "borrower_intake") {
          synced.push(match);
          continue;
        }
        const values: InsertRealEstateOwned = {
          userId: borrowerUserId,
          applicationId,
          propertyAddress: rental.address,
          propertyCity: rental.city ?? null,
          propertyState: rental.state ?? null,
          // The fast intake does not ask for the physical property type. Use
          // the same neutral default as URLA 2c; investment belongs in the
          // occupancy field below.
          propertyType: "single_family",
          mortgagePayment: rental.monthlyDebtPayment || null,
          monthlyRentalIncome: rental.monthlyRentalIncome,
          occupancyType: "investment",
          status: "retained",
          willBeRented: true,
          verificationSource: "borrower_intake",
        };
        if (match) {
          const [updated] = await tx.update(realEstateOwned)
            .set({ ...values, updatedAt: new Date() })
            .where(eq(realEstateOwned.id, match.id))
            .returning();
          keptIntakeIds.add(match.id);
          synced.push(updated);
        } else {
          const [created] = await tx.insert(realEstateOwned).values(values).returning();
          keptIntakeIds.add(created.id);
          synced.push(created);
        }
      }

      for (const row of existing) {
        if (row.verificationSource === "borrower_intake" && !keptIntakeIds.has(row.id)) {
          await tx.delete(realEstateOwned).where(eq(realEstateOwned.id, row.id));
        }
      }
      await tx.update(loanApplications)
        .set({ ownsOtherRealEstate: true, updatedAt: new Date() })
        .where(eq(loanApplications.id, applicationId));
      return synced;
    });
  }

  async getHmdaDemographicsByApplication(applicationId: string): Promise<HmdaDemographics[]> {
    return await db
      .select()
      .from(hmdaDemographics)
      .where(eq(hmdaDemographics.applicationId, applicationId));
  }

  async getHmdaDemographicsBySequence(applicationId: string, borrowerSequenceNumber: number = 1): Promise<HmdaDemographics | undefined> {
    const [record] = await db
      .select()
      .from(hmdaDemographics)
      .where(and(
        eq(hmdaDemographics.applicationId, applicationId),
        eq(hmdaDemographics.borrowerSequenceNumber, borrowerSequenceNumber),
      ))
      .limit(1);
    return record;
  }

  async upsertHmdaDemographics(data: InsertHmdaDemographics): Promise<HmdaDemographics> {
    const seq = (data as any).borrowerSequenceNumber ?? 1;
    const existing = await this.getHmdaDemographicsBySequence(data.applicationId, seq);
    const { createdAt, updatedAt, id, ...cleanData } = data as any;

    if (existing) {
      const [updated] = await db
        .update(hmdaDemographics)
        .set({ ...cleanData, borrowerSequenceNumber: seq, updatedAt: new Date() })
        .where(and(
          eq(hmdaDemographics.applicationId, data.applicationId),
          eq(hmdaDemographics.borrowerSequenceNumber, seq),
        ))
        .returning();
      return updated;
    }
    const [created] = await db.insert(hmdaDemographics).values({ ...cleanData, borrowerSequenceNumber: seq }).returning();
    return created;
  }

  async getBorrowerProfileByUserId(userId: string): Promise<BorrowerProfile | undefined> {
    const [profile] = await db
      .select()
      .from(borrowerProfiles)
      .where(eq(borrowerProfiles.userId, userId))
      .limit(1);
    return profile;
  }

  // Batched variant of getBorrowerProfileByUserId for list views. Keyed by
  // userId (a profile belongs to a user, not an application), so callers holding
  // applications must map through application.userId themselves.
  async getBorrowerProfilesByUserIds(userIds: string[]): Promise<Map<string, BorrowerProfile>> {
    if (userIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(borrowerProfiles)
      .where(inArray(borrowerProfiles.userId, userIds));
    return indexRowsByKey(rows, (row) => row.userId);
  }

  // MISMO Export Data - aggregates all data needed for MISMO 3.4 XML generation
  async getMISMOLoanData(applicationId: string) {
    const application = await this.getLoanApplication(applicationId);
    if (!application) {
      return null;
    }

    const [user, urlaData, loanOpts, docs, fullSsn] = await Promise.all([
      application.userId ? this.getUser(application.userId) : Promise.resolve(undefined),
      this.getCompleteUrlaData(applicationId),
      this.getLoanOptionsByApplication(applicationId),
      this.getDocumentsByApplication(applicationId),
      // GSE loan delivery requires the real TaxpayerIdentifierValue. This is
      // the one read path that decrypts the SSN; the export route is gated to
      // internal staff roles only (never broker/lender partners or clients)
      // and records the export as a deal activity.
      this.getDecryptedUrlaSsn(applicationId),
    ]);

    // GSE delivery needs full identifiers. The SSN comes from ssnVault's
    // audited decryption (fullSsn, above); account numbers are decrypted here
    // via piiVault. This object feeds the MISMO generator only — never a client.
    const personalInfo = urlaData.personalInfo
      ? { ...urlaData.personalInfo, ssn: fullSsn }
      : null;
    const withAccountNumber = <T extends {
      accountNumberEncrypted: string | null;
      accountNumberIv: string | null;
      accountNumberKeyId: string | null;
    }>(record: T): T & { accountNumber: string | null } => ({
      ...record,
      accountNumber: decryptPiiField({
        encrypted: record.accountNumberEncrypted,
        iv: record.accountNumberIv,
        keyId: record.accountNumberKeyId,
      }),
    });

    return {
      application,
      user: user || null,
      personalInfo,
      employment: urlaData.employmentHistory,
      assets: urlaData.assets.map(withAccountNumber),
      liabilities: urlaData.liabilities.map(withAccountNumber),
      propertyInfo: urlaData.propertyInfo || null,
      declarations: urlaData.declarations || null,
      loanOptions: loanOpts,
      documents: docs,
    };
  }

  // Data Quality Scoring for Broker Dashboard
  async getApplicationDataQuality(applicationId: string) {
    // application + taskList results are unused but the parallel fetches stay (existence
    // + timing behavior preserved) — underscore marks them deliberately unused.
    const [_application, urlaData, docs, _taskList] = await Promise.all([
      this.getLoanApplication(applicationId),
      this.getCompleteUrlaData(applicationId),
      this.getDocumentsByApplication(applicationId),
      this.getTasksByApplication(applicationId),
    ]);

    const sections = [];

    // Personal Information Section
    const personalFields = [
      "firstName", "lastName", "ssnLast4", "dateOfBirth", "email", "cellPhone",
      "currentStreet", "currentCity", "currentState", "currentZip"
    ];
    const personalMissing = personalFields.filter(f => !urlaData.personalInfo?.[f as keyof typeof urlaData.personalInfo]);
    const personalScore = Math.round(((personalFields.length - personalMissing.length) / personalFields.length) * 100);
    sections.push({
      name: "Personal Information",
      score: personalScore,
      missingFields: personalMissing,
      verificationStatus: urlaData.personalInfo?.ssnEncrypted ? "verified" : "pending",
    });

    // Employment Section
    const hasCurrentEmployment = urlaData.employmentHistory.some(e => e.employmentType === "current");
    const employmentScore = hasCurrentEmployment ? 100 : 0;
    sections.push({
      name: "Employment History",
      score: employmentScore,
      missingFields: hasCurrentEmployment ? [] : ["Current Employment"],
      verificationStatus: hasCurrentEmployment ? "pending_verification" : "incomplete",
    });

    // Assets Section
    const assetsScore = urlaData.assets.length > 0 ? 100 : 0;
    sections.push({
      name: "Assets",
      score: assetsScore,
      missingFields: urlaData.assets.length > 0 ? [] : ["At least one asset account"],
      verificationStatus: urlaData.assets.length > 0 ? "pending_verification" : "incomplete",
    });

    // Liabilities Section
    const liabilitiesScore = urlaData.liabilities.length >= 0 ? 100 : 0;
    sections.push({
      name: "Liabilities",
      score: liabilitiesScore,
      missingFields: [],
      verificationStatus: "complete",
    });

    // Declarations Section
    const declarationFields = [
      "willOccupyAsPrimaryResidence", "hasRelationshipWithSeller", 
      "hasOutstandingJudgments", "hasDeclaredBankruptcy", "isUSCitizen"
    ];
    const declarationsMissing = declarationFields.filter(
      f => urlaData.declarations?.[f as keyof typeof urlaData.declarations] === null || 
           urlaData.declarations?.[f as keyof typeof urlaData.declarations] === undefined
    );
    const declarationsScore = urlaData.declarations 
      ? Math.round(((declarationFields.length - declarationsMissing.length) / declarationFields.length) * 100)
      : 0;
    sections.push({
      name: "Borrower Declarations",
      score: declarationsScore,
      missingFields: declarationsMissing,
      verificationStatus: urlaData.declarations?.declarationsVerifiedAt ? "verified" : "pending",
    });

    // Documents Section
    const requiredDocTypes = ["w2", "pay_stub", "bank_statement", "id"];
    const uploadedTypes = Array.from(new Set(docs.map(d => d.documentType)));
    const docsMissing = requiredDocTypes.filter(t => !uploadedTypes.includes(t));
    const docsVerified = docs.filter(d => d.status === "verified").length;
    const docsScore = Math.round(((requiredDocTypes.length - docsMissing.length) / requiredDocTypes.length) * 100);
    sections.push({
      name: "Documents",
      score: docsScore,
      missingFields: docsMissing,
      verificationStatus: docsVerified === docs.length && docs.length > 0 ? "verified" : "pending_verification",
    });

    // Calculate overall score
    const overallScore = Math.round(sections.reduce((sum, s) => sum + s.score, 0) / sections.length);

    return { overallScore, sections };
  }

}
