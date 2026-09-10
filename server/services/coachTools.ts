import type { Request } from "express";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { storage } from "../storage";
import {
  syncCoachIntakeToApplication,
  type AppliedField,
  type SkippedField,
} from "./coachProfileSync";
import {
  loadFileTruth,
  type FileTruth,
  type LoanStatusSnapshot,
} from "./coachFileTruth";
import type { ChecklistItemDto, ChecklistStats } from "./documentChecklist";
import type { BorrowerTaskView } from "@shared/borrowerTaskView";
import type { User } from "@shared/schema";
import { ACTIVE_TASK_STATUSES } from "@shared/schema";
import { taskEngine } from "./taskEngine";
import { emitEvent } from "./analyticsEventPipeline";
import {
  loadCoachDocumentEvidence,
  type CoachDocumentEvidenceSnapshot,
} from "./coachDocumentEvidence";

// ---------------------------------------------------------------------------
// Homi tool surface — Claude Sonnet 5 tool-use replaces the old
// <coach_data> text-block extraction. Structured capture now arrives as typed
// tool calls, validated server-side with the SAME Zod schemas the old parser
// used, so malformed data is returned to the model as an is_error tool_result
// (it self-corrects) instead of being silently dropped.
//
// This module owns:
//  - the coach data types + Zod schemas (moved here from coachingService so
//    the import graph stays acyclic; coachingService re-exports them),
//  - the Anthropic tool definitions (COACH_TOOLS — module-level const in a
//    FIXED order; tools render before system in the prompt-cache prefix, so
//    any reorder invalidates the cache),
//  - the executors, which apply side effects (profile writeback via
//    coachProfileSync) and stream `captured`/`panel` events mid-turn.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Data shapes (public API — re-exported by coachingService)
// ---------------------------------------------------------------------------

export interface CoachingProfile {
  readinessTier: "ready_now" | "almost_ready" | "building" | "exploring";
  completionPercentage: number;
  statusNote: string;
  completedInputs: string[];
  outstandingInputs: string[];
  estimatedTimeline: string;
}

export interface ActionPlanItem {
  id: string;
  phase: number;
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  category: "credit" | "savings" | "income" | "debt" | "documents" | "education";
  completed: boolean;
}

export interface DocumentRequirement {
  docType: string;
  label: string;
  reason: string;
  priority: "required" | "recommended" | "optional";
  category: string;
  /** True when this item can be satisfied by securely connecting the account via Plaid (bank/assets, and for W-2 borrowers income/employment) — the capture panel renders a "Connect with Plaid" CTA linking to /verification. */
  plaidEligible?: boolean;
}

export interface CoachIntakeData {
  annualIncome?: string;
  monthlyDebts?: string;
  creditScore?: string;
  employmentType?: string;
  employmentYears?: string;
  downPayment?: string;
  purchasePrice?: string;
  propertyType?: string;
  loanPurpose?: string;
  isVeteran?: boolean;
  isFirstTimeBuyer?: boolean;
}

export interface BorrowerPackage {
  generatedDate: string;
  borrowerOverview: {
    borrowerNames: string;
    householdComposition: string;
    primaryResidenceState: string;
    incomeProfileType: string;
  };
  householdOverview: {
    firstTimeBuyer: string;
    veteranStatus: string;
  };
  transactionIntent: {
    transactionType: string;
    propertyIntent: string;
    targetTimeframe: string;
  };
  incomeSources: Array<{
    source: string;
    type: string;
    frequency: string;
    documentationStatus: string;
  }>;
  assetSummary: Array<{
    assetType: string;
    accountCategory: string;
    ownershipType: string;
    documentationStatus: string;
    lastStatementDate: string;
    validationNotes: string;
    accessLink: string;
  }>;
  creditAndDebt: {
    creditScore: string;
    creditScoreVerification: string;
    monthlyDebts: string;
    monthlyDebtsVerification: string;
    dtiRatio: string;
    dtiNote: string;
  };
  propertyContext: {
    propertyAddress: string;
    estimatedValueOrPrice: string;
    occupancyIntent: string;
  };
  documentInventory: Array<{
    docType: string;
    label: string;
    status: string;
    flags: string[];
  }>;
  readinessStatus: {
    intakeStatus: string;
    documentStatus: string;
    packageStatus: string;
    pendingItems: string[];
  };
  auditTrail: {
    intakeStartDate: string;
    lastUpdateDate: string;
    events: Array<{
      date: string;
      activity: string;
    }>;
  };
  validationNotes: {
    recencyChecks: string[];
    completenessChecks: string[];
    consistencyObservations: string[];
  };
  complianceFooter: string;
}

// ---------------------------------------------------------------------------
// Zod schemas (unchanged rules — moved from coachingService)
// ---------------------------------------------------------------------------

export const coachProfileSchema = z.object({
  readinessTier: z.enum(["ready_now", "almost_ready", "building", "exploring"]).catch("exploring"),
  completionPercentage: z.number().min(0).max(100).catch(0),
  statusNote: z.string().catch(""),
  completedInputs: z.array(z.string()).catch([]),
  outstandingInputs: z.array(z.string()).catch([]),
  estimatedTimeline: z.string().catch(""),
}).passthrough();

export const coachIntakeSchema = z.object({
  annualIncome: z.string().optional(),
  monthlyDebts: z.string().optional(),
  creditScore: z.string().optional(),
  employmentType: z.string().optional(),
  employmentYears: z.string().optional(),
  downPayment: z.string().optional(),
  purchasePrice: z.string().optional(),
  propertyType: z.string().optional(),
  loanPurpose: z.string().optional(),
  isVeteran: z.boolean().optional(),
  isFirstTimeBuyer: z.boolean().optional(),
}).strict();

const actionPlanItemSchema = z.object({
  id: z.string().min(1),
  phase: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string(),
  priority: z.enum(["high", "medium", "low"]),
  category: z.enum(["credit", "savings", "income", "debt", "documents", "education"]),
  completed: z.boolean(),
});
export const coachActionPlanSchema = z.array(actionPlanItemSchema);

