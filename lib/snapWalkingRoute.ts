import { MAPBOX_PUBLIC_TOKEN } from "./mapboxToken";
import {
  simplifyAnchorPathForSnap,
  type AnchorPathSource,
} from "./simplifyAnchorPathForSnap";
import type { RouteLineString } from "./routeTypes";

export type { AnchorPathSource };

export type SnapWalkingRouteOptions = {
  /**
   * Photo traces (`image`) use mild anchor reduction for mid-sized contours so Mapbox
   * gets fewer legs; freehand stick letters stay unchanged when sparse.
   */
  anchorSource?: AnchorPathSource;
};

type MapboxRouteSegment = {
  coordinates: [number, number][];
  distance: number;
  duration: number;
};

type MapboxStep = {
  maneuver?: { location?: [number, number] };
  geometry?: { coordinates?: [number, number][] };
};

type MapboxDirectionsRoute = {
  distance?: number;
  duration?: number;
  geometry?: { coordinates: [number, number][] };
  legs?: {
    steps?: MapboxStep[];
  }[];
};

function nearSame(a: [number, number], b: [number, number], eps = 1e-5): boolean {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

type LineSeg = { a: [number, number]; b: [number, number]; len: number };

function buildNonDegenerateSegments(line: [number, number][]): LineSeg[] {
  const segments: LineSeg[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const len = haversineMeters(a, b);
    if (len >= 0.05) segments.push({ a, b, len });
  }
  return segments;
}

function pointAtDistanceAlongSegments(
  segments: LineSeg[],
  d: number,
): [number, number] {
  let remain = d;
  for (const seg of segments) {
    if (remain <= seg.len + 1e-8) {
      const f = seg.len < 1e-8 ? 0 : remain / seg.len;
      return [
        seg.a[0] + f * (seg.b[0] - seg.a[0]),
        seg.a[1] + f * (seg.b[1] - seg.a[1]),
      ];
    }
    remain -= seg.len;
  }
  const last = segments[segments.length - 1];
  return last.b;
}

function pointAtArcLengthClamped(
  line: [number, number][],
  s: number,
): [number, number] {
  const segs = buildNonDegenerateSegments(line);
  if (!segs.length) return line[0];
  const total = segs.reduce((a, g) => a + g.len, 0);
  return pointAtDistanceAlongSegments(segs, Math.min(Math.max(0, s), total));
}

/**
 * Fixed spacing along true stitched geometry. Fills lobes (e.g. hearts) where
 * maneuver-only handles + fillLargeGaps miss: that helper uses closest-segment
 * arc length, which can pair two points on the wrong branch and skip a long bulge.
 */
function samplePointsAlongLineEvery(
  line: [number, number][],
  spacingM: number,
): [number, number][] {
  const segs = buildNonDegenerateSegments(line);
  if (!segs.length) return line.length ? [line[0]!] : [];
  const total = segs.reduce((s, g) => s + g.len, 0);
  if (total < 2) {
    return line.length >= 2 ? [line[0]!, line[line.length - 1]!] : [line[0]!];
  }
  const out: [number, number][] = [];
  let d = 0;
  while (d <= total) {
    out.push(pointAtArcLengthClamped(line, d));
    d += spacingM;
  }
  const end = line[line.length - 1]!;
  if (!out.length || haversineMeters(out[out.length - 1]!, end) > 12) {
    out.push(end);
  }
  return out;
}

function mergeWithArcLengthSamples(
  stitched: [number, number][],
  wps: [number, number][],
  spacingM: number,
  minSepM: number,
): [number, number][] {
  if (stitched.length < 2) return wps;
  const samples = samplePointsAlongLineEvery(stitched, spacingM);
  const merged = mergeAndOrderWaypoints(stitched, [...wps, ...samples], minSepM);
  return dedupeWaypoints(merged, minSepM);
}

function fillLargeGapsAlongRoute(
  line: [number, number][],
  orderedWaypoints: [number, number][],
  maxGapM: number,
): [number, number][] {
  if (orderedWaypoints.length < 2) return orderedWaypoints;
  const totalLen = buildNonDegenerateSegments(line).reduce(
    (s, g) => s + g.len,
    0,
  );
  if (totalLen < 1) return orderedWaypoints;

  const out: [number, number][] = [orderedWaypoints[0]];
  for (let i = 0; i < orderedWaypoints.length - 1; i++) {
    const a = orderedWaypoints[i];
    const b = orderedWaypoints[i + 1];
    const sa = distanceAlongLineToPoint(line, a);
    const sb = distanceAlongLineToPoint(line, b);
    const lo = Math.min(sa, sb);
    const hi = Math.max(sa, sb);
    const gap = hi - lo;
    const numInterior = gap > maxGapM ? Math.ceil(gap / maxGapM) - 1 : 0;
    for (let k = 1; k <= numInterior; k++) {
      const s = lo + (k / (numInterior + 1)) * gap;
      out.push(pointAtArcLengthClamped(line, s));
    }
    out.push(b);
  }
  return dedupeWaypoints(out, 20);
}

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

function distanceAlongLineToPoint(
  line: [number, number][],
  p: [number, number],
): number {
  let bestAlong = 0;
  let bestDist = Infinity;
  let cumulative = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const segLen = haversineMeters(a, b);
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

function mergeAndOrderWaypoints(
  line: [number, number][],
  candidates: [number, number][],
  minSepM = 12,
): [number, number][] {
  const uniq: [number, number][] = [];
  for (const p of candidates) {
    let dup = false;
    for (const u of uniq) {
      if (haversineMeters(p, u) < 2) {
        dup = true;
        break;
      }
    }
    if (!dup) uniq.push(p);
  }
  const scored = uniq.map((p) => ({
    p,
    s: distanceAlongLineToPoint(line, p),
  }));
  scored.sort((a, b) => a.s - b.s);
  return dedupeWaypoints(
    scored.map((x) => x.p),
    minSepM,
  );
}

/**
 * Order Mapbox maneuver handles by travel order along the **user sketch** first.
 * At T-junctions, projecting onto the snapped polyline alone can pick the wrong
 * branch; draw order disambiguates.
 */
function mergeAndOrderWaypointsAlongUserPath(
  userPath: [number, number][],
  stitched: [number, number][],
  candidates: [number, number][],
  minSepM = 12,
): [number, number][] {
  const uniq: [number, number][] = [];
  for (const p of candidates) {
    let dup = false;
    for (const u of uniq) {
      if (haversineMeters(p, u) < 2) {
        dup = true;
        break;
      }
    }
    if (!dup) uniq.push(p);
  }

  const primary = userPath.length >= 2 ? userPath : stitched;
  const scored = uniq.map((p) => ({
    p,
    su: distanceAlongLineToPoint(primary, p),
    ss: distanceAlongLineToPoint(stitched, p),
  }));

  scored.sort((a, b) => {
    if (Math.abs(a.su - b.su) > 8) return a.su - b.su;
    return a.ss - b.ss;
  });

  return dedupeWaypoints(
    scored.map((x) => x.p),
    minSepM,
  );
}

function collectBlockWaypointsFromLegs(
  routes: MapboxDirectionsRoute[],
  stitchedLine: [number, number][],
): [number, number][] {
  const out: [number, number][] = [];
  routes.forEach((route, chunkIdx) => {
    const steps = route.legs?.[0]?.steps;
    if (!steps?.length) return;
    const start = chunkIdx > 0 ? 1 : 0;
    for (let i = start; i < steps.length; i++) {
      const loc = steps[i].maneuver?.location;
      if (!loc || loc.length < 2) continue;
      const pt: [number, number] = [loc[1], loc[0]];
      if (out.length && nearSame(out[out.length - 1], pt)) continue;
      out.push(pt);
    }
  });

  if (stitchedLine.length >= 2) {
    const first = stitchedLine[0];
    const last = stitchedLine[stitchedLine.length - 1];
    if (!out.length) {
      return dedupeWaypoints([first, last], 1);
    }
    if (!nearSame(out[0], first)) out.unshift(first);
    if (!nearSame(out[out.length - 1], last)) out.push(last);
  }

  return dedupeWaypoints(out, 1);
}

function dedupeWaypoints(pts: [number, number][], minMeters = 2): [number, number][] {
  if (pts.length < 2) return pts;
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (haversineMeters(pts[i], out[out.length - 1]) >= minMeters) out.push(pts[i]);
  }
  return out;
}

type LatLngBBox = { minLat: number; maxLat: number; minLng: number; maxLng: number };

function bboxOfPts(pts: [number, number][]): LatLngBBox | null {
  if (!pts.length) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [la, ln] of pts) {
    minLat = Math.min(minLat, la);
    maxLat = Math.max(maxLat, la);
    minLng = Math.min(minLng, ln);
    maxLng = Math.max(maxLng, ln);
  }
  return { minLat, maxLat, minLng, maxLng };
}

