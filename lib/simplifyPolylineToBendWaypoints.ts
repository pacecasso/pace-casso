/**
 * Reduce a dense lat/lng polyline (e.g. Mapbox walking geometry) to a small set
 * of vertices at real direction changes, plus occasional anchors on very long
 * straightaways — suitable for map editor handles, not sub-block spam.
 */

export type BendSimplifyOptions = {
  /** Ignore bearing noise below this (degrees). */
  minTurnDeg?: number;
  /** Force a handle at least this often on a straight (meters). */
  maxStraightRunM?: number;
  /** Drop corners closer than this to the previous kept point (meters). */
  minCornerSeparationM?: number;
};

import { haversineMeters } from "./haversine";

function initialBearingDeg(a: [number, number], b: [number, number]): number {
  const φ1 = (a[0] * Math.PI) / 180;
  const φ2 = (b[0] * Math.PI) / 180;
  const Δλ = ((b[1] - a[1]) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return (((θ * 180) / Math.PI) + 360) % 360;
}

function smallestAngleBetweenBearingsDeg(b1: number, b2: number): number {
  let d = Math.abs(b1 - b2) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

const LOOP_CLOSE_M = 42;

/**
 * Returns vertices taken from `line` (subset of indices), in order.
 */
export function simplifyPolylineToBendWaypoints(
  line: [number, number][],
  options: BendSimplifyOptions = {},
): [number, number][] {
  const minTurnDeg = options.minTurnDeg ?? 26;
  const maxStraightRunM = options.maxStraightRunM ?? 300;
  const minCornerSeparationM = options.minCornerSeparationM ?? 16;

  if (line.length < 2) return line.slice() as [number, number][];

  const closed =
    line.length >= 4 &&
    haversineMeters(line[0]!, line[line.length - 1]!) < LOOP_CLOSE_M;

  const work = closed ? line.slice(0, -1) : line.slice();
  if (work.length < 2) return line.slice() as [number, number][];

  const prefix: number[] = [0];
  for (let i = 1; i < work.length; i++) {
    prefix[i] = prefix[i - 1]! + haversineMeters(work[i - 1]!, work[i]!);
  }

  const kept: number[] = [0];
  let lastK = 0;

  for (let i = 1; i < work.length - 1; i++) {
    const a = work[i - 1]!;
    const b = work[i]!;
    const c = work[i + 1]!;
    const bearIn = initialBearingDeg(a, b);
    const bearOut = initialBearingDeg(b, c);
    const turn = smallestAngleBetweenBearingsDeg(bearIn, bearOut);
    const run = prefix[i]! - prefix[lastK]!;
    const sep = haversineMeters(work[lastK]!, b);
    const longStraight = run >= maxStraightRunM;
    const sharpTurn = turn >= minTurnDeg;
    if (!sharpTurn && !longStraight) continue;
    if (
      sharpTurn &&
      !longStraight &&
      sep < minCornerSeparationM &&
      kept.length > 0
    ) {
      continue;
    }
    kept.push(i);
    lastK = i;
  }

  const lastIdx = work.length - 1;
  if (kept[kept.length - 1] !== lastIdx) {
    if (
      kept.length === 0 ||
      haversineMeters(work[kept[kept.length - 1]!]!, work[lastIdx]!) >= 6
    ) {
      kept.push(lastIdx);
    } else {
      kept[kept.length - 1] = lastIdx;
    }
  }

  let out = kept.map((i) => [work[i]![0], work[i]![1]] as [number, number]);

  if (closed && out.length >= 2) {
    const f = out[0]!;
    const l = out[out.length - 1]!;
    if (haversineMeters(f, l) > 8) {
      out = [...out, [f[0], f[1]] as [number, number]];
    }
  }

  return out.length >= 2 ? out : (line.slice() as [number, number][]);
}
