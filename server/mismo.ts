/**
 * MISMO 3.4 XML Generation Service
 * 
 * Generates compliant MISMO 3.4 XML for loan delivery to GSEs (Fannie Mae, Freddie Mac)
 * Supports ULDD Phase 5 requirements effective July 28, 2025
 */

import type { 
  LoanApplication, 
  User, 
  UrlaPersonalInfo, 
  EmploymentHistory, 
  UrlaAsset, 
  UrlaLiability,
  UrlaPropertyInfo,
  LoanOption,
  Document,
  BorrowerDeclarations,
} from "@shared/schema";
import { isApprovedGradeLoanAppStatus } from "@shared/schema";
import { isExcludedAsPaidByOtherParty } from "@shared/liabilityExclusions";
import { liabilityKind, type LiabilityKind } from "@shared/liabilityTypes";
import { COMPANY_CONFIG } from "./config/company";
import { mersOrgIdApplicable } from "@shared/businessChannel";
import {
  MISMO_NAMESPACE,
  ULDD_EXTENSION_NAMESPACE,
  XLINK_NAMESPACE,
  XSI_NAMESPACE,
  type MortgageType,
  type LoanPurposeType,
  type PropertyUsageType,
  type AssetType,
  type LiabilityType,
} from "@shared/mismo";

export type MISMOPersonalInfo = UrlaPersonalInfo & { ssn?: string | null };

export interface MISMOLoanDTO {
  application: LoanApplication;
  user: User | null;
  // `ssn` is a virtual field: SSNs are encrypted at rest and are decrypted
  // only when getMISMOLoanData receives an audited delivery purpose.
  personalInfo: MISMOPersonalInfo | null;
  /**
   * Every borrower on the URLA, with the full SSN populated only on an
   * audited export/submission path. Optional keeps older internal
   * callers compatible; the primary-only fields above remain the fallback.
   */
  allPersonalInfo?: MISMOPersonalInfo[];
  employment: EmploymentHistory[];
  // Asset/liability `accountNumber` is likewise a decrypted virtual field.
  assets: (UrlaAsset & { accountNumber?: string | null })[];
  liabilities: (UrlaLiability & { accountNumber?: string | null })[];
  propertyInfo: UrlaPropertyInfo | null;
  declarations: BorrowerDeclarations | null;
  allDeclarations?: BorrowerDeclarations[];
  loanOptions: LoanOption[];
  documents: Document[];
}

export function generateLuhnCheckDigit(digits: string): number {
  // The MERS MIN is an all-numeric identifier; any non-digit (e.g. hex from a
  // UUID-derived loan number, or a non-numeric org id) would map through
  // Number() to NaN and silently corrupt the check digit. Fail loudly instead.
  if (!/^\d+$/.test(digits)) {
    throw new Error(`generateLuhnCheckDigit requires a numeric string, received: "${digits}"`);
  }
  const digitsArray = digits.split("").map(Number);
  let checksum = 0;
  let isDouble = true;

  for (let i = digitsArray.length - 1; i >= 0; i--) {
    let digit = digitsArray[i];
    if (isDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    checksum += digit;
    isDouble = !isDouble;
  }

  return (10 - (checksum % 10)) % 10;
}

export function generateMERSMIN(orgId: string, loanNumber: string): string {
  const appId = "100";
  // Both segments must be numeric and fit their fixed width. Strip any
  // formatting, then validate — we would rather throw than emit a MIN whose
  // Luhn check digit is NaN (which a GSE/investor ingestion will reject).
  const numericOrgId = orgId.replace(/\D/g, "");
  const numericLoanNumber = loanNumber.replace(/\D/g, "");
  if (numericOrgId.length === 0 || numericOrgId.length > 7) {
    throw new Error(`MERS Org ID must be 1-7 digits, received: "${orgId}"`);
  }
  if (numericLoanNumber.length === 0 || numericLoanNumber.length > 7) {
    throw new Error(`MERS loan number must be 1-7 digits, received: "${loanNumber}"`);
  }
  const paddedOrgId = numericOrgId.padStart(7, "0");
  const paddedLoanNumber = numericLoanNumber.padStart(7, "0");

  const minPrefix = appId + paddedOrgId + paddedLoanNumber;
  const checkDigit = generateLuhnCheckDigit(minPrefix);

  return minPrefix + checkDigit.toString();
}

export function validateMERSMIN(min: string): boolean {
  if (min.length !== 18) return false;
  
  const prefix = min.substring(0, 17);
  const providedCheckDigit = parseInt(min.charAt(17), 10);
  const calculatedCheckDigit = generateLuhnCheckDigit(prefix);
  
  return providedCheckDigit === calculatedCheckDigit;
}

function escapeXml(unsafe: string | null | undefined): string {
  if (!unsafe) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  // A malformed date string produces an Invalid Date whose toISOString() throws
  // a RangeError and would abort the entire export. Drop the value instead.
  if (isNaN(d.getTime())) return "";
  return d.toISOString().split("T")[0];
}

// DB decimal columns arrive as plain numeric strings, but hand-entered values
// can carry currency formatting ("$1,234.56"). parseFloat("$1,234") is NaN and
// parseFloat("1,234") is 1 — both silently corrupt the amount — so strip the
// formatting first and fall back to "0.00" rather than emitting a literal "NaN".
function formatCurrency(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined) return "0.00";
  const num = typeof amount === "string" ? parseFloat(amount.replace(/[$,\s]/g, "")) : amount;
  return Number.isFinite(num) ? num.toFixed(2) : "0.00";
}

function formatPercent(rate: number | string | null | undefined): string {
  if (rate === null || rate === undefined) return "0.000";
  const num = typeof rate === "string" ? parseFloat(rate.replace(/[%,\s]/g, "")) : rate;
  return Number.isFinite(num) ? num.toFixed(3) : "0.000";
}

function mapMortgageType(loanType: string | null | undefined): MortgageType {
  const mapping: Record<string, MortgageType> = {
    conventional: "Conventional",
    fha: "FHA",
    va: "VA",
    usda: "USDA",
  };
  return mapping[loanType?.toLowerCase() || ""] || "Conventional";
}

function mapLoanPurpose(purpose: string | null | undefined): LoanPurposeType {
  const p = purpose?.toLowerCase() || "";
  // ULDD LoanPurposeTypeEnumerated = {MortgageModification, Other, Purchase, Refinance}
  // (verified vs docs/fannie-mae/schemas MISMO_3_0.xsd + golden UCD samples; ledger
  // uldd-loanpurposetype-enum). Cash-out is NOT a LoanPurposeType value — a cash-out or
  // rate/term refi is LoanPurposeType=Refinance, with the cash-out fact carried separately
  // by REFINANCE/RefinanceCashOutDeterminationType (follow-up, tracked with the F-018 restructure).
  if (p === "purchase") return "Purchase";
  if (p === "refinance" || p === "cash_out_refinance" || p === "cash_out" || p === "no_cash_out_refinance") {
    return "Refinance";
  }
  if (p === "construction") {
    // U-7: the base ULDD XSD has no Construction LoanPurposeType value. Fail loud rather than
    // emit an out-of-enum value that fails GSE ingestion (pending ULDD data-dictionary confirmation).
    throw new Error(
      "MISMO LoanPurposeType: construction loan purpose is unmapped — no valid ULDD enum value (escalation U-7, pending source confirmation)",
    );
  }
  return "Purchase";
}

