import type { Document, LoanApplication } from "@shared/schema";

/** The document row records the uploader. The application owns borrower identity. */
interface ApplicationLookup {
  getLoanApplication(id: string): Promise<LoanApplication | undefined>;
}

export class DocumentBorrowerResolutionError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

/**
 * Resolve the person whose financial data a document contains.
 *
 * Application-linked files can be uploaded by a borrower, loan officer, or
 * processor, so documents.userId remains uploader provenance. Standalone files
 * are borrower-direct and intentionally fall back to that field.
 */
export async function resolveDocumentBorrowerUserId(
  document: Document,
  storage: ApplicationLookup,
): Promise<string> {
  if (!document.applicationId) return document.userId;

  const application = await storage.getLoanApplication(document.applicationId);
  if (!application) {
    throw new DocumentBorrowerResolutionError(
      "The document's loan application could not be resolved",
    );
  }
  return application.userId;
}
