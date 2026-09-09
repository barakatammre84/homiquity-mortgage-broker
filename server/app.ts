import { type Server } from "node:http";

import express, {
  type Express,
  type Request,
  Response,
  NextFunction,
} from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import compression from "compression";

import { registerRoutes } from "./routes";
import { startDocumentExtractionWorker } from "./services/documentExtractionJobs";
import { pool } from "./db";
import { betaGateMiddleware } from "./middleware/betaGate";
import { trustProxyHops } from "./trustProxy";
import { rateLimitKey } from "./clientIp";
import { isRateLimitRelaxed } from "./services/rateLimitPolicy";
import { captureException, initErrorMonitoring } from "./services/errorMonitoring";

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export const app = express();

// Hop count must match the real proxy chain or req.ip records the LB instead
// of the caller (TCPA consent + audit rows) — see server/trustProxy.ts.
app.set("trust proxy", trustProxyHops());

// Express 5 changed the default `query parser` from "extended" (qs) to "simple"
// (Node's querystring), which stops nesting brackets: `?arr[]=a&obj[k]=v` parses
// to the literal keys "arr[]" and "obj[k]" instead of an array and an object.
// This app was built against qs semantics — the requirement came from a live
// prod probe where a scalar cast
// meeting an array surfaced as a handler error rather than a silent empty
// result. Keep the Express 4 behaviour explicit rather than inheriting a
// default that just changed underneath us.
app.set("query parser", "extended");

// Response compression, done in-process (no CDN edge does it for us).
// First in the chain so every later writer (API JSON, static assets, SPA
// shell, prerendered documents) is covered. SSE must NOT be compressed:
// buffering would hold frames past their flush (server/sse.ts already sets
// no-transform for intermediaries), so event-stream responses are excluded
// explicitly rather than trusting the mime-db compressible flag.
app.use(
  compression({
    filter: (req, res) => {
      const contentType = String(res.getHeader("Content-Type") ?? "");
      if (contentType.includes("text/event-stream")) return false;
      return compression.filter(req, res);
    },
  }),
);

// Content Security Policy — the authorized-script control for PCI DSS 4.0.1
// Req 6.4.3 / 11.6.1. Every third-party origin listed here is a deliberate,
// documented authorization (script inventory lives in knowledge-base/handbook/app-guide/06):
//   - maps.googleapis.com  : Google Maps JS API + Street View (PropertyMap/StreetView)
//   - cdn.plaid.com        : Plaid Link (react-plaid-link script + iframe)
//   - fonts.googleapis.com / fonts.gstatic.com : Google Fonts (until self-hosted)
//   - storage.googleapis.com : direct-to-GCS document uploads (presigned PUT)
//   - images.unsplash.com  : marketing/property imagery
// Rollout: report-only by default so violations surface in logs without breaking
// pages; set CSP_ENFORCE=true to switch the browser to blocking mode.
// Dev is exempt — Vite HMR needs inline scripts and websockets.
const cspDirectives = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "https://maps.googleapis.com", "https://cdn.plaid.com"],
  styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
  imgSrc: [
    "'self'",
    "data:",
    "blob:",
    "https://maps.googleapis.com",
    "https://maps.gstatic.com",
    "https://*.googleapis.com",
    "https://images.unsplash.com",
  ],
  connectSrc: ["'self'", "https://maps.googleapis.com", "https://storage.googleapis.com"],
  frameSrc: ["https://cdn.plaid.com"],
  workerSrc: ["'self'", "blob:"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  reportUri: ["/api/csp-report"],
};

/**
 * Strip the query string and fragment off a URL before it reaches a log line.
 *
 * Not cosmetic. A violation fired on `/reset-password?token=…` or
 * `/verify-email?token=…` would otherwise write a live single-use credential
 * into the application log, where it outlives the 30-minute token TTL and is
 * readable by anyone with log access. `blocked-uri` is frequently a bare
 * keyword ("eval", "inline") rather than a URL, so anything without a `?`/`#`
 * passes through untouched.
 */
function scrubUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "?";
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : `${raw.slice(0, cut)}?<redacted>`;
}

function pick(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number") return String(v);
  }
  return "?";
}