/**
 * Maps the application's amortization type to the ULDD `LoanAmortizationType` enum.
 *
 * Valid values were read out of the committed schema, not recalled:
 * `docs/fannie-mae/schemas/uldd-phase5-extension/MISMO_3_0.xsd` gives AdjustableRate, Fixed,
 * GraduatedPaymentMortgage, GrowingEquityMortgage, OtherAmortizationType, GraduatedPaymentARM,
 * RateImprovementMortgage, ReverseMortgage, Step. Nothing here is invented.
 *
 * F-053: this was the compile-time literal "Fixed". The rate sheet seeds a real 5/6 ARM
 * (`server/seedMarketPricing.ts`) and the borrower's URLA captures the choice
 * (`server/routes/borrower/urla.ts`), so an adjustable file was delivered to the wholesale
 * lender as fixed-rate. B2-1.4 governs amortization types; A3-4-02 requires delivery data to be
 * "complete and accurate"; and under A2-2-07 a data inaccuracy is a life-of-loan representation.
 * It is the same defect class as F-051 in this file — a stored value discarded for a constant.
 *
 * An unrecognised non-empty value throws rather than defaulting, following the U-7 precedent
 * above: fail loud rather than emit a plausible value the schema accepts and the lender believes.
 */
function mapAmortizationType(amortizationType: string | null | undefined): string {
  const t = (amortizationType ?? "").toLowerCase().trim();
  // Two vocabularies reach this field: the application enum (`fixed` | `adjustable`,
  // shared/statusVocabularies.ts) and the rate-sheet product spelling (`FIXED` | `ARM`).
  if (t === "adjustable" || t === "arm") return "AdjustableRate";
  if (t === "fixed") return "Fixed";
  if (t === "") {
    // Unset. Fixed is the documented platform assumption — `lendingWholesale.amortizationType`
    // defaults to "FIXED" and every ARM product sets the field explicitly — so this asserts the
    // default rather than overriding a known value, which is what F-053 actually was.
    return "Fixed";
  }
  throw new Error(
    `MISMO LoanAmortizationType: unmapped amortization type "${amortizationType}" — not a value in the ULDD enumeration (F-053)`,
  );
}

/**
 * Maps the stored AUS recommendation to the free-text description ULDD carries.
 *
 * `AutomatedUnderwritingRecommendationDescription` is `MISMOString` with
 * `minOccurs="0"` (MISMO_3_0.xsd:1294) — free text, not an enumeration, and
 * legally omissible. Fannie's per-data-point expected vocabulary lives in ULDD
 * Appendix D, which is NOT in `docs/fannie-mae/` and is not fetchable
 * (escalation U-22), so we do NOT invent GSE tokens here. The strings below
 * mirror this repo's own vocabulary (`server/services/ausSubmission.ts:145,185`)
 * and are honest about a system that `AutomatedUnderwritingSystemType` already
 * declares as "Other".
 *
 * Returns null when there is no recommendation to report, or when the stored
 * value is unrecognised. **Null must omit the AUTOMATED_UNDERWRITINGS container
 * entirely** rather than substitute a value — asserting an AUS outcome the file
 * does not have is finding F-051 (P0), and it is the same rule `:405-408`
 * applies to citizenship and `:846-850` applies to SystemType.
 */
function mapAusRecommendation(recommendation: string | null | undefined): string | null {
  const mapping: Record<string, string> = {
    approve_eligible: "Approve/Eligible",
    approve_ineligible: "Approve/Ineligible",
    refer: "Refer",
    refer_with_caution: "Refer with Caution",
  };
  return mapping[recommendation?.toLowerCase() ?? ""] ?? null;
}

function mapPropertyUsage(usage: string | null | undefined): PropertyUsageType {
  const mapping: Record<string, PropertyUsageType> = {
    primary_residence: "PrimaryResidence",
    primary: "PrimaryResidence",
    second_home: "SecondHome",
    secondary: "SecondHome",
    investment: "Investment",
    investment_property: "Investment",
  };
  return mapping[usage?.toLowerCase() || ""] || "PrimaryResidence";
}

function mapAssetType(type: string | null | undefined): AssetType {
  const mapping: Record<string, AssetType> = {
    checking: "CheckingAccount",
    checking_account: "CheckingAccount",
    savings: "SavingsAccount",
    savings_account: "SavingsAccount",
    money_market: "MoneyMarketFund",
    money_market_account: "MoneyMarketFund",
    cd: "CertificateOfDepositTimeDeposit",
    certificate_of_deposit: "CertificateOfDepositTimeDeposit",
    stocks: "Stock",
    stock: "Stock",
    bonds: "Bond",
    bond: "Bond",
    retirement: "RetirementFund",
    retirement_account: "RetirementFund",
    mutual_fund: "MutualFund",
    ira: "RetirementFund",
    "401k": "RetirementFund",
    other: "Other",
  };
  return mapping[type?.toLowerCase() || ""] || "Other";
}

/**
 * LiabilityTypeEnumerated (MISMO_3_0.xsd line 9773) from the stored type.
 * Classifies through the shared `liabilityKind`, so the URLA picker's own
 * labels ("Revolving (Credit Card)", "Student Loan") reach a real enum instead
 * of falling to the default — and the default is now a value the schema
 * enumerates. F-020: "Mortgage", "Other", "ChildSupport" and "Alimony" were
 * emitted verbatim and none of them exist in the schema; alimony and child
 * support are EXPENSE items in MISMO and travel as OtherLiability until an
 * EXPENSE container is built (the remaining half of F-020).
 */
function mapLiabilityType(type: string | null | undefined): LiabilityType {
  const byKind: Record<LiabilityKind, LiabilityType> = {
    revolving: "Revolving",
    installment: "Installment",
    student_loan: "Installment",
    mortgage: "MortgageLoan",
    heloc: "HELOC",
    lease: "LeasePayments",
    alimony: "OtherLiability",
    child_support: "OtherLiability",
    other: "OtherLiability",
  };
  return byKind[liabilityKind(type)];
}

interface XMLNode {
  tag: string;
  attributes?: Record<string, string>;
  children?: (XMLNode | string)[];
  text?: string;
}

/**
 * MISMO's `ContactPointTelephoneValue` is typed `MISMONumericString`, whose
 * facet is `<xsd:pattern value="\d*"/>` — digits only. Every human phone format
 * we store ("(512) 555-0134", "512-555-0142", "+1 512 555 0134") is a schema
 * violation, and the client stores whatever the borrower typed. Strip to digits
 * the same way generateMERSMIN does for the MERS org id / loan number.
 *
 * Returns "" when nothing numeric survives, so callers can omit the element
 * rather than emit an empty one. Note `\d*` also accepts a 3-digit fragment —
 * digit-count is a data-quality question the schema will not catch.
 */
function normalizePhoneForMismo(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}

function buildXmlNode(node: XMLNode, indent: number = 0): string {
  const spaces = "  ".repeat(indent);
  const attrs = node.attributes
    ? " " + Object.entries(node.attributes)
        .map(([k, v]) => `${k}="${escapeXml(v)}"`)
        .join(" ")
    : "";

  if (node.text !== undefined && node.text !== null && node.text !== "") {
    return `${spaces}<${node.tag}${attrs}>${escapeXml(String(node.text))}</${node.tag}>`;
  }

  if (!node.children || node.children.length === 0) {
    return `${spaces}<${node.tag}${attrs}/>`;
  }

  const childContent = node.children
    .filter(child => child !== null && child !== undefined)
    .map(child => {
      if (typeof child === "string") {
        return escapeXml(child);
      }
      return buildXmlNode(child, indent + 1);
    })
    .filter(content => content.trim() !== "")
    .join("\n");

  if (childContent.trim() === "") {
    return "";
  }

  return `${spaces}<${node.tag}${attrs}>\n${childContent}\n${spaces}</${node.tag}>`;
}

