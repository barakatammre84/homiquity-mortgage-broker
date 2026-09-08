import { useState, useRef, useEffect, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { friendlyApiError } from "@/lib/errorMessage";
import { Loader2 } from "lucide-react";

interface AddressSuggestion {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

export interface AddressResult {
  formattedAddress: string;
  lat: number;
  lng: number;
  zip: string;
  city: string;
  state: string;
  streetAddress: string;
  county?: string;
}

type SearchMode = "address" | "location";

interface AddressInputProps {
  onSelect: (result: AddressResult) => void;
  onChange?: (value: string) => void;
  id?: string;
  placeholder?: string;
  className?: string;
  defaultValue?: string;
  mode?: SearchMode;
}

export function AddressInput({ onSelect, onChange, id, placeholder = "Enter an address...", className, defaultValue, mode = "address" }: AddressInputProps) {
  const [value, setValue] = useState(defaultValue || "");
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingDetails, setIsFetchingDetails] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  /** Set when a lookup could not be completed — never used for "no matches". */
  const [lookupError, setLookupError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fetchSuggestions = useCallback(async (input: string) => {
    if (input.length < 3) {
      setSuggestions([]);
      setIsOpen(false);
      return;
    }

    setIsLoading(true);
    setLookupError(null);
    try {
      const modeParam = mode === "location" ? "&mode=location" : "";
      // apiRequest so a non-2xx and a network error share ONE failure path.
      // They did not: `if (res.ok)` had no else, so a failed lookup left the
      // PREVIOUS input's suggestions on screen with the dropdown still open —
      // the borrower could pick a result for an address they had already typed
      // past. The endpoint is public (no auth middleware on /api/geocode/*), so
      // the session-expiry redirect can never fire here.
      const res = await apiRequest(
        "GET",
        `/api/geocode/autocomplete?input=${encodeURIComponent(input)}${modeParam}`,
      );
      const data = await res.json();
      setSuggestions(data);
      setIsOpen(data.length > 0);
      setHighlightIndex(-1);
    } catch (error) {
      // Never show results that do not correspond to what is in the box.
      setSuggestions([]);
      setIsOpen(false);
      setHighlightIndex(-1);
      // 503 is the one that actually bites: the route answers it whenever
      // GOOGLE_MAPS_API_KEY is unset (server/routes/geocode.ts:34), so every
      // lookup fails and the old code showed nothing at all — indistinguishable
      // from "we don't cover your address".
      setLookupError(
        friendlyApiError(error, "Address lookup is unavailable — type your address in full."),
      );
    } finally {
      setIsLoading(false);
    }
  }, [mode]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    onChange?.(newValue);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(newValue), 300);
  };

  const handleSelect = async (suggestion: AddressSuggestion) => {
    setValue(suggestion.description);
    onChange?.(suggestion.description);
    setIsOpen(false);
    setSuggestions([]);
    setIsFetchingDetails(true);

    try {
      const res = await apiRequest(
        "GET",
        `/api/geocode/details?placeId=${encodeURIComponent(suggestion.placeId)}`,
      );
      const details = await res.json();
      if (!details.formattedAddress) {
        throw new Error("The lookup returned no address for that suggestion.");
      }
      setValue(details.formattedAddress);
      onChange?.(details.formattedAddress);
      onSelect({
        formattedAddress: details.formattedAddress,
        lat: details.lat,
        lng: details.lng,
        zip: details.zip,
        city: details.city,
        state: details.state,
        streetAddress: details.streetAddress,
        county: details.county,
      });
    } catch (error) {
      // This branch used to be an EMPTY catch, and it was the worse of the two
      // failures on this component. The input had already been set to the
      // suggestion's text above, so the field showed a complete, authoritative-
      // looking address while `onSelect` never fired — meaning zip, state,
      // county, city and lat/lng were silently never captured. On the URLA
      // property section that is a subject property with an address string and
      // nothing structured behind it, and those fields feed delivery.
      //
      // We cannot fabricate them, so say so instead of looking finished.
      setLookupError(
        friendlyApiError(
          error,
          "We couldn't verify that address — please re-enter it, or your loan team will confirm it.",
        ),
      );
    } finally {
      setIsFetchingDetails(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || suggestions.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
    } else if (e.key === "Enter" && highlightIndex >= 0) {
      e.preventDefault();
      handleSelect(suggestions[highlightIndex]);
    } else if (e.key === "Escape") {
      setIsOpen(false);
    }
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div ref={containerRef} className={`relative ${className || ""}`}>
      <div className="relative">
        <Input
          id={id}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => { if (suggestions.length > 0) setIsOpen(true); }}
          placeholder={placeholder}
          data-testid="input-address-autocomplete"
          className={isLoading || isFetchingDetails ? "pr-10" : ""}
        />
        {(isLoading || isFetchingDetails) && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {lookupError && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="text-address-lookup-error">
          {lookupError}
        </p>
      )}

      {isOpen && suggestions.length > 0 && (
        <div
          className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md"
          data-testid="dropdown-address-suggestions"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.placeId}
              type="button"
              className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors
                ${i === highlightIndex ? "bg-accent" : "hover-elevate"}
                ${i < suggestions.length - 1 ? "border-b border-border/50" : ""}
              `}
              onMouseEnter={() => setHighlightIndex(i)}
              onClick={() => handleSelect(s)}
              data-testid={`button-suggestion-${i}`}
            >
              <span className="font-medium">{s.mainText}</span>
              <span className="text-xs text-muted-foreground">{s.secondaryText}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
