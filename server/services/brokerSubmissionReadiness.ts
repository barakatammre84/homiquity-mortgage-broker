/**
 * Broker submission workflow — the operational pipeline for getting a loan
 * file from intake to a wholesale-lender submission.
 *
 * Homiquity operates as a BROKER: we originate and package the file; the
 * wholesale lender underwrites, closes, and (if selling to Fannie Mae) runs
 * loan delivery. The stages below reflect that division of labor:
 *
 *   1. intake            — URLA gating sections, TRID clock, e-disclosure
 *   2. aus               — a recorded dual-AUS run (DU + LPA) gates submission;
 *                          findings captured, recommendation quality advisory
 *   3. lenderPackage     — MISMO export validity, outstanding docs, QM
 *                          pre-flight, anti-steering disclosure (Reg Z
 *                          §1026.36(e)(3)) before options are locked
 *   4. deliveryPreflight — the Fannie Mae Loan Delivery / UCD / EarlyCheck
 *                          edit mirror (shared/fannieMae/) run as a lender's-
 *                          eye view of the file. INFORMATIONAL for a broker:
 *                          closing data belongs to the lender, so this stage
 *                          never blocks submission — it predicts what the
 *                          lender's own delivery checks will say.
 *
 * The stage derivation is a pure function (deriveSubmissionStages) so the
 * workflow decisions are unit-testable without a database.
 */

import { storage } from "../storage";
import { hasBorrowerConsent } from "../consentGate";
import { validateULDDCompliance, type ULDDValidationResult, type MISMOLoanDTO } from "../mismo";
import type { LoanDeliveryEditResult } from "@shared/fannieMae/loanDeliveryEdits";

export type StageStatus = "ready" | "blocked" | "attention" | "not_applicable";

export interface SubmissionStage {
  key: "intake" | "aus" | "lenderPackage" | "deliveryPreflight";
  label: string;
  status: StageStatus;
  blockers: string[];
  warnings: string[];
}

export interface BrokerSubmissionReadiness {
  applicationId: string;
  /** True when stages 1–3 are all ready: the file can go to a wholesale lender. */
  readyToSubmitToLender: boolean;
  currentStage: SubmissionStage["key"];
  stages: SubmissionStage[];
  nextActions: string[];
}

/** The URLA-validation subset the stage logic reads (from mismoValidation). */
export interface StageDerivationInputs {
  urla: {
    gseGatingFailed: boolean;
    criticalErrors: string[];
    missingDocuments: string[];
    qmStatus: "QM" | "Non-QM" | "Unknown";
    pointsAndFeesCompliant: boolean;
    tridStatus: {
      leRequired: boolean;
      leDueDate: Date | null;
      leIssued: boolean;
    };
  };
  uldd: Pick<ULDDValidationResult, "valid" | "errors" | "warnings">;
  aus: {
    casefileId: string | null;
    recommendation: string | null;
    /** True when the dual-AUS LPA leg produced findings for this casefile. */
    lpaAssessed: boolean;
    /** False when current borrower facts/evidence/policy no longer match the recorded run. */
    inputsCurrent?: boolean;
    staleReason?: string | null;
    decisionPath?: "automated" | "manual_underwrite";
  };
  consents: {
    eDisclosure: boolean;
    antiSteering: boolean;
  };
  deliveryEdits: Pick<LoanDeliveryEditResult, "deliverable"> & {
    fatalCount: number;
    warningCount: number;
    notEvaluatedCount: number;
  };
  /**
   * TRID change-of-circumstance state (Reg Z §1026.19(e)(3)(iv) / (e)(4)(i)).
   * An OPEN record past its revised-LE due date is a redisclosure failure —
   * the same hard-stop posture as an overdue original Loan Estimate.
   */
  changeOfCircumstance: {
    openCount: number;
    overdueRevisedLe: boolean;
  };
  /**
   * Income-analysis readiness (UAL P6). Only gates files that actually need
   * the income package — self-employment or a non-agency selected income path.
   * A clean wage-earner file is unaffected.
   */
  incomeAnalysis: {
    /** The file has SE employment or a selected non-agency income path. */
    requiresIncomePackage: boolean;
    /** A multi-path income evaluation has been produced (P3). */
    hasCurrentEvaluation: boolean;
    /** Open FLAGGED review-workbench items (P5) — contradictions a human must resolve. */
    openFlaggedReviewItems: number;
    /** The full current workpaper set and its lender-facing memo were approved. */
    hasCurrentApprovedMemo: boolean;
  };
  now?: Date;
}

