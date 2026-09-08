import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddressInput } from "@/components/AddressInput";
import {
  Briefcase,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  DollarSign,
  Home,
  Plus,
  Shield,
  Trash2,
  TrendingUp,
  Users,
} from "lucide-react";
import type { RentalPropertyEntry, IncomeSourceEntry, PreApprovalFormData } from "@shared/schema";
import { maskCurrencyDigits } from "@/lib/formatters";
import { parseMaskedAmount, sumIncomeSourcesAnnual } from "@/lib/preApprovalAnalysis";

const EMPTY_DETAILS = {
  annualAmount: "",
  employerName: "",
  yearsInRole: "",
  businessStructure: undefined,
  ownershipPercent: "",
};
const EMPTY_RENTAL: RentalPropertyEntry = {
  address: "",
  monthlyRentalIncome: "",
  monthlyDebtPayment: "",
};

type RentalAwareEntry = IncomeSourceEntry & { rentalProperties?: RentalPropertyEntry[] };

function monthlyRentTotal(props: readonly RentalPropertyEntry[]): number {
  return props.reduce(
    (sum, p) => sum + (parseFloat((p.monthlyRentalIncome || "").replace(/,/g, "")) || 0),
    0,
  );
}

/**
 * Rental annual income is DERIVED — Σ monthly rents × 12 — never typed. Applied
 * on every rental mutation so the reported entry and the on-screen total can't
 * disagree.
 */
function withDerivedRentalAmount(entry: RentalAwareEntry): RentalAwareEntry {
  const total = monthlyRentTotal(entry.rentalProperties ?? []);
  return {
    ...entry,
    annualAmount: total > 0 ? maskCurrencyDigits(String(Math.round(total * 12))) : "",
  };
}

/**
 * Complex-income step (extracted from PreApproval.tsx).
 *
 * ONE source of truth: the `incomeSources` array itself. Selected types,
 * per-type details, and rental rows are all PROJECTIONS of it, derived on
 * render — not separate state.
 *
 * They used to be three `useState` stores in the page, written alongside the
 * form field on every mutation. That duplication is why the draft-restore path
 * had to hand-rebuild them (`applyIncomeSources`, threaded down through
 * useDraftRestore as a ninth argument): restoring the form field alone left the
 * step rendering empty with the data sitting right there. It also let the two
 * drift within a single interaction — toggling "rental" on passed the PREVIOUS
 * (empty) rental array to the entry builder, so the form said "no properties"
 * while the UI showed a property row. Deriving instead of mirroring retires
 * both, and every future restore entry point gets it for free.
 */
