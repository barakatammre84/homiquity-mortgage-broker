import { QueryClient, QueryFunction } from "@tanstack/react-query";

// Latches while a redirect to /login is already in flight, so a burst of
// concurrent 401s doesn't queue N navigations.
let sessionExpiredHandled = false;

/** Pre-auth surfaces: a 401 here is a *failed sign-in*, not an expired session. */
const PRE_AUTH_PATHS = ["/", "/login", "/signup"];

function handleSessionExpired() {
  // Order matters. The path check MUST come before the latch is consumed:
  // POST /api/auth/login answers 401 on a wrong password (server/auth.ts:155),
  // so setting the latch first meant one typo on /login burned it for the whole
  // tab — and the real session expiry, hours later, then redirected nowhere.
  const currentPath = window.location.pathname;
  if (PRE_AUTH_PATHS.includes(currentPath)) return;

  if (sessionExpiredHandled) return;
  sessionExpiredHandled = true;

  setTimeout(() => {
    window.location.href = "/login";
  }, 100);
}

/**
 * What `apiRequest` throws on a non-2xx. The `message` keeps the historical
 * `"<status>: <body>"` shape that `friendlyApiError` parses, so nothing that
 * only reads the message needs to change; `status` is added so a caller can
 * branch on it (e.g. 403 → "restricted to internal staff") without parsing the
 * string back out.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function throwIfResNotOk(
  res: Response,
  /**
   * Set false for endpoints that serve signed-out visitors. A 401 there is not
   * an expired session (there was never a session), so bouncing to /login would
   * throw a browsing visitor out of a public page.
   */
  { sessionRedirect = true }: { sessionRedirect?: boolean } = {},
) {
  // Any 2xx proves the session is alive again, so the latch must not outlive it
  // (re-login in the same tab, or a 401 that turned out to be transient).
  if (res.ok) {
    sessionExpiredHandled = false;
    return;
  }
  if (res.status === 401 && sessionRedirect) {
    const url = typeof res.url === "string" ? res.url : "";
    // Background shell polls should not trigger a login redirect on their own;
    // /api/shell/badges is the consolidated badge poll that replaced the
    // per-count polls.
    const isBackgroundPoll =
      url.includes("/api/auth/user") ||
      url.includes("/api/notifications/unread-count") ||
      url.includes("/api/shell/badges");
    if (!isBackgroundPoll) {
      handleSessionExpired();
    }
  }
  const text = (await res.text()) || res.statusText;
  throw new ApiError(res.status, `${res.status}: ${text}`);
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

/**
 * Build a request URL from a query key. THE URL builder — every queryFn in this
 * file routes through it, public and authenticated alike.
 *
 * Scalar segments join with "/" (the historical behaviour); a trailing plain
 * object becomes the query string. That makes `["/api/faqs", { search, category }]`
 * a complete description of the request — which matters because the key is
 * *already* how the cache identifies it, so the two can never disagree.
 *
 * Empty, null and undefined params are dropped, so an unset filter produces
 * `/api/faqs` rather than `/api/faqs?search=&category=`.
 *
 * It did not always cover both paths: `getQueryFn` (the authenticated default)
 * used a bare `queryKey.join("/")`, so the params-object form documented here
 * worked ONLY on public surfaces and silently produced
 * `/api/consent-templates/[object Object]` behind the session. ConsentGateCard
 * hit exactly that and worked around it with a hand-written queryFn whose URL
 * was a second, independent spelling of its key — the drift this module's key
 * factories exist to prevent. One builder, both paths, no second spelling.
 */
export function buildQueryUrl(queryKey: readonly unknown[]): string {
  const last = queryKey[queryKey.length - 1];
  const hasParams =
    typeof last === "object" && last !== null && !Array.isArray(last);

  const segments = (hasParams ? queryKey.slice(0, -1) : queryKey).filter(
    (s) => s !== undefined && s !== null && s !== "",
  );
  const path = segments.join("/");
  if (!hasParams) return path;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(last as Record<string, unknown>)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Query function for endpoints that serve signed-out visitors (rates, articles,
 * FAQs, agent search, invite validation).
 *
 * Public pages used to hand-roll `fetch` + `if (!res.ok) throw new Error(...)`
 * inside every `queryFn`. That produced a second, quieter transport contract:
 * a bare `Error` instead of `ApiError`, so `friendlyApiError` could not read the
 * server's own message envelope and a deliberate 503 (INTAKE_PAUSED) surfaced as
 * "Failed to fetch rates". It was also copy-paste bait — the pattern carries no
 * signal that it drops 401 handling, so an authed page cloned from a rates page
 * would silently lose the session-expiry redirect.
 *
 * This keeps the one thing those hand-rolled fetches got right — no redirect on
 * 401 — but makes it an explicit, documented mode of the shared transport rather
 * than a side effect of bypassing it. Errors are `ApiError`, so public and
 * authed surfaces report failures identically.
 *
 * Use `getQueryFn` (the default) for anything behind the session.
 */
export const getPublicQueryFn =
  <T>(): QueryFunction<T> =>
  async ({ queryKey }) => {
    // No `credentials: "include"` — these endpoints are public, so there is no
    // reason to attach the session cookie.
    const res = await fetch(buildQueryUrl(queryKey));
    await throwIfResNotOk(res, { sessionRedirect: false });
    return (await res.json()) as T;
  };

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(buildQueryUrl(queryKey), {
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

/**
 * THE query keys for the loan-application resource family.
 *
 * `buildQueryUrl` joins scalar segments with "/", so a key written as one
 * template string (`` [`/api/loan-applications/${id}/options`] ``) and one
 * written as segments (`["/api/loan-applications", id, "options"]`) fetch the
 * *same URL* — but they are two different cache entries, and only the segmented
 * form participates in prefix invalidation.
 *
 * That distinction was silently breaking refreshes: `invalidateQueries({
 * queryKey: ["/api/loan-applications", id] })` — fired from BorrowerFile,
 * StatusUpdateDialog, CreditTab, ConditionsTab, DocumentReviewPanel and
 * LoanPipeline — matches every segmented child but *cannot* match a
 * single-string key, so the submission-readiness and lender-submission panels
 * kept rendering pre-change data until a hard reload.
 *
 * Always build loan-application keys from here. Never hand-write a
 * `` [`/api/loan-applications/${id}/...`] `` template key — `pnpm guard:querykeys`
 * fails the build on one.
 */
export const loanApplicationKeys = {
  fileReview: (id: string) => ["/api/loan-applications", id, "file-review"] as const,
  /** The whole family — invalidates every application query, list included. */
  all: () => ["/api/loan-applications"] as const,
  /** One file and everything nested under it (the common invalidation prefix). */
  detail: (id: string) => ["/api/loan-applications", id] as const,
  pipeline: (id: string) => ["/api/loan-applications", id, "pipeline"] as const,
  options: (id: string) => ["/api/loan-applications", id, "options"] as const,
  offers: (id: string) => ["/api/loan-applications", id, "offers"] as const,
  actionItemsRoot: () => ["/api/applications"] as const,
  // Note the different path prefix: the action-items route grew up on the
  // dashboard registrar under /api/applications.
  actionItems: (id: string) => ["/api/applications", id, "action-items"] as const,
  properties: (id: string) => ["/api/loan-applications", id, "properties"] as const,
  prequalStatus: (id: string) => ["/api/loan-applications", id, "prequal-status"] as const,
  letterStatus: (id: string) => ["/api/loan-applications", id, "letter-status"] as const,
  loanEstimate: (id: string) => ["/api/loan-applications", id, "loan-estimate"] as const,
  /** F-4's read-only tolerance/cure posture (staff). */
  leTolerance: (id: string) => ["/api/loan-applications", id, "le-tolerance"] as const,
  /** F-11's per-file cost ledger (staff). */
  costs: (id: string) => ["/api/loan-applications", id, "costs"] as const,
  /** F-18's QM ceiling for the compensation election (staff). */
  compensationQm: (id: string) =>
    ["/api/loan-applications", id, "compensation", "qm"] as const,
  hmda: (id: string) => ["/api/loan-applications", id, "hmda"] as const,
  incomeSummary: (id: string) => ["/api/loan-applications", id, "income-summary"] as const,
  submissionReadiness: (id: string) =>
    ["/api/loan-applications", id, "submission-readiness"] as const,
  lenderSubmissions: (id: string) =>
    ["/api/loan-applications", id, "lender-submissions"] as const,
  changeOfCircumstances: (id: string) =>
    ["/api/loan-applications", id, "change-of-circumstances"] as const,
  /**
   * Credit sub-tree. Kept fully SEGMENTED on purpose: the codebase currently
   * mixes `[id, "credit", "summary"]` with `[id, "credit/adverse-actions"]`,
   * which join to the same URL but are *different* cache keys — an invalidation
   * written one way never matches a fetch written the other. These are the one
   * canonical form; the migration rewrites both spellings to them.
   */
  credit: {
    root: (id: string) => ["/api/loan-applications", id, "credit"] as const,
    summary: (id: string) => ["/api/loan-applications", id, "credit", "summary"] as const,
    auditLog: (id: string) => ["/api/loan-applications", id, "credit", "audit-log"] as const,
    draft: (id: string) => ["/api/loan-applications", id, "credit", "draft"] as const,
    adverseActions: (id: string) =>
      ["/api/loan-applications", id, "credit", "adverse-actions"] as const,
  },
  /** Fixed-path resource: the borrower's latest in-progress draft. */
  draftLatest: () => ["/api/loan-applications/draft/latest"] as const,
};

/**
 * Sibling key factories for the other high-churn resources (batch 1 of the
 * migration: dashboard, tasks, calculator-results, coach/conversations,
 * onboarding/status). Same rule as above — build keys here, never hand-type the
 * `/api/...` literal at the call site, so fetch and invalidation cannot drift.
 *
 * NOTE: `/api/auth/user` is intentionally absent — it lives behind useAuth,
 * which is the pattern these factories generalise. `/api/applications`
 * (document-checklist / team) is a DIFFERENT endpoint from
 * `/api/loan-applications` and is deferred to a later batch; it is not modelled
 * here so nobody conflates the two.
 */
export const dashboardKeys = {
  root: () => ["/api/dashboard"] as const,
};

export const taskKeys = {
  all: () => ["/api/tasks"] as const,
  detail: (id: string) => ["/api/tasks", id] as const,
};

/**
 * NO READER YET — kept as the canonical key shape, not as live wiring.
 *
 * `POST /api/calculator-results` saves a calculation and `GET
 * /api/calculator-results` serves the list, but no client surface queries that
 * list today. Eight calculators used to invalidate `all()` on save, which
 * matched nothing; those calls are gone (see the note at each save handler).
 * Re-wire them here when a "my saved calculations" view lands.
 */
export const calculatorResultKeys = {
  all: () => ["/api/calculator-results"] as const,
};

export const coachConversationKeys = {
  all: () => ["/api/coach/conversations"] as const,
  detail: (id: string) => ["/api/coach/conversations", id] as const,
};

/**
 * The borrower's file as the assistant reads it — stage, the real document
 * checklist, tasks, readiness. Separate from the conversation keys because it
 * is keyed on the FILE, not on a chat: it must stay correct when the borrower
 * switches conversations, and it must invalidate when a document is uploaded.
 */
export const coachContextKeys = {
  root: () => ["/api/coach/context"] as const,
};

export const onboardingStatusKeys = {
  root: () => ["/api/onboarding/status"] as const,
};

/**
 * The borrower's homeownership goal and the two derived views GapCalculator
 * renders beside it.
 *
 * Segmented so `all()` reaches every one. The page used to invalidate
 * `["/api/homeownership-goal"]` and `["/api/homeownership-goal/gap-analysis"]`
 * by hand after create/update and simply omit the third sibling, so saving a
 * goal refreshed the goal and the gap analysis while the credit
 * recommendations kept advising against the OLD target. Enumerating siblings by
 * hand is the failure mode; one prefix that genuinely covers them is the fix.
 */
export const homeownershipGoalKeys = {
  all: () => ["/api/homeownership-goal"] as const,
  gapAnalysis: () => ["/api/homeownership-goal", "gap-analysis"] as const,
  creditRecommendations: () =>
    ["/api/homeownership-goal", "credit-recommendations"] as const,
};

/**
 * Lease reads.
 *
 * Segmented, so `all()` is a real invalidation prefix: `partialMatchKey` compares
 * element by element, so a single `["/api/leases"]` string would never have matched
 * `["/api/leases/<id>"]` — the same trap documented on `consentKeys` below.
 */
export const leaseKeys = {
  /** Every lease read — the prefix a write should invalidate. */
  all: () => ["/api/leases"] as const,
  detail: (id: string) => ["/api/leases", id] as const,
  /** A lease's rent payments. Segmented, so `all()` covers it as a prefix. */
  payments: (id: string) => ["/api/leases", id, "payments"] as const,
};

/**
 * Consent reads. SEGMENTED under a bare `/api/consents` root on purpose.
 *
 * `partialMatchKey` (query-core) compares queryKey arrays ELEMENT BY ELEMENT —
 * it is not a string-prefix test. So `invalidateQueries({ queryKey:
 * ["/api/consents"] })` matched neither `["/api/consents/me"]` nor
 * `["/api/consents/check", id, type]`: `"/api/consents/me" !== "/api/consents"`.
 * ConsentGateCard fired exactly that key after recording a consent, so every
 * OTHER mounted consent surface (EConsent, TaxReturnInsightCard) kept rendering
 * "not consented" for a borrower who had just consented. The gate itself
 * recovered through its `onConsented()` callback, which is why this survived.
 *
 * Splitting the path into segments leaves the fetched URL identical
 * (`buildQueryUrl` joins with "/") while making `all()` a real invalidation
 * prefix. `/api/consent-templates` is deliberately NOT modelled here: it is a
 * different top-level path, and nesting it would rewrite its URL.
 */
export const consentKeys = {
  /** Every consent read — the prefix a write should invalidate. */
  all: () => ["/api/consents"] as const,
  /** The borrower's own consent records. */
  me: () => ["/api/consents", "me"] as const,
  check: (applicationId: string, consentType: string) =>
    ["/api/consents", "check", applicationId, consentType] as const,
};

/**
 * Task-engine reads. Segmented for the same reason as `consentKeys` — and here
 * the breakage was user-visible rather than latent.
 *
 * Task Operations fired `invalidateQueries({ queryKey: ["/api/task-engine"] })`
 * after escalate / status-update / run-escalation while its four queries were
 * keyed `["/api/task-engine/metrics"]`, `["/api/task-engine/sla-classes"]`,
 * `["/api/task-engine/tasks/by-role", role]` and `["/api/task-engine/my-tasks"]`.
 * Element-wise matching means none of those matched: all three invalidations
 * were dead. `metrics` self-healed on its 30s `refetchInterval`, but the task
 * lists have none, so with `staleTime: 5min` an underwriter changed a task's
 * status and the row kept showing the old one until they hit Refresh or
 * re-focused the tab — which reads as "the change didn't take".
 *
 * Every URL is byte-identical to what the hand-typed keys produced; only the
 * cache addressing changed. `all()` is now a prefix that genuinely reaches all
 * of them, so the existing broad invalidation became correct instead of inert.
 */
export const taskEngineKeys = {
  /** Every task-engine read — the prefix a task write should invalidate. */
  all: () => ["/api/task-engine"] as const,
  metrics: () => ["/api/task-engine", "metrics"] as const,
  slaClasses: () => ["/api/task-engine", "sla-classes"] as const,
  myTasks: () => ["/api/task-engine", "my-tasks"] as const,
  tasksByRole: (role: string) =>
    ["/api/task-engine", "tasks", "by-role", role] as const,
  borrowerTasks: (applicationId: string | undefined) =>
    ["/api/task-engine", "applications", applicationId, "borrower-tasks"] as const,
};

/**
 * Autopilot reads — the borrower's live packaging status and the admin metrics.
 *
 * `status` exists because that entry is fed by an SSE stream, NOT only by a
 * fetch. The stream used to write into a `useState` inside useAutopilotStatus,
 * which put live server state in a parallel store: nothing could invalidate it,
 * two mounts opened two connections, and it had no error state at all. The
 * server closes every stream on a 300s timer and relies on the browser's
 * transparent reconnect (server/routes/autopilot.ts) — but a reconnect that
 * meets a 401 or a 502 FAILS THE CONNECTION PERMANENTLY per the EventSource
 * spec, and with no `onerror` the hook never learned. The banner then rendered
 * a confident, frozen "we're reviewing your file" to a borrower forever.
 *
 * Keeping the status in the cache and having the stream `setQueryData` into it
 * makes the stream one more writer to a normal entry: invalidatable, shared
 * across mounts, and backed by the snapshot endpoint when the stream is down.
 *
 * `metrics` / `metricsTrend` take the window as a params OBJECT, so the key
 * describes the request. They used to be `["/api/autopilot/metrics", rangeDays]`
 * with a queryFn that computed `new Date()` at fetch time — the time window was
 * a request input that did not appear in the key, so one cache entry silently
 * meant different things at different times.
 */
export interface AutopilotMetricsRange {
  from: string;
  to: string;
}

export const autopilotKeys = {
  all: () => ["/api/autopilot"] as const,
  config: () => ["/api/autopilot", "config"] as const,
  status: (applicationId: string) =>
    ["/api/autopilot", "status", applicationId] as const,
  /** Every metrics read (both the summary and the trend) — an invalidation prefix. */
  metricsAll: () => ["/api/autopilot", "metrics"] as const,
  metrics: (range: AutopilotMetricsRange) =>
    ["/api/autopilot", "metrics", range] as const,
  metricsTrend: (range: AutopilotMetricsRange) =>
    ["/api/autopilot", "metrics", "trend", range] as const,
};

/**
 * Borrower-graph reads. `affordability` takes the price as a params object, not
 * a bare scalar: the endpoint is `GET /api/borrower-graph/affordability?price=`
 * (server/routes/borrower/scenariosWaitlist.ts), so the old
 * `["/api/borrower-graph/affordability", price]` key resolved to
 * `/api/borrower-graph/affordability/450000` — a path that does not exist. The
 * key was decorative and the hand-written queryFn was the only thing making the
 * request work.
 */
export const borrowerGraphKeys = {
  all: () => ["/api/borrower-graph"] as const,
  affordability: (price: number | null) =>
    ["/api/borrower-graph/affordability", { price }] as const,
};

/**
 * Prediction reads. `me` takes the application as a params object for the same
 * reason as `borrowerGraphKeys.affordability` — the route is a bare
 * `GET /api/predictions/me` reading `?applicationId=`
 * (server/routes/data-intelligence.ts:235), not `/api/predictions/me/:id`.
 */
export const predictionKeys = {
  all: () => ["/api/predictions"] as const,
  me: (applicationId?: string) =>
    ["/api/predictions/me", { applicationId }] as const,
  benchmark: () => ["/api/predictions/benchmark"] as const,
};

/**
 * Consent TEMPLATES — a different top-level path from `consentKeys`
 * (`/api/consents`), so deliberately its own factory rather than a branch of
 * that one: nesting it would rewrite its URL.
 *
 * One identity for one endpoint. `GET /api/consent-templates?type=` was being
 * read two ways — ConsentGateCard used the params-object form while
 * TaxReturnInsightCard used `["/api/consent-templates", "tax_document_use"]`
 * plus a hand-written queryFn — so the same server data occupied two cache
 * entries, double-fetched, and no single invalidation could reach both.
 */
export const consentTemplateKeys = {
  all: () => ["/api/consent-templates"] as const,
  byType: (consentType: string) =>
    ["/api/consent-templates", { type: consentType }] as const,
};

/**
 * URLA (Uniform Residential Loan Application) reads. A THIRD top-level path
 * alongside `/api/loan-applications` and `/api/applications` — see the note on
 * `applicationResourceKeys` below; all three are keyed by an application id and
 * none of them are each other.
 *
 * Modelled here because the same resource is read by two personas from two
 * files: the borrower's URLAForm and the staff BorrowerFile both fetched
 * `['/api/urla', id]` as a hand-typed literal, and the borrower's save
 * invalidated a third hand-typed copy of it. Three spellings of one identity
 * that happened to agree — `pnpm guard:querykeys` could not have caught them
 * drifting apart, because its template-string rule only sees
 * `` [`/api/urla/${id}`] ``; a hand-typed SEGMENTED key is invisible to it. URLA
 * is the largest data-capture surface in the app, so it is the worst place to
 * leave an identity that only convention holds together.
 *
 * Full taxpayer identifiers are never a browser resource. Delivery services
 * decrypt them only inside the audited MISMO package path, so this key factory
 * can safely represent every client-readable URLA endpoint.
 */
export const urlaKeys = {
  /** Every URLA read — the prefix a URLA write should invalidate. */
  all: () => ["/api/urla"] as const,
  // `string | null | undefined` for the same reason as
  // `applicationResourceKeys`: the borrower's call site holds
  // `activeApplication?.id`, which has not resolved on the first render.
  detail: (applicationId: string | null | undefined) =>
    ["/api/urla", applicationId] as const,
};

/**
 * Document-checklist / deal-team resource. NOTE: `/api/applications` is a
 * DIFFERENT endpoint from `/api/loan-applications` — see the note on
 * `loanApplicationKeys`. Kept separate so nobody conflates the two.
 *
 * `all()` exists because a document upload does not always know which file it
 * landed on: `POST /api/documents/upload` auto-attaches to the borrower's most
 * recent application when `applicationId` is omitted, so the uploader has no id
 * to scope an invalidation with. Invalidating the root reaches every checklist.
 */
export const applicationResourceKeys = {
  all: () => ["/api/applications"] as const,
  // `string | null | undefined`: call sites hold an id that may not have
  // resolved yet (and pair the query with `enabled: !!applicationId`). Widening
  // here beats a `!` at every call site, which would assert away a real state.
  documentChecklist: (applicationId: string | null | undefined) =>
    ["/api/applications", applicationId, "document-checklist"] as const,
  team: (applicationId: string | null | undefined) =>
    ["/api/applications", applicationId, "team"] as const,
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: true,
      staleTime: 5 * 60 * 1000,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
