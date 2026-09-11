// Verified-user context: types, readiness derivations, profile/tone/context prompt builders.
// Split from the old server/services/coachingService.ts — which re-exports it.
import { type CoachIntakeData, type CoachingProfile, type ActionPlanItem, type DocumentRequirement, type BorrowerPackage } from "./coachTools";
import type { FileTruth } from "./coachFileTruth";

// The coach data types + Zod schemas live in coachTools.ts (they define the
// tool surface); re-export them so this module's public API is unchanged for
// the route layer and any future consumers.
export {
  coachProfileSchema,
  coachIntakeSchema,
  coachActionPlanSchema,
  coachDocumentChecklistSchema,
  borrowerPackageSchema,
  COACH_TOOLS,
  type CoachingProfile,
  type ActionPlanItem,
  type DocumentRequirement,
  type CoachIntakeData,
  type BorrowerPackage,
  type CoachStreamEvent,
  type CoachEmit,
  type CoachToolTurnState,
} from "./coachTools";

export interface CoachResponse {
  message: string;
  profile?: CoachingProfile;
  intake?: CoachIntakeData;
  actionPlan?: ActionPlanItem[];
  documentChecklist?: DocumentRequirement[];
  borrowerPackage?: BorrowerPackage;
}

export type UserType = "renter" | "first_time_buyer" | "current_homeowner" | "affluent_borrower" | "investor";
export type ReadinessState = "not_started" | "intake_started" | "intake_complete" | "docs_uploaded" | "docs_validated" | "package_ready";

export interface VerifiedUserContext {
  hasApplication: boolean;
  applicationStatus?: string;
  /**
   * The file the assistant's server-truth tools may read — resolved with
   * `pickWorkableLoanApplication`, so never a denied/withdrawn/funded one.
   *
   * Deliberately NOT the same application the narrative context above is built
   * from. That one falls back to the most recent file of any status so the
   * assistant is never blind to history, which is right for prose and wrong
   * for a tool that tells a borrower which documents to upload — that is how
   * uploads once landed on a closed loan (see the selector's own docblock).
   */
  workableApplicationId?: string | null;
  /** Per-turn authorized snapshot, reused by server tools and never serialized wholesale. */
  fileTruth?: FileTruth;
  annualIncome?: string | null;
  monthlyDebts?: string | null;
  creditScore?: number | null;
  employmentType?: string | null;
  employmentYears?: number | null;
  employerName?: string | null;
  isVeteran?: boolean;
  isFirstTimeBuyer?: boolean;
  dtiRatio?: string | null;
  ltvRatio?: string | null;
  preApprovalAmount?: string | null;
  purchasePrice?: string | null;
  downPayment?: string | null;
  preferredLoanType?: string | null;
  propertyType?: string | null;
  loanPurpose?: string | null;
  employmentHistory?: Array<{
    employerName?: string | null;
    positionTitle?: string | null;
    isSelfEmployed?: boolean;
    startDate?: string | null;
    totalMonthlyIncome?: string | null;
  }>;
  /**
   * Additional income sources itemized inside annualIncome. These are
   * borrower-reported intake facts, never verified or qualifying income.
   */
  incomeSources?: Array<{
    type: string;
    annualAmount?: string | null;
    employerName?: string | null;
    yearsInRole?: string | null;
    businessStructure?: string | null;
    ownershipPercent?: string | null;
    rentalProperties?: Array<{
      address: string;
      monthlyRentalIncome?: string | null;
      monthlyDebtPayment?: string | null;
    }>;
  }>;
  uploadedDocuments?: Array<{
    documentType: string;
    status: string;
    uploadDate?: string | null;
    extractionConfidence?: "high" | "medium" | "low" | null;
  }>;
  userName?: string;
  userType?: UserType;
  readinessState?: ReadinessState;
  completionPercentage?: number;
  completedSteps?: string[];
  readinessTier?: string | null;
  previousReadinessTier?: string | null;
  previousCompletionPercentage?: number | null;
  outstandingInputs?: string[];
  completedInputs?: string[];
  documentsMissing?: string[];
  documentsUploaded?: number;
  documentsVerified?: number;
  daysSinceLastActivity?: number | null;
  engagementLevel?: string | null;
  propertiesViewed?: number;
  suggestedNextAction?: string | null;
  hasMultipleIncomes?: boolean;
  hasBusinessIncome?: boolean;
  hasInvestmentProperties?: boolean;
  /** Only a current approved financial memo may set this true. */
  financialPackageApproved?: boolean;
  propertyContext?: {
    price: number;
    address: string;
  } | null;
}