/**
 * Render browser CSP violation reports as log lines.
 *
 * Exported for tests, and separated from the route so the parsing can be
 * exercised without an HTTP round trip.
 *
 * Two things this fixes, both of which made the existing log unactionable:
 *
 * 1. It logs `source-file`, `line-number`, `column-number` and `script-sample`.
 *    Without them a report says only *that* something was blocked, never
 *    *which script did it* — a `blocked=eval` line naming neither file nor
 *    sample cannot be chased to a cause, which is why the recurring eval
 *    violation on /signup and /dashboard sat in the logs unexplained.
 * 2. It accepts the Reporting API shape as well as the legacy one. `report-uri`
 *    posts a single `{"csp-report": {kebab-case}}` object, but the newer
 *    `report-to` / `Reporting-Endpoints` transport posts an ARRAY of
 *    `{type, body:{camelCase}}` envelopes. The previous code indexed
 *    `body["csp-report"]` on that array, got undefined, and logged a line of
 *    all-"?" values — present in the log, carrying nothing. The endpoint
 *    already advertises `application/reports+json`, so it can receive these.
 *
 * `script-sample` is capped at 40 chars by the CSP spec; it is truncated again
 * here so a non-conforming client cannot dump an arbitrary payload into logs.
 * The envelope count is capped for the same reason: the 50kb body limit still
 * admits thousands of tiny envelopes, and one line each would be a log-flood
 * primitive reachable without authentication.
 */
const MAX_REPORTS_PER_REQUEST = 10;

export function formatCspReports(body: unknown): string[] {
  const envelopes: unknown[] = Array.isArray(body)
    ? body.slice(0, MAX_REPORTS_PER_REQUEST).map((entry) => (entry as Record<string, unknown>)?.body ?? entry)
    : [(body as Record<string, unknown>)?.["csp-report"] ?? body];

  return envelopes.map((entry) => {
    const r = (entry ?? {}) as Record<string, unknown>;
    const sample = pick(r["script-sample"], r.sample);
    return (
      `CSP violation: directive=${pick(r["effective-directive"], r["violated-directive"], r.effectiveDirective, r.violatedDirective)} ` +
      `blocked=${scrubUrl(pick(r["blocked-uri"], r.blockedURI, r.blockedURL))} ` +
      `page=${scrubUrl(pick(r["document-uri"], r.documentURI, r.documentURL))} ` +
      `source=${scrubUrl(pick(r["source-file"], r.sourceFile))}:${pick(r["line-number"], r.lineNumber)}:${pick(r["column-number"], r.columnNumber)} ` +
      `sample=${sample === "?" ? "?" : JSON.stringify(sample.slice(0, 80))}`
    );
  });
}

/**
 * Baseline security headers. Exported so a test can assert that the REAL config
 * produces the REAL headers, rather than restating the config back to itself.
 *
 * That indirection is the point: X-Frame-Options was served from two places
 * with two different values — the old CDN layer sent DENY while helmet's
 * in-app default sent SAMEORIGIN. Whichever landed depended on the platform,
 * nothing tested it, and when the CDN went away the weaker value became the
 * only one. Nobody would have noticed.
 */
export const HELMET_OPTIONS = {
  contentSecurityPolicy:
    process.env.NODE_ENV === "production"
      ? {
          directives: cspDirectives,
          reportOnly: process.env.CSP_ENFORCE !== "true",
        }
      : false,
  crossOriginEmbedderPolicy: false as const, // Google Maps tiles are not CORP-tagged
  // DENY, not helmet's SAMEORIGIN default. Nothing legitimately frames this
  // app, and there is no CDN layer left to supply a stronger value — the app
  // response IS the response.
  //
  // The modern equivalent (CSP `frame-ancestors 'none'`, in cspDirectives
  // above) does NOT close this on its own: CSP ships Report-Only until
  // CSP_ENFORCE is set, so frame-ancestors is currently observed, not
  // enforced. X-Frame-Options is the header actually blocking a frame today.
  frameguard: { action: "deny" as const },
};

app.use(helmet(HELMET_OPTIONS));

