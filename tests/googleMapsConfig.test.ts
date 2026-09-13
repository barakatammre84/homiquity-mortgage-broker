import { describe, expect, it } from "vitest";
import {
  getGoogleMapsBrowserApiKey,
  getGoogleMapsServerApiKey,
} from "../server/routes/geocode";

describe("Google Maps credential separation", () => {
  it("uses separately restricted server and browser keys", () => {
    const env = {
      NODE_ENV: "production",
      GOOGLE_MAPS_SERVER_API_KEY: "server-key",
      GOOGLE_MAPS_BROWSER_API_KEY: "browser-key",
    };

    expect(getGoogleMapsServerApiKey(env)).toBe("server-key");
    expect(getGoogleMapsBrowserApiKey(env)).toBe("browser-key");
  });

  it("never accepts the browser-visible legacy key in production", () => {
    const env = { NODE_ENV: "production", GOOGLE_MAPS_API_KEY: "legacy-key" };

    expect(getGoogleMapsServerApiKey(env)).toBeUndefined();
    expect(getGoogleMapsBrowserApiKey(env)).toBeUndefined();
  });

  it("keeps the legacy single key as a local-development fallback", () => {
    const env = { NODE_ENV: "development", GOOGLE_MAPS_API_KEY: "local-key" };

    expect(getGoogleMapsServerApiKey(env)).toBe("local-key");
    expect(getGoogleMapsBrowserApiKey(env)).toBe("local-key");
  });
});