export function deriveUserType(ctx: VerifiedUserContext): UserType {
  if (ctx.hasInvestmentProperties) return "investor";
  if (ctx.hasMultipleIncomes || ctx.hasBusinessIncome) return "affluent_borrower";
  if (ctx.loanPurpose === "refinance" || ctx.loanPurpose === "cash_out") return "current_homeowner";
  if (ctx.isFirstTimeBuyer) return "first_time_buyer";
  if (!ctx.hasApplication) return "renter";
  return "first_time_buyer";
}

export function deriveReadinessState(ctx: VerifiedUserContext): ReadinessState {
  if (!ctx.hasApplication) return "not_started";

  const hasVerifiedDocs = ctx.documentsVerified !== undefined && ctx.documentsVerified > 0;
  const hasUploadedDocs = ctx.documentsUploaded !== undefined && ctx.documentsUploaded > 0;
  const noMissingDocs = !ctx.documentsMissing || ctx.documentsMissing.length === 0;
  const hasFinancials = !!(ctx.annualIncome && ctx.creditScore && ctx.monthlyDebts && ctx.employmentType);

  if (ctx.financialPackageApproved === true && hasFinancials && hasVerifiedDocs && noMissingDocs) return "package_ready";
  if (hasVerifiedDocs) return "docs_validated";
  if (hasUploadedDocs) return "docs_uploaded";
  if (hasFinancials) return "intake_complete";
  return "intake_started";
}

export function deriveCompletedSteps(ctx: VerifiedUserContext): string[] {
  const steps: string[] = [];
  if (ctx.employmentType) steps.push("employment_type");
  if (ctx.annualIncome) steps.push("annual_income");
  if (ctx.creditScore) steps.push("credit_score");
  if (ctx.monthlyDebts) steps.push("monthly_debts");
  if (ctx.purchasePrice) steps.push("purchase_price");
  if (ctx.downPayment) steps.push("down_payment");
  if (ctx.propertyType) steps.push("property_type");
  if (ctx.loanPurpose) steps.push("loan_purpose");
  if (ctx.isVeteran !== undefined) steps.push("veteran_status");
  if (ctx.employmentYears) steps.push("employment_years");
  if (ctx.employerName) steps.push("employer_name");
  if (ctx.uploadedDocuments && ctx.uploadedDocuments.length > 0) {
    for (const doc of ctx.uploadedDocuments) {
      steps.push(`doc_uploaded:${doc.documentType}`);
    }
  }
  return steps;
}

export function deriveCompletionPercentage(ctx: VerifiedUserContext): number {
  if (!ctx.hasApplication) return 0;
  const coreFields = [
    ctx.employmentType,
    ctx.annualIncome,
    ctx.creditScore,
    ctx.monthlyDebts,
    ctx.purchasePrice,
    ctx.downPayment,
    ctx.propertyType,
    ctx.loanPurpose,
  ];
  const filledCore = coreFields.filter(Boolean).length;
  const coreWeight = 60;
  const corePercent = (filledCore / coreFields.length) * coreWeight;

  const docWeight = 30;
  const uploaded = ctx.documentsUploaded || 0;
  const verified = ctx.documentsVerified || 0;
  const missing = ctx.documentsMissing?.length || 0;
  const totalDocs = uploaded + missing;
  const docPercent = totalDocs > 0
    ? ((verified * 1.0 + (uploaded - verified) * 0.7) / totalDocs) * docWeight
    : 0;

  const verificationWeight = 10;
  const hasVerifiedDocs = (ctx.documentsVerified || 0) > 0;
  const noMissingDocs = !ctx.documentsMissing || ctx.documentsMissing.length === 0;
  const hasFinancials = !!(ctx.annualIncome && ctx.creditScore && ctx.monthlyDebts && ctx.employmentType);
  let verificationPercent = 0;
  if (hasFinancials && hasVerifiedDocs && noMissingDocs) verificationPercent = verificationWeight;
  else if (hasVerifiedDocs) verificationPercent = verificationWeight * 0.7;
  else if (hasFinancials) verificationPercent = verificationWeight * 0.3;

  return Math.min(100, Math.round(corePercent + docPercent + verificationPercent));
}

