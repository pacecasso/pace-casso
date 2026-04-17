import * as turf from "@turf/turf";

type Waypoint = [number, number];

/** Bilateral mean distance (meters) between two polylines (anchor↔route). */
export function meanBidirectionalErrorMeters(
  anchor: Waypoint[],
  route: Waypoint[],
): number | null {
  if (anchor.length < 2 || route.length < 2) return null;
  try {
    const ls = turf.lineString(
      route.map(([lat, lng]) => [lng, lat] as [number, number]),
    );
    let sumA = 0;
    for (const p of anchor) {
      const np = turf.nearestPointOnLine(ls, [p[1], p[0]], {
        units: "kilometers",
      });
      const d = (np.properties as { dist?: number }).dist ?? 0;
      sumA += d * 1000;
    }
    const meanA = sumA / anchor.length;

    const lsA = turf.lineString(
      anchor.map(([lat, lng]) => [lng, lat] as [number, number]),
    );
    let sumB = 0;
    let countB = 0;
    const step = Math.max(1, Math.floor(route.length / 48));
    for (let i = 0; i < route.length; i += step) {
      const p = route[i];
      const np = turf.nearestPointOnLine(lsA, [p[1], p[0]], {
        units: "kilometers",
      });
      const d = (np.properties as { dist?: number }).dist ?? 0;
      sumB += d * 1000;
      countB++;
    }
    const meanB = countB ? sumB / countB : meanA;
    return (meanA + meanB) / 2;
  } catch {
    return null;
  }
}

function percentFromMeanError(meanM: number, sensitivityM: number): number {
  return Math.min(
    100,
    Math.max(0, 100 * Math.exp(-meanM / sensitivityM)),
  );
}

/**
 * 0–100: strict point-to-street agreement (mean error, tight exponential).
 * Good for debugging; penalizes grid “stair steps” vs a smooth template.
 */
export function shapeAccuracyPercent(
  anchor: Waypoint[],
  route: Waypoint[],
): number {
  const m = meanBidirectionalErrorMeters(anchor, route);
  if (m == null) return 0;
  return Math.round(percentFromMeanError(m, 42));
}

function extentCombined(anchor: Waypoint[], route: Waypoint[]) {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of [...anchor, ...route]) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  const latSpan = maxLat - minLat;
  const lngSpan = maxLng - minLng;
  return {
    minLat,
    maxLat,
    minLng,
    maxLng,
    /** Span of the combined bounding box (degrees), for simplify tolerances. */
    diagonalSpanDeg: Math.sqrt(latSpan * latSpan + lngSpan * lngSpan) || 1e-6,
  };
}

function simplifyWaypoints(pts: Waypoint[], toleranceDeg: number): Waypoint[] {
  if (pts.length < 2) return pts.slice();
  const line = turf.lineString(
    pts.map(([lat, lng]) => [lng, lat] as [number, number]),
  );
  const out = turf.simplify(line, {
    tolerance: Math.max(1e-9, toleranceDeg),
    highQuality: true,
  });
  const coords =
    out.type === "Feature" && out.geometry?.type === "LineString"
      ? out.geometry.coordinates
      : null;
  if (!coords?.length || coords.length < 2) return pts.slice();
  return coords.map(([lng, lat]) => [lat, lng] as Waypoint);
}

/** Softer decay than tight fit — rewards coarse silhouette alignment. */
const INTERP_MULTISCALE_SENSITIVITY_M = 82;
/** Blend with original-resolution error so fine detail still matters a little. */
const INTERP_ORIGINAL_SENSITIVITY_M = 56;

/**
 * 0–100: “GPS-art style” agreement — multi-scale simplified polylines + softer
 * decay, closer to how large-scale street art reads (gestalt over pixel fit).
 */
export function interpretationMatchPercent(
  anchor: Waypoint[],
  route: Waypoint[],
): number {
  const m0 = meanBidirectionalErrorMeters(anchor, route);
  if (m0 == null) return 0;

  const { diagonalSpanDeg } = extentCombined(anchor, route);
  /** Fractions of combined diagonal used as Douglas–Peucker tolerance (degrees). */
  const fracSteps = [
    0.0004, 0.001, 0.0022, 0.0045, 0.009, 0.018, 0.032, 0.055,
  ];

  let best = 0;
  for (const frac of fracSteps) {
    const tol = diagonalSpanDeg * frac;
    const aS = simplifyWaypoints(anchor, tol);
    const rS = simplifyWaypoints(route, tol);
    if (aS.length < 2 || rS.length < 2) continue;
    const m = meanBidirectionalErrorMeters(aS, rS);
    if (m == null) continue;
    best = Math.max(
      best,
      percentFromMeanError(m, INTERP_MULTISCALE_SENSITIVITY_M),
    );
  }

  const origSoft = percentFromMeanError(m0, INTERP_ORIGINAL_SENSITIVITY_M);
  return Math.round(Math.min(100, Math.max(best, origSoft)));
}