// Liveness probe. The mount position is the whole point: it sits ahead of the
// beta gate, the rate limiters, the body parsers and every route, because each
// of those would otherwise answer it.
//
//   - betaGateMiddleware carves out only `/api/` (server/middleware/betaGate.ts),
//     so a bare `/health` mounted BELOW it gets the 401 lock screen the moment
//     BETA_ACCESS_CODE is armed — a health check that fails exactly when the
//     private beta is switched on.
//   - With no route of its own, `/health` falls through to the SPA catch-all and
//     returns the HTML shell with a 200. That is worse than a 404: it reads as
//     healthy while proving nothing about the process.
//
// It answers from the event loop alone — no database, no I/O — so a 200 here
// means exactly one thing: this process is up and scheduling work. That is the
// correct semantics for a liveness probe, whose only remedy is a restart.
//
// READINESS is a different question and lives at GET /api/health
// (server/routes.ts), which pings Postgres and carries the deployed commit.
// railway.json points `healthcheckPath` at THAT one on purpose: a deploy that
// cannot reach the database must not replace a container that can. Keep the two
// separate — collapsing them either blinds the deploy gate to a dead database,
// or fails liveness for a reason no restart can fix.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Private-beta gate (server/middleware/betaGate.ts). Total no-op unless
// BETA_ACCESS_CODE is set. Must mount ahead of the whole route surface:
// /robots.txt's Disallow-all override has to win over the static file, and
// non-API document routes registered later (e.g. /sitemap.xml) are gated
// exactly as they were at the edge. /api/* passes through inside the gate.
app.use(betaGateMiddleware);

const generalLimiter = rateLimit({
  keyGenerator: rateLimitKey,
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
  skip: (req) => !req.path.startsWith("/api") || isRateLimitRelaxed(),
});

const authLimiter = rateLimit({
  keyGenerator: rateLimitKey,
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later" },
  skip: () => isRateLimitRelaxed(),
});

const uploadLimiter = rateLimit({
  keyGenerator: rateLimitKey,
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many upload requests, please try again later" },
});

const trackLimiter = rateLimit({
  keyGenerator: rateLimitKey,
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many tracking requests" },
});

const emailCaptureLimiter = rateLimit({
  keyGenerator: rateLimitKey,
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// Strict limiter for expensive AI document-extraction endpoints. These invoke a
// paid LLM per request, so they are a cost-DoS vector and need a tighter cap than
// the general 500/15min limiter.
const extractionLimiter = rateLimit({
  keyGenerator: rateLimitKey,
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many document extraction requests, please try again later" },
});

// Paid-LLM chat endpoints (Homi). Same cost-DoS rationale as extraction:
// every message invokes a paid model. The per-user 30/day cap in the route is
// the primary ceiling; this per-IP limiter blunts bursts and scripted abuse.
const aiCoachLimiter = rateLimit({
  keyGenerator: rateLimitKey,
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many coach messages, please try again in a few minutes" },
  skip: () => isRateLimitRelaxed(),
});

// Unauthenticated proxies to paid third-party APIs (Google geocoding, live
// property/listing data vendors). Tighter than the general limiter because
// each request is billable and requires no login — a cheap cost-DoS vector.
const vendorProxyLimiter = rateLimit({
  keyGenerator: rateLimitKey,
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

// Public, unauthenticated lead intake. Aggregators post server-to-server so a
// modest per-IP ceiling still admits legitimate bursts while blunting spam.
const leadsLimiter = rateLimit({
  keyGenerator: rateLimitKey,
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many lead submissions, please try again later" },
});

app.use("/api/login", authLimiter);
app.use("/api/callback", authLimiter);
app.use("/api/test-login", authLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/auth/forgot-password", authLimiter);
app.use("/api/auth/reset-password", authLimiter);
app.use("/api/auth/verify-email", authLimiter);
app.use("/api/auth/resend-verification", authLimiter);
app.use("/api/uploads", uploadLimiter);
app.use("/api/documents/upload", uploadLimiter);
app.use("/api/documents/extract-tax-return", extractionLimiter);
app.use("/api/documents/extract-paystub", extractionLimiter);
app.use("/api/documents/extract-bank-statement", extractionLimiter);
app.use("/api/calculators/extract-lease", extractionLimiter);
// Prefix mount covers both /api/coach/message and /api/coach/message/stream.
app.use("/api/coach/message", aiCoachLimiter);
app.use("/api/geocode", vendorProxyLimiter);
app.use("/api/properties/auto-complete", vendorProxyLimiter);
app.use("/api/properties/search-live", vendorProxyLimiter);
app.use("/api/properties/detail-live", vendorProxyLimiter);
app.use("/api/properties/similar-homes", vendorProxyLimiter);
app.use("/api/properties/search-sold", vendorProxyLimiter);
app.use("/api/listings/search", vendorProxyLimiter);
app.use("/api/listings/nearby", vendorProxyLimiter);
app.use("/api/track", trackLimiter);
// Only the public POST intake is throttled; the authenticated staff GET list
// and detail views under /api/leads are left to the general limiter.
app.use("/api/leads", (req, res, next) => (req.method === "POST" ? leadsLimiter(req, res, next) : next()));
// Inbound SMS provider webhook — modest ceiling; a provider retries transiently.
app.use("/api/webhooks/sms", rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many webhook requests" },
}));
// Client error telemetry — cap so a looping browser can't flood the reporter.
app.use("/api/client-errors", rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many error reports" },
}));
app.use("/api/email-capture", emailCaptureLimiter);
app.use("/api/partner-waitlist", emailCaptureLimiter);
app.use(generalLimiter);

declare module 'http' {
  interface IncomingMessage {
    rawBody: unknown
  }
}
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: false }));