function buildAddressNode(
  street: string | null | undefined,
  unit: string | null | undefined,
  city: string | null | undefined,
  state: string | null | undefined,
  zip: string | null | undefined,
  county?: string | null | undefined,
  tagName: string = "ADDRESS"
): XMLNode | null {
  // ADDRESS's xsd:sequence orders: AddressLineText, AddressUnitIdentifier,
  // CityName, CountryCode, CountyName, PostalCode, StateCode (verified against
  // MISMO_3_0.xsd — CountryCode and PostalCode sit BEFORE StateCode).
  const children: XMLNode[] = [];

  if (street) {
    children.push({ tag: "AddressLineText", text: street });
  }
  if (unit) {
    children.push({ tag: "AddressUnitIdentifier", text: unit });
  }
  if (city) {
    children.push({ tag: "CityName", text: city });
  }
  children.push({ tag: "CountryCode", text: "US" });
  if (county) {
    children.push({ tag: "CountyName", text: county });
  }
  if (zip) {
    children.push({ tag: "PostalCode", text: zip });
  }
  if (state) {
    children.push({ tag: "StateCode", text: state });
  }

  if (children.length === 1) return null;

  return { tag: tagName, children };
}

function buildBorrowerNode(dto: MISMOLoanDTO): XMLNode {
  const { personalInfo, employment, declarations } = dto;
  const borrowerChildren: XMLNode[] = [];

  const borrowerDetail: XMLNode[] = [];
  if (personalInfo?.dateOfBirth) {
    borrowerDetail.push({ tag: "BorrowerBirthDate", text: personalInfo.dateOfBirth });
  }
  // No BorrowerSSNIdentifier here — the element does not exist in this
  // schema's BORROWER_DETAIL (verified against MISMO_3_0.xsd). The SSN's one
  // schema-valid home is PARTY/TAXPAYER_IDENTIFIERS, which buildPartyNode
  // already emits; duplicating it here was both invalid and a wider PII spill.
  borrowerDetail.push({
    tag: "BorrowerClassificationType",
    text: (personalInfo?.borrowerSequenceNumber ?? 1) > 1 ? "Secondary" : "Primary",
  });
  if (personalInfo?.maritalStatus) {
    const maritalMap: Record<string, string> = {
      married: "Married",
      unmarried: "Unmarried",
      separated: "Separated",
    };
    borrowerDetail.push({ 
      tag: "MaritalStatusType", 
      text: maritalMap[personalInfo.maritalStatus?.toLowerCase()] || "Unmarried" 
    });
  }

  if (borrowerDetail.length > 0) {
    borrowerChildren.push({ tag: "BORROWER_DETAIL", children: borrowerDetail });
  }

  if (declarations) {
    // ── URLA §5 declarations ──────────────────────────────────────────────
    // Three structural facts, all verified against
    // docs/fannie-mae/schemas/uldd-phase5-extension/MISMO_3_0.xsd:4032-4138:
    //
    //   1. DECLARATION = (DECLARATION_DETAIL, DECLARATION_EXPLANATIONS,
    //      EXTENSION). No data point may sit directly under DECLARATION — the
    //      old code put all nineteen there. libxml2 stops a container at its
    //      first content-model failure, so only IntentToOccupyIndicator was
    //      ever REPORTED; iterative removal found fourteen more behind it
    //      (15 of 19 rejected; the surviving 4 survived by luck of order).
    //   2. DECLARATION_DETAIL is an xsd:sequence, so the children below MUST
    //      stay in the schema's own order. BankruptcyIndicator is a real name
    //      and was still rejected purely for being emitted fourteenth.
    //   3. Two of the points are enumerated (Yes|No|Unknown), not
    //      MISMOIndicator booleans.
    //
    // Root cause of the omissions below: this schema is the MISMO v3.0
    // reference model ("Generated by Contivo Builder on June 1, 2010") and its
    // DECLARATION_DETAIL documentation cites "URLA Section VIII lines a–m" —
    // the legacy 1003 declaration set. `borrower_declarations` is modeled on
    // URLA 2020 §5. The URLA-2020-only questions have no representation here.
    // That is a model-generation gap, not a naming error: an omitted data
    // point is an honest gap, an invented element name is a fabricated record.
    const declarationDetail: XMLNode[] = [];

    const addIndicator = (tag: string, value: boolean | null | undefined) => {
      if (value !== null && value !== undefined) {
        declarationDetail.push({ tag, text: value ? "true" : "false" });
      }
    };
    // Enumerated points take Yes|No|Unknown. A NULL column is omitted rather
    // than mapped to "Unknown": "Unknown" asserts the borrower was asked and
    // did not know, which is not what an unanswered column means.
    const addYesNo = (tag: string, value: boolean | null | undefined) => {
      if (value !== null && value !== undefined) {
        declarationDetail.push({ tag, text: value ? "Yes" : "No" });
      }
    };

    // ---- DECLARATION_DETAIL xsd:sequence order starts here ----
    // AlimonyChildSupportObligationIndicator — no URLA 2020 §5 question; not captured.
    addIndicator("BankruptcyIndicator", declarations.hasDeclaredBankruptcy); // 5b-M
    addIndicator("BorrowedDownPaymentIndicator", declarations.isBorrowingForDownPayment); // 5a-C
    // BorrowerFirstTimeHomebuyerIndicator — a lender/investor determination
    // (the schema says so explicitly), not a borrower declaration; not captured.

    // Citizenship (URLA §1, not §5): the schema has ONE enumerated point where
    // we hold two booleans. Emit only what the borrower actually told us.
    // CitizenshipResidencyTypeEnumerated also offers NonPermanentResidentAlien
    // / NonResidentAlien / Unknown, and our two-boolean model cannot
    // distinguish "not a permanent resident alien" from "never asked" — so a
    // false/false pair is OMITTED rather than resolved to a category. Asserting
    // a citizenship status the borrower never gave us would be a fabricated
    // record on a fair-lending-sensitive data point.
    const citizenshipResidencyType = declarations.isUSCitizen
      ? "USCitizen"
      : declarations.isPermanentResidentAlien
        ? "PermanentResidentAlien"
        : null;
    if (citizenshipResidencyType) {
      declarationDetail.push({ tag: "CitizenshipResidencyType", text: citizenshipResidencyType });
    }

    addIndicator("CoMakerEndorserOfNoteIndicator", declarations.hasCoMakerEndorser); // 5b-F
    addYesNo("HomeownerPastThreeYearsType", declarations.hasOwnershipInterestInPast3Years); // 5a-A(1)
    addYesNo("IntentToOccupyType", declarations.willOccupyAsPrimaryResidence); // 5a-A
    // LoanForeclosureOrJudgmentIndicator — deliberately NOT emitted; see the
    // PropertyForeclosedPastSevenYearsIndicator note below (escalation E-2).
    addIndicator("OutstandingJudgmentsIndicator", declarations.hasOutstandingJudgments); // 5b-G
    addIndicator("PartyToLawsuitIndicator", declarations.isPartyToLawsuit); // 5b-I
    addIndicator("PresentlyDelinquentIndicator", declarations.isDelinquentOnFederalDebt); // 5b-H
    // PriorPropertyTitleType / PriorPropertyUsageType — captured on
    // borrower_declarations (priorPropertyTitle / priorPropertyType) and both
    // have legal homes here, but the exporter has never emitted them. That is
    // a completeness gap, not a conformance defect; out of scope for this fix.
    //
    // ESCALATION E-2 — the foreclosure family is NOT emitted, in either slot.
    // URLA 2020 asks two questions (5b-J deed-in-lieu, 5b-L foreclosure) and
    // MISMO 3.0 offers two OVERLAPPING points:
    //   PropertyForeclosedPastSevenYearsIndicator — "foreclosed upon or given
    //     title or deed in lieu thereof"
    //   LoanForeclosureOrJudgmentIndicator — "foreclosure, transfer of title in
    //     lieu of foreclosure, or judgment"
    // Both cover both questions; the local sources do not settle which URLA
    // answer belongs in which element, and guessing would mis-state a
    // seven-year derogatory event in a GSE delivery. hasBeenForeclosed and
    // hasConveyedTitleInLieuOfForeclosure stay captured in the database and
    // undelivered pending a user decision.

    // EXTENSION is the last child of the DECLARATION_DETAIL sequence.
    //
    // URLA 5b-K (pre-foreclosure / short sale) has no base-model home; its one
    // legal expression is the Fannie extension point
    // ULDD:DECLARATION_DETAIL_EXTENSION/PriorPropertyShortSaleCompletedIndicator.
    //
    // The wrapper is `ULDD:OTHER`, not a bare `OTHER`: in THIS distribution the
    // only `OTHER` either schema declares is the one in the ULDD namespace
    // (ULDD_Phase_5_Extension.xsd:6). MISMO_3_0.xsd declares no global OTHER, so
    // an unprefixed one resolves to nothing and `processContents="lax"` skips it
    // — taking the whole extension subtree out of validation. (The UCD golden
    // samples DO use an unprefixed <OTHER>, but UCD redefines MISMO *3.3*, where
    // OTHER is a typed child of a typed EXTENSION in the MISMO namespace — a
    // different schema, not a different convention for this one. Escalation E-4
    // remains open on what Fannie's ingestion accepts; what is *validated* is
    // not ambiguous.)
    if (
      declarations.hasCompletedShortSale !== null &&
      declarations.hasCompletedShortSale !== undefined
    ) {
      declarationDetail.push({
        tag: "EXTENSION",
        children: [{
          tag: "ULDD:OTHER",
          children: [{
            tag: "ULDD:DECLARATION_DETAIL_EXTENSION",
            children: [{
              tag: "ULDD:PriorPropertyShortSaleCompletedIndicator",
              text: declarations.hasCompletedShortSale ? "true" : "false",
            }],
          }],
        }],
      });
    }

    // NOT DELIVERABLE — captured in `borrower_declarations`, no legal home in
    // MISMO 3.0 (see the model-generation note above). Each was previously
    // emitted under an invented element name that exists in neither schema:
    //   hasRelationshipWithSeller             (5a-B seller affiliation)
    //   hasAppliedForMortgageOnOtherProperty  (5a-D.1 other-property mortgage)
    //   hasPriorityLienOnSubjectProperty      (5a-E PACE priority lien)
    //   hasUndisclosedDebt                    (5a-C undisclosed borrowed funds)
    //   hasAppliedForNewCredit                (5a-D.2 new credit)
    //   hasPriorityLienToBePaidOff            (no URLA 2020 §5 question at all)
    // ESCALATION E-3: whether ULDD expects these at all needs the Fannie Loan
    // Delivery job aid; this finding is bounded by the two local XSDs.

    if (declarationDetail.length > 0) {
      borrowerChildren.push({
        tag: "DECLARATION",
        children: [{ tag: "DECLARATION_DETAIL", children: declarationDetail }],
      });
    }
  }

  if (employment.length > 0) {
    const employersNode: XMLNode[] = [];
    for (const emp of employment) {
      // EMPLOYER = (INDIVIDUAL, LEGAL_ENTITY, ADDRESS, …, EMPLOYMENT, …) —
      // there is no EmployerName/EmployerTelephoneNumber element. The employer's
      // name lives at LEGAL_ENTITY/LEGAL_ENTITY_DETAIL/FullName and its phone at
      // LEGAL_ENTITY/CONTACTS/CONTACT/CONTACT_POINTS/CONTACT_POINT (CONTACTS
      // precedes LEGAL_ENTITY_DETAIL in the sequence). Verified against
      // MISMO_3_0.xsd.
      const employerChildren: XMLNode[] = [];
      const employerPhoneDigits = normalizePhoneForMismo(emp.employerPhone);
      if (emp.employerName || employerPhoneDigits) {
        const legalEntityChildren: XMLNode[] = [];
        if (employerPhoneDigits) {
          legalEntityChildren.push({
            tag: "CONTACTS",
            children: [{
              tag: "CONTACT",
              children: [{
                tag: "CONTACT_POINTS",
                children: [{
                  tag: "CONTACT_POINT",
                  children: [
                    { tag: "ContactPointTelephoneValue", text: employerPhoneDigits },
                    { tag: "ContactPointRoleType", text: "Work" },
                  ],
                }],
              }],
            }],
          });
        }
        if (emp.employerName) {
          legalEntityChildren.push({
            tag: "LEGAL_ENTITY_DETAIL",
            children: [{ tag: "FullName", text: emp.employerName }],
          });
        }
        employerChildren.push({ tag: "LEGAL_ENTITY", children: legalEntityChildren });
      }

      const empAddress = buildAddressNode(
        emp.employerStreet,
        emp.employerUnit,
        emp.employerCity,
        emp.employerState,
        emp.employerZip
      );
      if (empAddress) {
        employerChildren.push(empAddress);
      }

      // EMPLOYMENT children in schema sequence order: SelfEmployedIndicator,
      // EndDate, MonthlyIncomeAmount, PositionDescription, StartDate,
      // StatusType (verified against MISMO_3_0.xsd — EmploymentEndDate sits
      // BEFORE EmploymentMonthlyIncomeAmount in the sequence).
      const employmentDetail: XMLNode[] = [];
      if (emp.isSelfEmployed !== undefined) {
        employmentDetail.push({
          tag: "EmploymentBorrowerSelfEmployedIndicator",
          text: emp.isSelfEmployed ? "true" : "false"
        });
      }
      if (emp.endDate) {
        employmentDetail.push({ tag: "EmploymentEndDate", text: emp.endDate });
      }
      if (emp.totalMonthlyIncome) {
        employmentDetail.push({
          tag: "EmploymentMonthlyIncomeAmount",
          text: formatCurrency(emp.totalMonthlyIncome)
        });
      }
      if (emp.positionTitle) {
        employmentDetail.push({
          tag: "EmploymentPositionDescription",
          text: emp.positionTitle
        });
      }
      if (emp.startDate) {
        employmentDetail.push({ tag: "EmploymentStartDate", text: emp.startDate });
      }
      // MISMO EmploymentStatusType is Current | Previous. The employmentType
      // column holds free-text categories ("employed"/"self_employed"/…), never
      // this distinction, so the old `=== "current"` check tagged nearly every
      // active job "Previous". Key off the end date instead: an open-ended job
      // (no end date) is the borrower's current employment.
      employmentDetail.push({
        tag: "EmploymentStatusType",
        text: emp.endDate ? "Previous" : "Current",
      });

      if (employmentDetail.length > 0) {
        employerChildren.push({ tag: "EMPLOYMENT", children: employmentDetail });
      }

      if (employerChildren.length > 0) {
        employersNode.push({ tag: "EMPLOYER", children: employerChildren });
      }
    }
    if (employersNode.length > 0) {
      borrowerChildren.push({ tag: "EMPLOYERS", children: employersNode });
    }
  }

  if (personalInfo?.numberOfDependents) {
    borrowerChildren.push({
      tag: "DEPENDENTS",
      children: [
        { tag: "DependentCount", text: String(personalInfo.numberOfDependents) },
      ],
    });
  }

  return { tag: "BORROWER", children: borrowerChildren };
}

