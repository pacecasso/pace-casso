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
 * Reserved for callers (`snapWalkingRoute`, auto-find) so options stay aligned if we
 * ever add source-specific rules again. **Currently unused:** mid-sized photo traces
 * (≤56 verts) must stay unsimplified so Mapbox keeps silhouette corners for gestalt.
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

export function simplifyAnchorPathForSnap(
  coords: [number, number][],
  _opts?: { sourceKind?: AnchorPathSource },
): [number, number][] {
  if (coords.length < 2) return coords;

  if (coords.length <= SPARSE_VERTEX_CAP) {
    return coords;
  }

  let pts = dedupeByMinSpacing(coords, 2.5);

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

  const n = work.length;
  // Tolerances in metres (previously degree-based: 0.00014°–0.00042° ≈ 15–47 m).
  // Bumped ~30 % more aggressive to smooth anchor paths.
  const toleranceM =
    n > 100 ? 60 : n > 50 ? 45 : n > 20 ? 30 : 20;
  const tol = closed ? toleranceM * 0.42 : toleranceM;

  const out = dpSimplifyLatLng(work, closed, tol);

  return out.length >= 2 ? out : pts;
}