// Browser-generated CSP violation reports. Registered after the rate limiters
// but before the CSRF check (reports are cross-context POSTs with no Origin
// header) and parsed with the report-specific content types express.json()
// ignores by default.
app.post(
  "/api/csp-report",
  express.json({ type: ["application/json", "application/csp-report", "application/reports+json"], limit: "50kb" }),
  (req, res) => {
    for (const line of formatCspReports(req.body)) log(line, "csp");
    res.status(204).end();
  },
);

// CSRF Protection for session-based routes
// Check Origin/Referer headers for state-changing requests
app.use((req, res, next) => {
  const safeMethods = ['GET', 'HEAD', 'OPTIONS'];
  if (safeMethods.includes(req.method)) {
    return next();
  }

  if (!req.path.startsWith('/api')) {
    return next();
  }

  // OAuth provider callbacks (e.g. Apple's form_post) arrive as cross-origin
  // POSTs from the provider's domain. They are protected by the OAuth `state`
  // parameter (validated against the session), so exempt them from the
  // Origin/Referer CSRF check which would otherwise reject them.
  if (/^\/api\/auth\/[^/]+\/callback$/.test(req.path)) {
    return next();
  }

  // Vendor webhooks (Plaid, etc.) are server-to-server posts with no Origin
  // header and no session — CSRF does not apply. Each webhook route does its
  // own verification (shared secret / signature).
  if (req.path.startsWith("/api/webhooks/")) {
    return next();
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = req.headers.host;
  const isDev = process.env.NODE_ENV === 'development';

  const allowedDomains = new Set<string>();
  const hostName = host?.split(':')[0];
  if (hostName) allowedDomains.add(hostName);
  if (isDev) {
    allowedDomains.add('localhost');
    allowedDomains.add('127.0.0.1');
  }

  const isAllowed = (headerValue: string | undefined): boolean => {
    if (!headerValue) return false;
    try {
      const url = new URL(headerValue);
      return allowedDomains.has(url.hostname);
    } catch {
      return false;
    }
  };

  if (isAllowed(origin) || isAllowed(referer)) {
    return next();
  }

  if (isDev) {
    return next();
  }

  if (!origin && !referer) {
    log(`CSRF check failed: no origin or referer header, host=${host}`);
    return res.status(403).json({ error: 'CSRF validation failed' });
  }

  log(`CSRF check failed: origin=${origin}, referer=${referer}, host=${host}, allowed=${Array.from(allowedDomains).join(',')}`);
  return res.status(403).json({ error: 'CSRF validation failed' });
});

const SENSITIVE_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/^(\/api\/staff-invites\/validate\/)([^/]+)/, "$1[REDACTED]"],
];

// Response bodies are logged ONLY for paths on this allowlist. Almost every
// endpoint in this app can carry borrower PII (SSNs, income, account data), so
// the safe default is to log status/duration only. A denylist was the previous
// approach and it silently missed new PII routes (e.g. /api/urla/* responses
// contain the borrower's SSN) — do not revert to one. Add a path here only if
// its response can never contain personal or credential data.
const RESPONSE_BODY_LOG_ALLOWLIST: RegExp[] = [
  /^\/api\/health$/,
  /^\/api\/track$/, // responds { ok: true } only
  /^\/api\/csp-report$/,
];

function sanitizePathForLog(path: string): string {
  for (const [pattern, replacement] of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(path)) {
      return path.replace(pattern, replacement);
    }
  }
  return path;
}

