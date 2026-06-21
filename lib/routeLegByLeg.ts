import { fetchMapboxWalkingDirectionsJson } from "./mapboxClient";
import { haversineMeters } from "./haversine";

export type LatLng = [number, number];

export type RouteLegByLegOptions = {
  /** Reject legs longer than this (likely bridge / detour). */
  maxLegMeters?: number;
  /** All route points must pass this check. */
  validatePoint?: (p: LatLng) => boolean;
};

type DirectionsRoute = {
  distance?: number;
  geometry?: { coordinates?: [number, number][] };
};

function nearSame(a: LatLng, b: LatLng, epsM = 3): boolean {
  return haversineMeters(a, b) < epsM;
}

function appendLeg(out: LatLng[], leg: LatLng[]): void {
  if (!leg.length) return;
  if (!out.length) {
    out.push(...leg);
    return;
  }
  let start = 0;
  if (nearSame(out[out.length - 1]!, leg[0]!)) start = 1;
  for (let i = start; i < leg.length; i++) out.push(leg[i]!);
}

async function fetchLegGeometry(from: LatLng, to: LatLng): Promise<LatLng[]> {
  const data = (await fetchMapboxWalkingDirectionsJson({
    coordinates: [from, to],
    steps: false,
    overview: "full",
  })) as { routes?: DirectionsRoute[] };
  const route = data.routes?.[0];
  const raw = route?.geometry?.coordinates;
  if (!raw?.length) {
    throw new Error(`Leg-by-leg: no route from [${from}] to [${to}]`);
  }
  return raw.map(([lng, lat]) => [lat, lng] as LatLng);
}

function legLengthM(leg: LatLng[]): number {
  let m = 0;
  for (let i = 1; i < leg.length; i++) m += haversineMeters(leg[i - 1]!, leg[i]!);
  return m;
}

/**
 * Walk a route by snapping each consecutive anchor pair with its own 2-point
 * Mapbox Directions call.
 */
export async function routeLegByLeg(
  anchors: LatLng[],
  options: RouteLegByLegOptions = {},
): Promise<{
  coordinates: LatLng[];
  distanceMeters: number;
  legCount: number;
  rejectedLegs: number;
}> {
  if (anchors.length < 2) {
    return {
      coordinates: anchors.slice(),
      distanceMeters: 0,
      legCount: 0,
      rejectedLegs: 0,
    };
  }

  const maxLeg = options.maxLegMeters ?? 900;
  const validate = options.validatePoint;
  const stitched: LatLng[] = [];
  let distanceMeters = 0;
  let legCount = 0;
  let rejectedLegs = 0;

  for (let i = 0; i < anchors.length - 1; i++) {
    const from = anchors[i]!;
    const to = anchors[i + 1]!;
    if (nearSame(from, to, 1)) continue;

    const direct = haversineMeters(from, to);
    if (direct > maxLeg * 1.15) {
      rejectedLegs++;
      continue;
    }

    let leg: LatLng[];
    try {
      leg = await fetchLegGeometry(from, to);
    } catch {
      rejectedLegs++;
      continue;
    }

    const legM = legLengthM(leg);
    if (legM > maxLeg) {
      rejectedLegs++;
      continue;
    }

    if (validate && leg.some((p) => !validate(p))) {
      rejectedLegs++;
      continue;
    }

    appendLeg(stitched, leg);
    legCount++;
    distanceMeters += legM;
  }

  if (stitched.length < 2) {
    throw new Error("Leg-by-leg routing produced an empty path");
  }

  if (validate && stitched.some((p) => !validate(p))) {
    throw new Error("Leg-by-leg route contains invalid points");
  }

  return { coordinates: stitched, distanceMeters, legCount, rejectedLegs };
}

function midpoint(a: LatLng, b: LatLng): LatLng {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Like routeLegByLeg but recursively bisects failed legs so the stitched path
 * stays continuous on walkable streets.
 */
export async function routeLegByLegResilient(
  anchors: LatLng[],
  options: RouteLegByLegOptions = {},
): Promise<{
  coordinates: LatLng[];
  distanceMeters: number;
  legCount: number;
  rejectedLegs: number;
}> {
  if (anchors.length < 2) {
    return {
      coordinates: anchors.slice(),
      distanceMeters: 0,
      legCount: 0,
      rejectedLegs: 0,
    };
  }

  const maxLeg = options.maxLegMeters ?? 900;
  const validate = options.validatePoint;

  async function routeSegment(from: LatLng, to: LatLng, depth: number): Promise<LatLng[] | null> {
    if (nearSame(from, to, 1)) return [];
    if (depth > 6) return null;

    const direct = haversineMeters(from, to);
    if (direct > maxLeg * 1.15 && depth < 6) {
      const mid = midpoint(from, to);
      const a = await routeSegment(from, mid, depth + 1);
      const b = await routeSegment(mid, to, depth + 1);
      if (!a || !b) return null;
      const merged: LatLng[] = [];
      appendLeg(merged, a);
      appendLeg(merged, b);
      return merged;
    }

    let leg: LatLng[];
    try {
      leg = await fetchLegGeometry(from, to);
    } catch {
      if (depth >= 6) return null;
      const mid = midpoint(from, to);
      const a = await routeSegment(from, mid, depth + 1);
      const b = await routeSegment(mid, to, depth + 1);
      if (!a || !b) return null;
      const merged: LatLng[] = [];
      appendLeg(merged, a);
      appendLeg(merged, b);
      return merged;
    }

    if (legLengthM(leg) > maxLeg) {
      if (depth >= 6) return null;
      const mid = midpoint(from, to);
      const a = await routeSegment(from, mid, depth + 1);
      const b = await routeSegment(mid, to, depth + 1);
      if (!a || !b) return null;
      const merged: LatLng[] = [];
      appendLeg(merged, a);
      appendLeg(merged, b);
      return merged;
    }

    if (validate && leg.some((p) => !validate(p))) {
      if (depth >= 6) return null;
      const mid = midpoint(from, to);
      const a = await routeSegment(from, mid, depth + 1);
      const b = await routeSegment(mid, to, depth + 1);
      if (!a || !b) return null;
      const merged: LatLng[] = [];
      appendLeg(merged, a);
      appendLeg(merged, b);
      return merged;
    }

    return leg;
  }

  const stitched: LatLng[] = [];
  let distanceMeters = 0;
  let legCount = 0;
  let rejectedLegs = 0;

  for (let i = 0; i < anchors.length - 1; i++) {
    const from = anchors[i]!;
    const to = anchors[i + 1]!;
    const leg = await routeSegment(from, to, 0);
    if (!leg) {
      rejectedLegs++;
      continue;
    }
    const legM = legLengthM(leg);
    appendLeg(stitched, leg);
    legCount++;
    distanceMeters += legM;
  }

  if (stitched.length < 2) {
    throw new Error("Resilient leg-by-leg routing produced an empty path");
  }

  return { coordinates: stitched, distanceMeters, legCount, rejectedLegs };
}