const documentRequirementSchema = z.object({
  docType: z.string().min(1),
  label: z.string().min(1),
  reason: z.string(),
  priority: z.enum(["required", "recommended", "optional"]),
  category: z.string().min(1),
  plaidEligible: z.boolean().optional(),
});
export const coachDocumentChecklistSchema = z.array(documentRequirementSchema);

export const borrowerPackageSchema = z.object({
  generatedDate: z.string().min(1),
  borrowerOverview: z.object({
    borrowerNames: z.string().min(1),
    householdComposition: z.string().min(1),
    primaryResidenceState: z.string().min(1),
    incomeProfileType: z.string().min(1),
  }),
  householdOverview: z.object({
    firstTimeBuyer: z.string().min(1),
    veteranStatus: z.string().min(1),
  }),
  transactionIntent: z.object({
    transactionType: z.string().min(1),
    propertyIntent: z.string().min(1),
    targetTimeframe: z.string().min(1),
  }),
  incomeSources: z.array(z.object({
    source: z.string(),
    type: z.string(),
    frequency: z.string(),
    documentationStatus: z.string(),
  })),
  assetSummary: z.array(z.object({
    assetType: z.string(),
    accountCategory: z.string(),
    ownershipType: z.string(),
    documentationStatus: z.string(),
    lastStatementDate: z.string(),
    validationNotes: z.string(),
    accessLink: z.string(),
  })),
  creditAndDebt: z.object({
    creditScore: z.string(),
    creditScoreVerification: z.string(),
    monthlyDebts: z.string(),
    monthlyDebtsVerification: z.string(),
    dtiRatio: z.string(),
    dtiNote: z.string(),
  }),
  propertyContext: z.object({
    propertyAddress: z.string(),
    estimatedValueOrPrice: z.string(),
    occupancyIntent: z.string(),
  }),
  documentInventory: z.array(z.object({
    docType: z.string(),
    label: z.string(),
    status: z.string(),
    flags: z.array(z.string()),
  })),
  readinessStatus: z.object({
    intakeStatus: z.string(),
    documentStatus: z.string(),
    packageStatus: z.string(),
    pendingItems: z.array(z.string()),
  }),
  auditTrail: z.object({
    intakeStartDate: z.string(),
    lastUpdateDate: z.string(),
    events: z.array(z.object({
      date: z.string(),
      activity: z.string(),
    })),
  }),
  validationNotes: z.object({
    recencyChecks: z.array(z.string()),
    completenessChecks: z.array(z.string()),
    consistencyObservations: z.array(z.string()),
  }),
  complianceFooter: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Streamed turn events (transport-agnostic — the SSE route serializes them,
// the JSON route buffers them)
// ---------------------------------------------------------------------------

export type CoachStreamEvent =
  | { type: "text"; delta: string }
  | {
      type: "captured";
      applicationId: string | null;
      created: boolean;
      applied: AppliedField[];
      skipped: SkippedField[];
    }
  | {
      type: "panel";
      profile?: CoachingProfile;
      actionPlan?: ActionPlanItem[];
      documentChecklist?: DocumentRequirement[] | ChecklistItemDto[];
      borrowerPackage?: BorrowerPackage;
      suggestions?: string[];
      // Server-truth payloads. These are read from the borrower's file, not
      // authored by the model — the client renders them as fact.
      loanStatus?: LoanStatusSnapshot;
      checklistStats?: ChecklistStats;
      tasks?: BorrowerTaskView[];
      /**
       * Where this panel's content came from. "file" = derived from the
       * borrower's records; "assistant" = the model's own suggestion.
       *
       * The defect this closes is not that the model suggests things — it is
       * that a suggestion RENDERED IDENTICALLY to a file-derived panel reads
       * as fact. The borrower could not tell which was which, and acted on
       * both the same way.
       */
      source?: "file" | "assistant";
    }
  | { type: "degraded"; reason: "temporarily_unavailable" }
  | { type: "lint_replaced"; categories: string[]; citations: string[] };

export type CoachEmit = (event: CoachStreamEvent) => void;

/** Structured results a turn accumulates across tool calls. */
export interface CoachToolTurnState {
  intake?: CoachIntakeData;
  profile?: CoachingProfile;
  actionPlan?: ActionPlanItem[];
  documentChecklist?: DocumentRequirement[];
  borrowerPackage?: BorrowerPackage;
  suggestions?: string[];
  humanHelpRequest?: { taskId: string; alreadyOpen: boolean };
  /** Redacted persistence result used by Homi's operational outcome metrics. */
  captureOutcome?: {
    attempts: number;
    createdApplication: boolean;
    appliedFields: string[];
    skippedFields: number;
  };
  /** Writeback target resolved by record_intake (for ai_interactions linkage). */
  syncedApplicationId?: string | null;
}

export interface CoachToolContext {
  req: Request;
  userId: string;
  /** Needed by the read tools' re-authorization (getLoanApplicationWithAccess). */
  userRole: string;
  conversationId: string;
  /** Unique persisted user message for idempotent side effects this turn. */
  turnId: string;
  /**
   * The file the read tools may read, resolved server-side from the session.
   * Null when the borrower has no workable file — the tools say so rather than
   * letting the model improvise. NO tool accepts this as input: a model can be
   * talked into emitting someone else's uuid, which is an IDOR primitive.
   */
  workableApplicationId: string | null;
  emit: CoachEmit;
  state: CoachToolTurnState;
  /** Read-only snapshots reused across model calls in this one Homi turn. */
  fileTruthCache?: FileTruth | "unavailable";
  documentEvidenceCache?: CoachDocumentEvidenceSnapshot | "unavailable";
}

// ---------------------------------------------------------------------------
// Tool definitions — FIXED order (prompt-cache prefix). Descriptions are
// prescriptive about WHEN to call (measurably improves trigger rate).
// ---------------------------------------------------------------------------

const INTAKE_INPUT_SCHEMA = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    annualIncome: { type: "string", description: 'Annual gross income in dollars, digits only (e.g. "85000").' },
    monthlyDebts: { type: "string", description: 'Total monthly debt payments in dollars, digits only (e.g. "1200").' },
    creditScore: { type: "string", description: 'Approximate credit score, 300-850, digits only (e.g. "720"). If the user gives a range, send the midpoint.' },
    employmentType: { type: "string", enum: ["employed", "self_employed", "retired", "other"] },
    employmentYears: { type: "string", description: "Years at current job, digits only." },
    downPayment: { type: "string", description: "Down payment funds available, in dollars, digits only." },
    purchasePrice: { type: "string", description: "Target purchase price, in dollars, digits only." },
    propertyType: { type: "string", enum: ["single_family", "condo", "townhouse", "multi_family"] },
    loanPurpose: { type: "string", enum: ["purchase", "refinance", "cash_out"] },
    isVeteran: { type: "boolean" },
    isFirstTimeBuyer: { type: "boolean" },
  },
};

export const COACH_TOOLS: Anthropic.Tool[] = [
  {
    name: "record_intake",
    description:
      "Save financial details to the borrower's pre-application profile. Call this EVERY time the user supplies or corrects a financial detail — income, monthly debts, credit score, employment, down payment, target price, property type, loan purpose, veteran or first-time-buyer status. Send ONLY the fields learned or corrected in this turn, as plain numeric strings with no $ signs or commas. The result tells you exactly which fields were saved and which were skipped — narrate that honestly.",
    input_schema: INTAKE_INPUT_SCHEMA,
  },
  {
    name: "set_action_plan",
    description:
      "Replace the borrower's step-by-step PREPARATION plan — the educational work that has no record behind it yet (building credit, saving a down payment, seasoning income, timing a move). Call when the user asks for a plan, or when their situation changes materially. Always send the FULL plan (it replaces the previous one). This plan is labelled as YOUR suggestion in the UI, not as a fact from their file, so keep it to advice you can justify. NEVER list documents here — call get_document_checklist, which returns the real ones. NEVER state where their file stands or what stage it is in — call get_loan_status.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", description: 'Stable id, e.g. "action-1".' },
              phase: { type: "integer", minimum: 1 },
              title: { type: "string" },
              description: { type: "string" },
              priority: { type: "string", enum: ["high", "medium", "low"] },
              category: { type: "string", enum: ["credit", "savings", "income", "debt", "education"] },
              completed: { type: "boolean" },
            },
            required: ["id", "phase", "title", "description", "priority", "category", "completed"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "generate_borrower_package",
    description:
      "Generate the lender-ready borrower intake summary. Call ONLY when the borrower's readiness tier is ready_now, or when the user explicitly asks for their borrower summary/package. Every field with no data MUST be the string \"Not Provided\", \"Pending\", or \"Insufficient Data\" — never invent, infer, or estimate values. Never include approval odds, qualitative assessments, or product recommendations anywhere in it.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        generatedDate: { type: "string", description: "YYYY-MM-DD" },
        borrowerOverview: {
          type: "object",
          properties: {
            borrowerNames: { type: "string" },
            householdComposition: { type: "string", description: "Single Borrower | Co-Borrowers (Married) | Co-Borrowers (Non-Married) | Not Provided" },
            primaryResidenceState: { type: "string", description: "Two-letter state code or Not Provided" },
            incomeProfileType: { type: "string", description: "W-2 | Self-Employed | Mixed | Investor | Not Provided" },
          },
          required: ["borrowerNames", "householdComposition", "primaryResidenceState", "incomeProfileType"],
        },
        householdOverview: {
          type: "object",
          properties: {
            firstTimeBuyer: { type: "string", description: "Yes | No | Not Provided" },
            veteranStatus: { type: "string", description: "Yes | No | Not Provided" },
          },
          required: ["firstTimeBuyer", "veteranStatus"],
        },
        transactionIntent: {
          type: "object",
          properties: {
            transactionType: { type: "string", description: "Purchase | Refinance | Cash-Out Refinance | Not Provided" },
            propertyIntent: { type: "string", description: "Primary Residence | Second Home | Investment | Not Provided" },
            targetTimeframe: { type: "string", description: "Borrower-stated timeframe or Not Provided — never infer." },
          },
          required: ["transactionType", "propertyIntent", "targetTimeframe"],
        },
        incomeSources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              source: { type: "string" },
              type: { type: "string", description: "W-2 | Self-Employed | Rental | 1099 | Retirement | Other" },
              frequency: { type: "string", description: "Monthly | Bi-Weekly | Annual | Not Provided" },
              documentationStatus: { type: "string", description: "Uploaded | Pending | Not Provided" },
            },
            required: ["source", "type", "frequency", "documentationStatus"],
          },
        },
        assetSummary: {
          type: "array",
          items: {
            type: "object",
            properties: {
              assetType: { type: "string" },
              accountCategory: { type: "string", description: "Liquid | Non-Liquid | Retirement | Gift | Other" },
              ownershipType: { type: "string", description: "Individual | Joint | Trust | Custodial | Not Specified" },
              documentationStatus: { type: "string", description: "Uploaded | Pending | Not Provided" },
              lastStatementDate: { type: "string", description: "YYYY-MM-DD or Not Provided" },
              validationNotes: { type: "string", description: "Factual procedural note or empty string — never assess sufficiency." },
              accessLink: { type: "string", description: "Always send an empty string — links are generated server-side." },
            },
            required: ["assetType", "accountCategory", "ownershipType", "documentationStatus", "lastStatementDate", "validationNotes", "accessLink"],
          },
        },
        creditAndDebt: {
          type: "object",
          properties: {
            creditScore: { type: "string" },
            creditScoreVerification: { type: "string", description: "Tier 1 | Tier 2 | Tier 3 | Not Provided" },
            monthlyDebts: { type: "string" },
            monthlyDebtsVerification: { type: "string", description: "Tier 1 | Tier 2 | Tier 3 | Not Provided" },
            dtiRatio: { type: "string", description: 'e.g. "35%" or "Insufficient Data"' },
            dtiNote: { type: "string" },
          },
          required: ["creditScore", "creditScoreVerification", "monthlyDebts", "monthlyDebtsVerification", "dtiRatio", "dtiNote"],
        },
        propertyContext: {
          type: "object",
          properties: {
            propertyAddress: { type: "string", description: "Address if identified or Not Provided — never fabricate." },
            estimatedValueOrPrice: { type: "string" },
            occupancyIntent: { type: "string", description: "Primary Residence | Second Home | Investment | Not Provided" },
          },
          required: ["propertyAddress", "estimatedValueOrPrice", "occupancyIntent"],
        },
        documentInventory: {
          type: "array",
          items: {
            type: "object",
            properties: {
              docType: { type: "string" },
              label: { type: "string" },
              status: { type: "string", description: "Received — Verified | Received — Pending Review | Not Yet Received | Not Required" },
              flags: { type: "array", items: { type: "string", enum: ["recency", "legibility", "consistency", "completeness"] } },
            },
            required: ["docType", "label", "status", "flags"],
          },
        },
        readinessStatus: {
          type: "object",
          properties: {
            intakeStatus: { type: "string", description: "Started | Complete" },
            documentStatus: { type: "string", description: "Complete | Partial | Not Started" },
            packageStatus: { type: "string", description: "Ready for Underwriting Review | Pending Items" },
            pendingItems: { type: "array", items: { type: "string" } },
          },
          required: ["intakeStatus", "documentStatus", "packageStatus", "pendingItems"],
        },
        auditTrail: {
          type: "object",
          properties: {
            intakeStartDate: { type: "string" },
            lastUpdateDate: { type: "string" },
            events: {
              type: "array",
              items: {
                type: "object",
                properties: { date: { type: "string" }, activity: { type: "string" } },
                required: ["date", "activity"],
              },
            },
          },
          required: ["intakeStartDate", "lastUpdateDate", "events"],
        },
        validationNotes: {
          type: "object",
          properties: {
            recencyChecks: { type: "array", items: { type: "string" } },
            completenessChecks: { type: "array", items: { type: "string" } },
            consistencyObservations: { type: "array", items: { type: "string" } },
          },
          required: ["recencyChecks", "completenessChecks", "consistencyObservations"],
        },
        complianceFooter: { type: "string", description: "The standard informational-purposes compliance footer." },
      },
      required: [
        "generatedDate", "borrowerOverview", "householdOverview", "transactionIntent", "incomeSources",
        "assetSummary", "creditAndDebt", "propertyContext", "documentInventory", "readinessStatus",
        "auditTrail", "validationNotes", "complianceFooter",
      ],
    },
  },
  {
    name: "suggest_next_steps",
    description:
      "Provide tappable follow-up suggestions rendered as chips under the chat. Call at the END of every turn with 2-3 short messages the user might naturally send next, phrased in the USER's voice (e.g. \"What documents do I need?\"), each under 60 characters.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        suggestions: { type: "array", items: { type: "string", maxLength: 80 }, minItems: 1, maxItems: 3 },
      },
      required: ["suggestions"],
    },
  },
  // NOTE: new tools append at the END — tools render before system in the
  // prompt-cache prefix, so inserting mid-list reorders every later tool and
  // invalidates the cache twice over.
  {
    name: "lookup_dpa_programs",
    description:
      "Look up down-payment-assistance programs from Homiquity's verified educational directory (currently Illinois: IHDA statewide, City of Chicago, Cook County). Call whenever the user asks about down payment assistance, grants, DPA, IHDA, or help covering closing-cost cash — NEVER answer DPA questions from memory. Cite only what this tool returns; program terms change and funding pauses, so always tell the user to confirm current details with the administering agency or a HUD-approved housing counselor, and never state or imply that the user qualifies.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        state: { type: "string", description: "Optional two-letter state code (e.g. \"IL\") to filter by." },
        firstTimeBuyer: {
          type: "boolean",
          description:
            "Pass false for a repeat buyer (excludes first-time-only programs). True or omitted returns all programs — first-time buyers qualify for both first-time-only and general programs.",
        },
      },
      required: [],
    },
  },
  // --- Server-truth read tools ------------------------------------------
  // These replace guessing. Before them the assistant answered "where does my
  // file stand?" and "what documents do you need?" from its memory of the
  // conversation, which goes stale between messages and was never right for a
  // borrower whose file moved. None of them accepts an id: the application is
  // resolved server-side from the session (see CoachToolContext).
  {
    name: "get_loan_status",
    description:
      "Read where this borrower's APPLICATION PROCESS actually stands right now: stage, how far along, days in process, conditions cleared vs outstanding, and the single next action the server recommends. Call this when the user asks about application status, progress, timing, what's happening, what's next, or 'where am I' — and before making any claim about their process stage. Do not call it for OCR results, document-value verification, or financial-analysis approval; get_document_evidence owns those questions. You do NOT know process status from the conversation; it changes between messages. Never answer from memory or from earlier in this chat.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_document_checklist",
    description:
      "Read the borrower's REAL document checklist — the same list their Documents page shows, with each item's true status (needed, uploaded, in review, verified, rejected) and, for rejections, the reason they must fix. Call this whenever the user asks what documents are needed, what's outstanding, whether something was received, or why a document came back. NEVER compose or guess a document list: an invented item does not match any real requirement, so uploading against it silently fails to clear anything.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        filter: {
          type: "string",
          enum: ["needed", "rejected", "all"],
          description: "Narrow the list. Omit for everything still outstanding plus anything rejected.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_borrower_tasks",
    description:
      "Read the borrower's open to-dos that are NOT document uploads — consents, identity verification, demographic questions, and the closing-prep steps their loan team has made visible. Call this alongside get_document_checklist when the user asks what they need to do, or why something is stuck. These are real task records; do not invent tasks.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        includeCompleted: {
          type: "boolean",
          description: "Include finished tasks. Omit for open work only.",
        },
      },
      required: [],
    },
  },
  {
    name: "request_human_help",
    description:
      "Create a real follow-up for the borrower's loan officer. Call when the borrower explicitly asks to speak with a person or loan officer, asks for a call, or when a complex file question cannot be resolved safely from the available file truth. Do not merely promise that someone will contact them: call this tool. Choose only the topic; never send account numbers, tax identifiers, document text, or a free-form conversation summary.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        topic: {
          type: "string",
          enum: [
            "complex_income",
            "document_question",
            "application_status",
            "loan_options",
            "technical_help",
            "other",
          ],
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "get_document_evidence",
    description:
      "Read the safe financial facts Homiquity ACTUALLY extracted from this borrower's uploaded documents, each fact's machine-read or human-verified status, whether low-confidence values need staff review, and whether a current approved financial package exists. Call whenever the borrower asks what Homiquity found in their documents, whether OCR worked, whether a value was verified, how tax/pay-stub/bank evidence compares, or what financial analysis is complete. Never call an unreviewed value verified or qualifying income; only the review status returned by this tool may authorize those words. Low confidence is a staff-review signal, not a borrower re-upload request: ask for a replacement only when get_document_checklist says rejected and gives the reason.",
    input_schema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
];

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

