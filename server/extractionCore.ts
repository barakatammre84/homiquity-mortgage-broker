// Model constants + prompt version, the import-time Anthropic client + object storage instances, lineage/extracted-data types, file/media helpers, the shared model-call wrapper.
// Split from the old server/extractionService.ts — which re-exports it.
/**
 * AI Document Extraction Service — the Anthropic (Claude) vendor adapter.
 * Every document-extraction model call in the codebase lives here
 * (vendor-adapter rule); orchestration/persistence live in the services that
 * consume it.
 *
 * Extracts structured financial data from:
 * - Tax Returns — single-pass summary (legacy) AND multi-form classification +
 *   per-form extraction (UAL P2a Situation Identification Engine)
 * - Pay Stubs (income verification)
 * - Bank Statements (asset verification)
 * - Lease agreements (rent auto-fill)
 */

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import { ObjectStorageService } from "./integrations/object_storage";
import type { DocumentTypeTaxonomy } from "@shared/schema/documents";

// Model lineage, persisted with every extraction so a past result can be traced
// to the exact model + prompt that produced it. Bump EXTRACTION_PROMPT_VERSION
// whenever any extraction prompt text changes.
//
// Extraction is tiered by task. Single-document reads (pay stub, bank statement,
// lease, single-pass tax return) are bounded, high-volume, and vision-bound but
// not reasoning-heavy — Sonnet 5 has the same high-res vision as Opus at lower
// cost, and everything downstream is Zod-validated + confidence-capped. The
// multi-form tax-package pass (UAL P2a: classify every form, then tie the forms
// out across entities and years) is the one genuinely hard reasoning task and it
// feeds the income engine — it stays on Opus. Lineage records the actual model.

export const EXTRACTION_MODEL_SINGLE_DOC = "claude-sonnet-5";
export const EXTRACTION_MODEL_TAX_PACKAGE = "claude-opus-4-8";
/** @deprecated Use the task-specific constants above; retained for back-compat. */
export const EXTRACTION_MODEL_ID = EXTRACTION_MODEL_TAX_PACKAGE;
export const EXTRACTION_PROMPT_VERSION = "2026-09-v5";
/** Lineage marker for deterministic simulated extractions (I10: unmistakable). */
export const SIMULATED_MODEL_ID = "simulated";

/**
 * Demonstration extraction is a local/test aid only. A production process
 * must fail closed before a plausible sample value can enter the normal
 * borrower-fact persistence path.
 */
export function extractionSimulationEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.EXTRACTION_SIMULATE !== "true") return false;
  if (env.NODE_ENV === "production") {
    throw new Error("EXTRACTION_SIMULATE cannot be enabled in production");
  }
  return true;
}

// Captured at import time (tests rely on this): construct the client only when
// a key exists — the Anthropic SDK throws at construction with no API key.
const apiKey = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
export const anthropic = apiKey ? new Anthropic({ apiKey }) : null;
export const objectStorageService = new ObjectStorageService();

export interface ExtractionLineage {
  /** Model that produced this extraction (audit lineage). */
  modelId?: string;
  /** Prompt revision that produced this extraction (audit lineage). */
  promptVersion?: string;
  /** SHA-256 of the raw model response — ties stored fields to the exact output. */
  rawResponseHash?: string;
  /** The raw model response, AES-256-GCM encrypted (it can contain PII). */
  rawResponseEncrypted?: string;
  rawResponseIv?: string;
  rawResponseKeyId?: string;
  /** Source location and field-specific model confidence for staff review. */
  fieldEvidence?: Record<string, ExtractedFieldEvidence>;
  /** Page count observed by the extractor when the source is paginated. */
  pageCount?: number;
  /**
   * Independent page classification returned alongside a simple-document
   * extraction. The upload dropdown is a routing hint from the borrower; it is
   * never evidence that the bytes are actually that kind of document.
   */
  documentClassification?: DocumentClassification;
}

export interface DocumentPageClassification {
  /** 1-indexed source page. */
  pageNumber: number;
  documentType: DocumentTypeTaxonomy;
  /** Model confidence from 0 to 1 for this page's type. */
  confidence: number;
}

export interface DocumentClassification {
  pageCount: number;
  pages: DocumentPageClassification[];
}

export interface ExtractedFieldEvidence {
  /** 1-indexed source page. Images are page 1. */
  pageNumber: number;
  /** Field-specific model confidence from 0 to 1. */
  confidence: number;
  /** Normalized page coordinates, when the model can locate the value. */
  boundingBox?: { x: number; y: number; width: number; height: number };
}

