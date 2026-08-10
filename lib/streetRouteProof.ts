import { haversineMeters } from "./haversine";

export type LatLng = [number, number];

export type DistanceStats = {
  meanMeters: number;
  p95Meters: number;
  maxMeters: number;
};

export type WalkingProofCriteria = {
  targetDistanceToleranceRatio: number;
  maxMeanDeviationMeters: number;
  maxP95DeviationMeters: number;
  maxMapboxDistanceDeltaRatio: number;
};

export type WalkingProofReport = {
  pass: boolean;
  criteria: WalkingProofCriteria;
  candidatePointCount: number;
  mapboxPointCount: number;
  validationWaypointCount: number;
  candidateDistanceMeters: number;
  mapboxDistanceMeters: number;
  targetDistanceMeters: number | null;
  targetDistanceDeltaRatio: number | null;
  mapboxDistanceDeltaRatio: number;
  candidateToMapbox: DistanceStats;
  mapboxToCandidate: DistanceStats;
  bilateralMeanDeviationMeters: number;
  bilateralP95DeviationMeters: number;
  failures: string[];
};

const EARTH_RADIUS_M = 6_371_000;

export const DEFAULT_WALKING_PROOF_CRITERIA: WalkingProofCriteria = {
  targetDistanceToleranceRatio: 0.05,
  maxMeanDeviationMeters: 45,
  maxP95DeviationMeters: 120,
  maxMapboxDistanceDeltaRatio: 0.12,
};

function isLatLng(v: unknown): v is LatLng {
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

export function cleanLatLngs(points: unknown): LatLng[] {
  if (!Array.isArray(points)) return [];
  return points.filter(isLatLng);
}

export function parseGpxTrackpoints(gpx: string): LatLng[] {
  const out: LatLng[] = [];
  const re = /<trkpt\b[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"/gi;
  for (let match; (match = re.exec(gpx));) {
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (isLatLng([lat, lng])) out.push([lat, lng]);
  }
  return out;
}

export function pathDistanceMeters(points: LatLng[]): number {
  const clean = cleanLatLngs(points);
  let total = 0;
  for (let i = 1; i < clean.length; i++) {
    total += haversineMeters(clean[i - 1]!, clean[i]!);
  }
  return total;
}

function interpolateLatLng(a: LatLng, b: LatLng, t: number): LatLng {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function selectValidationWaypoints(
  points: LatLng[],
  maxWaypoints = 25,
): LatLng[] {
  const clean = cleanLatLngs(points);
  if (clean.length <= maxWaypoints) return clean;
  if (maxWaypoints < 2) return clean.slice(0, 1);

  const cumulative = [0];
  for (let i = 1; i < clean.length; i++) {
    cumulative.push(
      cumulative[i - 1]! + haversineMeters(clean[i - 1]!, clean[i]!),
    );
  }
  const total = cumulative[cumulative.length - 1]!;
  if (total <= 0) return [clean[0]!, clean[clean.length - 1]!];

  const out: LatLng[] = [];
  let seg = 1;
  for (let i = 0; i < maxWaypoints; i++) {
    const target = (total * i) / (maxWaypoints - 1);
    while (seg < cumulative.length - 1 && cumulative[seg]! < target) seg++;
    const before = cumulative[seg - 1]!;
    const after = cumulative[seg]!;
    const denom = after - before;
    const t = denom > 0 ? (target - before) / denom : 0;
    out.push(interpolateLatLng(clean[seg - 1]!, clean[seg]!, t));
  }
  return out;
}
export function selectValidationWaypointsBySpacing(
  points: LatLng[],
  options: { spacingMeters?: number; maxWaypoints?: number } = {},
): LatLng[] {
  const clean = cleanLatLngs(points);
  if (clean.length < 2) return clean;
  const spacingMeters = Math.max(25, options.spacingMeters ?? 350);
  const maxWaypoints = Math.max(2, Math.floor(options.maxWaypoints ?? 180));

  const total = pathDistanceMeters(clean);
  if (total <= 0) return [clean[0]!, clean[clean.length - 1]!];
  const count = Math.min(
    maxWaypoints,
    Math.max(2, Math.ceil(total / spacingMeters) + 1),
  );
  return selectValidationWaypoints(clean, count);
}

type XY = { x: number; y: number };

function refLatRad(a: LatLng[], b: LatLng[]): number {
  const points = [...a, ...b];
  const meanLat =
    points.reduce((sum, [lat]) => sum + lat, 0) / Math.max(1, points.length);
  return (meanLat * Math.PI) / 180;
}

function toLocalMeters([lat, lng]: LatLng, refLat: number): XY {
  return {
    x: EARTH_RADIUS_M * ((lng * Math.PI) / 180) * Math.cos(refLat),
    y: EARTH_RADIUS_M * ((lat * Math.PI) / 180),
  };
}

function pointSegmentDistanceMeters(p: XY, a: XY, b: XY): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;
  const denom = vx * vx + vy * vy;
  const t =
    denom > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / denom)) : 0;
  const cx = a.x + vx * t;
  const cy = a.y + vy * t;
  return Math.hypot(p.x - cx, p.y - cy);
}

