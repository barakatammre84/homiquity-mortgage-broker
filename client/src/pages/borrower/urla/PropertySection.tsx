import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AddressInput } from "@/components/AddressInput";
import { US_STATES } from "@/lib/us-states";
import type {
  AmortizationType,
  LoanApplication,
  PreferredLoanType,
  UrlaLoanDetails,
  UrlaPropertyInfo,
} from "@shared/schema";
import { MoneyInput } from "./MoneyInput";
import { AMORTIZATION_TYPE_OPTIONS, LOAN_TYPE_OPTIONS } from "./types";

interface PropertySectionProps {
  propertyInfo: Partial<UrlaPropertyInfo>;
  onChange: (value: Partial<UrlaPropertyInfo>) => void;
  /** Section 4a — borrower-stated loan type + amortization type (WF2-F4). */
  loanDetails: UrlaLoanDetails;
  onLoanDetailsChange: (value: UrlaLoanDetails) => void;
  app: LoanApplication;
}

export function PropertySection({
  propertyInfo,
  onChange,
  loanDetails,
  onLoanDetailsChange,
  app,
}: PropertySectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Property Information and Loan Details</CardTitle>
        <CardDescription>
          The home this loan is for. We've carried over what you told us during pre-approval —
          just confirm or correct it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <h4 className="font-semibold">Property Address</h4>
        <div className="mb-3">
          <Label>Search Address</Label>
          <AddressInput
            placeholder="Start typing the property address..."
            defaultValue={propertyInfo.propertyStreet || app.propertyAddress || ""}
            onSelect={(result) => onChange({
              ...propertyInfo,
              propertyStreet: result.streetAddress || result.formattedAddress,
              propertyCity: result.city,
              propertyState: result.state,
              propertyZip: result.zip,
              propertyCounty: result.county || propertyInfo.propertyCounty,
            })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 space-y-2">
            <Label htmlFor="property-street">Street Address</Label>
            <Input
              id="property-street"
              placeholder="Street Address"
              value={propertyInfo.propertyStreet || app.propertyAddress || ""}
              onChange={(e) => onChange({ ...propertyInfo, propertyStreet: e.target.value })}
              data-testid="input-property-street"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="property-unit">Unit #</Label>
            <Input
              id="property-unit"
              placeholder="Unit #"
              value={propertyInfo.propertyUnit || ""}
              onChange={(e) => onChange({ ...propertyInfo, propertyUnit: e.target.value })}
              data-testid="input-property-unit"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="property-city">City</Label>
            <Input
              id="property-city"
              placeholder="City"
              value={propertyInfo.propertyCity || app.propertyCity || ""}
              onChange={(e) => onChange({ ...propertyInfo, propertyCity: e.target.value })}
              data-testid="input-property-city"
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-2">
            <Label htmlFor="property-state">State</Label>
            <Select
              value={propertyInfo.propertyState || app.propertyState || ""}
              onValueChange={(value) => onChange({ ...propertyInfo, propertyState: value })}
            >
              <SelectTrigger id="property-state" data-testid="select-property-state">
                <SelectValue placeholder="State" />
              </SelectTrigger>
              <SelectContent>
                {US_STATES.map((state) => (
                  <SelectItem key={state.value} value={state.value}>{state.value}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="property-zip">ZIP Code</Label>
            <Input
              id="property-zip"
              placeholder="ZIP"
              value={propertyInfo.propertyZip || app.propertyZip || ""}
              onChange={(e) => onChange({ ...propertyInfo, propertyZip: e.target.value })}
              data-testid="input-property-zip"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="number-of-units">Number of Units</Label>
            <Input
              id="number-of-units"
              type="number"
              min="1"
              value={propertyInfo.numberOfUnits ?? 1}
              onChange={(e) => onChange({ ...propertyInfo, numberOfUnits: parseInt(e.target.value) || 1 })}
              data-testid="input-number-units"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="occupancy-type">Occupancy Type</Label>
            <Select
              value={propertyInfo.occupancyType || "primary_residence"}
              onValueChange={(value) => onChange({ ...propertyInfo, occupancyType: value })}
            >
              <SelectTrigger id="occupancy-type" data-testid="select-occupancy-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="primary_residence">Primary Residence</SelectItem>
                <SelectItem value="second_home">Second Home</SelectItem>
                <SelectItem value="investment">Investment Property</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            {/*
              Fannie Mae Selling Guide B3-6-03 counts owners' association and
              co-op dues inside the qualifying housing expense (PITIA) used to
              compute the DTI. This is decision input, not a display nicety —
              leaving it blank on a condo/PUD gaps the file rather than
              qualifying the borrower on an incomplete housing expense.
            */}
            <Label htmlFor="monthly-association-dues">Monthly HOA / Association Dues</Label>
            <MoneyInput
              id="monthly-association-dues"
              value={propertyInfo.monthlyAssociationDues ?? ""}
              onChange={(e) => onChange({ ...propertyInfo, monthlyAssociationDues: e.target.value })}
              data-testid="input-monthly-association-dues"
            />
            <p className="text-sm text-muted-foreground">
              Enter 0 if the property has no association. Condos, co-ops and PUDs almost
              always have dues, and they count toward your qualifying payment.
            </p>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
          <div>
            <h4 className="font-semibold">Other monthly property costs</h4>
            <p className="mt-1 text-sm text-muted-foreground">
              These costs are part of the payment a lender uses to qualify you. Enter $0 when a cost does not apply. Your loan team can help confirm any amount you do not know.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="monthly-flood-insurance">Flood insurance</Label>
              <MoneyInput
                id="monthly-flood-insurance"
                value={propertyInfo.monthlyFloodInsurance ?? ""}
                onChange={(e) => onChange({ ...propertyInfo, monthlyFloodInsurance: e.target.value })}
                data-testid="input-monthly-flood-insurance"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="monthly-ground-rent">Ground rent</Label>
              <MoneyInput
                id="monthly-ground-rent"
                value={propertyInfo.monthlyGroundRent ?? ""}
                onChange={(e) => onChange({ ...propertyInfo, monthlyGroundRent: e.target.value })}
                data-testid="input-monthly-ground-rent"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="monthly-special-assessments">Special assessments</Label>
              <MoneyInput
                id="monthly-special-assessments"
                value={propertyInfo.monthlySpecialAssessments ?? ""}
                onChange={(e) => onChange({ ...propertyInfo, monthlySpecialAssessments: e.target.value })}
                data-testid="input-monthly-special-assessments"
              />
            </div>
          </div>
        </div>

        <hr />

        <h4 className="font-semibold">Loan Details</h4>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="property-value">Property Value</Label>
            <MoneyInput
              id="property-value"
              value={propertyInfo.propertyValue || app.propertyValue || app.purchasePrice || ""}
              onChange={(e) => onChange({ ...propertyInfo, propertyValue: e.target.value })}
              data-testid="input-property-value"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="loan-purpose">Loan Purpose</Label>
            <Select defaultValue={app.loanPurpose || "purchase"} disabled>
              <SelectTrigger id="loan-purpose" data-testid="select-loan-purpose">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="purchase">Purchase</SelectItem>
                <SelectItem value="refinance">Refinance</SelectItem>
                <SelectItem value="cash_out">Cash Out Refinance</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Set during pre-approval — message your loan team if this should change.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="loan-type">Loan Type</Label>
            <Select
              value={loanDetails.preferredLoanType}
              onValueChange={(value) =>
                onLoanDetailsChange({ ...loanDetails, preferredLoanType: value as PreferredLoanType })
              }
            >
              <SelectTrigger id="loan-type" data-testid="select-loan-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOAN_TYPE_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    data-testid={`option-loan-type-${option.value}`}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="amortization-type">Amortization Type</Label>
            <Select
              value={loanDetails.amortizationType}
              onValueChange={(value) =>
                onLoanDetailsChange({ ...loanDetails, amortizationType: value as AmortizationType })
              }
            >
              <SelectTrigger id="amortization-type" data-testid="select-amortization-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AMORTIZATION_TYPE_OPTIONS.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    data-testid={`option-amortization-type-${option.value}`}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="subordinate-financing">Will another new loan or HELOC also be secured by this property?</Label>
            <Select
              value={propertyInfo.subordinateFinancingExists === true
                ? "yes"
                : propertyInfo.subordinateFinancingExists === false ? "no" : "unknown"}
              onValueChange={(value) => onChange({
                ...propertyInfo,
                subordinateFinancingExists: value === "unknown" ? null : value === "yes",
                ...(value === "no" ? {
                  closedEndSubordinateBalance: "0",
                  helocDrawnBalance: "0",
                  helocCreditLimit: "0",
                  monthlySubordinateFinancingPayment: "0",
                } : {}),
              })}
            >
              <SelectTrigger id="subordinate-financing" data-testid="select-subordinate-financing"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="no">No</SelectItem>
                <SelectItem value="yes">Yes</SelectItem>
                <SelectItem value="unknown">Not sure yet</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              Include down-payment-assistance loans, second mortgages, and home-equity lines opened with this mortgage.
            </p>
          </div>
          {propertyInfo.subordinateFinancingExists === true && (
            <div className="grid gap-4 sm:grid-cols-2" data-testid="subordinate-financing-details">
              <div className="space-y-2">
                <Label htmlFor="closed-end-subordinate-balance">Second-mortgage amount</Label>
                <MoneyInput id="closed-end-subordinate-balance" value={propertyInfo.closedEndSubordinateBalance ?? ""} onChange={(e) => onChange({ ...propertyInfo, closedEndSubordinateBalance: e.target.value })} />
                <p className="text-xs text-muted-foreground">Enter $0 if there is no closed-end second mortgage.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="heloc-drawn-balance">HELOC amount drawn</Label>
                <MoneyInput id="heloc-drawn-balance" value={propertyInfo.helocDrawnBalance ?? ""} onChange={(e) => onChange({ ...propertyInfo, helocDrawnBalance: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="heloc-credit-limit">Full HELOC credit limit</Label>
                <MoneyInput id="heloc-credit-limit" value={propertyInfo.helocCreditLimit ?? ""} onChange={(e) => onChange({ ...propertyInfo, helocCreditLimit: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="monthly-subordinate-payment">Combined monthly payment</Label>
                <MoneyInput id="monthly-subordinate-payment" value={propertyInfo.monthlySubordinateFinancingPayment ?? ""} onChange={(e) => onChange({ ...propertyInfo, monthlySubordinateFinancingPayment: e.target.value })} />
              </div>
            </div>
          )}
        </div>

        <hr />

        <div className="space-y-4">
          <h4 className="font-semibold">Special Property Characteristics</h4>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="mixed-use"
                checked={propertyInfo.isMixedUse || false}
                onCheckedChange={(checked) => onChange({ ...propertyInfo, isMixedUse: !!checked })}
                data-testid="checkbox-mixed-use"
              />
              <Label htmlFor="mixed-use" className="font-normal">
                This property is mixed-use (e.g., residential and commercial)
              </Label>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="manufactured"
                checked={propertyInfo.isManufacturedHome || false}
                onCheckedChange={(checked) => onChange({ ...propertyInfo, isManufacturedHome: !!checked })}
                data-testid="checkbox-manufactured"
              />
              <Label htmlFor="manufactured" className="font-normal">
                This is a manufactured home
              </Label>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