function polylineLengthMeters(line: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < line.length - 1; i++) {
    s += haversineMeters(line[i]!, line[i + 1]!);
  }
  return s;
}

/**
 * Hearts / winding loops need dense arc samples; long grid straights do not.
 * Open hearts often have start≈end; winding art has path length ≫ bbox span.
 */
function routeNeedsLobeWaypoints(
  stitched: [number, number][],
  totalDistM: number,
): boolean {
  if (stitched.length < 4) return false;
  const endsClose =
    haversineMeters(stitched[0]!, stitched[stitched.length - 1]!) < 220;
  const sb = bboxOfPts(stitched);
  if (!sb) return false;
  const midLat = ((sb.minLat + sb.maxLat) / 2) * (Math.PI / 180);
  const hM = (sb.maxLat - sb.minLat) * 111000;
  const wM = (sb.maxLng - sb.minLng) * Math.cos(midLat) * 111000;
  const bboxMax = Math.max(hM, wM, 80);
  const pathLen = polylineLengthMeters(stitched);
  const windy = pathLen / bboxMax > 2.12;
  const longForSize = totalDistM > 650 && windy;
  return endsClose || longForSize;
}

/** Initial bearing from a to b (degrees, 0–360, clockwise from north). */
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

/**
 * Drop intermediate handles where the path barely turns (long straightaways
 * like N blocks on one avenue). Keeps corners; multi-pass until stable.
 */