export interface ExtractedTaxReturnData extends ExtractionLineage {
  documentYear: string;
  taxpayerName?: string;
  /** Form 1040 line 1a — total W-2 wages. */
  w2Wages?: number;
  grossIncome?: number;
  adjustedGrossIncome?: number;
  taxableIncome?: number;
  filingStatus?: string;
  scheduleC?: {
    businessIncome?: number;
    businessExpenses?: number;
    netProfitLoss?: number;
  };
  scheduleD?: {
    capitalGains?: number;
  };
  scheduleE?: {
    /** Schedule E Part I line 26 — total rental real estate income or (loss). */
    netRentalIncomeLoss?: number;
    /** Sum of line 3 (rents received) across property columns. */
    grossRents?: number;
    /** Line 18 total depreciation expense. */
    totalDepreciation?: number;
    /** Line 12 total mortgage interest paid to banks. */
    mortgageInterest?: number;
    /** Number of property columns with data (Part I). */
    propertyCount?: number;
  };
  confidence: "high" | "medium" | "low";
  extractedFields: string[];
  warnings?: string[];
}

export interface ExtractedPayStubData extends ExtractionLineage {
  employeeName?: string;
  employerName?: string;
  payPeriodStartDate?: string;
  payPeriodEndDate?: string;
  grossPay?: number;
  netPay?: number;
  ytdGross?: number;
  ytdNetPay?: number;
  ytdTaxes?: number;
  deductions?: {
    federal?: number;
    fica?: number;
    other?: number;
  };
  confidence: "high" | "medium" | "low";
  extractedFields: string[];
  warnings?: string[];
}

export interface ExtractedBankStatementData extends ExtractionLineage {
  accountType?: string;
  accountNumber?: string;
  statementPeriod?: { start?: string; end?: string };
  openingBalance?: number;
  closingBalance?: number;
  totalDeposits?: number;
  totalWithdrawals?: number;
  averageDailyBalance?: number;
  transactions?: Array<{
    date: string;
    description: string;
    amount: number;
    type: "deposit" | "withdrawal";
  }>;
  confidence: "high" | "medium" | "low";
  extractedFields: string[];
  warnings?: string[];
}

export interface ExtractedLeaseData extends ExtractionLineage {
  monthlyRent?: number;
  tenantName?: string;
  landlordName?: string;
  propertyAddress?: string;
  leaseStartDate?: string;
  leaseEndDate?: string;
  securityDeposit?: number;
  confidence: "high" | "medium" | "low";
  extractedFields: string[];
  warnings?: string[];
}

export type ExtractedDocumentData = 
  | ExtractedTaxReturnData 
  | ExtractedPayStubData 
  | ExtractedBankStatementData
  | ExtractedLeaseData;

// Accepts an in-memory Buffer (transient uploads that never persist, e.g. the
// public lease extractor), a normalized /objects/ path (object storage — the
// presigned-upload flow), or a legacy filesystem path.
export async function fileToBase64(source: string | Buffer): Promise<string> {
  if (Buffer.isBuffer(source)) {
    return source.toString("base64");
  }
  if (source.startsWith("/objects/")) {
    const objectFile = await objectStorageService.getObjectEntityFile(source);
    const chunks: Buffer[] = [];
    const stream = objectFile.createReadStream();
    return new Promise((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      stream.on("error", reject);
    });
  }
  const fileBuffer = fs.readFileSync(source);
  return fileBuffer.toString("base64");
}

export function getMimeType(source: string | Buffer, storedMimeType?: string): string {
  if (storedMimeType) return storedMimeType;
  if (Buffer.isBuffer(source)) return "application/octet-stream";
  const ext = path.extname(source).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

/**
 * Wrap an uploaded file as the correct Anthropic content block: images go in
 * an image block, everything else (uploads are constrained to pdf/jpg/png) is
 * treated as a PDF document block.
 */
export function mediaBlock(mimeType: string, base64: string): Anthropic.ContentBlockParam {
  if (mimeType.startsWith("image/")) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: base64,
      },
    };
  }
  return {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: base64 },
  };
}

/**
 * One vision/document call: file + prompt in, raw model text out. A safety
 * refusal (stop_reason "refusal") returns "" so the caller's low-confidence
 * fallback handles it like any other unusable response.
 */
export async function generateExtractionText(
  client: Anthropic,
  mimeType: string,
  base64: string,
  prompt: string,
  model: string,
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    messages: [
      {
        role: "user",
        content: [mediaBlock(mimeType, base64), { type: "text", text: prompt }],
      },
    ],
  });
  if (response.stop_reason === "refusal") return "";
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// ---------------------------------------------------------------------------
// Model-output validation.
//
// The model's JSON is untrusted input: it can be malformed, out of range, or
// steered by adversarial text embedded in an uploaded document (prompt
// injection). Nothing the model returns is trusted until it passes these
// schemas: numeric fields are clamped to sane document ranges (out-of-range
// values are DROPPED, not trusted), bank account numbers are reduced to their
// last 4 digits, cross-field consistency failures cap the model's self-reported
// confidence, and a structurally invalid payload degrades to a low-confidence
// empty extraction instead of flowing downstream.
// ---------------------------------------------------------------------------