export interface CoachToolResult {
  /** Text returned to the model as the tool_result content. */
  content: string;
  isError?: boolean;
}

function zodIssueSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

const KNOWN_INTAKE_KEYS = new Set(Object.keys(INTAKE_INPUT_SCHEMA.properties));

export async function executeCoachTool(
  ctx: CoachToolContext,
  name: string,
  input: unknown,
): Promise<CoachToolResult> {
  switch (name) {
    case "record_intake": {
      // Strip unknown keys first (the schema is .strict()) so one hallucinated
      // key doesn't void the real fields; report what was ignored.
      const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      const filtered: Record<string, unknown> = {};
      const ignored: string[] = [];
      for (const [k, v] of Object.entries(raw)) {
        if (KNOWN_INTAKE_KEYS.has(k)) filtered[k] = v;
        else ignored.push(k);
      }
      const parsed = coachIntakeSchema.safeParse(filtered);
      if (!parsed.success) {
        return { content: `Invalid intake fields — ${zodIssueSummary(parsed.error)}. Re-send with corrected values.`, isError: true };
      }
      if (Object.keys(parsed.data).length === 0) {
        return { content: "No recognized intake fields were provided.", isError: true };
      }

      // Always keep the conversation-level snapshot (borrowerGraph readiness,
      // /api/coach/intake/latest, and the Pre-Approval prefill read it) …
      ctx.state.intake = { ...ctx.state.intake, ...parsed.data };

      const previousCapture = ctx.state.captureOutcome;
      ctx.state.captureOutcome = {
        attempts: (previousCapture?.attempts ?? 0) + 1,
        createdApplication: previousCapture?.createdApplication ?? false,
        appliedFields: previousCapture?.appliedFields ?? [],
        skippedFields: previousCapture?.skippedFields ?? 0,
      };

      // … and write through to the borrower's real records.
      try {
        const sync = await syncCoachIntakeToApplication(ctx.req, ctx.userId, parsed.data, ctx.conversationId);
        ctx.state.syncedApplicationId = sync.applicationId;
        // The write can change readiness and invalidate approved analysis.
        ctx.fileTruthCache = undefined;
        ctx.documentEvidenceCache = undefined;
        ctx.state.captureOutcome = {
          attempts: ctx.state.captureOutcome.attempts,
          createdApplication: ctx.state.captureOutcome.createdApplication || sync.created,
          appliedFields: [...new Set([
            ...ctx.state.captureOutcome.appliedFields,
            ...sync.applied.map((field) => field.field),
          ])],
          skippedFields: ctx.state.captureOutcome.skippedFields + sync.skipped.length,
        };
        ctx.emit({
          type: "captured",
          applicationId: sync.applicationId,
          created: sync.created,
          applied: sync.applied,
          skipped: sync.skipped,
        });
        const appliedNote = sync.applied.length > 0
          ? `Saved to the borrower's draft pre-application: ${sync.applied.map((f) => f.field).join(", ")}.`
          : "Nothing new was saved to the pre-application.";
        const skippedNote = sync.skipped.length > 0
          ? ` Skipped: ${sync.skipped.map((f) => `${f.field} (${f.reason})`).join(", ")}.`
          : "";
        const ignoredNote = ignored.length > 0 ? ` Ignored unknown fields: ${ignored.join(", ")}.` : "";
        return { content: `${appliedNote}${skippedNote}${ignoredNote}` };
      } catch (err) {
        console.error("[Coach] Profile sync failed:", err);
        return {
          content:
            "The values were noted in this conversation, but saving to the pre-application profile failed temporarily. Do NOT tell the user their profile was updated.",
          isError: true,
        };
      }
    }

    case "set_action_plan": {
      const items = (input as { items?: unknown })?.items;
      const parsed = coachActionPlanSchema.safeParse(items);
      if (!parsed.success) {
        return { content: `Invalid action plan — ${zodIssueSummary(parsed.error)}.`, isError: true };
      }
      ctx.state.actionPlan = parsed.data;
      ctx.emit({ type: "panel", actionPlan: parsed.data, source: "assistant" });
      return { content: `Action plan set (${parsed.data.length} items).` };
    }

    case "generate_borrower_package": {
      const pkg = (input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {}) as Record<string, unknown>;
      if (Array.isArray(pkg.assetSummary)) {
        // Document access links are generated server-side; never trust
        // model-authored URLs (same rule as the old parser).
        pkg.assetSummary = pkg.assetSummary.map((a) =>
          a && typeof a === "object" ? { ...(a as Record<string, unknown>), accessLink: "" } : a,
        );
      }
      const parsed = borrowerPackageSchema.safeParse(pkg);
      if (!parsed.success) {
        return { content: `Invalid borrower package — ${zodIssueSummary(parsed.error)}.`, isError: true };
      }
      ctx.state.borrowerPackage = parsed.data;
      ctx.emit({ type: "panel", borrowerPackage: parsed.data });
      return { content: "Borrower package generated and shown to the user." };
    }

    case "suggest_next_steps": {
      const suggestions = (input as { suggestions?: unknown })?.suggestions;
      const parsed = z.array(z.string().min(1).max(80)).min(1).max(3).safeParse(suggestions);
      if (!parsed.success) {
        return { content: `Invalid suggestions — ${zodIssueSummary(parsed.error)}.`, isError: true };
      }
      ctx.state.suggestions = parsed.data;
      ctx.emit({ type: "panel", suggestions: parsed.data });
      return { content: "Suggestions shown." };
    }

    case "lookup_dpa_programs": {
      const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
      const parsed = z
        .object({
          state: z.string().trim().toUpperCase().length(2).optional(),
          firstTimeBuyer: z.boolean().optional(),
        })
        .safeParse(raw);
      if (!parsed.success) {
        return { content: `Invalid DPA lookup — ${zodIssueSummary(parsed.error)}.`, isError: true };
      }
      try {
        // Read-only over the seed-verified directory (same rows the public
        // /down-payment-wizard shows) — the coach's only DPA knowledge source.
        const programs = await storage.getDpaPrograms(parsed.data);
        if (programs.length === 0) {
          return {
            content:
              "No matching programs. The directory currently lists Illinois programs only (verified as of July 2026) — do NOT invent programs for other states; point the user to their state's housing finance agency or a HUD-approved housing counselor instead.",
          };
        }
        const lines = programs.map((p) => {
          const cap = p.maxAssistancePercent
            ? `up to ${p.maxAssistancePercent}% (max $${Number(p.maxAssistanceAmount).toLocaleString()})`
            : `up to $${Number(p.maxAssistanceAmount).toLocaleString()}`;
          const credit = p.minCreditScore ? `; published minimum credit score ${p.minCreditScore}` : "";
          const ftb = p.firstTimeBuyerOnly ? "; first-time buyers only" : "";
          return `- ${p.name} (${p.programType}, ${p.assistanceType}, ${p.state ?? "nationwide"}): ${cap}${credit}${ftb}. ${p.description} Eligibility notes: ${p.eligibilityNotes ?? "see agency"}. Application: ${p.applicationUrl ?? "via the administering agency"}`;
        });
        return {
          content:
            `${programs.length} verified program(s):\n${lines.join("\n")}\n` +
            "Present these as educational information. Terms change and funding can pause — tell the user to confirm current details with the administering agency or a HUD-approved housing counselor, and do not state or imply that they qualify.",
        };
      } catch (err) {
        console.error("[Coach] DPA lookup failed:", err);
        return { content: "The DPA directory is temporarily unavailable — say so; do not answer from memory.", isError: true };
      }
    }

    case "get_loan_status": {
      const truth = await loadTruthForTool(ctx);
      if (truth === "no_application") {
        return {
          content:
            "This borrower has no application in progress, so there is no status to report. " +
            "Say so plainly and offer to help them start one — do NOT describe a stage.",
        };
      }
      if (truth === "unavailable") return FILE_TRUTH_UNAVAILABLE;

      const { status } = truth;
      ctx.emit({ type: "panel", loanStatus: status, source: "file" });

      const lines: string[] = [];
      if (status.stage) {
        lines.push(`Stage: ${status.stage.label} — ${status.stage.description}`);
        lines.push(`Journey progress: ${status.stage.progressPercent}% (phase: ${status.stage.phase})`);
      }
      if (status.pipeline) {
        lines.push(`Day ${status.pipeline.daysInPipeline} in process.`);
        lines.push(
          `Conditions: ${status.pipeline.conditionsTotal - status.pipeline.conditionsOutstanding} of ` +
            `${status.pipeline.conditionsTotal} cleared (${status.pipeline.conditionsOutstanding} outstanding).`,
        );
      }
      for (const step of status.journey) {
        lines.push(`${step.stepId}: ${step.lines.join("; ")}`);
      }
      if (status.nextAction) {
        lines.push(
          `Next action for the borrower: ${status.nextAction.title} — ${status.nextAction.description} ` +
            `(${status.nextAction.href})`,
        );
      }
      return {
        content:
          `${lines.join("\n")}\n` +
          "State ONLY these facts. Do not estimate or promise a closing date, and do not " +
          "characterize the file as fast, slow, on track, or at risk — none of that is in this data.",
      };
    }

    case "get_document_checklist": {
      const parsed = z
        .object({ filter: z.enum(["needed", "rejected", "all"]).optional() })
        .safeParse(input && typeof input === "object" ? input : {});
      if (!parsed.success) {
        return { content: `Invalid checklist filter — ${zodIssueSummary(parsed.error)}.`, isError: true };
      }

      const truth = await loadTruthForTool(ctx);
      if (truth === "no_application") {
        return {
          content:
            "No application yet, so there is no personalized checklist. Explain what lenders " +
            "typically ask for in general terms, and do NOT present a list as if it were theirs.",
        };
      }
      if (truth === "unavailable") return FILE_TRUTH_UNAVAILABLE;

      const { documents, stats } = truth.checklist;
      const filter = parsed.data.filter ?? "all";
      const shown = filter === "all"
        ? documents
        : documents.filter((d) => (filter === "needed" ? d.status === "needed" : d.status === "rejected"));

      // The client gets the FULL list either way — the panel is the borrower's
      // real checklist, byte-identical to what their Documents page renders.
      // Only the model's summary is filtered and capped.
      ctx.emit({ type: "panel", documentChecklist: documents, checklistStats: stats, source: "file" });

      if (shown.length === 0) {
        return {
          content:
            `Nothing matches "${filter}". Totals: ${stats.total} items — ${stats.verified} verified, ` +
            `${stats.uploaded} in review, ${stats.needed} still needed, ${stats.rejected} rejected.`,
        };
      }

      // Rejected first. The list is capped at MODEL_CHECKLIST_CAP and read in
      // order, and a rejection is the only item where the borrower is BLOCKED
      // — leaving it eighth behind seven "needed" rows is how its reason gets
      // summarized away. Ordering by what matters beats asking the model to
      // remember what mattered.
      const ordered = [...shown].sort((a, b) => {
        const rank = (s: string) => (s === "rejected" ? 0 : s === "needed" ? 1 : 2);
        return rank(a.status) - rank(b.status);
      });
      const rendered = ordered.slice(0, MODEL_CHECKLIST_CAP).map((d) => {
        const why = d.description ? ` Why: ${d.description}` : "";
        const rejected = d.status === "rejected" && d.rejectionReason
          ? ` MUST FIX: ${d.rejectionReason}`
          : "";
        const year = d.documentYear ? ` (${d.documentYear})` : "";
        return `- ${d.label}${year} [${d.status}]${why}${rejected}`;
      });
      const overflow = ordered.length > MODEL_CHECKLIST_CAP
        ? `\n…and ${ordered.length - MODEL_CHECKLIST_CAP} more (all of them are shown to the borrower in the checklist panel).`
        : "";

      // A rejected item is the only place on this list where the borrower is
      // BLOCKED and cannot self-diagnose: the file is uploaded, so it looks
      // done, and only the reviewer's reason says why it bounced. Measured at
      // roughly a coin flip without this line, so it is stated where the model
      // reads it last rather than only in the system prompt.
      const rejectedNote = stats.rejected > 0
        ? "\nOne or more items were REJECTED. You MUST tell the user the exact reason shown above " +
          "for each one — it is the only thing standing between them and clearing it, and they " +
          "cannot work it out from the file itself. Never report a rejection without its reason."
        : "";
      return {
        content:
          `${stats.total} items — ${stats.verified} verified, ${stats.uploaded} in review, ` +
          `${stats.needed} needed, ${stats.rejected} rejected.\n${rendered.join("\n")}${overflow}\n` +
          "These are the borrower's REAL requirements. Name only what is listed here; never add a " +
          "document that is not on it, and never tell them an item is done when its status says otherwise." +
          rejectedNote,
      };
    }

    case "get_borrower_tasks": {
      const parsed = z
        .object({ includeCompleted: z.boolean().optional() })
        .safeParse(input && typeof input === "object" ? input : {});
      if (!parsed.success) {
        return { content: `Invalid task filter — ${zodIssueSummary(parsed.error)}.`, isError: true };
      }

      const truth = await loadTruthForTool(ctx);
      if (truth === "no_application") {
        return { content: "No application yet, so there are no tasks on file." };
      }
      if (truth === "unavailable") return FILE_TRUTH_UNAVAILABLE;

      // Already masked through borrowerTaskView in loadFileTruth — the raw rows
      // carry staff notes and escalation internals and never reach this point.
      const all = truth.tasks;
      const shown = parsed.data.includeCompleted
        ? all
        : all.filter((t) => t.status !== "COMPLETED" && t.status !== "EXPIRED");

      ctx.emit({ type: "panel", tasks: shown, source: "file" });

      if (shown.length === 0) {
        return { content: "No open tasks — nothing is waiting on the borrower outside the document checklist." };
      }
      const rendered = shown.slice(0, MODEL_TASK_CAP).map((t) => {
        const label = t.title ?? t.borrowerDisplayText ?? "Task";
        return `- ${label} [${t.status}]`;
      });
      const overflow = shown.length > MODEL_TASK_CAP
        ? `\n…and ${shown.length - MODEL_TASK_CAP} more.`
        : "";
      return { content: `${shown.length} open task(s):\n${rendered.join("\n")}${overflow}` };
    }

    case "request_human_help": {
      const parsed = z.object({
        topic: z.enum([
          "complex_income",
          "document_question",
          "application_status",
          "loan_options",
          "technical_help",
          "other",
        ]),
      }).strict().safeParse(input);
      if (!parsed.success) {
        return { content: `Invalid human-help request — ${zodIssueSummary(parsed.error)}.`, isError: true };
      }
      if (ctx.state.humanHelpRequest) {
        return {
          content:
            "A human follow-up was already handled in this turn. Tell the borrower the request is active; do not create or promise another callback.",
        };
      }
      const truth = await loadTruthForTool(ctx);
      if (truth === "no_application") {
        return {
          content:
            "There is no application in progress to route to a loan team. Tell the borrower to start an application or use the public contact option; do not promise a callback.",
          isError: true,
        };
      }
      if (truth === "unavailable") return FILE_TRUTH_UNAVAILABLE;

      try {
        const existingTasks = await storage.getTasksByApplication(ctx.workableApplicationId!);
        const existing = existingTasks.find((task) => {
          const metadata = task.triggerMetadata as Record<string, unknown> | null;
          return ACTIVE_TASK_STATUSES.includes(task.status) && metadata?.source === "homi_handoff";
        });
        if (existing) {
          ctx.state.humanHelpRequest = { taskId: existing.id, alreadyOpen: true };
          return {
            content:
              "A human follow-up is already open with the loan team. Tell the borrower that the existing request is still active; do not create or promise a second callback.",
          };
        }

        const team = await storage.getDealTeamMembers(ctx.workableApplicationId!);
        const loanOfficer = team.find((member) => member.teamRole === "loan_officer" && member.isActive);
        const task = await taskEngine.createTask({
          applicationId: ctx.workableApplicationId!,
          assignedToUserId: loanOfficer?.userId ?? null,
          title: "Borrower requested human help through Homi",
          description: `Topic: ${parsed.data.topic.replace(/_/g, " ")}`,
          taskType: "follow_up",
          taskTypeCode: "FOLLOW_UP",
          ownerRole: "LO",
          priority: parsed.data.topic === "complex_income" ? "high" : "normal",
        }, ctx.userId, "SYSTEM", {
          source: "homi_handoff",
          conversationId: ctx.conversationId,
          turnId: ctx.turnId,
          topic: parsed.data.topic,
        });
        ctx.state.humanHelpRequest = { taskId: task.id, alreadyOpen: false };
        // A later task read in this turn must include the newly-created item.
        ctx.fileTruthCache = undefined;
        await emitEvent("borrower", "homi_human_help_requested", {
          applicationId: ctx.workableApplicationId!,
          userId: ctx.userId,
          actorId: ctx.userId,
          actorRole: ctx.userRole,
          entityType: "task",
          entityId: task.id,
          textValue: parsed.data.topic,
          source: "homi",
        });
        return {
          content:
            "The human follow-up is now on the loan officer work queue. Tell the borrower the request was sent and that they can continue using their secure file while the team responds. Do not invent a response time.",
        };
      } catch (error) {
        console.error("[Coach] Human handoff failed:", error);
        return {
          content:
            "The human follow-up could not be placed on the loan team's queue. Say that clearly and direct the borrower to secure Messages; do not claim that anyone was notified.",
          isError: true,
        };
      }
    }

    case "get_document_evidence": {
      const evidence = await loadEvidenceForTool(ctx);
      if (evidence === "no_application") {
        return {
          content:
            "This borrower has no application in progress, so there is no application document evidence to report. " +
            "Say so plainly; do not describe hypothetical extraction as if it ran.",
        };
      }
      if (evidence === "unavailable") return FILE_TRUTH_UNAVAILABLE;
      if (evidence.documents.length === 0) {
        return {
          content:
            "No current accepted or pending-review document has extracted financial evidence on this application. " +
            `Financial package review: ${evidence.financialReview.status}. ` +
            "Do not say OCR failed; no safe extracted facts are available to this tool.",
        };
      }

      const lines = evidence.documents.map((document) => {
        const facts = document.facts.length > 0
          ? document.facts.map((fact) => {
              const value = fact.format === "currency"
                ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(fact.value)
                : String(fact.value);
              const review = fact.reviewStatus === "human_verified"
                ? "human verified"
                : `machine read; ${fact.confidence} confidence${fact.needsHumanReview ? "; needs human review" : ""}`;
              return `${fact.label}: ${value} (${review}${fact.pageNumber ? `; source page ${fact.pageNumber}` : ""})`;
            }).join("; ")
          : "no allowlisted financial facts extracted";
        const omitted = document.omittedFactCount > 0 ? `; ${document.omittedFactCount} additional fact(s) omitted from this bounded view` : "";
        return `- ${document.label} [document ${document.documentReviewStatus}; evidence ${document.evidenceStatus}]: ${facts}${omitted}`;
      });
      const packageLine = evidence.financialReview.status === "approved_for_lender_package"
        ? `Financial review: approved for lender presentation (income ${evidence.financialReview.income}; assets ${evidence.financialReview.assets}).`
        : "Financial review: no current fully approved lender-package memo. Extracted figures remain evidence for review, not qualifying income or an approval decision.";
      const documentScope = evidence.summary.omittedDocumentCount > 0
        ? `${evidence.summary.documentCount} current document(s) shown; ${evidence.summary.omittedDocumentCount} additional current document(s) omitted from this bounded view`
        : `${evidence.summary.documentCount} current document(s) shown`;
      return {
        content:
          `${documentScope}; ${evidence.summary.extractedFactCount} safe financial fact(s); ` +
          `${evidence.summary.humanVerifiedFactCount} human verified; ${evidence.summary.factsNeedingHumanReview} need human review.\n` +
          `${lines.join("\n")}\n${packageLine}\n` +
          "State each value with the exact review label above. Confidence measures extraction certainty only. " +
          "A low-confidence fact needs STAFF review; do not ask the borrower to replace the document unless get_document_checklist says it was rejected. " +
          "When additional documents were omitted from this bounded view, do not claim that an unlisted document is absent; use get_document_checklist for receipt status. " +
          "Never turn gross income, AGI, gross pay, deposits, or rent into qualifying income unless a current approved workpaper explicitly supplies that conclusion.",
      };
    }

    default:
      return { content: `Unknown tool: ${name}`, isError: true };
  }
}

