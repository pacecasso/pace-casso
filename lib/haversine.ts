/** WGS84 mean radius used consistently across all distance calculations. */
const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres between two [lat, lng] points. */
export function haversineMeters(
  a: [number, number],
  b: [number, number],
): number {
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(b[0] - a[0]);
  const dLng = toR(b[1] - a[1]);
  const lat1 = toR(a[0]);
  const lat2 = toR(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