function thinNearlyColinearChordWaypoints(
  wps: [number, number][],
  maxTurnDeg: number,
  minLegM: number,
): [number, number][] {
  if (wps.length < 3) return wps;
  let cur = wps;
  for (let pass = 0; pass < 10; pass++) {
    const next: [number, number][] = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      const a = next[next.length - 1];
      const b = cur[i];
      const c = cur[i + 1];
      const leg1 = haversineMeters(a, b);
      const leg2 = haversineMeters(b, c);
      if (leg1 < minLegM || leg2 < minLegM) {
        next.push(b);
        continue;
      }
      const bear1 = initialBearingDeg(a, b);
      const bear2 = initialBearingDeg(b, c);
      const turn = smallestAngleBetweenBearingsDeg(bear1, bear2);
      if (turn < maxTurnDeg) continue;
      next.push(b);
    }
    next.push(cur[cur.length - 1]);
    if (next.length === cur.length) break;
    cur = next;
  }
  return cur;
}

/** If block waypoints sit on one leg (e.g. west edge only) while stitched spans a loop, fine-tune breaks. */
function blockWaypointsCoverStitched(
  stitched: [number, number][],
  wps: [number, number][],
  minRatio = 0.22,
): boolean {
  const sb = bboxOfPts(stitched);
  const wb = bboxOfPts(wps);
  if (!sb || !wb) return true;

  const latSpanS = sb.maxLat - sb.minLat;
  const lngSpanS = sb.maxLng - sb.minLng;
  const latSpanW = wb.maxLat - wb.minLat;
  const lngSpanW = wb.maxLng - wb.minLng;

  const eps = 1.2e-4;
  const needLat = latSpanS > eps;
  const needLng = lngSpanS > eps;

  const latOk = !needLat || latSpanW / latSpanS >= minRatio;
  const lngOk = !needLng || lngSpanW / lngSpanS >= minRatio;
  return latOk && lngOk;
}

