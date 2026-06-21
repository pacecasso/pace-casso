/** Normalized contour point (same shape as Step1 `NormalizedPoint`). */
export type ContourPoint = { x: number; y: number };

export type PlacementTransform = {
  center: [number, number];
  rotationDeg: number;
  scale: number;
};

export type PlacedContourResult = {
  anchorLatLngs: [number, number][];
  approxDistanceKm: number;
};

const CLOSED_PATH_THRESHOLD = 0.025;

function isValidContourPoint(p: ContourPoint): boolean {
  return (
    Number.isFinite(p.x) &&
    p.x >= 0 &&
    p.x <= 1 &&
    Number.isFinite(p.y) &&
    p.y >= 0 &&
    p.y <= 1
  );
}

function isValidLatLng([lat, lng]: [number, number]): boolean {
  return (
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

function shouldCloseContourPath(
  contour: ContourPoint[],
  width: number,
  height: number,
): boolean {
  if (contour.length < 4) return false;
  const first = contour[0]!;
  const last = contour[contour.length - 1]!;
  const gap = Math.hypot(first.x - last.x, first.y - last.y);
  return gap <= CLOSED_PATH_THRESHOLD * Math.max(width, height, 1e-6);
}

/**
 * Map contour from normalized image space to WGS84 using center, rotation, and scale
 * (same math as Step 2 map placement).
 */
export function buildAnchorLatLngsFromContour(
  contour: ContourPoint[],
  { center, rotationDeg, scale }: PlacementTransform,
): PlacedContourResult {
  contour = contour.filter(isValidContourPoint);
  if (!contour.length) {
    return { anchorLatLngs: [], approxDistanceKm: 0 };
  }
  if (
    !isValidLatLng(center) ||
    !Number.isFinite(rotationDeg) ||
    !Number.isFinite(scale) ||
    scale <= 0
  ) {
    return { anchorLatLngs: [], approxDistanceKm: 0 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  contour.forEach((p) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  });
  const width = maxX - minX || 1;
  const height = maxY - minY || 1;
  const cxNorm = minX + width / 2;
  const cyNorm = minY + height / 2;

  const baseSpanMeters = 2000;
  const maxDim = Math.max(width, height);
  const metersPerUnit = (baseSpanMeters * scale) / maxDim;

  const lat0 = center[0];
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLng =
    metersPerDegreeLat * Math.cos((lat0 * Math.PI) / 180);
  if (!Number.isFinite(metersPerDegreeLng) || Math.abs(metersPerDegreeLng) < 1e-6) {
    return { anchorLatLngs: [], approxDistanceKm: 0 };
  }

  const rad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  let perimeterMeters = 0;

  const localPts: [number, number][] = [];
  const pts: [number, number][] = contour.map((p) => {
    const dxNorm = p.x - cxNorm;
    const dyNorm = p.y - cyNorm;

    const localX = dxNorm * metersPerUnit;
    const localY = -dyNorm * metersPerUnit;

    const rx = localX * cosR - localY * sinR;
    const ry = localX * sinR + localY * cosR;
    localPts.push([rx, ry]);

    const dLat = ry / metersPerDegreeLat;
    const dLng = rx / metersPerDegreeLng;

    return [center[0] + dLat, center[1] + dLng];
  });

  for (let idx = 1; idx < localPts.length; idx++) {
    const a = localPts[idx - 1]!;
    const b = localPts[idx]!;
    perimeterMeters += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  if (shouldCloseContourPath(contour, width, height) && localPts.length > 2) {
    const first = localPts[0]!;
    const last = localPts[localPts.length - 1]!;
    perimeterMeters += Math.hypot(first[0] - last[0], first[1] - last[1]);
  }

  return {
    anchorLatLngs: pts,
    approxDistanceKm: perimeterMeters / 1000,
  };
}
