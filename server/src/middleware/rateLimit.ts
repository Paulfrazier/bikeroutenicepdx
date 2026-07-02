/**
 * Best-effort, in-memory per-IP rate limiting.
 *
 * State is per-process: it is NOT shared across Railway instances and resets on
 * deploy/restart. That is a deliberate trade-off — the app has no database
 * (Railway's filesystem is ephemeral), and this is abuse-resistance (protecting
 * the upstream routing/geocoding engines and third-party ToS), not a hard quota.
 *
 * Generalized from the inline limiter that POST /fix-submit used; both now share
 * the same `clientIp` derivation and the same `429 { code: "rate_limited" }`
 * response shape.
 */

import type { Context, MiddlewareHandler } from "hono";

/**
 * Trusted client IP.
 *
 * Railway (like most managed proxies) appends the real client IP as the LAST
 * entry of `X-Forwarded-For`; any earlier entries are client-supplied and must
 * not be trusted — reading the left-most value lets an attacker rotate a fake
 * IP per request and bypass the limit entirely. We therefore take the right-most
 * hop. Falls back to "local" when the header is absent (direct/dev access).
 */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "local";
}

/**
 * Sliding-window check against a caller-owned store. Returns true when the key
 * is within budget; false when the limit is exceeded. Timestamps older than the
 * window are pruned on every call (lazy cleanup).
 */
export function withinBudget(
  store: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number,
  now: number
): boolean {
  const prev = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (prev.length >= limit) {
    store.set(key, prev); // keep the pruned list, don't record this hit
    return false;
  }
  store.set(key, [...prev, now]);
  return true;
}

export interface RateLimitOptions {
  /** Max requests allowed per IP within the window. */
  limit: number;
  /** Sliding-window length in milliseconds. */
  windowMs: number;
}

/**
 * Per-IP sliding-window rate-limit middleware. Each `rateLimit(...)` call owns
 * its own store, so different routes get independent budgets.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const store = new Map<string, number[]>();
  return async (c, next) => {
    const ok = withinBudget(
      store,
      clientIp(c),
      options.limit,
      options.windowMs,
      Date.now()
    );
    if (!ok) {
      return c.json(
        { error: "too many requests, slow down", code: "rate_limited" },
        429
      );
    }
    await next();
  };
}
