import { AddressInput } from "@/components/AddressInput";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Icons } from "@/lib/icons";
import { MoneyInput } from "./MoneyInput";
import type { RealEstateOwnedForm } from "./types";

interface Props {
  ownsOtherRealEstate: boolean | null;
  properties: RealEstateOwnedForm[];
  onOwnershipChange: (value: boolean) => void;
  onChange: (value: RealEstateOwnedForm[]) => void;
}

const newProperty = (): RealEstateOwnedForm => ({
  propertyType: "single_family",
  occupancyType: "investment",
  status: "retained",
});

export function RealEstateOwnedSection({
  ownsOtherRealEstate,
  properties,
  onOwnershipChange,
  onChange,
}: Props) {
  const update = (index: number, patch: Partial<RealEstateOwnedForm>) => {
    const next = [...properties];
    next[index] = { ...next[index], ...patch };
    onChange(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Section 2c: Properties You Own</CardTitle>
        <CardDescription>
          Tell us about homes or investment properties you already own. We use this once for income,
          monthly obligations, reserves, and the lender package.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label>Do you own any other real estate?</Label>
          <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
            <Button
              type="button"
              variant={ownsOtherRealEstate === true ? "default" : "outline"}
              onClick={() => {
                onOwnershipChange(true);
                if (properties.length === 0) onChange([newProperty()]);
              }}
              data-testid="button-reo-yes"
            >
              Yes
            </Button>
            <Button
              type="button"
              variant={ownsOtherRealEstate === false ? "default" : "outline"}
              onClick={() => onOwnershipChange(false)}
              data-testid="button-reo-no"
            >
              No
            </Button>
          </div>
        </div>

        {ownsOtherRealEstate === true && (
          <div className="space-y-4">
            {properties.map((property, index) => (
              <div key={property.id ?? index} className="space-y-4 rounded-xl border p-4" data-testid={`reo-property-${index}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Icons.home className="h-4 w-4 text-primary" aria-hidden="true" />
                    <h3 className="font-medium">Property {index + 1}</h3>
                    {property.verificationSource === "borrower_intake" && (
                      <Badge variant="secondary">Carried over from your application</Badge>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove property ${index + 1}`}
                    onClick={() => onChange(properties.filter((_, propertyIndex) => propertyIndex !== index))}
                    data-testid={`button-remove-reo-${index}`}
                  >
                    <Icons.reject className="h-4 w-4" />
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label>Property address</Label>
                  <AddressInput
                    defaultValue={property.propertyAddress || ""}
                    placeholder="Start typing the property address..."
                    onChange={(address) => update(index, { propertyAddress: address })}
                    onSelect={(result) => update(index, { propertyAddress: result.formattedAddress })}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-2">
                    <Label>Property type</Label>
                    <Select value={property.propertyType || ""} onValueChange={(value) => update(index, { propertyType: value })}>
                      <SelectTrigger data-testid={`select-reo-type-${index}`}><SelectValue placeholder="Choose..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="single_family">Single-family</SelectItem>
                        <SelectItem value="condo">Condo</SelectItem>
                        <SelectItem value="townhouse">Townhouse</SelectItem>
                        <SelectItem value="multi_family">Multi-family</SelectItem>
                        <SelectItem value="other">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>How it is used</Label>
                    <Select value={property.occupancyType || ""} onValueChange={(value) => update(index, { occupancyType: value })}>
                      <SelectTrigger data-testid={`select-reo-occupancy-${index}`}><SelectValue placeholder="Choose..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="primary">Primary home</SelectItem>
                        <SelectItem value="second_home">Second home</SelectItem>
                        <SelectItem value="investment">Investment / rental</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>What happens to it</Label>
                    <Select value={property.status || ""} onValueChange={(value) => update(index, { status: value, willBeSold: value === "pending_sale" })}>
                      <SelectTrigger data-testid={`select-reo-status-${index}`}><SelectValue placeholder="Choose..." /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="retained">Keep it</SelectItem>
                        <SelectItem value="pending_sale">Sell before closing</SelectItem>
                        <SelectItem value="sold">Already sold</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Estimated value</Label>
                    <MoneyInput value={property.marketValue || ""} onChange={(event) => update(index, { marketValue: event.target.value })} data-testid={`input-reo-value-${index}`} />
                  </div>
                  <div className="space-y-2">
                    <Label>Mortgage balance</Label>
                    <MoneyInput value={property.mortgageBalance || ""} onChange={(event) => update(index, { mortgageBalance: event.target.value })} data-testid={`input-reo-balance-${index}`} />
                  </div>
                  <div className="space-y-2">
                    <Label>Monthly mortgage payment</Label>
                    <MoneyInput value={property.mortgagePayment || ""} onChange={(event) => update(index, { mortgagePayment: event.target.value })} data-testid={`input-reo-payment-${index}`} />
                  </div>
                  <div className="space-y-2">
                    <Label>Monthly rent</Label>
                    <MoneyInput value={property.monthlyRentalIncome || ""} onChange={(event) => update(index, { monthlyRentalIncome: event.target.value, willBeRented: Number(event.target.value.replace(/,/g, "")) > 0 })} data-testid={`input-reo-rent-${index}`} />
                  </div>
                  <div className="space-y-2">
                    <Label>Monthly taxes</Label>
                    <MoneyInput value={property.monthlyTaxes || ""} onChange={(event) => update(index, { monthlyTaxes: event.target.value })} data-testid={`input-reo-taxes-${index}`} />
                  </div>
                  <div className="space-y-2">
                    <Label>Monthly insurance</Label>
                    <MoneyInput value={property.monthlyInsurance || ""} onChange={(event) => update(index, { monthlyInsurance: event.target.value })} data-testid={`input-reo-insurance-${index}`} />
                  </div>
                  <div className="space-y-2">
                    <Label>Monthly HOA dues</Label>
                    <MoneyInput value={property.monthlyHoa || ""} onChange={(event) => update(index, { monthlyHoa: event.target.value })} data-testid={`input-reo-hoa-${index}`} />
                  </div>
                  <div className="space-y-2">
                    <Label>City</Label>
                    <Input value={property.propertyCity || ""} onChange={(event) => update(index, { propertyCity: event.target.value })} data-testid={`input-reo-city-${index}`} />
                  </div>
                  <div className="space-y-2">
                    <Label>State</Label>
                    <Input maxLength={2} value={property.propertyState || ""} onChange={(event) => update(index, { propertyState: event.target.value.toUpperCase() })} data-testid={`input-reo-state-${index}`} />
                  </div>
                  <div className="space-y-2">
                    <Label>ZIP code</Label>
                    <Input value={property.propertyZip || ""} onChange={(event) => update(index, { propertyZip: event.target.value })} data-testid={`input-reo-zip-${index}`} />
                  </div>
                </div>
              </div>
            ))}
            <Button type="button" variant="outline" className="w-full" onClick={() => onChange([...properties, newProperty()])} data-testid="button-add-reo">
              <Icons.add className="mr-2 h-4 w-4" /> Add another property
            </Button>
          </div>
        )}

        {ownsOtherRealEstate === null && (
          <p className="text-sm text-muted-foreground">Choose Yes or No so your loan team knows this section is complete.</p>
        )}
      </CardContent>
    </Card>
  );
}
