import type { Express } from "express";
import { getRoleHomeRoute } from "@shared/roleHomeRoute";
import { authStorage } from "./integrations/auth/storage";
import { randomBytes, createSign } from "crypto";

interface OAuthProviderConfig {
  authUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  scope: string;
  parseUserInfo: (data: any) => { email: string; firstName?: string; lastName?: string; profileImageUrl?: string };
  // Some providers (Apple) require additional secrets and a dynamically
  // generated client secret rather than a static one.
  extraSecretEnvs?: string[];
  getClientSecret?: () => string;
}

// Apple Sign In requires the OAuth "client secret" to be a short-lived ES256
// JWT signed with the private key (.p8) issued by Apple, not a static value.
// See https://developer.apple.com/documentation/sign_in_with_apple
function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function generateAppleClientSecret(): string {
  const teamId = process.env.APPLE_TEAM_ID!;
  const keyId = process.env.APPLE_KEY_ID!;
  const clientId = process.env.APPLE_CLIENT_ID!;
  let privateKey = process.env.APPLE_PRIVATE_KEY!;
  // Allow the .p8 contents to be pasted with literal "\n" sequences.
  if (privateKey.includes("\\n")) {
    privateKey = privateKey.replace(/\\n/g, "\n");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: keyId };
  const payload = {
    iss: teamId,
    iat: now,
    exp: now + 60 * 60, // 1 hour; regenerated per request
    aud: "https://appleid.apple.com",
    sub: clientId,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const der = signer.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(der)}`;
}

const providers: Record<string, OAuthProviderConfig> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    scope: "openid email profile",
    parseUserInfo: (data: any) => {
      if (data.verified_email === false) return { email: "" };
      return {
        email: data.email,
        firstName: data.given_name || null,
        lastName: data.family_name || null,
        profileImageUrl: data.picture || null,
      };
    },
  },
  linkedin: {
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    userInfoUrl: "https://api.linkedin.com/v2/userinfo",
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
    scope: "openid profile email",
    parseUserInfo: (data: any) => ({
      email: data.email,
      firstName: data.given_name || null,
      lastName: data.family_name || null,
      profileImageUrl: data.picture || null,
    }),
  },
  apple: {
    authUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    userInfoUrl: "",
    clientIdEnv: "APPLE_CLIENT_ID",
    clientSecretEnv: "APPLE_CLIENT_SECRET",
    scope: "name email",
    extraSecretEnvs: ["APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"],
    getClientSecret: generateAppleClientSecret,
    parseUserInfo: (_data: any) => ({
      email: "",
      firstName: undefined,
      lastName: undefined,
      profileImageUrl: undefined,
    }),
  },
};

function getCallbackUrl(req: any, provider: string): string {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  return `${protocol}://${req.get("host")}/api/auth/${provider}/callback`;
}

// Providers that generate their client secret dynamically (Apple) rely on a set
// of extra secrets instead of a single static client secret.
function requiredEnvVars(provider: OAuthProviderConfig): string[] {
  return provider.getClientSecret
    ? [provider.clientIdEnv, ...(provider.extraSecretEnvs ?? [])]
    : [provider.clientIdEnv, provider.clientSecretEnv];
}

function missingEnvVars(provider: OAuthProviderConfig): string[] {
  return requiredEnvVars(provider).filter((key) => !process.env[key]);
}

function isProviderConfigured(provider: OAuthProviderConfig): boolean {
  return missingEnvVars(provider).length === 0;
}

export interface ProvidersResponse {
  providers: Record<string, boolean>;
  missing?: Record<string, string[]>;
}

export function getSocialAuthSuccessRoute(role: string): string {
  return getRoleHomeRoute(role);
}

/**
 * Drives which social buttons the login/signup pages render. Reports only whether
 * each provider's env vars are PRESENT — never whether the credentials behind
 * them work, which no local check can know.
 *
 * An unconfigured provider is silently hidden in the UI. That is right for
 * borrowers, but it is indistinguishable from a broken build while developing, so
 * in development this also names the env vars each hidden provider is waiting on.
 * Names only, never values — and never off localhost: the route is public and
 * unauthenticated, and every deployed build runs as "production", so
 * keying on "development" fails closed everywhere it matters.
 */
export function buildProvidersResponse(): ProvidersResponse {
  const available: Record<string, boolean> = {};
  for (const [name, config] of Object.entries(providers)) {
    available[name] = isProviderConfigured(config);
  }

  if (process.env.NODE_ENV !== "development") return { providers: available };

  const missing: Record<string, string[]> = {};
  for (const [name, config] of Object.entries(providers)) {
    if (!available[name]) missing[name] = missingEnvVars(config);
  }
  return { providers: available, missing };
}

const STATE_COOKIE = "oauth_state";