export function deriveSubmissionStages(inputs: StageDerivationInputs): Omit<BrokerSubmissionReadiness, "applicationId"> {
  const now = inputs.now ?? new Date();
  const stages: SubmissionStage[] = [];

  // --- Stage 1: intake & disclosures -------------------------------------
  const intakeBlockers: string[] = [];
  const intakeWarnings: string[] = [];
  if (inputs.urla.gseGatingFailed) {
    intakeBlockers.push("Required URLA fields are missing in gating sections 1a/4/5");
  }
  if (inputs.urla.tridStatus.leRequired && !inputs.urla.tridStatus.leIssued) {
    const due = inputs.urla.tridStatus.leDueDate;
    if (due && now > due) {
      intakeBlockers.push("TRID: the Loan Estimate is past its 3-business-day delivery deadline");
    } else {
      intakeWarnings.push("TRID clock is running — the Loan Estimate has not been issued yet");
    }
  }
  if (!inputs.consents.eDisclosure) {
    intakeWarnings.push("No e-disclosure (ESIGN) consent on file — disclosures must go out on paper until captured");
  }
  // Change-of-circumstance redisclosure (Reg Z §1026.19(e)(4)(i)): an open
  // record past its 3-business-day revised-LE deadline blocks submission —
  // the same TRID posture as an overdue original LE above.
  if (inputs.changeOfCircumstance.overdueRevisedLe) {
    intakeBlockers.push(
      "TRID: a changed circumstance requires a revised Loan Estimate and its 3-business-day deadline has passed (Reg Z §1026.19(e)(4)(i)) — deliver the revised LE before this file can go to a wholesale lender",
    );
  } else if (inputs.changeOfCircumstance.openCount > 0) {
    intakeWarnings.push(
      `${inputs.changeOfCircumstance.openCount} open change(s) of circumstance — the revised Loan Estimate is due within 3 business days of the establishing information`,
    );
  }
  stages.push({
    key: "intake",
    label: "File intake & disclosures",
    status: intakeBlockers.length > 0 ? "blocked" : intakeWarnings.length > 0 ? "attention" : "ready",
    blockers: intakeBlockers,
    warnings: intakeWarnings,
  });

  // --- Stage 2: AUS --------------------------------------------------------
  const ausBlockers: string[] = [];
  const ausWarnings: string[] = [];
  if (inputs.urla.criticalErrors.length > 0) {
    ausBlockers.push(`${inputs.urla.criticalErrors.length} critical URLA/regulatory error(s) block AUS submission`);
  }
  // L1 §2: delivery gates submission until the AUS stage is clean — a file
  // with no recorded AUS run never goes to a wholesale lender.
  if (!inputs.aus.casefileId) {
    ausBlockers.push("No AUS run recorded — run DU / LPA before this file can go to a wholesale lender");
  } else if (!inputs.aus.recommendation) {
    ausBlockers.push("AUS casefile created but no recommendation captured — re-run DU / LPA to completion");
  } else if (inputs.aus.inputsCurrent === false) {
    ausBlockers.push(
      `Recorded AUS findings are stale — ${inputs.aus.staleReason ?? "borrower facts, evidence, verification, or policy changed"} Re-run DU / LPA before packaging.`,
    );
  }
  // Broker doctrine is dual AUS: flag DU-only casefiles (files run before
  // the LPA leg landed re-run through AUS to pick it up).
  if (inputs.aus.recommendation && !inputs.aus.lpaAssessed) {
    ausWarnings.push("LPA leg has not run for this casefile — re-run AUS for the dual-AUS view");
  }
  // Recommendation quality never blocks: a broker can still place refer /
  // ineligible files manually (non-QM lanes, manual underwrite) — L1 routes
  // ambiguity to humans, so the LO makes that call deliberately.
  const nonApproveRecommendations = ["approve_ineligible", "refer", "refer_with_caution"];
  if (inputs.aus.recommendation && nonApproveRecommendations.includes(inputs.aus.recommendation)) {
    ausWarnings.push(
      `AUS recommendation is ${inputs.aus.recommendation.replace(/_/g, " ")} — not Approve/Eligible; lender placement is a manual broker decision`,
    );
  }
  if (inputs.aus.decisionPath === "manual_underwrite") {
    ausWarnings.push("The local decision engine routed this file to manual underwriting; a licensed reviewer must document the placement decision.");
  }
  stages.push({
    key: "aus",
    label: "Automated underwriting (DU + LPA)",
    status: ausBlockers.length > 0 ? "blocked" : ausWarnings.length > 0 ? "attention" : "ready",
    blockers: ausBlockers,
    warnings: ausWarnings,
  });

  // --- Stage 3: wholesale lender package ----------------------------------
  const pkgBlockers: string[] = [];
  const pkgWarnings: string[] = [];
  if (!inputs.uldd.valid) {
    inputs.uldd.errors.forEach(e => pkgBlockers.push(`MISMO file: ${e}`));
  }
  inputs.uldd.warnings.forEach(w => pkgWarnings.push(`MISMO file: ${w}`));
  if (inputs.urla.missingDocuments.length > 0) {
    pkgBlockers.push(`${inputs.urla.missingDocuments.length} required document(s) outstanding: ${inputs.urla.missingDocuments.join(", ")}`);
  }
  if (!inputs.urla.pointsAndFeesCompliant) {
    pkgBlockers.push("QM pre-flight: points and fees exceed the Reg Z cap for this loan amount");
  } else if (inputs.urla.qmStatus === "Unknown") {
    pkgWarnings.push(
      "QM pre-flight inconclusive: the preliminary fee floor fits, but a conclusive points-and-fees figure is not yet computable from the file's fee itemization",
    );
  }
  if (!inputs.consents.antiSteering) {
    pkgBlockers.push("Anti-steering loan-options disclosure (Reg Z §1026.36(e)(3)) has not been acknowledged");
  }
  // Income analysis (UAL P6): a file that needs the cited income package must
  // carry a current evaluation and have no unresolved flagged review items
  // before it goes to a lender. Wage-earner files skip this entirely.
  if (inputs.incomeAnalysis.requiresIncomePackage) {
    if (!inputs.incomeAnalysis.hasCurrentEvaluation) {
      pkgBlockers.push(
        "Income analysis not yet run — a self-employed or non-agency file needs a multi-path income evaluation before the lender package can be assembled",
      );
    }
    if (inputs.incomeAnalysis.openFlaggedReviewItems > 0) {
      pkgBlockers.push(
        `${inputs.incomeAnalysis.openFlaggedReviewItems} flagged income review item(s) still open — resolve the extraction/tie-out contradictions before submitting`,
      );
    }
    if (!inputs.incomeAnalysis.hasCurrentApprovedMemo) {
      pkgBlockers.push(
        "Financial review is incomplete — approve every current workpaper and the current credit memo before submitting",
      );
    }
  }
  stages.push({
    key: "lenderPackage",
    label: "Wholesale lender package",
    status: pkgBlockers.length > 0 ? "blocked" : pkgWarnings.length > 0 ? "attention" : "ready",
    blockers: pkgBlockers,
    warnings: pkgWarnings,
  });

  // --- Stage 4: delivery pre-flight (informational) ------------------------
  const preflightWarnings: string[] = [];
  if (inputs.deliveryEdits.fatalCount > 0) {
    preflightWarnings.push(`${inputs.deliveryEdits.fatalCount} Loan Delivery/UCD edit(s) would fire at the lender's delivery — expect conditions`);
  }
  if (inputs.deliveryEdits.notEvaluatedCount > 0) {
    preflightWarnings.push(`${inputs.deliveryEdits.notEvaluatedCount} delivery check(s) awaiting closing-stage data (lender-side)`);
  }
  stages.push({
    key: "deliveryPreflight",
    label: "Delivery pre-flight (lender's-eye view)",
    // Never blocks a broker submission — closing data is the lender's.
    status: inputs.deliveryEdits.fatalCount > 0 ? "attention" : "ready",
    blockers: [],
    warnings: preflightWarnings,
  });

  const gatingStages = stages.slice(0, 3);
  const readyToSubmitToLender = gatingStages.every(s => s.status === "ready" || s.status === "attention")
    && gatingStages.every(s => s.blockers.length === 0);

  const currentStage = (stages.find(s => s.status === "blocked") ?? stages.find(s => s.status === "attention") ?? stages[2]).key;

  const nextActions = stages.flatMap(s =>
    s.blockers.map(b => `[${s.label}] ${b}`),
  );
  if (nextActions.length === 0 && readyToSubmitToLender) {
    nextActions.push("File is packaging-complete — select a wholesale lender and submit");
  }

  return { readyToSubmitToLender, currentStage, stages, nextActions };
}

