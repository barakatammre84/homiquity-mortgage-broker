import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateAgainstXsd,
  validateMismoExport,
  extractOffendingElements,
  MISMO_BASE_XSD,
} from "../server/services/mismoXsdValidation";
import { generateMISMO34XML, type MISMOLoanDTO } from "../server/mismo";

// ---------------------------------------------------------------------------
// L6 (CTO_ROADMAP.md): "Add an XSD-validation step for our generated MISMO
// 3.4 XML to the delivery test gate ... so exports are schema-valid, not just
// valid per our hand-built checks."
//
// The real MISMO export (server/mismo.ts) does NOT yet conform to the
// official schema — xmllint finds real structural violations (wrong element
// nesting/names for SUBJECT_PROPERTY, PARTY names, EMPLOYMENT, ASSETS,
// LIABILITIES, LOAN identifiers). Fixing shared/mismo.ts field-by-field
// against the schema is a separate, larger remediation ticket (tracked as
// L6-fix in CTO_ROADMAP.md) — this suite's job is to PIN the current known
// violations as a regression baseline: any accidental new violation fails
// the test immediately, and any deliberate fix requires updating the
// baseline array here (forcing the change to be visible and intentional).
//
// Element-name extraction (not full messages) keeps the baseline stable
// across incidental line-number/formatting churn in the generated XML.
// ---------------------------------------------------------------------------