function buildUserProfileHeader(ctx: VerifiedUserContext): string {
  const lines: string[] = [];
  lines.push("\n\n=== USER PROFILE ===");

  const userTypeLabels: Record<UserType, string> = {
    renter: "Renter (no current homeownership)",
    first_time_buyer: "First-Time Buyer",
    current_homeowner: "Current Homeowner (refinance or equity access)",
    affluent_borrower: "Affluent/Complex Borrower (multiple income sources or business income)",
    investor: "Investor (investment properties)",
  };

  const readinessStateLabels: Record<ReadinessState, string> = {
    not_started: "Not Started — intake has not begun",
    intake_started: "Intake Started — some financial information provided, more required",
    intake_complete: "Intake Complete — core financial inputs collected, documents needed",
    docs_uploaded: "Documents Uploaded — awaiting validation",
    docs_validated: "Documents Validated — verified against inputs",
    package_ready: "Package Preparation Approved — a current financial review has approved the file for package preparation",
  };

  if (ctx.userName) lines.push(`Name: ${ctx.userName}`);
  lines.push(`User Type: ${userTypeLabels[ctx.userType || "renter"]}`);
  lines.push(`Readiness State: ${readinessStateLabels[ctx.readinessState || "not_started"]}`);
  lines.push(`Completion: ${ctx.completionPercentage || 0}%`);

  if (ctx.completedSteps && ctx.completedSteps.length > 0) {
    lines.push(`\nCOMPLETED STEPS (DO NOT ask for these again):`);
    for (const step of ctx.completedSteps) {
      lines.push(`  - ${step}`);
    }
  }

  if (ctx.documentsMissing && ctx.documentsMissing.length > 0) {
    lines.push(`\nMISSING INPUTS (recommend the FIRST one only):`);
    for (const doc of ctx.documentsMissing) {
      lines.push(`  - ${doc}`);
    }
  }

  lines.push("\nCRITICAL: Never repeat a completed step. Never ask for information already provided. Use this profile to identify ONLY the next missing input.");

  return lines.join("\n");
}

function buildToneDirective(ctx: VerifiedUserContext): string {
  const userType = ctx.userType || "renter";
  const state = ctx.readinessState || "not_started";

  if (userType === "affluent_borrower" || userType === "investor") {
    return "\n\nTONE: Professional, efficient, precise. This user is financially sophisticated. Minimize basic explanations. Focus on organization, speed, and completeness. Respect their time.";
  }

  if (userType === "first_time_buyer" || userType === "renter") {
    if (state === "not_started" || state === "intake_started") {
      return "\n\nTONE: Warm, patient, encouraging. This user is new to the mortgage process. Explain concepts simply. Break complex requirements into small steps. Celebrate progress.";
    }
    if (state === "intake_complete" || state === "docs_uploaded") {
      return "\n\nTONE: Supportive and focused. The user has made real progress. Acknowledge what they've accomplished and guide them through the document phase with clear, specific instructions.";
    }
  }

  if (state === "package_ready") {
    return "\n\nTONE: Confident and reassuring. This user's package is complete. Reinforce that their preparation has been thorough and explain next steps clearly.";
  }

  return "\n\nTONE: Calm, neutral, and supportive. Focus on clarity and reducing friction.";
}