export async function evaluateBrokerSubmissionReadiness(applicationId: string): Promise<BrokerSubmissionReadiness> {
  const application = await storage.getLoanApplication(applicationId);
  if (!application) {
    throw new Error("Application not found");
  }

  const { validateMISMOCompleteness } = await import("./mismoValidation");
  const urla = await validateMISMOCompleteness(applicationId);

  const mismoData = await storage.getMISMOLoanData(applicationId);
  const uldd = mismoData
    ? validateULDDCompliance(mismoData as MISMOLoanDTO)
    : { valid: false, errors: ["MISMO loan data could not be assembled"], warnings: [], phase5Ready: false };

  const [eDisclosure, antiSteering] = await Promise.all([
    hasBorrowerConsent("e_disclosure", applicationId),
    hasBorrowerConsent("anti_steering", applicationId),
  ]);

  const { evaluateDeliveryReadiness } = await import("./loanDeliveryReadiness");
  const delivery = await evaluateDeliveryReadiness(applicationId);

  const persistedFindings = application.ausFindings as {
    lpa?: unknown;
    inputIntegrity?: { decisionPath?: "automated" | "manual_underwrite" };
  } | null;
  const ausFreshness = application.ausCasefileId
    ? await import("./ausDecisionIntegrity").then(module =>
        module.evaluateAusInputFreshness(applicationId, persistedFindings),
      )
    : { current: false, reason: null, currentFingerprint: null };

  // Income-analysis readiness (UAL P6): does this file need the income package,
  // and is it complete? A file needs it when the borrower has self-employment,
  // or the selected income path is non-agency (DSCR / bank-statement).
  const { db } = await import("../db");
  const { incomePathEvaluations } = await import("@shared/schema");
  const { eq, desc } = await import("drizzle-orm");
  const employment = await storage.getEmploymentHistory(applicationId);
  const [latestEval] = await db
    .select()
    .from(incomePathEvaluations)
    .where(eq(incomePathEvaluations.applicationId, applicationId))
    .orderBy(desc(incomePathEvaluations.createdAt))
    .limit(1);
  const selectedNonAgency =
    !!latestEval?.recommendedPathId &&
    ["dscr", "bank_statement", "rental"].includes(latestEval.recommendedPathId);
  const requiresIncomePackage = employment.some((e) => e.isSelfEmployed) || selectedNonAgency;
  const currentApprovedMemo = requiresIncomePackage
    ? await import("./financialReview").then(module => module.getCurrentApprovedCreditMemo(applicationId))
    : null;
  const { countOpenReviewItems } = await import("./income/reviewTriage");
  const openFlaggedReviewItems = await countOpenReviewItems(applicationId, "flagged");

  const derived = deriveSubmissionStages({
    urla: {
      gseGatingFailed: urla.gseGatingFailed,
      criticalErrors: urla.criticalErrors,
      missingDocuments: urla.missingDocuments,
      qmStatus: urla.qmStatus,
      pointsAndFeesCompliant: urla.pointsAndFeesCompliant,
      tridStatus: {
        leRequired: urla.tridStatus.leRequired,
        leDueDate: urla.tridStatus.leDueDate,
        leIssued: urla.tridStatus.leIssued,
      },
    },
    uldd,
    aus: {
      casefileId: application.ausCasefileId ?? null,
      recommendation: application.ausRecommendation ?? null,
      lpaAssessed: !!persistedFindings?.lpa,
      inputsCurrent: application.ausCasefileId ? ausFreshness.current : undefined,
      staleReason: ausFreshness.reason,
      decisionPath: persistedFindings?.inputIntegrity?.decisionPath,
    },
    consents: { eDisclosure, antiSteering },
    changeOfCircumstance: await (async () => {
      const { getCocReadinessSummary } = await import("./changeOfCircumstance");
      return getCocReadinessSummary(applicationId);
    })(),
    deliveryEdits: {
      deliverable: delivery.edits.deliverable,
      fatalCount: delivery.edits.fatal.length,
      warningCount: delivery.edits.warnings.length,
      notEvaluatedCount: delivery.edits.notEvaluated.length,
    },
    incomeAnalysis: {
      requiresIncomePackage,
      hasCurrentEvaluation: !!latestEval,
      openFlaggedReviewItems,
      hasCurrentApprovedMemo: !!currentApprovedMemo,
    },
  });

  return { applicationId, ...derived };
}
