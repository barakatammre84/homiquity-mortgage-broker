import { eq } from "drizzle-orm";
import {
  borrowerDeclarations,
  employmentHistory,
  urlaAssets,
  urlaLiabilities,
  urlaPersonalInfo,
} from "@shared/schema";
import { db } from "../db";

type BorrowerSequenceEvidence = {
  borrowerSequenceNumber?: number | null;
  totalBorrowers?: number | null;
};

/**
 * Resolve the borrowers represented anywhere in the URLA. The primary is
 * always sequence 1. A declared total borrower count expands the expected set
 * even when a partially saved co-borrower row is missing, so incomplete joint
 * files fail closed at the credit gate.
 */
export function expectedBorrowerSequences(rows: readonly BorrowerSequenceEvidence[]): number[] {
  const sequences = new Set<number>([1]);
  for (const row of rows) {
    const sequence = row.borrowerSequenceNumber;
    if (Number.isInteger(sequence) && sequence! > 0 && sequence! <= 10) sequences.add(sequence!);
    const total = row.totalBorrowers;
    if (Number.isInteger(total) && total! > 0 && total! <= 10) {
      for (let borrower = 1; borrower <= total!; borrower += 1) sequences.add(borrower);
    }
  }
  return [...sequences].sort((a, b) => a - b);
}

export async function loadExpectedBorrowerSequences(applicationId: string): Promise<number[]> {
  const [personal, employment, assets, liabilities, declarations] = await Promise.all([
    db.select({
      borrowerSequenceNumber: urlaPersonalInfo.borrowerSequenceNumber,
      totalBorrowers: urlaPersonalInfo.totalBorrowers,
    }).from(urlaPersonalInfo).where(eq(urlaPersonalInfo.applicationId, applicationId)),
    db.select({ borrowerSequenceNumber: employmentHistory.borrowerSequenceNumber })
      .from(employmentHistory).where(eq(employmentHistory.applicationId, applicationId)),
    db.select({ borrowerSequenceNumber: urlaAssets.borrowerSequenceNumber })
      .from(urlaAssets).where(eq(urlaAssets.applicationId, applicationId)),
    db.select({ borrowerSequenceNumber: urlaLiabilities.borrowerSequenceNumber })
      .from(urlaLiabilities).where(eq(urlaLiabilities.applicationId, applicationId)),
    db.select({ borrowerSequenceNumber: borrowerDeclarations.borrowerSequenceNumber })
      .from(borrowerDeclarations).where(eq(borrowerDeclarations.applicationId, applicationId)),
  ]);
  return expectedBorrowerSequences([
    ...personal,
    ...employment,
    ...assets,
    ...liabilities,
    ...declarations,
  ]);
}
