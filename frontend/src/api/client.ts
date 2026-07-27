/**
 * API client. Three jobs beyond fetch():
 *
 * 1. Access token lives in module memory only — never localStorage.
 * 2. Refresh is SINGLE-FLIGHT at module level: concurrent 401s, StrictMode
 *    double-mounts and parallel tabs (via Web Locks) produce one refresh.
 * 3. Requests slower than 3s flip a "waking the server up" signal — Render's
 *    free tier cold-starts in ~50s and a dead spinner reads as broken.
 */

export const API_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export interface UserPrivate {
  id: string;
  email: string;
  username: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  username_changed_at: string | null;
  created_at: string;
}

export interface TokenOut {
  access_token: string;
  token_type: string;
  user: UserPrivate;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

export const NETWORK_ERROR_MESSAGE =
  "Can't reach the server. Check your connection and try that again.";

interface ValidationIssue {
  type?: string;
  loc?: Array<string | number>;
  msg?: string;
  ctx?: { min_length?: number; max_length?: number };
}

const FIELD_LABELS: Record<string, string> = {
  email: "email",
  username: "username",
  password: "password",
  new_password: "new password",
  current_password: "current password",
  title: "title",
  link: "link",
  note: "note",
  price: "price",
};

/** Raw Pydantic messages read like a stack trace. Turn the common ones into
 * copy that says what broke and what to do about it. */
function humanizeIssue(issue: ValidationIssue): string | null {
  const field = [...(issue.loc ?? [])].reverse().find((part): part is string => typeof part === "string");
  const label = field ? (FIELD_LABELS[field] ?? field.replace(/_/g, " ")) : null;
  const msg = issue.msg ?? "";

  if (msg.toLowerCase().includes("email address")) {
    return "That doesn't look like an email address. Check it and try again.";
  }
  switch (issue.type) {
    case "missing":
      return label ? `Fill in the ${label} field.` : "A required field is missing.";
    case "string_too_short": {
      const min = issue.ctx?.min_length;
      if (field === "password" || field === "new_password") {
        return `Password needs at least ${min ?? 8} characters.`;
      }
      return label && min ? `The ${label} needs at least ${min} characters.` : null;
    }
    case "string_too_long": {
      const max = issue.ctx?.max_length;
      return label && max ? `The ${label} is limited to ${max} characters.` : null;
    }
    default:
      return null;
  }
}

/** Pydantic 422s send {detail: [{msg, ...}]}; everything else {detail: str}. */
export function errorDetail(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail.length > 0) {
      const first = detail[0] as ValidationIssue;
      const humanized = humanizeIssue(first);
      if (humanized) return humanized;
      if (typeof first.msg === "string" && first.msg.length > 0) {
        // custom validators already write human copy; strip the prefix
        return first.msg.replace(/^Value error, /, "");
      }
    }
  }
  return fallback;
}

// ---------------------------------------------------------------- token

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

// Dev-only hook so a browser session can simulate token expiry mid-flow
// (e.g. inject an expired JWT and watch the silent refresh+retry).
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__optataSetAccessToken = setAccessToken;
}

// ------------------------------------------------- session-expired signal

let sessionExpiredHandler: (() => void) | null = null;

/** AuthContext registers here; a failed refresh-retry cycle hard-logs-out. */
export function onSessionExpired(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

function hardLogout(): void {
  accessToken = null;
  sessionExpiredHandler?.();
}

// ------------------------------------------------------- slow requests

const SLOW_REQUEST_MS = 3000;
const slowListeners = new Set<(slow: boolean) => void>();
let slowRequestCount = 0;

export function subscribeSlowRequests(listener: (slow: boolean) => void): () => void {
  slowListeners.add(listener);
  listener(slowRequestCount > 0);
  return () => {
    slowListeners.delete(listener);
  };
}

function emitSlow(slow: boolean): void {
  for (const listener of slowListeners) listener(slow);
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  let countedAsSlow = false;
  const timer = setTimeout(() => {
    countedAsSlow = true;
    slowRequestCount += 1;
    if (slowRequestCount === 1) emitSlow(true);
  }, SLOW_REQUEST_MS);
  try {
    return await fetch(url, init);
  } finally {
    clearTimeout(timer);
    if (countedAsSlow) {
      slowRequestCount -= 1;
      if (slowRequestCount === 0) emitSlow(false);
    }
  }
}

// ------------------------------------------------------------- requests

function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (accessToken !== null) headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return timedFetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: "include", // refresh token cookie
  });
}

// -------------------------------------------------------------- refresh

let refreshInFlight: Promise<TokenOut | null> | null = null;
let bootstrapPromise: Promise<TokenOut | null> | null = null;

async function doRefresh(): Promise<TokenOut | null> {
  const execute = async (): Promise<TokenOut | null> => {
    const response = await rawRequest("/auth/refresh", { method: "POST" });
    // A 401 here means "guest". This function is the BOTTOM of the auth
    // stack — it must never trigger another refresh, or 401 → refresh →
    // 401 → refresh loops forever.
    if (!response.ok) {
      accessToken = null;
      return null;
    }
    const data = (await response.json()) as TokenOut;
    accessToken = data.access_token;
    return data;
  };

  // Cross-tab politeness: with the lock held, the second tab's refresh runs
  // after the first finished and carries the already-rotated cookie — no
  // reuse race at all. Falls back gracefully where Web Locks is missing.
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return navigator.locks.request("wishlist-auth-refresh", execute);
  }
  return execute();
}

/** Single-flight: concurrent callers share one promise, one network call. */
export function refreshSession(): Promise<TokenOut | null> {
  if (refreshInFlight === null) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/**
 * The app-mount refresh. Module-level and NEVER cleared: StrictMode's double
 * effect invocation and any remount reuse the same promise, so exactly one
 * network call happens per page load.
 */
export function bootstrapSession(): Promise<TokenOut | null> {
  if (bootstrapPromise === null) {
    bootstrapPromise = refreshSession();
  }
  return bootstrapPromise;
}

// ------------------------------------------------------------------ api

/**
 * fetch with auth. On 401 it reads the RFC 6750 challenge:
 * error="invalid_token" → the token was presented but is stale → refresh
 * once and retry once. A plain Bearer challenge means no usable session —
 * refreshing cannot help, the caller sees the 401.
 */
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await rawRequest(path, init);
  if (response.status !== 401) return response;

  const challenge = response.headers.get("WWW-Authenticate") ?? "";
  if (!challenge.includes('error="invalid_token"')) return response;

  const refreshed = await refreshSession();
  if (refreshed === null) {
    hardLogout();
    return response;
  }
  const retry = await rawRequest(path, init);
  if (retry.status === 401) hardLogout(); // one refresh, one retry, then out
  return retry;
}

/** api() + JSON body + typed result; throws ApiError with a usable message. */
export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await api(path, init);
  } catch {
    throw new ApiError(0, NETWORK_ERROR_MESSAGE);
  }
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // non-JSON error body — fall through to the fallback message
    }
    throw new ApiError(
      response.status,
      errorDetail(body, "The server choked on that one. Try again."),
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
