/** Same shape as Step1 `NormalizedPoint` (0..1 box). */
export type NormalizedContourPoint = { x: number; y: number };

/** Map a geographic stroke into the same 0..1 box convention as image contours. */
export function latLngPathToNormalizedContour(
  pts: [number, number][],
): NormalizedContourPoint[] {
  if (pts.length < 2) return [];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of pts) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
  }
  const dLat = maxLat - minLat || 1e-9;
  const dLng = maxLng - minLng || 1e-9;
  return pts.map(([lat, lng]) => ({
    x: (lng - minLng) / dLng,
    y: (maxLat - lat) / dLat,
  }));
}

export function centroidLatLng(pts: [number, number][]): [number, number] {
  let sLat = 0;
  let sLng = 0;
  for (const [lat, lng] of pts) {
    sLat += lat;
    sLng += lng;
  }
  const n = pts.length;
  return [sLat / n, sLng / n];
}
