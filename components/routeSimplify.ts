export type LatLng = [number, number]; // [lat, lng]

type SimplifyOptions = {
  maxPoints?: number;
  minPoints?: number;
  toleranceMeters?: number;
};

// Douglas–Peucker-style simplification in approximate meters.
export function simplifyRoute(
  coords: LatLng[],
  options: SimplifyOptions = {},
): LatLng[] {
  const maxPoints = options.maxPoints ?? 60;
  const minPoints = options.minPoints ?? 20;
  const toleranceMeters = options.toleranceMeters ?? 20; // ~20 m deviation

  if (coords.length <= maxPoints) {
    return coords;
  }

  const origin = coords[0];
  const projected = coords.map((c) => projectToMeters(origin, c));

  const indexesToKeep = new Set<number>();
  indexesToKeep.add(0);
  indexesToKeep.add(coords.length - 1);

  simplifySegment(projected, 0, projected.length - 1, toleranceMeters, indexesToKeep);

  const kept = Array.from(indexesToKeep).sort((a, b) => a - b);
  let simplified = kept.map((i) => coords[i]);

  if (simplified.length > maxPoints) {
    const step = Math.ceil(simplified.length / maxPoints);
    const reduced: LatLng[] = [];
    for (let i = 0; i < simplified.length; i += step) {
      reduced.push(simplified[i]);
    }
    if (reduced[reduced.length - 1] !== simplified[simplified.length - 1]) {
      reduced.push(simplified[simplified.length - 1]);
    }
    simplified = reduced;
  }

  if (simplified.length < minPoints) {
    return coords;
  }

  return simplified;
}

function projectToMeters(origin: LatLng, point: LatLng): [number, number] {
  const [lat0, lng0] = origin;
  const [lat, lng] = point;
  const R = 6371000;
  const dLat = ((lat - lat0) * Math.PI) / 180;
  const dLng = ((lng - lng0) * Math.PI) / 180;
  const x = dLng * Math.cos(((lat0 + lat) * 0.5 * Math.PI) / 180) * R;
  const y = dLat * R;
  return [x, y];
}

function simplifySegment(
  pts: [number, number][],
  start: number,
  end: number,
  tolerance: number,
  keep: Set<number>,
) {
  if (end <= start + 1) return;

  const [x1, y1] = pts[start];
  const [x2, y2] = pts[end];

  let maxDist = 0;
  let index = -1;

  for (let i = start + 1; i < end; i++) {
    const d = perpendicularDistance(pts[i][0], pts[i][1], x1, y1, x2, y2);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }

  if (maxDist > tolerance && index !== -1) {
    keep.add(index);
    simplifySegment(pts, start, index, tolerance, keep);
    simplifySegment(pts, index, end, tolerance, keep);
  }
}

function perpendicularDistance(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const num = Math.abs(
    (y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1,
  );
  const den = Math.hypot(y2 - y1, x2 - x1) || 1;
  return num / den;
}

