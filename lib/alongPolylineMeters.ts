/**
 * Cumulative distance (m) along an open polyline to the closest point to p [lat,lng].
 */

import { haversineMeters } from "./haversine";

function projectScalarOnSegment(
  a: [number, number],
  b: [number, number],
  p: [number, number],
): number {
  const ax = a[1];
  const ay = a[0];
  const bx = b[1];
  const by = b[0];
  const px = p[1];
  const py = p[0];
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const denom = abx * abx + aby * aby;
  if (denom < 1e-18) return 0;
  const t = (apx * abx + apy * aby) / denom;
  return Math.max(0, Math.min(1, t));
}

/** Segments shorter than this (metres) are skipped to avoid NaN from 0/0. */
const MIN_SEG_M = 1e-4;

export function distanceAlongPolylineToPoint(
  line: [number, number][],
  p: [number, number],
): number {
  if (line.length < 2) return 0;
  let bestAlong = 0;
  let bestDist = Infinity;
  let cumulative = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const segLen = haversineMeters(a, b);
    if (segLen < MIN_SEG_M) {
      // Identical or near-identical points: treat the segment as a single
      // point candidate and advance cumulative distance without dividing.
      const d = haversineMeters(p, a);
      if (d < bestDist) {
        bestDist = d;
        bestAlong = cumulative;
      }
      cumulative += segLen;
      continue;
    }
    const t = projectScalarOnSegment(a, b, p);
    const cx = a[0] + t * (b[0] - a[0]);
    const cy = a[1] + t * (b[1] - a[1]);
    const d = haversineMeters(p, [cx, cy]);
    if (d < bestDist) {
      bestDist = d;
      bestAlong = cumulative + t * segLen;
    }
    cumulative += segLen;
  }
  return bestAlong;
}
