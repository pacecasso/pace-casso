/**
 * Tap-to-route state, modelled on onthegomap.com: the route is a list of
 * tapped points plus one mode per leg ("streets" = walking directions,
 * "straight" = a ruler line). Leg geometry is NOT part of the state — it is
 * looked up in a cache keyed by (from, to, mode), so undo/redo snapshots are
 * tiny, and a routing fetch that resolves after an undo can never clobber
 * the newer state (it only fills the cache).
 *
 * Pure; the component owns fetching. Distance helpers here are shared with
 * the Step 4 route editor (km/mi markers, hover distance).
 */

import { haversineMeters } from "./haversine";

export type LatLng = [number, number];
export type LegMode = "streets" | "straight";

export type TapRouteState = {
  points: LatLng[];
  /** modes[i] is the leg from points[i] to points[i + 1]. */
  modes: LegMode[];
};

export const EMPTY_TAP_ROUTE: TapRouteState = { points: [], modes: [] };

/** Cache entry for one routed leg; `fallback` = routing failed, drawn straight. */
export type LegGeometry = { coords: LatLng[]; fallback: boolean };

function k6(p: LatLng): string {
  return `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
}

export function legKey(a: LatLng, b: LatLng, mode: LegMode): string {
  return `${mode}|${k6(a)}|${k6(b)}`;
}

export function legCount(s: TapRouteState): number {
  return Math.max(0, s.points.length - 1);
}

export function addPoint(
  s: TapRouteState,
  p: LatLng,
  mode: LegMode,
): TapRouteState {
  if (!s.points.length) return { points: [p], modes: [] };
  const last = s.points[s.points.length - 1]!;
  if (haversineMeters(last, p) < 1) return s;
  return { points: [...s.points, p], modes: [...s.modes, mode] };
}

export function removeLastPoint(s: TapRouteState): TapRouteState {
  if (!s.points.length) return s;
  return { points: s.points.slice(0, -1), modes: s.modes.slice(0, -1) };
}

/**
 * Remove a point. A middle point's two legs become one leg between its
 * neighbours; it keeps the incoming leg's mode, so a ruler section stays a
 * ruler section.
 */
export function removePoint(s: TapRouteState, i: number): TapRouteState {
  const n = s.points.length;
  if (i < 0 || i >= n) return s;
  if (i === n - 1) return removeLastPoint(s);
  if (i === 0) return { points: s.points.slice(1), modes: s.modes.slice(1) };
  const modes = s.modes.slice();
  modes.splice(i, 1);
  return { points: s.points.filter((_, j) => j !== i), modes };
}

export function movePoint(s: TapRouteState, i: number, p: LatLng): TapRouteState {
  if (i < 0 || i >= s.points.length) return s;
  const points = s.points.slice();
  points[i] = p;
  return { points, modes: s.modes };
}

/** Insert a point inside leg `legIndex`; both halves inherit that leg's mode. */
export function insertPoint(
  s: TapRouteState,
  legIndex: number,
  p: LatLng,
): TapRouteState {
  if (legIndex < 0 || legIndex >= legCount(s)) return s;
  const mode = s.modes[legIndex]!;
  const points = s.points.slice();
  points.splice(legIndex + 1, 0, p);
  const modes = s.modes.slice();
  modes.splice(legIndex, 0, mode);
  return { points, modes };
}

export function setLegMode(
  s: TapRouteState,
  legIndex: number,
  mode: LegMode,
): TapRouteState {
  if (legIndex < 0 || legIndex >= legCount(s)) return s;
  if (s.modes[legIndex] === mode) return s;
  const modes = s.modes.slice();
  modes[legIndex] = mode;
  return { points: s.points, modes };
}

export function reverseRoute(s: TapRouteState): TapRouteState {
  return { points: s.points.slice().reverse(), modes: s.modes.slice().reverse() };
}

/** Run back the way you came: append the route mirrored (onthegomap "out & back"). */
export function outAndBack(s: TapRouteState): TapRouteState {
  if (s.points.length < 2) return s;
  const back = s.points.slice(0, -1).reverse();
  return {
    points: [...s.points, ...back],
    modes: [...s.modes, ...s.modes.slice().reverse()],
  };
}

/** Route back to the start point to close the loop. */
export function closeLoop(s: TapRouteState, mode: LegMode): TapRouteState {
  if (s.points.length < 2) return s;
  const first = s.points[0]!;
  const last = s.points[s.points.length - 1]!;
  if (haversineMeters(first, last) < 1) return s;
  return { points: [...s.points, first], modes: [...s.modes, mode] };
}

export function isClosedLoop(s: TapRouteState): boolean {
  if (s.points.length < 3) return false;
  return haversineMeters(s.points[0]!, s.points[s.points.length - 1]!) < 1;
}

/** Densified straight leg, so ruler legs still have points to hover / split. */
export function straightLeg(a: LatLng, b: LatLng): LatLng[] {
  const steps = Math.max(1, Math.min(40, Math.ceil(haversineMeters(a, b) / 50)));
  const out: LatLng[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
  }
  return out;
}

export type AssembledLeg = {
  coords: LatLng[];
  mode: LegMode;
  /** Still routing — drawn as a faint straight placeholder. */
  pending: boolean;
  /** Routing failed; drawn straight and flagged. */
  fallback: boolean;
};

/**
 * Resolve every leg from the cache. Straight legs never need a fetch;
 * street legs missing from the cache come back `pending` with a placeholder
 * so the line stays connected while they route.
 */
export function assembleLegs(
  s: TapRouteState,
  cache: ReadonlyMap<string, LegGeometry>,
): AssembledLeg[] {
  const legs: AssembledLeg[] = [];
  for (let i = 0; i < legCount(s); i++) {
    const a = s.points[i]!;
    const b = s.points[i + 1]!;
    const mode = s.modes[i] ?? "streets";
    if (mode === "straight") {
      legs.push({ coords: straightLeg(a, b), mode, pending: false, fallback: false });
      continue;
    }
    const hit = cache.get(legKey(a, b, mode));
    if (hit && hit.coords.length >= 2) {
      // Pin the ends to the tapped points so the line meets every handle.
      const coords = hit.coords.slice();
      coords[0] = a;
      coords[coords.length - 1] = b;
      legs.push({ coords, mode, pending: false, fallback: hit.fallback });
    } else {
      legs.push({ coords: straightLeg(a, b), mode, pending: true, fallback: false });
    }
  }
  return legs;
}

/** Street legs that still need a fetch (deduped by cache key). */
export function missingStreetLegs(
  s: TapRouteState,
  cache: ReadonlyMap<string, LegGeometry>,
): { key: string; from: LatLng; to: LatLng }[] {
  const out: { key: string; from: LatLng; to: LatLng }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < legCount(s); i++) {
    if (s.modes[i] !== "streets") continue;
    const a = s.points[i]!;
    const b = s.points[i + 1]!;
    const key = legKey(a, b, "streets");
    if (cache.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, from: a, to: b });
  }
  return out;
}

/** Concatenate legs into one line, dropping duplicated joints. */
export function joinLegs(legs: { coords: LatLng[] }[]): LatLng[] {
  const out: LatLng[] = [];
  for (const leg of legs) {
    for (const p of leg.coords) {
      const last = out[out.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      out.push(p);
    }
  }
  return out;
}

export function lineLengthMeters(line: LatLng[]): number {
  let m = 0;
  for (let i = 1; i < line.length; i++) m += haversineMeters(line[i - 1]!, line[i]!);
  return m;
}

/** Cumulative metres at each vertex. */
export function cumulativeMeters(line: LatLng[]): number[] {
  const out: number[] = new Array(line.length).fill(0);
  for (let i = 1; i < line.length; i++) {
    out[i] = out[i - 1]! + haversineMeters(line[i - 1]!, line[i]!);
  }
  return out;
}

/**
 * Evenly spaced distance markers (every km or mile), like onthegomap's
 * numbered pins. Marker n sits exactly n * stepM along the line.
 */
export function distanceMarkers(
  line: LatLng[],
  stepM: number,
): { n: number; at: LatLng }[] {
  if (line.length < 2 || !(stepM > 0)) return [];
  const cum = cumulativeMeters(line);
  const total = cum[cum.length - 1]!;
  const out: { n: number; at: LatLng }[] = [];
  let seg = 1;
  for (let n = 1; n * stepM <= total; n++) {
    const target = n * stepM;
    while (seg < line.length - 1 && cum[seg]! < target) seg++;
    const a = line[seg - 1]!;
    const b = line[seg]!;
    const segLen = cum[seg]! - cum[seg - 1]!;
    const t = segLen > 0 ? (target - cum[seg - 1]!) / segLen : 0;
    out.push({ n, at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] });
  }
  return out;
}

/** Projection of p onto the line: nearest point, distance off-line, distance along. */
export function projectOntoLine(
  line: LatLng[],
  p: LatLng,
): { point: LatLng; offM: number; alongM: number; segIndex: number } | null {
  if (line.length < 2) return null;
  const cosLat = Math.cos((p[0] * Math.PI) / 180);
  let best: { point: LatLng; offM: number; segIndex: number; t: number } | null = null;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const ax = a[1] * cosLat;
    const ay = a[0];
    const dx = b[1] * cosLat - ax;
    const dy = b[0] - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p[1] * cosLat - ax) * dx + (p[0] - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const q: LatLng = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const d = haversineMeters(p, q);
    if (!best || d < best.offM) best = { point: q, offM: d, segIndex: i, t };
  }
  if (!best) return null;
  const cum = cumulativeMeters(line);
  const alongM =
    cum[best.segIndex]! + haversineMeters(line[best.segIndex]!, best.point);
  return { point: best.point, offM: best.offM, alongM, segIndex: best.segIndex };
}

/** Which leg a hit on the joined line belongs to (by distance along it). */
export function legIndexAtAlong(legs: { coords: LatLng[] }[], alongM: number): number {
  let acc = 0;
  for (let i = 0; i < legs.length; i++) {
    acc += lineLengthMeters(legs[i]!.coords);
    if (alongM <= acc + 0.5) return i;
  }
  return Math.max(0, legs.length - 1);
}
