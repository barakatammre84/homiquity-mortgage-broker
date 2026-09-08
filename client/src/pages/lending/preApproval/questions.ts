// The pre-approval funnel's question catalog — step definitions, options,
// and the persisted-step-marker mapping. Extracted verbatim from PreApproval.tsx.
import { type PreApprovalFormData } from "@shared/schema";
import {
  DollarSign,
  Home,
  Briefcase,
  Building2,
  TrendingUp,
  Clock,
  CreditCard,
  MapPin,
  Shield,
  Users,
  Check,
  HelpCircle,
  Minus,
  Percent,
} from "lucide-react";

import { type FunnelStepId } from "@/funnel/preApprovalMachine";

export type QuestionType = "intro" | "choice" | "currency" | "number" | "state" | "boolean_pair" | "income_sources" | "final";

export interface QuestionOption {
  value: string;
  label: string;
  icon?: typeof Home;
}

export interface Question {
  id: string;
  field?: keyof PreApprovalFormData;
  type: QuestionType;
  question?: string;
  title?: string;
  subtitle?: string;
  buttonText?: string;
  options?: QuestionOption[];
  placeholder?: string;
  subtext?: string;
  /** "Why we ask" micro-copy — shown below the input, doubles as mobile
   * parity for the desktop-only advisory panel. */
  why?: string;
  icon?: typeof Home;
  booleanFields?: { field: keyof PreApprovalFormData; label: string; icon: typeof Home }[];
}

