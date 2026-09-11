import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import { MoneyInput } from "./MoneyInput";
import { LIABILITY_TYPES, type LiabilityForm } from "./types";
import {
  OTHER_PARTY_RELATIONSHIPS,
  PAID_BY_OTHER_PARTY_INELIGIBLE_COPY,
  THIRD_PARTY_PAYMENT_HISTORY_MONTHS,
  assessPaidByOtherParty,
} from "@shared/liabilityExclusions";
import { isMortgageClassLiability, liabilityKind, STUDENT_LOAN_REPAYMENT_PLANS } from "@shared/liabilityTypes";

const STUDENT_PLAN_LABELS: Record<(typeof STUDENT_LOAN_REPAYMENT_PLANS)[number], string> = {
  income_driven: "Income-driven repayment",
  deferred: "Deferred",
  forbearance: "Forbearance",
  standard: "Standard repayment",
  other: "Other or not sure",
};

/** A three-state yes/no: unanswered is a real state the rule treats as "not yet". */
function YesNoSelect({
  id,
  label,
  value,
  onChange,
  testId,
}: {
  id: string;
  label: string;
  value: boolean | null | undefined;
  onChange: (value: boolean) => void;
  testId: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value === true ? "yes" : value === false ? "no" : ""}
        onValueChange={(v) => onChange(v === "yes")}
      >
        <SelectTrigger id={id} data-testid={testId}>
          <SelectValue placeholder="Choose..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="yes">Yes</SelectItem>
          <SelectItem value="no">No</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * B3-6-05, Debts Paid by Others. The borrower says who pays; the form asks
 * exactly the questions the rule turns on (interested party; for a mortgage,
 * payer on the loan and rental income from the property); and the status
 * line says plainly whether the payment left their ratio — and why not, if
 * it did not. The rule is shared/liabilityExclusions.ts, the same predicate
 * the engines read, so the form can never promise an exclusion the decision
 * will not apply.
 */
function PaidByOtherPartyFields({
  index,
  liability,
  update,
}: {
  index: number;
  liability: LiabilityForm;
  update: (patch: Partial<LiabilityForm>) => void;
}) {
  const mortgageClass = isMortgageClassLiability(liability.liabilityType);
  const assessment = assessPaidByOtherParty(liability);
  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center gap-2">
        <Checkbox
          id={`paid-by-other-${index}`}
          checked={!!liability.paidByOtherParty}
          onCheckedChange={(checked) => update({ paidByOtherParty: !!checked })}
          data-testid={`checkbox-paid-by-other-${index}`}
        />
        <Label htmlFor={`paid-by-other-${index}`} className="font-normal text-sm">
          Someone else makes the payments on this debt
        </Label>
      </div>
      {liability.paidByOtherParty && (
        <div
          className="rounded-md border border-border bg-muted/30 p-3 space-y-3"
          data-testid={`panel-paid-by-other-${index}`}
        >
          <p className="text-sm text-muted-foreground">
            When someone else has been making a payment, Fannie Mae lets us leave it out of your
            debt ratio. We will ask for the last {THIRD_PARTY_PAYMENT_HISTORY_MONTHS} months of
            their cancelled checks or bank statements showing the payments made on time.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`other-party-relationship-${index}`}>Who makes the payments?</Label>
              <Select
                value={liability.otherPartyRelationship || ""}
                onValueChange={(value) => update({ otherPartyRelationship: value })}
              >
                <SelectTrigger
                  id={`other-party-relationship-${index}`}
                  data-testid={`select-other-party-relationship-${index}`}
                >
                  <SelectValue placeholder="Choose..." />
                </SelectTrigger>
                <SelectContent>
                  {OTHER_PARTY_RELATIONSHIPS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <YesNoSelect
              id={`other-party-interested-${index}`}
              label="Is that person the seller, a real estate agent, or anyone else involved in this purchase?"
              value={liability.otherPartyInterestedParty}
              onChange={(v) => update({ otherPartyInterestedParty: v })}
              testId={`select-other-party-interested-${index}`}
            />
            {mortgageClass && (
              <>
                <YesNoSelect
                  id={`other-party-obligated-${index}`}
                  label="Is that person also on this mortgage?"
                  value={liability.otherPartyObligated}
                  onChange={(v) => update({ otherPartyObligated: v })}
                  testId={`select-other-party-obligated-${index}`}
                />
                <YesNoSelect
                  id={`uses-rental-income-${index}`}
                  label="Are you using rental income from this property to qualify?"
                  value={liability.usesRentalIncomeFromProperty}
                  onChange={(v) => update({ usesRentalIncomeFromProperty: v })}
                  testId={`select-uses-rental-income-${index}`}
                />
              </>
            )}
          </div>
          <p
            className={
              assessment.status === "excludable"
                ? "text-sm font-medium text-foreground"
                : "text-sm text-muted-foreground"
            }
            data-testid={`text-paid-by-other-status-${index}`}
          >
            {assessment.status === "excludable"
              ? `This payment is left out of your debt ratio. We'll request the ${THIRD_PARTY_PAYMENT_HISTORY_MONTHS}-month payment history from the person who pays.`
              : assessment.status === "ineligible"
                ? PAID_BY_OTHER_PARTY_INELIGIBLE_COPY[assessment.reason]
                : ""}
          </p>
        </div>
      )}
    </div>
  );
}

interface LiabilitiesSectionProps {
  liabilities: LiabilityForm[];
  onChange: (value: LiabilityForm[]) => void;
}