function buildPartyNode(dto: MISMOLoanDTO): XMLNode {
  const { personalInfo, user } = dto;

  // NAME children in this schema are FirstName / LastName / MiddleName /
  // SuffixName (no *Text variants), and the xsd:sequence puts LastName BEFORE
  // MiddleName. Verified against MISMO_3_0.xsd.
  const nameChildren: XMLNode[] = [];
  if (personalInfo?.firstName) {
    nameChildren.push({ tag: "FirstName", text: personalInfo.firstName });
  }
  if (personalInfo?.lastName) {
    nameChildren.push({ tag: "LastName", text: personalInfo.lastName });
  }
  if (personalInfo?.middleName) {
    nameChildren.push({ tag: "MiddleName", text: personalInfo.middleName });
  }
  if (personalInfo?.suffix) {
    nameChildren.push({ tag: "SuffixName", text: personalInfo.suffix });
  }

  const individualChildren: XMLNode[] = [];

  const contactPoints: XMLNode[] = [];
  if (personalInfo?.email || user?.email) {
    contactPoints.push({
      tag: "CONTACT_POINT",
      children: [
        { tag: "ContactPointEmailValue", text: personalInfo?.email || user?.email || "" },
        { tag: "ContactPointRoleType", text: "Home" },
      ],
    });
  }
  const cellPhoneDigits = normalizePhoneForMismo(personalInfo?.cellPhone);
  if (cellPhoneDigits) {
    contactPoints.push({
      tag: "CONTACT_POINT",
      children: [
        { tag: "ContactPointTelephoneValue", text: cellPhoneDigits },
        { tag: "ContactPointRoleType", text: "Mobile" },
      ],
    });
  }
  const homePhoneDigits = normalizePhoneForMismo(personalInfo?.homePhone);
  if (homePhoneDigits) {
    contactPoints.push({
      tag: "CONTACT_POINT",
      children: [
        { tag: "ContactPointTelephoneValue", text: homePhoneDigits },
        { tag: "ContactPointRoleType", text: "Home" },
      ],
    });
  }
  // INDIVIDUAL's xsd:sequence is (ALIASES, CONTACT_POINTS,
  // IDENTIFICATION_VERIFICATION, NAME, EXTENSION) — CONTACT_POINTS comes
  // BEFORE NAME. Verified against MISMO_3_0.xsd.
  if (contactPoints.length > 0) {
    individualChildren.push({ tag: "CONTACT_POINTS", children: contactPoints });
  }
  if (nameChildren.length > 0) {
    individualChildren.push({ tag: "NAME", children: nameChildren });
  }

  const partyChildren: XMLNode[] = [];
  if (individualChildren.length > 0) {
    partyChildren.push({ tag: "INDIVIDUAL", children: individualChildren });
  }

  const addressNode = buildAddressNode(
    personalInfo?.currentStreet,
    personalInfo?.currentUnit,
    personalInfo?.currentCity,
    personalInfo?.currentState,
    personalInfo?.currentZip
  );
  if (addressNode) {
    partyChildren.push({ tag: "ADDRESSES", children: [addressNode] });
  }

  const borrowerNode = buildBorrowerNode(dto);
  partyChildren.push({
    tag: "ROLES",
    children: [
      {
        tag: "ROLE",
        children: [
          borrowerNode,
          {
            tag: "ROLE_DETAIL",
            children: [
              { tag: "PartyRoleType", text: "Borrower" },
            ],
          },
        ],
      },
    ],
  });

  if (personalInfo?.ssn) {
    partyChildren.push({
      tag: "TAXPAYER_IDENTIFIERS",
      children: [
        {
          tag: "TAXPAYER_IDENTIFIER",
          children: [
            { tag: "TaxpayerIdentifierType", text: "SocialSecurityNumber" },
            { tag: "TaxpayerIdentifierValue", text: personalInfo.ssn.replace(/-/g, "") },
          ],
        },
      ],
    });
  }

  return { tag: "PARTY", children: partyChildren };
}

