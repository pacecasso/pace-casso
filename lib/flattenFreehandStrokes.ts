/**
 * Join freehand strokes into one polyline for snapping. When the user lifts the
 * pen at a corner and starts the next stroke at ~the same corner, we must not
 * insert a short chord from stroke1’s last point to stroke2’s first point —
 * that creates bogus triangles at T-junctions.
 */

import { haversineMeters } from "./haversine";

/** Below this, treat the next stroke as continuing the same path (skip its first vertex). */
const STROKE_JOIN_GAP_M = 22;

const DUPLICATE_VERTEX_M = 2.5;

export function flattenStrokesForSnap(
  strokes: [number, number][][],
): [number, number][] {
  const out: [number, number][] = [];
  for (const s of strokes) {
    if (s.length < 2) continue;
    if (out.length === 0) {
      out.push(...s);
      continue;
    }
    const prevEnd = out[out.length - 1]!;
    const nextStart = s[0]!;
    const gap = haversineMeters(prevEnd, nextStart);

    if (gap <= STROKE_JOIN_GAP_M) {
      if (s.length <= 1) continue;
      for (let k = 1; k < s.length; k++) {
        const p = s[k]!;
        if (
          out.length > 0 &&
          haversineMeters(out[out.length - 1]!, p) < DUPLICATE_VERTEX_M
        ) {
          continue;
        }
        out.push(p);
      }
    } else {
      for (const p of s) {
        if (
          out.length > 0 &&
          haversineMeters(out[out.length - 1]!, p) < DUPLICATE_VERTEX_M
        ) {
          continue;
        }
        out.push(p);
      }
    }
  }
  return out;
}
