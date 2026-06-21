/**
 * Per-browser memory of the user's recently finalized routes.
 *
 * Captured when a user completes the workflow; read by auto-find's vision
 * ranker so that future placements can be biased toward the kind of layouts
 * this user actually keeps. Not personalisation in the ML sense — more like
 * a few-shot "here's what this user liked before, lean that way when
 * quality is close."
 */

const STORAGE_KEY = "pacecasso-finalized-routes-v1";
const MAX_ENTRIES = 5;

export type FinalizedRouteMemory = {
  center: [number, number];
  rotationDeg: number;
  scale: number;
  distanceKm: number;
  /** ISO timestamp of when this entry was saved. */
  savedAt: string;
};

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidCenter(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    isFiniteNum(v[0]) &&
    v[0] >= -90 &&
    v[0] <= 90 &&
    isFiniteNum(v[1]) &&
    v[1] >= -180 &&
    v[1] <= 180
  );
}

function isValidEntry(v: unknown): v is FinalizedRouteMemory {
  if (!v || typeof v !== "object") return false;
  const r = v as Partial<FinalizedRouteMemory>;
  if (!isValidCenter(r.center)) return false;
  if (!isFiniteNum(r.rotationDeg)) return false;
  if (!isFiniteNum(r.scale) || r.scale <= 0) return false;
  if (!isFiniteNum(r.distanceKm) || r.distanceKm <= 0) return false;
  if (typeof r.savedAt !== "string" || !Number.isFinite(Date.parse(r.savedAt))) {
    return false;
  }
  return true;
}

export function loadFinalizedRoutes(): FinalizedRouteMemory[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

export function saveFinalizedRoute(
  entry: Omit<FinalizedRouteMemory, "savedAt">,
): void {
  if (typeof window === "undefined") return;
  try {
    const next: FinalizedRouteMemory = {
      ...entry,
      savedAt: new Date().toISOString(),
    };
    if (!isValidEntry(next)) return;
    // Dedupe near-identical repeats (same center + scale within small tolerance)
    // so a user who clicks finalize multiple times doesn't fill memory with
    // the same placement.
    const existing = loadFinalizedRoutes().filter((r) => {
      const dLat = Math.abs(r.center[0] - next.center[0]);
      const dLng = Math.abs(r.center[1] - next.center[1]);
      const dScale = Math.abs(r.scale - next.scale);
      return !(dLat < 0.002 && dLng < 0.002 && dScale < 0.1);
    });
    const combined = [next, ...existing].slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(combined));
  } catch {
    /* localStorage full or private mode — silent */
  }
}

export function clearFinalizedRoutes(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
