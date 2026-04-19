/**
 * Unified Douglas-Peucker simplification used by all three callers:
 *   - simplifyLatLng  → GPS coordinates, tolerance in metres
 *   - simplifyCartesian → pixel-space contour rings, tolerance in pixels
 */

export type Point2D = [number, number];

function perpendicularDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const den = Math.hypot(abx, aby);
  if (den === 0) return Math.hypot(px - ax, py - ay);
  return Math.abs(abx * (ay - py) - (ax - px) * aby) / den;
}

function dpRecurse(
  pts: Point2D[],
  start: number,
  end: number,
  tolerance: number,
  keep: Uint8Array,
): void {
  if (end <= start + 1) return;
  const [ax, ay] = pts[start]!;
  const [bx, by] = pts[end]!;
  let maxDist = 0;
  let maxIdx = -1;
  for (let i = start + 1; i < end; i++) {
    const d = perpendicularDistance(pts[i]![0], pts[i]![1], ax, ay, bx, by);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist > tolerance && maxIdx !== -1) {
    keep[maxIdx] = 1;
    dpRecurse(pts, start, maxIdx, tolerance, keep);
    dpRecurse(pts, maxIdx, end, tolerance, keep);
  }
}

/** Douglas-Peucker on any Cartesian coords. Tolerance is in the same units as the coords. */
export function simplifyCartesian(pts: Point2D[], tolerance: number): Point2D[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  dpRecurse(pts, 0, pts.length - 1, tolerance, keep);
  return pts.filter((_, i) => keep[i] === 1);
}

function projectToMeters(origin: Point2D, point: Point2D): Point2D {
  const [lat0, lng0] = origin;
  const [lat, lng] = point;
  const R = 6_371_000;
  const dLat = ((lat - lat0) * Math.PI) / 180;
  const dLng = ((lng - lng0) * Math.PI) / 180;
  const midLat = ((lat0 + lat) * 0.5 * Math.PI) / 180;
  return [dLng * Math.cos(midLat) * R, dLat * R];
}

/** Douglas-Peucker on [lat, lng] coordinates. Tolerance is in metres. */
export function simplifyLatLng(coords: Point2D[], toleranceMeters: number): Point2D[] {
  if (coords.length < 3) return coords.slice();
  const origin = coords[0]!;
  const projected = coords.map((c) => projectToMeters(origin, c));
  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;
  dpRecurse(projected, 0, projected.length - 1, toleranceMeters, keep);
  return coords.filter((_, i) => keep[i] === 1);
}