function distanceToPolylineMeters(point: XY, line: XY[]): number {
  if (line.length === 0) return Number.POSITIVE_INFINITY;
  if (line.length === 1) return Math.hypot(point.x - line[0]!.x, point.y - line[0]!.y);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, pointSegmentDistanceMeters(point, line[i - 1]!, line[i]!));
  }
  return best;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return Number.POSITIVE_INFINITY;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx]!;
}

function distanceStats(from: LatLng[], to: LatLng[], sharedRefLat: number): DistanceStats {
  const line = to.map((p) => toLocalMeters(p, sharedRefLat));
  const distances = from
    .map((p) => distanceToPolylineMeters(toLocalMeters(p, sharedRefLat), line))
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b);
  if (!distances.length) {
    return {
      meanMeters: Number.POSITIVE_INFINITY,
      p95Meters: Number.POSITIVE_INFINITY,
      maxMeters: Number.POSITIVE_INFINITY,
    };
  }
  const meanMeters = distances.reduce((sum, d) => sum + d, 0) / distances.length;
  return {
    meanMeters,
    p95Meters: percentile(distances, 95),
    maxMeters: distances[distances.length - 1]!,
  };
}

export function buildWalkingProofReport(input: {
  candidate: LatLng[];
  mapboxWalkingRoute: LatLng[];
  validationWaypoints: LatLng[];
  targetDistanceMeters?: number | null;
  criteria?: Partial<WalkingProofCriteria>;
}): WalkingProofReport {
  const candidate = cleanLatLngs(input.candidate);
  const mapboxWalkingRoute = cleanLatLngs(input.mapboxWalkingRoute);
  const validationWaypoints = cleanLatLngs(input.validationWaypoints);
  const criteria = {
    ...DEFAULT_WALKING_PROOF_CRITERIA,
    ...input.criteria,
  };
  const failures: string[] = [];

  if (candidate.length < 2) failures.push("candidate_has_too_few_points");
  if (mapboxWalkingRoute.length < 2) failures.push("mapbox_route_has_too_few_points");
  if (validationWaypoints.length < 2) failures.push("validation_has_too_few_waypoints");

  const candidateDistanceMeters = pathDistanceMeters(candidate);
  const mapboxDistanceMeters = pathDistanceMeters(mapboxWalkingRoute);
  const targetDistanceMeters =
    typeof input.targetDistanceMeters === "number" &&
    Number.isFinite(input.targetDistanceMeters) &&
    input.targetDistanceMeters > 0
      ? input.targetDistanceMeters
      : null;

  const targetDistanceDeltaRatio =
    targetDistanceMeters != null && candidateDistanceMeters > 0
      ? Math.abs(candidateDistanceMeters - targetDistanceMeters) /
        targetDistanceMeters
      : null;
  const mapboxDistanceDeltaRatio =
    mapboxDistanceMeters > 0 && candidateDistanceMeters > 0
      ? Math.abs(candidateDistanceMeters - mapboxDistanceMeters) /
        mapboxDistanceMeters
      : Number.POSITIVE_INFINITY;

  const sharedRef = refLatRad(candidate, mapboxWalkingRoute);
  const candidateToMapbox = distanceStats(candidate, mapboxWalkingRoute, sharedRef);
  const mapboxToCandidate = distanceStats(mapboxWalkingRoute, candidate, sharedRef);
  const bilateralMeanDeviationMeters =
    (candidateToMapbox.meanMeters + mapboxToCandidate.meanMeters) / 2;
  const bilateralP95DeviationMeters = Math.max(
    candidateToMapbox.p95Meters,
    mapboxToCandidate.p95Meters,
  );

  if (candidateDistanceMeters <= 0) failures.push("candidate_distance_is_zero");
  if (mapboxDistanceMeters <= 0) failures.push("mapbox_distance_is_zero");
  if (
    targetDistanceDeltaRatio != null &&
    targetDistanceDeltaRatio > criteria.targetDistanceToleranceRatio
  ) {
    failures.push("target_distance_outside_tolerance");
  }
  if (mapboxDistanceDeltaRatio > criteria.maxMapboxDistanceDeltaRatio) {
    failures.push("mapbox_distance_delta_too_high");
  }
  if (bilateralMeanDeviationMeters > criteria.maxMeanDeviationMeters) {
    failures.push("mean_deviation_too_high");
  }
  if (bilateralP95DeviationMeters > criteria.maxP95DeviationMeters) {
    failures.push("p95_deviation_too_high");
  }

  return {
    pass: failures.length === 0,
    criteria,
    candidatePointCount: candidate.length,
    mapboxPointCount: mapboxWalkingRoute.length,
    validationWaypointCount: validationWaypoints.length,
    candidateDistanceMeters,
    mapboxDistanceMeters,
    targetDistanceMeters,
    targetDistanceDeltaRatio,
    mapboxDistanceDeltaRatio,
    candidateToMapbox,
    mapboxToCandidate,
    bilateralMeanDeviationMeters,
    bilateralP95DeviationMeters,
    failures,
  };
}
