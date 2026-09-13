import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildProvidersResponse, getSocialAuthSuccessRoute } from "../server/socialAuth";

// buildProvidersResponse drives GET /api/auth/providers, which decides which
// social buttons the login/signup pages render. It reports whether each
// provider's env vars are PRESENT — never whether the credentials behind them
// are valid, which is why a provider can report configured and still fail at
// Google's token exchange.

const OAUTH_ENV = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "APPLE_CLIENT_ID",
  "APPLE_CLIENT_SECRET",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
];

describe("buildProvidersResponse", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [...OAUTH_ENV, "NODE_ENV"]) saved[key] = process.env[key];
    for (const key of OAUTH_ENV) delete process.env[key];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reports a provider configured only once every required env var is set", () => {
    process.env.NODE_ENV = "production";
    process.env.GOOGLE_CLIENT_ID = "id";

    expect(buildProvidersResponse().providers.google).toBe(false); // secret still missing

    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(buildProvidersResponse().providers.google).toBe(true);
  });

  it("treats Apple's dynamic client secret as its signing vars, not APPLE_CLIENT_SECRET", () => {
    process.env.NODE_ENV = "development";
    process.env.APPLE_CLIENT_ID = "id";
    process.env.APPLE_CLIENT_SECRET = "irrelevant"; // Apple signs an ES256 JWT instead

    const res = buildProvidersResponse();
    expect(res.providers.apple).toBe(false);
    expect(res.missing?.apple).toEqual(["APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"]);

    process.env.APPLE_TEAM_ID = "team";
    process.env.APPLE_KEY_ID = "key";
    process.env.APPLE_PRIVATE_KEY = "pem";
    expect(buildProvidersResponse().providers.apple).toBe(true);
  });

  it("names the missing env vars in development so a hidden button explains itself", () => {
    process.env.NODE_ENV = "development";

    const { missing } = buildProvidersResponse();

    expect(missing?.google).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    expect(missing?.linkedin).toEqual(["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"]);
  });

  it("omits a configured provider from missing", () => {
    process.env.NODE_ENV = "development";
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";

    const res = buildProvidersResponse();

    expect(res.providers.google).toBe(true);
    expect(res.missing).not.toHaveProperty("google");
  });

  // The route is public and unauthenticated. Env var NAMES are a development
  // affordance and must never be served off localhost — deployed builds, preview
  // included, run as "production", and an unset NODE_ENV must not leak either.
  it.each(["production", "test", undefined])("withholds missing when NODE_ENV is %s", (nodeEnv) => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;

    const res = buildProvidersResponse();

    expect(res.providers.google).toBe(false);
    expect(res).not.toHaveProperty("missing");
  });
});

describe("getSocialAuthSuccessRoute", () => {
  it.each(["lo", "loa"])("lands %s in the streamlined deal desk", (role) => {
    expect(getSocialAuthSuccessRoute(role)).toBe("/lo-command-center");
  });

  it("preserves the broker-specific dashboard", () => {
    expect(getSocialAuthSuccessRoute("broker")).toBe("/broker-dashboard");
  });

  it("lands borrowers in their dashboard", () => {
    expect(getSocialAuthSuccessRoute("active_buyer")).toBe("/dashboard");
  });
});