function readCookie(req: any, name: string): string | undefined {
  const header = req.headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function decodeJwtPayload(token: string): any {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function setupSocialAuth(app: Express) {
  app.get("/api/auth/providers", (_req, res) => {
    res.json(buildProvidersResponse());
  });

  for (const [providerName, config] of Object.entries(providers)) {
    app.get(`/api/auth/${providerName}`, (req, res) => {
      if (!isProviderConfigured(config)) {
        return res.status(503).json({ error: `${providerName} login is not configured yet` });
      }

      const state = randomBytes(16).toString("hex");
      (req.session as any).oauthState = state;
      (req.session as any).oauthProvider = providerName;

      // Apple replies via a cross-site form_post, so the SameSite=Lax session
      // cookie is not sent on the callback. Store the state in a dedicated
      // SameSite=None cookie so it survives the cross-site POST. We encode the
      // provider alongside the state so it can be validated independently.
      res.cookie(STATE_COOKIE, `${providerName}:${state}`, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        maxAge: 10 * 60 * 1000,
        path: "/api/auth",
      });

      const params = new URLSearchParams({
        client_id: process.env[config.clientIdEnv]!,
        redirect_uri: getCallbackUrl(req, providerName),
        response_type: "code",
        scope: config.scope,
        state,
      });

      if (providerName === "apple") {
        params.set("response_mode", "form_post");
      }

      res.redirect(`${config.authUrl}?${params.toString()}`);
    });

    const callbackHandler = async (req: any, res: any) => {
      const clearState = () => {
        delete (req.session as any).oauthState;
        delete (req.session as any).oauthProvider;
        res.clearCookie(STATE_COOKIE, { path: "/api/auth" });
      };

      try {
        const oauthError = req.body?.error || req.query?.error;
        if (oauthError) {
          const desc = req.body?.error_description || req.query?.error_description || oauthError;
          console.error(`[${providerName}] OAuth provider returned error: ${desc}`);
          clearState();
          return res.redirect("/login?error=auth_failed");
        }

        const code = req.body?.code || req.query?.code;
        const state = req.body?.state || req.query?.state;

        // Prefer the dedicated state cookie (survives Apple's cross-site POST);
        // fall back to the session for same-site GET callbacks.
        const cookieValue = readCookie(req, STATE_COOKIE);
        let expectedState = (req.session as any).oauthState as string | undefined;
        let expectedProvider = (req.session as any).oauthProvider as string | undefined;
        if (cookieValue) {
          const sep = cookieValue.indexOf(":");
          if (sep !== -1) {
            expectedProvider = cookieValue.slice(0, sep);
            expectedState = cookieValue.slice(sep + 1);
          }
        }

        if (!state || !expectedState || state !== expectedState) {
          console.error(`[${providerName}] OAuth state mismatch`);
          clearState();
          return res.redirect("/login?error=auth_failed");
        }

        if (expectedProvider && expectedProvider !== providerName) {
          console.error(`[${providerName}] Provider mismatch: expected ${expectedProvider}`);
          clearState();
          return res.redirect("/login?error=auth_failed");
        }

        clearState();

        if (!code) {
          return res.redirect("/login?error=auth_failed");
        }

        const tokenParams: Record<string, string> = {
          client_id: process.env[config.clientIdEnv]!,
          client_secret: config.getClientSecret ? config.getClientSecret() : process.env[config.clientSecretEnv]!,
          code,
          redirect_uri: getCallbackUrl(req, providerName),
          grant_type: "authorization_code",
        };

        const tokenRes = await fetch(config.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams(tokenParams).toString(),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          console.error(`[${providerName}] Token exchange failed:`, errText);
          return res.redirect("/login?error=auth_failed");
        }

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;
        const idToken = tokenData.id_token;

        let userInfo: { email: string; firstName?: string | null; lastName?: string | null; profileImageUrl?: string | null };

        if (providerName === "apple") {
          const claims = idToken ? decodeJwtPayload(idToken) : null;
          const appleUser = req.body?.user ? (typeof req.body.user === "string" ? JSON.parse(req.body.user) : req.body.user) : null;
          userInfo = {
            email: claims?.email || "",
            firstName: appleUser?.name?.firstName || null,
            lastName: appleUser?.name?.lastName || null,
            profileImageUrl: null,
          };
        } else {
          const userRes = await fetch(config.userInfoUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!userRes.ok) {
            console.error(`[${providerName}] UserInfo fetch failed`);
            return res.redirect("/login?error=auth_failed");
          }
          const userData = await userRes.json();
          userInfo = config.parseUserInfo(userData);
        }

        if (!userInfo.email) {
          console.error(`[${providerName}] No email returned from provider`);
          return res.redirect("/login?error=no_email");
        }

        const email = userInfo.email.trim().toLowerCase();

        const user = await authStorage.upsertSocialUser({
          email,
          firstName: userInfo.firstName || null,
          lastName: userInfo.lastName || null,
          profileImageUrl: userInfo.profileImageUrl || null,
          authProvider: providerName,
        });

        req.login(
          {
            id: user.id,
            email: user.email || undefined,
            firstName: user.firstName || undefined,
            lastName: user.lastName || undefined,
            profileImageUrl: user.profileImageUrl || undefined,
            role: user.role,
          },
          (err: any) => {
            if (err) {
              console.error(`[${providerName}] Session login failed:`, err);
              return res.redirect("/login?error=auth_failed");
            }
            res.redirect(getSocialAuthSuccessRoute(user.role));
          }
        );
      } catch (error) {
        console.error(`[${providerName}] OAuth callback error:`, error);
        res.redirect("/login?error=auth_failed");
      }
    };

    app.get(`/api/auth/${providerName}/callback`, callbackHandler);
    app.post(`/api/auth/${providerName}/callback`, callbackHandler);
  }
}
