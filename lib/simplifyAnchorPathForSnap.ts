import { simplifyLatLng } from "./douglasPeucker";
import { haversineMeters } from "./haversine";

/** Drop consecutive vertices closer than minM (noise from touch / dense sampling). */
function dedupeByMinSpacing(
  coords: [number, number][],
  minM: number,
): [number, number][] {
  if (coords.length < 2) return coords;
  const out: [number, number][] = [coords[0]!];
  for (let i = 1; i < coords.length; i++) {
    const p = coords[i]!;
    if (haversineMeters(out[out.length - 1]!, p) >= minM) out.push(p);
  }
  const last = coords[coords.length - 1]!;
  if (out.length >= 2 && haversineMeters(out[out.length - 1]!, last) > 0.5) {
    out.push(last);
  }
  return out.length >= 2 ? out : coords;
}

const CLOSED_LOOP_END_M = 45;

/**
 * Fewer Mapbox waypoints on straight segments → walking routes follow main streets
 * instead of zig-zagging to hit every pixel. Corners are kept via Douglas–Peucker.
 *
 * Closed freehand loops (first ≈ last) are simplified as an **open** ring (drop duplicate
 * closing vertex) and use a **tighter** tolerance so the box does not collapse to one edge.
 */
/** Above this, treat as dense (e.g. freehand) and run DP; stick letters stay ≤ ~25 verts. */
const SPARSE_VERTEX_CAP = 56;

/**
 * - `image` traces (photo silhouettes) use adaptive, perimeter-aware tolerance
 *   so fins / tails / fine curves survive to Mapbox. The older fixed-meters DP
 *   (25 m closed) crushed a 1.5 km fish into a pentagon.
 * - `freehand` / `default` keep the stricter tolerance so noisy touch input
 *   doesn't zig-zag across adjacent streets.
 */
export type AnchorPathSource = "default" | "image" | "freehand";

function dpSimplifyLatLng(
  work: [number, number][],
  closed: boolean,
  toleranceMeters: number,
): [number, number][] {
  if (work.length < 2) return work;
  let out = simplifyLatLng(work, toleranceMeters) as [number, number][];
  if (closed && out.length >= 2) {
    const f = out[0]!;
    const l = out[out.length - 1]!;
    if (haversineMeters(f, l) > 18) out = [...out, f];
  }
  return out.length >= 2 ? out : work;
}

/** Rough perimeter in metres (closes the ring if `closed`). */
function perimeterM(pts: [number, number][], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += haversineMeters(pts[i - 1]!, pts[i]!);
  }
  if (closed && pts.length >= 2) {
    total += haversineMeters(pts[pts.length - 1]!, pts[0]!);
  }
  return total;
}

/** Keep every N-th point until count ≤ cap, preserving first + last. */
function decimateToCap(pts: [number, number][], cap: number): [number, number][] {
  if (pts.length <= cap) return pts;
  const stride = Math.ceil(pts.length / cap);
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i += stride) out.push(pts[i]!);
  const last = pts[pts.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Image-source: preserve silhouette detail. Use tolerance ≈ 0.5 % of perimeter
 * (bounded 5–14 m), then cap at 100 points so Mapbox-chunking doesn't balloon.
 *
 * Example: a 1.6 km fish perimeter → ~8 m tolerance → gill/fin notches survive.
 * A 4 km dragon perimeter → 14 m tolerance (capped) → still keeps major curves.
 */
function simplifyImageAnchors(
  work: [number, number][],
  closed: boolean,
): [number, number][] {
  const peri = perimeterM(work, closed);
  const adaptive = peri * 0.005;
  const tolM = Math.min(14, Math.max(5, adaptive));
  const out = dpSimplifyLatLng(work, closed, tolM);
  return decimateToCap(out, 100);
}

export function simplifyAnchorPathForSnap(
  coords: [number, number][],
  opts?: { sourceKind?: AnchorPathSource },
): [number, number][] {
  if (coords.length < 2) return coords;

  if (coords.length <= SPARSE_VERTEX_CAP) {
    return coords;
  }

  const sourceKind = opts?.sourceKind ?? "default";

  // Image sources use a small dedupe (5 m vs 2.5 m) to kill pixel-staircase
  // jitter from the Moore boundary trace, but leave enough density for DP to
  // keep the fins, tail, and gill curves that define a recognisable shape.
  const minSpacingM = sourceKind === "image" ? 5 : 2.5;
  let pts = dedupeByMinSpacing(coords, minSpacingM);

  if (pts.length < 2) pts = coords;

  const closed =
    pts.length >= 4 &&
    haversineMeters(pts[0]!, pts[pts.length - 1]!) < CLOSED_LOOP_END_M;

  let work = pts;
  if (closed && pts.length >= 3) {
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    if (haversineMeters(a, b) < CLOSED_LOOP_END_M) {
      work = pts.slice(0, -1);
    }
  }

  if (work.length < 2) return pts;
  if (work.length <= 6) return pts;

  if (sourceKind === "image") {
    const out = simplifyImageAnchors(work, closed);
    return out.length >= 2 ? out : pts;
  }

  const n = work.length;
  // Tolerances in metres (previously degree-based: 0.00014°–0.00042° ≈ 15–47 m).
  // Bumped ~30 % more aggressive to smooth anchor paths.
  const toleranceM =
    n > 100 ? 60 : n > 50 ? 45 : n > 20 ? 30 : 20;
  const tol = closed ? toleranceM * 0.42 : toleranceM;

  const out = dpSimplifyLatLng(work, closed, tol);

  return out.length >= 2 ? out : pts;
}