export function buildVerifiedContextPrompt(ctx: VerifiedUserContext): string {
  if (!ctx.hasApplication) {
    const greeting = ctx.userName ? `The user's name is ${ctx.userName}.` : "";
    let noAppContext = buildUserProfileHeader(ctx);
    noAppContext += `\n\n${greeting} This user has not yet submitted a loan application. Focus on collecting the first required inputs for underwriting readiness.`;
    noAppContext += buildToneDirective(ctx);
    noAppContext += `\n\nIMPORTANT: Any financial information this user shares in chat is SELF-REPORTED and UNVERIFIED. Treat it as approximate and advisory. Do NOT use self-reported chat data as definitive fact. Always recommend they provide documentation to verify their claims.`;

    if (ctx.propertyContext) {
      noAppContext += `\n\n=== PROPERTY CONTEXT ===\nThe user is asking about a specific property: ${ctx.propertyContext.address}\nListed Price: $${ctx.propertyContext.price.toLocaleString()}\nFocus your guidance on this property. Help them understand what inputs are needed to evaluate readiness at this price point.`;
    }

    return noAppContext;
  }

  const lines: string[] = [];
  lines.push(buildUserProfileHeader(ctx));
  lines.push(buildToneDirective(ctx));

  lines.push("\n\n=== TIER 2: APPLICATION DATA (MEDIUM TRUST) ===");
  lines.push("This data comes from the user's loan application form. It is self-reported but formally submitted. Compare it with available source documents and prefer a human-reviewed workpaper for any qualifying figure.");
  if (ctx.workableApplicationId === null) {
    lines.push(`Most Recent Historical Application Status: ${ctx.applicationStatus}`);
    lines.push("There is no application currently in progress. Do not present this historical file as an active application or offer file actions against it.");
  } else {
    lines.push(`Application Status: ${ctx.applicationStatus}`);
  }

  if (ctx.userName) lines.push(`Borrower Name: ${ctx.userName}`);
  if (ctx.annualIncome) lines.push(`Annual Income: $${parseFloat(ctx.annualIncome).toLocaleString()}`);
  if (ctx.monthlyDebts) lines.push(`Monthly Debts: $${parseFloat(ctx.monthlyDebts).toLocaleString()}`);
  if (ctx.creditScore) lines.push(`Credit Score: ${ctx.creditScore}`);
  if (ctx.employmentType) lines.push(`Employment Type: ${ctx.employmentType}`);
  if (ctx.employmentYears) lines.push(`Years Employed: ${ctx.employmentYears}`);
  if (ctx.employerName) lines.push(`Employer: ${ctx.employerName}`);
  if (ctx.isVeteran) lines.push(`Veteran Status: Yes`);
  if (ctx.isFirstTimeBuyer) lines.push(`First-Time Buyer: Yes`);
  if (ctx.dtiRatio) lines.push(`DTI Ratio: ${ctx.dtiRatio}%`);
  if (ctx.ltvRatio) lines.push(`LTV Ratio: ${ctx.ltvRatio}%`);
  if (ctx.preApprovalAmount) lines.push(`Pre-Approval Amount: $${parseFloat(ctx.preApprovalAmount).toLocaleString()}`);
  if (ctx.purchasePrice) lines.push(`Target Purchase Price: $${parseFloat(ctx.purchasePrice).toLocaleString()}`);
  if (ctx.downPayment) lines.push(`Down Payment: $${parseFloat(ctx.downPayment).toLocaleString()}`);
  if (ctx.preferredLoanType) lines.push(`Preferred Loan Type: ${ctx.preferredLoanType}`);
  if (ctx.propertyType) lines.push(`Property Type: ${ctx.propertyType}`);
  if (ctx.loanPurpose) lines.push(`Loan Purpose: ${ctx.loanPurpose}`);

  if (ctx.employmentHistory && ctx.employmentHistory.length > 0) {
    lines.push("\nEmployment History:");
    for (const emp of ctx.employmentHistory) {
      const parts = [];
      if (emp.employerName) parts.push(emp.employerName);
      if (emp.positionTitle) parts.push(emp.positionTitle);
      if (emp.isSelfEmployed) parts.push("(Self-Employed)");
      if (emp.startDate) parts.push(`since ${emp.startDate}`);
      if (emp.totalMonthlyIncome) parts.push(`$${parseFloat(emp.totalMonthlyIncome).toLocaleString()}/month`);
      lines.push(`  - ${parts.join(" | ")}`);
    }
  }

  if (ctx.incomeSources && ctx.incomeSources.length > 0) {
    lines.push("\nAdditional Income Sources Itemized Within the Household Total (borrower-reported; unverified):");
    for (const source of ctx.incomeSources) {
      const parts = [`type: ${source.type}`];
      if (source.annualAmount) parts.push(`reported annual amount: $${parseFloat(source.annualAmount).toLocaleString()}`);
      if (source.employerName) parts.push(`business/payer: ${source.employerName}`);
      if (source.yearsInRole) parts.push(`history: ${source.yearsInRole} years`);
      if (source.businessStructure) parts.push(`structure: ${source.businessStructure}`);
      if (source.ownershipPercent) parts.push(`ownership: ${source.ownershipPercent}%`);
      lines.push(`  - ${parts.join(" | ")}`);
      for (const rental of source.rentalProperties ?? []) {
        const rentalParts = [`property: ${rental.address}`];
        if (rental.monthlyRentalIncome) rentalParts.push(`reported gross rent: $${parseFloat(rental.monthlyRentalIncome).toLocaleString()}/month`);
        if (rental.monthlyDebtPayment) rentalParts.push(`reported property payment: $${parseFloat(rental.monthlyDebtPayment).toLocaleString()}/month`);
        lines.push(`      - ${rentalParts.join(" | ")}`);
      }
    }
    lines.push("The source amounts above are components of Annual Income, not amounts to add to it. They remain self-reported until a human-reviewed workpaper determines qualifying income.");
  }

  if (ctx.uploadedDocuments && ctx.uploadedDocuments.length > 0) {
    lines.push("\nDocuments Already Uploaded (with review signals):");
    const today = new Date();
    for (const doc of ctx.uploadedDocuments) {
      const parts = [`${doc.documentType}: ${doc.status}`];

      if (doc.uploadDate) {
        const uploadDate = new Date(doc.uploadDate);
        const daysSinceUpload = Math.floor((today.getTime() - uploadDate.getTime()) / (1000 * 60 * 60 * 24));
        parts.push(`uploaded ${daysSinceUpload} days ago (${doc.uploadDate})`);
      }

      if (doc.extractionConfidence) {
        parts.push(`extraction: ${doc.extractionConfidence}`);
        if (doc.extractionConfidence === "low") {
          parts.push("⚠ STAFF REVIEW: low extraction confidence; borrower action is needed only if the real checklist reports this document rejected");
        }
      }

      lines.push(`  - ${parts.join(" | ")}`);
    }
    lines.push("\nUse get_document_evidence before stating what OCR found or whether a value was verified. Low extraction confidence routes to staff review; request another upload only when get_document_checklist reports a rejection and its reason.");
  }

  lines.push("\n\n=== TIER 4: CHAT INPUT (LOWEST TRUST — TREAT WITH CAUTION) ===");
  lines.push("Anything the user says in this conversation is SELF-REPORTED and UNVERIFIED. It is the LEAST reliable data source.");
  lines.push("RULES FOR HANDLING CHAT INPUT:");
  lines.push("- NEVER treat chat-reported numbers as fact. Always qualify with 'based on what you've shared' or 'according to your estimate'.");
  lines.push("- If chat input conflicts with provisional extraction, name both as unverified and route the discrepancy to review. Never declare the machine value correct merely because it came from a document.");
  lines.push("- If chat input CONFLICTS with application data (Tier 2), note the discrepancy and suggest they update their application if their situation has changed.");
  lines.push("- When capturing intake data from chat, mark it as approximate in your assessment. Encourage the user to upload supporting documents to verify.");
  lines.push("- For income: use the current approved qualifying-income workpaper when supplied; no single raw tax-return or pay-stub line is automatically qualifying income.");
  lines.push("- For assets: use reviewer-confirmed current balances and sourcing conclusions when supplied; chat claims remain estimates.");

  if (ctx.workableApplicationId !== null && ctx.completionPercentage !== undefined && ctx.completionPercentage !== null) {
    lines.push("\n\n=== READINESS CONTEXT (from Borrower Graph) ===");
    lines.push(`Current Completion Percentage: ${ctx.completionPercentage}/100`);
    if (ctx.readinessTier) lines.push(`Readiness Tier: ${ctx.readinessTier}`);
    if (ctx.completedInputs && ctx.completedInputs.length > 0) {
      lines.push(`Completed Inputs: ${ctx.completedInputs.join(", ")}`);
    }
    if (ctx.outstandingInputs && ctx.outstandingInputs.length > 0) {
      lines.push(`Outstanding Inputs: ${ctx.outstandingInputs.join(", ")}`);
    }
    if (ctx.documentsMissing && ctx.documentsMissing.length > 0) {
      lines.push(`Missing Documents: ${ctx.documentsMissing.join(", ")}`);
    }
    if (ctx.documentsUploaded !== undefined) {
      lines.push(`Documents Uploaded: ${ctx.documentsUploaded}${ctx.documentsVerified !== undefined ? ` (${ctx.documentsVerified} verified)` : ""}`);
    }
    lines.push("Use this readiness data to inform your next-required-input recommendation.");
  }

  if (ctx.previousReadinessTier && ctx.readinessTier && ctx.previousReadinessTier !== ctx.readinessTier) {
    const tierOrder = ["exploring", "building", "almost_ready", "ready_now"];
    const prevIdx = tierOrder.indexOf(ctx.previousReadinessTier);
    const currIdx = tierOrder.indexOf(ctx.readinessTier);
    const direction = currIdx > prevIdx ? "ADVANCED" : "MOVED BACK";
    lines.push(`\n\n⚑ READINESS TRANSITION DETECTED: User ${direction} from "${ctx.previousReadinessTier}" to "${ctx.readinessTier}".`);
    if (ctx.previousCompletionPercentage !== undefined && ctx.previousCompletionPercentage !== null && ctx.completionPercentage !== undefined) {
      lines.push(`Completion changed from ${ctx.previousCompletionPercentage}% to ${ctx.completionPercentage}%.`);
    }
    lines.push("You MUST lead your response with a transition acknowledgment using the Readiness Transition Communication format (Section 10):");
    lines.push("1. Explain what changed — name specific inputs or documents");
    lines.push("2. Why it matters for underwriting preparation — frame as input completeness, not approval likelihood");
    lines.push("3. What remains outstanding — list specific gaps");
    lines.push("4. The single next required input");
    lines.push("Do NOT use scoring language that implies approval. Frame progress as 'completeness of required inputs' not 'likelihood of approval.'");
  }

  if (ctx.daysSinceLastActivity !== undefined && ctx.daysSinceLastActivity !== null) {
    lines.push("\n\n=== BEHAVIORAL CONTEXT ===");
    lines.push(`Days Since Last Activity: ${ctx.daysSinceLastActivity}`);
    if (ctx.engagementLevel) lines.push(`Engagement Level: ${ctx.engagementLevel}`);
    if (ctx.propertiesViewed !== undefined) lines.push(`Properties Viewed: ${ctx.propertiesViewed}`);
    if (ctx.suggestedNextAction) lines.push(`System-Suggested Next Action: ${ctx.suggestedNextAction}`);
    if (ctx.daysSinceLastActivity > 7) {
      lines.push("⚑ STALL DETECTED — RETURN AFTER ABSENCE: This user has been away for over a week. Apply Section 7 (Behavioral Nudge Engine) RETURN AFTER ABSENCE protocol:");
      lines.push("- Lead with a warm welcome and their saved progress — do NOT reference the time gap as a problem");
      lines.push("- Name their completed steps specifically before mentioning any gaps");
      lines.push("- Frame the next step as 'picking up where we left off,' not 'catching up'");
      lines.push("- Use the smallest remaining input, not the most important one");
      lines.push("- FORBIDDEN: 'it's been a while,' 'we should get back on track,' urgency, fear, guilt, or sales language");
    } else if (ctx.daysSinceLastActivity > 2) {
      lines.push("NOTE: User has been away a few days. If they seem hesitant, apply Section 7 (Behavioral Nudge Engine) stall protocol: reinforce progress, identify smallest next step, frame as procedural.");
    }
  }

  if (ctx.hasMultipleIncomes || ctx.hasBusinessIncome || ctx.hasInvestmentProperties) {
    lines.push("\n\n=== ⚑ COMPLEX BORROWER FLAG — ACTIVATE SECTION 8 ===");
    const complexityFactors: string[] = [];
    if (ctx.hasMultipleIncomes) complexityFactors.push("MULTIPLE income sources (lenders typically request separate documentation per source)");
    if (ctx.hasBusinessIncome) complexityFactors.push("BUSINESS/SELF-EMPLOYMENT income (lenders typically request P&L, business tax returns, and stability documentation)");
    if (ctx.hasInvestmentProperties) complexityFactors.push("INVESTMENT/RENTAL property intent (lenders typically request additional reserve and rental income documentation)");
    lines.push("Detected complexity factors:");
    complexityFactors.forEach(f => lines.push(`- ${f}`));
    lines.push("ACTIVATE Section 8 (Affluent/Complex Borrower Mode):");
    lines.push("- Shift tone to PROFESSIONAL and EFFICIENT — this user likely understands financial concepts");
    lines.push("- REDUCE explanatory language — skip basics like 'DTI means...' or 'a lender will look at...'");
    lines.push("- EMPHASIZE document organization — proactively categorize their documents into lender-ready groups");
    lines.push("- Use precise, structured language — lists and categories over paragraphs");
    lines.push("- Acknowledge complexity without dramatizing it — 'Your profile has multiple income streams, so the documentation requirements are more detailed' not 'This is going to be complicated'");
  }

  if (ctx.propertyContext) {
    lines.push("\n\n=== PROPERTY CONTEXT ===");
    lines.push(`The user is asking about a specific property: ${ctx.propertyContext.address}`);
    lines.push(`Listed Price: $${ctx.propertyContext.price.toLocaleString()}`);
    lines.push("Focus your guidance on what inputs are still needed for underwriting readiness. Do not assess whether the user's financial profile supports this purchase price — that determination occurs during underwriting review.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Static system prompt — coach-2.0.0.
//
// Trimmed from coach-1.x: the ~165-line "STRUCTURED OUTPUT FORMAT" section
// (and the JSON-emission half of the Borrower Package Builder) is GONE —
// structured data now travels through typed tools (coachTools.ts), validated
// server-side. Sections keep their original numbers because the dynamic
// context block references them by number ("Section 7", "Section 8",
// "Section 10").

// ---------------------------------------------------------------------------
// Server-derived readiness profile
// ---------------------------------------------------------------------------

/**
 * The readiness panel, computed from the borrower's file instead of authored
 * by the model.
 *
 * `update_readiness` used to let the model write this. Half of it was already
 * server-owned — runCoachTurn overwrote completionPercentage before persisting,
 * so the model's number was discarded — and the rest (tier, completed inputs,
 * outstanding inputs) was ALREADY computed by buildBorrowerGraph and handed to
 * the model in its own context. The model was being asked to restate numbers
 * the server had just given it, and could restate them wrong.
 *
 * `estimatedTimeline` is the one field with no server equivalent, and that is
 * exactly why it is gone. A model-authored "1-3 months" on a mortgage file is
 * a forward-looking claim with no basis in any record, and the Reg N lexicon
 * does not catch it because it names no rate and promises no approval. It is
 * replaced by a neutral description of where the borrower actually is.
 *
 * Pure: no I/O, no clock, same context in → same profile out.
 */
export function deriveReadinessProfile(ctx: VerifiedUserContext): CoachingProfile {
  const completedInputs = ctx.completedInputs?.length
    ? ctx.completedInputs
    : deriveCompletedSteps(ctx);

  const tier = normalizeReadinessTier(ctx.readinessTier)
    ?? tierFromCompletion(ctx.completionPercentage ?? deriveCompletionPercentage(ctx));

  return {
    readinessTier: tier,
    completionPercentage: ctx.completionPercentage ?? deriveCompletionPercentage(ctx),
    statusNote: READINESS_STATUS_NOTES[deriveReadinessState(ctx)],
    completedInputs,
    outstandingInputs: ctx.outstandingInputs ?? [],
    // Deliberately not a duration. See the docblock above.
    estimatedTimeline: READINESS_TIER_CAPTIONS[tier],
  };
}

const READINESS_TIERS = ["ready_now", "almost_ready", "building", "exploring"] as const;
type ReadinessTier = (typeof READINESS_TIERS)[number];

function normalizeReadinessTier(value: string | null | undefined): ReadinessTier | null {
  return READINESS_TIERS.includes(value as ReadinessTier) ? (value as ReadinessTier) : null;
}

function tierFromCompletion(pct: number): ReadinessTier {
  if (pct >= 90) return "ready_now";
  if (pct >= 65) return "almost_ready";
  if (pct >= 25) return "building";
  return "exploring";
}

/** Where the borrower is, stated as fact. No pace, no prediction, no promise. */
const READINESS_STATUS_NOTES: Record<ReadinessState, string> = {
  not_started: "You haven't started an application yet — nothing here is on file.",
  intake_started: "We have some of your details. A few more inputs complete the picture underwriting needs.",
  intake_complete: "Your details are in. Documents are what turn them into something a lender can verify.",
  docs_uploaded: "Your documents are in and awaiting review.",
  docs_validated: "At least one requested document is verified. Financial and underwriting review remain separate steps.",
  package_ready: "A current financial review is approved for lender-package preparation.",
};

/**
 * Replaces the model's `estimatedTimeline`. Says what stage means, never how
 * long it takes — the server has no basis for a duration either, and inventing
 * one server-side would be the same lie in a more trustworthy voice.
 */
const READINESS_TIER_CAPTIONS: Record<ReadinessTier, string> = {
  ready_now: "Current intake and requested documents complete",
  almost_ready: "Nearly ready — a few inputs outstanding",
  building: "Building your file",
  exploring: "Getting started",
};