export function LiabilitiesSection({ liabilities, onChange }: LiabilitiesSectionProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Section 2: Liabilities - Debts and Obligations</CardTitle>
            <CardDescription>
              What you pay each month — credit cards, loans, alimony, and the like. Being
              thorough here prevents surprises during underwriting; nothing on this list
              disqualifies you.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="touch-target"
            onClick={() => onChange([...liabilities, {}])}
            data-testid="button-add-liability"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Liability
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {liabilities.map((liability, index) => (
          <div key={index} className="border rounded-lg p-4">
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-medium">Liability {index + 1}</h4>
              {index > 0 && (
                <Button
                  variant="ghost"
                  size="icon" aria-label="Delete"
                  onClick={() => onChange(liabilities.filter((_, i) => i !== index))}
                  data-testid={`button-remove-liability-${index}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-2">
                <Label>Liability Type</Label>
                <Select
                  value={liability.liabilityType || ""}
                  onValueChange={(value) => {
                    const updated = [...liabilities];
                    updated[index] = {
                      ...updated[index],
                      liabilityType: value,
                      ...(liabilityKind(value) === "student_loan" ? {} : { studentLoanRepaymentPlan: null }),
                      ...(["installment", "student_loan", "alimony", "child_support"].includes(liabilityKind(value))
                        ? {}
                        : { remainingTermMonths: null }),
                    };
                    onChange(updated);
                  }}
                >
                  <SelectTrigger data-testid={`select-liability-type-${index}`}>
                    <SelectValue placeholder="Select type..." />
                  </SelectTrigger>
                  <SelectContent>
                    {LIABILITY_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Creditor Name</Label>
                <Input
                  placeholder="Creditor"
                  value={liability.creditorName || ""}
                  onChange={(e) => {
                    const updated = [...liabilities];
                    updated[index] = { ...updated[index], creditorName: e.target.value };
                    onChange(updated);
                  }}
                  data-testid={`input-creditor-${index}`}
                />
              </div>
              <div className="space-y-2">
                <Label>Unpaid Balance</Label>
                <MoneyInput
                  value={liability.unpaidBalance || ""}
                  onChange={(e) => {
                    const updated = [...liabilities];
                    updated[index] = { ...updated[index], unpaidBalance: e.target.value };
                    onChange(updated);
                  }}
                  data-testid={`input-balance-${index}`}
                />
              </div>
              <div className="space-y-2">
                <Label>Monthly Payment</Label>
                <MoneyInput
                  value={liability.monthlyPayment || ""}
                  onChange={(e) => {
                    const updated = [...liabilities];
                    updated[index] = { ...updated[index], monthlyPayment: e.target.value };
                    onChange(updated);
                  }}
                  data-testid={`input-monthly-payment-${index}`}
                />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <Checkbox
                  id={`paid-off-${index}`}
                  checked={liability.toBePaidOff || false}
                  onCheckedChange={(checked) => {
                    const updated = [...liabilities];
                    updated[index] = { ...updated[index], toBePaidOff: !!checked };
                    onChange(updated);
                  }}
                  data-testid={`checkbox-paid-off-${index}`}
                />
                <Label htmlFor={`paid-off-${index}`} className="font-normal text-sm">To be paid off</Label>
              </div>
            </div>
            {[
              "installment",
              "student_loan",
              "alimony",
              "child_support",
            ].includes(liabilityKind(liability.liabilityType)) && (
              <div className="mt-4 grid gap-4 rounded-md border bg-muted/20 p-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`remaining-payments-${index}`}>Payments remaining</Label>
                  <Input
                    id={`remaining-payments-${index}`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={1200}
                    step={1}
                    value={liability.remainingTermMonths ?? ""}
                    onChange={(event) => {
                      const updated = [...liabilities];
                      updated[index] = {
                        ...updated[index],
                        remainingTermMonths: event.target.value === "" ? null : Number(event.target.value),
                      };
                      onChange(updated);
                    }}
                    data-testid={`input-remaining-payments-${index}`}
                  />
                  <p className="text-xs text-muted-foreground">
                    A reviewer checks the statement before using a shorter remaining term in your mortgage calculation. Vehicle leases still count regardless of term.
                  </p>
                </div>
                {liabilityKind(liability.liabilityType) === "student_loan" && (
                  <div className="space-y-2">
                    <Label htmlFor={`student-plan-${index}`}>Current repayment plan</Label>
                    <Select
                      value={liability.studentLoanRepaymentPlan || ""}
                      onValueChange={(value) => {
                        const updated = [...liabilities];
                        updated[index] = { ...updated[index], studentLoanRepaymentPlan: value };
                        onChange(updated);
                      }}
                    >
                      <SelectTrigger id={`student-plan-${index}`} data-testid={`select-student-plan-${index}`}>
                        <SelectValue placeholder="Choose plan..." />
                      </SelectTrigger>
                      <SelectContent>
                        {STUDENT_LOAN_REPAYMENT_PLANS.map(plan => (
                          <SelectItem key={plan} value={plan}>{STUDENT_PLAN_LABELS[plan]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      If an income-driven plan currently requires $0, upload the latest student-loan statement. Your loan officer can use $0 only after reviewing that evidence.
                    </p>
                  </div>
                )}
              </div>
            )}
            <PaidByOtherPartyFields
              index={index}
              liability={liability}
              update={(patch) => {
                const updated = [...liabilities];
                updated[index] = { ...updated[index], ...patch };
                onChange(updated);
              }}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
