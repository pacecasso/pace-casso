/**
 * Shared protection for API routes that spend money (Anthropic vision,
 * Mapbox proxies).
 *
 * Serverless reality check: the sliding-window limiter in mapboxRateLimit
 * lives in per-instance memory, and raw `x-forwarded-for` is client-
 * spoofable, so on Vercel neither was a real barrier. This module adds the
 * two protections that DO hold up without external storage:
 *
 * 1. Same-origin gate — browser fetch() always carries an Origin or
 *    Referer; both must match the request's own Host. Zero-config (no env
 *    var), blocks drive-by scripts and hot-linking. A determined attacker
 *    can forge the header, which is why (2) exists.
 * 2. Per-instance daily budget — a hard ceiling on how many times an
 *    expensive route can run per process per UTC day. Even if every other
 *    control is bypassed, spend is bounded.
 *
 * Plus a trusted client-IP reader: prefers x-real-ip (set by Vercel's
 * proxy and not client-controllable there) over x-forwarded-for.
 */

const dayBudgets = new Map<string, { day: string; count: number }>();

/** Client IP for rate-limit keying. On Vercel, x-real-ip is proxy-set. */
export function trustedClientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || "unknown";
  return "unknown";
}

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host || null;
  } catch {
    return null;
  }
}

/**
 * True when the request plausibly comes from our own frontend: its Origin
 * (or, failing that, Referer) host matches the Host header the request was
 * served on. Requests with neither header (curl, server scripts) are
 * rejected — every browser fetch() from the app carries at least one.
 */
export function sameOriginAllowed(req: Request): boolean {
  const host = req.headers.get("host")?.trim().toLowerCase();
  if (!host) return false;
  const originHost = hostOf(req.headers.get("origin"));
  if (originHost) return originHost.toLowerCase() === host;
  const refererHost = hostOf(req.headers.get("referer"));
  if (refererHost) return refererHost.toLowerCase() === host;
  return false;
}

/**
 * Per-instance daily ceiling for an expensive route. Not shared across
 * serverless instances — treat the cap as "per instance per day", i.e. a
 * spend bound, not an exact quota.
 */
export function dailyBudgetAllow(routeName: string, maxPerDay: number): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const bucket = dayBudgets.get(routeName);
  if (!bucket || bucket.day !== day) {
    dayBudgets.set(routeName, { day, count: 1 });
    return true;
  }
  if (bucket.count >= maxPerDay) return false;
  bucket.count++;
  return true;
}

export type ShieldVerdict =
  | { ok: true }
  | { ok: false; status: number; message: string };

/** Combined gate for Anthropic-backed routes. */
export function shieldExpensiveRoute(
  req: Request,
  routeName: string,
  maxPerDay: number,
): ShieldVerdict {
  if (!sameOriginAllowed(req)) {
    return {
      ok: false,
      status: 403,
      message: "This endpoint only serves the PaceCasso app.",
    };
  }
  if (!dailyBudgetAllow(routeName, maxPerDay)) {
    return {
      ok: false,
      status: 429,
      message: "Daily AI budget reached for this endpoint — try again tomorrow.",
    };
  }
  return { ok: true };
}