function fallbackWaypointsFromLine(
  line: [number, number][],
  target: number,
): [number, number][] {
  if (line.length < 2) return line.slice() as [number, number][];
  const n = Math.min(Math.max(2, target), line.length);
  if (n >= line.length) return line.slice() as [number, number][];
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    const idx = t * (line.length - 1);
    const i = Math.floor(idx);
    const j = Math.min(i + 1, line.length - 1);
    const f = idx - i;
    const a = line[i];
    const b = line[j];
    out.push([a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]);
  }
  return dedupeWaypoints(out, 1);
}

export const SNAP_WALKING_CHUNK_SIZE = 20;
const CHUNK_SIZE = SNAP_WALKING_CHUNK_SIZE;

/** If chunk geometries don’t meet, Leaflet draws a chord through blocks — bridge with a 2-point walking request. */
const CHUNK_JOIN_GAP_BRIDGE_M = 28;

function appendDedupedStitch(
  target: [number, number][],
  pts: [number, number][],
  epsDeg = 1e-5,
): void {
  for (const p of pts) {
    const last = target[target.length - 1];
    if (last && nearSame(last, p, epsDeg)) continue;
    target.push(p);
  }
}

async function fetchWalkingBridge(
  from: [number, number],
  to: [number, number],
): Promise<{ coordinates: [number, number][]; distance: number }> {
  const coordString = `${from[1]},${from[0]};${to[1]},${to[0]}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coordString}?geometries=geojson&overview=full&steps=false&alternatives=false&access_token=${MAPBOX_PUBLIC_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mapbox bridge (${res.status}): ${text || res.statusText}`);
  }
  const data = await res.json();
  if (!data.routes?.length) {
    throw new Error("Mapbox bridge: no route");
  }
  const r = data.routes[0] as MapboxDirectionsRoute;
  const lineCoords: [number, number][] = (r.geometry?.coordinates ?? []).map(
    ([lng, lat]: [number, number]) => [lat, lng],
  );
  if (lineCoords.length < 2) {
    throw new Error("Mapbox bridge: empty geometry");
  }
  return {
    coordinates: lineCoords,
    distance: r.distance ?? 0,
  };
}

async function stitchSegmentGeometries(
  segments: MapboxRouteSegment[],
): Promise<{ stitched: [number, number][]; extraDist: number }> {
  const stitched: [number, number][] = [];
  let extraDist = 0;

  for (let idx = 0; idx < segments.length; idx++) {
    const coordsSeg = segments[idx].coordinates;
    if (!coordsSeg.length) continue;

    if (stitched.length === 0) {
      appendDedupedStitch(stitched, coordsSeg);
      continue;
    }

    const prev = stitched[stitched.length - 1];
    const first = coordsSeg[0];
    const gap = haversineMeters(prev, first);

    if (gap <= CHUNK_JOIN_GAP_BRIDGE_M) {
      appendDedupedStitch(stitched, coordsSeg);
      continue;
    }

    try {
      const bridge = await fetchWalkingBridge(prev, first);
      extraDist += bridge.distance;
      appendDedupedStitch(stitched, bridge.coordinates);
      appendDedupedStitch(stitched, coordsSeg);
    } catch {
      appendDedupedStitch(stitched, coordsSeg);
    }
  }

  return { stitched, extraDist };
}

