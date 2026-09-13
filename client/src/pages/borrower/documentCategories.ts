// Static document-checklist catalog and category metadata for the borrower
// Documents page. Kept as a standalone data module so the page component
// stays focused on state/data-fetching and presentation, not this catalog.
import { titleCaseFromSnake } from "@/lib/formatters";
import { documentTypesMatch } from "@shared/documentTypes";
import {
  User,
  DollarSign,
  Building2,
  CreditCard,
  Home,
  Shield,
  FileText,
  ClipboardList,
} from "lucide-react";

// Document categories with their required document types
export const DOCUMENT_CATEGORIES = [
  {
    id: "identity",
    name: "Identity & Compliance",
    description: "Government-issued ID and identity verification",
    icon: User,
    color: "text-chart-1",
    bgColor: "bg-chart-1/10",
    documents: [
      { type: "drivers_license", name: "Driver's License", required: true, description: "Valid state-issued driver's license" },
      { type: "passport", name: "Passport", required: false, description: "Valid passport (alternative to driver's license)" },
      { type: "ssn_card", name: "Social Security Card", required: false, description: "Social Security card if available" },
    ]
  },
  {
    id: "income",
    name: "Income Verification",
    description: "Pay stubs, tax returns, and employment documents",
    icon: DollarSign,
    color: "text-chart-2",
    bgColor: "bg-chart-2/10",
    documents: [
      { type: "paystub", name: "Recent Pay Stubs", required: true, description: "Last 30 days of pay stubs" },
      { type: "w2", name: "W-2 Forms", required: true, description: "W-2s from the last 2 years" },
      { type: "employment_verification", name: "Employment Verification", required: false, description: "Employer letter or verification showing a known change in pay" },
      { type: "tax_return_1040", name: "Tax Returns (1040)", required: true, description: "Personal tax returns from last 2 years" },
      { type: "rental_tax_package", name: "Rental Income Tax Package", required: false, description: "Signed tax return with Schedule 1 and Schedule E" },
      { type: "capital_gains_tax_package", name: "Capital Gains Tax Package", required: false, description: "Two signed tax returns with Schedule D for each year" },
      { type: "1099_misc", name: "1099 Forms", required: false, description: "1099 forms if you have additional income" },
      { type: "1099_nec", name: "1099-NEC Forms", required: false, description: "Nonemployee compensation forms for contract work" },
      { type: "profit_loss", name: "Profit & Loss Statement", required: false, description: "For self-employed borrowers" },
      { type: "business_license", name: "Business Records", required: false, description: "Business license or formation records" },
      { type: "social_security_award_letter", name: "Social Security Award Letter", required: false, description: "If receiving Social Security income" },
    ]
  },
  {
    id: "assets",
    name: "Assets & Savings",
    description: "Bank statements, retirement accounts, and investments",
    icon: Building2,
    color: "text-chart-4",
    bgColor: "bg-chart-4/10",
    documents: [
      { type: "bank_statement_checking", name: "Checking Account Statements", required: true, description: "Last 2 months of statements" },
      { type: "bank_statement_savings", name: "Savings Account Statements", required: true, description: "Last 2 months of statements" },
      { type: "bank_statement_business", name: "Business Bank Statements", required: false, description: "Recent business account statements" },
      { type: "retirement_statement_401k", name: "401(k) Statement", required: false, description: "Most recent quarterly statement" },
      { type: "retirement_statement_ira", name: "IRA Statement", required: false, description: "Most recent quarterly statement" },
      { type: "brokerage_statement", name: "Brokerage Statement", required: false, description: "Investment account statements" },
      { type: "gift_letter", name: "Gift Letter", required: false, description: "If receiving gift funds for down payment" },
    ]
  },
  {
    id: "liabilities",
    name: "Current Debts",
    description: "Existing mortgages, loans, and credit obligations",
    icon: CreditCard,
    color: "text-chart-3",
    bgColor: "bg-chart-3/10",
    documents: [
      { type: "mortgage_statement", name: "Mortgage Statement", required: false, description: "Current mortgage payment info (if applicable)" },
      { type: "auto_loan_statement", name: "Auto Loan Statement", required: false, description: "Current auto loan info (if applicable)" },
      { type: "student_loan_statement", name: "Student Loan Statement", required: false, description: "Student loan payment info (if applicable)" },
      { type: "credit_card_statement", name: "Credit Card Statements", required: false, description: "Most recent statements" },
    ]
  },
  {
    id: "property",
    name: "Property & Transaction",
    description: "Purchase contract, insurance, and property documents",
    icon: Home,
    color: "text-chart-5",
    bgColor: "bg-chart-5/10",
    documents: [
      { type: "purchase_contract", name: "Purchase Contract", required: true, description: "Signed purchase agreement" },
      { type: "earnest_money_receipt", name: "Earnest Money Receipt", required: true, description: "Proof of earnest money deposit" },
      { type: "homeowners_insurance_binder", name: "Homeowners Insurance Binder", required: true, description: "Proof of insurance coverage" },
      { type: "appraisal_report", name: "Appraisal Report", required: false, description: "Provided by lender" },
      { type: "title_commitment", name: "Title Commitment", required: false, description: "Provided by title company" },
    ]
  },
];