export const QUESTIONS: Question[] = [
  {
    id: "intro",
    type: "intro",
    title: "Let's get you home.",
    subtitle: "Get a preliminary answer and a clear next step in about 3 minutes. No hard credit check.",
    buttonText: "Start My Pre-Approval"
  },
  {
    id: "loanPurpose",
    field: "loanPurpose",
    type: "choice",
    question: "What are you looking to do?",
    why: "Purpose determines which loan programs and rates apply to you.",
    icon: Home,
    options: [
      { value: "purchase", label: "Buying a Home", icon: Home },
      { value: "refinance", label: "Refinancing My Home", icon: TrendingUp },
      { value: "cash_out", label: "Cash-Out Refinance", icon: DollarSign }
    ]
  },
  {
    id: "occupancyType",
    field: "occupancyType",
    type: "choice",
    question: "How will you use this home?",
    why: "Occupancy changes which loan programs, down payments, and rates are available.",
    icon: Home,
    options: [
      { value: "primary_residence", label: "Primary Residence", icon: Home },
      { value: "second_home", label: "Second Home", icon: Home },
      { value: "investment", label: "Investment Property", icon: Building2 },
    ],
  },
  {
    id: "propertyType",
    field: "propertyType",
    type: "choice",
    question: "What kind of property are we looking at?",
    why: "Property type affects your rate and reserve requirements.",
    icon: Building2,
    options: [
      { value: "single_family", label: "Single Family Home", icon: Home },
      { value: "condo", label: "Condo", icon: Building2 },
      { value: "townhouse", label: "Townhouse", icon: Building2 },
      { value: "multi_family", label: "Multi-Family (2-4 Units)", icon: Users }
    ]
  },
  {
    id: "numberOfUnits",
    field: "numberOfUnits",
    type: "number",
    question: "How many units are in the property?",
    placeholder: "2",
    subtext: "Enter 2, 3, or 4 units.",
    why: "The exact unit count affects loan limits, reserve rules, and how rental income is evaluated.",
    icon: Building2,
  },
  {
    id: "subjectMonthlyRentalIncome",
    field: "subjectMonthlyRentalIncome",
    type: "currency",
    question: "What monthly rent do you expect from this property?",
    placeholder: "3,000",
    subtext: "Use the current total rent, expected market rent, or 0 if none is expected.",
    why: "Projected rent can affect qualification, but it must be documented and reviewed before it counts.",
    icon: DollarSign,
  },
  {
    // Asked BEFORE price/down payment so VA eligibility can unlock the
    // zero-down path and suppress PMI guidance (the machine reorders routing;
    // this array is just the step registry).
    id: "veteranAndFirstTime",
    type: "boolean_pair",
    question: "These help us find programs you may qualify for",
    why: "Veterans can unlock $0-down VA loans; first-time buyers unlock assistance programs.",
    icon: Shield,
    booleanFields: [
      { field: "isVeteran", label: "I am a U.S. military veteran or active duty", icon: Shield },
      { field: "isFirstTimeBuyer", label: "I am a first-time home buyer", icon: Home },
      // UAL P7 routing signal. Product-preference wording only (marketing-
      // integrity rules: any certification is the funder's — never claim our
      // own, never use faith terms). Routes the file; promises nothing.
      { field: "avoidsInterestFinancing", label: "I require financing that avoids interest", icon: Percent }
    ]
  },
  {
    id: "purchasePrice",
    field: "purchasePrice",
    type: "currency",
    question: "What is the estimated purchase price?",
    placeholder: "500,000",
    subtext: "It's okay to estimate if you haven't found 'the one' yet.",
    why: "This anchors your loan amount so we can estimate a realistic monthly payment.",
    icon: DollarSign
  },
  {
    id: "downPayment",
    field: "downPayment",
    type: "currency",
    question: "How much are you planning to put down?",
    placeholder: "100,000",
    subtext: "We can adjust this later to fine-tune your monthly payment.",
    why: "You don't need 20% down — some programs start around 3%. This just sets your starting point.",
    icon: DollarSign
  },
  {
    id: "propertyState",
    field: "propertyState",
    type: "state",
    question: "Which state are you looking to buy in?",
    why: "Rates, taxes, and available programs vary by state.",
    icon: MapPin,
    subtext: "Select from the list below"
  },
  {
    // VA-only step (routed in only when isVeteran): family size selects the
    // regional residual-income requirement for VA underwriting.
    id: "householdFamilySize",
    field: "householdFamilySize",
    type: "number",
    question: "How many people are in your household?",
    placeholder: "3",
    subtext: "Include yourself, your spouse, and any dependents.",
    why: "VA loans are approved on residual income — the money left over each month — and the requirement scales with household size.",
    icon: Users
  },
  {
    // VA-only step: square footage drives the VA utility-cost deduction
    // ($0.14/sqft) in the residual-income calculation.
    id: "homeSquareFootage",
    field: "homeSquareFootage",
    type: "number",
    question: "Roughly how big is the home you're buying?",
    placeholder: "2,000",
    subtext: "Square footage — an estimate is fine if you're still shopping.",
    why: "The VA estimates utility costs from square footage when checking that the loan leaves you enough residual income.",
    icon: Home
  },
  {
    id: "annualIncome",
    field: "annualIncome",
    type: "currency",
    question: "What is your estimated total annual household income?",
    placeholder: "120,000",
    subtext: "Before taxes. Include jobs, businesses, rentals, retirement, and other income; we'll break it down next.",
    why: "Income and debts together set your buying power — lenders compare them, not income alone.",
    icon: Briefcase
  },
  {
    id: "employmentType",
    field: "employmentType",
    type: "choice",
    question: "How are you employed?",
    why: "This determines which income documents we'll ask for — nothing else.",
    icon: Briefcase,
    options: [
      { value: "employed", label: "W-2 Employee", icon: Briefcase },
      { value: "self_employed", label: "Self-Employed / 1099", icon: Users },
      { value: "retired", label: "Retired", icon: Clock },
      { value: "other", label: "Other", icon: Users }
    ]
  },
  {
    id: "employmentYears",
    field: "employmentYears",
    type: "number",
    question: "How many years have you been at your current job?",
    placeholder: "5",
    subtext: "Round to the nearest year",
    why: "A shorter tenure doesn't disqualify you — recent job changes in the same field usually count as continuous history.",
    icon: Clock
  },
  {
    id: "hasAdditionalIncome",
    field: "hasAdditionalIncome",
    type: "choice",
    question: "Does that total include income outside your main job or source?",
    why: "Breaking down the total helps us request the right documents without counting income twice.",
    icon: TrendingUp,
    options: [
      { value: "yes", label: "Yes, break it down", icon: TrendingUp },
      // NOT a checkmark. A tick beside "No, this is my only income" reads as
      // "already answered" — which, next to a tile that used to arrive
      // pre-highlighted, is a large part of why borrowers reported answering
      // No and being taken to the other-income step anyway. The radio dot on
      // the right of the tile is the only selection signal.
      { value: "no", label: "No, that is my only income", icon: Minus }
    ]
  },
  {
    id: "incomeSources",
    type: "income_sources",
    question: "What other income is included in your total?",
    subtext: "Select all that apply, then break down the amount from each source."
  },
  {
    id: "monthlyDebts",
    field: "monthlyDebts",
    type: "currency",
    question: "What are your total monthly debt payments?",
    placeholder: "1,500",
    subtext: "Car, student, and personal loans, credit card minimums, child support. Don't include rent, utilities, or groceries.",
    why: "Only the monthly minimums count here — not your total balances. This is the other half of your debt-to-income ratio.",
    icon: CreditCard
  },
  {
    id: "creditScore",
    field: "creditScore",
    type: "choice",
    question: "Roughly, what is your credit score?",
    subtext: "An estimate is fine -- we'll verify this later with a soft check that won't affect your score.",
    icon: CreditCard,
    options: [
      { value: "760", label: "760+", icon: Check },
      { value: "720", label: "720-759", icon: Check },
      { value: "680", label: "680-719", icon: Check },
      { value: "640", label: "640-679", icon: Check },
      { value: "600", label: "Under 640", icon: Check },
      { value: "not_sure", label: "Not sure", icon: HelpCircle }
    ]
  },
  {
    id: "final",
    type: "final",
    question: "You're almost there!",
    subtitle: "Authorize the soft credit check below and submit to get your personalized loan options."
  }
];

export const QUESTIONS_BY_ID: Record<string, Question> = Object.fromEntries(
  QUESTIONS.map((q) => [q.id, q]),
);

/** Map a persisted step marker to a valid step id (tolerates legacy numeric markers). */
export function toStepId(raw: string): FunnelStepId {
  return QUESTIONS_BY_ID[raw] ? (raw as FunnelStepId) : "loanPurpose";
}