export function IncomeSourcesStep({
  employmentType,
  householdAnnualIncome,
  value,
  onChange,
}: {
  employmentType: PreApprovalFormData["employmentType"] | undefined;
  householdAnnualIncome?: string;
  /** THE state — `form.incomeSources`. */
  value: IncomeSourceEntry[] | undefined;
  onChange: (entries: IncomeSourceEntry[]) => void;
}) {
  const entries: RentalAwareEntry[] = value ?? [];
  const [chooserOpen, setChooserOpen] = useState(entries.length === 0);
  const [activeEntryIndex, setActiveEntryIndex] = useState(0);
  // `string[]`, not the entry union: the toggle list is keyed by the plain
  // option values rendered below, and narrowing happens where an entry is built.
  const selectedIncomeTypes: string[] = Array.from(new Set(entries.map((e) => e.type)));
  const rentalProperties = entries.find((e) => e.type === "rental")?.rentalProperties ?? [];

  useEffect(() => {
    if (entries.length === 0) {
      setChooserOpen(true);
      setActiveEntryIndex(0);
    } else if (activeEntryIndex >= entries.length) {
      setActiveEntryIndex(entries.length - 1);
    }
  }, [activeEntryIndex, entries.length]);

  /** Replace one entry and report upward. Self-employment may have many entries. */
  const updateEntryAt = (entryIndex: number, update: (entry: RentalAwareEntry) => RentalAwareEntry) => {
    onChange(entries.map((entry, index) => (index === entryIndex ? update(entry) : entry)));
  };
  const employmentTypeMap: Record<string, string> = { employed: "w2", self_employed: "self_employed", retired: "pension" };
  // Self-employed borrowers keep their primary type in the list — the
  // complex-income block exists precisely to detail 1099/business income.
  const rawPrimaryType = employmentTypeMap[employmentType || ""] || "";
  const primaryType = rawPrimaryType === "self_employed" ? "" : rawPrimaryType;
  const allIncomeTypes = [
    { value: "w2", label: "W-2 Employment", icon: Briefcase },
    { value: "self_employed", label: "Self-Employment / 1099", icon: Users },
    { value: "rental", label: "Rental Income", icon: Home },
    { value: "social_security", label: "Social Security", icon: Shield },
    { value: "pension", label: "Pension / Retirement", icon: Clock },
    { value: "investment", label: "Investment Income", icon: TrendingUp },
    { value: "other", label: "Other Income", icon: DollarSign },
  ].filter((t) => t.value !== primaryType);

  const toggleIncomeType = (typeValue: string) => {
    if (selectedIncomeTypes.includes(typeValue)) {
      // Removing the entry removes its details and (for rental) its rows with
      // it — there is no second store left holding them.
      onChange(entries.filter((e) => e.type !== typeValue));
      setActiveEntryIndex(0);
      return;
    }
    const added: RentalAwareEntry = {
      ...EMPTY_DETAILS,
      type: typeValue as IncomeSourceEntry["type"],
      // Rental opens with one blank row, which is what the card renders. The
      // entry carries it so the form and the screen agree from the first frame.
      ...(typeValue === "rental" ? { rentalProperties: [{ ...EMPTY_RENTAL }] } : {}),
    };
    onChange([...entries, added]);
    setActiveEntryIndex(entries.length);
    setChooserOpen(false);
  };

  const addSelfEmployedSource = () => {
    onChange([
      ...entries,
      { ...EMPTY_DETAILS, type: "self_employed" },
    ]);
    setActiveEntryIndex(entries.length);
  };

  const removeEntryAt = (entryIndex: number) => {
    onChange(entries.filter((_, index) => index !== entryIndex));
    setActiveEntryIndex(Math.max(0, entryIndex - 1));
  };

  const updateDetail = (entryIndex: number, field: string, fieldValue: string) => {
    updateEntryAt(entryIndex, (entry) => ({ ...entry, [field]: fieldValue }));
  };

  const updateRentals = (
    update: (props: RentalPropertyEntry[]) => RentalPropertyEntry[],
  ) => {
    const rentalIndex = entries.findIndex((entry) => entry.type === "rental");
    if (rentalIndex < 0) return;
    updateEntryAt(rentalIndex, (entry) =>
      withDerivedRentalAmount({
        ...entry,
        rentalProperties: update(entry.rentalProperties ?? []),
      }),
    );
  };

  const addRentalProperty = () => updateRentals((props) => [...props, { ...EMPTY_RENTAL }]);

  const removeRentalProperty = (index: number) =>
    updateRentals((props) => props.filter((_, i) => i !== index));

  const updateRentalProperty = (
    index: number,
    field: keyof RentalPropertyEntry,
    fieldValue: string,
  ) =>
    updateRentals((props) =>
      props.map((p, i) => (i === index ? { ...p, [field]: fieldValue } : p)),
    );

  const needsEmployerDetails = (typeValue: string) => typeValue === "w2" || typeValue === "self_employed";

  const rentalAnnualTotal = monthlyRentTotal(rentalProperties) * 12;
  const householdTotal = parseMaskedAmount(householdAnnualIncome);
  const detailedTotal = sumIncomeSourcesAnnual(entries);
  const remainingInHouseholdTotal = householdTotal - detailedTotal;
  const breakdownIsHigh = householdTotal > 0 && remainingInHouseholdTotal < 0;

  return (
    <div className="w-full max-w-lg mx-auto space-y-6">
      {/* One column on a phone: each chip is a 36px glyph + label + checkbox in
          p-4, and at 320px two of them crush labels like "Self-Employment /
          1099" and "Pension / Retirement" (DESIGN_SYSTEM.md §12.3). */}
      {entries.length > 0 && (
        <Button
          type="button"
          variant="outline"
          aria-expanded={chooserOpen}
          aria-controls="income-source-chooser"
          onClick={() => setChooserOpen((open) => !open)}
          className="touch-target flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
          data-testid="button-toggle-income-source-chooser"
        >
          <span>{entries.length} income source{entries.length === 1 ? "" : "s"} selected</span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {chooserOpen ? "Done" : "Add or remove"}
            {chooserOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </span>
        </Button>
      )}

      <div
        id="income-source-chooser"
        className={`${chooserOpen ? "grid" : "hidden"} grid-cols-1 sm:grid-cols-2 gap-3`}
      >
        {allIncomeTypes.map((incomeType) => {
          const TypeIcon = incomeType.icon;
          const isActive = selectedIncomeTypes.includes(incomeType.value);
          return (
            <button
              key={incomeType.value}
              type="button"
              aria-pressed={isActive}
              data-testid={`toggle-income-${incomeType.value}`}
              onClick={() => toggleIncomeType(incomeType.value)}
              className={`flex items-center gap-3 p-4 text-left text-sm font-medium border-2 rounded-xl transition-all duration-200
                ${isActive
                  ? "border-primary bg-primary/5"
                  : "border-muted hover:border-primary/50"
                }`}
            >
              <div className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors shrink-0
                ${isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                <TypeIcon className="h-4 w-4" />
              </div>
              <span className={`flex-1 ${isActive ? "text-primary" : "text-foreground"}`}>
                {incomeType.label}
              </span>
              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors shrink-0
                ${isActive ? "border-primary bg-primary" : "border-muted-foreground/30"}`}>
                {isActive && <Check className="w-3 h-3 text-primary-foreground" />}
              </div>
            </button>
          );
        })}
      </div>

      {selectedIncomeTypes.length > 0 && (
        <div className="space-y-4">
          <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Income sources to edit">
            {entries.map((entry, index) => {
              const ordinal = entries.slice(0, index + 1).filter((item) => item.type === entry.type).length;
              const typeLabel = allIncomeTypes.find((item) => item.value === entry.type)?.label ?? "Income source";
              const label = entry.type === "self_employed" ? `Business or 1099 ${ordinal}` : typeLabel;
              const isActive = index === activeEntryIndex;
              return (
                <Button
                  key={`${entry.type}-${index}`}
                  type="button"
                  variant="outline"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveEntryIndex(index)}
                  className={`touch-target min-h-11 shrink-0 rounded-full border px-4 py-2 text-sm font-medium ${isActive ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"}`}
                  data-testid={`button-edit-income-source-${index}`}
                >
                  {label}
                </Button>
              );
            })}
          </div>
          {entries.map((details, entryIndex) => {
            const typeValue = details.type;
            const typeInfo = allIncomeTypes.find((t) => t.value === typeValue);
            const sameTypeOrdinal = entries
              .slice(0, entryIndex + 1)
              .filter((entry) => entry.type === typeValue).length;
            const entryFieldId = `${typeValue}-${sameTypeOrdinal - 1}`;

            if (entryIndex !== activeEntryIndex) return null;

            if (typeValue === "rental") {
              return (
                <div key={`${typeValue}-${entryIndex}`} className="border-2 rounded-xl p-5 space-y-4 text-left" data-testid="card-income-rental">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Home className="h-4 w-4 text-primary" />
                    <span className="font-semibold text-foreground">Rental Properties</span>
                    {rentalAnnualTotal > 0 && (
                      <span className="text-sm text-muted-foreground ml-auto">
                        ${maskCurrencyDigits(String(Math.round(rentalAnnualTotal)))}/yr total
                      </span>
                    )}
                  </div>

                  {rentalProperties.map((prop, idx) => (
                    <div key={idx} className="border rounded-xl p-4 space-y-3 bg-muted/30" data-testid={`rental-property-${idx}`}>
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground">Property {idx + 1}</span>
                        {rentalProperties.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon" aria-label="Delete"
                            data-testid={`button-remove-rental-${idx}`}
                            onClick={() => removeRentalProperty(idx)}
                          >
                            <Trash2 className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        )}
                      </div>
                      <div>
                        <label htmlFor={`rental-address-${idx}`} className="text-sm text-muted-foreground mb-1 block">Property Address</label>
                        <AddressInput
                          id={`rental-address-${idx}`}
                          placeholder="Start typing a property address..."
                          defaultValue={prop.address}
                          onChange={(address) => updateRentalProperty(idx, "address", address)}
                          onSelect={(result) => updateRentalProperty(idx, "address", result.formattedAddress)}
                        />
                      </div>
                      {/* Two $-prefixed currency fields side by side leave ~110px
                          of usable width each at 320px, inside a card that is
                          itself nested two levels deep. Stack them on a phone. */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label htmlFor={`rental-income-${idx}`} className="text-sm text-muted-foreground mb-1 block">Monthly Rental Income</label>
                          <div className="relative">
                            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                              id={`rental-income-${idx}`}
                              data-testid={`input-rental-income-${idx}`}
                              value={prop.monthlyRentalIncome}
                              onChange={(e) => updateRentalProperty(idx, "monthlyRentalIncome", maskCurrencyDigits(e.target.value))}
                              className="pl-9"
                              placeholder="2,000"
                              inputMode="decimal"
                            />
                          </div>
                        </div>
                        <div>
                          <label htmlFor={`rental-debt-${idx}`} className="text-sm text-muted-foreground mb-1 block">Monthly Debt Payment</label>
                          <div className="relative">
                            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                              id={`rental-debt-${idx}`}
                              data-testid={`input-rental-debt-${idx}`}
                              value={prop.monthlyDebtPayment || ""}
                              onChange={(e) => updateRentalProperty(idx, "monthlyDebtPayment", maskCurrencyDigits(e.target.value))}
                              className="pl-9"
                              placeholder="1,200"
                              inputMode="decimal"
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}

                  <Button
                    type="button"
                    variant="outline"
                    data-testid="button-add-rental-property"
                    onClick={addRentalProperty}
                    className="w-full"
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    Add Another Property
                  </Button>
                </div>
              );
            }

            return (
              <div
                key={`${typeValue}-${entryIndex}`}
                className="border-2 rounded-xl p-5 space-y-4 text-left"
                data-testid={typeValue === "self_employed" ? `card-income-self_employed-${sameTypeOrdinal - 1}` : `card-income-${typeValue}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  {typeInfo && <typeInfo.icon className="h-4 w-4 text-primary" />}
                  <span className="font-semibold text-foreground">
                    {typeValue === "self_employed" ? `Business or 1099 source ${sameTypeOrdinal}` : typeInfo?.label}
                  </span>
                  {typeValue === "self_employed" && entries.filter((entry) => entry.type === "self_employed").length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove business or 1099 source ${sameTypeOrdinal}`}
                      onClick={() => removeEntryAt(entryIndex)}
                      className="ml-auto"
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  )}
                </div>
                <div>
                  <label htmlFor={`income-amount-${entryFieldId}`} className="text-sm text-muted-foreground mb-1 block">Annual Amount</label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id={`income-amount-${entryFieldId}`}
                      data-testid={typeValue === "self_employed" ? `input-income-amount-self_employed-${sameTypeOrdinal - 1}` : `input-income-amount-${typeValue}`}
                      value={details.annualAmount ?? ""}
                      onChange={(e) => updateDetail(entryIndex, "annualAmount", maskCurrencyDigits(e.target.value))}
                      className="pl-9"
                      placeholder="75,000"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor={`income-employer-${entryFieldId}`} className="text-sm text-muted-foreground mb-1 block">
                    {typeValue === "self_employed" ? "Business or payer name" : needsEmployerDetails(typeValue) ? "Employer Name" : "Source"}
                  </label>
                  <Input
                    id={`income-employer-${entryFieldId}`}
                    data-testid={typeValue === "self_employed" ? `input-income-employer-self_employed-${sameTypeOrdinal - 1}` : `input-income-employer-${typeValue}`}
                    value={details.employerName ?? ""}
                    onChange={(e) => updateDetail(entryIndex, "employerName", e.target.value)}
                    placeholder={needsEmployerDetails(typeValue) ? "Company name" : "Source name (optional)"}
                  />
                </div>
                {needsEmployerDetails(typeValue) && (
                  <>
                    <div>
                      <label htmlFor={`income-years-${entryFieldId}`} className="text-sm text-muted-foreground mb-1 block">
                        {typeValue === "self_employed" ? "Years receiving this income" : "Years in Role"}
                      </label>
                      <Input
                        id={`income-years-${entryFieldId}`}
                        data-testid={typeValue === "self_employed" ? `input-income-years-self_employed-${sameTypeOrdinal - 1}` : `input-income-years-${typeValue}`}
                        value={details.yearsInRole ?? ""}
                        onChange={(e) => updateDetail(entryIndex, "yearsInRole", e.target.value.replace(/\D/g, ""))}
                        placeholder="3"
                        inputMode="numeric"
                      />
                    </div>
                    {typeValue === "self_employed" && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label htmlFor={`income-structure-${entryFieldId}`} className="text-sm text-muted-foreground mb-1 block">Business or income type</label>
                          <select
                            id={`income-structure-${entryFieldId}`}
                            data-testid={`select-business-structure-self_employed-${sameTypeOrdinal - 1}`}
                            value={details.businessStructure ?? ""}
                            onChange={(event) => updateDetail(entryIndex, "businessStructure", event.target.value)}
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <option value="">Select one</option>
                            <option value="sole_proprietorship">1099 / sole proprietor</option>
                            <option value="single_member_llc">Single-member LLC</option>
                            <option value="partnership">Partnership</option>
                            <option value="s_corporation">S corporation</option>
                            <option value="c_corporation">C corporation</option>
                            <option value="other">Other / not sure</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor={`income-ownership-${entryFieldId}`} className="text-sm text-muted-foreground mb-1 block">Your ownership</label>
                          <div className="relative">
                            <Input
                              id={`income-ownership-${entryFieldId}`}
                              data-testid={`input-ownership-self_employed-${sameTypeOrdinal - 1}`}
                              value={details.ownershipPercent ?? ""}
                              onChange={(event) => updateDetail(entryIndex, "ownershipPercent", event.target.value.replace(/\D/g, "").slice(0, 3))}
                              placeholder="100"
                              inputMode="numeric"
                              className="pr-9"
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">Use 0% for a 1099 payer you do not own.</p>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {selectedIncomeTypes.includes("self_employed") && (
            <Button
              type="button"
              variant="outline"
              data-testid="button-add-self-employed-source"
              onClick={addSelfEmployedSource}
              className="w-full"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Another Business or 1099 Source
            </Button>
          )}
          {householdTotal > 0 && (
            <div
              className={`rounded-xl border p-4 text-left ${breakdownIsHigh ? "border-destructive bg-destructive/5" : "bg-muted/30"}`}
              data-testid="income-breakdown-check"
            >
              <p className="text-sm font-semibold text-foreground">Income check</p>
              <dl className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Household total you reported</dt>
                  <dd className="font-medium">${householdTotal.toLocaleString()}/yr</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Detailed on this screen</dt>
                  <dd className="font-medium">${detailedTotal.toLocaleString()}/yr</dd>
                </div>
                <div className="flex justify-between gap-3 border-t pt-1">
                  <dt className={breakdownIsHigh ? "text-destructive" : "text-muted-foreground"}>
                    {breakdownIsHigh ? "Above your household total" : "Main source or household income not itemized here"}
                  </dt>
                  <dd className={breakdownIsHigh ? "font-semibold text-destructive" : "font-medium"} data-testid="income-breakdown-remainder">
                    ${Math.abs(remainingInHouseholdTotal).toLocaleString()}/yr
                  </dd>
                </div>
              </dl>
              <p className={`mt-2 text-xs leading-relaxed ${breakdownIsHigh ? "text-destructive" : "text-muted-foreground"}`}>
                {breakdownIsHigh
                  ? "Update your household total or one of the source amounts so we do not count income twice."
                  : "These source amounts are already included in your household total. We use the breakdown to request the right records."}
              </p>
            </div>
          )}
          {(selectedIncomeTypes.includes("self_employed") || selectedIncomeTypes.includes("rental")) && (
            <p className="rounded-xl bg-warning-subtle p-4 text-left text-xs leading-relaxed text-warning-subtle-foreground" data-testid="complex-income-verification-note">
              These are reported amounts for planning. Mortgage income can differ after tax-return cash flow, business expenses, ownership, history, and rental expenses are reviewed. Your loan team will show the verified calculation before relying on it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