/**
 * Materialize one PARTY context per URLA borrower. Employment and declarations
 * are borrower-owned records, so they must be filtered before building each
 * PARTY; passing the deal-wide arrays into every PARTY would duplicate income
 * and attribute a co-borrower's job to the primary borrower.
 */
function borrowerPartyDtos(dto: MISMOLoanDTO): MISMOLoanDTO[] {
  const personalRows = dto.allPersonalInfo?.length
    ? dto.allPersonalInfo
    : dto.personalInfo
      ? [dto.personalInfo]
      : [];

  return [...personalRows]
    .sort((a, b) => (a.borrowerSequenceNumber ?? 1) - (b.borrowerSequenceNumber ?? 1))
    .map((personalInfo) => {
      const sequence = personalInfo.borrowerSequenceNumber ?? 1;
      return {
        ...dto,
        user: sequence === 1 ? dto.user : null,
        personalInfo,
        employment: dto.employment.filter(
          (record) => (record.borrowerSequenceNumber ?? 1) === sequence,
        ),
        declarations:
          dto.allDeclarations?.find(
            (record) => (record.borrowerSequenceNumber ?? 1) === sequence,
          ) ?? (sequence === 1 ? dto.declarations : null),
      };
    });
}

/**
 * Loan-state stamp for a LOAN container. Per the ULDD Implementation Guide
 * (Table 5, Subject Loan State), a loan delivery file carries the subject
 * loan as multiple LOAN containers: AtClosing (LoanStateDate = note date)
 * and Current (LoanStateDate = extraction date) — plus AtModification for
 * modified loans, which we do not originate.
 */
export interface LoanStateStamp {
  loanStateType: "AtClosing" | "Current" | "AtModification";
  /** YYYY-MM-DD; omitted when the date is not yet known. */
  loanStateDate?: string;
}

