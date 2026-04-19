/**
 * Simple sliding-window rate limiter for API routes (per client key).
 *
 * Each bucket is pruned after EVICT_AFTER_MS of inactivity so the Map
 * does not grow without bound across long-running server processes.
 * Pruning runs every PRUNE_INTERVAL calls (not every call) to keep the
 * hot-path O(1).
 */

type Bucket = { windowStart: number; count: number; lastSeen: number };

const WINDOW_MS = 60_000;
const DEFAULT_MAX_PER_WINDOW = 120;
/** Drop a bucket that hasn't been seen for 4 full windows. */
const EVICT_AFTER_MS = WINDOW_MS * 4;
/** Sweep for stale buckets every N calls. */
const PRUNE_INTERVAL = 50;

const buckets = new Map<string, Bucket>();
let callsSincePrune = 0;

function pruneStale(now: number): void {
  for (const [key, b] of buckets) {
    if (now - b.lastSeen > EVICT_AFTER_MS) buckets.delete(key);
  }
}

export function rateLimitAllow(
  clientKey: string,
  maxPerWindow = DEFAULT_MAX_PER_WINDOW,
): boolean {
  const now = Date.now();

  if (++callsSincePrune >= PRUNE_INTERVAL) {
    callsSincePrune = 0;
    pruneStale(now);
  }

  let b = buckets.get(clientKey);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    b = { windowStart: now, count: 0, lastSeen: now };
    buckets.set(clientKey, b);
  }
  b.lastSeen = now;
  if (b.count >= maxPerWindow) return false;
  b.count++;
  return true;
}
