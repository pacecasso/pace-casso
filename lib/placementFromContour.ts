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

/**
 * Map contour from normalized image space to WGS84 using center, rotation, and scale
 * (same math as Step 2 map placement).
 */
export function buildAnchorLatLngsFromContour(
  contour: ContourPoint[],
  { center, rotationDeg, scale }: PlacementTransform,
): PlacedContourResult {
  if (!contour.length) {
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

  const rad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  let perimeterMeters = 0;

  const pts: [number, number][] = contour.map((p) => {
    const dxNorm = p.x - cxNorm;
    const dyNorm = p.y - cyNorm;

    const localX = dxNorm * metersPerUnit;
    const localY = -dyNorm * metersPerUnit;

    const rx = localX * cosR - localY * sinR;
    const ry = localX * sinR + localY * cosR;

    const dLat = ry / metersPerDegreeLat;
    const dLng = rx / metersPerDegreeLng;

    return [center[0] + dLat, center[1] + dLng];
  });

  for (let idx = 1; idx < contour.length; idx++) {
    const a = contour[idx - 1]!;
    const b = contour[idx]!;
    const dxPrev = (a.x - cxNorm) * metersPerUnit;
    const dyPrev = -(a.y - cyNorm) * metersPerUnit;
    const localXPrev = dxPrev * cosR - dyPrev * sinR;
    const localYPrev = dxPrev * sinR + dyPrev * cosR;
    const dx = (b.x - cxNorm) * metersPerUnit;
    const dy = -(b.y - cyNorm) * metersPerUnit;
    const localX = dx * cosR - dy * sinR;
    const localY = dx * sinR + dy * cosR;
    perimeterMeters += Math.hypot(localX - localXPrev, localY - localYPrev);
  }

  if (contour.length > 2) {
    const first = contour[0]!;
    const last = contour[contour.length - 1]!;
    const dxFirst = (first.x - cxNorm) * metersPerUnit;
    const dyFirst = -(first.y - cyNorm) * metersPerUnit;
    const dxLast = (last.x - cxNorm) * metersPerUnit;
    const dyLast = -(last.y - cyNorm) * metersPerUnit;
    const localXFirst = dxFirst * cosR - dyFirst * sinR;
    const localYFirst = dxFirst * sinR + dyFirst * cosR;
    const localXLast = dxLast * cosR - dyLast * sinR;
    const localYLast = dxLast * sinR + dyLast * cosR;
    perimeterMeters += Math.hypot(
      localXFirst - localXLast,
      localYFirst - localYLast,
    );
  }

  return {
    anchorLatLngs: pts,
    approxDistanceKm: perimeterMeters / 1000,
  };
}