function buildLoanNode(dto: MISMOLoanDTO, mersMin?: string, loanState?: LoanStateStamp): XMLNode {
  const { application, loanOptions } = dto;
  const loanChildren: XMLNode[] = [];

  if (loanState) {
    const stateChildren: XMLNode[] = [];
    if (loanState.loanStateDate) {
      stateChildren.push({ tag: "LoanStateDate", text: loanState.loanStateDate });
    }
    stateChildren.push({ tag: "LoanStateType", text: loanState.loanStateType });
    loanChildren.push({ tag: "LOAN_STATE", children: stateChildren });
  }

  // This schema's LOAN_IDENTIFIER uses TYPED identifier elements
  // (LenderLoanIdentifier, MERS_MINIdentifier, …) — there is no generic
  // LoanIdentifier + LoanIdentifierType pair. Verified against MISMO_3_0.xsd.
  const loanIdentifiers: XMLNode[] = [
    {
      tag: "LOAN_IDENTIFIER",
      children: [{ tag: "LenderLoanIdentifier", text: application.id }],
    },
  ];

  if (mersMin) {
    loanIdentifiers.push({
      tag: "LOAN_IDENTIFIER",
      children: [{ tag: "MERS_MINIdentifier", text: mersMin }],
    });
  }

  loanChildren.push({ tag: "LOAN_IDENTIFIERS", children: loanIdentifiers });

  // Loan amount + selected option (used by TERMS_OF_MORTGAGE below). Prefer an explicit loan-option
  // amount; otherwise derive from price minus down payment. Use != null (not truthiness) so a real
  // $0 down payment yields loan = price, while a MISSING down payment leaves the amount unknown
  // rather than overstating the loan.
  const optionAmount = loanOptions[0]?.loanAmount != null
    ? parseFloat(String(loanOptions[0].loanAmount))
    : NaN;
  const price = application.purchasePrice != null ? parseFloat(String(application.purchasePrice)) : NaN;
  const down = application.downPayment != null ? parseFloat(String(application.downPayment)) : NaN;
  let loanAmount: number | null = null;
  if (Number.isFinite(optionAmount)) {
    loanAmount = optionAmount;
  } else if (Number.isFinite(price) && Number.isFinite(down)) {
    loanAmount = price - down;
  }
  const selectedOption = loanOptions.find(o => o.isLocked) || loanOptions[0];

  // F-018 (verified vs docs/fannie-mae/schemas MISMO_3_0.xsd + golden UCD samples):
  //   LOAN_DETAIL      = loan-characteristic detail (ApplicationReceivedDate here);
  //   AMORTIZATION_RULE = amortization type/term;
  //   TERMS_OF_MORTGAGE    = LienPriorityType, LoanPurposeType, MortgageType, NoteAmount, NoteRatePercent.
  // Previously all five plus amortization were mis-nested in LOAN_DETAIL/TERMS_OF_MORTGAGE, and the
  // LOAN children were emitted out of XSD sequence — both fixed here (see the ordered push below).
  const loanDetail: XMLNode[] = [];
  if (application.createdAt) {
    loanDetail.push({ tag: "ApplicationReceivedDate", text: formatDate(application.createdAt) });
  }
  loanChildren.push({ tag: "LOAN_DETAIL", children: loanDetail });

  loanChildren.push({
    tag: "AMORTIZATION",
    children: [
      {
        tag: "AMORTIZATION_RULE",
        // XSD AMORTIZATION_RULE sequence: PeriodCount, PeriodType, LoanAmortizationType.
        children: [
          { tag: "LoanAmortizationPeriodCount", text: String(selectedOption?.loanTerm || 30) },
          { tag: "LoanAmortizationPeriodType", text: "Year" },
          { tag: "LoanAmortizationType", text: mapAmortizationType(application.amortizationType) },
        ],
      },
    ],
  });

  const termsOfLoan: XMLNode[] = [];
  termsOfLoan.push({ tag: "LienPriorityType", text: "FirstLien" });
  termsOfLoan.push({ tag: "LoanPurposeType", text: mapLoanPurpose(application.loanPurpose) });
  termsOfLoan.push({ tag: "MortgageType", text: mapMortgageType(application.preferredLoanType) });
  if (loanAmount != null && loanAmount > 0) {
    termsOfLoan.push({ tag: "NoteAmount", text: formatCurrency(loanAmount) });
  }
  if (selectedOption?.interestRate) {
    termsOfLoan.push({ tag: "NoteRatePercent", text: formatPercent(selectedOption.interestRate) });
  }
  loanChildren.push({ tag: "TERMS_OF_MORTGAGE", children: termsOfLoan });

  if (mersMin) {
    loanChildren.push({
      tag: "MERS_REGISTRATION",
      children: [
        { tag: "MERSMINIdentifier", text: mersMin },
        { tag: "MERSOrganizationIdentifier", text: mersMin.substring(3, 10) },
        { tag: "MERSRegistrationStatusType", text: "Registered" },
      ],
    });
  }

  if (isApprovedGradeLoanAppStatus(application.status)) {
    // Schema-true AUS expression (U-1, verified against MISMO_3_0.xsd):
    // AUTOMATED_UNDERWRITINGS must precede UNDERWRITING_DETAIL, the
    // recommendation rides in AutomatedUnderwritingRecommendationDescription
    // (before SystemType in the sequence), and UNDERWRITING_DETAIL has no
    // decision element — its nearest legal statement is the manual-UW flag.
    // SystemType stays "Other" with an honest description: the AUS legs are
    // deterministic simulations, and a delivery file must never claim
    // DesktopUnderwriter until the real DU integration (F6) produces the
    // casefile id (aus_casefile_id) it would assert.
    //
    // F-051 (P0): the recommendation was previously the compile-time literal
    // "Approve", so a `refer` / `refer_with_caution` / `approve_ineligible`
    // casefile was delivered to the wholesale lender as an approval. It now
    // reads the recommendation the AUS leg actually recorded, and when there is
    // none the whole AUTOMATED_UNDERWRITINGS container is omitted — both
    // AUTOMATED_UNDERWRITINGS and UNDERWRITING_DETAIL are independently
    // minOccurs="0" (MISMO_3_0.xsd:20884-20889), so the manual-underwriting
    // statement stands on its own.
    //
    // AutomatedUnderwritingCaseIdentifier is deliberately NOT emitted: the only
    // casefile id available is the simulator's `sim-du-<sha1>` (F-068), and
    // asserting it as a real AUS case identifier would reintroduce this bug in
    // a different element.
    const underwritingChildren: XMLNode[] = [];
    const ausRecommendation = mapAusRecommendation(application.ausRecommendation);
    if (ausRecommendation) {
      underwritingChildren.push({
        tag: "AUTOMATED_UNDERWRITINGS",
        children: [
          {
            tag: "AUTOMATED_UNDERWRITING",
            children: [
              {
                tag: "AutomatedUnderwritingRecommendationDescription",
                text: ausRecommendation,
              },
              { tag: "AutomatedUnderwritingSystemType", text: "Other" },
              {
                tag: "AutomatedUnderwritingSystemTypeOtherDescription",
                text: "Proprietary deterministic underwriting cascade",
              },
            ],
          },
        ],
      });
    }
    const decisionPath = (
      application.ausFindings as {
        decisionPath?: string;
        inputIntegrity?: { decisionPath?: string };
      } | null
    )?.inputIntegrity?.decisionPath
      ?? (application.ausFindings as { decisionPath?: string } | null)?.decisionPath;
    // When no recognized AUS result exists, or the local engine explicitly
    // routed the file out of its automated matrix, the lender package must say
    // manual underwriting. A hardcoded false misstates the very workflow the
    // findings and readiness gate ask the loan officer to follow.
    const manualUnderwriting = !ausRecommendation || decisionPath === "manual_underwrite";
    underwritingChildren.push({
      tag: "UNDERWRITING_DETAIL",
      children: [{ tag: "LoanManualUnderwritingIndicator", text: String(manualUnderwriting) }],
    });
    loanChildren.push({ tag: "UNDERWRITING", children: underwritingChildren });
  }

  if (application.dtiRatio || application.ltvRatio) {
    const qualificationChildren: XMLNode[] = [];
    if (application.dtiRatio) {
      qualificationChildren.push({ 
        tag: "DebtIncomeRatioPercent", 
        text: formatPercent(application.dtiRatio) 
      });
    }
    if (application.ltvRatio) {
      qualificationChildren.push({ 
        tag: "LoanToValueRatioPercent", 
        text: formatPercent(application.ltvRatio) 
      });
    }
    loanChildren.push({
      tag: "QUALIFICATION",
      children: [{ tag: "QUALIFICATION_DETAIL", children: qualificationChildren }],
    });
  }

  // F-018: emit LOAN children in the MISMO LOAN sequence order (the XSD is a <sequence>),
  // regardless of the order they were built above. Verified against MISMO_3_0.xsd LOAN complexType.
  const LOAN_CHILD_ORDER = [
    "AMORTIZATION",
    "LOAN_DETAIL",
    "LOAN_IDENTIFIERS",
    "LOAN_STATE",
    "MERS_REGISTRATION",
    "QUALIFICATION",
    "REFINANCE",
    "TERMS_OF_MORTGAGE",
    "UNDERWRITING",
  ];
  loanChildren.sort(
    (a, b) => LOAN_CHILD_ORDER.indexOf(a.tag) - LOAN_CHILD_ORDER.indexOf(b.tag),
  );

  return { tag: "LOAN", children: loanChildren };
}

