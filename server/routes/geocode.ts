import { Express, Request, Response } from "express";
import { firstQueryValue } from "./queryParams";

const autocompleteCache = new Map<string, { data: any; expires: number }>();
const detailsCache = new Map<string, { data: any; expires: number }>();

type MapsEnv = Partial<Pick<NodeJS.ProcessEnv,
  "NODE_ENV" | "GOOGLE_MAPS_SERVER_API_KEY" | "GOOGLE_MAPS_BROWSER_API_KEY" | "GOOGLE_MAPS_API_KEY"
>>;

// Production uses two separately restricted keys. The legacy single key is
// accepted only outside production so existing local setups do not break while
// preventing an unrestricted browser-visible key from reaching a live deploy.
export function getGoogleMapsServerApiKey(env: MapsEnv = process.env): string | undefined {
  return env.GOOGLE_MAPS_SERVER_API_KEY ||
    (env.NODE_ENV !== "production" ? env.GOOGLE_MAPS_API_KEY : undefined);
}

export function getGoogleMapsBrowserApiKey(env: MapsEnv = process.env): string | undefined {
  return env.GOOGLE_MAPS_BROWSER_API_KEY ||
    (env.NODE_ENV !== "production" ? env.GOOGLE_MAPS_API_KEY : undefined);
}

function getCached(cache: Map<string, { data: any; expires: number }>, key: string) {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.data;
  if (entry) cache.delete(key);
  return null;
}

function setCache(cache: Map<string, { data: any; expires: number }>, key: string, data: any, ttlMs: number) {
  cache.set(key, { data, expires: Date.now() + ttlMs });
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (v.expires < now) cache.delete(k);
    }
  }
}

export function registerGeocodeRoutes(app: Express) {
  const serverApiKey = getGoogleMapsServerApiKey();
  const browserApiKey = getGoogleMapsBrowserApiKey();

  app.get("/api/geocode/autocomplete", async (req: Request, res: Response) => {
    const input = (firstQueryValue(req.query.input) || "").trim();
    const mode = (firstQueryValue(req.query.mode) || "address").trim();
    if (input.length < 3) {
      return res.json([]);
    }
    if (!serverApiKey) {
      return res.status(503).json({ error: "Google Maps server API key not configured" });
    }

    const cacheKey = `${mode}:${input.toLowerCase()}`;
    const cached = getCached(autocompleteCache, cacheKey);
    if (cached) return res.json(cached);

    const primaryTypes = mode === "location"
      ? ["locality", "administrative_area_level_1", "postal_code", "sublocality"]
      : ["street_address", "premise"];

    try {
      const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
        method: "POST",
        headers: {
          "X-Goog-Api-Key": serverApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input,
          includedPrimaryTypes: primaryTypes,
          includedRegionCodes: ["us"],
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        console.error("Places autocomplete error:", response.status, errText.slice(0, 300));
        return res.status(502).json({ error: "Address lookup failed" });
      }

      const data = await response.json();
      const suggestions = (data.suggestions || []).slice(0, 5).map((s: any) => ({
        placeId: s.placePrediction?.placeId || "",
        description: s.placePrediction?.text?.text || "",
        mainText: s.placePrediction?.structuredFormat?.mainText?.text || "",
        secondaryText: s.placePrediction?.structuredFormat?.secondaryText?.text || "",
      }));

      setCache(autocompleteCache, cacheKey, suggestions, 10 * 60 * 1000);
      return res.json(suggestions);
    } catch (err) {
      console.error("Places autocomplete error:", err);
      return res.status(500).json({ error: "Address lookup failed" });
    }
  });

  app.get("/api/geocode/details", async (req: Request, res: Response) => {
    const placeId = (firstQueryValue(req.query.placeId) || "").trim();
    if (!placeId) {
      return res.status(400).json({ error: "placeId is required" });
    }
    if (!serverApiKey) {
      return res.status(503).json({ error: "Google Maps server API key not configured" });
    }

    const cached = getCached(detailsCache, placeId);
    if (cached) return res.json(cached);

    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?place_id=${encodeURIComponent(placeId)}&key=${serverApiKey}`;
      const response = await fetch(url);

      if (!response.ok) {
        console.error("Geocoding error:", response.status);
        return res.status(502).json({ error: "Geocoding failed" });
      }

      const data = await response.json();
      const result = data.results?.[0];
      if (!result) {
        return res.json({ error: "No results found" });
      }

      const components = result.address_components || [];
      const getComponent = (type: string) =>
        components.find((c: any) => c.types.includes(type));

      const streetNumber = getComponent("street_number")?.long_name || "";
      const route = getComponent("route")?.long_name || "";
      const city = getComponent("locality")?.long_name || getComponent("sublocality")?.long_name || "";
      const state = getComponent("administrative_area_level_1")?.short_name || "";
      const zip = getComponent("postal_code")?.long_name || "";
      const county = getComponent("administrative_area_level_2")?.long_name || "";

      const details = {
        formattedAddress: result.formatted_address || "",
        lat: result.geometry?.location?.lat || 0,
        lng: result.geometry?.location?.lng || 0,
        streetNumber,
        route,
        streetAddress: streetNumber && route ? `${streetNumber} ${route}` : "",
        city,
        state,
        zip,
        county,
      };

      setCache(detailsCache, placeId, details, 60 * 60 * 1000);
      return res.json(details);
    } catch (err) {
      console.error("Geocoding error:", err);
      return res.status(500).json({ error: "Geocoding failed" });
    }
  });

  app.get("/api/geocode/validate", async (req: Request, res: Response) => {
    const address = (firstQueryValue(req.query.address) || "").trim();
    if (!address) {
      return res.status(400).json({ error: "address is required" });
    }
    if (!serverApiKey) {
      return res.status(503).json({ error: "Google Maps server API key not configured" });
    }

    try {
      const response = await fetch("https://addressvalidation.googleapis.com/v1:validateAddress", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": serverApiKey,
        },
        body: JSON.stringify({
          address: { addressLines: [address] },
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        console.error("Address validation error:", response.status, errText.slice(0, 300));
        return res.status(502).json({ error: "Address validation failed" });
      }

      const data = await response.json();
      const result = data.result || {};
      const verdict = result.verdict || {};
      const postalAddr = result.address?.postalAddress || {};
      const dpv = result.uspsData?.dpvConfirmation || null;

      const correctedLines = postalAddr.addressLines || [];
      const correctedAddress = [
        ...correctedLines,
        [postalAddr.locality, postalAddr.administrativeArea, postalAddr.postalCode]
          .filter(Boolean)
          .join(", "),
      ]
        .filter(Boolean)
        .join(", ");

      return res.json({
        isValid: verdict.addressComplete === true && verdict.hasUnconfirmedComponents !== true,
        correctedAddress: correctedAddress || address,
        dpv,
        verdict,
      });
    } catch (err) {
      console.error("Address validation error:", err);
      return res.status(500).json({ error: "Address validation failed" });
    }
  });

  app.get("/api/config/maps-key", (_req: Request, res: Response) => {
    if (!browserApiKey) {
      return res.status(503).json({ error: "Google Maps browser API key not configured" });
    }
    return res.json({ key: browserApiKey });
  });
}
