type Waypoint = [number, number];

const EARTH_RADIUS_M = 6371000;

type XY = { x: number; y: number };

type Segment = {
  a: XY;
  b: XY;
  ux: number;
  uy: number;
  len: number;
};

function isValidWaypoint(v: unknown): v is Waypoint {
  return (
    Array.isArray(v) &&
    typeof v[0] === "number" &&
    Number.isFinite(v[0]) &&
    v[0] >= -90 &&
    v[0] <= 90 &&
    typeof v[1] === "number" &&
    Number.isFinite(v[1]) &&
    v[1] >= -180 &&
    v[1] <= 180
  );
}

function toLocalMeters([lat, lng]: Waypoint, refLatRad: number): XY {
  const latRad = (lat * Math.PI) / 180;
  const lngRad = (lng * Math.PI) / 180;
  return {
    x: EARTH_RADIUS_M * lngRad * Math.cos(refLatRad),
    y: EARTH_RADIUS_M * latRad,
  };
}

function pointSegmentDistance(p: XY, a: XY, b: XY): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const denom = vx * vx + vy * vy;
  const t = denom > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / denom)) : 0;
  const cx = a.x + t * vx;
  const cy = a.y + t * vy;
  return Math.hypot(p.x - cx, p.y - cy);
}

function segmentDistance(a: Segment, b: Segment): number {
  return Math.min(
    pointSegmentDistance(a.a, b.a, b.b),
    pointSegmentDistance(a.b, b.a, b.b),
    pointSegmentDistance(b.a, a.a, a.b),
    pointSegmentDistance(b.b, a.a, a.b),
  );
}

function buildSegments(route: Waypoint[]): Segment[] {
  const validRoute = route.filter(isValidWaypoint);
  if (validRoute.length < 2) return [];
  const refLat =
    (validRoute.reduce((sum, [lat]) => sum + lat, 0) / validRoute.length) *
    (Math.PI / 180);
  const pts = validRoute.map((p) => toLocalMeters(p, refLat));
  const out: Segment[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 8) continue;
    out.push({ a, b, ux: dx / len, uy: dy / len, len });
  }
  return out;
}

/**
 * Estimates how much of a route retraces a nearby corridor in the opposite
 * direction. This is intentionally soft: out-and-back may be valid GPS art,
 * but auto-placement should prefer cleaner one-line interpretations when the
 * shape can read without retracing.
 */
export function doublingBackRatio(
  route: Waypoint[],
  options: { corridorMeters?: number; oppositeDot?: number } = {},
): number {
  const segs = buildSegments(route);
  if (segs.length < 2) return 0;
  const corridorMeters = options.corridorMeters ?? 28;
  const oppositeDot = options.oppositeDot ?? -0.72;
  const total = segs.reduce((sum, s) => sum + s.len, 0);
  if (total <= 0) return 0;

  const doubled = new Uint8Array(segs.length);
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i]!;
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j]!;
      const dot = a.ux * b.ux + a.uy * b.uy;
      if (dot > oppositeDot) continue;
      if (segmentDistance(a, b) > corridorMeters) continue;
      doubled[i] = 1;
      doubled[j] = 1;
    }
  }

  let repeated = 0;
  for (let i = 0; i < segs.length; i++) {
    if (doubled[i]) repeated += segs[i]!.len;
  }
  return Math.max(0, Math.min(1, repeated / total));
}

/**
 * Estimates how much of the route is spent on tiny corrective turns. These
 * jogs are technically valid on a street grid, but in GPS art they often make
 * a shape look less intentional than a simpler grid-native approximation.
 */
export function jaggedTurnRatio(
  route: Waypoint[],
  options: {
    minTurnDeg?: number;
    maxTurnDeg?: number;
    shortLegMeters?: number;
  } = {},
): number {
  const segs = buildSegments(route);
  if (segs.length < 3) return 0;

  const total = segs.reduce((sum, s) => sum + s.len, 0);
  if (total <= 0) return 0;

  const minTurnDeg = options.minTurnDeg ?? 35;
  const maxTurnDeg = options.maxTurnDeg ?? 145;
  const shortLegMeters = options.shortLegMeters ?? 170;
  let jagged = 0;

  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1]!;
    const next = segs[i]!;
    const dot = Math.max(-1, Math.min(1, prev.ux * next.ux + prev.uy * next.uy));
    const turnDeg = (Math.acos(dot) * 180) / Math.PI;
    if (turnDeg < minTurnDeg || turnDeg > maxTurnDeg) continue;

    const shorter = Math.min(prev.len, next.len);
    if (shorter >= shortLegMeters) continue;

    const angleWeight = Math.sin((turnDeg * Math.PI) / 180);
    const shortLegWeight = 0.35 + 0.65 * (1 - shorter / shortLegMeters);
    jagged += shorter * angleWeight * shortLegWeight;
  }

  return Math.max(0, Math.min(1, jagged / total));
}

/**
 * Detects short local excursions where the route leaves a corridor and quickly
 * comes back nearby. These "stick-out" spurs often raise point-fit scores while
 * making the GPS art read worse.
 */
export function protrudingDetourRatio(
  route: Waypoint[],
  options: {
    maxWindowMeters?: number;
    collapseRatio?: number;
    minExcessMeters?: number;
  } = {},
): number {
  const segs = buildSegments(route);
  if (segs.length < 2) return 0;

  const total = segs.reduce((sum, s) => sum + s.len, 0);
  if (total <= 0) return 0;

  const maxWindowMeters = options.maxWindowMeters ?? 520;
  const collapseRatio = options.collapseRatio ?? 0.55;
  const minExcessMeters = options.minExcessMeters ?? 45;
  const marked = new Uint8Array(segs.length);

  for (let start = 0; start < segs.length - 1; start++) {
    let pathLen = 0;
    for (let end = start; end < Math.min(segs.length, start + 4); end++) {
      pathLen += segs[end]!.len;
      if (end === start) continue;
      if (pathLen > maxWindowMeters) break;

      const direct = Math.hypot(
        segs[end]!.b.x - segs[start]!.a.x,
        segs[end]!.b.y - segs[start]!.a.y,
      );
      const excess = pathLen - direct;
      if (excess < minExcessMeters) continue;
      if (direct / pathLen > collapseRatio) continue;

      for (let i = start; i <= end; i++) marked[i] = 1;
    }
  }

  let protruding = 0;
  for (let i = 0; i < segs.length; i++) {
    if (marked[i]) protruding += segs[i]!.len;
  }
  return Math.max(0, Math.min(1, protruding / total));
}

/** 0-100 quality score where 100 means clean, intentional route geometry. */
export function routeQualityScore(route: Waypoint[]): number {
  if (buildSegments(route).length < 1) return 0;
  const backtrack = doublingBackRatio(route);
  const jagged = jaggedTurnRatio(route);
  const protruding = protrudingDetourRatio(route);
  return Math.round(
    100 * Math.exp(-2.4 * backtrack - 1.6 * jagged - 2.1 * protruding),
  );
}
