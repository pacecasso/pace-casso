/**
 * Simple sliding-window rate limiter for API routes (per client key).
 */

type Bucket = { windowStart: number; count: number };

const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 120;

const buckets = new Map<string, Bucket>();

export function rateLimitAllow(
  clientKey: string,
  maxPerWindow = DEFAULT_MAX_PER_WINDOW,
): boolean {
  const now = Date.now();
  let b = buckets.get(clientKey);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    b = { windowStart: now, count: 0 };
    buckets.set(clientKey, b);
  }
  if (b.count >= maxPerWindow) return false;
  b.count++;
  return true;
}
