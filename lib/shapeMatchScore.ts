import * as turf from "@turf/turf";

type Waypoint = [number, number];

/** 0–100: closer agreement between placed outline and snapped street route. */
export function shapeAccuracyPercent(
  anchor: Waypoint[],
  route: Waypoint[],
): number {
  if (anchor.length < 2 || route.length < 2) return 0;
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
    const mean = (meanA + meanB) / 2;
    return Math.round(
      Math.min(100, Math.max(0, 100 * Math.exp(-mean / 42))),
    );
  } catch {
    return 0;
  }
}
