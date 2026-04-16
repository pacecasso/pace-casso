/**
 * Cumulative distance (m) along an open polyline to the closest point to p [lat,lng].
 */

function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(b[0] - a[0]);
  const dLng = toR(b[1] - a[1]);
  const lat1 = toR(a[0]);
  const lat2 = toR(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
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

export function distanceAlongPolylineToPoint(
  line: [number, number][],
  p: [number, number],
): number {
  if (line.length < 2) return 0;
  let bestAlong = 0;
  let bestDist = Infinity;
  let cumulative = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
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