async function snapOneContinuousPolyline(
  anchorLatLngs: [number, number][],
  anchorSource: AnchorPathSource | undefined,
): Promise<{
  stitched: [number, number][];
  totalDist: number;
  routePayloads: MapboxDirectionsRoute[];
}> {
  if (anchorLatLngs.length < 2) {
    throw new Error("Not enough points to snap to streets.");
  }

  let coords = simplifyAnchorPathForSnap(anchorLatLngs, {
    sourceKind: anchorSource ?? "default",
  });
  if (coords.length < 2) coords = anchorLatLngs;
  const segments: MapboxRouteSegment[] = [];
  const routePayloads: MapboxDirectionsRoute[] = [];

  for (let i = 0; i < coords.length - 1; i += CHUNK_SIZE - 1) {
    const chunk = coords.slice(i, i + CHUNK_SIZE);
    if (chunk.length < 2) break;

    const coordString = chunk.map(([lat, lng]) => `${lng},${lat}`).join(";");
    const url = `https://api.mapbox.com/directions/v5/mapbox/walking/${coordString}?geometries=geojson&overview=full&steps=true&alternatives=false&access_token=${MAPBOX_PUBLIC_TOKEN}`;

    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mapbox error (${res.status}): ${text || res.statusText}`);
    }

    const data = await res.json();
    if (!data.routes?.length) {
      throw new Error("Mapbox did not return any routes for a segment.");
    }

    const r = data.routes[0] as MapboxDirectionsRoute;
    routePayloads.push(r);
    const lineCoords: [number, number][] = (r.geometry?.coordinates ?? []).map(
      ([lng, lat]: [number, number]) => [lat, lng],
    );

    segments.push({
      coordinates: lineCoords,
      distance: r.distance ?? 0,
      duration: r.duration ?? 0,
    });
  }

  if (!segments.length) {
    throw new Error("No snapped segments were created.");
  }

  let totalDist = segments.reduce((s, g) => s + g.distance, 0);
  const { stitched, extraDist } = await stitchSegmentGeometries(segments);
  totalDist += extraDist;

  return { stitched, totalDist, routePayloads };
}

function finalizeBlockWaypoints(
  stitched: [number, number][],
  totalDist: number,
  routePayloads: MapboxDirectionsRoute[],
  userAnchorPath: [number, number][],
): RouteLineString {
  const maneuverPts = collectBlockWaypointsFromLegs(routePayloads, stitched);
  let blockWaypoints = mergeAndOrderWaypointsAlongUserPath(
    userAnchorPath,
    stitched,
    maneuverPts,
    26,
  );

  const needsLobe = routeNeedsLobeWaypoints(stitched, totalDist);
  if (!needsLobe) {
    blockWaypoints = thinNearlyColinearChordWaypoints(blockWaypoints, 16, 20);
  }
  blockWaypoints = dedupeWaypoints(blockWaypoints, 22);

  let covers = blockWaypointsCoverStitched(stitched, blockWaypoints);
  const gapMaxM =
    needsLobe ? 280 : covers ? 620 : 280;
  blockWaypoints = fillLargeGapsAlongRoute(stitched, blockWaypoints, gapMaxM);
  blockWaypoints = dedupeWaypoints(
    blockWaypoints,
    needsLobe ? 24 : covers ? 32 : 24,
  );

  covers = blockWaypointsCoverStitched(stitched, blockWaypoints);
  const mustArc = needsLobe || !covers;
  if (mustArc) {
    blockWaypoints = mergeWithArcLengthSamples(
      stitched,
      blockWaypoints,
      170,
      22,
    );
    blockWaypoints = dedupeWaypoints(blockWaypoints, 22);
  } else {
    blockWaypoints = mergeWithArcLengthSamples(
      stitched,
      blockWaypoints,
      360,
      28,
    );
    blockWaypoints = dedupeWaypoints(blockWaypoints, 28);
  }

  if (blockWaypoints.length < 2) {
    const target = Math.max(
      4,
      Math.min(28, Math.ceil(totalDist / 200) || 8),
    );
    blockWaypoints = fallbackWaypointsFromLine(stitched, target);
  }

  if (!blockWaypointsCoverStitched(stitched, blockWaypoints)) {
    const target = Math.max(
      8,
      Math.min(24, Math.ceil(totalDist / 200) || 12),
    );
    blockWaypoints = fallbackWaypointsFromLine(stitched, target);
  }

  return {
    coordinates: stitched,
    distanceMeters: totalDist,
    blockWaypoints,
  };
}

/**
 * Pure summary of how anchors will be simplified and chunked for Mapbox (no network).
 * Use in tests and debugging (waypoint budget, segment count).
 */
export function describeSnapRoutingPlan(
  anchorLatLngs: [number, number][],
  options?: SnapWalkingRouteOptions,
): {
  simplifiedVertexCount: number;
  mapboxChunkCount: number;
  /** Waypoints per Directions request (incl. endpoints), except the last chunk may be shorter. */
  chunkWaypointCap: number;
} {
  const simplified = simplifyAnchorPathForSnap(anchorLatLngs, {
    sourceKind: options?.anchorSource ?? "default",
  });
  const coords =
    simplified.length >= 2 ? simplified : anchorLatLngs;
  const n = coords.length;
  let chunks = 0;
  for (let i = 0; i < n - 1; i += CHUNK_SIZE - 1) {
    chunks++;
  }
  return {
    simplifiedVertexCount: n,
    mapboxChunkCount: chunks,
    chunkWaypointCap: CHUNK_SIZE,
  };
}

const SNAP_CACHE_MAX = 32;
const snapCache = new Map<string, Promise<RouteLineString>>();

function snapCacheKey(
  coords: [number, number][],
  anchorSource: AnchorPathSource | undefined,
): string {
  const n = coords.length;
  const head = Math.min(24, n);
  const tail = Math.min(24, Math.max(0, n - 24));
  const parts: number[] = [n, anchorSource === undefined ? 0 : anchorSource === "image" ? 1 : anchorSource === "freehand" ? 2 : 3];
  for (let i = 0; i < head; i++) {
    parts.push(
      Math.round(coords[i][0] * 1e5),
      Math.round(coords[i][1] * 1e5),
    );
  }
  for (let i = n - tail; i < n; i++) {
    if (i < head) continue;
    parts.push(
      Math.round(coords[i][0] * 1e5),
      Math.round(coords[i][1] * 1e5),
    );
  }
  return parts.join(",");
}

/**
 * Snap a polyline in lat/lng to walkable streets via Mapbox Directions (walking profile).
 * Identical coordinate sets share one in-flight request (bounded cache size).
 */
export async function snapWalkingRoute(
  anchorLatLngs: [number, number][],
  options?: SnapWalkingRouteOptions,
): Promise<RouteLineString> {
  if (anchorLatLngs.length < 2) {
    throw new Error("Not enough points to snap to streets.");
  }

  const key = snapCacheKey(anchorLatLngs, options?.anchorSource);
  const existing = snapCache.get(key);
  if (existing) return existing;

  while (snapCache.size >= SNAP_CACHE_MAX) {
    const k = snapCache.keys().next().value as string | undefined;
    if (k === undefined) break;
    snapCache.delete(k);
  }

  const promise = (async () => {
    const one = await snapOneContinuousPolyline(
      anchorLatLngs,
      options?.anchorSource,
    );
    return finalizeBlockWaypoints(
      one.stitched,
      one.totalDist,
      one.routePayloads,
      anchorLatLngs,
    );
  })();

  snapCache.set(key, promise);
  return promise;
}