/** Caps so a long file cannot eat the second model call's input budget. */
const MODEL_CHECKLIST_CAP = 12;
const MODEL_TASK_CAP = 10;

/**
 * A tool asked for file truth and could not get it. Say so — an assistant that
 * fills the gap from memory is exactly the failure these tools exist to fix.
 */
const FILE_TRUTH_UNAVAILABLE: CoachToolResult = {
  content:
    "That information is temporarily unavailable. Tell the user you cannot read their file " +
    "right now and offer to try again — do NOT answer from memory or from earlier in this chat.",
  isError: true,
};

/**
 * Resolve the borrower's file for a read tool. Returns a discriminated result
 * rather than throwing, because "you have no application" and "I could not
 * load it" are different things the assistant must say differently.
 */
async function loadTruthForTool(
  ctx: CoachToolContext,
): Promise<FileTruth | "no_application" | "unavailable"> {
  if (!ctx.workableApplicationId) return "no_application";
  if (ctx.fileTruthCache) return ctx.fileTruthCache;
  try {
    const truth = await loadFileTruth(ctx.workableApplicationId, {
      id: ctx.userId,
      role: ctx.userRole,
    } as Pick<User, "id" | "role">);
    // A null here means the access check refused — treat it as unavailable, not
    // as "no application": we must never describe a file we could not authorize.
    const result = truth ?? "unavailable";
    ctx.fileTruthCache = result;
    return result;
  } catch (err) {
    console.error("[Coach] file-truth load failed:", err);
    ctx.fileTruthCache = "unavailable";
    return "unavailable";
  }
}

async function loadEvidenceForTool(
  ctx: CoachToolContext,
): Promise<CoachDocumentEvidenceSnapshot | "no_application" | "unavailable"> {
  if (!ctx.workableApplicationId) return "no_application";
  if (ctx.documentEvidenceCache) return ctx.documentEvidenceCache;
  try {
    const evidence = await loadCoachDocumentEvidence(ctx.workableApplicationId, {
      id: ctx.userId,
      role: ctx.userRole,
    } as Pick<User, "id" | "role">);
    const result = evidence ?? "unavailable";
    ctx.documentEvidenceCache = result;
    return result;
  } catch (err) {
    console.error("[Coach] document-evidence load failed:", err);
    ctx.documentEvidenceCache = "unavailable";
    return "unavailable";
  }
}