// Detected at COLLECTION time (module scope), not in beforeAll, so the
// xmllint-dependent cases can use `it.skipIf` — which reports them as SKIPPED.
// They previously `return`ed early, which vitest reports as PASSED: on any
// machine without libxml2 the entire schema-validity gate on our lender-facing
// MISMO 3.4 export went green while asserting nothing. `ubuntu-latest` does not
// list libxml2-utils in its documented apt package set, so that is not a
// hypothetical. A skipped test is visible in the run output; a vacuous pass is not.
const xmllintInstalled = (() => {
  try {
    execFileSync("xmllint", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * A fixture that MUST stay representative of a real borrower file.
 *
 * 2026-08-06: it was not, and that made this suite lie. It set
 * `declarations: null` and left every phone field empty, so the export emitted
 * neither a single declaration indicator nor a single
 * `ContactPointTelephoneValue` — and the suite happily asserted "validates
 * clean" over an export that omitted the offending elements entirely. Once the
 * fixture carried real data, 15 of the 19 declaration elements were rejected
 * (14 of the 19 names exist in NEITHER local schema) and all three phone sites
 * failed the `\d*` facet.
 *
 * Two rules this encodes:
 *  - A conformance fixture is only worth its assertions if it exercises what
 *    production actually emits. Adding a field to the export means adding it
 *    here.
 *  - Phones must be stored FORMATTED here. A digits-only phone satisfies the
 *    `MISMONumericString` facet by accident, so it proves nothing about
 *    normalization — that vacuous pass is exactly how this defect stayed
 *    hidden. `server/scripts/seedDemoFile.ts` seeds `"512-555-0142"`, and
 *    `PersonalInfoSection.tsx` stores whatever the borrower types.
 */
function baseDto(overrides: Partial<MISMOLoanDTO> = {}): MISMOLoanDTO {
  return {
    application: {
      id: "3f8a-9c2d-11ee-8c90-0242ac120002",
      status: "pre_approved",
      loanPurpose: "purchase",
      preferredLoanType: "conventional",
      propertyType: "single_family",
      propertyAddress: "123 Main St",
      propertyCity: "Austin",
      propertyState: "TX",
      propertyZip: "78701",
      propertyValue: "500000",
      purchasePrice: "500000",
      downPayment: "100000",
      // POPULATED on purpose — same reason the phones below are formatted.
      // F-051's fix omits AUTOMATED_UNDERWRITINGS when there is no AUS
      // recommendation, so a fixture without one would stop exercising that
      // container against the schema entirely and quietly recreate the
      // fixture-bounded blindness this file exists to prevent (F-049).
      ausRecommendation: "refer_with_caution",
      createdAt: new Date("2026-01-01"),
      ...(overrides.application ?? {}),
    } as any,
    user: { id: "user-abc123", email: "b@example.com" } as any,
    personalInfo: (overrides.personalInfo ?? {
      firstName: "Jane",
      lastName: "Doe",
      ssn: "123-45-6789",
      email: "jane@example.com",
      // FORMATTED on purpose — see the docblock above.
      cellPhone: "(512) 555-0134",
      homePhone: "512-555-0143",
    }) as any,
    employment: overrides.employment ?? [
      {
        employerName: "Acme",
        employmentType: "employed",
        startDate: "2020-01-01",
        employerPhone: "(512) 555-0100",
      } as any,
    ],
    otherIncome: overrides.otherIncome ?? [{
      incomeSource: "Social Security",
      monthlyAmount: "1500",
      taxTreatment: "fully_non_taxable",
      nonTaxableMonthlyAmount: null,
      hasDefinedExpiration: false,
      expirationDate: null,
      paidInVirtualCurrency: false,
    } as any],
    assets: overrides.assets ?? [{ accountType: "checking", cashOrMarketValue: "5000" } as any],
    liabilities: overrides.liabilities ?? [
      { liabilityType: "credit_card", monthlyPayment: "50" } as any,
    ],
    propertyInfo: overrides.propertyInfo ?? {
      occupancyType: "primary_residence",
      monthlyAssociationDues: "175",
      monthlyFloodInsurance: "80",
      monthlyGroundRent: "25",
      monthlySpecialAssessments: "40",
      subordinateFinancingExists: true,
      closedEndSubordinateBalance: "15000",
      helocDrawnBalance: "10000",
      helocCreditLimit: "30000",
      monthlySubordinateFinancingPayment: "225",
    } as any,
    // URLA §5 + §1 citizenship. Every field non-null, so the export emits every
    // declaration data point it is capable of emitting — the fields with no
    // MISMO 3.0 home are omitted by the exporter, not by the fixture.
    declarations: (overrides.declarations ?? {
      willOccupyAsPrimaryResidence: true,
      hasOwnershipInterestInPast3Years: false,
      priorPropertyType: "primary_residence",
      priorPropertyTitle: "sole",
      hasRelationshipWithSeller: false,
      isBorrowingForDownPayment: false,
      hasAppliedForMortgageOnOtherProperty: false,
      hasCreditForMortgageOnOtherProperty: false,
      hasPriorityLienOnSubjectProperty: false,
      hasCoMakerEndorser: false,
      hasOutstandingJudgments: false,
      isDelinquentOnFederalDebt: false,
      isPartyToLawsuit: false,
      hasConveyedTitleInLieuOfForeclosure: false,
      hasCompletedShortSale: false,
      hasBeenForeclosed: false,
      hasDeclaredBankruptcy: false,
      hasUndisclosedDebt: false,
      hasAppliedForNewCredit: false,
      hasPriorityLienToBePaidOff: false,
      isUSCitizen: true,
      isPermanentResidentAlien: false,
    }) as any,
    loanOptions: overrides.loanOptions ?? [],
    documents: [],
  };
}

describe("validateAgainstXsd (harness correctness)", () => {
  it.skipIf(!xmllintInstalled)("validates a conformant document as valid", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mismo-xsd-harness-"));
    const xsdPath = path.join(dir, "control.xsd");
    writeFileSync(
      xsdPath,
      `<?xml version="1.0"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <xsd:element name="ROOT">
    <xsd:complexType>
      <xsd:sequence>
        <xsd:element name="OK" type="xsd:string"/>
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>
</xsd:schema>`,
    );
    try {
      const result = validateAgainstXsd("<ROOT><OK>yes</OK></ROOT>", xsdPath);
      expect(result.skipped).toBe(false);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!xmllintInstalled)("flags a document with an unexpected element", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mismo-xsd-harness-"));
    const xsdPath = path.join(dir, "control.xsd");
    writeFileSync(
      xsdPath,
      `<?xml version="1.0"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <xsd:element name="ROOT">
    <xsd:complexType>
      <xsd:sequence>
        <xsd:element name="OK" type="xsd:string"/>
      </xsd:sequence>
    </xsd:complexType>
  </xsd:element>
</xsd:schema>`,
    );
    try {
      const result = validateAgainstXsd("<ROOT><NOT_OK>no</NOT_OK></ROOT>", xsdPath);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(xmllintInstalled)("returns skipped:true instead of a false failure when xmllint is unavailable", () => {
    // Exercised implicitly by every assertion above via the module-level
    // availability cache; this test documents the contract explicitly using
    // a path that is guaranteed not to exist so a broken installation would
    // still not report a false "invalid".
    const result = validateAgainstXsd("<ROOT/>", "/nonexistent/schema.xsd");
    expect(result.skipped).toBe(true);
  });
});

describe("MISMO export vs. the official schema (known-violations baseline)", () => {
  // KNOWN NON-CONFORMANCE — do not silently grow this list. If a change adds
  // a new offending element, that's a regression: fix the export instead of
  // updating this baseline. If a change removes one, that's progress on the
  // L6-fix remediation ticket: update the baseline down and note it in the
  // commit. See CTO_ROADMAP.md L6 for the tracked remediation scope.
  // F-018 (2026-07-08): fixing the LOAN child-container sequence + nesting cleared the
  // LOAN_DETAIL / LOAN_IDENTIFIERS structural violations (the five terms points now sit in
  // TERMS_OF_MORTGAGE, amortization in AMORTIZATION_RULE, children emitted in XSD order). That
  // let xmllint validate INTO the UNDERWRITING container, which surfaced pre-existing (previously
  // masked) violations there — AUTOMATED_UNDERWRITINGS / UnderwritingDecisionType — tracked as
  // escalation U-1 (AUS data-point names pending ULDD data-dictionary confirmation; MISMO's is
  // AutomatedUnderwritingRecommendationDescription). Net structural progress; do not "fix" the
  // UNDERWRITING names from memory.
  // L6-fix (2026-08-05): every structural violation except escalation U-1 is
  // cleared — SUBJECT_PROPERTY → COLLATERAL/PROPERTIES/PROPERTY (estimated
  // value + sales contract moved to PROPERTY_VALUATIONS), typed loan
  // identifiers (LenderLoanIdentifier / MERS_MINIdentifier), NAME element
  // names + sequence, CONTACT_POINTS-before-NAME, BorrowerSSNIdentifier
  // dropped (SSN's one valid home is TAXPAYER_IDENTIFIERS), employer name/
  // phone into LEGAL_ENTITY, DEAL child order (ASSETS, COLLATERALS,
  // LIABILITIES, LOANS, PARTIES), ADDRESS child order, EMPLOYMENT child
  // order, FinancedUnitCount. Every corrected name/path was verified against
  // MISMO_3_0.xsd (content models extracted, xmllint re-run), never guessed.
  // U-1 RESOLVED (2026-08-05, same verify-then-fix method): the AUS names were
  // confirmed against MISMO_3_0.xsd — the AUTOMATED_UNDERWRITINGS container is
  // legal but must PRECEDE UNDERWRITING_DETAIL, and all four emitted decision
  // names (UnderwritingDecisionType, UnderwritingMethodType,
  // AutomatedUnderwritingResultType — the last two previously masked by
  // libxml2's first-failure-per-container behavior) do not exist in the
  // schema. The schema-true expression is
  // AUTOMATED_UNDERWRITING/{AutomatedUnderwritingRecommendationDescription,
  // AutomatedUnderwritingSystemType (+OtherDescription)} with
  // UNDERWRITING_DETAIL/LoanManualUnderwritingIndicator. The baseline is now
  // EMPTY and must stay empty: any new offending element is a regression —
  // fix the export, never grow a baseline back.

  it.skipIf(!xmllintInstalled)("underwriting-purpose export validates clean against the official schema", () => {
    const xml = generateMISMO34XML(baseDto());
    const result = validateMismoExport(xml);
    expect(extractOffendingElements(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.skipIf(!xmllintInstalled)("loanDelivery-purpose export validates clean against the official schema", () => {
    const xml = generateMISMO34XML(baseDto(), { purpose: "loanDelivery", noteDate: "2026-03-15" });
    const result = validateMismoExport(xml);
    expect(extractOffendingElements(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it.skipIf(!xmllintInstalled)("multi-borrower export validates clean against the official schema", () => {
    const dto = baseDto();
    dto.allPersonalInfo = [
      { ...dto.personalInfo!, borrowerSequenceNumber: 1 },
      {
        borrowerSequenceNumber: 2,
        firstName: "Sam",
        lastName: "Secondary",
        ssn: "444-55-6666",
        email: "sam@example.com",
      } as any,
    ];
    dto.employment = [
      ...dto.employment.map((row) => ({ ...row, borrowerSequenceNumber: 1 })),
      {
        borrowerSequenceNumber: 2,
        employerName: "Secondary Employer",
        employmentType: "employed",
        startDate: "2021-01-01",
      } as any,
    ];
    dto.allDeclarations = [
      { ...dto.declarations!, borrowerSequenceNumber: 1 },
      { ...dto.declarations!, borrowerSequenceNumber: 2 },
    ];

    const result = validateMismoExport(generateMISMO34XML(dto));
    expect(extractOffendingElements(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });

  // B3-6-05, Debts Paid by Others → LiabilityExclusionIndicator (MISMO_3_0.xsd
  // line 9748). Validated against the official schema, not just grepped for:
  // the LIABILITY_DETAIL content model is an ordered sequence, so a correct
  // element in the wrong position is a schema violation xmllint would catch.
  it.skipIf(!xmllintInstalled)("a third-party-paid liability's exclusion indicator validates in schema order", () => {
    const xml = generateMISMO34XML(
      baseDto({
        liabilities: [
          {
            liabilityType: "Student Loan",
            creditorName: "Navient",
            monthlyPayment: "350",
            unpaidBalance: "30000",
            paidByOtherParty: true,
            otherPartyRelationship: "family_member",
            otherPartyInterestedParty: false,
          } as any,
        ],
      }),
    );
    expect(xml).toContain("<LiabilityExclusionIndicator>true</LiabilityExclusionIndicator>");
    const result = validateMismoExport(xml);
    expect(extractOffendingElements(result.errors)).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("phone normalization (MISMONumericString \\d* facet)", () => {
  // The fixture already stores formatted phones, so the two suites above cover
  // this. These pin the mechanism directly, because the failure mode is a
  // SILENT one: a digits-only fixture validates whether or not normalization
  // happens, and that vacuous pass is how the defect survived.
  it("emits only digits for every formatted phone the fixture carries", () => {
    const xml = generateMISMO34XML(baseDto());
    const values = [...xml.matchAll(/<ContactPointTelephoneValue>([^<]*)</g)].map(m => m[1]);
    // borrower cell + borrower home + employer work
    expect(values).toEqual(["5125550134", "5125550143", "5125550100"]);
    for (const v of values) expect(v).toMatch(/^\d*$/);
  });

  it.skipIf(!xmllintInstalled)("survives every format the client can store, incl. E.164 and extensions", () => {
    const xml = generateMISMO34XML(
      baseDto({
        personalInfo: {
          firstName: "Jane",
          lastName: "Doe",
          ssn: "123-45-6789",
          cellPhone: "+1 (512) 555-0134",
          homePhone: "512 555 0143 x22",
        } as any,
        employment: [
          {
            employerName: "Acme",
            employmentType: "employed",
            startDate: "2020-01-01",
            employerPhone: "512.555.0100",
          } as any,
        ],
      }),
    );
    expect(validateMismoExport(xml).valid).toBe(true);
  });

  it("omits the element entirely when nothing numeric survives", () => {
    const xml = generateMISMO34XML(
      baseDto({
        personalInfo: { firstName: "Jane", lastName: "Doe", cellPhone: "n/a" } as any,
        employment: [
          { employerName: "Acme", startDate: "2020-01-01", employerPhone: "--" } as any,
        ],
      }),
    );
    // An empty ContactPointTelephoneValue would be a worse record than none.
    expect(xml).not.toContain("ContactPointTelephoneValue");
    expect(xml).toContain("<FullName>Acme</FullName>");
  });
});

describe("URLA §5 DECLARATION block", () => {
  /** Direct children of DECLARATION_DETAIL, in document order. */
  function detailChildren(xml: string): string[] {
    const block = xml.match(/<DECLARATION_DETAIL>([\s\S]*?)<\/DECLARATION_DETAIL>/);
    expect(block, "export emitted no DECLARATION_DETAIL").not.toBeNull();
    const names: string[] = [];
    let depth = 0;
    for (const [, closing, name, selfClosing] of block![1].matchAll(
      /<(\/?)([A-Za-z_][\w:.-]*)[^>]*?(\/?)>/g,
    )) {
      if (closing) {
        depth--;
      } else {
        if (depth === 0) names.push(name);
        if (!selfClosing) depth++;
      }
    }
    return names;
  }

  it("puts every data point inside DECLARATION/DECLARATION_DETAIL", () => {
    const xml = generateMISMO34XML(baseDto());
    // Nothing may sit directly under DECLARATION — that was defect #1, and it
    // masked the other fourteen (libxml2 stops a container at its first
    // content-model failure).
    expect(xml).toMatch(/<DECLARATION>\s*<DECLARATION_DETAIL>/);
    expect(xml).toMatch(/<\/DECLARATION_DETAIL>\s*<\/DECLARATION>/);
  });

  it("emits DECLARATION_DETAIL children in the XSD's xsd:sequence order", () => {
    // MISMO_3_0.xsd:4052-4138. Order is mandatory: BankruptcyIndicator is a
    // real element name and was STILL rejected before this fix, purely for
    // being emitted fourteenth. Renaming without reordering does not validate.
    expect(detailChildren(generateMISMO34XML(baseDto()))).toEqual([
      "BankruptcyIndicator",
      "BorrowedDownPaymentIndicator",
      "CitizenshipResidencyType",
      "CoMakerEndorserOfNoteIndicator",
      "HomeownerPastThreeYearsType",
      "IntentToOccupyType",
      "OutstandingJudgmentsIndicator",
      "PartyToLawsuitIndicator",
      "PresentlyDelinquentIndicator",
      "EXTENSION",
    ]);
  });

  it("emits the two enumerated points as Yes/No, not true/false", () => {
    const yes = generateMISMO34XML(baseDto());
    expect(yes).toContain("<IntentToOccupyType>Yes</IntentToOccupyType>");
    expect(yes).toContain("<HomeownerPastThreeYearsType>No</HomeownerPastThreeYearsType>");

    const no = generateMISMO34XML(
      baseDto({
        declarations: {
          willOccupyAsPrimaryResidence: false,
          hasOwnershipInterestInPast3Years: true,
        } as any,
      }),
    );
    expect(no).toContain("<IntentToOccupyType>No</IntentToOccupyType>");
    expect(no).toContain("<HomeownerPastThreeYearsType>Yes</HomeownerPastThreeYearsType>");
  });

  it("collapses the two citizenship booleans onto one enumerated element", () => {
    expect(generateMISMO34XML(baseDto())).toContain(
      "<CitizenshipResidencyType>USCitizen</CitizenshipResidencyType>",
    );
    expect(
      generateMISMO34XML(
        baseDto({ declarations: { isPermanentResidentAlien: true } as any }),
      ),
    ).toContain("<CitizenshipResidencyType>PermanentResidentAlien</CitizenshipResidencyType>");
  });

  it("omits citizenship rather than inventing a category when both flags are false", () => {
    // The two-boolean model cannot tell "not a permanent resident alien" from
    // "never asked", and CitizenshipResidencyType offers NonPermanentResidentAlien
    // / NonResidentAlien / Unknown. Picking one would fabricate a fair-lending
    // -sensitive answer the borrower never gave.
    const bothFalse = generateMISMO34XML(
      baseDto({ declarations: { isUSCitizen: false, isPermanentResidentAlien: false } as any }),
    );
    expect(bothFalse).not.toContain("CitizenshipResidencyType");
    const neitherAsked = generateMISMO34XML(
      baseDto({ declarations: { willOccupyAsPrimaryResidence: true } as any }),
    );
    expect(neitherAsked).not.toContain("CitizenshipResidencyType");
  });

  it("never emits an element name that exists in neither local schema", () => {
    const xml = generateMISMO34XML(baseDto());
    // The 14 names the old emitter used that appear in NEITHER MISMO_3_0.xsd
    // nor ULDD_Phase_5_Extension.xsd. Their concepts stay captured in
    // borrower_declarations; an omitted data point is honest, an invented
    // element name is a fabricated record.
    for (const invented of [
      "IntentToOccupyIndicator",
      "HomeownerPastThreeYearsIndicator",
      "PropertySellerRelationshipIndicator",
      "MortgageOnOtherPropertyIndicator",
      "PriorityLienIndicator",
      "DelinquentPastDueIndicator",
      "DeedInLieuIndicator",
      "ShortSaleIndicator",
      "LoanForeclosureIndicator",
      "UndisclosedBorrowedFundsIndicator",
      "NewCreditIndicator",
      "PriorityLienPayoffIndicator",
      "USCitizenIndicator",
      "PermanentResidentAlienIndicator",
    ]) {
      expect(xml, `${invented} exists in neither schema`).not.toContain(`<${invented}>`);
    }
  });

  it("leaves the foreclosure pair undelivered pending escalation E-2", () => {
    // Two URLA 2020 questions (5b-J, 5b-L) map ambiguously onto two OVERLAPPING
    // MISMO points; the local sources do not settle which goes where. Guessing
    // would mis-state a seven-year derogatory event in a GSE delivery.
    const xml = generateMISMO34XML(
      baseDto({
        declarations: {
          hasBeenForeclosed: true,
          hasConveyedTitleInLieuOfForeclosure: true,
        } as any,
      }),
    );
    expect(xml).not.toContain("PropertyForeclosedPastSevenYearsIndicator");
    expect(xml).not.toContain("LoanForeclosureOrJudgmentIndicator");
  });

  it("omits DECLARATION entirely when no data point has a home", () => {
    const xml = generateMISMO34XML(
      baseDto({ declarations: { hasRelationshipWithSeller: true } as any }),
    );
    expect(xml).not.toContain("<DECLARATION>");
  });
});

describe("EXTENSION content is actually validated (not skipped)", () => {
  // MISMO_3_0.xsd's EXTENSION is `<xsd:any namespace="##any"
  // processContents="lax"/>`. `lax` validates only what it can RESOLVE, so with
  // the base schema alone every ULDD-namespace element was skipped in silence —
  // a fabricated name passed. These are the negative controls for that.
  const fabricated = (xml: string) =>
    xml.replace(
      "<ULDD:PriorPropertyShortSaleCompletedIndicator>",
      "<ULDD:TotallyMadeUpIndicator>",
    ).replace(
      "</ULDD:PriorPropertyShortSaleCompletedIndicator>",
      "</ULDD:TotallyMadeUpIndicator>",
    );

  it.skipIf(!xmllintInstalled)("emits the short sale at its one legal home, and it validates", () => {
    const xml = generateMISMO34XML(baseDto({ declarations: { hasCompletedShortSale: true } as any }));
    expect(xml).toContain(
      "<ULDD:PriorPropertyShortSaleCompletedIndicator>true</ULDD:PriorPropertyShortSaleCompletedIndicator>",
    );
    expect(validateMismoExport(xml).valid).toBe(true);
  });

  it.skipIf(!xmllintInstalled)("REJECTS a fabricated ULDD element name — the whole point of the wrapper", () => {
    const bad = fabricated(generateMISMO34XML(baseDto()));
    expect(bad).toContain("ULDD:TotallyMadeUpIndicator");
    expect(validateMismoExport(bad).valid).toBe(false);
  });

  it.skipIf(!xmllintInstalled)("documents the blind spot: the base schema alone passes that same document", () => {
    // Not an aspiration — this is what the gate did before 2026-08-06, and it
    // is why `validateMismoExport` exists rather than a bare MISMO_BASE_XSD.
    const bad = fabricated(generateMISMO34XML(baseDto()));
    expect(validateAgainstXsd(bad, MISMO_BASE_XSD).valid).toBe(true);
  });
});