function buildCollateralNode(dto: MISMOLoanDTO): XMLNode | null {
  const { application, propertyInfo } = dto;
  
  const street = propertyInfo?.propertyStreet || application.propertyAddress;
  const city = propertyInfo?.propertyCity || application.propertyCity;
  const state = propertyInfo?.propertyState || application.propertyState;
  const zip = propertyInfo?.propertyZip || application.propertyZip;
  
  if (!street && !city) return null;

  const propertyChildren: XMLNode[] = [];

  const addressNode = buildAddressNode(
    street, 
    propertyInfo?.propertyUnit, 
    city, 
    state, 
    zip,
    undefined
  );
  if (addressNode) {
    propertyChildren.push(addressNode);
  }

  // PROPERTY_DETAIL children in schema sequence order: ConstructionMethodType,
  // FinancedUnitCount, PropertyUsageType (verified against MISMO_3_0.xsd).
  const propertyDetail: XMLNode[] = [];
  // ConstructionMethodType is a MISMO-enumerated construction method
  // (SiteBuilt | Manufactured | Modular | …), NOT the app's propertyType
  // (single_family/condo/townhouse/multi_family — those are attachment/project
  // concepts and belong in AttachmentType/ProjectType). Emitting the raw
  // propertyType here produced schema-invalid values like
  // <ConstructionMethodType>single_family</...>. Every current propertyType is
  // site-built unless the URLA flags it a manufactured home.
  propertyDetail.push({
    tag: "ConstructionMethodType",
    text: propertyInfo?.isManufacturedHome ? "Manufactured" : "SiteBuilt",
  });
  if (propertyInfo?.numberOfUnits) {
    // The schema has no PropertyUnitCount — FinancedUnitCount is the ULDD
    // data point for the subject property's unit count.
    propertyDetail.push({
      tag: "FinancedUnitCount",
      text: String(propertyInfo.numberOfUnits),
    });
  }
  propertyDetail.push({
    tag: "PropertyUsageType",
    text: mapPropertyUsage(propertyInfo?.occupancyType)
  });

  if (propertyDetail.length > 0) {
    propertyChildren.push({ tag: "PROPERTY_DETAIL", children: propertyDetail });
  }

  // Estimated value and the sales contract both live under PROPERTY_VALUATIONS
  // in this schema (PROPERTY_VALUATION_DETAIL / SALES_CONTRACT) — there is no
  // SUBJECT_PROPERTY element and no SALES_CONTRACT_DETAIL. Verified against
  // MISMO_3_0.xsd: PROPERTY = (ADDRESS, …, PROPERTY_DETAIL, …,
  // PROPERTY_VALUATIONS); PROPERTY_VALUATION = (AVMS,
  // PROPERTY_VALUATION_DETAIL, SALES_CONTRACT, EXTENSION).
  const valuationChildren: XMLNode[] = [];
  if (application.propertyValue) {
    valuationChildren.push({
      tag: "PROPERTY_VALUATION_DETAIL",
      children: [
        { tag: "PropertyEstimatedValueAmount", text: formatCurrency(application.propertyValue) },
      ],
    });
  }
  if (application.purchasePrice) {
    valuationChildren.push({
      tag: "SALES_CONTRACT",
      children: [
        { tag: "SalesContractAmount", text: formatCurrency(application.purchasePrice) },
      ],
    });
  }
  if (valuationChildren.length > 0) {
    propertyChildren.push({
      tag: "PROPERTY_VALUATIONS",
      children: [{ tag: "PROPERTY_VALUATION", children: valuationChildren }],
    });
  }

  if (propertyChildren.length === 0) return null;

  return {
    tag: "COLLATERALS",
    children: [
      {
        tag: "COLLATERAL",
        children: [
          { tag: "PROPERTIES", children: [{ tag: "PROPERTY", children: propertyChildren }] },
        ],
      },
    ],
  };
}

function buildAssetsNode(dto: MISMOLoanDTO): XMLNode | null {
  const { assets } = dto;
  if (assets.length === 0) return null;

  const assetNodes: XMLNode[] = [];
  for (const asset of assets) {
    const assetDetail: XMLNode[] = [];
    if (asset.accountNumber) {
      assetDetail.push({ tag: "AssetAccountIdentifier", text: asset.accountNumber });
    }
    if (asset.cashOrMarketValue) {
      assetDetail.push({ 
        tag: "AssetCashOrMarketValueAmount", 
        text: formatCurrency(asset.cashOrMarketValue) 
      });
    }
    assetDetail.push({ tag: "AssetType", text: mapAssetType(asset.accountType) });

    const assetChildren: XMLNode[] = [{ tag: "ASSET_DETAIL", children: assetDetail }];

    if (asset.financialInstitution) {
      assetChildren.push({
        tag: "ASSET_HOLDER",
        children: [
          {
            tag: "NAME",
            children: [{ tag: "FullName", text: asset.financialInstitution }],
          },
        ],
      });
    }

    assetNodes.push({ tag: "ASSET", children: assetChildren });
  }

  return { tag: "ASSETS", children: assetNodes };
}

function buildLiabilitiesNode(dto: MISMOLoanDTO): XMLNode | null {
  const { liabilities } = dto;
  if (liabilities.length === 0) return null;

  const liabilityNodes: XMLNode[] = [];
  for (const liability of liabilities) {
    const liabilityDetail: XMLNode[] = [];
    if (liability.accountNumber) {
      liabilityDetail.push({ tag: "LiabilityAccountIdentifier", text: liability.accountNumber });
    }
    // B3-6-05, Debts Paid by Others: a payment the qualifying ratio leaves out
    // is declared to the lender as excluded, so the package and the decision
    // tell one story. MISMO_3_0.xsd (docs/fannie-mae/schemas/uldd-phase5-
    // extension, line 9748): "Indicates whether the liability is to be
    // excluded from inclusion in calculations associated with processing the
    // loan." Emitted only when true — absent means included, the default —
    // and in the container's alphabetical position (after AccountIdentifier,
    // before MonthlyPaymentAmount) as the schema sequence requires. The
    // 12-month payment history rides the file as its own condition.
    if (isExcludedAsPaidByOtherParty(liability)) {
      liabilityDetail.push({ tag: "LiabilityExclusionIndicator", text: "true" });
    }
    if (liability.monthlyPayment) {
      liabilityDetail.push({ 
        tag: "LiabilityMonthlyPaymentAmount", 
        text: formatCurrency(liability.monthlyPayment) 
      });
    }
    if (liability.toBePaidOff !== undefined) {
      liabilityDetail.push({ 
        tag: "LiabilityPayoffStatusIndicator", 
        text: liability.toBePaidOff ? "true" : "false" 
      });
    }
    liabilityDetail.push({ tag: "LiabilityType", text: mapLiabilityType(liability.liabilityType) });
    if (liability.unpaidBalance) {
      liabilityDetail.push({ 
        tag: "LiabilityUnpaidBalanceAmount", 
        text: formatCurrency(liability.unpaidBalance) 
      });
    }

    const liabilityChildren: XMLNode[] = [{ tag: "LIABILITY_DETAIL", children: liabilityDetail }];

    if (liability.creditorName) {
      liabilityChildren.push({
        tag: "LIABILITY_HOLDER",
        children: [
          {
            tag: "NAME",
            children: [{ tag: "FullName", text: liability.creditorName }],
          },
        ],
      });
    }

    liabilityNodes.push({ tag: "LIABILITY", children: liabilityChildren });
  }

  return { tag: "LIABILITIES", children: liabilityNodes };
}

// ============================================================================
// XLINK RELATIONSHIP GENERATION (Graph-based data model)
//
// DEFERRED — intentionally emits nothing. A MISMO 3.4 relationship graph
// associates objects via xlink arcs: each ASSET/LIABILITY/EMPLOYMENT/PARTY
// carries an xlink:label, and each RELATIONSHIP references them with
// xlink:from / xlink:to under a GSE-accepted arcrole URI. The previous
// implementation emitted xlink:href pointers to labels that were never defined
// (dangling references) alongside non-standard RelationshipType/RelatedParty
// children — an invalid graph that fails GSE ingestion. Until the container
// nodes carry matching labels and the exact arcrole URIs are wired in, we omit
// the block rather than deliver a broken graph. The objects themselves are
// still emitted inline under DEAL; single-borrower associations are implicit.
// ============================================================================

function buildRelationshipsNode(_dto: MISMOLoanDTO): XMLNode | null {
  return null;
}

export interface MISMOGenerationOptions {
  includeAboutVersions?: boolean;
  mersOrgId?: string;
  generateMersMin?: boolean;
  /**
   * "loanDelivery" produces the ULDD delivery shape per the ULDD
   * Implementation Guide: the subject loan is emitted as AtClosing + Current
   * LOAN containers (Table 5), and the ASSET container is omitted because
   * Fannie Mae does not support it in delivery files (Table 4). The default
   * ("underwriting") keeps the single-LOAN shape with assets for AUS-style
   * consumers.
   */
  purpose?: "underwriting" | "loanDelivery";
  /** Note date (YYYY-MM-DD) for the AtClosing loan state, when known. */
  noteDate?: string;
  /**
   * Generation clock for ABOUT_VERSION CreatedDatetime and the Current
   * loan-state date. Same inputs + same clock ⇒ byte-identical XML.
   */
  generatedAt?: Date;
}