function mayLogResponseBody(path: string): boolean {
  return RESPONSE_BODY_LOG_ALLOWLIST.some((p) => p.test(path));
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      const safePath = sanitizePathForLog(path);
      let logLine = `${req.method} ${safePath} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse && mayLogResponseBody(path)) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

// Builds the fully-wired Express app (routes, error handler, and the provided
// setup step) WITHOUT binding a port. runApp() below listens; createApp() is
// exported separately so tests can drive the app without a socket.
export async function createApp(
  setup: (app: Express, server: Server) => Promise<void>,
): Promise<{ app: Express; server: Server }> {
  const server = await registerRoutes(app);

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    // Report server errors (5xx) to monitoring; 4xx are expected client-contract
    // responses and would be noise.
    if (status >= 500) {
      captureException(err, { path: sanitizePathForLog(req.path), method: req.method, status });
    }

    log(`Express error: ${status} ${message}`, "error");
    if (!res.headersSent) {
      // 5xx messages are internal detail (driver errors, stack fragments,
      // connection strings in pg errors) — log them, but never send them to
      // the client in production. 4xx messages are intentional client-facing
      // contract and pass through.
      const isServerError = status >= 500;
      const clientMessage =
        isServerError && process.env.NODE_ENV === "production"
          ? "Internal Server Error"
          : message;
      res.status(status).json({ message: clientMessage });
    }
  });

  // importantly run the final setup after setting up all the other routes so
  // the catch-all route doesn't interfere with the other routes
  await setup(app, server);

  return { app, server };
}

export default async function runApp(
  setup: (app: Express, server: Server) => Promise<void>,
) {
  initErrorMonitoring();

  // A failing stdout/stderr must never take the process down with it: piped
  // runs can close the read end, and the keep-alive handlers below would
  // otherwise re-throw on their own logging — the 2026-08-05 event-loop
  // storm (EPIPE → handler logs → EPIPE → …), which pinned the CPU at 100%
  // and left every request dead until an external restart.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  // Runaway breaker: a handler firing continuously means the process is
  // wedged, and crash-and-restart beats a zombie serving nothing.
  let stormCount = 0;
  let stormWindowStart = 0;
  const noteStorm = () => {
    const now = Date.now();
    if (now - stormWindowStart > 5_000) {
      stormWindowStart = now;
      stormCount = 0;
    }
    stormCount += 1;
    if (stormCount >= 50) {
      try {
        console.error("Uncaught-exception storm detected — exiting for a clean restart.");
      } catch {
        /* stdout may itself be the casualty */
      }
      process.exit(1);
    }
  };

  process.on("uncaughtException", (err) => {
    noteStorm();
    try {
      log(`Uncaught Exception: ${err.message}`, "error");
      console.error(err.stack);
    } catch {
      /* logging must never re-throw here */
    }
    try {
      captureException(err, { kind: "uncaughtException" });
    } catch {
      /* reporting must never re-throw here */
    }
    // A persistent process that survives an uncaught throw keeps serving in
    // an undefined state behind a green /api/health (the DB ping still
    // passes). The platform supervises restarts, so crash clean instead —
    // log-and-continue was only safe when serverless recycled the instance.
    // Capture above is fire-and-forget by design; stderr is the crash record.
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    noteStorm();
    try {
      log(`Unhandled Rejection: ${reason}`, "error");
      if (reason instanceof Error) {
        console.error(reason.stack);
      }
    } catch {
      /* logging must never re-throw here */
    }
    try {
      captureException(reason, { kind: "unhandledRejection" });
    } catch {
      /* reporting must never re-throw here */
    }
  });

  const { server } = await createApp(setup);

  // Node's 5s keep-alive default is shorter than a typical platform LB's
  // ~60s idle window — the LB reuses a socket the server just closed and the
  // caller sees a sporadic 502. Keep-alive must outlive the LB's idle timer,
  // and headersTimeout must exceed keepAliveTimeout so a parked keep-alive
  // socket is not torn down as a slow-header client.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen({ port, host: "0.0.0.0" }, () => {
    log(`serving on port ${port}`);
  });
  const documentExtractionWorker = startDocumentExtractionWorker();

  // Graceful drain on the platform's stop signal (deploy replace, restart,
  // scale-down): stop accepting, let in-flight requests finish, release the
  // pg pool, exit 0 so the supervisor reads a clean stop. The drain is
  // bounded — long-lived SSE connections are active sockets and would hold
  // server.close() open indefinitely, so a force-exit timer caps the window
  // (unref'd: it must never keep an otherwise-finished process alive).
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    documentExtractionWorker.stop();
    log(`${signal} received — draining connections`, "shutdown");
    const forceExit = setTimeout(() => {
      log("drain window elapsed — forcing exit", "shutdown");
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    server.close(() => {
      void Promise.resolve()
        .then(() => pool.end())
        .catch(() => {
          /* a failed pool teardown must not block the exit */
        })
        .then(() => process.exit(0));
    });
    // Parked keep-alive sockets are not "in flight" — without this, close()
    // waits out every idle browser connection for the full drain window.
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
