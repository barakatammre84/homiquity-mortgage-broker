import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { US_STATES } from "@/lib/us-states";
import { Plus, Trash2 } from "lucide-react";
import type { EmploymentHistory, OtherIncomeSource } from "@shared/schema";
import { MoneyInput } from "./MoneyInput";
import { SelfEmploymentIncomeWorksheet } from "./SelfEmploymentIncomeWorksheet";
import { INCOME_SOURCES, type AssetForm } from "./types";

interface EmploymentSectionProps {
  employmentRecords: Partial<EmploymentHistory>[];
  onChange: (value: Partial<EmploymentHistory>[]) => void;
  otherIncomes: Partial<OtherIncomeSource>[];
  onOtherIncomesChange: (value: Partial<OtherIncomeSource>[]) => void;
  assets: AssetForm[];
}

export function EmploymentSection({
  employmentRecords,
  onChange,
  otherIncomes,
  onOtherIncomesChange,
  assets,
}: EmploymentSectionProps) {
  const retirementAssets = assets.flatMap((asset, index) => {
    if (!/retirement|401\s*\(?k\)?|\bira\b|\bsep\b|keogh/i.test(asset.accountType ?? "")) return [];
    const last4 = asset.accountNumberLast4
      ?? asset.accountNumber?.replace(/\D/g, "").slice(-4)
      ?? "";
    if (last4.length !== 4) return [];
    return [{
      value: last4,
      label: `${asset.financialInstitution || asset.accountType || `Retirement account ${index + 1}`} ·••••${last4}`,
    }];
  });
  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>Section 1b: Current Employment/Self-Employment and Income</CardTitle>
              <CardDescription>
                Walk us through the last two years of work — it lets underwriting verify your
                income without extra back-and-forth later.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="touch-target"
              onClick={() => onChange([...employmentRecords, { employmentType: "additional" }])}
              data-testid="button-add-employment"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Employment
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {employmentRecords.map((emp, index) => (
            <div key={index} className="border rounded-lg p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold">
                  {index === 0 ? "Current Employment" : `Additional Employment ${index}`}
                </h4>
                {index > 0 && (
                  <Button
                    variant="ghost"
                    size="icon" aria-label="Delete"
                    onClick={() => onChange(employmentRecords.filter((_, i) => i !== index))}
                    data-testid={`button-remove-employment-${index}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="sm:col-span-2 space-y-2">
                  <Label>Employer or Business Name</Label>
                  <Input
                    placeholder="Employer Name"
                    value={emp.employerName || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], employerName: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-employer-name-${index}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Phone</Label>
                  <Input
                    placeholder="(xxx) xxx-xxxx"
                    value={emp.employerPhone || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], employerPhone: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-employer-phone-${index}`}
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="sm:col-span-2 space-y-2">
                  <Label>Street Address</Label>
                  <Input
                    placeholder="Street Address"
                    value={emp.employerStreet || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], employerStreet: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-employer-street-${index}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label>City</Label>
                  <Input
                    placeholder="City"
                    value={emp.employerCity || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], employerCity: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-employer-city-${index}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label>State</Label>
                  <Select
                    value={emp.employerState || ""}
                    onValueChange={(value) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], employerState: value };
                      onChange(updated);
                    }}
                  >
                    <SelectTrigger data-testid={`select-employer-state-${index}`}>
                      <SelectValue placeholder="State" />
                    </SelectTrigger>
                    <SelectContent>
                      {US_STATES.map((state) => (
                        <SelectItem key={state.value} value={state.value}>{state.value}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-2">
                  <Label>Position or Title</Label>
                  <Input
                    placeholder="Position Title"
                    value={emp.positionTitle || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], positionTitle: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-position-${index}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Start Date</Label>
                  <Input
                    type="date"
                    value={emp.startDate || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], startDate: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-start-date-${index}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Years in Line of Work</Label>
                  <Input
                    type="number"
                    min="0"
                    value={emp.yearsInLineOfWork ?? ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], yearsInLineOfWork: parseInt(e.target.value) || 0 };
                      onChange(updated);
                    }}
                    data-testid={`input-years-work-${index}`}
                  />
                </div>
                <div className="flex items-center gap-2 pt-6">
                  <Checkbox
                    id={`self-employed-${index}`}
                    checked={!!emp.isSelfEmployed}
                    onCheckedChange={(checked) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], isSelfEmployed: !!checked };
                      onChange(updated);
                    }}
                    data-testid={`checkbox-self-employed-${index}`}
                  />
                  <Label htmlFor={`self-employed-${index}`} className="font-normal">Self-Employed</Label>
                </div>
                <div className="space-y-2">
                  <Label>Is any income from this job or business paid in cryptocurrency?</Label>
                  <Select
                    value={emp.paidInVirtualCurrency === true
                      ? "yes"
                      : emp.paidInVirtualCurrency === false ? "no" : "unknown"}
                    onValueChange={(value) => {
                      const updated = [...employmentRecords];
                      updated[index] = {
                        ...updated[index],
                        paidInVirtualCurrency: value === "unknown" ? null : value === "yes",
                      };
                      onChange(updated);
                    }}
                  >
                    <SelectTrigger data-testid={`select-employment-virtual-currency-${index}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="no">No</SelectItem>
                      <SelectItem value="yes">Yes</SelectItem>
                      <SelectItem value="unknown">I’m not sure</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <hr />

              <h5 className="font-medium">Gross Monthly Income</h5>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="space-y-2">
                  <Label>Base Income</Label>
                  <MoneyInput
                    value={emp.baseIncome || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], baseIncome: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-base-income-${index}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Overtime</Label>
                  <MoneyInput
                    value={emp.overtimeIncome || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], overtimeIncome: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-overtime-${index}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Bonus</Label>
                  <MoneyInput
                    value={emp.bonusIncome || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], bonusIncome: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-bonus-${index}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Commission</Label>
                  <MoneyInput
                    value={emp.commissionIncome || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], commissionIncome: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-commission-${index}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Military Entitlements</Label>
                  <MoneyInput
                    value={emp.militaryEntitlements || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], militaryEntitlements: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-military-${index}`}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Other Income</Label>
                  <MoneyInput
                    value={emp.otherIncome || ""}
                    onChange={(e) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], otherIncome: e.target.value };
                      onChange(updated);
                    }}
                    data-testid={`input-other-income-${index}`}
                  />
                </div>
              </div>

              {!emp.isSelfEmployed && (
                <div className="rounded-xl border border-border/70 bg-muted/30 p-4 space-y-4">
                  <div className="space-y-1">
                    <Label>Do you know if this income will decrease?</Label>
                    <p className="text-sm text-muted-foreground">
                      Tell us about a planned retirement, reduced hours, job change, or other confirmed pay change so your estimate stays accurate.
                    </p>
                  </div>
                  <Select
                    value={emp.hasKnownFutureIncomeReduction === true
                      ? "yes"
                      : emp.hasKnownFutureIncomeReduction === false ? "no" : "unknown"}
                    onValueChange={(value) => {
                      const updated = [...employmentRecords];
                      updated[index] = {
                        ...updated[index],
                        hasKnownFutureIncomeReduction: value === "unknown" ? null : value === "yes",
                        ...(value === "yes" ? {} : {
                          futureMonthlyIncome: null,
                          futureIncomeEffectiveDate: null,
                          futureIncomeReason: null,
                        }),
                      };
                      onChange(updated);
                    }}
                  >
                    <SelectTrigger data-testid={`select-future-income-reduction-${index}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unknown">Choose an answer</SelectItem>
                      <SelectItem value="no">No known decrease</SelectItem>
                      <SelectItem value="yes">Yes, it will decrease</SelectItem>
                    </SelectContent>
                  </Select>

                  {emp.hasKnownFutureIncomeReduction === true && (
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="space-y-2">
                        <Label>Future gross monthly income</Label>
                        <MoneyInput
                          value={emp.futureMonthlyIncome ?? ""}
                          onChange={(e) => {
                            const updated = [...employmentRecords];
                            updated[index] = { ...updated[index], futureMonthlyIncome: e.target.value };
                            onChange(updated);
                          }}
                          data-testid={`input-future-monthly-income-${index}`}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Effective date</Label>
                        <Input
                          type="date"
                          value={emp.futureIncomeEffectiveDate ?? ""}
                          onChange={(e) => {
                            const updated = [...employmentRecords];
                            updated[index] = { ...updated[index], futureIncomeEffectiveDate: e.target.value };
                            onChange(updated);
                          }}
                          data-testid={`input-future-income-date-${index}`}
                        />
                      </div>
                      <div className="space-y-2 sm:col-span-2 lg:col-span-1">
                        <Label>What is changing?</Label>
                        <Input
                          placeholder="For example, retiring or moving to reduced hours"
                          value={emp.futureIncomeReason ?? ""}
                          onChange={(e) => {
                            const updated = [...employmentRecords];
                            updated[index] = { ...updated[index], futureIncomeReason: e.target.value };
                            onChange(updated);
                          }}
                          data-testid={`input-future-income-reason-${index}`}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {emp.isSelfEmployed && (
                <>
                  <hr />
                  <SelfEmploymentIncomeWorksheet
                    index={index}
                    value={emp.selfEmploymentIncome}
                    onChange={(next) => {
                      const updated = [...employmentRecords];
                      updated[index] = { ...updated[index], selfEmploymentIncome: next ?? undefined };
                      onChange(updated);
                    }}
                  />
                </>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>Section 1e: Income from Other Sources</CardTitle>
              <CardDescription>
                Include retirement, Social Security, disability, capital gains, or anything else
                you'd like us to review for qualification.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="touch-target"
              onClick={() => onOtherIncomesChange([...otherIncomes, {}])}
              data-testid="button-add-other-income"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Income Source
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {otherIncomes.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Nothing here yet — and that's fine. Add a source only if you have income beyond
              your employment.
            </p>
          ) : (
            <div className="space-y-4">
              {otherIncomes.map((income, index) => (
                <div key={index} className="rounded-lg border p-4 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <div className="space-y-2">
                      <Label>Income Source</Label>
                      <Select
                        value={income.incomeSource || ""}
                        onValueChange={(value) => {
                          const updated = [...otherIncomes];
                          updated[index] = value === "Capital Gains" || value === "Employment-Related Assets as Income"
                            ? {
                                ...updated[index],
                                incomeSource: value,
                                monthlyAmount: "0",
                                taxTreatment: "taxable",
                                nonTaxableMonthlyAmount: null,
                                hasDefinedExpiration: false,
                                expirationDate: null,
                                paidInVirtualCurrency: false,
                                ...(value === "Employment-Related Assets as Income" ? {
                                  linkedAssetAccountLast4: null,
                                  assetOwnershipType: null,
                                  hasUnrestrictedAccess: null,
                                  fullDistributionPenaltyAmount: null,
                                  fundsUsedForTransaction: null,
                                } : {}),
                              }
                            : { ...updated[index], incomeSource: value };
                          onOtherIncomesChange(updated);
                        }}
                      >
                        <SelectTrigger data-testid={`select-income-source-${index}`}>
                          <SelectValue placeholder="Select source..." />
                        </SelectTrigger>
                        <SelectContent>
                          {INCOME_SOURCES.map((source) => (
                            <SelectItem key={source} value={source}>{source}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {income.incomeSource === "Capital Gains" ? (
                      <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                        No estimate needed. We calculate this from your two most recent Schedule D
                        forms and a current brokerage statement.
                      </div>
                    ) : income.incomeSource === "Employment-Related Assets as Income" ? (
                      <div className="space-y-2">
                        <Label>Retirement account</Label>
                        {retirementAssets.length > 0 ? (
                          <Select
                            value={income.linkedAssetAccountLast4 || ""}
                            onValueChange={(value) => {
                              const updated = [...otherIncomes];
                              updated[index] = { ...updated[index], linkedAssetAccountLast4: value };
                              onOtherIncomesChange(updated);
                            }}
                          >
                            <SelectTrigger data-testid={`select-employment-asset-${index}`}>
                              <SelectValue placeholder="Select account..." />
                            </SelectTrigger>
                            <SelectContent>
                              {retirementAssets.map((asset) => (
                                <SelectItem key={asset.value} value={asset.value}>{asset.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                            Add your retirement account in the Assets step, including the account number, then return here to select it.
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Label>Monthly Amount</Label>
                        <MoneyInput
                          value={income.monthlyAmount || ""}
                          onChange={(e) => {
                            const updated = [...otherIncomes];
                            updated[index] = { ...updated[index], monthlyAmount: e.target.value };
                            onOtherIncomesChange(updated);
                          }}
                          data-testid={`input-income-amount-${index}`}
                        />
                      </div>
                    )}
                    <Button
                      variant="ghost"
                      size="icon" aria-label="Delete"
                      onClick={() => onOtherIncomesChange(otherIncomes.filter((_, i) => i !== index))}
                      data-testid={`button-remove-income-${index}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  {income.incomeSource === "Employment-Related Assets as Income" && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label>How is this account owned?</Label>
                        <Select
                          value={income.assetOwnershipType || ""}
                          onValueChange={(value) => {
                            const updated = [...otherIncomes];
                            updated[index] = { ...updated[index], assetOwnershipType: value };
                            onOtherIncomesChange(updated);
                          }}
                        >
                          <SelectTrigger data-testid={`select-employment-asset-ownership-${index}`}><SelectValue placeholder="Select ownership..." /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="individual">I own it individually</SelectItem>
                            <SelectItem value="joint_with_coborrower">Jointly with a co-borrower on this loan</SelectItem>
                            <SelectItem value="joint_other">Jointly with someone who is not on this loan</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Can you request the full balance now, without employer or plan approval?</Label>
                        <Select
                          value={income.hasUnrestrictedAccess === true ? "yes" : income.hasUnrestrictedAccess === false ? "no" : ""}
                          onValueChange={(value) => {
                            const updated = [...otherIncomes];
                            updated[index] = { ...updated[index], hasUnrestrictedAccess: value === "yes" };
                            onOtherIncomesChange(updated);
                          }}
                        >
                          <SelectTrigger data-testid={`select-employment-asset-access-${index}`}><SelectValue placeholder="Select..." /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="yes">Yes, I can request all funds</SelectItem>
                            <SelectItem value="no">No or I’m not sure</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label>Penalty if the full account were distributed</Label>
                        <MoneyInput
                          value={income.fullDistributionPenaltyAmount || ""}
                          onChange={(event) => {
                            const updated = [...otherIncomes];
                            updated[index] = { ...updated[index], fullDistributionPenaltyAmount: event.target.value };
                            onOtherIncomesChange(updated);
                          }}
                          placeholder="Enter 0 if none"
                          data-testid={`input-employment-asset-penalty-${index}`}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Amount from this account used for down payment, closing costs, and reserves</Label>
                        <MoneyInput
                          value={income.fundsUsedForTransaction || ""}
                          onChange={(event) => {
                            const updated = [...otherIncomes];
                            updated[index] = { ...updated[index], fundsUsedForTransaction: event.target.value };
                            onOtherIncomesChange(updated);
                          }}
                          placeholder="Enter 0 if none"
                          data-testid={`input-employment-asset-transaction-use-${index}`}
                        />
                      </div>
                    </div>
                  )}
                  {income.incomeSource !== "Capital Gains" && income.incomeSource !== "Employment-Related Assets as Income" && <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>Is any of this income exempt from federal income tax?</Label>
                      <Select
                        value={income.taxTreatment || "unknown"}
                        onValueChange={(value) => {
                          const updated = [...otherIncomes];
                          updated[index] = {
                            ...updated[index],
                            taxTreatment: value,
                            ...(value !== "partially_non_taxable" ? { nonTaxableMonthlyAmount: null } : {}),
                          };
                          onOtherIncomesChange(updated);
                        }}
                      >
                        <SelectTrigger data-testid={`select-income-tax-treatment-${index}`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="taxable">No</SelectItem>
                          <SelectItem value="fully_non_taxable">Yes, all of it</SelectItem>
                          <SelectItem value="partially_non_taxable">Yes, part of it</SelectItem>
                          <SelectItem value="unknown">I’m not sure</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {income.taxTreatment === "partially_non_taxable" && (
                      <div className="space-y-2">
                        <Label>Monthly amount that is tax-exempt</Label>
                        <MoneyInput
                          value={income.nonTaxableMonthlyAmount ?? ""}
                          onChange={(e) => {
                            const updated = [...otherIncomes];
                            updated[index] = { ...updated[index], nonTaxableMonthlyAmount: e.target.value };
                            onOtherIncomesChange(updated);
                          }}
                          data-testid={`input-nontaxable-income-amount-${index}`}
                        />
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label>Does this income have a known end date?</Label>
                      <Select
                        value={income.hasDefinedExpiration === true
                          ? "yes"
                          : income.hasDefinedExpiration === false ? "no" : "unknown"}
                        onValueChange={(value) => {
                          const updated = [...otherIncomes];
                          updated[index] = {
                            ...updated[index],
                            hasDefinedExpiration: value === "unknown" ? null : value === "yes",
                            ...(value !== "yes" ? { expirationDate: null } : {}),
                          };
                          onOtherIncomesChange(updated);
                        }}
                      >
                        <SelectTrigger data-testid={`select-income-expiration-${index}`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="no">No known end date</SelectItem>
                          <SelectItem value="yes">Yes</SelectItem>
                          <SelectItem value="unknown">I’m not sure</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {income.hasDefinedExpiration === true && (
                      <div className="space-y-2">
                        <Label>End date</Label>
                        <Input
                          type="date"
                          value={income.expirationDate ?? ""}
                          onChange={(e) => {
                            const updated = [...otherIncomes];
                            updated[index] = { ...updated[index], expirationDate: e.target.value };
                            onOtherIncomesChange(updated);
                          }}
                          data-testid={`input-income-expiration-date-${index}`}
                        />
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label>Is this income paid in cryptocurrency?</Label>
                      <Select
                        value={income.paidInVirtualCurrency === true
                          ? "yes"
                          : income.paidInVirtualCurrency === false ? "no" : "unknown"}
                        onValueChange={(value) => {
                          const updated = [...otherIncomes];
                          updated[index] = {
                            ...updated[index],
                            paidInVirtualCurrency: value === "unknown" ? null : value === "yes",
                          };
                          onOtherIncomesChange(updated);
                        }}
                      >
                        <SelectTrigger data-testid={`select-other-income-virtual-currency-${index}`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="no">No</SelectItem>
                          <SelectItem value="yes">Yes</SelectItem>
                          <SelectItem value="unknown">I’m not sure</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>}
                  <p className="text-xs text-muted-foreground">
                    {income.incomeSource === "Capital Gains"
                      ? "Your loan officer will review the return history, confirm the signed returns, and connect the current investment portfolio before any amount is counted."
                      : income.incomeSource === "Employment-Related Assets as Income"
                        ? "We subtract any full-distribution penalty and every dollar assigned to this transaction, then divide the remaining reviewed balance over the loan term you select."
                      : "These details help us calculate eligible income correctly and avoid asking for the same information later."}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