export function generateMISMO34XML(
  dto: MISMOLoanDTO,
  options: MISMOGenerationOptions = {}
): string {
  const {
    includeAboutVersions = true,
    mersOrgId = COMPANY_CONFIG.mersOrgId,
    generateMersMin = true,
    purpose = "underwriting",
    noteDate,
    generatedAt = new Date(),
  } = options;

  let mersMin: string | undefined;
  // Only mint a MIN when the org id is a real numeric MERS identifier. While it
  // is unset ("PENDING") we deliberately omit MERS_REGISTRATION rather than emit
  // a placeholder MIN that would fail Luhn validation downstream. The loan
  // number is derived from the application id's digits (a UUID is hex, so we
  // strip the letters) padded to the 7-digit MIN loan-number width.
  const orgIdIsNumeric = /^\d{1,7}$/.test(mersOrgId);
  if (generateMersMin && orgIdIsNumeric) {
    const loanNumber = dto.application.id.replace(/\D/g, "").slice(0, 7).padStart(7, "0");
    mersMin = generateMERSMIN(mersOrgId, loanNumber);
  }

  // DEAL's xsd:sequence orders its containers ASSETS, COLLATERALS, EXPENSES,
  // LIABILITIES, LOANS, PARTIES, RELATIONSHIPS, SERVICES (verified against
  // MISMO_3_0.xsd) — emit in that order, not discovery order.
  const dealChildren: XMLNode[] = [];

  // The ULDD Implementation Guide (Table 4) states Fannie Mae does not
  // support the ASSET container in delivery files — it is emitted only for
  // underwriting-style consumers.
  if (purpose !== "loanDelivery") {
    const assetsNode = buildAssetsNode(dto);
    if (assetsNode) {
      dealChildren.push(assetsNode);
    }
  }

  const collateralNode = buildCollateralNode(dto);
  if (collateralNode) {
    dealChildren.push(collateralNode);
  }

  const liabilitiesNode = buildLiabilitiesNode(dto);
  if (liabilitiesNode) {
    dealChildren.push(liabilitiesNode);
  }

  if (purpose === "loanDelivery") {
    // ULDD Implementation Guide Table 5: every subject loan is delivered
    // with an AtClosing LOAN container (LoanStateDate = note date) and a
    // Current LOAN container (LoanStateDate = data-extraction date).
    dealChildren.push({
      tag: "LOANS",
      children: [
        buildLoanNode(dto, mersMin, { loanStateType: "AtClosing", loanStateDate: noteDate }),
        buildLoanNode(dto, mersMin, {
          loanStateType: "Current",
          loanStateDate: generatedAt.toISOString().slice(0, 10),
        }),
      ],
    });
  } else {
    dealChildren.push({
      tag: "LOANS",
      children: [buildLoanNode(dto, mersMin)],
    });
  }

  dealChildren.push({
    tag: "PARTIES",
    children: borrowerPartyDtos(dto).map(buildPartyNode),
  });

  const relationshipsNode = buildRelationshipsNode(dto);
  if (relationshipsNode) {
    dealChildren.push(relationshipsNode);
  }

  const messageChildren: XMLNode[] = [];

  if (includeAboutVersions) {
    messageChildren.push({
      tag: "ABOUT_VERSIONS",
      children: [
        {
          tag: "ABOUT_VERSION",
          children: [
            { tag: "CreatedDatetime", text: generatedAt.toISOString() },
            { tag: "DataVersionIdentifier", text: "3.4.0" },
            { tag: "DataVersionName", text: "MISMO" },
          ],
        },
      ],
    });
  }

  messageChildren.push({
    tag: "DEAL_SETS",
    children: [
      {
        tag: "DEAL_SET",
        children: [
          {
            tag: "DEALS",
            children: [{ tag: "DEAL", children: dealChildren }],
          },
        ],
      },
    ],
  });

  const xmlDeclaration = '<?xml version="1.0" encoding="UTF-8"?>';
  const messageNode: XMLNode = {
    tag: "MESSAGE",
    attributes: {
      xmlns: MISMO_NAMESPACE,
      "xmlns:xlink": XLINK_NAMESPACE,
      "xmlns:xsi": XSI_NAMESPACE,
      // Declared on the envelope (not per-EXTENSION) so every Fannie extension
      // point resolves the same way; ULDD:DECLARATION_DETAIL_EXTENSION is the
      // first consumer. Declaring an unused namespace prefix is valid XML.
      "xmlns:ULDD": ULDD_EXTENSION_NAMESPACE,
    },
    children: messageChildren,
  };

  const xmlBody = buildXmlNode(messageNode);
  return `${xmlDeclaration}\n${xmlBody}`;
}

export function validateMISMOXML(xml: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!xml.includes('<?xml version="1.0"')) {
    errors.push("Missing XML declaration");
  }

  if (!xml.includes("MESSAGE")) {
    errors.push("Missing MESSAGE root element");
  }

  if (!xml.includes("DEAL_SETS")) {
    errors.push("Missing DEAL_SETS container");
  }

  if (!xml.includes("DEAL")) {
    errors.push("Missing DEAL element");
  }

  if (!xml.includes("LOAN")) {
    errors.push("Missing LOAN element");
  }

  if (!xml.includes("PARTY")) {
    errors.push("Missing PARTY element");
  }

  const requiredDataPoints = [
    "NoteAmount",
    "LoanPurposeType",
    "MortgageType",
    // BaseLoanAmount was dropped in the F-018 restructure (redundant with NoteAmount and
    // out-of-schema in TERMS_OF_MORTGAGE); NoteAmount is the canonical loan amount.
    "LoanAmortizationType",
  ];

  for (const dataPoint of requiredDataPoints) {
    if (!xml.includes(dataPoint)) {
      errors.push(`Missing required ULDD data point: ${dataPoint}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface ULDDValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  phase5Ready: boolean;
}

export function validateULDDCompliance(dto: MISMOLoanDTO): ULDDValidationResult {
  const { application, personalInfo, propertyInfo, employment } = dto;
  const errors: string[] = [];
  const warnings: string[] = [];

  // != null (not truthiness) so a valid $0-down loan (e.g. VA 100% financing)
  // computes loanAmount = price and passes, instead of being wrongly reported as
  // a missing NoteAmount.
  const price = application.purchasePrice != null ? parseFloat(String(application.purchasePrice)) : NaN;
  const down = application.downPayment != null ? parseFloat(String(application.downPayment)) : NaN;
  const loanAmount = Number.isFinite(price) && Number.isFinite(down) ? price - down : null;
  if (loanAmount == null || loanAmount <= 0) {
    errors.push("NoteAmount is required and must be greater than 0");
  }

  if (!application.loanPurpose) {
    errors.push("LoanPurposeType is required");
  }

  if (!application.preferredLoanType) {
    errors.push("MortgageType is required");
  }

  if (!personalInfo?.firstName || !personalInfo?.lastName) {
    errors.push("Borrower name is required");
  }

  if (!personalInfo?.ssn && !personalInfo?.ssnLast4) {
    errors.push("Borrower SSN is required");
  }

  const street = propertyInfo?.propertyStreet || application.propertyAddress;
  const city = propertyInfo?.propertyCity || application.propertyCity;
  if (!street && !city) {
    errors.push("Subject property address is required");
  }

  if (!application.creditScore && application.status !== "draft") {
    warnings.push("Credit score should be provided for loan delivery");
  }

  if (!application.propertyValue) {
    warnings.push("Property valuation amount should be provided");
  }

  if (!employment || employment.length === 0) {
    warnings.push("Employment information should be provided");
  }

  // A broker registers no notes in MERS, so a missing org id is expected, not
  // a gap to warn about (F-14). Warn only where it would actually be needed.
  if (mersOrgIdApplicable() && !/^\d{1,7}$/.test(COMPANY_CONFIG.mersOrgId)) {
    warnings.push("MERS Org ID is not configured; a MERS MIN cannot be generated for loan delivery");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    phase5Ready: errors.length === 0 && warnings.length === 0,
  };
}