// Workflow-triggered education: after an upload, tell the borrower what the
// team actually does with that document, keyed by category. Factual process
// descriptions only — no approval promises or timelines we can't keep.
export const UPLOAD_NEXT_STEPS: Record<string, string> = {
  identity:
    "We'll use this to confirm your identity — a standard step for every mortgage. You'll be notified once it's verified.",
  income:
    "Our team will use this to verify your income, which is what turns your estimated numbers into a documented pre-approval. You'll be notified when it's reviewed.",
  assets:
    "We'll review this to document your funds for the down payment and closing costs. If we have questions about any deposits, we'll reach out — that's routine.",
  liabilities:
    "We'll use this to confirm your monthly payments so your debt-to-income numbers are accurate. You'll be notified when it's reviewed.",
  property:
    "This moves your file forward toward final review. We'll let you know if the underwriter needs anything else about the property.",
};

// Friendly names for document types, falling back to prettified snake_case for
// condition-required types that aren't in the static catalog (e.g. a letter of
// explanation added by an underwriter).
const DOC_TYPE_NAMES: Record<string, string> = Object.fromEntries(
  DOCUMENT_CATEGORIES.flatMap((cat) => cat.documents.map((d) => [d.type, d.name])),
);

export function docTypeName(type: string): string {
  return DOC_TYPE_NAMES[type] ?? titleCaseFromSnake(type);
}

export function getUploadNextStep(docType: string): string {
  const category = DOCUMENT_CATEGORIES.find(cat =>
    cat.documents.some(d => documentTypesMatch(d.type, docType))
  );
  return (
    (category && UPLOAD_NEXT_STEPS[category.id]) ||
    "We'll review it shortly. You'll be notified when it's processed."
  );
}

// Category shells for the personalized path — same visual system as the
// static catalog (CONDITION_CATEGORIES vocabulary from the pipeline engine).
export const CONDITION_CATEGORY_META: Record<
  string,
  { name: string; description: string; icon: typeof User; color: string; bgColor: string }
> = {
  income: { name: "Income Verification", description: "Pay stubs, tax returns, and employment documents", icon: DollarSign, color: "text-chart-2", bgColor: "bg-chart-2/10" },
  assets: { name: "Assets & Savings", description: "Bank statements and reserve documentation", icon: Building2, color: "text-chart-4", bgColor: "bg-chart-4/10" },
  credit: { name: "Credit & Liabilities", description: "Statements and explanations for credit items", icon: CreditCard, color: "text-chart-3", bgColor: "bg-chart-3/10" },
  property: { name: "Property & Transaction", description: "Contract, appraisal, and property documents", icon: Home, color: "text-chart-5", bgColor: "bg-chart-5/10" },
  insurance: { name: "Insurance", description: "Homeowners and other required coverage", icon: Shield, color: "text-chart-1", bgColor: "bg-chart-1/10" },
  title: { name: "Title", description: "Title and closing documentation", icon: FileText, color: "text-chart-4", bgColor: "bg-chart-4/10" },
  compliance: { name: "Identity & Compliance", description: "Government-issued ID and identity verification", icon: User, color: "text-chart-1", bgColor: "bg-chart-1/10" },
  other: { name: "Other Requests", description: "Additional items your loan team asked for", icon: ClipboardList, color: "text-chart-2", bgColor: "bg-chart-2/10" },
};
